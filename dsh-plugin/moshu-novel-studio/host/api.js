/**
 * 墨枢 Host 半：/api/moshu/* 各端点的实现。
 *
 * 由 index.js 通过 ctx.webServer.register({ kind:'prefix', path:'/api/moshu', handler })
 * 挂进 DSH 自己的 HTTP 监听器：一个进程、一个端口、没有独立服务、没有跨端口 fetch。
 *
 * 结构（v3）：
 * - `routes.js`：路由表（一条记录声明 method/path/handler/needsBook/write/json）+ dispatch + 三类守卫；
 * - `http.js`：sendJson / 请求体 / 参数校验等与业务无关的原语；
 * - `current-book.js`：唯一决定「当前是哪一本作品」的地方；
 * - `jsonstore.js`：派生 JSON（批注 / 记忆 / 任务 / 地图 / 上下文）的唯一读写入口；
 * - 本文件：只剩「每个端点做什么」。
 *
 * 约定：
 * - handler 签名统一为 (ctx, req, res, url) => Promise<void>
 * - 统一 JSON 响应 + `Content-Type: application/json; charset=utf-8`
 * - 失败统一 4xx/5xx + `{ error: '中文原因' }`
 * - 请求体上限 16 MB
 */
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { HttpError } from './errors.js';
import * as store from './store.js';
import * as review from './review.js';
import * as books from './books.js';
import * as models from './models.js';
import * as ai from './ai.js';
import * as backups from './backups.js';
import * as documents from './documents.js';
import * as assetsApi from './assets.js';
import * as jsonstore from './jsonstore.js';
import { validateMap } from './map.js';
import { EDITABLE_KEYS, defaultSettings, readSettings, settingsRanges, writeSettingsPatch } from './settings.js';
import { AI_TIMEOUT_MS, MAX_ANNOTATIONS, buildRequest, guardInstruction } from './prompts.js';
import {
  MAX_BODY_BYTES,
  messageOf,
  optionalStringArray,
  readJsonBody,
  requireArray,
  requireText,
  sendJson,
} from './http.js';
import { PREFIX, createDispatcher } from './routes.js';

/** 路由前缀（定义在 routes.js，这里再导出保持既有 import 不变）。 */
export { PREFIX, MAX_BODY_BYTES };

/**
 * 接口版本。前端 client.js 里有同一个常量：
 * 前端跟着插件包立刻更新，后端要重启 DSH 才换，所以两边必须能对上号。
 * 改任何接口形状 / 加删端点时 +1。
 */
export const API_VERSION = 6;

/** 正文 PUT 上限 2 MB、审阅正文上限 500 KB（沿用旧后端）。 */
const MAX_DOCUMENT_BYTES = 2_000_000;
const MAX_REVIEW_BYTES = 500_000;

/* ------------------------------------------------------------------ 各端点 */

async function handleHealth(_req, res) {
  const { projectDir, novelDir } = store.projectContext();
  /* apiVersion：前端用它判断"我是不是在对一个还没重启的旧后端说话"。改接口就加 1。 */
  sendJson(res, 200, { ok: true, apiVersion: API_VERSION, projectDir, novelDir });
}

async function handleStatus(ctx, res) {
  const { settings } = store.projectContext();
  sendJson(res, 200, review.describeStatus(ctx, settings));
}

async function handleBootstrap(ctx, res) {
  const { novelDir, settings, book } = store.projectContext();
  const status = review.describeStatus(ctx, settings);
  const dsh = {
    available: status.available,
    status: status.status,
    provider: status.provider,
    model: status.model,
    message: status.message,
  };
  /* 一本作品都不存在时，**不要** initializeProject：那会按种子把《雾隐之城》重新造出来，
     作者会以为"删除没生效 / 切换内容没变"。这里直接返回空书架，让页面显示"新建第一本书"。
     唯一判断依据是 `currentBook()`（`host/current-book.js`），读路径上不创建任何目录。 */
  if (!book) {
    sendJson(res, 200, {
      name: '',
      bookId: '',
      subtitle: '',
      root: novelDir,
      documents: [],
      annotations: [],
      memories: [],
      map: { locations: [], routes: [] },
      tasks: [],
      timeline: [],
      contextDocumentIds: [],
      dsh,
    });
    return;
  }
  await store.initializeProject(book.root);
  const project = await store.bootstrap(book.root, dsh);
  sendJson(res, 200, project);
}

