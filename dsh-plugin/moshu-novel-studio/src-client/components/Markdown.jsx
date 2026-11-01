'use strict';

/**
 * 墨枢 · Markdown 渲染（阅读模式用）。
 *
 * 以前资料页和编辑器预览各自写了一个「一行一段」的小渲染器：
 * 只认 # 标题、- 列表、> 引用、--- 分隔线，其余一律当普通段落。
 * 结果是表格、代码块、有序列表、嵌套列表、链接全都不成形；更要命的是
 * **每个换行都被当成一个段落**，一段话在源码里折行就会渲染成好几段——
 * 段首缩进、段间留白、列表标记全会错位。
 *
 * 这里按 Markdown 的块规则真正分组：连续的普通行合成**一个**段落，
 * 列表项成组、引用成组、表格成表、围栏代码块整体保留。
 */

const React = require('react');
const { Fragment } = React;

/* ------------------------------------------------------------------ 行内 */

const INLINE_PATTERN = /(!\[[^\]]*\]\([^)]*\)|\[[^\]]+\]\([^)]+\)|\[\[[^\]]+\]\]|\*\*[^*]+\*\*|__[^_]+__|`[^`]+`|\*[^*\n]+\*|~~[^~]+~~)/g;

function renderText(text, key) {
  return text ? <Fragment key={key}>{text}</Fragment> : null;
}

/**
 * 行内标记：粗体、斜体、删除线、行内代码、链接、图片、wiki 链接。
 * 逐段 split，保证顺序不丢、也不嵌套解析（够阅读用，且不会把 HTML 注进页面）。
 */
function renderInline(value) {
  const parts = String(value === undefined || value === null ? '' : value).split(INLINE_PATTERN).filter((part) => part !== '');
  return parts.map((part, index) => {
    const image = /^!\[([^\]]*)\]\(([^)]*)\)$/.exec(part);
    if (image) {
      return <img key={index} src={image[2]} alt={image[1]} loading="lazy" />;
    }
    const link = /^\[([^\]]+)\]\(([^)]+)\)$/.exec(part);
    if (link) {
      return <a key={index} href={link[2]} target="_blank" rel="noreferrer noopener">{link[1]}</a>;
    }
    const wiki = /^\[\[([^\]|]+)(?:\|([^\]]+))?\]\]$/.exec(part);
    if (wiki) {
      return <span key={index} className="wiki-link">{wiki[2] || wiki[1]}<small>↗ {wiki[1]}</small></span>;
    }
    if (/^\*\*[^*]+\*\*$/.test(part) || /^__[^_]+__$/.test(part)) {
      return <strong key={index}>{part.slice(2, -2)}</strong>;
    }
    if (/^~~[^~]+~~$/.test(part)) return <del key={index}>{part.slice(2, -2)}</del>;
    if (/^`[^`]+`$/.test(part)) return <code key={index}>{part.slice(1, -1)}</code>;
    if (/^\*[^*\n]+\*$/.test(part)) return <em key={index}>{part.slice(1, -1)}</em>;
    return renderText(part, index);
  });
}

/* ------------------------------------------------------------------ 块 */

const RE = {
  fence: /^\s*(```+|~~~+)\s*([^`~]*)$/,
  heading: /^(#{1,6})\s+(.*)$/,
  hr: /^\s*([-*_])(\s*\1){2,}\s*$/,
  quote: /^\s*>\s?(.*)$/,
  ul: /^(\s*)[-*+]\s+(.*)$/,
  ol: /^(\s*)(\d+)[.)]\s+(.*)$/,
  table: /^\s*\|(.+)\|\s*$/,
  tableRule: /^\s*\|?[\s:|-]+\|[\s:|-]*$/,
  frontMatter: /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/,
};

function stripFrontMatter(content) {
  return String(content || '').replace(RE.frontMatter, '');
}

