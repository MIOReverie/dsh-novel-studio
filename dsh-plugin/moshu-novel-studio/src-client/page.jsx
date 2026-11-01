'use strict';

/**
 * 墨枢 · 整页外壳。
 * 顶栏（当前书籍 + 视图 tab + 动作）+ 标题区 + 主区 + 底部状态栏。
 * 视图内部实现由 components/* / shell/* 提供，这里只负责编排与状态。
 *
 * 第二轮（CONTRACT-v2）新增职责：
 *   - 书籍：books / currentBook / BookMenu；切书后重新 bootstrap、重置 chapterId、清搜索、toast。
 *   - 模型：只读展示（模型由 DSH 会话决定，工作台不再单独选模型）。
 *   - 设置：settings + meta；AI 工作台与设置两个视图 tab；saveSettings 后按需重新 bootstrap。
 *   - 启动并行 getBooks() + getSettings() + getModels() + bootstrap；前三个失败降级为只读提示，不白屏。
 *
 * 第三轮（CONTRACT-v3 §3）新增职责：
 *   - 未保存正文上提：draftsRef（path → {content, at}）。编辑器实例销毁后草稿仍在，
 *     重挂时通过 initialDrafts 灌回编辑器；bootstrap 不会再用磁盘旧文本冲掉草稿。
 *   - 保存冲突改成队列：conflicts 数组（面板永远显示队首）+ solvedPaths（path → 解决时间），
 *     用来丢弃解决之后才到达的 409。
 *   - 保存回包按章归属：只有「这次保存的 path === 当前打开的那一章」才回写状态栏时间。
 */

const React = require('react');
const { useCallback, useEffect, useMemo, useRef, useState } = React;

const css = require('./styles.css');
const strings = require('./strings');
const icons = require('./icons');
const api = require('./api');
const runtime = require('./runtime');
const { relocateAnnotation } = require('./annotations');
const { BookMenu } = require('./shell/BookMenu');
const { ConflictDialog } = require('./components/ConflictDialog');

const t = strings.t;

const VIEW_ORDER = [
  { id: 'write', label: '创作空间', icon: 'PenLine' },
  { id: 'outline', label: '故事大纲', icon: 'Network' },
  { id: 'library', label: '世界资料', icon: 'LibraryBig' },
  { id: 'map', label: '世界地图', icon: 'Map' },
  { id: 'timeline', label: '时间线', icon: 'Route' },
  { id: 'memory', label: 'AI 记忆', icon: 'BrainCircuit' },
  { id: 'tasks', label: '任务中心', icon: 'Activity' },
  { id: 'overview', label: '总览', icon: 'Activity' },
  { id: 'settings', label: '设置', icon: 'Settings2' }
];

const TITLES = {
  write: ['创作空间', '让每一个想法，都有迹可循。'],
  outline: ['故事大纲', '从一条主线，到一整个世界。'],
  library: ['世界资料', '你创造的每个人，都被认真记住。'],
  map: ['世界地图', '故事发生的每一寸土地。'],
  timeline: ['故事时间线', '因果相接，万事有迹。'],
  memory: ['AI 记忆', '理解你的故事，而不只是文字。'],
  tasks: ['DSH 任务中心', '所有智能工作，都清晰可控。'],
  overview: ['总览', ''],
  settings: ['设置', '让工作台顺手一点。']
};

const VIEW_KEY = {
  write: 'Editor',
  outline: 'Outline',
  library: 'Library',
  map: 'MapView',
  timeline: 'Timeline',
  memory: 'Memory',
  tasks: 'Tasks',
  overview: 'Overview',
  settings: 'SettingsView'
};

const ISSUE_LABEL = {
  books: '书籍',
  settings: '偏好设置',
  models: '模型列表'
};

const EMPTY_MODELS = { current: null, providers: [], message: '' };
const EMPTY_META = { defaults: {}, ranges: {}, editable: [] };

/* 冲突解决之后多久之内到达的 409 算「迟到回包」：这种回包带的是解决前的 mtime，
   再去弹一次面板只会把作者刚做完的决定推翻掉。 */
const CONFLICT_SOLVED_TTL_MS = 5000;

/* ---- 视图组件：缺一个不影响整页加载（对应的 tab 会显示占位说明） ---- */
const VIEW_COMPONENTS = {};
/**
 * 这一篇算不算章节。
 *
 * 以前只看 `type === 'chapter'`：早期版本的 `applyDocumentContent` 按目录猜类型时
 * 漏掉了 `chapters/`，于是一章会被标成 `world`，从侧边栏整条消失 ——
 * 连它那一行的「重命名 / 删除」入口一起不见了。
 * 现在按类型**或**路径判定，历史数据不会再丢。
 */
function isChapterDoc(doc) {
  if (!doc || typeof doc !== 'object') return false;
  if (doc.type === 'chapter') return true;
  return typeof doc.path === 'string' && /^chapters\/.*\.md$/i.test(doc.path);
}

function registerView(key, factory) {
  try {
    const value = factory();
    VIEW_COMPONENTS[key] = typeof value === 'function' ? value : null;
  } catch (error) {
    VIEW_COMPONENTS[key] = null;
  }
}
registerView('Editor', function () { return require('./components/Editor').Editor; });
registerView('Outline', function () { return require('./components/Outline').Outline; });
registerView('Library', function () { return require('./components/Library').Library; });
registerView('MapView', function () { return require('./components/MapView').MapView; });
registerView('Timeline', function () { return require('./components/Timeline').Timeline; });
registerView('Memory', function () { return require('./components/Memory').Memory; });
registerView('Tasks', function () { return require('./components/Tasks').Tasks; });
registerView('Overview', function () { return require('./components/Overview').Overview; });
registerView('SettingsView', function () { return require('./shell/SettingsView').SettingsView; });

/* ---------------- 小工具 ---------------- */

function messageOf(reason) {
  if (!reason) return '';
  if (typeof reason === 'string') return reason;
  return reason.message ? String(reason.message) : String(reason);
}

function hasKey(object, key) {
  return Boolean(object) && Object.prototype.hasOwnProperty.call(object, key);
}

function bookTitleOf(book) {
  if (!book) return '';
  return String(book.title || book.name || book.id || '');
}

function formatClock(date) {
  try {
    return date.toLocaleTimeString(strings.isEnglish() ? 'en-US' : 'zh-CN', { hour: '2-digit', minute: '2-digit' });
  } catch (error) {
    return '';
  }
}

function formatNumber(value) {
  const number = Number(value);
  if (!isFinite(number)) return '0';
  try {
    return number.toLocaleString();
  } catch (error) {
    return String(number);
  }
}

function normalizeSettingsPayload(payload) {
  if (!payload || typeof payload !== 'object') return { settings: {}, meta: EMPTY_META };
  const wrapped = payload.settings && typeof payload.settings === 'object';
  return {
    settings: wrapped ? payload.settings : payload,
    meta: {
      defaults: payload.defaults && typeof payload.defaults === 'object' ? payload.defaults : {},
      ranges: payload.ranges && typeof payload.ranges === 'object' ? payload.ranges : {},
      editable: Array.isArray(payload.editable) ? payload.editable : []
    }
  };
}

function normalizeModelsPayload(payload) {
  if (!payload || typeof payload !== 'object') return EMPTY_MODELS;
  return {
    current: payload.current && typeof payload.current === 'object' ? payload.current : null,
    providers: Array.isArray(payload.providers) ? payload.providers : [],
    message: typeof payload.message === 'string' ? payload.message : ''
  };
}

function applyLocale(settings) {
  if (!settings || typeof settings !== 'object') return;
  const language = settings.language;
  if (typeof language === 'string' && language) {
    try { strings.setLocale(language); } catch (error) { /* 语言切换失败就用当前语言 */ }
  }
}

function firstChapterIdOf(project) {
  const documents = (project && project.documents) || [];
  const first = documents.filter(isChapterDoc)[0];
  return first ? first.id : '';
}

/** 文档 / 保存响应里的 mtime（毫秒）。没有就 null —— 后端还没上乐观锁时按无条件写处理。 */
function documentMtimeOf(payload) {
  if (typeof api.mtimeOf === 'function') return api.mtimeOf(payload);
  if (!payload || typeof payload !== 'object') return null;
  const value = payload.mtime !== undefined ? payload.mtime : payload.mtimeMs;
  return typeof value === 'number' && isFinite(value) ? value : null;
}

/* ---------------- 页面 ---------------- */

