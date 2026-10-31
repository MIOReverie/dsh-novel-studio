'use strict';

/**
 * 地图编辑的纯函数。
 *
 * 放在这里而不是塞进 MapView.jsx：
 * - 这些是**数据变换**（合并陆地、重排图层、插入顶点、算包围盒），能脱离 React/DOM 精确测试；
 * - 组件里只剩"什么时候调用"。
 *
 * 坐标一律是画布坐标（0..width / 0..height），调用方负责裁剪。
 */

const MIN_RING = 3;

function clamp(value, min, max) {
  const number = Number(value);
  if (!Number.isFinite(number)) return min;
  return Math.max(min, Math.min(max, number));
}

/** 一个陆地的全部环：`points` 是主环，`rings` 是附加环（合并出来的、或挖洞的）。 */
function landRings(land) {
  if (!land || typeof land !== 'object') return [];
  const rings = [];
  if (Array.isArray(land.points) && land.points.length >= MIN_RING) rings.push(land.points);
  if (Array.isArray(land.rings)) {
    for (const ring of land.rings) {
      if (Array.isArray(ring) && ring.length >= MIN_RING) rings.push(ring);
    }
  }
  return rings;
}

/** 一个陆地的顶点总数（所有环）。 */
function landVertexCount(land) {
  return landRings(land).reduce((total, ring) => total + ring.length, 0);
}

/** 包围盒；空输入返回 null。 */
function boundsOf(rings) {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let seen = false;
  for (const ring of rings) {
    for (const point of ring || []) {
      if (!point || !Number.isFinite(point.x) || !Number.isFinite(point.y)) continue;
      seen = true;
      if (point.x < minX) minX = point.x;
      if (point.y < minY) minY = point.y;
      if (point.x > maxX) maxX = point.x;
      if (point.y > maxY) maxY = point.y;
    }
  }
  if (!seen) return null;
  return { minX, minY, maxX, maxY, width: maxX - minX, height: maxY - minY };
}

function boundsOverlap(a, b) {
  if (!a || !b) return false;
  return a.minX <= b.maxX && b.minX <= a.maxX && a.minY <= b.maxY && b.minY <= a.maxY;
}

/** 射线法：点是否在环内。 */
function pointInRing(point, ring) {
  if (!point || !Array.isArray(ring) || ring.length < MIN_RING) return false;
  let inside = false;
  for (let index = 0, prev = ring.length - 1; index < ring.length; prev = index, index += 1) {
    const a = ring[index];
    const b = ring[prev];
    if (!a || !b) continue;
    const intersects = (a.y > point.y) !== (b.y > point.y)
      && point.x < ((b.x - a.x) * (point.y - a.y)) / ((b.y - a.y) || 1e-9) + a.x;
    if (intersects) inside = !inside;
  }
  return inside;
}

/** 两个陆地是否真的重叠（先比包围盒，再看主环互相包含）。 */
function landsOverlap(a, b) {
  if (!a || !b || a.id === b.id) return false;
  const ringsA = landRings(a);
  const ringsB = landRings(b);
  if (!ringsA.length || !ringsB.length) return false;
  const boxA = boundsOf(ringsA);
  const boxB = boundsOf(ringsB);
  if (!boundsOverlap(boxA, boxB)) return false;
  /* 顶点落进对方环内，或者包围盒中心互含，都算重叠。 */
  for (const ring of ringsB) {
    for (const point of ring) {
      if (pointInRing(point, ringsA[0])) return true;
    }
  }
  for (const ring of ringsA) {
    for (const point of ring) {
      if (pointInRing(point, ringsB[0])) return true;
    }
  }
  const centerA = { x: (boxA.minX + boxA.maxX) / 2, y: (boxA.minY + boxA.maxY) / 2 };
  const centerB = { x: (boxB.minX + boxB.maxX) / 2, y: (boxB.minY + boxB.maxY) / 2 };
  return pointInRing(centerA, ringsB[0]) || pointInRing(centerB, ringsA[0]);
}

/**
 * 把 `source` 并进 `target`：
 * 结果是一个陆地 + 多个环。SVG 的 nonzero 填充规则下，重叠的环天然就是并集，
 * 不会有"上层的描边切过下层"的接缝——这正是两块陆地重叠时的毛病。
 *
 * 返回新的 target（不改入参）。
 */
function mergeLands(target, source) {
  if (!target || !source) return target;
  const rings = landRings(target);
  const extra = landRings(source);
  return {
    ...target,
    rings: rings.slice(1).concat(extra),
  };
}

