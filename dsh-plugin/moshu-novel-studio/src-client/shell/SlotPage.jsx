'use strict';

/**
 * 工作台在「主区面板」里的入口。
 *
 * 存在意义只有一个：**保证同一时刻只有一个工作台在编辑**。
 * 全屏浮层打开时，这里退化成一张提示卡，否则主区面板 + 浮层会各挂一个编辑器，
 * 两边都对同一章自动保存（互相覆盖，而且备份也会翻倍）。
 */

const React = require('react');
const icons = require('../icons');
const { Page } = require('../page');
const runtime = require('../runtime');
const css = require('./workbench-slot.css');

const h = React.createElement;

function AwayCard(props) {
  return h(
    'div',
    { className: 'moshu-slot-away' },
    h('style', { dangerouslySetInnerHTML: { __html: css } }),
    h(icons.PenLine, { size: 24 }),
    h('strong', null, '工作台正在全屏打开'),
    h('p', null, '编辑窗口只有一个，避免两处同时写同一章。'),
    h(
      'button',
      {
        type: 'button',
        className: 'moshu-slot-away-btn',
        onClick: function () { runtime.setFullscreen(false); }
      },
      h(icons.X, { size: 15 }),
      h('span', null, '收回全屏'),
    ),
  );
}

function SlotPage(props) {
  const inOverlay = Boolean(props && props.inOverlay);
  /* 作用域交给 Page 自己设：让位时（渲染 AwayCard）不碰全局作用域。
     以前这里无条件 setScope，于是"主区面板"和"全屏浮层"会互相把作用域覆盖掉——
     进全屏后 Page 拿到的是共享库，于是显示"书架是空的、要新建书"。 */
  const scope = (props && props.scope) || '';
  const [fullscreen, setFullscreen] = React.useState(runtime.isFullscreen());
  const [owner, setOwner] = React.useState(runtime.currentEditor());
  const idRef = React.useRef('slot-' + Math.random().toString(36).slice(2, 9));

  React.useEffect(function () {
    return runtime.subscribeFullscreen(function (value) { setFullscreen(Boolean(value)); });
  }, []);

  React.useEffect(function () {
    if (!inOverlay) return undefined;
    return undefined;
  }, [inOverlay]);

  React.useEffect(function () {
    const release = runtime.claimEditor(idRef.current);
    setOwner(runtime.currentEditor());
    return function () {
      release();
      setOwner(runtime.currentEditor());
    };
  }, []);

  React.useEffect(function () {
    return runtime.subscribeEditor(function (value) { setOwner(value); });
  }, []);

  /* 全屏时非浮层的实例让位；同时挂载多个实例时，只有最新的那个真正渲染编辑器。 */
  if (fullscreen && !inOverlay) return h(AwayCard, null);
  if (!inOverlay && owner && owner !== idRef.current) return h(AwayCard, null);
  return h(Page, Object.assign({}, props || {}, { scope }));
}

module.exports = { SlotPage: SlotPage };
