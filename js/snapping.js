// ─── SNAPPING.JS ──────────────────────────────────────────────────
import { appState } from './state.js';
import { projectPointOntoSegment, normalizeDirection } from './geometry.js';
import {
  getWallContourEndpoints, getWallContourSegment, getWallContourMidpoint,
  getWallCornerPoints, getWallSnapSegments, getWallJointRects,
  getJointBoundaryCornerPoints, getJointLocalCornerPoints, getWallGuideCorners,
  isPointInsideWallSurface,
} from './wall.js';

// ── Viewport: set by render.js via initViewport ───────────────────
let _scale = 0.12, _panX = 200, _panY = 150;
let _shiftDown = false, _ctrlDown = false;

export function setViewport(scale, panX, panY) { _scale = scale; _panX = panX; _panY = panY; }
export function setModifiers(shift, ctrl) { _shiftDown = shift; _ctrlDown = ctrl; }

export function toScreen(x, y) { return { x: x * _scale + _panX, y: y * _scale + _panY }; }
export function toWorld(sx, sy) { return { x: (sx - _panX) / _scale, y: (sy - _panY) / _scale }; }

// ── Snap type helpers ────────────────────────────────────────────
export function getSnapTypePriority(type) {
  return { corner: 0, endpoint: 1, intersection: 2, midpoint: 3, tracking: 3, wallFace: 4, wallAxis: 5, perpendicular: 6 }[type] ?? 9;
}
export function getSnapLabel(type) {
  return { corner: 'Угол', endpoint: 'Точка стены', midpoint: 'Середина',
    intersection: 'Пересечение', perpendicular: 'Перпендикуляр',
    wallFace: 'Край стены', wallAxis: 'Ось стены',
    tracking: 'Линия отслеживания' }[type] || '';
}

// ── Main object snap ─────────────────────────────────────────────
export function findObjectSnapCandidate(worldPoint, screenPoint, options = {}) {
  const tolerance = options.tolerance ?? 16;
  const bestByKey = new Map();

  function register(type, point, extra = {}, distLimit = tolerance) {
    const screen = toScreen(point.x, point.y);
    const distance = Math.hypot(screenPoint.x - screen.x, screenPoint.y - screen.y);
    if (distance > distLimit) return;
    const key = `${type}:${Math.round(point.x)},${Math.round(point.y)}`;
    const candidate = { type, x: point.x, y: point.y, distance, label: getSnapLabel(type), ...extra };
    const prev = bestByKey.get(key);
    if (!prev || candidate.distance < prev.distance) bestByKey.set(key, candidate);
  }

  if (options.includeEndpoint) {
    for (const wall of appState.walls)
      for (const p of getWallContourEndpoints(wall)) register('endpoint', p, { wallId: wall.id });
  }
  if (options.includeCorner) {
    for (const jr of getWallJointRects()) {
      const hpts = getJointLocalCornerPoints(jr);
      for (const p of getJointBoundaryCornerPoints(jr)) register('corner', p, { wallIds: jr.wallIds, highlightPoints: hpts });
    }
    for (const wall of appState.walls)
      for (const p of getWallCornerPoints(wall)) register('corner', p, { wallId: wall.id });
  }
  if (options.includeMidpoint) {
    for (const wall of appState.walls) register('midpoint', getWallContourMidpoint(wall), { wallId: wall.id });
  }
  if (options.includeIntersection) {
    for (let i = 0; i < appState.walls.length; i++) {
      for (let j = i + 1; j < appState.walls.length; j++) {
        const a = getWallContourSegment(appState.walls[i]);
        const b = getWallContourSegment(appState.walls[j]);
        const hit = _segmentIntersectionLocal(a, b);
        if (!hit) continue;
        if (hit.t < 0.02 || hit.t > 0.98 || hit.u < 0.02 || hit.u > 0.98) continue;
        register('intersection', hit, { wallIds: [appState.walls[i].id, appState.walls[j].id] });
      }
    }
  }
  if (options.includePerpendicular && options.startPoint) {
    for (const wall of appState.walls) {
      const seg = getWallContourSegment(wall);
      const proj = projectPointOntoSegment(options.startPoint, seg);
      if (proj.t <= 0.03 || proj.t >= 0.97 || proj.distance < 0.5) continue;
      register('perpendicular', proj, {
        wallId: wall.id, wallAngle: Math.atan2(seg.y2 - seg.y1, seg.x2 - seg.x1),
      });
    }
  }
  if (options.includeWallPoint) {
    const wpt = options.wallPointTolerance ?? Math.max(tolerance, 24);
    for (const wall of appState.walls) {
      const wallAngle = Math.atan2(wall.y2 - wall.y1, wall.x2 - wall.x1);
      for (const entry of getWallSnapSegments(wall)) {
        const proj = projectPointOntoSegment(worldPoint, entry.segment);
        const inside = isPointInsideWallSurface(worldPoint, wall, 0.75);
        register(entry.type, proj, { wallId: wall.id, wallAngle }, inside ? Infinity : wpt);
      }
    }
  }

  const candidates = [...bestByKey.values()];
  candidates.sort((a, b) =>
    Math.abs(a.distance - b.distance) > 0.5
      ? a.distance - b.distance
      : getSnapTypePriority(a.type) - getSnapTypePriority(b.type)
  );
  return candidates[0] || null;
}

