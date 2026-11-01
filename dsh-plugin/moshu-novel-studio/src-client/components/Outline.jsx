const React = require('react');
const { useMemo, useState } = React;
const {
  BookOpen, Check, ChevronDown, ChevronRight, CircleHelp, FileText,
  LibraryBig, PenLine, Plus, Route, Save, ScanSearch, Sparkles, X,
} = require('../icons');
const { request } = require('../api');
const { SharedStyle } = require('./SharedStyle');
const css = require('./World.css');

const BEATS = ['铺垫', '触发', '升级', '中点转折', '低谷', '高潮', '收束'];
const STATUSES = ['未开始', '大纲中', '草稿', '待审阅', '已完成'];

/**
 * 从文件名取章节号。
 * 工作台的章节文件名是 `chapter-001.md`（改名后会带标题 `chapter-001-雾里来客.md`），
 * 也兼容 `第3章.md` / `001-xxx.md` 这类写法。
 * 以前只认「文件名以数字开头」，导致 `chapter-001.md` 全部被判成 0 号：
 * 大纲页整列显示「第 0 章」，新建章节永远算成 1 → 撞 409，整页等于不可用。
 */
function chapterNumber(path) {
  const name = path.split('/').pop() || '';
  const match = name.match(/^(?:chapter[-_\s]*)?(\d+)/i) || name.match(/第\s*(\d+)\s*章/);
  return match ? Number(match[1]) : null;
}

function metadata(content, key) {
  const block = (content.match(/^---\r?\n([\s\S]*?)\r?\n---/) || [])[1] || '';
  const found = block.match(new RegExp(`^${key}:\\s*["']?([^\\r\\n"']*)`, 'm'));
  return (found && found[1] ? found[1].trim() : '');
}

function setMetadata(content, values) {
  const existing = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  const lines = existing ? existing[1].split(/\r?\n/) : [];
  Object.entries(values).forEach(([key, value]) => {
    const index = lines.findIndex(line => line.startsWith(`${key}:`));
    if (index >= 0) lines[index] = `${key}: ${value}`;
    else lines.push(`${key}: ${value}`);
  });
  return `---\n${lines.filter(Boolean).join('\n')}\n---\n\n${existing ? content.slice(existing[0].length) : content}`;
}

function withoutMetadata(content) {
  return content.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, '').replace(/^#\s+.*\r?\n/, '').trim();
}

