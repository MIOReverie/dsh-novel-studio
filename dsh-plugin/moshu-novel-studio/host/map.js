/**
 * 墨枢 Host 半：地图数据的形状与校验（唯一出处）。
 *
 * 地图从 v1 的「写死在 SVG 里的底图 + 可拖动的地点」升级成 **全部由数据绘制**：
 * 陆地是多边形，山脉/森林是图章，河流/路线是折线，地点是点。
 * 这样作者能改地形，AI 也能"画"出一整块大陆。
 *
 * 形状（v2）：
 * {
 *   name, width, height, scale,
 *   landmasses: [{ id, name, points:[{x,y}], rings?, tone? }], // 闭合多边形（rings = 附加环，合并/挖洞）
 *   mountains:  [{ id, x, y, scale? }],
 *   forests:    [{ id, x, y }],
 *   terrain:    [{ id, type, points } | { id, type, x, y, scale? }],  // 地貌面（优先）或旧的点
 *   props:      [{ id, type, x, y, scale? }],   // 独立图章（雪峰/松树/岩石…）
 *   decor:      [{ id, assetId, x, y, scale?, rotation? }], // AI 画的装饰图（引用素材库）
 *   rivers:     [{ id, name, points:[{x,y}] }],
 *   routes:     [{ id, name, color, points:[{x,y}] }],
 *   locations:  [{ id, name, x, y, category, description, color, chapterIds }]
 * }
 *
 * 所有坐标都落在 0..width / 0..height 的画布坐标系里（不再有 0..100 的百分比）。
 */
import { HttpError } from './errors.js';

export const CANVAS = Object.freeze({ width: 1200, height: 760 });

/** 数量上限：防止一份坏数据把渲染拖死。 */
export const LIMITS = Object.freeze({
  landmasses: 24,
  landPoints: 400,
  stamps: 400,
  rivers: 80,
  riverPoints: 400,
  routes: 200,
  routePoints: 400,
  locations: 400,
});

const isFiniteNumber = (value) => typeof value === 'number' && Number.isFinite(value);

/** 可绘制范围的一半（世界地图没有边界，只有防爆上限）。 */
const WORLD_LIMIT = 100000;

function asCoord(value, max, label) {
  /* 只接受真正的数字/number 字符串：`Number(null)` 是 0，
     会让空输入的地点被钉到画布左上角，而不是报错。 */
  if (value === null || value === undefined || value === '') {
    throw new HttpError(400, `${label} 不能为空。`);
  }
  const number = Number(value);
  if (!Number.isFinite(number)) throw new HttpError(400, `${label} 必须是数字。`);
  /* 画布不再有硬边界：世界地图本来就可以画到初始视口之外。
     只留一个防爆上限（±100000），避免一个坏坐标把渲染拖垮。 */
  if (number < -WORLD_LIMIT || number > WORLD_LIMIT) {
    throw new HttpError(400, `${label} 超出可绘制范围（±${WORLD_LIMIT}）。`);
  }
  return Math.round(number * 100) / 100;
}

/**
 * 读旧数据时的宽松归一化：缺什么补什么，从不抛错。
 * 渲染和"读给模型看"都走它。
 * @param {unknown} raw
 */
