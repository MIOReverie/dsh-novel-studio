/**
 * 墨枢 Host 半：书籍管理（切换 / 新建 / 改名 / 回收站）。
 *
 * 一本书 = `<projectDir>/novels/<书名>/` 目录。书名同时是 BookRef.id。
 * 契约 v2 的硬要求：
 * - 新建书必须校验书名（1–40 字、无非法字符、不能是 `.`/`..`、不能重名）；
 * - 新建/切换都会把书名写进 `.moshu/settings.json` 的 `novelDir`；
 * - 删除一律移到 `novels/.trash/<书名>-<时间戳>/`，**永不物理删除**。
 */
import { existsSync, statSync } from 'node:fs';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { HttpError } from './errors.js';
import * as store from './store.js';
import { removeSettingsKeys, writeSettingsPatch } from './settings.js';
import { currentBook } from './current-book.js';
/* 作品根目录由 scope.js 决定（每个对话一个库，无作用域时是共享库）。 */
import { novelsRootOf } from './scope.js';

/** 回收站目录（`novels/.trash/`），列表时会跳过所有 `.` 开头的目录。 */
const TRASH_DIR = '.trash';

/** `<projectDir>/novels`。 */


/** 时间戳：`2026-10-30T09-12-33-123Z`。 */
function stamp() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

