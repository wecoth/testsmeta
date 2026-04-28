// ─── GEOMETRY.JS ──────────────────────────────────────────────────
// pure math: segment intersections, graph, faces, polygon utilities

// Базовая геометрия отрезков
export function segmentIntersection(a, b, epsilon = 0.001) {
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

export function projectPointOntoSegment(point, segment) {
  const dx = segment.x2 - segment.x1;
  const dy = segment.y2 - segment.y1;
  const len2 = dx * dx + dy * dy;
  if (len2 < 0.0001) {
    return {
      x: segment.x1, y: segment.y1, t: 0,
      distance: Math.hypot(point.x - segment.x1, point.y - segment.y1)
    };
  }
  let t = ((point.x - segment.x1) * dx + (point.y - segment.y1) * dy) / len2;
  t = Math.max(0, Math.min(1, t));
  const proj = { x: segment.x1 + dx * t, y: segment.y1 + dy * t };
  return { ...proj, t, distance: Math.hypot(point.x - proj.x, point.y - proj.y) };
}

export function clamp(v, min, max) {
  return Math.min(max, Math.max(min, v));
}

export function normalizeDirection(dir) {
  if (Math.abs(dir.x) >= Math.abs(dir.y)) {
    return dir.x >= 0 ? { x: 1, y: 0 } : { x: -1, y: 0 };
  }
  return dir.y >= 0 ? { x: 0, y: 1 } : { x: 0, y: -1 };
}

export function applyWallOffset(cx, cy, angle, offset, thickness) {
  if (offset === 'center') return { x: cx, y: cy };
  const px = -Math.sin(angle);
  const py =  Math.cos(angle);
  const sign = offset === 'right' ? 1 : -1;
  return { x: cx + sign * px * thickness / 2, y: cy + sign * py * thickness / 2 };
}

// Полигоны
export function polygonSignedArea(poly) {
  if (poly.length < 3) return 0;
  let area = 0;
  for (let i = 0; i < poly.length; i++) {
    const p1 = poly[i];
    const p2 = poly[(i + 1) % poly.length];
    area += p1.x * p2.y - p2.x * p1.y;
  }
  return area / 2;
}

export function polygonArea(poly) {
  return Math.abs(polygonSignedArea(poly));
}

export function polygonCentroid(poly) {
  if (poly.length === 0) return { x: 0, y: 0 };
  let cx = 0, cy = 0, area = 0;
  for (let i = 0; i < poly.length; i++) {
    const p1 = poly[i];
    const p2 = poly[(i + 1) % poly.length];
    const cross = p1.x * p2.y - p2.x * p1.y;
    area += cross;
    cx += (p1.x + p2.x) * cross;
    cy += (p1.y + p2.y) * cross;
  }
  area /= 2;
  if (Math.abs(area) < 0.0001) {
    cx = poly.reduce((s, p) => s + p.x, 0) / poly.length;
    cy = poly.reduce((s, p) => s + p.y, 0) / poly.length;
    return { x: cx, y: cy };
  }
  return { x: cx / (6 * area), y: cy / (6 * area) };
}

export function isPointInPolygon(point, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i].x, yi = poly[i].y;
    const xj = poly[j].x, yj = poly[j].y;
    const intersect = ((yi > point.y) !== (yj > point.y)) &&
      (point.x < (xj - xi) * (point.y - yi) / (yj - yi) + xi);
    if (intersect) inside = !inside;
  }
  return inside;
}

// Граф и комнаты (работает с массивом отрезков {id, x1,y1,x2,y2})

// ─── Константы допусков ────────────────────────────────────────────
// EPS_SNAP  — максимальное расстояние между «одной и той же» точкой.
//             Перекрывает типичное дрожание привязки (sub-pixel + float).
//             При сетке 1мм = 1 единица: 10 единиц = 10мм — безопасно.
// EPS_PERP  — насколько конец/пересечение может отклониться от оси отрезка
//             (поперечное отклонение).
// EPS_ALONG — насколько точка может выйти за концы отрезка при фильтрации.
const EPS_SNAP  = 10;   // было 5 → увеличено для устойчивости к дрожанию
const EPS_PERP  = 10;   // было 5
const EPS_ALONG = 10;   // было 2