/** 数组内移动一项，direction ∈ top/up/down/bottom。越界时原样返回。 */
function reorderItem(list, id, direction) {
  if (!Array.isArray(list)) return list;
  const index = list.findIndex((item) => item && item.id === id);
  if (index < 0) return list;
  let target = index;
  if (direction === 'top') target = list.length - 1; // 数组末尾 = 画在最上层
  else if (direction === 'bottom') target = 0;
  else if (direction === 'up') target = Math.min(list.length - 1, index + 1);
  else if (direction === 'down') target = Math.max(0, index - 1);
  if (target === index) return list;
  const next = list.slice();
  const [item] = next.splice(index, 1);
  next.splice(target, 0, item);
  return next;
}

/** 点到线段的距离与垂足。 */
function closestOnSegment(point, a, b) {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const lengthSquared = dx * dx + dy * dy;
  if (!lengthSquared) return { point: { x: a.x, y: a.y }, distance: Math.hypot(point.x - a.x, point.y - a.y) };
  let t = ((point.x - a.x) * dx + (point.y - a.y) * dy) / lengthSquared;
  t = clamp(t, 0, 1);
  const projected = { x: a.x + t * dx, y: a.y + t * dy };
  return { point: projected, distance: Math.hypot(point.x - projected.x, point.y - projected.y) };
}

/**
 * 在环里找离 `point` 最近的一条边，把顶点插进去。
 * @returns {{index:number, point:{x:number,y:number}, distance:number}|null}
 */
function insertVertexAt(ring, point) {
  if (!Array.isArray(ring) || ring.length < 2 || !point) return null;
  let best = null;
  for (let index = 0; index < ring.length; index += 1) {
    const a = ring[index];
    const b = ring[(index + 1) % ring.length];
    const hit = closestOnSegment(point, a, b);
    if (!best || hit.distance < best.distance) {
      best = { index: index + 1, point: hit.point, distance: hit.distance };
    }
  }
  return best;
}

/** 把点吸附到网格。 */
function snapPoint(point, grid, enabled) {
  if (!enabled || !(grid > 0)) return point;
  return { x: Math.round(point.x / grid) * grid, y: Math.round(point.y / grid) * grid };
}

/** 整体平移（自动夹在画布内，保持形状不变形）。 */
function translateRing(ring, dx, dy, width, height) {
  const box = boundsOf([ring]);
  if (!box) return ring;
  const safeDx = clamp(dx, -box.minX, width - box.maxX);
  const safeDy = clamp(dy, -box.minY, height - box.maxY);
  return ring.map((point) => ({ x: point.x + safeDx, y: point.y + safeDy }));
}

/**
 * 适应内容：算出让 bbox 塞进画布所需的平移与缩放。
 * @returns {{x:number,y:number,k:number}}
 */
function fitView(rings, width, height, padding = 60, frame) {
  const box = boundsOf(rings);
  if (!box) return { x: 0, y: 0, k: 1 };
  /* frame：视口在世界坐标里的框（世界无边界时它不是从 0,0 开始的）。 */
  const baseX = frame && Number.isFinite(frame.x) ? frame.x : 0;
  const baseY = frame && Number.isFinite(frame.y) ? frame.y : 0;
  const usableW = Math.max(40, width - padding * 2);
  const usableH = Math.max(40, height - padding * 2);
  const k = Math.max(0.2, Math.min(6, Math.min(usableW / Math.max(box.width, 1), usableH / Math.max(box.height, 1))));
  /* 视图变换是 translate(x y) scale(k)：内容点 p 显示在 x + p*k。 */
  const centerX = (box.minX + box.maxX) / 2;
  const centerY = (box.minY + box.maxY) / 2;
  const frameCenterX = baseX + width / 2;
  const frameCenterY = baseY + height / 2;
  return {
    x: frameCenterX - centerX * k,
    y: frameCenterY - centerY * k,
    k,
  };
}

/** 一个陆地的所有环 → 可走 `boundsOf` 的数组。 */
function ringsOfLands(landmasses) {
  const rings = [];
  for (const land of Array.isArray(landmasses) ? landmasses : []) rings.push(...landRings(land));
  return rings;
}

module.exports = {
  MIN_RING,
  landRings,
  landVertexCount,
  boundsOf,
  boundsOverlap,
  pointInRing,
  landsOverlap,
  mergeLands,
  reorderItem,
  closestOnSegment,
  insertVertexAt,
  snapPoint,
  translateRing,
  fitView,
  ringsOfLands,
};
