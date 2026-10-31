const React = require('react');
const { useMemo, useState } = React;
const {
  Check, CheckCircle2, CircleHelp, PenLine, Plus, ScanSearch,
  MessageSquareText, Settings2, Sparkles, X,
} = require('../icons');
const css = require('./Annotations.css');

/**
 * 一条批注的 source 到底是谁写的。
 * Host 的审阅链路写的是 `source:'dsh'`（见 host/review.js），旧数据里可能是 `'ai'` / `'AI'`，
 * 手动写的是 `'manual'`。三种 AI 来源必须都显示成「AI」，否则作者会以为那条意见是自己写的。
 */
function isAiSource(source) {
  return source === 'dsh' || source === 'ai' || source === 'AI';
}

/** status === 'stale'：引用的原文已经在正文里找不到了（revision 之后没能重新锚定）。 */
function isStale(annotation) {
  if (!annotation) return false;
  if (annotation.stale === true) return true;
  return annotation.status === 'stale';
}

/**
 * NewAnnotation：父组件 onAddAnnotation 收到的形态（原 TSX 的
 * `Omit<Annotation,'id'|'createdAt'|'status'|'source'>`）。
 * @typedef {Object} NewAnnotation
 * @property {string} documentPath
 * @property {string} quote
 * @property {number} [start]
 * @property {number} [end]
 * @property {'情节'|'语言'|'设定'|'人物'|'逻辑'} type
 * @property {'建议'|'注意'|'严重'} [severity]
 * @property {string} comment
 * @property {string} [suggestion]
 */