/**
 * Принудительно «защёлкивает» концы отрезков друг к другу, если они
 * попадают в радиус EPS_SNAP. Возвращает новый массив отрезков с
 * исправленными координатами — оригинал не мутируется.
 *
 * Это нулевой шаг перед построением графа: убирает микронестыковки,
 * которые возникают из-за float-арифметики в инструменте рисования
 * даже при включённой привязке.
 */
function snapEndpoints(segments, eps = EPS_SNAP) {
  // Собираем все концы
  const raw = [];
  for (const s of segments) {
    raw.push({ x: s.x1, y: s.y1, sid: s.id, which: 1 });
    raw.push({ x: s.x2, y: s.y2, sid: s.id, which: 2 });
  }

  // Union-Find по близости: группируем концы в радиусе eps
  const parent = raw.map((_, i) => i);
  function find(i) {
    while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; }
    return i;
  }
  function unite(i, j) { parent[find(i)] = find(j); }

  for (let i = 0; i < raw.length; i++) {
    for (let j = i + 1; j < raw.length; j++) {
      if (Math.hypot(raw[i].x - raw[j].x, raw[i].y - raw[j].y) < eps) {
        unite(i, j);
      }
    }
  }

  // Для каждой группы вычисляем среднюю точку (centroid) как canonical
  const groups = new Map();
  for (let i = 0; i < raw.length; i++) {
    const root = find(i);
    if (!groups.has(root)) groups.set(root, []);
    groups.get(root).push(raw[i]);
  }
  const canonical = new Map(); // root → {x, y}
  for (const [root, pts] of groups) {
    const x = pts.reduce((s, p) => s + p.x, 0) / pts.length;
    const y = pts.reduce((s, p) => s + p.y, 0) / pts.length;
    canonical.set(root, { x, y });
  }

  // Строим карту замены: (sid, which) → snapped {x, y}
  const snapMap = new Map();
  for (let i = 0; i < raw.length; i++) {
    const { sid, which } = raw[i];
    const c = canonical.get(find(i));
    snapMap.set(`${sid}:${which}`, c);
  }

  return segments.map(s => ({
    ...s,
    x1: snapMap.get(`${s.id}:1`).x,
    y1: snapMap.get(`${s.id}:1`).y,
    x2: snapMap.get(`${s.id}:2`).x,
    y2: snapMap.get(`${s.id}:2`).y,
  }));
}

/**
 * Находит все уникальные вершины графа стен/разделителей.
 * Принимает массив простых отрезков.
 */
export function findAllIntersections(segments, eps = EPS_SNAP) {
  // Шаг 0: защёлкиваем близкие концы
  segments = snapEndpoints(segments, eps);

  const points = [];

  function findOrAdd(x, y, sid) {
    const existing = points.find(p => Math.hypot(p.x - x, p.y - y) < eps);
    if (existing) {
      if (!existing.wallIds.includes(sid)) existing.wallIds.push(sid);
      return existing;
    }
    const np = { x, y, wallIds: [sid] };
    points.push(np);
    return np;
  }

  // 1. Концы всех (уже выровненных) отрезков
  for (const s of segments) {
    findOrAdd(s.x1, s.y1, s.id);
    findOrAdd(s.x2, s.y2, s.id);
  }

  // Дополнительный объединяющий проход — страхует от остаточных расхождений
  for (const s of segments) {
    for (const pt of [{ x: s.x1, y: s.y1 }, { x: s.x2, y: s.y2 }]) {
      const existing = points.find(p => Math.hypot(p.x - pt.x, p.y - pt.y) < eps);
      if (existing && !existing.wallIds.includes(s.id)) existing.wallIds.push(s.id);
    }
  }

  // 2. X-пересечения (пересечение внутри тел отрезков)
  for (let i = 0; i < segments.length; i++) {
    for (let j = i + 1; j < segments.length; j++) {
      const a = segments[i], b = segments[j];
      if (a.id === b.id) continue;
      const inter = segmentIntersection(a, b, eps);
      if (inter) {
        const p = findOrAdd(inter.x, inter.y, a.id);
        if (!p.wallIds.includes(b.id)) p.wallIds.push(b.id);
      }
    }
  }

  // 3. T-стыки: конец sA лежит на теле sB (не на концах — они уже покрыты шагом 1)
  for (const sA of segments) {
    const endpointsA = [{ x: sA.x1, y: sA.y1 }, { x: sA.x2, y: sA.y2 }];
    for (const sB of segments) {
      if (sA.id === sB.id) continue;
      const lenB = Math.hypot(sB.x2 - sB.x1, sB.y2 - sB.y1);
      if (lenB < 1) continue;
      const uxB = (sB.x2 - sB.x1) / lenB, uyB = (sB.y2 - sB.y1) / lenB;
      const nxB = -uyB;

      for (const pt of endpointsA) {
        const dx = pt.x - sB.x1, dy = pt.y - sB.y1;
        const along = dx * uxB + dy * uyB;
        const perp  = Math.abs(dx * nxB + dy * uyB); // note: was wrong (nyB unused), use nxB/-uyB properly
        const perpCorrect = Math.abs(dx * (-uyB) + dy * uxB);
        if (along > eps && along < lenB - eps && perpCorrect <= EPS_PERP) {
          const projX = sB.x1 + uxB * along;
          const projY = sB.y1 + uyB * along;
          const p = findOrAdd(projX, projY, sB.id);
          if (!p.wallIds.includes(sA.id)) p.wallIds.push(sA.id);
        }
      }
    }
  }

  return points;
}

