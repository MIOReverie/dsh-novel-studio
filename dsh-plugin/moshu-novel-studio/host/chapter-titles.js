/**
 * 章节标题的存放位置：`<作品>/chapters.json`，**不再写进正文**。
 *
 * 以前每章第一行是 `# 第一章 雾从旧钟楼来`，于是：
 *   1. 字数统计把它算进去（一章白多几个字）；
 *   2. 正文里凭空多一个段落，阅读视图和导出的稿子里都有；
 *   3. 改标题就要改正文 —— AI 也就有理由来动正文。
 *
 * 现在标题只存元数据：文件里是纯正文。
 * 旧数据（正文里带 `# ` 标题）由 ensureChapterTitles 一次性迁出：
 * 标题记进 chapters.json，正文去掉那一行（会备份、可恢复）。
 */
import path from 'node:path';
import { promises as fs, existsSync } from 'node:fs';
import * as jsonstore from './jsonstore.js';

const FILE = 'chapters.json';

/** 章节文件里第一行是不是 `# 标题`（只认首个非空行）。 */
export function splitLeadingHeading(content) {
  const text = String(content === undefined || content === null ? '' : content).replace(/\r\n/g, '\n');
  const lines = text.split('\n');
  let index = 0;
  while (index < lines.length && !lines[index].trim()) index += 1;
  const first = lines[index] === undefined ? '' : lines[index];
  const match = /^#\s+(.+?)\s*$/.exec(first);
  if (!match) return { heading: '', body: text };
  return {
    heading: match[1].trim(),
    body: lines.slice(index + 1).join('\n').replace(/^\n+/, ''),
  };
}

/** 全部标题：{ 'chapters/chapter-001.md': '第一章 …' } */
export async function readTitles(root) {
  const data = await jsonstore.readObject(root, FILE, {}).catch(() => ({}));
  const titles = data && typeof data.titles === 'object' && data.titles ? data.titles : {};
  const out = {};
  for (const [key, value] of Object.entries(titles)) {
    if (typeof value === 'string' && value.trim()) out[key] = value.trim();
  }
  return out;
}

async function writeDoc(root, patch) {
  const current = await jsonstore.readObject(root, FILE, {}).catch(() => ({}));
  const next = { ...(current && typeof current === 'object' ? current : {}), ...patch };
  await jsonstore.writeObject(root, FILE, next);
  return next;
}

export async function setTitle(root, relative, title) {
  const titles = await readTitles(root);
  const clean = String(title || '').trim();
  if (clean) titles[relative] = clean;
  else delete titles[relative];
  await writeDoc(root, { titles });
  return titles;
}

export async function removeTitle(root, relative) {
  return setTitle(root, relative, '');
}

/**
 * 一次性迁移：把正文里的 `# 标题` 搬到 chapters.json 并从正文删掉。
 *
 * @param {(relative: string, body: string) => Promise<any>} rewrite 用宿主自己的 saveDocument 写回（自动备份）
 */
export async function ensureChapterTitles(root, rewrite) {
  const marker = path.join(root, FILE);
  const titles = await readTitles(root);
  let files = [];
  const dir = path.join(root, 'chapters');
  try {
    files = (await fs.readdir(dir, { withFileTypes: true }))
      .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith('.md'))
      .map((entry) => 'chapters/' + entry.name)
      .sort();
  } catch {
    return { migrated: 0, skipped: true };
  }

  const done = [];
  for (const relative of files) {
    let content = '';
    try {
      content = await fs.readFile(path.join(root, ...relative.split('/')), 'utf8');
    } catch { continue; }
    const { heading, body } = splitLeadingHeading(content);
    if (!heading) {
      /* 正文里没有标题行：只在缺标题时补一个（用文件名兜底） */
      if (!titles[relative]) {
        titles[relative] = path.basename(relative, '.md');
        done.push({ relative, action: 'title-from-name' });
      }
      continue;
    }
    titles[relative] = titles[relative] || heading;
    if (typeof rewrite === 'function') {
      await rewrite(relative, body);
    } else {
      await fs.writeFile(path.join(root, ...relative.split('/')), body, 'utf8');
    }
    done.push({ relative, action: 'heading-moved', heading });
  }

  await writeDoc(root, {
    titles,
    migratedAt: new Date().toISOString(),
    marker: existsSync(marker) ? 'updated' : 'created',
  });
  return { migrated: done.filter((item) => item.action === 'heading-moved').length, done };
}