function _segmentIntersectionLocal(a, b, epsilon = 0.001) {
  const r = { x: a.x2 - a.x1, y: a.y2 - a.y1 };
  const s = { x: b.x2 - b.x1, y: b.y2 - b.y1 };
  const denom = r.x * s.y - r.y * s.x;
  if (Math.abs(denom) < epsilon) return null;
  const qp = { x: b.x1 - a.x1, y: b.y1 - a.y1 };
  const t = (qp.x * s.y - qp.y * s.x) / denom;
  const u = (qp.x * r.y - qp.y * r.x) / denom;
  if (t < -epsilon || t > 1 + epsilon || u < -epsilon || u > 1 + epsilon) return null;
  return { x: a.x1 + r.x * t, y: a.y1 + r.y * t, t, u };
}

// ── Grid snap ───────────────────────────────────────────────────

export function snap(x, y, options = {}) {
  if (typeof options === 'boolean') options = { forceNoEndpoint: options };
  const forceNoEndpoint = !!options.forceNoEndpoint;
  const screenPoint = options.screenPoint || toScreen(x, y);

  const objectSnap = !options.skipObject
    ? findObjectSnapCandidate({ x, y }, screenPoint, {
        includeEndpoint:     !forceNoEndpoint,
        includeCorner:       true,
        includeMidpoint:     !forceNoEndpoint,
        includeIntersection: !forceNoEndpoint,
        includeWallPoint:    true,
        includePerpendicular: !!options.includePerpendicular,
        startPoint: options.startPoint || null,
      })
    : null;

  if (objectSnap) {
    return {
      x: objectSnap.x, y: objectSnap.y,
      snapType: objectSnap.type,
      snappedToEndpoint:     objectSnap.type === 'endpoint',
      snappedToMidpoint:     objectSnap.type === 'midpoint',
      snappedToIntersection: objectSnap.type === 'intersection',
      snappedToPerpendicular:objectSnap.type === 'perpendicular',
      snapLabel:    objectSnap.label || '',
      snapDistance: objectSnap.distance,
    };
  }

  const g = (_shiftDown && _ctrlDown) ? 100 : _shiftDown ? 10 : 1;
  const sx = Math.round(x / g) * g;
  const sy = Math.round(y / g) * g;

  if (!forceNoEndpoint) {
    const snapDist = 120;
    for (const w of appState.walls) {
      for (const pt of getWallContourEndpoints(w)) {
        if (Math.hypot(x - pt.x, y - pt.y) < snapDist) {
          return { x: pt.x, y: pt.y, snapType: 'endpoint',
            snappedToEndpoint: true, snappedToMidpoint: false,
            snappedToIntersection: false, snappedToPerpendicular: false,
            snapLabel: getSnapLabel('endpoint'), snapDistance: 0 };
        }
      }
    }
  }

  return { x: sx, y: sy, snapType: null,
    snappedToEndpoint: false, snappedToMidpoint: false,
    snappedToIntersection: false, snappedToPerpendicular: false,
    snapLabel: '', snapDistance: Infinity };
}

