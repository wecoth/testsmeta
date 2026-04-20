// ─── RENDER.JS ────────────────────────────────────────────────────
import { appState, DRAW_COLORS, ROOM_COLORS, ROOM_STROKES } from './state.js';
import {
  getWallWorldGeometry, getWallCornerPoints, getWallLength,
  getWallContourPoint, isWallEndpointCoveredByAnotherWall,
  buildWallJointMap, getWallJointItemsForEndpoint, getWallJointRects,
  getJointBoundaryCornerPoints, getJointLocalCornerPoints, getJointBoundaryPaths,
  areWallsCollinear,
} from './wall.js';
import { toScreen, toWorld, getGuideAxes, getGuideLineScreenEndpoints, setViewport as _setViewportFn } from './snapping.js';
import { exteriorWallIds } from './room.js';
import { polygonCentroid } from './geometry.js';
import { isPointInsideWallSurface } from './wall.js';

let _canvas, _ctx, _hatchPat = null;
let _getScale = () => 0.12;
let _fontScale = 1; // множитель шрифта для offscreen рендера (PDF)

export function initRenderer(canvas, ctx, getScaleFn) {
  _canvas = canvas; _ctx = ctx;
  _getScale = getScaleFn || (() => 0.12);
  _hatchPat = null;
}

// ── Utilities ─────────────────────────────────────────────────────

function sel(type, id, list) { return list.some(i => i.type === type && i.id === id); }

function wallStyle(isSelected) {
  return {
    fill:   isSelected ? DRAW_COLORS.wallFillSelected : DRAW_COLORS.wallFill,
    stroke: isSelected ? DRAW_COLORS.wallStrokeSelected : DRAW_COLORS.wallStroke,
  };
}

function sg(wall) { // screen geometry
  const w = getWallWorldGeometry(wall);
  const sc = p => toScreen(p.x, p.y);
  return { p1: sc(w.p1), p2: sc(w.p2), angle: w.angle, halfT: w.halfT,
           a: sc(w.a), b: sc(w.b), c: sc(w.c), d: sc(w.d) };
}

function hatch() {
  if (_hatchPat) return _hatchPat;
  const pc = document.createElement('canvas'); pc.width = 12; pc.height = 12;
  const px = pc.getContext('2d');
  px.strokeStyle = DRAW_COLORS.wallHatch; px.lineWidth = 1;
  px.beginPath(); px.moveTo(-2, 12); px.lineTo(12, -2); px.moveTo(4, 12); px.lineTo(12, 4); px.stroke();
  _hatchPat = _ctx.createPattern(pc, 'repeat'); return _hatchPat;
}

function fillWall(pathFn, fill) {
  _ctx.save(); pathFn(); _ctx.fillStyle = fill; _ctx.fill();
  const h = hatch(); if (h) { pathFn(); _ctx.fillStyle = h; _ctx.fill(); }
  _ctx.restore();
}

function wallInteriorSide(wall, fallback = 1) {
  const mid = { x: (wall.x1 + wall.x2) / 2, y: (wall.y1 + wall.y2) / 2 };
  const angle = Math.atan2(wall.y2 - wall.y1, wall.x2 - wall.x1);
  const normal = { x: -Math.sin(angle), y: Math.cos(angle) };
  let best = null;
  for (const r of appState.rooms) {
    if (!r.boundarySegments.some(s => s.wall && s.wall.id === wall.id)) continue;
    const dot = (r.center.x - mid.x) * normal.x + (r.center.y - mid.y) * normal.y;
    if (Math.abs(dot) < 1) continue;
    if (best === null || Math.abs(dot) > Math.abs(best)) best = dot;
  }
  return best === null ? fallback : best >= 0 ? 1 : -1;
}

// ── Exported helpers ──────────────────────────────────────────────

// BASE_FONT_MM: фиксированный размер шрифта в мировых единицах (мм).
// При scale=0.12 → 10px на экране. При scale=0.5 → 42px (приближение).
// Текст физически растёт вместе с чертежом — читается одинаково на любом масштабе.
const BASE_FONT_MM    = 84;  // ~10px при стандартном масштабе
const BASE_FONT_SM_MM = 75;  // ~9px  для вторичных подписей

export function drawAlignedTextBox(text, pos, angle, opts = {}) {
  let a = angle;
  if (a > Math.PI / 2 || a < -Math.PI / 2) a += Math.PI;
  _ctx.save(); _ctx.translate(pos.x, pos.y); _ctx.rotate(a);

  // Размер шрифта в пикселях = BASE_MM * scale — статичен в мировых координатах
  const scale    = _getScale();
  const basePx   = BASE_FONT_MM * scale;
  // Из opts.font извлекаем weight и используем basePx как размер
  const weight   = opts.font ? (opts.font.match(/^(\d+)/) || ['','600'])[1] : '600';
  _ctx.font      = `${weight} ${basePx.toFixed(1)}px Onest, Inter, sans-serif`;

  // Тень для читаемости без подложки
  _ctx.shadowColor   = 'rgba(255,255,255,0.9)';
  _ctx.shadowBlur    = basePx * 0.4;
  _ctx.fillStyle     = opts.textColor || '#0f172a';
  _ctx.textAlign     = 'center';
  _ctx.textBaseline  = 'middle';
  _ctx.fillText(text, 0, 0);
  _ctx.shadowBlur    = 0;
  _ctx.restore();
}

export function getWallResizeHandles(wall) {
  return ['start', 'end'].map(ep => ({
    wall, endpoint: ep, point: getWallContourPoint(wall, ep),
    screen: toScreen(getWallContourPoint(wall, ep).x, getWallContourPoint(wall, ep).y),
  }));
}

export function getOpeningScreenBounds(op) {
  const wall = appState.walls.find(w => w.id === op.wallId); if (!wall) return null;
  const wlen = Math.hypot(wall.x2 - wall.x1, wall.y2 - wall.y1); if (wlen < 1) return null;
  const angle = Math.atan2(wall.y2 - wall.y1, wall.x2 - wall.x1);
  const halfT = wall.thickness / 2;
  const sdxW = -Math.sin(angle) * halfT, sdyW = Math.cos(angle) * halfT;
  const t1 = Math.max(0, Math.min(1, op.t - op.width / 2 / wlen));
  const t2 = Math.max(0, Math.min(1, op.t + op.width / 2 / wlen));
  const ax1 = wall.x1 + (wall.x2 - wall.x1) * t1, ay1 = wall.y1 + (wall.y2 - wall.y1) * t1;
  const ax2 = wall.x1 + (wall.x2 - wall.x1) * t2, ay2 = wall.y1 + (wall.y2 - wall.y1) * t2;
  const corners = [
    toScreen(ax1 + sdxW, ay1 + sdyW), toScreen(ax2 + sdxW, ay2 + sdyW),
    toScreen(ax2 - sdxW, ay2 - sdyW), toScreen(ax1 - sdxW, ay1 - sdyW),
  ];
  return { left: Math.min(...corners.map(p => p.x)), top: Math.min(...corners.map(p => p.y)),
           right: Math.max(...corners.map(p => p.x)), bottom: Math.max(...corners.map(p => p.y)) };
}

export function boundsIntersect(a, b) {
  return !(a.right < b.left || a.left > b.right || a.bottom < b.top || a.top > b.bottom);
}

export function hitTestWallResizeHandle(sp, tool, selectedItems) {
  if (tool !== 'select') return null;
  const wall = selectedItems.length === 1 && selectedItems[0].type === 'wall'
    ? appState.walls.find(w => w.id === selectedItems[0].id) : null;
  if (!wall) return null;
  for (const h of getWallResizeHandles(wall))
    if (Math.hypot(sp.x - h.screen.x, sp.y - h.screen.y) <= 10) return h;
  return null;
}

// ── MAIN REDRAW ───────────────────────────────────────────────────

export function redraw(ps) {
  if (!_ctx || !_canvas) return;
  _ctx.clearRect(0, 0, _canvas.width, _canvas.height);
  drawGrid();
  drawRoomFills(ps.selectedItems);
  drawWalls(ps.selectedItems);
  drawWallJoints(ps.selectedItems);
  drawDividers(ps.selectedItems);
  drawOpenings(ps.selectedItems, ps.defaultDoorHinge, ps.defaultDoorSwing);
  drawWallDimensions();
  drawOpeningLeaders(exteriorWallIds);
  drawSelectedHandles(ps.tool, ps.selectedItems, ps.wallResizeState);
  // Stage 1: базовая линия для выделенных стен (жёлтый пунктир)
  for (const item of ps.selectedItems) {
    if (item.type !== 'wall') continue;
    const wall = appState.walls.find(w => w.id === item.id);
    if (wall) drawBaseLine(wall);
  }
  if (ps.hoverItem) drawHoverHighlight(ps.hoverItem, ps.selectedItems, ps.defaultDoorHinge, ps.defaultDoorSwing);
  if (ps.hoverOpening) drawOpening(ps.hoverOpening, ps.hoverOpening.wall, true, false, ps.defaultDoorHinge, ps.defaultDoorSwing);
  if (ps.tool === 'wall' && ps.trackingLines?.length) {
    drawTrackingLines(ps.activeTrackingPoint, ps.trackingLines);
  }
  if (ps.isDrawing && ps.drawStart && ps.drawEnd) drawTempWall(ps);
  if (ps.tool === 'wall' && ps.currentGuideLine)  drawGuideLine(ps.currentGuideLine);
  if (ps.tool === 'wall' && ps.currentObjectSnap) drawCornerHotspots(ps.currentObjectSnap);
  if (ps.tool === 'wall' && ps.currentObjectSnap) drawObjectSnap(ps.currentObjectSnap);
  drawSelectionBox(ps.selectBoxStart, ps.selectBoxCurrent);
  drawCursorGhost(ps);
}

