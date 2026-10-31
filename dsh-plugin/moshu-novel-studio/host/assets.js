/**
 * 墨枢 · 素材库（Host 半）。
 *
 * AI 可以"画"一个 SVG 图标存进来，前端的地点面板会把它和内置图标放在一起选。
 * 也可以被地图上的图章/地貌复用。
 *
 * 存储：`<作品>/maps/assets/<id>.svg` + `<作品>/maps/assets/index.json`
 *   index 里只存元信息（id / name / kind / viewBox / createdAt），SVG 本体单独成文件，
 *   这样列表接口很轻，前端可以随时轮询刷新。
 */
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { HttpError } from './errors.js';
import * as jsonstore from './jsonstore.js';

const ASSET_DIR = 'maps/assets';
const INDEX = 'maps/assets/index.json';
const MAX_SVG_BYTES = 8000;
const MAX_ASSETS = 120;

/** 只允许 24×24 的矢量图标；带脚本/外链一律拒绝（它会被注入到页面里）。 */
function assertSafeSvg(raw) {
  const svg = String(raw || '').trim();
  if (!svg) throw new HttpError(400, 'svg 不能为空。');
  if (Buffer.byteLength(svg, 'utf8') > MAX_SVG_BYTES) {
    throw new HttpError(400, `svg 太大了（上限 ${MAX_SVG_BYTES} 字节），画简一点。`);
  }
  if (!/^<svg[\s>]/i.test(svg) || !/<\/svg>\s*$/i.test(svg)) {
    throw new HttpError(400, 'svg 必须是一段完整的 <svg>…</svg>。');
  }
  const banned = [/<script/i, /<foreignObject/i, /javascript:/i, /\son[a-z]+\s*=/i, /<use[^>]+href\s*=\s*["']http/i, /<image/i];
  for (const pattern of banned) {
    if (pattern.test(svg)) throw new HttpError(400, 'svg 里不能有脚本、外链、<image> 或 <foreignObject>。');
  }
  const viewBox = (/viewBox\s*=\s*["']([^"']+)["']/i.exec(svg) || [])[1] || '';
  return { svg, viewBox: viewBox.trim() || '0 0 24 24' };
}

function assetIdOf(name, existing) {
  const base = String(name || '')
    .toLowerCase()
    .replace(/[^\w\u4e00-\u9fa5-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32) || 'asset';
  let id = base;
  let attempt = 1;
  while (existing.has(id)) {
    attempt += 1;
    id = base + '-' + attempt;
  }
  return id;
}

/**
 * 素材清单（带 svg 正文）。
 * 图标都很小（上限 8 KB），一次带回来前端就能直接渲染，不用逐个请求。
 */
export async function listAssetsWithSvg(root) {
  const list = await listAssets(root);
  const out = [];
  for (const entry of list.slice(0, 80)) {
    try {
      const full = await readAsset(root, entry.id);
      out.push({ id: full.id, name: full.name, kind: full.kind, viewBox: full.viewBox, svg: full.svg });
    } catch {
      /* 文件丢了的条目跳过，不影响其它素材 */
    }
  }
  return out;
}

/** 素材清单（轻量，只有元信息）。 */
export async function listAssets(root) {
  const list = await jsonstore.readArray(root, INDEX, []);
  return (Array.isArray(list) ? list : []).filter((item) => item && typeof item.id === 'string');
}

/** 读一个素材的 SVG 本体。 */
export async function readAsset(root, id) {
  const entry = (await listAssets(root)).find((item) => item.id === id);
  if (!entry) throw new HttpError(404, `没有 id 为「${id}」的素材。`);
  const file = path.join(root, ...('maps/assets/' + id + '.svg').split('/'));
  const svg = await fs.readFile(file, 'utf8').catch(() => '');
  if (!svg) throw new HttpError(404, `素材「${id}」的文件不见了。`);
  return { ...entry, svg };
}

/**
 * 新增 / 覆盖一个素材。
 * @param {{name:string, svg:string, kind?:string, overwrite?:boolean}} body
 */
export async function writeAsset(root, body) {
  const name = String(body?.name || '').trim().slice(0, 40);
  if (!name) throw new HttpError(400, '缺少 name：这个素材叫什么。');
  const { svg, viewBox } = assertSafeSvg(body?.svg);
  const kind = ['icon', 'stamp', 'pattern'].includes(String(body?.kind || '')) ? String(body.kind) : 'icon';

  return jsonstore.withDocLock(root, INDEX, async () => {
    const list = await listAssets(root);
    if (list.length >= MAX_ASSETS) throw new HttpError(400, `素材太多了（上限 ${MAX_ASSETS} 个），先删掉一些。`);
    const existing = new Set(list.map((item) => item.id));
    const wanted = String(body?.id || '').trim();
    let id = wanted && existing.has(wanted) ? wanted : assetIdOf(name, existing);
    if (wanted && !existing.has(wanted) && /^[\w\u4e00-\u9fa5-]+$/.test(wanted)) id = wanted;

    const dir = path.join(root, ...ASSET_DIR.split('/'));
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, id + '.svg'), svg, 'utf8');

    const entry = {
      id,
      name,
      kind,
      viewBox,
      createdAt: new Date().toISOString(),
    };
    const next = list.filter((item) => item.id !== id).concat([entry]);
    await jsonstore.writeArray(root, INDEX, next);
    return { entry, replaced: existing.has(id), total: next.length };
  });
}

/** 删除一个素材（连同文件）。 */
export async function deleteAsset(root, id) {
  return jsonstore.withDocLock(root, INDEX, async () => {
    const list = await listAssets(root);
    const next = list.filter((item) => item.id !== id);
    if (next.length === list.length) throw new HttpError(404, `没有 id 为「${id}」的素材。`);
    await jsonstore.writeArray(root, INDEX, next);
    const file = path.join(root, ...('maps/assets/' + id + '.svg').split('/'));
    await fs.rm(file, { force: true });
    return { ok: true, total: next.length };
  });
}
