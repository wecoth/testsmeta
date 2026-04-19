// ─── WALL.JS ──────────────────────────────────────────────────────
import { appState } from './state.js';
import { clamp, applyWallOffset, segmentIntersection } from './geometry.js';

// ── Contour helpers ──────────────────────────────────────────────

export function getWallContourPoint(wall, endpoint) {
  return endpoint === 'start'
    ? { x: wall.cx1 ?? wall.x1, y: wall.cy1 ?? wall.y1 }
    : { x: wall.cx2 ?? wall.x2, y: wall.cy2 ?? wall.y2 };
}

export function getWallContourEndpoints(wall) {
  return [
    getWallContourPoint(wall, 'start'),
    getWallContourPoint(wall, 'end'),
  ];
}

export function getWallContourSegment(wall) {
  return {
    x1: wall.cx1 ?? wall.x1, y1: wall.cy1 ?? wall.y1,
    x2: wall.cx2 ?? wall.x2, y2: wall.cy2 ?? wall.y2,
  };
}

export function getWallContourMidpoint(wall) {
  const s = getWallContourSegment(wall);
  return { x: (s.x1 + s.x2) / 2, y: (s.y1 + s.y2) / 2 };
}

export function getWallLength(wall) {
  const s = getWallContourPoint(wall, 'start');
  const e = getWallContourPoint(wall, 'end');
  return Math.hypot(e.x - s.x, e.y - s.y);
}

export function getWallOffsetMode(wall) {
  if (wall.offset === 'left' || wall.offset === 'center' || wall.offset === 'right') {
    return wall.offset;
  }
  const start = getWallContourPoint(wall, 'start');
  const end   = getWallContourPoint(wall, 'end');
  const len   = Math.hypot(end.x - start.x, end.y - start.y);
  if (len < 0.001) return 'center';
  const normal = { x: -(end.y - start.y) / len, y: (end.x - start.x) / len };
  const signedOffset = (wall.x1 - start.x) * normal.x + (wall.y1 - start.y) * normal.y;
  const halfT = (wall.thickness || 0) / 2;
  if (signedOffset > halfT * 0.35) return 'right';
  if (signedOffset < -halfT * 0.35) return 'left';
  return 'center';
}

// ── World geometry (corners a b c d) ─────────────────────────────

export function getWallWorldGeometry(wall) {
  const angle = Math.atan2(wall.y2 - wall.y1, wall.x2 - wall.x1);
  const halfT = wall.thickness / 2;
  const dx = -Math.sin(angle) * halfT;
  const dy =  Math.cos(angle) * halfT;
  return {
    p1: { x: wall.x1, y: wall.y1 },
    p2: { x: wall.x2, y: wall.y2 },
    angle, halfT,
    a: { x: wall.x1 + dx, y: wall.y1 + dy },
    b: { x: wall.x2 + dx, y: wall.y2 + dy },
    c: { x: wall.x2 - dx, y: wall.y2 - dy },
    d: { x: wall.x1 - dx, y: wall.y1 - dy },
  };
}

export function getWallCornerPoints(wall) {
  const g = getWallWorldGeometry(wall);
  return [g.a, g.b, g.c, g.d];
}

export function getWallWorldBounds(wall) {
  const g = getWallWorldGeometry(wall);
  const pts = [g.a, g.b, g.c, g.d];
  return {
    minX: Math.min(...pts.map(p => p.x)),
    maxX: Math.max(...pts.map(p => p.x)),
    minY: Math.min(...pts.map(p => p.y)),
    maxY: Math.max(...pts.map(p => p.y)),
  };
}

export function getWallSnapSegments(wall) {
  const g = getWallWorldGeometry(wall);
  return [
    // wallAxis всегда по базовой линии (cx1/cy1) — не сдвигается при смене offset/thickness
    { type: 'wallAxis', segment: {
        x1: wall.cx1 ?? wall.x1, y1: wall.cy1 ?? wall.y1,
        x2: wall.cx2 ?? wall.x2, y2: wall.cy2 ?? wall.y2,
    }},
    { type: 'wallFace', segment: { x1: g.a.x, y1: g.a.y, x2: g.b.x, y2: g.b.y } },
    { type: 'wallFace', segment: { x1: g.d.x, y1: g.d.y, x2: g.c.x, y2: g.c.y } },
  ];
}