function drawHoverHighlight(hoverItem, selectedItems, dh, ds) {
  const isAlreadySelected = selectedItems.some(i => i.type === hoverItem.type && i.id === hoverItem.id);
  if (isAlreadySelected) return;
  _ctx.save();
  if (hoverItem.type === 'wall') {
    const wall = appState.walls.find(w => w.id === hoverItem.id);
    if (!wall) { _ctx.restore(); return; }
    const g = sg(wall);
    _ctx.beginPath();
    _ctx.moveTo(g.a.x, g.a.y); _ctx.lineTo(g.b.x, g.b.y);
    _ctx.lineTo(g.c.x, g.c.y); _ctx.lineTo(g.d.x, g.d.y);
    _ctx.closePath();
    _ctx.fillStyle = 'rgba(74,111,227,0.07)';
    _ctx.strokeStyle = 'rgba(74,111,227,0.45)';
    _ctx.lineWidth = 2; _ctx.lineJoin = 'miter'; _ctx.miterLimit = 10;
    _ctx.fill(); _ctx.stroke();
  } else if (hoverItem.type === 'opening') {
    const op = appState.openings.find(o => o.id === hoverItem.id);
    if (!op) { _ctx.restore(); return; }
    const wall = appState.walls.find(w => w.id === op.wallId);
    if (!wall) { _ctx.restore(); return; }
    const wlen = Math.hypot(wall.x2 - wall.x1, wall.y2 - wall.y1);
    const angle = Math.atan2(wall.y2 - wall.y1, wall.x2 - wall.x1);
    const halfT = wall.thickness / 2;
    const t1 = Math.max(0, Math.min(1, op.t - op.width / 2 / wlen));
    const t2 = Math.max(0, Math.min(1, op.t + op.width / 2 / wlen));
    const ax1 = wall.x1 + (wall.x2 - wall.x1) * t1, ay1 = wall.y1 + (wall.y2 - wall.y1) * t1;
    const ax2 = wall.x1 + (wall.x2 - wall.x1) * t2, ay2 = wall.y1 + (wall.y2 - wall.y1) * t2;
    const sdxW = -Math.sin(angle) * halfT, sdyW = Math.cos(angle) * halfT;
    const c1 = toScreen(ax1 + sdxW, ay1 + sdyW), c2 = toScreen(ax2 + sdxW, ay2 + sdyW);
    const c3 = toScreen(ax2 - sdxW, ay2 - sdyW), c4 = toScreen(ax1 - sdxW, ay1 - sdyW);
    _ctx.beginPath();
    _ctx.moveTo(c1.x, c1.y); _ctx.lineTo(c2.x, c2.y);
    _ctx.lineTo(c3.x, c3.y); _ctx.lineTo(c4.x, c4.y); _ctx.closePath();
    _ctx.fillStyle = 'rgba(74,111,227,0.10)';
    _ctx.strokeStyle = 'rgba(74,111,227,0.55)';
    _ctx.lineWidth = 2; _ctx.fill(); _ctx.stroke();
    drawOpening(op, wall, false, false, dh, ds);
  }
  _ctx.restore();
}

function drawGrid() {
  const W = _canvas.width, H = _canvas.height;
  const stepMin = 100, stepMaj = 1000;
  const wMin = toWorld(0, 0), wMax = toWorld(W, H);
  _ctx.save();
  _ctx.strokeStyle = '#e8eaee'; _ctx.lineWidth = 0.5;
  for (let x = Math.floor(wMin.x / stepMin) * stepMin; x <= wMax.x + stepMin; x += stepMin) {
    const sx = toScreen(x, 0).x; _ctx.beginPath(); _ctx.moveTo(sx, 0); _ctx.lineTo(sx, H); _ctx.stroke();
  }
  for (let y = Math.floor(wMin.y / stepMin) * stepMin; y <= wMax.y + stepMin; y += stepMin) {
    const sy = toScreen(0, y).y; _ctx.beginPath(); _ctx.moveTo(0, sy); _ctx.lineTo(W, sy); _ctx.stroke();
  }
  _ctx.strokeStyle = '#c8cdd8'; _ctx.lineWidth = 1;
  for (let x = Math.floor(wMin.x / stepMaj) * stepMaj; x <= wMax.x + stepMaj; x += stepMaj) {
    const sx = toScreen(x, 0).x; _ctx.beginPath(); _ctx.moveTo(sx, 0); _ctx.lineTo(sx, H); _ctx.stroke();
  }
  for (let y = Math.floor(wMin.y / stepMaj) * stepMaj; y <= wMax.y + stepMaj; y += stepMaj) {
    const sy = toScreen(0, y).y; _ctx.beginPath(); _ctx.moveTo(0, sy); _ctx.lineTo(W, sy); _ctx.stroke();
  }
  _ctx.fillStyle = '#a0aab8'; _ctx.font = '10px Onest, Inter, sans-serif'; _ctx.textAlign = 'left';
  for (let x = Math.floor(wMin.x / stepMaj) * stepMaj; x <= wMax.x + stepMaj; x += stepMaj) {
    const sx = toScreen(x, 0).x; if (sx > 2 && sx < W - 2) _ctx.fillText((x / 1000).toFixed(0) + 'м', sx + 2, 12);
  }
  for (let y = Math.floor(wMin.y / stepMaj) * stepMaj; y <= wMax.y + stepMaj; y += stepMaj) {
    const sy = toScreen(0, y).y; if (sy > 14 && sy < H - 2) _ctx.fillText((y / 1000).toFixed(0) + 'м', 2, sy - 2);
  }
  _ctx.restore();
}

function drawRoomFills(selectedItems) {
  const scale = _getScale();
  for (let i = 0; i < appState.rooms.length; i++) {
    const r = appState.rooms[i];
    _ctx.save();

    if (r.polygon && r.polygon.length >= 3) {
      // Новый векторный метод
      _ctx.beginPath();
      const first = toScreen(r.polygon[0].x, r.polygon[0].y);
      _ctx.moveTo(first.x, first.y);
      for (let j = 1; j < r.polygon.length; j++) {
        const p = toScreen(r.polygon[j].x, r.polygon[j].y);
        _ctx.lineTo(p.x, p.y);
      }
      _ctx.closePath();
      _ctx.fillStyle = ROOM_COLORS[i % ROOM_COLORS.length];
      _ctx.fill();
      // Тонкая обводка для устранения возможных зазоров
      _ctx.strokeStyle = ROOM_COLORS[i % ROOM_COLORS.length];
      _ctx.lineWidth = 1;
      _ctx.stroke();
    } else if (r.cells) {
      // Старый метод (fallback)
      const OVERLAP_MM = 32;
      _ctx.beginPath();
      for (const c of r.cells) {
        const p = toScreen(c.x1 - OVERLAP_MM / 2, c.y1 - OVERLAP_MM / 2);
        const w = (c.x2 - c.x1 + OVERLAP_MM) * scale;
        const h = (c.y2 - c.y1 + OVERLAP_MM) * scale;
        _ctx.rect(p.x, p.y, w, h);
      }
      _ctx.fillStyle = ROOM_COLORS[i % ROOM_COLORS.length];
      _ctx.fill();
    }

    // Текст метки (как было)
    if (scale > 0.08) {
      const center = r.center || (r.polygon ? polygonCentroid(r.polygon) : { x: 0, y: 0 });
      const sc = toScreen(center.x, center.y);
      _ctx.fillStyle = DRAW_COLORS.roomLabel;
      _ctx.font = `600 ${(scale * 200).toFixed(1)}px Onest, Inter, sans-serif`;
      _ctx.textAlign = 'center'; _ctx.textBaseline = 'middle';
      _ctx.fillText(r.name, sc.x, sc.y);
      _ctx.font = `500 ${(scale * 160).toFixed(1)}px Onest, Inter, sans-serif`;
      _ctx.fillStyle = DRAW_COLORS.roomMeta;
      _ctx.fillText(`${r.area.toFixed(2)} м²`, sc.x, sc.y + Math.max(10, scale * 180));
    }
    _ctx.restore();
  }
}

