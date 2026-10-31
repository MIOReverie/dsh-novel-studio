'use strict';

/**
 * 极简 i18n：中文原文即 key，英文走内置对照表。
 * 语言来自 DSH 的 locale 服务（configure(ctx) 里通过 ctx.get('locale') 读取），
 * 拿不到就默认中文。
 */

const EN = {
  '墨枢': 'Moshu',

  /* 视图 / 导航 */
  '创作空间': 'Writing Studio',
  '故事大纲': 'Story Outline',
  '世界资料': 'World Library',
  '世界地图': 'World Map',
  '时间线': 'Timeline',
  '故事时间线': 'Story Timeline',
  'AI 记忆': 'AI Memory',
  '任务中心': 'Task Center',
  'DSH 任务中心': 'DSH Task Center',
  '切换视图': 'Switch view',
  '视图': 'View',
  '当前视图': 'Current view',

  /* 标题与副标题 */
  '让每一个想法，都有迹可循。': 'So every idea leaves a trail.',
  '从一条主线，到一整个世界。': 'From a single thread to a whole world.',
  '你创造的每个人，都被认真记住。': 'Everyone you create is remembered properly.',
  '故事发生的每一寸土地。': 'Every inch of ground the story happens on.',
  '因果相接，万事有迹。': 'Cause meets effect, and everything leaves a mark.',
  '理解你的故事，而不只是文字。': 'It follows your story, not just your prose.',
  '所有智能工作，都清晰可控。': 'Every AI job, clear and under control.',

  /* 顶部动作 */
  '搜索作品中的任何内容': 'Search anything in this manuscript',
  '搜索作品': 'Search the manuscript',
  '打开搜索': 'Open search',
  '关闭搜索': 'Close search',
  '搜索': 'Search',
  '关闭': 'Close',
  '导出作品': 'Export manuscript',
  '导出': 'Export',
  '已保存到本地': 'Saved locally',
  '已保存': 'Saved',
  '已保存 · {time}': 'Saved · {time}',
  '正在保存…': 'Saving…',
  '本地': 'Local',
  '模型状态': 'Model status',
  '模型不可用': 'Model unavailable',
  '本地模型': 'Local model',
  '已连接': 'Connected',

  /* 标题区统计 */
  '总字数': 'words',
  '章节': 'chapters',
  '待处理批注': 'open notes',

  /* 底部状态栏 */
  'Markdown 源文件': 'Markdown source',
  '工作区': 'Workspace',

  /* 搜索弹窗 */
  '搜索章节、人物、设定与记忆…': 'Search chapters, characters, lore and memory…',
  '没有找到“{q}”相关内容': 'Nothing matches “{q}”',
  '从一个词，找到整个世界': 'One word, and the whole world opens',
  '可搜索正文、人物、世界观和 AI 记忆': 'Looks through prose, characters, worldbuilding and AI memory',
  '正文': 'Prose',
  '人物': 'Characters',
  '设定': 'Lore',
  '记忆': 'Memory',

  /* 提示与错误 */
  '正在导出完整 Markdown 稿件': 'Exporting the full Markdown manuscript',
  '批注保存失败': 'Could not save the notes',
  '地图已保存': 'Map saved',
  '记忆已更新': 'Memory updated',
  '只能保存 Markdown 文档': 'Only Markdown documents can be saved',
  '请求未完成，请重试': 'The request did not complete. Please try again.',
  '未命名': 'Untitled',
  '未命名文档': 'Untitled document',
  '重试': 'Retry',

  /* 首次加载 / 致命错误 */
  '正在加载作品…': 'Loading the manuscript…',
  '墨枢暂时无法连接本地服务': 'Moshu cannot reach the local service right now',

  /* 视图占位 */
  '该视图暂时不可用': 'This view is not available yet',
  '视图组件未能加载': 'The view component did not load',

  /* 新增视图（v2） */
  'AI 工作台': 'AI Workbench',
  '让工作台顺手一点。': 'Make the workbench fit the way you write.',

  /* 当前书籍 / BookMenu */
  '当前书籍': 'Current work',
  '切换书籍': 'Switch work',
  '当前作品': 'Current work',
  '本书': 'This work',
  '书名': 'Title',
  '输入新书名': 'Enter a new title',
  '新建作品': 'New work',
  '创建': 'Create',
  '正在切换…': 'Switching…',
  '改名': 'Rename',
  '保存': 'Save',
  '取消': 'Cancel',
  '移到回收站': 'Move to trash',
  '确定把《{name}》移到回收站？': 'Move “{name}” to the trash?',
  '会移到 novels/.trash，不会真正删除，之后可以手动找回。': 'It goes to novels/.trash — nothing is deleted, and you can pull it back by hand later.',
  '书名不能为空': 'The title cannot be empty',
  '书名最多 40 个字': 'The title can be at most 40 characters',
  '书名不能是 . 或 ..': 'The title cannot be . or ..',
  '书名不能以「.」开头（这个前缀留给内部目录）': 'The title cannot start with “.” (that prefix is reserved for internal folders)',
  '书名不能包含 \\ / : * ? " < > |': 'The title cannot contain \\ / : * ? " < > |',
  '已有同名作品': 'A work with that name already exists',
  '还没有其他作品，先新建一个吧': 'No works yet — create the first one',
  '最近修改 {time}': 'updated {time}',
  '{n} 章': '{n} chapters',
  '{n} 章 · {w} 字': '{n} chapters · {w} words',
  '已切换到《{name}》': 'Switched to “{name}”',
  '已新建《{name}》': 'Created “{name}”',
  '已改名为《{name}》': 'Renamed to “{name}”',
  '《{name}》已移到回收站': 'Moved “{name}” to the trash',
  '章': 'chapters',
  '字': 'words',

  /* 模型菜单 */
  '模型': 'Model',
  '切换模型': 'Switch model',
  '模型通道': 'Model channel',
  '刷新列表': 'Refresh list',
  '正在刷新…': 'Refreshing…',
  '模型列表已刷新': 'Model list refreshed',
  '搜索模型…': 'Search models…',
  '搜索模型': 'Search models',
  '当前模型': 'Current model',
  '未设置': 'Not set',
  '没有匹配的模型': 'No model matches that',
  '宿主没有提供任何可选模型': 'The host exposes no selectable models',
  '没有可用模型': 'No models available',
  '已切换到 {model}': 'Switched to {model}',
  '关闭菜单': 'Close menu',

  /* 设置页 / 降级提示 */
  '设置': 'Settings',
  '偏好设置': 'Preferences',
  '模型列表': 'Model list',
  '书籍': 'Works',
  '已保存设置': 'Settings saved',
  '设置保存失败': 'Could not save the settings',
  '部分功能暂时不可用：': 'Some parts are unavailable: ',
  '重新加载': 'Reload',
};

