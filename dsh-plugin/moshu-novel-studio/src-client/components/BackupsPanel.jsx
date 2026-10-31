const React = require('react');
const { useEffect, useState } = React;
const { FileText, LoaderCircle, X } = require('../icons');
const api = require('../api');

/**
 * 备份历史面板。
 * props: { path, onRestore(content), onClose() }
 * 自己调 api.getBackups(path) / api.restoreBackup(path, id)。
 * 样式在 Editor.css（.moshu-root .editor-backups*），只在编辑器里挂载。
 */

function messageOf(reason, fallback) {
  if (reason instanceof Error && reason.message) return reason.message;
  if (typeof reason === 'string' && reason) return reason;
  if (reason && typeof reason.message === 'string' && reason.message) return reason.message;
  return fallback;
}

function formatTime(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return typeof value === 'string' && value ? value : '未知时间';
  try {
    return date.toLocaleString('zh-CN', {
      month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
    });
  } catch (error) {
    return date.toISOString();
  }
}

function formatSize(value) {
  const bytes = Number(value);
  if (!Number.isFinite(bytes) || bytes <= 0) return '—';
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / 1024 / 1024).toFixed(1) + ' MB';
}

function BackupsPanel({ path, onRestore, onClose }) {
  const [loading, setLoading] = useState(true);
  const [entries, setEntries] = useState([]);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [confirmId, setConfirmId] = useState('');
  const [busyId, setBusyId] = useState('');
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    setError('');
    setConfirmId('');
    if (!path) {
      setEntries([]);
      setLoading(false);
      setError('还没有打开章节，先选一章再来看备份。');
      return () => { alive = false; };
    }
    if (typeof api.getBackups !== 'function') {
      setEntries([]);
      setLoading(false);
      setError('备份接口暂不可用，请刷新页面后重试。');
      return () => { alive = false; };
    }
    Promise.resolve()
      .then(() => api.getBackups(path))
      .then((result) => {
        if (!alive) return;
        setEntries(result && Array.isArray(result.entries) ? result.entries : []);
        setLoading(false);
      })
      .catch((reason) => {
        if (!alive) return;
        setEntries([]);
        setLoading(false);
        setError(messageOf(reason, '读取备份失败，请稍后重试。'));
      });
    return () => { alive = false; };
  }, [path, reloadKey]);

  useEffect(() => {
    function onKeyDown(event) {
      if (event.key !== 'Escape') return;
      if (confirmId) { setConfirmId(''); return; }
      if (typeof onClose === 'function') onClose();
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [confirmId, onClose]);

  const close = () => {
    if (typeof onClose === 'function') onClose();
  };

  const restore = async (entry) => {
    if (!entry || busyId) return;
    if (typeof api.restoreBackup !== 'function') {
      setError('恢复接口暂不可用，请刷新页面后重试。');
      return;
    }
    setBusyId(entry.id);
    setError('');
    setNotice('');
    try {
      const result = await api.restoreBackup(path, entry.id);
      const content = result && typeof result.content === 'string' ? result.content : '';
      setConfirmId('');
      setNotice('已恢复这一版，编辑器里现在是它的内容。');
      setReloadKey(key => key + 1);
      if (typeof onRestore === 'function') onRestore(content);
    } catch (reason) {
      setError(messageOf(reason, '恢复失败，请稍后重试。'));
    } finally {
      setBusyId('');
    }
  };

  return (
    <aside className="editor-backups" aria-label="备份历史">
      <header className="editor-backups-header">
        <div>
          <span className="editor-backups-eyebrow">VERSIONS</span>
          <h2>备份历史 <span className="editor-backups-count">{entries.length}</span></h2>
        </div>
        <button type="button" className="editor-backups-close" onClick={close} aria-label="关闭备份历史" title="关闭">
          <X size={15} />
        </button>
      </header>
      <p className="editor-backups-path" title={path}>{path || '尚未选择章节'}</p>

      {loading && (
        <div className="editor-backups-empty">
          <LoaderCircle size={18} className="is-spinning" />
          <p>正在读取备份…</p>
        </div>
      )}

      {!loading && error && <p className="editor-backups-error" role="alert">{error}</p>}

      {!loading && !error && entries.length === 0 && (
        <div className="editor-backups-empty">
          <FileText size={22} />
          <h3>还没有历史版本</h3>
          <p>每次保存都会先把上一版留在这里；恢复某一版之前，也会先把当前内容另存一份备份。</p>
        </div>
      )}

      {!loading && !error && entries.length > 0 && (
        <ul className="editor-backups-list">
          {entries.map((entry) => {
            const confirming = confirmId === entry.id;
            return (
              <li className="editor-backups-item" key={entry.id}>
                <div className="editor-backups-item-main">
                  <strong>{formatTime(entry.at)}</strong>
                  <span>{formatSize(entry.bytes)}</span>
                </div>
                {confirming ? (
                  <div className="editor-backups-confirm">
                    <p>恢复这一版？当前内容会先另存一份备份，再替换成这一版。</p>
                    <div className="editor-backups-confirm-actions">
                      <button type="button" onClick={() => setConfirmId('')} disabled={busyId === entry.id}>取消</button>
                      <button type="button" className="is-primary" onClick={() => void restore(entry)} disabled={busyId === entry.id}>
                        {busyId === entry.id ? '恢复中…' : '恢复这一版'}
                      </button>
                    </div>
                  </div>
                ) : (
                  <button type="button" className="editor-backups-restore" onClick={() => setConfirmId(entry.id)} disabled={Boolean(busyId)}>
                    恢复这一版
                  </button>
                )}
              </li>
            );
          })}
        </ul>
      )}

      {notice && <p className="editor-backups-notice" role="status">{notice}</p>}
    </aside>
  );
}

module.exports = { BackupsPanel };