function drawDividers(selectedItems) {
  if (!appState.dividers || !appState.dividers.length) return;
  
  _ctx.save();
  _ctx.strokeStyle = '#f97316'; // оранжевый
  _ctx.lineWidth = 2.5;
  _ctx.setLineDash([12, 8]);
  _ctx.lineCap = 'round';
  
  for (const d of appState.dividers) {
    const p1 = toScreen(d.x1, d.y1);
    const p2 = toScreen(d.x2, d.y2);
    _ctx.beginPath();
    _ctx.moveTo(p1.x, p1.y);
    _ctx.lineTo(p2.x, p2.y);
    _ctx.stroke();
  }
  
  _ctx.setLineDash([]);
  _ctx.restore();
}

function drawWalls(selectedItems) {
  const scale = _getScale();
  const jmap = buildWallJointMap();
  const jrects = getWallJointRects();

  // Предварительно вычисляем clip-точки для всех стен
  const wallData = appState.walls.map(w => {
    const g = sg(w);
    const isSel = sel('wall', w.id, selectedItems);
    const style = wallStyle(isSel);
    const sjItems = getWallJointItemsForEndpoint(jmap, w, 'start').filter(it => it.wall.id !== w.id);
    const ejItems = getWallJointItemsForEndpoint(jmap, w, 'end').filter(it => it.wall.id !== w.id);
    const sj = sjItems.length > 0 || isWallEndpointCoveredByAnotherWall(w, 'start');
    const ej = ejItems.length > 0 || isWallEndpointCoveredByAnotherWall(w, 'end');
    const myJoints = jrects.filter(jr => jr.wallIds.includes(w.id));
    const sp = getWallContourPoint(w, 'start');
    const ep = getWallContourPoint(w, 'end');
    const hasStartJR = myJoints.some(jr =>
      sp.x >= jr.left-2 && sp.x <= jr.right+2 && sp.y >= jr.top-2 && sp.y <= jr.bottom+2);
    const hasEndJR = myJoints.some(jr =>
      ep.x >= jr.left-2 && ep.x <= jr.right+2 && ep.y >= jr.top-2 && ep.y <= jr.bottom+2);

    // Stage 4: коллинеарных соседей исключаем из clip-расчёта —
    // у параллельных граней нет точки пересечения, clip всё равно вернул бы null,
    // но явное исключение делает намерение понятным.
    // Не-коллинеарных соседей сортируем по приоритету: более «главная» стена
    // клипает нашу грань первой, т.е. её линия «побеждает» при T-стыке.
    const filterAndSort = items =>
      items
        .filter(it => !areWallsCollinear(w, it.wall))
        .sort((a, b) => (b.wall.priority ?? 0) - (a.wall.priority ?? 0))
        .map(i => i.wall);

    const wclipS = (sj && !hasStartJR) ? getWorldFaceClips(w, filterAndSort(sjItems), 'start') : null;
    const wclipE = (ej && !hasEndJR)   ? getWorldFaceClips(w, filterAndSort(ejItems), 'end')   : null;

    // Screen-координаты 4 углов с учётом clip
    const ptA = wclipS?.ab ? toScreen(wclipS.ab.x, wclipS.ab.y) : g.a;
    const ptB = wclipE?.ab ? toScreen(wclipE.ab.x, wclipE.ab.y) : g.b;
    const ptC = wclipE?.dc ? toScreen(wclipE.dc.x, wclipE.dc.y) : g.c;
    const ptD = wclipS?.dc ? toScreen(wclipS.dc.x, wclipS.dc.y) : g.d;
    return { w, g, isSel, style, sj, ej, myJoints, ptA, ptB, ptC, ptD };
  });

  // Pass 1: fill обрезанным полигоном
  for (const { style, ptA, ptB, ptC, ptD } of wallData) {
    fillWall(() => {
      _ctx.beginPath();
      _ctx.moveTo(ptA.x, ptA.y); _ctx.lineTo(ptB.x, ptB.y);
      _ctx.lineTo(ptC.x, ptC.y); _ctx.lineTo(ptD.x, ptD.y);
      _ctx.closePath();
    }, style.fill);
  }

  // Pass 2: fill joint rects (ортогональные углы)
  for (const jr of jrects) {
    const isSel = jr.wallIds.some(id => sel('wall', id, selectedItems));
    const style = wallStyle(isSel);
    const tl = toScreen(jr.left, jr.top), br = toScreen(jr.right, jr.bottom);
    const rl = Math.min(tl.x, br.x), rt = Math.min(tl.y, br.y);
    const rr = Math.max(tl.x, br.x), rb = Math.max(tl.y, br.y);
    fillWall(() => { _ctx.beginPath(); _ctx.rect(rl, rt, rr-rl, rb-rt); }, style.fill);
  }

  // Pass 3: stroke outlines
  for (const { w, g, isSel, style, sj, ej, myJoints, ptA, ptB, ptC, ptD } of wallData) {
    _ctx.save();
    _ctx.strokeStyle = style.stroke; _ctx.lineWidth = isSel ? 1.5 : 1;
    _ctx.lineCap = 'butt'; _ctx.lineJoin = 'miter'; _ctx.miterLimit = 10;
    _ctx.beginPath();

    // Получаем контурные точки для проверки покрытия торцов
    const sp = getWallContourPoint(w, 'start');
    const ep = getWallContourPoint(w, 'end');
    const startCovered = appState.walls.some(other => other.id !== w.id && isPointInsideWallSurface(sp, other, 15));
    const endCovered   = appState.walls.some(other => other.id !== w.id && isPointInsideWallSurface(ep, other, 15));

    // Проверяем, перекрыта ли грань другой стеной
    const midAB = { x: (g.a.x + g.b.x) / 2, y: (g.a.y + g.b.y) / 2 };
    const midDC = { x: (g.d.x + g.c.x) / 2, y: (g.d.y + g.c.y) / 2 };
    const worldAB = toWorld(midAB.x, midAB.y);
    const worldDC = toWorld(midDC.x, midDC.y);

    const abCovered = appState.walls.some(other => other.id !== w.id && isPointInsideWallSurface(worldAB, other, 15));
    const dcCovered = appState.walls.some(other => other.id !== w.id && isPointInsideWallSurface(worldDC, other, 15));

    // Рисуем грань ab только если она не перекрыта
    if (!abCovered) {
      drawClippedFace(ptA, ptB, myJoints);
    }
    // Рисуем грань dc только если она не перекрыта
    if (!dcCovered) {
      drawClippedFace(ptD, ptC, myJoints);
    }

    // Stage 4: торцевые заглушки не рисуем если:
    //   a) конец стыкуется с другой стеной (sj/ej), ИЛИ
    //   b) конец касается коллинеарной стены, ИЛИ
    //   c) конец перекрыт другой стеной (startCovered/endCovered)
    const jmapStart = getWallJointItemsForEndpoint(jmap, w, 'start').filter(it => it.wall.id !== w.id);
    const jmapEnd   = getWallJointItemsForEndpoint(jmap, w, 'end').filter(it => it.wall.id !== w.id);
    const collinearAtStart = jmapStart.some(it => areWallsCollinear(w, it.wall));
    const collinearAtEnd   = jmapEnd.some(it => areWallsCollinear(w, it.wall));

    if (!ej && !collinearAtEnd && !endCovered)   { _ctx.moveTo(g.b.x, g.b.y); _ctx.lineTo(g.c.x, g.c.y); }
    if (!sj && !collinearAtStart && !startCovered) { _ctx.moveTo(g.d.x, g.d.y); _ctx.lineTo(g.a.x, g.a.y); }

    _ctx.stroke();
    _ctx.restore();
  }
}

// Пересечение двух бесконечных линий в 2D.
// Возвращает точку {x,y} или null если параллельны.
function lineLineIntersect(a, b, c, d) {
  const r = { x: b.x - a.x, y: b.y - a.y };
  const s = { x: d.x - c.x, y: d.y - c.y };
  const denom = r.x * s.y - r.y * s.x;
  if (Math.abs(denom) < 0.0001) return null;
  const t = ((c.x - a.x) * s.y - (c.y - a.y) * s.x) / denom;
  return { x: a.x + r.x * t, y: a.y + r.y * t };
}