let currentLocale = 'zh';

function normalize(value) {
  if (value === null || value === undefined) return '';
  return String(value).trim().toLowerCase();
}

function readFromContext(ctx) {
  if (!ctx) return '';
  try {
    if (typeof ctx.get === 'function') {
      const service = ctx.get('locale');
      if (service) {
        if (typeof service.getLocale === 'function') return normalize(service.getLocale());
        if (typeof service.getLocaleSync === 'function') return normalize(service.getLocaleSync());
        if (typeof service.locale === 'string') return normalize(service.locale);
        if (typeof service.current === 'string') return normalize(service.current);
        if (typeof service.currentLocale === 'string') return normalize(service.currentLocale);
      }
    }
    if (typeof ctx.getLocale === 'function') return normalize(ctx.getLocale());
    if (typeof ctx.locale === 'string') return normalize(ctx.locale);
  } catch (error) {
    return '';
  }
  return '';
}

/** 由 index.jsx 的 configure(ctx) 调用；返回最终生效的语言标记。 */
function configure(ctx) {
  const next = readFromContext(ctx);
  if (next) currentLocale = next;
  return currentLocale;
}

function setLocale(value) {
  currentLocale = normalize(value) || 'zh';
  return currentLocale;
}

function getLocale() {
  return currentLocale;
}

function isEnglish() {
  return currentLocale.indexOf('en') === 0;
}

function interpolate(text, vars) {
  if (!vars) return text;
  return text.replace(/\{(\w+)\}/g, function (match, key) {
    return Object.prototype.hasOwnProperty.call(vars, key) ? String(vars[key]) : match;
  });
}

/** t('中文原文', { name: 'x' }) —— 英文缺省回退中文。 */
function t(text, vars) {
  if (text === null || text === undefined) return '';
  const key = String(text);
  let out = key;
  if (isEnglish() && Object.prototype.hasOwnProperty.call(EN, key)) out = EN[key];
  return interpolate(out, vars);
}

module.exports = { t: t, configure: configure, setLocale: setLocale, getLocale: getLocale, isEnglish: isEnglish, translations: EN };
