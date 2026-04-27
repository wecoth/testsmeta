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

/**
 * Находит все уникальные вершины графа стен/разделителей.
 * Принимает массив простых отрезков.
 */
export function findAllIntersections(segments, eps = 5) {
  const EPS_MERGE = 5;
  const EPS_PERP  = 5;

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

  // 1. Концы всех отрезков
  for (const s of segments) {
    findOrAdd(s.x1, s.y1, s.id);
    findOrAdd(s.x2, s.y2, s.id);
  }

  // 2. Пересечения отрезков (X-стыки)
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

  // 3. T-стыки: конец одного отрезка лежит на теле другого
  for (const sA of segments) {
    const endpointsA = [{ x: sA.x1, y: sA.y1 }, { x: sA.x2, y: sA.y2 }];
    for (const sB of segments) {
      if (sA.id === sB.id) continue;
      const lenB = Math.hypot(sB.x2 - sB.x1, sB.y2 - sB.y1);
      if (lenB < 1) continue;
      const uxB = (sB.x2 - sB.x1) / lenB, uyB = (sB.y2 - sB.y1) / lenB;
      const nxB = -uyB, nyB = uxB;

      for (const pt of endpointsA) {
        const dx = pt.x - sB.x1, dy = pt.y - sB.y1;
        const along = dx * uxB + dy * uyB;
        const perp  = Math.abs(dx * nxB + dy * nyB);
        if (along > EPS_MERGE && along < lenB - EPS_MERGE && perp <= EPS_PERP) {
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
export function buildWallGraph(segments, points, eps = 5) {
  const EPS_PERP = 5;
  const EPS_ALONG = 2;

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

    // удаляем дубли по координате вдоль
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
    // Если несколько стен на одном ребре — игнорируем повтор, для графа важно только наличие ребра
  }

  return { vertices, edges: Array.from(edgeMap.values()) };
}

/**
 * Находит все грани (faces) в планарном графе.
 * Внешний контур (CCW) отбрасывается.
 */
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
  const seenFaces = new Set();
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

      // Дедупликация по набору вершин
      const vertexIds = path.map(p => p.v).slice().sort((a, b) => a - b);
      const faceKey = vertexIds.join(',');
      if (seenFaces.has(faceKey)) continue;
      seenFaces.add(faceKey);

      if (polygonSignedArea(polygon) > 0) continue; // внешний контур

      faces.push(polygon);
    }
  }

  return faces;
}