// ── Guide lines ──────────────────────────────────────────────────

export function getGuideAxes(guide) {
  const primary   = normalizeDirection(guide.dir);
  const secondary = normalizeDirection({ x: -primary.y, y: primary.x });
  return [
    { key: 'primary',   dir: primary,   color: '#5f6771' },
    { key: 'secondary', dir: secondary, color: '#9aa1a9' },
  ];
}

export function getGuideLineScreenEndpoints(guide) {
  const anchor = toScreen(guide.anchor.x, guide.anchor.y);
  const span = Math.max(2000, 2000);
  return {
    start: { x: anchor.x - guide.dir.x * span, y: anchor.y - guide.dir.y * span },
    end:   { x: anchor.x + guide.dir.x * span, y: anchor.y + guide.dir.y * span },
    anchor,
  };
}

export function distancePointToGuideLineScreen(screenPoint, guide) {
  const { anchor } = getGuideLineScreenEndpoints(guide);
  const dx = screenPoint.x - anchor.x, dy = screenPoint.y - anchor.y;
  return Math.abs(dx * (-guide.dir.y) + dy * guide.dir.x);
}

export function projectPointToGuideLineWorld(point, guide) {
  const dx = point.x - guide.anchor.x, dy = point.y - guide.anchor.y;
  const along = dx * guide.dir.x + dy * guide.dir.y;
  return { x: guide.anchor.x + guide.dir.x * along, y: guide.anchor.y + guide.dir.y * along };
}

export function getNearestGuideAxis(screenPoint, guide) {
  let best = null;
  for (const axis of getGuideAxes(guide)) {
    const axisGuide = { anchor: guide.anchor, dir: axis.dir };
    const distance = distancePointToGuideLineScreen(screenPoint, axisGuide);
    if (!best || distance < best.distance) best = { ...axis, distance };
  }
  return best;
}

export function findGuideCandidate(screenPoint) {
  const tolerance = 14;
  let best = null, bestDist = tolerance;

  for (const wall of appState.walls) {
    for (const corner of getWallGuideCorners(wall)) {
      const screen = toScreen(corner.point.x, corner.point.y);
      const distance = Math.hypot(screenPoint.x - screen.x, screenPoint.y - screen.y);
      if (distance < bestDist) {
        bestDist = distance;
        best = { id: corner.id, wallId: wall.id, anchor: corner.point, dir: corner.dir };
      }
    }
  }
  for (const jr of getWallJointRects()) {
    for (const point of getJointLocalCornerPoints(jr)) {
      const screen = toScreen(point.x, point.y);
      const distance = Math.hypot(screenPoint.x - screen.x, screenPoint.y - screen.y);
      if (distance < bestDist) {
        bestDist = distance;
        best = { id: `joint:${jr.key}`, wallIds: jr.wallIds, anchor: point, dir: { x: 1, y: 0 } };
      }
    }
  }
  return best;
}

// ── Snapped resize point ─────────────────────────────────────────

export function getSnappedWallResizePoint(fixedPoint, worldPoint, screenPoint, shiftDown) {
  const snappedBase = snap(worldPoint.x, worldPoint.y, {
    screenPoint: screenPoint || toScreen(worldPoint.x, worldPoint.y),
    includePerpendicular: true,
    startPoint: fixedPoint,
  });
  let nextPoint = { ...snappedBase };

  if (!snappedBase.snapType) {
    const dx = nextPoint.x - fixedPoint.x, dy = nextPoint.y - fixedPoint.y;
    const len = Math.hypot(dx, dy);
    if (len > 20 && !shiftDown) {
      let angle = Math.atan2(dy, dx);
      for (const sa of [0, Math.PI / 2, Math.PI, -Math.PI / 2]) {
        const diff = Math.abs(angle - sa);
        if (diff < 0.15 || Math.abs(diff - 2 * Math.PI) < 0.15) {
          angle = sa;
          nextPoint = { x: fixedPoint.x + Math.cos(angle) * len, y: fixedPoint.y + Math.sin(angle) * len };
          break;
        }
      }
    }
  }
  return nextPoint;
}

