// ─── GEOMETRY.JS — pure math, vector room detection ────────────────
//
// МОДЕЛЬ ПОМЕЩЕНИЙ (Renga-style):
// • Контур помещения = линии рисования стен (cx1,cy1 → cx2,cy2),
//   которые при привязке 'left'/'right' лежат на ВНУТРЕННЕЙ ГРАНИ стены.
// • Толщина стен в построении графа НЕ участвует. Снаппинг при рисовании
//   гарантирует, что концы соседних стен совпадают точно по cx/cy.
// • Все допуски в графе — это допуски на ошибки округления плавающей точки
//   (~2 мм), а не на физические толщины конструкций.
//
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

export function rangesOverlap(a1, a2, b1, b2, eps = 2) {
  return Math.max(Math.min(a1, a2), Math.min(b1, b2)) <
         Math.min(Math.max(a1, a2), Math.max(b1, b2)) + eps;
}

export function clusterValues(values, threshold = 5) {
  if (!values.length) return [];
  const sorted = [...values].sort((a, b) => a - b);
  const result = [];
  let group = [sorted[0]];
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i] - group[group.length - 1] <= threshold) {
      group.push(sorted[i]);
    } else {
      result.push(group.reduce((s, v) => s + v, 0) / group.length);
      group = [sorted[i]];
    }
  }
  result.push(group.reduce((s, v) => s + v, 0) / group.length);
  return result.map(v => Math.round(v));
}

export function applyWallOffset(cx, cy, angle, offset, thickness) {
  // 'center' deprecated — поддерживается только для обратной совместимости
  // со старыми проектами. Новые стены создаются только с 'left' или 'right'.
  if (offset === 'center') return { x: cx, y: cy };
  const px = -Math.sin(angle);
  const py =  Math.cos(angle);
  const sign = offset === 'right' ? 1 : -1;
  return { x: cx + sign * px * thickness / 2, y: cy + sign * py * thickness / 2 };
}

// ══════════════════════════════════════════════════════════════════
// ВЕКТОРНОЕ ПОСТРОЕНИЕ КОМНАТ
// ══════════════════════════════════════════════════════════════════

/** Знаковая площадь полигона (положительная для CCW, отрицательная для CW) */
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

/** Площадь полигона (по модулю) */
export function polygonArea(poly) {
  return Math.abs(polygonSignedArea(poly));
}

/** Центроид полигона */
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

/** Проверка: точка внутри полигона (алгоритм луча) */
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

/** Проверка: точка внутри контура стены (для исключения пустот) */
export function isPointInWall(point, wall, eps = 5) {
  const len = Math.hypot(wall.x2 - wall.x1, wall.y2 - wall.y1);
  if (len < 0.001) return false;
  const u = ((point.x - wall.x1) * (wall.x2 - wall.x1) + (point.y - wall.y1) * (wall.y2 - wall.y1)) / (len * len);
  if (u < -0.1 || u > 1.1) return false;
  const proj = {
    x: wall.x1 + u * (wall.x2 - wall.x1),
    y: wall.y1 + u * (wall.y2 - wall.y1)
  };
  const dist = Math.hypot(point.x - proj.x, point.y - proj.y);
  return dist <= wall.thickness / 2 + eps;
}

// Хелпер: базовая линия стены — линия рисования = внутренняя грань
function wallBase(w) {
  return {
    x1: w.cx1 ?? w.x1, y1: w.cy1 ?? w.y1,
    x2: w.cx2 ?? w.x2, y2: w.cy2 ?? w.y2,
  };
}

/**
 * Возвращает противоположную грань стены — линию, параллельную cx/cy на
 * расстоянии thickness по нормали в сторону, противоположную offset.
 *
 * Для стены с offset='right': cx/cy справа от направления, противоположная
 * грань слева (нормаль -wN). Для offset='left': наоборот.
 *
 * Если толщина 0 (разделитель) — противоположная грань не строится (return null).
 */