export function normalizeMap(raw) {
  const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const width = isFiniteNumber(source.width) ? source.width : CANVAS.width;
  const height = isFiniteNumber(source.height) ? source.height : CANVAS.height;

  /* v1 文件没有 width/height，坐标是 0..100 的百分比；v2 一律写画布单位。
   *
   * 不能只看"有没有 width"：AI 或前端新写的地图可能没带 width，但坐标已经是画布单位
   * （400 这种），按百分比再放大 12 倍就会整张飞出画布（实测过：x=400 变成 4800 被拒）。
   * 所以要求两个证据同时成立才迁移：**缺 width** 且 **所有坐标都 ≤ 100**。 */
  const everyCoord = (list, key) => (Array.isArray(list) ? list : [])
    .map((item) => (key ? item?.[key] : item))
    .filter((point) => point && isFiniteNumber(Number(point.x)) && isFiniteNumber(Number(point.y)));
  const allPoints = [
    ...everyCoord(source.landmasses).flatMap((land) => everyCoord(land?.points)),
    ...everyCoord(source.landmasses).flatMap((land) => (Array.isArray(land?.rings) ? everyCoord(land.rings.flat()) : [])),
    ...everyCoord(source.mountains),
    ...everyCoord(source.forests),
    ...everyCoord(source.rivers).flatMap((line) => everyCoord(line?.points)),
    ...everyCoord(source.routes).flatMap((line) => everyCoord(line?.points)),
    ...everyCoord(source.locations),
  ];
  const withinPercent = allPoints.length > 0 && allPoints.every((point) => Number(point.x) <= 100 && Number(point.y) <= 100);
  const legacyPercent = !isFiniteNumber(source.width) && withinPercent;
  const sx = legacyPercent ? width / 100 : 1;
  const sy = legacyPercent ? height / 100 : 1;

  const points = (list) => (Array.isArray(list) ? list : [])
    .filter((point) => point && isFiniteNumber(Number(point.x)) && isFiniteNumber(Number(point.y)))
    .map((point) => ({ x: Number(point.x) * sx, y: Number(point.y) * sy }));

  const landmasses = (Array.isArray(source.landmasses) ? source.landmasses : [])
    .filter((item) => item && typeof item === 'object')
    .map((item, index) => {
      /* 附加环：一块陆地可以由多个多边形组成（合并出来的大陆，或挖出来的洞）。
         SVG 的 nonzero 填充下，重叠的环天然是并集 —— 这正是「两块陆地重叠」的正确画法。 */
      const extraRings = (Array.isArray(item.rings) ? item.rings : [])
        .map((ring) => points(ring))
        .filter((ring) => ring.length >= 3);
      return {
        id: typeof item.id === 'string' && item.id ? item.id : `land-${index + 1}`,
        name: typeof item.name === 'string' && item.name ? item.name : `陆地 ${index + 1}`,
        points: points(item.points),
        ...(extraRings.length ? { rings: extraRings } : {}),
        ...(typeof item.tone === 'string' && item.tone ? { tone: item.tone } : {}),
      };
    })
    .filter((item) => item.points.length >= 3);

  const stamps = (list, prefix) => (Array.isArray(list) ? list : [])
    .filter((item) => item && isFiniteNumber(Number(item.x)) && isFiniteNumber(Number(item.y)))
    .map((item, index) => ({
      id: typeof item.id === 'string' && item.id ? item.id : `${prefix}-${index + 1}`,
      x: Number(item.x) * sx,
      y: Number(item.y) * sy,
      ...(isFiniteNumber(Number(item.scale)) ? { scale: Number(item.scale) } : {}),
      /* 地貌种类：hill/plateau/desert/… 由客户端渲染成不同图形。
         山脉/森林沿用各自的列表，不带 type。 */
      ...(typeof item.type === 'string' && item.type ? { type: item.type } : {}),
      ...(isFiniteNumber(Number(item.rotation)) ? { rotation: Number(item.rotation) } : {}),
    }));

  const lines = (list, prefix, withName) => (Array.isArray(list) ? list : [])
    .filter((item) => item && typeof item === 'object')
    .map((item, index) => ({
      id: typeof item.id === 'string' && item.id ? item.id : `${prefix}-${index + 1}`,
      ...(withName ? { name: typeof item.name === 'string' && item.name ? item.name : `${prefix} ${index + 1}` } : {}),
      ...(typeof item.color === 'string' && item.color ? { color: item.color } : {}),
      /* 河宽（画布单位）：1 = 细，3 = 宽。缺省由客户端按类型给默认值。 */
      ...(isFiniteNumber(Number(item.width)) ? { width: Math.max(0.2, Math.min(12, Number(item.width))) } : {}),
      points: points(item.points),
    }))
    .filter((item) => item.points.length >= 2);

  const decorList = (list) => (Array.isArray(list) ? list : [])
    .filter((item) => item && typeof item === 'object')
    .map((item, index) => ({
      id: typeof item.id === 'string' && item.id ? item.id : `decor-${index + 1}`,
      assetId: typeof item.assetId === 'string' ? item.assetId : '',
      x: Number(item.x) || 0,
      y: Number(item.y) || 0,
      ...(isFiniteNumber(Number(item.scale)) ? { scale: Number(item.scale) } : {}),
      ...(isFiniteNumber(Number(item.rotation)) ? { rotation: Number(item.rotation) } : {}),
    }))
    .filter((item) => item.assetId && Number.isFinite(item.x) && Number.isFinite(item.y));

  const terrainList = (list) => (Array.isArray(list) ? list : [])
    .filter((item) => item && typeof item === 'object')
    .map((item, index) => {
      const type = typeof item.type === 'string' && item.type ? item.type : 'hill';
      const ring = points(item.points);
      if (ring.length >= 3) {
        const extraRings = (Array.isArray(item.rings) ? item.rings : []).map((each) => points(each)).filter((each) => each.length >= 3);
        return {
          id: typeof item.id === 'string' && item.id ? item.id : `terrain-${index + 1}`,
          type,
          points: ring,
          ...(extraRings.length ? { rings: extraRings } : {}),
        };
      }
      if (!isFiniteNumber(Number(item.x)) || !isFiniteNumber(Number(item.y))) return null;
      return {
        id: typeof item.id === 'string' && item.id ? item.id : `terrain-${index + 1}`,
        type,
        x: Number(item.x) * sx,
        y: Number(item.y) * sy,
        ...(isFiniteNumber(Number(item.scale)) ? { scale: Number(item.scale) } : {}),
      };
    })
    .filter(Boolean);

  const locations = (Array.isArray(source.locations) ? source.locations : [])
    .filter((item) => item && typeof item === 'object')
    .map((item, index) => ({
      ...item,
      id: typeof item.id === 'string' && item.id ? item.id : `loc-${index + 1}`,
      name: typeof item.name === 'string' && item.name ? item.name : `地点 ${index + 1}`,
      x: Number(item.x) * sx,
      y: Number(item.y) * sy,
      category: item.category || item.type || 'other',
      chapterIds: Array.isArray(item.chapterIds) ? item.chapterIds : (item.chapter ? [item.chapter] : []),
    }))
    .filter((item) => isFiniteNumber(item.x) && isFiniteNumber(item.y));

  return {
    name: typeof source.name === 'string' && source.name ? source.name : '未命名大陆',
    width,
    height,
    scale: isFiniteNumber(source.scale) ? source.scale : 0.5,
    landmasses,
    mountains: stamps(source.mountains, 'mt'),
    forests: stamps(source.forests, 'forest'),
    /* 更多地貌：丘陵 / 高原 / 沙漠 / 沼泽 / 苔原 / 冰川 / 火山 / 峡谷 / 草原。
       两种形态都收：points（面，界面里画出来的）与 x/y（点，早期/AI 盖章）。 */
    terrain: terrainList(source.terrain),
    /* 独立图章：{id, type, x, y, scale?}，和山脉/森林同级但种类更多。 */
    props: stamps(source.props, 'prop'),
    /* 装饰图：引用素材库里的一张 SVG，贴在世界坐标上（AI 可以整张画出来的东西）。 */
    decor: decorList(source.decor),
    rivers: lines(source.rivers, 'river', true),
    routes: lines(source.routes, 'route', true),
    locations,
  };
}

