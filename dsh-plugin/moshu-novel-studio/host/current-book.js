/**
 * 墨枢 Host 半：作品解析的**唯一出处**。
 *
 * v3 之前 `novelDir` 有三个来源（`defaultSettings()` 的默认值、`store.resolveNovelDir`、
 * `bootstrap` 里的扫描回落），三者可以互相矛盾：设置页显示的作品名可能是一本并不存在的书，
 * `POST /bootstrap` 又按这个不存在的路径去播种示例书，于是作者看到「删了没反应」。
 *
 * 现在只有这一个函数决定「当前作品是哪一本」：
 *
 *   1. `settings.novelDir` 存在，且它指向的目录在磁盘上真实存在 → 用它；
 *   2. 否则扫描 `<projectDir>/novels/`：优先《雾隐之城》，否则字典序第一本；
 *   3. 一本书都没有（或 novels/ 不存在）→ `null`。
 *
 * 注意两件事：
 * - 这里**只解析、不创建**任何目录。空书架必须落到 `null`，绝不能在读路径上把示例书造出来。
 * - 配置值越界（指向 `<projectDir>` 之外）时不抛错，直接当作「没有配置」，落到扫描：
 *   一个坏配置不该让 `/health`、`/status` 这类读接口 500。写设置时 `settings.js` 已经
 *   校验过「必须是 novels/ 下真实存在的目录」，正常流程走不到这个分支。
 */
import { readdirSync, statSync } from 'node:fs';
/* 与 books.js 共用同一份实现（作用域感知）。 */
import { novelsRootOf } from './scope.js';
import path from 'node:path';
import { DEFAULT_NOVEL_NAME, isInside, loadSettings } from './store.js';

/** `<projectDir>/novels`。 */


function isDirectory(target) {
  try {
    return statSync(target).isDirectory();
  } catch {
    return false;
  }
}

/**
 * 当前打开的作品。
 *
 * @param {ReturnType<typeof loadSettings>} [settings] 一次请求里已经读到的设置（省一次读盘）
 * @returns {{id:string, root:string} | null} id = 作品目录名（同时是 `bookId`）
 */
/**
 * 书 id 的统一校验（读、写共用一套）。
 * 以前写侧拒绝 `.` 前缀与分隔符，读侧却放行 `.trash`、`a/b`——
 * 手改 settings 就能把「当前作品」指到回收站里。
 */
function validateBookId(raw) {
  const id = typeof raw === 'string' ? raw.trim() : '';
  if (!id) return '';
  if (id.startsWith('.') || id.includes('/') || id.includes('\\') || id === '..') return '';
  return id;
}

export function currentBook(settings = loadSettings()) {
  const projectDir = path.resolve(settings?.projectDir || process.cwd());
  const configured = typeof settings?.novelDir === 'string' ? settings.novelDir.trim() : '';

  /* 配置值必须是「一本书的目录名」：拒绝 `.` 开头（回收站）、分隔符、`..`。
     否则手改 settings 就能把当前作品指到 novels/.trash 里。 */
  /* 非法值（`.trash`、`a/b`、`..`）当作没配置，落到下面的扫描——比抛错更安全（页面还能打开）。 */
  const safeConfigured = validateBookId(configured);
  if (safeConfigured) {
    const resolved = path.join(novelsRootOf(projectDir), safeConfigured);
    if (isInside(projectDir, resolved) && isDirectory(resolved)) {
      return { id: safeConfigured, root: resolved };
    }
  }

  const novelsRoot = novelsRootOf(projectDir);
  try {
    const names = readdirSync(novelsRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
      .map((entry) => entry.name)
      .sort();
    if (names.length) {
      const name = names.includes(DEFAULT_NOVEL_NAME) ? DEFAULT_NOVEL_NAME : names[0];
      return { id: name, root: path.join(novelsRoot, name) };
    }
  } catch {
    /* novels/ 还不存在：就是空书架 */
  }
  return null;
}

/**
 * 「还没有作品」时用来占位的路径（**不保证存在**）。
 *
 * 只给两个地方用：`store.resolveNovelDir()` 的返回值（`GET /health` 的 `novelDir` 字段、
 * `bootstrap` 空书架的 `root` 字段）以及 409 文案。它不参与解析，也不创建目录。
 * @param {ReturnType<typeof loadSettings>} [settings]
 */
export function fallbackBookRoot(settings = loadSettings()) {
  const projectDir = path.resolve(settings?.projectDir || process.cwd());
  return path.join(novelsRootOf(projectDir), DEFAULT_NOVEL_NAME);
}

