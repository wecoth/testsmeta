// ─── ROOM.JS (v2 — автоматическое разделение комнат разделителями) ───
import { appState, ROOM_STROKES } from './state.js';
import { EventBus } from './eventBus.js';
import {
  findAllIntersections, buildWallGraph, findFaces,
  polygonArea, polygonSignedArea, polygonCentroid, isPointInPolygon, isPointInWall,
  polygonBboxArea,
} from './geometry.js';

let _wallHeightFallback = 2700;
export function setWallHeight(h) { _wallHeightFallback = (h && h > 0) ? h : 2700; }

export function roomDefaultName(index) { return `Комната ${index + 1}`; }

export function renameRoom(roomKey, nextName) {
  const room = appState.rooms.find(r => r.key === roomKey);
  if (!room) return;
  const normalized = (nextName || '').trim();
  if (!normalized || normalized === room.defaultName) {
    delete appState.roomNameOverrides[roomKey];
  } else {
    appState.roomNameOverrides[roomKey] = normalized;
  }
  for (const r of appState.rooms) {
    r.name = appState.roomNameOverrides[r.key] || r.defaultName;
  }
}

export let exteriorWallIds = new Set();

// ══════════════════════════════════════════════════════════════════
// ВСПОМОГАТЕЛЬНЫЕ ФУНКЦИИ (остаются без изменений)
// ══════════════════════════════════════════════════════════════════

function findAllWallsForEdge(ax, ay, bx, by, walls, eps = 8) {
  const midX = (ax + bx) / 2, midY = (ay + by) / 2;
  const edgeLen = Math.hypot(bx - ax, by - ay);
  if (edgeLen < 1) return [];
  const edUX = (bx - ax) / edgeLen, edUY = (by - ay) / edgeLen;
  const result = [];
  for (const w of walls) {
    const bx1 = w.cx1 ?? w.x1, by1 = w.cy1 ?? w.y1;
    const bx2 = w.cx2 ?? w.x2, by2 = w.cy2 ?? w.y2;
    const wLen = Math.hypot(bx2 - bx1, by2 - by1);
    if (wLen < 1) continue;
    const wUX = (bx2 - bx1) / wLen, wUY = (by2 - by1) / wLen;
    if (Math.abs(edUX * wUX + edUY * wUY) < 0.95) continue;

    const t = w.thickness || 0;
    const candidates = [{ x1: bx1, y1: by1 }];
    if (t > 0.5 && !w.isDivider) {
      const nx = -wUY, ny = wUX;
      const sign = w.offset === 'right' ? +1 : -1;
      candidates.push({ x1: bx1 + sign * nx * t, y1: by1 + sign * ny * t });
    }

    let matched = false;
    for (const c of candidates) {
      const dx = midX - c.x1, dy = midY - c.y1;
      const along = dx * wUX + dy * wUY;
      if (along < -eps || along > wLen + eps) continue;
      const perp = Math.abs(dx * (-wUY) + dy * wUX);
      if (perp > eps) continue;
      matched = true;
      break;
    }
    if (matched) result.push(w);
  }
  return result;
}

