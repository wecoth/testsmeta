// ─── OPENING.JS ───────────────────────────────────────────────────
import { appState } from './state.js';
import { clamp } from './geometry.js';

export function addOpening(wall, t, width, height, type, options = {}) {
  const wlen = Math.hypot(wall.x2 - wall.x1, wall.y2 - wall.y1);
  if (wlen <= width) return false;
  const tc = clamp(t, width / 2 / wlen, 1 - width / 2 / wlen);
  const opening = {
    id: appState.idOpen++,
    wallId: wall.id, t: tc, width, height, type,
  };
  if (type === 'door') {
    opening.hinge = options.hinge || 'start';
    opening.swing = options.swing ?? 1;
  }
  appState.openings.push(opening);
  return true;
}

export function findClosestOpening(wx, wy, threshold = 80) {
  // Сначала проверяем точное попадание в прямоугольник проёма
  for (const op of appState.openings) {
    const wall = appState.walls.find(w => w.id === op.wallId);
    if (!wall) continue;
    const wlen = Math.hypot(wall.x2 - wall.x1, wall.y2 - wall.y1);
    if (wlen < 1) continue;
    // Вектор вдоль стены и нормаль
    const ux = (wall.x2 - wall.x1) / wlen, uy = (wall.y2 - wall.y1) / wlen;
    const nx = -uy, ny = ux;
    // Проецируем курсор на локальные оси стены
    const rx = wx - wall.x1, ry = wy - wall.y1;
    const along  = rx * ux + ry * uy; // позиция вдоль стены в мм
    const normal = rx * nx + ry * ny; // отступ от оси стены в мм
    // Границы проёма вдоль стены
    const centerAlong = op.t * wlen;
    const halfW = op.width / 2;
    const halfT = wall.thickness / 2 + 20; // +20мм допуск
    if (along >= centerAlong - halfW && along <= centerAlong + halfW &&
        Math.abs(normal) <= halfT) {
      return op;
    }
  }
  // Fallback: расстояние до центра (для маленьких проёмов)
  for (const op of appState.openings) {
    const wall = appState.walls.find(w => w.id === op.wallId);
    if (!wall) continue;
    const mx = wall.x1 + (wall.x2 - wall.x1) * op.t;
    const my = wall.y1 + (wall.y2 - wall.y1) * op.t;
    if (Math.hypot(wx - mx, wy - my) < threshold) return op;
  }
  return null;
}

export function updateDoorOpening(id, patch) {
  const op = appState.openings.find(o => o.id === id && o.type === 'door');
  if (!op) return;
  Object.assign(op, patch);
}

/**
 * Collect all opening areas that touch a given room's boundary segments.
 */
export function openingTouchesSegments(op, segments, walls) {
  const wall = walls.find(w => w.id === op.wallId);
  if (!wall) return false;
  const wallSegs = segments.filter(seg => seg.wall && seg.wall.id === op.wallId);
  if (!wallSegs.length) return false;

  const wallLen = Math.hypot(wall.x2 - wall.x1, wall.y2 - wall.y1);
  const halfOpen = op.width / 2;
  const sx = wall.x1 + (wall.x2 - wall.x1) * (op.t - halfOpen / wallLen);
  const sy = wall.y1 + (wall.y2 - wall.y1) * (op.t - halfOpen / wallLen);
  const ex = wall.x1 + (wall.x2 - wall.x1) * (op.t + halfOpen / wallLen);
  const ey = wall.y1 + (wall.y2 - wall.y1) * (op.t + halfOpen / wallLen);

  const eps = 2;
  return wallSegs.some(seg =>
    seg.orientation === 'h'
      ? Math.max(Math.min(sx, ex), Math.min(seg.x1, seg.x2)) < Math.min(Math.max(sx, ex), Math.max(seg.x1, seg.x2)) + eps
      : Math.max(Math.min(sy, ey), Math.min(seg.y1, seg.y2)) < Math.min(Math.max(sy, ey), Math.max(seg.y1, seg.y2)) + eps
  );
}