async function handleDocumentPut(req, res) {
  const body = await readJsonBody(req);
  if (typeof body.content !== 'string' || body.content.length > MAX_DOCUMENT_BYTES) {
    throw new HttpError(400, '文档 content 必须是 2 MB 以内的字符串。');
  }
  // 可选乐观锁：不给 expectedMtime 就是老行为（直接覆盖）；给了就必须与磁盘当前 mtime 一致。
  let expectedMtime;
  if (body.expectedMtime !== undefined && body.expectedMtime !== null) {
    const value = Number(body.expectedMtime);
    if (!Number.isFinite(value)) throw new HttpError(400, 'expectedMtime 必须是毫秒数（bootstrap 返回的 document.mtime）。');
    expectedMtime = value;
  }
  const { novelDir } = store.projectContext();
  const saved = await store.saveDocument(novelDir, body.path, body.content, {
    create: false,
    keep: readSettings().backupKeep,
    expectedMtime,
  });
  sendJson(res, 200, { ok: true, ...saved });
}

async function handleDocumentPost(req, res) {
  const body = await readJsonBody(req);
  let content;
  if (typeof body.content === 'string') content = body.content;
  else if (body.content !== undefined && body.content !== null) {
    throw new HttpError(400, '文档 content 必须是字符串。');
  } else content = `# ${requireText(body.title, 'title', 200)}\n`;
  if (content.length > MAX_DOCUMENT_BYTES) throw new HttpError(400, '文档 content 必须是 2 MB 以内的字符串。');
  const { novelDir } = store.projectContext();
  /* 新建文档前**不要** initializeProject：空书架时那会把《雾隐之城》造出来。 */
  const saved = await store.saveDocument(novelDir, body.path, content, { create: true, keep: readSettings().backupKeep });
  sendJson(res, 201, { ok: true, ...saved });
}

async function handleAnnotationsPost(req, res) {
  const body = await readJsonBody(req);
  const batch = Array.isArray(body.annotations);
  const incoming = batch ? requireArray(body.annotations, 'annotations') : [body.annotation || body];
  const replaceAll = body.replaceAll === true;
  /* 整表替换 + 空数组 = 清空全书批注。这不是「保存」，是一次误调用就能毁掉整本稿子的批注，
     所以必须显式 force（v3 契约 §2.2）。 */
  if (replaceAll && batch && incoming.length === 0 && body.force !== true) {
    throw new HttpError(400, '拒绝用空数组清空全部批注；确实要清空请传 force:true');
  }
  const now = new Date().toISOString();
  const annotations = incoming.map((raw) => {
    const item = raw && typeof raw === 'object' ? { ...raw } : {};
    if (!item.documentPath && typeof body.documentPath === 'string') item.documentPath = body.documentPath;
    return {
      ...item,
      id: typeof item.id === 'string' && item.id ? item.id : randomUUID(),
      /* 客户端传来的时间戳要能解析：否则 annotations.json 里存进 NaN，
         前端排序 / 时间线全崩。 */
      createdAt: typeof item.createdAt === 'string' && Number.isFinite(Date.parse(item.createdAt))
        ? item.createdAt
        : now,
      source: item.source || 'manual',
    };
  });
  for (const item of annotations) {
    requireText(item.documentPath, 'documentPath', 500);
    requireText(item.comment, 'comment', 20_000);
    if (!['open', 'resolved', 'stale'].includes(item.status)) item.status = 'open';
  }
  const { novelDir } = store.projectContext();
  /* 「读当前表 → 按 id 合并 → 写回」必须在同一把锁里，否则并发保存互相覆盖（审计 P0-4：16 并发只落 1 条）。 */
  await jsonstore.withDocLock(novelDir, 'annotations.json', async () => {
    const current = replaceAll ? [] : await jsonstore.readArray(novelDir, 'annotations.json', []);
    const byId = new Map(current.map((item) => [item.id, item]));
    for (const item of annotations) byId.set(item.id, item);
    const merged = [...byId.values()];
    if (replaceAll) await jsonstore.replaceArray(novelDir, 'annotations.json', merged);
    else await jsonstore.writeArray(novelDir, 'annotations.json', merged);
  });
  sendJson(res, 201, { ok: true, annotations: batch ? annotations : annotations[0] });
}

