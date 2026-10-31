'use strict';

/**
 * 「墨枢」作为对话里的一个 View（和 对话 / 轨迹 / 上下文 / 网页预览 并排）。
 *
 * 为什么这样做，而不是再写一个聊天框：
 * - 宿主的 Conversation 里已经有完整的消息流、工具卡、审批、diff、流式输出；
 *   插件再造一套只会两套割裂、而且必然落后。
 * - 把工作台挂成 View 之后，"看稿子"和"和 AI 说话"就是同一窗口里的两个 tab。
 *
 * 两条布局约束（都来自宿主实测）：
 * 1. 宿主的输入框 `position: sticky` 贴在底部、**叠在内容上**，高度写进
 *    `--dsh-composer-height`；不留出这段空间，工作台底部就会被压住。
 * 2. 但它顶上那 ~150px 是拿不回来的。想真正写满，就把工作台提到全屏浮层
 *    （runtime.setFullscreen → WorkbenchOverlay）。全屏时这里只留一张提示卡，
 *    避免两个工作台实例同时对同一章自动保存。
 */

const React = require('react');
const icons = require('../icons');
const { SlotPage } = require('./SlotPage');
const runtime = require('../runtime');
const api = require('../api');
const css = require('./conversation-workbench.css');

const h = React.createElement;

function ConversationWorkbench(props) {
  /* sessionId 可能来自几个不同位置（不同宿主的 session 槽会给不同形状）。 */
  const sessionId = String(
    (props && props.sessionId)
    || (props && props.session && (props.session.id || props.session.sessionId))
    || (props && props.id && typeof props.id === 'string' ? '' : '')
    || ''
  );
  const [mode, setMode] = React.useState(null);
  React.useEffect(function () {
    let alive = true;
    if (!sessionId) { setMode(null); return function () {}; }
    fetch('/api/moshu/session-mode?sessionId=' + encodeURIComponent(sessionId), { credentials: 'same-origin' })
      .then(function (res) { return res.ok ? res.json() : null; })
      .then(function (data) { if (alive && data) setMode(data); })
      .catch(function () { /* 问不到就当创作模式，不打扰作者 */ });
    return function () { alive = false; };
  }, [sessionId]);

  const openView = props && typeof props.openView === 'function' ? props.openView : null;
  const [fullscreen, setFullscreen] = React.useState(runtime.isFullscreen());

  React.useEffect(function () {
    return runtime.subscribeFullscreen(function (value) { setFullscreen(Boolean(value)); });
  }, []);

  function goTo(view) {
    if (!openView) return;
    try {
      openView(view, '');
    } catch (error) {
      /* 切不过去不影响当前视图 */
    }
  }

  if (fullscreen) {
    return h(
      'div',
      { className: 'moshu-convview' },
      h('style', { dangerouslySetInnerHTML: { __html: css } }),
      h(
        'div',
        { className: 'moshu-convview-body moshu-convview-away' },
        h(icons.PenLine, { size: 22 }),
        h('strong', null, '工作台正在全屏打开'),
        h('p', null, '为了避免同一章被两个编辑器同时保存，这里暂时只留一个入口。'),
        h(
          'button',
          {
            type: 'button',
            className: 'moshu-convview-btn is-primary',
            onClick: function () { runtime.setFullscreen(false); }
          },
          h(icons.X, { size: 15 }),
          h('span', null, '收回内嵌视图'),
        ),
      ),
    );
  }

  /* 非创作模式的会话：工作台照样能改稿，但 AI 看不到小说工具（novel_* 只挂在
     创作模式的 preset 上）。给一条明确提示，免得作者以为「AI 怎么不会看我的稿子」。 */
  const modeBanner = mode && mode.creation === false
    ? h(
      'div',
      { className: 'moshu-convview-mode' },
      h(icons.Sparkles, { size: 14 }),
      h('span', null, '当前会话不是创作模式：AI 看不到小说工具（读写章节、批注、地图）。编辑功能不受影响。'),
      h('span', { className: 'moshu-convview-mode-tag' }, '切到创作模式后 AI 才能参与'),
    )
    : null;

  return h(
    'div',
    { className: 'moshu-convview' },
    h('style', { dangerouslySetInnerHTML: { __html: css } }),
    modeBanner,
    h(
      'div',
      { className: 'moshu-convview-body' },
      h(SlotPage, { scope: sessionId }),
      /* 浮条放在 body 里：body 已经按 --dsh-composer-height 让开了输入框。 */
      h(
        'div',
        { className: 'moshu-convview-dock' },
        h(
          'button',
          {
            type: 'button',
            className: 'moshu-convview-btn is-primary',
            onClick: function () { goTo('chat'); },
            title: '回到对话继续和 AI 说话'
          },
          h(icons.MessageSquareText, { size: 15 }),
          h('span', null, '回到对话'),
        ),
        /* 原来这里有个浮动「全屏编辑」按钮：现在入口统一到工作台头部，
           浮动条只留「回到对话」，免得同一件事有两个入口。 */
        h(
          'span',
          { className: 'moshu-convview-hint' },
          '写长章时点右上角「全屏」，Esc 退出。',
        ),
      ),
    ),
    /* 与宿主输入框等高的停靠条：输入框贴底悬浮，铺一条同色同高的底栏接住它，
       看起来就是页面的一部分，而不是压在地图上。 */
    h('div', { className: 'moshu-convview-seat', 'aria-hidden': true }),
  );
}

module.exports = { ConversationWorkbench: ConversationWorkbench };
