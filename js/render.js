// ─── RENDER.JS ────────────────────────────────────────────────────
import { appState, DRAW_COLORS, ROOM_COLORS, ROOM_STROKES } from './state.js';
import {
  getWallWorldGeometry, getWallCornerPoints, getWallLength,
  getWallContourPoint, isWallEndpointCoveredByAnotherWall,
  buildWallJointMap, getWallJointItemsForEndpoint, getWallJointRects,
  getJointBoundaryCornerPoints, getJointLocalCornerPoints, getJointBoundaryPaths,
  areWallsCollinear,
} from './wall.js';
import { exteriorWallIds } from './room.js';
import { polygonCentroid, isPointInPolygon } from './geometry.js';
import { toScreen, toWorld, getGuideAxes, getGuideLineScreenEndpoints, setViewport as _setViewportFn } from './snapping.js';

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

function fillWall(pathFn, fill, hatchBounds = null) {
  _ctx.save();
  pathFn();
  _ctx.fillStyle = fill;
  _ctx.fill();

  // Штрихуем через clip: без плиточной ряби и только в области фигуры.
  _ctx.save();
  pathFn();
  _ctx.clip();
  hatch(hatchBounds);
  _ctx.restore();

  _ctx.restore();
}

function hatch(bounds = null) {
  if (!_ctx || !_canvas) return;

  // Экранно-стабильная ГОСТ-подобная штриховка бетона: ___ _ ___ _
  const HATCH_STEP = 24;
  const HATCH_LONG = 20;
  const HATCH_SHORT = 6;
  const HATCH_GAP = 10;
  const HATCH_LINE = 1.0;

  let left = 0;
  let top = 0;
  let right = _canvas.width;
  let bottom = _canvas.height;

  if (bounds) {
    left = bounds.left;
    top = bounds.top;
    right = bounds.right;
    bottom = bounds.bottom;
  }

  // Небольшой запас, чтобы штрихи не обрезались по краям clip-области.
  const pad = HATCH_STEP * 2;
  left -= pad;
  top -= pad;
  right += pad;
  bottom += pad;

  const origin = toScreen(0, 0);

  // Линии вида y = x + c, где c привязан к мировому нулю.
  const c0 = origin.y - origin.x;
  const cMin = top - right;
  const cMax = bottom - left;
  const kStart = Math.ceil((cMin - c0) / HATCH_STEP);
  const kEnd = Math.floor((cMax - c0) / HATCH_STEP);

  if (kEnd < kStart) return;

  _ctx.save();
  _ctx.strokeStyle = DRAW_COLORS.wallHatch;
  _ctx.lineWidth = HATCH_LINE;
  _ctx.lineCap = 'butt';
  _ctx.setLineDash([HATCH_LONG, HATCH_GAP, HATCH_SHORT, HATCH_GAP]);

  // Якорим фазу штрихов по миру, чтобы при pan/zoom они не "скользили" по стене.
  const dashPeriod = HATCH_LONG + HATCH_GAP + HATCH_SHORT + HATCH_GAP;
  const dashAnchor = (origin.x + origin.y) / Math.SQRT2;
  _ctx.lineDashOffset = -(((dashAnchor % dashPeriod) + dashPeriod) % dashPeriod);

  for (let k = kStart; k <= kEnd; k++) {
    const c = c0 + k * HATCH_STEP;
    const x1 = left;
    const y1 = x1 + c;
    const x2 = right;
    const y2 = x2 + c;

    _ctx.beginPath();
    _ctx.moveTo(x1, y1);
    _ctx.lineTo(x2, y2);
    _ctx.stroke();
  }

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
  _ctx.font      = `${weight} ${basePx.toFixed(1)}px Merriweather, Onest, Inter, sans-serif`;

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
  drawMeasures(ps.selectedItems);   // ← добавить
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
  if (ps.tool === 'wall' && ps.isDrawing && ps.drawStart && ps.drawEnd) drawTempWall(ps);
  if (ps.tool === 'divider' && ps.isDrawing && ps.drawStart && ps.drawEnd) drawTempDivider(ps);
  if (ps.tool === 'measure' && ps.isDrawing && ps.drawStart && ps.drawEnd) drawTempMeasure(ps);
  if ((ps.tool === 'wall' || ps.tool === 'measure' || ps.tool === 'divider') && ps.currentGuideLine)  drawGuideLine(ps.currentGuideLine);
  if ((ps.tool === 'wall' || ps.tool === 'measure' || ps.tool === 'divider') && ps.currentObjectSnap) drawCornerHotspots(ps.currentObjectSnap);
  if ((ps.tool === 'wall' || ps.tool === 'measure' || ps.tool === 'divider') && ps.currentObjectSnap) drawObjectSnap(ps.currentObjectSnap);
  drawSelectionBox(ps.selectBoxStart, ps.selectBoxCurrent);
  drawCursorGhost(ps);
}