function clipWallAxisToPolygon(wall, polygon) {
  const result = [];
  if (!polygon || polygon.length < 3) return result;
  const seg = {
    x1: wall.cx1 ?? wall.x1, y1: wall.cy1 ?? wall.y1,
    x2: wall.cx2 ?? wall.x2, y2: wall.cy2 ?? wall.y2,
  };
  const len = Math.hypot(seg.x2 - seg.x1, seg.y2 - seg.y1);
  if (len < 0.5) return result;
  const ux = (seg.x2 - seg.x1) / len;
  const uy = (seg.y2 - seg.y1) / len;

  const ts = [0, 1];
  for (let i = 0; i < polygon.length; i++) {
    const a = polygon[i];
    const b = polygon[(i + 1) % polygon.length];
    const edge = { x1: a.x, y1: a.y, x2: b.x, y2: b.y };
    const inter = segmentIntersectionLocal(seg, edge);
    if (inter && inter.t > 0.001 && inter.t < 0.999) {
      ts.push(inter.t);
    }
  }

  for (const p of polygon) {
    const dx = p.x - seg.x1, dy = p.y - seg.y1;
    const along = dx * ux + dy * uy;
    if (along < -3 || along > len + 3) continue;
    const perp = Math.abs(dx * (-uy) + dy * ux);
    if (perp <= 3) {
      const t = Math.max(0, Math.min(1, along / len));
      ts.push(t);
    }
  }

  ts.sort((a, b) => a - b);

  for (let i = 0; i < ts.length - 1; i++) {
    const t1 = ts[i], t2 = ts[i + 1];
    if (t2 - t1 < 0.001) continue;
    const tm = (t1 + t2) / 2;
    const pm = { x: seg.x1 + ux * tm * len, y: seg.y1 + uy * tm * len };
    if (isPointInPolygon(pm, polygon) || isPointOnPolygonBoundary(pm, polygon, 3)) {
      result.push({
        x1: seg.x1 + ux * t1 * len,
        y1: seg.y1 + uy * t1 * len,
        x2: seg.x1 + ux * t2 * len,
        y2: seg.y1 + uy * t2 * len,
      });
    }
  }

  return result;
}

function segmentIntersectionLocal(a, b, eps = 0.001) {
  const r = { x: a.x2 - a.x1, y: a.y2 - a.y1 };
  const s = { x: b.x2 - b.x1, y: b.y2 - b.y1 };
  const denom = r.x * s.y - r.y * s.x;
  if (Math.abs(denom) < eps) return null;
  const qp = { x: b.x1 - a.x1, y: b.y1 - a.y1 };
  const t = (qp.x * s.y - qp.y * s.x) / denom;
  const u = (qp.x * r.y - qp.y * r.x) / denom;
  if (t < -eps || t > 1 + eps || u < -eps || u > 1 + eps) return null;
  return { x: a.x1 + r.x * t, y: a.y1 + r.y * t, t, u };
}

function projectPointOntoSegmentLocal(pt, seg) {
  const dx = seg.x2 - seg.x1, dy = seg.y2 - seg.y1;
  const len2 = dx*dx + dy*dy;
  if (len2 < 0.0001) return { distance: Math.hypot(pt.x - seg.x1, pt.y - seg.y1) };
  const t = ((pt.x - seg.x1)*dx + (pt.y - seg.y1)*dy) / len2;
  const clamped = Math.max(0, Math.min(1, t));
  const proj = { x: seg.x1 + dx*clamped, y: seg.y1 + dy*clamped };
  return { distance: Math.hypot(pt.x - proj.x, pt.y - proj.y) };
}

function isPointOnPolygonBoundary(pt, poly, eps = 1.0) {
  if (!poly || poly.length < 2) return false;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i], b = poly[(i+1)%poly.length];
    const seg = { x1: a.x, y1: a.y, x2: b.x, y2: b.y };
    const proj = projectPointOntoSegmentLocal(pt, seg);
    if (proj.distance < eps) return true;
  }
  return false;
}

function wallFootprintArea(wall, lengthMm) {
  return lengthMm * (wall.thickness || 0);
}

// ══════════════════════════════════════════════════════════════════
// ПОСТРОЕНИЕ КОМНАТ ПО ГРАФУ ИЗ ОСЕЙ СТЕН И РАЗДЕЛИТЕЛЕЙ
// ══════════════════════════════════════════════════════════════════

function getSlimWalls(walls, dividers) {
  const slimWalls = walls.map(w => ({
    id: w.id,
    x1: w.x1, y1: w.y1, x2: w.x2, y2: w.y2,
    cx1: w.cx1 ?? w.x1, cy1: w.cy1 ?? w.y1,
    cx2: w.cx2 ?? w.x2, cy2: w.cy2 ?? w.y2,
    // thickness=0: граф строится ТОЛЬКО по осям (cx/cy).
    // Реальная толщина используется только в метриках (computeRoomForPolygon).
    thickness: 0,
    height: w.height || _wallHeightFallback,
    offset: 'left',
    isDivider: false,
  }));

  const dividerWalls = dividers.map(d => ({
    id: `div_${d.id}`,
    x1: d.x1, y1: d.y1, x2: d.x2, y2: d.y2,
    cx1: d.x1, cy1: d.y1, cx2: d.x2, cy2: d.y2,
    thickness: 0,
    height: _wallHeightFallback,
    offset: 'left',
    isDivider: true,
  }));

  return [...slimWalls, ...dividerWalls];
}