/** 一本书的 BookRef（契约 v2 字段，一个不多一个不少）。 */
async function readBook(projectDir, name, options = {}) {
  /* options.root：显式指定从哪个书库读（共享库导出时用），默认是当前作用域的书库。 */
  const root = options.root ? path.join(options.root, name) : path.join(novelsRootOf(projectDir), name);
  const [documents, stat] = await Promise.all([store.listDocuments(root).catch(() => []), fs.stat(root)]);
  const chapters = documents.filter((doc) => doc.type === 'chapter');
  const words = chapters.reduce((total, doc) => total + doc.content.replace(/\s+/g, '').length, 0);
  const projectText = await store.readDocument(root, 'project.md').catch(() => '');
  const title = projectText.match(/^#\s+(.+)$/m)?.[1]?.trim() || name;
  const updatedAt = documents.reduce(
    (latest, doc) => (doc.updatedAt > latest ? doc.updatedAt : latest),
    stat.mtime.toISOString(),
  );
  return { id: name, name, title, path: root, chapters: chapters.length, words, updatedAt };
}

/** 列出全部书籍（跳过 `.trash` 等隐藏目录），按书名排序。 */
export async function listBooks(projectDir) {
  const root = novelsRootOf(projectDir);
  let entries = [];
  try {
    entries = await fs.readdir(root, { withFileTypes: true });
  } catch (error) {
    if (error?.code === 'ENOENT') return [];
    throw error;
  }
  const names = entries
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
    .map((entry) => entry.name)
    .sort((left, right) => left.localeCompare(right, 'zh-CN'));
  const books = [];
  for (const name of names) books.push(await readBook(projectDir, name));
  return books;
}

/**
 * 当前作品目录名（薄封装：解析在 `current-book.js`，没有作品时是空串）。
 * @returns {string}
 */
export function currentBookId() {
  return currentBook()?.id ?? '';
}

/** `GET /books`：`{ projectDir, current, books }`（还没有任何书时 current 为 null）。 */
export async function describeBooks(projectDir) {
  const books = await listBooks(projectDir);
  const id = currentBookId();
  const current = books.find((book) => book.id === id) || null;
  return { projectDir, current, books };
}

/**
 * 校验一个**已存在**的书（目录名），返回原样的 id。
 *
 * 这里只做「存在性 + 防穿越」：不再套用新建书时那套命名规则。
 * 以前拿 validateNovelName 当存在性校验，导致磁盘上本来就在的作品
 * （旧后端建的 41 字目录、首尾带空格的目录）能列出来却切不了、删不掉。
 */
function requireExistingBook(projectDir, rawId) {
  const id = typeof rawId === 'string' ? rawId : '';
  if (!id) throw new HttpError(400, '缺少书籍 id。');
  const root = novelsRootOf(projectDir);
  const dir = path.join(root, id);
  if (id.includes('/') || id.includes('\\') || id === '.' || id === '..' || !store.isInside(root, dir)) {
    throw new HttpError(400, `书名「${id}」不合法。`);
  }
  let stat;
  try {
    stat = statSync(dir);
  } catch {
    throw new HttpError(404, `书籍「${id}」不存在。`);
  }
  if (!stat.isDirectory()) throw new HttpError(404, `书籍「${id}」不是一个目录。`);
  return id;
}

/** 新建一本书：建目录 + 骨架，并切过去。 */
export async function createBook(projectDir, rawName, options = {}) {
  const name = store.validateNovelName(rawName);
  const root = path.join(novelsRootOf(projectDir), name);
  if (existsSync(root)) throw new HttpError(400, `已经有一本书叫「${name}」了，请换个名字。`);
  /* 默认建空书；只有显式要示例（sample:true）才写入样例正文。 */
  await store.initializeProject(root, { sample: options.sample === true });
  await writeSettingsPatch({ novelDir: name });
  return { book: await readBook(projectDir, name), books: await listBooks(projectDir) };
}

/** 切换当前书籍（写 settings.novelDir）。 */
export async function selectBook(projectDir, rawId) {
  const name = requireExistingBook(projectDir, rawId);
  await writeSettingsPatch({ novelDir: name });
  return { book: await readBook(projectDir, name) };
}

/** 改名（目录 rename，原子）。当前书改名后同步 settings.novelDir。 */
export async function renameBook(projectDir, rawId, rawName) {
  const id = requireExistingBook(projectDir, rawId);
  const name = store.validateNovelName(rawName);
  if (name === id) return { book: await readBook(projectDir, id), books: await listBooks(projectDir) };

  const from = path.join(novelsRootOf(projectDir), id);
  const to = path.join(novelsRootOf(projectDir), name);
  if (existsSync(to)) throw new HttpError(400, `已经有一本书叫「${name}」了，请换个名字。`);
  const wasCurrent = currentBookId() === id;
  await store.renameWithRetry(from, to);
  if (wasCurrent) {
    try {
      await writeSettingsPatch({ novelDir: name });
    } catch (error) {
      /* settings 写不进去就把目录改回去，避免"目录名变了、当前书还指旧名"。 */
      await store.renameWithRetry(to, from).catch(() => {});
      throw error;
    }
  }
  return { book: await readBook(projectDir, name), books: await listBooks(projectDir) };
}

/**
 * 删除一本书：移到 `novels/.trash/<书名>-<时间戳>/`，永不物理删除。
 * 删的是当前书时，自动切到剩下的第一本；一本不剩就清掉 settings.novelDir。
 */
export async function trashBook(projectDir, rawId) {
  const id = requireExistingBook(projectDir, rawId);
  const from = path.join(novelsRootOf(projectDir), id);
  const wasCurrent = currentBookId() === id;
  const target = path.join(novelsRootOf(projectDir), TRASH_DIR, `${id}-${stamp()}`);
  /* 顺序很重要：先落 settings，再搬目录。
     反过来的话，settings 写失败会留下"目录已进回收站、novelDir 还指着它"的状态，
     整个书架看起来就没了（实测过）。 */
  if (wasCurrent) {
    const remaining = (await listBooks(projectDir)).filter((item) => item.id !== id);
    if (remaining.length) await writeSettingsPatch({ novelDir: remaining[0].id });
    else await removeSettingsKeys(['novelDir']);
  }
  await fs.mkdir(path.dirname(target), { recursive: true });
  await store.renameWithRetry(from, target);

  const books = await listBooks(projectDir);
  return { books, trashedTo: path.posix.join('novels', TRASH_DIR, path.basename(target)) };
}

/**
 * 彻底删除一本作品（**不进回收站**，磁盘上直接消失）。
 *
 * 「移到回收站」和「彻底删除」是两件事，作者必须能明确选择。
 * 为了防误触，confirm 必须与书名逐字相同。
 */
export async function deleteBookPermanently(projectDir, rawId, rawConfirm) {
  const id = requireExistingBook(projectDir, rawId);
  const confirm = typeof rawConfirm === 'string' ? rawConfirm.trim() : '';
  /* 界面上作者看到的是「标题」（project.md 的一级标题），磁盘上的 id 是目录名；
     改名或改过标题之后两者会不同。确认词两者都接受，否则作者永远删不掉自己的书。 */
  const book = await readBook(projectDir, id).catch(() => null);
  const title = (book && book.title) || id;
  if (confirm !== id && confirm !== title) {
    throw new HttpError(400, `彻底删除是不可恢复的：请在确认框里原样输入书名「${title}」。`);
  }
  const wasCurrent = currentBookId() === id;
  const target = path.join(novelsRootOf(projectDir), id);
  /* 先更新 settings，再动磁盘：settings 写失败时目录还在，书架不会凭空消失。 */
  if (wasCurrent) {
    const remaining = (await listBooks(projectDir)).filter((item) => item.id !== id);
    if (remaining.length) await writeSettingsPatch({ novelDir: remaining[0].id });
    else await removeSettingsKeys(['novelDir']);
  }
  await fs.rm(target, { recursive: true, force: true, maxRetries: 3 });
  return { books: await listBooks(projectDir), deleted: id };
}

/** 校验回收站条目名：只允许 `.trash` 下的一层目录名。 */
function requireTrashId(raw) {
  const id = typeof raw === 'string' ? raw.trim() : '';
  if (!id || id.includes('/') || id.includes('\\') || id.startsWith('.') || id.includes('..')) {
    throw new HttpError(400, '回收站条目无效。');
  }
  return id;
}

/** 目录的递归体积（回收站里 stat.size 恒为 0，显示成 0.0 KB 毫无意义）。 */
async function directorySize(dir) {
  let total = 0;
  let entries = [];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) total += await directorySize(full);
    else total += await fs.stat(full).then((stat) => stat.size).catch(() => 0);
  }
  return total;
}

