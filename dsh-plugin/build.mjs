import { readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { transformSync } from '@babel/core';
import presetReact from '@babel/preset-react';

/**
 * Builds `moshu-novel-studio/client.js` from `moshu-novel-studio/src-client/**`.
 *
 * The DSH web client loads one plain-JS artifact per plugin through
 * `window.__ModuleLoader__.load({ id, factory(require) })`. React comes from the
 * host module table, so every source module is plain CJS + JSX:
 * `require('react')`, `require('./x')`, `module.exports = ...`.
 *
 * This script transforms JSX with Babel and concatenates the modules into one
 * artifact with a tiny require shim. No bundler, no esbuild subprocess.
 */
const here = path.dirname(fileURLToPath(import.meta.url));
const pkgDir = path.join(here, 'moshu-novel-studio');
const srcDir = path.join(pkgDir, 'src-client');
const outFile = path.join(pkgDir, 'client.js');
/* 包名以 package.json 为准：宿主按 manifest 的 id 匹配模块，
   这里硬编码一份的话，改名就会留下旧 id、运行时整包注册不上。 */
const pkgName = JSON.parse(readFileSync(path.join(pkgDir, 'package.json'), 'utf8')).name;

const PANEL_ID = 'moshu-novel-studio';
const ENTRY = './index.jsx';

function walk(dir, acc = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.')) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, acc);
    else acc.push(full);
  }
  return acc;
}

function moduleId(file) {
  return './' + path.relative(srcDir, file).split(path.sep).join('/');
}

if (!statSync(srcDir, { throwIfNoEntry: false })) {
  console.error(`[moshu] missing source directory: ${srcDir}`);
  process.exit(1);
}

const files = walk(srcDir)
  .filter((file) => /\.(jsx?|css)$/i.test(file))
  .sort();

const definitions = [];
const problems = [];

for (const file of files) {
  const id = moduleId(file);
  const source = readFileSync(file, 'utf8');

  if (id.toLowerCase().endsWith('.css')) {
    definitions.push(`__define(${JSON.stringify(id)}, function (module) {\nmodule.exports = ${JSON.stringify(source)};\n});`);
    continue;
  }

  let code;
  try {
    code = transformSync(source, {
      filename: file,
      babelrc: false,
      configFile: false,
      sourceType: 'script',
      presets: [[presetReact, { runtime: 'classic', pragma: 'React.createElement', pragmaFrag: 'React.Fragment' }]],
      compact: false,
      retainLines: false,
    }).code;
  } catch (error) {
    problems.push(`${id}: ${error.message.split('\n')[0]}`);
    continue;
  }
  definitions.push(`__define(${JSON.stringify(id)}, function (module, exports, require) {\n${code}\n});`);
}

if (!files.some((file) => moduleId(file) === ENTRY)) {
  problems.push(`missing entry module ${ENTRY}`);
}

/* ---- 依赖解析检查 ----
   以前 require 一个不存在的模块（最典型：新组件 require 了一个还没写的 .css）
   构建是"成功"的，直到浏览器里点开那个面板才炸。这里在构建期就判死。 */
