'use strict';

/**
 * 小说工具在 Harness 对话里的专用卡片。
 *
 * 宿主把工具卡渲染在 `tool.call.toolview` 插槽里（key = 线上工具名），
 * 传进来的 props 形状（实测自 dsh-client-ui-conversation 的 records.d.ts）：
 *
 *   phase: 'preparing' | 'start' | 'result'
 *   - start  → block.argsRaw（JSON 字符串）
 *   - result → block.args（已解析对象）、block.content（ContentBlock[]）、
 *              block.isError、block.error、block.meta
 *
 * 任何字段都可能是空的（窗口截断、正在准备），所以这里全部走可选读取，
 * 读不到就退化成一行紧凑文本，绝不因为形状不符而抛错（抛了会空白整张卡）。
 */

const React = require('react');
const icons = require('../icons');
const css = require('./novel-tools.css');

const h = React.createElement;

/* ------------------------------------------------------------------ 取值 */

function parseArgs(props) {
  const block = props && props.block;
  if (!block) return {};
  if (typeof block.argsRaw === 'string' && block.argsRaw) {
    try {
      const parsed = JSON.parse(block.argsRaw);
      return parsed && typeof parsed === 'object' ? parsed : {};
    } catch (error) {
      return {};
    }
  }
  const args = block.args;
  return args && typeof args === 'object' ? args : {};
}

/** result 阶段的结构化结果：优先 meta，其次把 content 里的文本拼起来再尝试 JSON。 */
function parseResult(props) {
  const block = props && props.block;
  if (!block || (props && props.phase !== 'result')) return null;
  if (block.meta && typeof block.meta === 'object') return block.meta;
  const content = Array.isArray(block.content) ? block.content : [];
  const text = content
    .map((item) => (item && item.type === 'text' ? String(item.text || '') : ''))
    .join('')
    .trim();
  if (!text) return { ok: !block.isError, text: '' };
  try {
    const parsed = JSON.parse(text);
    if (parsed && typeof parsed === 'object') return parsed;
  } catch (error) {
    /* 不是 JSON 就是纯文本结果（读/检索类） */
  }
  return { ok: !block.isError, text: text };
}

function isError(props, result) {
  const block = props && props.block;
  if (block && block.isError) return true;
  return Boolean(result && result.ok === false);
}

function shortPath(value) {
  const text = String(value || '');
  return text || '（未指定）';
}

function charCount(value) {
  return String(value || '').replace(/\s/g, '').length;
}

/* ------------------------------------------------------------------ 结构 */

function Card(props) {
  const result = parseResult(props);
  const failed = isError(props, result);
  const running = props.phase !== 'result';
  const glyph = props.glyph || 'FileText';
  const Glyph = icons[glyph] || icons.FileText;
  const stateClass = failed ? ' is-error' : running ? ' is-running' : ' is-ok';

  return h(
    'div',
    { className: 'moshu-toolcard' + stateClass },
    h('style', { dangerouslySetInnerHTML: { __html: css } }),
    h(
      'div',
      { className: 'moshu-toolcard-head' },
      h('span', { className: 'moshu-toolcard-glyph' }, h(Glyph, { size: 14 })),
      h('span', { className: 'moshu-toolcard-title' }, props.title),
      props.badge ? h('span', { className: 'moshu-toolcard-badge' + (props.badgeTone ? ' is-' + props.badgeTone : '') }, props.badge) : null,
      running ? h('span', { className: 'moshu-toolcard-state' }, h(icons.LoaderCircle, { size: 12, className: 'is-spinning' }), '运行中') : null,
      failed ? h('span', { className: 'moshu-toolcard-state' }, h(icons.X, { size: 12 }), '未完成') : null,
    ),
    props.rows && props.rows.length
      ? h(
        'dl',
        { className: 'moshu-toolcard-rows' },
        props.rows.map((row, index) => h(
          'div',
          { className: 'moshu-toolcard-row', key: row.label + index },
          h('dt', null, row.label),
          h('dd', { className: row.mono ? 'is-mono' : undefined }, row.value),
        )),
      )
      : null,
    props.note ? h('p', { className: 'moshu-toolcard-note' }, props.note) : null,
    props.text ? h('pre', { className: 'moshu-toolcard-text' }, props.text) : null,
  );
}

/* ------------------------------------------------------------------ 各工具卡 */