async function handleMemoryPost(req, res) {
  const body = await readJsonBody(req);
  const replaceAll = Array.isArray(body.memories);
  if (replaceAll && body.memories.length === 0 && body.force !== true) {
    throw new HttpError(400, '拒绝用空数组清空全部记忆；确实要清空请传 force:true。');
  }
  const incoming = replaceAll ? requireArray(body.memories, 'memories') : [body.memory || body];
  const { novelDir } = store.projectContext();
  /* 锁语义同 /annotations：锁定校验也必须看到「最新的表」，否则两个请求能各自通过校验后互相覆盖。 */
  const memories = await jsonstore.withDocLock(novelDir, 'memory/memory.json', async () => {
    const current = replaceAll ? [] : await jsonstore.readArray(novelDir, 'memory/memory.json', []);
    const byId = new Map(current.map((item) => [item.id, item]));
    for (const raw of incoming) {
      const item = raw && typeof raw === 'object' ? raw : {};
      requireText(item.title, 'title', 500);
      requireText(item.content, 'content', 100_000);
      const previous = byId.get(item.id);
      if (previous?.locked && item.locked !== false && body.force !== true) {
        throw new HttpError(409, `「${previous.title}」已锁定，请先解锁再修改。`);
      }
      const id = item.id || randomUUID();
      byId.set(id, { ...previous, ...item, id, updatedAt: new Date().toISOString() });
    }
    const next = [...byId.values()];
    await jsonstore.writeArray(novelDir, 'memory/memory.json', next);
    return next;
  });
  sendJson(res, 201, { ok: true, memories });
}

async function handleMapGet(_ctx, _req, res) {
  const { novelDir } = store.projectContext();
  const [map, assets] = await Promise.all([store.readMap(novelDir), assetsApi.listAssetsWithSvg(novelDir)]);
  sendJson(res, 200, { map, assets });
}

async function handleAssetsGet(_ctx, _req, res) {
  const { novelDir } = store.projectContext();
  sendJson(res, 200, { assets: await assetsApi.listAssetsWithSvg(novelDir) });
}

async function handleAssetsDelete(_ctx, req, res) {
  const body = await readJsonBody(req);
  const { novelDir } = store.projectContext();
  sendJson(res, 200, await assetsApi.deleteAsset(novelDir, String(body.id || '')));
}

async function handleMapPost(req, res) {
  const body = await readJsonBody(req);
  const raw = body.map && typeof body.map === 'object' ? body.map : body;
  /* 地图现在整份由数据绘制（陆地多边形 / 山脉 / 森林 / 河流 / 路线 / 地点），
     校验与归一化都在 host/map.js，这里不再自己挑字段——以前只留 locations/routes，
     作者画的陆地会被静默丢掉。 */
  /* 空对象（或只有一个 name）传上来时，validateMap 会把它当成"一张空地图"落盘，
     把作者画的陆地/山脉/河流全部清掉。要么明确说明，要么别接受。 */
  const collections = ['landmasses', 'mountains', 'forests', 'terrain', 'rivers', 'routes', 'locations'];
  const hasCollection = collections.some((key) => raw && Object.prototype.hasOwnProperty.call(raw, key));
  if (!hasCollection) {
    throw new HttpError(400, '这次没有携带任何地图内容（landmasses/locations/…）。如果确实要清空地图，请把这些字段显式传成空数组。');
  }
  const map = validateMap(raw);
  const { novelDir } = store.projectContext();
  await jsonstore.writeObject(novelDir, 'maps/main.map.json', map);
  sendJson(res, 200, { ok: true, map });
}

async function handleContextPost(req, res) {
  const body = await readJsonBody(req);
  const ids = requireArray(body.ids, 'ids').filter((id) => typeof id === 'string').slice(0, 100);
  const { novelDir } = store.projectContext();
  /* 上下文选择本来就是「整表就是这几条」，这里用显式整表替换（仍然先备份）。 */
  await jsonstore.replaceArray(novelDir, 'context.json', ids);
  sendJson(res, 200, { ok: true, ids });
}

/**
 * 审阅指令的优先级：请求体 instruction → `settings.reviewFocus` → prompts.js 里的默认。
 * 请求体里的越界指令直接 400（`guardInstruction` 抛错）；设置里的审阅重点越界时
 * 只退回默认值，不让一个存储值把整条审阅卡死。
 * @param {unknown} value 请求体 instruction
 * @param {{reviewFocus?:string}} settings
 * @returns {string} 修剪后的指令（空串表示用 prompts 里的默认）
 */
function resolveReviewInstruction(value, settings) {
  const fromBody = guardInstruction(value);
  if (fromBody) return fromBody;
  const focus = typeof settings.reviewFocus === 'string' ? settings.reviewFocus.trim() : '';
  if (!focus) return '';
  try {
    return guardInstruction(focus);
  } catch {
    return '';
  }
}

/**
 * `maxAnnotations`：给了就必须是 1–20 的整数，否则 400。
 * 以前审阅走「静默夹紧」、`/ai/run` 走「400」，同一份客户端代码两条路径行为不同。
 */