// ── Surface tests ─────────────────────────────────────────────────

export function isPointInsideWallSurface(point, wall, padding = 0.75) {
  const start = { x: wall.x1, y: wall.y1 };
  const end   = { x: wall.x2, y: wall.y2 };
  const dx = end.x - start.x, dy = end.y - start.y;
  const len = Math.hypot(dx, dy);
  if (len < 0.0001) {
    return Math.hypot(point.x - start.x, point.y - start.y) <= wall.thickness / 2 + padding;
  }
  const ux = dx / len, uy = dy / len;
  const nx = -uy, ny = ux;
  const relX = point.x - start.x, relY = point.y - start.y;
  const along  = relX * ux + relY * uy;
  const normal = relX * nx + relY * ny;
  return along >= -padding && along <= len + padding && Math.abs(normal) <= wall.thickness / 2 + padding;
}

export function isWallEndpointCoveredByAnotherWall(wall, endpoint) {
  const point = endpoint === 'start'
    ? { x: wall.cx1 ?? wall.x1, y: wall.cy1 ?? wall.y1 }
    : { x: wall.cx2 ?? wall.x2, y: wall.cy2 ?? wall.y2 };
  return appState.walls.some(other => other.id !== wall.id && isPointInsideWallSurface(point, other));
}

// ── Joint map ────────────────────────────────────────────────────

export function getWallJointPoint(wall, endpoint) {
  return endpoint === 'start'
    ? { x: wall.cx1 ?? wall.x1, y: wall.cy1 ?? wall.y1 }
    : { x: wall.cx2 ?? wall.x2, y: wall.cy2 ?? wall.y2 };
}

export function getWallJointKey(point) {
  return `${Math.round(point.x)},${Math.round(point.y)}`;
}

export function buildWallJointMap() {
  const joints = new Map();
  for (const wall of appState.walls) {
    for (const endpoint of ['start', 'end']) {
      const point = getWallJointPoint(wall, endpoint);
      const other = getWallJointPoint(wall, endpoint === 'start' ? 'end' : 'start');
      const dx = other.x - point.x, dy = other.y - point.y;
      const direction = Math.abs(dx) >= Math.abs(dy)
        ? { x: Math.sign(dx) || 0, y: 0 }
        : { x: 0, y: Math.sign(dy) || 0 };
      const key = getWallJointKey(point);
      if (!joints.has(key)) joints.set(key, []);
      joints.get(key).push({ wall, endpoint, point, other, direction });
    }
  }
  return joints;
}

export function getWallJointItemsForEndpoint(jointMap, wall, endpoint) {
  return jointMap.get(getWallJointKey(getWallJointPoint(wall, endpoint))) || [];
}

// ── Joint rects (cached — invalidated when walls change) ──────────
let _jointRectsCache = null;
let _jointRectsCacheKey = '';

export function invalidateJointCache() {
  _jointRectsCache = null;
}