/** 改章节正文：唯一需要作者审批的工具，卡片要把"改了哪一章、多少字"说清楚。 */
function EditChapterCard(props) {
  const args = parseArgs(props);
  const result = parseResult(props);
  const mode = args.mode === 'append' ? '追加' : '整章替换';
  const bytes = charCount(args.content);
  const rows = [
    { label: '章节', value: shortPath(args.path), mono: true },
    { label: '方式', value: mode },
    { label: '字（去空白）', value: bytes.toLocaleString('zh-CN') },
  ];
  if (result && result.backup) rows.push({ label: '旧稿备份', value: shortPath(result.backup), mono: true });
  if (result && typeof result.mtime === 'number') rows.push({ label: '写入时间', value: new Date(result.mtime).toLocaleString('zh-CN') });
  const refused = result && result.ok === false ? String(result.message || '') : '';
  return h(Card, {
    phase: props.phase,
    block: props.block,
    glyph: 'PenLine',
    title: '改小说正文',
    badge: '需要你同意',
    badgeTone: 'warn',
    rows: rows,
    note: refused || args.reason || '正文属于作者，这一改必须经你点同意才会落盘。',
  });
}

/** 写资料区：免审批，但要能一眼看出写到哪个文件。 */
function WriteReferenceCard(props) {
  const args = parseArgs(props);
  const result = parseResult(props);
  const modeText = args.mode === 'append' ? '追加' : args.mode === 'replace' ? '覆盖' : '新建';
  const rows = [
    { label: '资料', value: shortPath(args.path), mono: true },
    { label: '方式', value: modeText },
    { label: '字（去空白）', value: charCount(args.content).toLocaleString('zh-CN') },
  ];
  if (result && result.backup) rows.push({ label: '旧稿备份', value: shortPath(result.backup), mono: true });
  return h(Card, {
    phase: props.phase,
    block: props.block,
    glyph: 'LibraryBig',
    title: '更新资料区',
    badge: '免审批',
    badgeTone: 'ok',
    rows: rows,
    note: result && result.ok === false ? String(result.message || '') : null,
  });
}

function DeleteReferenceCard(props) {
  const args = parseArgs(props);
  const result = parseResult(props);
  return h(Card, {
    phase: props.phase,
    block: props.block,
    glyph: 'X',
    title: '删除资料',
    badge: '免审批',
    badgeTone: 'warn',
    rows: [{ label: '资料', value: shortPath(args.path), mono: true }],
    note: result && result.ok === false
      ? String(result.message || '')
      : '已移到作品的 .trash，可以找回。',
  });
}

function ReadToolCard(props) {
  const args = parseArgs(props);
  const result = parseResult(props);
  const text = result && typeof result.text === 'string' ? result.text : '';
  const lines = text ? text.split('\n') : [];
  const preview = lines.slice(0, 24).join('\n');
  const rows = [{ label: '文档', value: shortPath(args.path), mono: true }];
  if (lines.length) rows.push({ label: '行数', value: lines.length.toLocaleString('zh-CN') });
  return h(Card, {
    phase: props.phase,
    block: props.block,
    glyph: 'FileText',
    title: '读作品',
    rows: rows,
    text: lines.length > 24 ? preview + '\n…' : preview,
    note: lines.length > 24 ? '只显示前 24 行，模型看到的是完整内容。' : null,
  });
}

function SearchToolCard(props) {
  const args = parseArgs(props);
  const result = parseResult(props);
  const text = result && typeof result.text === 'string' ? result.text : '';
  const hits = (text.match(/^.+?:\d+:/gm) || []).length;
  return h(Card, {
    phase: props.phase,
    block: props.block,
    glyph: 'Search',
    title: '全书检索',
    rows: [
      { label: '关键词', value: shortPath(args.query) },
      hits ? { label: '命中', value: String(hits) } : null,
    ].filter(Boolean),
  });
}

function ListToolCard(props) {
  const args = parseArgs(props);
  const result = parseResult(props);
  const text = result && typeof result.text === 'string' ? result.text : '';
  const count = (text.match(/^- /gm) || []).length;
  return h(Card, {
    phase: props.phase,
    block: props.block,
    glyph: 'LibraryBig',
    title: '列出作品文档',
    rows: [
      args.type ? { label: '类型', value: String(args.type) } : null,
      count ? { label: '篇数', value: String(count) } : null,
    ].filter(Boolean),
  });
}

function OverviewCard(props) {
  const result = parseResult(props);
  const text = result && typeof result.text === 'string' ? result.text : '';
  const first = text.split('\n').filter((line) => line.trim()).slice(0, 5).join('\n');
  return h(Card, {
    phase: props.phase,
    block: props.block,
    glyph: 'BookOpen',
    title: '作品概览',
    text: first,
  });
}

