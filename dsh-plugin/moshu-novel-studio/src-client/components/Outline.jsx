'use strict';

/**
 * 故事大纲 —— 重写版（无弹层，全部就地编辑）。
 *
 * 数据在宿主 `outline.json`（GET/POST /outline）：{ volumes[], chapters[] }。
 * 左边选卷，右边是这个卷的章节；点开一章直接写目标/冲突/场景/钩子，标节拍·线索·状态。
 */

const React = require('react');
const { useEffect, useMemo, useRef, useState } = React;
const api = require('../api');
const { SharedStyle } = require('./SharedStyle');
const { BookOpen, ChevronDown, ChevronRight, FileText, Plus, Save, Trash2 } = require('../icons');
const css = require('./Outline.css');

const STATUS_LABEL = { idea: '设想', draft: '大纲中', done: '已完成' };
const BEAT_LABEL = { setup: '铺垫', turn: '转折', climax: '高潮', resolution: '收束', other: '未标记' };
const ARC_LABEL = { main: '主线', sub: '支线', hidden: '暗线' };

function wordCount(value) {
  return String(value || '').replace(/\s/g, '').length;
}

function nextId(prefix, list) {
  const used = new Set(list.map((item) => String(item.id || '')));
  let index = list.length + 1;
  while (used.has(prefix + index)) index += 1;
  return prefix + index;
}