/**
 * 严格校验（写盘前调用）。归一化仍发生在这里，所以调用方拿到的是可落盘的数据。
 * @param {unknown} raw
 * @returns {ReturnType<typeof normalizeMap>}
 */
export function validateMap(raw) {
  const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const map = normalizeMap(source);

  const dirs = (list, label, max) => {
    if (!Array.isArray(list)) throw new HttpError(400, `${label} 必须是数组。`);
    if (list.length > max) throw new HttpError(400, `${label} 最多 ${max} 个。`);
    return list;
  };

  /* 每个集合都先校验「原始值必须是数组」再去归一化。
     以前只查 landmasses，其余用归一化后的空数组兜底，于是
     `{locations:'不是数组'}` 会被当成「0 个地点」直接落盘，把整张地图清空。 */
  for (const [key, label] of [
    ['landmasses', 'landmasses'],
    ['mountains', 'mountains'],
    ['forests', 'forests'],
    ['terrain', 'terrain'],
    ['rivers', 'rivers'],
    ['routes', 'routes'],
    ['locations', 'locations'],
  ]) {
    const value = source[key];
    if (value !== undefined && value !== null && !Array.isArray(value)) {
      throw new HttpError(400, `地图的 ${label} 必须是数组（收到的是 ${typeof value}）。`);
    }
  }
  /* 坐标必须在**原始数据**上就是数字：normalizeMap 会把 `null` 变成 0
     （`Number(null) === 0`），于是空输入的地点会被悄悄钉到画布左上角。 */
  const rawPoints = (list, label) => {
    if (!Array.isArray(list)) return;
    for (const point of list) {
      if (!point || typeof point !== 'object') continue;
      for (const axis of ['x', 'y']) {
        const value = point[axis];
        if (value === null || value === undefined || value === '') {
          throw new HttpError(400, `${label}的坐标 ${axis} 不能为空。`);
        }
        if (!Number.isFinite(Number(value))) {
          throw new HttpError(400, `${label}的坐标 ${axis} 必须是数字。`);
        }
      }
    }
  };
  rawPoints(Array.isArray(source.locations) ? source.locations : [], '地点');
  rawPoints(Array.isArray(source.mountains) ? source.mountains : [], '山脉');
  rawPoints(Array.isArray(source.forests) ? source.forests : [], '森林');
  /* 地貌有两种形态：面（校验顶点坐标）和点（校验 x/y），不能混着按点校验。 */
  rawPoints(Array.isArray(source.props) ? source.props : [], '图章');
  rawPoints(Array.isArray(source.decor) ? source.decor : [], '装饰');
  for (const item of Array.isArray(source.terrain) ? source.terrain : []) {
    if (!item || typeof item !== 'object') continue;
    if (Array.isArray(item.points)) rawPoints(item.points, '地貌顶点');
    else rawPoints([item], '地貌');
  }
  for (const land of Array.isArray(source.landmasses) ? source.landmasses : []) {
    rawPoints(Array.isArray(land?.points) ? land.points : [], '陆地顶点');
  }
  for (const key of ['rivers', 'routes']) {
    for (const line of Array.isArray(source[key]) ? source[key] : []) {
      rawPoints(Array.isArray(line?.points) ? line.points : [], key === 'rivers' ? '河流点' : '路线点');
    }
  }

  dirs(source.landmasses || [], 'landmasses', LIMITS.landmasses);
  /* 先按**原始**数据校验顶点数：normalizeMap 会把不足 3 个点的陆地过滤掉，
     那样作者的坏多边形会被静默丢弃——这比报错更糟。 */
  for (const [index, raw] of (Array.isArray(source.landmasses) ? source.landmasses : []).entries()) {
    const list = Array.isArray(raw?.points) ? raw.points : [];
    const label = typeof raw?.name === 'string' && raw.name ? raw.name : `第 ${index + 1} 块陆地`;
    if (list.length < 3) throw new HttpError(400, `陆地「${label}」至少要 3 个顶点（收到 ${list.length} 个）。`);
    if (list.length > LIMITS.landPoints) throw new HttpError(400, `陆地「${label}」顶点超过 ${LIMITS.landPoints} 个。`);
  }
  for (const land of map.landmasses) {
    for (const point of land.points) {
      asCoord(point.x, map.width, '陆地顶点 x');
      asCoord(point.y, map.height, '陆地顶点 y');
    }
  }

  for (const [list, label] of [[map.mountains, 'mountains'], [map.forests, 'forests']]) {
    dirs(list, label, LIMITS.stamps);
    for (const item of list) {
      asCoord(item.x, map.width, `${label} x`);
      asCoord(item.y, map.height, `${label} y`);
    }
  }

  for (const [list, label, max] of [[map.rivers, 'rivers', LIMITS.rivers], [map.routes, 'routes', LIMITS.routes]]) {
    dirs(list, label, max);
    for (const line of list) {
      if (line.points.length < 2) throw new HttpError(400, `${label} 里每条线至少要 2 个点。`);
      if (line.points.length > LIMITS.riverPoints) throw new HttpError(400, `${label} 里每条线最多 ${LIMITS.riverPoints} 个点。`);
      for (const point of line.points) {
        asCoord(point.x, map.width, `${label} 点 x`);
        asCoord(point.y, map.height, `${label} 点 y`);
      }
    }
  }

  dirs(map.locations, 'locations', LIMITS.locations);
  const seenIds = new Set();
  for (const [list, label] of [[map.landmasses, '陆地'], [map.locations, '地点'], [map.rivers, '河流'], [map.routes, '路线']]) {
    const ids = new Set();
    for (const item of list) {
      if (typeof item.id !== 'string' || !item.id) continue;
      if (ids.has(item.id)) throw new HttpError(400, `${label}里有重复的 id「${item.id}」。`);
      ids.add(item.id);
      seenIds.add(item.id);
    }
  }
  for (const location of map.locations) {
    if (typeof location.id !== 'string' || !location.id) throw new HttpError(400, '每个地点都要有 id。');
    if (typeof location.name !== 'string' || !location.name) throw new HttpError(400, '每个地点都要有 name。');
    asCoord(location.x, map.width, '地点 x');
    asCoord(location.y, map.height, '地点 y');
  }

  return map;
}