/** 把连续的列表行收成一组（支持缩进嵌套与任务列表）。 */
function takeList(lines, start) {
  const first = RE.ul.exec(lines[start]) || RE.ol.exec(lines[start]);
  const ordered = !RE.ul.test(lines[start]);
  const baseIndent = first[1].length;
  const items = [];
  let index = start;

  while (index < lines.length) {
    const line = lines[index];
    if (!line.trim()) {
      /* 空行之后还是同类列表项就继续（宽松列表），否则结束 */
      const next = lines[index + 1];
      if (next && (ordered ? RE.ol.test(next) : RE.ul.test(next))) { index += 1; continue; }
      break;
    }
    const match = ordered ? RE.ol.exec(line) : RE.ul.exec(line);
    if (!match) {
      /* 续行：接到上一项后面 */
      if (items.length) {
        items[items.length - 1].text += '\n' + line.trim();
        index += 1;
        continue;
      }
      break;
    }
    const indent = match[1].length;
    if (indent < baseIndent) break;
    const text = ordered ? match[3] : match[2];
    items.push({ text, depth: Math.max(0, Math.round((indent - baseIndent) / 2)), ordered });
    index += 1;
  }

  return {
    node: { type: 'list', ordered, items },
    next: index,
  };
}

/** 表格：首行表头 + 分隔行 + 若干行。 */
function takeTable(lines, start) {
  const rows = [];
  let index = start;
  while (index < lines.length && RE.table.test(lines[index])) {
    rows.push(lines[index]);
    index += 1;
  }
  if (rows.length < 2 || !RE.tableRule.test(rows[1])) return null;

  const cells = (row) => row.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((cell) => cell.trim());
  const header = cells(rows[0]);
  const aligns = cells(rows[1]).map((cell) => {
    const left = cell.startsWith(':');
    const right = cell.endsWith(':');
    if (left && right) return 'center';
    if (right) return 'right';
    return left ? 'left' : '';
  });
  const body = rows.slice(2).map(cells);
  return { node: { type: 'table', header, aligns, body }, next: index };
}

/** 把整篇切成块。 */
function parseBlocks(content) {
  const lines = stripFrontMatter(content).replace(/\r/g, '').split('\n');
  const blocks = [];
  let index = 0;

  while (index < lines.length) {
    const line = lines[index];

    if (!line.trim()) { index += 1; continue; }

    /* 围栏代码块 */
    const fence = RE.fence.exec(line);
    if (fence) {
      const marker = fence[1][0];
      const lang = fence[2].trim();
      const body = [];
      index += 1;
      while (index < lines.length && !new RegExp('^\\s*' + marker + '{3,}').test(lines[index])) {
        body.push(lines[index]);
        index += 1;
      }
      index += 1;
      blocks.push({ type: 'code', lang, text: body.join('\n') });
      continue;
    }

    const heading = RE.heading.exec(line);
    if (heading) {
      blocks.push({ type: 'heading', level: Math.min(6, heading[1].length), text: heading[2] });
      index += 1;
      continue;
    }

    if (RE.hr.test(line)) {
      blocks.push({ type: 'hr' });
      index += 1;
      continue;
    }

    if (RE.quote.test(line)) {
      const quoted = [];
      while (index < lines.length && RE.quote.test(lines[index])) {
        quoted.push(RE.quote.exec(lines[index])[1]);
        index += 1;
      }
      blocks.push({ type: 'quote', lines: quoted });
      continue;
    }

    if (RE.table.test(line)) {
      const table = takeTable(lines, index);
      if (table) {
        blocks.push(table.node);
        index = table.next;
        continue;
      }
    }

    if (RE.ul.test(line) || RE.ol.test(line)) {
      const list = takeList(lines, index);
      blocks.push(list.node);
      index = list.next;
      continue;
    }

    /* 段落：连续普通行合成一段（这就是「段落标记位置有误」的根因修正） */
    const paragraph = [];
    while (index < lines.length) {
      const current = lines[index];
      if (!current.trim()) break;
      if (RE.heading.test(current) || RE.hr.test(current) || RE.quote.test(current)) break;
      if (RE.fence.test(current) || RE.table.test(current)) break;
      if (RE.ul.test(current) || RE.ol.test(current)) break;
      paragraph.push(current.trim());
      index += 1;
    }
    if (paragraph.length) blocks.push({ type: 'paragraph', lines: paragraph });
  }

  return blocks;
}

