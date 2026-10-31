/**
 * 墨枢 Host 半：作品数据层。
 *
 * 目录布局与旧后端 `server/store.ts` 完全一致：
 *   <projectDir>/novels/<作品>/
 *     project.md
 *     chapters/*.md  outline/*.md  world/*.md  characters/*.md  locations/*.md  memory/*.md
 *     annotations.json  tasks.json  context.json
 *     memory/memory.json  maps/main.map.json
 *     .backups/<相对路径>/<时间戳>.md   ← 每次覆盖正文前的备份
 *     snapshots/<时间戳>.md             ← 快照
 *
 * Markdown 是权威源；其余 JSON 只做派生数据（可重建）。
 *
 * 说明：本模块不读 `.dsh-connection.json`、不碰 cookie / token，
 * 作品根目录与模型通道只来自 `.moshu/settings.json` 与环境变量。
 */
import { existsSync, lstatSync, readFileSync } from 'node:fs';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { seedDocuments, seedMap, seedMemories } from './seed.js';
import { HttpError } from './errors.js';
import { currentScope, scopedSettingsFile } from './scope.js';
import { currentBook, fallbackBookRoot } from './current-book.js';
import * as jsonstore from './jsonstore.js';
import { renameWithRetry } from './jsonstore.js';
import { normalizeMap } from './map.js';
import { readTimeline } from './timeline.js';

/** 改名重试的原实现在 `jsonstore.js`（那里也要用），这里保持同名导出以免调用点漂移。 */
export { renameWithRetry };


/** 契约固定默认值（宿主没有提供默认模型时的最后兜底）。 */
export const DEFAULT_PROJECT_DIR = 'F:\\代码\\AI辅助小说平台';
export const DEFAULT_NOVEL_NAME = '雾隐之城';
export const DEFAULT_PROVIDER = 'wb-proxy';
export const DEFAULT_MODEL = 'deepseek-v4.1-flash';

/**
 * 宿主默认模型选择器，由 index.js 在 apply 时注入。
 * 让插件跟随用户在 DSH 里选定的模型，而不是钉死某个通道：
 * 解析顺序 = settings.json 显式值 → 宿主默认 → 契约兜底。
 */
let hostModelDefault = null;

/** @param {null | (() => {provider?: string, model?: string} | undefined)} resolver */
export function setHostModelDefault(resolver) {
  hostModelDefault = typeof resolver === 'function' ? resolver : null;
}

function resolveHostModelDefault() {
  if (!hostModelDefault) return undefined;
  try {
    const selection = hostModelDefault();
    if (selection && asTrimmedString(selection.provider) && asTrimmedString(selection.model)) {
      return { provider: asTrimmedString(selection.provider), model: asTrimmedString(selection.model) };
    }
  } catch {
    /* 宿主没提供可用选择时退回契约兜底值 */
  }
  return undefined;
}

/**
 * 宿主默认模型（不含 settings.json 的显式覆盖）：宿主选择 → 契约兜底。
 * `GET /settings` 的 provider / model 默认值取这里。
 * @returns {{provider:string,model:string}}
 */
export function defaultModelSelection() {
  const host = resolveHostModelDefault();
  return {
    provider: host?.provider || DEFAULT_PROVIDER,
    model: host?.model || DEFAULT_MODEL,
  };
}