export function getWallJointRects(jointMap = null) {
  // Bug #12 fix: cache the result and only recompute when walls change.
  const cacheKey = JSON.stringify(appState.walls.map(w => `${w.id},${w.x1},${w.y1},${w.x2},${w.y2},${w.thickness}`));
  if (_jointRectsCache && _jointRectsCacheKey === cacheKey) return _jointRectsCache;

  const map = jointMap || buildWallJointMap();
  const rects = [];
  const seenRects = new Set();

  for (const items of map.values()) {
    if (items.length < 2) continue;
    // Используем РЕАЛЬНЫЙ угол стены (не снапнутое направление).
    // Иначе 45° стена классифицируется как "горизонтальная" и создаёт
    // ложный joint rect с вертикальной стеной → артефакты на диагональных углах.
    const ORTHO_TOL = 0.15; // sin(~8.6°)
    const horizontals = items.filter(item => {
      const a = Math.atan2(item.wall.y2 - item.wall.y1, item.wall.x2 - item.wall.x1);
      return Math.abs(Math.sin(a)) < ORTHO_TOL;
    });
    const verticals = items.filter(item => {
      const a = Math.atan2(item.wall.y2 - item.wall.y1, item.wall.x2 - item.wall.x1);
      return Math.abs(Math.cos(a)) < ORTHO_TOL;
    });
    if (!horizontals.length || !verticals.length) continue;

    for (const horizontal of horizontals) {
      for (const vertical of verticals) {
        const joint = horizontal.point;
        const hBounds = getWallWorldBounds(horizontal.wall);
        const vBounds = getWallWorldBounds(vertical.wall);
        const x1 = horizontal.direction.x > 0 ? vBounds.minX : Math.max(vBounds.minX, joint.x);
        const x2 = horizontal.direction.x > 0 ? Math.min(vBounds.maxX, joint.x) : vBounds.maxX;
        const y1 = vertical.direction.y > 0 ? hBounds.minY : Math.max(hBounds.minY, joint.y);
        const y2 = vertical.direction.y > 0 ? Math.min(hBounds.maxY, joint.y) : hBounds.maxY;
        const left = Math.min(x1, x2), right = Math.max(x1, x2);
        const top  = Math.min(y1, y2), bottom = Math.max(y1, y2);
        if ((right - left) < 1 || (bottom - top) < 1) continue;

        const key = `${Math.round(left)},${Math.round(top)},${Math.round(right)},${Math.round(bottom)}`;
        if (seenRects.has(key)) continue;
        seenRects.add(key);

        const boundaryEdges = getJointBoundaryEdges(left, top, right, bottom, horizontal.direction, vertical.direction);
        if (!boundaryEdges.length) continue;

        rects.push({
          key, left, top, right, bottom,
          wallIds: [...new Set([horizontal.wall.id, vertical.wall.id])],
          boundaryEdges,
        });
      }
    }
  }

  _jointRectsCache = rects;
  _jointRectsCacheKey = cacheKey;
  return rects;
}

export function getJointBoundaryEdges(left, top, right, bottom, hDir, vDir) {
  const edges = [];
  if (vDir?.y > 0) edges.push({ side: 'top',    x1: left,  y1: top,    x2: right, y2: top    });
  else if (vDir?.y < 0) edges.push({ side: 'bottom', x1: left,  y1: bottom, x2: right, y2: bottom });
  if (hDir?.x > 0) edges.push({ side: 'left',   x1: left,  y1: top,    x2: left,  y2: bottom });
  else if (hDir?.x < 0) edges.push({ side: 'right',  x1: right, y1: top,    x2: right, y2: bottom });
  return edges;
}

export function getJointBoundaryCornerPoints(jointRect) {
  const points = new Map();
  for (const edge of jointRect.boundaryEdges) {
    for (const p of [{ x: edge.x1, y: edge.y1 }, { x: edge.x2, y: edge.y2 }]) {
      const k = `${Math.round(p.x)},${Math.round(p.y)}`;
      if (!points.has(k)) points.set(k, p);
    }
  }
  return [...points.values()];
}

export function getJointLocalCornerPoints(jointRect) {
  const points = new Map();
  const add = p => {
    const k = `${Math.round(p.x)},${Math.round(p.y)}`;
    if (!points.has(k)) points.set(k, p);
  };
  for (const p of getJointBoundaryCornerPoints(jointRect)) add(p);
  const eps = 1;
  for (const wallId of jointRect.wallIds) {
    const wall = appState.walls.find(w => w.id === wallId);
    if (!wall) continue;
    for (const p of getWallCornerPoints(wall)) {
      if (p.x >= jointRect.left - eps && p.x <= jointRect.right  + eps &&
          p.y >= jointRect.top  - eps && p.y <= jointRect.bottom + eps) add(p);
    }
  }
  return [...points.values()];
}