function wallOppositeFace(w) {
  const b = wallBase(w);
  const t = w.thickness || 0;
  if (t < 0.5) return null; // разделители не имеют второй грани
  const len = Math.hypot(b.x2 - b.x1, b.y2 - b.y1);
  if (len < 1) return null;
  const ux = (b.x2 - b.x1) / len, uy = (b.y2 - b.y1) / len;
  const nx = -uy, ny = ux;
  // Знак противоположной грани относительно cx/cy:
  // applyWallOffset для 'right' сдвигает ось на +nx*halfT (sign=+1)
  // → внутренняя грань (cx/cy) = ось − halfT по n → противоположная = ось + halfT = +n от cx/cy
  // Для 'left' → противоположная = -n от cx/cy
  const sign = w.offset === 'right' ? +1 : -1;
  const dx = sign * nx * t;
  const dy = sign * ny * t;
  return {
    x1: b.x1 + dx, y1: b.y1 + dy,
    x2: b.x2 + dx, y2: b.y2 + dy,
  };
}

/**
 * Возвращает обе грани стены: внутреннюю (cx/cy) и противоположную.
 * Для разделителей — только одну (cx/cy).
 *
 * Каждая грань — это объект { x1,y1,x2,y2, wall, faceKind } где faceKind
 * = 'inner' (по cx/cy, со стороны offset) или 'outer' (противоположная).
 */
function wallFaces(w) {
  const inner = wallBase(w);
  const opp = wallOppositeFace(w);
  const result = [{ ...inner, wall: w, faceKind: 'inner' }];
  if (opp) result.push({ ...opp, wall: w, faceKind: 'outer' });
  return result;
}

/**
 * Возвращает торцы стены — два коротких отрезка на её концах,
 * соединяющих внутреннюю и внешнюю грани. Нужны чтобы соседняя
 * комната могла замкнуть свой контур через торец общей стены.
 *
 * Для разделителя торцов нет (return []).
 */
function wallEnds(w) {
  const inner = wallBase(w);
  const opp = wallOppositeFace(w);
  if (!opp) return [];
  return [
    { x1: inner.x1, y1: inner.y1, x2: opp.x1, y2: opp.y1, wall: w, faceKind: 'end-start' },
    { x1: inner.x2, y1: inner.y2, x2: opp.x2, y2: opp.y2, wall: w, faceKind: 'end-end' },
  ];
}

/**
 * Все сегменты стены, участвующие в графе помещений:
 *   - inner: внутренняя грань (cx/cy, та что рисует пользователь)
 *   - outer: противоположная грань (на расстоянии thickness)
 *   - end-start, end-end: торцы (соединяют inner и outer на концах стены)
 *
 * Для разделителя — только одна inner (нет толщины, нет торцов).
 */
function wallSegments(w) {
  return [...wallFaces(w), ...wallEnds(w)];
}

/**
 * Находит все уникальные вершины графа по ВСЕМ сегментам каждой стены
 * (внутренняя грань, внешняя грань, два торца).
 *
 * НОВАЯ МОДЕЛЬ (Renga-style 2.0):
 * Стена даёт в граф 4 сегмента: две продольных грани (inner + outer) и
 * два торца. Это позволяет одной физической стене обслуживать ДВЕ комнаты
 * (по одной с каждой стороны), и контур каждой комнаты корректно замыкается
 * через торцы общей стены.
 *
 * Снаппинг при рисовании гарантирует точное совпадение концов соседних
 * стен. Допуск ~2 мм только на float-округления.
 */