function summarize(content) {
  const text = withoutMetadata(content).replace(/[#>*_`\[\]-]/g, '').replace(/\s+/g, ' ').trim();
  return text ? `${text.slice(0, 86)}${text.length > 86 ? '…' : ''}` : '尚未填写章纲，点击编辑补充本章目标与冲突。';
}

function wordCount(content) {
  return (content.match(/[\u3400-\u9fff]|[a-zA-Z0-9]+/g) || []).length;
}

function outlineFor(chapter, outlines) {
  return outlines.find(doc => Number(metadata(doc.content, 'chapter')) === chapter)
    || outlines.find(doc => (doc.path.match(/chapter[-_](\d+)/i) || [])[1] === String(chapter));
}

function volumeTemplate(number) {
  return `---\nvolume: ${number}\n---\n\n# 第 ${number} 卷\n\n## 本卷目标\n\n## 主要冲突\n\n## 转折与结果\n`;
}

function chapterTemplate(number, title) {
  return `---\nchapter: ${number}\nstatus: 大纲中\nbeat: 铺垫\narc: 主线\n---\n\n# 第 ${number} 章 · ${title}\n\n## 本章目标\n\n## 核心冲突\n\n## 场景与信息增量\n\n## 结尾钩子\n`;
}

function Outline({ documents, chapters: chapterDocuments, onSave, onOpenChapter, onDocumentsChanged }) {
  const outlines = useMemo(() => documents.filter(doc => doc.type === 'outline'), [documents]);
  const [collapsed, setCollapsed] = useState([]);
  const [editing, setEditing] = useState(null);
  const [draft, setDraft] = useState('');
  const [beat, setBeat] = useState('铺垫');
  const [arc, setArc] = useState('主线');
  const [status, setStatus] = useState('大纲中');
  const [busy, setBusy] = useState('');
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');

  const volumes = useMemo(() => {
    const chapters = (chapterDocuments || documents.filter(doc => doc.type === 'chapter')).map(document => ({
      document,
      number: chapterNumber(document.path) || 0,
      title: document.title.replace(/^第\s*\d+\s*章\s*[·:：-]?\s*/, ''),
      volume: Number(metadata((outlineFor(chapterNumber(document.path) || 0, outlines) || {}).content || '', 'volume')) || 1,
      outline: outlineFor(chapterNumber(document.path) || 0, outlines),
    })).sort((a, b) => a.number - b.number);
    /* 卷号只来自「真实存在的东西」：章节挂的卷号 + 卷纲文件里的 volume。
       以前这里在没有章节时会强行塞一个 [1]，于是空作品也显示「第 1 卷」；
       再叠上点过一次「新建卷」生成的 volume-2.md，就成了「两卷故事」——其实一个字都没有。 */
    const numbers = Array.from(new Set([
      ...chapters.map(chapter => chapter.volume),
      ...outlines.map(doc => Number(metadata(doc.content, 'volume'))).filter(Boolean),
    ])).sort((a, b) => a - b);
    return numbers.map(number => {
      const volumeDoc = outlines.find(doc => Number(metadata(doc.content, 'volume')) === number && !metadata(doc.content, 'chapter'));
      return {
        number,
        title: (volumeDoc && volumeDoc.title) || `第 ${number} 卷`,
        summary: volumeDoc ? summarize(volumeDoc.content) : '',
        chapters: chapters.filter(chapter => chapter.volume === number),
      };
    });
  }, [documents, chapterDocuments, outlines]);

  const chapters = volumes.flatMap(volume => volume.chapters);
  const done = chapters.filter(chapter => (chapter.outline ? metadata(chapter.outline.content, 'status') : chapter.document.status) === '已完成').length;
  const words = chapters.reduce((sum, chapter) => sum + wordCount(chapter.document.content), 0);
  const progress = chapters.length ? Math.round(done / chapters.length * 100) : 0;

  async function save(path, content, key, close = false) {
    setBusy(key); setError(''); setMessage('');
    try {
      await onSave(path, content);
      setMessage('已保存到项目');
      if (close) setEditing(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '保存失败，请重试');
    } finally { setBusy(''); }
  }

  async function create(path, content, key, extra) {
    setBusy(key); setError(''); setMessage('');
    try {
      /* 优先用页面传进来的 onSave：它会更新本地文档状态、触发重新渲染。
         以前这里直接 request('/document')，写完磁盘但页面状态没变 ——
         用户看到的就是「点了没反应」。 */
      if (typeof onSave === 'function') {
        await onSave(path, content);
      } else {
        await request('/document', { method: 'POST', body: JSON.stringify({ path, content, ...(extra || {}) }) });
      }
      setMessage('已创建到项目');
      /* 通知父级重新拉一次目录：不然「已创建」提示之后列表还是空的，
         再点一次就会用同一个文件名撞 409。 */
      if (typeof onDocumentsChanged === 'function') {
        try { await onDocumentsChanged(); } catch (error) { /* 刷新失败不影响创建结果 */ }
      }
      return true;
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '创建失败，请重试');
      return false;
    } finally { setBusy(''); }
  }

  async function saveOutline(chapter, content, key, close = false) {
    if (chapter.outline) await save(chapter.outline.path, content, key, close);
    else {
      const created = await create(`outline/chapter-${chapter.number}.md`, content, key);
      if (created && close) setEditing(null);
    }
  }

  function openEditor(chapter) {
    setEditing(chapter);
    setDraft((chapter.outline && chapter.outline.content) || chapterTemplate(chapter.number, chapter.title));
    setBeat(chapter.outline ? metadata(chapter.outline.content, 'beat') || '铺垫' : '铺垫');
    setArc(chapter.outline ? metadata(chapter.outline.content, 'arc') || '主线' : '主线');
    setStatus(chapter.outline ? metadata(chapter.outline.content, 'status') || '大纲中' : chapter.document.status || '大纲中');
    setMessage(''); setError('');
  }

  async function addChapter(volume) {
    const number = Math.max(0, ...chapters.map(chapter => chapter.number)) + 1;
    const title = `第 ${number} 章`;
    const path = `chapters/chapter-${String(number).padStart(3, '0')}.md`;
    /* 正文留空、标题进元数据（章节标题不再写在正文第一行） */
    if (await create(path, '', `add-${volume}`, { title })) {
      const outlineContent = setMetadata(chapterTemplate(number, title), { volume: String(volume) });
      await create(`outline/chapter-${number}.md`, outlineContent, `outline-${number}`);
    }
  }

  return <div className="outline-view">
    <SharedStyle />
    <style dangerouslySetInnerHTML={{ __html: css }} />
    <header className="outline-header">
      <div><h1>故事大纲</h1></div>
      <button
        type="button"
        className="primary-button"
        disabled={!!busy}
        onClick={() => create(`outline/volume-${Math.max(0, ...volumes.map(v => v.number)) + 1}.md`, volumeTemplate(Math.max(0, ...volumes.map(v => v.number)) + 1), 'volume')}
      >
        <Plus size={17} />新建卷
      </button>
    </header>

    {(message || error) && (
      <div className={error ? 'notice error' : 'notice success'} role="status">
        {error || message}
        <button type="button" onClick={() => { setError(''); setMessage(''); }} aria-label="关闭提示"><X size={15} /></button>
      </div>
    )}

    <section className="outline-stats" aria-label="写作进度">
      <div><LibraryBig size={20} /><span><strong>{volumes.length}</strong>卷故事</span></div>
      <div><BookOpen size={20} /><span><strong>{chapters.length}</strong>章规划</span></div>
      <div><PenLine size={20} /><span><strong>{words.toLocaleString()}</strong>已写字数</span></div>
      <div className="outline-progress">
        <span><strong>整体完成度</strong><b>{progress}%</b></span>
        <div className="progress-track" role="progressbar" aria-valuenow={progress} aria-valuemin={0} aria-valuemax={100}>
          <i style={{ width: `${progress}%` }} />
        </div>
        <small>{done} / {chapters.length || 0} 章已完成</small>
      </div>
    </section>

    <section className="story-arc">
      <div className="section-heading"><div><Route size={19} /><h2>主线弧线</h2></div></div>
      {chapters.length ? <div className="arc-track">
        <div className="arc-line" />
        {chapters.map(chapter => {
          const chapterBeat = chapter.outline ? metadata(chapter.outline.content, 'beat') : '';
          const chapterArc = chapter.outline ? metadata(chapter.outline.content, 'arc') : '';
          return <button
            type="button"
            className="arc-stop"
            key={chapter.document.id}
            onClick={() => openEditor(chapter)}
            title={`${chapter.document.title}：${chapterBeat || '待设置节拍'}`}
          >
            <span className="arc-node">{chapterBeat === '高潮' ? <Sparkles size={15} /> : <CircleHelp size={10} />}</span>
            <strong>{chapterBeat || '待设置'}</strong>
            <small>{chapter.number ? `第 ${chapter.number} 章` : chapter.title}{chapterArc && chapterArc !== '主线' ? ` · ${chapterArc}` : ''}</small>
          </button>;
        })}
      </div> : <div className="empty-inline"><Route size={22} /><span>还没有章节</span></div>}
    </section>

    <div className="volume-list">
      {volumes.length === 0 ? (
        <div className="empty-volume outline-empty">
          <LibraryBig size={26} />
          <p>还没有故事大纲</p>
          <button
            type="button"
            className="primary-button"
            disabled={!!busy}
            onClick={() => create('outline/volume-1.md', volumeTemplate(1), 'volume', { title: '第 1 卷' })}
          >
            <Plus size={16} />新建第一卷
          </button>
        </div>
      ) : volumes.map(volume => {
        const isCollapsed = collapsed.includes(volume.number);
        return <section className="volume-section" key={volume.number}>
          <div className="volume-heading">
            <button
              type="button"
              className="collapse-button"
              onClick={() => setCollapsed(current => (isCollapsed ? current.filter(n => n !== volume.number) : [...current, volume.number]))}
              aria-label={isCollapsed ? '展开卷' : '收起卷'}
            >{isCollapsed ? <ChevronRight size={20} /> : <ChevronDown size={20} />}</button>
            <div><h2>{volume.title}</h2><p>{volume.summary || `${volume.chapters.length} 个章节 · 规划本卷的目标、冲突与转折`}</p></div>
            <button type="button" className="secondary-button" disabled={!!busy} onClick={() => addChapter(volume.number)}><Plus size={16} />添加章节</button>
          </div>
          {!isCollapsed && (volume.chapters.length ? <div className="chapter-grid">{volume.chapters.map(chapter => {
            const chapterStatus = chapter.outline ? metadata(chapter.outline.content, 'status') || '大纲中' : chapter.document.status || '未开始';
            const chapterBeat = chapter.outline ? metadata(chapter.outline.content, 'beat') : '';
            return <article className="chapter-card" key={chapter.document.id}>
              <div className="chapter-card-top">
                <span className="chapter-number">{String(chapter.number).padStart(2, '0')}</span>
                <span className={`status-badge status-${chapterStatus}`}>{chapterStatus === '已完成' ? <Check size={12} /> : <CircleHelp size={9} />}{chapterStatus}</span>
              </div>
              <h3>{chapter.title}</h3><p>{chapter.outline ? summarize(chapter.outline.content) : '尚未填写章纲，点击编辑补充本章目标与冲突。'}</p>
              <div className="chapter-meta">
                <span><ScanSearch size={13} />{chapterBeat || '未标记节拍'}</span>
                <span>{wordCount(chapter.document.content).toLocaleString()} 字</span>
              </div>
              <div className="chapter-actions">
                <button type="button" className="primary-button" onClick={() => openEditor(chapter)}><FileText size={15} />编辑章纲</button>
                {onOpenChapter && <button type="button" className="icon-button" onClick={() => onOpenChapter(chapter.document.id)} title="打开正文" aria-label={`打开${chapter.title}正文`}><PenLine size={16} /></button>}
                <select
                  aria-label={`${chapter.title}状态`}
                  value={chapterStatus}
                  disabled={!!busy}
                  onChange={event => {
                    const content = setMetadata((chapter.outline && chapter.outline.content) || chapterTemplate(chapter.number, chapter.title), { status: event.target.value });
                    void saveOutline(chapter, content, chapter.document.id);
                  }}
                >{STATUSES.map(item => <option key={item}>{item}</option>)}</select>
              </div>
            </article>;
          })}</div> : <div className="empty-volume">
            <BookOpen size={24} /><p>这一卷还没有章节</p>
            <button type="button" onClick={() => addChapter(volume.number)}><Plus size={15} />添加第一章</button>
          </div>)}
        </section>;
      })}
    </div>

    {editing && <div className="modal-backdrop" role="presentation" onMouseDown={event => { if (event.target === event.currentTarget) setEditing(null); }}>
      <section className="outline-editor modal-panel" role="dialog" aria-modal="true" aria-labelledby="outline-editor-title">
        <header>
          <div><p className="eyebrow">CHAPTER {String(editing.number).padStart(2, '0')}</p><h2 id="outline-editor-title">{editing.title}</h2></div>
          <button type="button" className="icon-button" onClick={() => setEditing(null)} aria-label="关闭"><X size={20} /></button>
        </header>
        <div className="outline-editor-options">
          <label>故事节拍<select value={beat} onChange={event => setBeat(event.target.value)}>{BEATS.map(item => <option key={item}>{item}</option>)}</select></label>
          <label>剧情弧线<input value={arc} onChange={event => setArc(event.target.value)} placeholder="主线 / 人物弧 / 感情线" /></label>
          <label>写作状态<select value={status} onChange={event => setStatus(event.target.value)}>{STATUSES.map(item => <option key={item}>{item}</option>)}</select></label>
        </div>
        <label className="markdown-field">章纲 Markdown<textarea value={draft} onChange={event => setDraft(event.target.value)} spellCheck={false} autoFocus /></label>
        <footer>

          <div>
            <button type="button" className="secondary-button" onClick={() => setEditing(null)}>取消</button>
            <button
              type="button"
              className="primary-button"
              disabled={!!busy}
              onClick={() => saveOutline(editing, setMetadata(draft, { chapter: String(editing.number), beat, arc, status }), 'editor', true)}
            ><Save size={16} />{busy === 'editor' ? '保存中…' : '保存章纲'}</button>
          </div>
        </footer>
      </section>
    </div>}
  </div>;
}

module.exports = { Outline };
