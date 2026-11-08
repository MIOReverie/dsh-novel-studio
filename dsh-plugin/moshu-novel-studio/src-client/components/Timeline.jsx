'use strict';

/**
 * 故事时间线 —— 左侧泳道栏 + 右侧横向事件画布 + 详情编辑，作者可自己改。
 *
 * 数据（timeline.json，GET/POST /timeline）：
 *   { id, title, date, era, description, characters[], chapterId, chapterTitle,
 *     location, type, lane, laneName, thread, links: [{ target, kind }] }
 *
 * 上一版的布局问题：泳道名用绝对定位压在同一层里，第一张事件卡正好盖在泳道栏上。
 * 这一版把泳道栏做成**独立的左侧列**（不在画布内、不与卡片重叠），
 * 画布只放事件卡与连线。
 *
 * 作者可做的事：新建/删除事件、改标题/时间/描述/人物/地点、改剧情线与明暗线、
 * 手动连线（因果 / 影响 / 伏笔）、删连线，改完保存（Ctrl+S）。
 */

const React = require('react');
const { useEffect, useMemo, useRef, useState } = React;
const api = require('../api');
const { SharedStyle } = require('./SharedStyle');
const { Activity, ChevronRight, Plus, Save, X } = require('../icons');
const css = require('./Timeline.css');

const THREAD_LABEL = { bright: '明线', dark: '暗线' };
const LINK_LABEL = { cause: '因果', impact: '影响', foreshadow: '伏笔' };
const TYPE_LABEL = {
  turning: '转折', journey: '旅途', revelation: '揭示', conflict: '冲突',
  decision: '抉择', dialogue: '对话', other: '事件',
};

/* 画布布局常量 */
const COL_W = 190;
const ROW_H = 88;
const PAD_X = 24;
const NODE_W = 168;
const GAP = 12;

function sortEvents(events) {
  return events.slice().sort((a, b) => {
    const an = Number(a.order);
    const bn = Number(b.order);
    if (Number.isFinite(an) && Number.isFinite(bn) && an !== bn) return an - bn;
    return String(a.id).localeCompare(String(b.id));
  });
}

/** 按出现顺序分泳道；laneName 取事件里的显示名。 */
function buildLanes(events) {
  const map = new Map();
  events.forEach((event) => {
    const id = String(event.lane || 'main');
    if (!map.has(id)) {
      map.set(id, { id, name: String(event.laneName || (id === 'main' ? '主线' : id)), thread: event.thread === 'dark' ? 'dark' : 'bright', events: [] });
    }
    const lane = map.get(id);
    if (event.thread === 'dark') lane.thread = 'dark';
    lane.events.push(event);
  });
  return [...map.values()];
}