/** 书名里不允许出现的字符（Windows 文件名非法字符 + 控制字符）。 */
const NOVEL_NAME_FORBIDDEN = /[\\/:*?"<>|\u0000-\u001f]/;

/**
 * 校验书名 / 作品目录名（契约 v2：1–40 字，不能含 `\/:*?"<>|`，不能是 `.` / `..`）。
 * 目录名同时就是 BookRef.id，所以这本书的 id 与 name 都用这个函数把关。
 * @param {unknown} input
 * @returns {string} 去掉首尾空白后的书名
 */
export function validateNovelName(input) {
  if (typeof input !== 'string') throw new HttpError(400, '书名必须是字符串。');
  const name = input.trim();
  if (!name) throw new HttpError(400, '书名不能为空。');
  if (name.length > 40) throw new HttpError(400, '书名最多 40 个字。');
  if (/^\.+$/.test(name)) throw new HttpError(400, '书名不能是「.」或「..」。');
  if (name.startsWith('.')) throw new HttpError(400, '书名不能以「.」开头（这个前缀留给内部目录）。');
  if (NOVEL_NAME_FORBIDDEN.test(name)) throw new HttpError(400, '书名不能包含 \\ / : * ? " < > | 这些字符。');
  return name;
}

/** 插件目录：<...>/moshu-novel-studio */
const PLUGIN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** 既不参与文档列表、也不该出现在导航里的目录。 */
const IGNORED_DIRECTORIES = new Set(['snapshots']);

const json = (value) => `${JSON.stringify(value, null, 2)}\n`;

function asTrimmedString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function readJsonSync(file) {
  try {
    const data = JSON.parse(readFileSync(file, 'utf8'));
    return data && typeof data === 'object' && !Array.isArray(data) ? data : undefined;
  } catch {
    return undefined;
  }
}

/** 从严到宽依次尝试的 settings.json 位置。 */
function settingsCandidates() {
  const files = [];
  const push = (file) => {
    const resolved = path.resolve(file);
    if (!files.includes(resolved)) files.push(resolved);
  };
  const explicit = asTrimmedString(process.env.MOSHU_SETTINGS);
  if (explicit) push(explicit);
  push(path.join(process.cwd(), '.moshu', 'settings.json'));
  push(path.join(DEFAULT_PROJECT_DIR, '.moshu', 'settings.json'));
  push(path.join(PLUGIN_ROOT, '..', '..', '.moshu', 'settings.json'));
  return files;
}

/**
 * 读取 `.moshu/settings.json`，解析出作品根目录与模型通道。
 * 解析顺序（契约）：settings.projectDir → 环境变量 MOSHU_PROJECT_DIR → 默认目录。
 * 每次调用都重新读盘，改完 settings 不必重启 DSH。
 * @returns {{file:string,projectDir:string,novelDir:string,provider:string,model:string}}
 */
export function loadSettings() {
  let file = '';
  let data = {};
  /* 显式指定的配置文件**必须**能读：以前读不出来会静默降级到别的候选，
     最后落到硬编码的真实项目上——作者以为在改自己的书，实际在改另一个目录。 */
  const explicit = asTrimmedString(process.env.MOSHU_SETTINGS);
  if (explicit && existsSync(explicit)) {
    const parsed = readJsonSync(explicit);
    if (!parsed) {
      throw new HttpError(500, `墨枢配置读不出来：${explicit} 不是合法的 JSON 对象。请修好它，或删掉后重启 DSH。`);
    }
    file = explicit;
    data = parsed;
  }
  if (!file) {
    for (const candidate of settingsCandidates()) {
      if (!existsSync(candidate)) continue;
      const parsed = readJsonSync(candidate);
      if (!parsed) continue;
      file = candidate;
      data = parsed;
      break;
    }
  }
  const base = file ? path.dirname(path.dirname(file)) : path.resolve(DEFAULT_PROJECT_DIR);
  const configuredDir = asTrimmedString(data.projectDir);
  const envDir = asTrimmedString(process.env.MOSHU_PROJECT_DIR);
  let projectDir;
  if (configuredDir) projectDir = path.resolve(base, configuredDir);
  else if (envDir) projectDir = path.resolve(envDir);
  /* 没有 projectDir 就用「配置文件所在项目的根」，绝不回落硬编码路径：
     那个常量只在这台机器上存在，换台机器就是往别人的目录里写。 */
  else projectDir = base;
  /* 作用域（每个对话一个库）：
     - 作品目录仍然挂在全局 projectDir 下，但 `novels/` 由 scope.js 按会话分流；
     - 「当前作品」= 该对话自己的 settings.json，互不影响；
     - provider/model 没设时回落到全局设置，所以换模型是全局默认、单会话可覆盖。 */
  const scopeFile = scopedSettingsFile(projectDir);
  let scopeData = {};
  if (scopeFile) {
    if (existsSync(scopeFile)) {
      const parsedScope = readJsonSync(scopeFile);
      if (parsedScope) scopeData = parsedScope;
    }
    data = { ...data, ...scopeData };
  }
  const novelDir = asTrimmedString(data.novelDir) || asTrimmedString(data.novel) || asTrimmedString(data.novelName);
  /* 模型跟着 DSH 会话走：工作台不再单独选模型，宿主给了默认就用宿主的。
     settings 里的 provider/model 只作为"宿主拿不到时"的兜底。 */
  const hostDefault = resolveHostModelDefault();
  const provider = hostDefault?.provider || asTrimmedString(data.provider) || DEFAULT_PROVIDER;
  const model = hostDefault?.model || asTrimmedString(data.model) || DEFAULT_MODEL;
  return {
    file,
    projectDir,
    novelDir,
    provider,
    model,
    scopeId: currentScope(),
    scopeFile: scopeFile || '',
  };
}

/** target 是否落在 root 之内（含 root 本身）。 */
export function isInside(root, target) {
  const relative = path.relative(root, target);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

/**
 * 数据目录：`<projectDir>/novels/<作品>`。
 *
 * **薄封装**：解析逻辑全部在 `current-book.js`（v3 契约 §2.1），这里只把结果翻译成
 * 「一个路径字符串」。没有当前作品时返回一个**不保证存在**的占位路径（旧行为：
 * 空书架时 `GET /health` 仍要给出一个 `novelDir`），它不创建任何目录。
 * @param {ReturnType<typeof loadSettings>} [settings]
 */
export function resolveNovelDir(settings = loadSettings()) {
  return currentBook(settings)?.root ?? fallbackBookRoot(settings);
}


/** 一次请求用到的目录与配置。`novelDir` / `book` 都来自 `currentBook()`（唯一解析出处）。 */
export function projectContext() {
  const settings = loadSettings();
  const book = currentBook(settings);
  return {
    settings,
    projectDir: settings.projectDir,
    novelDir: book?.root ?? fallbackBookRoot(settings),
    book,
  };
}

async function exists(file) {
  try {
    await fs.access(file);
    return true;
  } catch {
    return false;
  }
}

/** 取文件 stat；不存在返回 undefined（其他错误照常抛出）。 */
async function statOrNull(file) {
  try {
    return await fs.stat(file);
  } catch (error) {
    if (error?.code === 'ENOENT') return undefined;
    throw error;
  }
}

/** mtime 一律给毫秒数；拿不到就是 0（前端据此判断"没有可信时间戳"）。 */
function mtimeOf(stat) {
  const value = Number(stat?.mtimeMs);
  return Number.isFinite(value) && value > 0 ? value : 0;
}

/**
 * 乐观锁的容差（毫秒）。
 * 同一个文件在 Windows 上 mtime 精度可能只有 ~1ms，留 1ms 余量避免把"没变"判成"变了"。
 */
export const MTIME_TOLERANCE_MS = 1;

/** 读正文 + 同一时刻的 mtime（用于 409 冲突响应：content 与 mtime 必须对得上）。 */
async function readTextWithMtime(file) {
  let last;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const before = await statOrNull(file);
    if (!before) return undefined;
    const content = await fs.readFile(file, 'utf8');
    const after = await statOrNull(file);
    if (!after) return undefined;
    last = { content, mtime: mtimeOf(after) };
    // 读写之间没有别人动过这个文件时，前后两次 stat 一致，这一对 (content, mtime) 才可信。
    if (before.mtimeMs === after.mtimeMs && before.size === after.size) return last;
  }
  return last;
}

/**
 * 目标文件必须是合法 UTF-8 才允许覆盖。
 *
 * 用别的编辑器（GBK 等）写过的章节，读的时候会变成 `�`；如果这时作者在墨枢里存一次，
 * 整章中文就被不可逆地写坏了。宁可拒绝写入并告诉他先转码。
 */
async function assertUtf8Writable(file) {
  const stat = await statOrNull(file);
  if (!stat || !stat.isFile() || stat.size === 0) return;
  let bytes;
  try {
    bytes = await fs.readFile(file);
  } catch {
    return;
  }
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new HttpError(
      409,
      '这个文件不是 UTF-8 编码（可能被别的编辑器用 GBK 保存过）。为避免把中文写坏，墨枢已拒绝覆盖；请先把它转成 UTF-8 再保存。',
    );
  }
}