/**
 * Создаёт комнаты для ВСЕХ замкнутых контуров, найденных в текущем графе.
 * Заменяет существующие комнаты (если есть) новыми.
 */
function rebuildAllRooms() {
  const walls = appState.walls;
  const dividers = appState.dividers || [];

  if (walls.length === 0 && dividers.length === 0) {
    appState.rooms = [];
    EventBus.emit('rooms:computed');
    return;
  }

  const allWallsForGraph = getSlimWalls(walls, dividers);
  if (allWallsForGraph.length < 3) {
    appState.rooms = [];
    EventBus.emit('rooms:computed');
    return;
  }

  try {
    const points = findAllIntersections(allWallsForGraph);
    if (!points || points.length < 3) {
      appState.rooms = [];
      EventBus.emit('rooms:computed');
      return;
    }
    const { vertices, edges } = buildWallGraph(allWallsForGraph, points);
    if (edges.length < 3) {
      appState.rooms = [];
      EventBus.emit('rooms:computed');
      return;
    }
    const faces = findFaces(vertices, edges);
    const newRooms = [];

    // Все стены и разделители для проверки принадлежности ребра
    const allWallsFlat = [...walls, ...(dividers.map(d => ({
      id: `div_${d.id}`, cx1: d.x1, cy1: d.y1, cx2: d.x2, cy2: d.y2,
      thickness: 0, offset: 'left', isDivider: true,
    })))];

    // Площадь самого большого фейса — это внешний контур, его пропускаем
    const faceAreas = faces.map(f => polygonArea(f.map(v => ({ x: v.x, y: v.y }))));
    const maxArea = Math.max(...faceAreas);

    for (let fi = 0; fi < faces.length; fi++) {
      const poly = faces[fi].map(v => ({ x: v.x, y: v.y }));
      const area = faceAreas[fi];

      if (area < 200000) continue; // мусорные фейсы < 0.2 м²
      if (area >= maxArea * 0.98) continue; // внешний фейс (самый большой)

      // Проверяем что хотя бы одно ребро полигона лежит на реальной стене/разделителе
      let hasWallEdge = false;
      for (let k = 0; k < poly.length; k++) {
        const a = poly[k], b = poly[(k + 1) % poly.length];
        const found = findAllWallsForEdge(a.x, a.y, b.x, b.y, allWallsFlat);
        if (found.length > 0) { hasWallEdge = true; break; }
      }
      if (!hasWallEdge) continue;

      const room = computeRoomForPolygon(poly);
      if (room) {
        newRooms.push(room);
      }
    }

    // Если нашли комнаты – заменяем; иначе оставляем старые (на случай, если граф не замкнут)
    if (newRooms.length > 0) {
      appState.rooms = newRooms;
    }
  } catch (e) {
    // При ошибке оставляем существующие комнаты
    console.warn('Ошибка при перестроении комнат:', e);
  }
  EventBus.emit('rooms:computed');
}

/**
 * Удаляет только те комнаты, чей полигон больше не существует в графе.
 */
