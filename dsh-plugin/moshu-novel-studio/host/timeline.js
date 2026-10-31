/**
 * 墨枢 · 时间线（Host 半）。
 *
 * 以前 `bootstrap` 里的时间线是**编出来的**：一章一条，日期写「故事进程 · N」，
 * 类型按章号轮换 —— 它不是书里的时间线，只是章节列表换了个样子。
 *
 * 现在事件由 AI 从正文里提取，落在 `<作品>/timeline.json`；
 * 这里只负责读写与校验，不做任何"猜测式补全"。
 */
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { HttpError } from './errors.js';
import * as jsonstore from './jsonstore.js';

const FILE = 'timeline.json';
const MAX_EVENTS = 400;
const TYPES = ['conflict', 'revelation', 'journey', 'dialogue', 'decision', 'other'];

function text(value, max) {
  return String(value === undefined || value === null ? '' : value).trim().slice(0, max);
}

/** 归一化一条事件（也兼容旧数据里缺字段的情况）。 */
/** 剧情网连线：{ target, kind }。target 指向另一条事件的 id。 */
function normalizeLinks(value) {
  const KINDS = ['cause', 'impact', 'foreshadow'];
  if (!Array.isArray(value)) return [];
  const out = [];
  for (const raw of value.slice(0, 24)) {
    if (!raw || typeof raw !== 'object') continue;
    const target = text(raw.target, 60);
    if (!target) continue;
    const kind = KINDS.indexOf(text(raw.kind, 20)) >= 0 ? text(raw.kind, 20) : 'cause';
    out.push({ target, kind });
  }
  return out;
}

export function normalizeEvent(raw, index) {
  const item = raw && typeof raw === 'object' ? raw : {};
  return {
    id: text(item.id, 60) || `evt-${index + 1}`,
    title: text(item.title, 120),
    date: text(item.date, 60),
    era: text(item.era, 60),
    description: text(item.description, 600),
    characters: Array.isArray(item.characters) ? item.characters.map((name) => text(name, 40)).filter(Boolean).slice(0, 12) : [],
    chapterId: text(item.chapterId, 120),
    chapterTitle: text(item.chapterTitle, 120),
    location: text(item.location, 80),
    type: TYPES.indexOf(text(item.type, 20)) >= 0 ? text(item.type, 20) : 'other',
    /* 剧情线：lane 是泳道 id，laneName 是显示名，thread 区分明线/暗线 */
    lane: text(item.lane, 40) || 'main',
    laneName: text(item.laneName, 40),
    thread: text(item.thread, 10) === 'dark' ? 'dark' : 'bright',
    links: normalizeLinks(item.links),
  };
}

/** 读全部事件。文件不存在就是空数组（不是错误）。 */
export async function readTimeline(root) {
  const list = await jsonstore.readArray(root, FILE, []);
  return (Array.isArray(list) ? list : []).map(normalizeEvent).filter((item) => item.title);
}

/** 覆写整条时间线（调用方已经算好最终列表）。 */
export async function writeTimeline(root, events) {
  const list = (Array.isArray(events) ? events : []).map(normalizeEvent).filter((item) => item.title);
  if (list.length > MAX_EVENTS) throw new HttpError(400, `时间线事件太多了（上限 ${MAX_EVENTS} 条）。`);
  const ids = new Set();
  for (const item of list) {
    if (ids.has(item.id)) throw new HttpError(400, `时间线里有重复的 id「${item.id}」。`);
    ids.add(item.id);
  }
  await jsonstore.writeArray(root, FILE, list);
  return list;
}

/** 单条增删改（AI 与界面都走这里）。 */
export async function mutateTimeline(root, action, payload) {
  return jsonstore.withDocLock(root, FILE, async () => {
    const current = await readTimeline(root);
    const list = current.slice();

    if (action === 'add') {
      const event = normalizeEvent({ ...payload, id: text(payload?.id, 60) || `evt-${Date.now().toString(36)}` }, list.length);
      if (!event.title) throw new HttpError(400, '事件要有 title。');
      list.push(event);
      await writeTimeline(root, list);
      return { event, total: list.length, added: true };
    }
    if (action === 'update') {
      const id = text(payload?.id, 60);
      const at = list.findIndex((item) => item.id === id);
      if (at < 0) throw new HttpError(404, `时间线里没有 id 为「${id}」的事件。`);
      list[at] = normalizeEvent({ ...list[at], ...payload, id }, at);
      await writeTimeline(root, list);
      return { event: list[at], total: list.length, updated: true };
    }
    if (action === 'remove') {
      const id = text(payload?.id, 60);
      const next = list.filter((item) => item.id !== id);
      if (next.length === list.length) throw new HttpError(404, `时间线里没有 id 为「${id}」的事件。`);
      await writeTimeline(root, next);
      return { removed: id, total: next.length };
    }
    throw new HttpError(400, 'action 只能是 add / update / remove。');
  });
}

/** 整条时间线是否存在（给界面判断"要不要提示 AI 提取"）。 */
export async function timelineExists(root) {
  try {
    await fs.access(path.join(root, FILE));
    return true;
  } catch {
    return false;
  }
}