export function findAllIntersections(walls, eps = 2) {
  const EPS_MERGE = 2;
  const EPS_PERP  = 2;

  // Все сегменты всех стен
  const allSegs = [];
  for (const w of walls) {
    for (const s of wallSegments(w)) allSegs.push(s);
  }

  // Уникальный ID сегмента — для wallIds в вершинах
  function segId(s) {
    if (s.faceKind === 'inner') return s.wall.id;
    if (s.faceKind === 'outer') return `${s.wall.id}_o`;
    return `${s.wall.id}_${s.faceKind}`; // end-start / end-end
  }

  const points = [];

  function findOrAdd(x, y, sid) {
    const existing = points.find(p => Math.hypot(p.x - x, p.y - y) < EPS_MERGE);
    if (existing) {
      if (!existing.wallIds.includes(sid)) existing.wallIds.push(sid);
      return existing;
    }
    const np = { x, y, wallIds: [sid] };
    points.push(np);
    return np;
  }

  // 1. Концы всех сегментов
  for (const s of allSegs) {
    const sid = segId(s);
    findOrAdd(s.x1, s.y1, sid);
    findOrAdd(s.x2, s.y2, sid);
  }

  // 2. Пересечения сегментов (X-стыки и crossing)
  for (let i = 0; i < allSegs.length; i++) {
    for (let j = i + 1; j < allSegs.length; j++) {
      const s1 = allSegs[i], s2 = allSegs[j];
      // Не считаем пересечения сегментов одной стены — они и так связаны
      if (s1.wall.id === s2.wall.id) continue;
      const inter = segmentIntersection(s1, s2, eps);
      if (inter) {
        const p = findOrAdd(inter.x, inter.y, segId(s1));
        const sid2 = segId(s2);
        if (!p.wallIds.includes(sid2)) p.wallIds.push(sid2);
      }
    }
  }

  // 3. T-стыки: конец одного сегмента лежит на оси другого
  for (const sA of allSegs) {
    const endpointsA = [{ x: sA.x1, y: sA.y1 }, { x: sA.x2, y: sA.y2 }];
    const sidA = segId(sA);
    for (const sB of allSegs) {
      if (sA === sB) continue;
      if (sA.wall.id === sB.wall.id) continue; // те же стены — пропускаем
      const lenB = Math.hypot(sB.x2 - sB.x1, sB.y2 - sB.y1);
      if (lenB < 1) continue;
      const uxB = (sB.x2 - sB.x1) / lenB, uyB = (sB.y2 - sB.y1) / lenB;
      const nxB = -uyB, nyB = uxB;
      const sidB = segId(sB);

      for (const pt of endpointsA) {
        const dx = pt.x - sB.x1, dy = pt.y - sB.y1;
        const along = dx * uxB + dy * uyB;
        const perp  = Math.abs(dx * nxB + dy * nyB);
        if (along > EPS_MERGE && along < lenB - EPS_MERGE && perp <= EPS_PERP) {
          const projX = sB.x1 + uxB * along;
          const projY = sB.y1 + uyB * along;
          const p = findOrAdd(projX, projY, sidB);
          if (!p.wallIds.includes(sidA)) p.wallIds.push(sidA);
        }
      }
    }
  }

  return points;
}

/**
 * Строит граф: вершины и рёбра.
 *
 * НОВАЯ МОДЕЛЬ: каждая стена даёт 4 ребра в графе:
 *   - inner: внутренняя грань (cx/cy)
 *   - outer: противоположная грань (на расстоянии thickness)
 *   - 2 торца: соединяют inner и outer на концах
 *
 * Это позволяет одной физической стене замыкать контуры ДВУХ комнат —
 * каждая со своей стороны, через торцы общей стены.
 *
 * Параллельные дубликаты рёбер склеиваются.
 */
