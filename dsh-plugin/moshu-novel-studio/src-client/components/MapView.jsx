'use strict';

/**
 * 墨枢 · 世界地图（v2：整份地图由数据绘制）
 *
 * 旧版把大陆轮廓、山脉、森林、河流全写死在 SVG 常量里，作者只能挪图钉。
 * 现在 `map` 里有什么就画什么：
 *
 *   landmasses: [{ id, name, points:[{x,y}], tone? }]   闭合多边形（Catmull-Rom 平滑）
 *   mountains:  [{ id, x, y, scale? }]                  图章
 *   forests:    [{ id, x, y }]                          图章
 *   rivers:     [{ id, name, color?, points }]          折线
 *   routes:     [{ id, name, color?, points }]          折线
 *   locations:  [{ id, name, x, y, category, ... }]     图钉
 *
 * 坐标一律是画布系（0..1200 / 0..760，左上角原点）。后端已经做过归一化，
 * 这里**不再换算旧版 0..100 的百分比**，只做防御性的裁剪与四舍五入。
 *
 * props（与 page.jsx 的调用点保持一致）：
 *   data / initialData  —— 服务器给的整份地图（缺失时退回 GET /bootstrap 的 map）
 *   onSave(map)         —— 保存，返回 Promise；不传则自己 POST /map { map }
 *   onChange(map)       —— 可选，每次编辑后回调
 *   onSelectLocation    —— 可选，旧版就有，选中地点时回调
 *   className           —— 可选
 */

const React = require('react');
const {
  Activity, Check, ChevronDown, ChevronRight, Copy, Download, Grid2,
  Layers, LibraryBig, LoaderCircle, Magnet, Map, Merge, Mountain, Network, PenLine, Plus,
  Redo, Route, Save, ScanSearch, Search, Sparkles, Undo, X, Zap,
} = require('../icons');
const { request } = require('../api');
const runtime = require('../runtime');
const css = require('./Map.css');
const ops = require('./map-ops');

const { useEffect, useMemo, useRef, useState } = React;

const CANVAS_W = 1200;
/** 网格边长（画布坐标）。吸附也用它。 */
const GRID = 40;
/** 海面/波浪向外多铺多少（世界单位）：平移时不露边，又不用真的画无限。 */
const SEA_PAD = 2000;
const CANVAS_H = 760;
const MIN_ZOOM = 0.5;
const MAX_ZOOM = 4;
/** 顶点手柄的屏幕半径（会按缩放反向补偿，缩放时手感一致）。 */
const HANDLE_RADIUS = 6;
const HIT_RADIUS = 24;
const MAX_NAME = 40;

/* ==== 平滑路径工具开始（纯函数；离屏测试按这两个标记整段抽取） ==== */

/** 坐标绝对值上限：坏数据（Infinity / 1e300）不能把 path 写成非法字符串。 */
const COORD_LIMIT = 1e6;

function finiteNumber(value) {
  const number = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(number) ? number : null;
}

/** 保留两位小数（后端 asCoord 也是两位），并把离谱坐标关进 COORD_LIMIT。 */
function roundCoord(value) {
  const number = finiteNumber(value);
  if (number === null) return null;
  const bounded = Math.max(-COORD_LIMIT, Math.min(COORD_LIMIT, number));
  return Math.round(bounded * 100) / 100;
}

/**
 * 清洗点集：丢掉非对象 / 非数字坐标，去掉「连续重复点」（重复点会让切线退化）。
 * 不做任何坐标换算。
 */
function tidyPoints(list) {
  if (!Array.isArray(list)) return [];
  const out = [];
  for (let index = 0; index < list.length; index += 1) {
    const item = list[index];
    if (!item || typeof item !== 'object') continue;
    const x = roundCoord(item.x);
    const y = roundCoord(item.y);
    if (x === null || y === null) continue;
    const last = out[out.length - 1];
    if (last && last.x === x && last.y === y) continue;
    out.push({ x, y });
  }
  return out;
}

function coordText(value) {
  const number = finiteNumber(value);
  if (number === null) return '0';
  return String(Math.round(Math.max(-COORD_LIMIT, Math.min(COORD_LIMIT, number)) * 100) / 100);
}

/**
 * Catmull-Rom → 三次贝塞尔。
 *
 * 对每一段 p1→p2，取 p0/p3 作为邻居算切线：
 *   c1 = p1 + (p2 - p0) / 6
 *   c2 = p2 - (p3 - p1) / 6
 * 闭合时下标取模，开放时端点用自身当邻居（端点切线自然收敛）。
 *
 * 退化情况一律不抛错：
 *   0 点 → 空串；1 点 → M；2 点 → 一条直线（闭合再补 Z）。
 *
 * @param {Array<{x:number,y:number}>} points
 * @param {{closed?:boolean, tension?:number}} [options]
 * @returns {string} SVG path 的 d
 */
function smoothPath(points, options) {
  const opts = options || {};
  const closed = opts.closed === true;
  const tension = typeof opts.tension === 'number' && Number.isFinite(opts.tension) ? opts.tension : 1;
  let list = tidyPoints(points);

  if (closed && list.length > 2) {
    const first = list[0];
    const last = list[list.length - 1];
    if (first.x === last.x && first.y === last.y) list = list.slice(0, -1);
  }
  if (!list.length) return '';

  const start = list[0];
  let d = 'M ' + coordText(start.x) + ' ' + coordText(start.y);
  if (list.length === 1) return closed ? d + ' Z' : d;
  if (list.length === 2) {
    d += ' L ' + coordText(list[1].x) + ' ' + coordText(list[1].y);
    return closed ? d + ' Z' : d;
  }

  const count = list.length;
  const k = tension / 6;
  const lastSegment = closed ? count - 1 : count - 2;
  for (let index = 0; index <= lastSegment; index += 1) {
    const p1 = list[index];
    const p2 = list[(index + 1) % count];
    const p0 = closed ? list[(index - 1 + count) % count] : list[index - 1] || p1;
    const p3 = closed ? list[(index + 2) % count] : list[index + 2] || p2;
    const c1x = p1.x + (p2.x - p0.x) * k;
    const c1y = p1.y + (p2.y - p0.y) * k;
    const c2x = p2.x - (p3.x - p1.x) * k;
    const c2y = p2.y - (p3.y - p1.y) * k;
    d += ' C ' + coordText(c1x) + ' ' + coordText(c1y)
      + ', ' + coordText(c2x) + ' ' + coordText(c2y)
      + ', ' + coordText(p2.x) + ' ' + coordText(p2.y);
  }
  return closed ? d + ' Z' : d;
}

/** 陆地：闭合平滑路径。 */
function landPath(points) {
  return smoothPath(points, { closed: true });
}

/**
 * 一个陆地的完整路径：主环 + 附加环，拼成一条 path。
 * nonzero 填充规则下，重叠的环就是**并集**——两块陆地合并后接缝自然消失。
 */
function landPathOf(land) {
  const rings = ops.landRings(land);
  if (!rings.length) return '';
  return rings.map((ring) => smoothPath(ring, { closed: true })).filter(Boolean).join(' ');
}

/** 河流 / 路线：开放平滑路径。 */
function linePath(points) {
  return smoothPath(points, { closed: false });
}

/** 通用入口（测试与调试都走它）。 */
function pointsToPath(points, closed) {
  return smoothPath(points, { closed: closed === true });
}

/* ==== 平滑路径工具结束 ==== */

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

/** 世界坐标 → 画布内坐标（两位小数、裁到画布范围）。 */
/**
 * 世界坐标 → 存储坐标（两位小数）。
 * **不再夹到 0..画布尺寸**：地图没有边界，画到初始视口之外是合法的。
 */
function canvasPoint(point) {
  const x = roundCoord(point && point.x);
  const y = roundCoord(point && point.y);
  return { x: x === null ? 0 : x, y: y === null ? 0 : y };
}

function uid(prefix) {
  return prefix + '-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 7);
}

function textOr(value, fallback) {
  return typeof value === 'string' && value.trim() ? value : fallback;
}

function listOf(value) {
  return Array.isArray(value) ? value : [];
}

function messageOf(reason) {
  if (!reason) return '未知错误';
  if (typeof reason === 'string') return reason;
  if (reason.message) return String(reason.message);
  return String(reason);
}

function nextName(prefix, list) {
  const used = new Set(listOf(list).map((item) => item && item.name));
  let index = listOf(list).length + 1;
  while (used.has(prefix + ' ' + index)) index += 1;
  return prefix + ' ' + index;
}

/* ---------------- 数据形状 ---------------- */

const CATEGORIES = [
  { id: 'capital', label: '都城' },
  { id: 'city', label: '城镇' },
  { id: 'town', label: '村镇' },
  { id: 'port', label: '港口' },
  { id: 'fortress', label: '要塞' },
  { id: 'temple', label: '神殿' },
  { id: 'tower', label: '高塔' },
  { id: 'dungeon', label: '遗迹' },
  { id: 'cave', label: '洞穴' },
  { id: 'camp', label: '营地' },
  { id: 'battle', label: '战场' },
  { id: 'mine', label: '矿山' },
  { id: 'farm', label: '农田' },
  { id: 'ferry', label: '渡口' },
  { id: 'pass', label: '关隘' },
  { id: 'academy', label: '书院' },
  { id: 'lighthouse', label: '灯塔' },
  { id: 'falls', label: '瀑布' },
  { id: 'tomb', label: '王陵' },
  { id: 'abyss', label: '深渊' },
  { id: 'portal', label: '传送门' },
  { id: 'landmark', label: '地标' },
  { id: 'region', label: '区域' },
  { id: 'other', label: '地点' },
];

/* 与 CATEGORIES 同源，避免两处清单漂移。 */
const CATEGORY_IDS = CATEGORIES.map((item) => item.id);

/** 地貌种类：每种一个小图形，颜色跟着 biome 走。 */
const TERRAIN_KINDS = [
  /* 森林和地貌是同一类东西（都是"地面覆盖"），所以放在同一组里选。 */
  { id: 'forest', label: '森林' },
  { id: 'hill', label: '丘陵' },
  { id: 'plateau', label: '高原' },
  { id: 'desert', label: '沙漠' },
  { id: 'swamp', label: '沼泽' },
  { id: 'tundra', label: '苔原' },
  { id: 'glacier', label: '冰川' },
  { id: 'volcano', label: '火山' },
  { id: 'canyon', label: '峡谷' },
  { id: 'grass', label: '草原' },
];

/**
 * 地点图标：每个分类一个形状。
 * 以前只有「城镇 / 区域 / 其它」三种，剩下的全是一个通用水滴，等于没有区分。
 */
function locationGlyph(category) {
  if (category === 'capital') {
    return (
      <>
        <path d="M0-14 3.6-4.4 13.6-4.4 5.6 1.8 8.6 11.6 0 5.6-8.6 11.6-5.6 1.8-13.6-4.4-3.6-4.4Z" />
        <circle cx="0" cy="-1" r="2.4" opacity=".5" />
      </>
    );
  }
  if (category === 'city' || category === 'town') {
    return category === 'town'
      ? (
        <>
          <path d="M-8 7V-4h7v11Z" />
          <path d="M1 7V-8h7v15Z" />
          <path d="M-11 8H10v3h-21Z" />
        </>
      )
      : (
        <>
          <path d="M-9 7V-6h5v-5h5v5h5v-8h4V7Z" />
          <path d="M-12 8H12v3h-24Z" />
        </>
      );
  }
  if (category === 'port') {
    return (
      <>
        <path d="M0-12V8" />
        <path d="M-9 2C-9 9 0 12 0 12S9 9 9 2" fill="none" />
        <circle cx="0" cy="-12" r="2.6" />
        <path d="M-4 3H4" />
      </>
    );
  }
  if (category === 'fortress') {
    return (
      <>
        <path d="M-10 8V-9l4 3 3-3 3 3 3-3 4 3V8Z" />
        <path d="M-3 8V2h6v6" />
      </>
    );
  }
  if (category === 'temple') {
    return (
      <>
        <path d="M0-13 11-2H-11Z" />
        <path d="M-7-1v9M0-1v9M7-1v9" />
        <path d="M-10 9H10" />
      </>
    );
  }
  if (category === 'tower') {
    return (
      <>
        <path d="M-4-13h8l-2 6v15h-4V-7Z" />
        <path d="M-6-13H6" />
      </>
    );
  }
  if (category === 'dungeon') {
    return (
      <>
        <path d="M-11 9V-2 3 -6 1 -1 -6 9Z" />
        <path d="M-4 9V-2 9" />
        <path d="M-11 9H11" />
      </>
    );
  }
  if (category === 'cave') {
    return (
      <>
        <path d="M-11 9C-11 0-6-8 0-11 6-8 11 0 11 9Z" />
        <path d="M-4 9C-4 4-2 1 0 1s4 3 4 8" fill="none" />
      </>
    );
  }
  if (category === 'camp') {
    return (
      <>
        <path d="M-11 9 0-11 11 9Z" />
        <path d="M0-11V9" />
      </>
    );
  }
  if (category === 'battle') {
    return (
      <>
        <path d="m-9 9 18-18" />
        <path d="m-9-9 18 18" />
      </>
    );
  }
  if (category === 'mine') {
    return (
      <>
        <path d="M-11 9 0-9 11 9Z" />
        <path d="M-5 9 0 1 5 9" fill="none" />
      </>
    );
  }
  if (category === 'farm') {
    return (
      <>
        <path d="M-11 8H11" />
        <path d="M-8 8V2M-3 8V2M3 8V2M8 8V2" />
        <path d="M-11 2h22" />
      </>
    );
  }
  if (category === 'ferry') {
    return (
      <>
        <path d="M-10 4h20l-4 7h-12Z" />
        <path d="M0 4V-10M0-10l7 6" fill="none" />
      </>
    );
  }
  if (category === 'pass') {
    return (
      <>
        <path d="M-11 9V-4l5 3 6-6 6 6 5-3V9Z" />
        <path d="M-2 9V3h4v6" fill="none" />
      </>
    );
  }
  if (category === 'academy') {
    return (
      <>
        <path d="M-10 0h20" />
        <path d="M-7-1 0-7 7-1" fill="none" />
        <path d="M-6 0v8M0 0v8M6 0v8" />
      </>
    );
  }
  if (category === 'lighthouse') {
    return (
      <>
        <path d="M-5 9 3-9h0l2 18Z" />
        <path d="M-6-9h7" />
        <path d="M-9-6 -4-9M6-9 10-6" fill="none" />
      </>
    );
  }
  if (category === 'falls') {
    return (
      <>
        <path d="M-9-8h18" />
        <path d="M-7-4V9M0-4V9M7-4V9" />
      </>
    );
  }
  if (category === 'tomb') {
    /* 王陵：封土 + 神道，比"墓碑"大一号 */
    return (
      <>
        <path d="M-12 9V1a12 12 0 0 1 24 0v8Z" />
        <path d="M0 9V-3M-4 3h8" fill="none" />
        <path d="M-2 9h4" />
      </>
    );
  }
  if (category === 'abyss') {
    /* 深渊：向内收的同心裂口 */
    return (
      <>
        <path d="M-11-4C-6 6 6 6 11-4" fill="none" />
        <path d="M-7 2C-4 8 4 8 7 2" fill="none" />
        <path d="M-3 8C-1 11 1 11 3 8" fill="none" />
      </>
    );
  }
  if (category === 'portal') {
    /* 传送门：竖立的椭圆门 + 中心涟漪 */
    return (
      <>
        <ellipse cx="0" cy="0" rx="7" ry="11" fill="none" />
        <path d="M-3-2a3 4 0 0 1 6 0" fill="none" />
        <path d="M-6 8h12" />
      </>
    );
  }
  if (category === 'region') return <path d="M0-12 11 0 0 12-11 0Z" />;
  /* landmark / other：通用水滴 */
  return <path d="M0-13C-8-13-12-8-12-2-12 6 0 14 0 14S12 6 12 6 12-8 8-13 0-13Z" />;
}

/**
 * 地貌纹理：平铺在色块上的小笔触，让"一片沙漠/一片冰川"有辨识度。
 * 用 SVG pattern（46×46 一格）平铺，比给每块地貌生成散点便宜得多，也不用存进数据。
 */