/** 其余（批注、审阅）用通用卡，避免为小工具写一堆重复代码。 */
function GenericNovelCard(props) {
  const args = parseArgs(props);
  const result = parseResult(props);
  const text = result && typeof result.text === 'string' ? result.text : '';
  const rows = [];
  if (args.path) rows.push({ label: '对象', value: shortPath(args.path), mono: true });
  if (args.quote) rows.push({ label: '引用', value: String(args.quote).slice(0, 60) });
  return h(Card, {
    phase: props.phase,
    block: props.block,
    glyph: 'MessageSquareText',
    title: props.title || '小说工具',
    rows: rows,
    text: text ? text.split('\n').slice(0, 10).join('\n') : null,
  });
}

const AnnotateCard = function AnnotateCard(props) {
  const args = parseArgs(props);
  const result = parseResult(props);
  return h(Card, {
    phase: props.phase,
    block: props.block,
    glyph: 'MessageSquareText',
    title: '写批注（不动正文）',
    badge: '免审批',
    badgeTone: 'ok',
    rows: [
      { label: '章节', value: shortPath(args.path), mono: true },
      args.quote ? { label: '引用', value: String(args.quote).slice(0, 60) } : null,
      result && typeof result.total === 'number' ? { label: '本章批注', value: String(result.total) } : null,
    ].filter(Boolean),
  });
};

const ReviewCard = function ReviewCard(props) {
  const result = parseResult(props);
  const text = result && typeof result.text === 'string' ? result.text : '';
  return h(Card, {
    phase: props.phase,
    block: props.block,
    glyph: 'ScanSearch',
    title: '审阅章节',
    rows: result && typeof result.dropped === 'number' && result.dropped > 0
      ? [{ label: '丢弃', value: `${result.dropped} 条（引用定位不到）` }]
      : [],
    text: text ? text.split('\n').slice(0, 12).join('\n') : null,
  });
};


/** 客户端版的取值助手（宿主那边的 asText 不在这里）。 */
function textOf(value) {
  return typeof value === 'string' ? value : (value === undefined || value === null ? '' : String(value));
}

/* ------------------------------------------------------------------ 地图 / 新工具 */

/** 地图读取：把计数摊开，一眼看清这份地图有什么。 */
const MapReadCard = function MapReadCard(props) {
  const result = parseResult(props);
  const counts = (result && result.counts) || {};
  const rows = [
    { label: '陆地', value: String(counts.landmasses ?? 0) + ' 块' },
    { label: '山脉', value: String(counts.mountains ?? 0) + ' 座' },
    { label: '森林', value: String(counts.forests ?? 0) + ' 片' },
    { label: '地貌', value: String(counts.terrain ?? 0) + ' 处' },
    { label: '河流', value: String(counts.rivers ?? 0) + ' 条' },
    { label: '地点', value: String(counts.locations ?? 0) + ' 个' },
  ];
  if (result && result.width) rows.push({ label: '画布', value: result.width + ' × ' + result.height, mono: true });
  return h(Card, {
    phase: props.phase,
    block: props.block,
    glyph: 'Map',
    title: '读地图',
    rows,
  });
};

/** 地图写入 / 细粒度编辑：说明改了什么。 */
const MapEditCard = function MapEditCard(props) {
  const args = parseArgs(props);
  const result = parseResult(props);
  const name = textOf(args && args.name) || textOf(args && args.kind) || '';
  const rows = [];
  if (name) rows.push({ label: '目标', value: name });
  const action = textOf(args && args.action);
  if (action) rows.push({ label: '动作', value: action });
  const terrain = textOf(args && args.terrain);
  if (terrain) rows.push({ label: '地貌', value: terrain });
  if (result && result.text) rows.push({ label: '结果', value: String(result.text).slice(0, 80) });
  return h(Card, {
    phase: props.phase,
    block: props.block,
    glyph: 'Map',
    title: '改地图',
    rows,
  });
};

/** 章节管理：改名 / 移动 / 删除，都是要审批的目录操作。 */
const ChapterManageCard = function ChapterManageCard(props) {
  const args = parseArgs(props);
  const result = parseResult(props);
  const action = textOf(args && args.action);
  const label = action === 'rename' ? '重命名章节' : action === 'move' ? '移动章节' : action === 'delete' ? '删除章节' : '管理章节';
  const rows = [];
  if (args && args.path) rows.push({ label: '章节', value: String(args.path), mono: true });
  if (args && args.title) rows.push({ label: '新标题', value: String(args.title) });
  if (args && args.direction) rows.push({ label: '方向', value: args.direction === 'up' ? '上移' : '下移' });
  if (result && result.path) rows.push({ label: '结果', value: String(result.path), mono: true });
  return h(Card, {
    phase: props.phase,
    block: props.block,
    glyph: 'BookOpen',
    title: label,
    badge: '需审批',
    badgeTone: 'warn',
    rows,
  });
};

