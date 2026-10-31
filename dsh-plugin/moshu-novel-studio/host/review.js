/**
 * 墨枢 Host 半：审阅相关的两件事 —— 模型状态与批注锚定。
 *
 * **提示词不在这里。** 所有 system / task prompt 一律来自 `prompts.js`（契约 v2 第 4 条），
 * `/ai/review` 与 `/ai/run` 走同一套 `buildRequest` + `assembleContext`。
 * 本模块只保留两件与提示词无关的事：
 * 1. `describeStatus` / `listProviderIds`：把 `ctx.llm` 翻译成「模型能不能用」；
 * 2. `parseReviewAnnotations` / `locateQuote`：把模型给的 quote 逐字锚定回正文，
 *    锚不上的直接丢弃 —— 宁可少几条，也绝不给出无法定位的批注。
 */
import { randomUUID } from 'node:crypto';

function extractJson(text) {
  const cleaned = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  try {
    return JSON.parse(cleaned);
  } catch {
    const start = cleaned.indexOf('[');
    const end = cleaned.lastIndexOf(']');
    if (start >= 0 && end > start) return JSON.parse(cleaned.slice(start, end + 1));
    throw new Error('模型返回的内容不是有效的批注 JSON，请重新审阅。');
  }
}

/** 引用比对时的句末标点/引号/空白（与旧后端同一集合）。 */
const TRAILING_NOISE = /[。！？!?，,、；;：:…—\s"'\u201C\u201D\u2018\u2019」』]+$/;

/**
 * 在正文里定位模型引用的原句，容忍句末标点与空白差异（逐字沿用旧后端）：
 * 1. 直接 indexOf；2. 去掉尾部标点再找；3. 取前 24 字头部再找；4. 去掉所有空白后比对。
 * @returns {{start:number,end:number}|undefined}
 */
export function locateQuote(content, quote) {
  const direct = content.indexOf(quote);
  if (direct >= 0) return { start: direct, end: direct + quote.length };
  const trimmed = quote.replace(TRAILING_NOISE, '').trim();
  if (trimmed.length >= 6) {
    const found = content.indexOf(trimmed);
    if (found >= 0) return { start: found, end: found + trimmed.length };
  }
  const head = trimmed.slice(0, Math.min(24, trimmed.length));
  if (head.length >= 8) {
    const found = content.indexOf(head);
    if (found >= 0) return { start: found, end: found + head.length };
  }
  const normalized = [];
  let compact = '';
  for (let index = 0; index < content.length; index += 1) {
    const char = content[index];
    if (/\s/.test(char)) continue;
    compact += char;
    normalized.push(index);
  }
  const compactQuote = quote.replace(/\s+/g, '');
  const hit = compact.indexOf(compactQuote);
  if (hit >= 0 && compactQuote.length >= 6) {
    const start = normalized[hit];
    const last = normalized[hit + compactQuote.length - 1];
    return { start, end: last + 1 };
  }
  return undefined;
}

const CATEGORIES = new Set(['情节', '逻辑', '设定', '人物', '语言']);
const LEVELS = new Set(['建议', '注意', '严重']);

/**
 * 把模型输出解析成可定位批注；锚定不上正文的一律丢弃。
 * @param {string} text 模型返回的原始文本
 * @param {{documentPath:string,content:string}} input
 */
export function parseReviewAnnotations(text, input) {
  const data = extractJson(text);
  if (!Array.isArray(data)) throw new Error('模型返回格式不正确：批注必须是数组。');
  return data.slice(0, 8).flatMap((raw) => {
    if (!raw || typeof raw !== 'object') return [];
    if (typeof raw.quote !== 'string' || typeof raw.comment !== 'string' || !raw.quote.trim() || !raw.comment.trim()) return [];
    const position = locateQuote(input.content, raw.quote.trim());
    if (!position) return [];
    const quote = input.content.slice(position.start, position.end);
    return [{
      id: randomUUID(),
      documentPath: input.documentPath,
      quote,
      start: position.start,
      end: position.end,
      prefix: input.content.slice(Math.max(0, position.start - 40), position.start),
      suffix: input.content.slice(position.end, position.end + 40),
      type: CATEGORIES.has(raw.type) ? raw.type : '情节',
      severity: LEVELS.has(raw.severity) ? raw.severity : '建议',
      comment: raw.comment.trim(),
      suggestion: typeof raw.suggestion === 'string' ? raw.suggestion.trim() : '',
      status: 'open',
      source: 'dsh',
      createdAt: new Date().toISOString(),
    }];
  });
}

/** 宿主 llm 服务当前注册的模型通道 id。 */
export function listProviderIds(llm) {
  try {
    if (!llm || typeof llm.listProviders !== 'function') return [];
    const providers = llm.listProviders();
    if (!Array.isArray(providers)) return [];
    return providers
      .map((entry) => (typeof entry === 'string' ? entry : entry && typeof entry.id === 'string' ? entry.id : ''))
      .filter(Boolean);
  } catch {
    return [];
  }
}

/**
 * 由 `ctx.llm` 推导的模型状态（契约里的 dsh 字段 / GET /status）。
 * @param {any} ctx cordis 上下文
 * @param {{provider:string,model:string}} settings
 * @returns {{available:boolean,status:'available'|'unavailable',provider:string,model:string,message:string}}
 */
export function describeStatus(ctx, settings) {
  const provider = settings.provider;
  const model = settings.model;
  const base = { provider, model };
  const llm = typeof ctx?.get === 'function' ? ctx.get('llm') : undefined;
  if (!llm || typeof llm.stream !== 'function') {
    return {
      available: false,
      status: 'unavailable',
      ...base,
      message: '当前 DSH 进程没有提供可用的 llm 服务，AI 审阅不可用。请确认宿主加载了模型插件（例如 @deepseek-ai/dsh-llm-pi-ai）后再打开墨枢。',
    };
  }
  const ids = listProviderIds(llm);
  if (ids.length > 0 && !ids.includes(provider)) {
    return {
      available: false,
      status: 'unavailable',
      ...base,
      message: `llm 服务已就绪，但没有注册名为「${provider}」的模型通道。当前可用通道：${ids.join('、')}。可在 .moshu/settings.json 里用 provider / model 覆盖默认值。`,
    };
  }
  return {
    available: true,
    status: 'available',
    ...base,
    message: ids.length === 0
      ? `llm 服务已就绪（宿主暂时没有注册任何模型通道），将按 ${provider} / ${model} 调用。`
      : `DSH 内置模型通道 ${provider} / ${model} 可用。`,
  };
}

/* ------------------------------------------------------------------ *
 * 说明：本文件不再有 `REVIEW_SYSTEM` / `buildReviewPrompt` / `completeText` /
 * `reviewDocument`。审阅的提示词与模型调用统一由 `prompts.buildRequest('review', …)`
 * 与 `ai.streamText` 负责（`/ai/review` 与 `/ai/run` 同一条路径）；
 * 这四个导出已确认在 host/** 与 client.js 里都没有别的引用，因此删除而不是留成死代码。
 * ------------------------------------------------------------------ */
