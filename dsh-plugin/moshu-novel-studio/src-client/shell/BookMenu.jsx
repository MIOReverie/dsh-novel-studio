'use strict';

/**
 * 墨枢 · 当前书籍下拉弹层。
 *
 * 契约（CONTRACT-v2 + 第三轮回收站）：
 *   <BookMenu books={BookRef[]} current={BookRef|null} busy={bool}
 *             onSelect(id) onCreate(name) onRename(id,name) onTrash(id)
 *             onDelete(id, confirmName)   // 彻底删除：不可恢复
 *             onTrashChanged()            // 回收站恢复 / 清空后请父组件重拉数据
 *             onClose() />
 *
 * 自带：列表（书名 / 章数 / 字数 / 最近修改，当前书打勾）、新建、改名、
 * 移到回收站二次确认、彻底删除（必须逐字输入书名才放行）、
 * 底部可折叠的「回收站 (N)」（展开才懒加载，可恢复 / 彻底删除）。
 * 空书名、重名、非法字符在这里先挡一次。
 *
 * 交互：Esc 关闭、点外面关闭、role="menu"、触发按钮由 page.jsx 负责 aria-expanded。
 * Esc 的优先级：先取消正在进行的危险确认，再关闭菜单。
 * 样式在 ./bookmenu.css（全部挂在 .moshu-root 下），不塞回 styles.css。
 */

const React = require('react');
const { useEffect, useRef, useState } = React;

const api = require('../api');
const icons = require('../icons');
const strings = require('../strings');
const css = require('./bookmenu.css');

const t = strings.t;