/** 严格版本：给值就必须合法；不给则用设置值。 */
function strictAnnotationCount(value, fallback) {
  if (value === undefined || value === null) {
    return Math.min(Math.max(1, Number(fallback) || 8), MAX_ANNOTATIONS);
  }
  const number = Number(value);
  if (!Number.isInteger(number) || number < 1 || number > MAX_ANNOTATIONS) {
    throw new HttpError(400, `maxAnnotations 必须是 1 ~ ${MAX_ANNOTATIONS} 的整数。`);
  }
  return number;
}

function clampAnnotationCount(value, fallback) {
  const pick = (input) => {
    if (input === undefined || input === null || input === '') return null;
    const number = Number(input);
    if (!Number.isFinite(number)) return null;
    return Math.min(MAX_ANNOTATIONS, Math.max(1, Math.round(number)));
  };
  return pick(value) ?? pick(fallback) ?? 8;
}

/**
 * AI 审阅（旧入口 `/ai/review`）。
 *
 * 与 `/ai/run` 走**同一条**提示词与上下文路径：
 * `prompts.buildRequest('review', …)` 出 system+prompt、`ai.assembleContext` 组装上下文、
 * `ai.streamText` 调模型、`review.parseReviewAnnotations` 锚定。
 * 与 `/ai/run` 的差别只有两点：结果直接落成批注（这是页面"审阅"按钮的既有语义），
 * 以及会往 tasks.json 记一条 type='review' 的任务。
 */
/**
 * 把「客户端断开」变成 AbortSignal：用户关页面/切走时，正在跑的模型调用要停。
 * 以前只有 240 秒超时这一个出口，关掉页面照样跑满、照样计费。
 */
function requestSignal(req) {
  const controller = new AbortController();
  try {
    req.on('close', () => controller.abort());
    req.on('aborted', () => controller.abort());
  } catch {
    /* 老版本没有这些事件就只靠超时 */
  }
  return controller.signal;
}

async function handleReviewPost(ctx, req, res) {
  const body = await readJsonBody(req);
  const documentPath = requireText(body.documentPath || body.path, 'documentPath', 500);
  if (typeof body.content === 'string' && body.content.length > MAX_REVIEW_BYTES) {
    throw new HttpError(400, `文档 content 必须是 ${Math.round(MAX_REVIEW_BYTES / 1000)} KB 以内的字符串。`);
  }
  const { novelDir } = store.projectContext();
  // 注意：projectContext().settings 只有 provider/model/novelDir，
  // 审阅还用得到 reviewFocus / maxAnnotations / contextRelatedDocs / contextMemories，
  // 所以这里和 /ai/run 一样取「默认值 ← settings.json 合法覆盖」的完整设置。
  const settings = readSettings();
  const instruction = resolveReviewInstruction(body.instruction, settings);
  const maxAnnotations = strictAnnotationCount(body.maxAnnotations, settings.maxAnnotations);

  // 上下文与 /ai/run 同一份组装代码（旧前端的 context / sources 仍被接受，但以自动组装为准）。
  const signal = requestSignal(req);
  const assembled = await ai.assembleContext({
    novelDir,
    settings,
    recipe: { target: 'chapter' },
    targetPath: documentPath,
    contextIds: body.contextIds,
    targetContent: typeof body.content === 'string' && body.content.trim() ? body.content : undefined,
    legacyRelated: body.context?.related,
    legacyMemories: body.context?.memories,
  });
  const document = assembled.document;
  if (!document || !String(document.content || '').trim()) {
    throw new HttpError(400, '这一章还没有正文，无法审阅。请先写入内容再运行审阅。');
  }

  const status = review.describeStatus(ctx, settings);
  if (!status.available) throw new HttpError(503, status.message);
  const llm = ctx.get('llm');

  const request = buildRequest('review', {
    instruction,
    maxAnnotations,
    allowRewriteSuggestion: Boolean(settings.allowRewriteSuggestion),
    context: {
      document,
      documents: assembled.documents,
      memories: assembled.memories,
      budget: assembled.budget,
    },
  });

  const task = {
    id: randomUUID(),
    type: 'review',
    title: `审阅 ${document.path}`,
    status: 'running',
    createdAt: new Date().toISOString(),
    sources: assembled.sources.length ? assembled.sources : [document.path],
    mode: 'dsh',
    summary: `${settings.provider} / ${settings.model} 正在分析剧情、逻辑、人物、设定和语言`,
  };
  await store.appendTask(novelDir, task);

  const startedAt = Date.now();
  try {
    const text = await ai.streamText(llm, {
      signal,
      provider: settings.provider,
      model: settings.model,
      system: request.system,
      prompt: request.prompt,
      timeoutMs: AI_TIMEOUT_MS,
    });
    const elapsedMs = Date.now() - startedAt;
    const anchored = ai.anchorAnnotations(text, { documentPath: document.path, content: document.content }, maxAnnotations);
    const annotations = anchored.annotations.map((annotation) => ({ ...annotation, source: 'dsh', origin: 'review' }));
    task.status = 'completed';
    task.elapsedMs = elapsedMs;
    task.summary = `审阅完成，生成 ${annotations.length} 条可定位批注（丢弃 ${anchored.dropped} 条无法锚定的；${settings.provider} / ${settings.model}）`;
    await store.appendTask(novelDir, task);
    sendJson(res, 200, { annotations, mode: 'dsh', task, dropped: anchored.dropped, elapsedMs });
  } catch (error) {
    task.status = 'failed';
    task.elapsedMs = Date.now() - startedAt;
    task.summary = error instanceof Error ? error.message : '审阅失败';
    await store.appendTask(novelDir, task).catch(() => {});
    throw error;
  }
}