function Timeline(props) {
  const incoming = Array.isArray(props && props.events) ? props.events : [];
  const onOpenChapter = props && typeof props.onOpenChapter === 'function' ? props.onOpenChapter : null;
  const notify = props && typeof props.onNotify === 'function' ? props.onNotify : function () { };

  const [events, setEvents] = useState(incoming);
  const [selectedId, setSelectedId] = useState('');
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [linkDraft, setLinkDraft] = useState({ target: '', kind: 'cause' });
  const eventsRef = useRef(events);
  eventsRef.current = events;
  const loadedOnce = useRef(false);

  /* 初次从接口取（作者 edits 落在 timeline.json，bootstrap 也给一份，优先接口） */
  useEffect(function () {
    let alive = true;
    api.request('/timeline').then(function (payload) {
      if (!alive || !payload || !Array.isArray(payload.events)) return;
      loadedOnce.current = true;
      setEvents(payload.events);
    }).catch(function () { /* 接口不可用时用 props 里的数据 */ });
    return function () { alive = false; };
  }, []);

  /* props 变化（AI 刚写过）且本地没改动时同步 */
  useEffect(function () {
    if (dirty || !loadedOnce.current) return;
    setEvents(incoming);
  }, [incoming, dirty]);

  const ordered = useMemo(() => sortEvents(events), [events]);
  const lanes = useMemo(() => buildLanes(ordered), [ordered]);

  const positions = useMemo(() => {
    const pos = new Map();
    ordered.forEach((event, index) => {
      const laneIndex = lanes.findIndex((lane) => lane.id === String(event.lane || 'main'));
      pos.set(event.id, { x: PAD_X + index * COL_W, y: (laneIndex < 0 ? 0 : laneIndex) * ROW_H + ROW_H / 2 });
    });
    return pos;
  }, [ordered, lanes]);

  const width = PAD_X * 2 + Math.max(ordered.length, 1) * COL_W;
  const height = Math.max(lanes.length, 1) * ROW_H;

  const links = useMemo(() => {
    const out = [];
    ordered.forEach((event) => {
      const from = positions.get(event.id);
      if (!from) return;
      (Array.isArray(event.links) ? event.links : []).forEach((link, index) => {
        const to = positions.get(link && link.target);
        if (!to) return;
        const kind = LINK_LABEL[link.kind] ? link.kind : 'cause';
        const midX = (from.x + to.x) / 2;
        out.push({
          key: event.id + '->' + link.target + '-' + index,
          d: 'M' + from.x + ' ' + from.y + ' C' + midX + ' ' + from.y + ' ' + midX + ' ' + to.y + ' ' + to.x + ' ' + to.y,
          kind,
          dark: event.thread === 'dark',
        });
      });
    });
    return out;
  }, [ordered, positions]);

  const selected = ordered.find((event) => event.id === selectedId) || null;

  function patch(next) {
    setEvents(next);
    setDirty(true);
  }

  function updateSelected(value) {
    patch(eventsRef.current.map((event) => (event.id === selectedId ? { ...event, ...value } : event)));
  }

  async function persist() {
    setBusy(true);
    setError('');
    try {
      const saved = await api.request('/timeline', { method: 'POST', body: JSON.stringify({ events: eventsRef.current }) });
      if (saved && Array.isArray(saved.events)) {
        setEvents(saved.events);
        setDirty(false);
        notify('时间线已保存');
      }
    } catch (reason) {
      setError(reason && reason.message ? reason.message : '保存失败');
    } finally {
      setBusy(false);
    }
  }

  function addEvent() {
    const current = eventsRef.current;
    const id = 'evt-' + Date.now().toString(36);
    const lane = selected ? String(selected.lane || 'main') : (lanes[0] ? lanes[0].id : 'main');
    const laneName = selected ? String(selected.laneName || '') : (lanes[0] ? lanes[0].name : '主线');
    const next = current.concat([{
      id,
      title: '新事件',
      date: '', era: '', description: '', characters: [],
      chapterId: '', chapterTitle: '', location: '',
      type: 'other', lane, laneName,
      thread: selected && selected.thread === 'dark' ? 'dark' : 'bright',
      links: [],
      order: current.length,
    }]);
    patch(next);
    setSelectedId(id);
  }

  function removeEvent(id) {
    const next = eventsRef.current
      .filter((event) => event.id !== id)
      .map((event) => ({ ...event, links: (event.links || []).filter((link) => link.target !== id) }));
    patch(next);
    if (selectedId === id) setSelectedId('');
  }

  function addLink() {
    if (!selected || !linkDraft.target) return;
    if (linkDraft.target === selected.id) return;
    const exists = (selected.links || []).some((link) => link.target === linkDraft.target && link.kind === linkDraft.kind);
    if (exists) return;
    const links2 = (selected.links || []).concat([{ target: linkDraft.target, kind: linkDraft.kind }]);
    updateSelected({ links: links2 });
    setLinkDraft({ target: '', kind: linkDraft.kind });
  }

  function removeLink(target, kind) {
    if (!selected) return;
    updateSelected({ links: (selected.links || []).filter((link) => !(link.target === target && link.kind === kind)) });
  }

  /* 切换一条泳道的明/暗：改这一组所有事件，保持一致 */
  function toggleLaneThread(laneId) {
    const lane = lanes.find((item) => item.id === laneId);
    if (!lane) return;
    const nextThread = lane.thread === 'dark' ? 'bright' : 'dark';
    patch(eventsRef.current.map((event) => (String(event.lane || 'main') === laneId ? { ...event, thread: nextThread } : event)));
  }

  useEffect(function () {
    function onKeyDown(event) {
      if ((event.ctrlKey || event.metaKey) && String(event.key || '').toLowerCase() === 's') {
        event.preventDefault();
        void persist();
      }
    }
    window.addEventListener('keydown', onKeyDown);
    return function () { window.removeEventListener('keydown', onKeyDown); };
  }, []);

  return (
    <section className="tl-board">
      <SharedStyle />
      <style dangerouslySetInnerHTML={{ __html: css }} />

      <header className="tl-bar">
        <div className="tl-bar-title">
          <Activity size={14} />
          <span><b>{ordered.length}</b> 个事件</span>
          <span className="tl-sep">·</span>
          <span><b>{lanes.length}</b> 条线</span>
        </div>
        <div className="tl-bar-actions">
          {error ? <span className="tl-error" role="alert">{error}</span> : null}
          {dirty ? <span className="tl-dirty">未保存</span> : null}
          <button type="button" className="tl-btn" onClick={addEvent} disabled={busy}><Plus size={14} />新建事件</button>
          <button type="button" className="tl-btn is-primary" onClick={() => void persist()} disabled={busy || !dirty}>
            <Save size={14} />{busy ? '保存中…' : '保存'}
          </button>
        </div>
      </header>

      <div className="tl-body">
        {/* 左栏：只放泳道（明线/暗线），不叠任何事件卡 */}
        <aside className="tl-lanes" aria-label="剧情线">
          <p className="tl-lanes-title">剧情线</p>
          {lanes.length ? lanes.map((lane) => (
            <button
              key={lane.id}
              type="button"
              className={'tl-lane-item is-' + lane.thread}
              onClick={() => toggleLaneThread(lane.id)}
              title={lane.thread === 'dark' ? '当前是暗线，点击改为明线' : '当前是明线，点击改为暗线'}
            >
              <span className={'tl-thread-dot is-' + lane.thread} />
              <span className="tl-lane-name">{lane.name}</span>
              <span className={'tl-thread-tag is-' + lane.thread}>{THREAD_LABEL[lane.thread]}</span>
              <span className="tl-lane-count">{lane.events.length}</span>
            </button>
          )) : <p className="tl-lanes-empty">还没有事件</p>}
        </aside>

        {/* 画布：只有事件卡与连线 */}
        <div className="tl-scroll">
          {ordered.length ? (
            <div className="tl-canvas" style={{ width, height }}>
              {lanes.map((lane, index) => (
                <div
                  key={lane.id}
                  className={'tl-row is-' + lane.thread}
                  style={{ top: index * ROW_H, height: ROW_H, width }}
                />
              ))}
              <svg className="tl-links" width={width} height={height}>
                {links.map((link) => (
                  <path key={link.key} className={'tl-link is-' + link.kind + (link.dark ? ' is-dark' : '')} d={link.d} />
                ))}
              </svg>
              {ordered.map((event) => {
                const point = positions.get(event.id);
                if (!point) return null;
                const dark = event.thread === 'dark';
                return (
                  <button
                    key={event.id}
                    type="button"
                    className={'tl-node is-' + (event.type || 'other') + (dark ? ' is-dark' : '') + (selectedId === event.id ? ' is-selected' : '')}
                    style={{ left: point.x - NODE_W / 2, top: point.y - 30, width: NODE_W }}
                    onClick={() => setSelectedId(event.id)}
                    title={event.title}
                  >
                    <span className="tl-node-body">
                      <strong>{event.title}</strong>
                      <em>{event.date || event.era || TYPE_LABEL[event.type || 'other']}</em>
                    </span>
                    {(event.links || []).length ? <span className="tl-node-links">{(event.links || []).length}</span> : null}
                  </button>
                );
              })}
            </div>
          ) : (
            <div className="tl-empty">
              <p>还没有时间线事件</p>
              <span>可以让 AI 从正文里提取，也可以点右上角「新建事件」自己写。</span>
            </div>
          )}
        </div>

        {/* 右侧：选中事件的编辑面板 */}
        {selected ? (
          <aside className="tl-detail">
            <header className="tl-detail-head">
              <span className="tl-detail-title">编辑事件</span>
              <button type="button" onClick={() => setSelectedId('')} aria-label="关闭"><X size={14} /></button>
            </header>

            <label className="tl-field">标题
              <input value={selected.title} onChange={(event) => updateSelected({ title: event.target.value })} />
            </label>

            <div className="tl-field-row">
              <label className="tl-field">时间
                <input value={selected.date || ''} onChange={(event) => updateSelected({ date: event.target.value })} placeholder="第三年春" />
              </label>
              <label className="tl-field">纪元/卷
                <input value={selected.era || ''} onChange={(event) => updateSelected({ era: event.target.value })} placeholder="第一卷 · 雾起" />
              </label>
            </div>

            <label className="tl-field">描述
              <textarea rows={3} value={selected.description || ''} onChange={(event) => updateSelected({ description: event.target.value })} />
            </label>

            <label className="tl-field">在场人物（逗号分隔）
              <input
                value={(selected.characters || []).join('、')}
                onChange={(event) => updateSelected({ characters: event.target.value.split(/[、,，\s]+/).filter(Boolean) })}
              />
            </label>

            <div className="tl-field-row">
              <label className="tl-field">地点
                <input value={selected.location || ''} onChange={(event) => updateSelected({ location: event.target.value })} />
              </label>
              <label className="tl-field">剧情线
                <input
                  value={selected.laneName || (selected.lane === 'main' ? '主线' : selected.lane || '')}
                  onChange={(event) => updateSelected({ laneName: event.target.value })}
                  placeholder="主线 / 朝堂线"
                />
              </label>
            </div>

            <div className="tl-field-row">
              <label className="tl-field">线别
                <select value={selected.thread === 'dark' ? 'dark' : 'bright'} onChange={(event) => updateSelected({ thread: event.target.value })}>
                  <option value="bright">明线</option>
                  <option value="dark">暗线</option>
                </select>
              </label>
              <label className="tl-field">类型
                <select value={selected.type || 'other'} onChange={(event) => updateSelected({ type: event.target.value })}>
                  {Object.keys(TYPE_LABEL).map((key) => <option key={key} value={key}>{TYPE_LABEL[key]}</option>)}
                </select>
              </label>
            </div>

            <div className="tl-links-edit">
              <p className="tl-links-title">剧情关系</p>
              {(selected.links || []).length ? (selected.links || []).map((link, index) => {
                const target = ordered.find((event) => event.id === link.target);
                return (
                  <div className="tl-link-row" key={link.target + index}>
                    <span className={'tl-link-kind is-' + link.kind}>{LINK_LABEL[link.kind] || '因果'}</span>
                    <ChevronRight size={12} />
                    <span className="tl-link-target">{target ? target.title : '（事件已删除）'}</span>
                    <button type="button" onClick={() => removeLink(link.target, link.kind)} aria-label="删除这条关系"><X size={12} /></button>
                  </div>
                );
              }) : <p className="tl-links-empty">还没有连线。连上它导致 / 影响 / 铺垫的那条事件。</p>}

              <div className="tl-link-add">
                <select value={linkDraft.kind} onChange={(event) => setLinkDraft({ ...linkDraft, kind: event.target.value })}>
                  {Object.keys(LINK_LABEL).map((key) => <option key={key} value={key}>{LINK_LABEL[key]}</option>)}
                </select>
                <select value={linkDraft.target} onChange={(event) => setLinkDraft({ ...linkDraft, target: event.target.value })}>
                  <option value="">选择事件…</option>
                  {ordered.filter((event) => event.id !== selected.id).map((event) => (
                    <option key={event.id} value={event.id}>{event.title}</option>
                  ))}
                </select>
                <button type="button" className="tl-btn" onClick={addLink} disabled={!linkDraft.target}><Plus size={13} />连线</button>
              </div>
            </div>

            <div className="tl-detail-foot">
              {selected.chapterTitle || selected.chapterId ? (
                <button type="button" className="tl-btn" onClick={() => onOpenChapter && onOpenChapter(selected.chapterId || selected.chapterTitle)}>打开章节</button>
              ) : null}
              <button type="button" className="tl-btn is-danger" onClick={() => removeEvent(selected.id)}>删除事件</button>
            </div>
          </aside>
        ) : null}
      </div>
    </section>
  );
}

module.exports = { Timeline };