// Вычисляет clip-точки для диагональных стыков в world-координатах.
// ab грань нашей стены встречается с ab гранью соседа, dc — с dc.
// Валидация: clip-точка должна быть в правильной половине стены (не уходить за середину).
function getWorldFaceClips(wall, neighbors, endpoint) {
  const wg = getWallWorldGeometry(wall);
  const result = { ab: null, dc: null };

  for (const n of neighbors) {
    const ng = getWallWorldGeometry(n);

    const ptAB = lineLineIntersect(wg.a, wg.b, ng.a, ng.b);
    if (ptAB) {
      const dx = wg.b.x - wg.a.x, dy = wg.b.y - wg.a.y;
      const len2 = dx*dx + dy*dy;
      if (len2 > 0.0001) {
        const t = ((ptAB.x - wg.a.x)*dx + (ptAB.y - wg.a.y)*dy) / len2;
        // start: t ∈ [-0.5, 0.5]; end: t ∈ [0.5, 1.5]
        if (endpoint === 'start' ? (t >= -0.5 && t <= 0.5) : (t >= 0.5 && t <= 1.5))
          result.ab = ptAB;
      }
    }

    const ptDC = lineLineIntersect(wg.d, wg.c, ng.d, ng.c);
    if (ptDC) {
      const dx = wg.c.x - wg.d.x, dy = wg.c.y - wg.d.y;
      const len2 = dx*dx + dy*dy;
      if (len2 > 0.0001) {
        const t = ((ptDC.x - wg.d.x)*dx + (ptDC.y - wg.d.y)*dy) / len2;
        if (endpoint === 'start' ? (t >= -0.5 && t <= 0.5) : (t >= 0.5 && t <= 1.5))
          result.dc = ptDC;
      }
    }
  }
  return result;
}

// Рисует грань от sa до ea, пропуская участки внутри joint rects (ортогональные стыки).
function drawClippedFace(sa, ea, joints) {
  const dx = ea.x - sa.x, dy = ea.y - sa.y;
  const len = Math.hypot(dx, dy);
  if (len < 0.5) return;

  if (!joints.length) {
    _ctx.moveTo(sa.x, sa.y); _ctx.lineTo(ea.x, ea.y);
    return;
  }

  const skip = [];
  for (const jr of joints) {
    const tl = toScreen(jr.left, jr.top), br = toScreen(jr.right, jr.bottom);
    const rl = Math.min(tl.x, br.x) - 1, rt = Math.min(tl.y, br.y) - 1;
    const rr = Math.max(tl.x, br.x) + 1, rb = Math.max(tl.y, br.y) + 1;
    let tEnter = 0, tExit = 1;
    const params = [
      dx !== 0 ? (rl - sa.x) / dx : (sa.x >= rl ? 0 : 1),
      dx !== 0 ? (rr - sa.x) / dx : (sa.x <= rr ? 1 : 0),
      dy !== 0 ? (rt - sa.y) / dy : (sa.y >= rt ? 0 : 1),
      dy !== 0 ? (rb - sa.y) / dy : (sa.y <= rb ? 1 : 0),
    ];
    tEnter = Math.max(tEnter, Math.min(params[0], params[1]), Math.min(params[2], params[3]));
    tExit  = Math.min(tExit,  Math.max(params[0], params[1]), Math.max(params[2], params[3]));
    if (tEnter < tExit - 0.01) skip.push([tEnter, tExit]);
  }

  if (!skip.length) {
    _ctx.moveTo(sa.x, sa.y); _ctx.lineTo(ea.x, ea.y);
    return;
  }

  skip.sort((a, b) => a[0] - b[0]);
  let cur = 0;
  for (const [t1, t2] of skip) {
    if (cur < t1 - 0.01) {
      _ctx.moveTo(sa.x + dx * cur, sa.y + dy * cur);
      _ctx.lineTo(sa.x + dx * t1,  sa.y + dy * t1);
    }
    cur = Math.max(cur, t2);
  }
  if (cur < 1 - 0.01) {
    _ctx.moveTo(sa.x + dx * cur, sa.y + dy * cur);
    _ctx.lineTo(ea.x, ea.y);
  }
}

function drawWallJoints(selectedItems) {
  for (const jr of getWallJointRects()) {
    const isSel = jr.wallIds.some(id => sel('wall', id, selectedItems));
    const style = wallStyle(isSel);
    const tl = toScreen(jr.left, jr.top), br = toScreen(jr.right, jr.bottom);
    const rl = Math.min(tl.x, br.x), rt = Math.min(tl.y, br.y);
    const rr = Math.max(tl.x, br.x), rb = Math.max(tl.y, br.y);
    // Заливка стыка
    fillWall(() => { _ctx.beginPath(); _ctx.rect(rl, rt, rr - rl, rb - rt); }, style.fill);
    // Контур — только boundary edges (внешние грани стыка)
    _ctx.save();
    _ctx.strokeStyle = style.stroke;
    _ctx.lineWidth = isSel ? 1.5 : 1;
    _ctx.lineCap = 'round'; _ctx.lineJoin = 'round';
    _ctx.beginPath();
    for (const path of getJointBoundaryPaths(jr)) {
      if (!path.length) continue;
      const s = toScreen(path[0].x, path[0].y);
      _ctx.moveTo(s.x, s.y);
      for (let i = 1; i < path.length; i++) {
        const p = toScreen(path[i].x, path[i].y);
        _ctx.lineTo(p.x, p.y);
      }
    }
    _ctx.stroke();
    _ctx.restore();
  }
}

function drawOpenings(selectedItems, dh, ds) {
  for (const op of appState.openings) {
    const wall = appState.walls.find(w => w.id === op.wallId); if (!wall) continue;
    drawOpening(op, wall, false, sel('opening', op.id, selectedItems), dh, ds);
  }
}

function drawOpening(op, wall, isHover, isSel, dh, ds) {
  const wlen = Math.hypot(wall.x2 - wall.x1, wall.y2 - wall.y1); if (wlen < 1) return;
  const angle = Math.atan2(wall.y2 - wall.y1, wall.x2 - wall.x1);
  const halfW = op.width / 2;
  const t1 = Math.max(0, Math.min(1, op.t - halfW / wlen)), t2 = Math.max(0, Math.min(1, op.t + halfW / wlen));
  const ax1 = wall.x1 + (wall.x2 - wall.x1) * t1, ay1 = wall.y1 + (wall.y2 - wall.y1) * t1;
  const ax2 = wall.x1 + (wall.x2 - wall.x1) * t2, ay2 = wall.y1 + (wall.y2 - wall.y1) * t2;
  const p1 = toScreen(ax1, ay1), p2 = toScreen(ax2, ay2);
  // sdx/sdy — перпендикуляр ровно на половину толщины стены
  const scale = _getScale();
  const halfT = wall.thickness / 2;
  const sdx = -Math.sin(angle) * halfT * scale, sdy = Math.cos(angle) * halfT * scale;
  // Правильные экранные smещения от оси
  const sdxW = -Math.sin(angle) * halfT, sdyW = Math.cos(angle) * halfT;
  // Экранные координаты 4 углов проёма (строго в пределах толщины стены)
  const c1 = toScreen(ax1 + sdxW, ay1 + sdyW);
  const c2 = toScreen(ax2 + sdxW, ay2 + sdyW);
  const c3 = toScreen(ax2 - sdxW, ay2 - sdyW);
  const c4 = toScreen(ax1 - sdxW, ay1 - sdyW);

  const color = op.type === 'window' ? DRAW_COLORS.windowStroke : DRAW_COLORS.doorStroke;
  const fillColor = op.type === 'window' ? (isHover ? DRAW_COLORS.windowHover : DRAW_COLORS.windowFill)
    : (isHover ? DRAW_COLORS.doorHover : DRAW_COLORS.doorFill);
  const doorHinge = op.hinge || dh, doorSwing = op.swing ?? ds;
  _ctx.save();

  if (op.type === 'window') {
    // Заливка проёма
    _ctx.beginPath();
    _ctx.moveTo(c1.x, c1.y); _ctx.lineTo(c2.x, c2.y);
    _ctx.lineTo(c3.x, c3.y); _ctx.lineTo(c4.x, c4.y); _ctx.closePath();
    _ctx.fillStyle = '#fcfcfd'; _ctx.fill();
    _ctx.fillStyle = fillColor; _ctx.fill();

    // Только две длинные стороны (вдоль стены) — рама окна
    _ctx.strokeStyle = color; _ctx.lineWidth = isSel ? 2 : 1.5;
    _ctx.beginPath();
    _ctx.moveTo(c1.x, c1.y); _ctx.lineTo(c2.x, c2.y); // внешняя грань
    _ctx.moveTo(c4.x, c4.y); _ctx.lineTo(c3.x, c3.y); // внутренняя грань
    // Торцы рамы
    _ctx.moveTo(c1.x, c1.y); _ctx.lineTo(c4.x, c4.y);
    _ctx.moveTo(c2.x, c2.y); _ctx.lineTo(c3.x, c3.y);
    _ctx.stroke();

    // Одна средняя линия — стеклопакет (одна линия посередине вдоль стены)
    const mx1 = (c1.x + c4.x) / 2, my1 = (c1.y + c4.y) / 2;
    const mx2 = (c2.x + c3.x) / 2, my2 = (c2.y + c3.y) / 2;
    _ctx.beginPath(); _ctx.moveTo(mx1, my1); _ctx.lineTo(mx2, my2);
    _ctx.lineWidth = 1; _ctx.stroke();

  } else {
    // Дверь: только белая заливка проёма (без обводки прямоугольника)
    _ctx.beginPath();
    _ctx.moveTo(c1.x, c1.y); _ctx.lineTo(c2.x, c2.y);
    _ctx.lineTo(c3.x, c3.y); _ctx.lineTo(c4.x, c4.y); _ctx.closePath();
    _ctx.fillStyle = '#fcfcfd'; _ctx.fill();

    const hp = doorHinge === 'start' ? p1 : p2;
    const leafEnd = doorHinge === 'start' ? p2 : p1;
    const leafLen = Math.hypot(leafEnd.x - hp.x, leafEnd.y - hp.y);
    const baseAngle = doorHinge === 'start' ? angle : angle + Math.PI;
    const openAngle = baseAngle + doorSwing * Math.PI / 2;
    const arcEnd = { x: hp.x + Math.cos(openAngle) * leafLen, y: hp.y + Math.sin(openAngle) * leafLen };

    // Линия петли через толщину стены
    const hc1 = doorHinge === 'start' ? c1 : c2;
    const hc2 = doorHinge === 'start' ? c4 : c3;
    _ctx.strokeStyle = color; _ctx.lineWidth = isSel ? 2 : 1.5; _ctx.setLineDash([]);
    _ctx.beginPath();
    _ctx.moveTo(hc1.x, hc1.y); _ctx.lineTo(hc2.x, hc2.y);
    // Полотно двери в закрытом положении
    _ctx.moveTo(hp.x, hp.y); _ctx.lineTo(leafEnd.x, leafEnd.y);
    _ctx.stroke();
    // Дуга траектории
    _ctx.beginPath(); _ctx.arc(hp.x, hp.y, leafLen, baseAngle, openAngle, doorSwing < 0);
    _ctx.lineWidth = 1; _ctx.setLineDash([4, 3]); _ctx.stroke(); _ctx.setLineDash([]);
    // Полотно в открытом положении
    _ctx.beginPath(); _ctx.moveTo(hp.x, hp.y); _ctx.lineTo(arcEnd.x, arcEnd.y);
    _ctx.lineWidth = isSel ? 2 : 1.5; _ctx.stroke();
  }

  if (isHover) drawOpeningDimensions(op, wall, angle, { x1: ax1, y1: ay1, x2: ax2, y2: ay2 });
  _ctx.restore();
}