async function handleTasksPost(req, res) {
  const body = await readJsonBody(req);
  const title = requireText(body.title, 'title', 500);
  const { novelDir } = store.projectContext();
  const task = {
    id: randomUUID(),
    type: typeof body.type === 'string' ? body.type : 'manual',
    title,
    status: ['completed', 'running', 'failed'].includes(body.status) ? body.status : 'completed',
    createdAt: new Date().toISOString(),
    sources: optionalStringArray(body.sources),
    mode: typeof body.mode === 'string' ? body.mode : 'manual',
    /* 单条摘要不设上限时，100 条 × 1 MB 可以让 tasks.json 长到 100 MB，
       而且每次 append 都要整表读写。 */
    summary: typeof body.summary === 'string' ? body.summary.slice(0, 2000) : '',
  };
  await store.appendTask(novelDir, task);
  sendJson(res, 201, { ok: true, task });
}

async function handleSnapshotPost(_req, res) {
  const { novelDir } = store.projectContext();
  const snapshot = await store.createSnapshot(novelDir);
  sendJson(res, 201, { ok: true, ...snapshot });
}

async function handleExportGet(_req, res) {
  const { novelDir } = store.projectContext();
  const markdown = await store.exportNovel(novelDir);
  const title = path.basename(novelDir) || store.DEFAULT_NOVEL_NAME;
  const filename = `${title}.md`;
  if (res.writableEnded) return;
  res.statusCode = 200;
  res.setHeader('Content-Type', 'text/markdown; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="mo-shu.md"; filename*=UTF-8''${encodeURIComponent(filename)}`);
  res.setHeader('Content-Length', Buffer.byteLength(markdown));
  res.end(markdown);
}

/* ------------------------------------------------------------------ 书籍 */

async function handleBooksGet(_ctx, _req, res) {
  const { projectDir } = store.projectContext();
  sendJson(res, 200, await books.describeBooks(projectDir));
}

async function handleBookCreate(_ctx, req, res) {
  const body = await readJsonBody(req);
  const { projectDir } = store.projectContext();
  const { book, books: list } = await books.createBook(projectDir, body.name, { sample: body.sample === true });
  sendJson(res, 201, { ok: true, book, books: list });
}

async function handleBooksShared(_ctx, _req, res) {
  const { projectDir } = store.projectContext();
  sendJson(res, 200, await books.listSharedBooks(projectDir));
}

async function handleBooksImport(_ctx, req, res) {
  const body = await readJsonBody(req);
  const { projectDir } = store.projectContext();
  sendJson(res, 201, await books.importSharedBook(projectDir, body.name));
}

async function handleBookSelect(_ctx, req, res) {
  const body = await readJsonBody(req);
  const { projectDir } = store.projectContext();
  const { book } = await books.selectBook(projectDir, body.id);
  sendJson(res, 200, { ok: true, book });
}

async function handleBookRename(_ctx, req, res) {
  const body = await readJsonBody(req);
  const { projectDir } = store.projectContext();
  const { book, books: list } = await books.renameBook(projectDir, body.id, body.name);
  sendJson(res, 200, { ok: true, book, books: list });
}

async function handleBookTrash(_ctx, req, res) {
  const body = await readJsonBody(req);
  const { projectDir } = store.projectContext();
  const { books: list, trashedTo } = await books.trashBook(projectDir, body.id);
  sendJson(res, 200, { ok: true, books: list, trashedTo });
}

/** 彻底删除一本书：不进回收站，磁盘上直接消失。confirm 必须是书名。 */
async function handleBookDelete(_ctx, req, res) {
  const body = await readJsonBody(req);
  const { projectDir } = store.projectContext();
  const result = await books.deleteBookPermanently(projectDir, body.id, body.confirm);
  sendJson(res, 200, { ok: true, ...result });
}

async function handleTrashGet(_ctx, _req, res) {
  const { projectDir } = store.projectContext();
  sendJson(res, 200, { trash: await books.listTrash(projectDir) });
}

async function handleTrashRestore(_ctx, req, res) {
  const body = await readJsonBody(req);
  const { projectDir } = store.projectContext();
  const result = await books.restoreFromTrash(projectDir, body.trashId);
  sendJson(res, 200, { ok: true, ...result });
}

async function handleTrashPurge(_ctx, req, res) {
  const body = await readJsonBody(req);
  const { projectDir } = store.projectContext();
  const result = await books.purgeTrash(projectDir, body.trashId);
  sendJson(res, 200, { ok: true, ...result });
}

/* ------------------------------------------------------------------ 模型 */

async function handleModelsGet(ctx, _req, res) {
  sendJson(res, 200, await models.describeModels(ctx));
}

async function handleModelsPost(_ctx, req, res) {
  const body = await readJsonBody(req);
  sendJson(res, 200, { ok: true, current: await models.setModel(body) });
}

/* ------------------------------------------------------------------ 设置 */

function handleSettingsGet(_ctx, _req, res) {
  sendJson(res, 200, {
    settings: readSettings(),
    defaults: defaultSettings(),
    ranges: settingsRanges(),
    editable: [...EDITABLE_KEYS],
  });
}

async function handleStorageGet(_ctx, _req, res) {
  sendJson(res, 200, store.storageInfo());
}

async function handleStoragePost(_ctx, req, res) {
  const body = await readJsonBody(req);
  const next = await store.setProjectDir(body.projectDir);
  sendJson(res, 200, next);
}

async function handleSettingsPost(_ctx, req, res) {
  const body = await readJsonBody(req);
  const settings = await writeSettingsPatch(body.patch);
  sendJson(res, 200, { ok: true, settings });
}

/* ------------------------------------------------------------------ AI 工作台 */

function handleRecipesGet(_ctx, _req, res) {
  sendJson(res, 200, ai.listRecipes());
}

async function handleAiRun(ctx, req, res) {
  const body = await readJsonBody(req);
  sendJson(res, 200, await ai.runRecipe(ctx, body, requestSignal(req)));
}

/* ------------------------------------------------------------------ 备份 / 文档管理 */

async function handleBackupsGet(_ctx, _req, res, url) {
  sendJson(res, 200, await backups.listBackups(url.searchParams));
}

async function handleBackupsRestore(_ctx, req, res) {
  const body = await readJsonBody(req);
  sendJson(res, 200, await backups.restore(body));
}

async function handleDocumentRename(_ctx, req, res) {
  const body = await readJsonBody(req);
  sendJson(res, 200, await documents.renameDocument(body));
}

async function handleDocumentDelete(_ctx, req, res) {
  const body = await readJsonBody(req);
  sendJson(res, 200, await documents.deleteDocument(body));
}

/**
 * 这个会话是不是「创作模式」。
 *
 * 客户端拿不到会话的 agent preset（客户端包里根本没有 preset 信息），
 * 所以由 Host 回答：`agents.get(sessionId).ctx` → `agentPresets.composedPreset(ctx)`。
 * 任何一步拿不到都返回 `creation: true`——宁可不提示，也不能误报「你不在创作模式」。
 */
async function handleSessionMode(ctx, _req, res, url) {
  const sessionId = String(url?.searchParams?.get('sessionId') || '').trim();
  const result = { sessionId, presetId: null, creation: true, source: 'unknown' };
  if (!sessionId) return sendJson(res, 200, result);
  try {
    const agents = ctx.get('agents');
    const presets = ctx.get('agentPresets');
    const agent = agents && typeof agents.get === 'function' ? agents.get(sessionId) : undefined;
    const agentCtx = agent && (agent.ctx || agent.context);
    if (agentCtx && presets && typeof presets.composedPreset === 'function') {
      const presetId = presets.composedPreset(agentCtx);
      if (typeof presetId === 'string' && presetId) {
        result.presetId = presetId;
        result.creation = presetId === 'moshu-create';
        result.source = 'preset';
      }
    }
  } catch {
    /* 拿不到就保持 creation:true */
  }
  sendJson(res, 200, result);
}

async function handleDocumentTrashGet(_ctx, _req, res) {
  sendJson(res, 200, await documents.listDocumentTrash());
}

async function handleDocumentTrashRestore(_ctx, req, res) {
  const body = await readJsonBody(req);
  sendJson(res, 200, await documents.restoreDocumentFromTrash(body));
}

async function handleDocumentMove(_ctx, req, res) {
  const body = await readJsonBody(req);
  sendJson(res, 200, await documents.moveDocument(body));
}

/* ------------------------------------------------------------------ 分发 */

/**
 * handler 名 → 实现。签名统一为 `(ctx, req, res, url)`。
 *
 * `routes.js` 里的路由表用字符串引用这里的名字；拼错 / 少注册会在 `createDispatcher()`
 * 构建索引时立刻抛错（模块加载期），不会变成运行时的 404。
 */
const HANDLERS = {
  health: (ctx, req, res) => handleHealth(req, res),
  status: (ctx, _req, res) => handleStatus(ctx, res),
  bootstrap: (ctx, _req, res) => handleBootstrap(ctx, res),

  documentPut: (_ctx, req, res) => handleDocumentPut(req, res),
  documentPost: (_ctx, req, res) => handleDocumentPost(req, res),
  documentRename: (ctx, req, res) => handleDocumentRename(ctx, req, res),
  documentDelete: (ctx, req, res) => handleDocumentDelete(ctx, req, res),
  documentMove: (ctx, req, res) => handleDocumentMove(ctx, req, res),
  documentTrashGet: (_ctx, req, res) => handleDocumentTrashGet(_ctx, req, res),
  sessionMode: (ctx, req, res, url) => handleSessionMode(ctx, req, res, url),
  documentTrashRestore: (ctx, req, res) => handleDocumentTrashRestore(ctx, req, res),

  annotationsPost: (_ctx, req, res) => handleAnnotationsPost(req, res),
  memoryPost: (_ctx, req, res) => handleMemoryPost(req, res),
  mapPost: (_ctx, req, res) => handleMapPost(req, res),
  mapGet: (ctx, req, res) => handleMapGet(ctx, req, res),
  assetsGet: (ctx, req, res) => handleAssetsGet(ctx, req, res),
  assetsDelete: (ctx, req, res) => handleAssetsDelete(ctx, req, res),
  contextPost: (_ctx, req, res) => handleContextPost(req, res),
  tasksPost: (_ctx, req, res) => handleTasksPost(req, res),

  snapshotPost: (_ctx, req, res) => handleSnapshotPost(req, res),
  exportGet: (_ctx, req, res) => handleExportGet(req, res),

  aiRecipes: (ctx, req, res) => handleRecipesGet(ctx, req, res),
  aiReview: (ctx, req, res) => handleReviewPost(ctx, req, res),
  aiRun: (ctx, req, res) => handleAiRun(ctx, req, res),

  backupsGet: (ctx, req, res, url) => handleBackupsGet(ctx, req, res, url),
  backupsRestore: (ctx, req, res) => handleBackupsRestore(ctx, req, res),

  booksGet: (ctx, req, res) => handleBooksGet(ctx, req, res),
  bookCreate: (ctx, req, res) => handleBookCreate(ctx, req, res),
  booksShared: (ctx, req, res) => handleBooksShared(ctx, req, res),
  booksImport: (ctx, req, res) => handleBooksImport(ctx, req, res),
  bookSelect: (ctx, req, res) => handleBookSelect(ctx, req, res),
  bookRename: (ctx, req, res) => handleBookRename(ctx, req, res),
  bookTrash: (ctx, req, res) => handleBookTrash(ctx, req, res),
  bookDelete: (ctx, req, res) => handleBookDelete(ctx, req, res),

  trashGet: (ctx, req, res) => handleTrashGet(ctx, req, res),
  trashRestore: (ctx, req, res) => handleTrashRestore(ctx, req, res),
  trashPurge: (ctx, req, res) => handleTrashPurge(ctx, req, res),

  modelsGet: (ctx, req, res) => handleModelsGet(ctx, req, res),
  modelsPost: (ctx, req, res) => handleModelsPost(ctx, req, res),
  settingsGet: (ctx, req, res) => handleSettingsGet(ctx, req, res),
  settingsPost: (ctx, req, res) => handleSettingsPost(ctx, req, res),
  storageGet: (ctx, req, res) => handleStorageGet(ctx, req, res),
  storagePost: (ctx, req, res) => handleStoragePost(ctx, req, res),
};

/**
 * 分发器：路由匹配 + 三类守卫全在 `routes.js`（策略随路由声明一起写死）。
 * 这里只把 handler 实现交过去。
 */
const dispatch = createDispatcher(HANDLERS);

/* ------------------------------------------------------------------ 来源校验 */

/**
 * 本机来源校验（对所有请求统一执行，先于路由匹配 —— 伪造 Host 的请求不会因为路径写错变成 404）。
 *
 * 插件用 `ctx.webServer.register` 自挂路由，宿主那层 `isTrustedApiRequest`（Host/Origin/
 * sec-fetch-site + browser token）管不到这里。不补这一层的话：任何网页都能用
 * `Content-Type: text/plain` 的「简单请求」静默调用 POST /document/delete、/ai/run，
 * DNS rebinding 之后连响应体（整部稿件 + 绝对路径）都能读走。
 *
 * 规则：只认回环 Host；拒绝跨站；带 Origin 时必须与 Host 同源；带 body 的写操作必须 JSON。
 * 这是"防别的网站"，不是"防本机进程"——本机进程本来就能直接读写文件。
 */
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);

