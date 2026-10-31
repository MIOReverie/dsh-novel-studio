const React = require('react');
const { useEffect, useMemo, useState } = React;
const {
  Activity, BrainCircuit, Check, CheckCircle2, ChevronDown, ChevronRight, CircleHelp,
  Command, FileText, LibraryBig, LoaderCircle, Moon, Network, Search, Settings2, X, Zap,
} = require('../icons');
const { getProject, request } = require('../api');
const { SharedStyle } = require('./SharedStyle');
const css = require('./Tasks.css');

const statusLabels = { completed: '已完成', running: '运行中', failed: '失败' };
const typeLabels = {
  read: '只读分析', annotate: '章节审阅', draft: '正文草稿', update: '资料更新',
  maintenance: '记忆维护', review: '智能审阅', write: '辅助写作',
};
const modeLabels = {
  review: '章节审阅', write: '辅助写作', readonly: '只读分析', local: '本地降级', dsh: 'DSH 执行',
};
const formatDate = (value, full = false) => {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString('zh-CN', full
    ? { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }
    : { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
};

function PlusIcon() {
  return <span aria-hidden="true">＋</span>;
}

function Tasks({ project, tasks: providedTasks, dsh, onRefresh, onSaveMemory, onOpenDocument }) {
  /* 真实模型：优先 dsh.model，其次「未知」。以前写死 deepseek-v4.1-flash。 */
  const modelLabel = String((dsh && (dsh.model || dsh.provider)) || '').trim() || '未知模型';
  const [filter, setFilter] = useState('all');
  const [query, setQuery] = useState('');
  /* project.tasks 可能不存在（空书 / 旧数据）——以前这里直接 .tasks[0] 会白屏。 */
  const [selectedId, setSelectedId] = useState((((project || {}).tasks || [])[0] || {}).id || '');
  const [view, setView] = useState('overview');
  const [busy, setBusy] = useState(null);
  const [notice, setNotice] = useState('');
  const [checkedAt, setCheckedAt] = useState(null);
  const [expandedSource, setExpandedSource] = useState(null);
  const [reviewed, setReviewed] = useState({});
  const [showAll, setShowAll] = useState(false);

  useEffect(() => {
    if (selectedId && !providedTasks.some(task => task.id === selectedId)) setSelectedId((providedTasks[0] || {}).id || '');
  }, [providedTasks, selectedId]);

  const tasks = useMemo(() => [...providedTasks].sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()), [providedTasks]);
  const filtered = tasks.filter(task => (filter === 'all' || task.status === filter)
    && (!query.trim() || `${task.title} ${task.summary} ${task.mode}`.toLowerCase().includes(query.trim().toLowerCase())));
  const visibleTasks = showAll ? filtered : filtered.slice(0, 30);
  const selected = tasks.find(task => task.id === selectedId);
  const running = tasks.filter(task => task.status === 'running').length;
  const failed = tasks.filter(task => task.status === 'failed').length;
  const completed = tasks.filter(task => task.status === 'completed').length;
  /* 模型名从当前设置/宿主那边取，取不到就如实写「未知」——写死一个名字会跟页头胶囊打架。 */
  const model = modelLabel;
  const taskDocuments = selected ? project.documents.filter(doc => selected.sources.includes(doc.path) || selected.sources.includes(doc.title)) : [];
  const pendingChanges = selected ? project.memories.filter(memory => memory.status === 'pending'
    && (!memory.source || selected.sources.some(source => memory.source.indexOf(source) >= 0) || selected.type === 'maintenance')) : [];

  const refresh = async () => {
    setBusy('refresh');
    setNotice('');
    try {
      if (onRefresh) await onRefresh(); else await getProject();
      setCheckedAt(new Date());
      setNotice('已重新读取 DSH 状态与任务记录');
    } catch (error) {
      setNotice(error instanceof Error ? error.message : '连接检查失败，请稍后重试');
    } finally { setBusy(null); }
  };

  const retry = async (task) => {
    setBusy(task.id);
    setNotice('');
    try {
      const source = project.documents.find(doc => doc.type === 'chapter' && task.sources.includes(doc.path));
      if (!source) throw new Error('找不到原审阅章节，请回到写作页重新审阅。');
      const result = await request('/ai/review', {
        method: 'POST',
        body: JSON.stringify({
          documentPath: source.path,
          content: source.content,
          instruction: '重新检查剧情、逻辑、人物、设定和语言问题。',
          context: {
            memories: project.memories,
            related: project.documents.filter(doc => doc.type !== 'chapter'),
          },
        }),
      });
      if (onRefresh) await onRefresh();
      setNotice(`DSH 审阅完成，生成 ${result.annotations.length} 条批注。请回到写作页查看。`);
    } catch (error) { setNotice(error instanceof Error ? error.message : '任务重试失败'); }
    finally { setBusy(null); }
  };

  const reviewChange = async (memory, decision) => {
    if (!selected) return;
    const key = `${selected.id}-${memory.id}`;
    setBusy(key);
    setNotice('');
    try {
      const next = decision === 'accepted'
        ? { ...memory, status: 'confirmed', updatedAt: new Date().toISOString() }
        : { ...memory, title: `${memory.title}（已拒绝）`, content: '', status: 'confirmed', updatedAt: new Date().toISOString() };
      if (onSaveMemory) await onSaveMemory(next);
      else await request('/memory', { method: 'POST', body: JSON.stringify(next) });
      setReviewed(previous => ({ ...previous, [key]: decision }));
      if (onRefresh) await onRefresh();
      setNotice(decision === 'accepted' ? '变更已确认并写入项目记忆' : '变更已拒绝，原项目文件未被修改');
    } catch (error) { setNotice(error instanceof Error ? error.message : '审查结果保存失败'); }
    finally { setBusy(null); }
  };

  return (
    <div className="tasks-page tasks-view">
      <SharedStyle />
      <style dangerouslySetInnerHTML={{ __html: css }} />
      <header className="tasks-header page-header">
        <div>
          <div className="eyebrow"><Command size={15} /> AI EXECUTION CENTER</div>
          <h1>任务中心</h1>

        </div>
        <button className="button" onClick={refresh} disabled={busy === 'refresh'}>
          <LoaderCircle size={16} className={busy === 'refresh' ? 'spinning' : ''} /> 刷新状态
        </button>
      </header>

      <section className={`dsh-connection-panel ${dsh.available ? 'connected' : 'disconnected'}`}>
        <div className="dsh-connection-main">
          <span className="dsh-icon">{dsh.available ? <Network size={24} /> : <Moon size={24} />}</span>
          <div>
            <div className="connection-title">
              <h2>DeepSeek Harness</h2>
              <span className={`connection-status ${dsh.available ? 'online' : 'offline'}`}><span />{dsh.available ? '已连接' : '未连接'}</span>
            </div>
            <p>{dsh.message || (dsh.available ? '本地 AI 执行服务运行正常' : '本地写作与文件管理不受影响')}</p>
          </div>
        </div>
        <div className="dsh-connection-meta">
          <div><BrainCircuit size={16} /><span>执行模型</span><strong>{model}</strong><span className="model-badge">当前模型</span></div>
          <div><CheckCircle2 size={16} /><span>权限策略</span><strong>作者确认后写入</strong></div>
          <div><Activity size={16} /><span>服务状态</span><strong>{dsh.available ? '可接受新任务' : '仅本地功能可用'}</strong></div>
        </div>
      </section>

      <section className="task-stat-grid">
        <button className={filter === 'all' ? 'active' : ''} onClick={() => setFilter('all')}>
          <span className="stat-icon"><Activity size={19} /></span>
          <div><span>全部任务</span><strong>{tasks.length}</strong></div>
          <small>完整执行记录</small>
        </button>
        <button className={filter === 'running' ? 'active' : ''} onClick={() => setFilter('running')}>
          <span className="stat-icon running"><LoaderCircle size={19} /></span>
          <div><span>正在运行</span><strong>{running}</strong></div>
          <small>实时追踪进度</small>
        </button>
        <button className={filter === 'completed' ? 'active' : ''} onClick={() => setFilter('completed')}>
          <span className="stat-icon completed"><CheckCircle2 size={19} /></span>
          <div><span>已完成</span><strong>{completed}</strong></div>
          <small>结果已保存</small>
        </button>
        <button className={filter === 'failed' ? 'active' : ''} onClick={() => setFilter('failed')}>
          <span className="stat-icon failed"><X size={19} /></span>
          <div><span>执行失败</span><strong>{failed}</strong></div>
          <small>可查看日志并重试</small>
        </button>
      </section>

      {notice && (
        <div className="task-notice" role="status">
          <CircleHelp size={16} /><span>{notice}</span>
          <button className="icon-button" onClick={() => setNotice('')} aria-label="关闭提示"><X size={15} /></button>
        </div>
      )}

      <div className="tasks-layout">
        <section className="task-history panel">
          <div className="panel-heading"><div><h2>运行历史</h2></div><Activity size={19} /></div>
          <div className="task-history-toolbar">
            <label className="search-field">
              <Search size={16} />
              <input value={query} onChange={event => setQuery(event.target.value)} placeholder="搜索任务" aria-label="搜索任务" />
              {query && <button onClick={() => setQuery('')} aria-label="清空搜索"><X size={14} /></button>}
            </label>
            <label className="select-field">
              <Settings2 size={15} />
              <select value={filter} onChange={event => setFilter(event.target.value)} aria-label="任务状态筛选">
                <option value="all">全部状态</option>
                <option value="running">运行中</option>
                <option value="completed">已完成</option>
                <option value="failed">失败</option>
              </select>
            </label>
          </div>
          <div className="task-list">
            {visibleTasks.map(task => (
              <button key={task.id} className={`task-list-item ${selectedId === task.id ? 'selected' : ''}`} onClick={() => { setSelectedId(task.id); setView('overview'); }}>
                <span className={`task-status-icon ${task.status}`}>
                  {task.status === 'completed' ? <Check size={17} /> : task.status === 'running' ? <LoaderCircle size={17} className="spinning" /> : <X size={17} />}
                </span>
                <span className="task-list-content">
                  <span className="task-list-top"><span className="task-type">{typeLabels[task.type] || task.type}</span><time>{formatDate(task.createdAt)}</time></span>
                  <strong>{task.title}</strong>
                  <span className="task-summary">{task.summary}</span>
                  <span className="task-list-bottom">
                    <span><FileText size={12} />{(task.sources || []).length} 个来源</span>
                    <span className={`task-status ${task.status}`}>{statusLabels[task.status]}</span>
                  </span>
                </span>
                <ChevronRight size={16} className="task-chevron" />
              </button>
            ))}
            {!filtered.length && <div className="empty-state">
              <FileText size={32} />
              <h3>没有相关任务</h3>
              <p>{tasks.length ? '尝试调整状态筛选或搜索关键词。' : '开始一次 AI 审阅后，任务会显示在这里。'}</p>
              {tasks.length > 0 && <button className="button" onClick={() => { setFilter('all'); setQuery(''); }}>查看全部任务</button>}
            </div>}
          </div>
          {filtered.length > 30 && (
            <button className="task-show-more" onClick={() => setShowAll(value => !value)}>
              {showAll ? '收起历史任务' : `显示全部 ${filtered.length} 条任务`}<ChevronDown size={15} />
            </button>
          )}
        </section>

        <section className="task-detail panel">
          {selected ? <>
            <div className="task-detail-header">
              <div>
                <div className="task-detail-labels">
                  <span className={`task-status ${selected.status}`}>
                    {selected.status === 'running' ? <LoaderCircle size={13} className="spinning" /> : selected.status === 'completed' ? <CheckCircle2 size={13} /> : <X size={13} />}
                    {statusLabels[selected.status]}
                  </span>
                  <span>{typeLabels[selected.type] || selected.type}</span>
                  <span className="task-id">#{selected.id.slice(0, 12)}</span>
                </div>
                <h2>{selected.title}</h2>
                <p>{selected.summary}</p>
              </div>
              {selected.status === 'failed' && (
                <button className="button primary" onClick={() => retry(selected)} disabled={busy === selected.id || !dsh.available}>
                  <LoaderCircle size={15} />{busy === selected.id ? '提交中…' : '重试任务'}
                </button>
              )}
            </div>
            <div className="task-detail-tabs" role="tablist">
              <button className={view === 'overview' ? 'active' : ''} onClick={() => setView('overview')}><CircleHelp size={15} />执行概览</button>
              <button className={view === 'sources' ? 'active' : ''} onClick={() => setView('sources')}><LibraryBig size={15} />上下文来源<span>{selected.sources.length}</span></button>
              <button className={view === 'changes' ? 'active' : ''} onClick={() => setView('changes')}><FileText size={15} />变更审查{pendingChanges.length > 0 && <span className="attention-count">{pendingChanges.length}</span>}</button>
              <button className={view === 'logs' ? 'active' : ''} onClick={() => setView('logs')}><Command size={15} />运行日志</button>
            </div>
            <div className="task-detail-body">
              {view === 'overview' && <div className="task-overview">
                <section className="execution-result">
                  <div className="section-heading">
                    <h3>执行结果</h3>
                    <span className={`result-indicator ${selected.status}`}>
                      {selected.status === 'completed' ? '结果已保存' : selected.status === 'running' ? '正在生成' : '未完成'}
                    </span>
                  </div>
                  <p>{selected.summary || '任务尚未产生执行摘要。'}</p>
                  {selected.status === 'failed' && <div className="error-callout">
                    <CircleHelp size={17} />
                    <div>
                      <strong>本次执行没有修改文件</strong>
                    </div>
                  </div>}
                </section>
                <dl className="task-metadata">
                  <div><dt><Activity size={15} />创建时间</dt><dd>{formatDate(selected.createdAt, true)}</dd></div>
                  <div><dt><BrainCircuit size={15} />执行方式</dt><dd>{modeLabels[selected.mode] || selected.mode}</dd></div>
                  <div><dt><BrainCircuit size={15} />使用模型</dt><dd><code>{model}</code></dd></div>
                  <div><dt><CheckCircle2 size={15} />写入权限</dt><dd>{selected.type === 'read' || selected.type === 'annotate' || selected.type === 'draft' ? '只读 / 不覆盖正文' : '变更需作者确认'}</dd></div>
                </dl>
                <button className="source-summary-card" onClick={() => setView('sources')}>
                  <span><LibraryBig size={20} /></span>
                  <div>
                    <strong>本次任务读取了 {selected.sources.length} 份资料</strong>
                    <p>{selected.sources.slice(0, 3).join('、') || '未记录上下文来源'}{selected.sources.length > 3 ? '…' : ''}</p>
                  </div>
                  <ChevronRight size={18} />
                </button>
                {pendingChanges.length > 0 && <button className="review-callout" onClick={() => setView('changes')}>
                  <FileText size={20} />
                  <div><strong>{pendingChanges.length} 项变更待确认</strong></div>
                  <ChevronRight size={18} />
                </button>}
              </div>}

              {view === 'sources' && <div className="task-sources-view">
                <div className="detail-section-intro"><h3>上下文来源</h3></div>
                <div className="source-access-note"><CheckCircle2 size={16} /> 只读访问</div>
                {selected.sources.map((source, index) => {
                  const doc = project.documents.find(item => item.path === source || item.title === source);
                  return <article className="source-record" key={`${source}-${index}`}>
                    <button onClick={() => setExpandedSource(expandedSource === source ? null : source)}>
                      <span className="source-file-icon"><FileText size={17} /></span>
                      <span><strong>{(doc && doc.title) || source}</strong><small>{(doc && doc.path) || source}</small></span>
                      <span className="source-read-badge"><Check size={12} />已读取</span>
                      {doc && <ChevronDown size={16} className={expandedSource === source ? 'expanded' : ''} />}
                    </button>
                    {expandedSource === source && doc && <div className="source-content-preview">
                      <pre>{doc.content.slice(0, 1600)}{doc.content.length > 1600 ? '\n\n… 内容较长，仅显示前文预览' : ''}</pre>
                      {onOpenDocument && <button className="button small" onClick={() => onOpenDocument(doc.path)}>打开原文 <ChevronRight size={13} /></button>}
                    </div>}
                  </article>;
                })}

                {!selected.sources.length && <div className="empty-state compact">
                  <LibraryBig size={28} /><h3>未读取文档</h3>
                </div>}
              </div>}

              {view === 'changes' && <div className="task-changes-view">
                <div className="detail-section-intro"><h3>变更审查</h3></div>
                {pendingChanges.map(memory => {
                  const key = `${selected.id}-${memory.id}`;
                  const decision = reviewed[key];
                  return <article className={`change-review-card ${decision ? `reviewed-${decision}` : ''}`} key={memory.id}>
                    <div className="change-review-header">
                      <span className="change-file-icon"><FileText size={18} /></span>
                      <div><h4>{memory.title}</h4><p>{memory.source || 'AI 从当前任务上下文提取'}</p></div>
                      <span className="status-badge pending">待确认</span>
                    </div>
                    <div className="memory-diff">
                      <div className="diff-before"><span>当前</span><p>（空）</p></div>
                      <div className="diff-after"><span><PlusIcon />AI 建议新增</span><p>{memory.content}</p></div>
                    </div>
                    {decision ? <div className={`review-result ${decision}`}>
                      {decision === 'accepted' ? <CheckCircle2 size={17} /> : <X size={17} />}
                      {decision === 'accepted' ? '已接受，变更已写入项目记忆' : '已拒绝，未修改正式记忆'}
                    </div> : <div className="change-review-actions">
                      <button className="button" disabled={busy === key} onClick={() => reviewChange(memory, 'rejected')}><X size={15} />拒绝变更</button>
                      <button className="button primary" disabled={busy === key} onClick={() => reviewChange(memory, 'accepted')}><Check size={15} />{busy === key ? '保存中…' : '确认并写入'}</button>
                    </div>}
                  </article>;
                })}
                {!pendingChanges.length && <div className="empty-state changes-empty">
                  <span className="empty-success"><CheckCircle2 size={32} /></span>
                  <h3>没有待审查的变更</h3>
                  <p>没有待确认的变更</p>
                </div>}
              </div>}

              {view === 'logs' && <div className="task-logs-view">
                <div className="detail-section-intro"><h3>运行日志</h3></div>
                <div className="terminal-log">
                  <div className="terminal-header">
                    <span><i /><i /><i /></span>
                    <strong>DSH TASK LOG</strong>
                    <span>{selected.id.slice(0, 8)}</span>
                  </div>
                  <div className="terminal-body">
                    <p><time>{formatDate(selected.createdAt, true)}</time><span className="log-info">INFO</span> 创建任务：{selected.title}</p>
                    <p><time>{formatDate(selected.createdAt, true)}</time><span className="log-info">INFO</span> 执行模型：{model}</p>
                    <p><time>{formatDate(selected.createdAt, true)}</time><span className="log-info">INFO</span> 权限检查通过，开始组装上下文</p>
                    {selected.sources.map(source => (
                      <p key={source}><time>{formatDate(selected.createdAt, true)}</time><span className="log-read">READ</span> {source}</p>
                    ))}
                    <p>
                      <time>{formatDate(selected.createdAt, true)}</time>
                      <span className={selected.status === 'failed' ? 'log-error' : 'log-success'}>
                        {selected.status === 'failed' ? 'ERROR' : selected.status === 'running' ? 'RUNNING' : 'DONE'}
                      </span> {selected.summary}
                    </p>
                  </div>
                </div>

              </div>}
            </div>
          </> : <div className="empty-state task-detail-empty">
            <Command size={38} /><h2>选择一个任务</h2>
          </div>}
        </section>
      </div>

      <footer className="tasks-footer">
        <span><Network size={14} />{dsh.available ? 'DSH 服务可用' : 'DSH 当前离线'}</span>
        <span><BrainCircuit size={14} />{model}</span>
        {checkedAt && <span>最后检查：{checkedAt.toLocaleTimeString('zh-CN')}</span>}
        <span className="tasks-footer-right"><Zap size={13} />本地</span>
      </footer>
    </div>
  );
}

module.exports = { Tasks };
