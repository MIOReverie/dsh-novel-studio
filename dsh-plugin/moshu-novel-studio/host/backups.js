/**
 * 墨枢 Host 半：备份历史（`GET /backups?path=` / `POST /backups/restore`）。
 *
 * 备份布局沿用 store.js：`<作品>/.backups/<相对路径目录>/<时间戳>.md`。
 * 恢复的语义是「可回滚」：先把当前内容另存一份备份，再写回旧版本，
 * 所以恢复本身也能被再恢复一次。
 */
import { HttpError } from './errors.js';
import * as store from './store.js';
import { readSettings } from './settings.js';

/**
 * 列出某文档的备份，新的在前。
 * @param {URLSearchParams} searchParams
 */
export async function listBackups(searchParams) {
  const { novelDir } = store.projectContext();
  const { relative } = store.resolveMarkdown(novelDir, searchParams.get('path'));
  const entries = await store.listBackups(novelDir, relative);
  return { path: relative, entries };
}

/**
 * 恢复到指定备份。
 * @param {{path?:unknown, id?:unknown}} body
 */
export async function restore(body) {
  if (typeof body.id !== 'string' || !body.id.trim()) {
    throw new HttpError(400, '缺少备份 id（要恢复哪一份）。');
  }
  const { novelDir } = store.projectContext();
  const { relative } = store.resolveMarkdown(novelDir, body.path);
  const settings = readSettings();
  const restored = await store.restoreBackup(novelDir, relative, body.id.trim(), settings.backupKeep);
  return { ok: true, path: relative, content: restored.content, mtime: restored.mtime };
}
