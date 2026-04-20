// ─── ROOM.JS (VECTOR VERSION + INWARD OFFSET) ────────────────────────
import { appState, ROOM_STROKES } from './state.js';
import { EventBus } from './eventBus.js';
import {
  findAllIntersections, buildWallGraph, findFaces,
  polygonArea, polygonCentroid, isPointInPolygon, isPointInWall
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
// ПОСТРОЕНИЕ ВНУТРЕННЕГО ПОЛИГОНА КОМНАТЫ (Stage 7 — переделано)
//
// ИДЕЯ: ребро rawPoly идёт по cx/cy базовой линии стены. Реальная стена —
// это полоса шириной thickness между двумя гранями контура. Внутренняя
// грань ДЛЯ НАШЕЙ КОМНАТЫ = та грань, что физически отделяет тело стены
// от пола комнаты (т.е. обращена к центру комнаты).
//
// Алгоритм: для каждого ребра rawPoly находим стену и её внутреннюю грань
// (КАК ПРЯМУЮ — две точки на ней, в координатах граней контура стены).
// Внутренняя вершина полигона комнаты = пересечение соседних внутренних
// граней. Это работает для ЛЮБЫХ углов между стенами без эвристик.
// ══════════════════════════════════════════════════════════════════

function lineLineIntersect2(p1, d1, p2, d2) {
  const denom = d1.x * d2.y - d1.y * d2.x;
  if (Math.abs(denom) < 0.0001) return null;
  const t = ((p2.x - p1.x) * d2.y - (p2.y - p1.y) * d2.x) / denom;
  return { x: p1.x + d1.x * t, y: p1.y + d1.y * t };
}

// Находит стену для ребра комнаты: ту, чьё ТЕЛО ПЕРЕКРЫВАЕТ это ребро.
// Ребро rawPoly идёт примерно по cx/cy одной из стен. Стена считается
// найденной, если ребро параллельно её оси и попадает в её "окрестность"
// (длиной + thickness/2 + small eps).
function findWallForEdge(ax, ay, bx, by, walls, eps = 50) {
  const midX = (ax + bx) / 2, midY = (ay + by) / 2;
  const edgeLen = Math.hypot(bx - ax, by - ay);
  if (edgeLen < 1) return null;
  const edUX = (bx - ax) / edgeLen, edUY = (by - ay) / edgeLen;
  let best = null, bestDist = Infinity;
  for (const w of walls) {
    const bx1 = w.cx1 ?? w.x1, by1 = w.cy1 ?? w.y1;
    const bx2 = w.cx2 ?? w.x2, by2 = w.cy2 ?? w.y2;
    const wLen = Math.hypot(bx2 - bx1, by2 - by1);
    if (wLen < 1) continue;
    const wUX = (bx2 - bx1) / wLen, wUY = (by2 - by1) / wLen;
    // Параллельность (с любым направлением)
    if (Math.abs(edUX * wUX + edUY * wUY) < 0.95) continue;
    const halfT = (w.thickness || 0) / 2;
    // Проекция середины ребра на ось стены
    const dx = midX - bx1, dy = midY - by1;
    const along = dx * wUX + dy * wUY;
    if (along < -eps || along > wLen + eps) continue;
    // Перпендикулярное расстояние
    const perp = Math.abs(dx * (-wUY) + dy * wUX);
    if (perp > halfT + eps) continue; // ребро должно быть в пределах тела стены
    if (perp < bestDist) { bestDist = perp; best = w; }
  }
  return best;
}

// Вычисляет внутреннюю грань стены для данной комнаты.
// Возвращает прямую вида { p: точка, d: направление } — это касательная к
// внутренней грани стены контура, выраженная как точка + направление.
//
// Внутренняя грань = та грань стены (face1 или face2), что находится
// БЛИЖЕ К ЦЕНТРУ КОМНАТЫ. Это работает универсально: и для стен внутри
// комнаты, и для стен снаружи, и для общих стен.
function getInnerFaceLine(wall, roomCenter) {
  const bx1 = wall.cx1 ?? wall.x1, by1 = wall.cy1 ?? wall.y1;
  const bx2 = wall.cx2 ?? wall.x2, by2 = wall.cy2 ?? wall.y2;
  const wLen = Math.hypot(bx2 - bx1, by2 - by1);
  if (wLen < 0.001) return null;
  const wUx = (bx2 - bx1) / wLen, wUy = (by2 - by1) / wLen;
  const wNx = -wUy, wNy = wUx; // нормаль к оси
  const halfT = wall.thickness / 2;
  // Смещение оси стены от базы (по wN)
  const ax = wall.x1 ?? bx1, ay = wall.y1 ?? by1;
  const axisOffset = (ax - bx1) * wNx + (ay - by1) * wNy;
  // Грани контура — на ±halfT от ОСИ стены (не от базы!)
  // face1 в направлении +wN от базы = axisOffset + halfT
  // face2 в направлении -wN от базы = axisOffset - halfT
  const face1Offset = axisOffset + halfT;
  const face2Offset = axisOffset - halfT;
  // Знаковая позиция центра комнаты относительно базы
  const centerOffset = (roomCenter.x - bx1) * wNx + (roomCenter.y - by1) * wNy;
  // Внутренняя грань = ближайшая к центру комнаты
  const innerOffset = Math.abs(centerOffset - face1Offset) < Math.abs(centerOffset - face2Offset)
    ? face1Offset : face2Offset;
  // Прямая внутренней грани: проходит через точку базы + innerOffset * wN,
  // направлена вдоль оси стены wU
  return {
    p: { x: bx1 + wNx * innerOffset, y: by1 + wNy * innerOffset },
    d: { x: wUx, y: wUy },
  };
}

function buildInnerPolygon(rawPoly, walls, roomCenter) {
  if (rawPoly.length < 3) return rawPoly;
  const n = rawPoly.length;

  // Для каждого ребра rawPoly найти стену и построить прямую её внутренней грани
  const innerLines = new Array(n);
  for (let i = 0; i < n; i++) {
    const a = rawPoly[i], b = rawPoly[(i + 1) % n];
    const wall = findWallForEdge(a.x, a.y, b.x, b.y, walls);
    if (!wall) {
      // Ребро без стены — оставляем как есть (на ребро)
      const dx = b.x - a.x, dy = b.y - a.y;
      const len = Math.hypot(dx, dy) || 1;
      innerLines[i] = { p: { x: a.x, y: a.y }, d: { x: dx / len, y: dy / len } };
    } else {
      innerLines[i] = getInnerFaceLine(wall, roomCenter);
    }
  }

  // Внутренние вершины = пересечения соседних внутренних линий
  const innerPoly = new Array(n);
  for (let i = 0; i < n; i++) {
    const prev = innerLines[(i - 1 + n) % n];
    const curr = innerLines[i];
    const pt = lineLineIntersect2(prev.p, prev.d, curr.p, curr.d);
    if (pt) {
      innerPoly[i] = pt;
    } else {
      // Параллельные грани (вырожденный случай) — берём точку текущей линии
      innerPoly[i] = { x: curr.p.x, y: curr.p.y };
    }
  }
  return innerPoly;
}

// ══════════════════════════════════════════════════════════════════
// ВЕКТОРНОЕ ПОСТРОЕНИЕ КОМНАТ
// ══════════════════════════════════════════════════════════════════
export function computeRooms(wallHeightFallback = 2700) {
  // Всегда очищаем старые комнаты
  appState.rooms = [];
  
  const walls = appState.walls;
  if (walls.length < 3) {
    // Если стен недостаточно, всё равно испускаем событие, чтобы экспликация очистилась
    EventBus.emit('rooms:computed');
    return;
  }

  const points = findAllIntersections(walls);
  if (points.length < 3) {
    EventBus.emit('rooms:computed');
    return;
  }

  const { vertices, edges } = buildWallGraph(walls, points);
  if (edges.length < 3) {
    EventBus.emit('rooms:computed');
    return;
  }

  // TEMP DEBUG (закомментировано — раскомментируй при отладке)
  // console.log('walls:', walls.map(w => ({id:w.id, cx1:w.cx1, cy1:w.cy1, cx2:w.cx2, cy2:w.cy2, offset:w.offset})));
  // console.log('points:', points.length, JSON.stringify(points.map(p => ({x:Math.round(p.x), y:Math.round(p.y)}))));
  // console.log('edges:', edges.length);

  const faces = findFaces(vertices, edges);
  // console.log('faces:', faces.length);

  // findFaces возвращает каждую грань ДВАЖДЫ (обходы forward + backward).
  // Различаем их через ориентированную (signed) площадь: внутренние грани
  // (комнаты) имеют один знак, внешние — другой. По модулю площадь одинаковая.
  // Дедуплицируем по centroid + знаку площади.
  function signedArea(poly) {
    let a = 0;
    for (let i = 0; i < poly.length; i++) {
      const p1 = poly[i], p2 = poly[(i + 1) % poly.length];
      a += p1.x * p2.y - p2.x * p1.y;
    }
    return a / 2;
  }
  const dedupedFaces = [];
  const seenKeys = new Set();
  for (const face of faces) {
    const poly = face.map(v => ({ x: v.x, y: v.y }));
    const sArea = signedArea(poly);
    if (Math.abs(sArea) < 1) continue;
    const c = polygonCentroid(poly);
    // Ключ включает ЗНАК площади — обратные обходы имеют противоположный знак
    const sign = sArea > 0 ? 'p' : 'n';
    const key = `${Math.round(c.x/10)}_${Math.round(c.y/10)}_${sign}`;
    if (seenKeys.has(key)) continue;
    seenKeys.add(key);
    dedupedFaces.push({ poly, sArea });
  }
  // console.log('faces (deduped):', dedupedFaces.length);

  // Внутренние грани (комнаты) и внешние различаются ЗНАКОМ ориентированной
  // площади. Какой именно знак "комнатный" — зависит от того, как findFaces
  // обходит граф. Эвристика: комнат обычно несколько, внешний — один.
  // Считаем количество фейсов каждого знака; меньшинство = внешние.
  let posCount = 0, negCount = 0;
  for (const f of dedupedFaces) {
    if (f.sArea > 0) posCount++; else negCount++;
  }
  // Если знаков поровну (один фейс комната + один внешний — для одной комнаты),
  // внешний = тот, у кого площадь больше. Иначе меньшинство.
  let exteriorSign;
  if (posCount === 0) exteriorSign = 'n';
  else if (negCount === 0) exteriorSign = 'p';
  else if (posCount === negCount) {
    // У одной комнаты ровно 2 фейса (1+ и 1-). Внешний — тот с большей |area|.
    // Но для замкнутой одной комнаты они равны! В этом случае внешним считаем
    // фейс с отрицательной signed area (стандартная конвенция: CCW = внутренний).
    exteriorSign = 'n';
  } else {
    exteriorSign = posCount < negCount ? 'p' : 'n';
  }

  const facePolys = dedupedFaces.map(f => f.poly);
  const faceAreas = dedupedFaces.map(f => Math.abs(f.sArea));

  // Защита от разомкнутого графа: если фейсов нет или нет внешнего —
  // ничего не строим, экспликация очищается через emit.
  if (dedupedFaces.length === 0) {
    EventBus.emit('rooms:computed');
    return;
  }

  // Помечаем индексы внешних фейсов
  const exteriorIndices = new Set();
  for (let i = 0; i < dedupedFaces.length; i++) {
    if ((dedupedFaces[i].sArea > 0 ? 'p' : 'n') === exteriorSign) {
      exteriorIndices.add(i);
    }
  }
  // Для совместимости с дальнейшим кодом: exteriorIndex = первый внешний (нужен для exteriorPoly)
  const exteriorIndex = [...exteriorIndices][0] ?? faceAreas.indexOf(Math.max(...faceAreas));
  const exteriorPoly = facePolys[exteriorIndex];

  exteriorWallIds = new Set();
  if (exteriorPoly) {
    for (const edge of edges) {
      const v1 = vertices[edge.v1], v2 = vertices[edge.v2];
      const mid = { x: (v1.x + v2.x) / 2, y: (v1.y + v2.y) / 2 };
      if (isPointOnPolygonBoundary(mid, exteriorPoly, 3.0)) {
        exteriorWallIds.add(edge.wallId);
      }
    }
  }

  for (let i = 0; i < facePolys.length; i++) {
    if (exteriorIndices.has(i)) continue; // исключаем все внешние границы
    
    const rawPoly = facePolys[i];
    const rawArea = faceAreas[i];
    if (rawArea < 50000) continue; // 0.05 м²

    // Фильтр "тонких" фейсов: паразитные полоски между параллельными стенами
    // имеют огромный периметр и малую площадь. Compactness = area / perimeter².
    // Для квадрата = 1/16 ≈ 0.0625, для круга ≈ 0.0796, для тонкой полоски → 0.
    let perimeter = 0;
    for (let k = 0; k < rawPoly.length; k++) {
      const a = rawPoly[k], b = rawPoly[(k + 1) % rawPoly.length];
      perimeter += Math.hypot(b.x - a.x, b.y - a.y);
    }
    const compactness = perimeter > 0 ? rawArea / (perimeter * perimeter) : 0;
    // Минимально допустимое соотношение: ~0.005 (вытянутый прямоугольник 1:50).
    // Реальные комнаты редко имеют такую вытянутость; полоски между стенами — да.
    if (compactness < 0.005) continue;

    const roughCenter = polygonCentroid(rawPoly);
    
    // Проверяем, не находится ли центр внутри тела стены (артефакт в стыке)
    let insideWall = false;
    for (const w of walls) {
      // Используем cx/cy (базовую линию) — они совпадают с полигоном
      const wx1 = w.cx1 ?? w.x1, wy1 = w.cy1 ?? w.y1;
      const wx2 = w.cx2 ?? w.x2, wy2 = w.cy2 ?? w.y2;
      const ww = { ...w, x1: wx1, y1: wy1, x2: wx2, y2: wy2 };
      if (isPointInWall(roughCenter, ww, 3)) { insideWall = true; break; }
    }
    if (insideWall) continue;

    // Находим граничные стены (чьи рёбра лежат на полигоне)
    const boundaryWallIds = new Set();
    for (const edge of edges) {
      const v1 = vertices[edge.v1], v2 = vertices[edge.v2];
      const mid = { x: (v1.x + v2.x) / 2, y: (v1.y + v2.y) / 2 };
      if (isPointOnPolygonBoundary(mid, rawPoly, 3.0)) {
        boundaryWallIds.add(edge.wallId);
      }
    }
    const boundaryWalls = walls.filter(w => boundaryWallIds.has(w.id));

    // Stage 7 fix: площадь всегда считается по ВНУТРЕННИМ ГРАНЯМ стен.
    // Пользователь рисует по внутренним углам (ввёл 3000 — значит между
    // внутренними углами ровно 3000), стены "растут" наружу от контура.
    // Поэтому innerPolygon (построенный из прямых внутренних граней) даёт
    // ровно тот контур, который пользователь имел в виду.
    //
    // Работает одинаково для:
    //   • одиночной комнаты (внутренняя грань = cx/cy базовой линии)
    //   • смежной комнаты (внутренняя грань общей стены смещена на halfT
    //     от оси в сторону нашей комнаты — компенсирует смещение cx/cy)
    // Результат: 3×3 = 9.00 м² всегда, вне зависимости от толщины стен
    // и количества соседей.
    const innerPolygon = buildInnerPolygon(rawPoly, boundaryWalls, roughCenter);
    const area = polygonArea(innerPolygon);
    if (area < 10000) continue; // < 0.01 м² — артефакт
    const poly = innerPolygon; // тот же полигон для отрисовки заливки

    const center = polygonCentroid(poly);

    let roomHeightMm = wallHeightFallback;
    for (const w of boundaryWalls) {
      if (w.height && w.height < roomHeightMm) roomHeightMm = w.height;
    }

    const roomOpenings = appState.openings.filter(op => boundaryWallIds.has(op.wallId));
    const entranceDoorId = detectEntranceDoor(roomOpenings, exteriorWallIds);

    const metrics = computeRoomMetrics(
      boundaryWalls, roomOpenings, roomHeightMm, center, entranceDoorId
    );

    const key = generateRoomKey(poly);
    const defaultName = roomDefaultName(appState.rooms.length);

    const bbox = getBbox(poly);
    const cells = [{
      x1: bbox.minX, y1: bbox.minY,
      x2: bbox.maxX, y2: bbox.maxY
    }];

    const boundarySegments = boundaryWalls.map(w => ({
      orientation: Math.abs(w.y2 - w.y1) < Math.abs(w.x2 - w.x1) ? 'h' : 'v',
      x1: Math.min(w.x1, w.x2), y1: Math.min(w.y1, w.y2),
      x2: Math.max(w.x1, w.x2), y2: Math.max(w.y1, w.y2),
      length: Math.hypot(w.x2 - w.x1, w.y2 - w.y1),
      wall: w
    }));

    appState.rooms.push({
      key, polygon: poly,
      cells, boundarySegments,
      center,
      defaultName,
      name: appState.roomNameOverrides[key] || defaultName,
      area: area / 1e6,
      volume: area * roomHeightMm / 1e9,
      height: roomHeightMm / 1000,
      perimeter: metrics.perimeterFloorM,
      wallArea: metrics.wallAreaNetM2,
      openingsArea: metrics.openingsAreaM2,
      metrics,
      wallIds: [...boundaryWallIds],
    });
  }

  // Деление площади под дверями
  for (const op of appState.openings) {
    if (op.type !== 'door') continue;
    const wall = walls.find(w => w.id === op.wallId);
    if (!wall || wall.thickness < 1) continue;

    const bordering = appState.rooms.filter(r => r.wallIds.includes(op.wallId));
    if (bordering.length === 2) {
      const halfM2 = (op.width * wall.thickness) / 2 / 1e6;
      bordering[0].area += halfM2;
      bordering[0].volume = bordering[0].area * bordering[0].height;
      bordering[1].area += halfM2;
      bordering[1].volume = bordering[1].area * bordering[1].height;
    }
  }

  EventBus.emit('rooms:computed');
}

// ══════════════════════════════════════════════════════════════════
// ВСПОМОГАТЕЛЬНЫЕ ФУНКЦИИ
// ══════════════════════════════════════════════════════════════════
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

function detectEntranceDoor(openings, exteriorWallIds) {
  for (const op of openings) {
    if (op.type === 'door' && exteriorWallIds.has(op.wallId)) return op.id;
  }
  return null;
}

// ══════════════════════════════════════════════════════════════════
// МЕТРИКИ (перенесены из старого room.js без изменений)
// ══════════════════════════════════════════════════════════════════
function round2(v) { return Math.round(v * 100) / 100; }

function wallStart(w) { return { x: w.cx1 ?? w.x1, y: w.cy1 ?? w.y1 }; }
function wallEnd(w)   { return { x: w.cx2 ?? w.x2, y: w.cy2 ?? w.y2 }; }
function wallLengthMm(w) {
  const s = wallStart(w), e = wallEnd(w);
  return Math.hypot(e.x - s.x, e.y - s.y);
}
function reversedWall(w) {
  return { ...w,
    cx1: w.cx2 ?? w.x2, cy1: w.cy2 ?? w.y2,
    cx2: w.cx1 ?? w.x1, cy2: w.cy1 ?? w.y1,
    x1: w.x2, y1: w.y2, x2: w.x1, y2: w.y1,
  };
}
function dist2(a, b) { return (a.x - b.x) ** 2 + (a.y - b.y) ** 2; }

const SNAP_TOL_SQ = 200 * 200;
function orderBoundaryWalls(walls) {
  if (walls.length <= 1) return walls;
  const used = new Array(walls.length).fill(false);
  const result = [walls[0]];
  used[0] = true;
  for (let step = 1; step < walls.length; step++) {
    const lastEnd = wallEnd(result[result.length - 1]);
    let bestIdx = -1, bestDist = Infinity;
    for (let i = 0; i < walls.length; i++) {
      if (used[i]) continue;
      const d = Math.min(dist2(lastEnd, wallStart(walls[i])), dist2(lastEnd, wallEnd(walls[i])));
      if (d < bestDist) { bestDist = d; bestIdx = i; }
    }
    if (bestIdx < 0 || bestDist > SNAP_TOL_SQ) break;
    const next = walls[bestIdx];
    result.push(dist2(lastEnd, wallEnd(next)) < dist2(lastEnd, wallStart(next))
      ? reversedWall(next) : next);
    used[bestIdx] = true;
  }
  return result;
}

function buildWallSegments(walls, openings) {
  return walls.map(wall => {
    const lenMm = Math.hypot(wall.x2 - wall.x1, wall.y2 - wall.y1);
    if (lenMm < 1) return { wall, segments: [] };

    const wallOps = openings
      .filter(op => op.wallId === wall.id)
      .map(op => ({
        startMm: Math.max(0,     (op.t - op.width / 2 / lenMm) * lenMm),
        endMm:   Math.min(lenMm, (op.t + op.width / 2 / lenMm) * lenMm),
      }))
      .filter(op => op.endMm > op.startMm)
      .sort((a, b) => a.startMm - b.startMm);

    const segments = [];
    let cursor = 0;
    for (const op of wallOps) {
      if (op.startMm > cursor + 0.5) {
        segments.push({ startMm: cursor, endMm: op.startMm, widthMm: op.startMm - cursor });
      }
      cursor = Math.max(cursor, op.endMm);
    }
    if (cursor < lenMm - 0.5) {
      segments.push({ startMm: cursor, endMm: lenMm, widthMm: lenMm - cursor });
    }
    return { wall, segments };
  });
}

function computeCornerStats(walls) {
  if (walls.length < 2) return { inner: 0, outer: 0 };
  const n = walls.length;
  let inner = 0, outer = 0;

  let signedArea = 0;
  for (let i = 0; i < n; i++) {
    const s = wallStart(walls[i]), e = wallEnd(walls[i]);
    signedArea += s.x * e.y - e.x * s.y;
  }

  for (let i = 0; i < n; i++) {
    const dx1 = wallEnd(walls[i]).x   - wallStart(walls[i]).x;
    const dy1 = wallEnd(walls[i]).y   - wallStart(walls[i]).y;
    const dx2 = wallEnd(walls[(i+1)%n]).x - wallStart(walls[(i+1)%n]).x;
    const dy2 = wallEnd(walls[(i+1)%n]).y - wallStart(walls[(i+1)%n]).y;
    const cross = dx1 * dy2 - dy1 * dx2;
    if (Math.abs(cross) < 0.001) continue;
    const isInterior = signedArea < 0 ? cross < 0 : cross > 0;
    if (isInterior) inner++; else outer++;
  }
  return { inner, outer };
}

function computeRoomMetrics(walls, openings, heightMm, center, entranceDoorId) {
  const heightM = heightMm / 1000;

  const orderedWalls = orderBoundaryWalls(walls);
  const wallSegData  = buildWallSegments(orderedWalls, openings);

  let perimeterRawMm = 0;
  for (const w of orderedWalls) perimeterRawMm += wallLengthMm(w);

  let perimeterDeductMm = 0;
  for (const op of openings) {
    if (op.type === 'door') {
      perimeterDeductMm += op.width;
    } else if (op.type === 'window' && op.height >= heightMm * 0.95) {
      perimeterDeductMm += op.width;
    }
  }
  const perimeterFloorM = Math.max(0, perimeterRawMm - perimeterDeductMm) / 1000;

  let wallAreaGrossM2 = 0;
  let narrowWallsLm   = 0;
  let openingsAreaM2  = 0;

  for (const { wall, segments } of wallSegData) {
    const wallLenM = Math.hypot(wall.x2 - wall.x1, wall.y2 - wall.y1) / 1000;
    for (const seg of segments) {
      if (seg.widthMm < 500) {
        narrowWallsLm += heightM;
      }
    }
    wallAreaGrossM2 += wallLenM * heightM;
  }

  for (const op of openings) {
    openingsAreaM2 += (op.width * op.height) / 1e6;
  }

  const wallAreaNetM2 = Math.max(0, wallAreaGrossM2 - openingsAreaM2);

  const cornerStats = computeCornerStats(orderedWalls);

  let windowAreaM2 = 0, windowCount = 0;
  let entranceDoorAreaM2 = 0;
  let windowRevealsLm = 0;

  for (const op of openings) {
    if (op.type === 'window') {
      windowAreaM2    += (op.width * op.height) / 1e6;
      windowRevealsLm += (op.width + 2 * op.height) / 1000;
      windowCount++;
    } else if (op.type === 'door' && op.id === entranceDoorId) {
      entranceDoorAreaM2 = (op.width * op.height) / 1e6;
    }
  }

  const pogonazLm = round2(narrowWallsLm + windowRevealsLm);

  const wallOuterCornersLm = round2(cornerStats.outer * heightM);
  let revealCornersLm = 0;
  for (const op of openings) {
    if (op.type === 'window') revealCornersLm += 2 * op.height / 1000;
  }
  const outerAnglesLm = round2(wallOuterCornersLm + revealCornersLm);

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

// ══════════════════════════════════════════════════════════════════
// DOM и экспорт для сметы (без изменений)
// ══════════════════════════════════════════════════════════════════
export function updateExpl(explBody, roomCountEl) {
  if (!explBody) return;
  if (roomCountEl) roomCountEl.textContent = appState.rooms.length;

  if (!appState.rooms.length) {
    explBody.innerHTML = `<tr class="empty-row"><td colspan="7">Нарисуйте замкнутый контур — появятся все метрики</td></tr>`;
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
// РЕАКТИВНОСТЬ
// ══════════════════════════════════════════════════════════════════
let debounceTimer = null;
const DEBOUNCE_MS = 80;

EventBus.on('walls:changed', () => {
  if (debounceTimer) clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => {
    computeRooms(_wallHeightFallback);
    debounceTimer = null;
  }, DEBOUNCE_MS);
});
