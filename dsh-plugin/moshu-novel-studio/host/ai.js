/**
 * 墨枢 Host 半：AI 工作台（`GET /ai/recipes` / `POST /ai/run`）。
 *
 * 唯一职责：把「作者选的卡片 + 目标 + 指令 + 上下文」交给宿主模型，再把产物结构化回来。
 *
 * 三条硬约束（契约 v2）：
 * 1. 所有提示词都从 `prompts.js` 取，这里只做上下文组装，不自己写 system / task prompt。
 * 2. 每个请求先 `guardInstruction(instruction)`：命中续写/代写类要求直接 400，绝不调模型。
 * 3. **只计算、不落盘**。唯一副作用是往 `tasks.json` 追加一条执行记录；
 *    批注/记忆/文档由前端确认后再打既有端点写回。
 */
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { AI_TIMEOUT_MS, RECIPES, buildRequest, findRecipe, guardInstruction } from './prompts.js';
import { HttpError } from './errors.js';
import * as store from './store.js';
import * as review from './review.js';
import { readSettings } from './settings.js';

/** 一次最多返回多少条批注（与 prompts.js 的 MAX_ANNOTATIONS 对齐）。 */
const MAX_ANNOTATIONS = 20;

/** `target:'novel'` 的卡片没有指定文档时，取前 3 章、每章截断 1800 字。 */
const NOVEL_CHAPTER_LIMIT = 3;
const NOVEL_CHAPTER_CHARS = 1800;

/** 记忆提取最多 12 条（与 prompts.js 的 memoryMode 对齐）。 */
const MEMORY_LIMIT = 12;

/** 单条上下文资料的截断长度（formatContext 内部还会再截一次）。 */
const RELATED_DOC_CHARS = 2400;

/** 记忆条目在上下文里的截断长度。 */
const MEMORY_CHARS = 400;

/** 记忆 type → 中文类别（旧数据用 type，新数据用 category）。 */
const MEMORY_CATEGORY = {
  canon: '设定',
  character: '人物',
  foreshadowing: '伏笔',
  event: '事件',
  relation: '关系',
  item: '物品',
  location: '地点',
  setting: '设定',
};

/** `GET /ai/recipes`：任务卡清单直接来自 prompts.js。 */
export function listRecipes() {
  return { recipes: RECIPES };
}

/* ------------------------------------------------------------------ 上下文 */

const clip = (value, max) => {
  const text = String(value ?? '');
  return text.length > max ? `${text.slice(0, max)}…（已截断）` : text;
};

function normalizeIds(value) {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item) => typeof item === 'string' && item.trim())
    .map((item) => item.trim())
    .slice(0, 30);
}

function typeOf(relative) {
  if (relative.startsWith('chapters/')) return 'chapter';
  if (relative.startsWith('characters/')) return 'character';
  if (relative.startsWith('factions/')) return 'faction';
  if (relative.startsWith('locations/')) return 'location';
  if (relative.startsWith('outline/')) return 'outline';
  if (relative.startsWith('memory/')) return 'memory';
  return 'world';
}