function Outline(props) {
  const documents = Array.isArray(props && props.documents) ? props.documents : [];
  const onOpenChapter = props && typeof props.onOpenChapter === 'function' ? props.onOpenChapter : null;
  const onDocumentsChanged = props && typeof props.onDocumentsChanged === 'function' ? props.onDocumentsChanged : null;
  const notify = props && typeof props.onNotify === 'function' ? props.onNotify : function () { };

  const [outline, setOutline] = useState(null);
  const [activeVolumeId, setActiveVolumeId] = useState('');
  const [expanded, setExpanded] = useState('');
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const outlineRef = useRef(null);
  outlineRef.current = outline;

  const chapterDocs = useMemo(
    () => documents.filter((doc) => doc.type === 'chapter' || /^chapters\/.*\.md$/i.test(String(doc.path || ''))),
    [documents],
  );
  const wordsOf = useMemo(() => {
    const map = new Map();
    chapterDocs.forEach((doc, index) => {
      const number = Number(((doc.path || '').match(/chapter[-_]?(\d+)/i) || [])[1]) || index + 1;
      map.set(number, { words: wordCount(doc.content), path: doc.path, id: doc.id });
    });
    return map;
  }, [chapterDocs]);

  useEffect(function () {
    let alive = true;
    api.request('/outline').then(function (payload) {
      if (!alive || !payload) return;
      setOutline(payload.outline);
      setActiveVolumeId((current) => current || (payload.outline.volumes[0] || {}).id || '');
    }).catch(function (reason) {
      if (alive) setError(reason && reason.message ? reason.message : '大纲读取失败');
    });
    return function () { alive = false; };
  }, []);

  async function persist(next) {
    setBusy(true);
    setError('');
    try {
      const saved = await api.request('/outline', { method: 'POST', body: JSON.stringify({ outline: next }) });
      if (saved && saved.outline) {
        setOutline(saved.outline);
        setDirty(false);
        notify('大纲已保存');
      }
    } catch (reason) {
      setError(reason && reason.message ? reason.message : '保存失败');
    } finally {
      setBusy(false);
    }
  }

  function patch(next) {
    setOutline(next);
    setDirty(true);
  }

  function updateVolume(id, value) {
    const current = outlineRef.current;
    patch({ ...current, volumes: current.volumes.map((volume) => (volume.id === id ? { ...volume, ...value } : volume)) });
  }

  function updateChapter(id, value) {
    const current = outlineRef.current;
    patch({ ...current, chapters: current.chapters.map((chapter) => (chapter.id === id ? { ...chapter, ...value } : chapter)) });
  }

  function addVolume() {
    const current = outlineRef.current;
    const number = current.volumes.reduce((max, volume) => Math.max(max, Number(volume.number) || 0), 0) + 1;
    const volume = { id: nextId('v', current.volumes), number, title: `第 ${number} 卷`, goal: '', conflict: '', turn: '' };
    patch({ ...current, volumes: current.volumes.concat([volume]) });
    setActiveVolumeId(volume.id);
  }

  async function addChapter() {
    const current = outlineRef.current;
    const volumeId = activeVolumeId || (current.volumes[0] || {}).id || '';
    if (!volumeId) { addVolume(); return; }
    const number = current.chapters.reduce((max, chapter) => Math.max(max, Number(chapter.number) || 0), 0) + 1;
    const path = `chapters/chapter-${String(number).padStart(3, '0')}.md`;
    const chapter = {
      id: nextId('c', current.chapters),
      number,
      volumeId,
      title: `第 ${number} 章`,
      goal: '', conflict: '', scenes: '', hook: '',
      beat: 'other', arc: 'main', status: 'idea',
      chapterPath: path,
    };
    const next = { ...current, chapters: current.chapters.concat([chapter]) };
    setOutline(next);
    setExpanded(chapter.id);
    await persist(next);
    try {
      await api.request('/document', { method: 'POST', body: JSON.stringify({ path, content: '', title: chapter.title }) });
      if (onDocumentsChanged) await onDocumentsChanged();
    } catch (reason) {
      notify('大纲已保存，但正文文件没建成：' + (reason && reason.message ? reason.message : ''));
    }
  }

  function removeChapter(id) {
    const current = outlineRef.current;
    patch({ ...current, chapters: current.chapters.filter((chapter) => chapter.id !== id) });
  }

  function removeVolume(id) {
    const current = outlineRef.current;
    patch({
      ...current,
      volumes: current.volumes.filter((volume) => volume.id !== id),
      chapters: current.chapters.filter((chapter) => chapter.volumeId !== id),
    });
    if (activeVolumeId === id) setActiveVolumeId((current.volumes.find((volume) => volume.id !== id) || {}).id || '');
  }

  useEffect(function () {
    function onKeyDown(event) {
      if ((event.ctrlKey || event.metaKey) && String(event.key || '').toLowerCase() === 's') {
        if (!outlineRef.current) return;
        event.preventDefault();
        void persist(outlineRef.current);
      }
    }
    window.addEventListener('keydown', onKeyDown);
    return function () { window.removeEventListener('keydown', onKeyDown); };
  }, []);

  if (!outline) {
    return <div className="outline-view outline-loading"><style>{css}</style><p>{error || '正在读取大纲…'}</p></div>;
  }

  const activeVolume = outline.volumes.find((volume) => volume.id === activeVolumeId) || outline.volumes[0] || null;
  const chaptersOf = outline.chapters
    .filter((chapter) => !activeVolume || chapter.volumeId === activeVolume.id)
    .sort((a, b) => a.number - b.number);
  const missing = outline.chapters.filter((chapter) => !chapter.goal.trim()).length;
  const done = outline.chapters.filter((chapter) => chapter.status === 'done').length;
  const totalWords = chapterDocs.reduce((sum, doc) => sum + wordCount(doc.content), 0);

  return (
    <div className="outline-view">
      <SharedStyle />
      <style dangerouslySetInnerHTML={{ __html: css }} />

      <header className="outline-bar">
        <div className="outline-bar-stats">
          <span><b>{outline.volumes.length}</b>卷</span>
          <span><b>{outline.chapters.length}</b>章</span>
          <span><b>{done}</b>已完成</span>
          <span className={missing ? 'is-warn' : ''}><b>{missing}</b>缺章纲</span>
          <span><b>{totalWords.toLocaleString()}</b>字</span>
        </div>
        <div className="outline-bar-actions">
          {error ? <span className="outline-error" role="alert">{error}</span> : null}
          {dirty ? <span className="outline-dirty">未保存</span> : null}
          <button type="button" className="outline-btn" onClick={addVolume} disabled={busy}><Plus size={14} />新建卷</button>
          <button type="button" className="outline-btn" onClick={() => void addChapter()} disabled={busy || !outline.volumes.length}><Plus size={14} />新建章</button>
          <button type="button" className="outline-btn is-primary" onClick={() => void persist(outline)} disabled={busy || !dirty}>
            <Save size={14} />{busy ? '保存中…' : '保存'}
          </button>
        </div>
      </header>

      <div className="outline-body">
        <aside className="outline-volumes">
          {outline.volumes.length ? outline.volumes.map((volume) => {
            const count = outline.chapters.filter((chapter) => chapter.volumeId === volume.id).length;
            return (
              <button
                key={volume.id}
                type="button"
                className={'outline-volume' + (activeVolume && activeVolume.id === volume.id ? ' is-active' : '')}
                onClick={() => setActiveVolumeId(volume.id)}
              >
                <strong>{volume.title || `第 ${volume.number} 卷`}</strong>
                <small>{count} 章</small>
                <span
                  role="button"
                  tabIndex={0}
                  className="outline-volume-del"
                  title="删除这一卷（连带卷内章纲）"
                  onClick={(event) => { event.stopPropagation(); removeVolume(volume.id); }}
                  onKeyDown={(event) => { if (event.key === 'Enter') { event.stopPropagation(); removeVolume(volume.id); } }}
                ><Trash2 size={12} /></span>
              </button>
            );
          }) : <p className="outline-empty-hint">还没有卷。点「新建卷」开始。</p>}
        </aside>

        <main className="outline-main">
          {activeVolume ? (
            <section className="outline-volume-edit">
              <input
                className="outline-title-input"
                value={activeVolume.title}
                placeholder="卷名"
                onChange={(event) => updateVolume(activeVolume.id, { title: event.target.value })}
              />
              <div className="outline-field-row">
                <label>本卷目标<textarea rows={2} value={activeVolume.goal} onChange={(event) => updateVolume(activeVolume.id, { goal: event.target.value })} /></label>
                <label>核心冲突<textarea rows={2} value={activeVolume.conflict} onChange={(event) => updateVolume(activeVolume.id, { conflict: event.target.value })} /></label>
                <label>转折与结果<textarea rows={2} value={activeVolume.turn} onChange={(event) => updateVolume(activeVolume.id, { turn: event.target.value })} /></label>
              </div>
            </section>
          ) : null}

          {chaptersOf.length ? chaptersOf.map((chapter) => {
            const word = wordsOf.get(Number(chapter.number));
            const open = expanded === chapter.id;
            return (
              <article className={'outline-chapter' + (open ? ' is-open' : '') + (chapter.goal.trim() ? '' : ' is-missing')} key={chapter.id}>
                <header className="outline-chapter-head" onClick={() => setExpanded(open ? '' : chapter.id)}>
                  <span className="outline-chapter-no">{String(chapter.number).padStart(2, '0')}</span>
                  <input
                    className="outline-chapter-title"
                    value={chapter.title}
                    placeholder="章节标题"
                    onClick={(event) => event.stopPropagation()}
                    onChange={(event) => updateChapter(chapter.id, { title: event.target.value })}
                  />
                  <span className={'outline-tag is-' + chapter.status}>{STATUS_LABEL[chapter.status]}</span>
                  <span className="outline-tag is-quiet">{BEAT_LABEL[chapter.beat]}</span>
                  <span className="outline-tag is-quiet">{ARC_LABEL[chapter.arc]}</span>
                  <span className="outline-words">{word ? word.words.toLocaleString() + ' 字' : '未建正文'}</span>
                  {chapter.goal.trim() ? null : <span className="outline-tag is-warn">缺章纲</span>}
                  {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                </header>

                {open ? (
                  <div className="outline-chapter-body">
                    <div className="outline-field-row">
                      <label>本章目标<textarea rows={3} value={chapter.goal} placeholder="这一章要推进什么" onChange={(event) => updateChapter(chapter.id, { goal: event.target.value })} /></label>
                      <label>核心冲突<textarea rows={3} value={chapter.conflict} placeholder="谁要什么，被什么挡住" onChange={(event) => updateChapter(chapter.id, { conflict: event.target.value })} /></label>
                    </div>
                    <div className="outline-field-row">
                      <label>场景与信息增量<textarea rows={3} value={chapter.scenes} placeholder="在哪、谁在场、读者新知道什么" onChange={(event) => updateChapter(chapter.id, { scenes: event.target.value })} /></label>
                      <label>结尾钩子<textarea rows={3} value={chapter.hook} placeholder="这一章停在什么地方" onChange={(event) => updateChapter(chapter.id, { hook: event.target.value })} /></label>
                    </div>
                    <div className="outline-chapter-foot">
                      <label>节拍
                        <select value={chapter.beat} onChange={(event) => updateChapter(chapter.id, { beat: event.target.value })}>
                          {Object.keys(BEAT_LABEL).map((key) => <option key={key} value={key}>{BEAT_LABEL[key]}</option>)}
                        </select>
                      </label>
                      <label>线索
                        <select value={chapter.arc} onChange={(event) => updateChapter(chapter.id, { arc: event.target.value })}>
                          {Object.keys(ARC_LABEL).map((key) => <option key={key} value={key}>{ARC_LABEL[key]}</option>)}
                        </select>
                      </label>
                      <label>状态
                        <select value={chapter.status} onChange={(event) => updateChapter(chapter.id, { status: event.target.value })}>
                          {Object.keys(STATUS_LABEL).map((key) => <option key={key} value={key}>{STATUS_LABEL[key]}</option>)}
                        </select>
                      </label>
                      <div className="outline-chapter-tools">
                        {word && onOpenChapter ? (
                          <button type="button" className="outline-btn" onClick={() => onOpenChapter(word.path || word.id)}><FileText size={13} />打开正文</button>
                        ) : null}
                        <button type="button" className="outline-btn is-danger" onClick={() => removeChapter(chapter.id)}><Trash2 size={13} />删除章纲</button>
                      </div>
                    </div>
                  </div>
                ) : null}
              </article>
            );
          }) : (
            <div className="outline-empty">
              <BookOpen size={22} />
              <p>这一卷还没有章节</p>
              <button type="button" className="outline-btn is-primary" onClick={() => void addChapter()} disabled={busy}><Plus size={14} />新建第一章</button>
            </div>
          )}
        </main>
      </div>
    </div>
  );
}

module.exports = { Outline };