async function atomicWrite(file, content) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
  await fs.writeFile(temporary, content, 'utf8');
  try {
    /* rename 在 Windows 上会被杀软 / 索引 / 另一个进程短暂占用（EPERM/EBUSY）。
       这里必须重试：以前失败后 finally 会立刻删掉临时文件，那份内容在磁盘上一点痕迹都不留。 */
    await renameWithRetry(temporary, file);
  } catch (error) {
    /* 真的写不进去：保留 .tmp（里面是刚写好的完整内容），交给上层报 500；
       initializeProject 会清理超过 1 小时的孤儿 .tmp，作者也能手工找回。 */
    throw error;
  }
}

/**
 * 同一个文件的写操作排队执行 —— 实现搬到 `jsonstore.withPathLock`（唯一一份）。
 *
 * 以前乐观锁只校验 mtime，但从「读 mtime」到「落盘」之间有 4–8 个 await 点，
 * 并发请求会一起通过校验，最后只剩一份内容（实测 20 并发 → 13 个 200、只剩最后一份）。
 */
const withPathLock = jsonstore.withPathLock;

export async function writeJson(file, value) {
  await atomicWrite(file, json(value));
}


/**
 * 目录/文件改名的重试版本 —— 见 `jsonstore.js` 里的实现（同一个函数，这里只做再导出）。
 * Windows 上刚写完的目录偶尔会被索引或杀软短暂占用（EPERM/EBUSY），重试几次就能过去。
 */