const definedIds = new Set(files.map(moduleId));
const dirOf = (id) => (id.lastIndexOf('/') > 0 ? id.slice(0, id.lastIndexOf('/')) : '.');
function joinId(base, spec) {
  const parts = (base + '/' + spec).split('/');
  const out = [];
  for (const part of parts) {
    if (!part || part === '.') continue;
    if (part === '..') { out.pop(); continue; }
    out.push(part);
  }
  return './' + out.join('/');
}
function resolves(id) {
  return [id, id + '.jsx', id + '.js', id + '.css', id + '/index.jsx', id + '/index.js'].some((candidate) => definedIds.has(candidate));
}
for (const file of files) {
  const id = moduleId(file);
  if (id.toLowerCase().endsWith('.css')) continue;
  const source = readFileSync(file, 'utf8');
  for (const match of source.matchAll(/require\((['"])([^'"]+)\1\)/g)) {
    const spec = match[2];
    if (!spec.startsWith('.')) {
      /* runtime only allows react; other bare specifiers throw in the browser. */
      if (spec !== 'react') problems.push(`${id}: unsupported bare module "${spec}" (client allows react only)`);
      continue;
    }
    const target = joinId(dirOf(id), spec);
    if (!resolves(target)) problems.push(`${id}: require('${spec}') 找不到模块（期望 ${target}）`);
  }
}

/* ---- 孤儿模块检查 ----
   以前 walk() 到的文件会无条件进产物：一个没人 require 的文件悄悄变大，
   或者忘了从入口引用，都不会有任何提示。 */
{
  const reachable = new Set();
  const queue = [ENTRY];
  const sources = new Map();
  for (const file of files) {
    const id = moduleId(file);
    if (id.toLowerCase().endsWith('.css')) continue;
    sources.set(id, readFileSync(file, 'utf8'));
  }
  while (queue.length) {
    const currentId = queue.pop();
    if (reachable.has(currentId)) continue;
    reachable.add(currentId);
    const source = sources.get(currentId);
    if (!source) continue;
    for (const match of source.matchAll(/require\((['"])([^'"]+)\1\)/g)) {
      const spec = match[2];
      if (!spec.startsWith('.')) continue;
      const target = joinId(dirOf(currentId), spec);
      for (const candidate of [target, target + '.jsx', target + '.js', target + '.css', target + '/index.jsx', target + '/index.js']) {
        if (definedIds.has(candidate)) { queue.push(candidate); break; }
      }
    }
  }
  for (const id of definedIds) {
    if (id.toLowerCase().endsWith('.css')) continue;
    if (!reachable.has(id)) problems.push(`${id}: 没有任何模块 require 它（孤儿文件，或者忘了从入口引用）`);
  }
}

if (problems.length) {
  console.error('[moshu] build failed:');
  for (const problem of problems) console.error('  - ' + problem);
  process.exit(1);
}

const artifact = `/* 墨枢 · DSH 小说工作台 — generated by dsh-plugin/build.mjs; do not edit. 2026-11-01 18:19:03 */
window.__MOSHU_BUILD__ = '2026-11-01 18:19:03';
window.__ModuleLoader__.load({
  id: ${JSON.stringify(pkgName)},
  factory(require) {
    const React = require('react');
    const __modules = Object.create(null);
    const __cache = Object.create(null);

    function __define(id, factory) { __modules[id] = factory; }
    function __dirname(id) { const at = id.lastIndexOf('/'); return at < 0 ? '' : id.slice(0, at); }
    function __join(base, spec) {
      const parts = (base + '/' + spec).split('/');
      const out = [];
      for (const part of parts) {
        if (!part || part === '.') continue;
        if (part === '..') { out.pop(); continue; }
        out.push(part);
      }
      return './' + out.join('/');
    }
    function __lookup(id) {
      const tries = [id, id + '.jsx', id + '.js', id + '/index.jsx', id + '/index.js'];
      for (const candidate of tries) {
        if (Object.prototype.hasOwnProperty.call(__modules, candidate)) return candidate;
      }
      return null;
    }
    function __load(id) {
      const resolved = __lookup(id);
      if (!resolved) throw new Error('moshu: missing module ' + id);
      if (__cache[resolved]) return __cache[resolved].exports;
      const module = { exports: {} };
      __cache[resolved] = module;
      __modules[resolved](module, module.exports, __requireFrom(resolved));
      return module.exports;
    }
    function __requireFrom(from) {
      return function require(spec) {
        if (spec === 'react') return React;
        if (spec.charAt(0) !== '.') throw new Error('moshu: unsupported import "' + spec + '"');
        return __load(__join(__dirname(from), spec));
      };
    }

${definitions.join('\n\n')}

    const entry = __load(${JSON.stringify(ENTRY)});
    if (!entry || typeof entry.Page !== 'function') throw new Error('moshu: src-client/index.jsx must export Page');
    if (typeof entry.Icon !== 'function') throw new Error('moshu: src-client/index.jsx must export Icon');
    const Page = entry.Page;
    const Icon = entry.Icon;
    const labelOf = typeof entry.label === 'function' ? entry.label : function () { return '墨枢'; };
    const panelId = ${JSON.stringify(PANEL_ID)};
    /* 小说工具在 Harness 对话里的专用渲染：src-client/index.jsx 导出
       toolViews = [{ key: <wire tool name>, Component }]，这里逐个挂到
       conversation 的工具卡插槽上。 */
    /* 侧边栏入口（sidebar.panellist + 对应的 main 面板）默认打开；
       entry.sidebarPanel === false 就完全不注册——入口只留对话里的 tab 与全屏浮层。 */
    const withSidebarPanel = entry.sidebarPanel !== false;
    const toolViews = Array.isArray(entry.toolViews) ? entry.toolViews : [];
    /* 工作台作为对话里的一个 View（和 对话 / 轨迹 / 上下文 / 网页预览 并排）。 */
    const conv = entry.conversationView;
    /* 全屏工作台浮层（shell.overlay）。 */
    const overlay = entry.overlayView;

    return {
      inject: ['slots'],
      apply(ctx) {
        if (typeof entry.configure === 'function') entry.configure(ctx);
        if (withSidebarPanel) {
          ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
            name: 'sidebar.panellist',
            id: panelId,
            order: 25,
            label: () => labelOf(ctx),
          }, Icon));
          ctx.slots.inject('main', () => ctx.slots.register({
            name: 'main',
            key: panelId,
          }, Page));
        }
        for (const item of toolViews) {
          if (!item || typeof item.key !== 'string' || typeof item.Component !== 'function') continue;
          const key = item.key;
          const Component = item.Component;
          ctx.slots.inject('tool.call.toolview', () => ctx.slots.register({
            name: 'tool.call.toolview',
            key: key,
          }, Component));
        }
        if (conv && typeof conv.id === 'string' && typeof conv.Component === 'function') {
          const viewId = conv.id;
          const viewOrder = typeof conv.order === 'number' ? conv.order : 25;
          const viewLabel = typeof conv.label === 'function' ? conv.label : function () { return String(conv.label || '墨枢'); };
          const ViewComponent = conv.Component;
          ctx.slots.inject('conversation.view', () => ctx.slots.register({
            name: 'conversation.view',
            id: viewId,
            order: viewOrder,
            label: () => viewLabel(ctx),
          }, ViewComponent));
        }
        if (overlay && typeof overlay.id === 'string' && typeof overlay.Component === 'function') {
          const overlayId = overlay.id;
          const overlayOrder = typeof overlay.order === 'number' ? overlay.order : 50;
          const OverlayComponent = overlay.Component;
          ctx.slots.inject('shell.overlay', () => ctx.slots.register({
            name: 'shell.overlay',
            id: overlayId,
            order: overlayOrder,
          }, OverlayComponent));
        }
      },
    };
  },
});
`;

writeFileSync(outFile, artifact, 'utf8');
const bytes = Buffer.byteLength(artifact);
console.log(`[moshu] wrote ${path.relative(here, outFile)} (${files.length} modules, ${(bytes / 1024).toFixed(1)} KiB)`);
