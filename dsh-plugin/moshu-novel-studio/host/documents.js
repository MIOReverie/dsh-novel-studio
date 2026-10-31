/**
 * 墨枢 Host 半：文档管理（重命名 / 删除 / 上下移动）。
 *
 * 三条硬规则：
 * - 所有路径都先过 `store.resolveMarkdown`（拒绝 `../`、绝对路径、非 .md、符号链接）；
 * - 删除一律移进 `<作品>/.trash/<时间戳>/<原相对路径>`，**永不物理删除**；
 * - 章节上下移动交换的是**序号前缀**（`chapter-NNN[-标题].md` 里的 NNN），
 *   正文一个字节都不动；每一跳都是 rename，中途失败逆序回滚。
 */
import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { HttpError } from './errors.js';
import * as store from './store.js';
import { readArray, withPathLock, writeArray } from './jsonstore.js';

async function exists(file) {
  try {
    await fs.access(file);
    return true;
  } catch {
    return false;
  }
}

function fileAt(root, relative) {
  return path.join(root, ...relative.split('/'));
}

/** 时间戳：`2026-10-30T09-12-33-123Z`。 */
function stamp() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

/**
 * 重命名 / 移动文档（`to` 是完整的项目内相对路径）。
 * 旧文件先备份再 rename，rename 本身是原子的。
 */
export async function renameDocument(body) {
  const { novelDir } = store.projectContext();
  return renameIn(novelDir, body.from, body.to);
}

/**
 * 按**作品根**重命名（AI 工具也走这里，避免第二套实现）。
 * @param {string} novelDir 作品目录
 * @param {string} rawFrom 原相对路径
 * @param {string} rawTo 新相对路径
 */
export async function renameIn(novelDir, rawFrom, rawTo) {
  const from = store.resolveMarkdown(novelDir, rawFrom).relative;
  const to = store.resolveMarkdown(novelDir, rawTo).relative;
  if (from === to) return { ok: true, path: to };
  /* 两把锁都要拿：只锁 from 的话，飞行中的保存会把 from 重新创建出来，
     改名后于是同时存在「新名 + 旧名」两份章节。 */
  return withPathLock(`doc:${novelDir}|${from}`, () =>
    withPathLock(`doc:${novelDir}|${to}`, () => renameDocumentUnlocked(novelDir, from, to)));
}

async function renameDocumentUnlocked(novelDir, from, to) {
  const fromFile = fileAt(novelDir, from);
  const targetFile = fileAt(novelDir, to);
  if (!(await exists(fromFile))) throw new HttpError(404, '要重命名的文档不存在。');
  if (await exists(targetFile)) throw new HttpError(409, `目标路径「${to}」已经有一个文档了。`);

  await store.snapshotBackup(novelDir, from);
  await fs.mkdir(path.dirname(targetFile), { recursive: true });
  await store.renameWithRetry(fromFile, targetFile);
  const migrated = await migrateAnnotations(novelDir, from, to);
  return { ok: true, path: to, annotations: migrated.changed };
}

/** 删除文档：移进 `<作品>/.trash/<时间戳>/<原相对路径>`。 */
export async function deleteDocument(body) {
  const { novelDir } = store.projectContext();
  return deleteIn(novelDir, body.path);
}

/** 按**作品根**删除（移进 `.trash/<时间戳>/<原相对路径>`）。 */
export async function deleteIn(novelDir, rawPath) {
  const { relative } = store.resolveMarkdown(novelDir, rawPath);
  return withPathLock(`doc:${novelDir}|${relative}`, () => deleteDocumentUnlocked(novelDir, relative));
}

async function deleteDocumentUnlocked(novelDir, relative) {
  const file = fileAt(novelDir, relative);
  if (!(await exists(file))) throw new HttpError(404, '要删除的文档不存在。');

  const folder = stamp();
  const trashedRelative = path.posix.join('.trash', folder, relative);
  const target = fileAt(novelDir, trashedRelative);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await store.renameWithRetry(file, target);
  const migrated = await migrateAnnotations(novelDir, relative, null);
  return { ok: true, path: trashedRelative, annotations: migrated.changed };
}

/**
 * 章节文件名：`chapter-<序号>` + 可选的 `-<标题 slug>` + `.md`。
 * 改名后的章节是 `chapter-003-初遇.md`，上下移动必须照样认。
 */
const CHAPTER_NAME = /^(chapter-(\d+))(-[^/\\]+)?\.md$/;

/** 由「序号前缀 + 标题后缀」拼回文件名。 */
function chapterName(prefix, suffix) {
  return suffix ? `chapter-${prefix}-${suffix}.md` : `chapter-${prefix}.md`;
}

