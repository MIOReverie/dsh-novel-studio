/**
 * 墨枢 Host 半：HTTP 原语（响应、请求体、参数校验）。
 *
 * 这里只放「与业务无关」的东西，`api.js`（端点实现）与 `routes.js`（路由表 + dispatch）
 * 共用同一份，避免两处各写一套 `sendJson` 之后状态码 / 响应头漂移。
 *
 * 约定（与 v3 之前完全一致）：
 * - 统一 JSON 响应 + `Content-Type: application/json; charset=utf-8` + `Cache-Control: no-store`
 * - 失败统一 4xx/5xx + `{ error: '中文原因' }`
 * - 请求体上限 16 MB
 */
import { HttpError } from './errors.js';

/** 请求体上限：16 MB。 */
export const MAX_BODY_BYTES = 16 * 1024 * 1024;

/** 写 JSON 响应（已经结束时不再重复写）。 */
export function sendJson(res, status, payload) {
  if (res.writableEnded) return;
  const body = JSON.stringify(payload);
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Length', Buffer.byteLength(body));
  res.end(body);
}

/** 把任意异常翻译成给作者看的中文文案（5xx 才带前缀，4xx 保持原样）。 */
export function messageOf(error, status) {
  if (error instanceof HttpError && error.message) return error.message;
  if (error instanceof Error && error.message) {
    return status >= 500 ? `服务器处理失败：${error.message}` : error.message;
  }
  return '服务器处理失败，请稍后重试。';
}

/** 读取请求体；超过上限时继续排空连接但不再累积内存。 */
export function readBody(req, limit = MAX_BODY_BYTES) {
  return new Promise((resolve, reject) => {
    const declared = Number(req.headers?.['content-length']);
    const chunks = [];
    let size = 0;
    let overflowed = Number.isFinite(declared) && declared > limit;
    let settled = false;
    const done = (handler, value) => {
      if (settled) return;
      settled = true;
      handler(value);
    };
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        overflowed = true;
        chunks.length = 0;
        return;
      }
      if (!overflowed) chunks.push(chunk);
    });
    req.on('end', () => {
      if (overflowed) done(reject, new HttpError(413, `请求体过大，上限 ${Math.round(limit / 1024 / 1024)} MB。`));
      else done(resolve, Buffer.concat(chunks));
    });
    req.on('error', (error) => done(reject, new HttpError(400, `读取请求体失败：${error instanceof Error ? error.message : String(error)}`)));
    req.on('aborted', () => done(reject, new HttpError(400, '请求被中断。')));
  });
}

/** 解析 JSON 对象请求体（空体视为 `{}`，非对象 / 坏 JSON 一律 400）。 */
export async function readJsonBody(req) {
  const buffer = await readBody(req);
  const text = buffer.toString('utf8').trim();
  if (!text) return {};
  try {
    const data = JSON.parse(text);
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('not an object');
    return data;
  } catch {
    throw new HttpError(400, '请求体不是有效的 JSON 对象。');
  }
}

/** 必填字符串（去空白后 1 ~ max 字符）。 */
export function requireText(value, label, max) {
  if (typeof value !== 'string' || !value.trim() || value.length > max) {
    throw new HttpError(400, `请求缺少有效的 ${label}（1 ~ ${max} 字符的字符串）。`);
  }
  return value;
}

/** 必填数组。 */
export function requireArray(value, label) {
  if (!Array.isArray(value)) throw new HttpError(400, `${label} 必须是数组。`);
  return value;
}

/** 可选的字符串数组（截断到 max 条）。 */
export function optionalStringArray(value, max = 50) {
  return Array.isArray(value) ? value.filter((item) => typeof item === 'string').slice(0, max) : [];
}
