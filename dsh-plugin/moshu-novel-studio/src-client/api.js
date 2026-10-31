'use strict';

/**
 * src/api.ts 的直译：所有请求都打 DSH 插件自带的 /api/moshu 前缀。
 * 第二轮按 CONTRACT-v2 补齐书籍 / 模型 / 设置 / AI / 备份 / 文档管理端点。
 * 失败一律抛 Error(message)，message 取响应体的 error（字符串或 { message }）。
 */

const BASE = '/api/moshu';

let projectContext = null;

/** 由 page.jsx 在作品加载后写入，供 aiReview 组装上下文。 */
function setProjectContext(project) {
  projectContext = project || null;
}

function clip(value, max) {
  if (typeof value !== 'string') return '';
  return value.length > max ? value.slice(0, max) + '…' : value;
}

function text(value) {
  if (value === null || value === undefined) return '';
  return String(value);
}

function taskSources(path) {
  if (!projectContext) return {};
  const included = projectContext.contextDocumentIds || [];
  const documents = projectContext.documents || [];
  const memories = projectContext.memories || [];
  const chosen = documents.filter(function (doc) { return included.indexOf(doc.id) !== -1 && doc.path !== path; }).slice(0, 5);
  const pickedMemories = memories
    .filter(function (memory) { return memory.status !== 'pending'; })
    .sort(function (a, b) { return Number(Boolean(b.locked)) - Number(Boolean(a.locked)); })
    .slice(0, 10)
    .map(function (memory) {
      return { title: memory.title, content: clip(memory.content, 400), locked: Boolean(memory.locked) };
    });
  return {
    sources: [path].concat(pickedMemories.filter(function (memory) { return memory.locked; }).map(function (memory) { return memory.title; })),
    context: {
      memories: pickedMemories,
      related: chosen.map(function (doc) {
        return { title: doc.title, path: doc.path, content: clip(doc.content, 1200) };
      })
    }
  };
}

/**
 * 当前打开的作品 id（bootstrap 返回的 bookId）。
 * page.jsx 在每次 bootstrap 后写入；所有写请求都带上它，Host 比对不上会 409。
 */
/* 作品身份按作用域分开记。
   以前只有一个 currentBookId，而主区面板（作用域 = '') 和对话内嵌（作用域 = sessionId）
   两个 SlotPage 会各自在渲染时调用 setScope：来回切换就把 currentBookId 清空了，
   于是新建章节 / 删除 / 改名这类写请求丢掉 X-Moshu-Book → Host 返回 428 →「新建章节无效」。 */
const bookByScope = Object.create(null);
let currentScope = '';

/** 与 Host 半 `host/api.js` 的 API_VERSION 必须一致。改接口就同时改两处。 */
const API_VERSION = 6;

/** GET /health：只有它是"任何版本的宿主都有"的接口，用来做版本握手。 */
function getHealth() {
  return request('/health');
}

function setBookId(id) {
  bookByScope[currentScope] = typeof id === 'string' ? id : '';
}

function getBookId() {
  return bookByScope[currentScope] || '';
}

/**
 * 统一请求。
 * `options.signal`（AbortSignal）原样透传给 fetch，调用方可以随时取消。
 * 失败抛 Error(message)，并把 HTTP 状态与响应体挂到错误对象上：
 *   error.status / error.code、error.body / error.data
 * —— 保存冲突（409）要靠 body 里的 mtime/content 才能给作者做选择。
 */
async function request(path, options) {
  const opts = options || {};
  const init = { method: opts.method || 'GET' };
  if (opts.body !== undefined) init.body = opts.body;
  if (opts.signal) init.signal = opts.signal;
  if (opts.headers) init.headers = opts.headers;
  init.headers = Object.assign({ 'Content-Type': 'application/json' }, init.headers || {});
  /* 作品身份：Host 用它挡住"切书后旧请求写进新书"。没有它时 Host 不做校验（向后兼容）。
     书名是中文，HTTP 头只允许 Latin-1，所以必须 URL 编码。 */
  const bookId = getBookId();
  if (bookId) init.headers['X-Moshu-Book'] = encodeURIComponent(bookId);
  /* 会话作用域：每个对话一个书库。没有它 = 共享库（侧边栏面板）。 */
  if (currentScope) init.headers['X-Moshu-Scope'] = currentScope;
  const response = await fetch(BASE + path, init);
  let data = null;
  try {
    data = await response.json();
  } catch (error) {
    data = null;
  }
  if (!response.ok) {
    const reason = data && data.error;
    const message = typeof reason === 'string' ? reason : (reason && reason.message) || '请求未完成，请重试';
    const failure = new Error(message);
    failure.status = response.status;
    failure.code = response.status;
    failure.body = data || null;
    failure.data = data || null;
    throw failure;
  }
  return data;
}

/**
 * 保存冲突（乐观锁）的唯一判定：HTTP 409 **且** body.conflict === true。
 *
 * 409 不止一种：`POST /document` 的「该文档已存在」也是 409，但没有 content/mtime，
 * 那种情况必须按普通错误提示，绝不能弹冲突面板。Host 只给乐观锁冲突补 conflict:true。
 */