function terrainTexture(type) {
  const cls = 'map-tex map-tex-' + type;
  if (type === 'forest') {
    return [
      <path key="a" className={cls + ' is-tree'} d="M12 30V22M12 22l-5 5M12 22l5 5" />,
      <path key="b" className={cls + ' is-tree'} d="M32 34V26M32 26l-5 5M32 26l5 5" />,
      <path key="c" className={cls + ' is-tree'} d="M38 16V9M38 9l-4 4M38 9l4 4" />,
    ];
  }
  if (type === 'desert') {
    return [
      <path key="a" className={cls} d="M4 14c6-5 12-5 18 0" />,
      <path key="b" className={cls} d="M22 32c6-5 12-5 18 0" />,
      <circle key="c" className={cls} cx="12" cy="30" r="1.4" />,
    ];
  }
  if (type === 'glacier') {
    return [
      <path key="a" className={cls} d="M6 10 20 26M20 26l-4-10M20 26l10-5" />,
      <path key="b" className={cls} d="M2 36 16 28M16 28l8 6" />,
    ];
  }
  if (type === 'swamp') {
    return [
      <path key="a" className={cls} d="M4 16h10M20 16h12M4 32h14M24 32h14" />,
      <path key="b" className={cls} d="M10 22v10M30 22v10" />,
    ];
  }
  if (type === 'volcano') {
    return [
      <path key="a" className={cls} d="M8 30 16 12l8 18Z" />,
      <path key="b" className={cls} d="M28 34 34 22l6 12Z" />,
    ];
  }
  if (type === 'canyon') {
    return [
      <path key="a" className={cls} d="M2 20 10 26 18 18 26 26 34 18 42 24" />,
      <path key="b" className={cls} d="M2 34 10 30 18 36 26 30 34 36 42 30" />,
    ];
  }
  if (type === 'plateau') {
    return [
      <path key="a" className={cls} d="M6 14h12M14 18h14M4 26h16M26 30h14" />,
    ];
  }
  if (type === 'grass') {
    return [
      <path key="a" className={cls} d="M10 30v-8M14 30v-5M18 30v-9" />,
      <path key="b" className={cls} d="M30 32v-7M34 32v-10M38 32v-6" />,
    ];
  }
  if (type === 'tundra') {
    return [
      <circle key="a" className={cls} cx="10" cy="16" r="1.6" />,
      <circle key="b" className={cls} cx="26" cy="26" r="1.4" />,
      <circle key="c" className={cls} cx="36" cy="12" r="1.2" />,
      <path key="d" className={cls} d="M4 34c6-4 12-4 18 0" />,
    ];
  }
  /* hill：小丘弧线 */
  return [
    <path key="a" className={cls} d="M6 24c4-8 10-8 14 0" />,
    <path key="b" className={cls} d="M24 34c4-7 10-7 14 0" />,
  ];
}

/**
 * 地貌面里自动铺的元素。
 *
 * 不是纹理小点，而是**能认出来的符号**（树、山、沙丘、冰锥…），
 * 尺寸约为独立图章的一半多一点，铺满整片多边形 —— 一串山脉/一片森林就是这么来的。
 * 位置由地貌 id 做种子确定性生成，所以刷新、重绘都稳定，也不会写进数据。
 */
const TERRAIN_SYMBOL = {
  /* r = 符号间距（画布单位）：森林密一些，火山/高原稀一些。
     数值是按"一眼看出是树林而不是噪点"调的，别调太小，否则大块地貌会几千个节点。 */
  forest: { r: 38, size: 0.52 },
  hill: { r: 52, size: 0.58 },
  plateau: { r: 64, size: 0.6 },
  desert: { r: 58, size: 0.55 },
  swamp: { r: 46, size: 0.5 },
  tundra: { r: 56, size: 0.52 },
  glacier: { r: 60, size: 0.56 },
  volcano: { r: 96, size: 0.62 },
  canyon: { r: 66, size: 0.55 },
  grass: { r: 42, size: 0.48 },
};

/** 单块地貌的符号上限：防止一块巨型区域生成上万个节点拖垮渲染。 */
const MAX_SYMBOLS_PER_AREA = 320;

/** 稳定伪随机：同一块地貌每次算出来的位置一致。 */
function seededRandom(seed) {
  let value = seed;
  return function next() {
    value = (value * 1664525 + 1013904223) % 4294967296;
    return value / 4294967296;
  };
}

function hashSeed(text) {
  let hash = 0;
  const value = String(text || '');
  for (let index = 0; index < value.length; index += 1) hash = (hash * 31 + value.charCodeAt(index)) % 2147483647;
  return hash || 1;
}

/** 在一块多边形里按网格+抖动铺符号，只保留落在多边形内的点。 */
function scatterInRing(ring, spacing, seed) {
  const box = ops.boundsOf([ring]);
  if (!box || !(spacing > 0)) return [];
  const random = seededRandom(seed);
  const points = [];
  for (let y = box.minY + spacing / 2; y <= box.maxY; y += spacing) {
    for (let x = box.minX + spacing / 2; x <= box.maxX; x += spacing) {
      const point = {
        x: x + (random() - 0.5) * spacing * 0.7,
        y: y + (random() - 0.5) * spacing * 0.7,
        scale: 0.85 + random() * 0.3,
      };
      if (ops.pointInRing(point, ring)) points.push(point);
    }
  }
  return points;
}

/** 某种地貌的小符号（在 translate/scale 之后画）。 */
function terrainSymbol(type) {
  if (type === 'forest') {
    return (
      <>
        <path className="map-sym-trunk" d="M0 10v9" />
        <path className="map-sym-tree" d="M0-16 -12 6 -6 5 -14 15 14 15 6 5 12 6Z" />
      </>
    );
  }
  if (type === 'hill') {
    return <path className="map-sym-hill" d="M-24 12C-16-6-6-6 0 2 6-6 16-6 24 12Z" />;
  }
  if (type === 'plateau') {
    return (
      <>
        <path className="map-sym-hill" d="M-24 12 0-14 24 12Z" />
        <path className="map-sym-line" d="M-8 12 0-2 8 12" />
      </>
    );
  }
  if (type === 'desert') {
    return (
      <>
        <path className="map-sym-hill" d="M-24 10C-14 0-4 0 6 8 14 2 20 4 24 10Z" />
        <path className="map-sym-line" d="M-14 11C-9 6-4 6 0 9" />
      </>
    );
  }
  if (type === 'swamp') {
    return (
      <>
        <path className="map-sym-line" d="M-18 10H18" />
        <path className="map-sym-reed" d="M-8 10V-4M0 10V-8M8 10V-2" />
      </>
    );
  }
  if (type === 'tundra') {
    return (
      <>
        <path className="map-sym-hill" d="M-22 11C-14 3-6 3 0 9 8 3 16 4 22 11Z" />
        <path className="map-sym-line" d="M-6 8 2 0 8 6" />
      </>
    );
  }
  if (type === 'glacier') {
    return (
      <>
        <path className="map-sym-hill" d="M-18 11 -6-12 2 6 10-10 20 11Z" />
        <path className="map-sym-line" d="M-6-12 2 11M10-10 5 11" />
      </>
    );
  }
  if (type === 'volcano') {
    return (
      <>
        <path className="map-sym-hill" d="M-22 12 -3-14 3-14 22 12Z" />
        <path className="map-sym-crater" d="M-6-10H6" />
        <path className="map-sym-line" d="M-1-16C-4-22 2-24-1-30" />
      </>
    );
  }
  if (type === 'canyon') {
    return (
      <>
        <path className="map-sym-hill" d="M-24 9 -12 9 -7 1 0 9 10 9 24 9 24 12H-24Z" />
        <path className="map-sym-line" d="M-12 9 -7 1 0 9 10 9" />
      </>
    );
  }
  /* grass */
  return (
    <>
      <path className="map-sym-hill" d="M-22 11C-14 5-6 5 0 9 8 5 16 6 22 11Z" />
      <path className="map-sym-reed" d="M-12 10V2M-4 10V-1M4 10V3M12 10V0" />
    </>
  );
}

/** 每种地貌的图形（画在 translate(x y) scale(s) 里）。 */
function terrainGlyph(type) {
  if (type === 'hill') {
    return [
      <path key="a" className="map-terrain-body" d="M-22 8C-16-6-8-8 0-2 8-9 18-6 22 8Z" />,
      <path key="b" className="map-terrain-body is-second" d="M2 8C6 0 12-2 17 8Z" />,
    ];
  }
  if (type === 'plateau') {
    return [
      <path key="a" className="map-terrain-body" d="M-20 10 0-12 20 10Z" />,
      <path key="b" className="map-terrain-edge" d="M-7 10 0-2 7 10" />,
    ];
  }
  if (type === 'desert') {
    return [
      <path key="a" className="map-terrain-body" d="M-22 8C-14 2-6 2 0 6 8 0 16 0 22 6L22 10H-22Z" />,
      <path key="b" className="map-terrain-edge" d="M6 6C10 2 14 2 17 5" />,
      <path key="c" className="map-terrain-edge" d="M-15 7C-12 4-9 4-6 6" />,
    ];
  }
  if (type === 'swamp') {
    return [
      <path key="a" className="map-terrain-body" d="M-20 6H20L16 10H-16Z" />,
      <path key="b" className="map-terrain-edge" d="M-10 6V1M-2 6V-2M6 6V2M13 6V0" />,
    ];
  }
  if (type === 'tundra') {
    return [
      <path key="a" className="map-terrain-body" d="M-20 9C-14 4-6 4 0 8 8 3 16 4 20 9L20 11H-20Z" />,
      <path key="b" className="map-terrain-edge" d="M-8 7 2 1 9 6" />,
    ];
  }
  if (type === 'glacier') {
    return [
      <path key="a" className="map-terrain-body" d="M-18 9 -6-8 2 4 9-9 19 9Z" />,
      <path key="b" className="map-terrain-edge" d="M-6-8 2 9M9-9 4 9" />,
    ];
  }
  if (type === 'volcano') {
    return [
      <path key="a" className="map-terrain-body" d="M-20 10 -3-11 3-11 20 10Z" />,
      <path key="b" className="map-terrain-crater" d="M-6-8H6" />,
      <path key="c" className="map-terrain-edge" d="M-1-13C-4-18 2-20-1-25" />,
    ];
  }
  if (type === 'canyon') {
    return [
      <path key="a" className="map-terrain-body" d="M-22 9 -10 9 -6 2 0 9 10 9 22 9 22 11H-22Z" />,
      <path key="b" className="map-terrain-edge" d="M-10 9 -6 2 0 9 10 9" />,
    ];
  }
  return [
    <path key="a" className="map-terrain-body" d="M-20 9C-14 5-6 5 0 8 8 4 16 5 20 9Z" />,
    <path key="b" className="map-terrain-edge" d="M-12 8V3M-5 8V4M4 8V3M12 8V4" />,
  ];
}
const KIND_LABEL = { land: '陆地', mountain: '山脉', forest: '森林', river: '河流', route: '路线', location: '地点' };
const LIST_KEY = { land: 'landmasses', mountain: 'mountains', forest: 'forests', terrain: 'terrain', prop: 'props', decor: 'decor', river: 'rivers', route: 'routes', location: 'locations' };

function categoryOf(value) {
  return CATEGORY_IDS.indexOf(value) >= 0 ? value : 'other';
}

function emptyMap() {
  return {
    name: '未命名大陆',
    width: CANVAS_W,
    height: CANVAS_H,
    scale: 0.5,
    landmasses: [],
    mountains: [],
    forests: [],
    terrain: [],
    props: [],
    decor: [],
    rivers: [],
    routes: [],
    locations: [],
  };
}

/**
 * 把服务器（或旧存档）给的地图整成可渲染的形状：缺字段补空数组、坏点丢掉、
 * 坐标裁进画布。**不做 0..100 → 0..1200 的换算**（后端已经处理）。
 */
function normalizeMap(raw) {
  const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};

  const cleanPoints = (value) => {
    const out = [];
    for (const point of tidyPoints(value)) out.push(canvasPoint(point));
    return out;
  };

  const landmasses = [];
  for (const [index, item] of listOf(source.landmasses).entries()) {
    if (!item || typeof item !== 'object') continue;
    const points = cleanPoints(item.points);
    if (points.length < 3) continue; // 少于三个顶点画不出闭合陆地
    const land = { id: textOr(item.id, 'land-' + (index + 1)), name: textOr(item.name, '陆地 ' + (index + 1)), points };
    /* 附加环（合并出来的大陆 / 挖洞）必须保留，否则一读盘就丢了。 */
    const extraRings = listOf(item.rings).map((ring) => cleanPoints(ring)).filter((ring) => ring.length >= 3);
    if (extraRings.length) land.rings = extraRings;
    if (typeof item.tone === 'string' && item.tone) land.tone = item.tone;
    landmasses.push(land);
  }

  const stampList = (value, prefix) => {
    const out = [];
    for (const [index, item] of listOf(value).entries()) {
      if (!item || typeof item !== 'object') continue;
      const x = roundCoord(item.x);
      const y = roundCoord(item.y);
      if (x === null || y === null) continue;
      /* 世界没有边界：不夹坐标，只保底防止 NaN。 */
      const stamp = { id: textOr(item.id, prefix + '-' + (index + 1)), x, y };
      const scale = finiteNumber(item.scale);
      if (scale !== null) stamp.scale = clamp(scale, 0.3, 2.5);
      if (typeof item.type === 'string' && item.type) stamp.type = item.type;
      out.push(stamp);
    }
    return out;
  };

  /** AI 画的装饰图：{id, assetId, x, y, scale?, rotation?}。 */
  const decorList = (value) => {
    const out = [];
    for (const [index, item] of listOf(value).entries()) {
      if (!item || typeof item !== 'object') continue;
      const x = roundCoord(item.x);
      const y = roundCoord(item.y);
      if (x === null || y === null) continue;
      const assetId = textOr(item.assetId, '');
      if (!assetId) continue;
      const decor = { id: textOr(item.id, 'decor-' + (index + 1)), assetId, x, y };
      const scale = finiteNumber(item.scale);
      if (scale !== null) decor.scale = clamp(scale, 0.2, 8);
      const rotation = finiteNumber(item.rotation);
      if (rotation !== null) decor.rotation = rotation;
      out.push(decor);
    }
    return out;
  };

  /** 独立图章：{id, type, x, y, scale?}。 */
  const propList = (value) => {
    const out = [];
    for (const [index, item] of listOf(value).entries()) {
      if (!item || typeof item !== 'object') continue;
      const x = roundCoord(item.x);
      const y = roundCoord(item.y);
      if (x === null || y === null) continue;
      const prop = { id: textOr(item.id, 'prop-' + (index + 1)), type: textOr(item.type, 'peak'), x, y };
      const scale = finiteNumber(item.scale);
      if (scale !== null) prop.scale = clamp(scale, 0.3, 2.5);
      out.push(prop);
    }
    return out;
  };

  /** 地貌：既可能是「面」（points），也可能是旧数据的「点」（x/y）。 */
  const terrainList = (value) => {
    const out = [];
    for (const [index, item] of listOf(value).entries()) {
      if (!item || typeof item !== 'object') continue;
      const type = typeof item.type === 'string' && item.type ? item.type : 'hill';
      const points = cleanPoints(item.points);
      if (points.length >= 3) {
        const area = { id: textOr(item.id, 'terrain-' + (index + 1)), type, points };
        const rings = listOf(item.rings).map((ring) => cleanPoints(ring)).filter((ring) => ring.length >= 3);
        if (rings.length) area.rings = rings;
        out.push(area);
        continue;
      }
      const x = roundCoord(item.x);
      const y = roundCoord(item.y);
      if (x === null || y === null) continue;
      const stamp = { id: textOr(item.id, 'terrain-' + (index + 1)), type, x, y };
      const scale = finiteNumber(item.scale);
      if (scale !== null) stamp.scale = clamp(scale, 0.3, 2.5);
      out.push(stamp);
    }
    return out;
  };

  const lineList = (value, prefix, label) => {
    const out = [];
    for (const [index, item] of listOf(value).entries()) {
      if (!item || typeof item !== 'object') continue;
      const points = cleanPoints(item.points);
      if (points.length < 2) continue;
      const line = { id: textOr(item.id, prefix + '-' + (index + 1)), name: textOr(item.name, label + ' ' + (index + 1)), points };
      if (typeof item.color === 'string' && item.color) line.color = item.color;
      const width = finiteNumber(item.width);
      if (width !== null) line.width = clamp(width, 0.2, 12);
      out.push(line);
    }
    return out;
  };

  const locations = [];
  for (const [index, item] of listOf(source.locations).entries()) {
    if (!item || typeof item !== 'object') continue;
    const x = roundCoord(item.x);
    const y = roundCoord(item.y);
    if (x === null || y === null) continue;
    const location = {
      id: textOr(item.id, 'loc-' + (index + 1)),
      name: textOr(item.name, '地点 ' + (index + 1)),
      /* 世界没有边界：不夹坐标（否则画到外面的地点一读盘就被拖回画布内）。 */
      x,
      y,
      /* 原样保留分类字符串：旧数据里的中文分类（地标 / 禁区）不该在保存时被改写，
         渲染与下拉框再各自用 categoryOf() 兜底成五类之一。 */
      category: textOr(item.category, textOr(item.type, 'other')),
      description: typeof item.description === 'string' ? item.description : '',
      chapterIds: Array.isArray(item.chapterIds)
        ? item.chapterIds.filter((value) => typeof value === 'string')
        : (typeof item.chapter === 'string' && item.chapter ? [item.chapter] : []),
    };
    if (typeof item.color === 'string' && item.color) location.color = item.color;
    /* 自定义图标（asset:<id>）必须保留，否则一读盘就被打回内置图形。 */
    if (typeof item.icon === 'string' && item.icon) location.icon = item.icon;
    locations.push(location);
  }

  const scale = finiteNumber(source.scale);

  return {
    name: textOr(source.name, '未命名大陆'),
    /* 画布尺寸是契约固定的 1200×760：viewBox 不再随数据变，保存时也按它校验，
       否则一份 width=800 的旧数据会把所有 x>800 的坐标变成 400。 */
    width: CANVAS_W,
    height: CANVAS_H,
    scale: scale === null ? 0.5 : clamp(scale, 0.01, 1000),
    landmasses,
    mountains: stampList(source.mountains, 'mt'),
    forests: stampList(source.forests, 'forest'),
    terrain: terrainList(source.terrain),
    props: propList(source.props),
    decor: decorList(source.decor),
    rivers: lineList(source.rivers, 'river', '河流'),
    routes: lineList(source.routes, 'route', '路线'),
    locations,
  };
}