function purgeInvalidRooms() {
  const walls = appState.walls;
  const dividers = appState.dividers || [];
  const allWallsForGraph = getSlimWalls(walls, dividers);
  if (allWallsForGraph.length < 3) {
    if (appState.rooms.length) {
      appState.rooms = [];
      EventBus.emit('rooms:computed');
    }
    return;
  }

  try {
    const points = findAllIntersections(allWallsForGraph);
    if (!points || points.length < 3) {
      appState.rooms = [];
      EventBus.emit('rooms:computed');
      return;
    }
    const { vertices, edges } = buildWallGraph(allWallsForGraph, points);
    if (edges.length < 3) {
      appState.rooms = [];
      EventBus.emit('rooms:computed');
      return;
    }
    const faces = findFaces(vertices, edges);
    const validKeys = new Set();

    for (const face of faces) {
      const poly = face.map(v => ({ x: v.x, y: v.y }));
      if (polygonArea(poly) < 200000) continue;
      const key = generateRoomKey(poly);
      validKeys.add(key);
    }

    const previousCount = appState.rooms.length;
    appState.rooms = appState.rooms.filter(room => validKeys.has(room.key));
    if (appState.rooms.length !== previousCount) {
      EventBus.emit('rooms:computed');
    }
  } catch (e) {
    // Ничего не делаем
  }
}

// Экспортируем для инструментов
export function computeRoomForPolygon(poly) {
  const walls = appState.walls;
  const dividers = appState.dividers || [];
  const wallHeightFallback = _wallHeightFallback;

  const dividerWalls = dividers.map(d => ({
    id: `div_${d.id}`,
    x1: d.x1, y1: d.y1, x2: d.x2, y2: d.y2,
    cx1: d.x1, cy1: d.y1, cx2: d.x2, cy2: d.y2,
    thickness: 0,
    height: wallHeightFallback,
    offset: 'left',
    isDivider: true,
  }));

  const allWalls = [...walls, ...dividerWalls];
  const boundaryWallIds = new Set();
  const boundaryWallsList = [];
  let hasDividers = false;

  for (let k = 0; k < poly.length; k++) {
    const a = poly[k];
    const b = poly[(k + 1) % poly.length];
    const edgeWalls = findAllWallsForEdge(a.x, a.y, b.x, b.y, allWalls);
    for (const w of edgeWalls) {
      if (w.isDivider) {
        hasDividers = true;
      } else if (!boundaryWallIds.has(w.id)) {
        boundaryWallIds.add(w.id);
        boundaryWallsList.push(w);
      }
    }
  }

  const interiorWalls = [];
  for (const w of walls) {
    if (boundaryWallIds.has(w.id)) continue;
    const clipped = clipWallAxisToPolygon(w, poly);
    let totalLen = 0;
    for (const seg of clipped) {
      totalLen += Math.hypot(seg.x2 - seg.x1, seg.y2 - seg.y1);
    }
    if (totalLen > 1) {
      interiorWalls.push({ wall: w, lengthMm: totalLen });
    }
  }

  let grossArea = polygonArea(poly);
  let netAreaMm2 = grossArea;

  for (const { wall, lengthMm } of interiorWalls) {
    netAreaMm2 -= wallFootprintArea(wall, lengthMm);
  }

  const roomOpenings = appState.openings.filter(op => boundaryWallIds.has(op.wallId));
  for (const op of roomOpenings) {
    if (op.type !== 'door') continue;
    const wall = boundaryWallsList.find(w => w.id === op.wallId);
    if (!wall) continue;
    const isInterior = !exteriorWallIds.has(op.wallId);
    if (isInterior) {
      netAreaMm2 += (op.width * (wall.thickness || 0)) / 2;
    } else {
      netAreaMm2 += op.width * (wall.thickness || 0);
    }
  }

  if (netAreaMm2 < 10000) return null;

  let totalLengthMm = 0, weightedHeightSum = 0;
  for (const w of boundaryWallsList) {
    const len = wallFullLengthMm(w);
    const h = w.height || wallHeightFallback;
    totalLengthMm += len;
    weightedHeightSum += len * h;
  }
  // Fallback: если граничные стены не нашлись (комната из разделителей или
  // float-погрешность в findAllWallsForEdge) — берём высоту из внутренних стен
  // или глобальный fallback.
  let heightMm;
  if (totalLengthMm > 0) {
    heightMm = weightedHeightSum / totalLengthMm;
  } else if (interiorWalls.length > 0) {
    heightMm = interiorWalls[0].wall.height || wallHeightFallback;
  } else {
    heightMm = wallHeightFallback;
  }

  const entranceDoorId = detectEntranceDoor(roomOpenings, exteriorWallIds);

  const metrics = computeRoomMetrics({
    boundaryWalls: boundaryWallsList,
    interiorWalls,
    openings: roomOpenings,
    heightMm,
    polygon: poly,
    entranceDoorId,
    hasDividers,
    netAreaMm2,
    exteriorWallIds,
  });

  const key = generateRoomKey(poly);
  const defaultName = roomDefaultName(appState.rooms.length + 1); // индекс для нового помещения
  const bbox = getBbox(poly);
  const center = polygonCentroid(poly);

  return {
    key,
    polygon: poly,
    cells: [{ x1: bbox.minX, y1: bbox.minY, x2: bbox.maxX, y2: bbox.maxY }],
    boundarySegments: boundaryWallsList.map(w => ({
      orientation: Math.abs(w.y2 - w.y1) < Math.abs(w.x2 - w.x1) ? 'h' : 'v',
      x1: Math.min(w.x1, w.x2), y1: Math.min(w.y1, w.y2),
      x2: Math.max(w.x1, w.x2), y2: Math.max(w.y1, w.y2),
      length: Math.hypot(w.x2 - w.x1, w.y2 - w.y1),
      wall: w,
    })),
    center,
    defaultName,
    name: appState.roomNameOverrides[key] || defaultName,
    area: netAreaMm2 / 1e6,
    volume: netAreaMm2 * heightMm / 1e9,
    height: heightMm / 1000,
    perimeter: metrics.perimeterFloorM,
    wallArea: metrics.wallAreaNetM2,
    openingsArea: metrics.openingsAreaM2,
    metrics,
    wallIds: [...boundaryWallIds],
    interiorWalls,
  };
}