export function getJointBoundaryPaths(jointRect) {
  const activeSides = new Set(jointRect.boundaryEdges.map(e => e.side));
  const defs = [
    { side: 'top',    start: { x: jointRect.left,  y: jointRect.top    }, end: { x: jointRect.right, y: jointRect.top    } },
    { side: 'right',  start: { x: jointRect.right, y: jointRect.top    }, end: { x: jointRect.right, y: jointRect.bottom } },
    { side: 'bottom', start: { x: jointRect.right, y: jointRect.bottom }, end: { x: jointRect.left,  y: jointRect.bottom } },
    { side: 'left',   start: { x: jointRect.left,  y: jointRect.bottom }, end: { x: jointRect.left,  y: jointRect.top    } },
  ];
  const active = defs.map(d => activeSides.has(d.side));
  if (active.every(Boolean)) {
    return [[defs[0].start, defs[0].end, defs[1].end, defs[2].end, defs[3].end]];
  }
  const paths = [], visited = new Set();
  for (let i = 0; i < defs.length; i++) {
    if (!active[i] || visited.has(i) || active[(i + defs.length - 1) % defs.length]) continue;
    const path = [defs[i].start, defs[i].end];
    visited.add(i);
    let next = (i + 1) % defs.length;
    while (active[next] && !visited.has(next)) {
      path.push(defs[next].end);
      visited.add(next);
      next = (next + 1) % defs.length;
    }
    paths.push(path);
  }
  return paths;
}

// ── Baseline (Stage 1: Renga-style) ─────────────────────────────
// Пересчитывает x1/y1/x2/y2 (смещённую ось) от базовой линии (cx1/cy1 → cx2/cy2).
// Вызывать при изменении thickness или offset — базовая линия при этом НЕ двигается.
export function recalculateContourFromBase(wall) {
  const cx1 = wall.cx1 ?? wall.x1;
  const cy1 = wall.cy1 ?? wall.y1;
  const cx2 = wall.cx2 ?? wall.x2;
  const cy2 = wall.cy2 ?? wall.y2;
  const angle      = Math.atan2(cy2 - cy1, cx2 - cx1);
  const offsetMode = wall.offset || 'center';
  const s = applyWallOffset(cx1, cy1, angle, offsetMode, wall.thickness);
  const e = applyWallOffset(cx2, cy2, angle, offsetMode, wall.thickness);
  wall.x1 = s.x; wall.y1 = s.y;
  wall.x2 = e.x; wall.y2 = e.y;
  invalidateJointCache();
}

// ── Stage 4: сопряжение стен ─────────────────────────────────────

// Возвращает true, если две стены лежат на одной прямой (коллинеарны) и касаются.
// Используется в render.js чтобы не рисовать шов между двумя сегментами одной прямой.
export function areWallsCollinear(w1, w2, angleTol = 0.035, thicknessTol = 5) {
  // Разная толщина — разные стены, шов нужен
  if (Math.abs(w1.thickness - w2.thickness) > thicknessTol) return false;

  // Проверяем касание концевых точек (по базовой линии)
  const a1 = { x: w1.cx1 ?? w1.x1, y: w1.cy1 ?? w1.y1 };
  const a2 = { x: w1.cx2 ?? w1.x2, y: w1.cy2 ?? w1.y2 };
  const b1 = { x: w2.cx1 ?? w2.x1, y: w2.cy1 ?? w2.y1 };
  const b2 = { x: w2.cx2 ?? w2.x2, y: w2.cy2 ?? w2.y2 };

  const TOUCH = 8; // мм
  const touches = (
    Math.hypot(a2.x - b1.x, a2.y - b1.y) < TOUCH ||
    Math.hypot(a1.x - b2.x, a1.y - b2.y) < TOUCH ||
    Math.hypot(a1.x - b1.x, a1.y - b1.y) < TOUCH ||
    Math.hypot(a2.x - b2.x, a2.y - b2.y) < TOUCH
  );
  if (!touches) return false;

  // Проверяем угол: коллинеарные = почти одинаковое направление (или противоположное)
  const angle1 = Math.atan2(a2.y - a1.y, a2.x - a1.x);
  const angle2 = Math.atan2(b2.y - b1.y, b2.x - b1.x);
  // Нормализуем разницу в [0, π]
  let diff = Math.abs(angle1 - angle2) % Math.PI;
  if (diff > Math.PI / 2) diff = Math.PI - diff;

  return diff < angleTol;
}

// ── Wall update ──────────────────────────────────────────────────