/** WPS 式批注侧栏。持久化、正文定位及 AI 结果合并由父组件负责。 */
function Annotations({
  annotations,
  activeDocumentPath,
  currentChapterOnly = false,
  selectedText = '',
  selectionRange,
  isLoading = false,
  className = '',
  onFilterChange,
  onLocate,
  onRelocate,
  onUpdateAnnotation,
  onAddAnnotation,
  onDeleteAnnotation,
}) {
  const [filter, setFilter] = useState('open');
  const [composerOpen, setComposerOpen] = useState(false);
  const [draft, setDraft] = useState('');
  const [pendingId, setPendingId] = useState(null);
  const [submitting, setSubmitting] = useState(false);
  /* 删除后 5 秒内可撤销（以前一键删除、无确认、无撤销）。 */
  const [undo, setUndo] = useState(null);
  const [error, setError] = useState('');

  const visible = useMemo(() => annotations.filter(item => {
    if (currentChapterOnly && activeDocumentPath && item.documentPath !== activeDocumentPath) return false;
    if (filter === 'open') return item.status !== 'resolved';
    if (filter === 'resolved') return item.status === 'resolved';
    if (filter === 'stale') return isStale(item);
    return true;
  }).sort((left, right) => Number(isStale(left)) - Number(isStale(right))), [annotations, activeDocumentPath, currentChapterOnly, filter]);
  const openCount = annotations.filter(item => item.status !== 'resolved').length;
  const staleCount = annotations.filter(isStale).length;

  const changeFilter = (next) => {
    setFilter(next);
    if (onFilterChange) onFilterChange(next);
  };

  const runAction = async (id, action) => {
    setPendingId(id);
    setError('');
    try {
      await action();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '操作未完成，请稍后重试');
    } finally {
      setPendingId(null);
    }
  };

  const submit = async (event) => {
    event.preventDefault();
    if (!draft.trim() || !activeDocumentPath) return;
    /* 没有引用原文时不要建批注：空 quote 在下一次保存时会被 relocateAnnotation 判成
       stale，而「重新定位」对空 quote 永远失败——那条批注就只剩下「删除」一条路。 */
    if (!selectedText || !selectedText.trim()) {
      setError('先在正文里选中要批注的那段话，再写批注（没有引用原文的批注没法定位）。');
      return;
    }
    setSubmitting(true);
    setError('');
    try {
      await onAddAnnotation({
        documentPath: activeDocumentPath,
        quote: selectedText,
        start: selectionRange && selectionRange.start,
        end: selectionRange && selectionRange.end,
        type: '语言',
        severity: '建议',
        comment: draft.trim(),
      });
      setDraft('');
      setComposerOpen(false);
      changeFilter('open');
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '批注添加失败，请稍后重试');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <aside className={`annotations-panel ${className}`} aria-label="章节批注">
      <style dangerouslySetInnerHTML={{ __html: css }} />
      <header className="annotations-header">
        <div>
          <span className="annotations-eyebrow">EDITORIAL NOTES</span>
          <h2>批注 <span className="annotations-count">{openCount}</span></h2>
        </div>
        <button
          type="button"
          className="annotations-add-button"
          onClick={() => setComposerOpen(value => !value)}
          disabled={!activeDocumentPath}
          aria-expanded={composerOpen}
          aria-label="添加手动批注"
          title="添加手动批注"
        >
          {composerOpen ? <X size={18} /> : <MessageSquareText size={18} />}
        </button>
      </header>

      <div className="annotations-filter" aria-label="筛选批注">
        <Settings2 size={14} aria-hidden="true" />
        {['open', 'stale', 'resolved', 'all'].map(value => (
          <button
            type="button"
            key={value}
            className={filter === value ? 'is-active' : ''}
            onClick={() => changeFilter(value)}
            aria-pressed={filter === value}
            title={value === 'stale' ? '引用的原文已经定位不到的批注' : undefined}
          >
            {value === 'open' ? '待处理' : value === 'resolved' ? '已解决' : value === 'stale' ? `失效${staleCount ? ' ' + staleCount : ''}` : '全部'}
          </button>
        ))}
      </div>

      {composerOpen && (
        <form className="annotation-composer" onSubmit={submit}>
          <label htmlFor="manual-annotation">写下你的想法</label>
          {selectedText && <blockquote>{selectedText}</blockquote>}
          <textarea
            id="manual-annotation"
            value={draft}
            onChange={event => setDraft(event.target.value)}
            placeholder="记录需要修改、核实或补充的地方…"
            rows={4}
            maxLength={2000}
            autoFocus
          />
          <div className="annotation-composer-footer">
            <span>{draft.length}/2000</span>
            <button type="submit" className="annotation-submit" disabled={!draft.trim() || submitting}>
              {submitting ? '添加中…' : '添加批注'}
            </button>
          </div>
        </form>
      )}
      {error && <p className="annotations-error" role="alert">{error}</p>}

      <div className="annotations-list" aria-live="polite">
        {isLoading ? (
          <div className="annotations-empty"><Sparkles size={22} /><p>正在整理批注…</p></div>
        ) : visible.length === 0 ? (
          <div className="annotations-empty">
            <CheckCircle2 size={28} />
            <h3>
              {filter === 'open'
                ? '此处已清爽无虞'
                : filter === 'stale'
                  ? '没有失效的批注'
                  : '还没有这类批注'}
            </h3>
            <p>
              {filter === 'open'
                ? '所有待处理意见都已解决。'
                : filter === 'stale'
                  ? '所有批注都还能在正文里定位到。'
                  : '切换筛选条件，或添加一条手动批注。'}
            </p>
          </div>
        ) : visible.map(item => {
          const resolved = item.status === 'resolved';
          const stale = isStale(item);
          const isAI = isAiSource(item.source);
          return (
            <article
              className={`annotation-card ${resolved ? 'is-resolved' : ''} ${stale ? 'is-stale' : ''} severity-${item.severity || '建议'}`}
              key={item.id}
            >
              <header className="annotation-card-header">
                <span className={`annotation-source ${isAI ? 'is-ai' : ''}`}>
                  {isAI ? <Sparkles size={13} /> : <PenLine size={13} />}{isAI ? 'AI 审阅' : '作者'}
                </span>
                <span className="annotation-type">{item.type}{item.severity ? ` · ${item.severity}` : ''}</span>
              </header>
              {stale && (
                <p className="annotation-stale-note">
                  <CircleHelp size={12} />
                  <span>原文已失效 · 这条批注引用的那段话现在在正文里定位不到了</span>
                </p>
              )}
              {item.quote && <blockquote className="annotation-quote">{item.quote}</blockquote>}
              <p className="annotation-content">{item.comment}</p>
              {item.suggestion && <p className="annotation-suggestion"><strong>修改建议</strong>{item.suggestion}</p>}
              <footer className="annotation-actions">
                {stale ? (
                  <>
                    {onRelocate && (
                      <button
                        type="button"
                        className="annotation-relocate"
                        disabled={pendingId === item.id}
                        title="按引用的原文重新在正文里找一次"
                        onClick={() => void runAction(item.id, () => onRelocate(item))}
                      ><ScanSearch size={14} />{pendingId === item.id ? '定位中…' : '重新定位'}</button>
                    )}
                    {onDeleteAnnotation && (
                      <button
                        type="button"
                        className="annotation-delete has-text"
                        disabled={pendingId === item.id}
                        title="删掉这条已经失效的批注"
                        onClick={() => {
                          /* 删除立刻生效、且直接落库；给一个 5 秒窗口「撤销」。 */
                          const snapshot = item;
                          void runAction(snapshot.id, () => onDeleteAnnotation(snapshot.id));
                          if (typeof window !== 'undefined') {
                            window.setTimeout(() => {
                              setUndo(null);
                            }, 5000);
                            setUndo({ item: snapshot });
                          }
                        }}
                      ><X size={13} />删除</button>
                    )}
                  </>
                ) : (
                  <>
                    <button type="button" onClick={() => onLocate(item)} title="定位到正文"><ScanSearch size={14} /> 定位</button>
                    <button
                      type="button"
                      className={resolved ? 'annotation-reopen' : 'annotation-resolve'}
                      disabled={pendingId === item.id}
                      onClick={() => void runAction(item.id, () => onUpdateAnnotation({ ...item, status: resolved ? 'open' : 'resolved' }))}
                    >
                      {resolved ? <Plus size={14} /> : <Check size={14} />}
                      {pendingId === item.id ? '处理中…' : resolved ? '重开' : '解决'}
                    </button>
                    {onDeleteAnnotation && (
                      <button
                        type="button"
                        className="annotation-delete"
                        aria-label="删除批注"
                        title="删除批注"
                        disabled={pendingId === item.id}
                        onClick={() => void runAction(item.id, () => onDeleteAnnotation(item.id))}
                      ><X size={14} /></button>
                    )}
                  </>
                )}
              </footer>
            </article>
          );
        })}
      </div>
      {undo ? (
        <div className="annotations-undo" role="status">
          <span>已删除一条批注</span>
          <button
            type="button"
            onClick={async () => {
              const restore = undo.item;
              setUndo(null);
              try {
                if (typeof onAddAnnotation === 'function') {
                  await onAddAnnotation({
                    documentPath: restore.documentPath,
                    quote: restore.quote,
                    start: restore.start,
                    end: restore.end,
                    type: restore.type,
                    severity: restore.severity,
                    comment: restore.comment,
                  });
                }
              } catch (reason) {
                setError(reason instanceof Error ? reason.message : '撤销失败');
              }
            }}
          >
            撤销
          </button>
        </div>
      ) : null}
    </aside>
  );
}

module.exports = { Annotations, isAiSource, isStale };