async function seedIfMissing(root, relative, content) {
  const file = path.join(root, relative);
  if (!(await exists(file))) await atomicWrite(file, content);
}

/**
 * 首次使用时补齐作品骨架。
 *
 * 注意：**只有真正的新作品才会写入种子正文**。以前这里对任何作品都「缺什么补什么」，
 * 结果作者把 chapter-002 改名或删掉后，下一次新建文档又会把种子章节种回来。
 * 现在只对「没有 project.md 也没有 chapters/ 目录」的新目录播种；
 * 已有作品只补运行期必需的文件（批注/任务/记忆），绝不复活被作者删掉的正文。
 * @param {string} root 作品数据目录
 */
/**
 * 初始化一本作品。
 *
 * **默认建空书**：只放骨架（project.md / 空地图 / 空的批注·任务·记忆）。
 * 示例作品（`雾隐之城` 的两章、人物、地点、示例记忆）以前是**每建一本就整套复制**，
 * 结果作者新建《蒸汽纪元探索日记》，里面却躺着「沈青梧」「旧钟楼」「第一章 雾从旧钟楼来」——
 * 一篇自己的字都没有，全是样例。
 *
 * 想看示例就显式传 `sample: true`（POST /books 的 sample 字段）。
 *
 * @param {string} root 作品目录
 * @param {{sample?: boolean}} [options] sample=true 时额外写入示例正文与设定
 */
export async function initializeProject(root, options = {}) {
  const brandNew = !(await exists(path.join(root, 'project.md'))) && !(await exists(path.join(root, 'chapters')));
  await fs.mkdir(root, { recursive: true });
  const title = path.basename(root) || DEFAULT_NOVEL_NAME;
  const sample = options.sample === true;

  if (brandNew) {
    await seedIfMissing(root, 'project.md', `# ${title}\n\n> 一句话说明这本书讲什么（随时可改）\n`);
    await seedIfMissing(root, 'maps/main.map.json', json({ ...emptyCanvasMap(), name: title }));
    if (sample) {
      await Promise.all(Object.entries(seedDocuments).map(([name, content]) => seedIfMissing(root, name, content)));
      await seedIfMissing(root, 'maps/main.map.json', json({ ...seedMap, name: title, scale: 0.5 }));
      await seedIfMissing(root, 'memory/memory.json', json(seedMemories));
    }
  }

  /* 运行期必需的容器文件，任何情况下都补齐（AI 读写它们时不该遇到 404）。 */
  await seedIfMissing(root, 'annotations.json', '[]\n');
  await seedIfMissing(root, 'tasks.json', '[]\n');
  if (sample) await seedIfMissing(root, 'memory/memory.json', json(seedMemories));
  else await seedIfMissing(root, 'memory/memory.json', '[]\n');
}

/** 空画布地图（新建作品用）：只有尺寸与空集合，什么都不预置。 */
function emptyCanvasMap() {
  return {
    width: 1200,
    height: 760,
    scale: 1,
    landmasses: [],
    mountains: [],
    forests: [],
    rivers: [],
    routes: [],
    locations: [],
  };
}

/**
 * 校验并解析项目内相对 Markdown 路径。
 * 拒绝绝对路径、盘符、反斜杠、`..`、隐藏段、非 .md，以及路径上任何符号链接。
 * @param {string} root 作品数据目录
 * @param {unknown} input 前端给的相对路径
 * @returns {{relative:string,resolved:string}}
 */