export function updateWallGeometry(wall, nextStart, nextEnd, options = {}) {
  const preserveFrom = options.preserveFrom === 'end' ? 'end' : 'start';
  const prevLen = getWallLength(wall);
  const relatedOpenings = appState.openings
    .filter(op => op.wallId === wall.id)
    .map(op => ({
      op,
      centerFromStart: op.t * prevLen,
      centerFromEnd:   prevLen - op.t * prevLen,
    }));

  const nextLen = Math.hypot(nextEnd.x - nextStart.x, nextEnd.y - nextStart.y);
  if (nextLen < 1) return false;

  const angle = Math.atan2(nextEnd.y - nextStart.y, nextEnd.x - nextStart.x);
  const offsetMode = getWallOffsetMode(wall);
  const shiftedStart = applyWallOffset(nextStart.x, nextStart.y, angle, offsetMode, wall.thickness);
  const shiftedEnd   = applyWallOffset(nextEnd.x,   nextEnd.y,   angle, offsetMode, wall.thickness);

  wall.cx1 = nextStart.x; wall.cy1 = nextStart.y;
  wall.cx2 = nextEnd.x;   wall.cy2 = nextEnd.y;
  wall.x1 = shiftedStart.x; wall.y1 = shiftedStart.y;
  wall.x2 = shiftedEnd.x;   wall.y2 = shiftedEnd.y;
  wall.offset = offsetMode;

  if (relatedOpenings.length) {
    const allowedIds = new Set();
    for (const { op, centerFromStart, centerFromEnd } of relatedOpenings) {
      if (nextLen <= op.width + 1) continue;
      const center = preserveFrom === 'end' ? nextLen - centerFromEnd : centerFromStart;
      op.t = clamp(center, op.width / 2, nextLen - op.width / 2) / nextLen;
      allowedIds.add(op.id);
    }
    appState.openings = appState.openings.filter(op =>
      op.wallId !== wall.id || allowedIds.has(op.id));
  }

  invalidateJointCache();
  return true;
}

export function setWallLength(wall, nextLength, anchor = 'start', options = {}) {
  if (!wall) return false;
  const targetLength = Number(nextLength);
  if (!isFinite(targetLength) || targetLength < 20) return false;
  const start = getWallContourPoint(wall, 'start');
  const end   = getWallContourPoint(wall, 'end');
  const currentLength = Math.hypot(end.x - start.x, end.y - start.y);
  if (currentLength < 1 || Math.abs(currentLength - targetLength) < 0.5) return false;
  const ux = (end.x - start.x) / currentLength;
  const uy = (end.y - start.y) / currentLength;
  const nextStart = anchor === 'end' ? { x: end.x - ux * targetLength, y: end.y - uy * targetLength } : start;
  const nextEnd   = anchor === 'end' ? end : { x: start.x + ux * targetLength, y: start.y + uy * targetLength };
  return updateWallGeometry(wall, nextStart, nextEnd, {
    preserveFrom: anchor === 'end' ? 'end' : 'start',
  });
}

// ── CRUD ─────────────────────────────────────────────────────────

export function addWall(start, end, thick, height, wallOffset) {
  const angle = Math.atan2(end.y - start.y, end.x - start.x);
  const s  = applyWallOffset(start.x, start.y, angle, wallOffset, thick);
  const e2 = applyWallOffset(end.x,   end.y,   angle, wallOffset, thick);
  const wall = {
    id: appState.idWall++,
    // Смещённая ось (зависит от offset/thickness — пересчитывается recalculateContourFromBase)
    x1: s.x,  y1: s.y,
    x2: e2.x, y2: e2.y,
    // Базовая линия (то что рисовал пользователь — никогда не сдвигается)
    cx1: start.x, cy1: start.y,
    cx2: end.x,   cy2: end.y,
    thickness: thick, height, offset: wallOffset,
    horizontalOffset: 0, // зарезервировано для будущего смещения по нормали (Stage 1+)
    // Stage 4: приоритет сопряжения. Чем выше — тем «главнее» стена при T-стыке.
    // Стены с равным приоритетом сопрягаются симметрично.
    priority: appState.idWall - 1, // порядковый номер как начальный приоритет
  };
  appState.walls.push(wall);
  invalidateJointCache();
  return wall;
}

