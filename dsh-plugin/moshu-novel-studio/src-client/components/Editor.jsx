const React = require('react');
const { Markdown } = require('./Markdown');
const { Fragment, useEffect, useMemo, useRef, useState } = React;
const {
  BookOpen, CheckCircle2, ChevronRight, FileText, Hash,
  LoaderCircle, MessageSquareText, PanelRightClose, PanelRightOpen, PenLine, Plus, Save, ScanSearch, X,
} = require('../icons');
const api = require('../api');
const { relocateAnnotation } = require('../annotations');
const { Annotations } = require('./Annotations');
const { BackupsPanel } = require('./BackupsPanel');
// 共用控件变量（--moshu-*）。编辑器不渲染它的话，当前章高亮等取色会落空。
const { SharedStyle } = require('./SharedStyle');
const css = require('./Editor.css');

const DEFAULT_REVIEW_FOCUS = '检查剧情因果、人物动机、前后逻辑、设定冲突和语言表达。';
// 改名 / 移动 / 新建之后等新目录到达的宽限时间。
const PENDING_SELECT_MS = 10000;

/** settings 可能还没加载完（undefined），所有取值都要有兜底。 */
function fallbackSetting(key) {
  if (key === 'autosaveDelayMs') return 1600;
  if (key === 'editorFontSize') return 15;
  if (key === 'editorSerif') return true;
  if (key === 'lineNumbers') return true;
  if (key === 'reviewFocus') return DEFAULT_REVIEW_FOCUS;
  if (key === 'maxAnnotations') return 8;
  return undefined;
}

function readSetting(settings, key) {
  if (!settings || typeof settings !== 'object') return undefined;
  return settings[key];
}

function settingNumber(settings, key, min, max) {
  const raw = readSetting(settings, key);
  const fallback = fallbackSetting(key);
  if (raw === undefined || raw === null) return fallback;
  const value = typeof raw === 'number' ? raw : Number(raw);
  if (!Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, value));
}

function settingBoolean(settings, key) {
  const raw = readSetting(settings, key);
  const fallback = fallbackSetting(key);
  return typeof raw === 'boolean' ? raw : fallback;
}

function settingText(settings, key) {
  const raw = readSetting(settings, key);
  return typeof raw === 'string' ? raw : fallbackSetting(key);
}

function messageOf(reason, fallback) {
  if (reason instanceof Error && reason.message) return reason.message;
  if (typeof reason === 'string' && reason) return reason;
  if (reason && typeof reason.message === 'string' && reason.message) return reason.message;
  return fallback;
}

/**
 * page 判定为「迟到的 409」的错误：这一章刚刚解决过冲突（5 秒内），
 * 这次回包带的是解决前的 mtime，只是晚到了。这种错误不能锁自动保存
 * （锁了就是审计里的「先不管 → 自动保存永久停摆」），也不该再弹面板。
 */
function isStaleConflict(reason) {
  return Boolean(reason && reason.staleConflict === true);
}

function chapterChars(content) {
  return String(content === undefined || content === null ? '' : content).replace(/\s/g, '').length;
}

function chapterTitle(chapter) {
  if (chapter && typeof chapter.title === 'string' && chapter.title) return chapter.title;
  const path = chapter && typeof chapter.path === 'string' ? chapter.path : '';
  return path.split('/').pop().replace(/\.md$/i, '') || '未命名章节';
}

/** 下一章的文件路径：chapters/chapter-<最大序号+1>.md，三位补零。 */
function nextChapterPath(list) {
  let max = 0;
  (Array.isArray(list) ? list : []).forEach((chapter) => {
    /* 也要认改名后的 chapter-NNN-标题.md，否则最大号永远算不到，会撞上已存在的文件。 */
    const match = /^chapters\/chapter-(\d+)(?:-[^/]*)?\.md$/i.exec(String(chapter && chapter.path ? chapter.path : ''));
    if (match) max = Math.max(max, Number(match[1]));
  });
  return 'chapters/chapter-' + String(max + 1).padStart(3, '0') + '.md';
}