// ══════════════════════════════════════════════════════════════════
// МЕТРИКИ КОМНАТ (без изменений)
// ══════════════════════════════════════════════════════════════════
function round2(v) { return Math.round(v * 100) / 100; }

function wallStart(w) { return { x: w.cx1 ?? w.x1, y: w.cy1 ?? w.y1 }; }
function wallEnd(w)   { return { x: w.cx2 ?? w.x2, y: w.cy2 ?? w.y2 }; }

function wallFullLengthMm(w) {
  const s = wallStart(w), e = wallEnd(w);
  return Math.hypot(e.x - s.x, e.y - s.y);
}

function computeRoomMetrics({
  boundaryWalls, interiorWalls, openings, heightMm, polygon,
  entranceDoorId, hasDividers, netAreaMm2,
}) {
  const heightM = heightMm / 1000;
  let perimeterMm = 0;
  for (let i = 0; i < polygon.length; i++) {
    const a = polygon[i], b = polygon[(i + 1) % polygon.length];
    perimeterMm += Math.hypot(b.x - a.x, b.y - a.y);
  }

  let wallAreaGrossM2 = 0;
  let narrowWallsLm = 0;
  const allWallsForEdge = [...boundaryWalls];
  let openingsAreaM2 = 0;
  let perimeterDeductMm = 0;
  let windowAreaM2 = 0, windowCount = 0, windowRevealsLm = 0;
  let entranceDoorAreaM2 = 0;

  for (const w of boundaryWalls) {
    const lenMm = hasDividers
      ? wallLengthInRoomMm(w, polygon, allWallsForEdge)
      : wallFullLengthMm(w);
    const lenM = lenMm / 1000;
    wallAreaGrossM2 += lenM * heightM;
  }

  for (const { wall, lengthMm } of interiorWalls) {
    const lenM = lengthMm / 1000;
    const thickM = (wall.thickness || 0) / 1000;
    wallAreaGrossM2 += 2 * lenM * heightM;
    wallAreaGrossM2 += 2 * thickM * heightM;
  }

  for (const op of openings) {
    const opArea = (op.width * op.height) / 1e6;
    openingsAreaM2 += opArea;
    if (op.type === 'door') {
      perimeterDeductMm += op.width;
      if (op.id === entranceDoorId) entranceDoorAreaM2 = opArea;
    } else if (op.type === 'window') {
      if (op.height >= heightMm * 0.95) perimeterDeductMm += op.width;
      windowAreaM2 += opArea;
      windowRevealsLm += (op.width + 2 * op.height) / 1000;
      windowCount++;
    }
  }

  for (const w of boundaryWalls) {
    const fullLen = wallFullLengthMm(w);
    const wallOps = openings
      .filter(op => op.wallId === w.id)
      .map(op => ({
        startMm: Math.max(0, (op.t * fullLen) - op.width / 2),
        endMm:   Math.min(fullLen, (op.t * fullLen) + op.width / 2),
      }))
      .filter(op => op.endMm > op.startMm)
      .sort((a, b) => a.startMm - b.startMm);
    let cursor = 0;
    for (const op of wallOps) {
      if (op.startMm > cursor + 0.5) {
        const gap = op.startMm - cursor;
        if (gap < 500) narrowWallsLm += heightM;
      }
      cursor = Math.max(cursor, op.endMm);
    }
    if (cursor < fullLen - 0.5) {
      const gap = fullLen - cursor;
      if (gap < 500) narrowWallsLm += heightM;
    }
  }

  const wallAreaNetM2 = Math.max(0, wallAreaGrossM2 - openingsAreaM2);
  const perimeterFloorM = Math.max(0, perimeterMm - perimeterDeductMm) / 1000;
  const cornerStats = computeCornerStats(polygon);
  const wallOuterCornersLm = round2(cornerStats.outer * heightM);
  let revealCornersLm = 0;
  for (const op of openings) {
    if (op.type === 'window') revealCornersLm += 2 * op.height / 1000;
  }
  const outerAnglesLm = round2(wallOuterCornersLm + revealCornersLm);
  const pogonazLm = round2(narrowWallsLm + windowRevealsLm);

  return {
    perimeterFloorM:    round2(perimeterFloorM),
    wallAreaNetM2:      round2(wallAreaNetM2),
    wallAreaGrossM2:    round2(wallAreaGrossM2),
    openingsAreaM2:     round2(openingsAreaM2),
    narrowWallsLm:      round2(narrowWallsLm),
    cornersInner:       cornerStats.inner,
    cornersOuter:       cornerStats.outer,
    outerAnglesLm,
    windowAreaM2:       round2(windowAreaM2),
    windowCount,
    windowRevealsLm:    round2(windowRevealsLm),
    pogonazLm,
    entranceDoorAreaM2: round2(entranceDoorAreaM2),
    entranceDoorId,
    heightM:            round2(heightM),
  };
}