/** 保存前的定稿：与 normalizeMap 同一套规则，保证后端校验一定过。 */
function prepareForSave(map) {
  return normalizeMap(map);
}

function findItem(map, selection) {
  if (!selection) return null;
  const key = LIST_KEY[selection.kind];
  if (!key) return null;
  const list = map[key];
  if (!Array.isArray(list)) return null;
  for (const item of list) {
    if (item && item.id === selection.id) return item;
  }
  return null;
}

function lineLength(points, scale) {
  let total = 0;
  for (let index = 1; index < listOf(points).length; index += 1) {
    const from = points[index - 1];
    const to = points[index];
    total += Math.hypot(to.x - from.x, to.y - from.y);
  }
  const factor = finiteNumber(scale);
  return Math.round(total * (factor === null ? 0 : factor) * 10) / 10;
}

/** 整体平移时用：先把位移夹到「整块仍在画布内」，避免逐点裁剪切变形。 */
function clampDelta(points, dx, dy) {
  if (!points || !points.length) return { dx: 0, dy: 0 };
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (const point of points) {
    if (point.x < minX) minX = point.x;
    if (point.x > maxX) maxX = point.x;
    if (point.y < minY) minY = point.y;
    if (point.y > maxY) maxY = point.y;
  }
  /* 世界无边界：只做防爆限制，不再把对象夹回初始画布。 */
  const LIMIT = 100000;
  return {
    dx: clamp(dx, -LIMIT - minX, LIMIT - maxX),
    dy: clamp(dy, -LIMIT - minY, LIMIT - maxY),
  };
}

/* ---------------- 工具表 ---------------- */

const TOOLS = [
  { id: 'select', label: '选择', icon: ScanSearch, hint: '点选对象；拖动移动；选中陆地后双击它的边可以插顶点，Alt+点顶点删顶点' },
  { id: 'land', label: '画陆地', icon: PenLine, hint: '连续点击落点，至少 3 点后按「完成」闭合；Esc 取消' },
  { id: 'mountain', label: '山脉', icon: Activity, hint: '点一下盖一座山，可以连续盖章；拖动已盖章的山可移动' },
  { id: 'terrain', label: '植被/地貌', icon: Mountain, hint: '选类型（森林或某种地貌），连点围出一片地面，按「完成」闭合' },
  { id: 'river', label: '河流', icon: Zap, hint: '连续点击画河道，至少 2 点后按「完成」；完成前可撤销上一点' },
  { id: 'route', label: '路线', icon: Route, hint: '连续点击画路线，至少 2 点后按「完成」；完成前可撤销上一点' },
  { id: 'prop', label: '图章', icon: Sparkles, hint: '选一种图章（雪峰/松树/枯树/仙人掌/岩石/火山锥），点一下放一个' },
  { id: 'location', label: '地点', icon: Map, hint: '点击地图放一个地点，然后填名称与分类' },
];

/** 独立图章（点缀在地图上的单个元素）。山脉/森林仍是画笔，这些是"点一个"的。 */
const PROP_KINDS = [
  { id: 'peak', label: '雪峰' },
  { id: 'pine', label: '松树' },
  { id: 'dead', label: '枯树' },
  { id: 'cactus', label: '仙人掌' },
  { id: 'rock', label: '岩石' },
  { id: 'cone', label: '火山锥' },
];

/** 图章图形（画在 translate/scale 之后）。 */
function propGlyph(type) {
  if (type === 'peak') {
    return (
      <>
        <path className="map-prop-body" d="M-20 14 -4-16 4-4 10-14 20 14Z" />
        <path className="map-prop-snow" d="M-4-16 -10 2 -4 0 0 4 4-4 8 0 10-14Z" />
      </>
    );
  }
  if (type === 'pine') {
    return (
      <>
        <path className="map-prop-trunk" d="M0 8v10" />
        <path className="map-prop-body" d="M0-18 -10 2 -4 1 -12 14 12 14 4 1 10 2Z" />
      </>
    );
  }
  if (type === 'dead') {
    return (
      <>
        <path className="map-prop-trunk" d="M0 14V-14" />
        <path className="map-prop-line" d="M0-6 -8-12M0-2 8-10M0-12 4-18" />
      </>
    );
  }
  if (type === 'cactus') {
    return (
      <>
        <path className="map-prop-body" d="M-4 14V-8a4 4 0 0 1 8 0v22Z" />
        <path className="map-prop-body" d="M-4 2h-6v-8M4 6h6v-6" />
      </>
    );
  }
  if (type === 'rock') {
    return <path className="map-prop-body" d="M-14 12 -8-6 0-12 8-4 14 12Z" />;
  }
  /* cone：火山锥 */
  return (
    <>
      <path className="map-prop-body" d="M-16 13 -2-13 2-13 16 13Z" />
      <path className="map-prop-line" d="M-4-9H4" />
      <path className="map-prop-line" d="M0-16C-3-21 2-23 0-27" />
    </>
  );
}

const LAYERS = [
  { id: 'land', label: '陆地', icon: Map },
  { id: 'mountains', label: '山脉', icon: Activity },
  { id: 'forests', label: '森林', icon: Network },
  { id: 'terrain', label: '植被/地貌', icon: Mountain },
  { id: 'props', label: '图章', icon: Sparkles },
  { id: 'decor', label: 'AI 装饰', icon: PenLine },
  { id: 'rivers', label: '河流', icon: Zap },
  { id: 'routes', label: '路线', icon: Route },
  { id: 'locations', label: '地点', icon: Sparkles },
];

const DEFAULT_LAYERS = { land: true, mountains: true, forests: true, terrain: true, props: true, decor: true, rivers: true, routes: true, locations: true };

/** 笔刷：按住拖动连续盖章的间距（画布单位）与抖动幅度。 */
const BRUSH = {
  mountain: { key: 'mountains', spacing: 46, jitter: 12, min: 0.85, max: 1.25 },
  forest: { key: 'forests', spacing: 24, jitter: 8, min: 0.9, max: 1.1 },
};

/** 空态文案（后端 landmasses 为空时显示）。整句是需求原文，别拆开。 */
const EMPTY_LAND_TIP = '还没有地形。点「画陆地」开始，或让 AI 按正文生成。';