export function buildWallGraph(walls, points, eps = 2) {
  const EPS_PERP = 2;
  const EPS_ALONG = 2;

  const vertices = points.map((p, i) => ({ ...p, id: i }));
  const rawEdges = [];

  // Все сегменты всех стен
  const allSegs = [];
  for (const w of walls) {
    for (const s of wallSegments(w)) allSegs.push(s);
  }

  function segId(s) {
    if (s.faceKind === 'inner') return s.wall.id;
    if (s.faceKind === 'outer') return `${s.wall.id}_o`;
    return `${s.wall.id}_${s.faceKind}`;
  }

  for (const seg of allSegs) {
    const sid = segId(seg);
    const len = Math.hypot(seg.x2 - seg.x1, seg.y2 - seg.y1);
    if (len < 1) continue;
    const ux = (seg.x2 - seg.x1) / len, uy = (seg.y2 - seg.y1) / len;
    const nx = -uy, ny = ux;

    const onSeg = vertices.filter(v => {
      if (!v.wallIds.includes(sid)) return false;
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

    const deduped = [];
    for (const v of onSeg) {
      const along = (v.x - seg.x1) * ux + (v.y - seg.y1) * uy;
      const prev = deduped.length
        ? (deduped[deduped.length-1].x - seg.x1) * ux + (deduped[deduped.length-1].y - seg.y1) * uy
        : -Infinity;
      if (along - prev > eps) deduped.push(v);
    }

    for (let i = 0; i < deduped.length - 1; i++) {
      const v1 = deduped[i], v2 = deduped[i+1];
      if (Math.hypot(v2.x - v1.x, v2.y - v1.y) < 1) continue;
      rawEdges.push({
        v1: v1.id, v2: v2.id,
        wallId: seg.wall.id,
        faceKind: seg.faceKind,
      });
    }
  }

  // Склейка параллельных дубликатов
  const edgeMap = new Map();
  for (const e of rawEdges) {
    const a = Math.min(e.v1, e.v2), b = Math.max(e.v1, e.v2);
    const key = `${a}-${b}`;
    if (!edgeMap.has(key)) {
      edgeMap.set(key, {
        id: `e${edgeMap.size}`,
        v1: e.v1, v2: e.v2,
        wallId: e.wallId,
        wallIds: [e.wallId],
        faceKinds: [e.faceKind],
      });
    } else {
      const existing = edgeMap.get(key);
      if (!existing.wallIds.includes(e.wallId)) existing.wallIds.push(e.wallId);
      if (!existing.faceKinds.includes(e.faceKind)) existing.faceKinds.push(e.faceKind);
    }
  }

  const edges = Array.from(edgeMap.values());
  return { vertices, edges };
}

/** Находит все грани (faces) в планарном графе */
export function findFaces(vertices, edges) {
  const adj = Array.from({ length: vertices.length }, () => []);
  for (const e of edges) {
    adj[e.v1].push({ to: e.v2, edge: e });
    adj[e.v2].push({ to: e.v1, edge: e });
  }

  for (let i = 0; i < adj.length; i++) {
    adj[i].sort((a, b) => {
      const v = vertices[i];
      const angA = Math.atan2(vertices[a.to].y - v.y, vertices[a.to].x - v.x);
      const angB = Math.atan2(vertices[b.to].y - v.y, vertices[b.to].x - v.x);
      return angA - angB;
    });
  }

  const usedEdges = new Set();
  const faces = [];

  for (const e of edges) {
    for (const dir of ['forward', 'backward']) {
      const start = dir === 'forward' ? e.v1 : e.v2;
      const next  = dir === 'forward' ? e.v2 : e.v1;
      const edgeKey = `${e.id}:${dir}`;
      if (usedEdges.has(edgeKey)) continue;

      const path = [{ v: start, e: e.id }];
      let current = start;
      let prev = next;
      usedEdges.add(edgeKey);
      const maxSteps = edges.length * 2 + 4;
      let steps = 0;

      while (steps++ < maxSteps) {
        const neighbors = adj[prev];
        const inIdx = neighbors.findIndex(n => n.to === current);
        if (inIdx === -1) break;
        const outIdx = (inIdx + 1) % neighbors.length;
        const nextEdge = neighbors[outIdx];

        path.push({ v: prev, e: nextEdge.edge.id });

        if (nextEdge.to === start) break;

        const dirKey = nextEdge.edge.v1 === prev ? 'forward' : 'backward';
        usedEdges.add(`${nextEdge.edge.id}:${dirKey}`);

        current = prev;
        prev = nextEdge.to;
      }

      const polygon = path.map(p => vertices[p.v]);
      faces.push(polygon);
    }
  }

  return faces;
}

/**
 * Площадь bounding box полигона.
 * Используется для надёжного определения внешнего фейса.
 */
export function polygonBboxArea(poly) {
  if (!poly || poly.length === 0) return 0;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of poly) {
    if (p.x < minX) minX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.x > maxX) maxX = p.x;
    if (p.y > maxY) maxY = p.y;
  }
  return (maxX - minX) * (maxY - minY);
}