function computeCornerStats(polygon) {
  const n = polygon.length;
  if (n < 3) return { inner: 0, outer: 0 };
  let inner = 0, outer = 0;
  let signedArea = 0;
  for (let i = 0; i < n; i++) {
    const a = polygon[i], b = polygon[(i + 1) % n];
    signedArea += a.x * b.y - b.x * a.y;
  }
  for (let i = 0; i < n; i++) {
    const prev = polygon[(i - 1 + n) % n];
    const curr = polygon[i];
    const next = polygon[(i + 1) % n];
    const dx1 = curr.x - prev.x, dy1 = curr.y - prev.y;
    const dx2 = next.x - curr.x, dy2 = next.y - curr.y;
    const cross = dx1 * dy2 - dy1 * dx2;
    if (Math.abs(cross) < 0.001) continue;
    const isInterior = signedArea < 0 ? cross < 0 : cross > 0;
    if (isInterior) inner++; else outer++;
  }
  return { inner, outer };
}

function detectEntranceDoor(openings, exteriorWallIds) {
  for (const op of openings) {
    if (op.type === 'door' && exteriorWallIds.has(op.wallId)) return op.id;
  }
  return null;
}

function generateRoomKey(poly) {
  const c = polygonCentroid(poly);
  return `${Math.round(c.x/50)*50},${Math.round(c.y/50)*50}`;
}

