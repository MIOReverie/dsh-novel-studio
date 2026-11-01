/**
 * 会话作用域。
 *
 * 问题：墨枢原来只有**一个**全局项目（`<projectDir>/novels/` + 一份 settings.json），
 * 于是所有对话共用同一个书架、同一个「当前作品」——A 窗口切书，B 窗口也跟着变；
 * 两个对话同时改稿会互相覆盖。
 *
 * 现在：**作品放在 `<工作区>/.moshu/novels/`**（一个工作区一本小说，不同对话共用）。
 * 作用域只用来分隔**「当前作品」这类界面状态**：
 *   `<projectDir>/.moshu/scopes/<sessionId>/settings.json`
 * 老数据（`<projectDir>/novels/` 与 `.moshu/scopes/<id>/novels/`）会在第一次访问时
 * 自动搬到新位置（见 store.ensureNovelsMigrated）。
 *
 * 作用域靠 AsyncLocalStorage 传播：HTTP 从 `X-Moshu-Scope` 头进，
 * 工具调用从 `exec.agent.session.id` 进，之后所有 `projectContext()` 自动用对目录。
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import path from 'node:path';

const storage = new AsyncLocalStorage();

/** 只接受安全字符：会话 id 会变成目录名，不允许路径分隔符与点前缀。 */
export function sanitizeScope(raw) {
  const id = typeof raw === 'string' ? raw.trim() : '';
  if (!id || id.length > 120) return '';
  if (!/^[A-Za-z0-9_-]+$/.test(id)) return '';
  return id;
}

/** 在当前作用域里跑一段同步/异步代码。 */
export function runInScope(scope, fn) {
  const id = sanitizeScope(scope);
  return id ? storage.run({ scope: id }, fn) : fn();
}

/** 当前作用域 id；空串表示共享库（侧边栏面板）。 */
export function currentScope() {
  return storage.getStore()?.scope || '';
}

/** 某个作用域的根目录。 */
export function scopeRootOf(projectDir, scope) {
  const id = sanitizeScope(scope);
  return id ? path.join(projectDir, '.moshu', 'scopes', id) : '';
}

/**
 * 作品根目录：`<工作区>/.moshu/novels`。
 *
 * **一个工作区 = 一本小说**：同一个工作区里的不同对话看到的是同一批书，
 * 换对话（换话题）不用重新找书；作用域只决定「当前作品」这一项，不再分家。
 * 以前是每个对话一个 `novels/`，同一本书在两个对话里各存一份，容易改重、
 * 也不符合「一个工作区服务一本小说」的用法。
 */
export function novelsRootOf(projectDir) {
  return path.join(projectDir, '.moshu', 'novels');
}

/** 旧位置（升级前）：共享库与「每个对话一个库」都可能存着老书，迁移时扫这里。 */
export function legacyNovelsRoots(projectDir, sessionIds) {
  const roots = [path.join(projectDir, 'novels')];
  for (const id of sessionIds) {
    const safe = sanitizeScope(id);
    if (safe) roots.push(path.join(projectDir, '.moshu', 'scopes', safe, 'novels'));
  }
  return roots;
}

/** 当前作用域的 settings.json（没有作用域时返回空串，调用方回落到全局）。 */
export function scopedSettingsFile(projectDir) {
  const scopeDir = scopeRootOf(projectDir, currentScope());
  return scopeDir ? path.join(scopeDir, 'settings.json') : '';
}