function Page(props) {
  /* 作用域属于**这个实例**：只有真正在渲染工作台的实例才设置全局作用域，
     让位的实例（AwayCard）不碰它。 */
  const scope = props && typeof props.scope === 'string' ? props.scope : '';
  if (typeof api.setScope === 'function') api.setScope(scope);
  /* inOverlay：从全屏浮层里渲染时不再显示「全屏」按钮（避免自己套自己）。 */
  const inOverlay = Boolean(props && props.inOverlay);
  const [project, setProject] = useState(null);
  const [view, setView] = useState('write');
  /* 专注写作：可以分别把顶栏、左侧目录藏起来。
     Ctrl+Shift+H 顶栏 · Ctrl+Shift+L 左侧栏（再按一次恢复）。 */
  const [hideTopbar, setHideTopbar] = useState(false);
  const [hideRail, setHideRail] = useState(false);

  /* 专注模式的按键：只改界面，不碰文档，所以放在最外层监听。 */
  useEffect(function () {
    function onKeyDown(event) {
      if (!event.ctrlKey || !event.shiftKey || event.altKey) return;
      const key = String(event.key || '').toLowerCase();
      if (key === 'h') {
        event.preventDefault();
        setHideTopbar(function (value) { return !value; });
      } else if (key === 'l') {
        event.preventDefault();
        setHideRail(function (value) { return !value; });
      }
    }
    window.addEventListener('keydown', onKeyDown);
    return function () { window.removeEventListener('keydown', onKeyDown); };
  }, []);
  const [chapterId, setChapterId] = useState('');
  const [error, setError] = useState('');
  const [search, setSearch] = useState(false);
  const [query, setQuery] = useState('');
  const [toast, setToast] = useState('');
  const [savedAt, setSavedAt] = useState(null);

  /* v2 新状态 */
  const [books, setBooks] = useState([]);
  const [currentBook, setCurrentBook] = useState(null);
  const [bookMenuOpen, setBookMenuOpen] = useState(false);
  const [models, setModels] = useState(EMPTY_MODELS);
  const [settings, setSettings] = useState({});
  const [settingsMeta, setSettingsMeta] = useState(EMPTY_META);
  const [issues, setIssues] = useState([]);
  const [bookBusy, setBookBusy] = useState(false);
  const [modelBusy, setModelBusy] = useState(false);

  const toastTimer = useRef(0);
  const aliveRef = useRef(true);

  /* ---- 保存冲突（乐观锁） ----
     mtimeByPath：path → 上次从磁盘读到/写回的 mtime（毫秒）。bootstrap 与每次保存成功都会更新；
                  PUT /document 带上它，磁盘被别人改过时 Host 回 409，不再静默覆盖。
     conflicts：排队中的冲突 [{ path, mine, disk, diskMtime }]，面板永远只显示队首。
                以前是一格 conflict，第二次 409 会把第一次的 mine 覆盖掉。
     solvedPaths：path → 解决时间（毫秒）。解决后 5 秒内同一 path 的 409 是迟到回包，直接丢弃。
     contentRevision：外部替换正文（选了「用磁盘版本」）后 +1，让 Editor 丢掉本地未保存快照。 */
  const mtimeByPath = useRef(Object.create(null));
  /* 服务端版本低于前端时置为非空 —— 直接给"重启 DSH"的提示，而不是让每个接口各自 404。 */
  const [hostOutdated, setHostOutdated] = useState(null);
  /* 空书架状态下的新建输入。 */
  const [newBookName, setNewBookName] = useState('');
  const [emptyShelfError, setEmptyShelfError] = useState('');
  /* 共享库里的书：每个对话有自己的书库之后，升级前建的书都留在共享库；
     会话书架一开始是空的，这里给一个「导入」入口，而不是让作者以为书丢了。 */
  const [sharedBooks, setSharedBooks] = useState([]);
  /* 编辑器的 flush 把手：切书前必须先把未保存正文写掉。 */
  const editorApiRef = useRef(null);
  const [conflicts, setConflicts] = useState([]);
  const [conflictBusy, setConflictBusy] = useState(false);
  const [conflictError, setConflictError] = useState('');
  const [contentRevision, setContentRevision] = useState(0);
  /** 全页是否有未保存的正文（Editor 上报 + 冲突未决），beforeunload 依据它提示。 */
  const unsavedRef = useRef(false);
  /* 徽标要反映真实脏状态：以前它只看 savedAt（只有「保存成功」时才更新），
     所以画着地图、改着资料时顶栏照样写「已保存到本地」。 */
  const [editorDirty, setEditorDirty] = useState(false);

  /* ---- 未保存正文的归属地（CONTRACT-v3 §3.1） ----
     draftsRef：path → { content, at }。编辑器每敲一个字就同步进来，
                所以 Editor 实例被卸载（切 tab / 切书 / 重挂）之后草稿仍然在这里。
     draftsVersion：草稿表的版本号，仅用来重建交给 Editor 的不可变快照。
     draftBookRef：草稿属于哪本作品；换书（作品身份变了）时整表作废——
                   同一个相对路径在另一本书里是另一份文件。 */
  const draftsRef = useRef(Object.create(null));
  const [draftsVersion, setDraftsVersion] = useState(0);
  const draftBookRef = useRef('');
  /* 解决冲突的时间表（迟到 409 的丢弃依据）。 */
  const solvedPathsRef = useRef(Object.create(null));
  /* 页面明确丢弃了哪些 path 的本地正文（path → 递增序号）。编辑器要据此丢掉自己那份快照，
     否则「页面已经没有这份草稿」和「编辑器还留着」两边对不上，切回该章又会写回被否定的旧文字。 */
  const [discardedPaths, setDiscardedPaths] = useState({});
  const discardSeqRef = useRef(0);
  /* 当前打开的那一章的 path：保存回包只有对上它才回写状态栏（CONTRACT-v3 §3.3）。 */
  const activePathRef = useRef('');

  /** 当前 chapterId 对应的文档 path（可能为空：还没选章节）。 */
  const currentPath = (function () {
    if (!project) return '';
    const docs = project.documents || [];
    for (let index = 0; index < docs.length; index += 1) {
      if (docs[index] && docs[index].id === chapterId) return String(docs[index].path || '');
    }
    return '';
  })();
  activePathRef.current = currentPath;
  /* 面板永远显示队首那一条冲突。 */
  const conflict = conflicts.length ? conflicts[0] : null;

  const notify = useCallback(function (message) {
    const text = typeof message === 'string' ? message : messageOf(message);
    if (!text) return;
    setToast(text);
    if (toastTimer.current) window.clearTimeout(toastTimer.current);
    toastTimer.current = window.setTimeout(function () { setToast(''); }, 3200);
  }, []);

  /* ---------------- 草稿（未保存正文的权威副本） ---------------- */

  /** Editor 每次输入都会调这里：草稿存在 page 上，组件实例销毁也不丢。 */
  const handleDraftChange = useCallback(function (path, content) {
    if (!path || typeof content !== 'string') return;
    draftsRef.current[path] = { content: content, at: Date.now() };
    setDraftsVersion(function (value) { return value + 1; });
  }, []);

  /**
   * 丢掉某个 path 的草稿。
   * 传了 content 时只在「草稿还是这一份」时才丢：保存飞行途中作者又敲了新字，
   * 那份新草稿必须留着（否则刚写的几个字随回包一起消失）。
   * Editor 传 onDraftClear(path) 过来时 content 为空 = 明确丢弃（换成磁盘版本 / 恢复备份 / 删章）。
   */
  const dropDraft = useCallback(function (path, content) {
    if (!path) return;
    const draft = draftsRef.current[path];
    if (!draft) return;
    if (typeof content === 'string' && draft.content !== content) return;
    delete draftsRef.current[path];
    setDraftsVersion(function (value) { return value + 1; });
  }, []);

  /** 交给 Editor 的只读快照：只在草稿表版本变化时重建，正常的重渲染不换引用。 */
  const draftsSnapshot = useMemo(function () {
    const source = draftsRef.current || {};
    const snapshot = {};
    Object.keys(source).forEach(function (path) {
      const entry = source[path];
      if (entry && typeof entry.content === 'string') snapshot[path] = { content: entry.content, at: entry.at };
    });
    return snapshot;
  }, [draftsVersion]);

  /**
   * bootstrap 拿到的新 project + 草稿 → 合并后的 project。
   * 有草稿的 path 保留草稿正文：切模型 / AI 刷新 / 手动重新加载都会 bootstrap，
   * 以前那次 setProject 会把 textarea 冲回磁盘上的旧文本（"我刚写的没了"）。
   */
  const mergeDraftsIntoProject = useCallback(function (data, drafts) {
    if (!data || typeof data !== 'object') return data;
    const source = drafts || {};
    const paths = Object.keys(source);
    if (!paths.length) return data;
    const documents = Array.isArray(data.documents) ? data.documents : [];
    let touched = false;
    const nextDocuments = documents.map(function (doc) {
      if (!doc || !doc.path || !hasKey(source, doc.path)) return doc;
      const draft = source[doc.path];
      if (!draft || typeof draft.content !== 'string') return doc;
      if (draft.content === doc.content) return doc;
      touched = true;
      return Object.assign({}, doc, { content: draft.content });
    });
    if (!touched) return data;
    return Object.assign({}, data, { documents: nextDocuments });
  }, []);

  /** 重新拉一遍 bootstrap，并决定 chapterId 的去向。 */
  const bootstrap = useCallback(async function (options) {
    const opts = options || {};
    const data = await api.getProject();
    /* 换书（作品身份变了）就把草稿表整张作废：同一个相对路径在另一本书里是另一份文件，
       拿旧书的草稿去覆盖新书的同名章节是实测过的数据事故。 */
    const nextBookKey = String((data && (data.bookId || data.root)) || '');
    if (draftBookRef.current && nextBookKey && nextBookKey !== draftBookRef.current) {
      draftsRef.current = Object.create(null);
      setDraftsVersion(function (value) { return value + 1; });
    }
    if (nextBookKey) draftBookRef.current = nextBookKey;
    /* 有草稿的文档保留草稿正文：bootstrap 不许把磁盘旧文本冲回编辑器。 */
    setProject(mergeDraftsIntoProject(data, draftsRef.current));
    /* 作品身份交给 api 层：之后每个写请求都会带上它，切书后旧请求会被 Host 挡住。 */
    if (typeof api.setBookId === 'function') api.setBookId((data && data.bookId) || '');
    const chapters = ((data && data.documents) || []).filter(isChapterDoc);
    setChapterId(function (previous) {
      if (!opts.resetChapter && previous && chapters.some(function (doc) { return doc.id === previous; })) return previous;
      return chapters.length ? chapters[0].id : '';
    });
    return data;
  }, [mergeDraftsIntoProject]);

  const reloadBooks = useCallback(async function () {
    try {
      const payload = await api.getBooks();
      const bag = payload || {};
      if (Array.isArray(bag.books)) setBooks(bag.books);
      if (bag.current) setCurrentBook(bag.current);
      setIssues(function (list) { return list.filter(function (item) { return item.key !== 'books'; }); });
      return bag;
    } catch (reason) {
      setIssues(function (list) {
        const rest = list.filter(function (item) { return item.key !== 'books'; });
        return rest.concat([{ key: 'books', message: messageOf(reason) }]);
      });
      return null;
    }
  }, []);

  /** 启动：getBooks + getSettings + getModels + bootstrap 并行；前三个失不白屏。 */
  const loadAll = useCallback(async function () {
    setError('');
    /* 先握手：前端随插件包一起更新，后端要重启 DSH 才更新。
       版本对不上就直接给一条能照做的提示，不要拿新接口去打旧宿主。 */
    let health = null;
    try {
      health = await api.getHealth();
    } catch (reason) {
      /* 连 /health 都拿不到：下面的并行请求会照常报错，走原来的致命页。 */
    }
    if (!aliveRef.current) return;
    /* 只有"确实连上了、而且版本号偏低"才算后端过旧。
       连 /health 都没拿到（DSH 刚起、插件还没挂、网络抖一下）属于连接问题，
       交给下面的并行请求报真实错误，不要骗用户去重启。 */
    const clientVersion = typeof api.API_VERSION === 'number' ? api.API_VERSION : 0;
    const serverVersion = health && typeof health.apiVersion === 'number' ? health.apiVersion : null;
    if (health && clientVersion && serverVersion !== null && serverVersion < clientVersion) {
      setHostOutdated({ version: serverVersion, expected: clientVersion });
      return;
    }
    setHostOutdated(null);

    const results = await Promise.allSettled([
      api.getBooks(),
      api.getSettings(),
      api.getModels(),
      api.getProject()
    ]);
    if (!aliveRef.current) return;

    const nextIssues = [];
    const booksResult = results[0];
    const settingsResult = results[1];
    const modelsResult = results[2];
    const projectResult = results[3];

    if (booksResult.status === 'fulfilled') {
      const bag = booksResult.value || {};
      setBooks(Array.isArray(bag.books) ? bag.books : []);
      setCurrentBook(bag.current || null);
    } else {
      nextIssues.push({ key: 'books', message: messageOf(booksResult.reason) });
    }

    if (settingsResult.status === 'fulfilled') {
      const normalized = normalizeSettingsPayload(settingsResult.value);
      setSettings(normalized.settings);
      setSettingsMeta(normalized.meta);
      applyLocale(normalized.settings);
    } else {
      nextIssues.push({ key: 'settings', message: messageOf(settingsResult.reason) });
    }

    if (modelsResult.status === 'fulfilled') {
      setModels(normalizeModelsPayload(modelsResult.value));
    } else {
      nextIssues.push({ key: 'models', message: messageOf(modelsResult.reason) });
    }

    if (projectResult.status === 'fulfilled') {
      const data = projectResult.value;
      /* 以前这里直接 setProject，绕过了 bootstrap 做的三件事：
         ① 告诉 api 层「当前是哪本书」（缺了它写请求就没有身份头）；
         ② 换书时作废草稿与 mtime 表；
         ③ 用草稿合并正文。
         于是「重新加载」之后可以出现「顶栏是 B、正文是 A、写请求没有身份」的状态。 */
      const bookKey = String((data && data.bookId) || '');
      if (typeof api.setBookId === 'function') api.setBookId(bookKey);
      if (draftBookRef.current !== bookKey) {
        draftBookRef.current = bookKey;
        draftsRef.current = Object.create(null);
        mtimeByPath.current = Object.create(null);
      }
      setProject(mergeDraftsIntoProject(data, draftsRef.current));
      setChapterId(function (previous) {
        const chapters = ((data && data.documents) || []).filter(isChapterDoc);
        if (previous && chapters.some(function (doc) { return doc.id === previous; })) return previous;
        return firstChapterIdOf(data);
      });
    } else {
      nextIssues.push({ key: 'project', message: messageOf(projectResult.reason) });
      setError(messageOf(projectResult.reason));
    }

    setIssues(nextIssues);
  }, []);

  useEffect(function () {
    aliveRef.current = true;
    loadAll();
    return function () { aliveRef.current = false; };
  }, [loadAll]);

  useEffect(function () {
    function onKeyDown(event) {
      if ((event.ctrlKey || event.metaKey) && String(event.key).toLowerCase() === 'k') {
        event.preventDefault();
        setSearch(true);
        return;
      }
      if (event.key === 'Escape') setSearch(false);
    }
    window.addEventListener('keydown', onKeyDown);
    return function () { window.removeEventListener('keydown', onKeyDown); };
  }, []);

  useEffect(function () {
    if (project) api.setProjectContext(project);
  }, [project]);

  /** bootstrap 拿到的 mtime 记账：只往「更新」的方向走，避免旧快照把新 mtime 覆盖掉。
      换书（root 变了）时整张表作废——同一个相对路径在另一本书里是另一份文件。 */
  const bookKeyRef = useRef('');
  useEffect(function () {
    if (!project) return;
    const bookKey = String(project.root || project.id || '');
    if (bookKey !== bookKeyRef.current) {
      bookKeyRef.current = bookKey;
      mtimeByPath.current = Object.create(null);
    }
    const documents = project.documents || [];
    documents.forEach(function (doc) {
      if (!doc || !doc.path) return;
      const mtime = documentMtimeOf(doc);
      if (mtime === null) return;
      const known = mtimeByPath.current[doc.path];
      if (typeof known === 'number' && known >= mtime) return;
      mtimeByPath.current[doc.path] = mtime;
    });
  }, [project]);

  /** 有未保存正文时离开页面要拦一下（保存完 Editor 上报 false，提示自动解除）。 */
  useEffect(function () {
    function onBeforeUnload(event) {
      if (!unsavedRef.current) return undefined;
      event.preventDefault();
      event.returnValue = '';
      return '';
    }
    window.addEventListener('beforeunload', onBeforeUnload);
    return function () { window.removeEventListener('beforeunload', onBeforeUnload); };
  }, []);

  useEffect(function () {
    return function () {
      if (toastTimer.current) window.clearTimeout(toastTimer.current);
    };
  }, []);

  function closeSearch() {
    setSearch(false);
    setQuery('');
  }

  function openBookMenu() {
    setBookMenuOpen(function (open) { return !open; });
  }



  /** 把某条路径的最新正文写进 project 状态（编辑器是受控的，改这里就等于改正文）。 */
  function applyDocumentContent(path, content, mtime) {
    const heading = /^#\s+(.+)$/m.exec(content || '');
    const baseName = String(path).split('/').pop() || '';
    const fallbackTitle = baseName.replace(/\.md$/i, '') || t('未命名');
    /* 路径 → 文档类型。以前漏了 chapters/ 和 factions/：给章节保存时会被标成 world，
       于是它从章节列表里消失（字数、目录、搜索全错）。现有一致于 host/store.js 的分类。 */
    const prefix = String(path);
    const type = prefix.indexOf('chapters/') === 0
      ? 'chapter'
      : prefix.indexOf('characters/') === 0
        ? 'character'
        : prefix.indexOf('locations/') === 0
          ? 'location'
          : prefix.indexOf('factions/') === 0
            ? 'faction'
            : prefix.indexOf('outline/') === 0
              ? 'outline'
              : prefix.indexOf('clues/') === 0
                ? 'clue'
                : 'world';
    setProject(function (current) {
      if (!current) return current;
      const docs = current.documents || [];
      const exists = docs.some(function (doc) { return doc.path === path; });
      const patch = { content: content };
      if (typeof mtime === 'number') patch.mtime = mtime;
      const documents = exists
        ? docs.map(function (doc) { return doc.path === path ? Object.assign({}, doc, patch) : doc; })
        : docs.concat([{
          id: String(path).replace(/\.md$/i, ''),
          path: path,
          title: (heading && heading[1]) || fallbackTitle,
          content: content,
          mtime: typeof mtime === 'number' ? mtime : undefined,
          type: type
        }]);
      return Object.assign({}, current, { documents: documents });
    });
  }

  /**
   * 写一份 Markdown。
   * expectedMtime 来自 mtimeByPath；磁盘被别人改过 → Host 回 409 → 排进冲突队列，
   * **不自动重试、不静默覆盖**。抛出的错误保留 status=409，调用方可以据此区分。
   */
  async function save(path, content) {
    if (!path || String(path).slice(-3).toLowerCase() !== '.md') {
      throw new Error(t('只能保存 Markdown 文档'));
    }
    const expectedMtime = mtimeByPath.current[path];
    let result = null;
    try {
      result = await api.saveDocument(path, content, expectedMtime);
    } catch (reason) {
      // 只有「乐观锁冲突」（409 + body.conflict===true）才弹面板；
      // 「文档已存在」那类 409 交给调用方当普通错误提示。
      const conflictHit = typeof api.isConflict === 'function' ? api.isConflict(reason) : false;
      if (conflictHit) {
        if (isRecentlySolved(path)) {
          /* 迟到回包：这一章刚解决过冲突，这次 PUT 带的是解决前的 mtime。
             面板不能再弹一次（那会把作者刚做完的决定推翻），但也不能假装写成功：
             打上 stale 标记，编辑器保持 dirty、按新的 mtime 再试一次。 */
          try { reason.staleConflict = true; } catch (error) { /* 冻结对象就按普通 409 处理 */ }
        } else {
          enqueueConflict(path, content, reason);
        }
      }
      throw reason;
    }
    /* 成功后立刻记账：后端给了新 mtime 就用它；没给（旧后端）就把旧值丢掉，别拿过期的去撞 409。 */
    const nextMtime = documentMtimeOf(result);
    if (nextMtime === null) delete mtimeByPath.current[path];
    else mtimeByPath.current[path] = nextMtime;
    const hasNewerDraft = Boolean(draftsRef.current[path] && draftsRef.current[path].content !== content);
    if (!hasNewerDraft) applyDocumentContent(path, content, nextMtime === null ? undefined : nextMtime);
    /* 这一份已经落盘了：草稿清掉（飞行途中又敲的那份不算数，dropDraft 自己会认出来）。 */
    dropDraft(path, content);
    /* 回包只能代表「我发出去的那一版」。飞行期间又敲了字时，草稿比回包新，
       此时绝不能把回包内容写回 project —— 那会把作者刚打的字吞掉（实测过）。 */
    const latest = draftsRef.current[path];
    if (latest && latest.content !== content) {
      return result;
    }
    /* 保存回包只回写「当前这一章」的状态栏：飞行中切了章，旧章的回包不许改新章的显示，
       否则新章会被当成「已保存」，自动保存就此停摆。 */
    if (path === activePathRef.current) setSavedAt(new Date());
    return result;
  }

  /* ---------------- 保存冲突：队列 + 三个出口 ---------------- */

  /** 这一章是不是「刚解决过冲突」（5 秒内）——迟到 409 的丢弃依据。 */
  function isRecentlySolved(path) {
    if (!path) return false;
    const at = solvedPathsRef.current[path];
    return typeof at === 'number' && Date.now() - at <= CONFLICT_SOLVED_TTL_MS;
  }

  /** 记下「这一章刚刚解决完了」，供迟到 409 判断。 */
  function markSolved(path) {
    if (!path) return;
    solvedPathsRef.current[path] = Date.now();
  }

  /** 某个 path 上最新的一份未保存正文（页面草稿是最新的：编辑器每次输入都会同步过来）。 */
  function draftContentOf(path) {
    const draft = path ? draftsRef.current[path] : null;
    return draft && typeof draft.content === 'string' ? draft.content : undefined;
  }

  /** 把一次 409 排进队尾；同一章已经在队里就更新它的正文，不重复排队。 */
  function enqueueConflict(path, mine, reason) {
    const info = typeof api.conflictOf === 'function' ? api.conflictOf(reason) : null;
    const disk = info && typeof info.content === 'string' ? info.content : '';
    const diskMtime = info && typeof info.mtime === 'number' ? info.mtime : null;
    setConflictError('');
    setConflicts(function (list) {
      const entry = { path: path, mine: mine, disk: disk, diskMtime: diskMtime };
      let found = -1;
      for (let index = 0; index < list.length; index += 1) {
        if (list[index].path === path) { found = index; break; }
      }
      if (found === -1) return list.concat([entry]);
      const next = list.slice();
      next[found] = entry;
      return next;
    });
    unsavedRef.current = true;
  }

  /**
   * 解决掉队首：后面的冲突接着显示，全部解决完面板自动关闭。
   * expectedPath 用来防连点：队首已经换了就不动队列（否则会把还没处理的那一条挤掉）。
   */
  function shiftConflict(expectedPath) {
    const remaining = conflicts.length > 1;
    setConflicts(function (list) {
      if (!list.length) return list;
      if (expectedPath && list[0].path !== expectedPath) return list;
      return list.length > 1 ? list.slice(1) : [];
    });
    setConflictError('');
    return remaining;
  }

  /**
   * 外部替换了正文之后通知编辑器：只有「被替换的正是编辑器当前打开的那一章」时才递增，
   * 否则会把别的章节的未保存快照一起清掉。
   */
  function bumpContentRevision(path) {
    const active = (project && (project.documents || []).filter(function (doc) {
      return doc.id === chapterId;
    })[0]) || null;
    if (active && active.path === path) setContentRevision(function (value) { return value + 1; });
  }

  /** 明确丢弃某一章的本地正文（页面草稿 + 编辑器快照一起丢）。 */
  function discardLocalContent(path) {
    if (!path) return;
    discardSeqRef.current += 1;
    const seq = discardSeqRef.current;
    setDiscardedPaths(function (map) {
      const next = Object.assign({}, map);
      next[path] = seq;
      return next;
    });
  }

  /** 1) 用磁盘版本覆盖我的编辑：放弃本地正文，编辑器换成磁盘全文。 */
  function useDiskVersion() {
    const current = conflict;
    if (!current || conflictBusy) return;
    if (typeof current.disk === 'string' && current.disk.length) {
      applyDocumentContent(current.path, current.disk, current.diskMtime === null ? undefined : current.diskMtime);
    }
    if (typeof current.diskMtime === 'number') mtimeByPath.current[current.path] = current.diskMtime;
    else delete mtimeByPath.current[current.path];
    /* 被否定的本地正文要一起丢掉：页面草稿 + 编辑器的未保存快照。
       少清一样，切回这一章时旧文字又会被写回磁盘（把磁盘版本覆盖掉）。 */
    dropDraft(current.path);
    discardLocalContent(current.path);
    markSolved(current.path);
    // 让编辑器清掉这一章的未保存快照（含 saveState），否则下次切章又会把旧文字写回去。
    bumpContentRevision(current.path);
    const remaining = shiftConflict(current.path);
    unsavedRef.current = remaining;
    if (current.path === activePathRef.current) setSavedAt(new Date());
    notify(t('已换成磁盘上的版本，你的改动已被替换'));
  }

  /** 2) 保留我的修改，强制保存：重发一次不带 expectedMtime 的 PUT。 */
  async function forceSaveConflict() {
    const current = conflict;
    if (!current || conflictBusy) return;
    setConflictBusy(true);
    setConflictError('');
    try {
      /* 面板开着这段时间作者可能又敲了字：草稿里那份才是「我的修改」，
         用 409 那一刻的 mine 会把冲突期间写的全丢掉。 */
      const latest = draftContentOf(current.path);
      const mine = typeof latest === 'string' ? latest : current.mine;
      const result = await api.saveDocument(current.path, mine);
      const nextMtime = documentMtimeOf(result);
      if (nextMtime === null) delete mtimeByPath.current[current.path];
      else mtimeByPath.current[current.path] = nextMtime;
      applyDocumentContent(current.path, mine, nextMtime === null ? undefined : nextMtime);
      dropDraft(current.path, mine);
      markSolved(current.path);
      bumpContentRevision(current.path);
      const remaining = shiftConflict(current.path);
      unsavedRef.current = remaining;
      if (current.path === activePathRef.current) setSavedAt(new Date());
      notify(t('已强制保存你的版本'));
    } catch (reason) {
      setConflictError(messageOf(reason) || t('强制保存失败，请稍后重试'));
    } finally {
      setConflictBusy(false);
    }
  }

  /** 3) 先不管：关掉这一条（队里还有下一条就接着显示），正文和「未保存」都留着。 */
  function dismissConflict() {
    const current = conflict;
    if (!current) return;
    /* 作者明确先不管：记一笔「刚处理过」，免得紧接着的迟到 409 又把这个面板弹回来。 */
    markSolved(current.path);
    shiftConflict(current.path);
    unsavedRef.current = true;
  }


  function updateChapter(id, content) {
    setProject(function (current) {
      if (!current) return current;
      return Object.assign({}, current, {
        documents: (current.documents || []).map(function (doc) { return doc.id === id ? Object.assign({}, doc, { content: content }) : doc; })
      });
    });
  }

  async function setAnnotations(next) {
    if (!project) return;
    const previous = project.annotations || [];
    setProject(function (current) { return current ? Object.assign({}, current, { annotations: next }) : current; });
    try {
      // 整表替换：第三个参数 replaceAll（api.saveAnnotations 本轮新增），Host 会清掉旧表再写。
      await api.saveAnnotations(null, next, true);
      setSavedAt(new Date());
    } catch (reason) {
      setProject(function (current) { return current ? Object.assign({}, current, { annotations: previous }) : current; });
      notify(messageOf(reason) || t('批注保存失败'));
    }
  }

  function exportBook() {
    window.location.href = '/api/moshu/export';
    notify('正在导出完整 Markdown 稿件');
  }

  /* ---------------- 书籍动作 ---------------- */

  /**
   * 任何会换掉"当前作品"的操作之前都必须先落盘。
   * 不 flush 就换书是实测过的数据事故：旧书的正文会写进新书的同名章节，
   * 或者干脆被 bookKey 变化清掉、连提示都没有。
   * @returns {Promise<{ok:boolean, reason?:string}>}
   */
  async function beforeBookChange(actionLabel) {
    const editor = editorApiRef.current;
    if (!editor || typeof editor.flushAll !== 'function') return { ok: true };
    try {
      await editor.flushAll();
      return { ok: true };
    } catch (error) {
      return { ok: false, reason: t('还有内容没能保存，先不{action}：{reason}', { action: actionLabel, reason: messageOf(error) }) };
    }
  }

  async function switchBook(id) {
    if (!id || bookBusy) return false;
    setBookBusy(true);
    const previousBook = currentBook;
    const previousBookId = currentBook ? String(currentBook.id) : '';
    try {
      const flushed = await beforeBookChange(t('切换作品'));
      if (!flushed.ok) {
        notify(flushed.reason);
        return false;
      }
      const result = await api.selectBook(id);
      const book = (result && result.book) || books.filter(function (item) { return String(item.id) === String(id); })[0] || null;
      if (book) setCurrentBook(book);
      await bootstrap({ resetChapter: true });
      closeSearch();
      await reloadBooks();
      notify(t('已切换到《{name}》', { name: bookTitleOf(book) || id }));
      return true;
    } catch (reason) {
      /* 服务端已经切过去了，但前端的 project 没跟上（bootstrap 失败）——
         这时如果就这么留着，会出现「顶栏是 B、正文还是 A、写请求没有身份」的危险状态，
         接着保存就把 A 的正文写进 B。所以要么把服务端切回去，要么明确失败。 */
      if (previousBookId && previousBookId !== String(id)) {
        try {
          await api.selectBook(previousBookId);
          setCurrentBook(previousBook);
          await bootstrap({});
          notify(t('切换失败，已留在《{name}》：{reason}', { name: previousBookId, reason: messageOf(reason) }));
          return false;
        } catch (rollbackError) {
          notify(t('切换失败且没能切回原作品，请刷新页面后再操作：{reason}', { reason: messageOf(reason) }));
          return false;
        }
      }
      notify(messageOf(reason));
      return false;
    } finally {
      setBookBusy(false);
    }
  }

  async function createBook(name) {
    if (bookBusy) return false;
    setBookBusy(true);
    try {
      const flushed = await beforeBookChange(t('新建作品'));
      if (!flushed.ok) {
        notify(flushed.reason);
        return false;
      }
      const result = await api.createBook(name);
      const bag = result || {};
      if (Array.isArray(bag.books)) setBooks(bag.books);
      if (bag.book) setCurrentBook(bag.book);
      await bootstrap({ resetChapter: true });
      closeSearch();
      await reloadBooks();
      notify(t('已新建《{name}》', { name: bookTitleOf(bag.book) || name }));
      return true;
    } catch (reason) {
      notify(messageOf(reason));
      return false;
    } finally {
      setBookBusy(false);
    }
  }

  async function renameBook(id, name) {
    if (bookBusy) return false;
    setBookBusy(true);
    try {
      /* 改名会改作品目录名 → 换书；不先 flush 的话，正在写的那一章会「已保存但没落盘」。 */
      const flushed = await beforeBookChange(t('重命名作品'));
      if (!flushed.ok) {
        notify(flushed.reason);
        return false;
      }
      const result = await api.renameBook(id, name);
      const bag = result || {};
      if (Array.isArray(bag.books)) setBooks(bag.books);
      const renamed = bag.book || null;
      const wasCurrent = Boolean(currentBook) && String(currentBook.id) === String(id);
      if (wasCurrent && renamed) setCurrentBook(renamed);
      if (wasCurrent) await bootstrap({});
      await reloadBooks();
      notify(t('已改名为《{name}》', { name: bookTitleOf(renamed) || name }));
      return true;
    } catch (reason) {
      notify(messageOf(reason));
      return false;
    } finally {
      setBookBusy(false);
    }
  }

  async function trashBook(id) {
    if (bookBusy) return false;
    const removed = books.filter(function (item) { return String(item.id) === String(id); })[0];
    setBookBusy(true);
    try {
      const flushed = await beforeBookChange(t('删除作品'));
      if (!flushed.ok) {
        notify(flushed.reason);
        return false;
      }
      const result = await api.trashBook(id);
      const bag = result || {};
      if (Array.isArray(bag.books)) setBooks(bag.books);
      /* 删掉的若是当前书，Host 会切到另一本；统一重新读一遍再 bootstrap */
      await reloadBooks();
      await bootstrap({ resetChapter: true });
      closeSearch();
      notify(t('《{name}》已移到回收站', { name: bookTitleOf(removed) || id }));
      return true;
    } catch (reason) {
      notify(messageOf(reason));
      return false;
    } finally {
      setBookBusy(false);
    }
  }

  /** 空书架页面上的"新建作品"。 */
  /* 空书架时拉一次共享库清单（只有会话作用域才需要）。 */
  useEffect(function () {
    if (api.getScope && !api.getScope()) { setSharedBooks([]); return; }
    let alive = true;
    api.listSharedBooks()
      .then(function (result) {
        if (!alive) return;
        const list = (result && result.books) || [];
        setSharedBooks(list.filter(function (item) { return item && item.id !== (project && project.bookId); }));
      })
      .catch(function () { if (alive) setSharedBooks([]); });
    return function () { alive = false; };
  }, [project && project.bookId, api.getScope ? api.getScope() : '']);

  async function importShared(name) {
    setEmptyShelfError('');
    try {
      await api.importSharedBook(name);
      await bootstrap({});
      await reloadBooks();
    } catch (reason) {
      setEmptyShelfError(messageOf(reason));
    }
  }

  async function createBookFromEmpty() {
    const name = String(newBookName || '').trim();
    if (!name) {
      setEmptyShelfError(t('先给作品起个名字。'));
      return;
    }
    setEmptyShelfError('');
    const created = await createBook(name);
    if (created) setNewBookName('');
    else setEmptyShelfError(t('新建失败，请稍后重试（原因见右上角提示）。'));
  }

  /** 彻底删除（不进回收站，磁盘上直接消失）。confirm 由菜单收集，必须是书名。 */
  async function deleteBookPermanently(id, confirmName) {
    if (bookBusy) return false;
    setBookBusy(true);
    try {
      const flushed = await beforeBookChange(t('删除作品'));
      if (!flushed.ok) {
        notify(flushed.reason);
        return false;
      }
      const result = await api.deleteBook(id, confirmName);
      const bag = result || {};
      if (Array.isArray(bag.books)) setBooks(bag.books);
      await reloadBooks();
      await bootstrap({ resetChapter: true });
      closeSearch();
      notify(t('《{name}》已被彻底删除', { name: id }));
      return true;
    } catch (reason) {
      notify(messageOf(reason));
      return false;
    } finally {
      setBookBusy(false);
    }
  }

  /** 回收站恢复/清空之后：书列表和当前作品都可能变，重拉一遍。 */
  async function handleTrashChanged() {
    try {
      await reloadBooks();
      await bootstrap({});
    } catch (reason) {
      notify(messageOf(reason));
    }
  }

  /* ---------------- 模型动作 ---------------- */

  const handleModelSelect = useCallback(async function (provider, model) {
    if (!provider || !model) return false;
    setModelBusy(true);
    try {
      await api.setModel(provider, model);
      setModels(function (current) {
        return Object.assign({}, current, { current: { provider: provider, model: model }, message: '' });
      });
      setSettings(function (current) { return Object.assign({}, current, { provider: provider, model: model }); });
      /* project.dsh 也带着模型状态，切完顺手刷一次，刷不动不算失败。 */
      try {
        await bootstrap({});
      } catch (error) {
        /* 模型已经写进设置里了 */
      }
      notify(t('已切换到 {model}', { model: provider + ' / ' + model }));
      return true;
    } catch (reason) {
      notify(messageOf(reason));
      return false;
    } finally {
      setModelBusy(false);
    }
  }, [bootstrap, notify]);

  const refreshModels = useCallback(async function () {
    setModelBusy(true);
    try {
      const payload = await api.getModels();
      const next = normalizeModelsPayload(payload);
      setModels(next);
      setIssues(function (list) { return list.filter(function (item) { return item.key !== 'models'; }); });
      notify(next.message || t('模型列表已刷新'));
    } catch (reason) {
      notify(messageOf(reason));
    } finally {
      setModelBusy(false);
    }
  }, [notify]);

  /* ---------------- 设置 / 刷新 ---------------- */

  const handleSaveSettings = useCallback(async function (patch) {
    const nextPatch = patch && typeof patch === 'object' ? patch : {};
    try {
      const result = await api.saveSettings(nextPatch);
      const merged = result && result.settings && typeof result.settings === 'object'
        ? result.settings
        : Object.assign({}, settings, nextPatch);
      setSettings(merged);
      applyLocale(merged);
      const affectsModel = hasKey(nextPatch, 'provider') || hasKey(nextPatch, 'model');
      const affectsBook = hasKey(nextPatch, 'novelDir');
      if (affectsModel) {
        setModels(function (current) {
          return Object.assign({}, current, {
            current: { provider: merged.provider || '', model: merged.model || '' }
          });
        });
      }
      if (affectsModel || affectsBook) {
        try {
          await bootstrap({ resetChapter: affectsBook });
        } catch (reason) {
          /* 设置本身已经存下了，bootstrap 失败不推翻它 */
        }
      }
      if (affectsBook) await reloadBooks();
      notify(t('已保存设置'));
    } catch (reason) {
      notify(messageOf(reason) || t('设置保存失败'));
      /* 往上抛：设置页靠它判断成败，吞掉会让页脚显示「已保存」而实际没存下。 */
      throw reason;
    }
  }, [bootstrap, notify, reloadBooks, settings]);

  const handleProjectRefresh = useCallback(async function () {
    try {
      await bootstrap({});
      await reloadBooks();
    } catch (reason) {
      notify(messageOf(reason));
    }
  }, [bootstrap, notify, reloadBooks]);

  /* Editor 的新 prop：新建/改名/删除/排序后让外壳重新 bootstrap。 */
  const handleDocumentsChanged = useCallback(async function () {
    try {
      await bootstrap({});
    } catch (reason) {
      notify(messageOf(reason));
    }
    reloadBooks();
  }, [bootstrap, notify, reloadBooks]);

  /* Editor 上报「有没有未保存正文」；beforeunload 靠它决定要不要拦。 */
  const handleEditorDirtyChange = useCallback(function (dirty) {
    unsavedRef.current = Boolean(dirty);
    setEditorDirty(Boolean(dirty));
  }, []);

  /* ---------------- 渲染 ---------------- */

  if (hostOutdated) {
    /* 插件的浏览器端一升级就生效，服务端要重启 DSH 才会换。两边不同版时，
       以前是「页面能打开、每个接口都 404」，现在给一条能照做的提示。 */
    return (
      <div className="moshu-root">
        <style dangerouslySetInnerHTML={{ __html: css }} />
        <div className="fatal">
          <div className="fatal-mark"><icons.Zap size={30} /></div>
          <h1>{t('墨枢的后端还是旧版本')}</h1>
          <p>
            {t('页面已经是新版本（v{expected}），但 DSH 进程里跑的还是 v{version}。请把 DSH 完全关掉再重新打开，然后刷新这个页面。', {
              expected: hostOutdated.expected,
              version: hostOutdated.version || '?',
            })}
          </p>
          <p>{t('（只刷新网页不够：插件后端不会热重载。）')}</p>
          <button type="button" className="button primary" onClick={function () { window.location.reload(); }}>
            {t('重启后点这里刷新')}
          </button>
        </div>
      </div>
    );
  }

  if (project && !project.bookId) {
    /* 一本作品都没有（例如刚把最后一本彻底删掉）：不要再去"复活"示例书，
       给一个能立刻新建的入口，并且提示可以去回收站找回。 */
    return (
      <div className="moshu-root">
        <style dangerouslySetInnerHTML={{ __html: css }} />
        <div className="fatal">
          <div className="fatal-mark"><icons.LibraryBig size={30} /></div>
          <h1>{t('书架是空的')}</h1>
          <p>{t('新建一本开始写。删掉的作品在回收站。')}</p>
          <div style={{ display: 'flex', gap: 8, justifyContent: 'center', marginTop: 6 }}>
            <input
              className="form-input"
              style={{ maxWidth: 260 }}
              value={newBookName}
              onChange={function (event) { setNewBookName(event.target.value); }}
              placeholder={t('给这本书起个名字')}
              aria-label={t('新作品名')}
              onKeyDown={function (event) { if (event.key === 'Enter') void createBookFromEmpty(); }}
            />
            <button type="button" className="button primary" onClick={function () { void createBookFromEmpty(); }}>
              {t('新建作品')}
            </button>
          </div>
          {emptyShelfError ? <p role="alert">{emptyShelfError}</p> : null}
          {sharedBooks.length ? (
            <div style={{ marginTop: 16 }}>
              <p style={{ fontSize: 12, opacity: 0.75 }}>{t('共享库里还有这些作品，可以复制到本次对话：')}</p>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, justifyContent: 'center' }}>
                {sharedBooks.map(function (item) {
                  return (
                    <button
                      key={item.id}
                      type="button"
                      className="button"
                      onClick={function () { void importShared(item.id); }}
                    >
                      {t('导入《{name}》', { name: item.title || item.name || item.id })}
                    </button>
                  );
                })}
              </div>
            </div>
          ) : null}
          <p style={{ marginTop: 14 }}>
            <button type="button" className="button" onClick={function () { setBookMenuOpen(true); }}>
              {t('打开书籍菜单 / 回收站')}
            </button>
          </p>
          {bookMenuOpen ? (
            <BookMenu
              books={books}
              current={currentBook}
              busy={bookBusy}
              onSelect={switchBook}
              onCreate={createBook}
              onRename={renameBook}
              onTrash={trashBook}
              onDelete={deleteBookPermanently}
              onTrashChanged={handleTrashChanged}
              onClose={function () { setBookMenuOpen(false); }}
            />
          ) : null}
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="moshu-root">
        <style dangerouslySetInnerHTML={{ __html: css }} />
        <div className="fatal">
          <div className="fatal-mark"><icons.BookOpen size={30} /></div>
          <h1>{t('墨枢暂时无法连接本地服务')}</h1>
          <p>{error}</p>
          <button type="button" className="button primary" onClick={function () { loadAll(); }}>{t('重新加载')}</button>
        </div>
      </div>
    );
  }

  if (!project) {
    return (
      <div className="moshu-root">
        <style dangerouslySetInnerHTML={{ __html: css }} />
        <div className="loading" aria-busy="true" aria-label={t('正在加载作品…')}>
          <div className="skeleton skeleton-bar" />
          <div className="skeleton-heading">
            <div className="skeleton skeleton-title" />
            <div className="skeleton skeleton-subtitle" />
          </div>
          <div className="skeleton-grid">
            <div className="skeleton skeleton-col" />
            <div className="skeleton skeleton-col tall" />
            <div className="skeleton skeleton-col" />
          </div>
        </div>
      </div>
    );
  }

  const documents = project.documents || [];
  const chapters = documents.filter(isChapterDoc);
  const annotations = project.annotations || [];
  const openAnnotations = annotations.filter(function (item) { return item.status === 'open'; }).length;
  const derivedWords = chapters.reduce(function (total, chapter) { return total + String(chapter.content || '').replace(/\s/g, '').length; }, 0);
  const wordCount = derivedWords || (currentBook && Number(currentBook.words)) || 0;
  const chapterCount = chapters.length || (currentBook && Number(currentBook.chapters)) || 0;

  const dsh = project.dsh || {};
  const dshAvailable = Boolean(dsh.available);
  const currentModel = (models && models.current) || {};
  const providerId = currentModel.provider || dsh.provider || '';
  const modelId = currentModel.model || dsh.model || '';
  const modelLabel = providerId && modelId
    ? providerId + ' / ' + modelId
    : (modelId || providerId || t('本地模型'));
  const modelReady = (models && models.providers && models.providers.length)
    ? true
    : (models && models.message ? false : dshAvailable);
  const modelTitle = modelReady ? t('切换模型') : (models.message || dsh.message || t('模型不可用'));

  const bookTitle = bookTitleOf(currentBook) || project.name || t('未命名');

  const heading = TITLES[view] || TITLES.write;
  const savedLabel = editorDirty || conflicts.length
    ? t('有未保存修改')
    : savedAt
      ? t('已保存 · {time}', { time: formatClock(savedAt) })
      : t('已保存到本地');
  const trimmedQuery = query.trim().toLowerCase();
  const results = trimmedQuery
    ? documents.filter(function (doc) { return (String(doc.title || '') + String(doc.content || '')).toLowerCase().indexOf(trimmedQuery) !== -1; })
    : [];

  function openDocument(doc) {
    if (doc.type === 'chapter') {
      setChapterId(doc.id);
      setView('write');
    } else if (doc.type === 'memory') {
      setView('memory');
    } else {
      setView('library');
    }
    closeSearch();
  }

  function openChapter(id) {
    setChapterId(id);
    setView('write');
  }

  function renderWorkspace() {
    const Component = VIEW_COMPONENTS[VIEW_KEY[view]];
    if (!Component) {
      return (
        <div className="view-missing">
          <icons.PanelRightOpen size={22} />
          <strong>{t('该视图暂时不可用')}</strong>
          <span>{t('视图组件未能加载')}</span>
        </div>
      );
    }
    if (view === 'write') {
      return (
        <Component
          onConnectDsh={undefined}
          chapters={chapters}
          activeChapterId={chapterId}
          onSelectChapter={setChapterId}
          onContentChange={updateChapter}
          editorApi={editorApiRef}
          bookKey={(project && (project.bookId || project.root)) || ''}
          onSave={async function (path, content) {
            await save(path, content);
            const current = documents.filter(function (doc) { return doc.path === path; })[0];
            if (current) {
              await api.request('/annotations', {
                method: 'POST',
                body: JSON.stringify({
                  annotations: annotations.filter(function (item) { return item.documentPath === path; }).map(function (item) {
                    return relocateAnnotation(content, item);
                  })
                })
              });
            }
          }}
          annotations={annotations}
          onAnnotationsChange={setAnnotations}
          project={project}
          settings={settings}
          onDocumentsChanged={handleDocumentsChanged}
          onNotify={notify}
          onDirtyChange={handleEditorDirtyChange}
          contentRevision={contentRevision}
          /* 草稿上提：挂载时灌回编辑器，输入时同步回页面。三个都能缺省（不传就是旧行为）。 */
          initialDrafts={draftsSnapshot}
          onDraftChange={handleDraftChange}
          onDraftClear={dropDraft}
          discardedPaths={discardedPaths}
        />
      );
    }
    if (view === 'outline') {
      return <Component documents={documents} onSave={save} onOpenChapter={openChapter} onDocumentsChanged={handleDocumentsChanged} />;
    }
    if (view === 'library') {
      return <Component documents={documents} onSave={save} />;
    }
    if (view === 'map') {
      return (
        <Component
          key={String(project.bookId || project.root || 'map')}
          data={project.map || { locations: [], routes: [] }}
          initialData={project.map || { locations: [], routes: [] }}
          onSave={async function (data) {
            /* 后端会把地图归一化后回传（补 id、校验坐标），以返回值为准写回 project，
               免得本地版本和磁盘上的字段对不上。 */
            const saved = await api.request('/map', { method: 'POST', body: JSON.stringify({ map: data }) });
            const next = saved && saved.map ? saved.map : data;
            setProject(function (current) { return current ? Object.assign({}, current, { map: next }) : current; });
            notify('地图已保存');
          }}
        />
      );
    }
    if (view === 'timeline') {
      return (
        <Component
          documents={documents}
          events={project.timeline || []}
          onOpenChapter={function (chapter) {
            if (chapter && chapter.id) openChapter(chapter.id);
          }}
        />
      );
    }
    if (view === 'memory') {
      return (
        <Component
          memories={project.memories || []}
          documents={documents}
          initialIncludedIds={project.contextDocumentIds || []}
          onContextChange={async function (ids) {
            await api.request('/context', { method: 'POST', body: JSON.stringify({ ids: ids }) });
            setProject(function (current) { return current ? Object.assign({}, current, { contextDocumentIds: ids }) : current; });
          }}
          onSave={async function (memory) {
            const result = await api.request('/memory', { method: 'POST', body: JSON.stringify(memory) });
            setProject(function (current) { return current ? Object.assign({}, current, { memories: result.memories }) : current; });
            notify('记忆已更新');
          }}
        />
      );
    }
    if (view === 'overview') {
      return (
        <Component
          project={project}
          documents={documents}
          onOpenChapter={openChapter}
        />
      );
    }
    if (view === 'settings') {
      return (
        <Component
          settings={settings}
          meta={settingsMeta}
          models={models}
          onSave={handleSaveSettings}
          onModelSelect={handleModelSelect}
          notify={notify}
        />
      );
    }
    return (
      <Component
        project={project}
        tasks={project.tasks || []}
        dsh={project.dsh}
        onRefresh={handleProjectRefresh}
      />
    );
  }

  const showStats = view !== 'settings';

  return (
    <div className={"moshu-root" + (hideRail ? " is-hide-rail" : "") + (hideTopbar ? " is-hide-topbar" : "")}>
      <style dangerouslySetInnerHTML={{ __html: css }} />

      <header className={'topbar' + (hideTopbar ? ' is-hidden' : '')}>
        <div className="breadcrumbs">
          <span>{t('墨枢')}</span>
          <span className="sep">/</span>
          <strong>{t(heading[0])}</strong>
        </div>

        <div className="menu-anchor">
          <button
            type="button"
            className="book-trigger"
            aria-haspopup="menu"
            aria-expanded={bookMenuOpen ? 'true' : 'false'}
            aria-label={t('当前书籍') + '：' + bookTitle}
            title={bookTitle}
            onClick={openBookMenu}
          >
            <icons.BookOpen size={14} className="book-trigger-icon" />
            <span className="book-trigger-name">{bookTitle}</span>
            <span className="book-trigger-meta">{t('{n} 章', { n: formatNumber(chapterCount) })}</span>
            <icons.ChevronDown size={12} className="book-trigger-caret" />
          </button>
          {bookMenuOpen ? (
            <BookMenu
              books={books}
              current={currentBook}
              busy={bookBusy}
              onSelect={switchBook}
              onCreate={createBook}
              onRename={renameBook}
              onTrash={trashBook}
              onDelete={deleteBookPermanently}
              onTrashChanged={handleTrashChanged}
              onClose={function () { setBookMenuOpen(false); }}
            />
          ) : null}
        </div>

        <nav className="moshu-tabs" aria-label={t('切换视图')}>
          {VIEW_ORDER.map(function (item) {
            const Glyph = icons[item.icon] || icons.PenLine;
            const active = view === item.id;
            return (
              <button
                key={item.id}
                type="button"
                className={'moshu-tab' + (active ? ' is-active' : '')}
                onClick={function () { setView(item.id); }}
                aria-current={active ? 'page' : undefined}
                title={t(item.label)}
              >
                <Glyph size={15} />
                <span>{t(item.label)}</span>
              </button>
            );
          })}
        </nav>

        <div className="top-actions">
          <button type="button" className="search-trigger" onClick={function () { setSearch(true); }} title={t('打开搜索')}>
            <icons.Search size={15} />
            <span>{t('搜索作品中的任何内容')}</span>
            <kbd>⌘ K</kbd>
          </button>
          <span className={'saved' + (editorDirty || conflicts.length ? ' is-dirty' : '')}>
            {editorDirty || conflicts.length ? <span className="save-dirty-dot" /> : <icons.Check size={13} />}
            {savedLabel}
          </span>
          {inOverlay ? (
            <button
              type="button"
              className="icon-button"
              onClick={function () { runtime.setFullscreen(false); }}
              title={t('退出全屏（Esc）')}
              aria-label={t('退出全屏')}
            >
              <icons.PanelLeftClose size={16} />
            </button>
          ) : (
            /* 入口放在头部、带文字：以前只有一个小图标，还另有一个浮动按钮，
               两处入口谁在哪儿都不直观。 */
            <button
              type="button"
              className="fullscreen-trigger"
              onClick={function () { runtime.setFullscreen(true, scope || api.getScope()); }}
              title={t('全屏编辑（Esc 退出）')}
              aria-label={t('全屏编辑')}
            >
              <icons.ScanSearch size={15} />
              <span>{t('全屏')}</span>
            </button>
          )}
          <button type="button" className="icon-button" onClick={exportBook} title={t('导出作品')} aria-label={t('导出作品')}>
            <icons.Download size={16} />
          </button>
        </div>
      </header>

      {issues.length > 0 ? (
        <div className="notice-banner" role="status">
          <icons.CircleHelp size={14} />
          <span>{t('部分功能暂时不可用：')}</span>
          <span className="notice-detail">
            {issues.map(function (item) {
              return t(ISSUE_LABEL[item.key] || item.key) + '（' + item.message + '）';
            }).join(' · ')}
          </span>
          <button type="button" className="notice-retry" onClick={function () { loadAll(); }}>{t('重新加载')}</button>
        </div>
      ) : null}

      {/* 地图页把大标题块整块去掉：面包屑已写着「世界地图」，地图头部还有书名与统计，
          再来一行标题 + 一句标语纯占高度（只这一页省下约 70px，全给画布）。 */}
      {view === 'map' ? null : (
      <section className={'page-heading' + (view === 'write' ? ' compact' : '')}>
        <div>
          <h1>{t(heading[0])}</h1>
          <p>{t(heading[1])}</p>
        </div>
        {showStats ? (
          <div className="writing-stats" title={bookTitle}>
            <span><b>{formatNumber(wordCount)}</b>{t('总字数')}</span>
            <span><b>{formatNumber(chapterCount)}</b>{t('章节')}</span>
            <span><b>{formatNumber(openAnnotations)}</b>{t('待处理批注')}</span>
          </div>
        ) : null}
      </section>
      )}

      {/* 地图页要吃掉整个工作区：去掉四周留白，画布才够大。 */}
      <div className={'workspace' + (view === 'map' ? ' workspace-flush' : '')}>{renderWorkspace()}</div>

      <footer className="statusbar">
        {/* 专注写作：把顶栏 / 左侧目录收起来，只留正文。快捷键 Ctrl+Shift+H / L。 */}
        <div className="focus-toggles">
          <button
            type="button"
            className={'focus-toggle' + (hideTopbar ? ' is-off' : '')}
            onClick={function () { setHideTopbar(function (value) { return !value; }); }}
            title={t('隐藏/显示顶栏（Ctrl+Shift+H）')}
            aria-pressed={hideTopbar}
          >
            {t('顶栏')}
          </button>
          <button
            type="button"
            className={'focus-toggle' + (hideRail ? ' is-off' : '')}
            onClick={function () { setHideRail(function (value) { return !value; }); }}
            title={t('隐藏/显示左侧目录（Ctrl+Shift+L）')}
            aria-pressed={hideRail}
          >
            {t('目录')}
          </button>
        </div>
        <div>
          <span className="local-indicator" />
          <span>{t('当前作品')}</span>
          <span className="status-separator">·</span>
          <span className="truncate" title={bookTitle}>{bookTitle}</span>
          <span className="status-separator">·</span>
          <span className="truncate" title={project.root}>{project.root}</span>
        </div>
        <div>
          <icons.Activity size={12} />
          <span>{t('Markdown 源文件')}</span>
          <span className="status-separator">·</span>
          <span className="truncate">{t('{n} 章 · {w} 字', { n: formatNumber(chapterCount), w: formatNumber(wordCount) })}</span>
          <span className="status-separator">·</span>
          <span className="truncate" title={modelTitle}>{modelLabel}</span>
        </div>
      </footer>

      {search && (
        <div className="modal-backdrop" role="presentation" onClick={closeSearch}>
          <div
            className="search-modal"
            role="dialog"
            aria-modal="true"
            aria-label={t('搜索作品')}
            onClick={function (event) { event.stopPropagation(); }}
          >
            <div className="search-input">
              <icons.Search size={19} />
              <input
                autoFocus
                value={query}
                placeholder={t('搜索章节、人物、设定与记忆…')}
                aria-label={t('搜索作品')}
                onChange={function (event) { setQuery(event.target.value); }}
              />
              <button type="button" onClick={closeSearch} title={t('关闭搜索')} aria-label={t('关闭搜索')}>
                <icons.X size={17} />
              </button>
            </div>
            <div className="search-results">
              {query && results.map(function (doc) {
                return (
                  <button key={doc.id || doc.path} type="button" onClick={function () { openDocument(doc); }}>
                    <icons.FileText size={17} />
                    <div>
                      <strong>{doc.title || t('未命名文档')}</strong>
                      <p>{String(doc.content || '').replace(/[#*\-\n]/g, ' ').slice(0, 90)}</p>
                    </div>
                    <span aria-hidden="true">↗</span>
                  </button>
                );
              })}
              {query && !results.length && (
                <div className="empty-search">{t('没有找到“{q}”相关内容', { q: query.trim() })}</div>
              )}
              {!query && (
                <div className="search-hint">
                  <icons.Command size={21} />
                  <p>{t('从一个词，找到整个世界')}</p>
                  <span>{t('可搜索正文、人物、世界观和 AI 记忆')}</span>
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {toast && <div className="toast"><icons.Check size={16} />{t(toast)}</div>}

      {conflict ? (
        <ConflictDialog
          path={conflict.path}
          mine={conflict.mine}
          disk={conflict.disk}
          diskMtime={conflict.diskMtime}
          busy={conflictBusy}
          error={conflictError}
          onUseDisk={useDiskVersion}
          onForceSave={forceSaveConflict}
          onDismiss={dismissConflict}
        />
      ) : null}
    </div>
  );
}

module.exports = { Page: Page, VIEW_ORDER: VIEW_ORDER };