/** 标题 → 文件名安全片段（保留中文，去掉文件系统非法字符）。 */
function titleSlug(title) {
  return String(title === undefined || title === null ? '' : title)
    .replace(/[\\/:*?"<>|]/g, ' ')
    .replace(/\s+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/\.+$/, '')
    .slice(0, 32);
}

/**
 * 重命名后的目标路径：保留 chapter-NNN 序号前缀（章节顺序靠文件名排序），
 * 后面挂上标题片段；不是 chapter-NNN 命名的章节则直接用标题。
 */
function renamedPath(chapter, title) {
  const from = String(chapter && chapter.path ? chapter.path : '');
  const cut = from.lastIndexOf('/');
  const dir = cut < 0 ? '' : from.slice(0, cut + 1);
  const base = from.slice(cut + 1).replace(/\.md$/i, '');
  const slug = titleSlug(title);
  const numbered = /^(chapter-\d+)/i.exec(base);
  if (numbered) return dir + (slug ? numbered[1] + '-' + slug : numbered[1]) + '.md';
  return dir + (slug || base) + '.md';
}

/** 正文一级标题：有 # 行就替换（只换第一条），没有就补在最前面。 */
function withChapterHeading(content, title) {
  const text = String(content === undefined || content === null ? '' : content).replace(/\r\n/g, '\n');
  const lines = text.split('\n');
  const at = lines.findIndex(line => /^#\s+/.test(line));
  const heading = '# ' + title;
  if (at >= 0) {
    const next = lines.slice();
    next[at] = heading;
    return next.join('\n');
  }
  return heading + '\n\n' + text.replace(/^\n+/, '');
}

function clipText(value, max) {
  const text = typeof value === 'string' ? value : '';
  return text.length > max ? text.slice(0, max) + '…' : text;
}

/** 这条批注是不是 AI 写的（Host 审阅写的是 'dsh'，旧数据里是 'ai' / 'AI'）。 */
function isAiSource(source) {
  return source === 'dsh' || source === 'ai' || source === 'AI';
}

/**
 * 重跑审阅时的合并规则：本章里 status !== 'resolved' 的旧 AI 批注被这一轮结果替换，
 * 已解决（resolved）的旧 AI 批注保留——那是作者已经处理完、确认过的意见，
 * 重跑一次审阅不该把它们从列表里抹掉。手动批注（source 不是 AI）一律保留。
 */
function keepAcrossRerun(annotation, path) {
  if (!annotation || annotation.documentPath !== path) return true;
  if (!isAiSource(annotation.source)) return true;
  return annotation.status === 'resolved';
}

/** 定位时用真实行高：优先取计算样式（--moshu-editor-font-size × line-height），拿不到再退回 28px。 */
function measureLineHeight(element) {
  const fallback = 28;
  if (!element || typeof window === 'undefined' || !window.getComputedStyle) return fallback;
  let computed = null;
  try {
    computed = window.getComputedStyle(element);
  } catch (error) {
    return fallback;
  }
  if (!computed) return fallback;
  const lineHeight = parseFloat(computed.lineHeight);
  if (isFinite(lineHeight) && lineHeight > 0) return lineHeight;
  const fontSize = parseFloat(computed.fontSize);
  if (isFinite(fontSize) && fontSize > 0) return fontSize * 2.15;
  return fallback;
}

/**
 * /ai/review 的请求体：与 api.js 里 aiReview 的形状保持一致
 * （api 签名不带第四个参数时由编辑器自己发，才能把 maxAnnotations 带上）。
 */
function reviewPayload(project, path, content, instruction) {
  const payload = { mode: 'review', path, documentPath: path, content, instruction };
  if (!project || typeof project !== 'object') return payload;
  const included = Array.isArray(project.contextDocumentIds) ? project.contextDocumentIds : [];
  const documents = Array.isArray(project.documents) ? project.documents : [];
  const memories = Array.isArray(project.memories) ? project.memories : [];
  const related = documents
    .filter(doc => included.indexOf(doc.id) !== -1 && doc.path !== path)
    .slice(0, 5)
    .map(doc => ({ title: doc.title, path: doc.path, content: clipText(doc.content, 1200) }));
  const picked = memories
    .filter(memory => memory.status !== 'pending')
    .sort((a, b) => Number(Boolean(b.locked)) - Number(Boolean(a.locked)))
    .slice(0, 10)
    .map(memory => ({ title: memory.title, content: clipText(memory.content, 400), locked: Boolean(memory.locked) }));
  payload.sources = [path].concat(picked.filter(memory => memory.locked).map(memory => memory.title));
  payload.context = { memories: picked, related };
  return payload;
}

async function requestReview(options) {
  const { project, path, content, instruction, maxAnnotations } = options;
  if (typeof api.aiReview === 'function' && api.aiReview.length >= 4) {
    return api.aiReview(path, content, instruction, { maxAnnotations });
  }
  if (typeof api.request !== 'function') throw new Error('AI 审阅接口暂不可用，请刷新页面后重试。');
  const payload = reviewPayload(project, path, content, instruction);
  payload.maxAnnotations = maxAnnotations;
  return api.request('/ai/review', { method: 'POST', body: JSON.stringify(payload) });
}

function inlineMarkdown(value) {
  return value.split(/(\*\*[^*]+\*\*|`[^`]+`|\*[^*\n]+\*)/g).filter(Boolean).map((part, index) => {
    if (part.startsWith('**') && part.endsWith('**')) return <strong key={index}>{part.slice(2, -2)}</strong>;
    if (part.startsWith('`') && part.endsWith('`')) return <code key={index}>{part.slice(1, -1)}</code>;
    if (part.startsWith('*') && part.endsWith('*')) return <em key={index}>{part.slice(1, -1)}</em>;
    return <Fragment key={index}>{part}</Fragment>;
  });
}

function MarkdownPreview({ content }) {
  /* 与资料页共用同一套解析：一行一段会把折行拆成多段，表格与代码块也渲染不出来。 */
  /* 正文按「一段一行」渲染：一行一段，不把相邻行并成一段。 */
  return <Markdown content={content} className="editor-markdown-preview" prose />;
}

function MenuDots({ size = 14 }) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} fill="currentColor" aria-hidden="true" focusable="false">
      <circle cx="5.4" cy="12" r="1.7" />
      <circle cx="12" cy="12" r="1.7" />
      <circle cx="18.6" cy="12" r="1.7" />
    </svg>
  );
}

function HistoryIcon({ size = 17 }) {
  return (
    <svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth={1.65}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <path d="M4.2 12a7.8 7.8 0 1 0 2.6-5.8" />
      <path d="M4.2 4.6v4.2h4.2" />
      <path d="M12 8.2V12l2.9 1.9" />
    </svg>
  );
}

function Editor({
  onConnectDsh,
  hideTopbar,
  hideRail,
  onToggleTopbar,
  onToggleRail,
  chapters,
  activeChapterId,
  onSelectChapter,
  onContentChange,
  onSave,
  annotations,
  onAnnotationsChange,
  project,
  settings,
  onDocumentsChanged,
  onNotify,
  onDirtyChange,
  contentRevision = 0,
  editorApi,
  bookKey = '',
  className = '',
  /* CONTRACT-v3 §3.1：未保存正文的权威副本在 page 上。
     initialDrafts 是挂载那一刻的草稿表（path → {content}，也接受纯字符串），
     onDraftChange(path, content) 每次输入同步回 page，onDraftClear(path) 表示明确丢弃，
     discardedPaths（path → 递增序号）是「页面已经丢弃了这几章的本地正文」的通知。
     四个都是可缺省的：不传就退化成以前“只活在组件实例里”的行为。 */
  initialDrafts = null,
  onDraftChange,
  onDraftClear,
  discardedPaths = null,
}) {
  const chapterList = Array.isArray(chapters) ? chapters : [];
  const annotationList = Array.isArray(annotations) ? annotations : [];

  const textareaRef = useRef(null);
  /* 行号面板要跟着 textarea 一起滚：以前它是独立 overflow:hidden 的容器，
     滚到第 200 行时左边还停在 1..30，按行号找批注全会错位。 */
  const gutterRef = useRef(null);
  /* 行号要对齐的是**视觉行**：一段话在正文里折成 3 行，行号面板却只占 1 行高，
     越往下错得越多。这里用同字体的离屏量尺量出每行实际占几行，再写回 span 高度。 */
  const measureGutterRef = useRef(function () {});
  const gutterInnerRef = useRef(null);
  const containerRef = useRef(null);

  /**
   * 行号跟随滚动。
   *
   * 以前是把 textarea 的 scrollTop 抄给行号栏，但真正滚的并不总是 textarea：
   * 正文撑高时滚的是外层 .editor-text-container，textarea 自己不动 ——
   * onScroll 根本不触发，行号就"钉"在原地。现在两个都听，并且用 transform 位移，
   * 不依赖行号栏自己能不能滚。
   */
  function syncGutterScroll() {
    const inner = gutterInnerRef.current;
    const area = textareaRef.current;
    const box = containerRef.current;
    if (!inner) return;
    const top = Math.max(
      area && area.scrollTop ? area.scrollTop : 0,
      box && box.scrollTop ? box.scrollTop : 0,
    );
    inner.style.transform = top ? 'translateY(' + (-top) + 'px)' : '';
  }
  const syncGutterScrollRef = useRef(syncGutterScroll);
  syncGutterScrollRef.current = syncGutterScroll;

  function measureGutter() {
    const gutter = gutterRef.current;
    const area = textareaRef.current;
    if (!gutter || !area) return;
    const spans = gutter.querySelectorAll('span');
    if (!spans.length) return;
    /* 还没布局完（宽度为 0）时别量：那会算出一堆假高度，反而更乱。 */
    if (!(area.clientWidth > 40)) return;
    const computed = window.getComputedStyle(area);
    const lineHeight = parseFloat(computed.lineHeight)
      || (parseFloat(computed.fontSize) || 15) * 2.15;
    if (!(lineHeight > 0)) return;

    const probe = document.createElement('div');
    probe.setAttribute('aria-hidden', 'true');
    probe.style.cssText = 'position:absolute;left:-9999px;top:0;visibility:hidden;pointer-events:none;'
      + 'white-space:pre-wrap;overflow-wrap:anywhere;word-break:break-word;padding:0;border:0;';
    probe.style.fontFamily = computed.fontFamily;
    probe.style.fontSize = computed.fontSize;
    probe.style.lineHeight = computed.lineHeight;
    probe.style.letterSpacing = computed.letterSpacing;
    probe.style.width = Math.max(20, area.clientWidth
      - (parseFloat(computed.paddingLeft) || 0)
      - (parseFloat(computed.paddingRight) || 0)) + 'px';
    document.body.appendChild(probe);

    const raw = String(area.value || '').split('\n');
    spans.forEach(function (span, index) {
      const text = raw[index] === undefined ? '' : raw[index];
      probe.textContent = text.length ? text : ' ';
      const visual = Math.max(1, Math.round(probe.getBoundingClientRect().height / lineHeight));
      span.style.height = (visual * lineHeight) + 'px';
    });

    document.body.removeChild(probe);
  }
  measureGutterRef.current = measureGutter;
  const menuRef = useRef(null);
  const saveRef = useRef(onSave);
  /* 批注的最新视图：异步流程（审阅）里不能用渲染闭包里的旧数组。 */
  const annotationsRef = useRef([]);
  const bookKeyRef = useRef(bookKey);
  const pendingSelectRef = useRef(null);
  saveRef.current = onSave;

  /* ---- 未保存正文的“随身快照” ----
     dirtyRef：path → 最新正文。用户每敲一个字就更新，保存成功才删除。
     这样切章 / 卸载时，即使父组件的 props 还没回流到最新值，cleanup 里也能拿到真实内容。
     挂载时用 page 的草稿种子初始化 —— 这是「卸载重挂丢稿」的修法：组件实例可以销毁，
     正文的权威副本在 page 的 draftsRef 里，重新挂载时再灌回来。
     savingRef / inflightRef：正在写的 path 与那次请求的 promise，
     既避免重复提交，也让「保存飞行中又有新输入」的情况能补写一次。 */
  const initialDraftsRef = useRef(null);
  if (initialDraftsRef.current === null) {
    const seed = Object.create(null);
    if (initialDrafts && typeof initialDrafts === 'object') {
      Object.keys(initialDrafts).forEach(function (path) {
        const entry = initialDrafts[path];
        const value = typeof entry === 'string'
          ? entry
          : (entry && typeof entry.content === 'string' ? entry.content : undefined);
        if (path && typeof value === 'string') seed[path] = value;
      });
    }
    initialDraftsRef.current = seed;
  }
  const dirtyRef = useRef(initialDraftsRef.current);
  const savingRef = useRef('');
  const inflightRef = useRef(null);
  const notifyRef = useRef(onNotify);
  const dirtyNotifyRef = useRef(onDirtyChange);
  const draftNotifyRef = useRef(onDraftChange);
  const draftClearRef = useRef(onDraftClear);
  const mountedRef = useRef(true);
  notifyRef.current = onNotify;
  dirtyNotifyRef.current = onDirtyChange;
  draftNotifyRef.current = onDraftChange;
  draftClearRef.current = onDraftClear;

  annotationsRef.current = annotationList;

  const reportDirty = (flag) => {
    const handler = dirtyNotifyRef.current;
    if (typeof handler !== 'function') return;
    try {
      handler(Boolean(flag));
    } catch (error) {
      /* 上报失败不影响正文 */
    }
  };

  const markDirty = (path, content) => {
    if (!path || typeof content !== 'string') return;
    dirtyRef.current[path] = content;
    /* 同步一份到 page：组件实例销毁以后，这份草稿还在。没传 onDraftChange 就跳过。 */
    const draftHandler = draftNotifyRef.current;
    if (typeof draftHandler === 'function') {
      try {
        draftHandler(path, content);
      } catch (error) {
        /* 草稿上报失败不影响正文 */
      }
    }
    reportDirty(true);
  };

  const clearDirty = (path) => {
    if (!path) return;
    if (Object.prototype.hasOwnProperty.call(dirtyRef.current, path)) delete dirtyRef.current[path];
    /* 明确丢弃（换成磁盘版本 / 恢复备份 / 删章）时，page 上的草稿也要一起丢，
       否则重新挂载时种子会把被否定的旧文字又灌回编辑器。 */
    const clearHandler = draftClearRef.current;
    if (typeof clearHandler === 'function') {
      try {
        clearHandler(path);
      } catch (error) {
        /* 同上 */
      }
    }
    if (!Object.keys(dirtyRef.current).length) reportDirty(false);
  };

  const pendingContentOf = (path) => {
    if (!path) return undefined;
    const value = dirtyRef.current[path];
    return typeof value === 'string' ? value : undefined;
  };

  /**
   * 保存成功后的收尾。只有「当前脏内容还是刚写下去的那一份」才清标记：
   * 保存飞行期间用户又敲了新字，就继续保持 dirty（那份新字由下一次自动保存接住）。
   * @returns {boolean} 是否已经彻底落地
   */
  const settleSaved = (path, content) => {
    const pending = pendingContentOf(path);
    if (pending === undefined) {
      if (!Object.keys(dirtyRef.current).length) reportDirty(false);
      return true;
    }
    if (pending !== content) return false;
    clearDirty(path);
    return true;
  };

  /** 所有写盘都走这里：记下 savingRef / inflightRef，供 flush 判断与补偿。 */
  const runSave = (path, content) => {
    savingRef.current = path;
    const promise = Promise.resolve().then(() => saveRef.current(path, content));
    inflightRef.current = { path: path, promise: promise };
    const release = () => {
      if (savingRef.current === path) savingRef.current = '';
      if (inflightRef.current && inflightRef.current.promise === promise) inflightRef.current = null;
    };
    promise.then(release, release);
    return promise;
  };

  /**
   * 立刻把某个路径上还没落盘的正文写掉（不等 debounce）。
   * 只在 refs 上工作：切章 / 卸载的 cleanup 里也能安全调用（组件可能已经卸载）。
   */
  const flushPath = (path, reason) => {
    const content = pendingContentOf(path);
    if (content === undefined) return Promise.resolve(false);
    if (savingRef.current === path) {
      // 这一章正有一次保存飞行中：等它落地后再按最新正文补一次，
      // 否则飞行期间敲的那几个字会被这次保存的 clearDirty 抹掉。
      const inflight = inflightRef.current;
      if (inflight && inflight.path === path) {
        return inflight.promise.then(
          () => flushPath(path, reason),
          () => flushPath(path, reason),
        );
      }
      return Promise.resolve(false);
    }
    const fileName = String(path).split('/').pop() || path;
    const task = runSave(path, content)
      .then(() => {
        const settled = settleSaved(path, content);
        if (settled && !Object.keys(dirtyRef.current).length) reportDirty(false);
        return true;
      })
      .catch((error) => {
        /* 失败就把它放回 dirty，正文绝不静默丢掉。
           但如果飞行途中作者又敲了字（dirtyRef 里已经是更新的一份），
           不能用旧的 content 把它盖掉。 */
        if (pendingContentOf(path) === undefined) {
          dirtyRef.current[path] = content;
          reportDirty(true);
        }
        const text = messageOf(error, '请稍后重试');
        const handler = notifyRef.current;
        if (typeof handler === 'function') {
          try {
            handler('「' + fileName + '」' + (reason ? reason + '时' : '') + '没能保存：' + text);
          } catch (notifyError) {
            /* toast 失败不影响正文 */
          }
        }
        /* 只有「写的就是当前这一章」才改当前章的指示器：切章时后台补写的旧章失败
           不该把新章标成保存失败。 */
        if (mountedRef.current && activePathRef.current === path) {
          setSaveState('dirty');
          setError('「' + fileName + '」有未保存的修改，保存失败：' + text);
        }
        throw error;
      });
    // 卸载路径上没人 await：吞掉 rejection，错误已经 toast 过了。
    task.catch(() => {});
    return task;
  };

  /**
   * 把所有还没落盘的正文一次性写掉（顺序执行，同一路径不会并发）。
   * 切书前必须调它：切书后服务端 novelDir 已经换了，此时再 flush 就会写进新书。
   * 失败必须抛出去 —— 外层靠它决定"先别切书"，吞掉就等于静默丢稿。
   */
  const flushAllDirty = async () => {
    /* 以前只跑一遍「开始时看到的那些 path」：flush 期间作者继续打字产生的新脏内容
       就被漏掉了，切书之后那段文字谁也没写。这里循环到「真的没有脏内容」为止。 */
    let failed = 0;
    let lastError = null;
    for (let round = 0; round < 5; round += 1) {
      const paths = Object.keys(dirtyRef.current);
      if (!paths.length) break;
      for (const path of paths) {
        try {
          await flushPath(path, '切换作品');
        } catch (error) {
          failed += 1;
          lastError = error;
        }
      }
      if (Object.keys(dirtyRef.current).length === 0) break;
    }
    if (failed > 0) {
      const reason = lastError && lastError.message ? `：${lastError.message}` : '';
      throw new Error(`有 ${failed} 个文件没能保存${reason}`);
    }
    if (Object.keys(dirtyRef.current).length) {
      throw new Error('还有内容没写完（可能一直在改），已中止切换。');
    }
    return true;
  };

  /* 把 flush 能力交给外层（page 在切书前 await 它）。每次渲染刷新一遍，闭包永远是最新的。 */
  useEffect(() => {
    if (!editorApi) return undefined;
    editorApi.current = { flushAll: flushAllDirty };
    return () => {
      if (editorApi.current && editorApi.current.flushAll === flushAllDirty) editorApi.current = null;
    };
  });

  /**
   * 换书：上一本书的未保存快照绝不能跟着过来。
   * 正常路径上 page 已经先 flush 过；这里是兜底（flush 失败 / 别处换了书）。
   * 初值用挂载时的 bookKey：首次挂载不能把刚用 initialDrafts 灌进来的草稿清掉
   * （以前初值是空串，挂载那一次必定触发清空 —— 重挂丢稿就是从这里漏掉的）。
   */
  useEffect(() => {
    if (!bookKey) return;
    if (bookKeyRef.current === bookKey) return;
    bookKeyRef.current = bookKey;
    dirtyRef.current = Object.create(null);
    reportDirty(false);
  }, [bookKey]);

  /* 改名/移动/新建会让文件的 id 变掉。趁新目录到达的这一帧就把选中项换算过去，
     免得中间有一帧回落到第一章（那会让自动保存盯错文件）。 */
  const pendingSelection = pendingSelectRef.current;
  const pendingMatch = pendingSelection && Date.now() - pendingSelection.at <= PENDING_SELECT_MS
    ? (chapterList.find(pendingSelection.match) || null)
    : null;
  const effectiveActiveId = pendingMatch ? pendingMatch.id : activeChapterId;
  const activeChapter = chapterList.find(chapter => chapter.id === effectiveActiveId) || chapterList[0] || null;

  /* ---- settings（可能为 undefined，全部走原默认值） ---- */
  const autosaveDelay = settingNumber(settings, 'autosaveDelayMs', 600, 6000);
  const editorFontSize = settingNumber(settings, 'editorFontSize', 13, 22);
  const editorSerif = settingBoolean(settings, 'editorSerif');
  const lineNumbersSetting = settingBoolean(settings, 'lineNumbers');
  const reviewFocus = settingText(settings, 'reviewFocus');
  const maxAnnotations = settingNumber(settings, 'maxAnnotations', 1, 20);

  const [mode, setMode] = useState('write');
  // null = 跟随设置里的初始值；用户手动切换后以手动为准。
  const [lineNumberPreference, setLineNumberPreference] = useState(null);
  const [showAnnotations, setShowAnnotations] = useState(true);
  const [saveState, setSaveState] = useState(() => {
    /* 带着草稿重新挂载时如实显示「有未保存修改」——
       以前一律从 'saved' 起步，保存失败后切 tab 再回来就显示「已保存」，
       而磁盘上其实还是旧的，永远不会再写一次。 */
    const landingPath = activeChapter ? activeChapter.path : '';
    return landingPath && pendingContentOf(landingPath) !== undefined ? 'dirty' : 'saved';
  });
  // 保存被别处改动挡住（409）时置真：暂停自动保存，等作者在冲突面板里做决定，
  // 绝不自动重试、也绝不静默覆盖。
  const [needsAttention, setNeedsAttention] = useState(false);
  const [savedAt, setSavedAt] = useState(null);
  const [error, setError] = useState('');
  const [flash, setFlash] = useState('');
  const [reviewing, setReviewing] = useState(false);
  const [instruction, setInstruction] = useState(reviewFocus);
  const [instructionEdited, setInstructionEdited] = useState(false);
  const [selection, setSelection] = useState({ start: 0, end: 0, text: '' });
  const [menuChapterId, setMenuChapterId] = useState(null);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [dialog, setDialog] = useState(null);
  const [dialogError, setDialogError] = useState('');
  const [busy, setBusy] = useState('');

  const showLineNumbers = lineNumberPreference === null ? lineNumbersSetting : lineNumberPreference;
  const activePath = activeChapter ? activeChapter.path : '';
  const activeTitle = activeChapter ? chapterTitle(activeChapter) : '';

  /* 保存回包要按「回包到达时打开的是哪一章」判断归属：
     飞行中切了章，旧章的回包不能把新章的 saveState 改成 saved（那会取消新章的自动保存）。 */
  const activePathRef = useRef(activePath);
  activePathRef.current = activePath;

  /* 行号跟随：textarea 与容器都挂原生 scroll（合成事件在容器滚动时收不到）。 */
  useEffect(function () {
    if (!showLineNumbers) return undefined;
    const area = textareaRef.current;
    const box = containerRef.current;
    const handler = function () { syncGutterScrollRef.current(); };
    if (area) area.addEventListener('scroll', handler, { passive: true });
    if (box) box.addEventListener('scroll', handler, { passive: true });
    return function () {
      if (area) area.removeEventListener('scroll', handler);
      if (box) box.removeEventListener('scroll', handler);
    };
  }, [showLineNumbers, activeChapter && activeChapter.id]);

  /* 行号量尺：正文、字号、字体、行号开关、窗口宽度变化都重量一次（下一帧，等布局稳定）。 */
  useEffect(function () {
    if (!showLineNumbers) return undefined;
    let frame = 0;
    function schedule() {
      if (frame) cancelAnimationFrame(frame);
      frame = requestAnimationFrame(function () { measureGutterRef.current(); });
    }
    schedule();
    window.addEventListener('resize', schedule);
    syncGutterScrollRef.current();
    return function () {
      if (frame) cancelAnimationFrame(frame);
      window.removeEventListener('resize', schedule);
    };
  }, [activeChapter && activeChapter.content, showLineNumbers, editorFontSize, editorSerif]);

  const editorStyle = {
    '--moshu-editor-font-size': editorFontSize + 'px',
    '--moshu-editor-font-family': editorSerif ? 'var(--moshu-serif)' : 'var(--moshu-sans)',
  };

  // 卸载标记：flush 的 catch 里要先知道组件还在不在，才决定要不要 setState。
  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  /* 挂载时如果带着草稿回来（page 的 initialDrafts），立刻把「有未保存正文」报上去：
     beforeunload 靠它决定要不要拦，自动保存也靠它排定时器。 */
  useEffect(() => {
    if (Object.keys(dirtyRef.current).length) reportDirty(true);
  }, []);

  useEffect(() => {
    /* 落到的那一章如果还有没落盘的草稿（重挂带回来的、或之前切走没写完的），
       如实标成 dirty，自动保存才会接手。 */
    const landingPath = activePath;
    setSaveState(landingPath && pendingContentOf(landingPath) !== undefined ? 'dirty' : 'saved');
    setNeedsAttention(false);
    setError('');
    setSelection({ start: 0, end: 0, text: '' });
    setMenuChapterId(null);
    setHistoryOpen(false);
    setDialog(null);
    setDialogError('');
  }, [activeChapterId]);

  /* 切章 / 卸载：把这一章还没落盘的正文立刻 flush 一次。
     cleanup 拿到的是「上一次渲染时的 path」，正好就是要离开的那一章；
     正文从 dirtyRef 取，所以不依赖父组件的 props 是否已经回流。 */
  useEffect(() => {
    const leavingPath = activePath;
    return () => {
      if (!leavingPath) return;
      flushPath(leavingPath, '切章或离开写作视图');
    };
  }, [activePath]);

  /* 外部替换正文（冲突面板选了「用磁盘版本」）：丢掉本地未保存快照，
     否则下一次切章又会把旧文字写回磁盘。contentRevision 由 page.jsx 递增（当前章）。 */
  const revisionRef = useRef(contentRevision);
  useEffect(() => {
    if (revisionRef.current === contentRevision) return;
    revisionRef.current = contentRevision;
    /* 只丢当前这一章的快照。以前是 `dirtyRef = {}` 清全表：
       另一章里还没落盘的字会静默变成「已保存」，关浏览器就没了。
       非当前章要丢的走 page 的 discardedPaths（下面那个 effect）。 */
    const currentPath = activePathRef.current;
    if (currentPath && Object.prototype.hasOwnProperty.call(dirtyRef.current, currentPath)) {
      delete dirtyRef.current[currentPath];
    }
    if (!Object.keys(dirtyRef.current).length) reportDirty(false);
    setNeedsAttention(false);
    setSaveState('saved');
    setError('');
  }, [contentRevision]);

  /* 页面明确丢弃了某几章的本地正文（可能是非当前章，contentRevision 覆盖不到）：
     编辑器里的快照也要丢，否则切回那一章时自动保存会把被否定的旧文字写回磁盘。 */
  const discardedSeenRef = useRef(Object.create(null));
  useEffect(() => {
    if (!discardedPaths || typeof discardedPaths !== 'object') return;
    const paths = Object.keys(discardedPaths);
    if (!paths.length) return;
    let touched = false;
    paths.forEach(function (path) {
      const mark = discardedPaths[path];
      const known = discardedSeenRef.current[path];
      if (typeof known === 'number' && known >= mark) return;
      discardedSeenRef.current[path] = mark;
      if (Object.prototype.hasOwnProperty.call(dirtyRef.current, path)) {
        delete dirtyRef.current[path];
        touched = true;
      }
      if (path === activePathRef.current) {
        setNeedsAttention(false);
        setSaveState('saved');
        setError('');
      }
    });
    if (touched && !Object.keys(dirtyRef.current).length) reportDirty(false);
  }, [discardedPaths]);

  /* 自动保存：停手 autosaveDelay 之后才落盘。
     被冲突挡住（needsAttention）时不排定时器——自动重试只会反复撞 409。 */
  useEffect(() => {
    if (saveState !== 'dirty' || !activeChapter || needsAttention) return undefined;
    const path = activeChapter.path;
    const timer = window.setTimeout(() => {
      const pending = pendingContentOf(path);
      const content = pending === undefined ? activeChapter.content : pending;
      if (pending === undefined) {
        // 已经被别处（切章 flush）写掉了，不用重复提交
        if (savingRef.current !== path) setSaveState('saved');
        return;
      }
      setSaveState('saving');
      runSave(path, content)
        .then(() => {
          const landed = settleSaved(path, content);
          /* 回包只对「还是当前这一章」负责：飞行中切了章，旧章的回包只做 settleSaved，
             不许把新章的 saveState 改成 saved —— 那会取消新章已经排好的自动保存。 */
          if (activePathRef.current !== path) return;
          if (landed) {
            setSaveState('saved');
            setSavedAt(new Date());
          } else {
            // 保存飞行期间又敲了新字：保持 dirty，effect 会为那份新内容再排一次
            setSaveState('dirty');
          }
        })
        .catch(reason => {
          if (isStaleConflict(reason)) {
            /* 迟到的 409：这一章在 page 那边已经解决完了。保持 dirty 让自动保存
               用新的 mtime 再试一次；不要重新标「待处理冲突」（那样自动保存永久停摆），
               也不要把已经被否定的正文塞回 dirtyRef。 */
            if (activePathRef.current === path) setSaveState('dirty');
            return;
          }
          /* 飞行途中又敲了字就别用旧 content 盖掉新内容。 */
          if (pendingContentOf(path) === undefined) {
            dirtyRef.current[path] = content;
            reportDirty(true);
          }
          if (api && typeof api.isConflict === 'function' && api.isConflict(reason)) {
            setNeedsAttention(true);
            setSaveState('dirty');
            setError('这个文件在磁盘上被其他来源修改了，请在冲突面板里选择保留哪一版（你的文字还在，没有丢）。');
            return;
          }
          setSaveState('error');
          setError(messageOf(reason, '自动保存失败'));
        });
    }, autosaveDelay);
    return () => window.clearTimeout(timer);
  }, [activeChapter && activeChapter.content, saveState, activeChapter && activeChapter.path, autosaveDelay, needsAttention]);

  // settings 晚到时补上审阅重点（用户已经手改过就不再覆盖）。
  useEffect(() => {
    if (instructionEdited) return;
    setInstruction(reviewFocus);
  }, [reviewFocus, instructionEdited]);

  useEffect(() => {
    if (!flash) return undefined;
    const timer = window.setTimeout(() => setFlash(''), 6000);
    return () => window.clearTimeout(timer);
  }, [flash]);

  // 章节菜单：Esc 关闭、点外部关闭。
  useEffect(() => {
    if (!menuChapterId) return undefined;
    function onKeyDown(event) {
      if (event.key === 'Escape') setMenuChapterId(null);
    }
    function onPointerDown(event) {
      const target = event.target;
      if (target && typeof target.closest === 'function' && target.closest('[data-editor-menu-trigger]')) return;
      if (menuRef.current && target && menuRef.current.contains(target)) return;
      setMenuChapterId(null);
    }
    window.addEventListener('keydown', onKeyDown);
    document.addEventListener('mousedown', onPointerDown);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      document.removeEventListener('mousedown', onPointerDown);
    };
  }, [menuChapterId]);

  // 弹层：Esc 关闭（处理中不关）。
  useEffect(() => {
    if (!dialog) return undefined;
    function onKeyDown(event) {
      if (event.key !== 'Escape' || busy) return;
      setDialog(null);
      setDialogError('');
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [dialog, busy]);

  // 移动/改名/删除后目录会重排，等新目录到了再把父组件的选中项同步过去。
  useEffect(() => {
    const pending = pendingSelectRef.current;
    if (!pending) return;
    if (Date.now() - pending.at > PENDING_SELECT_MS) { pendingSelectRef.current = null; return; }
    const found = chapterList.find(pending.match);
    if (!found) return;
    pendingSelectRef.current = null;
    if (found.id !== activeChapterId && typeof onSelectChapter === 'function') onSelectChapter(found.id);
  }, [chapters]);

  const chapterAnnotations = useMemo(
    () => annotationList.filter(a => a.documentPath === activePath),
    [annotationList, activePath],
  );
  const lines = ((activeChapter && activeChapter.content) || '').replace(/\r/g, '').split('\n');

  const save = async () => {
    if (!activeChapter || saveState === 'saving') return;
    // 手动保存是作者的明确意图：解掉冲突暂停，再试一次（撞 409 会重新弹面板）
    setNeedsAttention(false);
    const path = activeChapter.path;
    const pending = pendingContentOf(path);
    const content = pending === undefined ? activeChapter.content : pending;
    setSaveState('saving');
    try {
      await runSave(path, content);
      const landed = settleSaved(path, content);
      if (activePathRef.current !== path) return;
      if (landed) {
        setSaveState('saved');
        setSavedAt(new Date());
      } else {
        setSaveState('dirty');
      }
    } catch (reason) {
      if (isStaleConflict(reason)) {
        // 迟到的 409：面板那边已经解决过，别锁自动保存，保持 dirty 让下一次自动保存接手。
        if (activePathRef.current === path) setSaveState('dirty');
        return;
      }
      if (api && typeof api.isConflict === 'function' && api.isConflict(reason)) {
        setNeedsAttention(true);
        setSaveState('dirty');
        setError('这个文件在磁盘上被其他来源修改了，请在冲突面板里选择保留哪一版（你的文字还在，没有丢）。');
      } else {
        setSaveState('error');
        setError(messageOf(reason, '保存失败'));
      }
    }
  };

  const captureSelection = () => {
    const el = textareaRef.current;
    if (el) setSelection({ start: el.selectionStart, end: el.selectionEnd, text: el.value.slice(el.selectionStart, el.selectionEnd) });
  };

  const review = async () => {
    if (!activeChapter || reviewing) return;
    setReviewing(true);
    setError('');
    setFlash('');
    setShowAnnotations(true);
    const path = activeChapter.path;
    try {
      // 审阅要看的是磁盘上的正文：先把这一章没落盘的改动写掉（失败就中止，不拿旧正文去审）
      const pending = pendingContentOf(path);
      if (pending !== undefined) {
        await runSave(path, pending);
        const landed = settleSaved(path, pending);
        if (activePathRef.current === path) {
          if (landed) {
            setSaveState('saved');
            setSavedAt(new Date());
          } else {
            setSaveState('dirty');
          }
        }
      }
      const result = await requestReview({
        project,
        path,
        /* 审阅用「刚写下去的正文」，不是 props 里的旧值：刚改完一句就点审阅时，
           用旧正文会让 AI 评的是上一版，锚点也会按旧文本算。 */
        content: pending !== undefined ? pending : activeChapter.content,
        instruction,
        maxAnnotations,
      });
      const found = result && Array.isArray(result.annotations) ? result.annotations : [];
      const dropped = result && typeof result.dropped === 'number' && isFinite(result.dropped) ? Number(result.dropped) : 0;
      /* ---- 合并规则（这一轮审阅的结果怎么和旧批注合） ----
         1. 别的章节的批注：全部保留。
         2. 本章手动批注（source 不是 AI）：全部保留。
         3. 本章旧 AI 批注：status === 'resolved' 的保留（作者已经处理过，这是劳动成果），
            其余（open / stale）被这一轮结果替换。
         4. 新结果（found）直接追加；Host 已经给它们 source:'dsh'、status:'open'。
         注意：必须用 annotationsRef.current（最新一张表），不能用渲染时的闭包快照——
         审阅要跑十几秒，期间作者解决的/新增的批注会被快照覆盖掉（实测丢过）。 */
      const latest = annotationsRef.current || annotationList;
      const kept = latest.filter(a => keepAcrossRerun(a, path));
      if (onAnnotationsChange) await onAnnotationsChange([...kept, ...found]);
      const keptResolved = kept.filter(a => a.documentPath === path && isAiSource(a.source) && a.status === 'resolved').length;
      const parts = [];
      if (found.length) parts.push(`DSH 审阅完成，新增 ${found.length} 条批注。`);
      else parts.push('DSH 未发现可明确定位的问题。');
      if (keptResolved) parts.push(`保留了之前已解决的 ${keptResolved} 条 AI 批注。`);
      // dropped 只在真丢了东西的时候提；0 条不啰嗦。
      if (dropped > 0) parts.push(`另有 ${dropped} 条批注因为引用的原文定位不到而丢弃。`);
      // 成功走中性提示（flash → role="status"），不走告警样式。
      setFlash(parts.join(''));
    } catch (reason) {
      setError(messageOf(reason, 'DSH 审阅失败，请检查连接后重试。'));
    } finally {
      setReviewing(false);
    }
  };

  const locate = (annotation) => {
    if (!annotation) return;
    setMode('write');
    const chapter = chapterList.find(c => c.path === annotation.documentPath);
    if (chapter && chapter.id !== activeChapterId && typeof onSelectChapter === 'function') onSelectChapter(chapter.id);
    window.setTimeout(() => {
      const el = textareaRef.current;
      if (!el) return;
      el.focus();
      /* 同一句话在正文里出现多次时，indexOf 永远跳第一处（实测锚在第 26 个字符却跳到第 12 个）。
         先看已记录的 start 是否仍然对得上，再用 prefix/suffix 选唯一候选。 */
      const quote = annotation.quote || '';
      let start = -1;
      if (quote) {
        const recorded = annotation.start;
        if (Number.isInteger(recorded) && el.value.slice(recorded, recorded + quote.length) === quote) {
          start = recorded;
        } else {
          const candidates = [];
          let from = 0;
          while (from <= el.value.length - quote.length) {
            const found = el.value.indexOf(quote, from);
            if (found < 0) break;
            candidates.push(found);
            from = found + 1;
          }
          const withContext = candidates.filter((at) => {
            const before = annotation.prefix === undefined || el.value.slice(0, at).endsWith(annotation.prefix);
            const after = annotation.suffix === undefined || el.value.slice(at + quote.length).startsWith(annotation.suffix);
            return before && after;
          });
          if (withContext.length === 1) start = withContext[0];
          else if (candidates.length === 1) start = candidates[0];
          else if (candidates.length > 1) {
            setFlash(`这段原文在本章出现了 ${candidates.length} 次，无法确定批注指的是哪一处；已在第一条出现位置定位，请自行核对。`);
            start = candidates[0];
          }
        }
      }
      if (start < 0) start = annotation.start || 0;
      const end = start + (quote ? quote.length : 0);
      el.setSelectionRange(start, end);
      /* 不再手写 scrollTop：setSelectionRange 之后浏览器本来就会把光标滚进视野，
         我们那套「按 \n 数行」的估算在软换行下会差几十行，反而把它覆盖掉。 */
      // 滚动位置用真实行高算（行高由 --moshu-editor-font-size × line-height 决定），
      // 不再按 28px/行 硬估——字号一改，估算就全错。
      const lineHeight = measureLineHeight(el);
      const lineIndex = Math.max(0, el.value.slice(0, start).split('\n').length - 1);
      const viewport = el.clientHeight || 0;
      const paddingTop = parseFloat((typeof window !== 'undefined' && window.getComputedStyle
        ? window.getComputedStyle(el).paddingTop
        : '') || '') || 0;
      const targetTop = paddingTop + lineIndex * lineHeight;
      el.scrollTop = Math.max(0, targetTop - Math.max(lineHeight * 2, viewport / 3));
      setSelection({ start, end, text: el.value.slice(start, end) });
    }, 60);
  };

  /** 「重新定位」：拿正文再锚一次引用原文；锚不上就保持 stale 并如实告诉作者。 */
  const relocate = async (annotation) => {
    if (!annotation) return;
    const content = annotation.documentPath === activePath
      ? activeChapter.content
      : ((chapterList.find(c => c.path === annotation.documentPath) || {}).content || '');
    let next = null;
    try {
      next = relocateAnnotation(String(content || ''), annotation);
    } catch (reason) {
      next = null;
    }
    if (!next || next.status === 'stale') {
      setError('这条批注引用的原文在正文里仍然找不到，只能手动删除或重新引一段原文再批注。');
      return;
    }
    if (onAnnotationsChange) {
      await onAnnotationsChange(annotationList.map(a => (a.id === annotation.id ? next : a)));
    }
    setFlash('已重新定位到正文里的位置。');
    if (next.documentPath === activePath) locate(next);
  };

  /* ---- 章节管理 ---- */

  const refreshDocuments = () => {
    if (typeof onDocumentsChanged !== 'function') return false;
    try {
      const result = onDocumentsChanged();
      if (result && typeof result.then === 'function') result.then(undefined, () => {});
    } catch (reason) {
      // 目录刷新失败不该吞掉已经成功的写操作
    }
    return true;
  };

  const closeDialog = () => {
    if (busy) return;
    setDialog(null);
    setDialogError('');
  };

  /**
   * 动章节文件（新建/改名/移动/删除）之后会重刷目录，而目录是从磁盘读的：
   * 先把当前章没保存的修改落盘，否则刷新会把内存里的改动冲掉。
   * 正文取自 dirtyRef（用户敲下的最新值），不依赖 props 是否已经回流。
   */
  const flushPendingSave = async () => {
    if (!activeChapter) return;
    const path = activeChapter.path;
    const pending = pendingContentOf(path);
    const content = pending === undefined ? activeChapter.content : pending;
    if (pending === undefined) return;
    try {
      await runSave(path, content);
      const landed = settleSaved(path, content);
      if (activePathRef.current === path) {
        if (landed) {
          setSaveState('saved');
          setSavedAt(new Date());
        } else {
          setSaveState('dirty');
        }
      }
    } catch (reason) {
      if (pendingContentOf(path) === undefined) dirtyRef.current[path] = content;
      throw new Error('当前章还有未保存的修改，保存失败了：' + messageOf(reason, '请稍后重试'));
    }
  };

  const openCreateDialog = (initialTitle) => {
    setMenuChapterId(null);
    setDialogError('');
    setDialog({ type: 'create', chapter: null, value: typeof initialTitle === 'string' ? initialTitle : ('第' + (chapterList.length + 1) + '章') });
  };

  const openRenameDialog = (chapter) => {
    setMenuChapterId(null);
    setDialogError('');
    setDialog({ type: 'rename', chapter, value: chapterTitle(chapter) });
  };

  const openDeleteDialog = (chapter) => {
    setMenuChapterId(null);
    setDialogError('');
    setDialog({ type: 'delete', chapter, value: '' });
  };

  const selectChapter = (id) => {
    setMenuChapterId(null);
    if (typeof onSelectChapter === 'function') onSelectChapter(id);
  };

  const runCreate = async (title) => {
    if (!title) throw new Error('请先给这一章起个标题。');
    if (title.length > 120) throw new Error('标题最多 120 个字。');
    if (typeof api.request !== 'function') throw new Error('新建章节接口暂不可用，请刷新页面后重试。');
    await flushPendingSave();
    const path = nextChapterPath(chapterList);
    await api.request('/document', { method: 'POST', body: JSON.stringify({ path, content: '# ' + title + '\n\n' }) });
    const id = path.replace(/\.md$/i, '');
    const refreshed = refreshDocuments();
    // 不立刻选中：新章还没进目录，立刻切会让编辑器先落回第一章。
    // 等目录里出现这一章时，pending 会在渲染阶段直接把它接住。
    pendingSelectRef.current = { match: chapter => chapter.id === id, at: Date.now() };
    setFlash('已新建《' + title + '》' + (refreshed ? '。' : '；目录需要刷新后才会出现这一章，也可以手动点开它。'));
  };

  const runRename = async (chapter, title) => {
    if (!chapter) throw new Error('找不到要重命名的章节。');
    if (!title) throw new Error('标题不能为空。');
    if (title.length > 120) throw new Error('标题最多 120 个字。');
    if (title === chapterTitle(chapter)) {
      setFlash('标题没有变化。');
      return;
    }
    const from = chapter.path;
    const to = renamedPath(chapter, title);
    const wasActive = Boolean(activeChapter && activeChapter.id === chapter.id);
    // 改名的是当前章时，正文要用 dirtyRef 里最新的那一版，否则刚敲的一段会被旧内容盖掉。
    const pendingOfActive = wasActive ? pendingContentOf(from) : undefined;
    const sourceContent = pendingOfActive === undefined ? chapter.content : pendingOfActive;
    const nextContent = withChapterHeading(sourceContent, title);
    // 改的不是当前章时，先保住当前章未保存的修改（后面会重刷目录）。
    if (!wasActive) await flushPendingSave();
    let renamed = false;
    if (to !== from) {
      if (typeof api.renameDocument !== 'function') throw new Error('重命名接口暂不可用，请刷新页面后重试。');
      await api.renameDocument(from, to);
      renamed = true;
    }
    try {
      if (typeof api.request !== 'function') throw new Error('写回标题需要文档接口，请刷新页面后重试。');
      if (to === from && wasActive && pendingOfActive === undefined && typeof saveRef.current === 'function') {
        // 路径没变（只改正文标题）：走正常保存链路，带上 expectedMtime 才能撞出冲突。
        await saveRef.current(to, nextContent);
      } else {
        await api.request('/document', { method: 'PUT', body: JSON.stringify({ path: to, content: nextContent }) });
      }
    } catch (reason) {
      const reasonText = messageOf(reason, '写回正文标题失败。');
      if (!renamed) throw new Error(reasonText);
      try {
        await api.renameDocument(to, from);
      } catch (rollbackReason) {
        throw new Error('文件名已改成「' + to + '」，但正文标题没写回，回滚文件名也失败了：' + reasonText);
      }
      throw new Error('正文标题没写回，文件名已恢复为「' + from + '」：' + reasonText);
    }
    const refreshed = refreshDocuments();
    if (wasActive) {
      // 正文（含未保存的改动）已经跟着 PUT 落盘了，四态指示可以如实回到「已保存」。
      clearDirty(from);
      clearDirty(to);
      setSaveState('saved');
      setSavedAt(new Date());
      // 同样不立刻切 id：等目录里出现新路径再接过去，中间这一帧仍然显示旧对象。
      pendingSelectRef.current = {
        match: item => item.path === to || (chapterTitle(item) === title && item.path !== from),
        at: Date.now(),
      };
    }
    setFlash('已改名为《' + title + '》' + (refreshed ? '。' : '；目录需要刷新后才会更新。'));
  };

  const runDelete = async (chapter) => {
    if (!chapter) throw new Error('找不到要删除的章节。');
    if (typeof api.deleteDocument !== 'function') throw new Error('删除接口暂不可用，请刷新页面后重试。');
    const wasActive = Boolean(activeChapter && activeChapter.id === chapter.id);
    /* 不管是删哪一章都先补写：以前只在删「非当前章」时 flush，
       删当前章时刚敲的那段会跟着快照一起被丢掉，`.trash` 里只有编辑前的旧文。 */
    await flushPendingSave();
    await api.deleteDocument(chapter.path);
    const index = chapterList.findIndex(item => item.id === chapter.id);
    const neighbour = chapterList[index + 1] || chapterList[index - 1] || null;
    const refreshed = refreshDocuments();
    if (wasActive && typeof onSelectChapter === 'function') {
      // 这一章已经进了回收站：丢掉它的未保存快照，免得切章 flush 对着不存在的文件再写一次。
      clearDirty(chapter.path);
      onSelectChapter(neighbour ? neighbour.id : '');
      if (neighbour) pendingSelectRef.current = { match: item => item.id === neighbour.id, at: Date.now() };
    }
    /* 菜单指向的可能是刚被删掉的那一章：不清掉的话，同名新章（id 会重复）点 ⋯ 反而会被关掉。 */
    setMenuChapterId(null);
    setFlash('《' + chapterTitle(chapter) + '》已移到回收站（.trash 目录），' + (refreshed ? '可随时找回。' : '目录需要刷新后才会更新。'));
  };

  const moveChapter = async (chapter, direction) => {
    if (busy) return;
    setMenuChapterId(null);
    if (typeof api.moveDocument !== 'function') {
      setError('排序接口暂不可用，请刷新页面后重试。');
      return;
    }
    setBusy(direction);
    setError('');
    try {
      await flushPendingSave();
      await api.moveDocument(chapter.path, direction);
      const refreshed = refreshDocuments();
      if (activeChapter) {
        pendingSelectRef.current = { match: item => chapterTitle(item) === activeTitle, at: Date.now() };
      }
      setFlash((direction === 'up' ? '已上移一章' : '已下移一章') + (refreshed ? '。' : '；目录需要刷新后才会更新。'));
    } catch (reason) {
      setError(messageOf(reason, direction === 'up' ? '上移失败，请稍后重试。' : '下移失败，请稍后重试。'));
    } finally {
      setBusy('');
    }
  };

  const submitDialog = async (event) => {
    if (event) event.preventDefault();
    if (!dialog || busy) return;
    const value = typeof dialog.value === 'string' ? dialog.value.trim() : '';
    setDialogError('');
    if (dialog.type !== 'delete' && !value) {
      setDialogError('请先填写章节标题。');
      return;
    }
    setBusy(dialog.type);
    try {
      if (dialog.type === 'create') await runCreate(value);
      else if (dialog.type === 'rename') await runRename(dialog.chapter, value);
      else if (dialog.type === 'delete') await runDelete(dialog.chapter);
      setDialog(null);
    } catch (reason) {
      setDialogError(messageOf(reason, '操作没有完成，请稍后重试。'));
    } finally {
      setBusy('');
    }
  };

  const startFirstChapter = async () => {
    if (busy) return;
    setBusy('create');
    setError('');
    try {
      await runCreate('第1章');
    } catch (reason) {
      setError(messageOf(reason, '新建章节失败，请稍后重试。'));
    } finally {
      setBusy('');
    }
  };

  /**
   * 从备份恢复某一版。
   * Host 的 /backups/restore 已经把这一版写进磁盘了，所以这里**不能**再标成 dirty：
   * 否则自动保存会拿着恢复前的旧 mtime 去 PUT，误报一个假的冲突。
   * 做法：内容同步进 project（界面立刻换），清掉这一章的未保存快照，
   * 再走 onDocumentsChanged() 重新 bootstrap —— 恢复后磁盘内容就是刚恢复的这份，
   * 重新拉取只会把新的 mtime 带回来，不会冲掉正文。
   */
  const handleRestore = (content) => {
    if (!activeChapter) return;
    const next = typeof content === 'string' ? content : '';
    const path = activeChapter.path;
    setHistoryOpen(false);
    setError('');
    if (typeof onContentChange === 'function') onContentChange(activeChapter.id, next);
    clearDirty(path);
    setSaveState('saved');
    setSavedAt(new Date());
    const refreshed = refreshDocuments();
    setFlash('已恢复到这一版（Host 已写回磁盘），编辑器里显示的就是恢复后的内容'
      + (refreshed ? '。' : '；目录没能刷新，稍后请手动重新加载一次。'));
  };

  const renderOverlay = () => {
    if (!dialog) return null;
    const deleting = dialog.type === 'delete';
    const creating = dialog.type === 'create';
    const heading = creating ? '新建章节' : deleting ? '删除章节' : '重命名章节';
    const hint = creating
      ? '标题会写进正文一级标题，文件名按顺序生成（chapters/chapter-XXX.md）。'
      : deleting
        ? '这一章会被移到作品目录的 .trash 里，不会真正删除，随时可以找回。'
        : '会同时改文件名（chapters/chapter-NNN-标题.md）和正文的一级标题；两步都成功才算改名完成。';
    const confirmLabel = creating ? '创建' : deleting ? '移到回收站' : '保存';
    const dirtyWarning = deleting && activeChapter && dialog.chapter && dialog.chapter.id === activeChapter.id && saveState === 'dirty';
    return (
      <div
        className="editor-overlay"
        onMouseDown={event => { if (event.target === event.currentTarget) closeDialog(); }}
      >
        <form className={`editor-dialog ${deleting ? 'is-danger' : ''}`} role="dialog" aria-modal="true" aria-label={heading} onSubmit={submitDialog}>
          <h3>{heading}</h3>
          {dialog.chapter && !creating ? <p className="editor-dialog-target">{chapterTitle(dialog.chapter)}</p> : null}
          <p className="editor-dialog-hint">{hint}</p>
          {deleting ? null : (
            <input
              className="editor-dialog-input"
              type="text"
              value={dialog.value}
              onChange={event => setDialog({ ...dialog, value: event.target.value })}
              onFocus={event => event.target.select()}
              placeholder="例如：第三章 雾中小镇"
              aria-label="章节标题"
              maxLength={120}
              autoFocus
              disabled={Boolean(busy)}
            />
          )}
          {dirtyWarning ? <p className="editor-dialog-warn">还有未保存的修改</p> : null}
          {dialogError ? <p className="editor-dialog-error" role="alert">{dialogError}</p> : null}
          <div className="editor-dialog-actions">
            <button type="button" className="editor-dialog-button" onClick={closeDialog} disabled={Boolean(busy)}>取消</button>
            <button type="submit" className={`editor-dialog-button is-primary ${deleting ? 'is-danger' : ''}`} disabled={Boolean(busy)}>
              {busy ? '处理中…' : confirmLabel}
            </button>
          </div>
        </form>
      </div>
    );
  };

  /* 当前章找不到、但目录里还有别的章：不要整页退化成「从第一章开始」。
     以前这种状态下侧边栏连同每一行的「删除 / 重命名」入口会一起消失。 */
  React.useEffect(function () {
    if (activeChapter) return;
    const first = chapterList[0];
    if (first && typeof onSelectChapter === 'function') onSelectChapter(first.id);
  }, [activeChapter, chapterList, onSelectChapter]);

  if (!activeChapter) {
    return (
      <section className={`novel-editor editor-empty ${className}`} style={editorStyle}>
        <SharedStyle />
        <style dangerouslySetInnerHTML={{ __html: css }} />
        <button type="button" className="editor-empty-start" onClick={() => void startFirstChapter()} disabled={Boolean(busy)}>
          <FileText size={32} />
          <h2>从第一章开始</h2>
          <p>点这里写下第一章</p>
        </button>
        {error && <p className="editor-empty-error" role="alert">{error}</p>}
        {renderOverlay()}
      </section>
    );
  }

  return (
    <section className={`novel-editor ${className}`} style={editorStyle}>
      <SharedStyle />
      <style dangerouslySetInnerHTML={{ __html: css }} />
      <div className="editor-chapter-sidebar">
        <header className="editor-chapter-heading"><span>作品目录</span><span>{chapterList.length} 章</span></header>
        <button type="button" className="editor-chapter-create" onClick={() => openCreateDialog()} disabled={Boolean(busy)}>
          <Plus size={13} />新建章节
        </button>
        <nav className={`editor-chapter-list ${menuChapterId ? 'has-open-menu' : ''}`} aria-label="章节目录">
          {chapterList.map((chapter, index) => {
            const isActive = chapter.id === activeChapter.id;
            const menuOpen = menuChapterId === chapter.id;
            const isLast = index === chapterList.length - 1;
            return (
              <div className={`editor-chapter-row ${isActive ? 'is-active' : ''}`} key={chapter.id}>
                <button
                  type="button"
                  className={`editor-chapter-item ${isActive ? 'is-active' : ''}`}
                  onClick={() => selectChapter(chapter.id)}
                >
                  <span className="chapter-number">{String(index + 1).padStart(2, '0')}</span>
                  <span className="chapter-item-copy">
                    <strong>{chapterTitle(chapter)}</strong>
                    <small>{chapterChars(chapter.content)} 字</small>
                  </span>
                  <ChevronRight size={14} />
                </button>
                <button
                  type="button"
                  className="editor-chapter-menu-trigger"
                  data-editor-menu-trigger="chapter"
                  aria-haspopup="menu"
                  aria-expanded={menuOpen}
                  aria-label={chapterTitle(chapter) + ' 的更多操作'}
                  title="更多操作"
                  onClick={() => setMenuChapterId(menuOpen ? null : chapter.id)}
                >
                  <MenuDots size={14} />
                </button>
                {menuOpen && (
                  <div className={`editor-chapter-menu ${isLast ? 'is-upward' : ''}`} role="menu" ref={menuRef}>
                    <button type="button" role="menuitem" onClick={() => openRenameDialog(chapter)}>重命名</button>
                    <button
                      type="button"
                      role="menuitem"
                      disabled={index === 0 || Boolean(busy)}
                      onClick={() => void moveChapter(chapter, 'up')}
                    >上移</button>
                    <button
                      type="button"
                      role="menuitem"
                      disabled={isLast || Boolean(busy)}
                      onClick={() => void moveChapter(chapter, 'down')}
                    >下移</button>
                    <button type="button" role="menuitem" className="is-danger" onClick={() => openDeleteDialog(chapter)}>删除…</button>
                  </div>
                )}
              </div>
            );
          })}
        </nav>
      </div>

      <div className="editor-writing-area">
        <header className="editor-toolbar">
          <div className="editor-current-chapter"><BookOpen size={17} /><strong>{chapterTitle(activeChapter)}</strong></div>
          <div className="editor-toolbar-actions">
            <div className="editor-view-switch">
              <button type="button" className={mode === 'write' ? 'is-active' : ''} onClick={() => setMode('write')}><PenLine size={14} />写作</button>
              <button type="button" className={mode === 'preview' ? 'is-active' : ''} onClick={() => setMode('preview')}><BookOpen size={14} />阅读</button>
            </div>
            <button type="button" className="editor-icon-button" onClick={() => setLineNumberPreference(!showLineNumbers)} aria-label="切换行号" aria-pressed={showLineNumbers}><Hash size={17} /></button>
            <button type="button" className="editor-icon-button" onClick={() => setShowAnnotations(v => !v)} aria-label="切换批注栏">
              {showAnnotations ? <PanelRightClose size={17} /> : <PanelRightOpen size={17} />}
            </button>
            <button
              type="button"
              className={`editor-history-button ${historyOpen ? 'is-active' : ''}`}
              onClick={() => setHistoryOpen(v => !v)}
              aria-expanded={historyOpen}
              title="备份历史"
            >
              <HistoryIcon size={15} />历史
            </button>
            <button type="button" className="editor-save-button" onClick={() => void save()} disabled={saveState === 'saving'}>
              <Save size={15} />{saveState === 'saving' ? '保存中' : '保存'}
            </button>
          </div>
        </header>

        <div className="editor-document-meta">
          <span className={`editor-save-state is-${saveState}`} aria-live="polite">
            {saveState === 'saved'
              ? <CheckCircle2 size={13} />
              : saveState === 'saving'
                ? <LoaderCircle size={13} className="is-spinning" />
                : <span className="save-state-dot" />}
            {saveState === 'dirty'
              ? (needsAttention ? '有未保存修改 · 待处理冲突' : '有未保存修改')
              : saveState === 'saving'
                ? '正在保存…'
                : saveState === 'error'
                  ? '保存失败'
                  : savedAt
                    ? `已保存 · ${savedAt.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}`
                    : '正文已保存到本地'}
          </span>
          {/* 冲突搁置（needsAttention）或保存失败时，自动保存是停着的。
              以前状态栏只写一行「待处理冲突」，但面板已经关了，用户没有任何入口重新触发，
              只能靠手动点保存——这里就把那个入口显式给出来。 */}
          {needsAttention || saveState === 'error' ? (
            <button
              type="button"
              className="editor-retry-save"
              onClick={() => void save()}
              disabled={saveState === 'saving' || busy === 'save'}
            >
              <Save size={12} />重试保存
            </button>
          ) : null}
          <span>{chapterChars(activeChapter.content).toLocaleString()} 字 · {lines.length} 行</span>
          {/* 专注写作：把顶栏 / 左侧目录临时收起来，按钮就放在编辑区这条栏上。 */}
          {typeof onToggleTopbar === 'function' ? (
            <button
              type="button"
              className={'editor-focus-toggle' + (hideTopbar ? ' is-off' : '')}
              onClick={onToggleTopbar}
              title={hideTopbar ? '显示顶栏（Ctrl+Shift+H）' : '隐藏顶栏（Ctrl+Shift+H）'}
              aria-pressed={Boolean(hideTopbar)}
            >
              顶栏
            </button>
          ) : null}
          {typeof onToggleRail === 'function' ? (
            <button
              type="button"
              className={'editor-focus-toggle' + (hideRail ? ' is-off' : '')}
              onClick={onToggleRail}
              title={hideRail ? '显示左侧目录（Ctrl+Shift+L）' : '隐藏左侧目录（Ctrl+Shift+L）'}
              aria-pressed={Boolean(hideRail)}
            >
              目录
            </button>
          ) : null}
        </div>

        <div className={`editor-text-container ${showLineNumbers ? 'has-line-numbers' : ''}`} ref={containerRef}>
          {mode === 'write' ? (
            <>
              {showLineNumbers && (
                <div className="editor-line-numbers" aria-hidden="true" ref={gutterRef}>
                  <div className="editor-line-numbers-inner" ref={gutterInnerRef}>
                    {lines.map((_, index) => <span key={index}>{index + 1}</span>)}
                  </div>
                </div>
              )}
              <textarea
                ref={textareaRef}
                className="editor-textarea"
                value={activeChapter.content}
                onChange={e => {
                  const value = e.target.value;
                  // 先记进 dirtyRef：即使父组件的 props 还没回流，切章/卸载也能拿到这段文字。
                  markDirty(activeChapter.path, value);
                  if (typeof onContentChange === 'function') onContentChange(activeChapter.id, value);
                  // 注意：不在这里解掉 needsAttention——冲突未决时继续打字不能触发自动重试。
                  setSaveState('dirty');
                }}
                onKeyDown={e => {
                  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') { e.preventDefault(); void save(); }
                }}
                onScroll={() => { syncGutterScrollRef.current(); }}
                onSelect={captureSelection}
                onKeyUp={captureSelection}
                onMouseUp={captureSelection}
                placeholder="故事从这里继续…"
                spellCheck={false}
                aria-label={`${chapterTitle(activeChapter)}正文`}
              />
            </>
          ) : <MarkdownPreview content={activeChapter.content} />}
        </div>

        <footer className="editor-ai-bar">
          <div className="editor-ai-context"><ScanSearch size={17} /><span>AI 审阅 · 只批注，不续写</span></div>
          <input
            className="editor-ai-instruction"
            value={instruction}
            onChange={e => { setInstructionEdited(true); setInstruction(e.target.value); }}
            aria-label="AI 审阅重点"
            placeholder="告诉 AI 本次重点检查什么…"
            disabled={reviewing}
          />
          <button
            type="button"
            className="editor-review-button"
            onClick={() => void review()}
            disabled={reviewing || !String(activeChapter.content || '').trim()}
          >
            {reviewing ? <LoaderCircle size={15} className="is-spinning" /> : <MessageSquareText size={15} />} {reviewing ? 'DSH 审阅中…' : '生成审阅批注'}
          </button>
        </footer>

        {(() => {
          if (error) {
            return (
              <div className="editor-notice" role="alert">
                <span>{error}</span>
                {onConnectDsh && <button type="button" onClick={onConnectDsh}>连接 DSH</button>}
                <button type="button" onClick={() => setError('')} aria-label="关闭提示"><X size={14} /></button>
              </div>
            );
          }
          if (flash) {
            return (
              <div className="editor-notice is-ok" role="status">
                <span>{flash}</span>
                <button type="button" onClick={() => setFlash('')} aria-label="关闭提示"><X size={14} /></button>
              </div>
            );
          }
          return null;
        })()}

        {historyOpen && (
          <BackupsPanel path={activePath} onRestore={handleRestore} onClose={() => setHistoryOpen(false)} />
        )}
      </div>

      {showAnnotations && (
        <Annotations
          annotations={chapterAnnotations}
          activeDocumentPath={activePath}
          selectedText={selection.text}
          selectionRange={{ start: selection.start, end: selection.end }}
          onLocate={locate}
          onRelocate={relocate}
          onUpdateAnnotation={async annotation => { if (onAnnotationsChange) await onAnnotationsChange(annotationList.map(a => (a.id === annotation.id ? annotation : a))); }}
          onAddAnnotation={async annotation => { if (onAnnotationsChange) await onAnnotationsChange([...annotationList, { ...annotation, id: `manual-${Date.now()}`, status: 'open', source: 'manual', createdAt: new Date().toISOString() }]); }}
          onDeleteAnnotation={async id => { if (onAnnotationsChange) await onAnnotationsChange(annotationList.filter(a => a.id !== id)); }}
        />
      )}
      {!showAnnotations && chapterAnnotations.length > 0 && (
        <button
          type="button"
          className="editor-collapsed-notes"
          onClick={() => setShowAnnotations(true)}
          aria-pressed={false}
          aria-label={'展开批注栏（本章 ' + chapterAnnotations.filter(a => a.status !== 'resolved').length + ' 条待处理，共 ' + chapterAnnotations.length + ' 条）'}
        >
          <MessageSquareText size={17} />
          {/* 角标用「待处理」数：以前用全部条数，和面板标题、筛选计数三处对不上。 */}
          <span>{chapterAnnotations.filter(a => a.status !== 'resolved').length}</span>
        </button>
      )}
      {renderOverlay()}
    </section>
  );
}

module.exports = { Editor };