/* ------------------------------------------------------------------ 渲染 */

function renderList(items) {
  /* 按 depth 逐层开 ul/ol：简单两层就够覆盖资料区实际写法。 */
  const out = [];
  let depth = -1;
  const stack = [];
  items.forEach((item, index) => {
    const target = item.depth;
    while (depth < target) {
      const key = 'l' + index + '-' + depth + '-' + target;
      out.push(item.ordered ? <ol key={'open' + key}>{[]}</ol> : <ul key={'open' + key}>{[]}</ul>);
      stack.push({ tag: item.ordered ? 'ol' : 'ul', children: [] });
      depth += 1;
    }
    while (depth > target && depth > 0) {
      const done = stack.pop();
      if (stack.length) stack[stack.length - 1].children.push(React.createElement(done.tag, { key: 'nested' + index + depth }, done.children));
      else out.push(React.createElement(done.tag, { key: 'root' + index + depth }, done.children));
      depth -= 1;
    }
    const box = item.text.match(/^\[( |x|X)\]\s+([\s\S]*)$/);
    const content = box
      ? <Fragment><input type="checkbox" checked={box[1].toLowerCase() === 'x'} readOnly /> {renderInline(box[2])}</Fragment>
      : renderInline(item.text);
    if (stack.length) stack[stack.length - 1].children.push(<li key={'li' + index}>{content}</li>);
    else out.push(<li key={'li' + index}>{content}</li>);
  });
  while (stack.length) {
    const done = stack.pop();
    if (stack.length) stack[stack.length - 1].children.push(React.createElement(done.tag, { key: 'close' + stack.length }, done.children));
    else out.push(React.createElement(done.tag, { key: 'closetop' + out.length }, done.children));
  }
  return out;
}

function renderBlock(block, index) {
  if (block.type === 'heading') {
    const Tag = 'h' + block.level;
    return <Tag key={index}>{renderInline(block.text)}</Tag>;
  }
  if (block.type === 'hr') return <hr key={index} />;
  if (block.type === 'code') {
    return (
      <pre key={index} className={block.lang ? 'md-code is-' + block.lang : 'md-code'}>
        <code>{block.text}</code>
      </pre>
    );
  }
  if (block.type === 'quote') {
    return <blockquote key={index}>{block.lines.map((line, at) => <p key={at}>{renderInline(line)}</p>)}</blockquote>;
  }
  if (block.type === 'list') {
    return <Fragment key={index}>{renderList(block.items)}</Fragment>;
  }
  if (block.type === 'table') {
    return (
      <div key={index} className="md-table-wrap">
        <table className="md-table">
          <thead>
            <tr>{block.header.map((cell, at) => <th key={at} style={block.aligns[at] ? { textAlign: block.aligns[at] } : undefined}>{renderInline(cell)}</th>)}</tr>
          </thead>
          <tbody>
            {block.body.map((row, rowIndex) => (
              <tr key={rowIndex}>
                {block.header.map((_, cellIndex) => (
                  <td key={cellIndex} style={block.aligns[cellIndex] ? { textAlign: block.aligns[cellIndex] } : undefined}>
                    {renderInline(row[cellIndex] || '')}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );
  }
  /* 段落：源码里的软换行保留为 <br>，但仍是一个段落 */
  return (
    <p key={index}>
      {block.lines.map((line, at) => (
        <Fragment key={at}>
          {at ? <br /> : null}
          {renderInline(line)}
        </Fragment>
      ))}
    </p>
  );
}

function Markdown(props) {
  const content = props && props.content ? props.content : '';
  const className = props && props.className ? props.className : 'markdown-preview';
  const blocks = parseBlocks(content);
  return <div className={className}>{blocks.map(renderBlock)}</div>;
}

module.exports = { Markdown, parseBlocks, renderInline };
