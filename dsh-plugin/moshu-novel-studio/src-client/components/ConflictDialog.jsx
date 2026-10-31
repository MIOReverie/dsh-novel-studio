const React = require('react');
const { useEffect, useRef } = React;
const css = require('./ConflictDialog.css');

/**
 * 保存冲突面板（409）。
 *
 * 触发场景：页面自动保存时带着 expectedMtime，但磁盘上的 `.md` 已经被别的来源
 * （DSH 会话、另一个窗口、外部编辑器）改过，Host 拒绝写入并回传磁盘现版本。
 *
 * 三个出口，一个都不能少：
 *   1. 用磁盘版本覆盖我的编辑 —— 放弃本地修改，编辑器换成磁盘全文；
 *   2. 保留我的修改，强制保存   —— 重发一次不带 expectedMtime 的 PUT；
 *   3. 先不管                   —— 关掉面板，正文和“未保存”状态都留着，等作者自己决定。
 *
 * 这个组件只负责显示与回调，不自己发请求：决定权在 page.jsx（它维护 mtime 表）。
 */
function ConflictDialog({
  path = '',
  mine = '',
  disk = '',
  diskMtime = null,
  busy = false,
  error = '',
  onUseDisk,
  onForceSave,
  onDismiss,
}) {
  const firstButton = useRef(null);

  useEffect(() => {
    function onKeyDown(event) {
      if (event.key !== 'Escape' || busy) return;
      if (typeof onDismiss === 'function') onDismiss();
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [busy, onDismiss]);

  const mineLength = String(mine || '').length;
  const diskLength = String(disk || '').length;
  const diskKnown = typeof disk === 'string' && disk.length > 0;
  const at = diskMtime !== null && diskMtime !== undefined ? new Date(Number(diskMtime)) : null;
  const diskTime = at && !isNaN(at.getTime())
    ? at.toLocaleString('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit' })
    : '';

  return (
    <div className="conflict-backdrop" role="presentation">
      <style dangerouslySetInnerHTML={{ __html: css }} />
      <div
        className="conflict-panel"
        role="alertdialog"
        aria-modal="true"
        aria-label="保存冲突"
      >
        <header className="conflict-head">
          <span className="conflict-eyebrow">UNSAVED · CONFLICT</span>
          <h2>这个文件在磁盘上已被其他来源修改</h2>
          <p className="conflict-path" title={path}>{path || '（未命名文档）'}</p>
        </header>

        <p className="conflict-explain">
          磁盘上这份文件的版本和你正在看的已经不一样了（可能来自 DSH 会话，或者另一个窗口）。
          墨枢没有自动覆盖任何一边，请选择怎么处理：
        </p>

        <dl className="conflict-compare">
          <div>
            <dt>我的编辑</dt>
            <dd>{mineLength.toLocaleString()} 字 · 未保存</dd>
          </div>
          <div>
            <dt>磁盘版本</dt>
            <dd>
              {diskKnown ? diskLength.toLocaleString() + ' 字' : '内容未随响应返回'}
              {diskTime ? ' · ' + diskTime : ''}
            </dd>
          </div>
        </dl>

        {diskKnown && (
          <details className="conflict-preview">
            <summary>看一眼磁盘上的版本</summary>
            <pre>{disk.slice(0, 600)}{disk.length > 600 ? '\n…' : ''}</pre>
          </details>
        )}

        {error ? <p className="conflict-error" role="alert">{error}</p> : null}

        <div className="conflict-actions">
          <button
            type="button"
            className="conflict-button"
            onClick={() => { if (!busy && typeof onDismiss === 'function') onDismiss(); }}
            disabled={busy}
            title="关掉面板，正文和未保存状态都留着"
          >先不管</button>
          <button
            type="button"
            className="conflict-button is-danger"
            onClick={() => { if (!busy && typeof onUseDisk === 'function') onUseDisk(); }}
            disabled={busy || !diskKnown}
            title={diskKnown ? '放弃我这一版的修改，编辑器换成磁盘上的全文' : '响应里没有磁盘内容，无法用它覆盖'}
          >用磁盘版本覆盖我的编辑</button>
          <button
            type="button"
            ref={firstButton}
            className="conflict-button is-primary"
            onClick={() => { if (!busy && typeof onForceSave === 'function') onForceSave(); }}
            disabled={busy}
            title="不理会磁盘版本，直接写入我的全文"
          >{busy ? '保存中…' : '保留我的修改，强制保存'}</button>
        </div>

        <p className="conflict-foot">
          强制保存会覆盖磁盘上那份内容；不选的话，这段文字会一直标着“未保存”。
        </p>
      </div>
    </div>
  );
}

module.exports = { ConflictDialog };