/** 写记忆：写进被注入的那份 memory.json。 */
const MemoryWriteCard = function MemoryWriteCard(props) {
  const args = parseArgs(props);
  const result = parseResult(props);
  const rows = [];
  if (args && args.title) rows.push({ label: '标题', value: String(args.title) });
  if (args && args.type) rows.push({ label: '分类', value: String(args.type) });
  if (args && args.locked) rows.push({ label: '优先级', value: '锁定（注入时最前）' });
  if (result && typeof result.total === 'number') rows.push({ label: '记忆总数', value: String(result.total) });
  return h(Card, {
    phase: props.phase,
    block: props.block,
    glyph: 'BrainCircuit',
    title: result && result.replaced ? '更新记忆' : '新增记忆',
    rows,
    text: args && args.content ? String(args.content).slice(0, 160) : null,
  });
};

/** 读批注 / 读任务：只读，给一个计数就够。 */
const ReadOnlyListCard = function ReadOnlyListCard(props) {
  const result = parseResult(props);
  const label = props.title || '读取';
  const rows = [];
  if (result && typeof result.total === 'number') rows.push({ label: '总条数', value: String(result.total) });
  if (result && typeof result.matched === 'number') rows.push({ label: '匹配', value: String(result.matched) });
  const list = (result && (result.annotations || result.tasks)) || [];
  if (Array.isArray(list) && list.length) {
    rows.push({ label: '最近一条', value: String((list[0] && (list[0].comment || list[0].title || list[0].quote)) || '').slice(0, 60) });
  }
  return h(Card, { phase: props.phase, block: props.block, glyph: props.glyph || 'Search', title: label, rows, text: result && result.text ? String(result.text).slice(0, 200) : null });
};


/** 地貌面：说清楚改的是哪一片、什么类型、多少顶点。 */
const MapTerrainCard = function MapTerrainCard(props) {
  const args = parseArgs(props);
  const result = parseResult(props);
  const action = textOf(args && args.action) || 'add';
  const title = action === 'remove' ? '删除地貌' : action === 'update' ? '改地貌' : '画地貌';
  const rows = [];
  const kind = textOf(args && args.kind);
  if (kind) rows.push({ label: '类型', value: kind });
  const points = (args && Array.isArray(args.points)) ? args.points : [];
  if (points.length) rows.push({ label: '顶点', value: points.length + ' 个' });
  const id = textOf(args && args.id);
  if (id) rows.push({ label: 'id', value: id, mono: true });
  if (result && result.text) rows.push({ label: '结果', value: String(result.text).slice(0, 80) });
  return h(Card, { phase: props.phase, block: props.block, glyph: 'Mountain', title, rows });
};


/** AI 画素材：显示画了什么、叫什么、有没有直接贴到地图上。 */
const MapDrawCard = function MapDrawCard(props) {
  const args = parseArgs(props);
  const result = parseResult(props);
  const rows = [];
  if (args && args.name) rows.push({ label: '名称', value: String(args.name) });
  if (result && result.id) rows.push({ label: '素材 id', value: String(result.id), mono: true });
  if (result && result.placed) rows.push({ label: '放置', value: '已贴到地图上' });
  const svg = textOf(args && args.svg);
  return h(Card, {
    phase: props.phase,
    block: props.block,
    glyph: 'PenLine',
    title: 'AI 画图',
    rows,
    note: result && result.text ? String(result.text).slice(0, 120) : null,
    text: svg ? svg.slice(0, 300) : null,
  });
};

/** 素材清单：列出这本书已有的 AI 素材。 */
const MapAssetsCard = function MapAssetsCard(props) {
  const result = parseResult(props);
  const list = (result && result.assets) || [];
  const rows = [];
  if (result && typeof result.total === 'number') rows.push({ label: '素材', value: String(result.total) + ' 个' });
  if (list.length) rows.push({ label: '最近', value: list.slice(-4).map((a) => a.name || a.id).join('、') });
  return h(Card, { phase: props.phase, block: props.block, glyph: 'LibraryBig', title: '素材库', rows });
};


