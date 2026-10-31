'use strict';

/**
 * 插件内的运行时小仓库。
 *
 * DSH 只把 ctx 交给 client 模块的 `apply`，而页面组件是普通 React 组件。
 * 这里存一份 ctx 引用，让页面里的「创作模式」面板能调宿主服务
 * （启动创作会话、切到对话面板），而不必把 ctx 一层层透传。
 */

let currentCtx = null;

function setCtx(ctx) {
  currentCtx = ctx || null;
  return currentCtx;
}

function getCtx() {
  return currentCtx;
}

/** 取一个客户端服务；拿不到返回 undefined（调用方必须自己兜底）。 */
function service(name) {
  if (!currentCtx || typeof currentCtx.get !== 'function') return undefined;
  try {
    return currentCtx.get(name);
  } catch (error) {
    return undefined;
  }
}

/**
 * 「工作台全屏」这个状态必须跨组件共享：
 * - 对话里的内嵌 View 要据此让位（否则会同时挂两个工作台实例，两边都在自动保存同一章）；
 * - 浮层要据此显示/隐藏。
 * 用一个极小的订阅式 store，避免为了这点状态引入 context 或第三方库。
 */
let fullscreenOpen = false;
const fullscreenListeners = new Set();

let fullscreenScope = '';

function setFullscreen(next, scope) {
  /* 只有明确给了**非空**作用域才覆盖。空串多半是"调用方没带"，不该把上一次的抹掉。 */
  if (typeof scope === 'string' && scope) fullscreenScope = scope;
  const value = Boolean(next);
  if (value === fullscreenOpen) return;
  fullscreenOpen = value;
  for (const listener of Array.from(fullscreenListeners)) {
    try {
      listener(value);
    } catch (error) {
      /* 某个订阅者抛错不影响其它订阅者 */
    }
  }
}

function isFullscreen() {
  return fullscreenOpen;
}

function subscribeFullscreen(listener) {
  if (typeof listener !== 'function') return function () {};
  fullscreenListeners.add(listener);
  return function () {
    fullscreenListeners.delete(listener);
  };
}

/**
 * 同一时刻只允许一个工作台实例在编辑。
 *
 * 主区面板（SlotPage）、对话内嵌（ConversationWorkbench）、全屏浮层都可能挂 Page；
 * 以前只挡了「全屏」一种，剩下两种同时挂载时，两个编辑器会各自自动保存同一章
 * （实测：两个 textarea、互相 409、各自一套草稿）。这里用「最后挂载者拥有」的租约。
 */
let editorOwner = null;
const editorOrder = [];
const editorListeners = new Set();

function notifyEditors() {
  for (const listener of Array.from(editorListeners)) {
    try { listener(editorOwner); } catch (error) { /* 订阅者异常不影响其它 */ }
  }
}

function claimEditor(id) {
  if (!id) return function () {};
  if (!editorOrder.includes(id)) editorOrder.push(id);
  editorOwner = id;
  notifyEditors();
  return function () {
    const at = editorOrder.indexOf(id);
    if (at >= 0) editorOrder.splice(at, 1);
    if (editorOwner === id) {
      editorOwner = editorOrder.length ? editorOrder[editorOrder.length - 1] : null;
      notifyEditors();
    }
  };
}

function currentEditor() {
  return editorOwner;
}

function subscribeEditor(listener) {
  if (typeof listener !== 'function') return function () {};
  editorListeners.add(listener);
  return function () { editorListeners.delete(listener); };
}

module.exports = {
  setCtx: setCtx,
  getCtx: getCtx,
  service: service,
  setFullscreen: setFullscreen,
  fullscreenScope: function () { return fullscreenScope; },
  isFullscreen: isFullscreen,
  subscribeFullscreen: subscribeFullscreen,
  claimEditor: claimEditor,
  currentEditor: currentEditor,
  subscribeEditor: subscribeEditor
};