/**
 * 给模型看的地图摘要（坐标是画布系，AI 据此画新地形）。
 * @param {ReturnType<typeof normalizeMap>} map
 */
export function describeMap(map) {
  const line = (value) => `(${Math.round(value.x)},${Math.round(value.y)})`;
  const rows = [];
  rows.push(`# 地图：${map.name}`);
  rows.push(`画布 ${map.width}×${map.height}（左上角是 0,0，右下角是 ${map.width},${map.height}；比例 1 单位 ≈ ${map.scale} 里）`);
  rows.push('');
  rows.push(`## 陆地 ${map.landmasses.length} 块`);
  for (const land of map.landmasses) {
    rows.push(`- ${land.name}（${land.id}）：${land.points.length} 个顶点，顶点 ${land.points.slice(0, 8).map(line).join(' ')}${land.points.length > 8 ? ' …' : ''}`);
  }
  rows.push('');
  rows.push(`## 地点 ${map.locations.length} 个`);
  for (const location of map.locations) {
    rows.push(`- ${location.name}（${location.id}，${location.category}）${line(location)}${location.description ? `：${String(location.description).slice(0, 60)}` : ''}`);
  }
  rows.push('');
  rows.push(`## 山脉 ${map.mountains.length} 处 / 森林 ${map.forests.length} 处 / 河流 ${map.rivers.length} 条 / 路线 ${map.routes.length} 条`);
  for (const river of map.rivers) rows.push(`- 河流 ${river.name}：${river.points.map(line).join(' ')}`);
  for (const route of map.routes) rows.push(`- 路线 ${route.name}：${route.points.map(line).join(' ')}`);
  return rows.join('\n');
}
