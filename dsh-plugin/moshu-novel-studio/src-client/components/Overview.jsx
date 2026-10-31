'use strict';

/**
 * 总览：这本书现在什么状态。
 *
 * 原来的「创作模式」页只是一段说明 + 一个按钮（还依赖宿主不一定有的 startSession），
 * 打开它得不到任何信息。这里换成真正由数据驱动的总览：进度、章节表、最近改动。
 */

const React = require('react');
const icons = require('../icons');
const css = require('./Overview.css');

const h = React.createElement;

function metadata(content, key) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(String(content || ''));
  if (!match) return '';
  const line = new RegExp('^' + key + ':\\s*(.+)$', 'm').exec(match[1]);
  return line ? line[1].trim() : '';
}

/** 非空白字符数（和编辑器状态栏同一口径）。 */
function charsOf(content) {
  return String(content || '').replace(/\s/g, '').length;
}

function Overview(props) {
  const documents = Array.isArray(props.documents) ? props.documents : [];
  const project = props.project || {};
  const onOpenChapter = typeof props.onOpenChapter === 'function' ? props.onOpenChapter : function () {};

  const chapters = documents
    .filter(function (doc) { return doc && (doc.type === 'chapter' || /^chapters\/.*\.md$/i.test(String(doc.path || ''))); })
    .slice()
    .sort(function (a, b) { return String(a.path).localeCompare(String(b.path)); });

  const referenceDocs = documents.filter(function (doc) { return chapters.indexOf(doc) === -1; });

  const total = chapters.reduce(function (sum, doc) { return sum + charsOf(doc.content); }, 0);
  const done = chapters.filter(function (doc) { return metadata(doc.content, 'status') === '已完成'; }).length;
  const writing = chapters.filter(function (doc) { return metadata(doc.content, 'status') === '草稿'; }).length;
  const empty = chapters.filter(function (doc) { return charsOf(String(doc.content || '').replace(/^#[^\n]*\n?/, '')) < 200; }).length;
  const progress = chapters.length ? Math.round((done / chapters.length) * 100) : 0;

  const recent = documents
    .filter(function (doc) { return doc && doc.updatedAt; })
    .slice()
    .sort(function (a, b) { return String(b.updatedAt).localeCompare(String(a.updatedAt)); })
    .slice(0, 6);

  function titleOf(doc) {
    const heading = /^#\s+(.+)$/m.exec(String(doc.content || ''));
    return heading ? heading[1].trim() : String(doc.title || doc.path || '');
  }

  function openChapter(doc) {
    /* 优先让外壳的 Editor 打开它（会带着草稿/冲突状态），否则退回文档 id。 */
    onOpenChapter(doc.id);
  }

  return h(
    'div',
    { className: 'moshu-root overview-page' },
    h('style', { dangerouslySetInnerHTML: { __html: css } }),

    h(
      'section',
      { className: 'ov-stats' },
      h('div', { className: 'ov-stat' }, h('span', null, '章节'), h('strong', null, chapters.length)),
      h('div', { className: 'ov-stat' }, h('span', null, '字数'), h('strong', null, total.toLocaleString())),
      h('div', { className: 'ov-stat' }, h('span', null, '已完成'), h('strong', null, done)),
      h('div', { className: 'ov-stat' }, h('span', null, '未成稿'), h('strong', null, empty)),
      h('div', { className: 'ov-stat' }, h('span', null, '资料'), h('strong', null, referenceDocs.length)),
    ),

    h(
      'section',
      { className: 'ov-progress' },
      h('div', { className: 'ov-progress-head' },
        h('span', null, '成稿进度'),
        h('b', null, progress + '%'),
      ),
      h('div', { className: 'ov-progress-track', role: 'progressbar', 'aria-valuenow': progress, 'aria-valuemin': 0, 'aria-valuemax': 100 },
        h('i', { style: { width: progress + '%' } }),
      ),
      h('p', null, done + ' 章已完成 · ' + writing + ' 章草稿 · ' + (chapters.length - done - writing) + ' 章未开始'),
    ),

    h(
      'section',
      { className: 'ov-block' },
      h('div', { className: 'ov-block-head' }, h(icons.BookOpen, { size: 15 }), h('h2', null, '章节')),
      chapters.length
        ? h('ul', { className: 'ov-chapters' }, chapters.map(function (doc, index) {
          const status = metadata(doc.content, 'status') || '未开始';
          return h('li', { key: doc.id || doc.path },
            h('button', { type: 'button', className: 'ov-chapter', onClick: function () { openChapter(doc); } },
              h('span', { className: 'ov-chapter-no' }, String(index + 1).padStart(2, '0')),
              h('span', { className: 'ov-chapter-title' }, titleOf(doc)),
              h('span', { className: 'ov-chapter-words' }, charsOf(doc.content).toLocaleString() + ' 字'),
              h('span', { className: 'ov-chapter-status is-' + status }, status),
            ),
          );
        }))
        : h('p', { className: 'ov-empty' }, '还没有章节'),
    ),

    h(
      'section',
      { className: 'ov-block' },
      h('div', { className: 'ov-block-head' }, h(icons.Activity, { size: 15 }), h('h2', null, '最近改动')),
      recent.length
        ? h('ul', { className: 'ov-recent' }, recent.map(function (doc) {
          return h('li', { key: doc.id || doc.path },
            h('button', { type: 'button', onClick: function () { openChapter(doc); } },
              h('span', { className: 'ov-recent-title' }, titleOf(doc)),
              h('span', { className: 'ov-recent-path' }, String(doc.path || '')),
            ),
          );
        }))
        : h('p', { className: 'ov-empty' }, '还没有文档'),
    ),
  );
}

module.exports = { Overview: Overview };
