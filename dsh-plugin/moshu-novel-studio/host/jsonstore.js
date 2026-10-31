/**
 * 墨枢 Host 半：**派生 JSON 的唯一读写入口**。
 *
 * 为什么要有这一层（审计报告 P0-4，实测）：
 * - `annotations.json` 坏一次 → `GET /bootstrap` 500，整页打不开；
 * - 顶层不是数组时静默清零，下一次写入把原数据全丢；
 * - 16 个并发写只落 1 条（读-改-写之间互相覆盖）。
 *
 * 这一层给出的三件事：
 * 1. **坏档隔离**：解析失败 → 把文件改名成 `<name>.corrupt-<时间戳>.json` + 记一条 warn +
 *    返回 fallback。**绝不让读接口 500**。隔离本身失败也只 warn（不能反过来把请求打成 500）。
 * 2. **写前备份**：旧文件复制到 `.backups/_json/<相对路径>/<时间戳>.json`，每个文件最多留
 *    `MAX_JSON_BACKUPS = 20` 份；备份 / 清理失败都不影响主写入。
 * 3. **同路径串行**：同一相对路径的读-改-写排队执行（`withPathLock`，思路同 `store.js` 的老实现，
 *    但支持重入：`withDocLock` 里再调 `readArray` / `writeArray` 不会自己把自己锁死）。
 *
 * 接口形状（v3 契约 §2.2）：
 * ```js
 * readArray(root, relative, fallback = [])   // 缺文件 / 坏档 → fallback
 * writeArray(root, relative, value)          // 写前备份
 * readObject(root, relative, fallback = {})
 * writeObject(root, relative, value)
 * replaceArray(root, relative, value)        // 显式整表替换（仍先备份）
 * ```
 * 记账格式与 v3 之前逐字节一致：`JSON.stringify(value, null, 2) + '\n'`。
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';

/** 每个 JSON 文件最多保留的备份份数（契约 §2.2）。 */
export const MAX_JSON_BACKUPS = 20;

/** 备份根目录（相对作品目录）：`.backups/_json/<相对路径>/<时间戳>.json`。 */
export const JSON_BACKUP_ROOT = '.backups/_json';

/* ------------------------------------------------------------------ 日志 */

let activeLogger = null;

/**
 * 注入宿主 logger（`ctx.logger`）。不注入时退回 `console.warn`。
 * @param {{warn?:Function}|null|undefined} logger
 */
export function setLogger(logger) {
  activeLogger = logger && typeof logger.warn === 'function' ? logger : null;
}

function warn(message) {
  try {
    if (activeLogger) activeLogger.warn(message);
    else console.warn('[moshu]', message);
  } catch {
    /* 日志写不出去也不能影响数据读写 */
  }
}

/* ------------------------------------------------------------------ 工具 */

/** 与 v3 之前完全一致的落盘格式。 */
export function jsonText(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

/** 时间戳：`2026-10-31T05-12-33-123Z`（Windows 文件名安全，可直接排序）。 */
function stampOf() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

/**
 * 拒绝把派生 JSON 写到作品目录外面。
 * 现在所有调用点传的都是常量，但只要将来有人接用户输入，这里就是唯一的护栏。
 */
function assertInsideRoot(root, file, relative) {
  const base = path.resolve(root);
  const target = path.resolve(file);
  if (target !== base && !target.startsWith(base + path.sep)) {
    throw new Error(`jsonstore: 路径越界（${relative}）`);
  }
  return file;
}

function fileOf(root, relative) {
  const file = path.join(root, ...String(relative).split('/'));
  return assertInsideRoot(root, file, relative);
}

function keyOf(root, relative) {
  return `${path.resolve(root)}|${String(relative).replace(/\\/g, '/')}`;
}

async function pathExists(target) {
  try {
    await fs.access(target);
    return true;
  } catch {
    return false;
  }
}

function errorText(error) {
  return error instanceof Error && error.message ? error.message : String(error);
}

/**
 * 目录 / 文件改名的重试版本（Windows 上刚写完的文件常被杀软 / 索引短暂占用）。
 * 与 `store.renameWithRetry` 同一套策略；`store` 从这里导出同一个实现，避免两份漂移。
 */
export async function renameWithRetry(from, to, attempts = 6) {
  let lastError;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      await fs.rename(from, to);
      return;
    } catch (error) {
      lastError = error;
      if (!['EPERM', 'EBUSY', 'EACCES', 'ENOTEMPTY'].includes(error?.code)) throw error;
      await new Promise((resolve) => { setTimeout(resolve, 40 * (attempt + 1)); });
    }
  }
  throw lastError;
}

/** 原子写（同目录临时文件 + rename 重试）。 */
export async function atomicWrite(file, content) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
  await fs.writeFile(temporary, content, 'utf8');
  /* rename 在 Windows 上会被杀软 / 索引 / 另一个进程短暂占用（EPERM/EBUSY）。
     这里必须重试；重试仍失败就保留 .tmp（里面是刚写好的完整内容），交给上层报 500。 */
  await renameWithRetry(temporary, file);
}

/* ------------------------------------------------------------------ 串行锁 */

