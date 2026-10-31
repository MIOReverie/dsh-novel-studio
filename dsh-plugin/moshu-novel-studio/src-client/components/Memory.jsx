const React = require('react');
const { useEffect, useMemo, useState } = React;
const {
  Activity, BookOpen, BrainCircuit, Check, CheckCircle2, CircleHelp, FileText,
  LibraryBig, MessageSquareText, PenLine, Plus, Route, Save, ScanSearch, Search, Sparkles, X,
} = require('../icons');
const { SharedStyle } = require('./SharedStyle');
const css = require('./Memory.css');

const categories = [
  { id: 'all', label: '全部记忆', icon: LibraryBig },
  { id: 'canon', label: '稳定记忆', icon: CheckCircle2 },
  { id: 'character', label: '人物状态', icon: MessageSquareText },
  { id: 'summary', label: '章节摘要', icon: BookOpen },
  { id: 'foreshadowing', label: '伏笔线索', icon: Route },
];

const typeLabels = {
  canon: '稳定记忆', character: '人物状态', summary: '章节摘要', foreshadowing: '伏笔线索',
};

const dateLabel = (value) => {
  if (!value) return '时间未知';
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? value
    : date.toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
};

function Memory({ memories, documents, onSave, initialIncludedIds, onContextChange }) {
  const [category, setCategory] = useState('all');
  const [query, setQuery] = useState('');
  const [showPendingOnly, setShowPendingOnly] = useState(false);
  const [selectedId, setSelectedId] = useState((memories[0] || {}).id || '');
  const [editingId, setEditingId] = useState(null);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(null);
  const [notice, setNotice] = useState('');
  const [noticeTone, setNoticeTone] = useState('ok');
  const [showNew, setShowNew] = useState(false);
  const [newMemory, setNewMemory] = useState({ title: '', content: '', type: 'canon' });
  const [contextQuery, setContextQuery] = useState('');
  const [contextTab, setContextTab] = useState('included');
  const [includedIds, setIncludedIds] = useState(new Set());

  useEffect(() => {
    if (selectedId && !memories.some(item => item.id === selectedId)) setSelectedId((memories[0] || {}).id || '');
  }, [memories, selectedId]);

  useEffect(() => {
    setIncludedIds(new Set(initialIncludedIds || documents.filter(doc => doc.type !== 'memory').slice(0, 8).map(doc => doc.id)));
  }, [documents, initialIncludedIds]);

  const pending = memories.filter(item => item.status === 'pending');
  const confirmed = memories.filter(item => item.status !== 'pending');
  const filtered = memories.filter(item => {
    const keyword = query.trim().toLowerCase();
    return (category === 'all' || item.type === category)
      && (!showPendingOnly || item.status === 'pending')
      && (!keyword || `${item.title} ${item.content} ${item.source || ''}`.toLowerCase().includes(keyword));
  });
  const selected = memories.find(item => item.id === selectedId);
  const includedDocs = documents.filter(doc => includedIds.has(doc.id));
  const excludedDocs = documents.filter(doc => !includedIds.has(doc.id));
  const visibleDocs = (contextTab === 'included' ? includedDocs : excludedDocs)
    .filter(doc => !contextQuery || `${doc.title} ${doc.path}`.toLowerCase().includes(contextQuery.toLowerCase()));
  const totalCharacters = includedDocs.reduce((sum, doc) => sum + doc.content.length, 0)
    + confirmed.filter(item => item.locked).reduce((sum, item) => sum + item.content.length, 0);
  /* 这个数字只是「勾选的资料 + 锁定记忆」的体量估算，不是 AI 真正收到的量：
     后端会按 settings.contextRelatedDocs / contextMemories 重新挑选并截断。
     以前界面写「32,000 tokens 预算 / 已包含 N」，等于在替后端编数字。 */
  const estimatedTokens = Math.ceil(totalCharacters / 1.55);
  const tokenBudget = 32000;
  const rawHealth = Math.round(100 - pending.length * 2 - Math.max(0, estimatedTokens / tokenBudget - 0.75) * 60);
  /* 空库给 0 分：以前 memories 和 documents 都是空时照样显示 100 分「上下文状态良好」。 */
  const emptyLibrary = !memories.length && !documents.length;
  const health = emptyLibrary ? 0 : Math.max(0, Math.min(100, rawHealth));
  const healthLabel = emptyLibrary
    ? '还没有可用的上下文'
    : health >= 80
      ? '上下文状态良好'
      : health >= 50
        ? '上下文需要补充'
        : '上下文不足，AI 会看不清设定';
  const memoryCount = (type) => memories.filter(item => item.type === type).length;

  /** 保存一条记忆；返回 true 表示真的写进去了。 */
  const update = async (item, action) => {
    setBusy(item.id);
    setNotice('');
    try {
      await onSave(item);
      setNotice(action);
      setNoticeTone('ok');
      if (editingId === item.id) setEditingId(null);
      return true;
    } catch (error) {
      setNotice(error instanceof Error ? error.message : '保存失败，请稍后重试');
      setNoticeTone('error');
      return false;
    } finally {
      setBusy(null);
    }
  };

  const beginEdit = (item) => {
    if (item.locked) {
      setNotice('这条记忆已锁定。请先解锁，再编辑内容。');
      return;
    }
    setSelectedId(item.id);
    setDraft(item.content);
    setEditingId(item.id);
  };

  const toggleContext = (id) => {
    setIncludedIds(previous => {
      const next = new Set(previous);
      if (next.has(id)) next.delete(id); else next.add(id);
      if (onContextChange) {
        void Promise.resolve(onContextChange(Array.from(next))).catch(error => {
          setNotice(error instanceof Error ? error.message : '上下文选择保存失败');
        });
      }
      return next;
    });
  };

  const addMemory = async () => {
    if (!newMemory.title.trim() || !newMemory.content.trim()) {
      setNotice('请填写记忆标题和内容');
      return;
    }
    const item = {
      id: `memory-${Date.now()}`,
      title: newMemory.title.trim(),
      content: newMemory.content.trim(),
      type: newMemory.type,
      status: 'confirmed',
      source: '作者手动添加',
      updatedAt: new Date().toISOString(),
    };
    /* 只有真正写成功才关弹层、才清输入：以前失败也关，看着像成功。 */
    const saved = await update(item, '记忆已添加');
    if (saved === false) return;
    setNewMemory({ title: '', content: '', type: 'canon' });
    setShowNew(false);
    setSelectedId(item.id);
  };

  return (
    <div className="memory-page memory-view">
      <SharedStyle />
      <style dangerouslySetInnerHTML={{ __html: css }} />
      <header className="memory-header page-header">
        <div>
          <div className="eyebrow"><BrainCircuit size={15} /> LONG-TERM MEMORY</div>
          <h1>项目记忆</h1>

        </div>
        <button className="button primary" onClick={() => setShowNew(true)}><Plus size={17} /> 新建记忆</button>
      </header>

      <section className="memory-health-panel" aria-label="AI 上下文健康度">
        <div className="health-score">
          <div className="health-ring" style={{ '--health-score': `${health * 3.6}deg` }}>
            <div><strong>{health}</strong><span>健康度</span></div>
          </div>
          <div><h2>{healthLabel}</h2><p>{emptyLibrary ? '先在「世界资料」里建人物卡与设定，AI 才有东西可读' : '核心设定与人物状态已可供 AI 使用'}</p></div>
        </div>
        <div className="health-metrics">
          <div><CheckCircle2 size={18} /><span>已确认记忆</span><strong>{confirmed.length}</strong></div>
          <div><Check size={18} /><span>锁定记忆</span><strong>{memories.filter(item => item.locked).length}</strong></div>
          <div><Activity size={18} /><span>待确认变更</span><strong className={pending.length ? 'text-warning' : ''}>{pending.length}</strong></div>
          <div><Sparkles size={18} /><span>预计上下文</span><strong>{estimatedTokens.toLocaleString()} <small>tokens</small></strong></div>
        </div>
      </section>

      {notice && (
        <div className="memory-notice" role="status">
          <CircleHelp size={16} /><span>{notice}</span>
          <button className="icon-button" onClick={() => setNotice('')} aria-label="关闭提示"><X size={15} /></button>
        </div>
      )}

      <div className="memory-layout">
        <section className="memory-browser panel">
          <div className="panel-heading"><div><h2>记忆库</h2><p>{memories.length} 条可追溯的项目记忆</p></div><LibraryBig size={19} /></div>
          <div className="memory-category-tabs" role="tablist" aria-label="记忆分类">
            {categories.map(({ id, label, icon: Icon }) => (
              <button key={id} role="tab" aria-selected={category === id} className={category === id ? 'active' : ''} onClick={() => setCategory(id)}>
                <Icon size={16} /><span>{label}</span><span className="count">{id === 'all' ? memories.length : memoryCount(id)}</span>
              </button>
            ))}
          </div>
          <div className="memory-toolbar">
            <label className="search-field">
              <Search size={16} />
              <input value={query} onChange={event => setQuery(event.target.value)} placeholder="搜索记忆内容或来源" aria-label="搜索记忆" />
              {query && <button onClick={() => setQuery('')} aria-label="清空搜索"><X size={14} /></button>}
            </label>
            <button className={`button subtle ${showPendingOnly ? 'selected' : ''}`} onClick={() => setShowPendingOnly(value => !value)}>
              <Activity size={15} /> 待确认 {pending.length}
            </button>
          </div>
          <div className="memory-list">
            {filtered.map(item => (
              <article key={item.id} className={`memory-card ${selectedId === item.id ? 'selected' : ''} ${item.status === 'pending' ? 'pending' : ''}`}>
                <button className="memory-card-main" onClick={() => setSelectedId(item.id)}>
                  <div className="memory-card-heading">
                    <span className={`memory-type type-${item.type}`}>{typeLabels[item.type]}</span>
                    {item.locked && <Check size={13} aria-label="已锁定" />}
                    {item.status === 'pending' && <span className="status-badge pending">待确认</span>}
                  </div>
                  <h3>{item.title}</h3>
                  <p>{item.content}</p>
                  <div className="memory-source"><FileText size={13} /><span>{item.source || '项目记忆库'}</span><time>{dateLabel(item.updatedAt)}</time></div>
                </button>
                <div className="memory-card-actions">
                  {item.status === 'pending' ? <>
                    <button className="button small primary" disabled={busy === item.id} onClick={() => update({ ...item, status: 'confirmed', updatedAt: new Date().toISOString() }, '变更已确认，纳入正式记忆')}><Check size={14} /> 确认</button>
                    <button className="button small" disabled={busy === item.id} onClick={() => update({ ...item, content: '', status: 'confirmed', title: `${item.title}（已忽略）`, updatedAt: new Date().toISOString() }, '已忽略这条 AI 提取，保留操作记录')}>忽略</button>
                  </> : <>
                    <button
                      className="icon-button"
                      title={item.locked ? '解锁记忆' : '锁定记忆'}
                      aria-label={item.locked ? `解锁 ${item.title}` : `锁定 ${item.title}`}
                      disabled={busy === item.id}
                      onClick={() => update({ ...item, locked: !item.locked }, item.locked ? '记忆已解锁' : '记忆已锁定，AI 不会自动修改')}
                    >{item.locked ? <Check size={15} /> : <X size={15} />}</button>
                    <button className="icon-button" title="编辑记忆" aria-label={`编辑 ${item.title}`} onClick={() => beginEdit(item)}><PenLine size={15} /></button>
                  </>}
                </div>
                {editingId === item.id && <div className="memory-editor">
                  <label>记忆内容<textarea value={draft} onChange={event => setDraft(event.target.value)} rows={7} autoFocus /></label>
                  <div>
                    <button className="button" onClick={() => setEditingId(null)}>取消</button>
                    <button
                      className="button primary"
                      disabled={!draft.trim() || busy === item.id}
                      onClick={() => update({ ...item, content: draft.trim(), updatedAt: new Date().toISOString(), source: item.source || '作者编辑' }, '记忆修改已保存')}
                    ><Save size={15} /> {busy === item.id ? '保存中…' : '保存修改'}</button>
                  </div>
                </div>}
              </article>
            ))}
            {!filtered.length && <div className="empty-state">
              <Search size={30} />
              <h3>没有匹配的记忆</h3>
              <p>没有匹配的记忆</p>
              <button className="button" onClick={() => { setQuery(''); setCategory('all'); setShowPendingOnly(false); }}>清除筛选</button>
            </div>}
          </div>
        </section>

        <aside className="memory-inspector">
          {selected && <section className="memory-detail panel">
            <div className="panel-heading"><h2>记忆详情</h2><button className="icon-button" onClick={() => setSelectedId('')} aria-label="关闭详情"><X size={16} /></button></div>
            <span className={`memory-type type-${selected.type}`}>{typeLabels[selected.type]}</span><h3>{selected.title}</h3>
            <p className="memory-full-content">{selected.content}</p>
            <dl>
              <div><dt>状态</dt><dd>{selected.status === 'pending' ? '等待作者确认' : '作者已确认'}</dd></div>
              <div><dt>写入保护</dt><dd>{selected.locked ? '已锁定' : '未锁定'}</dd></div>
              <div><dt>来源</dt><dd>{selected.source || '项目记忆库'}</dd></div>
              <div><dt>更新时间</dt><dd>{dateLabel(selected.updatedAt)}</dd></div>
            </dl>
          </section>}

          <section className="context-panel panel">
            <div className="panel-heading">
              <div><h2><ScanSearch size={18} /> 上下文组装</h2></div>
              <span className="live-badge"><span />实时预览</span>
            </div>
            <div className="context-budget">
              <div><span>上下文预算</span><strong>{estimatedTokens.toLocaleString()} / {tokenBudget.toLocaleString()}</strong></div>
              <div className="progress-track"><span style={{ width: `${Math.min(100, estimatedTokens / tokenBudget * 100)}%` }} /></div>
              <p>{includedDocs.length} 份文档 · {confirmed.filter(item => item.locked).length} 条锁定记忆优先注入</p>
            </div>
            <div className="context-tabs">
              <button className={contextTab === 'included' ? 'active' : ''} onClick={() => setContextTab('included')}>已包含 {includedDocs.length}</button>
              <button className={contextTab === 'excluded' ? 'active' : ''} onClick={() => setContextTab('excluded')}>未包含 {excludedDocs.length}</button>
            </div>
            <label className="search-field compact">
              <Search size={14} />
              <input value={contextQuery} onChange={event => setContextQuery(event.target.value)} placeholder="查找上下文来源" />
            </label>
            <div className="context-list">
              {visibleDocs.map(doc => (
                <label className="context-item" key={doc.id}>
                  <input type="checkbox" checked={includedIds.has(doc.id)} onChange={() => toggleContext(doc.id)} />
                  <span className="custom-checkbox"><Check size={12} /></span>
                  <FileText size={16} />
                  <span><strong>{doc.title}</strong><small>{doc.path}</small></span>
                  <span className="context-tokens">约 {Math.ceil(doc.content.length / 1.55).toLocaleString()}</span>
                </label>
              ))}
              {!visibleDocs.length && <div className="empty-state compact">
                <FileText size={23} />
                <p>{contextQuery ? '没有匹配的资料' : contextTab === 'included' ? '尚未选择上下文资料' : '全部资料均已包含'}</p>
              </div>}
            </div>
            <div className="context-priority">
              <CheckCircle2 size={16} />
              <p><strong>注入优先级</strong><span>作者约束 → 锁定记忆 → 当前章纲 → 相邻摘要 → 检索资料</span></p>
            </div>
          </section>
        </aside>
      </div>

      {showNew && <div className="modal-backdrop" onMouseDown={event => { if (event.target === event.currentTarget) setShowNew(false); }}>
        <section className="modal memory-create-modal" role="dialog" aria-modal="true" aria-labelledby="new-memory-title">
          <div className="modal-header">
            <div>
              <span className="modal-icon"><BrainCircuit size={20} /></span>
              <div><h2 id="new-memory-title">新建记忆</h2></div>
            </div>
            <button className="icon-button" onClick={() => setShowNew(false)} aria-label="关闭"><X size={19} /></button>
          </div>
          <div className="modal-body">
            <label>记忆分类
              <select value={newMemory.type} onChange={event => setNewMemory({ ...newMemory, type: event.target.value })}>
                {categories.slice(1).map(item => <option key={item.id} value={item.id}>{item.label}</option>)}
              </select>
            </label>
            <label>标题<input autoFocus value={newMemory.title} onChange={event => setNewMemory({ ...newMemory, title: event.target.value })} placeholder="例如：林遥当前的身体状态" /></label>
            <label>记忆内容<textarea rows={7} value={newMemory.content} onChange={event => setNewMemory({ ...newMemory, content: event.target.value })} placeholder="记录明确、可供后续章节引用的事实…" /></label>

          </div>
          <div className="modal-footer">
            <button className="button" onClick={() => setShowNew(false)}>取消</button>
            <button className="button primary" onClick={addMemory} disabled={busy !== null}><Plus size={16} /> 创建记忆</button>
          </div>
        </section>
      </div>}
    </div>
  );
}

module.exports = { Memory };
module.exports.default = Memory;
