'use strict';

/**
 * 故事时间线 —— 横向泳道视图。
 *
 * 纵向列表只能回答"先发生什么"，回答不了"这几条线怎么缠在一起"。
 * 所以改成：**横轴是顺序，纵轴是剧情线**（主线/支线/人物线…），
 * 每个事件是泳道上的一个节点，事件之间的 links 画成曲线——明线实线、暗线虚线。
 *
 * 数据契约（timeline.json 里的事件）：
 *   { id, title, date, era, description, characters[], chapterId, chapterTitle,
 *     location, type, lane, laneName, thread, links: [{ target, kind }] }
 *   lane     —— 泳道 id（缺省 'main'）
 *   laneName —— 泳道显示名（缺省"主线"）
 *   thread   —— 'bright' 明线 / 'dark' 暗线（缺省 bright）
 *   links    —— 指向别的事件 id；kind: cause 因果 / impact 影响 / foreshadow 伏笔
 */

const React = require('react');
const { useMemo, useRef, useState } = React;
const { Activity, BookOpen, ChevronRight, Map: MapIcon, Network, Search, X } = require('../icons');
const css = require('./Timeline.css');

const TYPE_LABELS = {
  turning: '命运转折',
  journey: '旅途',
  revelation: '真相揭示',
  conflict: '冲突',
  decision: '抉择',
  dialogue: '对话',
  other: '故事事件',
};

const THREAD_LABELS = { bright: '明线', dark: '暗线' };
const LINK_LABELS = { cause: '因果', impact: '影响', foreshadow: '伏笔' };

/* 布局常量：横轴步长、泳道行高、左侧标签栏宽度 */
const COL_W = 168;
const ROW_H = 76;
const PAD_X = 28;
const LABEL_W = 132;

function eventsOf(props) {
  return Array.isArray(props && props.events) ? props.events : [];
}

/** 泳道：按出现顺序把事件分组；任意一条是暗线，整条泳道按暗线渲染。 */
function buildLanes(events) {
  const map = new Map();
  events.forEach((event, index) => {
    const id = String(event.lane || 'main');
    if (!map.has(id)) {
      map.set(id, {
        id,
        name: String(event.laneName || (id === 'main' ? '主线' : id)),
        thread: event.thread === 'dark' ? 'dark' : 'bright',
        events: [],
      });
    }
    const lane = map.get(id);
    if (event.thread === 'dark') lane.thread = 'dark';
    lane.events.push({ event, order: index });
  });
  return [...map.values()];
}