/**
 * Строит граф: вершины (id, x, y, wallIds) и рёбра (v1, v2, wallId).
 */
export function buildWallGraph(segments, points, eps = EPS_SNAP) {
  // snapEndpoints уже применялся в findAllIntersections, но если buildWallGraph
  // вызывается отдельно — применяем снова для консистентности
  segments = snapEndpoints(segments, eps);

  const vertices = points.map((p, i) => ({ ...p, id: i }));
  const rawEdges = [];

  for (const seg of segments) {
    const len = Math.hypot(seg.x2 - seg.x1, seg.y2 - seg.y1);
    if (len < 1) continue;
    const ux = (seg.x2 - seg.x1) / len, uy = (seg.y2 - seg.y1) / len;
    const nx = -uy, ny = ux;

    const onSeg = vertices.filter(v => {
      if (!v.wallIds.includes(seg.id)) return false;
      const dx = v.x - seg.x1, dy = v.y - seg.y1;
      const along = dx * ux + dy * uy;
      const perp  = Math.abs(dx * nx + dy * ny);
      return along >= -EPS_ALONG && along <= len + EPS_ALONG && perp <= EPS_PERP;
    });

    if (onSeg.length < 2) continue;

    onSeg.sort((va, vb) => {
      const da = (va.x - seg.x1) * ux + (va.y - seg.y1) * uy;
      const db = (vb.x - seg.x1) * ux + (vb.y - seg.y1) * uy;
      return da - db;
    });

    // удаляем дубли по координате вдоль (используем EPS_SNAP как порог)
    const deduped = [];
    for (const v of onSeg) {
      const along = (v.x - seg.x1) * ux + (v.y - seg.y1) * uy;
      const prev = deduped.length
        ? (deduped[deduped.length-1].x - seg.x1) * ux + (deduped[deduped.length-1].y - seg.y1) * uy
        : -Infinity;
      if (along - prev > EPS_SNAP) deduped.push(v);
    }

    for (let i = 0; i < deduped.length - 1; i++) {
      const v1 = deduped[i], v2 = deduped[i+1];
      if (Math.hypot(v2.x - v1.x, v2.y - v1.y) < 1) continue;
      rawEdges.push({ v1: v1.id, v2: v2.id, wallId: seg.id });
    }
  }

  // Склейка параллельных дубликатов
  const edgeMap = new Map();
  for (const e of rawEdges) {
    const a = Math.min(e.v1, e.v2), b = Math.max(e.v1, e.v2);
    const key = `${a}-${b}`;
    if (!edgeMap.has(key)) {
      edgeMap.set(key, { id: `e${edgeMap.size}`, v1: e.v1, v2: e.v2, wallId: e.wallId });
    }
  }

  return { vertices, edges: Array.from(edgeMap.values()) };
}