function drawOpeningDimensions(op, wall, angle, seg) {
  const ws = toScreen(wall.x1, wall.y1), we = toScreen(wall.x2, wall.y2);
  const os = toScreen(seg.x1, seg.y1), oe = toScreen(seg.x2, seg.y2);
  const normal = { x: -Math.sin(angle), y: Math.cos(angle) };
  const side = wallInteriorSide(wall, 1), off = wall.thickness / 2 + 18;
  const oP = p => ({ x: p.x + normal.x * off * side, y: p.y + normal.y * off * side });
  const dim = (from, to, label, color) => {
    if (Math.hypot(to.x - from.x, to.y - from.y) < 8) return;
    const fo = oP(from), to2 = oP(to);
    _ctx.save(); _ctx.strokeStyle = color; _ctx.lineWidth = 1;
    _ctx.beginPath(); _ctx.moveTo(from.x, from.y); _ctx.lineTo(fo.x, fo.y);
    _ctx.moveTo(to.x, to.y); _ctx.lineTo(to2.x, to2.y); _ctx.moveTo(fo.x, fo.y); _ctx.lineTo(to2.x, to2.y); _ctx.stroke(); _ctx.restore();
    drawAlignedTextBox(label, { x: (fo.x + to2.x) / 2, y: (fo.y + to2.y) / 2 }, angle);
  };
  const wlen = Math.hypot(wall.x2 - wall.x1, wall.y2 - wall.y1);
  dim(ws, os, `${Math.round(op.t * wlen - op.width / 2)} мм`, DRAW_COLORS.dimension);
  dim(os, oe, `${op.width} мм`, op.type === 'window' ? DRAW_COLORS.windowStroke : DRAW_COLORS.doorStroke);
  dim(oe, we, `${Math.round(wlen - (op.t * wlen + op.width / 2))} мм`, DRAW_COLORS.dimension);
}

function drawSelectedHandles(tool, selectedItems, wallResizeState) {
  if (tool !== 'select') return;
  const wall = selectedItems.length === 1 && selectedItems[0].type === 'wall'
    ? appState.walls.find(w => w.id === selectedItems[0].id) : null;
  if (!wall) return;
  for (const h of getWallResizeHandles(wall)) {
    const active = wallResizeState?.wallId === wall.id && wallResizeState?.endpoint === h.endpoint;
    _ctx.save(); _ctx.beginPath(); _ctx.arc(h.screen.x, h.screen.y, active ? 7.5 : 6.5, 0, Math.PI * 2);
    _ctx.fillStyle = DRAW_COLORS.handleFill; _ctx.fill();
    _ctx.strokeStyle = active ? DRAW_COLORS.handleActive : DRAW_COLORS.handleStroke;
    _ctx.lineWidth = active ? 2.5 : 1.8; _ctx.stroke();
    _ctx.beginPath(); _ctx.arc(h.screen.x, h.screen.y, 2, 0, Math.PI * 2);
    _ctx.fillStyle = active ? DRAW_COLORS.handleActive : DRAW_COLORS.handleStroke; _ctx.fill(); _ctx.restore();
  }
}

// ── Stage 3: линии отслеживания (фиолетовые) ─────────────────────
// Рисует бесконечные лучи от активированной точки + фиолетовую точку-якорь.
function drawTrackingLines(activeTrackingPoint, trackingLines) {
  if (!activeTrackingPoint || !trackingLines?.length) return;
  const anchor = toScreen(activeTrackingPoint.x, activeTrackingPoint.y);
  const SPAN   = Math.max(_canvas.width, _canvas.height) * 2;

  _ctx.save();

  // Лучи
  _ctx.strokeStyle = 'rgba(109, 40, 217, 0.5)';
  _ctx.lineWidth   = 1;
  _ctx.lineCap     = 'round';
  for (const line of trackingLines) {
    // Направление одинаково в мировых и экранных координатах (нет поворота вьюпорта)
    _ctx.setLineDash(line.lineType === 'axis' ? [3, 8] : [6, 6]);
    _ctx.beginPath();
    _ctx.moveTo(anchor.x - line.dir.x * SPAN, anchor.y - line.dir.y * SPAN);
    _ctx.lineTo(anchor.x + line.dir.x * SPAN, anchor.y + line.dir.y * SPAN);
    _ctx.stroke();
  }

  // Точка-якорь (фиолетовый кружок с белой обводкой)
  _ctx.setLineDash([]);
  _ctx.beginPath();
  _ctx.arc(anchor.x, anchor.y, 5.5, 0, Math.PI * 2);
  _ctx.fillStyle   = 'rgba(109, 40, 217, 0.9)';
  _ctx.fill();
  _ctx.strokeStyle = '#fff';
  _ctx.lineWidth   = 1.5;
  _ctx.stroke();

  _ctx.restore();
}

// ── Stage 1: базовая линия (жёлтый пунктир как в Renga) ──────────
// Показывается только для выделенных стен. Это cx1/cy1 → cx2/cy2 —
// линия, которую рисовал пользователь и которая не двигается при
// изменении offset/thickness.
function drawBaseLine(wall) {
  const p1 = toScreen(wall.cx1 ?? wall.x1, wall.cy1 ?? wall.y1);
  const p2 = toScreen(wall.cx2 ?? wall.x2, wall.cy2 ?? wall.y2);
  _ctx.save();
  _ctx.strokeStyle = 'rgba(202, 138, 4, 0.75)'; // янтарный — как в Renga
  _ctx.lineWidth   = 1.5;
  _ctx.setLineDash([8, 5]);
  _ctx.lineCap     = 'round';
  _ctx.beginPath();
  _ctx.moveTo(p1.x, p1.y);
  _ctx.lineTo(p2.x, p2.y);
  _ctx.stroke();
  _ctx.setLineDash([]);
  _ctx.restore();
}