function drawHoverHighlight(hoverItem, selectedItems, dh, ds) {
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
  } else if (hoverItem.type === 'measure') {
    const m = (appState.measures || []).find(v => v.id === hoverItem.id);
    if (!m) { _ctx.restore(); return; }
    const p1 = toScreen(m.x1, m.y1);
    const p2 = toScreen(m.x2, m.y2);
    _ctx.strokeStyle = 'rgba(17,24,39,0.75)';
    _ctx.lineWidth = 8;
    _ctx.lineCap = 'round';
    _ctx.beginPath();
    _ctx.moveTo(p1.x, p1.y);
    _ctx.lineTo(p2.x, p2.y);
    _ctx.stroke();
    _ctx.strokeStyle = '#111111';
    _ctx.lineWidth = 1.5;
    _ctx.beginPath();
    _ctx.moveTo(p1.x, p1.y);
    _ctx.lineTo(p2.x, p2.y);
    _ctx.stroke();
  } else if (hoverItem.type === 'divider') {
    const d = (appState.dividers || []).find(v => v.id === hoverItem.id);
    if (!d) { _ctx.restore(); return; }
    const p1 = toScreen(d.x1, d.y1);
    const p2 = toScreen(d.x2, d.y2);
    _ctx.strokeStyle = 'rgba(249,115,22,0.42)';
    _ctx.lineWidth = 10;
    _ctx.lineCap = 'round';
    _ctx.beginPath();
    _ctx.moveTo(p1.x, p1.y);
    _ctx.lineTo(p2.x, p2.y);
    _ctx.stroke();
    _ctx.strokeStyle = '#f97316';
    _ctx.lineWidth = 3;
    _ctx.setLineDash([12, 8]);
    _ctx.beginPath();
    _ctx.moveTo(p1.x, p1.y);
    _ctx.lineTo(p2.x, p2.y);
    _ctx.stroke();
    _ctx.setLineDash([]);
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
  _ctx.fillStyle = '#a0aab8'; _ctx.font = '10px Merriweather, Onest, Inter, sans-serif'; _ctx.textAlign = 'left';
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
      _ctx.font = `600 ${(scale * 200).toFixed(1)}px Merriweather, Onest, Inter, sans-serif`;
      _ctx.textAlign = 'center'; _ctx.textBaseline = 'middle';
      _ctx.fillText(r.name, sc.x, sc.y);
      _ctx.font = `500 ${(scale * 160).toFixed(1)}px Merriweather, Onest, Inter, sans-serif`;
      _ctx.fillStyle = DRAW_COLORS.roomMeta;
      _ctx.fillText(`${r.area.toFixed(2)} м²`, sc.x, sc.y + Math.max(10, scale * 180));
    }
    _ctx.restore();
  }
}

function drawDividers(selectedItems) {
  if (!appState.dividers || !appState.dividers.length) return;

  _ctx.save();
  _ctx.lineCap = 'round';

  for (const d of appState.dividers) {
    const isSel = sel('divider', d.id, selectedItems);
    const p1 = toScreen(d.x1, d.y1);
    const p2 = toScreen(d.x2, d.y2);
    _ctx.strokeStyle = isSel ? '#ea580c' : '#f97316';
    _ctx.lineWidth = isSel ? 3.5 : 2.5;
    _ctx.setLineDash([12, 8]);
    _ctx.beginPath();
    _ctx.moveTo(p1.x, p1.y);
    _ctx.lineTo(p2.x, p2.y);
    _ctx.stroke();
  }
  
  _ctx.setLineDash([]);
  _ctx.restore();
}