function MapView(props) {
  const supplied = props.data || props.initialData || null;
  const onSave = props.onSave;
  const onChange = props.onChange;
  const onSelectLocation = props.onSelectLocation;
  const className = props.className || '';

  const initial = useMemo(() => normalizeMap(supplied || emptyMap()), []);

  const [map, setMap] = useState(initial);
  const [tool, setTool] = useState('select');
  const [selection, setSelection] = useState(null);
  const [draft, setDraft] = useState(null);
  const [cursor, setCursor] = useState(null);
  const [view, setView] = useState({ x: 0, y: 0, k: 1 });
  const [layers, setLayers] = useState(DEFAULT_LAYERS);
  const [layersOpen, setLayersOpen] = useState(true);
  /* 右侧属性栏可以收起：小窗口里把宽度全部让给画布。 */
  const [sideOpen, setSideOpen] = useState(true);
  /* AI 画的素材（带 svg 正文）。轮询 /map 拿到，画完马上出现在面板里。 */
  const [assets, setAssets] = useState([]);
  const [query, setQuery] = useState('');
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState(null);
  const [modal, setModal] = useState(null);
  const [form, setForm] = useState({ name: '', category: 'city', description: '' });
  const [scaleText, setScaleText] = useState(String(initial.scale));
  const [spacePressed, setSpacePressed] = useState(false);
  const [loading, setLoading] = useState(!supplied);
  /* 网格与吸附：画地图时对齐用（网格只是视觉参考，吸附才改坐标）。 */
  const [showGrid, setShowGrid] = useState(true);
  const [terrainKind, setTerrainKind] = useState('forest');
  const [propKind, setPropKind] = useState('peak');
  const [snap, setSnap] = useState(false);
  /* 历史：撤销/重做。只存 map 快照，拖拽期间合并成一步。 */
  const [historyTick, setHistoryTick] = useState(0);

  const mapRef = useRef(map);
  const viewRef = useRef(view);
  const svgRef = useRef(null);
  /* 整个地图页的根节点：滚轮在这里统一拦掉，免得滚动页面打断绘制。 */
  const rootRef = useRef(null);
  const gestureRef = useRef(null);
  const spaceRef = useRef(false);
  const dirtyRef = useRef(false);
  const savingRef = useRef(false);
  const externalRef = useRef(supplied);
  const lastSentRef = useRef(null);
  const liveRef = useRef({});
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const historyRef = useRef({ past: [], future: [] });

  /* 世界范围：初始画布 ∪ 所有内容的外扩，再留 240 的余量。
     地图没有边界——画到外面去时，视口自动跟着长大，而不是被裁掉。 */
  const extent = useMemo(() => {
    const rings = ops.ringsOfLands(map.landmasses);
    for (const item of [
      ...(map.locations || []),
      ...(map.mountains || []),
      ...(map.forests || []),
      ...(map.terrain || []),
    ]) {
      if (Number.isFinite(item.x) && Number.isFinite(item.y)) rings.push([{ x: item.x, y: item.y }]);
    }
    for (const line of [...(map.rivers || []), ...(map.routes || [])]) rings.push(line.points || []);
    const box = ops.boundsOf(rings);
    const pad = 240;
    return {
      x: Math.min(0, (box ? box.minX : 0) - pad),
      y: Math.min(0, (box ? box.minY : 0) - pad),
      width: Math.max(CANVAS_W, (box ? box.maxX : CANVAS_W) + pad) - Math.min(0, (box ? box.minX : 0) - pad),
      height: Math.max(CANVAS_H, (box ? box.maxY : CANVAS_H) + pad) - Math.min(0, (box ? box.minY : 0) - pad),
    };
  }, [map]);

  /* 陆地轮廓的合并路径：地貌上色时用它裁剪，保证颜色不会溢到海里。 */
  const landClip = useMemo(
    () => ops.ringsOfLands(map.landmasses).map((ring) => smoothPath(ring, { closed: true })).filter(Boolean).join(' '),
    [map.landmasses],
  );

  const interactive = tool === 'select';
  const selectedItem = findItem(map, selection);
  const activeTool = TOOLS.filter((item) => item.id === tool)[0] || TOOLS[0];

  /* ---------------- 基础状态工具 ---------------- */

  function markDirty(value) {
    dirtyRef.current = value;
    setDirty(value);
  }

  function notify(text, tone) {
    setMessage(text ? { text, tone: tone || 'info' } : null);
  }

  const HISTORY_LIMIT = 60;

  /** 记一步历史（拖动/打字这类高频改动传 { history: false }）。 */
  function pushHistory(snapshot) {
    const history = historyRef.current;
    history.past.push(snapshot);
    if (history.past.length > HISTORY_LIMIT) history.past.shift();
    history.future.length = 0;
    setHistoryTick((value) => value + 1);
  }

  function commit(next, options) {
    if (!options || options.history !== false) pushHistory(mapRef.current);
    mapRef.current = next;
    setMap(next);
    markDirty(true);
  }

  function canUndo() {
    return historyRef.current.past.length > 0;
  }

  function canRedo() {
    return historyRef.current.future.length > 0;
  }

  function undo() {
    const history = historyRef.current;
    if (!history.past.length) return;
    history.future.push(mapRef.current);
    const previous = history.past.pop();
    mapRef.current = previous;
    setMap(previous);
    setScaleText(String(previous.scale));
    setSelection(null);
    setDraft(null);
    markDirty(true);
    emitChange();
    setHistoryTick((value) => value + 1);
    notify('已撤销。');
  }

  function redo() {
    const history = historyRef.current;
    if (!history.future.length) return;
    history.past.push(mapRef.current);
    const next = history.future.pop();
    mapRef.current = next;
    setMap(next);
    setScaleText(String(next.scale));
    setSelection(null);
    setDraft(null);
    markDirty(true);
    emitChange();
    setHistoryTick((value) => value + 1);
    notify('已重做。');
  }

  function emitChange() {
    const handler = onChangeRef.current;
    if (!handler) return;
    try {
      handler(mapRef.current);
    } catch (error) {
      /* 外部回调抛错不该打断编辑 */
    }
  }

  /**
   * 唯一的写入口：改 map + 置脏 + 回调。
   * 拖动过程中传 { silent: true }，松手时再统一 emitChange，避免每帧刷外层。
   */
  function mutate(updater, options) {
    const current = mapRef.current;
    const next = updater(current);
    if (!next || next === current) return;
    commit(next, options);
    if (!options || !options.silent) emitChange();
  }

  /* ---------------- 数据同步 ---------------- */

  useEffect(() => {
    if (!supplied) return;
    if (supplied === lastSentRef.current) return; // 自己保存后外层回传的同一份数据
    if (dirtyRef.current) return; // 有未保存编辑时，不让外部数据覆盖
    externalRef.current = supplied;
    const next = normalizeMap(supplied);
    mapRef.current = next;
    setMap(next);
    setScaleText(String(next.scale));
    setSelection(null);
    setDraft(null);
    setCursor(null);
    markDirty(false);
  }, [supplied]);

  useEffect(() => {
    if (supplied) {
      setLoading(false);
      return undefined;
    }
    let alive = true;
    setLoading(true);
    request('/bootstrap').then((payload) => {
      if (!alive) return;
      const source = payload && typeof payload === 'object' ? payload.map : null;
      const next = normalizeMap(source || emptyMap());
      mapRef.current = next;
      setMap(next);
      setScaleText(String(next.scale));
    }).catch((error) => {
      if (alive) notify('未能读取已保存地图（' + messageOf(error) + '）。当前是空白画布，保存会覆盖服务器地图。', 'error');
    }).finally(() => {
      if (alive) setLoading(false);
    });
    return () => {
      alive = false;
    };
  }, [supplied]);

  useEffect(() => {
    setScaleText(String(map.scale));
  }, [map.scale]);

  /* ---------------- 与后端同步（AI 画的东西实时出现） ---------------- */

  /**
   * 拉一次「地图 + 素材」。
   *
   * AI 在对话里画完一条河/一座山/一张素材后，这里下一次轮询就会把它画出来——
   * 不需要作者手动刷新。**本地有未保存修改或正在拖动时不覆盖**，否则会吞掉手工编辑。
   */
  useEffect(() => {
    let alive = true;
    const pull = async () => {
      if (!alive || dirtyRef.current || gestureRef.current || savingRef.current) return;
      try {
        const payload = await request('/map');
        if (!alive || !payload) return;
        if (Array.isArray(payload.assets)) setAssets(payload.assets);
        if (payload.map && !dirtyRef.current && !gestureRef.current) {
          const next = normalizeMap(payload.map);
          const before = JSON.stringify(mapRef.current);
          if (JSON.stringify(next) !== before) {
            mapRef.current = next;
            setMap(next);
            setSelection((current) => {
              if (!current) return current;
              const key = LIST_KEY[current.kind];
              const list = next[key] || [];
              return list.some((item) => item && item.id === current.id) ? current : null;
            });
          }
        }
      } catch (error) {
        /* 网络抖动/旧后端：忽略，下一轮再试 */
      }
    };
    void pull();
    const timer = window.setInterval(pull, 3000);
    return () => {
      alive = false;
      window.clearInterval(timer);
    };
  }, []);

  /* ---------------- 视图（平移 / 缩放） ---------------- */

  function setViewBoth(next) {
    viewRef.current = next;
    setView(next);
  }

  /** client 坐标 → viewBox 坐标；优先用 CTM（能正确处理 meet 留白）。 */
  function viewPointOf(event) {
    const node = svgRef.current;
    const fallback = { x: 0, y: 0 };
    if (!node) return fallback;
    if (typeof node.getScreenCTM === 'function' && typeof node.createSVGPoint === 'function') {
      try {
        const matrix = node.getScreenCTM();
        if (matrix) {
          const point = node.createSVGPoint();
          point.x = event.clientX;
          point.y = event.clientY;
          const mapped = point.matrixTransform(matrix.inverse());
          if (Number.isFinite(mapped.x) && Number.isFinite(mapped.y)) return { x: mapped.x, y: mapped.y };
        }
      } catch (error) {
        /* 落到下面的比例计算 */
      }
    }
    if (typeof node.getBoundingClientRect !== 'function') return fallback;
    const rect = node.getBoundingClientRect();
    if (!rect.width || !rect.height) return fallback;
    const ratio = Math.min(rect.width / CANVAS_W, rect.height / CANVAS_H);
    const offsetX = (rect.width - CANVAS_W * ratio) / 2;
    const offsetY = (rect.height - CANVAS_H * ratio) / 2;
    return {
      x: (event.clientX - rect.left - offsetX) / ratio,
      y: (event.clientY - rect.top - offsetY) / ratio,
    };
  }

  /** client 坐标 → 地图世界坐标（画布系，未裁剪）。 */
  function worldPointOf(event) {
    const point = viewPointOf(event);
    const current = viewRef.current;
    return { x: (point.x - current.x) / current.k, y: (point.y - current.y) / current.k };
  }

  /** 以某个屏幕点为锚缩放，锚点下的地图位置保持不动。 */
  function zoomAt(clientX, clientY, factor) {
    const current = viewRef.current;
    const target = clamp(current.k * factor, MIN_ZOOM, MAX_ZOOM);
    if (!Number.isFinite(target) || target === current.k) return;
    const anchor = typeof clientX === 'number' && Number.isFinite(clientX)
      ? viewPointOf({ clientX, clientY })
      : { x: extent.x + extent.width / 2, y: extent.y + extent.height / 2 };
    const worldX = (anchor.x - current.x) / current.k;
    const worldY = (anchor.y - current.y) / current.k;
    setViewBoth({ x: anchor.x - worldX * target, y: anchor.y - worldY * target, k: target });
  }

  function zoomBy(factor) {
    zoomAt(null, null, factor);
  }

  /** 适应内容：把所有地形与地点框进视口（空地图就回到 100%）。 */
  function fitToContent() {
    const rings = ops.ringsOfLands(mapRef.current.landmasses);
    for (const item of mapRef.current.locations || []) rings.push([{ x: item.x, y: item.y }]);
    for (const item of mapRef.current.mountains || []) rings.push([{ x: item.x, y: item.y }]);
    for (const item of mapRef.current.forests || []) rings.push([{ x: item.x, y: item.y }]);
    for (const line of (mapRef.current.rivers || []).concat(mapRef.current.routes || [])) rings.push(line.points || []);
    if (!rings.length) {
      setViewBoth({ x: 0, y: 0, k: 1 });
      return;
    }
    setViewBoth(ops.fitView(rings, extent.width, extent.height, 70, extent));
  }

  function resetView() {
    setViewBoth({ x: 0, y: 0, k: 1 });
  }

  function handleDoubleClick(event) {
    if (tool !== 'select') return;
    /* 选中陆地时，双击它的边 = 在这条边上加一个顶点（比"先选中再拖"自然得多）。 */
    if (selection && selection.kind === 'land') {
      const land = mapRef.current.landmasses.filter((item) => item.id === selection.id)[0];
      const point = viewPointOf(event);
      if (land && point) {
        const rings = ops.landRings(land);
        let best = null;
        rings.forEach((ring, ringIndex) => {
          const hit = ops.insertVertexAt(ring, point);
          if (hit && (!best || hit.distance < best.distance)) best = { ...hit, ringIndex };
        });
        const threshold = 16 / Math.max(viewRef.current.k, 0.2);
        if (best && best.distance <= threshold) {
          const next = rings.map((ring, at) => {
            if (at !== best.ringIndex) return ring;
            const copy = ring.slice();
            copy.splice(best.index, 0, { x: Math.round(best.point.x), y: Math.round(best.point.y) });
            return copy;
          });
          mutate((current) => ({
            ...current,
            landmasses: current.landmasses.map((item) => (
              item.id === land.id ? { ...item, points: next[0], rings: next.slice(1) } : item
            )),
          }));
          setSelection({ kind: 'land', id: land.id, ring: best.ringIndex, vertex: best.index });
          notify('已在这条边上插入一个顶点。');
          return;
        }
      }
    }
    /* 河流 / 路线：双击线上就在那里加一个拐点。 */
    if (selection && (selection.kind === 'river' || selection.kind === 'route')) {
      const key = LIST_KEY[selection.kind];
      const line = (mapRef.current[key] || []).filter((item) => item.id === selection.id)[0];
      const point = viewPointOf(event);
      if (line && point) {
        let best = null;
        for (let index = 0; index < line.points.length - 1; index += 1) {
          const hit = ops.closestOnSegment(point, line.points[index], line.points[index + 1]);
          if (!best || hit.distance < best.distance) best = { ...hit, index: index + 1 };
        }
        const threshold = 16 / Math.max(viewRef.current.k, 0.2);
        if (best && best.distance <= threshold) {
          const points = line.points.slice();
          points.splice(best.index, 0, { x: Math.round(best.point.x), y: Math.round(best.point.y) });
          mutate((current) => ({
            ...current,
            [key]: current[key].map((item) => (item.id === line.id ? { ...item, points } : item)),
          }));
          setSelection({ kind: selection.kind, id: line.id });
          notify('已加一个拐点。');
          return;
        }
      }
    }
    zoomAt(event.clientX, event.clientY, 1.4);
  }

  /**
   * 滚轮：**整张地图页都不再滚动页面**。
   *
   * 以前监听只挂在 <svg> 上，于是滚在浮层（空态卡、缩放条、状态条）或页头工具栏上时，
   * 事件照样冒泡给外层滚动容器，页面上下动一下就打断绘制。
   * 现在挂在地图页根节点：画布上 = 缩放，其它地方 = 只吞掉、不缩放。
   * 唯一放行的是可滚动面板（右侧属性面板、弹层），它们要能自己滚。
   */
  function handleWheel(event) {
    const target = event.target;
    /* 只有「在画布上滚动」才被转成缩放；其余位置（工具栏、浮层、右侧面板）
       一律放行，滚动照常——我们的目标是限制滚动**范围**，不是禁止滚动。 */
    const svg = svgRef.current;
    const overCanvas = Boolean(svg && target && (target === svg || svg.contains(target)));
    if (!overCanvas) return;
    event.preventDefault();
    const factor = Math.exp(-event.deltaY * 0.0016);
    if (!Number.isFinite(factor) || factor <= 0) return;
    zoomAt(event.clientX, event.clientY, clamp(factor, 0.5, 2));
  }

  /* 滚轮必须走原生监听：React 的 onWheel 是合成事件，passive 收不回来。 */
  useEffect(() => {
    const node = rootRef.current;
    if (!node || typeof node.addEventListener !== 'function') return undefined;
    const listener = (event) => liveRef.current.handleWheel(event);
    node.addEventListener('wheel', listener, { passive: false });
    return () => node.removeEventListener('wheel', listener);
  }, []);

  /* ---------------- 指针手势 ---------------- */

  function capturePointer(event) {
    const node = svgRef.current;
    if (!node) return;
    try {
      node.setPointerCapture(event.pointerId);
    } catch (error) {
      /* 某些环境（测试 / 老浏览器）不支持，忽略 */
    }
  }

  function releasePointer(event) {
    const node = svgRef.current;
    if (!node) return;
    try {
      if (node.hasPointerCapture(event.pointerId)) node.releasePointerCapture(event.pointerId);
    } catch (error) {
      /* 同上 */
    }
  }

  function handlePointerDown(event) {
    if (event.button !== undefined && event.button !== 0 && event.button !== 1) return;
    /* 带笔刷的工具：按下就盖第一个，之后按住拖动连续盖。 */
    if (BRUSH[tool]) {
      const spot = canvasPoint(ops.snapPoint(worldPointOf(event), GRID, snap));
      const stamp = stampAt(tool, spot, { first: true });
      gestureRef.current = { mode: 'brush', tool, last: spot, painted: Boolean(stamp), moved: false, start: viewPointOf(event) };
      capturePointer(event);
      return;
    }
    const start = viewPointOf(event);
    gestureRef.current = {
      mode: 'click',
      start,
      world: worldPointOf(event),
      view: { x: viewRef.current.x, y: viewRef.current.y },
      moved: false,
      button: event.button === undefined ? 0 : event.button,
    };
    capturePointer(event);
  }

  function handlePointerMove(event) {
    if (draft && (draft.kind === 'land' || draft.kind === 'river' || draft.kind === 'route')) {
      const spot = canvasPoint(worldPointOf(event));
      setCursor((previous) => (previous
        && Math.abs(previous.x - spot.x) < 0.4
        && Math.abs(previous.y - spot.y) < 0.4 ? previous : spot));
    }
    const gesture = gestureRef.current;
    if (!gesture) return;

    if (gesture.mode === 'brush') {
      const spot = worldPointOf(event);
      const config = BRUSH[gesture.tool];
      if (!config) return;
      const distance = Math.hypot(spot.x - gesture.last.x, spot.y - gesture.last.y);
      gesture.moved = true;
      /* 按间距铺开：拖多快都不会糊成一团，也不会漏出空档。 */
      if (distance >= config.spacing) {
        const steps = Math.min(8, Math.floor(distance / config.spacing));
        for (let index = 1; index <= steps; index += 1) {
          const ratio = (index * config.spacing) / distance;
          stampAt(gesture.tool, {
            x: gesture.last.x + (spot.x - gesture.last.x) * ratio,
            y: gesture.last.y + (spot.y - gesture.last.y) * ratio,
          }, { first: false });
        }
        gesture.last = spot;
      }
      return;
    }

    const point = viewPointOf(event);
    const dx = point.x - gesture.start.x;
    const dy = point.y - gesture.start.y;
    if (!gesture.moved && Math.hypot(dx, dy) > 3) gesture.moved = true;
    if (!gesture.moved) return;

    if (gesture.mode === 'pan' || gesture.mode === 'click') {
      setViewBoth({ x: gesture.view.x + dx, y: gesture.view.y + dy, k: viewRef.current.k });
      return;
    }
    const zoom = viewRef.current.k || 1;
    applyDrag(gesture, dx / zoom, dy / zoom);
  }

  function handlePointerUp(event) {
    const gesture = gestureRef.current;
    gestureRef.current = null;
    releasePointer(event);
    if (!gesture) return;

    if (gesture.mode === 'brush') {
      if (gesture.painted) {
        markDirty(true);
        emitChange();
      }
      return;
    }

    if (gesture.mode === 'object' || gesture.mode === 'vertex') {
      if (gesture.moved) {
        markDirty(true);
        emitChange();
        if (gesture.mode === 'object') selectItem(gesture.kind, gesture.id);
      } else if (gesture.mode === 'object') {
        selectItem(gesture.kind, gesture.id);
      } else {
        setSelection({ kind: 'land', id: gesture.id, vertex: gesture.pointIndex });
      }
      return;
    }
    if (!gesture.moved) handleCanvasClick(worldPointOf(event));
  }

  function handlePointerCancel() {
    gestureRef.current = null;
  }

  /** 从某个对象上按下：记录起点与原始几何，之后一律按「起点 + 位移」重算。 */
  function beginObjectDrag(event, kind, id, pointIndex, ringIndex) {
    if (spaceRef.current) return; // 按住空格 = 平移画布，不拖对象
    event.stopPropagation();
    if (event.button !== undefined && event.button !== 0) return;
    if (!interactive) return;
    const item = findItem(mapRef.current, { kind, id });
    if (!item) return;
    const rings = (kind === 'land' || kind === 'river' || kind === 'route' || kind === 'terrain')
      ? ops.landRings(item)
      : null;
    const ring = rings ? (rings[ringIndex || 0] || rings[0]) : null;
    const origin = rings
      ? (pointIndex === undefined || pointIndex === null
        ? { points: rings.map((each) => each.map((point) => ({ x: point.x, y: point.y }))) }
        : { x: ring[pointIndex].x, y: ring[pointIndex].y })
      : { x: item.x, y: item.y };
    gestureRef.current = {
      mode: pointIndex === undefined || pointIndex === null ? 'object' : 'vertex',
      kind,
      id,
      ringIndex: ringIndex || 0,
      pointIndex: pointIndex === undefined ? null : pointIndex,
      start: viewPointOf(event),
      moved: false,
      view: { x: viewRef.current.x, y: viewRef.current.y },
      origin,
    };
    /* 一次拖动 = 一步撤销：开始时记快照，过程中不再记。 */
    pushHistory(mapRef.current);
    capturePointer(event);
  }

  function applyDrag(gesture, dx, dy) {
    const { kind, id } = gesture;

    if (gesture.mode === 'vertex') {
      const land = mapRef.current.landmasses.filter((item) => item.id === id)[0];
      if (!land) return;
      const targetRing = gesture.ringIndex || 0;
      const point = canvasPoint({ x: gesture.origin.x + dx, y: gesture.origin.y + dy });
      const rings = ops.landRings(land).map((ring, at) => (
        at === targetRing
          ? ring.map((value, index) => (index === gesture.pointIndex ? point : value))
          : ring
      ));
      mutate((current) => ({
        ...current,
        landmasses: current.landmasses.map((item) => (
          item.id !== id ? item : { ...item, points: rings[0], rings: rings.slice(1) }
        )),
      }), { silent: true, history: false });
      return;
    }

    if (kind === 'land' || kind === 'river' || kind === 'route' || kind === 'terrain') {
      const key = LIST_KEY[kind];
      /* 多环陆地：所有环一起平移，位移按所有环的并集包围盒夹取。 */
      const allRings = gesture.origin.points;
      const flat = allRings.reduce((acc, ring) => acc.concat(ring), []);
      const delta = clampDelta(flat, dx, dy);
      const moved = allRings.map((ring) => ring.map((point) => ({
        x: Math.round((point.x + delta.dx) * 100) / 100,
        y: Math.round((point.y + delta.dy) * 100) / 100,
      })));
      mutate((current) => ({
        ...current,
        [key]: current[key].map((item) => (
          item.id !== id ? item : { ...item, points: moved[0], rings: moved.slice(1) }
        )),
      }), { silent: true, history: false });
      return;
    }

    if (kind === 'location' || kind === 'mountain' || kind === 'forest' || kind === 'prop' || kind === 'decor'
      || (kind === 'terrain' && !Array.isArray(gesture.origin.points))) {
      const key = LIST_KEY[kind];
      const point = canvasPoint({ x: gesture.origin.x + dx, y: gesture.origin.y + dy });
      mutate((current) => ({
        ...current,
        [key]: current[key].map((item) => (item.id !== id ? item : { ...item, x: point.x, y: point.y })),
      }), { silent: true, history: false });
    }
  }

  /* ---------------- 选中与编辑 ---------------- */

  function selectItem(kind, id) {
    const item = findItem(mapRef.current, { kind, id });
    if (!item) return;
    setSelection({ kind, id });
    if (kind === 'location' && onSelectLocation) {
      try {
        onSelectLocation(item);
      } catch (error) {
        /* 外部回调抛错不影响选中 */
      }
    }
  }

  function patchSelected(patch) {
    if (!selection) return;
    const key = LIST_KEY[selection.kind];
    if (!key) return;
    mutate((current) => ({
      ...current,
      [key]: current[key].map((item) => (item.id === selection.id ? { ...item, ...patch } : item)),
    }));
  }

  function deleteSelection() {
    if (!selection) return;
    const { kind, id } = selection;
    const key = LIST_KEY[kind];
    if (!key) return;
    const vertex = kind === 'land' && selection.vertex !== undefined && selection.vertex !== null
      ? selection.vertex
      : null;

    if (kind === 'land' && vertex !== null) {
      const land = mapRef.current.landmasses.filter((item) => item.id === id)[0];
      if (!land) {
        setSelection(null);
        return;
      }
      if (land.points.length <= 3) {
        notify('陆地至少要保留 3 个顶点；想整块删掉请用面板里的「删除陆地」。', 'error');
        return;
      }
      const points = land.points.filter((point, index) => index !== vertex);
      mutate((current) => ({
        ...current,
        landmasses: current.landmasses.map((item) => (item.id === id ? { ...item, points } : item)),
      }));
      setSelection({ kind: 'land', id, vertex: Math.min(vertex, points.length - 1) });
      notify('已删除一个顶点。');
      return;
    }

    mutate((current) => ({
      ...current,
      [key]: current[key].filter((item) => item.id !== id),
    }));
    setSelection(null);
    notify('已删除' + (KIND_LABEL[kind] || '对象') + '。');
  }

  /** 复制选中对象（偏移 20 像素，方便一眼看到多出来一个）。 */
  function duplicateSelection() {
    if (!selection) return;
    const key = LIST_KEY[selection.kind];
    if (!key) return;
    const item = findItem(mapRef.current, selection);
    if (!item) return;
    const copy = JSON.parse(JSON.stringify(item));
    copy.id = uid(selection.kind);
    if (typeof item.x === 'number') {
      copy.x = clamp(item.x + 20, 0, CANVAS_W);
      copy.y = clamp(item.y + 20, 0, CANVAS_H);
    } else {
      const shifted = ops.landRings(item).map((ring) => ring.map((point) => ({
        x: clamp(point.x + 20, 0, CANVAS_W),
        y: clamp(point.y + 20, 0, CANVAS_H),
      })));
      copy.points = shifted[0];
      copy.rings = shifted.slice(1);
    }
    if (copy.name) copy.name = String(copy.name).slice(0, MAX_NAME - 3) + '·副本';
    mutate((current) => ({ ...current, [key]: current[key].concat([copy]) }));
    setSelection({ kind: selection.kind, id: copy.id });
    notify('已复制一份。');
  }

  /** 方向键微调（Shift = 10 像素）。 */
  function nudgeSelection(dx, dy) {
    if (!selection) return;
    const key = LIST_KEY[selection.kind];
    if (!key) return;
    const item = findItem(mapRef.current, selection);
    if (!item) return;
    if (selection.kind === 'land' && selection.vertex !== undefined && selection.vertex !== null) {
      const rings = ops.landRings(item);
      const ringIndex = selection.ring || 0;
      const ring = rings[ringIndex] || [];
      const point = ring[selection.vertex];
      if (!point) return;
      const moved = canvasPoint({ x: point.x + dx, y: point.y + dy });
      const next = rings.map((each, at) => (
        at === ringIndex ? each.map((value, i) => (i === selection.vertex ? moved : value)) : each
      ));
      mutate((current) => ({
        ...current,
        landmasses: current.landmasses.map((each) => (
          each.id === item.id ? { ...each, points: next[0], rings: next.slice(1) } : each
        )),
      }));
      return;
    }
    if (typeof item.x === 'number') {
      mutate((current) => ({
        ...current,
        [key]: current[key].map((each) => (
          each.id === item.id
            ? { ...each, x: clamp(each.x + dx, 0, CANVAS_W), y: clamp(each.y + dy, 0, CANVAS_H) }
            : each
        )),
      }));
      return;
    }
    const rings = ops.landRings(item);
    const flat = rings.reduce((acc, ring) => acc.concat(ring), []);
    const delta = clampDelta(flat, dx, dy);
    const moved = rings.map((ring) => ring.map((point) => ({ x: point.x + delta.dx, y: point.y + delta.dy })));
    mutate((current) => ({
      ...current,
      [key]: current[key].map((each) => (
        each.id === item.id ? { ...each, points: moved[0], rings: moved.slice(1) } : each
      )),
    }));
  }

  /** 图层顺序：数组靠后 = 画在上层（后画的盖住先画的）。 */
  function moveSelectedLayer(direction) {
    if (!selection) return;
    const key = LIST_KEY[selection.kind];
    if (!key) return;
    const list = mapRef.current[key] || [];
    const next = ops.reorderItem(list, selection.id, direction);
    if (next === list) {
      notify(direction === 'top' || direction === 'up' ? '已经在最上层了。' : '已经在最下层了。');
      return;
    }
    mutate((current) => ({ ...current, [key]: next }));
  }

  /** 和当前陆地真正重叠的那些陆地。 */
  function overlappingLands() {
    if (!selection || selection.kind !== 'land') return [];
    const self = findItem(mapRef.current, selection);
    if (!self) return [];
    return mapRef.current.landmasses.filter((item) => ops.landsOverlap(self, item));
  }

  /**
   * 把重叠的陆地并成一块。
   * 合并后是一个 path 的多个环 —— nonzero 填充下天然是并集，接缝消失。
   */
  function mergeOverlapping() {
    if (!selection || selection.kind !== 'land') return;
    const self = findItem(mapRef.current, selection);
    if (!self) return;
    const targets = overlappingLands();
    if (!targets.length) {
      notify('这块陆地和别的陆地没有重叠，不需要合并。', 'error');
      return;
    }
    let merged = self;
    for (const target of targets) merged = ops.mergeLands(merged, target);
    const gone = new Set(targets.map((item) => item.id));
    mutate((current) => ({
      ...current,
      landmasses: current.landmasses
        .filter((item) => !gone.has(item.id))
        .map((item) => (item.id === self.id ? merged : item)),
    }));
    setSelection({ kind: 'land', id: self.id });
    notify('已把 ' + targets.length + ' 块重叠陆地合并成一块大陆。');
  }

  /** 河流 / 路线反向：源头与入海口画反了的时候用。 */
  function reverseLine() {
    if (!selection) return;
    const key = LIST_KEY[selection.kind];
    if (key !== 'rivers' && key !== 'routes') return;
    const item = findItem(mapRef.current, selection);
    if (!item || !Array.isArray(item.points)) return;
    mutate((current) => ({
      ...current,
      [key]: current[key].map((each) => (
        each.id === item.id ? { ...each, points: each.points.slice().reverse() } : each
      )),
    }));
    notify('已把方向反过来。');
  }

  /**
   * 盖一个图章（山 / 树 / 地貌）。
   * @param {string} toolId mountain | forest | terrain
   * @param {{x:number,y:number}} point 画布坐标
   * @param {{first?:boolean}} [options] first=true 时记一步撤销
   */
  function stampAt(toolId, point, options) {
    const config = BRUSH[toolId];
    if (!config) return null;
    const jitter = options && options.first ? 0 : config.jitter;
    const spot = {
      x: Math.round(point.x + (Math.random() - 0.5) * jitter),
      y: Math.round(point.y + (Math.random() - 0.5) * jitter),
    };
    const stamp = { id: uid(toolId === 'mountain' ? 'mt' : toolId === 'forest' ? 'forest' : 'terrain'), x: spot.x, y: spot.y };
    if (toolId === 'mountain') stamp.scale = Math.round((config.min + Math.random() * (config.max - config.min)) * 100) / 100;
    if (toolId === 'terrain') {
      stamp.type = terrainKind;
      stamp.scale = Math.round((config.min + Math.random() * (config.max - config.min)) * 100) / 100;
    }
    mutate((current) => ({
      ...current,
      [config.key]: (current[config.key] || []).concat([stamp]),
    }), { history: Boolean(options && options.first) });
    return stamp;
  }

  /* ---------------- 工具动作 ---------------- */

  function chooseTool(next) {
    setTool(next);
    setModal(null);
    setSelection(null);
    setDraft(null);
    setCursor(null);
    setMessage(null);
  }

  function handleCanvasClick(point) {
    if (tool === 'select') {
      setSelection(null);
      return;
    }
    /* 吸附只在"落点"这一步生效：拖动已有对象时不吸附，免得手感发涩。 */
    const spot = canvasPoint(ops.snapPoint(point, GRID, snap));

    if (tool === 'land' || tool === 'river' || tool === 'route' || tool === 'terrain') {
      const kind = tool;
      setDraft((current) => {
        if (current && current.kind === kind) return { ...current, points: current.points.concat([spot]) };
        return { kind, points: [spot], name: kind === 'river' ? '新河流' : kind === 'route' ? '新路线' : '新陆地' };
      });
      setCursor(spot);
      return;
    }

    if (tool === 'prop') {
      const shape = { id: uid('prop'), type: propKind, x: spot.x, y: spot.y };
      mutate((current) => ({ ...current, props: (current.props || []).concat([shape]) }));
      setSelection({ kind: 'prop', id: shape.id });
      return;
    }

    if (tool === 'mountain' || tool === 'forest' || tool === 'terrain') {
      const stamp = stampAt(tool, spot, { first: true });
      if (!stamp) return;
      setSelection({ kind: tool, id: stamp.id });
      return;
    }

    if (tool === 'location') {
      setForm({ name: '', category: 'city', description: '' });
      setModal({ x: spot.x, y: spot.y });
    }
  }

  function undoDraftPoint() {
    setDraft((current) => {
      if (!current || !current.points.length) return current;
      return { ...current, points: current.points.slice(0, -1) };
    });
  }

  function cancelDraft() {
    setDraft(null);
    setCursor(null);
    notify('已取消当前绘制。');
  }

  function finishDraft() {
    const current = draft;
    if (!current) return;
    if (current.kind === 'terrain') {
      if (current.points.length < 3) {
        notify('地貌至少要 3 个顶点，再点几下（它是一片地面，不是图标）。', 'error');
        return;
      }
      const area = {
        id: uid('terrain'),
        type: terrainKind,
        points: current.points.map((point) => canvasPoint(point)),
      };
      mutate((value) => ({ ...value, terrain: (value.terrain || []).concat([area]) }));
      setSelection({ kind: 'terrain', id: area.id });
      setTool('select');
      setDraft(null);
      setCursor(null);
      const label = (TERRAIN_KINDS.filter((item) => item.id === terrainKind)[0] || {}).label || '地貌';
      notify('已画出一片' + label + '。拖它的顶点还能继续改形状。');
      return;
    }

    if (current.kind === 'land') {
      if (current.points.length < 3) {
        notify('陆地至少要 3 个顶点，再点几下。', 'error');
        return;
      }
      const land = {
        id: uid('land'),
        name: nextName('陆地', mapRef.current.landmasses),
        points: current.points.map((point) => canvasPoint(point)),
      };
      mutate((value) => ({ ...value, landmasses: value.landmasses.concat([land]) }));
      setSelection({ kind: 'land', id: land.id });
      setTool('select');
      setDraft(null);
      setCursor(null);
      notify('新陆地已落笔，拖它的顶点还能继续微调。');
      return;
    }
    if (current.points.length < 2) {
      notify('至少要 2 个点。', 'error');
      return;
    }
    const isRiver = current.kind === 'river';
    const key = isRiver ? 'rivers' : 'routes';
    const item = {
      id: uid(isRiver ? 'river' : 'route'),
      name: textOr(current.name, isRiver ? '新河流' : '新路线').slice(0, MAX_NAME),
      points: current.points.map((point) => canvasPoint(point)),
    };
    mutate((value) => ({ ...value, [key]: value[key].concat([item]) }));
    setSelection({ kind: isRiver ? 'river' : 'route', id: item.id });
    setTool('select');
    setDraft(null);
    setCursor(null);
    notify((isRiver ? '河流' : '路线') + '已画好。');
  }

  function toggleLayer(id) {
    setLayers((current) => ({ ...current, [id]: current[id] === false }));
  }

  function renameMap(value) {
    mutate((current) => (current.name === value ? current : { ...current, name: value }));
  }

  function commitScale() {
    const value = Number(scaleText);
    if (Number.isFinite(value) && value > 0) {
      const next = clamp(value, 0.01, 1000);
      mutate((current) => (current.scale === next ? current : { ...current, scale: next }));
    } else {
      setScaleText(String(mapRef.current.scale));
    }
  }

  function addLocation(event) {
    if (event) event.preventDefault();
    const name = form.name.trim();
    if (!modal || !name) return;
    const location = {
      id: uid('loc'),
      name,
      x: modal.x,
      y: modal.y,
      category: categoryOf(form.category),
      description: form.description.trim(),
      chapterIds: [],
    };
    mutate((current) => ({ ...current, locations: current.locations.concat([location]) }));
    setSelection({ kind: 'location', id: location.id });
    setModal(null);
    setTool('select');
    notify('地点已经钉在地图上了。');
  }

  /* ---------------- 让 AI 画（创作模式） ---------------- */

  /**
   * 打开「创作模式」并给一段可以直接发出去的指令。
   *
   * 地图属于资料区，AI 有完整权限：可以加、可以改、可以推倒重画。
   * 这里不替用户发消息（宿主的会话输入不归插件管），只负责：
   * 把当前地图状态写进提示词 → 复制到剪贴板 → 启动创作模式会话。
   */
  async function askAi() {
    const current = mapRef.current;
    const counts = '当前地图：陆地 ' + current.landmasses.length + ' 块、地点 ' + current.locations.length
      + ' 个、山脉 ' + current.mountains.length + ' 处、森林 ' + current.forests.length
      + ' 处、河流 ' + current.rivers.length + ' 条、路线 ' + current.routes.length + ' 条。';
    const prompt = [
      '请参与《' + (current.name || '这本书') + '》的世界地图绘制。',
      counts,
      '先调用 novel_map_read 看清现有地形，然后按正文里已经交代过的地理来画：',
      '缺的陆地用 novel_map_add_land 补，地形不对用 novel_map_update_land 改，',
      '地点用 novel_map_place 钉，山脉森林用 novel_map_stamps 盖，河流路线用 novel_map_line 画；',
      '要整体重做就直接 novel_map_write 整份重写。正文没写到的区域留空，不要编造地理。',
    ].join(String.fromCharCode(10));

    let copied = false;
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        await navigator.clipboard.writeText(prompt);
        copied = true;
      }
    } catch (error) {
      copied = false;
    }

    let started = false;
    try {
      const uiWorkspace = runtime.service('uiWorkspace');
      const layout = runtime.service('layout');
      if (uiWorkspace && typeof uiWorkspace.startSession === 'function') {
        uiWorkspace.startSession(undefined, { agentPreset: 'moshu-create' });
        started = true;
        if (layout && typeof layout.selectPanel === 'function') {
          try { layout.selectPanel('conversation'); } catch (error) { /* 切不过去不影响会话 */ }
        }
      }
    } catch (error) {
      started = false;
    }

    if (started && copied) notify('已打开创作模式，提示词已复制——粘到输入框发出去就行。');
    else if (started) notify('已打开创作模式。切到对话，让 AI「按正文画世界地图」即可。');
    else if (copied) notify('提示词已复制。请在 DSH 里新建会话并选「创作模式」，粘进去发送。', 'error');
    else notify('请打开创作模式会话，让 AI「按正文画世界地图」。', 'error');
  }

  /* ---------------- 保存 / 导出 ---------------- */

  function save() {
    if (savingRef.current || loading) return;
    const payload = prepareForSave(mapRef.current);
    savingRef.current = true;
    setSaving(true);
    lastSentRef.current = payload;
    mapRef.current = payload;
    setMap(payload);
    setScaleText(String(payload.scale));

    Promise.resolve()
      .then(() => {
        if (onSave) return onSave(payload);
        return request('/map', { method: 'POST', body: JSON.stringify({ map: payload }) });
      })
      .then(() => {
        markDirty(false);
        notify('地图已保存。');
      })
      .catch((error) => {
        lastSentRef.current = null;
        notify('保存失败：' + messageOf(error), 'error');
      })
      .finally(() => {
        savingRef.current = false;
        setSaving(false);
      });
  }

  /** 把当前 SVG 的可见样式全部内联，导出的文件脱离宿主主题也能看。 */
  function exportSvg() {
    const node = svgRef.current;
    if (!node || typeof XMLSerializer === 'undefined') {
      notify('当前环境不支持导出 SVG。', 'error');
      return;
    }
    try {
      const clone = node.cloneNode(true);
      clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
      clone.setAttribute('width', String(CANVAS_W));
      clone.setAttribute('height', String(CANVAS_H));
      const strip = clone.querySelectorAll('.map-vertices, .map-draft, .map-hit, .map-select-ring, .map-location-ring, .map-land-selected, .map-line-selected, .map-line-point');
      for (let index = 0; index < strip.length; index += 1) strip[index].parentNode.removeChild(strip[index]);

      if (typeof window !== 'undefined' && window.getComputedStyle) {
        const sources = node.querySelectorAll('*');
        const copies = clone.querySelectorAll('*');
        const properties = [
          'fill', 'fill-opacity', 'fill-rule', 'stroke', 'stroke-width', 'stroke-opacity',
          'stroke-dasharray', 'stroke-linecap', 'stroke-linejoin', 'opacity', 'stop-color',
          'stop-opacity', 'font-family', 'font-size', 'font-weight', 'letter-spacing',
          'paint-order', 'text-anchor', 'display',
        ];
        for (let index = 0; index < sources.length && index < copies.length; index += 1) {
          const computed = window.getComputedStyle(sources[index]);
          if (!computed || typeof computed.getPropertyValue !== 'function') continue;
          for (const property of properties) {
            const value = computed.getPropertyValue(property);
            if (value && value.trim()) copies[index].setAttribute(property, value.trim());
          }
        }
      }

      const markup = new XMLSerializer().serializeToString(clone);
      const blob = new Blob([markup], { type: 'image/svg+xml;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = (mapRef.current.name || 'world-map') + '.svg';
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 2000);
      notify('已导出当前视图的 SVG。');
    } catch (error) {
      notify('导出失败：' + messageOf(error), 'error');
    }
  }

  /* ---------------- 键盘 ---------------- */

  function isTypingTarget(target) {
    if (!target) return false;
    if (target.isContentEditable) return true;
    const tag = String(target.tagName || '').toLowerCase();
    return tag === 'input' || tag === 'textarea' || tag === 'select';
  }

  /** 按钮 / 链接上的空格是「按下这个控件」，不能被画布拿去当平移键。 */
  function isControlTarget(target) {
    if (!target) return false;
    const tag = String(target.tagName || '').toLowerCase();
    if (tag === 'button' || tag === 'a' || tag === 'summary') return true;
    return typeof target.getAttribute === 'function' && target.getAttribute('role') === 'button';
  }

  function handleKeyDown(event) {
    if (event.code === 'Space' && !isTypingTarget(event.target) && !isControlTarget(event.target)) {
      if (!spaceRef.current) {
        spaceRef.current = true;
        setSpacePressed(true);
      }
      if (event.preventDefault) event.preventDefault();
      return;
    }
    if ((event.metaKey || event.ctrlKey) && (event.key === 's' || event.key === 'S')) {
      if (event.preventDefault) event.preventDefault();
      save();
      return;
    }
    if (isTypingTarget(event.target)) return;

    /* 撤销 / 重做 / 复制 / 方向键微调 */
    if ((event.metaKey || event.ctrlKey) && (event.key === 'z' || event.key === 'Z')) {
      if (event.preventDefault) event.preventDefault();
      if (event.shiftKey) redo();
      else undo();
      return;
    }
    if ((event.metaKey || event.ctrlKey) && (event.key === 'y' || event.key === 'Y')) {
      if (event.preventDefault) event.preventDefault();
      redo();
      return;
    }
    if ((event.metaKey || event.ctrlKey) && (event.key === 'd' || event.key === 'D')) {
      if (event.preventDefault) event.preventDefault();
      duplicateSelection();
      return;
    }
    if (event.key.indexOf('Arrow') === 0 && selection) {
      const step = event.shiftKey ? 10 : 1;
      const moves = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] };
      const move = moves[event.key];
      if (move) {
        if (event.preventDefault) event.preventDefault();
        nudgeSelection(move[0], move[1]);
        return;
      }
    }

    /* Esc 要**先**于「在输入框里就忽略」判断：焦点在地点名称输入框时，
       以前按 Esc 完全没反应，弹窗关不掉。 */
    if (event.key === 'Escape') {
      if (modal) {
        if (event.preventDefault) event.preventDefault();
        setModal(null);
        return;
      }
      if (isTypingTarget(event.target)) return;
      if (draft) {
        cancelDraft();
      } else {
        setSelection(null);
      }
      return;
    }
    if (event.key === 'Delete' || event.key === 'Backspace') {
      if (!selection) return;
      if (event.preventDefault) event.preventDefault();
      deleteSelection();
    }
  }

  function handleKeyUp(event) {
    if (event.code === 'Space' || event.key === ' ') {
      spaceRef.current = false;
      setSpacePressed(false);
    }
  }

  /* 每帧把最新闭包挂到 liveRef：原生监听（滚轮 / 键盘）永远拿到当前状态。 */
  liveRef.current = {
    handleWheel,
    handleKeyDown,
    handleKeyUp,
    save,
  };

  useEffect(() => {
    if (typeof window === 'undefined') return undefined;
    const down = (event) => liveRef.current.handleKeyDown(event);
    const up = (event) => liveRef.current.handleKeyUp(event);
    const blur = () => {
      spaceRef.current = false;
      setSpacePressed(false);
    };
    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);
    window.addEventListener('blur', blur);
    return () => {
      window.removeEventListener('keydown', down);
      window.removeEventListener('keyup', up);
      window.removeEventListener('blur', blur);
    };
  }, []);

  /* 选中对象被删掉 / 数据被替换后，清掉悬空的选中态。 */
  useEffect(() => {
    if (selection && !findItem(map, selection)) setSelection(null);
  }, [map, selection]);

  /* ---------------- 渲染片段 ---------------- */

  const filteredLocations = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return map.locations;
    return map.locations.filter((location) => String(location.name || '').toLowerCase().indexOf(needle) >= 0);
  }, [map.locations, query]);

  function layerCount(id) {
    if (id === 'land') return map.landmasses.length;
    if (id === 'mountains') return map.mountains.length;
    if (id === 'forests') return map.forests.length;
    if (id === 'terrain') return (map.terrain || []).length;
    if (id === 'props') return (map.props || []).length;
    if (id === 'decor') return (map.decor || []).length;
    if (id === 'rivers') return map.rivers.length;
    if (id === 'routes') return map.routes.length;
    return map.locations.length;
  }

  function handleSize() {
    return HANDLE_RADIUS / Math.max(view.k, 0.35);
  }

  function renderLand(land, index) {
    const d = landPathOf(land);
    if (!d) return null;
    const selected = Boolean(selection && selection.kind === 'land' && selection.id === land.id);
    return (
      <g key={land.id} className={'map-land' + (selected ? ' is-selected' : '')}>
        <path className="map-land-shelf" d={d} />
        <path
          className="map-land-body"
          d={d}
          fill={land.tone || 'url(#moshu-land-' + (index % 3) + ')'}
          pointerEvents={interactive ? 'visiblePainted' : 'none'}
          onPointerDown={interactive ? (event) => beginObjectDrag(event, 'land', land.id) : undefined}
        />
        <path className="map-land-edge" d={d} />
        {selected ? <path className="map-land-selected" d={d} /> : null}
      </g>
    );
  }

  /**
   * 地貌：画成**一片地面**，不是小图标。
   *
   * 两种数据都认：
   * - 新版：`points`（多边形）→ 平滑闭合的面，按地貌类型上色；
   * - 旧版/AI 盖章：只有 `x/y` → 画一块柔和的地面斑（不画图形符号，
   *   因为小图标看着像标签，不像地形）。
   */
  function renderTerrain(item) {
    const selected = Boolean(selection && selection.kind === 'terrain' && selection.id === item.id);
    const type = TERRAIN_KINDS.some((kind) => kind.id === item.type) ? item.type : 'hill';
    const isArea = Array.isArray(item.points) && item.points.length >= 3;

    if (isArea) {
      const rings = ops.landRings({ points: item.points, rings: item.rings });
      const d = rings.map((ring) => smoothPath(ring, { closed: true })).join(' ');
      if (!d) return null;
      const spec = TERRAIN_SYMBOL[type] || TERRAIN_SYMBOL.hill;
      const seed = hashSeed(item.id + type);
      const symbols = [];
      for (const ring of rings) {
        if (symbols.length >= MAX_SYMBOLS_PER_AREA) break;
        for (const point of scatterInRing(ring, spec.r, seed)) {
          if (symbols.length >= MAX_SYMBOLS_PER_AREA) break;
          symbols.push(
            <g key={symbols.length} transform={'translate(' + point.x.toFixed(1) + ' ' + point.y.toFixed(1) + ') scale(' + (spec.size * point.scale).toFixed(2) + ')'}>
              {terrainSymbol(type)}
            </g>,
          );
        }
      }
      return (
        <g
          key={item.id}
          className={'map-terrain-area map-terrain-' + type + (selected ? ' is-selected' : '')}
          /* 有陆地时把上色裁到陆地轮廓内：颜色不会漫到海里。 */
          clipPath={landClip ? 'url(#moshu-land-clip)' : undefined}
        >
          <path
            className="map-terrain-fill"
            d={d}
            pointerEvents={interactive ? 'visiblePainted' : 'none'}
            onPointerDown={interactive ? (event) => beginObjectDrag(event, 'terrain', item.id) : undefined}
          />
          {/* 自动铺满的符号：一片森林就是一片树，一串山脉就是一串山。 */}
          <g className="map-terrain-symbols" pointerEvents="none">
            {symbols}
          </g>
          <path className="map-terrain-outline" d={d} pointerEvents="none" />
          {selected ? <path className="map-terrain-selected" d={d} pointerEvents="none" /> : null}
        </g>
      );
    }

    const scale = item.scale || 1;
    return (
      <g
        key={item.id}
        className={'map-terrain map-terrain-' + type + (selected ? ' is-selected' : '')}
        transform={'translate(' + item.x + ' ' + item.y + ') scale(' + scale + ')'}
        onPointerDown={interactive ? (event) => beginObjectDrag(event, 'terrain', item.id) : undefined}
      >
        <circle className="map-terrain-patch" r={30} />
        {selected ? <circle className="map-select-ring" r={HIT_RADIUS} /> : null}
        {interactive ? <circle className="map-hit" r={HIT_RADIUS} /> : null}
      </g>
    );
  }

  function renderMountain(stamp) {
    const selected = Boolean(selection && selection.kind === 'mountain' && selection.id === stamp.id);
    const scale = stamp.scale || 1;
    return (
      <g
        key={stamp.id}
        className={'map-stamp' + (selected ? ' is-selected' : '')}
        transform={'translate(' + stamp.x + ' ' + stamp.y + ')'}
        onPointerDown={interactive ? (event) => beginObjectDrag(event, 'mountain', stamp.id) : undefined}
      >
        <g transform={'scale(' + scale + ')'}>
          <path className="map-mountain-body" d="M-36 29 -5 -32 8 -10 19 -27 48 29Z" />
          <path className="map-mountain-snow" d="M-5 -32 -19 1 -8 -5 -1 4 8 -10 14 -2 19 -27 29 -1 18 4 12 17 2 9 -9 17 -20 9Z" />
          <path className="map-mountain-shade" d="M-5 -32 -5 13 -24 29 -36 29Z" />
          <path className="map-mountain-shade-second" d="M8 -10 12 24 19 -27 48 29 31 29Z" />
        </g>
        {interactive ? <circle className="map-hit" r={HIT_RADIUS} /> : null}
        {selected ? <circle className="map-select-ring" r={HIT_RADIUS} /> : null}
      </g>
    );
  }

  /** 素材的 svg 正文（去掉外层 <svg> 标签），塞进 <g> 里当图标用。 */
  function innerSvgOf(asset) {
    const raw = String((asset && asset.svg) || '');
    return raw.replace(/^[\s\S]*?<svg[^>]*>/i, '').replace(/<\/svg>\s*$/i, '');
  }

  function assetOf(id) {
    return (assets || []).filter((item) => item && item.id === id)[0] || null;
  }

  /** AI 画的装饰图：贴在世界坐标上，缩放/旋转都跟着数据走。 */
  function renderDecor(item) {
    const asset = assetOf(item.assetId);
    if (!asset) return null;
    const scale = item.scale || 1;
    const rotation = item.rotation || 0;
    const selected = Boolean(selection && selection.kind === 'decor' && selection.id === item.id);
    return (
      <g
        key={item.id}
        className={'map-decor' + (selected ? ' is-selected' : '')}
        transform={'translate(' + item.x + ' ' + item.y + ') rotate(' + rotation + ') scale(' + scale + ')'}
        onPointerDown={interactive ? (event) => beginObjectDrag(event, 'decor', item.id) : undefined}
      >
        <svg
          className="map-decor-art"
          x={-12}
          y={-12}
          width={24}
          height={24}
          viewBox={asset.viewBox || '0 0 24 24'}
          dangerouslySetInnerHTML={{ __html: innerSvgOf(asset) }}
        />
        {selected ? <circle className="map-select-ring" r={HIT_RADIUS} /> : null}
        {interactive ? <circle className="map-hit" r={HIT_RADIUS} /> : null}
      </g>
    );
  }

  function renderProp(item) {
    const selected = Boolean(selection && selection.kind === 'prop' && selection.id === item.id);
    const type = PROP_KINDS.some((kind) => kind.id === item.type) ? item.type : 'peak';
    const scale = item.scale || 1;
    return (
      <g
        key={item.id}
        className={'map-prop map-prop-' + type + (selected ? ' is-selected' : '')}
        transform={'translate(' + item.x + ' ' + item.y + ') scale(' + scale + ')'}
        onPointerDown={interactive ? (event) => beginObjectDrag(event, 'prop', item.id) : undefined}
      >
        {propGlyph(type)}
        {selected ? <circle className="map-select-ring" r={HIT_RADIUS} /> : null}
        {interactive ? <circle className="map-hit" r={HIT_RADIUS} /> : null}
      </g>
    );
  }

  function renderForest(stamp, index) {
    const selected = Boolean(selection && selection.kind === 'forest' && selection.id === stamp.id);
    return (
      <g
        key={stamp.id}
        className={'map-stamp' + (selected ? ' is-selected' : '')}
        transform={'translate(' + stamp.x + ' ' + stamp.y + ')'}
        opacity="0.94"
        onPointerDown={interactive ? (event) => beginObjectDrag(event, 'forest', stamp.id) : undefined}
      >
        <path className="map-tree-trunk" d="M0 14v13" />
        <path className={'map-tree-body' + (index % 2 ? ' is-alt' : '')} d="M0 -20 -15 8 -7 7 -18 19 18 19 7 7 15 8Z" />
        <path className="map-tree-vein" d="M0 -16V13" />
        {interactive ? <circle className="map-hit" r={HIT_RADIUS * 0.8} /> : null}
        {selected ? <circle className="map-select-ring" r={HIT_RADIUS * 0.8} /> : null}
      </g>
    );
  }

  function renderLine(item, kind) {
    const d = linePath(item.points);
    if (!d) return null;
    const selected = Boolean(selection && selection.kind === kind && selection.id === item.id);
    const coreClass = kind === 'river' ? 'map-river-core' : 'map-route-core';
    const haloClass = kind === 'river' ? 'map-river-halo' : 'map-route-halo';
    /* 河宽：没设就按类型给默认（河 = 1.6，路线不变）。 */
    const baseWidth = kind === 'river' ? 1.6 : 1;
    const width = Number.isFinite(Number(item.width)) ? Number(item.width) : baseWidth;
    const strokeWidth = kind === 'river'
      ? (1.6 + width * 2.6)
      : undefined;
    return (
      <g key={item.id} className={'map-line map-line-' + kind + (selected ? ' is-selected' : '')}>
        <path className={haloClass} d={d} />
        <path
          className={coreClass}
          d={d}
          style={{
            ...(item.color ? { stroke: item.color } : {}),
            ...(strokeWidth ? { strokeWidth } : {}),
          }}
        />
        {interactive ? (
          <path
            className="map-line-hit"
            d={d}
            onPointerDown={(event) => beginObjectDrag(event, kind, item.id)}
          />
        ) : null}
        {selected ? <path className="map-line-selected" d={d} /> : null}
        {selected ? item.points.map((point, index) => (
          <circle
            key={index}
            className="map-line-point"
            cx={point.x}
            cy={point.y}
            r={handleSize() * 0.7}
            /* 这些点以前没有处理器：在点上按下会冒泡到 svg → 被当成"空白处"开始平移画布。
               现在拖点就是拖这个顶点（beginObjectDrag 的 vertex 模式支持 river/route）。 */
            onPointerDown={interactive ? (event) => beginObjectDrag(event, kind, item.id, index) : undefined}
          />
        )) : null}
      </g>
    );
  }

  function renderLocation(location) {
    const category = categoryOf(location.category);
    const selected = Boolean(selection && selection.kind === 'location' && selection.id === location.id);
    return (
      <g
        key={location.id}
        className={'map-location map-location-' + category + (selected ? ' is-selected' : '')}
        transform={'translate(' + location.x + ' ' + location.y + ')'}
        style={location.color ? { color: location.color } : undefined}
        onPointerDown={interactive ? (event) => beginObjectDrag(event, 'location', location.id) : undefined}
      >
        {selected ? <circle className="map-location-ring" r={26} /> : null}
        {/* 底板：不管底下是沙漠、森林还是冰川，图标都有一块自己的底色。 */}
        <circle className="map-location-plate" r={15} />
        <circle className="map-location-glare" r={17} />
        {location.icon && String(location.icon).indexOf('asset:') === 0 && assetOf(String(location.icon).slice(6)) ? (
          <g className="map-symbol map-symbol-asset">
            <svg
              x={-12}
              y={-12}
              width={24}
              height={24}
              viewBox={(assetOf(String(location.icon).slice(6)) || {}).viewBox || '0 0 24 24'}
              dangerouslySetInnerHTML={{ __html: innerSvgOf(assetOf(String(location.icon).slice(6))) }}
            />
          </g>
        ) : (
          <g className="map-symbol">{locationGlyph(category)}</g>
        )}
        <text className="map-location-label" y="31" textAnchor="middle" pointerEvents="none">{location.name}</text>
        {interactive ? <circle className="map-hit" r={HIT_RADIUS * 0.85} /> : null}
      </g>
    );
  }

  function renderVertexHandles() {
    if (!selection) return null;
    if (selection.kind !== 'land' && selection.kind !== 'terrain') return null;
    const key = LIST_KEY[selection.kind];
    const land = (map[key] || []).filter((item) => item.id === selection.id)[0];
    if (!land || !Array.isArray(land.points) || land.points.length < 3) return null;
    const radius = handleSize();
    /* 一个陆地可能有多个环（合并出来的）：每个环的顶点都要能拖、能删。 */
    return (
      <g className="map-vertices">
        {ops.landRings(land).map((ring, ringIndex) => (
          <g key={ringIndex} className="map-ring">
            {ring.map((point, index) => {
              const active = selection.vertex === index && (selection.ring || 0) === ringIndex;
              return (
                <circle
                  key={index}
                  className={'map-vertex' + (active ? ' is-active' : '') + (ringIndex ? ' is-extra' : '')}
                  cx={point.x}
                  cy={point.y}
                  r={radius}
                  onPointerDown={(event) => {
                    /* Alt / 右键点顶点 = 删掉它（不用先去面板里点按钮）。 */
                    if (event.altKey || event.button === 2) {
                      event.stopPropagation();
                      if (event.preventDefault) event.preventDefault();
                      deleteVertex(ringIndex, index);
                      return;
                    }
                    beginObjectDrag(event, selection.kind, land.id, index, ringIndex);
                  }}
                />
              );
            })}
          </g>
        ))}
      </g>
    );
  }

  /** 删除某个环上的一个顶点；环少于 3 点时整环丢弃。 */
  function deleteVertex(ringIndex, index) {
    const key = LIST_KEY[selection && selection.kind] || 'landmasses';
    const land = (mapRef.current[key] || []).filter((item) => item.id === (selection && selection.id))[0];
    if (!land) return;
    const rings = ops.landRings(land);
    const ring = rings[ringIndex];
    if (!ring) return;
    if (ring.length <= ops.MIN_RING) {
      if (rings.length <= 1) {
        notify('陆地至少要保留 3 个顶点；想整块删掉请用面板里的「删除陆地」。', 'error');
        return;
      }
      const next = rings.filter((_, at) => at !== ringIndex);
      mutate((current) => ({
        ...current,
        [key]: current[key].map((item) => (
          item.id === land.id ? { ...item, points: next[0], rings: next.slice(1) } : item
        )),
      }));
      setSelection({ kind: selection.kind, id: land.id });
      notify('已删掉一个附加多边形。');
      return;
    }
    const next = rings.map((item, at) => (at === ringIndex ? item.filter((_, i) => i !== index) : item));
    mutate((current) => ({
      ...current,
      [key]: current[key].map((item) => (
        item.id === land.id ? { ...item, points: next[0], rings: next.slice(1) } : item
      )),
    }));
    setSelection({ kind: selection.kind, id: land.id, ring: ringIndex, vertex: Math.min(index, next[ringIndex].length - 1) });
    notify('已删除一个顶点。');
  }

  function renderDraft() {
    if (!draft) return null;
    const points = draft.points || [];
    const preview = cursor ? points.concat([cursor]) : points.slice();
    const isLand = draft.kind === 'land' || draft.kind === 'terrain';
    const shape = isLand ? landPath(preview) : linePath(preview);
    const committed = points.length > 1 ? (isLand ? landPath(points) : linePath(points)) : '';
    const last = points[points.length - 1];
    return (
      <g className="map-draft">
        {committed ? <path className={isLand ? 'map-draft-shape is-solid' : 'map-draft-line'} d={committed} /> : null}
        {shape ? <path className={isLand ? 'map-draft-shape' : 'map-draft-line is-ghost'} d={shape} /> : null}
        {last && cursor ? <line className="map-draft-rubber" x1={last.x} y1={last.y} x2={cursor.x} y2={cursor.y} /> : null}
        {isLand && points.length > 1 && cursor ? (
          <line className="map-draft-rubber is-ghost" x1={cursor.x} y1={cursor.y} x2={points[0].x} y2={points[0].y} />
        ) : null}
        {points.map((point, index) => (
          <g key={index} className="map-draft-point">
            <circle cx={point.x} cy={point.y} r={handleSize()} />
            <text x={point.x} y={point.y + 3.5} textAnchor="middle">{index + 1}</text>
          </g>
        ))}
        {cursor && !points.length ? <circle className="map-draft-cursor" cx={cursor.x} cy={cursor.y} r={handleSize()} /> : null}
      </g>
    );
  }

  function draftRequirement() {
    if (!draft) return '';
    if (draft.kind === 'land' || draft.kind === 'terrain') {
      return draft.points.length < 3
        ? '还需要 ' + (3 - draft.points.length) + ' 个顶点才能闭合'
        : (draft.kind === 'terrain' ? '按「完成」画成一片地貌' : '按「完成」闭合成一块陆地');
    }
    return draft.points.length < 2 ? '至少需要 2 个点' : '按「完成」结束';
  }

  function canFinishDraft() {
    if (!draft) return false;
    return (draft.kind === 'land' || draft.kind === 'terrain') ? draft.points.length >= 3 : draft.points.length >= 2;
  }

  function renderInspector() {
    if (!selection || !selectedItem) {
      return (
        <div className="map-inspector">
          <div className="map-inspector-head">
            <span className="map-kicker">编辑面板</span>
          </div>
          <p className="map-inspector-lead">点选地图上的对象来编辑。</p>
          <ul className="map-keys">
            <li><kbd>Delete</kbd><span>删除选中对象 / 顶点</span></li>
            <li><kbd>Esc</kbd><span>取消当前绘制</span></li>
            <li><kbd>Ctrl</kbd><span>+ Z 撤销 · Shift+Z 重做</span></li>
            <li><kbd>Ctrl</kbd><span>+ D 复制选中对象</span></li>
            <li><kbd>←↑↓→</kbd><span>微调位置（按住 Shift = 10 像素）</span></li>
            <li><kbd>双击</kbd><span>选中陆地时在边上插一个顶点</span></li>
            <li><kbd>Alt</kbd><span>+ 点顶点 = 删掉这个顶点</span></li>
            <li><kbd>Ctrl</kbd><span>+ S 保存地图</span></li>
          </ul>
          <div className="map-counts">
            {LAYERS.map((layer) => (
              <div key={layer.id}><span>{layer.label}</span><span>{layerCount(layer.id)}</span></div>
            ))}
          </div>
        </div>
      );
    }

    const kind = selection.kind;
    const label = KIND_LABEL[kind] || '对象';
    const vertex = kind === 'land' && selection.vertex !== undefined && selection.vertex !== null
      ? selection.vertex
      : null;
    const hasName = kind === 'land' || kind === 'location' || kind === 'river' || kind === 'route';

    return (
      <div className="map-inspector">
        <div className="map-inspector-head">
          <span className="map-kicker">{label}</span>
          <button type="button" className="map-inspector-close" onClick={() => setSelection(null)} aria-label="关闭属性面板"><X size={14} /></button>
        </div>

        {hasName ? (
          <label className="map-field">
            <span>{kind === 'land' ? '陆地名称' : kind === 'river' ? '河流名称' : kind === 'route' ? '路线名称' : '地点名称'}</span>
            <input
              value={selectedItem.name || ''}
              maxLength={MAX_NAME}
              onChange={(event) => patchSelected({ name: event.target.value })}
            />
          </label>
        ) : null}

        {kind === 'location' ? (
          <React.Fragment>
            <div className="map-field">
              <span>图标{assets.length ? '（含 AI 画的 ' + assets.length + ' 个）' : ''}</span>
              <div className="map-icon-grid" role="group" aria-label="地点图标">
                {CATEGORIES.map((option) => {
                  const active = !selectedItem.icon && categoryOf(selectedItem.category) === option.id;
                  return (
                    <button
                      key={option.id}
                      type="button"
                      className={'map-icon-cell' + (active ? ' is-active' : '')}
                      title={option.label}
                      aria-pressed={active}
                      onClick={() => patchSelected({ category: option.id, icon: '' })}
                    >
                      <svg viewBox="0 0 24 24" aria-hidden="true">
                        <g transform="translate(12 12)">{locationGlyph(option.id)}</g>
                      </svg>
                      <span>{option.label}</span>
                    </button>
                  );
                })}
                {assets.map((asset) => {
                  const active = selectedItem.icon === 'asset:' + asset.id;
                  return (
                    <button
                      key={'asset-' + asset.id}
                      type="button"
                      className={'map-icon-cell is-asset' + (active ? ' is-active' : '')}
                      title={asset.name + '（AI 画）'}
                      aria-pressed={active}
                      onClick={() => patchSelected({ icon: 'asset:' + asset.id })}
                    >
                      <svg viewBox={asset.viewBox || '0 0 24 24'} aria-hidden="true" dangerouslySetInnerHTML={{ __html: innerSvgOf(asset) }} />
                      <span>{asset.name}</span>
                    </button>
                  );
                })}
              </div>
            </div>
            <label className="map-field">
              <span>描述</span>
              <textarea
                rows={5}
                value={selectedItem.description || ''}
                placeholder="这里的传说、居民，或即将发生的故事…"
                onChange={(event) => patchSelected({ description: event.target.value })}
              />
            </label>
          </React.Fragment>
        ) : null}

        {kind === 'land' ? (
          <p className="map-note">
            {selectedItem.points.length + ' 个顶点'}
            {vertex !== null ? ' · 正在微调第 ' + (vertex + 1) + ' 个顶点，拖动它即可变形' : ' · 点顶点可以单独拖动'}
          </p>
        ) : null}

        {kind === 'river' || kind === 'route' ? (
          <p className="map-note">{selectedItem.points.length + ' 个点 · 折线长约 ' + lineLength(selectedItem.points, map.scale) + ' 里'}</p>
        ) : null}

        {kind === 'terrain' ? (
          <label className="map-field">
            <span>地貌</span>
            <select
              value={TERRAIN_KINDS.some((item) => item.id === selectedItem.type) ? selectedItem.type : 'hill'}
              onChange={(event) => patchSelected({ type: event.target.value })}
            >
              {TERRAIN_KINDS.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}
            </select>
          </label>
        ) : null}

        {kind === 'terrain' || kind === 'mountain' ? (
          <label className="map-field">
            <span>大小 {Math.round((selectedItem.scale || 1) * 100)}%</span>
            <input
              type="range"
              min="0.5"
              max="2.5"
              step="0.05"
              value={selectedItem.scale || 1}
              onChange={(event) => patchSelected({ scale: Number(event.target.value) })}
            />
          </label>
        ) : null}

        {kind === 'river' ? (
          <label className="map-field">
            <span>河宽 {Math.round(((Number(selectedItem.width) || 1.6) / 3) * 100)}%</span>
            <input
              type="range"
              min="0.4"
              max="6"
              step="0.2"
              value={Number.isFinite(Number(selectedItem.width)) ? Number(selectedItem.width) : 1.6}
              onChange={(event) => patchSelected({ width: Number(event.target.value) })}
            />
          </label>
        ) : null}

        {kind === 'mountain' || kind === 'forest' || kind === 'location' ? (
          <p className="map-note">{'坐标 ' + Math.round(selectedItem.x) + ', ' + Math.round(selectedItem.y)}</p>
        ) : null}

        {kind === 'river' || kind === 'route' ? (
          <button type="button" className="map-btn-ghost map-btn-block" onClick={reverseLine}>
            首尾反向（源头 ↔ 入海口）
          </button>
        ) : null}

        <div className="map-field-group">
          <div className="map-field-group-head"><Layers size={13} /><span>图层顺序</span></div>
          <div className="map-order-buttons">
            <button type="button" onClick={() => moveSelectedLayer('top')} title="置于最上层">置顶</button>
            <button type="button" onClick={() => moveSelectedLayer('up')} title="上移一层">上移</button>
            <button type="button" onClick={() => moveSelectedLayer('down')} title="下移一层">下移</button>
            <button type="button" onClick={() => moveSelectedLayer('bottom')} title="置于最下层">置底</button>
          </div>
        </div>

        {kind === 'land' ? (
          <div className="map-field-group">
            <div className="map-field-group-head"><Merge size={13} /><span>重叠与配色</span></div>
            <p className="map-note">
              {overlappingLands().length
                ? '和 ' + overlappingLands().length + ' 块陆地重叠——合并后会变成一块大陆，接缝消失。'
                : '没有和别的陆地重叠。'}
            </p>
            <button
              type="button"
              className="map-btn-ghost map-btn-block"
              onClick={mergeOverlapping}
              disabled={!overlappingLands().length}
            >
              合并重叠的 {overlappingLands().length || ''} 块陆地
            </button>
            <div className="map-tone-row" role="group" aria-label="陆地配色">
              {[null, 'url(#moshu-land-0)', 'url(#moshu-land-1)', 'url(#moshu-land-2)'].map((tone, index) => (
                <button
                  key={index}
                  type="button"
                  className={'map-tone' + ((selectedItem.tone || null) === tone ? ' is-active' : '') + ' is-' + index}
                  onClick={() => patchSelected({ tone: tone || '' })}
                  aria-label={tone ? '配色 ' + index : '默认配色'}
                />
              ))}
            </div>
          </div>
        ) : null}

        <button type="button" className="map-btn-ghost map-btn-block" onClick={duplicateSelection}>
          <Copy size={13} />
          <span>复制一份（Ctrl+D）</span>
        </button>

        <button type="button" className="map-btn-danger" onClick={deleteSelection}>
          <X size={14} />
          <span>{kind === 'land' && vertex !== null ? '删除这个顶点' : '删除' + label}</span>
        </button>
        {kind === 'land' && vertex !== null ? (
          <button type="button" className="map-btn-ghost map-btn-block" onClick={() => setSelection({ kind: 'land', id: selection.id })}>
            结束顶点编辑
          </button>
        ) : null}
      </div>
    );
  }

  /* ---------------- 主渲染 ---------------- */

  return (
    <section className={('map-view ' + className).trim()} ref={rootRef}>
      <style>{css}</style>

      <header className="map-header">
        <div className="map-brand">
          <span className="map-brand-icon"><Map size={20} /></span>
          <div className="map-brand-main">
            <input
              className="map-name-input"
              value={map.name}
              maxLength={MAX_NAME}
              aria-label="地图名称"
              placeholder="地图名称"
              onChange={(event) => renameMap(event.target.value)}
              onBlur={() => {
                if (!String(mapRef.current.name || '').trim()) renameMap('未命名大陆');
              }}
            />
            <p className="map-stats">{'陆地 ' + map.landmasses.length + ' 块 · 地点 ' + map.locations.length + ' 个'}</p>
          </div>
        </div>

        <label className="map-scale-field">
          <span>1 单位 ≈</span>
          <input
            type="number"
            min="0.01"
            step="0.1"
            value={scaleText}
            aria-label="比例尺：1 单位等于多少里"
            onChange={(event) => setScaleText(event.target.value)}
            onBlur={commitScale}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault();
                commitScale();
              }
            }}
          />
          <span>里</span>
        </label>

        <div className="map-header-actions">
          <button type="button" className="map-btn-ghost map-ai" onClick={askAi} title="打开创作模式，让 AI 按正文画这张地图（它可以改、也可以整张重画）">
            <Sparkles size={15} />
            <span>让 AI 画</span>
          </button>
          <button type="button" className="map-btn-ghost" onClick={exportSvg} title="把当前视图导出成 SVG">
            <Download size={15} />
            <span>导出 SVG</span>
          </button>
          <button type="button" className="map-save" onClick={save} disabled={!dirty || saving}>
            {saving ? <LoaderCircle size={15} className="is-spinning" /> : dirty ? <Save size={15} /> : <Check size={15} />}
            <span>{saving ? '保存中' : dirty ? '保存地图' : '已保存'}</span>
          </button>
        </div>
      </header>

      <div className="map-toolbar">
        <div className="map-toolbar-group" role="toolbar" aria-label="地图工具">
          {TOOLS.map((item) => {
            const Icon = item.icon;
            const active = tool === item.id;
            return (
              <button
                key={item.id}
                type="button"
                className={'map-tool' + (active ? ' is-active' : '')}
                aria-pressed={active}
                title={item.hint}
                onClick={() => chooseTool(item.id)}
              >
                <Icon size={14} />
                <span>{item.label}</span>
              </button>
            );
          })}
        </div>
        <button
          type="button"
          className={'map-icon-btn' + (sideOpen ? ' is-on' : '')}
          onClick={() => setSideOpen((value) => !value)}
          aria-pressed={sideOpen}
          title={sideOpen ? '收起右侧面板（画布更宽）' : '展开右侧面板'}
        >
          <Layers size={15} /><span>面板</span>
        </button>
        <div className="map-toolbar-actions" role="group" aria-label="视图与编辑">
          <button type="button" className="map-icon-btn" onClick={undo} disabled={!canUndo()} title="撤销（Ctrl+Z）" aria-label="撤销">
            <Undo size={15} />
          </button>
          <button type="button" className="map-icon-btn" onClick={redo} disabled={!canRedo()} title="重做（Ctrl+Shift+Z）" aria-label="重做">
            <Redo size={15} />
          </button>
          <button type="button" className="map-icon-btn" onClick={fitToContent} title="适应内容" aria-label="适应内容">
            <ScanSearch size={15} />
          </button>
          <button
            type="button"
            className={'map-icon-btn' + (showGrid ? ' is-on' : '')}
            onClick={() => setShowGrid((value) => !value)}
            aria-pressed={showGrid}
            title="显示网格"
          >
            <Grid2 size={15} /><span>网格</span>
          </button>
          <button
            type="button"
            className={'map-icon-btn' + (snap ? ' is-on' : '')}
            onClick={() => setSnap((value) => !value)}
            aria-pressed={snap}
            title="落点吸附到网格"
          >
            <Magnet size={15} /><span>吸附</span>
          </button>
        </div>

        {tool === 'terrain' ? (
          <div className="map-toolbar-kinds" role="group" aria-label="地貌种类">
            {TERRAIN_KINDS.map((item) => (
              <button
                key={item.id}
                type="button"
                className={'map-kind' + (terrainKind === item.id ? ' is-active' : '')}
                aria-pressed={terrainKind === item.id}
                onClick={() => setTerrainKind(item.id)}
              >
                {item.label}
              </button>
            ))}
          </div>
        ) : null}

        {/* 绘制时的动作常驻顶栏：以前只在画布底部的浮条上，
            窗口一矮就得往下滚才能看到「完成」——画到一半很难受。 */}
        {draft ? (
          <div className="map-toolbar-draft" role="group" aria-label="绘制操作">
            <span className="map-toolbar-draft-label">
              {draft.kind === 'land' ? '画陆地' : draft.kind === 'river' ? '画河流' : '画路线'}
              <b>{draft.points.length} 点</b>
            </span>
            <button
              type="button"
              className="map-btn-ghost"
              onClick={undoDraftPoint}
              disabled={!draft.points.length}
            >撤销点</button>
            <button type="button" className="map-btn-solid" onClick={finishDraft} disabled={!canFinishDraft()}>
              完成
            </button>
            <button type="button" className="map-btn-ghost" onClick={cancelDraft}>取消</button>
          </div>
        ) : null}
        <p className="map-toolbar-hint">{activeTool.hint}</p>
      </div>

      <div className={'map-body' + (sideOpen ? '' : ' is-side-hidden')}>
        <div className="map-canvas">
          <svg
            ref={svgRef}
            className={'map-svg is-' + tool + (spacePressed ? ' is-space' : '')}
            viewBox={extent.x + ' ' + extent.y + ' ' + extent.width + ' ' + extent.height}
            preserveAspectRatio="xMidYMid meet"
            role="application"
            aria-label="世界地图编辑器：拖动平移，滚轮缩放，选中对象后可在右侧修改"
            onPointerDown={handlePointerDown}
            onPointerMove={handlePointerMove}
            onPointerUp={handlePointerUp}
            onPointerCancel={handlePointerCancel}
            onDoubleClick={handleDoubleClick}
            onContextMenu={(event) => event.preventDefault()}
          >
            <defs>
              {[0, 1, 2].map((index) => (
                <linearGradient key={index} id={'moshu-land-' + index} x1="0" y1="0" x2="0.92" y2="1">
                  <stop offset="0" className={'map-land-stop land-a' + index} />
                  <stop offset="0.58" className={'map-land-stop land-b' + index} />
                  <stop offset="1" className={'map-land-stop land-c' + index} />
                </linearGradient>
              ))}
              {/* 用 userSpaceOnUse + 固定向量：世界变宽时渐变不会被拉成一条细带。 */}
              <linearGradient id="moshu-sea" gradientUnits="userSpaceOnUse" x1={extent.x} y1={extent.y} x2={extent.x} y2={extent.y + Math.max(extent.height, 760)}>
                <stop offset="0" className="map-sea-stop sea-top" />
                <stop offset="1" className="map-sea-stop sea-bottom" />
              </linearGradient>

              <pattern id="moshu-waves" width="72" height="42" patternUnits="userSpaceOnUse">
                <path className="map-wave-path" d="M4 21 Q19 13 34 21 T64 21" />
              </pattern>
              <pattern id="moshu-grid" width={GRID} height={GRID} patternUnits="userSpaceOnUse">
                <path className="map-grid-path" d={'M ' + GRID + ' 0 L 0 0 0 ' + GRID} />
              </pattern>
              {TERRAIN_KINDS.map((kind) => (
                <pattern key={kind.id} id={'moshu-tex-' + kind.id} width="46" height="46" patternUnits="userSpaceOnUse">
                  {terrainTexture(kind.id)}
                </pattern>
              ))}
              {landClip ? (
                <clipPath id="moshu-land-clip">
                  <path d={landClip} />
                </clipPath>
              ) : null}
            </defs>

            <g className="map-viewport" transform={'translate(' + view.x + ' ' + view.y + ') scale(' + view.k + ')'}>
              {/* 海面与波浪必须是**世界坐标**里的东西：跟着平移/缩放一起动，
                  而不是像以前那样画在视口组外面、贴在屏幕上不动。
                  往外扩一大圈（SEA_PAD），平移时不会露出边缘；画的还是同一片海。 */}
              <rect className="map-sea" x={extent.x - SEA_PAD} y={extent.y - SEA_PAD} width={extent.width + SEA_PAD * 2} height={extent.height + SEA_PAD * 2} fill="url(#moshu-sea)" />
              <rect className="map-sea-waves" x={extent.x - SEA_PAD} y={extent.y - SEA_PAD} width={extent.width + SEA_PAD * 2} height={extent.height + SEA_PAD * 2} fill="url(#moshu-waves)" />
              {showGrid ? (
                <rect className="map-grid" x={extent.x} y={extent.y} width={extent.width} height={extent.height} fill="url(#moshu-grid)" pointerEvents="none" />
              ) : null}
              {layers.land ? <g className="map-layer map-layer-land">{map.landmasses.map(renderLand)}</g> : null}
              {layers.rivers ? <g className="map-layer map-layer-rivers">{map.rivers.map((river) => renderLine(river, 'river'))}</g> : null}
              {layers.forests ? <g className="map-layer map-layer-forests">{map.forests.map(renderForest)}</g> : null}
              {layers.terrain ? <g className="map-layer map-layer-terrain">{(map.terrain || []).map(renderTerrain)}</g> : null}
              {layers.mountains ? <g className="map-layer map-layer-mountains">{map.mountains.map(renderMountain)}</g> : null}
              {layers.props ? <g className="map-layer map-layer-props">{(map.props || []).map(renderProp)}</g> : null}
              {layers.decor ? <g className="map-layer map-layer-decor">{(map.decor || []).map(renderDecor)}</g> : null}
              {layers.routes ? <g className="map-layer map-layer-routes">{map.routes.map((route) => renderLine(route, 'route'))}</g> : null}
              {layers.locations ? <g className="map-layer map-layer-locations">{map.locations.map(renderLocation)}</g> : null}
              {renderDraft()}
              {renderVertexHandles()}
            </g>


          </svg>

          <div className="map-float map-zoom">
            <button type="button" onClick={() => zoomBy(1.25)} aria-label="放大">
              <Plus size={15} />
            </button>
            <button type="button" onClick={() => zoomBy(0.8)} aria-label="缩小">
              <span className="map-zoom-glyph">−</span>
            </button>
            <button type="button" onClick={resetView} aria-label="重置视图">
              <ScanSearch size={15} />
            </button>
          </div>

          <div className="map-float map-status">
            <span>{Math.round(view.k * 100) + '%'}</span>
            <span className="map-status-sep" />
            <span className="map-status-hint">{tool === 'select' ? '拖动平移 · 滚轮缩放 · 双击放大/加顶点' : '拖动平移 · 滚轮缩放'}</span>
            <span className="map-status-sep" />
            {/* 比例尺：100 画布单位 = 100 × scale 里（以前那个刻度条长度和数字没关系） */}
            <span className="map-scalebar" title="100 个画布单位对应的里数">
              <i />
              <span>{Math.round(100 * (Number(map.scale) || 0.5) * 10) / 10 + ' 里 / 100 单位'}</span>
            </span>
            {cursor ? (
              <React.Fragment>
                <span className="map-status-sep" />
                <span className="map-status-coord">{Math.round(cursor.x) + ', ' + Math.round(cursor.y)}</span>
              </React.Fragment>
            ) : null}
          </div>

          {tool === 'location' && !modal ? (
            <div className="map-hint"><Map size={13} /><span>点击放置</span></div>
          ) : null}

          {/* 空态卡片只是提示：开画之后让开画布（卡片本身 pointer-events:none，只有按钮可点）。 */}
          {!loading && !map.landmasses.length && !draft && tool === 'select' ? (
            <div className="map-empty">
              <span className="map-empty-icon"><Map size={20} /></span>
              <h2>空地图</h2>
              <p>{EMPTY_LAND_TIP}</p>
              <button type="button" className="map-btn-solid" onClick={() => chooseTool('land')}>
                <PenLine size={14} />
                <span>画陆地</span>
              </button>
            </div>
          ) : null}

          {draft ? (
            <div className="map-float map-draftbar">
              <div className="map-draftbar-head">
                <PenLine size={15} />
                <strong>{draft.kind === 'land' ? '画陆地' : draft.kind === 'river' ? '画河流' : '画路线'}</strong>
                <span className="map-draftbar-count">{draft.points.length + ' 个顶点'}</span>
                <button type="button" className="map-draftbar-close" onClick={cancelDraft} aria-label="取消绘制"><X size={15} /></button>
              </div>
              {draft.kind === 'river' || draft.kind === 'route' ? (
                <input
                  className="map-draftbar-name"
                  value={draft.name || ''}
                  maxLength={MAX_NAME}
                  placeholder={draft.kind === 'river' ? '河流名称' : '路线名称'}
                  aria-label={draft.kind === 'river' ? '河流名称' : '路线名称'}
                  onChange={(event) => setDraft((current) => (current ? { ...current, name: event.target.value } : current))}
                />
              ) : null}
              <div className="map-draftbar-actions">
                <button type="button" className="map-btn-ghost" onClick={undoDraftPoint} disabled={!draft.points.length}>撤销上一点</button>
                <button type="button" className="map-btn-solid" onClick={finishDraft} disabled={!canFinishDraft()}>完成</button>
              </div>
              <p>{draftRequirement()}</p>
            </div>
          ) : null}

          {loading ? (
            <div className="map-loading">
              <LoaderCircle className="is-spinning" size={22} />
              <span>正在展开世界地图…</span>
            </div>
          ) : null}
        </div>

        <aside className="map-side">
          <section className="map-side-block">
            <div className="map-side-head">
              <LibraryBig size={14} />
              <strong>图层</strong>
              <button
                type="button"
                className="map-side-toggle"
                aria-expanded={layersOpen}
                aria-label={layersOpen ? '收起图层' : '展开图层'}
                onClick={() => setLayersOpen((value) => !value)}
              >
                {layersOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
              </button>
            </div>
            {layersOpen ? (
              <div className="map-layer-grid">
                {LAYERS.map((layer) => {
                  const Icon = layer.icon;
                  const on = layers[layer.id] !== false;
                  return (
                    <button
                      key={layer.id}
                      type="button"
                      className={'map-layer' + (on ? ' is-on' : '')}
                      aria-pressed={on}
                      onClick={() => toggleLayer(layer.id)}
                    >
                      <Icon size={13} />
                      <span>{layer.label}</span>
                      <em className="map-layer-count">{layerCount(layer.id)}</em>
                    </button>
                  );
                })}
              </div>
            ) : null}
          </section>

          <section className="map-side-block map-side-inspector">
            {renderInspector()}
          </section>

          <section className="map-side-block map-side-places">
            <div className="map-side-head">
              <Map size={14} />
              <strong>地点</strong>
              <span className="map-side-count">{map.locations.length}</span>
            </div>
            <div className="map-search">
              <Search size={13} />
              <input
                value={query}
                aria-label="搜索地点"
                placeholder="搜索地点…"
                onChange={(event) => setQuery(event.target.value)}
              />
            </div>
            <div className="map-location-list">
              {filteredLocations.map((location) => (
                <button
                  key={location.id}
                  type="button"
                  className={'map-location-item' + (selection && selection.kind === 'location' && selection.id === location.id ? ' is-active' : '')}
                  onClick={() => {
                    setTool('select');
                    selectItem('location', location.id);
                  }}
                >
                  <span className={'map-dot map-cat-' + categoryOf(location.category)} aria-hidden="true" />
                  <span className="map-location-name">{location.name}</span>
                  <ChevronRight size={11} />
                </button>
              ))}
              {!filteredLocations.length ? (
                <p className="map-location-empty">{query.trim() ? '没有找到这个地点' : '还没有地点，用「地点」工具点一下地图。'}</p>
              ) : null}
            </div>
          </section>
        </aside>
      </div>

      {modal ? (
        <div className="map-modal" role="dialog" aria-label="标记一处地点" onClick={() => setModal(null)}>
          <form
            className="map-modal-card"
            onClick={(event) => event.stopPropagation()}
            onSubmit={addLocation}
          >
            <div className="map-modal-head">
              <div>
                <span className="map-kicker">新的世界碎片</span>
                <h2>标记一处地点</h2>
              </div>
              <button type="button" className="map-modal-close" onClick={() => setModal(null)} aria-label="关闭">
                <X size={16} />
              </button>
            </div>
            <label className="map-field">
              <span>地点名称</span>
              <input
                autoFocus
                required
                value={form.name}
                maxLength={MAX_NAME}
                placeholder="例如：风息谷"
                onChange={(event) => setForm({ ...form, name: event.target.value })}
              />
            </label>
            <label className="map-field">
              <span>地点类型</span>
              <select value={form.category} onChange={(event) => setForm({ ...form, category: event.target.value })}>
                {CATEGORIES.map((option) => <option key={option.id} value={option.id}>{option.label}</option>)}
              </select>
            </label>
            <label className="map-field">
              <span>地点描述</span>
              <textarea
                rows={4}
                value={form.description}
                placeholder="这里的传说、居民，或即将发生的故事…"
                onChange={(event) => setForm({ ...form, description: event.target.value })}
              />
            </label>
            <div className="map-modal-actions">
              <button type="button" className="map-btn-ghost" onClick={() => setModal(null)}>取消</button>
              <button type="submit" className="map-btn-solid" disabled={!form.name.trim()}>
                <Plus size={14} />
                <span>添加到地图</span>
              </button>
            </div>
            <p className="map-modal-note">{'坐标 ' + Math.round(modal.x) + ', ' + Math.round(modal.y)}</p>
          </form>
        </div>
      ) : null}

      {message ? (
        <div className={'map-toast' + (message.tone === 'error' ? ' is-error' : '')} role={message.tone === 'error' ? 'alert' : 'status'}>
          <span>{message.text}</span>
          <button type="button" onClick={() => setMessage(null)} aria-label="关闭提示"><X size={13} /></button>
        </div>
      ) : null}
    </section>
  );
}

module.exports = { MapView };