function drawTempWall(ps) {
  const { drawStart: ds, drawEnd: de, chainMode, lengthMode, lengthInput, wallOffset, inpWallThick, lengthOverlay, lengthLabel, lblLen, lblLenVal } = ps;
  if (!ds || !de) return;
  const scale = _getScale(), thick = parseFloat(inpWallThick?.value) || 200;
  const angle = Math.atan2(de.y - ds.y, de.x - ds.x);
  const ao = (cx, cy, off) => {
    if (off === 'center') return { x: cx, y: cy };
    const px = -Math.sin(angle), py = Math.cos(angle), sign = off === 'right' ? 1 : -1;
    return { x: cx + sign * px * thick / 2, y: cy + sign * py * thick / 2 };
  };
  const s = ao(ds.x, ds.y, wallOffset), e2 = ao(de.x, de.y, wallOffset);
  const p1 = toScreen(s.x, s.y), p2 = toScreen(e2.x, e2.y);
  const ps1 = toScreen(ds.x, ds.y), ps2 = toScreen(de.x, de.y);
  const halfT = (thick / 2) * scale;
  const ndx = -Math.sin(angle) * halfT, ndy = Math.cos(angle) * halfT;
  const len = Math.hypot(de.x - ds.x, de.y - ds.y);
  _ctx.save();
  _ctx.beginPath(); _ctx.moveTo(p1.x + ndx, p1.y + ndy); _ctx.lineTo(p2.x + ndx, p2.y + ndy);
  _ctx.lineTo(p2.x - ndx, p2.y - ndy); _ctx.lineTo(p1.x - ndx, p1.y - ndy); _ctx.closePath();
  _ctx.fillStyle = DRAW_COLORS.previewFill; _ctx.fill();
  _ctx.strokeStyle = DRAW_COLORS.previewStroke; _ctx.lineWidth = 1.5; _ctx.setLineDash([6, 4]); _ctx.stroke(); _ctx.setLineDash([]);
  _ctx.beginPath(); _ctx.moveTo(ps1.x, ps1.y); _ctx.lineTo(ps2.x, ps2.y);
  _ctx.strokeStyle = DRAW_COLORS.previewCenterLine; _ctx.lineWidth = 0.8; _ctx.setLineDash([3, 4]); _ctx.stroke(); _ctx.setLineDash([]);
  _ctx.beginPath(); _ctx.arc(ps1.x, ps1.y, chainMode ? 6 : 4, 0, Math.PI * 2);
  _ctx.fillStyle = chainMode ? DRAW_COLORS.handleActive : DRAW_COLORS.previewStroke; _ctx.fill(); _ctx.strokeStyle = '#fff'; _ctx.lineWidth = 1.5; _ctx.stroke();
  const snapType = de.snapType, endSnap = !!snapType || de.snappedToEndpoint;
  const scm = { corner: DRAW_COLORS.corner, endpoint: DRAW_COLORS.endpoint, midpoint: DRAW_COLORS.midpoint,
    intersection: DRAW_COLORS.intersection, perpendicular: DRAW_COLORS.perpendicular, wallFace: DRAW_COLORS.wallFace, wallAxis: DRAW_COLORS.wallAxis };
  _ctx.beginPath(); _ctx.arc(ps2.x, ps2.y, endSnap ? 8 : 4, 0, Math.PI * 2);
  _ctx.fillStyle = scm[snapType] || (endSnap ? DRAW_COLORS.endpoint : DRAW_COLORS.previewStroke);
  _ctx.fill(); _ctx.strokeStyle = '#fff'; _ctx.lineWidth = 1.5; _ctx.stroke();
  if (endSnap) { _ctx.beginPath(); _ctx.arc(ps2.x, ps2.y, 14, 0, Math.PI * 2); _ctx.strokeStyle = 'rgba(55,65,81,0.35)'; _ctx.lineWidth = 2; _ctx.stroke(); }
  if (chainMode) {
    _ctx.fillStyle = 'rgba(55,65,81,0.92)'; _ctx.beginPath();
    if (_ctx.roundRect) _ctx.roundRect(8, 32, 130, 20, 4); else _ctx.rect(8, 32, 130, 20); _ctx.fill();
    _ctx.fillStyle = '#fff'; _ctx.font = '600 11px Onest, Inter, sans-serif'; _ctx.textAlign = 'left'; _ctx.textBaseline = 'middle';
    _ctx.fillText('⛓ Цепочка стен · Esc — стоп', 14, 42);
  }
  _ctx.restore();
  const midX = (ps1.x + ps2.x) / 2, midY = (ps1.y + ps2.y) / 2;
  if (lengthOverlay) lengthOverlay.style.display = 'block';
  if (lengthLabel) { lengthLabel.style.left = midX + 'px'; lengthLabel.style.top = (midY - 8) + 'px';
    lengthLabel.textContent = (lengthMode && lengthInput) ? `${lengthInput}_ мм` : `${Math.round(len)} мм`; }
  if (lblLen) lblLen.style.display = 'inline';
  if (lblLenVal) lblLenVal.textContent = Math.round(len);
}

// ══════════════════════════════════════════════════════════════════
// ══════════════════════════════════════════════════════════════════
// РАЗМЕРНЫЕ ЦЕПОЧКИ
// Снаружи стены: общий размер угол-угол
// Внутри помещения: цепочка от угла до проёма / проём / от проёма до угла
// Если проёмов нет — только внешний общий размер
// ══════════════════════════════════════════════════════════════════
// ══════════════════════════════════════════════════════════════════
// ЗАСЕЧКА 45° (архитектурный стиль)
// ══════════════════════════════════════════════════════════════════
function drawTick45(screenPt, angle) {
  const TICK = 5 * _fontScale;
  const a = angle + Math.PI / 4;
  _ctx.moveTo(screenPt.x - Math.cos(a) * TICK, screenPt.y - Math.sin(a) * TICK);
  _ctx.lineTo(screenPt.x + Math.cos(a) * TICK, screenPt.y + Math.sin(a) * TICK);
}

// ══════════════════════════════════════════════════════════════════
// РАЗМЕРНЫЕ ЦЕПОЧКИ
// Снаружи: общий размер угол-угол с засечками 45°
// Внутри:  цепочка угол→проём→угол (только если есть проёмы)
// ══════════════════════════════════════════════════════════════════
function drawWallDimensions() {
  const scale = _getScale();
  if (scale < 0.07) return;
  _ctx.save();

  for (const wall of appState.walls) {
    const wlen = Math.hypot(wall.x2 - wall.x1, wall.y2 - wall.y1);
    if (wlen < 100) continue;

    const angle  = Math.atan2(wall.y2 - wall.y1, wall.x2 - wall.x1);
    const ux = Math.cos(angle), uy = Math.sin(angle);
    const nx = -uy, ny = ux;
    const interiorSign = wallInteriorSide(wall, 1);
    const halfT = wall.thickness / 2;

    const worldPt = (along, normalOff) => ({
      x: wall.x1 + ux * along + nx * normalOff,
      y: wall.y1 + uy * along + ny * normalOff,
    });
    const sp = (along, normalOff) => toScreen(worldPt(along, normalOff).x, worldPt(along, normalOff).y);

    // Проёмы
    const wallOpenings = appState.openings
      .filter(op => op.wallId === wall.id)
      .map(op => ({
        op,
        start: Math.max(0, op.t * wlen - op.width / 2),
        end:   Math.min(wlen, op.t * wlen + op.width / 2),
      }))
      .sort((a, b) => a.start - b.start);
    const hasOpenings = wallOpenings.length > 0;

    // Рисует одну размерную линию по набору tick-позиций
    const drawChain = (ticks, normalOff, lineColor) => {
      const sorted = [...new Set(ticks)].sort((a, b) => a - b);
      if (sorted.length < 2) return;
      const GAP = 15;
      const p1 = sp(sorted[0] + GAP, normalOff);
      const p2 = sp(sorted[sorted.length-1] - GAP, normalOff);
      _ctx.strokeStyle = lineColor;
      _ctx.lineWidth = 0.7;
      _ctx.setLineDash([]);
      _ctx.beginPath();
      _ctx.moveTo(p1.x, p1.y); _ctx.lineTo(p2.x, p2.y);
      // Засечки на всех точках кроме самых крайних
      for (const pos of sorted) {
        if (pos < sorted[0] + GAP * 0.3 || pos > sorted[sorted.length-1] - GAP * 0.3) continue;
        drawTick45(sp(pos, normalOff), angle);
      }
      drawTick45(p1, angle);
      drawTick45(p2, angle);
      _ctx.stroke();
    };

    // ── ВНУТРИ: цепочка ──────────────────────────────────────
    // Если нет проёмов — один размер угол-угол внутри.
    // Если есть проёмы — цепочка сегментов, общий размер не рисуем.
    const IN_OFF = (halfT + 80) * interiorSign;

    if (!hasOpenings) {
      // Простой размер угол-угол
      drawChain([0, wlen], IN_OFF, '#9ca3af');
      const pt = sp(wlen / 2, IN_OFF);
      drawAlignedTextBox(`${Math.round(wlen)} мм`, pt, angle, {
        font: '500 9px Onest, Inter, sans-serif',
        background: 'rgba(255,255,255,0.95)',
        textColor: '#374151',
      });
      continue;
    }

    // Цепочка с проёмами
    const chainTicks = [0, wlen];
    for (const { start, end } of wallOpenings) { chainTicks.push(start); chainTicks.push(end); }
    drawChain(chainTicks, IN_OFF, '#9ca3af');

    // Подписи сегментов
    const segs = [];
    let cursor = 0;
    for (const { start, end } of wallOpenings) {
      if (start > cursor + 1) segs.push({ from: cursor, to: start, isOpening: false });
      segs.push({ from: start, to: end, isOpening: true });
      cursor = end;
    }
    if (cursor < wlen - 1) segs.push({ from: cursor, to: wlen, isOpening: false });

    for (const seg of segs) {
      const mid = (seg.from + seg.to) / 2;
      const pt  = sp(mid, IN_OFF);
      drawAlignedTextBox(`${Math.round(seg.to - seg.from)} мм`, pt, angle, {
        font: `${seg.isOpening ? '700' : '500'} 9px Onest, Inter, sans-serif`,
        background: seg.isOpening ? 'rgba(239,246,255,0.97)' : 'rgba(255,255,255,0.97)',
        textColor:  seg.isOpening ? '#2563eb' : '#374151',
      });
    }
  }
  _ctx.restore();
}