/** 回收站里的条目：`<书名>-<时间戳>`。 */
export async function listTrash(projectDir) {
  const dir = path.join(novelsRootOf(projectDir), TRASH_DIR);
  let names = [];
  try {
    names = (await fs.readdir(dir, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
      .map((entry) => entry.name);
  } catch {
    return [];
  }
  const entries = [];
  for (const name of names) {
    const full = path.join(dir, name);
    const stat = await fs.stat(full).catch(() => null);
    const match = name.match(/^(.*)-(\d{4}-\d{2}-\d{2}T[\d-]+Z)$/);
    entries.push({
      trashId: name,
      name: match ? match[1] : name,
      trashedAt: match ? match[2] : stat ? stat.mtime.toISOString() : '',
      bytes: await directorySize(full),
    });
  }
  entries.sort((left, right) => String(right.trashedAt).localeCompare(String(left.trashedAt)));
  return entries;
}

/** 从回收站恢复一本书；同名已存在就加序号，绝不覆盖现有作品。 */
export async function restoreFromTrash(projectDir, rawTrashId) {
  const trashId = requireTrashId(rawTrashId);
  const root = novelsRootOf(projectDir);
  const from = path.join(root, TRASH_DIR, trashId);
  if (!existsSync(from)) throw new HttpError(404, '回收站里没有这一条。');
  /* 恢复出来的名字必须仍然满足新建规则（≤40 字），否则这本书会变成
     "能列出来、但切不了/删不掉"的僵尸（实测：40 字名重名恢复成 42 字 → 全 400）。 */
  const MAX_NAME = 40;
  const base = (trashId.replace(/-\d{4}-\d{2}-\d{2}T[\d-]+Z$/, '') || trashId).slice(0, MAX_NAME);
  let name = base;
  let attempt = 1;
  while (existsSync(path.join(root, name))) {
    attempt += 1;
    const suffix = `-${attempt}`;
    name = `${base.slice(0, MAX_NAME - suffix.length)}${suffix}`;
  }
  await store.renameWithRetry(from, path.join(root, name));
  return { books: await listBooks(projectDir), restored: name };
}

/** 彻底清掉回收站里的一条。 */
export async function purgeTrash(projectDir, rawTrashId) {
  const trashId = requireTrashId(rawTrashId);
  const target = path.join(novelsRootOf(projectDir), TRASH_DIR, trashId);
  if (!existsSync(target)) throw new HttpError(404, '回收站里没有这一条。');
  await fs.rm(target, { recursive: true, force: true, maxRetries: 3 });
  return { trash: await listTrash(projectDir) };
}

/**
 * 共享库（`<projectDir>/novels/`）里的书。
 *
 * 每个对话有自己的书库之后，升级前建的书都留在共享库里——
 * 会话里的书架一开始是空的，得让作者能把它们「拿进来」。
 */
export async function listSharedBooks(projectDir) {
  const root = path.join(projectDir, 'novels');
  let names = [];
  try {
    names = (await fs.readdir(root, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
      .map((entry) => entry.name);
  } catch (error) {
    if (error?.code === 'ENOENT') return { books: [] };
    throw error;
  }
  const books = [];
  for (const name of names) {
    try {
      books.push(await readBook(projectDir, name, { root }));
    } catch {
      books.push({ id: name, name, words: 0, chapters: 0 });
    }
  }
  return { books };
}

/**
 * 把共享库里的一本书**复制**到当前会话的书库。
 *
 * 是复制而不是移动：共享库保持原样，别的窗口/侧边栏照样能打开它。
 */
export async function importSharedBook(projectDir, rawName) {
  const name = String(rawName || '').trim();
  if (!name || name.includes('/') || name.includes('\\') || name.startsWith('.')) {
    throw new HttpError(400, '要导入的作品名无效。');
  }
  const source = path.join(projectDir, 'novels', name);
  const target = path.join(novelsRootOf(projectDir), name);
  if (!existsSync(source)) throw new HttpError(404, `共享库里没有《${name}》。`);
  if (path.resolve(source) === path.resolve(target)) {
    throw new HttpError(400, '当前就在这个库里，不需要导入。');
  }
  if (existsSync(target)) throw new HttpError(409, `这本库里已经有《${name}》了。`);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.cp(source, target, { recursive: true });
  const current = currentBook();
  if (!current) await writeSettingsPatch({ novelDir: name });
  return { book: await readBook(projectDir, name), books: await listBooks(projectDir) };
}
