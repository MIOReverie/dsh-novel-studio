/**
 * 墨枢 · 小说工具（模型侧）。
 *
 * 「创作模式」这个 agent preset 独占挂载本文件：标准模式里没有任何一个工具能碰墨枢的作品，
 * 只有在这里，AI 才能读写「当前作品根目录」下的 Markdown。作品根由运行时的书库作用域决定
 * （每个会话一个书库，或共享库），**不在任何地方写死绝对路径**。
 *
 * 作品分两个区，权限完全不同（这是本文件的全部设计依据）：
 *
 *   资料区 characters/ locations/ world/ outline/ memory/ clues/
 *     —— AI 的职责范围。可读可写可删，**不需要审批**。
 *
 *   小说区 chapters/
 *     —— 作者的正文。AI **只能**通过 `novel_edit_chapter` 改，而它每次写入前都必须
 *        走 `ctx.approval.request`，只有作者点了「允许一次」才落盘。
 *
 * 三条硬约束（与 Host 半其余部分保持一致，不另写一套）：
 * 1. 路径校验只走 `store.resolveMarkdown`（拒绝 `..` / 绝对路径 / 反斜杠 / 隐藏段 / 非 .md），
 *    并在其上再收一层：资料区只认那六个前缀，小说区只认 `chapters/`。
 * 2. 写盘只走 `store.saveDocument`（原子写 + 写前备份 + 乐观锁 + 同路径串行），绝不自己 fs.writeFile。
 * 3. 删除只走 `documents.deleteDocument`（移进 `<作品>/.trash/<时间戳>/`，永不物理删除）。
 *
 * 零依赖：只用 node 内置模块与仓库内模块。
 */
import { randomUUID } from 'node:crypto';
import { currentScope, novelsRootOf, runInScope, sanitizeScope } from './scope.js';
import { promises as fs, statSync } from 'node:fs';
import path from 'node:path';
import { AI_TIMEOUT_MS, buildRequest, findRecipe, guardInstruction } from './prompts.js';
import { anchorAnnotations, assembleContext, streamText } from './ai.js';
import { currentBook } from './current-book.js';
import { deleteDocument } from './documents.js';
/* 章节管理的改名/移动/删除复用 documents.js 的同一套实现。 */
import * as documents from './documents.js';
import * as assetsApi from './assets.js';
import * as chapterTitles from './chapter-titles.js';
import * as timelineApi from './timeline.js';
import { CANVAS, describeMap, validateMap } from './map.js';
import * as jsonstore from './jsonstore.js';
import { describeStatus, locateQuote } from './review.js';
import { readSettings } from './settings.js';
import * as store from './store.js';
import {
  isInside,
  listDocuments,
  loadSettings,
  resolveMarkdown,
  saveDocument,
} from './store.js';

/** 挂载本工具集需要宿主提供的服务（审批与模型都用 `ctx.get()` 可选获取）。 */
export const inject = ['tools'];

export const name = 'novel-tools';

/* ------------------------------------------------------------------ 常量 */

/** 资料区：AI 可以自由读写的六个目录。 */
const REFERENCE_DIRS = Object.freeze(['characters', 'locations', 'world', 'outline', 'memory', 'clues']);

/** 小说区：只有它需要审批。 */
const CHAPTER_DIR = 'chapters';

/** 顶层目录 → 文档类型（与 `store.documentType` 同一套口径，多认一个 `clues/`）。 */
const DIR_TYPES = Object.freeze({
  chapters: 'chapter',
  characters: 'character',
  factions: 'faction',
  locations: 'location',
  outline: 'outline',
  memory: 'memory',
  clues: 'clue',
});

/** 类型名 → 顶层目录（`novel_list` 的 `type` 过滤用；单复数都认）。 */
const TYPE_DIRS = Object.freeze({
  chapter: 'chapters',
  character: 'characters',
  faction: 'factions',
  location: 'locations',
  outline: 'outline',
  memory: 'memory',
  clue: 'clues',
  world: 'world',
});

/** 一次 `novel_read` 最多返回多少行 / 多少字符。 */
const READ_MAX_LINES = 400;
const READ_MAX_CHARS = 60_000;

/** 一次 `novel_search` 最多返回多少处命中。 */
const SEARCH_MAX_HITS = 40;
/** 检索结果里每行最多展示多少字符（超长行截断，行号仍然准）。 */
const SEARCH_LINE_CHARS = 200;

/** 单次写入的正文上限（与 `POST /document` 的 2 MB 口径一致）。 */
const WRITE_MAX_CHARS = 2_000_000;

/** 单条批注正文的上限（与 `POST /annotations` 的 comment 校验同一口径）。 */
const MAX_ANNOTATION_COMMENT = 20_000;

/** `novel_list` / `novel_search` 的 `type` 过滤取值。 */
const TYPE_NAMES = Object.freeze(['chapter', 'character', 'location', 'world', 'outline', 'memory', 'clue']);

/* ------------------------------------------------------------------ 小工具 */

/** 工具内部的「拒绝」，不是异常：所有工具都把失败翻译成 `{ok:false, ...}` 返回给模型。 */
class ToolRefusal extends Error {
  /**
   * @param {string} code 机器可读的拒绝原因（回给模型，便于它换一种做法）
   * @param {string} message 给人看的中文说明
   */
  constructor(code, message) {
    super(message);
    this.name = 'ToolRefusal';
    this.code = code;
  }
}

/** 中文正文字数：去掉所有空白字符后的长度（章节字数就是按这个口径报的）。 */
function countChars(text) {
  return String(text ?? '').replace(/\s/g, '').length;
}

function asText(value) {
  return typeof value === 'string' ? value : '';
}

function asInt(value, fallback, min, max) {
  /* 没传参数时不能走 Number('') === 0 —— 那会被夹到 min，
     于是「默认 200 行」变成「默认 1 行」（实测：AI 一次只读到一行，得翻 200 次）。 */
  if (value === undefined || value === null || value === '') return fallback;
  const number = typeof value === 'number' ? value : Number(String(value).trim());
  if (!Number.isFinite(number)) return fallback;
  return Math.min(Math.max(Math.trunc(number), min), max);
}

/** 正文按行拆开（行尾 `\r` 去掉；结尾换行不算一行空行）。 */
function splitLines(content) {
  const lines = String(content ?? '').split(/\r?\n/);
  if (lines.length && lines[lines.length - 1] === '') lines.pop();
  return lines;
}

/** 带行号的正文：`  12| 原文`。 */
function formatNumbered(lines, startNumber) {
  const last = startNumber + Math.max(lines.length - 1, 0);
  const width = String(last).length;
  return lines.map((line, index) => `${String(startNumber + index).padStart(width, ' ')}| ${line}`).join('\n');
}