/** 读取目标文档（先查已加载列表，查不到再单独读盘；不存在就 404）。 */
async function readTarget(novelDir, documents, targetPath) {
  const { relative } = store.resolveMarkdown(novelDir, targetPath);
  const found = documents.find((doc) => doc.path === relative);
  if (found) return { path: found.path, title: found.title, type: found.type, content: found.content };
  let content;
  try {
    content = await store.readDocument(novelDir, relative);
  } catch (error) {
    if (error?.code === 'ENOENT') throw new HttpError(404, `目标文档「${relative}」不存在。`);
    throw error;
  }
  const title = content.match(/^#\s+(.+)$/m)?.[1]?.trim() || path.posix.basename(relative, '.md');
  return { path: relative, title, type: typeOf(relative), content };
}

/** 整本视角：前 3 章拼接（每章截断 1800 字）。 */
function novelTarget(documents) {
  const chapters = documents.filter((doc) => doc.type === 'chapter').slice(0, NOVEL_CHAPTER_LIMIT);
  if (!chapters.length) return undefined;
  return {
    path: '',
    title: `整本视角 · 前 ${chapters.length} 章`,
    type: 'novel',
    content: chapters
      .map((doc) => `<!-- ${doc.path} -->\n${clip(doc.content, NOVEL_CHAPTER_CHARS)}`)
      .join('\n\n---\n\n'),
  };
}

/** 相关资料的相关度：标题出现在正文里最重，其次资料里的关键短语出现在正文里。 */
function scoreRelated(doc, targetText) {
  let score = 0;
  if (doc.title && targetText.includes(doc.title)) score += 10;
  for (const line of doc.content.split('\n').slice(0, 40)) {
    const phrase = line.replace(/^[\s>*#\-+]+/, '').trim().slice(0, 12);
    if (phrase.length >= 4 && targetText.includes(phrase)) score += 2;
  }
  if (['character', 'location', 'world', 'outline', 'faction', 'clue'].includes(doc.type)) score += 1;
  return score;
}

/**
 * 自动挑相关资料：只从非章节文档里选，按相关度排序，取 settings.contextRelatedDocs 条。
 */
function pickRelatedDocs(documents, targetText, limit, exclude) {
  if (!Number.isFinite(limit) || limit <= 0) return [];
  const candidates = documents.filter((doc) => doc.type !== 'chapter' && !exclude.has(doc.path));
  const scored = candidates.map((doc) => ({ doc, score: scoreRelated(doc, targetText) }));
  scored.sort((left, right) => right.score - left.score || left.doc.path.localeCompare(right.doc.path));
  return scored.slice(0, limit).map(({ doc }) => ({
    path: doc.path,
    title: doc.title,
    type: doc.type,
    content: clip(doc.content, RELATED_DOC_CHARS),
  }));
}

/** 旧前端（`body.context.related`）给的资料：只留合法路径，最多 5 条（与旧 UI 的上限一致）。 */
function normalizeLegacyRelated(value) {
  if (!Array.isArray(value)) return [];
  return value
    .filter((doc) => doc && typeof doc === 'object' && typeof doc.path === 'string' && doc.path.trim())
    .slice(0, 5)
    .map((doc) => ({
      path: doc.path.trim(),
      title: typeof doc.title === 'string' ? doc.title : path.posix.basename(doc.path.trim(), '.md'),
      type: typeof doc.type === 'string' ? doc.type : typeOf(doc.path.trim()),
      content: clip(doc.content, RELATED_DOC_CHARS),
    }));
}

/** 旧前端（`body.context.memories`）给的记忆：只在磁盘上一条记忆都没有时兜底。 */
function normalizeLegacyMemories(value) {
  if (!Array.isArray(value)) return [];
  return value
    .filter((memory) => memory && typeof memory === 'object' && memory.status !== 'pending' && typeof memory.title === 'string')
    .map((memory) => ({
      title: memory.title,
      content: clip(memory.content, MEMORY_CHARS),
      category: memory.category || MEMORY_CATEGORY[memory.type] || '设定',
      locked: Boolean(memory.locked),
    }));
}

/**
 * 组装一次调用能看到的全部上下文 —— `/ai/run` 与 `/ai/review` **共用这一份**。
 *
 * 规则（契约 v2「上下文组装」）：
 * - 目标文档：`targetPath` 指定的那篇；`recipe.target === 'novel'` 且没指定时取前 3 章；
 *   都没有时退到第一章。`targetContent` 给了就用它当正文（页面里正在编辑的版本）。
 * - 相关资料：`contextIds` 手选的那几篇 + 自动按相关度取的 `settings.contextRelatedDocs` 篇
 *   （只从非章节文档里选）+ 旧前端 `context.related`（去重后补齐，保证老页面还能用）。
 * - 记忆：排除 `status === 'pending'`、排除与目标章节同名的条目，`locked` 优先，
 *   取 `settings.contextMemories` 条；磁盘上一条都没有时才用旧前端传的。
 *
 * @param {{novelDir:string, settings:any, recipe?:any, targetPath?:string, contextIds?:unknown,
 *          targetContent?:string, legacyRelated?:unknown, legacyMemories?:unknown}} params
 */
export async function assembleContext({
  novelDir,
  settings,
  recipe,
  targetPath,
  contextIds,
  targetContent,
  legacyRelated,
  legacyMemories,
}) {
  const documents = await store.listDocuments(novelDir);

  let document;
  let targetText = '';
  const requested = typeof targetPath === 'string' ? targetPath.trim() : '';
  const liveContent = typeof targetContent === 'string' ? targetContent : undefined;
  if (requested) {
    try {
      document = await readTarget(novelDir, documents, requested);
    } catch (error) {
      // 页面正在编辑的新章节可能还没落盘：有正文就以正文为准，没有才 404。
      if (!(error instanceof HttpError) || error.status !== 404 || liveContent === undefined) throw error;
      const { relative } = store.resolveMarkdown(novelDir, requested);
      document = { path: relative, title: path.posix.basename(relative, '.md'), type: typeOf(relative), content: liveContent };
    }
    targetText = document.content;
  } else if (recipe?.target === 'novel') {
    document = novelTarget(documents);
    targetText = documents
      .filter((doc) => doc.type === 'chapter')
      .slice(0, NOVEL_CHAPTER_LIMIT)
      .map((doc) => doc.content)
      .join('\n');
  } else {
    const firstChapter = documents.find((doc) => doc.type === 'chapter');
    if (firstChapter) {
      document = { path: firstChapter.path, title: firstChapter.title, type: firstChapter.type, content: firstChapter.content };
      targetText = firstChapter.content;
    }
  }

  if (document && liveContent !== undefined) {
    document = { ...document, content: liveContent };
    targetText = liveContent;
  }

  const seen = new Set(document?.path ? [document.path] : []);
  const related = [];

  // 1) 作者手选的 contextIds（不存在的静默跳过，越界路径直接 400）
  for (const id of normalizeIds(contextIds)) {
    const { relative } = store.resolveMarkdown(novelDir, id);
    if (seen.has(relative)) continue;
    const found = documents.find((doc) => doc.path === relative);
    const content = found ? found.content : await store.readDocument(novelDir, relative).catch(() => '');
    if (!found && !content) continue;
    seen.add(relative);
    related.push({
      path: relative,
      title: found?.title || path.posix.basename(relative, '.md'),
      type: found?.type || typeOf(relative),
      content: clip(content, RELATED_DOC_CHARS),
    });
  }

  // 2) 自动相关资料
  related.push(...pickRelatedDocs(documents, targetText, Number(settings.contextRelatedDocs), seen));
  for (const doc of related) seen.add(doc.path);

  // 3) 旧前端勾选的资料（去重后补在最后，不覆盖自动挑选的结果）
  for (const doc of normalizeLegacyRelated(legacyRelated)) {
    let relative;
    try {
      relative = store.resolveMarkdown(novelDir, doc.path).relative;
    } catch {
      continue;
    }
    if (seen.has(relative)) continue;
    seen.add(relative);
    related.push({ ...doc, path: relative });
  }

  // 4) 记忆：locked 优先，待确认（pending）的不进上下文，与目标章节同名的不进上下文
  const rawMemories = await store.readMemories(novelDir);
  const excludedTitles = new Set(
    [document?.title, document?.path ? path.posix.basename(document.path, '.md') : '']
      .filter((title) => typeof title === 'string' && title.trim())
      .map((title) => title.trim()),
  );
  const usableMemories = rawMemories.filter((memory) => (
    memory
    && typeof memory === 'object'
    && memory.status !== 'pending'
    && !excludedTitles.has(String(memory.title ?? '').trim())
  ));
  const memories = usableMemories.length
    ? usableMemories
      .sort((left, right) => Number(Boolean(right.locked)) - Number(Boolean(left.locked)))
      .slice(0, Math.max(0, Number(settings.contextMemories) || 0))
      .map((memory) => ({
        title: typeof memory.title === 'string' ? memory.title : '',
        content: clip(memory.content, MEMORY_CHARS),
        category: memory.category || MEMORY_CATEGORY[memory.type] || '设定',
        locked: Boolean(memory.locked),
      }))
    : normalizeLegacyMemories(legacyMemories).slice(0, Math.max(0, Number(settings.contextMemories) || 0));

  /* `related` 是「最多送几篇」，不是「实际篇数」。以前写成 max(4, len)，
     于是手选多少就送多少——30 篇手选 + 自动挑选能拼出 8 万字符的 prompt。
     这里给的是上限：formatContext 会按 budget.related 截断。 */
  const budget = {
    related: Math.min(Math.max(related.length, settings.contextRelatedDocs || 4), 8),
    documentChars: recipe?.target === 'novel' ? 3000 : 2400,
    totalChars: 48_000,
  };

  const sources = [
    ...(document?.path ? [document.path] : []),
    ...related.map((doc) => doc.path),
    ...memories.filter((memory) => memory.locked && memory.title).map((memory) => memory.title),
  ].slice(0, 20);

  return { document, documents: related, memories, budget, sources };
}

/* ------------------------------------------------------------------ 模型 */

/**
 * 调一次模型并把 text-delta 分块聚成完整文本（system 用 prompts.js 给的）。
 * `/ai/run` 与 `/ai/review` 共用这一个调用点。
 */
export async function streamText(llm, options) {
  const { provider, model, system, prompt, timeoutMs, signal } = options;
  const messages = [{ role: 'user', content: [{ type: 'text', text: prompt }] }];
  let text = '';
  let finishReason = '';
  try {
    /* 超时信号 + 调用方的取消信号合并：客户端断开时不该继续烧 token。 */
    const timeoutSignal = AbortSignal.timeout(timeoutMs);
    const combined = signal
      ? (typeof AbortSignal.any === 'function' ? AbortSignal.any([timeoutSignal, signal]) : signal)
      : timeoutSignal;
    const stream = llm.stream({ provider, model, messages, system, signal: combined });
    for await (const chunk of stream) {
      if (!chunk || typeof chunk !== 'object') continue;
      if (chunk.type === 'text-delta' && typeof chunk.text === 'string') text += chunk.text;
      else if (chunk.type === 'finish' && typeof chunk.reason === 'string') finishReason = chunk.reason;
    }
  } catch (error) {
    const name = error?.name;
    if (name === 'AbortError' || name === 'TimeoutError') {
      throw new HttpError(504, `模型调用超时（${Math.round(timeoutMs / 1000)} 秒）：${provider} / ${model} 没有在限定时间内返回文本。`);
    }
    /* 不同失败要有不同的话：作者看到「502 调用失败」不知道该等、该换模型、还是该修凭据。 */
    const status = Number(error?.status || error?.code || 0);
    const raw = error instanceof Error ? error.message : String(error);
    if (status === 429) {
      const wait = Number(error?.providerRetryAfterMs || 0);
      const hint = wait > 0 ? `建议 ${Math.ceil(wait / 1000)} 秒后再试` : '稍等一会儿再试';
      throw new HttpError(429, `模型通道限流（${provider} / ${model}）：${hint}。原始信息：${raw}`);
    }
    if (status === 401 || status === 403) {
      throw new HttpError(502, `模型凭据被拒绝（${provider} / ${model}）：请到 DSH 设置里检查这条通道的 API Key。原始信息：${raw}`);
    }
    if (status === 400) {
      throw new HttpError(502, `请求被模型通道拒绝（${provider} / ${model}）：可能是上下文超长或参数不被支持。原始信息：${raw}`);
    }
    throw new HttpError(502, `模型调用失败（${provider} / ${model}）：${raw}`);
  }
  const value = text.trim();
  if (!value) {
    throw new HttpError(502, `模型没有返回任何文本（${provider} / ${model}，结束原因：${finishReason || '未知'}）。请稍后重试，或在 DSH 设置里确认该模型通道可用。`);
  }
  return value;
}

/* ------------------------------------------------------------------ 产物解析 */

/** 从模型输出里抠出一个 JSON 数组（容忍 ```json 代码块与前后废话）。 */
function extractJsonArray(text) {
  const cleaned = String(text ?? '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  const parse = (value) => {
    try {
      const data = JSON.parse(value);
      return Array.isArray(data) ? data : null;
    } catch {
      return null;
    }
  };
  const direct = parse(cleaned);
  if (direct) return direct;
  const start = cleaned.indexOf('[');
  const end = cleaned.lastIndexOf(']');
  if (start >= 0 && end > start) return parse(cleaned.slice(start, end + 1));
  return null;
}

const isAnnotationCandidate = (item) => Boolean(
  item
  && typeof item === 'object'
  && typeof item.quote === 'string' && item.quote.trim()
  && typeof item.comment === 'string' && item.comment.trim(),
);

/**
 * 批注模式：复用 review.js 的 `parseReviewAnnotations`（内部用 `locateQuote` 逐字锚定）。
 * `parseReviewAnnotations` 单次最多处理 8 条，这里按 8 条一批喂进去，
 * 这样设置里的 `maxAnnotations` 上限 20 也能如实生效，且没有重写锚定逻辑。
 * @returns {{annotations:object[], dropped:number}}
 */
export function anchorAnnotations(text, input, max) {
  const raw = extractJsonArray(text);
  if (!raw) throw new HttpError(502, '模型返回的内容不是有效的批注 JSON，请重新运行这张任务卡。');
  const limit = Math.min(Math.max(1, Number(max) || 8), MAX_ANNOTATIONS);
  const candidates = raw.filter(isAnnotationCandidate).slice(0, limit);
  const annotations = [];
  for (let offset = 0; offset < candidates.length; offset += 8) {
    const chunk = JSON.stringify(candidates.slice(offset, offset + 8));
    try {
      annotations.push(...review.parseReviewAnnotations(chunk, input));
    } catch (error) {
      throw new HttpError(502, error instanceof Error ? error.message : '模型返回的批注无法解析。');
    }
  }
  /* dropped = 模型给了多少 - 最终收录多少。以前只算「锚定失败」，
     于是超过条数上限被截断的、字段不合法被丢的都不计入，作者以为其余全部收录了。 */
  const dropped = Math.max(0, raw.length - annotations.length);
  return { annotations, dropped };
}

/** 记忆模式：`[{title,content,category}]`。 */
function parseMemories(text) {
  const raw = extractJsonArray(text);
  if (!raw) throw new HttpError(502, '模型返回的内容不是有效的记忆 JSON，请重新运行这张任务卡。');
  const candidates = raw.slice(0, MEMORY_LIMIT);
  const memories = [];
  for (const item of candidates) {
    if (
      !item || typeof item !== 'object'
      || typeof item.title !== 'string' || !item.title.trim()
      || typeof item.content !== 'string' || !item.content.trim()
    ) continue;
    memories.push({
      title: item.title.trim().slice(0, 60),
      content: item.content.trim(),
      category: typeof item.category === 'string' && item.category.trim() ? item.category.trim() : '设定',
    });
  }
  const dropped = Math.max(0, raw.length - memories.length);
  return { memories, dropped };
}

/* ------------------------------------------------------------------ 主流程 */

/**
 * 跑一张任务卡。
 * @param {any} ctx cordis 上下文（`ctx.get('llm')`）
 * @param {any} body 请求体
 */
export async function runRecipe(ctx, body = {}, signal) {
  const recipeId = typeof body.recipeId === 'string' ? body.recipeId.trim() : '';
  if (!recipeId) throw new HttpError(400, '缺少 recipeId（要跑哪张任务卡）。');
  const recipe = findRecipe(recipeId);

  // 1) 先挡住"要正文"的指令——命中直接 400，不调模型。
  let instruction = guardInstruction(body.instruction);
  if (!instruction) instruction = recipe.defaultInstruction || '';
  if (recipe.needsInstruction && !instruction) {
    throw new HttpError(400, '这张任务卡需要填写指令：想让它检查或整理什么？');
  }

  let maxAnnotations = null;
  if (body.maxAnnotations !== undefined && body.maxAnnotations !== null) {
    const value = Number(body.maxAnnotations);
    if (!Number.isInteger(value) || value < 1 || value > MAX_ANNOTATIONS) {
      throw new HttpError(400, `maxAnnotations 必须是 1 ~ ${MAX_ANNOTATIONS} 的整数。`);
    }
    maxAnnotations = value;
  }

  const { novelDir } = store.projectContext();
  const settings = readSettings();
  const assembled = await assembleContext({
    novelDir,
    settings,
    recipe,
    targetPath: body.targetPath,
    contextIds: body.contextIds,
  });

  const document = assembled.document;
  if (recipe.mode === 'review' && (!document || !document.content.trim())) {
    throw new HttpError(400, '章节体检需要先选一章正文（targetPath）。');
  }

  // 2) 模型不可用：503 + 真实原因（与 /status 同一套口径）。
  const status = review.describeStatus(ctx, settings);
  if (!status.available) throw new HttpError(503, status.message);
  const llm = ctx.get('llm');

  const request = buildRequest(recipe.mode, {
    instruction,
    maxAnnotations: maxAnnotations ?? settings.maxAnnotations,
    allowRewriteSuggestion: Boolean(settings.allowRewriteSuggestion),
    subjectName: document?.title || '',
    targetTitle: document?.title || '',
    dossierKind: recipe.dossierKind,
    context: {
      document,
      documents: assembled.documents,
      memories: assembled.memories,
      budget: assembled.budget,
    },
  });

  const task = {
    id: randomUUID(),
    type: 'ai',
    title: `${recipe.title}${document ? ` · ${document.title}` : ''}`.slice(0, 200),
    status: 'running',
    createdAt: new Date().toISOString(),
    sources: assembled.sources,
    mode: recipe.mode,
    recipeId: recipe.id,
    summary: '',
  };

  const startedAt = Date.now();
  try {
    const text = await streamText(llm, {
      signal,
      provider: settings.provider,
      model: settings.model,
      system: request.system,
      prompt: request.prompt,
      timeoutMs: AI_TIMEOUT_MS,
    });
    const elapsedMs = Date.now() - startedAt;

    let payload;
    if (request.output === 'annotations') {
      const anchored = anchorAnnotations(text, { documentPath: document.path, content: document.content }, maxAnnotations ?? settings.maxAnnotations);
      payload = { annotations: anchored.annotations, dropped: anchored.dropped };
      task.summary = `生成 ${anchored.annotations.length} 条可定位批注（丢弃 ${anchored.dropped} 条无法锚定的）`;
    } else if (request.output === 'memory') {
      const parsed = parseMemories(text);
      payload = { memories: parsed.memories, dropped: parsed.dropped };
      task.summary = `提取 ${parsed.memories.length} 条记忆（${settings.provider} / ${settings.model}）`;
    } else {
      payload = { text, dropped: 0 };
      task.summary = `生成 ${text.length} 字报告（${settings.provider} / ${settings.model}）`;
    }

    task.status = 'completed';
    task.elapsedMs = elapsedMs;
    await store.appendTask(novelDir, task);

    return {
      ok: true,
      taskId: task.id,
      recipeId: recipe.id,
      mode: recipe.mode,
      output: request.output,
      ...payload,
      elapsedMs,
    };
  } catch (error) {
    task.status = 'failed';
    task.summary = error instanceof Error ? `${recipe.title} 失败：${error.message}` : `${recipe.title} 失败`;
    task.elapsedMs = Date.now() - startedAt;
    await store.appendTask(novelDir, task).catch(() => {});
    throw error;
  }
}