/**
 * Находит все грани (faces) в планарном графе методом «наименьшего левого поворота».
 *
 * ИСПРАВЛЕНИЕ (Баг 1 + Баг 2):
 *
 * Баг 1: в оригинале последняя вершина перед замыканием (prev в момент
 * nextEdge.to === start) не добавлялась в path — грань была неполной.
 * Теперь prev добавляется явно перед break.
 *
 * Баг 2: в экранных координатах (ось Y направлена вниз) внутренние грани
 * обходятся по часовой стрелке (CW) и имеют ОТРИЦАТЕЛЬНУЮ signedArea
 * по стандартной формуле Шoelace. Внешний контур — CCW, signedArea > 0.
 * Оригинальный фильтр «> 0 → skip» выбрасывал все правильные грани.
 * Исправлено на «>= 0 → skip» (внешний контур и вырожденные).
 *
 * Примечание о системе координат: если у вас ось Y смотрит вверх
 * (математическая), поменяйте знак обратно на «< 0 → skip».
 */
export function findFaces(vertices, edges) {
  const adj = Array.from({ length: vertices.length }, () => []);
  for (const e of edges) {
    adj[e.v1].push({ to: e.v2, edge: e });
    adj[e.v2].push({ to: e.v1, edge: e });
  }

  // Сортируем смежные вершины по углу (CCW) для каждой вершины
  for (let i = 0; i < adj.length; i++) {
    adj[i].sort((a, b) => {
      const v = vertices[i];
      const angA = Math.atan2(vertices[a.to].y - v.y, vertices[a.to].x - v.x);
      const angB = Math.atan2(vertices[b.to].y - v.y, vertices[b.to].x - v.x);
      return angA - angB;
    });
  }

  // Кодируем направленные рёбра как ключи "vFrom->vTo"
  // для отслеживания использованных полуребёр
  const usedHalfEdges = new Set();
  const seenFaces = new Set();
  const faces = [];

  for (const e of edges) {
    for (const [vFrom, vTo] of [[e.v1, e.v2], [e.v2, e.v1]]) {
      const heKey = `${vFrom}->${vTo}`;
      if (usedHalfEdges.has(heKey)) continue;
      usedHalfEdges.add(heKey);

      // Обходим грань: всегда поворачиваем «как можно правее» (наименьший левый поворот)
      // что соответствует обходу внутренних граней в планарном графе
      const path = [vFrom, vTo];
      let cur = vFrom;
      let nxt = vTo;
      const maxSteps = edges.length + 4;
      let steps = 0;
      let closed = false;

      while (steps++ < maxSteps) {
        const neighbors = adj[nxt];
        // Находим индекс входящего ребра (cur → nxt) в списке соседей nxt
        const inIdx = neighbors.findIndex(n => n.to === cur);
        if (inIdx === -1) break; // граф не планарный или ошибка

        // Следующий сосед по CCW — это следующий после входящего (по часовой в экранных координатах)
        // adj отсортирован по углу CCW, поэтому +1 даёт наименьший левый поворот
        const outIdx = (inIdx + 1) % neighbors.length;
        const nextNeighbor = neighbors[outIdx];
        const nextV = nextNeighbor.to;

        if (nextV === path[0]) {
          // Замкнулись
          closed = true;
          // Помечаем финальное полуребро использованным
          usedHalfEdges.add(`${nxt}->${nextV}`);
          break;
        }

        // Помечаем полуребро использованным
        usedHalfEdges.add(`${nxt}->${nextV}`);
        path.push(nextV);
        cur = nxt;
        nxt = nextV;
      }

      if (!closed || path.length < 3) continue;

      // Дедупликация граней по набору вершин
      const vertexIds = path.slice().sort((a, b) => a - b);
      const faceKey = vertexIds.join(',');
      if (seenFaces.has(faceKey)) continue;
      seenFaces.add(faceKey);

      const polygon = path.map(id => vertices[id]);

      // ─── ИСПРАВЛЕНИЕ БАГ 2 ───────────────────────────────────────
      // В экранных координатах (Y вниз):
      //   внутренние грани (CW) → signedArea < 0
      //   внешний контур (CCW)  → signedArea > 0
      // Отбрасываем внешний контур и вырожденные (>= 0).
      // ЕСЛИ у вас Y направлен вверх — замените на «< 0 → continue».
      if (polygonSignedArea(polygon) >= 0) continue;

      faces.push(polygon);
    }
  }

  return faces;
}