/** 文档标题：首个 `# 标题`，否则文件名。 */
function titleOf(content, relative) {
  return String(content ?? '').match(/^#\s+(.+)$/m)?.[1]?.trim() || path.posix.basename(relative, '.md');
}

/** 顶层目录 → 文档类型（`factions/` 之外一律落到 world，与 Host 半一致）。 */
function typeOf(relative) {
  const text = String(relative || '');
  /* 顶层 project.md 是"这本书的元信息"（书名/简介），不是世界观设定。
     以前它落到 world，会和真正的设定混在一起被检索、被当作资料上下文。 */
  if (text === 'project.md') return 'project';
  return DIR_TYPES[text.split('/')[0]] || 'world';
}

/** `type` 过滤参数 → 顶层目录名；不传则 `undefined`（不过滤）。 */
function typeDirOf(value) {
  const text = asText(value).trim().toLowerCase().replace(/\/+$/, '');
  if (!text) return undefined;
  const key = text.replace(/s$/, '');
  const dir = TYPE_DIRS[text] || TYPE_DIRS[key];
  if (!dir) {
    throw new ToolRefusal(
      'BAD_TYPE',
      `不认识的类型「${value}」。可用：chapter / character / location / world / outline / memory / clue。`,
    );
  }
  return dir;
}

function fileAt(root, relative) {
  return path.join(root, ...relative.split('/'));
}

/** 读一篇文档（不存在返回 `undefined`，其它错误照抛）。 */
async function readExisting(root, relative) {
  const file = fileAt(root, relative);
  try {
    const [content, stat] = await Promise.all([fs.readFile(file, 'utf8'), fs.stat(file)]);
    /* 一并给出 mtime：多处调用点写的是 existing.mtime，之前只返回 stat，
       于是那些"读过之后又被改过"的保护全都静默失效（undefined 比较恒为 false）。 */
    return { content, stat, mtime: Number(stat.mtimeMs) };
  } catch (error) {
    if (error?.code === 'ENOENT') return undefined;
    throw error;
  }
}

function isDirectorySync(target) {
  try {
    return statSync(target).isDirectory();
  } catch {
    return false;
  }
}

/* ------------------------------------------------------------------ 作品解析 */

/**
 * 解析这次调用针对的作品。
 *
 * `book` 省略 → `currentBook()`（与 Host 半其余入口同一个出处）。
 * `book` 给作品名 → 只认「当前书库里同名的那一本」，必须真实存在且不越界。
 *
 * @param {unknown} input 工具参数里的 `book`
 * @returns {{settings:any, id:string, root:string, isCurrent:boolean}}
 */
function resolveBook(input) {
  const settings = loadSettings();
  const projectDir = path.resolve(settings?.projectDir || process.cwd());
  const current = currentBook(settings);
  const requested = asText(input).trim();

  if (!requested || (current && requested === current.id)) {
    if (!current) {
      throw new ToolRefusal(
        'NO_BOOK',
        '还没有打开任何作品。请先在墨枢里新建或打开一本书。',
      );
    }
    return { settings, id: current.id, root: current.root, isCurrent: true };
  }

  if (requested.includes('/') || requested.includes('\\') || /^\.+$/.test(requested)) {
    throw new ToolRefusal('BAD_BOOK', 'book 只接受作品名（例如「天灾之下」），不接受路径。');
  }
  /* 与墨枢界面同一套书库：AI 在对话里读写的是这个对话自己的书。 */
  const novelsRoot = novelsRootOf(projectDir);
  const target = path.join(novelsRoot, requested);
  if (!isInside(novelsRoot, target) || !isDirectorySync(target)) {
    throw new ToolRefusal(
      'NO_BOOK',
      `作品「${requested}」不存在${current ? `。当前作品是「${current.id}」` : ''}。`,
    );
  }
  return { settings, id: requested, root: target, isCurrent: Boolean(current && current.id === requested) };
}

/**
 * 把工具参数里的 `path` 解析成作品内相对路径，并检查它落在允许的区域里。
 *
 * 底层规则全部来自 `store.resolveMarkdown`（唯一一处路径校验），这里只多问一句
 * 「在哪个区」——因为两个区的权限不一样。
 *
 * @param {string} root 作品根目录
 * @param {unknown} input 用户/模型给的相对路径
 * @param {'reference'|'chapter'} area
 * @returns {string} 归一化后的相对路径（`posix` 分隔）
 */
function resolveInArea(root, input, area) {
  const { relative } = resolveMarkdown(root, input);
  const top = relative.split('/')[0];
  if (area === 'chapter') {
    if (top !== CHAPTER_DIR) {
      throw new ToolRefusal(
        'NOT_A_CHAPTER',
        `「${relative}」不是小说区正文。改正文只接受 ${CHAPTER_DIR}/ 下的 .md（例如 ${CHAPTER_DIR}/chapter-003.md）；`
        + `资料请用 novel_write_reference，它不需要审批。`,
      );
    }
    return relative;
  }
  if (!REFERENCE_DIRS.includes(top)) {
    throw new ToolRefusal(
      'NOT_A_REFERENCE_DIR',
      `「${relative}」不在资料区。资料区只允许 ${REFERENCE_DIRS.map((dir) => `${dir}/`).join(' ')} 下的 .md；`
      + (top === CHAPTER_DIR
        ? 'chapters/ 是小说区正文，只能用 novel_edit_chapter（会请你审批）。'
        : '其它目录不属于墨枢的资料区。'),
    );
  }
  return relative;
}

/* ------------------------------------------------------------------ 审批 */

/** 审批结果 → 给模型看的说明（`allowed-once` 之外的每一种都必须落盘为「不写」）。 */
function refusalOfOutcome(outcome) {
  if (outcome === 'rejected') return '作者拒绝了这次正文改动，文件一个字节都没有变。';
  if (outcome === 'cancelled') return '审批被取消（或会话已中止），文件一个字节都没有变。';
  return '审批不可用（当前会话没有可用的审批服务或 answerer），按失败即拒绝处理，文件一个字节都没有变。';
}

/**
 * 请求一次「允许改正文」的决定。
 *
 * 只有 `allowed-once` 是许可；其余（rejected / cancelled / unavailable，以及 approval
 * 服务根本不存在）全部拒绝——这里是整条链上唯一一道闸门，宁可拒绝也不能默认放行。
 *
 * @param {any} ctx cordis 上下文
 * @param {{agent?:any, callId?:any, signal?:any}} exec 工具执行身份
 * @param {string} reason 为什么要改（必须写清哪一章、改多少字）
 * @returns {Promise<{granted:boolean, outcome:string, message?:string}>}
 */
async function requestWriteApproval(ctx, exec, reason) {
  const approval = typeof ctx?.get === 'function' ? ctx.get('approval') : undefined;
  if (!approval || typeof approval.request !== 'function') {
    return {
      granted: false,
      outcome: 'unavailable',
      message: `${refusalOfOutcome('unavailable')}（这个 DSH 会话没有挂载审批服务）`,
    };
  }
  if (!exec || !exec.agent) {
    return {
      granted: false,
      outcome: 'unavailable',
      message: `${refusalOfOutcome('unavailable')}（这次调用没有关联到一个会话，无法发起审批）`,
    };
  }
  let outcome;
  try {
    outcome = await approval.request({
      agent: exec.agent,
      toolName: 'novel_edit_chapter',
      callId: exec.callId,
      reason,
      signal: exec.signal,
    });
  } catch (error) {
    return {
      granted: false,
      outcome: 'unavailable',
      message: `${refusalOfOutcome('unavailable')}（审批请求本身失败：${error instanceof Error ? error.message : String(error)}）`,
    };
  }
  if (outcome === 'allowed-once') return { granted: true, outcome };
  return { granted: false, outcome: typeof outcome === 'string' ? outcome : 'unavailable', message: refusalOfOutcome(outcome) };
}

/* ------------------------------------------------------------------ 返回形状 */

/**
 * 所有工具共用的输出声明。
 *
 * `text` 存在就原样给模型（读操作的行号正文）；否则把结构化结果 JSON 给它。
 * `schema` 只要求是对象：各工具字段差异很大，这里不做无意义的强约束。
 */
const OUTPUT = {
  schema: {
    type: 'object',
    properties: {
      ok: { type: 'boolean' },
      text: { type: 'string' },
    },
  },
  render(_args, value) {
    /* 以前只要结果里有 text 就只回 text：结构化字段（id / start / end / total）
       模型全看不到，后续就没法引用。现在 text 在前，其余字段附在后面。 */
    if (value && typeof value === 'object' && typeof value.text === 'string') {
      const rest = { ...value };
      delete rest.text;
      const tail = Object.keys(rest).length ? `\n\n${JSON.stringify(rest, null, 2)}` : '';
      return [{ type: 'text', text: value.text + tail }];
    }
    return [{ type: 'text', text: JSON.stringify(value, null, 2) }];
  },
};

/** 把异常翻译成模型能读懂的拒绝。 */
function refusal(error) {
  if (error instanceof ToolRefusal) return { ok: false, code: error.code, message: error.message };
  if (error && typeof error === 'object' && typeof error.status === 'number') {
    const code = error.status === 409 ? 'CONFLICT'
      : error.status === 404 ? 'NOT_FOUND'
        : error.status === 403 ? 'FORBIDDEN'
          : error.status === 400 ? 'BAD_REQUEST'
            : `HTTP_${error.status}`;
    return { ok: false, code, message: error.message };
  }
  return { ok: false, code: 'ERROR', message: error instanceof Error ? error.message : String(error) };
}

/** 统一包一层：任何异常都不外抛，一律变成 `{ok:false}` 返回。 */
function guard(body) {
  return async (args, exec) => {
    try {
      return await body(args, exec);
    } catch (error) {
      return refusal(error);
    }
  };
}

/* ------------------------------------------------------------------ 读 */

/** `novel_overview` 的实现。 */
async function overview(args) {
  const book = resolveBook(args?.book);
  const documents = await listDocuments(book.root);
  const chapters = documents.filter((doc) => typeOf(doc.path) === 'chapter');
  const chapterChars = chapters.reduce((sum, doc) => sum + countChars(doc.content), 0);
  const referenceCounts = {};
  for (const dir of REFERENCE_DIRS) referenceCounts[dir] = 0;
  for (const doc of documents) {
    const top = doc.path.split('/')[0];
    if (Object.prototype.hasOwnProperty.call(referenceCounts, top)) referenceCounts[top] += 1;
  }
  /* 资料区是否需要整理：同目录下标题互相包含、或文件明显空。
     只统计，不修改；让"该整理了"这件事在数据里可见，而不是靠模型自己想起来。 */
  const referenceDocs = documents.filter((doc) => {
    const top = doc.path.split('/')[0];
    return Object.prototype.hasOwnProperty.call(referenceCounts, top);
  });
  const norm = (value) => String(value || '').replace(/[\s（）()【】\[\]\-_·]/g, '').toLowerCase();
  const groups = new Map();
  for (const doc of referenceDocs) {
    const dir = path.posix.dirname(doc.path);
    const key = norm(String(doc.title || '').replace(/\.md$/i, ''));
    if (!key) continue;
    const list = groups.get(dir) || [];
    list.push({ path: doc.path, key, chars: countChars(doc.content) });
    groups.set(dir, list);
  }
  const duplicates = [];
  for (const [dir, list] of groups) {
    for (let i = 0; i < list.length; i += 1) {
      for (let j = i + 1; j < list.length; j += 1) {
        const a = list[i];
        const b = list[j];
        if (a.key === b.key || a.key.indexOf(b.key) >= 0 || b.key.indexOf(a.key) >= 0) {
          duplicates.push({ dir, a: a.path, b: b.path });
        }
      }
    }
  }
  const emptyDocs = referenceDocs.filter((doc) => countChars(doc.content) < 12).map((doc) => doc.path);
  const tidyHint = (duplicates.length || emptyDocs.length >= 5)
    ? `- 资料区需要整理：${duplicates.length ? `${duplicates.length} 组疑似同主题文件（${duplicates.slice(0, 3).map((item) => item.a + ' / ' + item.b).join('；')}${duplicates.length > 3 ? ' …' : ''}）` : ''}${duplicates.length && emptyDocs.length >= 5 ? '；' : ''}${emptyDocs.length >= 5 ? `${emptyDocs.length} 篇几乎空白` : ''}。作者要求"整理"时按【主动整理】一次做完；没要求就只提一句建议。`
    : '';

  const sortedChapters = [...chapters].sort((left, right) => left.mtime - right.mtime);
  const latest = sortedChapters[sortedChapters.length - 1];
  const totalChars = documents.reduce((sum, doc) => sum + countChars(doc.content), 0);

  /* 书库标记：不同会话可能是不同的库，AI 必须知道这一点，否则会拿旧路径去找。 */
  const scopeId = currentScope();
  const libraryLabel = scopeId ? `会话书库（${scopeId}）` : '共享书库';
  let mapSummary = '（还没有地图文件）';
  try {
    const map = await store.readMap(book.root);
    const count = (list) => (Array.isArray(list) ? list.length : 0);
    const kinds = new Set((map.terrain || []).map((item) => item && item.type).filter(Boolean));
    mapSummary = [
      `画布 ${map.width}×${map.height}`,
      `陆地 ${count(map.landmasses)} 块`,
      `山脉 ${count(map.mountains)} 座`,
      `森林 ${count(map.forests)} 片`,
      `地貌 ${count(map.terrain)} 处${kinds.size ? `（${[...kinds].join('/')}）` : ''}`,
      `河流 ${count(map.rivers)} 条`,
      `路线 ${count(map.routes)} 条`,
      `地点 ${count(map.locations)} 个`,
    ].join(' · ');
  } catch {
    mapSummary = '（地图读取失败，可用 novel_map_read 再看一次）';
  }

  /* 示例数据识别：升级前的示例书没有标记，但内容有指纹（雾隐之城那套）。
     不改作者的文件，只在这里提示模型"这可能是样例"。 */
  /* 按**内容指纹**判断，而不是按固定路径：作者可能已经改名/挪过那些文件，
     但示例特有的字句（雾从旧钟楼来 / 沈青梧 / 陆停云）还在。 */
  const SEED_MARKS = ['雾从旧钟楼来', '沈青梧', '陆停云', '雾与钟', '旧钟楼'];
  const hitSeed = SEED_MARKS.filter((mark) => documents.some(
    (doc) => String(doc.content || '').includes(mark) || String(doc.path || '').includes(mark),
  )).length;
  const seedHint = hitSeed >= 2
    ? '- 注意：这本书里有多处与内置示例（雾隐之城）相同的字句/文件名，很可能整本都是示例数据，不是作者原创。'
    : '';

  const text = [
    `# 《${book.id}》`,
    '',
    `- 书库：${libraryLabel}`,
    `- 作品：${book.id}`,
    `- 路径约定：所有 path 都是**相对作品目录**的（例如 chapters/chapter-001.md），不要拼绝对路径`,
    seedHint,
    tidyHint,
    `- 地图：${mapSummary}`,
    `- 章节：${chapters.length} 章`,
    `- 正文字数（去空白）：${chapterChars} 字`,
    `- 全部文档：${documents.length} 篇（含资料），合计 ${totalChars} 字`,
    `- 最近编辑的一章：${latest ? `${latest.path}（${latest.title}，${new Date(latest.mtime).toLocaleString('zh-CN')}）` : '（还没有章节）'}`,
    '',
    '## 资料区计数',
    ...REFERENCE_DIRS.map((dir) => `- ${dir}/：${referenceCounts[dir]} 篇`),
  ].join('\n');

  return {
    ok: true,
    book: book.id,
    chapters: chapters.length,
    chapterChars,
    totalChars,
    referenceCounts,
    currentChapter: latest ? { path: latest.path, title: latest.title, mtime: latest.mtime } : null,
    ...(duplicates.length || emptyDocs.length >= 5
      ? { tidy: { duplicates, emptyDocs: emptyDocs.slice(0, 20) } }
      : {}),
    text,
  };
}

/** `novel_list` 的实现。 */
async function listTool(args) {
  const book = resolveBook(args?.book);
  const dir = typeDirOf(args?.type);
  const documents = await listDocuments(book.root);
  const selected = dir ? documents.filter((doc) => doc.path.split('/')[0] === dir) : documents;

  if (!selected.length) {
    return {
      ok: true,
      book: book.id,
      type: dir || 'all',
      count: 0,
      documents: [],
      text: `${book.id} 的${dir ? ` ${dir}/ ` : '作品'}里一篇文档都没有。`,
    };
  }

  /* 章节按序号前缀排（chapter-002 在 chapter-010 前面），资料按路径排。 */
  const chapterNumber = (relative) => {
    const matched = /^chapters\/chapter-(\d+)/.exec(relative);
    return matched ? Number(matched[1]) : Number.POSITIVE_INFINITY;
  };
  const sorted = [...selected].sort((left, right) => {
    if (dir === CHAPTER_DIR) {
      const delta = chapterNumber(left.path) - chapterNumber(right.path);
      if (delta !== 0) return delta;
    }
    return left.path.localeCompare(right.path, 'zh-CN');
  });

  const entries = sorted.map((doc) => {
    const item = {
      path: doc.path,
      title: doc.title,
      type: typeOf(doc.path),
      chars: countChars(doc.content),
      mtime: doc.mtime,
      updatedAt: doc.updatedAt,
    };
    const chapter = /^chapters\/chapter-(\d+)/.exec(doc.path);
    if (chapter) item.number = Number(chapter[1]);
    return item;
  });

  const lines = entries.map((entry) => {
    const label = entry.number ? `第 ${entry.number} 章 · ` : '';
    return `- ${entry.path} · ${label}${entry.title}（${entry.chars} 字）`;
  });

  return {
    ok: true,
    book: book.id,
    type: dir || 'all',
    count: entries.length,
    documents: entries,
    text: [`${book.id}${dir ? ` · ${dir}/` : ''}：共 ${entries.length} 篇`, '', ...lines].join('\n'),
  };
}

/** `novel_read` 的实现。 */
async function readTool(args) {
  const book = resolveBook(args?.book);
  const requested = asText(args?.path).trim();
  if (!requested) throw new ToolRefusal('MISSING_PATH', '缺少 path：要读哪一篇（例如 chapters/chapter-001.md）。');
  const { relative } = resolveMarkdown(book.root, requested);

  const existing = await readExisting(book.root, relative);
  if (!existing) {
    throw new ToolRefusal('NOT_FOUND', `《${book.id}》里没有「${relative}」。先用 novel_list 看有哪些文档。`);
  }

  const allLines = splitLines(existing.content);
  const offset = asInt(args?.offset, 1, 1, Math.max(allLines.length, 1));
  const limit = asInt(args?.limit, 200, 1, READ_MAX_LINES);
  const slice = allLines.slice(offset - 1, offset - 1 + limit);

  /* 单行超长时按字符再兜一层，避免一次塞爆上下文。 */
  let body = formatNumbered(slice, offset);
  let charNote = '';
  if (body.length > READ_MAX_CHARS) {
    body = `${body.slice(0, READ_MAX_CHARS)}\n…（正文过长，本次展示已在此处按 ${READ_MAX_CHARS} 字符截断；请用 offset/limit 缩小范围重读）`;
    charNote = '本次按字符上限截断';
  }

  const end = offset + slice.length - 1;
  const truncated = end < allLines.length;
  const header = [
    `${relative} · ${titleOf(existing.content, relative)}`,
    `共 ${allLines.length} 行，本次第 ${offset}–${end} 行${truncated ? `（还有 ${allLines.length - end} 行没显示，用 offset=${end + 1} 继续读）` : '（已到末尾）'}${charNote ? `；${charNote}` : ''}`,
  ].join('\n');

  return {
    ok: true,
    book: book.id,
    path: relative,
    title: titleOf(existing.content, relative),
    type: typeOf(relative),
    lines: allLines.length,
    offset,
    end,
    truncated,
    chars: countChars(existing.content),
    mtime: existing.stat.mtimeMs,
    text: `${header}\n\n${body}`,
  };
}

/** `novel_search` 的实现。 */
async function searchTool(args) {
  const book = resolveBook(args?.book);
  const query = asText(args?.query).trim();
  if (!query) throw new ToolRefusal('MISSING_QUERY', '缺少 query：要在全书里找什么（一段原文、一个名字都行）。');
  if (query.length > 200) throw new ToolRefusal('BAD_QUERY', 'query 太长了（上限 200 字），请只给要检索的关键片段。');
  const dir = typeDirOf(args?.type);
  const maxHits = asInt(args?.maxResults, SEARCH_MAX_HITS, 1, SEARCH_MAX_HITS);

  const documents = await listDocuments(book.root);
  const needle = query.toLowerCase();
  const hits = [];
  let matchedDocs = 0;

  for (const doc of documents) {
    if (dir && doc.path.split('/')[0] !== dir) continue;
    const lines = splitLines(doc.content);
    let hitInDoc = 0;
    for (let index = 0; index < lines.length; index += 1) {
      if (!lines[index].toLowerCase().includes(needle)) continue;
      hitInDoc += 1;
      if (hits.length >= maxHits) break;
      const clip = (text) => (text.length > SEARCH_LINE_CHARS ? `${text.slice(0, SEARCH_LINE_CHARS)}…` : text);
      hits.push({
        path: doc.path,
        line: index + 1,
        text: clip(lines[index]),
        before: index > 0 ? clip(lines[index - 1]) : '',
        after: index + 1 < lines.length ? clip(lines[index + 1]) : '',
      });
    }
    if (hitInDoc) matchedDocs += 1;
    if (hits.length >= maxHits) break;
  }

  if (!hits.length) {
    return {
      ok: true,
      book: book.id,
      query,
      hits: 0,
      text: `《${book.id}》${dir ? `的 ${dir}/ ` : ''}里没有找到「${query}」。`,
    };
  }

  const blocks = [];
  let lastPath = '';
  for (const hit of hits) {
    if (hit.path !== lastPath) {
      blocks.push(`${hit.path}`);
      lastPath = hit.path;
    }
    if (hit.before) blocks.push(`${String(hit.line - 1).padStart(5, ' ')}| ${hit.before}`);
    blocks.push(`${String(hit.line).padStart(5, ' ')}> ${hit.text}`);
    if (hit.after) blocks.push(`${String(hit.line + 1).padStart(5, ' ')}| ${hit.after}`);
  }
  const capped = hits.length >= maxHits;

  return {
    ok: true,
    book: book.id,
    query,
    hits: hits.length,
    matchedDocuments: matchedDocs,
    capped,
    results: hits,
    text: [
      `《${book.id}》里「${query}」命中 ${hits.length} 处（${matchedDocs} 篇文档）${capped ? `；已达上限 ${maxHits} 处，可能还有更多` : ''}`,
      '（`行号>` 是命中行，`行号|` 是它的上一行/下一行上下文）',
      '',
      ...blocks,
    ].join('\n'),
  };
}

/* ------------------------------------------------------------------ 写资料区 */

/**
 * 写一篇文档（三种模式），统一走 `store.saveDocument`。
 *
 * @param {string} root 作品根目录
 * @param {string} relative 已校验的相对路径
 * @param {string} content 新内容
 * @param {'create'|'replace'|'append'} mode
 * @param {number|undefined} expectedMtime 乐观锁（可选）
 */
async function writeDocument(root, relative, content, mode, expectedMtime) {
  const keep = readSettings().backupKeep;
  let next = content;
  let create = mode === 'create';
  if (mode === 'append') {
    const existing = await readExisting(root, relative);
    create = !existing;
    next = existing && existing.content ? `${existing.content.replace(/\n*$/, '\n')}${content}` : content;
  }
  const options = { create, keep };
  if (mode !== 'create' && expectedMtime !== undefined) options.expectedMtime = expectedMtime;
  const saved = await saveDocument(root, relative, next, options);
  return { saved, bytes: Buffer.byteLength(next, 'utf8') };
}

/** `novel_write_reference` 的实现。 */
/**
 * 同一个主题是不是已经有文件了？
 *
 * 只提示、不拦截：作者确实可能想要一个新文件。但模型最常见的坏习惯是
 * 「补充一条就新开一个 xxx-补充.md」，越写越多、越写越碎 —— 这里把现有文件指出来，
 * 让它下一轮直接改写那一个。
 */
const VARIANT_NAME = /(补充|续写|续篇|下卷|附录|其二|其三|v\d+|副本|草稿|临时|备份)/i;

async function referenceDuplicateHint(book, relative) {
  const target = path.basename(relative, '.md');
  const dir = path.posix.dirname(relative);
  const norm = (text) => String(text || '').replace(/[\s（）()【】\[\]\-_·]/g, '').toLowerCase();
  const hints = [];

  if (VARIANT_NAME.test(target)) {
    hints.push('文件名里带「补充 / 续 / v2 / 草稿」这类字样：同一个主题应该在原文件里写清楚，不要拆成平行文件。');
  }

  let docs = [];
  try {
    docs = await store.listDocuments(book.root);
  } catch { docs = []; }

  const siblings = docs
    .filter((doc) => doc.type !== 'chapter' && doc.path !== relative && path.posix.dirname(doc.path) === dir)
    .map((doc) => ({ path: doc.path, title: String(doc.title || path.basename(doc.path, '.md')) }));

  const key = norm(target);
  const similar = siblings.filter((doc) => {
    const other = norm(doc.title);
    if (!key || !other) return false;
    return other === key || other.indexOf(key) >= 0 || key.indexOf(other) >= 0;
  });

  if (similar.length) {
    const first = similar[0];
    hints.push(`资料区里已经有「${first.title}」（${first.path}）：这个主题下次请用 mode=replace 改写它，而不是再建一个文件。`);
  }

  return { hints, similar: similar.map((doc) => doc.path) };
}

async function writeReference(args) {
  const book = resolveBook(args?.book);
  const requested = asText(args?.path).trim();
  if (!requested) throw new ToolRefusal('MISSING_PATH', '缺少 path：要写哪一篇资料（例如 characters/林昭.md）。');
  const relative = resolveInArea(book.root, requested, 'reference');

  const mode = asText(args?.mode).trim() || 'create';
  if (!['create', 'replace', 'append'].includes(mode)) {
    throw new ToolRefusal('BAD_MODE', 'mode 只能是 create / replace / append。');
  }
  const content = asText(args?.content);
  if (!content.trim()) throw new ToolRefusal('EMPTY_CONTENT', 'content 是空的：要写进去什么？');
  if (content.length > WRITE_MAX_CHARS) {
    throw new ToolRefusal('TOO_LARGE', `content 太长了（上限 ${WRITE_MAX_CHARS} 字符）。`);
  }

  const { saved, bytes } = await writeDocument(book.root, relative, content, mode, args?.expectedMtime);

  /* 新建时看一眼是不是"同一主题又开了一个文件"；只提示，不拦。 */
  const duplicate = mode === 'create' ? await referenceDuplicateHint(book, relative) : { hints: [], similar: [] };
  const warning = duplicate.hints.length ? duplicate.hints.join('') : '';

  return {
    ok: true,
    book: book.id,
    path: saved.path,
    mode,
    bytes,
    chars: countChars(content),
    mtime: saved.mtime,
    updatedAt: saved.updatedAt,
    backup: saved.backup === undefined ? null : saved.backup,
    note: mode === 'create' ? '资料区新建（免审批）' : `资料区${mode === 'append' ? '追加' : '覆盖'}（免审批，旧内容已备份）`,
    ...(warning ? { warning, similarPaths: duplicate.similar } : {}),
    text: warning ? `已写入 ${saved.path}。\n\n提醒：${warning}` : `已写入 ${saved.path}。`,
  };
}

/** `novel_delete_reference` 的实现。 */
async function deleteReference(args) {
  const book = resolveBook(args?.book);
  const requested = asText(args?.path).trim();
  if (!requested) throw new ToolRefusal('MISSING_PATH', '缺少 path：要删哪一篇资料。');
  const relative = resolveInArea(book.root, requested, 'reference');

  const existing = await readExisting(book.root, relative);
  if (!existing) throw new ToolRefusal('NOT_FOUND', `《${book.id}》里没有「${relative}」。`);

  /* 现有删除逻辑（documents.deleteDocument）是绑定「当前作品」的：它自己从
     projectContext() 取作品根目录。指定了别的作品时不能拿它去删错书，直接拒绝。 */
  if (!book.isCurrent) {
    throw new ToolRefusal(
      'NOT_CURRENT_BOOK',
      `删除只对当前作品生效（现有删除逻辑绑定当前作品）。现在打开的是「${currentBook(book.settings)?.id || '（无）'}」，`
      + `要删《${book.id}》的资料请先在墨枢里切到那本书。读取与写入不受此限制。`,
    );
  }

  const result = await deleteDocument({ path: relative });
  return {
    ok: true,
    book: book.id,
    path: relative,
    trashedTo: result.path,
    chars: countChars(existing.content),
    note: `已移入 ${result.path}（作品内回收站，没有物理删除，可以手工找回）`,
  };
}

/* ------------------------------------------------------------------ 写小说区（需审批） */

/** `novel_edit_chapter` 的实现。 */

/**
 * 批量改正文：**一次审批，写多章**。
 *
 * 逐章调用 novel_edit_chapter 会让作者点同意点到手软（改十章就是十次弹窗），
 * 于是实际使用中很容易被无脑连点，审批就失去意义。这里把整批合成一次决定：
 * 审批文案里列出每一章、每一章的改动量，作者一次看清、一次决定。
 *
 * 仍然坚持三条：全部先校验再请求审批（不允许写一半才发现路径非法）、
 * 每章都要给 expectedMtime（或显式 force）、写盘只走 store.saveDocument。
 */
async function editChapterBatch(ctx, args, exec) {
  const book = resolveBook(args?.book);
  const raw = Array.isArray(args?.edits) ? args.edits : [];
  if (!raw.length) throw new ToolRefusal('MISSING_EDITS', '缺少 edits：要改哪些章。');
  if (raw.length > 30) throw new ToolRefusal('TOO_MANY', '一次最多 30 章，分批来。');

  const plan = [];
  let totalChars = 0;
  for (const [index, item] of raw.entries()) {
    const requested = asText(item?.path).trim();
    if (!requested) throw new ToolRefusal('MISSING_PATH', `edits[${index}] 缺少 path。`);
    const relative = resolveInArea(book.root, requested, 'chapter');
    const mode = asText(item?.mode).trim() || 'replace';
    if (!['replace', 'append'].includes(mode)) {
      throw new ToolRefusal('BAD_MODE', `edits[${index}] 的 mode 只能是 replace / append（批量不支持 create，新章请单独调用）。`);
    }
    const content = asText(item?.content);
    if (!content.trim()) throw new ToolRefusal('EMPTY_CONTENT', `edits[${index}]（${relative}）的 content 是空的。`);
    if (content.length > WRITE_MAX_CHARS) throw new ToolRefusal('TOO_LARGE', `edits[${index}] 太长了。`);

    const existing = await readExisting(book.root, relative);
    if (!existing) throw new ToolRefusal('NOT_FOUND', `《${book.id}》里没有「${relative}」。`);

    if (args?.force !== true) {
      const expected = Number(item?.expectedMtime);
      if (!Number.isFinite(expected)) {
        throw new ToolRefusal('MISSING_MTIME', `edits[${index}]（${relative}）缺少 expectedMtime：先 novel_read 拿到 mtime 再传进来。`);
      }
      /* readExisting 返回的是 { content, stat }：mtime 在 stat 里，别再读 existing.mtime（永远是
         undefined，比较会静默通过——那就等于没有保护）。 */
      const actual = Number(existing.stat && existing.stat.mtimeMs);
      if (Number.isFinite(actual) && Math.abs(actual - expected) > 1) {
        throw new ToolRefusal('MTIME_CONFLICT', `「${relative}」在读过之后被改过（mtime 不一致），重新读一次再改。`);
      }
    }
    /* saveDocument 没有 append 选项：追加就在读过原文的基础上拼好，再整篇写回。 */
    const body = mode === 'append' ? String(existing.content || '').replace(/\s+$/, '') + '\n\n' + content : content;
    const chars = countChars(content);
    totalChars += chars;
    plan.push({ relative, mode, content: body, chars, expectedMtime: Number(item?.expectedMtime) });
  }

  const lines = plan.map((item, index) => `${index + 1}. ${item.relative} · ${item.mode === 'append' ? '追加' : '整章替换'} · ${item.chars} 字`);
  const reason = [
    `要一次改《${book.id}》的 ${plan.length} 章（共 ${totalChars} 字）：`,
    ...lines,
    '整批只问这一次，同意后全部写入（每章仍会备份到 .backups/）。',
    asText(args?.reason).trim() ? `模型补充说明：${asText(args.reason).trim()}` : '',
  ].filter(Boolean).join('\n');

  const decision = await requestWriteApproval(ctx, exec, reason);
  if (!decision.granted) {
    return {
      ok: false,
      code: decision.code || 'REJECTED',
      message: decision.message || '作者没有同意这次批量修改。',
      planned: plan.length,
      written: 0,
    };
  }

  const results = [];
  for (const item of plan) {
    try {
      const saved = await store.saveDocument(book.root, item.relative, item.content, {
        ...(args?.force === true ? {} : { expectedMtime: item.expectedMtime }),
      });
      results.push({ path: item.relative, ok: true, chars: item.chars, mtime: saved.mtime });
    } catch (error) {
      results.push({ path: item.relative, ok: false, error: error instanceof Error ? error.message : String(error) });
    }
  }
  const written = results.filter((item) => item.ok).length;
  const failed = results.filter((item) => !item.ok);

  return {
    ok: written > 0,
    planned: plan.length,
    written,
    failed: failed.length,
    results,
    text: `已改 ${written}/${plan.length} 章（共 ${totalChars} 字）。`
      + (failed.length ? `\n失败：${failed.map((item) => item.path + '（' + item.error + '）').join('；')}` : ''),
  };
}

async function editChapter(ctx, args, exec) {
  const book = resolveBook(args?.book);
  const requested = asText(args?.path).trim();
  if (!requested) throw new ToolRefusal('MISSING_PATH', '缺少 path：要改哪一章（例如 chapters/chapter-003.md）。');
  const relative = resolveInArea(book.root, requested, 'chapter');

  const mode = asText(args?.mode).trim() || 'replace';
  if (!['replace', 'append', 'create'].includes(mode)) {
    throw new ToolRefusal('BAD_MODE', 'mode 只能是 replace / append / create。');
  }
  const content = asText(args?.content);
  if (!content.trim()) throw new ToolRefusal('EMPTY_CONTENT', 'content 是空的：要改什么？');
  if (content.length > WRITE_MAX_CHARS) {
    throw new ToolRefusal('TOO_LARGE', `content 太长了（上限 ${WRITE_MAX_CHARS} 字符）。`);
  }

  /* 盲写正文会盖掉作者刚在界面里存的内容。要求先 novel_read 拿 mtime；
     确实要盲写（例如刚新建完马上补内容）就显式 force:true。 */
  if (mode !== 'create' && args?.force !== true) {
    const expected = Number(args?.expectedMtime);
    if (!Number.isFinite(expected)) {
      throw new ToolRefusal(
        'MISSING_MTIME',
        '改正文要先 novel_read 拿到这一章的 mtime，再把它作为 expectedMtime 传进来（避免盖掉作者刚做的修改）。确实要盲写请传 force:true。',
      );
    }
  }

  const existing = await readExisting(book.root, relative);
  if (mode === 'create') {
    if (existing) {
      throw new ToolRefusal('ALREADY_EXISTS', `《${book.id}》已经有「${relative}」了；要改它请用 mode=replace / append。`);
    }
    /* 新章节仍然走审批：它落在小说区，和改正文一样需要作者点头。 */
    const reasonCreate = [
      `要在《${book.id}》新建章节「${relative}」：`,
      `共 ${countChars(content)} 字。`,
      '小说区每次改动都需要你确认。',
      asText(args?.reason).trim() ? `模型补充说明：${asText(args.reason).trim()}` : '',
    ].filter(Boolean).join('');
    const decisionCreate = await requestWriteApproval(ctx, exec, reasonCreate);
    if (!decisionCreate.granted) {
      return {
        ok: false,
        code: decisionCreate.code || 'REJECTED',
        message: decisionCreate.message || '作者没有同意新建这一章。',
      };
    }
    /* 章节标题不再写进正文：正文里若带了 `# 标题` 就剥掉，标题记进 chapters.json。 */
    const split = chapterTitles.splitLeadingHeading(content);
    const body = split.body;
    const savedCreate = await store.saveDocument(book.root, relative, body, { create: true });
    const title = asText(args?.title).trim() || split.heading || path.basename(relative, '.md');
    await chapterTitles.setTitle(book.root, relative, title).catch(() => null);
    return {
      ok: true,
      path: relative,
      mode: 'create',
      title,
      chars: countChars(body),
      mtime: savedCreate.mtime,
      text: `已在《${book.id}》新建 ${relative}（${countChars(body)} 字）：《${title}》。标题存在 chapters.json，正文里不再有标题行。`,
    };
  }
  if (!existing) {
    throw new ToolRefusal('NOT_FOUND', `《${book.id}》的 ${CHAPTER_DIR}/ 里没有「${relative}」。要新建一章请用 mode=create；先看清单用 novel_list。`);
  }

  const before = existing.content;
  const beforeChars = countChars(before);
  const nextChars = mode === 'append' ? countChars(before) + countChars(content) : countChars(content);
  const delta = nextChars - beforeChars;
  const title = titleOf(before, relative);
  const extra = asText(args?.reason).trim();

  /* 审批理由必须让作者一眼看懂"改哪一章、改多少字"。 */
  if (!book.isCurrent) {
    throw new ToolRefusal(
      'NOT_CURRENT_BOOK',
      `这本书（《${book.id}》）不是当前打开的作品。改正文请让作者先切到那本书，或者只处理当前作品。`,
    );
  }
  const reason = [
    `要修改《${book.id}》的小说区正文「${relative}」（${title}）：`,
    mode === 'append' ? '在正文末尾追加内容' : '整章替换正文',
    `，${beforeChars} 字 → ${nextChars} 字（${delta >= 0 ? '+' : ''}${delta} 字）。`,
    '小说区每次改动都需要你确认。',
    extra ? `模型补充说明：${extra}` : '',
  ].filter(Boolean).join('');

  /* 先预检磁盘 mtime：作者在模型读完之后又改过这一章时，直接告诉他冲突，
     而不是先让他点一次「允许」、再在落盘阶段报 CONFLICT（那次批准就白费了）。 */
  if (args?.expectedMtime !== undefined && args.expectedMtime !== null) {
    const expected = Number(args.expectedMtime);
    if (Number.isFinite(expected) && Math.abs(existing.mtime - expected) > 1) {
      return {
        ok: false,
        code: 'CONFLICT',
        message: `这一章在你读完之后又被改过了（磁盘 mtime ${Math.round(existing.mtime)}，你读到的是 ${Math.round(expected)}）。请重新 novel_read 再决定怎么改。`,
      };
    }
  }

  const decision = await requestWriteApproval(ctx, exec, reason);
  if (!decision.granted) {
    return {
      ok: false,
      book: book.id,
      path: relative,
      code: `APPROVAL_${String(decision.outcome || 'unavailable').toUpperCase().replace(/-/g, '_')}`,
      approval: decision.outcome,
      reason,
      message: decision.message || refusalOfOutcome(decision.outcome),
    };
  }

  const { saved, bytes } = await writeDocument(book.root, relative, content, mode, args?.expectedMtime);

  return {
    ok: true,
    book: book.id,
    path: saved.path,
    mode,
    approval: 'allowed-once',
    reason,
    bytes,
    charsBefore: beforeChars,
    charsAfter: nextChars,
    mtime: saved.mtime,
    updatedAt: saved.updatedAt,
    backup: saved.backup === undefined ? null : saved.backup,
    note: '正文已按作者的一次性批准写入（旧内容已备份到 .backups/）',
  };
}

/* ------------------------------------------------------------------ 批注 */

/** `novel_annotate_chapter` 的实现。 */
async function annotateChapter(args) {
  const book = resolveBook(args?.book);
  const requested = asText(args?.path).trim();
  if (!requested) throw new ToolRefusal('MISSING_PATH', '缺少 path：给哪一章写批注。');
  const relative = resolveInArea(book.root, requested, 'chapter');

  const quote = asText(args?.quote).trim();
  if (!quote) throw new ToolRefusal('MISSING_QUOTE', '缺少 quote：要批注的原句（必须逐字照抄正文）。');
  const comment = asText(args?.comment).trim();
  if (!comment) throw new ToolRefusal('MISSING_COMMENT', '缺少 comment：这条批注想说什么。');
  if (comment.length > MAX_ANNOTATION_COMMENT) {
    throw new ToolRefusal('TOO_LARGE', `comment 太长了（上限 ${MAX_ANNOTATION_COMMENT} 字）。`);
  }

  const existing = await readExisting(book.root, relative);
  if (!existing) throw new ToolRefusal('NOT_FOUND', `《${book.id}》的 ${CHAPTER_DIR}/ 里没有「${relative}」。`);

  const position = locateQuote(existing.content, quote);
  if (!position) {
    throw new ToolRefusal(
      'ANCHOR_FAILED',
      `在「${relative}」里找不到这段原文，批注没有写。请用 novel_read 读一遍，把 quote 逐字照抄（不要改字、不要跨段拼接、不要带 Markdown 标记）。`,
    );
  }
  const anchoredQuote = existing.content.slice(position.start, position.end);

  const annotation = {
    id: randomUUID(),
    documentPath: relative,
    quote: anchoredQuote,
    start: position.start,
    end: position.end,
    prefix: existing.content.slice(Math.max(0, position.start - 40), position.start),
    suffix: existing.content.slice(position.end, position.end + 40),
    type: ['情节', '逻辑', '设定', '人物', '语言'].includes(args?.type) ? args.type : '情节',
    severity: ['建议', '注意', '严重'].includes(args?.severity) ? args.severity : '建议',
    comment,
    suggestion: asText(args?.suggestion).trim(),
    status: 'open',
    source: 'dsh',
    origin: 'novel-tools',
    createdAt: new Date().toISOString(),
  };

  /* 与 POST /annotations 同一套写法：同一把锁里「读表 → 按 id 合并 → 写回」。 */
  const total = await jsonstore.withDocLock(book.root, 'annotations.json', async () => {
    const current = await jsonstore.readArray(book.root, 'annotations.json', []);
    const byId = new Map(current.map((item) => [item.id, item]));
    byId.set(annotation.id, annotation);
    const merged = [...byId.values()];
    await jsonstore.writeArray(book.root, 'annotations.json', merged);
    return merged.length;
  });

  return {
    ok: true,
    book: book.id,
    path: relative,
    annotation,
    total,
    note: `已把这条批注写进《${book.id}》的 annotations.json（现在共 ${total} 条）；正文没有被改动。`,
    text: [
      `已写入 1 条批注（《${book.id}》现在共 ${total} 条），正文没有改动。`,
      `- 文档：${relative}（第 ${position.start}–${position.end} 字符）`,
      `- 原文：${anchoredQuote.slice(0, 160)}`,
      `- 批注：${comment}`,
    ].join('\n'),
  };
}

/* ------------------------------------------------------------------ 审阅 */

/** `novel_review` 的实现：跑一次现有审阅管线，只返回建议，不落盘。 */
async function reviewTool(ctx, args) {
  const book = resolveBook(args?.book);
  const requested = asText(args?.path).trim();
  if (!requested) throw new ToolRefusal('MISSING_PATH', '缺少 path：审阅哪一章（例如 chapters/chapter-003.md）。');
  const relative = resolveInArea(book.root, requested, 'chapter');

  const instruction = asText(args?.instruction).trim();
  /* 与 AI 工作台同一条护栏：要正文的指令在调模型之前就挡掉。 */
  const safeInstruction = instruction ? guardInstruction(instruction) : '';
  const settings = readSettings();
  const maxAnnotations = asInt(args?.maxAnnotations, settings.maxAnnotations, 1, 20);

  const status = describeStatus(ctx, book.settings);
  if (!status.available) throw new ToolRefusal('MODEL_UNAVAILABLE', status.message);
  const llm = typeof ctx?.get === 'function' ? ctx.get('llm') : undefined;
  if (!llm || typeof llm.stream !== 'function') {
    throw new ToolRefusal('MODEL_UNAVAILABLE', '当前 DSH 进程没有提供可用的 llm 服务，审阅不可用。');
  }

  const existing = await readExisting(book.root, relative);
  if (!existing || !existing.content.trim()) {
    throw new ToolRefusal('NOT_FOUND', `「${relative}」不存在或是空的，没有可审阅的正文。`);
  }

  const recipe = findRecipe('chapter-audit');
  const assembled = await assembleContext({
    novelDir: book.root,
    settings,
    recipe,
    targetPath: relative,
    contextIds: [],
  });
  const document = assembled.document;
  const request = buildRequest('review', {
    instruction: safeInstruction,
    maxAnnotations,
    allowRewriteSuggestion: Boolean(settings.allowRewriteSuggestion),
    subjectName: document?.title || '',
    targetTitle: document?.title || '',
    context: {
      document,
      documents: assembled.documents,
      memories: assembled.memories,
      budget: assembled.budget,
    },
  });

  const text = await streamText(llm, {
    provider: settings.provider,
    model: settings.model,
    system: request.system,
    prompt: request.prompt,
    timeoutMs: AI_TIMEOUT_MS,
  });
  const anchored = anchorAnnotations(text, { documentPath: relative, content: document.content }, maxAnnotations);

  const suggestions = anchored.annotations.map((annotation) => ({
    quote: annotation.quote,
    type: annotation.type,
    severity: annotation.severity,
    comment: annotation.comment,
    suggestion: annotation.suggestion,
    start: annotation.start,
    end: annotation.end,
  }));

  return {
    ok: true,
    book: book.id,
    path: relative,
    model: `${settings.provider} / ${settings.model}`,
    dropped: anchored.dropped,
    suggestions,
    note: '只返回批注建议：没有写入 annotations.json，没有改动正文。要留下某一条请调用 novel_annotate_chapter。',
    text: suggestions.length
      ? [
        `${relative} 审阅完成：${suggestions.length} 条建议（${anchored.dropped} 条因无法逐字锚定被丢弃；${settings.provider} / ${settings.model}）。`,
        '以下内容**没有落盘**，只在这里给你看。',
        '',
        ...suggestions.map((item, index) => [
          `${index + 1}. [${item.severity}·${item.type}] ${item.quote.slice(0, 120)}`,
          `   → ${item.comment}`,
          item.suggestion ? `   ↳ ${item.suggestion}` : '',
        ].filter(Boolean).join('\n')),
      ].join('\n')
      : `${relative} 审阅完成：没有发现需要处理的明确问题（${settings.provider} / ${settings.model}）。`,
  };
}

/* ------------------------------------------------------------------ 地图 */

/**
 * 读地图：返回当前地图摘要 + 完整 JSON，AI 看着它决定怎么画。
 * 只读，不改文件。
 */
async function mapReadTool(args) {
  const book = resolveBook(args?.book);
  const map = await store.readMap(book.root);
  const overview = describeMap(map);
  /* 完整地图原样给模型：以前这里漏了 terrain（地貌）和 width/height，
     于是「读 → 改 → 写回」一轮下来地貌全被抹掉、画布尺寸也被重置。 */
  const full = {
    name: map.name,
    scale: map.scale,
    width: map.width,
    height: map.height,
    landmasses: map.landmasses,
    mountains: map.mountains,
    forests: map.forests,
    terrain: map.terrain || [],
    props: map.props || [],
    decor: map.decor || [],
    rivers: map.rivers,
    routes: map.routes,
    locations: map.locations,
  };
  return {
    ok: true,
    book: book.id,
    name: map.name,
    width: map.width,
    height: map.height,
    counts: {
      landmasses: map.landmasses.length,
      locations: map.locations.length,
      mountains: map.mountains.length,
      forests: map.forests.length,
      terrain: (map.terrain || []).length,
      props: (map.props || []).length,
      decor: (map.decor || []).length,
      rivers: map.rivers.length,
      routes: map.routes.length,
    },
    map: full,
    text: `${overview}\n\n## 完整数据（改完原样传回 novel_map_write.map）\n${JSON.stringify(full, null, 1)}`,
  };
}

/**
 * 写地图：整份替换。地图属于世界资料，**不需要审批**（与资料区一致）。
 * 作者本人在墨枢里也能直接拖拽编辑，两边写的是同一份 `maps/main.map.json`。
 */
async function mapWriteTool(args) {
  const book = resolveBook(args?.book);
  let raw = args?.map;
  /* 有的模型会把整个对象序列化成字符串再传（尤其参数声明不明确时）。
     与其报 MISSING_MAP 让调用方猜，不如把它解析回来。 */
  if (typeof raw === 'string') {
    try {
      raw = JSON.parse(raw);
    } catch {
      throw new ToolRefusal('BAD_MAP', 'map 是一个字符串，但解析不出 JSON。请直接传对象。');
    }
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new ToolRefusal('MISSING_MAP', '缺少 map：要把地图写成什么？（先 novel_map_read 拿到当前结构再改）');
  }
  let map;
  try {
    /* 画布尺寸：模型经常漏这个字段。以前写死 1200×760，等于把别人的画布改小/改大。
       现在先把现有地图读出来，用它自己的尺寸当默认——只有作品还没有地图时才用初始尺寸。 */
    let existing = null;
    try {
      existing = await store.readMap(book.root);
    } catch {
      existing = null;
    }
    map = validateMap({
      width: existing && existing.width ? existing.width : CANVAS.width,
      height: existing && existing.height ? existing.height : CANVAS.height,
      ...raw,
    });
  } catch (error) {
    throw new ToolRefusal('BAD_MAP', error instanceof Error ? error.message : String(error));
  }
  /* 地图属于资料区：AI 有完整权限，可以整张重画、也可以覆盖作者画过的地形。
     唯一的约束是"别把本意之外的东西丢掉"——所以先 novel_map_read 是推荐做法，
     但不是强制；作者要求「推倒重画」时本来就该照做。 */
  const previous = await store.readMap(book.root).catch(() => null);
  await jsonstore.writeObject(book.root, 'maps/main.map.json', map);
  const beforeCounts = previous ? mapCount(previous) : null;
  return {
    ok: true,
    book: book.id,
    name: map.name,
    replaced: Boolean(beforeCounts),
    before: beforeCounts,
    counts: {
      landmasses: map.landmasses.length,
      locations: map.locations.length,
      mountains: map.mountains.length,
      forests: map.forests.length,
      rivers: map.rivers.length,
      routes: map.routes.length,
    },
    text: `已写入地图《${map.name}》：陆地 ${map.landmasses.length} 块、地点 ${map.locations.length} 个、`
      + `山脉 ${map.mountains.length} 处、森林 ${map.forests.length} 处、河流 ${map.rivers.length} 条、路线 ${map.routes.length} 条。`
      + '作者可以直接在墨枢的「世界地图」里继续拖拽修改。',
  };
}

/* --------------------------- 细粒度地图编辑 --------------------------- */

/**
 * 一次"读—改—写"的公共流程：读当前地图 → 交给 mutate 改 → 校验 → 落盘。
 *
 * 为什么要细粒度工具：整份 `novel_map_write` 要求 AI 先读全文再原样写回，
 * 只要漏抄一段就会把作者画好的地形抹掉。分工是：
 * - 想**局部**加/改/删 → 用下面这组工具，只碰目标对象；
 * - 想**重画整张图** → 才用 novel_map_write（而且默认拒绝覆盖非空地图）。
 *
 * @param {object} args
 * @param {(map: any) => {map: any, text: string}} mutate
 */
async function editMap(args, mutate) {
  const book = resolveBook(args?.book);
  const current = await store.readMap(book.root);
  const produced = mutate(current);
  if (!produced || !produced.map) throw new ToolRefusal('BAD_MUTATION', '内部错误：没有产出地图。');
  let next;
  try {
    next = validateMap(produced.map);
  } catch (error) {
    throw new ToolRefusal('BAD_MAP', error instanceof Error ? error.message : String(error));
  }
  await jsonstore.writeObject(book.root, 'maps/main.map.json', next);
  const counts = {
    landmasses: next.landmasses.length,
    locations: next.locations.length,
    mountains: next.mountains.length,
    forests: next.forests.length,
    rivers: next.rivers.length,
    routes: next.routes.length,
  };
  return {
    ok: true,
    book: book.id,
    counts,
    text: `${produced.text}\n\n当前地图：陆地 ${counts.landmasses} 块、地点 ${counts.locations} 个、`
      + `山脉 ${counts.mountains} 处、森林 ${counts.forests} 处、河流 ${counts.rivers} 条、路线 ${counts.routes} 条。`,
  };
}

/** 取参数里的点数组，容忍 {x,y} 或 [x,y]。 */
function asPoints(value, label) {
  if (!Array.isArray(value)) throw new ToolRefusal('BAD_POINTS', `${label} 要是数组，例如 [{x:100,y:200},{x:300,y:260}]。`);
  return value.map((point, index) => {
    if (Array.isArray(point)) return { x: Number(point[0]), y: Number(point[1]) };
    if (point && typeof point === 'object') return { x: Number(point.x), y: Number(point.y) };
    throw new ToolRefusal('BAD_POINTS', `${label} 第 ${index + 1} 个点不是 {x,y}。`);
  });
}

const mapCount = (map) => ({
  landmasses: map.landmasses.length,
  locations: map.locations.length,
  mountains: map.mountains.length,
  forests: map.forests.length,
  rivers: map.rivers.length,
  routes: map.routes.length,
});

/**
 * 按 id 或名字找一个对象（名字模糊匹配，方便 AI 用"主陆"这种称呼）。
 * @returns {{index:number, item:any}|undefined}
 */
function findNamed(list, key) {
  const wanted = String(key || '').trim();
  if (!wanted) return undefined;
  const byId = list.findIndex((item) => String(item.id) === wanted);
  if (byId >= 0) return { index: byId, item: list[byId] };
  const byName = list.findIndex((item) => String(item.name || '').trim() === wanted);
  if (byName >= 0) return { index: byName, item: list[byName] };
  const loose = list.findIndex((item) => String(item.name || '').includes(wanted));
  if (loose >= 0) return { index: loose, item: list[loose] };
  return undefined;
}

/* ------------------------------------------------------------------ 注册 */

/**
 * 模型侧工具集。每条 description 都必须回答三件事：
 * 会不会改文件、改哪里、需不需要审批——模型靠这个决定用哪个工具。
 */
export function apply(ctx) {
  /* 工具参数必须是**标准 JSON Schema**：宿主把 parameters 原样交给模型，
     并按它做输入校验。以前传的是 `{path:{type:'string',required:true}}` 这种自造形状，
     模型看不到参数声明、宿主也不校验（审计实测：assertObjectJsonSchema 直接拒绝）。
     这里在注册前统一转换：{ key: {type, description, required, enum, items} } → object schema。 */
  const toJsonSchema = (spec) => {
    if (!spec || typeof spec !== 'object') return { type: 'object', properties: {}, additionalProperties: false };
    /* 已经是 JSON Schema 就不要二次包装 */
    if (spec.type === 'object' && spec.properties) return spec;
    const properties = {};
    const required = [];
    for (const [name, raw] of Object.entries(spec)) {
      const field = raw && typeof raw === 'object' ? raw : { type: 'string' };
      const node = {};
      /* 以前这里没有 'object'，`map: {type:'object'}` 会被发成 **string**：
         于是模型把整张地图当字符串传，大一点就被当成"没给" → MISSING_MAP。 */
      const type = field.type === 'integer' ? 'integer'
        : field.type === 'number' ? 'number'
          : field.type === 'boolean' ? 'boolean'
            : field.type === 'array' ? 'array'
              : field.type === 'object' ? 'object'
                : 'string';
      node.type = type;
      if (field.description) node.description = field.description;
      if (Array.isArray(field.enum)) node.enum = field.enum;
      if (type === 'array') node.items = field.items && typeof field.items === 'object' ? field.items : { type: 'string' };
      if (type === 'object') {
        /* 开放对象：不写 properties 就表示"任意字段"。别加 additionalProperties，
           服务端对多余关键字敏感（11129）。 */
        if (field.properties && typeof field.properties === 'object') node.properties = field.properties;
        if (Array.isArray(field.required) && field.required.length) node.required = field.required;
      }
      properties[name] = node;
      if (field.required === true) required.push(name);
    }
    /* 形状必须和宿主自己的 parameterSchemaSpecToJsonSchema() 产物**逐字一致**：
       它只给 type / properties / required，**不带 additionalProperties**。
       多写一个 additionalProperties:false，服务端会判「工具定义不合规」
       （实测报 11129 invalid function call parameters，整个会话 503）。 */
    const schema = { type: 'object', properties };
    if (required.length) schema.required = required;
    return schema;
  };
  /**
   * 工具返回值必须是**可无损 JSON 化**的：宿主会做一次快照，带 undefined 属性 /
   * 非有限数字 / Date 的值会被判成 "value is not lossless JSON"（实测
   * novel_write_reference 明明写盘成功，9 次全都报这个错）。
   * 这里统一走一次 JSON 往返，返回的东西从构造上就是无损的。
   */
  const lossless = (value) => {
    if (value === undefined) return { ok: true };
    try {
      return JSON.parse(JSON.stringify(value));
    } catch {
      return { ok: false, code: 'BAD_OUTPUT', message: '这次的结果无法序列化，操作本身可能已经成功，请用 novel_read 确认。' };
    }
  };

  const register = (definition) => ctx.tools.register({
    ...definition,
    parameters: toJsonSchema(definition.parameters),
    /* 工具也要落在「发起这次对话」的作用域里：AI 读写的是这个对话自己的书库，
       而不是共享库。会话 id 来自 exec.agent.session.id。 */
    execute: async (args, exec) => {
      const sessionId = exec && exec.agent && exec.agent.session ? exec.agent.session.id : '';
      const value = await runInScope(sanitizeScope(sessionId), () => definition.execute(args, exec));
      return lossless(value);
    },
    output: OUTPUT,
  });

  register({
    name: 'novel_overview',
    description:
      'Read-only. Summarize the open novel (book name, chapter count, chapter word count, per-category reference counts, and the most recently edited chapter). '
      + 'Changes nothing on disk. Call this first to know what the book contains before reading or writing anything.',
    parameters: {
      book: {
        type: 'string',
        description: '作品名（默认当前打开的作品，例如「天灾之下」）。一般不用填。',
      },
    },
    execute: guard(overview),
  });

  register({
    name: 'novel_list',
    description:
      'Read-only. List document paths in the open novel, optionally filtered by type (chapter/character/location/world/outline/memory/clue). '
      + 'Returns paths with titles and word counts, not full text. Changes nothing on disk.',
    parameters: {
      type: {
        type: 'string',
        enum: [...TYPE_NAMES],
        description: '只看某一类文档：chapter / character / location / world / outline / memory / clue。不填则列出全部。',
      },
      book: {
        type: 'string',
        description: '作品名（默认当前作品）。',
      },
    },
    execute: guard(listTool),
  });

  register({
    name: 'novel_read',
    description:
      'Read-only. Read one Markdown document of the novel with line numbers. Use offset/limit for long chapters; the result says how many lines were returned and how to continue. '
      + 'Changes nothing on disk. Always read a chapter before editing, reviewing, or annotating it, and copy quotes verbatim from here.',
    parameters: {
      path: {
        type: 'string',
        required: true,
        description: '作品内相对路径，例如 chapters/chapter-001.md 或 characters/林昭.md。必须是 .md。',
      },
      offset: {
        type: 'integer',
        description: '从第几行开始读（1 起，默认 1）。',
      },
      limit: {
        type: 'integer',
        description: '最多读多少行（默认 200，上限 400）。',
      },
      book: {
        type: 'string',
        description: '作品名（默认当前作品）。',
      },
    },
    execute: guard(readTool),
  });

  register({
    name: 'novel_search',
    description:
      'Read-only. Full-book text search across every Markdown document; returns the matching line with its line number plus the line before and after. '
      + 'Case-insensitive substring match, no regex. Changes nothing on disk. Use it to find where a name, object, or sentence appears before claiming the book never mentions it.',
    parameters: {
      query: {
        type: 'string',
        required: true,
        description: '要检索的片段（一段原文、一个人名、一个地名都行，上限 200 字）。',
      },
      type: {
        type: 'string',
        description: '只搜某一类文档（chapter / character / location / world / outline / memory / clue）。不填则搜全书。',
      },
      maxResults: {
        type: 'integer',
        description: `最多返回多少处命中（默认 ${SEARCH_MAX_HITS}，上限 ${SEARCH_MAX_HITS}）。`,
      },
      book: {
        type: 'string',
        description: '作品名（默认当前作品）。',
      },
    },
    execute: guard(searchTool),
  });

  register({
    name: 'novel_write_reference',
    description:
      'WRITES FILES, no approval needed. Creates, overwrites, or appends one Markdown document in the REFERENCE area of the novel: '
      + `${REFERENCE_DIRS.map((dir) => `${dir}/`).join(', ')} — character sheets, locations, worldbuilding, outline, memory notes, clue ledgers. `
      + 'Overwrites back up the old content under .backups/ first. It REFUSES anything under chapters/: prose belongs to novel_edit_chapter and needs the author\'s approval. '
      + 'Write only facts you actually read in this book; never invent canon. '
      + 'EDIT IN PLACE: if the topic already has a file, use mode=replace and merge the new facts into it — do not spawn parallel files like "xxx-补充.md", "xxx（二）", "xxx-v2.md". '
      + 'ONE TOPIC, ONE COMPLETE FILE: write the whole thing in that file (e.g. an artefact split into three parts? name all three, where each one is and who holds it) instead of half-writing it or splitting it across files. '
      + 'NO WORK-LOG: never write "a later conversation added…", "updated as requested", "（新增）" or any note about your own editing process — the document is canon, not a changelog.',
    parameters: {
      path: {
        type: 'string',
        required: true,
        description: `资料区相对路径，必须以 ${REFERENCE_DIRS.map((dir) => `${dir}/`).join(' / ')} 之一开头，且是 .md。例如 characters/林昭.md。`,
      },
      content: {
        type: 'string',
        required: true,
        description: '要写入的完整 Markdown（append 模式下只给要追加的那一段）。',
      },
      mode: {
        type: 'string',
        enum: ['create', 'replace', 'append'],
        description: 'replace=整篇覆盖/合并（**主题已存在时用这个**）/ create=只新建（已存在会失败）/ append=接到末尾（只在真的往清单、时间线后面追加时用）。默认 create。',
      },
      force: {
        type: 'boolean',
        description: 'true = 不校验 mtime 直接写（会覆盖作者在这期间做的修改，慎用）。',
      },
      expectedMtime: {
        type: 'number',
        description: '可选乐观锁：传你在 novel_read 得到的 mtime，磁盘在这之后被改过就会失败而不是覆盖别人的改动。',
      },
      book: {
        type: 'string',
        description: '作品名（默认当前作品）。',
      },
    },
    execute: guard(writeReference),
  });

  register({
    name: 'novel_delete_reference',
    description:
      'DELETES one Markdown document from the REFERENCE area (characters/ locations/ world/ outline/ memory/ clues/), no approval needed. '
      + 'It moves the file into the book\'s .trash/<timestamp>/ folder instead of erasing it, so it can be recovered. '
      + 'It refuses chapters/ and only works on the currently open book. Prefer editing over deleting.',
    parameters: {
      path: {
        type: 'string',
        required: true,
        description: '要删的资料相对路径（六个资料目录之一，.md）。',
      },
      book: {
        type: 'string',
        description: '作品名（默认当前作品；删除只支持当前作品）。',
      },
    },
    execute: guard(deleteReference),
  });


/* ------------------------------------------------------------------ 章节管理 */

/** 文件名里不能出现的字符，换成一个短横。 */
function slugOf(title) {
  return String(title || '')
    .trim()
    .replace(/[\\/:*?"<>|]/g, '')
    .replace(/\s+/g, '-')
    .slice(0, 40);
}

/**
 * 章节级管理：改名 / 上下移动 / 删除。
 *
 * 三条都落在小说区，所以**都要审批**；删除是移到作品内的 `.trash`（可找回），
 * 不是物理删除。复用 `documents.js` 里作者本人也在用的同一套实现。
 */
async function chapterManageTool(ctx, args, exec) {
  const book = resolveBook(args?.book);
  const action = asText(args?.action).trim().toLowerCase();
  if (['rename', 'move', 'delete'].indexOf(action) < 0) {
    throw new ToolRefusal('BAD_ACTION', 'action 只能是 rename / move / delete。');
  }
  const requested = asText(args?.path).trim();
  if (!requested) throw new ToolRefusal('MISSING_PATH', '缺少 path：要管理哪一章（例如 chapters/chapter-003.md）。');
  const relative = resolveInArea(book.root, requested, 'chapter');

  const existing = await readExisting(book.root, relative);
  if (!existing) {
    throw new ToolRefusal('NOT_FOUND', `《${book.id}》的 ${CHAPTER_DIR}/ 里没有「${relative}」。`);
  }
  const currentTitle = titleOf(existing.content, relative);

  let reason;
  if (action === 'rename') {
    const nextTitle = asText(args?.title).trim().slice(0, 120);
    if (!nextTitle) throw new ToolRefusal('MISSING_TITLE', 'rename 需要 title（新的章节标题）。');
    reason = `要把《${book.id}》的「${relative}」改名为《${nextTitle}》（正文标题与文件名一起改）。`;
  } else if (action === 'move') {
    const direction = asText(args?.direction).trim().toLowerCase();
    if (direction !== 'up' && direction !== 'down') throw new ToolRefusal('BAD_DIRECTION', 'move 需要 direction: up 或 down。');
    reason = `要把《${book.id}》的「${relative}」${direction === 'up' ? '上移一章' : '下移一章'}（交换文件序号，正文不动）。`;
  } else {
    reason = `要把《${book.id}》的「${relative}」（${currentTitle}）移到作品内的 .trash 回收站。`;
  }
  const extra = asText(args?.reason).trim();
  if (extra) reason += `\n模型补充说明：${extra}`;

  const decision = await requestWriteApproval(ctx, exec, reason);
  if (!decision.granted) {
    return {
      ok: false,
      code: decision.code || 'REJECTED',
      message: decision.message || '作者没有同意这次章节管理操作。',
    };
  }

  try {
    if (action === 'move') {
      const direction = asText(args?.direction).trim().toLowerCase();
      const result = await documents.moveIn(book.root, relative, direction);
      return { ok: true, action, paths: result.paths, text: '已移动：「' + relative + '」。' };
    }
    if (action === 'delete') {
      const result = await documents.deleteIn(book.root, relative);
      return {
        ok: true,
        action,
        path: result.path,
        text: '已把「' + relative + '」移到回收站（' + result.path + '），可以从作品目录的 .trash 找回。',
      };
    }

    /* rename：**只改标题元数据**（chapters.json），正文一个字不动；
       旧数据里若还留着 `# 旧标题`，顺手把它从正文剥掉。文件名照旧跟着改。 */
    const nextTitle = asText(args?.title).trim().slice(0, 120);
    if (!nextTitle) throw new ToolRefusal('MISSING_TITLE', 'rename 需要 title。');
    const splitOld = chapterTitles.splitLeadingHeading(existing.content);
    if (splitOld.heading) {
      await store.saveDocument(book.root, relative, splitOld.body, { expectedMtime: existing.mtime });
    }
    await chapterTitles.setTitle(book.root, relative, nextTitle);

    const baseName = relative.split('/').pop() || '';
    const matched = /^chapter-(\d+)(?:-([^/]*))?\.md$/i.exec(baseName);
    const slug = slugOf(nextTitle);
    const nextName = matched
      ? 'chapter-' + matched[1] + (slug ? '-' + slug : '') + '.md'
      : (slug || baseName);
    const target = CHAPTER_DIR + '/' + nextName;
    if (target !== relative) await documents.renameIn(book.root, relative, target);
    return {
      ok: true,
      action,
      path: target,
      title: nextTitle,
      text: '已改名为《' + nextTitle + '》，文件：' + target + '。',
    };
  } catch (error) {
    if (error instanceof ToolRefusal) throw error;
    throw new ToolRefusal('MANAGE_FAILED', error instanceof Error ? error.message : String(error));
  }
}

  register({
    name: 'novel_chapter_manage',
    description:
      'ADMINISTERS chapter files in chapters/: rename (rewrites the # heading and the file name), move up/down (swaps the file number, body untouched), '
      + 'or delete (moved into the book\'s own .trash, recoverable). Every action requires the author\'s approval. '
      + 'Read the chapter first with novel_read. Use novel_edit_chapter for writing the body.',
    parameters: {
      action: { type: 'string', required: true, enum: ['rename', 'move', 'delete'], description: 'rename 改名 / move 上下移动 / delete 移到回收站。' },
      path: { type: 'string', required: true, description: '章节相对路径，例如 chapters/chapter-003.md。' },
      title: { type: 'string', description: 'rename 时的新标题（同时写进 # 一级标题与文件名）。' },
      direction: { type: 'string', enum: ['up', 'down'], description: 'move 时必填。' },
      reason: { type: 'string', description: '给作者看的补充说明（一句话）。' },
      book: { type: 'string', description: '作品名（默认当前作品）。' },
    },
    execute: guard((args, exec) => chapterManageTool(ctx, args, exec)),
  });

  register({
    name: 'novel_annotations_read',
    description:
      'Read-only. List the annotations that already exist on this book (the author\'s manual notes and earlier AI reviews), '
      + 'optionally filtered by chapter path or status. Use it before writing a new annotation so you do not duplicate an existing one. '
      + 'Changes nothing on disk.',
    parameters: {
      documentPath: { type: 'string', description: '只看某一章，例如 chapters/chapter-003.md（省略=全书）。' },
      status: { type: 'string', enum: ['open', 'resolved', 'stale'], description: '只看某个状态。' },
      limit: { type: 'integer', description: '最多返回多少条，默认 30。' },
      book: { type: 'string', description: '作品名（默认当前作品）。' },
    },
    execute: guard(async (args) => {
      const book = resolveBook(args?.book);
      const wantedPath = asText(args?.documentPath).trim();
      const wantedStatus = asText(args?.status).trim();
      const limit = Math.min(Math.max(asInt(args?.limit) ?? 30, 1), 200);
      const all = await store.readAnnotations(book.root);
      const filtered = all.filter((item) => {
        if (wantedPath && item.documentPath !== wantedPath) return false;
        if (wantedStatus && (item.status || 'open') !== wantedStatus) return false;
        return true;
      });
      const page = filtered.slice(0, limit);
      return {
        ok: true,
        total: all.length,
        matched: filtered.length,
        annotations: page.map((item) => ({
          id: item.id,
          documentPath: item.documentPath,
          status: item.status || 'open',
          type: item.type || '',
          severity: item.severity || '',
          quote: String(item.quote || '').slice(0, 120),
          comment: String(item.comment || '').slice(0, 300),
        })),
        text: `共 ${all.length} 条批注，匹配 ${filtered.length} 条，返回 ${page.length} 条。`,
      };
    }),
  });

  register({
    name: 'novel_tasks_read',
    description:
      'Read-only. List recent AI task records for this book (review runs, generated annotations, status). '
      + 'Use it to see whether a review already ran, so you do not repeat it. Changes nothing on disk.',
    parameters: {
      limit: { type: 'integer', description: '最多返回多少条，默认 10。' },
      book: { type: 'string', description: '作品名（默认当前作品）。' },
    },
    execute: guard(async (args) => {
      const book = resolveBook(args?.book);
      const limit = Math.min(Math.max(asInt(args?.limit) ?? 10, 1), 100);
      const tasks = await jsonstore.readArray(book.root, 'tasks.json', []);
      const sorted = tasks.slice().reverse().slice(0, limit);
      return {
        ok: true,
        total: tasks.length,
        tasks: sorted.map((item) => ({
          id: item.id,
          type: item.type || '',
          status: item.status || '',
          title: item.title || '',
          summary: String(item.summary || '').slice(0, 200),
          createdAt: item.createdAt || '',
        })),
        text: `共 ${tasks.length} 条任务记录，返回最近 ${sorted.length} 条。`,
      };
    }),
  });

  register({
    name: 'novel_chapter_batch',
    description:
      'BATCH-WRITES SEVERAL CHAPTERS WITH ONE SINGLE APPROVAL PROMPT. Use it whenever you are touching more than one chapter in a turn (rewriting a batch, applying the same fix everywhere, appending a scene to each): '
      + 'the author approves the whole batch once, instead of clicking allow ten times. '
      + 'Every item needs path + content, mode replace (default) or append, and expectedMtime from novel_read unless force:true. '
      + 'All paths and mtimes are validated BEFORE the approval is requested, so a rejected plan writes nothing at all; after approval each file is still backed up under .backups/. '
      + 'For a single chapter prefer novel_edit_chapter; for creating new chapters use novel_edit_chapter with mode=create.',
    parameters: {
      edits: {
        type: 'array',
        required: true,
        description: '要改的章节列表（最多 30 条）。',
        items: {
          type: 'object',
          properties: {
            path: { type: 'string', description: '章节相对路径，例如 chapters/chapter-003.md。' },
            content: { type: 'string', description: 'mode=replace 是整章新全文；append 只给追加部分。' },
            mode: { type: 'string', enum: ['replace', 'append'], description: 'replace 整章替换（默认）/ append 追加。' },
            expectedMtime: { type: 'number', description: 'novel_read 拿到的 mtime（除非 force）。' },
          },
          required: ['path', 'content'],
        },
      },
      reason: { type: 'string', description: '一句话说明这批改动要做什么（会显示在审批框里）。' },
      force: { type: 'boolean', description: 'true = 跳过 mtime 校验（慎用）。' },
      book: { type: 'string', description: '作品名（默认当前作品）。' },
    },
    execute: guard((args, exec) => editChapterBatch(ctx, args, exec)),
  });

  register({
    name: 'novel_edit_chapter',
    description:
      'WRITES PROSE, ALWAYS REQUIRES THE AUTHOR\'S APPROVAL. Replaces or appends the body of ONE chapter under chapters/. '
      + 'Before writing it asks the author through the harness approval prompt, naming the chapter and the exact word-count change; only an explicit "allow once" writes anything, '
      + 'and a reject/cancel/unavailable answer is reported back with the file untouched. The old text is backed up under .backups/. '
      + 'Use it only for changes the author asked for — never to continue the story or to silently rewrite their prose. '
      + 'When you do write, edit the existing paragraphs in place and keep the author\'s voice: no "here I added…" comments, no summary paragraphs explaining your change. '
      + 'For reference material use novel_write_reference instead: that one is free. '
      + 'Touching more than one chapter in a turn? Use novel_chapter_batch: it asks the author once for the whole set instead of once per chapter.',
    parameters: {
      path: {
        type: 'string',
        required: true,
        description: '章节相对路径，必须形如 chapters/chapter-003.md。',
      },
      content: {
        type: 'string',
        required: true,
        description: 'mode=replace 时是本章的新全文；mode=append 时只给要追加的这一段。',
      },
      mode: {
        type: 'string',
        enum: ['replace', 'append', 'create'],
        description: 'replace=整章替换（默认）/ append=接到本章末尾 / create=新建这一章（同样要审批）。',
      },
      force: {
        type: 'boolean',
        description: 'true = 跳过 mtime 校验直接写。会覆盖作者在这期间做的修改，除非你确定，否则先 novel_read 拿 expectedMtime。',
      },
      reason: {
        type: 'string',
        description: '给作者看的补充说明（会显示在审批请求里）：为什么这一章要这样改。一句话即可。',
      },
      expectedMtime: {
        type: 'number',
        description: '可选乐观锁：传你在 novel_read 得到的 mtime。作者在你读完之后又改过这一章时会失败而不是覆盖。',
      },
      book: {
        type: 'string',
        description: '作品名（默认当前作品）。',
      },
    },
    execute: guard((args, exec) => editChapter(ctx, args, exec)),
  });

  register({
    name: 'novel_annotate_chapter',
    description:
      'Adds ONE annotation (a comment anchored to a verbatim sentence) to a chapter WITHOUT touching the prose, no approval needed. '
      + 'It writes into the book\'s annotations.json only; the chapter file is not modified. quote must be copied character-for-character from novel_read — '
      + 'an unanchored quote is rejected instead of stored.',
    parameters: {
      path: {
        type: 'string',
        required: true,
        description: '章节相对路径，例如 chapters/chapter-003.md。',
      },
      quote: {
        type: 'string',
        required: true,
        description: '要批注的原句，必须与正文逐字一致（不改字、不跨段、不带 Markdown 标记）。',
      },
      comment: {
        type: 'string',
        required: true,
        description: '这条批注说什么：这句为什么有问题、会造成什么后果。',
      },
      type: {
        type: 'string',
        enum: ['情节', '逻辑', '设定', '人物', '语言'],
        description: '批注类别，默认「情节」。',
      },
      severity: {
        type: 'string',
        enum: ['建议', '注意', '严重'],
        description: '严重程度，默认「建议」。',
      },
      suggestion: {
        type: 'string',
        description: '修改方向（只描述往哪个方向改，不要给出可整句替换正文的成句）。',
      },
      book: {
        type: 'string',
        description: '作品名（默认当前作品）。',
      },
    },
    execute: guard(annotateChapter),
  });

  register({
    name: 'novel_memory_write',
    description:
      'WRITES one confirmed project memory entry, no approval needed (memory is worldbuilding material). '
      + 'This is the store the author\'s Memory panel reads and the one injected into review context, so use it instead of only writing memory/*.md. '
      + 'Upserts by title: an existing entry with the same title is replaced. Keep entries short and factual.',
    parameters: {
      title: { type: 'string', required: true, description: '记忆标题，例如「雾的规则」。同名即覆盖。' },
      content: { type: 'string', required: true, description: '记忆内容（一两句，只写书里真的写到的）。' },
      type: {
        type: 'string',
        enum: ['canon', 'character', 'plot', 'world', 'rule', 'other'],
        description: '分类，默认 canon。',
      },
      locked: { type: 'boolean', description: 'true = 高优先级（注入时排在最前）。' },
      book: { type: 'string', description: '作品名（默认当前作品）。' },
    },
    execute: guard(async (args) => {
      const book = resolveBook(args?.book);
      const title = asText(args?.title).trim().slice(0, 120);
      const content = asText(args?.content).trim().slice(0, 2000);
      if (!title) throw new ToolRefusal('MISSING_TITLE', '缺少 title。');
      if (!content) throw new ToolRefusal('MISSING_CONTENT', '缺少 content。');
      const types = ['canon', 'character', 'plot', 'world', 'rule', 'other'];
      const rawType = asText(args?.type).trim().toLowerCase();
      const type = types.indexOf(rawType) >= 0 ? rawType : 'canon';
      const locked = args?.locked === true;

      const result = await jsonstore.withDocLock(book.root, 'memory/memory.json', async () => {
        const list = await jsonstore.readArray(book.root, 'memory/memory.json', []);
        const next = Array.isArray(list) ? list.slice() : [];
        const at = next.findIndex((item) => item && String(item.title || '').trim() === title);
        const entry = {
          ...(at >= 0 ? next[at] : {}),
          id: at >= 0 && next[at].id ? next[at].id : 'memory-' + randomUUID().slice(0, 8),
          title,
          content,
          type,
          status: 'confirmed',
          source: 'AI · novel_memory_write',
          locked: locked || (at >= 0 && next[at].locked === true),
          updatedAt: new Date().toISOString(),
        };
        if (at >= 0) next[at] = entry;
        else next.push(entry);
        await jsonstore.writeArray(book.root, 'memory/memory.json', next);
        return { entry, total: next.length, replaced: at >= 0 };
      });

      return {
        ok: true,
        id: result.entry.id,
        replaced: result.replaced,
        total: result.total,
        text: (result.replaced ? '已更新' : '已新增') + '记忆「' + title + '」，当前共 ' + result.total + ' 条。',
      };
    }),
  });


/* ------------------------------------------------------------------ 素材与装饰 */

/** AI 自己画一张 SVG，存进这本书的素材库（可选：直接贴到地图上）。 */
async function mapDrawTool(args) {
  const book = resolveBook(args?.book);
  const name = asText(args?.name).trim();
  if (!name) throw new ToolRefusal('MISSING_NAME', '缺少 name：这张素材叫什么。');
  const svg = asText(args?.svg);
  if (!svg.trim()) throw new ToolRefusal('MISSING_SVG', '缺少 svg：要画的图形（24×24 的 <svg>…</svg>）。');

  let written;
  try {
    written = await assetsApi.writeAsset(book.root, {
      name,
      svg,
      kind: asText(args?.kind).trim() || 'icon',
      id: asText(args?.id).trim() || undefined,
    });
  } catch (error) {
    throw new ToolRefusal('BAD_SVG', error instanceof Error ? error.message : String(error));
  }

  const place = args?.place;
  if (place && typeof place === 'object') {
    const x = Number(place.x);
    const y = Number(place.y);
    if (!Number.isFinite(x) || !Number.isFinite(y)) {
      throw new ToolRefusal('BAD_POINTS', 'place.x / place.y 必须是画布坐标（数字）。');
    }
    const decor = {
      id: 'decor-' + randomUUID().slice(0, 8),
      assetId: written.entry.id,
      x,
      y,
      ...(Number.isFinite(Number(place.scale)) ? { scale: Number(place.scale) } : {}),
      ...(Number.isFinite(Number(place.rotation)) ? { rotation: Number(place.rotation) } : {}),
    };
    /* 这里不能吞异常：装饰没写进去要如实告诉调用方。 */
    await editMap(args, (current) => ({
      map: { ...current, decor: (current.decor || []).concat([decor]) },
      text: '已把「' + written.entry.name + '」贴到地图上。',
    }));
  }

  return {
    ok: true,
    id: written.entry.id,
    name: written.entry.name,
    kind: written.entry.kind,
    placed: Boolean(place && typeof place === 'object'),
    text: '已画好素材「' + written.entry.name + '」（id ' + written.entry.id + '）'
      + (place && typeof place === 'object' ? '，并贴到了地图上的 (' + Math.round(Number(place.x)) + ', ' + Math.round(Number(place.y)) + ')。' : '，可以在 place.icon 里用 asset:' + written.entry.id + ' 引用。'),
  };
}

/**
 * 已有的素材清单。
 * 只读，AI 可以据此复用同一张图，而不是每次重画。
 */
async function mapAssetsTool(args) {
  const book = resolveBook(args?.book);
  const list = await assetsApi.listAssets(book.root);
  const trimmed = list.slice(0, 60);
  return {
    ok: true,
    total: list.length,
    assets: trimmed.map((item) => ({ id: item.id, name: item.name, kind: item.kind })),
    text: list.length
      ? '共 ' + list.length + ' 张素材：' + trimmed.map((item) => item.id + '(' + item.name + ')').join('、')
      : '还没有素材。可以用 novel_map_draw 画一张。',
  };
}

  register({
    name: 'novel_map_draw',
    description:
      'DRAWS one reusable SVG artwork and stores it in this book\'s asset library, no approval needed. '
      + 'Use it for anything the built-in shapes cannot express: a unique town icon, a landmark silhouette, a clan banner, a sea monster. '
      + 'The svg must be a complete 24x24 <svg>…</svg> using only paths/shapes (no scripts, no external links, no <image>). '
      + 'Optionally pass place {x,y,scale,rotation} to drop it onto the map immediately as decoration. '
      + 'The author\'s map panel picks new assets up automatically, and locations can reference them with icon = "asset:<id>".',
    parameters: {
      name: { type: 'string', required: true, description: '素材名称，例如「黑石堡」「羽蛇图腾」。' },
      svg: { type: 'string', required: true, description: '完整的 24×24 SVG 字符串。' },
      kind: { type: 'string', enum: ['icon', 'stamp', 'pattern'], description: '用途：icon 地点图标（默认）/ stamp 图章 / pattern 底纹。' },
      id: { type: 'string', description: '想自己指定 id（覆盖同名素材时用）。' },
      place: {
        type: 'object',
        description: '可选：直接贴到地图上。{x, y, scale?, rotation?}',
        properties: {
          x: { type: 'number' },
          y: { type: 'number' },
          scale: { type: 'number' },
          rotation: { type: 'number' },
        },
        required: ['x', 'y'],
      },
      book: { type: 'string', description: '作品名（默认当前作品）。' },
    },
    execute: guard(mapDrawTool),
  });

  register({
    name: 'novel_map_assets',
    description:
      'Read-only. Lists the SVG assets already drawn for this book (id / name / kind), so you can reuse one instead of drawing it again. '
      + 'Changes nothing on disk.',
    parameters: {
      book: { type: 'string', description: '作品名（默认当前作品）。' },
    },
    execute: guard(mapAssetsTool),
  });


/* ------------------------------------------------------------------ 时间线 */

/**
 * 从正文里**提取**事件写进时间线。
 *
 * 为什么是 AI 干这件事：时间线要的是"书里真正发生过什么、按什么顺序、牵涉谁"，
 * 这只有读过正文才知道；按章节编号编出来的东西看着整齐，其实全是假的。
 */
async function timelineWriteTool(args) {
  const book = resolveBook(args?.book);
  const action = asText(args?.action).trim().toLowerCase();

  if (action === 'replace') {
    if (!args?.force) {
      throw new ToolRefusal('NEED_FORCE', 'replace 会整条覆盖作者已有的时间线，确认要覆盖就传 force:true。');
    }
    const events = Array.isArray(args?.events) ? args.events : [];
    if (!events.length) throw new ToolRefusal('MISSING_EVENTS', 'replace 需要 events 数组。');
    const written = await timelineApi.writeTimeline(book.root, events).catch((error) => {
      throw new ToolRefusal('BAD_EVENTS', error instanceof Error ? error.message : String(error));
    });
    return { ok: true, total: written.length, replaced: true, text: '时间线已重写，共 ' + written.length + ' 条事件。' };
  }

  if (action !== 'add' && action !== 'update' && action !== 'remove') {
    throw new ToolRefusal('BAD_ACTION', 'action 只能是 add / update / remove / replace。');
  }

  const payload = action === 'remove'
    ? { id: asText(args?.id).trim() }
    : {
      ...(args?.id ? { id: asText(args.id).trim() } : {}),
      title: asText(args?.title),
      date: asText(args?.date),
      era: asText(args?.era),
      description: asText(args?.description),
      characters: Array.isArray(args?.characters) ? args.characters : [],
      chapterId: asText(args?.chapterId),
      chapterTitle: asText(args?.chapterTitle),
      location: asText(args?.location),
      type: asText(args?.type),
      lane: asText(args?.lane),
      laneName: asText(args?.laneName),
      thread: asText(args?.thread),
      links: Array.isArray(args?.links) ? args.links : [],
    };
  if (action !== 'remove' && !String(payload.title || '').trim()) {
    throw new ToolRefusal('MISSING_TITLE', '事件要有 title：这一步发生了什么（一句话）。');
  }

  const result = await timelineApi.mutateTimeline(book.root, action, payload).catch((error) => {
    throw new ToolRefusal('TIMELINE_FAILED', error instanceof Error ? error.message : String(error));
  });

  return {
    ok: true,
    action,
    total: result.total,
    ...(result.event ? { event: result.event } : {}),
    text: action === 'add'
      ? '已加入时间线：「' + result.event.title + '」（共 ' + result.total + ' 条）。'
      : action === 'update'
        ? '已更新时间线事件「' + result.event.title + '」。'
        : '已从时间线删掉「' + result.removed + '」（还剩 ' + result.total + ' 条）。',
  };
}

  register({
    name: 'novel_timeline_read',
    description:
      'Read-only. Lists every timeline event of this book (id / title / date / era / characters / chapter), so you can see what is already recorded before adding more — and so you can remove entries that are not real turning points. '
      + 'Changes nothing on disk.',
    parameters: {
      chapter: { type: 'string', description: '只看某一章的事件（章节路径或标题都行）。' },
      book: { type: 'string', description: '作品名（默认当前作品）。' },
    },
    execute: guard(async (args) => {
      const book = resolveBook(args?.book);
      const all = await timelineApi.readTimeline(book.root);
      const key = asText(args?.chapter).trim();
      const list = key
        ? all.filter((item) => item.chapterId === key || item.chapterTitle === key || (item.chapterTitle || '').includes(key))
        : all;
      return {
        ok: true,
        total: list.length,
        events: list.slice(0, 120),
        text: list.length
          ? list.map((item, index) => (index + 1) + '. ' + (item.date || item.era || '') + ' · ' + item.title + (item.characters.length ? '（' + item.characters.join('、') + '）' : '')).join('\n')
          : '时间线还是空的。可以读正文后用 action=add 一条条加。',
      };
    }),
  });

  register({
    name: 'novel_timeline_write',
    description:
      'WRITES THE STORY TIMELINE by extracting events from the prose, no approval needed (it is reference material, like the map). '
      + 'Read the chapters first (novel_list + novel_read), then add ONLY events that matter: something that changes the situation (a death, an alliance breaking, a secret revealed, a place destroyed), has consequences later, changes what a character wants/knows, or sets up a payoff. '
      + 'Do NOT record routine action and movement — "the protagonist picked up the phone", "she walked into the room", eating, travelling, scenery, atmosphere. '
      + 'Test every candidate: if you deleted this event, would a later chapter stop making sense? If not, do not write it. A short timeline of real turning points beats a complete log of movements. '
      + 'The first event of a book must be the story\'s actual starting point, not the protagonist\'s small gesture. '
      + 'Put the wording the book itself uses into date / era (e.g. "第三年春", "雾夜之后"; leave it empty when the text gives no time), list the characters present, and point chapterId at the chapter it happened in. '
      + 'Never invent events that are not in the prose — a short, accurate timeline beats a long, made-up one. '
      + 'The timeline is shown as horizontal swimlanes: lane groups events into a plot thread (main / a character / a faction), thread=bright|dark marks main plot vs hidden plot, and links [{target,kind}] draw the plot web (cause / impact / foreshadow). '
      + 'Use several lanes when the story really runs several threads, and link an event to the one it causes or foreshadows. '
      + 'action=replace rewrites the whole timeline in one call and needs force:true.',
    parameters: {
      action: { type: 'string', required: true, enum: ['add', 'update', 'remove', 'replace'], description: 'add 新增 / update 改一条 / remove 删一条 / replace 整条重写（要 force）。' },
      id: { type: 'string', description: 'update / remove 时需要的事件 id。' },
      title: { type: 'string', description: '这一步发生了什么（一句话，不要写"主角继续前进"这种废话）。' },
      date: { type: 'string', description: '书里怎么说的时间（原文口径）。没有就留空。' },
      era: { type: 'string', description: '纪元/卷：例如「第一卷 · 雾起」「第三年春」。' },
      description: { type: 'string', description: '一两句细节：怎么发生、结果如何。' },
      characters: { type: 'array', description: '在场人物名字。', items: { type: 'string' } },
      chapterId: { type: 'string', description: '发生在哪一章（章节路径，例如 chapters/chapter-002.md）。' },
      chapterTitle: { type: 'string', description: '章节标题（方便界面显示）。' },
      location: { type: 'string', description: '发生地点。' },
      type: { type: 'string', enum: ['conflict', 'revelation', 'journey', 'dialogue', 'decision', 'turning', 'other'], description: '事件类型，默认 other。' },
      lane: { type: 'string', description: '剧情线 id：一条线一个值（如 main / 沈青梧 / 朝堂）。缺省 main。' },
      laneName: { type: 'string', description: '剧情线显示名（如「主线」「沈青梧线」）。' },
      thread: { type: 'string', enum: ['bright', 'dark'], description: '明线 bright（默认）/ 暗线 dark——暗线在时间线里画成虚线、压暗。' },
      links: {
        type: 'array',
        description: '剧情网连线：指向别的事件。kind: cause 因果 / impact 影响 / foreshadow 伏笔；target 是对方的事件 id。',
        items: {
          type: 'object',
          properties: {
            target: { type: 'string' },
            kind: { type: 'string', enum: ['cause', 'impact', 'foreshadow'] },
          },
          required: ['target'],
        },
      },
      events: { type: 'array', description: 'action=replace 时的整条时间线。', items: { type: 'object' } },
      force: { type: 'boolean', description: 'action=replace 必填 true，确认要覆盖已有时间线。' },
      book: { type: 'string', description: '作品名（默认当前作品）。' },
    },
    execute: guard(timelineWriteTool),
  });

  register({
    name: 'novel_map_read',
    description:
      'Read-only. Read the whole world map in one call: six layers (landmasses with rings, terrain areas with their biome type, mountains/forests/props stamps, rivers/routes, locations, decor) plus canvas size and per-layer counts. '
      + 'The result includes the complete JSON, which you can modify and pass back to novel_map_write. Changes nothing on disk.',
    parameters: {
      book: {
        type: 'string',
        description: '作品名（默认当前作品）。',
      },
    },
    execute: guard(mapReadTool),
  });

  register({
    name: 'novel_map_add_land',
    description:
      'ADDS one landmass (a closed polygon) to the world map, no approval needed. Leaves every existing landmass, pin, river and route untouched — this is the safe way to grow a map. '
      + 'points are canvas units (no fixed bounds: negative values or anything beyond the initial canvas are allowed; origin top-left), at least 3 points. '
      + 'Match the coastline style of what is already there instead of inventing a new shore next to it.',
    parameters: {
      name: { type: 'string', required: true, description: '陆地名称，例如「北境」「雾汀群岛」。' },
      points: {
        type: 'array',
        required: true,
        description: '顶点数组，至少 3 个：{x,y}。',
        items: { type: 'object', properties: { x: { type: 'number' }, y: { type: 'number' } }, required: ['x', 'y'] },
      },
      book: { type: 'string', description: '作品名（默认当前作品）。' },
    },
    execute: guard((args) => {
      const name = asText(args?.name).trim();
      if (!name) throw new ToolRefusal('MISSING_NAME', '缺少 name：这块陆叫什么？');
      const points = asPoints(args?.points, 'points');
      return editMap(args, (current) => {
        const land = { id: 'land-' + randomUUID().slice(0, 8), name, points };
        return {
          map: { ...current, landmasses: current.landmasses.concat([land]) },
          text: '已加一块陆地「' + name + '」（' + points.length + ' 个顶点，id ' + land.id + '）。',
        };
      });
    }),
  });

  register({
    name: 'novel_map_update_land',
    description:
      'EDITS one existing landmass by id or name: replace its outline points and/or rename it, no approval needed. '
      + 'Only that landmass changes; everything else on the map stays as the author drew it. Use it to refine a coastline instead of redrawing the whole map.',
    parameters: {
      target: { type: 'string', required: true, description: '陆地 id 或名称（例如「主陆」）。' },
      points: {
        type: 'array',
        description: '新的顶点数组（至少 3 个）；不改形状就省略。',
        items: { type: 'object', properties: { x: { type: 'number' }, y: { type: 'number' } }, required: ['x', 'y'] },
      },
      name: { type: 'string', description: '新名称；不改名就省略。' },
      book: { type: 'string', description: '作品名（默认当前作品）。' },
    },
    execute: guard((args) => {
      const target = asText(args?.target).trim();
      if (!target) throw new ToolRefusal('MISSING_TARGET', '缺少 target：要改哪块陆地？');
      const points = args?.points === undefined ? null : asPoints(args.points, 'points');
      const nextName = args?.name === undefined ? null : asText(args.name).trim() || null;
      return editMap(args, (current) => {
        const found = findNamed(current.landmasses, target);
        if (!found) throw new ToolRefusal('NOT_FOUND', '地图上没有叫「' + target + '」的陆地。先 novel_map_read 看看有哪些。');
        const changed = { ...found.item };
        if (points) changed.points = points;
        if (nextName) changed.name = nextName;
        const landmasses = current.landmasses.slice();
        landmasses[found.index] = changed;
        return {
          map: { ...current, landmasses },
          text: '已更新陆地「' + changed.name + '」（' + changed.points.length + ' 个顶点）。',
        };
      });
    }),
  });

  register({
    name: 'novel_map_place',
    description:
      'ADDS or MOVES one location pin on the world map, no approval needed. '
      + 'A same-name pin is only replaced when overwrite=true; otherwise the call is refused (so an existing landmark is never silently rewritten). '
      + 'Passing delete=true removes that pin. Coordinates are canvas units with no fixed bounds; keep the pin inside the landmass it belongs to.',
    parameters: {
      name: { type: 'string', required: true, description: '地点名称，例如「旧钟楼」。同名默认拒绝，需 overwrite:true 才覆盖。' },
      x: { type: 'number', description: '画布 x（无固定边界，可为负或超出初始画布）。删除时可省略。' },
      y: { type: 'number', description: '画布 y（无固定边界，可为负或超出初始画布）。删除时可省略。' },
      category: {
        type: 'string',
        enum: ['capital', 'city', 'town', 'port', 'fortress', 'temple', 'tower', 'dungeon', 'cave', 'camp', 'battle', 'mine', 'farm', 'ferry', 'pass', 'academy', 'lighthouse', 'falls', 'tomb', 'abyss', 'portal', 'landmark', 'region', 'other'],
        description: '地点类型，默认 other。',
      },
      description: { type: 'string', description: '一句话描述（原文里怎么写的就怎么写）。' },
      icon: { type: 'string', description: '可选：图标。填 "asset:<id>" 用它之前画的素材，或留空按 category 用内置图标。' },
      delete: { type: 'boolean', description: 'true = 删掉这个地点。' },
      overwrite: { type: 'boolean', description: '同名地点已存在时必须显式传 true 才会覆盖；默认拒绝。' },
      book: { type: 'string', description: '作品名（默认当前作品）。' },
    },
    execute: guard((args) => {
      const name = asText(args?.name).trim();
      if (!name) throw new ToolRefusal('MISSING_NAME', '缺少 name：地点叫什么？');
      const removing = args?.delete === true;
      return editMap(args, (current) => {
        const found = current.locations.findIndex((item) => String(item.name || '').trim() === name);
        const locations = current.locations.slice();
        if (removing) {
          if (found < 0) throw new ToolRefusal('NOT_FOUND', '地图上没有叫「' + name + '」的地点。');
          locations.splice(found, 1);
          return { map: { ...current, locations }, text: '已从地图上移除地点「' + name + '」。' };
        }
        const x = Number(args?.x);
        const y = Number(args?.y);
        if (!Number.isFinite(x) || !Number.isFinite(y)) throw new ToolRefusal('BAD_POINTS', 'x / y 必须是数字（画布坐标）。');
        const wanted = asText(args?.category);
        const CATEGORY_IDS = ['capital', 'city', 'town', 'port', 'fortress', 'temple', 'tower', 'dungeon', 'cave', 'camp', 'battle', 'mine', 'farm', 'ferry', 'pass', 'academy', 'lighthouse', 'falls', 'tomb', 'abyss', 'portal', 'landmark', 'region', 'other'];
        const category = CATEGORY_IDS.indexOf(wanted) >= 0 ? wanted : 'other';
        const patch = { name, x, y, category };
        if (args?.icon !== undefined) patch.icon = asText(args.icon).slice(0, 120);
        if (args?.description !== undefined) patch.description = asText(args.description).slice(0, 500);
        if (found >= 0 && args?.overwrite !== true) {
          /* 同名静默覆盖会让作者的地标莫名被替换（AI 想"再加一个码头"却改掉了原地点）。
             要覆盖必须显式 overwrite:true。 */
          throw new ToolRefusal(
            'NAME_TAKEN',
            '已经有地点叫「' + name + '」了。要改它请在参数里加 overwrite:true；要新增另一个，请换个名字。',
          );
        }
        if (found >= 0) {
          locations[found] = { ...locations[found], ...patch };
          return {
            map: { ...current, locations },
            text: '已把地点「' + name + '」更新到 (' + Math.round(x) + ', ' + Math.round(y) + ')，类型 ' + category + '。',
          };
        }
        locations.push({ id: 'loc-' + randomUUID().slice(0, 8), chapterIds: [], ...patch });
        return {
          map: { ...current, locations },
          text: '已在 (' + Math.round(x) + ', ' + Math.round(y) + ') 钉下地点「' + name + '」(' + category + ')。',
        };
      });
    }),
  });

  register({
    name: 'novel_map_stamps',
    description:
      'ADDS mountains, forests or terrain in bulk, no approval needed (one call can place a whole ridge line, woodland or desert). '
      + 'kind is mountain / forest / terrain / prop (for terrain also pass terrain; for prop also pass prop, e.g. peak / pine / dead / cactus / rock / cone); points are the stamp positions in canvas units. '
      + 'Existing stamps are kept. A ridge reads better as 4–8 stamps stepped along a line than as a single blob. '
      + 'For a whole woodland draw it as a terrain area (novel_map_terrain kind=forest) instead of scattering single trees here. '
      + 'Note: a terrain stamp is only a small patch — to paint an actual desert/forest region use novel_map_terrain (an area polygon) instead.',
    parameters: {
      kind: {
        type: 'string',
        required: true,
        enum: ['mountain', 'forest', 'terrain', 'prop'],
        description: '盖什么：mountain 山脉 / forest 森林 / terrain 地貌。',
      },
      terrain: {
        type: 'string',
        description: 'kind=terrain 时必填：forest 森林 / hill 丘陵 / plateau 高原 / desert 沙漠 / swamp 沼泽 / tundra 苔原 / glacier 冰川 / volcano 火山 / canyon 峡谷 / grass 草原。',
      },
      prop: {
        type: 'string',
        description: 'kind=prop 时必填：peak 雪峰 / pine 松树 / dead 枯树 / cactus 仙人掌 / rock 岩石 / cone 火山锥。',
      },
      points: {
        type: 'array',
        required: true,
        description: '图章位置数组：{x,y}。',
        items: { type: 'object', properties: { x: { type: 'number' }, y: { type: 'number' } }, required: ['x', 'y'] },
      },
      book: { type: 'string', description: '作品名（默认当前作品）。' },
    },
    execute: guard((args) => {
      const kind = asText(args?.kind).trim();
      if (kind !== 'mountain' && kind !== 'forest' && kind !== 'terrain' && kind !== 'prop') {
        throw new ToolRefusal('BAD_KIND', 'kind 只能是 mountain / forest / terrain / prop。');
      }
      const PROP_KINDS = ['peak', 'pine', 'dead', 'cactus', 'rock', 'cone'];
      let propType = '';
      if (kind === 'prop') {
        propType = asText(args?.prop).trim().toLowerCase();
        if (PROP_KINDS.indexOf(propType) < 0) {
          throw new ToolRefusal('BAD_PROP', 'kind=prop 时 prop 必须是：' + PROP_KINDS.join(' / ') + '。');
        }
      }
      const TERRAIN_KINDS = ['hill', 'plateau', 'desert', 'swamp', 'tundra', 'glacier', 'volcano', 'canyon', 'grass'];
      let terrainType = '';
      if (kind === 'terrain') {
        terrainType = asText(args?.terrain).trim().toLowerCase();
        if (TERRAIN_KINDS.indexOf(terrainType) < 0) {
          throw new ToolRefusal('BAD_TERRAIN', 'kind=terrain 时 terrain 必须是：' + TERRAIN_KINDS.join(' / ') + '。');
        }
      }
      const points = asPoints(args?.points, 'points');
      return editMap(args, (current) => {
        const key = kind === 'mountain' ? 'mountains' : kind === 'forest' ? 'forests' : kind === 'terrain' ? 'terrain' : 'props';
        const prefix = kind === 'mountain' ? 'mt' : kind === 'forest' ? 'forest' : kind === 'terrain' ? 'terrain' : 'prop';
        const list = (current[key] || []).slice();
        for (const point of points) {
          const stamp = { id: prefix + '-' + randomUUID().slice(0, 8), x: point.x, y: point.y };
          if (kind === 'terrain') stamp.type = terrainType;
          if (kind === 'prop') stamp.type = propType;
          list.push(stamp);
        }
        const label = kind === 'mountain' ? '山脉' : kind === 'forest' ? '森林' : kind === 'terrain' ? ('地貌（' + terrainType + '）') : ('图章（' + propType + '）');
        return {
          map: { ...current, [key]: list },
          text: '已盖 ' + points.length + ' 处' + label + '。',
        };
      });
    }),
  });

  register({
    name: 'novel_map_line',
    description:
      'ADDS or REPLACES one river or route polyline on the world map, no approval needed. Upserts by name. '
      + 'A river should start in high ground and end at the sea or a lake; a route should connect real pins. '
      + 'Other rivers/routes are untouched.',
    parameters: {
      kind: { type: 'string', required: true, enum: ['river', 'route'], description: '画河流还是路线。' },
      name: { type: 'string', required: true, description: '名称，例如「雾河」「青石长街」。同名即替换那条线。' },
      points: {
        type: 'array',
        required: true,
        description: '折线点数组：至少 2 个 {x,y}。',
        items: { type: 'object', properties: { x: { type: 'number' }, y: { type: 'number' } }, required: ['x', 'y'] },
      },
      book: { type: 'string', description: '作品名（默认当前作品）。' },
    },
    execute: guard((args) => {
      const kind = asText(args?.kind).trim();
      if (kind !== 'river' && kind !== 'route') throw new ToolRefusal('BAD_KIND', 'kind 只能是 river 或 route。');
      const name = asText(args?.name).trim();
      if (!name) throw new ToolRefusal('MISSING_NAME', '缺少 name：这条线叫什么？');
      const points = asPoints(args?.points, 'points');
      if (points.length < 2) throw new ToolRefusal('BAD_POINTS', '一条线至少要 2 个点。');
      return editMap(args, (current) => {
        const key = kind === 'river' ? 'rivers' : 'routes';
        const list = current[key].slice();
        const found = list.findIndex((item) => String(item.name || '').trim() === name);
        const id = found >= 0 ? list[found].id : kind + '-' + randomUUID().slice(0, 8);
        const line = { id, name, points };
        if (found >= 0) list[found] = { ...list[found], ...line };
        else list.push(line);
        return {
          map: { ...current, [key]: list },
          text: (found >= 0 ? '已替换' : '已添加') + (kind === 'river' ? '河流' : '路线') + '「' + name + '」（' + points.length + ' 个点）。',
        };
      });
    }),
  });

  register({
    name: 'novel_map_terrain',
    description:
      'ADDS / REPLACES / REMOVES a patch of terrain on the world map, no approval needed. '
      + 'Terrain is an AREA (a closed polygon like a landmass), not a pin: it paints the ground so the map reads as desert / swamp / glacier and so on. '
      + 'The paint is clipped to the landmasses, so a polygon may extend past the coast without spilling into the sea. '
      + 'kind is one of forest / hill / plateau / desert / swamp / tundra / glacier / volcano / canyon / grass. '
      + 'Use action=add to paint a new patch, action=update with an id to reshape or retype it, action=remove with an id to delete it. '
      + 'Call novel_map_read first: it returns every terrain entry with its id, type and points.',
    parameters: {
      action: { type: 'string', required: true, enum: ['add', 'update', 'remove'], description: 'add 新增 / update 改已有 / remove 删除。' },
      kind: {
        type: 'string',
        enum: ['forest', 'hill', 'plateau', 'desert', 'swamp', 'tundra', 'glacier', 'volcano', 'canyon', 'grass'],
        description: '地貌类型（add 必填；update 不填则保留原类型）。',
      },
      id: { type: 'string', description: 'update / remove 时的地貌 id（从 novel_map_read 的 terrain 里取）。' },
      points: {
        type: 'array',
        description: 'add / update 必填：闭合多边形的顶点，至少 3 个 {x,y}，画布坐标，无固定边界。',
        items: { type: 'object', properties: { x: { type: 'number' }, y: { type: 'number' } }, required: ['x', 'y'] },
      },
      book: { type: 'string', description: '作品名（默认当前作品）。' },
    },
    execute: guard((args) => {
      const action = asText(args?.action).trim().toLowerCase();
      if (['add', 'update', 'remove'].indexOf(action) < 0) {
        throw new ToolRefusal('BAD_ACTION', 'action 只能是 add / update / remove。');
      }
      const KINDS = ['forest', 'hill', 'plateau', 'desert', 'swamp', 'tundra', 'glacier', 'volcano', 'canyon', 'grass'];
      const kindRaw = asText(args?.kind).trim().toLowerCase();
      if (kindRaw && KINDS.indexOf(kindRaw) < 0) {
        throw new ToolRefusal('BAD_TERRAIN', 'kind 必须是：' + KINDS.join(' / ') + '。');
      }
      const id = asText(args?.id).trim();

      return editMap(args, (current) => {
        const list = (current.terrain || []).slice();

        if (action === 'remove') {
          if (!id) throw new ToolRefusal('MISSING_ID', 'remove 需要 id（从 novel_map_read 的 terrain 里取）。');
          const at = list.findIndex((item) => item && item.id === id);
          if (at < 0) throw new ToolRefusal('NOT_FOUND', '地图上没有 id 为「' + id + '」的地貌。');
          const gone = list.splice(at, 1)[0];
          return { map: { ...current, terrain: list }, text: '已删除地貌「' + (gone.type || '') + '」（' + id + '）。' };
        }

        if (action === 'update') {
          if (!id) throw new ToolRefusal('MISSING_ID', 'update 需要 id。');
          const at = list.findIndex((item) => item && item.id === id);
          if (at < 0) throw new ToolRefusal('NOT_FOUND', '地图上没有 id 为「' + id + '」的地貌。');
          const prev = list[at];
          /* 只改类型时不必重传顶点：不传就沿用原来的形状。 */
          const nextPoints = args?.points === undefined
            ? (Array.isArray(prev.points) ? prev.points : [])
            : asPoints(args.points, 'points');
          if (nextPoints.length < 3) throw new ToolRefusal('BAD_POINTS', '地貌是一片面，至少要 3 个顶点。');
          list[at] = { ...prev, ...(kindRaw ? { type: kindRaw } : {}), points: nextPoints };
          return {
            map: { ...current, terrain: list },
            text: '已更新地貌「' + (list[at].type || '') + '」（' + id + '），' + nextPoints.length + ' 个顶点。',
          };
        }

        if (!kindRaw) throw new ToolRefusal('MISSING_KIND', 'add 需要 kind（hill / desert / glacier 等）。');
        const points = asPoints(args?.points, 'points');
        if (points.length < 3) throw new ToolRefusal('BAD_POINTS', '地貌是一片面，至少要 3 个顶点。');
        const area = { id: 'terrain-' + randomUUID().slice(0, 8), type: kindRaw, points };
        return {
          map: { ...current, terrain: list.concat([area]) },
          text: '已画出一片' + kindRaw + '（' + area.id + '），' + points.length + ' 个顶点。',
        };
      });
    }),
  });

  register({
    name: 'novel_map_remove',
    description:
      'REMOVES one object from the world map by kind + id/name (land / location / river / route / mountain / forest / terrain), no approval needed. '
      + 'Only that object is deleted; everything else stays. Prefer removing a wrong object over rewriting the whole map.',
    parameters: {
      kind: { type: 'string', required: true, enum: ['land', 'location', 'river', 'route', 'mountain', 'forest', 'terrain'], description: '删哪一类对象。' },
      target: { type: 'string', required: true, description: '对象的 id 或名称。' },
      book: { type: 'string', description: '作品名（默认当前作品）。' },
    },
    execute: guard((args) => {
      const kind = asText(args?.kind).trim();
      const target = asText(args?.target).trim();
      if (!target) throw new ToolRefusal('MISSING_TARGET', '缺少 target：要删哪个？');
      return editMap(args, (current) => {
        const table = {
          land: ['landmasses', '陆地'],
          location: ['locations', '地点'],
          river: ['rivers', '河流'],
          route: ['routes', '路线'],
          mountain: ['mountains', '山脉'],
          forest: ['forests', '森林'],
          terrain: ['terrain', '地貌'],
        };
        const spec = table[kind];
        if (!spec) throw new ToolRefusal('BAD_KIND', 'kind 只能是 land / location / river / route / mountain / forest / terrain。');
        const key = spec[0];
        const label = spec[1];
        const list = current[key].slice();
        const found = findNamed(list, target);
        if (!found) throw new ToolRefusal('NOT_FOUND', '地图上没有叫「' + target + '」的' + label + '。');
        list.splice(found.index, 1);
        return { map: { ...current, [key]: list }, text: '已从地图上删除' + label + '「' + (found.item.name || target) + '」。' };
      });
    }),
  });

  register({
    name: 'novel_map_write',
    description:
      'WRITES THE WORLD MAP, no approval needed (the map is worldbuilding material, same as the reference area). '
      + 'Replaces the whole map in one call. Six layers: landmasses and terrain are closed polygons of points (terrain carries a biome type and its paint is clipped to the land), mountains/forests/props are point stamps, rivers/routes are polylines, locations are pins (a pin may reference an SVG asset via icon=\"asset:<id>\"), decor places an asset SVG at a world position. '
      + 'You may redesign or overwrite any part of the map, including terrain the author already drew — this is your area to manage. '
      + 'Read it first (novel_map_read) so you keep whatever should survive, and prefer the granular tools for partial edits. '
      + 'The author\'s map panel refreshes itself after your write — never tell them to reload. '
      + 'Coordinates are canvas units with no fixed bounds (negative or beyond the initial canvas is fine), origin top-left; omit width/height to keep the current canvas size. Draw only what the text supports; leave unknown regions empty rather than filling them with invented geography.',
    parameters: {
      map: {
        type: 'object',
        required: true,
        description: '完整地图对象：{ name, scale, landmasses, mountains, forests, rivers, routes, locations }。字段可从 novel_map_read 的结果里改。',
      },
      book: {
        type: 'string',
        description: '作品名（默认当前作品）。',
      },
    },
    execute: guard(mapWriteTool),
  });

  register({
    name: 'novel_review',
    description:
      'Read-only, costs one model call. Runs the studio\'s existing chapter-review pipeline over one chapter and returns annotation SUGGESTIONS only — '
      + 'nothing is written: not to annotations.json, not to the prose. Use it when the author asks for a review; then call novel_annotate_chapter for the suggestions worth keeping. '
      + 'It refuses instructions that ask it to write, continue, or rewrite prose.',
    parameters: {
      path: {
        type: 'string',
        required: true,
        description: '要审阅的章节相对路径，例如 chapters/chapter-003.md。',
      },
      instruction: {
        type: 'string',
        description: '审阅重点（例如「只看人物动机和前后逻辑」）。不填则按情节/逻辑/设定/人物/语言全面审。要求写正文的指令会被拒绝。',
      },
      maxAnnotations: {
        type: 'integer',
        description: '最多返回几条建议（1–20，默认取设置里的值）。',
      },
      book: {
        type: 'string',
        description: '作品名（默认当前作品）。',
      },
    },
    execute: guard((args) => reviewTool(ctx, args)),
  });
}
