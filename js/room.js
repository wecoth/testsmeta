// ─── ROOM.JS (v3 — ручной режим) ─────────────────────────────────
import { appState, ROOM_STROKES } from './state.js';
import { EventBus } from './eventBus.js';
import {
  findAllIntersections, buildWallGraph, findFaces,
  polygonArea, polygonCentroid, isPointInPolygon,
  segmentIntersection
} from './geometry.js';

let _wallHeightFallback = 2700;
export function setWallHeight(h) { _wallHeightFallback = (h && h > 0) ? h : 2700; }

export function roomDefaultName(index) { return `Комната ${index + 1}`; }

// Переименование комнаты (по ключу)
export function renameRoom(roomKey, nextName) {
  const room = appState.rooms.find(r => r.key === roomKey);
  if (!room) return;
  const normalized = (nextName || '').trim();
  if (!normalized || normalized === room.defaultName) {
    delete appState.roomNameOverrides[roomKey];
  } else {
    appState.roomNameOverrides[roomKey] = normalized;
  }
  // обновим имя в самой комнате
  room.name = appState.roomNameOverrides[roomKey] || room.defaultName;
}

// ── Вычисление кандидатов (замкнутых контуров) ────────────────────
/**
 * Возвращает массив полигонов-кандидатов, найденных по стенам и разделителям.
 * Каждый кандидат — массив точек {x,y} (замкнутый).
 */
export function computeCandidatePolygons() {
  const walls = appState.walls;
  const dividers = appState.dividers || [];

  if (walls.length === 0 && dividers.length === 0) return [];

  // строим простые отрезки (базовые линии стен и разделителей)
  const segments = [];
  for (const w of walls) {
    segments.push({
      id: w.id,
      x1: w.cx1 ?? w.x1, y1: w.cy1 ?? w.y1,
      x2: w.cx2 ?? w.x2, y2: w.cy2 ?? w.y2
    });
  }
  for (const d of dividers) {
    segments.push({
      id: `div_${d.id}`,
      x1: d.x1, y1: d.y1,
      x2: d.x2, y2: d.y2
    });
  }

  if (segments.length < 3) return [];

  try {
    const points = findAllIntersections(segments);
    if (!points || points.length < 3) return [];
    const { vertices, edges } = buildWallGraph(segments, points);
    if (edges.length < 3) return [];
    const faces = findFaces(vertices, edges);

    const candidates = [];
    // отфильтровываем внешний контур (самый большой) и слишком маленькие
    const faceAreas = faces.map(f => polygonArea(f.map(v => ({ x: v.x, y: v.y }))));
    const maxArea = Math.max(...faceAreas);

    for (let i = 0; i < faces.length; i++) {
      const poly = faces[i].map(v => ({ x: v.x, y: v.y }));
      const area = faceAreas[i];
      if (area < 200000) continue;          // менее 0.2 м² — мусор
      if (area >= maxArea * 0.98) continue; // внешний контур
      candidates.push(poly);
    }

    return candidates;
  } catch (e) {
    console.warn('Ошибка вычисления кандидатов:', e);
    return [];
  }
}

/**
 * Возвращает кандидата, внутри которого находится точка point (в мировых координатах),
 * или null.
 */
export function getCandidateAtPoint(point) {
  const candidates = computeCandidatePolygons();
  for (const poly of candidates) {
    if (isPointInPolygon(point, poly)) {
      return poly;
    }
  }
  return null;
}

// ── Управление комнатами ────────────────────────────────────────

/**
 * Создаёт комнату на основе полигона-кандидата.
 * Возвращает созданную комнату (объект) или null, если комната уже существует.
 */
export function createRoomFromCandidate(polygon) {
  // проверяем, нет ли уже комнаты с таким же ключом (центроид)
  const key = generateRoomKey(polygon);
  if (appState.rooms.find(r => r.key === key)) {
    return null; // уже есть
  }

  const room = computeRoomForPolygon(polygon);
  if (!room) return null;

  // по умолчанию имя берётся из defaults
  const defaultName = roomDefaultName(appState.rooms.length + 1);
  room.key = key;
  room.defaultName = defaultName;
  room.name = appState.roomNameOverrides[key] || defaultName;
  appState.rooms.push(room);
  EventBus.emit('rooms:computed');
  return room;
}

/**
 * Удаляет комнату по ключу.
 */
export function deleteRoom(roomKey) {
  const idx = appState.rooms.findIndex(r => r.key === roomKey);
  if (idx === -1) return false;
  appState.rooms.splice(idx, 1);
  EventBus.emit('rooms:computed');
  return true;
}

/**
 * Обновляет метрики всех существующих комнат на основе текущих кандидатов.
 * Если контур комнаты больше не существует — комната удаляется.
 */
export function updateRoomsFromCandidates() {
  const candidates = computeCandidatePolygons();
  const candidateKeys = new Set(candidates.map(poly => generateRoomKey(poly)));

  // обновляем метрики для тех, чей ключ остался
  appState.rooms = appState.rooms.filter(room => {
    if (!candidateKeys.has(room.key)) return false; // удаляем разрушенные
    // находим актуальный полигон (может немного измениться)
    const poly = candidates.find(p => generateRoomKey(p) === room.key);
    if (poly) {
      const updated = computeRoomForPolygon(poly);
      if (updated) {
        // сохраняем ключ и имя
        updated.key = room.key;
        updated.defaultName = room.defaultName;
        updated.name = room.name;
        Object.assign(room, updated);
      }
    }
    return true;
  });

  EventBus.emit('rooms:computed');
}