function hostnameOf(value) {
  const text = String(value || '').trim().toLowerCase();
  if (!text) return '';
  if (text.startsWith('[')) {
    const end = text.indexOf(']');
    return end === -1 ? text : text.slice(0, end + 1);
  }
  return text.split(':')[0];
}

function assertTrustedRequest(req) {
  const host = hostnameOf(req.headers.host);
  if (host && !LOOPBACK_HOSTS.has(host)) {
    throw new HttpError(403, '墨枢接口只接受本机回环地址访问。');
  }
  const site = String(req.headers['sec-fetch-site'] || '').toLowerCase();
  if (site === 'cross-site') throw new HttpError(403, '拒绝跨站请求。');
  const origin = req.headers.origin;
  if (origin && origin !== 'null') {
    let originHost = '';
    try {
      originHost = hostnameOf(new URL(String(origin)).host);
    } catch {
      originHost = '';
    }
    let originAuthority = originHost;
    try {
      originAuthority = hostnameOf(new URL(String(origin)).host);
      const parsedOrigin = new URL(String(origin));
      /* 同 hostname 不同端口不算同源；这里比 host:port。 */
      const requestAuthority = String(req.headers.host || '').toLowerCase();
      if (requestAuthority && parsedOrigin.host && parsedOrigin.host.toLowerCase() !== requestAuthority) {
        throw new HttpError(403, '拒绝来自其他来源的请求。');
      }
    } catch (error) {
      if (error instanceof HttpError) throw error;
      originAuthority = '';
    }
    if (!originAuthority || (host && originAuthority !== host)) {
      throw new HttpError(403, '拒绝来自其他来源的请求。');
    }
  }
  /* 写操作必须 JSON（防 text/plain 的「简单请求」）。各路由的 json:true 声明会在
     `routes.js` 里再校验一次 —— 这里拦在所有请求之前，保持 v3 之前的状态码不变。 */
  const method = String(req.method || 'GET').toUpperCase();
  const hasBody = Boolean(req.headers['transfer-encoding']) || Number(req.headers['content-length'] || 0) > 0;
  if (method !== 'GET' && method !== 'HEAD' && hasBody) {
    const type = String(req.headers['content-type'] || '').toLowerCase();
    if (!type.includes('application/json')) {
      throw new HttpError(415, '写操作必须使用 application/json。');
    }
  }
}

