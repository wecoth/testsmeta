// ─── GEOMETRY.JS — pure math, vector room detection added ─────────
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
  if (offset === 'center') return { x: cx, y: cy };
  const px = -Math.sin(angle);
  const py =  Math.cos(angle);
  const sign = offset === 'right' ? 1 : -1;
  return { x: cx + sign * px * thickness / 2, y: cy + sign * py * thickness / 2 };
}

// ══════════════════════════════════════════════════════════════════
// ВЕКТОРНОЕ ПОСТРОЕНИЕ КОМНАТ
// ══════════════════════════════════════════════════════════════════

/** Площадь полигона (по модулю) */
export function polygonArea(poly) {
  if (poly.length < 3) return 0;
  let area = 0;
  for (let i = 0; i < poly.length; i++) {
    const p1 = poly[i];
    const p2 = poly[(i + 1) % poly.length];
    area += p1.x * p2.y - p2.x * p1.y;
  }
  return Math.abs(area) / 2;
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

// Хелпер: базовая линия стены (cx/cy если есть, иначе x/y)
function wallBase(w) {
  return {
    x1: w.cx1 ?? w.x1, y1: w.cy1 ?? w.y1,
    x2: w.cx2 ?? w.x2, y2: w.cy2 ?? w.y2,
  };
}

/**
 * Находит все уникальные вершины графа по осям стен (cx/cy).
 *
 * ИСПРАВЛЕНИЕ (Баг 1):
 * Раньше использовался единый MERGE = maxThickness + 10 (~160 мм).
 * Это приводило к тому, что конец перегородки и конец соседней стены
 * сливались в одну вершину → ребро не создавалось → контур не замыкался.
 *
 * Теперь два раздельных допуска:
 *   ENDPOINT_MERGE = 8 мм  — только для слияния концов стен друг с другом
 *   TSTYLE_MERGE           — для T-стыков: конец одной стены попадает в середину другой
 *
 * T-стык определяется отдельно: если конец стены лежит вдоль оси другой стены
 * на расстоянии перпендикуляра ≤ halfThickness + зазор, это T-стык.
 */
export function findAllIntersections(walls, eps = 2) {
  // Маленький допуск — только для слияния действительно близких концов
  const ENDPOINT_MERGE = 8;

  const points = [];

  function findOrAdd(x, y, wallId) {
    const existing = points.find(p => Math.hypot(p.x - x, p.y - y) < ENDPOINT_MERGE);
    if (existing) {
      if (!existing.wallIds.includes(wallId)) existing.wallIds.push(wallId);
      return existing;
    }
    const np = { x, y, wallIds: [wallId] };
    points.push(np);
    return np;
  }

  // 1. Концы всех стен (по cx/cy) — с дедупликацией через ENDPOINT_MERGE
  for (const w of walls) {
    const b = wallBase(w);
    findOrAdd(b.x1, b.y1, w.id);
    findOrAdd(b.x2, b.y2, w.id);
  }

  // 2. Пересечения осей стен (T-стыки и крестовины)
  //    Используем стандартный segmentIntersection — он работает точно
  for (let i = 0; i < walls.length; i++) {
    for (let j = i + 1; j < walls.length; j++) {
      const b1 = wallBase(walls[i]), b2 = wallBase(walls[j]);
      const inter = segmentIntersection(b1, b2, eps);
      if (inter) {
        const p = findOrAdd(inter.x, inter.y, walls[i].id);
        if (!p.wallIds.includes(walls[j].id)) p.wallIds.push(walls[j].id);
      }
    }
  }

  // 3. T-стык: конец стены A лежит на оси стены B, но не пересекает её
  //    (segmentIntersection не поймает случай, когда конец ровно на оси)
  //    Допуск перпендикуляра = halfThickness стены B + небольшой зазор
  for (const wA of walls) {
    const bA = wallBase(wA);
    const endpointsA = [
      { x: bA.x1, y: bA.y1 },
      { x: bA.x2, y: bA.y2 },
    ];
    for (const wB of walls) {
      if (wB.id === wA.id) continue;
      const bB = wallBase(wB);
      const lenB = Math.hypot(bB.x2 - bB.x1, bB.y2 - bB.y1);
      if (lenB < 1) continue;
      const uxB = (bB.x2 - bB.x1) / lenB, uyB = (bB.y2 - bB.y1) / lenB;
      const nxB = -uyB, nyB = uxB;
      const halfTB = (wB.thickness || 0) / 2;
      // Допуск перпендикуляра: полтолщины стены B + 5 мм зазор
      const PERP_TOL = halfTB + 5;
      // Допуск вдоль оси: чуть больше нуля, чтобы не дублировать уже найденные пересечения
      const ALONG_TOL = 5;

      for (const pt of endpointsA) {
        const dx = pt.x - bB.x1, dy = pt.y - bB.y1;
        const along = dx * uxB + dy * uyB;
        const perp  = Math.abs(dx * nxB + dy * nyB);
        // Точка должна лежать ВНУТРИ отрезка (не на самом конце — там уже есть вершина)
        if (along > ALONG_TOL && along < lenB - ALONG_TOL && perp <= PERP_TOL) {
          // Проецируем на ось стены B → точная точка T-стыка
          const projX = bB.x1 + uxB * along;
          const projY = bB.y1 + uyB * along;
          const p = findOrAdd(projX, projY, wB.id);
          if (!p.wallIds.includes(wA.id)) p.wallIds.push(wA.id);
        }
      }
    }
  }

  return points;
}

/**
 * Строит граф: вершины и рёбра.
 *
 * Для каждой стены отбираем только вершины, которые физически лежат
 * на её оси. Допуск перпендикуляра = halfThickness + зазор (покрывает
 * T-стыки, где вершина могла чуть сдвинуться при проекции).
 *
 * Параллельные дубликаты рёбер (общая граница между двумя комнатами)
 * склеиваются в одно ребро — иначе findFaces даёт паразитные фейсы.
 */
export function buildWallGraph(walls, points, eps = 2) {
  const vertices = points.map((p, i) => ({ ...p, id: i }));
  const rawEdges = [];

  for (const wall of walls) {
    const b = wallBase(wall);
    const len = Math.hypot(b.x2 - b.x1, b.y2 - b.y1);
    if (len < 1) continue;
    const ux = (b.x2 - b.x1) / len, uy = (b.y2 - b.y1) / len;
    const nx = -uy, ny = ux;
    const halfT = (wall.thickness || 0) / 2;
    // Допуск перпендикуляра: halfThickness + запас на T-стык
    const PERP_TOL = halfT + 10;
    // Допуск вдоль оси: небольшой выход за концы (слияние могло чуть сдвинуть вершину)
    const ALONG_TOL = 10;

    const onWall = vertices.filter(v => {
      if (!v.wallIds.includes(wall.id)) return false;
      const dx = v.x - b.x1, dy = v.y - b.y1;
      const along = dx * ux + dy * uy;
      const perp  = Math.abs(dx * nx + dy * ny);
      return along >= -ALONG_TOL && along <= len + ALONG_TOL && perp <= PERP_TOL;
    });

    if (onWall.length < 2) continue;

    onWall.sort((va, vb) => {
      const da = (va.x - b.x1) * ux + (va.y - b.y1) * uy;
      const db = (vb.x - b.x1) * ux + (vb.y - b.y1) * uy;
      return da - db;
    });

    // Дедупликация близких вершин вдоль оси
    const deduped = [];
    for (const v of onWall) {
      const along = (v.x - b.x1) * ux + (v.y - b.y1) * uy;
      const prev = deduped.length
        ? (deduped[deduped.length-1].x - b.x1) * ux + (deduped[deduped.length-1].y - b.y1) * uy
        : -Infinity;
      if (along - prev > eps) deduped.push(v);
    }

    for (let i = 0; i < deduped.length - 1; i++) {
      const v1 = deduped[i], v2 = deduped[i+1];
      if (Math.hypot(v2.x - v1.x, v2.y - v1.y) < 1) continue;
      rawEdges.push({ v1: v1.id, v2: v2.id, wallId: wall.id });
    }
  }

  // Склейка параллельных дубликатов рёбер
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
      });
    } else {
      const existing = edgeMap.get(key);
      if (!existing.wallIds.includes(e.wallId)) existing.wallIds.push(e.wallId);
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
 * Вычисляет bounding box полигона и его площадь.
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
