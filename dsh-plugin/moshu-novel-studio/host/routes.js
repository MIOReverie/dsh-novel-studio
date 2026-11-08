/**
 * 墨枢 Host 半：路由表 + 分发（v3 契约 §2.3）。
 *
 * v3 之前「三类守卫」散在两处：来源校验在 `createHandler` 里，作品身份 / 空书架靠 `dispatch`
 * 里一个 `BOOK_SCOPED_ROUTES` 集合 + 15 个 handler 各自的自觉。新增端点只要忘了同步那个集合，
 * 就会出现「空书架时某个写端点顺手 initializeProject 把示例书造回来」（上一轮真发生过）。
 *
 * 现在**一条记录声明全部策略**：
 * ```js
 * { method:'POST', path:'/annotations', handler:'annotationsPost', needsBook:true, write:true, json:true }
 * ```
 * - `needsBook`：必须有一本打开着的作品（false = 空书架也能用，例如 /health、/books、/settings）。
 * - `write`：这是一次写操作 → 校验作品身份（`X-Moshu-Book`），并额外要求 JSON 请求体。
 * - `json`：端点交换的是 JSON（`false` 只有 `GET /export` 一个，它直接吐 Markdown）。
 *
 * 四个字段**必须显式声明**：`buildRouteIndex()` 缺一个就抛错（模块加载期即失败），
 * 所以「忘了声明」不再是运行时才发现的坑。
 *
 * `dispatch` 只做五件事：匹配 → 方法 → 作品身份 → 空书架 → JSON body 类型 → 调 handler。
 * 来源校验（Host / Origin / sec-fetch-site）在 `createHandler` 里对所有请求统一执行，先于匹配，
 * 与 v3 之前完全一致（伪造 Host 的请求不会因为路径写错而变成 404）。
 */
import { HttpError } from './errors.js';
import { runInScope, sanitizeScope } from './scope.js';
import { currentBook } from './current-book.js';
import { sendJson } from './http.js';

/** 路由前缀（与 index.js 的 register 保持一致）。 */
export const PREFIX = '/api/moshu';

/**
 * 全部路由策略。**新增端点必须在这里声明**，否则 `createDispatcher` 找不到它（404）。
 * handler 用字符串引用 `api.js` 里的实现，构建期校验存在性（写错名字立刻抛错）。
 */