/** 每个 key 一条 promise 链。 */
const queues = new Map();

/** 当前任务已经持有的 key 集合（用于重入判断）。 */
const held = new AsyncLocalStorage();

/**
 * 同一 key 的任务排队执行；在已持有该 key 的任务里再次调用则直接执行（重入）。
 *
 * 重入是必须的：`POST /annotations` 要「读 → 合并 → 写」原子完成，于是用 `withDocLock`
 * 把整段包起来，而里面的 `readArray` / `writeArray` 本身也要加锁 —— 非重入的队列会在
 * 第二层自己等自己，永远不返回。
 *
 * @template T
 * @param {string} key 任意唯一键（JSON 文件用 `keyOf(root, relative)`）
 * @param {() => Promise<T>|T} task
 * @returns {Promise<T>}
 */
let activeLockKey = null;

export function withPathLock(key, task) {
  /* 跨键嵌套会死锁（A→B 与 B→A 互等；实测 600ms 无进展）。
     目前没有跨键调用点，这里显式拒绝，免得将来有人踩进去后只能看到「卡住」。 */
  if (activeLockKey && activeLockKey !== key) {
    return Promise.reject(new Error(`withPathLock: 不允许跨键嵌套（已持有 ${activeLockKey}，又请求 ${key}）`));
  }
  const current = held.getStore();
  if (current && current.has(key)) return Promise.resolve().then(task);

  const previous = queues.get(key) || Promise.resolve();
  const start = () => {
    const keys = new Set(current || []);
    keys.add(key);
    return held.run(keys, () => task());
  };
  const run = previous.then(start, start);
  const tail = run.then(() => {}, () => {});
  queues.set(key, tail);
  tail.then(() => {
    if (queues.get(key) === tail) queues.delete(key);
  });
  return run;
}

/**
 * 把一个 JSON 文件的整段读-改-写包成原子操作。
 * @template T
 * @param {string} root 作品目录
 * @param {string} relative 相对路径（如 `annotations.json`）
 * @param {() => Promise<T>|T} task
 * @returns {Promise<T>}
 */
export function withDocLock(root, relative, task) {
  return withPathLock(keyOf(root, relative), task);
}

/* ------------------------------------------------------------------ 坏档隔离 */

/**
 * 把坏文件改名成 `<name>.corrupt-<时间戳>.json`。
 * 失败只记 warn —— 请求必须照常返回 fallback，不能反过来 500。
 */
async function isolateCorrupt(root, relative, reason) {
  const file = fileOf(root, relative);
  const extension = path.extname(file);
  const base = path.basename(file, extension);
  const target = path.join(path.dirname(file), `${base}.corrupt-${stampOf()}${extension}`);
  try {
    await renameWithRetry(file, target);
    warn(`[moshu] ${relative} 数据损坏（${reason}），已隔离为 ${path.basename(target)}，本次按空数据处理。`);
    return target;
  } catch (error) {
    warn(`[moshu] ${relative} 数据损坏（${reason}），但隔离失败（${errorText(error)}），本次按空数据处理。`);
    return null;
  }
}

/* ------------------------------------------------------------------ 备份 */

/** 同一文件在这么短时间内只留一份备份（毫秒）。 */
const BACKUP_COALESCE_MS = 60_000;

/**
 * 目录里是否有"够新"的备份。按文件名里的时间戳判断（排序即可，不必 stat 每个文件）。
 * @returns {Promise<boolean>}
 */