function drawMeasures(selectedItems) {
  if (!appState.measures || !appState.measures.length) return;

  _ctx.save();
  _ctx.setLineDash([]);
  _ctx.lineCap = 'round';

  for (const m of appState.measures) {
    const isSel = sel('measure', m.id, selectedItems);
    const offset = m.offset || 0;
    const p1_raw = { x: m.x1, y: m.y1 };
    const p2_raw = { x: m.x2, y: m.y2 };
    const segVec = { x: p2_raw.x - p1_raw.x, y: p2_raw.y - p1_raw.y };
    const len = Math.hypot(segVec.x, segVec.y);
    if (len < 1) continue;

    const perpX = -segVec.y / len;
    const perpY = segVec.x / len;
    const mid = { x: (p1_raw.x + p2_raw.x) / 2, y: (p1_raw.y + p2_raw.y) / 2 };

    // Точки размерной линии с учётом смещения
    const lineStart = {
      x: p1_raw.x + perpX * offset,
      y: p1_raw.y + perpY * offset
    };
    const lineEnd = {
      x: p2_raw.x + perpX * offset,
      y: p2_raw.y + perpY * offset
    };

    const p1 = toScreen(lineStart.x, lineStart.y);
    const p2 = toScreen(lineEnd.x, lineEnd.y);
    const screenLen = Math.hypot(p2.x - p1.x, p2.y - p1.y);
    if (screenLen < 1) continue;

    const angle = Math.atan2(p2.y - p1.y, p2.x - p1.x);
    const dirX = (p2.x - p1.x) / screenLen;
    const dirY = (p2.y - p1.y) / screenLen;

    // Выносные линии от исходных точек до размерной линии
    _ctx.strokeStyle = '#9ca3af';
    _ctx.lineWidth = 0.8;
    _ctx.setLineDash([4, 3]);
    _ctx.beginPath();
    const s1 = toScreen(p1_raw.x, p1_raw.y);
    const s2 = toScreen(p2_raw.x, p2_raw.y);
    _ctx.moveTo(s1.x, s1.y);
    _ctx.lineTo(p1.x, p1.y);
    _ctx.moveTo(s2.x, s2.y);
    _ctx.lineTo(p2.x, p2.y);
    _ctx.stroke();
    _ctx.setLineDash([]);

    // Размерная линия
    _ctx.strokeStyle = isSel ? '#0f172a' : '#111111';
    _ctx.lineWidth = isSel ? 1.5 : 1.0;
    _ctx.beginPath();
    _ctx.moveTo(p1.x, p1.y);
    _ctx.lineTo(p2.x, p2.y);
    _ctx.stroke();

    // Засечки 45°
    drawTick45(p1, angle);
    drawTick45(p2, angle);
    _ctx.stroke();

    // Текст
    const OFFSET_MM = 100;
    const offsetPx = OFFSET_MM * _getScale();
    const normalX = -dirY;
    const normalY = dirX;
    const labelPos = {
      x: (p1.x + p2.x) / 2 + normalX * offsetPx,
      y: (p1.y + p2.y) / 2 + normalY * offsetPx
    };
    drawAlignedTextBox(m.label, labelPos, angle, {
      textColor: '#111111',
      background: 'rgba(255,255,255,0.95)',
      font: '600 9px Merriweather, Onest, Inter, sans-serif'
    });

    // Маркер перетаскивания для выделенного размера
    if (isSel) {
      const markerScreen = toScreen(
        mid.x + perpX * offset,
        mid.y + perpY * offset
      );
      _ctx.beginPath();
      _ctx.arc(markerScreen.x, markerScreen.y, 6, 0, Math.PI * 2);
      _ctx.fillStyle = '#ffffff';
      _ctx.fill();
      _ctx.strokeStyle = '#3b82f6';
      _ctx.lineWidth = 2;
      _ctx.stroke();
      _ctx.beginPath();
      _ctx.arc(markerScreen.x, markerScreen.y, 3, 0, Math.PI * 2);
      _ctx.fillStyle = '#3b82f6';
      _ctx.fill();
    }
  }

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
    const left = Math.min(ptA.x, ptB.x, ptC.x, ptD.x);
    const top = Math.min(ptA.y, ptB.y, ptC.y, ptD.y);
    const right = Math.max(ptA.x, ptB.x, ptC.x, ptD.x);
    const bottom = Math.max(ptA.y, ptB.y, ptC.y, ptD.y);
    fillWall(() => {
      _ctx.beginPath();
      _ctx.moveTo(ptA.x, ptA.y); _ctx.lineTo(ptB.x, ptB.y);
      _ctx.lineTo(ptC.x, ptC.y); _ctx.lineTo(ptD.x, ptD.y);
      _ctx.closePath();
    }, style.fill, { left, top, right, bottom });
  }

  // Pass 2: fill joint rects (ортогональные углы)
  for (const jr of jrects) {
    const isSel = jr.wallIds.some(id => sel('wall', id, selectedItems));
    const style = wallStyle(isSel);
    const tl = toScreen(jr.left, jr.top), br = toScreen(jr.right, jr.bottom);
    const rl = Math.min(tl.x, br.x), rt = Math.min(tl.y, br.y);
    const rr = Math.max(tl.x, br.x), rb = Math.max(tl.y, br.y);
    fillWall(() => { _ctx.beginPath(); _ctx.rect(rl, rt, rr-rl, rb-rt); }, style.fill, { left: rl, top: rt, right: rr, bottom: rb });
  }

  // Pass 3: stroke outlines
  for (const { w, g, isSel, style, sj, ej, myJoints, ptA, ptB, ptC, ptD } of wallData) {
    _ctx.save();
    _ctx.strokeStyle = style.stroke; _ctx.lineWidth = isSel ? 1.5 : 1;
    _ctx.lineCap = 'butt'; _ctx.lineJoin = 'miter'; _ctx.miterLimit = 10;
    _ctx.beginPath();
    drawClippedFace(ptA, ptB, myJoints); // грань ab
    drawClippedFace(ptD, ptC, myJoints); // грань dc

    // Stage 4: торцевые заглушки не рисуем если:
    //   a) конец стыкуется с другой стеной (sj/ej), ИЛИ
    //   b) конец касается коллинеарной стены — шов был бы виден поперёк непрерывной стены
    const jmapStart = getWallJointItemsForEndpoint(jmap, w, 'start').filter(it => it.wall.id !== w.id);
    const jmapEnd   = getWallJointItemsForEndpoint(jmap, w, 'end').filter(it => it.wall.id !== w.id);
    const collinearAtStart = jmapStart.some(it => areWallsCollinear(w, it.wall));
    const collinearAtEnd   = jmapEnd.some(it => areWallsCollinear(w, it.wall));

    if (!ej && !collinearAtEnd)   { _ctx.moveTo(g.b.x, g.b.y); _ctx.lineTo(g.c.x, g.c.y); }
    if (!sj && !collinearAtStart) { _ctx.moveTo(g.d.x, g.d.y); _ctx.lineTo(g.a.x, g.a.y); }
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
    fillWall(() => { _ctx.beginPath(); _ctx.rect(rl, rt, rr - rl, rb - rt); }, style.fill, { left: rl, top: rt, right: rr, bottom: rb });
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
  if (len < 1) {
    if (lengthOverlay) lengthOverlay.style.display = 'none';
    if (lblLen) lblLen.style.display = 'none';
    return;
  }
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
    _ctx.fillStyle = '#fff'; _ctx.font = '600 11px Merriweather, Onest, Inter, sans-serif'; _ctx.textAlign = 'left'; _ctx.textBaseline = 'middle';
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

function drawTempDivider(ps) {
  const { drawStart: ds, drawEnd: de, tool } = ps;
  if (tool !== 'divider' || !ds || !de) return;

  const p1 = toScreen(ds.x, ds.y);
  const p2 = toScreen(de.x, de.y);
  const len = Math.hypot(p2.x - p1.x, p2.y - p1.y);
  if (len < 1) return;

  _ctx.save();
  _ctx.strokeStyle = '#f97316';
  _ctx.lineWidth = 2.8;
  _ctx.lineCap = 'round';
  _ctx.setLineDash([12, 8]);
  _ctx.beginPath();
  _ctx.moveTo(p1.x, p1.y);
  _ctx.lineTo(p2.x, p2.y);
  _ctx.stroke();
  _ctx.setLineDash([]);
  _ctx.restore();
}

function drawTempMeasure(ps) {
  const { drawStart: ds, drawEnd: de, tool, lengthMode, lengthInput } = ps;
  if (tool !== 'measure' || !ds || !de) return;
  
  const p1 = toScreen(ds.x, ds.y);
  const p2 = toScreen(de.x, de.y);
  const len = Math.hypot(de.x - ds.x, de.y - ds.y);
  if (len < 1) return;
  
  const angle = Math.atan2(p2.y - p1.y, p2.x - p1.x);
  
  _ctx.save();
  _ctx.strokeStyle = '#111111';
  _ctx.lineWidth = 1.0;
  _ctx.setLineDash([]);
  _ctx.lineCap = 'round';
  
  const GAP = 12;
  const dirX = (p2.x - p1.x) / len;
  const dirY = (p2.y - p1.y) / len;
  const startGap = { x: p1.x + dirX * GAP, y: p1.y + dirY * GAP };
  const endGap   = { x: p2.x - dirX * GAP, y: p2.y - dirY * GAP };
  
  _ctx.beginPath();
  _ctx.moveTo(startGap.x, startGap.y);
  _ctx.lineTo(endGap.x, endGap.y);
  _ctx.stroke();
  
  // Косые засечки (статичные в мировых единицах)
  drawTick45(p1, angle);
  drawTick45(p2, angle);
  _ctx.stroke();
  
  // Текст над линией с фиксированным отступом в мм
  const OFFSET_MM = 100;
  const offsetPx = OFFSET_MM * _getScale();
  const normalX = -dirY;
  const normalY = dirX;
  const mid = { x: (p1.x + p2.x) / 2, y: (p1.y + p2.y) / 2 };
  const labelPos = {
    x: mid.x + normalX * offsetPx,
    y: mid.y + normalY * offsetPx
  };
  
  const labelText = (lengthMode && lengthInput) 
    ? `${lengthInput} мм` 
    : `${Math.round(len)} мм`;
    
  drawAlignedTextBox(labelText, labelPos, angle, {
    textColor: '#111111',
    background: 'rgba(255,255,255,0.95)',
    font: '600 9px Merriweather, Onest, Inter, sans-serif'
  });
  
  _ctx.restore();
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
  const TICK_MM = 25;                      // длина засечки в миллиметрах
  const TICK = TICK_MM * _getScale();      // перевод в пиксели
  const a = angle + Math.PI / 4;
  _ctx.moveTo(screenPt.x - Math.cos(a) * TICK, screenPt.y - Math.sin(a) * TICK);
  _ctx.lineTo(screenPt.x + Math.cos(a) * TICK, screenPt.y + Math.sin(a) * TICK);
}

function drawStraightTick(screenPt, angle, lengthPx = 8) {
  const TICK = lengthPx * _fontScale;
  const perpX = -Math.sin(angle) * TICK;
  const perpY =  Math.cos(angle) * TICK;
  _ctx.moveTo(screenPt.x - perpX, screenPt.y - perpY);
  _ctx.lineTo(screenPt.x + perpX, screenPt.y + perpY);
}

// ══════════════════════════════════════════════════════════════════
// РАЗМЕРНЫЕ ЦЕПОЧКИ
// Снаружи: общий размер угол-угол с засечками 45°
// Внутри:  цепочка угол→проём→угол (только если есть проёмы)
// ══════════════════════════════════════════════════════════════════

function drawWallDimensions() {
  const scale = _getScale();
  if (scale < 0.07 || !appState.rooms?.length) return;
  _ctx.save();

  // All distances in world mm
  const LINE_OFF_MM  = 120;   // dimension line offset from wall face (inside room)
  const TEXT_OFF_MM  = 230;   // text offset from wall face (inside room)
  const GAP_MM       = 8;     // gap at ends of dimension line
  const MIN_SEG_MM   = 20;    // skip segments shorter than this
  const MIN_INLINE_MM = 300;  // segments shorter than this get a leader (world mm, zoom-independent)
  const LEADER_OUT_MM = 280;  // leader diagonal outward distance
  const SHELF_MM      = 320;  // leader horizontal shelf length

  // Track (wallId, roomId) pairs so each wall is drawn once PER room
  // This lets a shared wall show dimensions on both sides (one per room)
  const drawnPairs = new Set();

  for (const room of appState.rooms) {
    if (!room.boundarySegments?.length || !room.polygon?.length) continue;

    for (const boundary of room.boundarySegments) {
      const wall = boundary.wall;
      if (!wall || wall.isDivider) continue;
      const pairKey = `${wall.id}__${room.id}`;
      if (drawnPairs.has(pairKey)) continue;

      const wlen = Math.hypot(wall.x2 - wall.x1, wall.y2 - wall.y1);
      if (wlen < 50) continue;

      const angle = Math.atan2(wall.y2 - wall.y1, wall.x2 - wall.x1);
      const ux = Math.cos(angle), uy = Math.sin(angle);
      const nx = -uy, ny = ux;   // left normal
      const halfT = wall.thickness / 2;

      // ── Determine which side is INSIDE the room ──────────────────
      // Test both normals at wall midpoint; pick the one inside room polygon
      const testDist = halfT + LINE_OFF_MM;
      const midW = (seg) => wall.x1 + ux * ((seg ? (seg.from + seg.to) / 2 : wlen / 2));
      const midH = (seg) => wall.y1 + uy * ((seg ? (seg.from + seg.to) / 2 : wlen / 2));
      const mx = wall.x1 + ux * (wlen / 2);
      const my = wall.y1 + uy * (wlen / 2);
      const pPlus  = { x: mx + nx * testDist, y: my + ny * testDist };
      const pMinus = { x: mx - nx * testDist, y: my - ny * testDist };
      const plusIn  = isPointInPolygon(pPlus,  room.polygon);
      const minusIn = isPointInPolygon(pMinus, room.polygon);

      let sideSign;
      if (plusIn && !minusIn)       sideSign =  1;
      else if (minusIn && !plusIn)  sideSign = -1;
      else {
        // Both or neither inside — pick side closer to room center
        const dPlus  = Math.hypot(pPlus.x  - room.center.x, pPlus.y  - room.center.y);
        const dMinus = Math.hypot(pMinus.x - room.center.x, pMinus.y - room.center.y);
        sideSign = dPlus <= dMinus ? 1 : -1;
      }

      drawnPairs.add(pairKey);

      // ── Build wall segments (gaps between openings) ───────────────
      const wallOpenings = appState.openings
        .filter(op => op.wallId === wall.id)
        .map(op => ({
          start: Math.max(0, op.t * wlen - op.width / 2),
          end:   Math.min(wlen, op.t * wlen + op.width / 2),
        }))
        .sort((a, b) => a.start - b.start);

      const segments = [];
      let cursor = 0;
      for (const op of wallOpenings) {
        if (op.start > cursor + 1) segments.push({ from: cursor, to: op.start });
        cursor = Math.max(cursor, op.end);
      }
      if (cursor < wlen - 1) segments.push({ from: cursor, to: wlen });

      // ── Draw each segment ─────────────────────────────────────────
      for (const seg of segments) {
        const segLen = seg.to - seg.from;
        if (segLen < MIN_SEG_MM) continue;

        const label = `${Math.round(segLen)} мм`;
        const segCx  = (seg.from + seg.to) / 2;

        // Points on dimension line (offset inside room)
        const lineOff = sideSign * (halfT + LINE_OFF_MM);
        const textOff = sideSign * (halfT + TEXT_OFF_MM);

        const wA = { x: wall.x1 + ux * (seg.from + GAP_MM) + nx * lineOff,
                     y: wall.y1 + uy * (seg.from + GAP_MM) + ny * lineOff };
        const wB = { x: wall.x1 + ux * (seg.to   - GAP_MM) + nx * lineOff,
                     y: wall.y1 + uy * (seg.to   - GAP_MM) + ny * lineOff };
        const wL = { x: wall.x1 + ux * segCx + nx * textOff,
                     y: wall.y1 + uy * segCx + ny * textOff };

        const sA = toScreen(wA.x, wA.y);
        const sB = toScreen(wB.x, wB.y);
        const sL = toScreen(wL.x, wL.y);

        if (segLen >= MIN_INLINE_MM) {
          // ── Inline dimension ──────────────────────────────────────
          _ctx.strokeStyle = '#111';
          _ctx.lineWidth = 1.0;
          _ctx.setLineDash([]);
          _ctx.beginPath();
          _ctx.moveTo(sA.x, sA.y);
          _ctx.lineTo(sB.x, sB.y);
          drawTick45(sA, angle);
          drawTick45(sB, angle);
          _ctx.stroke();
          drawAlignedTextBox(label, sL, angle, {
            font: '500 13px Merriweather, Onest, Inter, sans-serif',
            background: 'rgba(255,255,255,0.95)',
            textColor: '#111',
          });
        } else {
          // ── Leader line (elbow) inside room ───────────────────────
          // Attach point: wall face on interior side
          const attachW = { x: wall.x1 + ux * segCx + nx * sideSign * halfT,
                            y: wall.y1 + uy * segCx + ny * sideSign * halfT };
          // Diagonal leg: goes inward (into room) and perpendicular
          const diagW = { x: attachW.x + nx * sideSign * LEADER_OUT_MM,
                          y: attachW.y + ny * sideSign * LEADER_OUT_MM };
          // Shelf: runs parallel to wall
          const shelfW = { x: diagW.x + ux * SHELF_MM,
                           y: diagW.y + uy * SHELF_MM };
          const midShelfW = { x: (diagW.x + shelfW.x) / 2,
                              y: (diagW.y + shelfW.y) / 2 };

          const pA  = toScreen(attachW.x, attachW.y);
          const pD  = toScreen(diagW.x,   diagW.y);
          const pE  = toScreen(shelfW.x,  shelfW.y);
          const pM  = toScreen(midShelfW.x, midShelfW.y);

          _ctx.strokeStyle = '#444';
          _ctx.lineWidth = 0.8;
          _ctx.setLineDash([3, 3]);
          _ctx.beginPath();
          _ctx.moveTo(pA.x, pA.y);
          _ctx.lineTo(pD.x, pD.y);
          _ctx.lineTo(pE.x, pE.y);
          _ctx.stroke();
          _ctx.setLineDash([]);
          _ctx.beginPath();
          _ctx.arc(pA.x, pA.y, 2, 0, Math.PI * 2);
          _ctx.fillStyle = '#444';
          _ctx.fill();
          drawAlignedTextBox(label, pM, angle, {
            font: '500 13px Merriweather, Onest, Inter, sans-serif',
            background: 'rgba(255,255,255,0.95)',
            textColor: '#333',
          });
        }
      }
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

    _ctx.font = `500 ${(BASE_FONT_MM * _getScale()).toFixed(1)}px Merriweather, Onest, Inter, sans-serif`;
    _ctx.fillStyle = '#374151';
    _ctx.textAlign = toDirX > 0 ? 'left' : 'right';
    _ctx.textBaseline = 'bottom';
    _ctx.fillText(label, textX, sEnd.y);
    _ctx.font = `400 ${(BASE_FONT_SM_MM * _getScale()).toFixed(1)}px Merriweather, Onest, Inter, sans-serif`;
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
      
  else if (snap.type === 'measureLine') {
    const wa = snap.wallAngle || 0, ux = Math.cos(wa), uy = Math.sin(wa), nx = -uy, ny = ux;
    _ctx.beginPath(); _ctx.moveTo(p.x - ux * 7, p.y - uy * 7); _ctx.lineTo(p.x + ux * 7, p.y + uy * 7);
    _ctx.moveTo(p.x - nx * 4, p.y - ny * 4); _ctx.lineTo(p.x + nx * 4, p.y + ny * 4); _ctx.stroke();
    _ctx.beginPath(); _ctx.arc(p.x, p.y, 3.5, 0, Math.PI * 2); _ctx.fillStyle = DRAW_COLORS.measureLine; _ctx.fill();
    _ctx.strokeStyle = DRAW_COLORS.measureLine; _ctx.lineWidth = 1.5; _ctx.stroke();
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
  _ctx.fillStyle = DRAW_COLORS.roomLabel; _ctx.font = '600 10px Merriweather, Onest, Inter, sans-serif'; _ctx.textAlign = 'left'; _ctx.textBaseline = 'top';
  _ctx.fillText(`${w} × ${h} мм`, 0, gd + 8); _ctx.restore();
}


// ══════════════════════════════════════════════════════════════════
// OFFSCREEN РЕНДЕР ДЛЯ PDF
// ══════════════════════════════════════════════════════════════════

export function getWallsBboxWorld() {
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
  // Include door arc extents in bbox
  for (const op of (appState.openings || [])) {
    if (op.type !== 'door') continue;
    const wall = walls.find(w => w.id === op.wallId); if (!wall) continue;
    const wlen = Math.hypot(wall.x2 - wall.x1, wall.y2 - wall.y1); if (wlen < 1) continue;
    const angle = Math.atan2(wall.y2 - wall.y1, wall.x2 - wall.x1);
    const halfW = op.width / 2;
    const t1 = Math.max(0, Math.min(1, op.t - halfW / wlen));
    const t2 = Math.max(0, Math.min(1, op.t + halfW / wlen));
    const ax1 = wall.x1 + (wall.x2 - wall.x1) * t1, ay1 = wall.y1 + (wall.y2 - wall.y1) * t1;
    const ax2 = wall.x1 + (wall.x2 - wall.x1) * t2, ay2 = wall.y1 + (wall.y2 - wall.y1) * t2;
    // Hinge point in world coords
    const dh = op.hinge || 'start';
    const ds = op.swing ?? 1;
    const hx = dh === 'start' ? ax1 : ax2, hy = dh === 'start' ? ay1 : ay2;
    const leafLen = op.width; // door leaf length = door width in world units
    const baseAngle = dh === 'start' ? angle : angle + Math.PI;
    const openAngle = baseAngle + ds * Math.PI / 2;
    // Arc sweeps from baseAngle to openAngle — expand bbox by radius in all touched quadrants
    // Simplest safe approach: bbox covers all 4 cardinal extremes of the arc circle, clipped to actual sweep
    const angles = [baseAngle, openAngle];
    // Add cardinal angles (0, π/2, π, 3π/2) if they fall within the sweep
    for (let a = -2 * Math.PI; a <= 2 * Math.PI; a += Math.PI / 2) {
      const normalized = ((a - Math.min(baseAngle, openAngle)) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI);
      const sweep = Math.abs(openAngle - baseAngle);
      if (normalized <= sweep + 0.01) angles.push(a);
    }
    for (const a of angles) {
      minX = Math.min(minX, hx + Math.cos(a) * leafLen);
      minY = Math.min(minY, hy + Math.sin(a) * leafLen);
      maxX = Math.max(maxX, hx + Math.cos(a) * leafLen);
      maxY = Math.max(maxY, hy + Math.sin(a) * leafLen);
    }
    // Also include hinge point itself
    minX = Math.min(minX, hx); minY = Math.min(minY, hy);
    maxX = Math.max(maxX, hx); maxY = Math.max(maxY, hy);
  }
  return { minX, minY, maxX, maxY };
}

// withDimensions=false → чистый план: белый фон, стены + заливка, без сетки/размеров
// withDimensions=true  → полный обмерный план: сетка, стены, размеры, выноски
export function renderToImage(outW, outH, withDimensions = false) {
  const bbox = getWallsBboxWorld();
  if (!bbox) return null;

  const PAD_MM = withDimensions ? 200 : 40;
  const wMinX  = bbox.minX - PAD_MM, wMinY = bbox.minY - PAD_MM;
  const wMaxX  = bbox.maxX + PAD_MM, wMaxY = bbox.maxY + PAD_MM;
  const worldW = wMaxX - wMinX,      worldH = wMaxY - wMinY;

  const scale   = Math.min(outW / worldW, outH / worldH) * (withDimensions ? 0.97 : 1.0);
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
  _fontScale = Math.max(1, outW / 800);

  _setViewportFn(scale, panX, panY);

  // Белый фон
  octx.fillStyle = '#ffffff';
  octx.fillRect(0, 0, outW, outH);

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

  // For clean plan: crop to walls bbox only (tight, no whitespace), with small pixel pad
  if (!withDimensions) {
    const PAD_PX = Math.round(PAD_MM * scale);
    // Screen coords of wall-only bbox (without PAD_MM expansion)
    const sx1 = Math.max(0, Math.floor((bbox.minX - 5) * scale + panX) - PAD_PX);
    const sy1 = Math.max(0, Math.floor((bbox.minY - 5) * scale + panY) - PAD_PX);
    const sx2 = Math.min(outW, Math.ceil((bbox.maxX + 5) * scale + panX) + PAD_PX);
    const sy2 = Math.min(outH, Math.ceil((bbox.maxY + 5) * scale + panY) + PAD_PX);
    const cropW = sx2 - sx1, cropH = sy2 - sy1;
    if (cropW > 0 && cropH > 0) {
      const cropped = document.createElement('canvas');
      cropped.width = cropW; cropped.height = cropH;
      cropped.getContext('2d').drawImage(oc, sx1, sy1, cropW, cropH, 0, 0, cropW, cropH);
      return cropped.toDataURL('image/png');
    }
  }

  return oc.toDataURL('image/png');
}