// ══════════════════════════════════════════════════════════════════
// ВЫНОСКИ ОКОН И ВХОДНОЙ ДВЕРИ (изломанная линия, как на обмерных планах)
// Схема: точка на стене → диагональ под ~45° наружу → горизонтальная полочка → подпись
// ══════════════════════════════════════════════════════════════════
function drawOpeningLeaders(extWallIds) {
  const scale = _getScale();
  if (scale < 0.07) return;
  _ctx.save();

  for (const op of appState.openings) {
    const wall = appState.walls.find(w => w.id === op.wallId);
    if (!wall) continue;

    const isEntrance = op.type === 'door' && extWallIds && extWallIds.has(op.wallId);
    if (op.type !== 'window' && !isEntrance) continue;

    const wlen  = Math.hypot(wall.x2 - wall.x1, wall.y2 - wall.y1);
    const angle = Math.atan2(wall.y2 - wall.y1, wall.x2 - wall.x1);
    const ux = Math.cos(angle), uy = Math.sin(angle);
    const nx = -uy, ny = ux;
    const interiorSign = wallInteriorSide(wall, 1);
    const halfT = wall.thickness / 2;

    // Центр проёма в мировых координатах
    const cx = wall.x1 + ux * op.t * wlen;
    const cy = wall.y1 + uy * op.t * wlen;

    // Точка старта выноски — на внешней грани стены
    const outSign = -interiorSign;
    const startX = cx + nx * (halfT + 5) * outSign;
    const startY = cy + ny * (halfT + 5) * outSign;
    const sStart = toScreen(startX, startY);

    // Диагональный отрезок: ~45° от стены наружу
    // Направление: смесь нормали наружу + вдоль стены вправо
    // Определяем "вправо" как направление от центра canvas
    const canvasCX = _canvas.width / 2, canvasCY = _canvas.height / 2;
    const sCenter = toScreen(cx, cy);
    // Вектор от центра стены к краю canvas — определяет куда "вправо"
    const toDirX = sCenter.x < canvasCX ? -1 : 1;

    const DIAG_PX = 28 * Math.min(scale * 6, 1.2); // длина диагонали в px
    const SHELF_PX = 32 * Math.min(scale * 6, 1.2); // длина полочки в px

    // Направление диагонали: наружу от стены + немного вправо
    // Вычисляем в screen-пространстве
    const sNormOut = toScreen(startX + nx * 100 * outSign, startY + ny * 100 * outSign);
    const normDirX = sNormOut.x - sStart.x, normDirY = sNormOut.y - sStart.y;
    const normLen = Math.hypot(normDirX, normDirY);
    const normUX = normLen > 0.1 ? normDirX / normLen : 0;
    const normUY = normLen > 0.1 ? normDirY / normLen : -1;

    // Диагональ = нормаль наружу + небольшой сдвиг вправо
    const diagX = normUX * 0.7 + toDirX * 0.7;
    const diagY = normUY * 0.7;
    const diagLen = Math.hypot(diagX, diagY);
    const diagUX = diagLen > 0.1 ? diagX / diagLen : normUX;
    const diagUY = diagLen > 0.1 ? diagY / diagLen : normUY;

    const sMid = { x: sStart.x + diagUX * DIAG_PX, y: sStart.y + diagUY * DIAG_PX };
    const sEnd = { x: sMid.x + toDirX * SHELF_PX, y: sMid.y };

    // Рисуем изломанную линию
    _ctx.strokeStyle = '#6b7280';
    _ctx.lineWidth = 0.8;
    _ctx.setLineDash([]);
    _ctx.beginPath();
    _ctx.moveTo(sStart.x, sStart.y);
    _ctx.lineTo(sMid.x, sMid.y);
    _ctx.lineTo(sEnd.x, sEnd.y);
    _ctx.stroke();

    // Точка-кружок на стене
    _ctx.beginPath();
    _ctx.arc(sStart.x, sStart.y, 2, 0, Math.PI * 2);
    _ctx.fillStyle = '#6b7280';
    _ctx.fill();

    // Подпись рядом с концом полочки
    const label     = `${Math.round(op.width)}×${Math.round(op.height)} мм`;
    const typeLabel = op.type === 'window' ? 'Окно' : 'Вх. дверь';
    const textX = sEnd.x + toDirX * 3;

    _ctx.font = `500 ${(BASE_FONT_MM * _getScale()).toFixed(1)}px Onest, Inter, sans-serif`;
    _ctx.fillStyle = '#374151';
    _ctx.textAlign = toDirX > 0 ? 'left' : 'right';
    _ctx.textBaseline = 'bottom';
    _ctx.fillText(label, textX, sEnd.y);
    _ctx.font = `400 ${(BASE_FONT_SM_MM * _getScale()).toFixed(1)}px Onest, Inter, sans-serif`;
    _ctx.fillStyle = '#9ca3af';
    _ctx.textBaseline = 'top';
    _ctx.fillText(typeLabel, textX, sEnd.y + 1);
  }

  _ctx.restore();
}

function drawGuideLine(guide) {
  const anchor = toScreen(guide.anchor.x, guide.anchor.y); _ctx.save();
  for (const axis of getGuideAxes(guide)) {
    const { start, end } = getGuideLineScreenEndpoints({ anchor: guide.anchor, dir: axis.dir });
    _ctx.strokeStyle = axis.color; _ctx.lineWidth = 2; _ctx.setLineDash([5, 8]);
    _ctx.beginPath(); _ctx.moveTo(start.x, start.y); _ctx.lineTo(end.x, end.y); _ctx.stroke();
  }
  _ctx.setLineDash([]); _ctx.fillStyle = DRAW_COLORS.guidePrimary;
  _ctx.beginPath(); _ctx.arc(anchor.x, anchor.y, 4.5, 0, Math.PI * 2); _ctx.fill();
  _ctx.strokeStyle = '#fff'; _ctx.lineWidth = 1.5; _ctx.stroke(); _ctx.restore();
}

function drawCornerHotspots(snap) {
  const pts = new Map();
  if (Array.isArray(snap.highlightPoints) && snap.highlightPoints.length)
    snap.highlightPoints.forEach(p => { const k = `${Math.round(p.x)},${Math.round(p.y)}`; if (!pts.has(k)) pts.set(k, p); });
  else {
    const ids = snap.wallIds?.length ? snap.wallIds : snap.wallId ? [snap.wallId] : [];
    for (const id of ids) { const w = appState.walls.find(v => v.id === id); if (!w) continue;
      for (const p of getWallCornerPoints(w)) { const k = `${Math.round(p.x)},${Math.round(p.y)}`; if (!pts.has(k)) pts.set(k, p); } }
  }
  _ctx.save();
  for (const p of pts.values()) { const s = toScreen(p.x, p.y), active = Math.hypot(p.x - snap.x, p.y - snap.y) < 1;
    _ctx.beginPath(); _ctx.arc(s.x, s.y, active ? 5 : 4, 0, Math.PI * 2);
    _ctx.fillStyle = '#fff'; _ctx.fill(); _ctx.strokeStyle = active ? DRAW_COLORS.corner : 'rgba(17,24,39,0.35)';
    _ctx.lineWidth = active ? 2 : 1.5; _ctx.stroke(); }
  _ctx.restore();
}