/**
 * 生成挂到 ctx.webServer 的 handler。
 * @param {any} ctx cordis 上下文（用 ctx.get('llm') 取模型服务）
 * @returns {(req:import('node:http').IncomingMessage, res:import('node:http').ServerResponse)=>Promise<void>}
 */
export function createHandler(ctx) {
  /* 派生 JSON 的坏档 / 备份告警走宿主 logger（没有 ctx 时 jsonstore 退回 console.warn）。 */
  jsonstore.setLogger(ctx?.logger);
  return async function moshuHandler(req, res) {

    try {
      assertTrustedRequest(req);
      await dispatch(ctx, req, res);
    } catch (error) {
      const status = error instanceof HttpError ? error.status : 500;
      if (status >= 500) {
        const logger = ctx?.logger;
        const message = error instanceof Error ? error : new Error(String(error));
        if (logger && typeof logger.warn === 'function') logger.warn(message);
        else console.warn('[moshu]', message);
      }
      if (res.writableEnded) return;
      if (res.headersSent) {
        res.destroy();
        return;
      }
      // details 是错误自带的额外字段（例如 409 冲突的 mtime / content），error 永远由 message 决定。
      const details = error instanceof HttpError && error.details ? error.details : undefined;
      sendJson(res, status, { ...details, error: messageOf(error, status) });
    }
  };
}