export function resolveMarkdown(root, input) {
  if (typeof input !== 'string' || !input.trim() || input.length > 500 || input.includes('\0') || input.includes('\\')) {
    throw new HttpError(400, '文档 path 无效，请使用项目内相对路径。');
  }
  const raw = input.trim().replace(/^\.\//, '');
  const relative = path.posix.normalize(raw);
  if (
    relative !== raw ||
    relative.startsWith('../') ||
    relative === '..' ||
    path.posix.isAbsolute(relative) ||
    /^[a-zA-Z]:/.test(relative) ||
    !/\.md$/i.test(relative) ||
    relative.split('/').some((part) => !part || part.startsWith('.'))
  ) {
    throw new HttpError(400, '仅允许项目目录内的 .md 文档，禁止越界路径。');
  }
  const resolved = path.resolve(root, ...relative.split('/'));
  // 路径上任何一段是符号链接都可能把写入引出作品目录。
  let probe = root;
  for (const part of relative.split('/')) {
    probe = path.join(probe, part);
    try {
      if (lstatSync(probe).isSymbolicLink()) throw new HttpError(403, '禁止通过链接写入项目外文件。');
    } catch (error) {
      if (error instanceof HttpError) throw error;
      if (error?.code !== 'ENOENT') throw error;
    }
  }
  if (!isInside(root, path.dirname(resolved))) throw new HttpError(403, '文档路径越界。');
  return { relative, resolved };
}

async function readRelative(root, relative) {
  try {
    return await fs.readFile(path.join(root, relative), 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') return '';
    throw error;
  }
}

export async function readDocument(root, relative) {
  const { resolved } = resolveMarkdown(root, relative);
  return fs.readFile(resolved, 'utf8');
}

/* ------------------------------------------------------------------ 备份 */

/** 某文档的备份目录：`<root>/.backups/<相对路径的目录部分>`。 */
/**
 * 备份目录：**每个文档一个目录** `.backups/<相对路径>/<时间戳>.md`。
 *
 * 早期版本按「上级目录」归并（`.backups/chapters/`），导致所有章节的备份混在一起：
 * 恢复时可能把甲章的稿子写进乙章。旧布局（`chapters/chapter-001.md/` 这种目录）
 * 与现在的布局一致，磁盘上已有的老备份可以直接复用。
 */
function backupDirOf(root, relative) {
  return path.join(root, '.backups', ...relative.split('/'));
}

/** 老布局：`.backups/<上级目录>/<时间戳>.md`（同一目录下所有文档混放）。 */
function legacyBackupDirOf(root, relative) {
  const segments = relative.split('/');
  if (segments.length < 2) return '';
  return path.join(root, '.backups', ...segments.slice(0, -1));
}

/** 时间戳文件名（同毫秒内多次备份时追加 -2、-3…，永不互相覆盖）。 */
async function uniqueBackupName(directory, stamp) {
  let name = `${stamp}.md`;
  let attempt = 1;
  while (await exists(path.join(directory, name))) {
    attempt += 1;
    name = `${stamp}-${attempt}.md`;
  }
  return name;
}

/** `2026-10-30T09-12-33-123Z.md` → `2026-10-30T09:12:33.123Z`（取不到就返回空串）。 */
function isoFromBackupName(name) {
  const matched = /^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z(?:-\d+)?\.md$/.exec(name);
  return matched ? `${matched[1]}T${matched[2]}:${matched[3]}:${matched[4]}.${matched[5]}Z` : '';
}

/** 备份 id 只允许是 `.backups/<目录>` 下的一个文件名。 */
function assertBackupId(id) {
  if (typeof id !== 'string' || !id || id.length > 120 || !/^[0-9A-Za-z._-]+\.md$/.test(id) || id.includes('..')) {
    throw new HttpError(400, '备份 id 无效。');
  }
}

/**
 * 把文档当前内容复制进 `.backups/`（写前备份）。文件不存在时什么都不做。
 * @returns {Promise<string|undefined>} 备份的相对路径（`<root>` 内）
 */
export async function snapshotBackup(root, relative) {
  const { resolved } = resolveMarkdown(root, relative);
  if (!(await exists(resolved))) return undefined;
  const directory = backupDirOf(root, relative);
  await fs.mkdir(directory, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const name = await uniqueBackupName(directory, stamp);
  await fs.copyFile(resolved, path.join(directory, name));
  return path.posix.join('.backups', ...relative.split('/'), name);
}

/**
 * 列出某文档的备份，新的在前。
 * @returns {Promise<Array<{id:string,at:string,bytes:number}>>}
 */
export async function listBackups(root, relative) {
  const directory = backupDirOf(root, relative);
  let names = [];
  try {
    names = (await fs.readdir(directory)).filter((name) => name.endsWith('.md'));
  } catch (error) {
    if (error?.code === 'ENOENT') return [];
    throw error;
  }
  /* 老布局（升级前写入的）与当前布局不同目录，但同样是这个文档的备份，
     以前完全读不到 → 作者以为备份丢了。这里一并列出，恢复时按 id 找文件。 */
  const legacyDir = legacyBackupDirOf(root, relative);
  if (legacyDir) {
    try {
      for (const name of await fs.readdir(legacyDir)) {
        if (!/\.md$/i.test(name)) continue;
        const candidate = path.join(legacyDir, name);
        const stat = await statOrNull(candidate);
        if (stat && stat.isFile() && !names.includes(name)) names.push(name);
      }
    } catch {
      /* 没有老目录就算了 */
    }
  }
  const entries = [];
  for (const name of names) {
    const preferred = path.join(directory, name);
    const full = existsSync(preferred) ? preferred : path.join(legacyBackupDirOf(root, relative) || directory, name);
    /* 只收真正的文件：老版本按目录归并时，这里会混进 `chapter-001.md/` 这种目录，
       当成备份会让「清理旧备份」用 fs.rm 去删目录 → EISDIR → 之后每次保存都 500。 */
    const stat = await statOrNull(full);
    if (!stat || !stat.isFile()) continue;
    entries.push({
      id: name,
      at: isoFromBackupName(name) || stat.mtime.toISOString(),
      bytes: stat.size,
      mtimeMs: stat.mtimeMs,
    });
  }
  entries.sort((left, right) => (left.at === right.at ? right.mtimeMs - left.mtimeMs : right.at.localeCompare(left.at)));
  return entries.map(({ mtimeMs, ...entry }) => entry);
}

/** 读取一份备份的正文。 */
export async function readBackup(root, relative, id) {
  assertBackupId(id);
  const file = path.join(backupDirOf(root, relative), id);
  try {
    return await fs.readFile(file, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') throw new HttpError(404, `找不到备份「${id}」，可能已被清理。`);
    throw error;
  }
}

/**
 * 按份数清理旧备份（新的在前，保留 `keep` 份）。`keep <= 0` 表示不清理。
 * @returns {Promise<number>} 删掉的份数
 */
export async function pruneBackups(root, relative, keep) {
  const limit = Math.trunc(Number(keep));
  if (!Number.isFinite(limit) || limit <= 0) return 0;
  const entries = await listBackups(root, relative);
  const extra = entries.slice(limit);
  if (!extra.length) return 0;
  const directory = backupDirOf(root, relative);
  let removed = 0;
  for (const entry of extra) {
    /* 单条删不掉（Windows 上被杀软/索引占用、或残留目录）不能拖垮整次保存：
       保存早就把正文写进磁盘了，这里再抛错只会让作者以为「保存失败」。 */
    try {
      await fs.rm(path.join(directory, entry.id), { force: true });
      removed += 1;
    } catch {
      /* 留给下一次清理 */
    }
  }
  return removed;
}

/**
 * 把当前内容另存一份备份，再写入新正文（供备份恢复用）。
 * 返回值带写盘后的 mtime：恢复绕过了 PUT 的乐观锁，前端必须用这个 mtime 刷新自己的表，
 * 否则下一次自动保存会被误判成冲突。
 * @returns {Promise<{content:string, mtime:number}>}
 */
export async function restoreBackup(root, relative, id, keep = 0) {
  /* 与 saveDocument 共用同一把路径锁：否则「恢复」和「自动保存」会交错，
     恢复被后到的保存覆盖（或反之），而两边都报成功。 */
  const key = lockKeyOf(root, relative);
  return withPathLock(key, () => restoreBackupUnlocked(root, relative, id, keep));
}

async function restoreBackupUnlocked(root, relative, id, keep = 0) {
  const content = await readBackup(root, relative, id);
  const { resolved } = resolveMarkdown(root, relative);
  const currentStat = await statOrNull(resolved);
  /* 空的备份文件多半是复制被打断留下的：拿它恢复等于把整章清空，宁可拒绝。 */
  if (!content.length && currentStat && currentStat.size > 0) {
    throw new HttpError(409, '这份备份是空的（可能是复制中断留下的残档），为避免清空正文，已拒绝恢复。');
  }
  if (currentStat) await snapshotBackup(root, relative);
  await atomicWrite(resolved, content);
  await pruneBackups(root, relative, keep);
  return { content, mtime: mtimeOf(await statOrNull(resolved)) };
}

/**
 * 保存正文。覆盖前先把旧文件复制到 `.backups/`（与旧后端一致），
 * `keep > 0` 时按份数清理旧备份。
 *
 * 乐观锁：`expectedMtime` 给了就要求磁盘当前 mtime 与之相差不超过 `MTIME_TOLERANCE_MS`，
 * 否则抛 409（带磁盘当前 mtime 与全文），且**一个字节都不写**。
 * 不给 `expectedMtime` 时行为与以前完全一致（向后兼容）。
 *
 * @param {string} root 作品数据目录
 * @param {unknown} relative 项目内相对 .md 路径
 * @param {string} content 新正文
 * @param {boolean | {create?:boolean, keep?:number, expectedMtime?:number}} options create=true 表示只允许新建
 * @returns {Promise<{path:string, updatedAt:string, mtime:number, backup?:string}>}
 */
/**
 * 路径锁的键：**必须**用归一化后的相对路径。
 * 以前直接用请求里的原始字符串，于是 `chapters/x.md` 与 `./chapters/x.md`
 * 各拿一把锁、同时通过乐观锁校验，后写覆盖先写。
 */
function lockKeyOf(root, relative) {
  let normalized = String(relative);
  try {
    normalized = resolveMarkdown(root, relative).relative;
  } catch {
    /* 非法路径交给后面的校验去报错，这里只要一个稳定的键 */
  }
  return `${path.resolve(root)}|${normalized}`;
}

export async function saveDocument(root, relative, content, options = false) {
  /* 同一路径串行：并发保存不再互相"通过校验然后互相覆盖"。 */
  return withPathLock(lockKeyOf(root, relative), () => saveDocumentUnlocked(root, relative, content, options));
}

async function saveDocumentUnlocked(root, relative, content, options = false) {
  const opts = typeof options === 'boolean' ? { create: options } : (options || {});
  const create = opts.create === true;
  const { resolved } = resolveMarkdown(root, relative);
  const presentStat = await statOrNull(resolved);
  const present = Boolean(presentStat);
  if (create && present) throw new HttpError(409, '该文档已存在。');
  if (!create && !present) throw new HttpError(404, '文档不存在，请使用新建文档接口。');

  const hasExpectation = opts.expectedMtime !== undefined && opts.expectedMtime !== null;
  if (present && hasExpectation) {
    const expected = Number(opts.expectedMtime);
    if (!Number.isFinite(expected)) throw new HttpError(400, 'expectedMtime 必须是毫秒数。');
    const disk = await readTextWithMtime(resolved);
    if (!disk) throw new HttpError(404, '文档不存在，请使用新建文档接口。');
    if (Math.abs(disk.mtime - expected) > MTIME_TOLERANCE_MS) {
      throw new HttpError(
        409,
        '这个文件在磁盘上已被其他来源修改（可能是 DSH 会话或另一个窗口）。',
        { details: { conflict: true, mtime: disk.mtime, content: disk.content } },
      );
    }
  }

  if (present) await assertUtf8Writable(resolved);
  const backup = present ? await snapshotBackup(root, relative) : undefined;
  await atomicWrite(resolved, content);
  if (opts.keep !== undefined) await pruneBackups(root, relative, opts.keep);
  const stat = await fs.stat(resolved);
  return { path: relative, updatedAt: stat.mtime.toISOString(), mtime: mtimeOf(stat), backup };
}

async function walk(directory) {
  const entries = await fs.readdir(directory, { withFileTypes: true });
  const collected = await Promise.all(entries.map(async (entry) => {
    if (entry.name.startsWith('.')) return [];
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) return IGNORED_DIRECTORIES.has(entry.name) ? [] : walk(full);
    /* 大小写不敏感：写入侧接受 .MD，读取侧也必须看得见，否则文件写进去却列不出来。 */
    return entry.isFile() && /\.md$/i.test(entry.name) ? [full] : [];
  }));
  return collected.flat();
}

function documentType(relative) {
  if (relative.startsWith('chapters/')) return 'chapter';
  if (relative.startsWith('characters/')) return 'character';
  if (relative.startsWith('factions/')) return 'faction';
  if (relative.startsWith('locations/')) return 'location';
  if (relative.startsWith('outline/')) return 'outline';
  if (relative.startsWith('memory/')) return 'memory';
  return 'world';
}

/** 列出作品内全部 Markdown 文档（隐藏目录、snapshots 不参与）。 */
export async function listDocuments(root) {
  let files;
  try {
    files = await walk(root);
  } catch (error) {
    if (error?.code === 'ENOENT') return [];
    throw error;
  }
  return Promise.all(files.sort((a, b) => a.localeCompare(b, 'zh-CN')).map(async (file) => {
    const relative = path.relative(root, file).split(path.sep).join('/');
    const [content, stat] = await Promise.all([fs.readFile(file, 'utf8'), fs.stat(file)]);
    const title = content.match(/^#\s+(.+)$/m)?.[1]?.trim() || path.basename(relative, '.md');
    return {
      id: relative.replace(/\.md$/i, ''),
      path: relative,
      title,
      content,
      type: documentType(relative),
      updatedAt: stat.mtime.toISOString(),
      // 页面保存时用它做乐观锁（PUT /document 的 expectedMtime）。
      mtime: mtimeOf(stat),
    };
  }));
}

/**
 * 读取作品内的 JSON 数组（缺失 / 坏档 → 空数组，坏档会被隔离成 `.corrupt-*` 并记 warn）。
 *
 * v3 之前这里坏一次就 500（`bootstrap` 整页打不开）。现在统一走 `jsonstore.js`：
 * 派生数据是「可重建」的，绝不能因为一个坏 JSON 让作者的整部稿子打不开。
 */
export async function readList(root, name) {
  return jsonstore.readArray(root, name, []);
}

export const readMemories = (root) => readList(root, 'memory/memory.json');
export const readAnnotations = (root) => readList(root, 'annotations.json');

export async function readMap(root) {
  const data = await jsonstore.readObject(root, 'maps/main.map.json', { locations: [], routes: [] });
  /* 形状与校验都在 host/map.js（陆地多边形、山脉、森林、河流、路线、地点）。
     旧数据（只有 locations/routes，坐标是 0..100 百分比）由 normalizeMap 兜住。 */
  const legacy = data && typeof data === 'object' ? data : {};
  const locations = Array.isArray(legacy.locations)
    ? legacy.locations.map((location) => ({ ...location, category: location.category || location.type || '地点' }))
    : [];
  const routes = Array.isArray(legacy.routes) ? legacy.routes : [];
  return normalizeMap({ ...legacy, locations, routes });
}

/** 追加（或在同 id 上替换）任务记录，只保留最近 100 条（与旧后端一致）。 */
export async function appendTask(root, task) {
  /* 读-改-写必须在同一把锁里，否则并发任务会互相覆盖（16 并发实测只剩 1 条）。 */
  return jsonstore.withDocLock(root, 'tasks.json', async () => {
    const tasks = await readList(root, 'tasks.json');
    const index = tasks.findIndex((item) => item && item.id === task.id);
    const next = index >= 0
      ? tasks.map((item, at) => (at === index ? task : item))
      : [...tasks.slice(-99), task];
    await jsonstore.writeArray(root, 'tasks.json', next);
    return task;
  });
}

/**
 * 组装整页所需的 Project（字段名沿用 src/types.ts 的 Project）。
 * @param {string} root 作品数据目录
 * @param {{available:boolean,status:string,provider:string,model:string,message?:string}} dsh
 */
export async function bootstrap(root, dsh) {
  const [documents, annotations, memories, map, tasks] = await Promise.all([
    listDocuments(root), readAnnotations(root), readMemories(root), readMap(root), readList(root, 'tasks.json'),
  ]);
  const projectText = await readRelative(root, 'project.md');
  const chapters = documents.filter((doc) => doc.type === 'chapter');
  const characterNames = documents.filter((doc) => doc.type === 'character').map((doc) => doc.title);
  /* 时间线**不再从章节编号编造**（以前是"一章一条、日期写故事进程 N"，
     那只是章节列表换了皮）。现在读 AI 从正文里提取出来的 timeline.json；
     还没有就让它是空的，页面会提示「可以让 AI 从正文里提取」。 */
  const timeline = await readTimeline(root).catch(() => []);
  const timelineReady = timeline.length > 0;
  const contextDocumentIds = await readList(root, 'context.json').catch(() => []);
  const subtitle = projectText.split('\n').find((line) => line && !line.startsWith('#') && !line.startsWith('>'))?.trim() || '在雾中找回昨日';
  return {
    name: path.basename(root) || DEFAULT_NOVEL_NAME,
    /* 作品身份：前端每次写请求都带回来，Host 比对不上就拒绝。
       没有它的话，切书瞬间在飞的旧请求会把旧书正文写进新书的同名文件。 */
    bookId: path.basename(root) || '',
    subtitle,
    root,
    documents,
    annotations,
    memories,
    map,
    tasks,
    timeline,
    timelineReady,
    contextDocumentIds,
    dsh,
  };
}

/**
 * 时间线用的卷标签：从卷纲（`outline/volume-*.md` 的 `volume` 元数据）里找，
 * 找不到就退回「第 N 卷」。
 */
function volumeLabel(index, documents) {
  const wanted = Number(String(documents?.[index]?.volume ?? '')) || null;
  const volumeDoc = (documents || []).find((doc) => {
    if (doc.type !== 'outline') return false;
    const matched = /^---\r?\n([\s\S]*?)\r?\n---/.exec(doc.content || '');
    const block = matched ? matched[1] : '';
    const found = /^volume:\s*(\d+)/m.exec(block);
    return found && wanted !== null && Number(found[1]) === wanted;
  });
  return volumeDoc ? volumeDoc.title : '第一卷';
}

/** 写一份全作品快照到 snapshots/。 */
export async function createSnapshot(root) {
  const documents = await listDocuments(root);
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const relative = `snapshots/${stamp}.md`;
  const content = [
    `# ${path.basename(root) || DEFAULT_NOVEL_NAME} · 创作快照`,
    '',
    `创建于 ${new Date().toLocaleString('zh-CN')}`,
    '',
    ...documents.flatMap((doc) => ['---', '', `<!-- ${doc.path} -->`, '', doc.content, '']),
  ].join('\n');
  await atomicWrite(path.join(root, ...relative.split('/')), content);
  return { id: stamp, path: relative, documents: documents.length };
}

/** 合并导出全部章节正文。 */
export async function exportNovel(root) {
  const documents = (await listDocuments(root)).filter((doc) => doc.type === 'chapter');
  return `${documents.map((doc) => doc.content.trim()).join('\n\n---\n\n')}\n`;
}