// ── Вспомогательные функции для метрик комнаты ──────────────────

function generateRoomKey(poly) {
  const c = polygonCentroid(poly);
  return `${Math.round(c.x/50)*50},${Math.round(c.y/50)*50}`;
}

// упрощённая версия findAllWallsForEdge (из старого кода, без thickness)
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
    // проверка точности (расстояние от середины ребра до базовой линии стены)
    const dx = midX - bx1, dy = midY - by1;
    const along = dx * wUX + dy * wUY;
    if (along < -eps || along > wLen + eps) continue;
    const perp = Math.abs(dx * (-wUY) + dy * wUX);
    if (perp > eps) continue;
    result.push(w);
  }
  return result;
}

function computeRoomForPolygon(poly) {
  // метрики без exteriorWallIds (ручной режим — нет понятия наружных стен)
  const walls = appState.walls;
  const dividers = appState.dividers || [];
  const allWallsForEdge = [...walls, ...dividers.map(d => ({
    id: `div_${d.id}`,
    cx1: d.x1, cy1: d.y1, cx2: d.x2, cy2: d.y2,
    thickness: 0, height: _wallHeightFallback,
    offset: 'left', isDivider: true
  }))];

  const boundaryWallsList = [];
  const boundaryWallIds = new Set();
  for (let k = 0; k < poly.length; k++) {
    const a = poly[k], b = poly[(k + 1) % poly.length];
    const edgeWalls = findAllWallsForEdge(a.x, a.y, b.x, b.y, allWallsForEdge);
    for (const w of edgeWalls) {
      if (!boundaryWallIds.has(w.id)) {
        boundaryWallIds.add(w.id);
        boundaryWallsList.push(w);
      }
    }
  }

  // простейшие метрики (без вычета проёмов, можно позже доработать)
  const areaMm2 = polygonArea(poly);
  if (areaMm2 < 200000) return null;

  let totalLengthMm = 0, weightedHeightSum = 0;
  for (const w of boundaryWallsList) {
    const len = Math.hypot((w.cx2 ?? w.x2) - (w.cx1 ?? w.x1), (w.cy2 ?? w.y2) - (w.cy1 ?? w.y1));
    const h = w.height || _wallHeightFallback;
    totalLengthMm += len;
    weightedHeightSum += len * h;
  }
  const heightMm = totalLengthMm > 0 ? weightedHeightSum / totalLengthMm : _wallHeightFallback;

  return {
    polygon: poly,
    boundarySegments: [], // не используется в отрисовке
    center: polygonCentroid(poly),
    area: areaMm2 / 1e6,
    volume: areaMm2 * heightMm / 1e9,
    height: heightMm / 1000,
    perimeter: poly.reduce((s, p, i, arr) => {
      const next = arr[(i+1) % arr.length];
      return s + Math.hypot(next.x - p.x, next.y - p.y);
    }, 0) / 1000,
    wallIds: [...boundaryWallIds],
  };
}

// ── События стен/разделителей → обновление существующих комнат ──
let debounceTimer = null;
EventBus.on('walls:changed', () => {
  clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => {
    updateRoomsFromCandidates();
  }, 50);
});
EventBus.on('dividers:changed', () => {
  clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => {
    updateRoomsFromCandidates();
  }, 50);
});
EventBus.on('openings:changed', () => {
  clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => {
    updateRoomsFromCandidates();
  }, 50);
});

// экспликация (без изменений, но теперь rooms могут быть пусты)
export function updateExpl(explBody, roomCountEl) {
  if (!explBody) return;
  if (roomCountEl) roomCountEl.textContent = appState.rooms.length;
  if (!appState.rooms.length) {
    explBody.innerHTML = `<tr class="empty-row"><td colspan="5">Нет комнат. Используйте инструмент «Комната» для назначения.</td></tr>`;
    return;
  }
  explBody.innerHTML = appState.rooms.map((r, i) => {
    const color = ROOM_STROKES[i % ROOM_STROKES.length].replace('0.4', '0.8');
    return `<tr>
      <td><div class="room-name-cell">
        <span class="room-dot" style="background:${color}"></span>
        <input class="room-name-input" type="text" value="${escHtml(r.name)}"
          data-room-key="${escHtml(r.key)}" data-room-default="${escHtml(r.defaultName)}">
      </div></td>
      <td>${r.area?.toFixed(2) ?? '—'}</td>
      <td>${r.perimeter?.toFixed(2) ?? '—'}</td>
      <td>${r.height?.toFixed(2) ?? '—'}</td>
      <td>${r.volume?.toFixed(2) ?? '—'}</td>
    </tr>`;
  }).join('');
}

function escHtml(s) {
  return String(s || '')
    .replaceAll('&', '&amp;').replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;').replaceAll('"', '&quot;');
}

export function getComputedRooms() {
  return appState.rooms.map(r => ({
    name: r.name,
    floorArea: r.area,
    perimeter: r.perimeter,
    height: r.height,
    volume: r.volume,
  }));
}
