'use strict';

/*
 * 墨枢 · DSH 插件 Client 半的出口。
 *
 * client.js（由 dsh-plugin/build.mjs 生成）只认这里导出的：
 *   Page / Icon / label / configure / toolViews / conversationView
 */

const React = require('react');
const pageModule = require('./page');
const icons = require('./icons');
const strings = require('./strings');
const runtime = require('./runtime');
const novelToolViews = require('./novel/ToolViews');
const { ConversationWorkbench } = require('./shell/ConversationWorkbench');
const { WorkbenchOverlay } = require('./shell/WorkbenchOverlay');
const { SlotPage } = require('./shell/SlotPage');

const Page = pageModule.Page;

/** 左侧栏图标：线性笔尖，选中时略加粗。 */
const Icon = function MoshuSidebarIcon(props) {
  const size = props && props.size ? props.size : 20;
  const active = Boolean(props && props.active);
  return (
    <icons.PenLine
      size={size}
      className={'moshu-sidebar-icon' + (active ? ' is-active' : '')}
      strokeWidth={active ? 2 : 1.65}
    />
  );
};

function label() {
  return '墨枢 · 小说工作台';
}

/**
 * DSH 传进来的 ctx。三件事：
 * 1. 读 locale 决定 t() 用中文还是英文；
 * 2. 存进 runtime，让「创作模式」面板能启动/切换会话；
 * 3. 什么都不做也不能抛错——抛了整页注册就没了。
 */
function configure(ctx) {
  try {
    strings.configure(ctx);
  } catch (error) {
    /* 拿不到 locale 就用默认中文 */
  }
  try {
    runtime.setCtx(ctx);
  } catch (error) {
    /* 没有 ctx 时创作模式会退化提示"请手动开会话" */
  }
}

/**
 * 小说工具在 Harness 对话里的专用卡片。
 * build.mjs 会把这些逐个注册进 `tool.call.toolview` 插槽（key = 线上工具名）。
 */
const toolViews = novelToolViews.toolViews;

/**
 * 工作台在对话里的 View：和 对话 / 轨迹 / 上下文 / 网页预览 并排的一个 tab。
 * build.mjs 会把它注册进 `conversation.view`。
 */
const conversationView = {
  id: 'moshu',
  order: 25,
  label: function () { return '墨枢'; },
  Component: ConversationWorkbench
};

/**
 * 全屏工作台：挂在 `shell.overlay`（整帧浮层，盖住所有列）。
 * 对话里那排 tab 下面永远压着一个输入框，写作区被压掉一截；想写满就走浮层。
 * 同一时刻只允许一个工作台实例在编辑，全屏时内嵌 View 会退化成提示卡。
 */
const overlayView = {
  id: 'moshu-fullscreen',
  order: 50,
  Component: WorkbenchOverlay
};

module.exports = {
  /* **不在侧边栏加入口**：工作台只从对话里的「墨枢」tab 进入（点 tab 后进全屏浮层）。
     侧边栏入口会和宿主自己的面板列抢位置，也没必要多一个入口。 */
  sidebarPanel: false,
  /* 主区面板挂的是「带单实例守卫」的 SlotPage，而不是裸 Page。 */
  Page: SlotPage,
  Icon: Icon,
  label: label,
  configure: configure,
  toolViews: toolViews,
  conversationView: conversationView,
  overlayView: overlayView
};