function isConflict(reason) {
  if (!reason) return false;
  const status = reason.status !== undefined ? reason.status : reason.code;
  if (status !== 409) return false;
  const body = reason.body || reason.data || null;
  return Boolean(body && body.conflict === true);
}

/**
 * 从锁冲突的响应体里取出磁盘现版本。
 * @returns {{mtime:number|null, content:string} | null}
 */
function conflictOf(reason) {
  if (!isConflict(reason)) return null;
  const body = reason.body || reason.data || {};
  const mtime = typeof body.mtime === 'number' ? body.mtime : (typeof body.mtimeMs === 'number' ? body.mtimeMs : null);
  return { mtime: mtime, content: typeof body.content === 'string' ? body.content : '' };
}

/** 从 bootstrap 的 document 或保存响应里读 mtime（毫秒）；没有就返回 null。 */
function mtimeOf(payload) {
  if (!payload || typeof payload !== 'object') return null;
  const direct = payload.mtime !== undefined ? payload.mtime : payload.mtimeMs;
  if (typeof direct === 'number' && isFinite(direct)) return direct;
  if (typeof direct === 'string' && direct && isFinite(Number(direct))) return Number(direct);
  const document = payload.document && typeof payload.document === 'object' ? payload.document : null;
  if (document) {
    const nested = document.mtime !== undefined ? document.mtime : document.mtimeMs;
    if (typeof nested === 'number' && isFinite(nested)) return nested;
  }
  return null;
}

function send(method, path, body) {
  return request(path, { method: method, body: JSON.stringify(body || {}) });
}

/* ---------------- 作品（v1） ---------------- */

function getProject() {
  return request('/bootstrap');
}

/**
 * PUT /document —— 写回一份 Markdown。
 * @param {string} path 作品内相对路径
 * @param {string} content 全文
 * @param {number|string} [expectedMtime] 乐观锁：客户端看到的 mtime（毫秒）。
 *        省略 = 无条件覆盖（新建文件、或后端还没给出 mtime）。
 *        不一致时后端返回 409，body 为 { error, mtime, content }。
 */
function saveDocument(path, content, expectedMtime) {
  const body = { path: path, content: content };
  const expected = typeof expectedMtime === 'string' && expectedMtime ? Number(expectedMtime) : expectedMtime;
  if (typeof expected === 'number' && isFinite(expected)) body.expectedMtime = expected;
  return request('/document', { method: 'PUT', body: JSON.stringify(body) });
}

async function aiReview(path, content, instruction) {
  const body = {
    mode: 'review',
    path: path,
    documentPath: path,
    content: content,
    instruction: instruction || '审阅这一章的情节衔接、人物行为、设定与语言。'
  };
  const sources = taskSources(path);
  if (sources.sources) body.sources = sources.sources;
  if (sources.context) body.context = sources.context;
  return request('/ai/review', { method: 'POST', body: JSON.stringify(body) });
}

/**
 * POST /annotations。
 * @param {string} documentPath 这一批批注所属文档（整表替换时可以省略）
 * @param {Array} annotations 批注数组
 * @param {boolean|{replaceAll:boolean}} [replaceAll] 传 true（或 {replaceAll:true}）
 *        时整表替换，否则 Host 按 id 合并。第三个参数是本轮新增，旧的两位调用照旧可用。
 */
function saveAnnotations(documentPath, annotations, replaceAll) {
  const body = { documentPath: documentPath, annotations: annotations };
  const replace = replaceAll === true || Boolean(replaceAll && typeof replaceAll === 'object' && replaceAll.replaceAll === true);
  if (replace) body.replaceAll = true;
  return request('/annotations', { method: 'POST', body: JSON.stringify(body) });
}

function runTask(task) {
  return request('/tasks', { method: 'POST', body: JSON.stringify(task) });
}

/* ---------------- 书籍（v2） ---------------- */

/** GET /books → { projectDir, current: BookRef, books: BookRef[] } */
function getBooks() {
  return request('/books');
}

/** POST /books { name } → { ok, book, books }（建目录 + 骨架，并切过去） */
function createBook(name) {
  return send('POST', '/books', { name: text(name).trim() });
}

/** POST /books/select { id } → { ok, book } */
function selectBook(id) {
  return send('POST', '/books/select', { id: text(id) });
}

/** POST /books/rename { id, name } → { ok, book, books } */
function renameBook(id, name) {
  return send('POST', '/books/rename', { id: text(id), name: text(name).trim() });
}

/** POST /books/trash { id } → { ok, books }（移到 novels/.trash，永不物理删除） */
function trashBook(id) {
  return send('POST', '/books/trash', { id: text(id) });
}

/** POST /books/delete { id, confirm } → { ok, books, deleted }（彻底删除，不可恢复；confirm 必须是书名） */
function deleteBook(id, confirmName) {
  return send('POST', '/books/delete', { id: text(id), confirm: text(confirmName).trim() });
}