const INVALID_CHARS = /[\\/:*?"<>|]/;
const MAX_NAME = 40;

function bookTitle(book) {
  if (!book) return '';
  return String(book.title || book.name || book.id || '');
}

function count(value) {
  const number = Number(value);
  if (!isFinite(number) || number < 0) return 0;
  try {
    return number.toLocaleString();
  } catch (error) {
    return String(number);
  }
}

function formatDate(value) {
  if (!value) return '';
  const date = value instanceof Date ? value : new Date(value);
  if (!date || isNaN(date.getTime())) return '';
  try {
    return date.toLocaleString(strings.isEnglish() ? 'en-US' : 'zh-CN', {
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit'
    });
  } catch (error) {
    return '';
  }
}

function pad2(value) {
  const number = Number(value);
  if (!isFinite(number)) return '00';
  return (number < 10 ? '0' : '') + String(Math.floor(number));
}

/** 回收站的时间戳统一显示成"本地时区的 MM-DD HH:mm"，一眼能看出是哪天删的。
 *  Host 的回收站目录名用的是 `2026-10-30T09-12-33-123Z`（`:` 和 `.` 被换成 `-` 以保证文件名安全），
 *  这种串 `new Date()` 直接解析会得到 Invalid Date，所以这里先补回冒号再解析。 */
function parseTrashTime(value) {
  if (value === null || value === undefined || value === '') return null;
  if (value instanceof Date) return isNaN(value.getTime()) ? null : value;
  if (typeof value === 'number') {
    if (!isFinite(value)) return null;
    const fromNumber = new Date(value);
    return isNaN(fromNumber.getTime()) ? null : fromNumber;
  }
  const raw = String(value).trim();
  if (!raw) return null;
  if (/^\d+$/.test(raw)) {
    const fromEpoch = new Date(Number(raw));
    return isNaN(fromEpoch.getTime()) ? null : fromEpoch;
  }
  const direct = new Date(raw);
  if (!isNaN(direct.getTime())) return direct;
  const fixed = raw.replace(/T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z$/, 'T$1:$2:$3.$4Z');
  const repaired = new Date(fixed);
  return isNaN(repaired.getTime()) ? null : repaired;
}

function formatTrashTime(value) {
  const date = parseTrashTime(value);
  if (!date) return '';
  return pad2(date.getMonth() + 1) + '-' + pad2(date.getDate()) + ' ' + pad2(date.getHours()) + ':' + pad2(date.getMinutes());
}

/** 回收站条目体积：KB / MB 两档，够读就行。 */
function formatBytes(value) {
  const bytes = Number(value);
  if (!isFinite(bytes) || bytes < 0) return '';
  const kb = bytes / 1024;
  if (kb < 100) return kb.toFixed(1) + ' KB';
  if (kb < 1024) return String(Math.round(kb)) + ' KB';
  const mb = kb / 1024;
  return (mb < 10 ? mb.toFixed(1) : String(Math.round(mb))) + ' MB';
}

/** 后端错误一律是中文 message；拿不到就给一句通用提示，不静默。 */
function messageOf(reason) {
  if (!reason) return t('请求未完成，请重试');
  if (typeof reason === 'string') return reason;
  const message = reason.message || reason.error;
  if (message && typeof message === 'object' && message.message) return String(message.message);
  if (message) return String(message);
  return t('请求未完成，请重试');
}

/** 前端先挡一次：空 / . 开头 / 非法字符 / 超长 / 重名。
 *  规则与 Host 的 store.validateNovelName 保持一致，避免提交了才被 400 打回来。 */
function validateName(raw, books, ignoreId) {
  const name = String(raw === null || raw === undefined ? '' : raw).trim();
  if (!name) return t('书名不能为空');
  if (/^\.+$/.test(name)) return t('书名不能是 . 或 ..');
  if (name.startsWith('.')) return t('书名不能以「.」开头（这个前缀留给内部目录）');
  if (INVALID_CHARS.test(name)) return t('书名不能包含 \\ / : * ? " < > |');
  if (name.length > MAX_NAME) return t('书名最多 40 个字');
  const lower = name.toLowerCase();
  const clash = (books || []).some(function (book) {
    if (!book) return false;
    if (ignoreId && String(book.id) === String(ignoreId)) return false;
    return [book.name, book.title, book.id].some(function (value) {
      return String(value === null || value === undefined ? '' : value).trim().toLowerCase() === lower;
    });
  });
  if (clash) return t('已有同名作品');
  return '';
}

/* ---------------- 回收站接口 ----------------
 * api.js 里这几个函数可能还没加：存在就优先用，缺失就退回 api.request，
 * 两边都发同样的 path/body，不依赖 api.js 的改动顺序。 */

function requestJson(path, body) {
  if (!api || typeof api.request !== 'function') {
    return Promise.reject(new Error(t('暂时无法连接本地服务')));
  }
  return api.request(path, { method: 'POST', body: JSON.stringify(body || {}) });
}

function readTrash() {
  const fn = typeof api.getTrash === 'function' ? api.getTrash : null;
  if (fn) return Promise.resolve(fn());
  if (!api || typeof api.request !== 'function') {
    return Promise.reject(new Error(t('暂时无法连接本地服务')));
  }
  return api.request('/trash');
}

function restoreTrashEntry(trashId) {
  const fn = typeof api.restoreTrash === 'function' ? api.restoreTrash : null;
  if (fn) return Promise.resolve(fn(trashId));
  return requestJson('/trash/restore', { trashId: trashId });
}

function purgeTrashEntry(trashId) {
  const fn = typeof api.purgeTrash === 'function' ? api.purgeTrash : null;
  if (fn) return Promise.resolve(fn(trashId));
  return requestJson('/trash/purge', { trashId: trashId });
}

function deleteBookForever(id, confirmName) {
  const fn = typeof api.deleteBook === 'function' ? api.deleteBook : null;
  if (fn) return Promise.resolve(fn(id, confirmName));
  return requestJson('/books/delete', { id: String(id), confirm: String(confirmName) });
}

/** GET /trash 的返回：{ trash: [{ trashId, name, trashedAt, bytes }] }。字段容错一下。 */
function normalizeTrash(payload) {
  const list = payload && Array.isArray(payload.trash) ? payload.trash : (Array.isArray(payload) ? payload : []);
  return list.map(function (item) {
    const source = item && typeof item === 'object' ? item : {};
    const id = source.trashId !== undefined && source.trashId !== null
      ? String(source.trashId)
      : (source.id !== undefined && source.id !== null ? String(source.id) : '');
    return {
      id: id,
      name: String(source.name || source.title || id || ''),
      trashedAt: source.trashedAt !== undefined ? source.trashedAt : (source.deletedAt !== undefined ? source.deletedAt : source.at),
      bytes: source.bytes !== undefined ? source.bytes : source.size
    };
  });
}

function BookMenu(props) {
  const propBooks = Array.isArray(props.books) ? props.books : [];
  const current = props.current || null;
  const busy = Boolean(props.busy);
  const onSelect = typeof props.onSelect === 'function' ? props.onSelect : function () {};
  const onCreate = typeof props.onCreate === 'function' ? props.onCreate : function () {};
  const onRename = typeof props.onRename === 'function' ? props.onRename : function () {};
  const onTrash = typeof props.onTrash === 'function' ? props.onTrash : function () {};
  const onClose = typeof props.onClose === 'function' ? props.onClose : function () {};

  const rootRef = useRef(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  /* 本地书籍列表：父组件每次传新数组就同步一次；
     restore / delete 返回的 books 先落到这里，界面不用等父组件刷新。 */
  const [localBooks, setLocalBooks] = useState(propBooks);
  const [draftName, setDraftName] = useState('');
  const [renamingId, setRenamingId] = useState('');
  const [renameValue, setRenameValue] = useState('');
  const [confirmId, setConfirmId] = useState('');
  const [deleteId, setDeleteId] = useState('');
  const [deleteInput, setDeleteInput] = useState('');
  const [deleteBusyId, setDeleteBusyId] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  /* 回收站 */
  const [trashOpen, setTrashOpen] = useState(false);
  const [trashItems, setTrashItems] = useState(null); // null = 还没加载
  const [trashLoading, setTrashLoading] = useState(false);
  const [trashError, setTrashError] = useState('');
  const [purgeConfirmId, setPurgeConfirmId] = useState('');
  const [trashBusyId, setTrashBusyId] = useState(''); // 恢复 / 彻底删除共用，避免并发

  const books = Array.isArray(localBooks) ? localBooks : propBooks;
  const currentId = current && current.id ? String(current.id) : '';

  useEffect(function () {
    setLocalBooks(propBooks);
  }, [props.books]);

  /* Esc：先取消危险确认，再关菜单。点外面关闭保持不变。触发按钮的点击交给 page.jsx。 */
  const escRef = useRef(null);
  escRef.current = function () {
    if (deleteId) {
      setDeleteId('');
      setDeleteInput('');
      setError('');
      return;
    }
    if (purgeConfirmId) {
      setPurgeConfirmId('');
      return;
    }
    if (confirmId) {
      setConfirmId('');
      return;
    }
    closeRef.current();
  };

  useEffect(function () {
    function onKeyDown(event) {
      if (event.key === 'Escape') {
        event.stopPropagation();
        if (typeof escRef.current === 'function') escRef.current();
      }
    }
    function onPointerDown(event) {
      const node = rootRef.current;
      const target = event.target;
      if (node && target && node.contains(target)) return;
      const anchor = target && typeof target.closest === 'function' ? target.closest('.menu-anchor') : null;
      if (anchor && node && anchor.contains(node)) return;
      closeRef.current();
    }
    document.addEventListener('keydown', onKeyDown);
    document.addEventListener('mousedown', onPointerDown);
    return function () {
      document.removeEventListener('keydown', onKeyDown);
      document.removeEventListener('mousedown', onPointerDown);
    };
  }, []);

  /* 打开时把焦点放到弹层本身，Tab 立刻能走到第一行。 */
  useEffect(function () {
    const node = rootRef.current;
    if (node && typeof node.focus === 'function') {
      try { node.focus({ preventScroll: true }); } catch (error) { node.focus(); }
    }
  }, []);

  /* 回收站第一次展开时才去读，之后复用；读失败 / 被标脏才重读。 */
  useEffect(function () {
    if (!trashOpen) return;
    if (trashItems !== null) return;
    if (trashLoading) return;
    refreshTrash();
  }, [trashOpen]);

  function settle(result, onOk, onFail) {
    if (!result || typeof result.then !== 'function') {
      onOk();
      return;
    }
    result.then(function (ok) {
      if (ok === false) onFail();
      else onOk();
    }).catch(function (reason) {
      setError(reason && reason.message ? reason.message : String(reason || ''));
      onFail();
    });
  }

  function applyBooks(next) {
    if (Array.isArray(next)) setLocalBooks(next);
  }

  /** 父组件要重拉数据时调一下；它抛错 / reject 都不该打断菜单。 */
  function notifyTrashChanged() {
    if (typeof props.onTrashChanged !== 'function') return;
    try {
      const result = props.onTrashChanged();
      if (result && typeof result.catch === 'function') result.catch(function () {});
    } catch (error) {
      /* 父组件的刷新失败不影响这里已经生效的本地状态 */
    }
  }

  function refreshTrash() {
    setTrashLoading(true);
    setTrashError('');
    readTrash().then(function (payload) {
      setTrashItems(normalizeTrash(payload));
      setTrashLoading(false);
    }).catch(function (reason) {
      setTrashItems(null);
      setTrashError(messageOf(reason));
      setTrashLoading(false);
    });
  }

  function toggleTrash() {
    setPurgeConfirmId('');
    setTrashError('');
    setTrashOpen(function (open) { return !open; });
  }

  /** 回收站内容可能变了：已经读过就顺手刷新，没展开过就等下次展开再读。 */
  function markTrashDirty() {
    if (trashItems !== null && !trashLoading) refreshTrash();
    else setTrashItems(null);
  }

  /* ---------------- 作品列表动作 ---------------- */

  function submitCreate() {
    if (busy) return;
    const message = validateName(draftName, books, '');
    if (message) {
      setError(message);
      return;
    }
    setError('');
    setNotice('');
    const name = draftName.trim();
    /* 建完就切过去了，弹层顺手收起来；失败则留在原地让用户改名字。 */
    settle(onCreate(name), function () {
      setDraftName('');
      onClose();
    }, function () {});
  }

  function startRename(book) {
    setConfirmId('');
    setDeleteId('');
    setDeleteInput('');
    setError('');
    setNotice('');
    setRenamingId(String(book.id));
    setRenameValue(bookTitle(book));
  }

  function submitRename(book) {
    if (busy) return;
    const message = validateName(renameValue, books, book.id);
    if (message) {
      setError(message);
      return;
    }
    setError('');
    settle(onRename(String(book.id), renameValue.trim()), function () { setRenamingId(''); }, function () {});
  }

  function submitTrash(book) {
    if (busy) return;
    setError('');
    setNotice('');
    settle(onTrash(String(book.id)), function () {
      setConfirmId('');
      markTrashDirty();
    }, function () {});
  }

  function openDeleteConfirm(book) {
    const id = String(book.id);
    setRenamingId('');
    setConfirmId('');
    setPurgeConfirmId('');
    setError('');
    setNotice('');
    setDeleteId(id);
    setDeleteInput('');
  }

  function cancelDeleteConfirm() {
    setDeleteId('');
    setDeleteInput('');
    setError('');
  }

  /** 确认词必须与书名逐字相同。
   *  Host 认「标题」（project.md 一级标题）和「目录名」两种写法（改名/改过标题后两者会不同），
   *  这里同步接受这两个别名，免得作者明明输对了却删不掉。 */
  function confirmAliases(book) {
    const list = [];
    [bookTitle(book), book && book.name, book && book.id].forEach(function (value) {
      const text = String(value === null || value === undefined ? '' : value).trim();
      if (text && list.indexOf(text) === -1) list.push(text);
    });
    return list;
  }

  function deleteInputMatches(book) {
    const aliases = confirmAliases(book);
    if (!aliases.length) return false;
    return aliases.indexOf(deleteInput) !== -1;
  }

  function submitDelete(book) {
    if (busy || deleteBusyId) return;
    const id = String(book.id);
    /* 发给 Host 的确认词用「标题」：它是作者在界面上看到的书名，Host 也认这一种。 */
    const confirmName = bookTitle(book);
    if (!confirmName) {
      setError(t('这本书没有书名，无法确认删除。'));
      return;
    }
    if (!deleteInputMatches(book)) {
      setError(t('输入的书名和《{name}》不一致，还不能删除。', { name: confirmName }));
      return;
    }
    setError('');
    setNotice('');
    setDeleteBusyId(id);

    /* 父组件接了 onDelete 就交给它（它负责切书 / 刷新）；没接就直接打后端。 */
    const delegated = typeof props.onDelete === 'function';
    const run = delegated
      ? Promise.resolve(props.onDelete(id, confirmName))
      : deleteBookForever(id, confirmName);

    run.then(function (result) {
      if (result === false) {
        setDeleteBusyId('');
        setError(t('彻底删除没有完成，请重试；或者改用「移到回收站」。'));
        return;
      }
      const bag = result && typeof result === 'object' ? result : null;
      if (bag && Array.isArray(bag.books)) {
        applyBooks(bag.books);
      } else {
        /* 父组件没回 books：先在本地摘掉这一行，父组件刷新后会被覆盖成权威列表。 */
        setLocalBooks(function (list) {
          const source = Array.isArray(list) ? list : [];
          return source.filter(function (entry) { return String(entry && entry.id) !== id; });
        });
      }
      setDeleteBusyId('');
      setDeleteId('');
      setDeleteInput('');
      setNotice(t('已彻底删除《{name}》', { name: confirmName }));
      notifyTrashChanged();
    }).catch(function (reason) {
      setDeleteBusyId('');
      setError(messageOf(reason));
    });
  }

  /* ---------------- 回收站动作 ---------------- */

  function submitRestore(item) {
    if (busy || trashBusyId) return;
    const trashId = item.id;
    if (!trashId) {
      setTrashError(t('这条回收站记录没有 id，无法恢复。'));
      return;
    }
    setTrashError('');
    setNotice('');
    setTrashBusyId(trashId);
    restoreTrashEntry(trashId).then(function (bag) {
      const payload = bag && typeof bag === 'object' ? bag : {};
      if (Array.isArray(payload.books)) applyBooks(payload.books);
      setTrashItems(function (list) {
        if (!Array.isArray(list)) return list;
        return list.filter(function (entry) { return entry.id !== trashId; });
      });
      setPurgeConfirmId('');
      setTrashBusyId('');
      setNotice(t('已恢复《{name}》', { name: item.name || trashId }));
      notifyTrashChanged();
    }).catch(function (reason) {
      setTrashBusyId('');
      setTrashError(messageOf(reason));
    });
  }

  function submitPurge(item) {
    if (busy || trashBusyId) return;
    const trashId = item.id;
    if (!trashId) {
      setTrashError(t('这条回收站记录没有 id，无法删除。'));
      return;
    }
    setTrashError('');
    setNotice('');
    setTrashBusyId(trashId);
    purgeTrashEntry(trashId).then(function (bag) {
      const payload = bag && typeof bag === 'object' ? bag : {};
      if (Array.isArray(payload.trash)) setTrashItems(normalizeTrash(payload));
      else {
        setTrashItems(function (list) {
          if (!Array.isArray(list)) return list;
          return list.filter(function (entry) { return entry.id !== trashId; });
        });
      }
      setPurgeConfirmId('');
      setTrashBusyId('');
      setNotice(t('已从回收站彻底删除《{name}》', { name: item.name || trashId }));
      notifyTrashChanged();
    }).catch(function (reason) {
      setTrashBusyId('');
      setTrashError(messageOf(reason));
    });
  }

  /* ---------------- 渲染 ---------------- */

  return (
    <React.Fragment>
      <style data-moshu-bookmenu="1" dangerouslySetInnerHTML={{ __html: css }} />
      <div
        className="menu-popover book-menu"
        ref={rootRef}
        role="menu"
        aria-label={t('切换书籍')}
        aria-busy={busy ? 'true' : undefined}
        tabIndex={-1}
      >
        <div className="menu-popover-head">
          <strong>{t('切换书籍')}</strong>
          {busy ? (
            <span className="menu-busy">
              <icons.LoaderCircle size={13} className="is-spinning" />
              {t('正在切换…')}
            </span>
          ) : null}
        </div>

        <div className="menu-scroll">
          {!books.length ? (
            <div className="menu-empty">{t('还没有其他作品，先新建一个吧')}</div>
          ) : null}

          {books.map(function (book) {
            const id = String(book && book.id !== undefined ? book.id : '');
            const title = bookTitle(book);
            const active = Boolean(currentId) && currentId === id;
            const stamp = formatDate(book.updatedAt);
            const meta = t('{n} 章 · {w} 字', { n: count(book.chapters), w: count(book.words) });
            const renaming = renamingId === id;
            const confirmingDelete = deleteId === id;
            const matched = confirmingDelete && deleteInputMatches(book);
            const deleting = deleteBusyId === id;

            if (renaming) {
              return (
                <div className="menu-row is-editing" key={id}>
                  <div className="menu-field">
                    <input
                      autoFocus
                      value={renameValue}
                      aria-label={t('改名')}
                      maxLength={64}
                      onChange={function (event) { setRenameValue(event.target.value); }}
                      onKeyDown={function (event) {
                        if (event.key === 'Enter') {
                          event.preventDefault();
                          submitRename(book);
                        }
                      }}
                    />
                    <button type="button" className="menu-primary" disabled={busy} onClick={function () { submitRename(book); }}>
                      {t('保存')}
                    </button>
                    <button type="button" className="menu-ghost" onClick={function () { setRenamingId(''); setError(''); }}>
                      {t('取消')}
                    </button>
                  </div>
                </div>
              );
            }

            return (
              <div className={'menu-row' + (active ? ' is-current' : '') + (confirmingDelete ? ' is-confirming' : '')} key={id}>
                <button
                  type="button"
                  role="menuitem"
                  className="menu-row-main"
                  disabled={busy}
                  aria-current={active ? 'true' : undefined}
                  title={title}
                  onClick={function () {
                    if (busy) return;
                    if (active) {
                      onClose();
                      return;
                    }
                    settle(onSelect(id), function () {}, function () {});
                  }}
                >
                  <span className="menu-row-title">{title || t('未命名')}</span>
                  <span className="menu-row-meta">
                    {meta}
                    {stamp ? ' · ' + t('最近修改 {time}', { time: stamp }) : ''}
                  </span>
                </button>

                <span className="menu-row-check" aria-hidden="true">
                  {active ? <icons.Check size={14} /> : null}
                </span>

                <div className="menu-row-actions book-row-actions">
                  <button
                    type="button"
                    className="menu-link"
                    disabled={busy}
                    onClick={function () { startRename(book); }}
                  >
                    {t('改名')}
                  </button>
                  <button
                    type="button"
                    className="menu-link is-danger"
                    disabled={busy}
                    onClick={function () {
                      setRenamingId('');
                      setDeleteId('');
                      setDeleteInput('');
                      setError('');
                      setNotice('');
                      setConfirmId(id);
                    }}
                  >
                    {t('移到回收站')}
                  </button>
                  <button
                    type="button"
                    className="book-link-danger"
                    disabled={busy}
                    aria-label={t('彻底删除《{name}》', { name: title || id })}
                    title={t('彻底删除：磁盘目录会被直接删除，不可恢复')}
                    onClick={function () { openDeleteConfirm(book); }}
                  >
                    <span className="book-danger-mark" aria-hidden="true" />
                    <span>{t('彻底删除')}</span>
                  </button>
                </div>

                {confirmId === id ? (
                  <div className="menu-confirm" role="alert">
                    <p className="menu-confirm-title">{t('确定把《{name}》移到回收站？', { name: title || id })}</p>
                    <p className="menu-confirm-hint">{t('会移到 novels/.trash，不会真正删除，之后可以手动找回。')}</p>
                    <div className="menu-confirm-actions">
                      <button type="button" className="menu-danger" disabled={busy} onClick={function () { submitTrash(book); }}>
                        {t('移到回收站')}
                      </button>
                      <button type="button" className="menu-ghost" onClick={function () { setConfirmId(''); }}>
                        {t('取消')}
                      </button>
                    </div>
                  </div>
                ) : null}

                {confirmingDelete ? (
                  <div className="menu-confirm book-confirm" role="alert">
                    <p className="menu-confirm-title">{t('确定彻底删除《{name}》？', { name: title || id })}</p>
                    <p className="menu-confirm-hint">
                      <span className="book-danger-mark" aria-hidden="true" />
                      {t('不可恢复：这本书的磁盘目录会被直接删除，不会进回收站，也不会留下副本。')}
                    </p>
                    <p className="menu-confirm-hint">
                      {t('如果只是想腾个位置，请用「移到回收站」——那里还能找回。')}
                    </p>
                    <p className="book-confirm-label">{t('请逐字输入书名以确认：')}</p>
                    <input
                      autoFocus
                      className="book-confirm-input"
                      value={deleteInput}
                      aria-label={t('输入书名以确认彻底删除')}
                      placeholder={title || t('输入书名')}
                      maxLength={128}
                      disabled={busy || deleting}
                      onChange={function (event) { setDeleteInput(event.target.value); }}
                      onKeyDown={function (event) {
                        if (event.key === 'Enter') {
                          event.preventDefault();
                          if (deleteInputMatches(book)) submitDelete(book);
                        }
                      }}
                    />
                    {matched ? (
                      <p className="book-confirm-hint is-ok">{t('书名一致，可以确认删除。')}</p>
                    ) : (
                      <p className="book-confirm-hint is-warn">
                        {deleteInput
                          ? t('输入与书名不一致，确认按钮暂不可用。')
                          : t('逐字输入书名后，确认按钮才会变成可点。')}
                      </p>
                    )}
                    <div className="menu-confirm-actions">
                      <button
                        type="button"
                        className="menu-danger book-danger-solid"
                        disabled={busy || deleting || !matched}
                        onClick={function () { submitDelete(book); }}
                      >
                        {deleting ? <icons.LoaderCircle size={12} className="is-spinning" /> : <span className="book-danger-mark" aria-hidden="true" />}
                        <span>{t('彻底删除')}</span>
                      </button>
                      <button
                        type="button"
                        className="menu-ghost"
                        disabled={deleting}
                        onClick={cancelDeleteConfirm}
                      >
                        {t('取消')}
                      </button>
                    </div>
                  </div>
                ) : null}
              </div>
            );
          })}
        </div>

        <div className="book-trash">
          <button
            type="button"
            className="book-trash-toggle"
            aria-expanded={trashOpen ? 'true' : 'false'}
            aria-controls="moshu-book-trash-body"
            onClick={toggleTrash}
          >
            {trashOpen ? <icons.ChevronDown size={12} /> : <icons.ChevronRight size={12} />}
            <span>
              {trashItems !== null
                ? t('回收站 ({n})', { n: count(trashItems.length) })
                : t('回收站')}
            </span>
          </button>

          {trashOpen ? (
            <div className="book-trash-body" id="moshu-book-trash-body" aria-label={t('回收站')}>
              {trashError ? (
                <div className="book-trash-error" role="alert">
                  <span>{trashError}</span>
                  <button type="button" className="book-trash-link" onClick={refreshTrash}>
                    {t('重试')}
                  </button>
                </div>
              ) : null}

              {!trashItems && !trashError ? (
                <p className="book-trash-loading">
                  <icons.LoaderCircle size={12} className="is-spinning" />
                  {t('正在读取回收站…')}
                </p>
              ) : null}

              {!trashLoading && !trashError && trashItems && !trashItems.length ? (
                <p className="book-trash-empty">{t('回收站是空的。删除作品时默认进这里，可以找回。')}</p>
              ) : null}

              {trashItems && trashItems.length ? (
                <div className="book-trash-list">
                  {trashItems.map(function (item, index) {
                    const sid = item.id || 'trash-' + index;
                    const time = formatTrashTime(item.trashedAt);
                    const size = formatBytes(item.bytes);
                    const rowBusy = trashBusyId === sid;
                    const confirmingPurge = purgeConfirmId === sid;
                    return (
                      <div className={'book-trash-row' + (confirmingPurge ? ' is-confirming' : '')} key={sid}>
                        <span className="book-trash-name" title={item.name || sid}>
                          {item.name || t('未命名')}
                        </span>
                        <span className="book-trash-meta">
                          {time ? t('删除于 {time}', { time: time }) : ''}
                          {time && size ? ' · ' : ''}
                          {size}
                        </span>
                        <div className="book-trash-actions">
                          <button
                            type="button"
                            className="book-trash-link"
                            disabled={busy || Boolean(trashBusyId)}
                            aria-label={t('恢复《{name}》', { name: item.name || sid })}
                            onClick={function () { submitRestore(item); }}
                          >
                            {rowBusy && !confirmingPurge ? <icons.LoaderCircle size={11} className="is-spinning" /> : null}
                            <span>{t('恢复')}</span>
                          </button>
                          <button
                            type="button"
                            className="book-trash-link is-danger"
                            disabled={busy || Boolean(trashBusyId)}
                            aria-label={t('彻底删除回收站里的《{name}》', { name: item.name || sid })}
                            onClick={function () {
                              setNotice('');
                              setTrashError('');
                              setPurgeConfirmId(confirmingPurge ? '' : sid);
                            }}
                          >
                            <span>{t('彻底删除')}</span>
                          </button>
                        </div>

                        {confirmingPurge ? (
                          <div className="book-confirm book-trash-confirm" role="alert">
                            <p className="menu-confirm-title">
                              {t('彻底删除回收站里的《{name}》？', { name: item.name || sid })}
                            </p>
                            <p className="menu-confirm-hint">
                              <span className="book-danger-mark" aria-hidden="true" />
                              {t('不可恢复：磁盘上的作品目录会被直接删掉，恢复入口也会一起消失。')}
                            </p>
                            <div className="menu-confirm-actions">
                              <button
                                type="button"
                                className="menu-danger book-danger-solid"
                                disabled={busy || Boolean(trashBusyId)}
                                onClick={function () { submitPurge(item); }}
                              >
                                {rowBusy ? <icons.LoaderCircle size={12} className="is-spinning" /> : <span className="book-danger-mark" aria-hidden="true" />}
                                <span>{t('彻底删除')}</span>
                              </button>
                              <button
                                type="button"
                                className="menu-ghost"
                                disabled={rowBusy}
                                onClick={function () { setPurgeConfirmId(''); }}
                              >
                                {t('取消')}
                              </button>
                            </div>
                          </div>
                        ) : null}
                      </div>
                    );
                  })}
                </div>
              ) : null}
            </div>
          ) : null}
        </div>

        <div className="menu-footer">
          <div className="menu-field">
            <input
              value={draftName}
              maxLength={64}
              placeholder={t('输入新书名')}
              aria-label={t('新建作品')}
              onChange={function (event) { setDraftName(event.target.value); setError(''); }}
              onKeyDown={function (event) {
                if (event.key === 'Enter') {
                  event.preventDefault();
                  submitCreate();
                }
              }}
            />
            <button type="button" className="menu-primary" disabled={busy} onClick={submitCreate}>
              {busy ? <icons.LoaderCircle size={13} className="is-spinning" /> : <icons.Plus size={13} />}
              <span>{t('新建作品')}</span>
            </button>
          </div>
          {notice ? <p className="book-notice" role="status">{notice}</p> : null}
          {error ? <p className="menu-error" role="alert">{error}</p> : null}
        </div>
      </div>
    </React.Fragment>
  );
}

module.exports = { BookMenu: BookMenu };
