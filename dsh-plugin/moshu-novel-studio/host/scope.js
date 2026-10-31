/**
 * 会话作用域。
 *
 * 问题：墨枢原来只有**一个**全局项目（`<projectDir>/novels/` + 一份 settings.json），
 * 于是所有对话共用同一个书架、同一个「当前作品」——A 窗口切书，B 窗口也跟着变；
 * 两个对话同时改稿会互相覆盖。
 *
 * 现在：每个对话（session）有自己的作用域目录
 *   `<projectDir>/.moshu/scopes/<sessionId>/`
 * 里面放自己的 `novels/` 与 `settings.json`。没有作用域（侧边栏面板）时用共享库
 * `<projectDir>/novels/`，也就是升级前的老数据还在那儿。
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
 * 作品根目录：有作用域就用自己的库，否则用共享库。
 * `projectDir` 永远是**全局**项目根，作用域只影响这一层。
 */
export function novelsRootOf(projectDir) {
  const scopeDir = scopeRootOf(projectDir, currentScope());
  return scopeDir ? path.join(scopeDir, 'novels') : path.join(projectDir, 'novels');
}

/** 当前作用域的 settings.json（没有作用域时返回空串，调用方回落到全局）。 */
export function scopedSettingsFile(projectDir) {
  const scopeDir = scopeRootOf(projectDir, currentScope());
  return scopeDir ? path.join(scopeDir, 'settings.json') : '';
}