export function deleteSelectedItems(selectedItems) {
  const wallIds    = new Set(selectedItems.filter(i => i.type === 'wall').map(i => i.id));
  const openingIds = new Set(selectedItems.filter(i => i.type === 'opening').map(i => i.id));
  appState.walls    = appState.walls.filter(w => !wallIds.has(w.id));
  // Bug #2 fix: also remove openings whose wall was deleted
  appState.openings = appState.openings.filter(o =>
    !wallIds.has(o.wallId) && !openingIds.has(o.id));
  invalidateJointCache();
}

// ── Hit-test helpers ─────────────────────────────────────────────

export function segmentClosest(px, py, w) {
  const ax = w.x2 - w.x1, ay = w.y2 - w.y1;
  const len2 = ax * ax + ay * ay;
  if (len2 === 0) return { t: 0, dist: Math.hypot(px - w.x1, py - w.y1) };
  let t = ((px - w.x1) * ax + (py - w.y1) * ay) / len2;
  t = Math.min(1, Math.max(0, t));
  return { t, dist: Math.hypot(px - (w.x1 + ax * t), py - (w.y1 + ay * t)) };
}

export function findClosestWall(wx, wy, threshold = 60) {
  let best = null, bestDist = threshold;
  for (const w of appState.walls) {
    const { t, dist } = segmentClosest(wx, wy, w);
    if (dist < bestDist) { best = { wall: w, t }; bestDist = dist; }
  }
  return best;
}

export function findClosestWallSel(wx, wy, threshold = 40) {
  let best = null, bestDist = threshold;
  for (const w of appState.walls) {
    const { dist } = segmentClosest(wx, wy, w);
    if (dist < bestDist) { best = w; bestDist = dist; }
  }
  return best;
}

// ── Guide corners ────────────────────────────────────────────────

export function getWallGuideCorners(wall) {
  const g = getWallWorldGeometry(wall);
  const len = Math.hypot(wall.x2 - wall.x1, wall.y2 - wall.y1);
  if (len < 1) return [];
  const dir = { x: (wall.x2 - wall.x1) / len, y: (wall.y2 - wall.y1) / len };
  return [g.a, g.b, g.c, g.d].map((point, index) => ({
    id: `${wall.id}:${index}`, wall, point, dir,
  }));
}

// ── Proximity helpers (for hover/click hit-testing) ──────────────

export function distanceToWallSurface(point, wall) {
  const dx = wall.x2 - wall.x1, dy = wall.y2 - wall.y1;
  const len = Math.hypot(dx, dy);
  if (len < 0.0001) return Math.hypot(point.x - wall.x1, point.y - wall.y1);
  const ux = dx / len, uy = dy / len;
  const relX = point.x - wall.x1, relY = point.y - wall.y1;
  const along = Math.max(0, Math.min(len, relX * ux + relY * uy));
  const cx = wall.x1 + ux * along, cy = wall.y1 + uy * along;
  return Math.max(0, Math.hypot(point.x - cx, point.y - cy) - wall.thickness / 2);
}

export function findClosestOpeningByProximity(wx, wy, thresholdWorld = 120) {
  let best = null, bestDist = thresholdWorld;
  for (const op of appState.openings) {
    const wall = appState.walls.find(w => w.id === op.wallId);
    if (!wall) continue;
    const wlen = Math.hypot(wall.x2 - wall.x1, wall.y2 - wall.y1);
    const angle = Math.atan2(wall.y2 - wall.y1, wall.x2 - wall.x1);
    const halfT = wall.thickness / 2;
    const cx = wall.x1 + (wall.x2 - wall.x1) * op.t;
    const cy = wall.y1 + (wall.y2 - wall.y1) * op.t;
    const ux = Math.cos(angle), uy = Math.sin(angle);
    const nx = -uy, ny = ux;
    const relX = wx - cx, relY = wy - cy;
    const along = Math.abs(relX * ux + relY * uy);
    const normal = Math.abs(relX * nx + relY * ny);
    const dAlong = Math.max(0, along - op.width / 2);
    const dNormal = Math.max(0, normal - halfT);
    const dist = Math.hypot(dAlong, dNormal);
    if (dist < bestDist) { best = op; bestDist = dist; }
  }
  return best;
}
