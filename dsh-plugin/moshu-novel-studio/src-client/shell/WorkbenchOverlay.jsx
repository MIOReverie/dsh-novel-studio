'use strict';

/**
 * 工作台全屏浮层（挂在宿主的 `shell.overlay` 上：整帧浮层，盖住所有列）。
 *
 * 为什么需要它：对话里那排 tab（对话/轨迹/上下文/网页预览/墨枢）下方永远压着一个
 * 输入框，它靠 CSS 变量把约 150px 的高度占死。工作台塞进去之后，写作区就被压掉一截。
 * 调 padding 只能"不被遮挡"，拿不回空间；真正的解法是把工作台整个提到浮层里，
 * 用满整窗高度去写字。
 *
 * 同一时刻只允许一个工作台实例在编辑：全屏打开时，内嵌的那个 View 会退化成一张小卡片
 * （见 ConversationWorkbench），否则两个实例会同时对同一章自动保存。
 */

const React = require('react');
const icons = require('../icons');
const { SlotPage } = require('./SlotPage');
const runtime = require('../runtime');
const api = require('../api');
const css = require('./workbench-overlay.css');

const h = React.createElement;

function WorkbenchOverlay() {
  const [open, setOpen] = React.useState(runtime.isFullscreen());

  React.useEffect(function () {
    return runtime.subscribeFullscreen(function (value) { setOpen(Boolean(value)); });
  }, []);

  React.useEffect(function () {
    if (!open) return undefined;
    function onKeyDown(event) {
      if (event.key === 'Escape') {
        event.preventDefault();
        runtime.setFullscreen(false);
      }
    }
    window.addEventListener('keydown', onKeyDown);
    return function () { window.removeEventListener('keydown', onKeyDown); };
  }, [open]);

  if (!open) return null;

  return h(
    'div',
    { className: 'moshu-overlay', role: 'dialog', 'aria-modal': 'true', 'aria-label': '墨枢小说工作台（全屏）' },
    h('style', { dangerouslySetInnerHTML: { __html: css } }),
    h(
      'div',
      { className: 'moshu-overlay-bar' },
      h('span', { className: 'moshu-overlay-mark' }, h(icons.PenLine, { size: 15 })),
      h('strong', { className: 'moshu-overlay-title' }, '墨枢 · 小说工作台'),
      h('span', { className: 'moshu-overlay-hint' }, '全屏编辑中 · 按 Esc 或右侧按钮回到对话'),
      h(
        'button',
        {
          type: 'button',
          className: 'moshu-overlay-close',
          onClick: function () { runtime.setFullscreen(false); },
          title: '退出全屏（Esc）'
        },
        h(icons.X, { size: 15 }),
        h('span', null, '退出全屏'),
      ),
    ),
    /* 必须是 SlotPage：它会带上作用域（这次全屏是从哪个书库进来的），
       裸 Page 没有 scope，会掉进共享库——表现就是「进全屏后要重新建书」。 */
    h('div', { className: 'moshu-overlay-body' }, h(SlotPage, {
      inOverlay: true,
      /* 兜底：任何入口忘了带作用域时，退回「当前 api 作用域」（= 打开全屏时那个实例的书库），
         绝不让浮层静默掉进共享库。 */
      scope: runtime.fullscreenScope() || (api.getScope ? api.getScope() : ''),
    })),
  );
}

module.exports = { WorkbenchOverlay: WorkbenchOverlay };