export const ROUTES = Object.freeze([
  /* 只读 / 诊断：空书架也要能打开页面 */
  { method: 'GET', path: '/health', handler: 'health', needsBook: false, write: false, json: true },
  /* 会话是不是创作模式（客户端拿不到 preset，只能问 Host）。 */
  { method: 'GET', path: '/session-mode', handler: 'sessionMode', needsBook: false, write: false, bookScoped: false, json: true },
  { method: 'GET', path: '/status', handler: 'status', needsBook: false, write: false, json: true },
  /* bootstrap 自己处理空书架（返回空 Project），所以不挂 needsBook —— 否则空书架时页面打不开。 */
  { method: 'GET', path: '/bootstrap', handler: 'bootstrap', needsBook: false, write: true, bookScoped: false, json: true },

  /* 文档 */
  { method: 'PUT', path: '/document', handler: 'documentPut', needsBook: true, write: true, json: true },
  { method: 'POST', path: '/document', handler: 'documentPost', needsBook: true, write: true, json: true },
  { method: 'POST', path: '/document/rename', handler: 'documentRename', needsBook: true, write: true, json: true },
  { method: 'POST', path: '/document/delete', handler: 'documentDelete', needsBook: true, write: true, json: true },
  { method: 'POST', path: '/document/move', handler: 'documentMove', needsBook: true, write: true, json: true },
  /* 文档回收站：以前只能进不能出，删错了只能去资源管理器翻。 */
  { method: 'GET', path: '/document/trash', handler: 'documentTrashGet', needsBook: true, write: false, json: true },
  { method: 'POST', path: '/document/trash/restore', handler: 'documentTrashRestore', needsBook: true, write: true, json: true },

  /* 派生 JSON（全部走 jsonstore） */
  { method: 'POST', path: '/annotations', handler: 'annotationsPost', needsBook: true, write: true, json: true },
  { method: 'POST', path: '/memory', handler: 'memoryPost', needsBook: true, write: true, json: true },
  { method: 'POST', path: '/map', handler: 'mapPost', needsBook: true, write: true, json: true },
  /* 只读：地图 + 素材清单。前端轮询它，AI 画完的东西立刻出现在面板上。 */
  { method: 'GET', path: '/map', handler: 'mapGet', needsBook: true, write: false, json: true },
  /* 素材库（AI 画的 SVG）：列表 + 删除 */
  { method: 'GET', path: '/assets', handler: 'assetsGet', needsBook: true, write: false, json: true },
  { method: 'POST', path: '/assets/delete', handler: 'assetsDelete', needsBook: true, write: true, json: true },
  { method: 'POST', path: '/context', handler: 'contextPost', needsBook: true, write: true, json: true },
  { method: 'POST', path: '/tasks', handler: 'tasksPost', needsBook: true, write: true, json: true },

  /* 快照 / 导出（导出是唯一的非 JSON 响应） */
  { method: 'POST', path: '/snapshot', handler: 'snapshotPost', needsBook: true, write: true, json: true },
  { method: 'GET', path: '/export', handler: 'exportGet', needsBook: true, write: false, json: false },

  /* AI 工作台 */
  { method: 'GET', path: '/ai/recipes', handler: 'aiRecipes', needsBook: false, write: false, json: true },
  { method: 'POST', path: '/ai/review', handler: 'aiReview', needsBook: true, write: true, json: true },
  { method: 'POST', path: '/ai/run', handler: 'aiRun', needsBook: true, write: true, json: true },

  /* 备份 */
  { method: 'GET', path: '/backups', handler: 'backupsGet', needsBook: true, write: false, json: true },
  { method: 'POST', path: '/backups/restore', handler: 'backupsRestore', needsBook: true, write: true, json: true },

  /* 书籍（空书架时的唯一出口） */
  { method: 'GET', path: '/books', handler: 'booksGet', needsBook: false, write: false, json: true , bookScoped: false },
  { method: 'POST', path: '/books', handler: 'bookCreate', needsBook: false, write: true, json: true , bookScoped: false },
  /* 共享库里的书（升级前建的都在那儿），以及「导入到当前对话」 */
  { method: 'GET', path: '/books/shared', handler: 'booksShared', needsBook: false, write: false, bookScoped: false, json: true },
  { method: 'POST', path: '/books/import', handler: 'booksImport', needsBook: false, write: true, bookScoped: false, json: true },
  { method: 'POST', path: '/books/select', handler: 'bookSelect', needsBook: false, write: true, json: true , bookScoped: false },
  { method: 'POST', path: '/books/rename', handler: 'bookRename', needsBook: false, write: true, json: true , bookScoped: false },
  { method: 'POST', path: '/books/trash', handler: 'bookTrash', needsBook: false, write: true, json: true , bookScoped: false },
  { method: 'POST', path: '/books/delete', handler: 'bookDelete', needsBook: false, write: true, json: true , bookScoped: false },

  /* 回收站 */
  { method: 'GET', path: '/trash', handler: 'trashGet', needsBook: false, write: false, json: true , bookScoped: false },
  { method: 'POST', path: '/trash/restore', handler: 'trashRestore', needsBook: false, write: true, json: true , bookScoped: false },
  { method: 'POST', path: '/trash/purge', handler: 'trashPurge', needsBook: false, write: true, json: true , bookScoped: false },

  /* 模型 / 设置 */
  { method: 'GET', path: '/models', handler: 'modelsGet', needsBook: false, write: false, json: true },
  { method: 'POST', path: '/models', handler: 'modelsPost', needsBook: false, write: true, json: true , bookScoped: false },
  { method: 'GET', path: '/settings', handler: 'settingsGet', needsBook: false, write: false, json: true },
  /* 数据目录（自定义小说存放位置）：只读信息 + 修改 */
  { method: 'GET', path: '/storage', handler: 'storageGet', needsBook: false, write: false, json: true, bookScoped: false },
  /* 故事大纲（结构化 outline.json）：读整份 / 写整份 */
  { method: 'GET', path: '/outline', handler: 'outlineGet', needsBook: true, write: false, json: true },
  { method: 'POST', path: '/outline', handler: 'outlinePost', needsBook: true, write: true, json: true },
  /* 故事时间线（作者也能改：改事件、连关系） */
  { method: 'GET', path: '/timeline', handler: 'timelineGet', needsBook: true, write: false, json: true },
  { method: 'POST', path: '/timeline', handler: 'timelinePost', needsBook: true, write: true, json: true },
  { method: 'POST', path: '/storage', handler: 'storagePost', needsBook: false, write: true, json: true, bookScoped: false },
  { method: 'POST', path: '/settings', handler: 'settingsPost', needsBook: false, write: true, json: true , bookScoped: false },
]);

