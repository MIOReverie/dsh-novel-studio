const React = require('react');
const { Markdown } = require('./Markdown');
const { Fragment, useEffect, useMemo, useRef, useState } = React;
const {
  BookOpen, Check, ChevronRight, FileText, LibraryBig, Map: MapIcon,
  MessageSquareText, Network, PenLine, Plus, Save, ScanSearch, Search, X,
} = require('../icons');
const { request } = require('../api');
const { SharedStyle } = require('./SharedStyle');
const css = require('./World.css');

const CATEGORIES = [
  { id: 'character', label: '人物', icon: MessageSquareText },
  { id: 'faction', label: '势力', icon: Network },
  { id: 'location', label: '地点', icon: MapIcon },
  { id: 'world', label: '世界设定', icon: LibraryBig },
];

const TEMPLATES = {
  character: '\n\n## 身份与动机\n\n## 性格与语言习惯\n\n## 能力与限制\n\n## 人物关系\n\n## 秘密与当前状态\n',
  faction: '\n\n## 宗旨与立场\n\n## 核心成员\n\n## 势力范围与资源\n\n## 与其他势力的关系\n',
  location: '\n\n## 地理与风貌\n\n## 人文与规则\n\n## 关键地点\n\n## 相关事件\n',
  world: '\n\n## 核心规则\n\n## 历史与背景\n\n## 限制与代价\n\n## 关联设定\n',
};

function categoryOf(document) {
  if (document.type === 'character' || document.type === 'location' || document.type === 'world') return document.type;
  const match = document.path.toLowerCase().match(/(?:^|\/)(characters?|人物|factions?|势力|locations?|地点|world|设定)(?:\/|$)/i);
  if (!match) return null;
  return /char|人物/.test(match[1]) ? 'character' : /fact|势力/.test(match[1]) ? 'faction' : /loc|地点/.test(match[1]) ? 'location' : 'world';
}

function cleanTitle(title) {
  return title.replace(/\.md$/i, '').split('/').pop() || title;
}