async function newestBackupWithin(directory, windowMs) {
  try {
    const names = (await fs.readdir(directory)).filter((name) => name.endsWith('.json')).sort();
    if (!names.length) return false;
    const newest = names[names.length - 1];
    /* 文件名形如 2026-10-31T10-42-52-835Z.json */
    const matched = /^(\d{4})-(\d{2})-(\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z/.exec(newest);
    if (!matched) return false;
    const iso = `${matched[1]}-${matched[2]}-${matched[3]}T${matched[4]}:${matched[5]}:${matched[6]}.${matched[7]}Z`;
    const at = Date.parse(iso);
    if (!Number.isFinite(at)) return false;
    return Date.now() - at < windowMs;
  } catch {
    return false;
  }
}

/** 清理一个备份目录，只保留最新 `MAX_JSON_BACKUPS` 份。失败不抛。 */
async function pruneBackups(directory, keep = MAX_JSON_BACKUPS) {
  let names;
  try {
    names = (await fs.readdir(directory)).filter((name) => name.endsWith('.json'));
  } catch {
    return 0;
  }
  if (names.length <= keep) return 0;
  names.sort(); // 时间戳文件名 → 字典序即时间序，最旧在前
  const extra = names.slice(0, names.length - keep);
  let removed = 0;
  for (const name of extra) {
    try {
      await fs.rm(path.join(directory, name), { force: true });
      removed += 1;
    } catch {
      /* 单条删不掉（被杀软 / 索引占用）留给下一次清理 */
    }
  }
  return removed;
}

/** 写前备份旧文件；任何失败都只 warn，不阻断写入。 */
async function backupBeforeWrite(root, relative, file) {
  try {
    let stat;
    try {
      stat = await fs.stat(file);
    } catch {
      return; // 文件不存在：第一次写入，没有可备份的内容
    }
    if (!stat.isFile()) return;
    const directory = path.join(root, JSON_BACKUP_ROOT, ...String(relative).split('/'));
    await fs.mkdir(directory, { recursive: true });

    /* 一分钟内同一个文件只留一份备份。
       AI 密集改地图时（一次迭代几十次写入）会堆出几十份内容几乎相同的备份，对作者是纯噪音；
       合并后仍然保留"最近一分钟之前的那个版本"，真要回滚照样找得回来。 */
    const recent = await newestBackupWithin(directory, BACKUP_COALESCE_MS);
    if (recent) return;

    const stamp = stampOf();
    let name = `${stamp}.json`;
    let attempt = 1;
    while (await pathExists(path.join(directory, name))) {
      attempt += 1;
      name = `${stamp}-${attempt}.json`;
    }
    await fs.copyFile(file, path.join(directory, name));
    await pruneBackups(directory);
  } catch (error) {
    warn(`[moshu] 备份 ${relative} 失败（不影响本次写入）：${errorText(error)}`);
  }
}

/* ------------------------------------------------------------------ 读 */

/**
 * @param {'array'|'object'} expect
 * @returns {Promise<any>} 命中 fallback 时原样返回 fallback
 */
async function readValue(root, relative, fallback, expect) {
  return withDocLock(root, relative, async () => {
    const file = fileOf(root, relative);
    let text;
    try {
      text = await fs.readFile(file, 'utf8');
    } catch (error) {
      if (error?.code === 'ENOENT') return fallback;
      throw error; // 权限 / IO 故障照常上抛（和以前一样 500）
    }
    if (!text.trim()) return fallback; // 空文件 = 还没写过任何内容
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch (error) {
      await isolateCorrupt(root, relative, `JSON 语法错误：${errorText(error)}`);
      return fallback;
    }
    const ok = expect === 'array'
      ? Array.isArray(parsed)
      : Boolean(parsed) && typeof parsed === 'object' && !Array.isArray(parsed);
    if (!ok) {
      /* 类型不对比语法错误更危险：以前这里静默返回空数组，下一次写入就把原数据整表覆盖掉。
         现在按坏档处理（隔离 + 保留现场），至少作者能从 `.corrupt-*` 或 `.backups/_json/` 找回。 */
      await isolateCorrupt(root, relative, expect === 'array' ? '顶层不是数组' : '顶层不是对象');
      return fallback;
    }
    return parsed;
  });
}

/**
 * 读一个 JSON 数组。缺文件 / 坏档 → `fallback`（默认 `[]`），绝不抛「数据损坏」。
 * @param {string} root 作品目录
 * @param {string} relative 相对路径
 * @param {any[]} [fallback]
 * @returns {Promise<any[]>}
 */
export async function readArray(root, relative, fallback = []) {
  return readValue(root, relative, fallback, 'array');
}

/**
 * 读一个 JSON 对象。缺文件 / 坏档 → `fallback`（默认 `{}`）。
 * @param {string} root 作品目录
 * @param {string} relative 相对路径
 * @param {object} [fallback]
 * @returns {Promise<object>}
 */
export async function readObject(root, relative, fallback = {}) {
  return readValue(root, relative, fallback, 'object');
}

/* ------------------------------------------------------------------ 写 */

/**
 * @param {'array'|'object'} expect
 */
async function writeValue(root, relative, value, expect) {
  if (expect === 'array' && !Array.isArray(value)) {
    throw new TypeError(`jsonstore.write: ${relative} 必须是数组（收到 ${typeof value}）。`);
  }
  if (expect === 'object' && (!value || typeof value !== 'object' || Array.isArray(value))) {
    throw new TypeError(`jsonstore.write: ${relative} 必须是对象（收到 ${Array.isArray(value) ? 'array' : typeof value}）。`);
  }
  return withDocLock(root, relative, async () => {
    const file = fileOf(root, relative);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await backupBeforeWrite(root, relative, file);
    await atomicWrite(file, jsonText(value));
    return value;
  });
}

/**
 * 写一个 JSON 数组（写前备份 + 原子替换）。
 * @param {string} root 作品目录
 * @param {string} relative 相对路径
 * @param {any[]} value
 */
export async function writeArray(root, relative, value) {
  return writeValue(root, relative, value, 'array');
}

/**
 * 写一个 JSON 对象（写前备份 + 原子替换）。
 * @param {string} root 作品目录
 * @param {string} relative 相对路径
 * @param {object} value
 */
export async function writeObject(root, relative, value) {
  return writeValue(root, relative, value, 'object');
}

/**
 * 显式整表替换一个 JSON 数组（仍然先备份）。
 *
 * 与 `writeArray` 的区别只在语义：调用方必须明确「这是整张表，不是增量」。
 * 空数组清空全表的策略由各端点决定（`POST /annotations` 要求 `force:true`）。
 */
export async function replaceArray(root, relative, value) {
  return writeValue(root, relative, value, 'array');
}