/**
 * 构建 `path → method → record` 索引，并把 handler 字符串解析成函数。
 * 任何一处声明不完整 / 重复 / 指向不存在的 handler 都在这里抛错（模块加载期）。
 *
 * @param {Array<object>} [routes] 路由声明
 * @param {Record<string, Function>} handlers `handler` 名字 → 实现，签名 `(ctx, req, res, url)`
 * @returns {Map<string, Record<string, {method:string,path:string,handler:Function,needsBook:boolean,write:boolean,json:boolean}>>}
 */
export function buildRouteIndex(routes = ROUTES, handlers = {}) {
  const index = new Map();
  routes.forEach((route, position) => {
    const where = `ROUTES[${position}] ${route?.method ?? '?'} ${route?.path ?? '?'}`;
    if (!route || typeof route !== 'object') throw new Error(`[moshu] 路由声明无效：${where}`);
    if (typeof route.path !== 'string' || !route.path.startsWith('/') || route.path.length < 2) {
      throw new Error(`[moshu] 路由 path 必须以 / 开头：${where}`);
    }
    if (typeof route.method !== 'string' || !route.method || route.method !== route.method.toUpperCase()) {
      throw new Error(`[moshu] 路由 method 必须是大写字符串：${where}`);
    }
    /* 「默认拒绝」：三个策略字段少一个都不注册，而不是悄悄按宽松语义跑。 */
    for (const flag of ['needsBook', 'write', 'json']) {
      if (typeof route[flag] !== 'boolean') {
        throw new Error(`[moshu] 路由必须显式声明 ${flag}:true|false：${where}`);
      }
    }
    const handler = typeof route.handler === 'function' ? route.handler : handlers[route.handler];
    if (typeof handler !== 'function') {
      throw new Error(`[moshu] 路由指向未注册的 handler「${route.handler}」：${where}`);
    }
    const methods = index.get(route.path) || {};
    if (methods[route.method]) {
      throw new Error(`[moshu] 路由重复声明：${route.method} ${route.path}`);
    }
    methods[route.method] = Object.freeze({ ...route, handler });
    index.set(route.path, methods);
  });
  return index;
}

/* ------------------------------------------------------------------ 守卫 */

/* 回环/来源校验只保留 api.js 一份实现（这里曾复制过一份，改错一处不会报错）。 */

/**
 * 作品身份校验（`write:true` 的端点）。
 *
 * 所有写请求都要带上 `X-Moshu-Book: <bootstrap 返回的 bookId>`。切书是「先改服务端 settings
 * 再换前端状态」，中间有窗口；没有这道闸，旧书里未保存的正文会在切书后被写进新书的同名文件
 * （实测：200、无提示、两本书同时被污染）。
 *
 * 还没有任何作品时不拦：那种情况下「写错书」无从谈起，真正的答案由空书架守卫（409）给出。
 */
export function assertSameBook(req) {
  const raw = String(req.headers['x-moshu-book'] || '').trim();
  let claimed = raw;
  if (claimed) {
    try {
      claimed = decodeURIComponent(raw);
    } catch {
      /* 不是合法编码就按原样比较 */
    }
  }
  const book = currentBook();
  if (!book) return;
  /* fail-closed：有当前作品时，写请求**必须**声明自己写的是哪一本。
     以前缺头就直接放行，于是「防止旧书正文写进新书」这道闸只对愿意带头的客户端生效。 */
  if (!claimed) {
    throw new HttpError(428, `这次写入没有带作品身份（X-Moshu-Book）。当前作品是《${book.id}》，请刷新页面后重试。`, {
      details: { conflict: 'book', bookId: book.id, missingBookHeader: true },
    });
  }
  if (claimed !== book.id) {
    throw new HttpError(409, `这本书已经切走了（当前是《${book.id}》）。为避免写错书，这次保存被拒绝；切回《${claimed}》再保存即可。`, {
      details: { conflict: 'book', bookId: book.id, claimedBook: claimed },
    });
  }
}