function getBbox(poly) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of poly) {
    minX = Math.min(minX, p.x); minY = Math.min(minY, p.y);
    maxX = Math.max(maxX, p.x); maxY = Math.max(maxY, p.y);
  }
  return { minX, minY, maxX, maxY };
}

function wallLengthInRoomMm(w, polygon, allWalls) {
  let total = 0;
  for (let k = 0; k < polygon.length; k++) {
    const a = polygon[k], b = polygon[(k + 1) % polygon.length];
    const edgeWalls = findAllWallsForEdge(a.x, a.y, b.x, b.y, allWalls);
    if (edgeWalls.some(ew => ew.id === w.id)) {
      total += Math.hypot(b.x - a.x, b.y - a.y);
    }
  }
  return total;
}

// ══════════════════════════════════════════════════════════════════
// DOM И ЭКСПОРТ
// ══════════════════════════════════════════════════════════════════
export function updateExpl(explBody, roomCountEl) {
  if (!explBody) return;
  if (roomCountEl) roomCountEl.textContent = appState.rooms.length;
  if (!appState.rooms.length) {
    explBody.innerHTML = `<tr class="empty-row"><td colspan="7">Нарисуйте замкнутый контур</td></tr>`;
    return;
  }
  explBody.innerHTML = appState.rooms.map((r, i) => {
    const m = r.metrics || {};
    const color = ROOM_STROKES[i % ROOM_STROKES.length].replace('0.4', '0.8');
    const fmt = v => (v != null && v > 0) ? v.toFixed(2) : '—';
    return `<tr>
      <td><div class="room-name-cell">
        <span class="room-dot" style="background:${color}"></span>
        <input class="room-name-input" type="text" value="${escHtml(r.name)}"
          data-room-key="${escHtml(r.key)}" data-room-default="${escHtml(r.defaultName)}">
      </div></td>
      <td>${r.area.toFixed(2)}</td>
      <td>${fmt(m.wallAreaNetM2 ?? r.wallArea)}</td>
      <td>${fmt(m.perimeterFloorM ?? r.perimeter)}</td>
      <td>${fmt(m.windowAreaM2)}</td>
      <td>${fmt(m.pogonazLm)}</td>
      <td>${fmt(m.outerAnglesLm)}</td>
    </tr>`;
  }).join('');
}

function escHtml(s) {
  return String(s || '')
    .replaceAll('&', '&amp;').replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;').replaceAll('"', '&quot;');
}

export function getComputedRooms() {
  return appState.rooms.map(r => {
    const m = r.metrics || {};
    return {
      name:            r.name,
      floorArea:       r.area,
      wallsArea:       m.wallAreaNetM2   ?? r.wallArea,
      perimeter:       m.perimeterFloorM ?? r.perimeter,
      height:          r.height          ?? 0,
      windowAreaM2:    m.windowAreaM2    ?? 0,
      windowCount:     m.windowCount     ?? 0,
      pogonazLm:       m.pogonazLm       ?? 0,
      outerAnglesLm:   m.outerAnglesLm   ?? 0,
      cornersOuter:    m.cornersOuter    ?? 0,
      narrowWallsLm:   m.narrowWallsLm   ?? 0,
      windowRevealsLm: m.windowRevealsLm ?? 0,
    };
  });
}

// ══════════════════════════════════════════════════════════════════
// РЕАКТИВНОСТЬ (переработанная)
// ══════════════════════════════════════════════════════════════════
let debounceTimer = null;
const DEBOUNCE_MS = 20;

EventBus.on('walls:changed', () => {
  if (debounceTimer) clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => {
    rebuildAllRooms();   // полное перестроение — новые замкнутые контуры появляются сразу
    debounceTimer = null;
  }, DEBOUNCE_MS);
});

EventBus.on('dividers:changed', () => {
  if (debounceTimer) clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => {
    rebuildAllRooms();        // полное перестроение комнат при добавлении/изменении разделителя
    debounceTimer = null;
  }, DEBOUNCE_MS);
});