/** GET /trash → { trash: [{ trashId, name, trashedAt, bytes }] } */
function getTrash() {
  return request('/trash');
}

/** POST /trash/restore { trashId } → { ok, books, restored } */
function restoreTrash(trashId) {
  return send('POST', '/trash/restore', { trashId: text(trashId) });
}

/** POST /trash/purge { trashId } → { ok, trash } */
function purgeTrash(trashId) {
  return send('POST', '/trash/purge', { trashId: text(trashId) });
}

/* ---------------- 模型（v2） ---------------- */

/** GET /models → { current: {provider, model}, providers: [...], message? } */
function getModels() {
  return request('/models');
}

/** POST /models { provider, model } → { ok, current } */
function setModel(provider, model) {
  return send('POST', '/models', { provider: text(provider), model: text(model) });
}

/* ---------------- 设置（v2） ---------------- */

/** GET /settings → { settings, defaults, ranges, editable } */
function getSettings() {
  return request('/settings');
}

/** POST /settings { patch } → { ok, settings } */
function saveSettings(patch) {
  return send('POST', '/settings', { patch: patch && typeof patch === 'object' ? patch : {} });
}

/* ---------------- AI 工作台（v2） ---------------- */

/** GET /ai/recipes → { recipes } */
function getRecipes() {
  return request('/ai/recipes');
}

/**
 * POST /ai/run —— 只计算、不落盘。
 * @param {{recipeId:string,targetPath?:string,instruction?:string,contextIds?:string[],maxAnnotations?:number}} payload
 * @param {{signal?:AbortSignal}} [options] 第二个参数本轮新增：options.signal 透传给 fetch，
 *        AI 工作台可以用它做「取消本次运行」。旧的单参调用照旧可用。
 */
function runAi(payload, options) {
  const input = payload || {};
  const body = { recipeId: text(input.recipeId) };
  if (input.targetPath) body.targetPath = text(input.targetPath);
  if (typeof input.instruction === 'string' && input.instruction.trim()) body.instruction = input.instruction.trim();
  if (Array.isArray(input.contextIds) && input.contextIds.length) {
    body.contextIds = input.contextIds.filter(function (id) { return Boolean(id); }).map(text);
  }
  if (typeof input.maxAnnotations === 'number' && isFinite(input.maxAnnotations)) body.maxAnnotations = input.maxAnnotations;
  const init = { method: 'POST', body: JSON.stringify(body) };
  if (options && options.signal) init.signal = options.signal;
  return request('/ai/run', init);
}

/* ---------------- 备份与文档管理（v2） ---------------- */

/** GET /backups?path=... → { path, entries: [{ id, at, bytes }] } */
function getBackups(path) {
  return request('/backups?path=' + encodeURIComponent(text(path)));
}

/** POST /backups/restore { path, id } → { ok, content } */
function restoreBackup(path, id) {
  return send('POST', '/backups/restore', { path: text(path), id: text(id) });
}

/** POST /document/rename { from, to } → { ok, path } */
function renameDocument(from, to) {
  return send('POST', '/document/rename', { from: text(from), to: text(to) });
}

/** POST /document/delete { path } → { ok }（移到作品 .trash，不物理删除） */
function deleteDocument(path) {
  return send('POST', '/document/delete', { path: text(path) });
}

/** POST /document/move { path, direction: 'up'|'down' } → { ok, paths } */
function moveDocument(path, direction) {
  return send('POST', '/document/move', { path: text(path), direction: direction === 'up' ? 'up' : 'down' });
}

/** 切换会话作用域（空串 = 共享库）。由 SlotPage 在渲染时同步调用。 */
function setScope(scope) {
  const next = typeof scope === 'string' ? scope.trim() : '';
  if (next !== currentScope) currentScope = next;
}

function getScope() {
  return currentScope;
}

module.exports = {
  setScope, getScope,
  listSharedBooks: () => request('/books/shared'),
  importSharedBook: (name) => request('/books/import', { method: 'POST', body: JSON.stringify({ name }) }),
  BASE: BASE,
  request: request,
  isConflict: isConflict,
  conflictOf: conflictOf,
  mtimeOf: mtimeOf,
  getProject: getProject,
  saveDocument: saveDocument,
  aiReview: aiReview,
  saveAnnotations: saveAnnotations,
  runTask: runTask,
  setProjectContext: setProjectContext,

  getBooks: getBooks,
  createBook: createBook,
  selectBook: selectBook,
  renameBook: renameBook,
  trashBook: trashBook,
  deleteBook: deleteBook,
  getTrash: getTrash,
  restoreTrash: restoreTrash,
  purgeTrash: purgeTrash,

  getModels: getModels,
  setModel: setModel,

  getSettings: getSettings,
  saveSettings: saveSettings,

  getRecipes: getRecipes,
  runAi: runAi,

  getBackups: getBackups,
  restoreBackup: restoreBackup,
  renameDocument: renameDocument,
  deleteDocument: deleteDocument,
  moveDocument: moveDocument,

  setBookId: setBookId,
  getBookId: getBookId,
  getHealth: getHealth,
  API_VERSION: API_VERSION
};