/**
 * 章节目录下的章节文件清单（按序号升序，同号再按文件名）。
 * @returns {Promise<Array<{name:string,number:number,prefix:string,suffix:string}>>}
 */
async function chapterFiles(novelDir) {
  const directory = path.join(novelDir, 'chapters');
  let names = [];
  try {
    names = await fs.readdir(directory);
  } catch (error) {
    if (error?.code === 'ENOENT') return [];
    throw error;
  }
  const chapters = [];
  for (const name of names) {
    const matched = CHAPTER_NAME.exec(name);
    if (!matched) continue;
    chapters.push({
      name,
      number: Number(matched[2]),
      prefix: matched[2],
      suffix: matched[3] ? matched[3].slice(1) : '',
    });
  }
  chapters.sort((left, right) => left.number - right.number || left.name.localeCompare(right.name));
  return chapters;
}

/**
 * 上移 / 下移一章：交换相邻两章的**序号前缀**（各自标题后缀原地保留），文件内容一个字节都不动。
 *
 * 为什么是改名而不是改内容：改名才是作者的心智模型（"这一章挪到前面去"），
 * 改内容会让备份、批注锚点、`annotations.json` 里的 documentPath 全部错位。
 *
 * 冲突：交换后要落到的文件名已经存在（既不是这两章之一）→ 409，两个文件保持原样。
 * 原子性：每一跳都是一次 rename；中途失败按已完成步骤逆序回滚。
 * 纯交换（两章标题后缀相同，目标名正好是对方的名字）时多用一个临时名中转，
 * 因为 Windows 不允许 rename 覆盖已存在的文件。
 */
export async function moveDocument(body) {
  const { novelDir } = store.projectContext();
  return moveIn(novelDir, body.path, body.direction);
}

/** 按**作品根**上移/下移一章（交换序号前缀，正文一个字节不动）。 */
export async function moveIn(novelDir, rawPath, rawDirection) {
  const { relative } = store.resolveMarkdown(novelDir, rawPath);
  const parts = relative.split('/');
  const matched = parts.length === 2 && parts[0] === 'chapters' ? CHAPTER_NAME.exec(parts[1]) : null;
  if (!matched) throw new HttpError(400, '只有 chapters/chapter-NNN.md（或 chapter-NNN-标题.md）形式的章节可以上下移动。');
  const direction = rawDirection;
  if (direction !== 'up' && direction !== 'down') {
    throw new HttpError(400, 'direction 只能是 "up" 或 "down"。');
  }

  const chapters = await chapterFiles(novelDir);
  const index = chapters.findIndex((chapter) => chapter.name === parts[1]);
  if (index < 0) throw new HttpError(404, '这一章不在 chapters/ 里，无法移动。');
  const neighborIndex = direction === 'up' ? index - 1 : index + 1;
  if (neighborIndex < 0) throw new HttpError(400, '这已经是第一章，无法上移。');
  if (neighborIndex >= chapters.length) throw new HttpError(400, '这已经是最后一章，无法下移。');

  const current = chapters[index];
  const neighbor = chapters[neighborIndex];
  const targetCurrent = chapterName(neighbor.prefix, current.suffix);
  const targetNeighbor = chapterName(current.prefix, neighbor.suffix);

  const directory = path.join(novelDir, 'chapters');
  const currentFile = path.join(directory, current.name);
  const neighborFile = path.join(directory, neighbor.name);
  const targetCurrentFile = path.join(directory, targetCurrent);
  const targetNeighborFile = path.join(directory, targetNeighbor);

  // 目标名已被第三份文件占用 → 409，两个文件都不动。
  for (const [file, name] of [[targetCurrentFile, targetCurrent], [targetNeighborFile, targetNeighbor]]) {
    if (file === currentFile || file === neighborFile) continue;
    if (await exists(file)) throw new HttpError(409, `目标文件名「chapters/${name}」已经存在，无法交换序号。`);
  }

  /**
   * 纯交换：两个目标名正好是对方现在的名字（两章标题后缀相同，例如都是 chapter-002.md /
   * chapter-003.md）。这时必须先改名到临时文件，否则第一次 rename 就撞上已存在的对方。
   */
  const pureSwap = targetCurrentFile === neighborFile && targetNeighborFile === currentFile;
  const tempFile = path.join(directory, `.swap-${randomUUID()}.tmp`);
  const steps = pureSwap
    ? [[currentFile, tempFile], [neighborFile, targetNeighborFile], [tempFile, targetCurrentFile]]
    : [[currentFile, targetCurrentFile], [neighborFile, targetNeighborFile]];

  const pending = steps.filter(([from, to]) => from !== to);
  const done = [];
  try {
    for (const [from, to] of pending) {
      await store.renameWithRetry(from, to);
      done.push([from, to]);
    }
  } catch (error) {
    for (const [from, to] of done.reverse()) {
      await store.renameWithRetry(to, from).catch(() => {});
    }
    throw error;
  }

  const after = await chapterFiles(novelDir);
  const wanted = new Set([targetCurrent, targetNeighbor]);
  return { ok: true, paths: after.filter((chapter) => wanted.has(chapter.name)).map((chapter) => `chapters/${chapter.name}`) };
}