function drawObjectSnap(snap) {
  const p = toScreen(snap.x, snap.y);
  const cm = { corner: DRAW_COLORS.corner, endpoint: DRAW_COLORS.endpoint, midpoint: DRAW_COLORS.midpoint,
    intersection: DRAW_COLORS.intersection, perpendicular: DRAW_COLORS.perpendicular, wallFace: DRAW_COLORS.wallFace, wallAxis: DRAW_COLORS.wallAxis };
  const color = cm[snap.type] || DRAW_COLORS.previewStroke;
  _ctx.save(); _ctx.strokeStyle = color; _ctx.fillStyle = '#fff'; _ctx.lineWidth = 2;
  if (snap.type === 'corner' || snap.type === 'endpoint') { _ctx.beginPath(); _ctx.rect(p.x - 4.5, p.y - 4.5, 9, 9); _ctx.fill(); _ctx.stroke(); }
  else if (snap.type === 'midpoint') { _ctx.beginPath(); _ctx.moveTo(p.x, p.y - 6); _ctx.lineTo(p.x + 6, p.y); _ctx.lineTo(p.x, p.y + 6); _ctx.lineTo(p.x - 6, p.y); _ctx.closePath(); _ctx.fill(); _ctx.stroke(); }
  else if (snap.type === 'intersection') { _ctx.beginPath(); _ctx.arc(p.x, p.y, 6, 0, Math.PI * 2); _ctx.fill(); _ctx.stroke(); }
  else if (snap.type === 'wallFace' || snap.type === 'wallAxis') {
    const wa = snap.wallAngle || 0, ux = Math.cos(wa), uy = Math.sin(wa), nx = -uy, ny = ux;
    _ctx.beginPath(); _ctx.moveTo(p.x - ux * 7, p.y - uy * 7); _ctx.lineTo(p.x + ux * 7, p.y + uy * 7);
    _ctx.moveTo(p.x - nx * 4, p.y - ny * 4); _ctx.lineTo(p.x + nx * 4, p.y + ny * 4); _ctx.stroke();
    _ctx.beginPath(); _ctx.arc(p.x, p.y, snap.type === 'wallFace' ? 4.5 : 3.5, 0, Math.PI * 2); _ctx.fill(); _ctx.stroke();
  }
  else if (snap.type === 'tracking') {
    // Ромб — как в Renga для точки на линии отслеживания
    _ctx.beginPath();
    _ctx.moveTo(p.x, p.y - 7); _ctx.lineTo(p.x + 7, p.y);
    _ctx.lineTo(p.x, p.y + 7); _ctx.lineTo(p.x - 7, p.y);
    _ctx.closePath(); _ctx.fill(); _ctx.stroke();
  }
  drawAlignedTextBox(snap.label, { x: p.x, y: p.y - 18 }, 0, { textColor: color, background: 'rgba(255,255,255,0.96)' });
  _ctx.restore();
}

function drawSelectionBox(start, current) {
  if (!start || !current) return;
  const box = { left: Math.min(start.x, current.x), top: Math.min(start.y, current.y), right: Math.max(start.x, current.x), bottom: Math.max(start.y, current.y) };
  if ((box.right - box.left) <= 5 && (box.bottom - box.top) <= 5) return;
  _ctx.save(); _ctx.fillStyle = DRAW_COLORS.selectionFill; _ctx.strokeStyle = DRAW_COLORS.selectionStroke;
  _ctx.lineWidth = 1; _ctx.setLineDash([6, 4]);
  _ctx.fillRect(box.left, box.top, box.right - box.left, box.bottom - box.top);
  _ctx.strokeRect(box.left, box.top, box.right - box.left, box.bottom - box.top);
  _ctx.setLineDash([]); _ctx.restore();
}

function drawCursorGhost(ps) {
  const { tool, mouseScreen, isPanning, inpWallThick } = ps;
  if (!mouseScreen || isPanning || (tool !== 'window' && tool !== 'door')) return;
  const scale = _getScale(), thick = parseFloat(inpWallThick?.value) || 200;
  const w = parseFloat(document.getElementById(tool === 'window' ? 'inpWindowWidth' : 'inpDoorWidth')?.value) || (tool === 'window' ? 1200 : 900);
  const h = parseFloat(document.getElementById(tool === 'window' ? 'inpWindowHeight' : 'inpDoorHeight')?.value) || (tool === 'window' ? 1500 : 2100);
  const gw = Math.max(36, Math.min(220, w * scale)), gd = Math.max(12, Math.min(40, thick * scale));
  const ox = Math.min(_canvas.width - gw - 84, mouseScreen.x + 18), oy = Math.min(_canvas.height - 62, mouseScreen.y + 18);
  _ctx.save(); _ctx.translate(ox, oy);
  _ctx.fillStyle = 'rgba(255,255,255,0.92)'; _ctx.strokeStyle = tool === 'window' ? DRAW_COLORS.windowStroke : DRAW_COLORS.doorStroke; _ctx.lineWidth = 1.2;
  _ctx.beginPath(); if (_ctx.roundRect) _ctx.roundRect(-8, -8, gw + 16, gd + 34, 10); else _ctx.rect(-8, -8, gw + 16, gd + 34); _ctx.fill(); _ctx.stroke();
  _ctx.beginPath(); _ctx.rect(0, 0, gw, gd);
  _ctx.fillStyle = tool === 'window' ? DRAW_COLORS.windowHover : DRAW_COLORS.doorHover; _ctx.fill();
  _ctx.strokeStyle = tool === 'window' ? DRAW_COLORS.windowStroke : DRAW_COLORS.doorStroke; _ctx.stroke();
  _ctx.fillStyle = DRAW_COLORS.roomLabel; _ctx.font = '600 10px Onest, Inter, sans-serif'; _ctx.textAlign = 'left'; _ctx.textBaseline = 'top';
  _ctx.fillText(`${w} × ${h} мм`, 0, gd + 8); _ctx.restore();
}


// ══════════════════════════════════════════════════════════════════
// OFFSCREEN РЕНДЕР ДЛЯ PDF
// ══════════════════════════════════════════════════════════════════

function getWallsBboxWorld() {
  const walls = appState.walls;
  if (!walls.length) return null;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const w of walls) {
    const half = w.thickness / 2 + 5;
    minX = Math.min(minX, w.x1 - half, w.x2 - half);
    minY = Math.min(minY, w.y1 - half, w.y2 - half);
    maxX = Math.max(maxX, w.x1 + half, w.x2 + half);
    maxY = Math.max(maxY, w.y1 + half, w.y2 + half);
  }
  return { minX, minY, maxX, maxY };
}

// withDimensions=false → чистый план: белый фон, стены + заливка, без сетки/размеров
// withDimensions=true  → полный обмерный план: сетка, стены, размеры, выноски
export function renderToImage(outW, outH, withDimensions = false) {
  const bbox = getWallsBboxWorld();
  if (!bbox) return null;

  const PAD_MM = withDimensions ? 500 : 150;
  const wMinX  = bbox.minX - PAD_MM, wMinY = bbox.minY - PAD_MM;
  const wMaxX  = bbox.maxX + PAD_MM, wMaxY = bbox.maxY + PAD_MM;
  const worldW = wMaxX - wMinX,      worldH = wMaxY - wMinY;

  const scale   = Math.min(outW / worldW, outH / worldH) * 0.94;
  const renderW = worldW * scale, renderH = worldH * scale;
  const panX    = (outW - renderW) / 2 - wMinX * scale;
  const panY    = (outH - renderH) / 2 - wMinY * scale;

  const oc   = document.createElement('canvas');
  oc.width   = outW; oc.height = outH;
  const octx = oc.getContext('2d');

  // Сохраняем состояние рендерера
  const savedCanvas   = _canvas;
  const savedCtx      = _ctx;
  const savedGetScale = _getScale;
  const savedHatch    = _hatchPat;

  // Переключаем на offscreen
  _canvas    = oc;
  _ctx       = octx;
  _getScale  = () => scale;
  _hatchPat  = null;
  // Масштабируем шрифты пропорционально ширине output (базовый = 800px)
  _fontScale = Math.max(1, outW / 800);

  // Устанавливаем viewport — _setViewportFn это setViewport из snapping.js
  _setViewportFn(scale, panX, panY);

  // Белый фон
  octx.fillStyle = '#ffffff';
  octx.fillRect(0, 0, outW, outH);

  if (withDimensions) {
    const step = 1000;
    octx.strokeStyle = '#e8eaee'; octx.lineWidth = 0.5;
    for (let wx = Math.floor(wMinX / step) * step; wx <= wMaxX + step; wx += step) {
      const sx = wx * scale + panX;
      octx.beginPath(); octx.moveTo(sx, 0); octx.lineTo(sx, outH); octx.stroke();
    }
    for (let wy = Math.floor(wMinY / step) * step; wy <= wMaxY + step; wy += step) {
      const sy = wy * scale + panY;
      octx.beginPath(); octx.moveTo(0, sy); octx.lineTo(outW, sy); octx.stroke();
    }
  }

  const empty = [];
  drawRoomFills(empty);
  drawWalls(empty);
  drawWallJoints(empty);
  drawOpenings(empty, 'start', 1);
  if (withDimensions) {
    drawWallDimensions();
    drawOpeningLeaders(exteriorWallIds);
  }

  // Восстанавливаем состояние
  _canvas    = savedCanvas;
  _ctx       = savedCtx;
  _getScale  = savedGetScale;
  _hatchPat  = savedHatch;
  _fontScale = 1;
  const vp   = window._plannerViewport ?? { scale: 0.12, panX: 200, panY: 150 };
  _setViewportFn(vp.scale, vp.panX, vp.panY);

  return oc.toDataURL('image/png');
}