/** 空书架守卫（`needsBook:true` 的端点）。 */
export function assertBookAvailable() {
  if (!currentBook()) {
    throw new HttpError(409, '还没有作品：请先在顶栏「当前书籍」里新建一本，或从回收站恢复。');
  }
}

/** 写操作带的请求体必须是 JSON（防 `text/plain` 简单请求）。 */
export function assertJsonBody(req) {
  const method = String(req.method || 'GET').toUpperCase();
  if (method === 'GET' || method === 'HEAD') return;
  const hasBody = Boolean(req.headers['transfer-encoding']) || Number(req.headers['content-length'] || 0) > 0;
  if (!hasBody) return;
  const type = String(req.headers['content-type'] || '').toLowerCase();
  if (!type.includes('application/json')) {
    throw new HttpError(415, '写操作必须使用 application/json。');
  }
}

/* ------------------------------------------------------------------ 分发 */

/**
 * @param {Record<string, Function>} handlers `handler` 名字 → 实现，签名 `(ctx, req, res, url)`
 * @returns {(ctx:any, req:import('node:http').IncomingMessage, res:import('node:http').ServerResponse)=>Promise<void>}
 */
export function createDispatcher(handlers) {
  const index = buildRouteIndex(ROUTES, handlers);

  return async function dispatch(ctx, req, res) {
    const url = new URL(req.url ?? '/', 'http://moshu.invalid');
    const pathname = url.pathname;
    if (pathname !== PREFIX && !pathname.startsWith(`${PREFIX}/`)) {
      sendJson(res, 404, { error: `未知路径：${pathname}。` });
      return;
    }
    const route = pathname.slice(PREFIX.length).replace(/\/+$/, '') || '/';
    const entry = index.get(route);
    const method = (req.method || 'GET').toUpperCase();
    if (method === 'OPTIONS') {
      /* 先匹配再回 OPTIONS：以前对不存在的路径也回 204 + 一份固定的 Allow，
         任何探测器都会以为"这条路径存在且支持增删改"。 */
      if (!entry) {
        sendJson(res, 404, { error: `不存在的接口：OPTIONS ${PREFIX}${route === '/' ? '' : route}。` });
        return;
      }
      res.statusCode = 204;
      res.setHeader('Allow', `${Object.keys(entry).join(', ')}, OPTIONS`);
      res.end();
      return;
    }
    if (!entry) {
      sendJson(res, 404, { error: `不存在的接口：${method} ${PREFIX}${route === '/' ? '' : route}。` });
      return;
    }
    const declared = entry[method];
    if (!declared) {
      const allow = Object.keys(entry).join(', ');
      res.setHeader('Allow', allow);
      sendJson(res, 405, { error: `接口 ${PREFIX}${route} 不支持 ${method} 方法，可用方法：${allow}。` });
      return;
    }
    /* 作用域必须在**任何守卫之前**生效。
       守卫里的 `currentBook()` 走的是 `loadSettings()`，而它按作用域解析书库；
       以前守卫跑在 runInScope 外面，于是会话作用域里的写请求会按「共享库」判断，
       直接 409「还没有作品」——表现就是「新建章节无效」。 */
    const scope = sanitizeScope(req.headers['x-moshu-scope']);
    await runInScope(scope, async () => {
      /* 按声明执行守卫：作品身份 → 空书架 → JSON body 类型。
         GET 不校验身份（读错书只是显示旧内容），与 v3 之前一致。 */
      if (declared.write && declared.bookScoped !== false) assertSameBook(req);
      if (declared.needsBook) assertBookAvailable();
      if (declared.write && declared.json) assertJsonBody(req);
      await declared.handler(ctx, req, res, url);
    });
  };
}