/**
 * 列出作品内 `.trash/` 里被删掉的文档。
 *
 * 以前删除只进 `.trash`，没有任何接口能读回来——作者只能去资源管理器里翻。
 * 结构：`<作品>/.trash/<时间戳>/<原相对路径>`。
 */
export async function listDocumentTrash() {
  const { novelDir } = store.projectContext();
  const root = path.join(novelDir, '.trash');
  let stamps = [];
  try {
    stamps = (await fs.readdir(root, { withFileTypes: true })).filter((entry) => entry.isDirectory());
  } catch (error) {
    if (error?.code === 'ENOENT') return { entries: [] };
    throw error;
  }
  const entries = [];
  for (const stampEntry of stamps) {
    const stampDir = path.join(root, stampEntry.name);
    const collected = await walkTrash(stampDir, stampEntry.name);
    entries.push(...collected);
  }
  entries.sort((left, right) => String(right.trashedAt).localeCompare(String(left.trashedAt)));
  return { entries };
}

/** 递归收集 `<stamp>/<相对路径>` 下的所有 .md。 */
async function walkTrash(directory, stamp, prefix = '') {
  const found = [];
  let list = [];
  try {
    list = await fs.readdir(directory, { withFileTypes: true });
  } catch {
    return found;
  }
  for (const entry of list) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      found.push(...await walkTrash(full, stamp, relative));
      continue;
    }
    if (!/\.md$/i.test(entry.name)) continue;
    const stat = await fs.stat(full).catch(() => null);
    found.push({
      id: `${stamp}/${relative}`,
      path: relative,
      trashedAt: stamp,
      bytes: stat ? stat.size : 0,
    });
  }
  return found;
}

/** 从回收站恢复一篇文档；目标已存在则 409，绝不覆盖。 */
export async function restoreDocumentFromTrash(body) {
  const { novelDir } = store.projectContext();
  const id = typeof body?.id === 'string' ? body.id.trim() : '';
  if (!id || id.includes('..') || id.includes('\\') || id.startsWith('.') || id.includes(':')) {
    throw new HttpError(400, '回收站条目无效。');
  }
  const [stamp, ...rest] = id.split('/');
  if (!stamp || !rest.length) throw new HttpError(400, '回收站条目无效。');
  const source = path.join(novelDir, '.trash', stamp, ...rest);
  const { resolved, relative } = store.resolveMarkdown(novelDir, rest.join('/'));
  if (!(await exists(source))) throw new HttpError(404, '回收站里没有这一条。');
  return withPathLock(`doc:${novelDir}|${relative}`, async () => {
    if (await exists(resolved)) {
      throw new HttpError(409, `「${relative}」已经有同名文档了，请先改名或删除它再恢复。`);
    }
    await fs.mkdir(path.dirname(resolved), { recursive: true });
    await store.renameWithRetry(source, resolved);
    const migrated = await migrateAnnotations(novelDir, relative, relative);
    return { ok: true, path: relative, annotations: migrated.changed };
  });
}

/**
 * 把批注的 `documentPath` 跟着文档走。
 *
 * 以前改名/删除只动文件：批注仍锚在旧路径上 → 变成孤儿（界面看不到），
 * 而如果之后又建了同名文档，旧批注会「复活」并锚到新正文上，`start/end` 全错。
 *
 * @param {string} novelDir 作品目录
 * @param {string} from 旧相对路径
 * @param {string|null} to 新相对路径；null 表示文档被删（批注标记 stale，等恢复时再绑回）
 */
async function migrateAnnotations(novelDir, from, to) {
  try {
    const list = await readArray(novelDir, 'annotations.json', []);
    if (!Array.isArray(list) || !list.length) return { changed: 0 };
    let changed = 0;
    const next = list.map((item) => {
      if (!item || item.documentPath !== from) return item;
      changed += 1;
      if (to) return { ...item, documentPath: to, status: item.status === 'stale' ? 'open' : item.status };
      /* 文档进了回收站：标 stale 而不是删除，恢复同名文档时还能绑回来。 */
      return item.status === 'stale' ? item : { ...item, status: 'stale' };
    });
    if (changed) await writeArray(novelDir, 'annotations.json', next);
    return { changed };
  } catch (error) {
    /* 批注迁移失败不能挡住改名/删除本身：先保证文件操作成功，再记一条。 */
    return { changed: 0, error: error instanceof Error ? error.message : String(error) };
  }
}