function Timeline(props) {
  const className = props && props.className ? props.className : '';
  const events = eventsOf(props);
  const onSelectEvent = props && props.onSelectEvent;
  const onOpenChapter = props && props.onOpenChapter;

  const [query, setQuery] = useState('');
  const [showDark, setShowDark] = useState(true);
  const [selected, setSelected] = useState(null);
  const [panning, setPanning] = useState(false);
  const boardRef = useRef(null);
  const dragRef = useRef(null);

  /* 按住空白处拖动 = 平移画布（和地图一样的手感）。
     拖节点是"点选"，所以只认空白区域起手的拖动；松手时若没移动就当作点击。 */
  function beginPan(event) {
    if (event.button !== 0) return;
    const node = boardRef.current;
    if (!node) return;
    dragRef.current = { x: event.clientX, y: event.clientY, left: node.scrollLeft, top: node.scrollTop, moved: false };
    setPanning(true);
    if (typeof node.setPointerCapture === 'function') {
      try { node.setPointerCapture(event.pointerId); } catch { /* 忽略 */ }
    }
  }

  function movePan(event) {
    const drag = dragRef.current;
    const node = boardRef.current;
    if (!drag || !node) return;
    const dx = event.clientX - drag.x;
    const dy = event.clientY - drag.y;
    if (Math.abs(dx) + Math.abs(dy) > 3) drag.moved = true;
    node.scrollLeft = drag.left - dx;
    node.scrollTop = drag.top - dy;
  }

  function endPan() {
    dragRef.current = null;
    setPanning(false);
  }

  const visible = useMemo(() => {
    const key = query.trim().toLowerCase();
    return events.filter((event) => {
      if (!showDark && event.thread === 'dark') return false;
      if (!key) return true;
      const haystack = [event.title, event.description, event.location, event.era, event.date]
        .concat(event.characters || [])
        .join(' ')
        .toLowerCase();
      return haystack.indexOf(key) >= 0;
    });
  }, [events, query, showDark]);

  const lanes = useMemo(() => buildLanes(visible), [visible]);

  /* 每个事件的位置：x 由全局顺序决定（同一条竖线 ≈ 同一段时间）。 */
  const positions = useMemo(() => {
    const pos = new Map();
    const order = new Map();
    visible.forEach((event, index) => order.set(event.id, index));
    lanes.forEach((lane, laneIndex) => {
      lane.events.forEach(({ event }) => {
        const column = order.has(event.id) ? order.get(event.id) : 0;
        pos.set(event.id, { x: PAD_X + column * COL_W, y: laneIndex * ROW_H + ROW_H / 2 });
      });
    });
    return pos;
  }, [lanes, visible]);

  const width = PAD_X * 2 + Math.max(visible.length, 1) * COL_W;
  const height = Math.max(lanes.length, 1) * ROW_H;

  const links = useMemo(() => {
    const out = [];
    visible.forEach((event) => {
      const from = positions.get(event.id);
      if (!from) return;
      (Array.isArray(event.links) ? event.links : []).forEach((link) => {
        const to = positions.get(link && link.target);
        if (!to) return;
        const kind = LINK_LABELS[link.kind] ? link.kind : 'cause';
        const midX = (from.x + to.x) / 2;
        out.push({
          key: event.id + '->' + link.target,
          d: 'M' + from.x + ' ' + from.y + ' C' + midX + ' ' + from.y + ' ' + midX + ' ' + to.y + ' ' + to.x + ' ' + to.y,
          kind,
          dark: event.thread === 'dark',
        });
      });
    });
    return out;
  }, [visible, positions]);

  const selectedEvent = selected ? visible.filter((event) => event.id === selected)[0] : null;

  function pick(id) {
    setSelected(id);
    if (onSelectEvent) onSelectEvent(id);
  }

  return (
    <section className={('tl-board ' + className).trim()}>
      <style>{css}</style>

      <header className="tl-bar">
        <div className="tl-bar-title">
          <Network size={14} />
          <strong>{visible.length}</strong>
          <span>个事件</span>
          <span className="tl-sep">·</span>
          <strong>{lanes.length}</strong>
          <span>条线</span>
        </div>
        <label className="tl-search">
          <Search size={13} />
          <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索事件、地点、人物…" />
          {query ? (
            <button type="button" onClick={() => setQuery('')} aria-label="清除搜索"><X size={12} /></button>
          ) : null}
        </label>
        <button
          type="button"
          className={'tl-toggle' + (showDark ? ' is-on' : '')}
          aria-pressed={showDark}
          onClick={() => setShowDark((value) => !value)}
          title="显示/隐藏暗线"
        >
          <Activity size={13} />
          <span>暗线</span>
        </button>
      </header>

      {events.length === 0 ? (
        <div className="tl-empty">
          <p>还没有时间线事件。</p>
          <span>可以在对话里让 AI 读正文后提取。</span>
        </div>
      ) : (
        <div
          className={'tl-scroll' + (panning ? ' is-panning' : '')}
          ref={boardRef}
          onPointerDown={beginPan}
          onPointerMove={movePan}
          onPointerUp={endPan}
          onPointerLeave={endPan}
          onPointerCancel={endPan}
        >
          <div className="tl-canvas" style={{ width: width + LABEL_W, height }}>
            {lanes.map((lane, index) => (
              <div
                key={lane.id}
                className={'tl-lane is-' + lane.thread}
                style={{ top: index * ROW_H, height: ROW_H, left: LABEL_W, width }}
              >
                <span className="tl-lane-rule" />
              </div>
            ))}
            {lanes.map((lane, index) => (
              <div
                key={'label-' + lane.id}
                className={'tl-lane-label is-' + lane.thread}
                style={{ top: index * ROW_H, height: ROW_H }}
              >
                <strong>{lane.name}</strong>
                <span>{THREAD_LABELS[lane.thread]}</span>
                <em>{lane.events.length}</em>
              </div>
            ))}

            <svg className="tl-links" width={width} height={height} style={{ left: LABEL_W }}>
              {links.map((link) => (
                <path key={link.key} className={'tl-link is-' + link.kind + (link.dark ? ' is-dark' : '')} d={link.d} />
              ))}
            </svg>

            {visible.map((event) => {
              const point = positions.get(event.id);
              if (!point) return null;
              const dark = event.thread === 'dark';
              return (
                <button
                  key={event.id}
                  type="button"
                  className={'tl-node is-' + (event.type || 'other') + (dark ? ' is-dark' : '')
                    + (selected === event.id ? ' is-selected' : '')}
                  style={{ left: LABEL_W + point.x - 74, top: point.y - 26 }}
                  onClick={() => pick(event.id)}
                  title={event.title}
                >
                  <span className="tl-node-dot" />
                  <span className="tl-node-body">
                    <strong>{event.title}</strong>
                    <em>{event.date || event.era || TYPE_LABELS[event.type || 'other']}</em>
                  </span>
                </button>
              );
            })}
          </div>
        </div>
      )}

      {selectedEvent ? (
        <aside className="tl-detail">
          <div className="tl-detail-head">
            <span className={'tl-type is-' + (selectedEvent.type || 'other')}>{TYPE_LABELS[selectedEvent.type || 'other']}</span>
            <button type="button" onClick={() => setSelected(null)} aria-label="关闭详情"><X size={13} /></button>
          </div>
          <h3>{selectedEvent.title}</h3>
          <dl>
            {selectedEvent.date ? (<div><dt>时间</dt><dd>{selectedEvent.date}</dd></div>) : null}
            {selectedEvent.era ? (<div><dt>纪元</dt><dd>{selectedEvent.era}</dd></div>) : null}
            {selectedEvent.location ? (<div><dt>地点</dt><dd><MapIcon size={12} /> {selectedEvent.location}</dd></div>) : null}
            {selectedEvent.characters && selectedEvent.characters.length ? (
              <div><dt>人物</dt><dd>{selectedEvent.characters.join('、')}</dd></div>
            ) : null}
          </dl>
          {selectedEvent.description ? <p>{selectedEvent.description}</p> : null}
          {selectedEvent.chapterTitle || selectedEvent.chapterId ? (
            <button
              type="button"
              className="tl-open"
              onClick={() => onOpenChapter && onOpenChapter(selectedEvent.chapterId || selectedEvent.chapterTitle)}
            >
              <BookOpen size={13} />
              <span>{selectedEvent.chapterTitle || selectedEvent.chapterId}</span>
              <ChevronRight size={13} />
            </button>
          ) : null}
        </aside>
      ) : null}

      <footer className="tl-legend">
        {Object.keys(LINK_LABELS).map((kind) => (
          <span key={kind} className={'tl-legend-item is-' + kind}>{LINK_LABELS[kind]}</span>
        ))}
        <span className="tl-legend-item is-dark">暗线 = 虚线</span>
      </footer>
    </section>
  );
}

module.exports = { Timeline };