// ══════════════════════════════════════════════════════════════════
// STAGE 3: ЛИНИИ ОТСЛЕЖИВАНИЯ (TRACKING LINES)
// Как в Renga: задержал курсор на точке >400мс → фиолетовые лучи.
// Лучи: продолжение стены, перпендикуляр, горизонталь, вертикаль.
// ══════════════════════════════════════════════════════════════════

// Возвращает массив лучей от активированной точки отслеживания.
// Каждый луч: { anchor, dir, lineType }
// lineType: 'axis' | 'continuation' | 'perpendicular'
export function getTrackingLines(trackingPoint) {
  if (!trackingPoint) return [];
  const anchor = { x: trackingPoint.x, y: trackingPoint.y };
  const lines = [];

  // Всегда: горизонталь и вертикаль (глобальные оси)
  lines.push({ anchor, dir: { x: 1, y: 0 }, lineType: 'axis' });
  lines.push({ anchor, dir: { x: 0, y: 1 }, lineType: 'axis' });

  // Продолжение стены + перпендикуляр (если у точки известно направление стены)
  if (trackingPoint.wallDir) {
    const d = trackingPoint.wallDir;
    lines.push({ anchor, dir: { x: d.x, y: d.y }, lineType: 'continuation' });
    lines.push({ anchor, dir: { x: -d.y, y: d.x }, lineType: 'perpendicular' });
  }

  return lines;
}

// Пытается привязать worldPoint к линиям отслеживания.
// Приоритет: пересечение двух линий > проекция на ближайшую линию.
// Возвращает { x, y, snapType:'tracking', lineType } или null.
export function snapToTrackingLines(worldPoint, screenPoint, trackingLines, tolerance = 14) {
  if (!trackingLines?.length) return null;

  // 1. Ищем пересечения всех пар линий — самая ценная привязка
  let bestIntersection = null, bestIDist = tolerance;
  for (let i = 0; i < trackingLines.length; i++) {
    for (let j = i + 1; j < trackingLines.length; j++) {
      const hit = _trackingLineIntersect(trackingLines[i], trackingLines[j]);
      if (!hit) continue;
      const s = toScreen(hit.x, hit.y);
      const d = Math.hypot(screenPoint.x - s.x, screenPoint.y - s.y);
      if (d < bestIDist) { bestIDist = d; bestIntersection = hit; }
    }
  }
  if (bestIntersection) {
    return { x: bestIntersection.x, y: bestIntersection.y, snapType: 'tracking', lineType: 'intersection' };
  }

  // 2. Проекция на ближайшую линию
  let bestPt = null, bestDist = tolerance;
  for (const line of trackingLines) {
    const proj = projectPointToGuideLineWorld(worldPoint, line);
    const s = toScreen(proj.x, proj.y);
    const d = Math.hypot(screenPoint.x - s.x, screenPoint.y - s.y);
    if (d < bestDist) { bestDist = d; bestPt = { x: proj.x, y: proj.y, snapType: 'tracking', lineType: line.lineType }; }
  }
  return bestPt;
}

// Пересечение двух бесконечных лучей в мировых координатах
function _trackingLineIntersect(a, b) {
  const denom = a.dir.x * b.dir.y - a.dir.y * b.dir.x;
  if (Math.abs(denom) < 0.0001) return null; // параллельны
  const dx = b.anchor.x - a.anchor.x, dy = b.anchor.y - a.anchor.y;
  const t = (dx * b.dir.y - dy * b.dir.x) / denom;
  return { x: a.anchor.x + a.dir.x * t, y: a.anchor.y + a.dir.y * t };
}