/** 时间线写入：告诉作者"从正文里提出了哪几件事"。 */
const TimelineWriteCard = function TimelineWriteCard(props) {
  const args = parseArgs(props);
  const result = parseResult(props);
  const action = textOf(args && args.action) || 'add';
  const title = action === 'replace' ? '重写时间线' : action === 'update' ? '改时间线事件' : action === 'remove' ? '删时间线事件' : '提取时间线';
  const rows = [];
  if (args && args.title) rows.push({ label: '事件', value: String(args.title) });
  if (args && args.date) rows.push({ label: '时间', value: String(args.date) });
  if (args && Array.isArray(args.characters) && args.characters.length) rows.push({ label: '人物', value: args.characters.join('、') });
  if (args && args.chapterTitle) rows.push({ label: '章节', value: String(args.chapterTitle) });
  if (result && typeof result.total === 'number') rows.push({ label: '共', value: result.total + ' 条' });
  return h(Card, { phase: props.phase, block: props.block, glyph: 'Route', title, rows });
};

/** 时间线读取：计数 + 前几条。 */
const TimelineReadCard = function TimelineReadCard(props) {
  const result = parseResult(props);
  const events = (result && result.events) || [];
  const rows = [];
  if (result && typeof result.total === 'number') rows.push({ label: '事件', value: String(result.total) + ' 条' });
  if (events.length) rows.push({ label: '最近', value: events.slice(-3).map((e) => e.title).join('；').slice(0, 80) });
  return h(Card, { phase: props.phase, block: props.block, glyph: 'Route', title: '读时间线', rows });
};


/** 批量改章节：一次审批，列出改了哪几章。 */
const ChapterBatchCard = function ChapterBatchCard(props) {
  const args = parseArgs(props);
  const result = parseResult(props);
  const edits = (args && Array.isArray(args.edits)) ? args.edits : [];
  const rows = [];
  if (edits.length) rows.push({ label: '章节', value: edits.length + ' 章' });
  if (args && args.reason) rows.push({ label: '目的', value: String(args.reason).slice(0, 60) });
  if (result && typeof result.written === 'number') rows.push({ label: '结果', value: result.written + ' / ' + (result.planned || edits.length) + ' 章' });
  return h(Card, {
    phase: props.phase,
    block: props.block,
    glyph: 'PenLine',
    title: '批量改正文',
    badge: '一次审批',
    badgeTone: 'warn',
    rows,
    note: edits.length ? edits.slice(0, 6).map((item) => (item && item.path) || '').filter(Boolean).join('\n') : null,
  });
};

/**
 * client.js 的 apply 按这里的 key 注册到 `tool.call.toolview`。
 * key 必须与 host/novel-tools.js 里的工具名逐字一致——打错一个字母就退回通用卡。
 */
const toolViewList = [
  { key: 'novel_edit_chapter', Component: EditChapterCard },
  { key: 'novel_write_reference', Component: WriteReferenceCard },
  { key: 'novel_delete_reference', Component: DeleteReferenceCard },
  { key: 'novel_read', Component: ReadToolCard },
  { key: 'novel_search', Component: SearchToolCard },
  { key: 'novel_list', Component: ListToolCard },
  { key: 'novel_overview', Component: OverviewCard },
  { key: 'novel_annotate_chapter', Component: AnnotateCard },
  { key: 'novel_review', Component: ReviewCard },
  /* 章节管理 / 记忆 / 只读检索：新增工具都要有自己的卡，否则会退回通用卡。 */
  { key: 'novel_chapter_manage', Component: ChapterManageCard },
  { key: 'novel_chapter_batch', Component: ChapterBatchCard },
  { key: 'novel_memory_write', Component: MemoryWriteCard },
  { key: 'novel_annotations_read', Component: (props) => h(ReadOnlyListCard, { ...props, title: '读批注' }) },
  { key: 'novel_tasks_read', Component: (props) => h(ReadOnlyListCard, { ...props, title: '读任务', glyph: 'Activity' }) },
  /* 地图：8 个工具全覆盖。 */
  { key: 'novel_map_read', Component: MapReadCard },
  { key: 'novel_map_write', Component: MapEditCard },
  { key: 'novel_map_add_land', Component: MapEditCard },
  { key: 'novel_map_update_land', Component: MapEditCard },
  { key: 'novel_map_place', Component: MapEditCard },
  { key: 'novel_map_stamps', Component: MapEditCard },
  { key: 'novel_map_line', Component: MapEditCard },
  { key: 'novel_map_terrain', Component: MapTerrainCard },
  { key: 'novel_map_draw', Component: MapDrawCard },
  { key: 'novel_map_assets', Component: MapAssetsCard },
  { key: 'novel_timeline_read', Component: TimelineReadCard },
  { key: 'novel_timeline_write', Component: TimelineWriteCard },
  { key: 'novel_map_remove', Component: MapEditCard }
];

module.exports = {
  toolViews: toolViewList,
  GenericNovelCard: GenericNovelCard
};