function excerpt(content) {
  const text = content.replace(/^---[\s\S]*?---/, '').replace(/^#.*$/gm, '').replace(/[#>*_`\[\]()!-]/g, '').replace(/\s+/g, ' ').trim();
  return text ? `${text.slice(0, 110)}${text.length > 110 ? '…' : ''}` : '这份资料还是空白，打开编辑器补充设定。';
}

function wikiLinks(content) {
  return Array.from(content.matchAll(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g)).map(match => ({
    target: cleanTitle(match[1].trim()),
    label: (match[2] && match[2].trim()) || '关联',
  }));
}

function inlineMarkdown(value) {
  return value.split(/(\[\[[^\]]+\]\]|\*\*[^*]+\*\*|`[^`]+`|\*[^*\n]+\*)/g).filter(Boolean).map((part, index) => {
    const link = part.match(/^\[\[([^\]|]+)(?:\|([^\]]+))?\]\]$/);
    if (link) return <span className="wiki-link" key={index}>{link[2] || link[1]}<small>↗ {link[1]}</small></span>;
    if (part.startsWith('**') && part.endsWith('**')) return <strong key={index}>{part.slice(2, -2)}</strong>;
    if (part.startsWith('`') && part.endsWith('`')) return <code key={index}>{part.slice(1, -1)}</code>;
    if (part.startsWith('*') && part.endsWith('*')) return <em key={index}>{part.slice(1, -1)}</em>;
    return <Fragment key={index}>{part}</Fragment>;
  });
}

function MarkdownPreview({ content }) {
  /* 旧实现是「一行一段」，表格/代码块/有序列表都不成形，折行也会被拆成多段。
     现在统一走共享的 Markdown 解析（块级分组 + 完整行内标记）。 */
  return <Markdown content={content} className="markdown-preview" />;
}

function Library({ documents, onSave }) {
  const entries = useMemo(
    () => documents.map(document => ({ document, category: categoryOf(document) })).filter(item => !!item.category),
    [documents],
  );
  const [category, setCategory] = useState('character');
  const [query, setQuery] = useState('');
  const [selectedId, setSelectedId] = useState('');
  const [mode, setMode] = useState('documents');
  const [editing, setEditing] = useState(false);
  const [creating, setCreating] = useState(false);
  const [newCategory, setNewCategory] = useState('character');
  const [newTitle, setNewTitle] = useState('');
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const titleInput = useRef(null);

  const visible = entries.filter(item => item.category === category && `${item.document.title} ${item.document.content}`.toLowerCase().includes(query.trim().toLowerCase()));
  const selected = visible.find(item => item.document.id === selectedId) || visible[0] || null;

  useEffect(() => {
    if (creating && titleInput.current) titleInput.current.focus();
  }, [creating]);

  const relations = useMemo(() => {
    const byTitle = new Map(entries.map(item => [cleanTitle(item.document.title).toLowerCase(), item.document]));
    const result = [];
    entries.forEach(({ document }) => {
      const source = cleanTitle(document.title);
      const links = wikiLinks(document.content);
      links.forEach(link => {
        const target = byTitle.get(link.target.toLowerCase());
        if (target) result.push({ source, target: cleanTitle(target.title), label: link.label });
      });
      entries.filter(item => item.category === 'character' && item.document.id !== document.id).forEach(item => {
        const target = cleanTitle(item.document.title);
        if (!target || links.some(link => link.target.toLowerCase() === target.toLowerCase())) return;
        const pattern = new RegExp(`(?:${target.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})[^\\n。.!?]{0,30}`, 'g');
        const match = (document.content.match(pattern) || [])[0];
        if (match) result.push({ source, target, label: match.replace(target, '').replace(/[：:，,\s]/g, '').slice(0, 16) || '共同提及' });
      });
    });
    return result;
  }, [entries]);

  const characterRelations = relations.filter(relation => {
    const source = entries.find(item => cleanTitle(item.document.title) === relation.source);
    const target = entries.find(item => cleanTitle(item.document.title) === relation.target);
    return source && source.category === 'character' && target && target.category === 'character';
  });

  function select(document) {
    setSelectedId(document.id); setEditing(false); setError(''); setNotice('');
  }

  function beginEdit() {
    if (!selected) return;
    setDraft(selected.document.content); setEditing(true); setError(''); setNotice('');
  }

  async function saveSelected() {
    if (!selected) return;
    setBusy(true); setError(''); setNotice('');
    try {
      await onSave(selected.document.path, draft);
      setNotice('资料已保存'); setEditing(false);
    } catch (cause) { setError(cause instanceof Error ? cause.message : '保存失败，请重试'); }
    finally { setBusy(false); }
  }

  async function createDocument(event) {
    event.preventDefault();
    const title = newTitle.trim().replace(/[\\/:*?"<>|]/g, '');
    if (!title) { setError('请输入资料名称'); return; }
    const folder = newCategory === 'character' ? 'characters' : newCategory === 'faction' ? 'factions' : newCategory === 'location' ? 'locations' : 'world';
    const path = `${folder}/${title}.md`;
    if (documents.some(doc => doc.path.toLowerCase() === path.toLowerCase())) { setError('同名资料已存在，请换一个名称'); return; }
    setBusy(true); setError(''); setNotice('');
    try {
      const content = `# ${title}${TEMPLATES[newCategory]}`;
      /* 内容已经在 body 里了，POST 就把它写进磁盘。以前这里再调一次 onSave →
         同一个文件被写两遍；第二次失败就报「创建失败」而文件其实已经存在。 */
      await request('/document', { method: 'POST', body: JSON.stringify({ path, content }) });
      setCategory(newCategory); setSelectedId(path.replace(/\.md$/i, '')); setCreating(false); setNewTitle('');
      setNotice(`已创建《${title}》`);
    } catch (cause) { setError(cause instanceof Error ? cause.message : '创建失败，请重试'); }
    finally { setBusy(false); }
  }

  return <div className="library-view">
    <SharedStyle />
    <style dangerouslySetInnerHTML={{ __html: css }} />
    <header className="library-header">
      <div><h1>世界资料库</h1></div>
      <button type="button" className="primary-button" onClick={() => { setCreating(true); setNewCategory(category); setError(''); }}><Plus size={17} />新建资料</button>
    </header>

    <div className="library-toolbar">
      <div className="library-search">
        <Search size={17} />
        <input value={query} onChange={event => setQuery(event.target.value)} placeholder="搜索名称或设定内容…" aria-label="搜索资料" />
        {query && <button type="button" onClick={() => setQuery('')} aria-label="清空搜索"><X size={15} /></button>}
      </div>
      <div className="segmented-control" aria-label="资料视图">
        <button type="button" className={mode === 'documents' ? 'active' : ''} onClick={() => setMode('documents')}><BookOpen size={16} />资料</button>
        <button type="button" className={mode === 'relationships' ? 'active' : ''} onClick={() => setMode('relationships')}><Network size={16} />人物关系</button>
      </div>
    </div>

    {(notice || error) && !creating && (
      <div className={error ? 'notice error' : 'notice success'} role="status">
        {error ? error : <><Check size={15} />{notice}</>}
        <button type="button" onClick={() => { setError(''); setNotice(''); }} aria-label="关闭提示"><X size={15} /></button>
      </div>
    )}

    {mode === 'relationships' ? <section className="relationship-view">
      <div className="section-heading"><div><Network size={20} /><h2>人物关系概览</h2></div><span>{characterRelations.length} 条关系</span></div>

      {characterRelations.length ? <div className="relationship-board">
        <div className="relation-people">
          {Array.from(new Set(characterRelations.flatMap(relation => [relation.source, relation.target]))).map(name => {
            const personItem = entries.find(item => cleanTitle(item.document.title) === name);
            const person = personItem && personItem.document;
            return <button
              type="button"
              className="person-node"
              key={name}
              onClick={() => { if (person) { setCategory('character'); setMode('documents'); select(person); } }}
            >
              <span><MessageSquareText size={20} /></span>
              <strong>{name}</strong>
              <small>{characterRelations.filter(relation => relation.source === name || relation.target === name).length} 条关联</small>
            </button>;
          })}
        </div>
        <div className="relationship-list">
          {characterRelations.map((relation, index) => (
            <div className="relationship-row" key={`${relation.source}-${relation.target}-${index}`}>
              <strong>{relation.source}</strong>
              <span><Network size={14} />{relation.label}</span>
              <strong>{relation.target}</strong>
            </div>
          ))}
        </div>
      </div> : <div className="empty-state">
        <Network size={34} />
        <h3>还没有人物关系</h3>
        <p>在人物文档里写 <code>[[人物]]</code></p>
        <button type="button" className="secondary-button" onClick={() => { setCategory('character'); setMode('documents'); }}>查看人物资料<ChevronRight size={16} /></button>
      </div>}
    </section> : <>
      <nav className="library-tabs" aria-label="资料类别">
        {CATEGORIES.map(item => {
          const Icon = item.icon;
          return <button
            type="button"
            className={category === item.id ? 'active' : ''}
            key={item.id}
            onClick={() => { setCategory(item.id); setSelectedId(''); setEditing(false); }}
          ><Icon size={17} />{item.label}<span>{entries.filter(entry => entry.category === item.id).length}</span></button>;
        })}
      </nav>
      <div className="library-layout">
        <aside className="document-list" aria-label="资料列表">
          <div className="document-list-heading">
            <span>{query ? `找到 ${visible.length} 项` : `全部${(CATEGORIES.find(item => item.id === category) || {}).label}`}</span>
            <FileText size={15} />
          </div>
          {visible.length ? visible.map(({ document }) => (
            <button
              type="button"
              className={`document-list-item ${selected && selected.document.id === document.id ? 'active' : ''}`}
              key={document.id}
              onClick={() => select(document)}
            >
              <span className="document-icon">
                {category === 'character' ? <MessageSquareText size={17} /> : category === 'location' ? <MapIcon size={17} /> : category === 'faction' ? <Network size={17} /> : <LibraryBig size={17} />}
              </span>
              <span><strong>{cleanTitle(document.title)}</strong><small>{excerpt(document.content)}</small></span>
              <ChevronRight size={15} />
            </button>
          )) : <div className="empty-list">
            <Search size={24} />
            <p>{query ? '没有匹配的资料' : '这个分类还没有资料'}</p>
            <small>{query ? '试试其他关键词' : '点击“新建资料”开始记录'}</small>
          </div>}
        </aside>
        <main className="document-reader">
          {selected ? <>
            <header className="document-header">
              <div>
                <span className="document-type">{(CATEGORIES.find(item => item.id === selected.category) || {}).label}</span>
                <h2>{cleanTitle(selected.document.title)}</h2>
                <p>{selected.document.path}{selected.document.updatedAt ? ` · 更新于 ${new Date(selected.document.updatedAt).toLocaleDateString('zh-CN')}` : ''}</p>
              </div>
              {editing ? <div className="editor-actions">
                <button type="button" className="secondary-button" onClick={() => setEditing(false)} disabled={busy}>取消</button>
                <button type="button" className="primary-button" onClick={saveSelected} disabled={busy}><Save size={16} />{busy ? '保存中…' : '保存'}</button>
              </div> : <button type="button" className="secondary-button" onClick={beginEdit}><PenLine size={16} />编辑</button>}
            </header>
            {editing ? <div className="markdown-editor">
              <div className="editor-caption"><PenLine size={14} />Markdown</div>
              <textarea value={draft} onChange={event => setDraft(event.target.value)} spellCheck={false} aria-label="Markdown 内容" autoFocus />
            </div> : <article className="markdown-preview">
              <div className="preview-caption"><ScanSearch size={14} />阅读模式</div>
              <div><MarkdownPreview content={selected.document.content} /></div>
            </article>}
          </> : <div className="empty-state">
            <BookOpen size={34} />
            <h3>选择或新建一份资料</h3>
            <button type="button" className="primary-button" onClick={() => setCreating(true)}><Plus size={16} />新建资料</button>
          </div>}
        </main>
      </div>
    </>}

    {creating && <div className="modal-backdrop" role="presentation" onMouseDown={event => { if (event.target === event.currentTarget) setCreating(false); }}>
      <form className="new-document-modal modal-panel" onSubmit={createDocument} role="dialog" aria-modal="true" aria-labelledby="new-document-title">
        <header>
          <div><p className="eyebrow">NEW ENTRY</p><h2 id="new-document-title">新建世界资料</h2></div>
          <button type="button" className="icon-button" onClick={() => setCreating(false)} aria-label="关闭"><X size={20} /></button>
        </header>
        <label>资料名称<input ref={titleInput} value={newTitle} onChange={event => setNewTitle(event.target.value)} placeholder="例如：林遥、白塔议会、北境" required /></label>
        <fieldset>
          <legend>资料类别</legend>
          <div className="category-picker">
            {CATEGORIES.map(item => {
              const Icon = item.icon;
              return <button type="button" className={newCategory === item.id ? 'active' : ''} key={item.id} onClick={() => setNewCategory(item.id)}><Icon size={18} />{item.label}</button>;
            })}
          </div>
        </fieldset>

        {error && <p className="form-error" role="alert">{error}</p>}
        <footer>
          <button type="button" className="secondary-button" onClick={() => setCreating(false)}>取消</button>
          <button type="submit" className="primary-button" disabled={busy}><Plus size={16} />{busy ? '创建中…' : '创建资料'}</button>
        </footer>
      </form>
    </div>}
  </div>;
}

module.exports = { Library };
