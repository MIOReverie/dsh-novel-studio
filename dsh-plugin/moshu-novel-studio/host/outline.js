/**
 * 墨枢 · 故事大纲（数据层，唯一真相）。
 *
 * 以前"章纲"是散在 `outline/*.md` 里的 front matter：
 *   - 卷/章/节拍/状态全靠正则从 YAML 头里抠，一改格式就失效；
 *   - 前端只能整体覆盖写回，容易把元数据叠三层；
 *   - 没有任何校验，"第 3 章的卷号写错了"这类问题没人管。
 *
 * 现在改为结构化存储 `<作品>/outline.json`：
 *   { version: 1, volumes: [...], chapters: [...] }
 * 老的 outline/*.md 只在**第一次**读的时候导入一次（文件本身不删不改）。
 */
import path from 'node:path';
import { promises as fs, existsSync } from 'node:fs';
import { HttpError } from './errors.js';
import * as jsonstore from './jsonstore.js';

const FILE = 'outline.json';
const MAX_VOLUMES = 60;
const MAX_CHAPTERS = 600;
const STATUSES = ['idea', 'draft', 'done'];
const BEATS = ['setup', 'turn', 'climax', 'resolution', 'other'];
const ARCS = ['main', 'sub', 'hidden'];

function text(value, max) {
  return String(value === undefined || value === null ? '' : value).slice(0, max);
}

function pick(value, allowed, fallback) {
  const key = text(value, 20).trim();
  return allowed.indexOf(key) >= 0 ? key : fallback;
}

/** 空文档。 */
export function emptyOutline() {
  return { version: 1, volumes: [], chapters: [] };
}

/** 归一化：保证前端拿到的一定是完整结构。 */
export function normalizeOutline(raw) {
  const source = raw && typeof raw === 'object' ? raw : {};
  const volumes = (Array.isArray(source.volumes) ? source.volumes : []).slice(0, MAX_VOLUMES).map((item, index) => ({
    id: text(item?.id, 40) || `v${index + 1}`,
    number: Number.isFinite(Number(item?.number)) ? Number(item.number) : index + 1,
    title: text(item?.title, 80),
    goal: text(item?.goal, 600),
    conflict: text(item?.conflict, 600),
    turn: text(item?.turn, 600),
  }));
  const volumeIds = new Set(volumes.map((item) => item.id));
  const chapters = (Array.isArray(source.chapters) ? source.chapters : []).slice(0, MAX_CHAPTERS).map((item, index) => ({
    id: text(item?.id, 40) || `c${index + 1}`,
    number: Number.isFinite(Number(item?.number)) ? Number(item.number) : index + 1,
    volumeId: volumeIds.has(text(item?.volumeId, 40)) ? text(item?.volumeId, 40) : (volumes[0]?.id || ''),
    title: text(item?.title, 80),
    goal: text(item?.goal, 800),
    conflict: text(item?.conflict, 800),
    scenes: text(item?.scenes, 1200),
    hook: text(item?.hook, 400),
    beat: pick(item?.beat, BEATS, 'other'),
    arc: pick(item?.arc, ARCS, 'main'),
    status: pick(item?.status, STATUSES, 'idea'),
    chapterPath: text(item?.chapterPath, 200),
  }));
  return { version: 1, volumes, chapters };
}

/** 校验（写盘前跑）。 */
export function validateOutline(doc) {
  const next = normalizeOutline(doc);
  const volumeIds = new Set();
  for (const volume of next.volumes) {
    if (volumeIds.has(volume.id)) throw new HttpError(400, `卷 id 重复：${volume.id}`);
    volumeIds.add(volume.id);
  }
  const chapterIds = new Set();
  const numbers = new Set();
  for (const chapter of next.chapters) {
    if (chapterIds.has(chapter.id)) throw new HttpError(400, `章 id 重复：${chapter.id}`);
    chapterIds.add(chapter.id);
    if (numbers.has(chapter.number)) throw new HttpError(400, `章号重复：${chapter.number}`);
    numbers.add(chapter.number);
    if (!chapter.volumeId) throw new HttpError(400, `第 ${chapter.number} 章没有归属的卷。`);
  }
  return next;
}

/**
 * 从老的 outline/*.md 导入（只在 outline.json 不存在时跑一次）。
 * 只读老文件，不删除、不修改。
 */
async function importLegacy(root) {
  const dir = path.join(root, 'outline');
  let files = [];
  try {
    files = (await fs.readdir(dir)).filter((name) => name.toLowerCase().endsWith('.md'));
  } catch {
    return emptyOutline();
  }
  const meta = (content, key) => {
    const block = (String(content).match(/^---\r?\n([\s\S]*?)\r?\n---/) || [])[1] || '';
    const found = block.match(new RegExp(`^${key}:\\s*["']?([^\\r\\n"']*)`, 'm'));
    return found ? found[1].trim() : '';
  };
  const body = (content) => String(content)
    .replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, '')
    .replace(/^#\s+.*\r?\n/, '')
    .trim();

  const volumes = [];
  const chapters = [];
  for (const name of files) {
    const full = path.join(dir, name);
    const content = await fs.readFile(full, 'utf8').catch(() => '');
    if (!content) continue;
    const volumeNumber = Number(meta(content, 'volume'));
    const chapterNumber = Number(meta(content, 'chapter'));
    if (chapterNumber) {
      chapters.push({
        id: `c${chapterNumber}`,
        number: chapterNumber,
        volumeId: volumeNumber ? `v${volumeNumber}` : '',
        title: meta(content, 'title') || '',
        goal: body(content),
        conflict: '',
        scenes: '',
        hook: '',
        beat: meta(content, 'beat') === '铺垫' ? 'setup' : meta(content, 'beat') === '转折' ? 'turn' : 'other',
        arc: meta(content, 'arc') === '支线' ? 'sub' : meta(content, 'arc') === '暗线' ? 'hidden' : 'main',
        status: meta(content, 'status') === '已完成' ? 'done' : meta(content, 'status') === '大纲中' ? 'draft' : 'idea',
        chapterPath: `chapters/chapter-${String(chapterNumber).padStart(3, '0')}.md`,
      });
    } else if (volumeNumber) {
      volumes.push({
        id: `v${volumeNumber}`,
        number: volumeNumber,
        title: body(content).split('\n')[0].replace(/^#+\s*/, '') || `第 ${volumeNumber} 卷`,
        goal: body(content),
        conflict: '',
        turn: '',
      });
    }
  }

  volumes.sort((a, b) => a.number - b.number);
  chapters.sort((a, b) => a.number - b.number);
  if (!volumes.length && chapters.length) {
    volumes.push({ id: 'v1', number: 1, title: '第 1 卷', goal: '', conflict: '', turn: '' });
  }
  return normalizeOutline({ volumes, chapters });
}

/** 读大纲：没有就建空文档（必要时从老 md 导入一次）。 */
export async function readOutline(root) {
  if (!existsSync(path.join(root, FILE))) {
    const imported = await importLegacy(root);
    await jsonstore.writeObject(root, FILE, imported).catch(() => null);
    return imported;
  }
  const data = await jsonstore.readObject(root, FILE, null).catch(() => null);
  return normalizeOutline(data || emptyOutline());
}

/** 整份写回（前端保存），带校验 + 串行锁。 */
export async function writeOutline(root, doc) {
  return jsonstore.withDocLock(root, FILE, async () => {
    const next = validateOutline(doc);
    await jsonstore.writeObject(root, FILE, next);
    return next;
  });
}

export const OUTLINE_CONST = { STATUSES, BEATS, ARCS };
