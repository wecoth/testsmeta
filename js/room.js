// ─── ROOM.JS (Renga-style: контур по cx/cy = внутренние грани) ───
//
// МОДЕЛЬ:
// • Контур помещения = полигон граней (faces) графа, построенного по
//   линиям рисования стен (cx/cy). При привязке 'left'/'right' эта
//   линия совпадает с внутренней гранью стены.
// • Никаких смещений на полтолщины — buildInnerPolygon удалена.
// • Чистая площадь пола = площадь контура МИНУС:
//     - площадь "следов" висящих стен/перегородок внутри (длина × толщина)
//     - площадь вложенных помещений (если есть замкнутый контур внутри)
// • Площадь стен помещения = для каждой граничной стены: (длина сегмента,
//   относящегося к этому помещению) × высота, минус площадь проёмов.
// • Разделители (нулевая толщина) — участвуют в графе помещений, но в
//   подсчёте площади стен НЕ участвуют.
//
// ИЗВЕСТНОЕ ОГРАНИЧЕНИЕ:
// • Помещение-в-помещении (например, кладовка внутри большой комнаты,
//   не примыкающая ни к одной внешней стене) корректно НЕ обрабатывается:
//   findFaces работает только со связными планарными графами. Если
//   контур кладовки висит в воздухе внутри другой комнаты, он сливается
//   с внешним контуром в один "бубликообразный" фейс. Решение — соединить
//   кладовку с внешними стенами хотя бы одной общей точкой/гранью, или
//   реализовать поиск компонент связности отдельно.
//
import { appState, ROOM_STROKES } from './state.js';
import { EventBus } from './eventBus.js';
import {
  findAllIntersections, buildWallGraph, findFaces,
  polygonArea, polygonSignedArea, polygonCentroid, isPointInPolygon, isPointInWall,
  polygonBboxArea,
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
// ВСПОМОГАТЕЛЬНЫЕ ФУНКЦИИ ГЕОМЕТРИИ
// ══════════════════════════════════════════════════════════════════

/**
 * Возвращает все стены, у которых ХОТЯ БЫ ОДНА грань (внутренняя cx/cy
 * или противоположная) лежит на ребре полигона.
 *
 * Для внутренней грани — это сам отрезок cx/cy.
 * Для противоположной грани — это отрезок cx/cy, сдвинутый по нормали
 * на ±thickness в сторону, противоположную offset.
 *
 * Используется для:
 *  - сбора граничных стен помещения,
 *  - определения толщин стен в isDeadZone.
 */
function findAllWallsForEdge(ax, ay, bx, by, walls, eps = 3) {
  const midX = (ax + bx) / 2, midY = (ay + by) / 2;
  const edgeLen = Math.hypot(bx - ax, by - ay);
  if (edgeLen < 1) return [];
  const edUX = (bx - ax) / edgeLen, edUY = (by - ay) / edgeLen;
  const result = [];
  for (const w of walls) {
    // Базовая линия (cx/cy = внутренняя грань)
    const bx1 = w.cx1 ?? w.x1, by1 = w.cy1 ?? w.y1;
    const bx2 = w.cx2 ?? w.x2, by2 = w.cy2 ?? w.y2;
    const wLen = Math.hypot(bx2 - bx1, by2 - by1);
    if (wLen < 1) continue;
    const wUX = (bx2 - bx1) / wLen, wUY = (by2 - by1) / wLen;
    // Ребро и стена должны быть коллинеарны (по углу)
    if (Math.abs(edUX * wUX + edUY * wUY) < 0.95) continue;

    // Кандидатные грани стены: inner и outer
    const t = w.thickness || 0;
    const candidates = [{ x1: bx1, y1: by1 }];
    if (t > 0.5 && !w.isDivider) {
      const nx = -wUY, ny = wUX;
      const sign = w.offset === 'right' ? +1 : -1;
      candidates.push({ x1: bx1 + sign * nx * t, y1: by1 + sign * ny * t });
    }

    let matched = false;
    for (const c of candidates) {
      const dx = midX - c.x1, dy = midY - c.y1;
      const along = dx * wUX + dy * wUY;
      if (along < -eps || along > wLen + eps) continue;
      const perp = Math.abs(dx * (-wUY) + dy * wUX);
      if (perp > eps) continue;
      matched = true;
      break;
    }
    if (matched) result.push(w);
  }
  return result;
}

/**
 * Пересечение оси стены с полигоном комнаты.
 * Возвращает массив отрезков оси, лежащих ВНУТРИ или НА границе полигона.
 *
 * Используется для двух целей:
 *  1) подсчёт "следа" висящей стены внутри комнаты (вычитается из площади);
 *  2) определение длины стены, обращённой в данное помещение (для подсчёта
 *     площади стен помещения).
 */
function clipWallAxisToPolygon(wall, polygon) {
  const result = [];
  if (!polygon || polygon.length < 3) return result;

  const seg = {
    x1: wall.cx1 ?? wall.x1, y1: wall.cy1 ?? wall.y1,
    x2: wall.cx2 ?? wall.x2, y2: wall.cy2 ?? wall.y2,
  };
  const len = Math.hypot(seg.x2 - seg.x1, seg.y2 - seg.y1);
  if (len < 0.5) return result;

  const ux = (seg.x2 - seg.x1) / len;
  const uy = (seg.y2 - seg.y1) / len;

  // Все t-значения, где ось стены пересекает полигон (вход/выход)
  const ts = [0, 1];
  for (let i = 0; i < polygon.length; i++) {
    const a = polygon[i];
    const b = polygon[(i + 1) % polygon.length];
    const edge = { x1: a.x, y1: a.y, x2: b.x, y2: b.y };
    const inter = segmentIntersectionLocal(seg, edge);
    if (inter && inter.t > 0.001 && inter.t < 0.999) {
      ts.push(inter.t);
    }
  }

  // Также добавляем точки полигона, лежащие на оси стены (они могут
  // быть концами стен, упирающихся в эту стену)
  for (const p of polygon) {
    const dx = p.x - seg.x1, dy = p.y - seg.y1;
    const along = dx * ux + dy * uy;
    if (along < -3 || along > len + 3) continue;
    const perp = Math.abs(dx * (-uy) + dy * ux);
    if (perp <= 3) {
      const t = Math.max(0, Math.min(1, along / len));
      ts.push(t);
    }
  }

  ts.sort((a, b) => a - b);

  for (let i = 0; i < ts.length - 1; i++) {
    const t1 = ts[i], t2 = ts[i + 1];
    if (t2 - t1 < 0.001) continue;
    // Тестируем середину сегмента — внутри или на границе полигона
    const tm = (t1 + t2) / 2;
    const pm = { x: seg.x1 + ux * tm * len, y: seg.y1 + uy * tm * len };
    if (isPointInPolygon(pm, polygon) || isPointOnPolygonBoundary(pm, polygon, 3)) {
      result.push({
        x1: seg.x1 + ux * t1 * len,
        y1: seg.y1 + uy * t1 * len,
        x2: seg.x1 + ux * t2 * len,
        y2: seg.y1 + uy * t2 * len,
      });
    }
  }

  return result;
}

function segmentIntersectionLocal(a, b, eps = 0.001) {
  const r = { x: a.x2 - a.x1, y: a.y2 - a.y1 };
  const s = { x: b.x2 - b.x1, y: b.y2 - b.y1 };
  const denom = r.x * s.y - r.y * s.x;
  if (Math.abs(denom) < eps) return null;
  const qp = { x: b.x1 - a.x1, y: b.y1 - a.y1 };
  const t = (qp.x * s.y - qp.y * s.x) / denom;
  const u = (qp.x * r.y - qp.y * r.x) / denom;
  if (t < -eps || t > 1 + eps || u < -eps || u > 1 + eps) return null;
  return { x: a.x1 + r.x * t, y: a.y1 + r.y * t, t, u };
}

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

/**
 * Площадь "следа" стены/перегородки в мм²: длина её оси (или фрагмента
 * оси) умноженная на толщину. Используется для вычитания из площади пола.
 */
function wallFootprintArea(wall, lengthMm) {
  return lengthMm * (wall.thickness || 0);
}

/**
 * Удаляет из графа "висящие хвосты" — подграфы, соединённые с основной
 * сетью контуров через единственную точку сочленения (articulation point).
 *
 * В нашей модели каждая стена даёт inner+outer+2 торца. Висящий простенок
 * образует замкнутую микро-петлю (4-цикл) на свободном конце, подвешенную
 * к остальной сети через ОДНУ ТОЧКУ. Это означает что в графе нет ни
 * мостов, ни вершин степени 1 — нужен анализ через biconnected components.
 *
 * Алгоритм Тарьяна для BCC:
 *   1. Для КАЖДОГО связного компонента графа отдельно строим BCC.
 *   2. В каждом компоненте берём самую большую BCC по числу рёбер —
 *      это "сердцевина" с реальным контуром помещения.
 *   3. Все остальные BCC внутри компонента + bridges, ведущие к ним,
 *      удаляем как хвосты.
 *
 * Покомпонентная обработка нужна потому что в плане могут быть несколько
 * НЕСВЯЗАННЫХ групп стен (например, две квартиры, два дома) — каждая
 * должна обработаться независимо.
 *
 * Удалённые стены не теряются: они потом найдутся через
 * clipWallAxisToPolygon как interiorWalls помещения, в котором лежат.
 */
function pruneDanglingTails(vertices, edges) {
  const n = vertices.length;
  if (edges.length === 0) return edges;

  const adj = Array.from({ length: n }, () => []);
  for (let i = 0; i < edges.length; i++) {
    adj[edges[i].v1].push({ to: edges[i].v2, ei: i });
    adj[edges[i].v2].push({ to: edges[i].v1, ei: i });
  }

  // BCC через DFS Тарьяна. Каждое ребро попадает ровно в один BCC.
  // edgeComponentId[ei] = id корневой вершины DFS, с которой
  // начался обход (= id связного компонента графа).
  const disc = new Array(n).fill(-1);
  const low  = new Array(n).fill(-1);
  const edgeStack = [];
  const bccEdges = [];      // массив компонент BCC: каждая = массив ei
  const bccComponentId = []; // для каждой BCC — id связного компонента
  let timer = 0;

  function dfsBCC(root, componentId) {
    disc[root] = low[root] = timer++;
    const callStack = [{ u: root, parentEi: -1, iter: 0 }];
    while (callStack.length) {
      const frame = callStack[callStack.length - 1];
      const { u, parentEi } = frame;
      if (frame.iter < adj[u].length) {
        const { to, ei } = adj[u][frame.iter++];
        if (ei === parentEi) continue;
        if (disc[to] === -1) {
          disc[to] = low[to] = timer++;
          edgeStack.push(ei);
          callStack.push({ u: to, parentEi: ei, iter: 0 });
        } else if (disc[to] < disc[u]) {
          edgeStack.push(ei);
          low[u] = Math.min(low[u], disc[to]);
        }
      } else {
        callStack.pop();
        if (callStack.length) {
          const parent = callStack[callStack.length - 1];
          low[parent.u] = Math.min(low[parent.u], low[u]);
          if (low[u] >= disc[parent.u]) {
            const bcc = [];
            while (edgeStack.length) {
              const top = edgeStack.pop();
              bcc.push(top);
              if (top === parentEi) break;
            }
            if (bcc.length > 0) {
              bccEdges.push(bcc);
              bccComponentId.push(componentId);
            }
          }
        }
      }
    }
  }
  // Запускаем DFS отдельно от каждой непосещённой вершины с рёбрами —
  // получаем разбиение на связные компоненты автоматически.
  for (let v = 0; v < n; v++) {
    if (disc[v] === -1 && adj[v].length > 0) {
      dfsBCC(v, v);
    }
  }

  if (bccEdges.length === 0) return edges;

  // Для каждого связного компонента находим САМУЮ БОЛЬШУЮ BCC по
  // числу рёбер (это сердцевина, остальные BCC компонента — хвосты).
  const mainBccByComponent = new Map(); // componentId → idx в bccEdges
  for (let i = 0; i < bccEdges.length; i++) {
    const cid = bccComponentId[i];
    const cur = mainBccByComponent.get(cid);
    if (cur === undefined || bccEdges[i].length > bccEdges[cur].length) {
      mainBccByComponent.set(cid, i);
    }
  }

  // Оставляем рёбра, которые в главной BCC своего компонента
  const keep = new Set();
  for (const idx of mainBccByComponent.values()) {
    for (const ei of bccEdges[idx]) keep.add(ei);
  }

  const removed = new Set();
  for (let i = 0; i < edges.length; i++) {
    if (!keep.has(i)) removed.add(edges[i].id);
  }

  return edges.filter(e => !removed.has(e.id));
}

/**
 * Определяет, является ли фейс "мёртвой зоной" — пространством между
 * двумя параллельными стенами (физической толщиной общей стены).
 *
 * Признак: фейс — узкий вытянутый прямоугольник, у которого минимальное
 * расстояние между противоположными сторонами ≤ thickness стен + малый
 * допуск, И эти стороны лежат на разных стенах.
 *
 * Берём пары противоположных рёбер (i, i+2) для прямоугольных фейсов.
 * Для произвольных N-угольников — берём для каждого ребра ближайшее
 * параллельное ребро и измеряем расстояние.
 */
/**
 * Классифицирует рёбра полигона фейса по типу граней стен.
 *
 * Каждая стена в графе даёт 4 типа рёбер (см. geometry.js / wallSegments):
 *   - inner: внутренняя грань (cx/cy = линия рисования)
 *   - outer: противоположная грань (на расстоянии thickness)
 *   - end-start, end-end: торцы стены
 *
 * Реальное помещение — это фейс, у которого рёбра преимущественно по
 * inner-граням (внутренние грани стен, замыкающие контур комнаты).
 * Внешний контур здания — наоборот, по outer-граням. Артефакты в углах
 * простенков и физические толщины стен (мёртвые зоны) — это фейсы,
 * у которых inner ≤ outer+торцы.
 */
function classifyFaceEdges(poly, vertices, edges) {
  const stats = { inner: 0, outer: 0, endStart: 0, endEnd: 0, unknown: 0 };
  for (let k = 0; k < poly.length; k++) {
    const a = poly[k], b = poly[(k + 1) % poly.length];
    // Найти вершины графа, соответствующие концам ребра
    const v1 = vertices.findIndex(v => Math.hypot(v.x - a.x, v.y - a.y) < 2);
    const v2 = vertices.findIndex(v => Math.hypot(v.x - b.x, v.y - b.y) < 2);
    if (v1 < 0 || v2 < 0) { stats.unknown++; continue; }
    const edge = edges.find(e => (e.v1 === v1 && e.v2 === v2) || (e.v1 === v2 && e.v2 === v1));
    if (!edge) { stats.unknown++; continue; }
    // Ребро может иметь несколько faceKinds (например inner+outer если
    // две разных стены лежат на одной линии). Учитываем все.
    for (const fk of (edge.faceKinds || [])) {
      if (fk === 'inner') stats.inner++;
      else if (fk === 'outer') stats.outer++;
      else if (fk === 'end-start') stats.endStart++;
      else if (fk === 'end-end') stats.endEnd++;
    }
  }
  return stats;
}

// ══════════════════════════════════════════════════════════════════
// ОСНОВНОЙ АЛГОРИТМ ПОИСКА КОМНАТ
// ══════════════════════════════════════════════════════════════════
export function computeRooms(wallHeightFallback = 2700) {
  appState.rooms = [];

  const walls = appState.walls;
  const dividers = appState.dividers || [];

  if (walls.length === 0 && dividers.length === 0) {
    EventBus.emit('rooms:computed');
    return;
  }

  // Разделители превращаем в "виртуальные стены" с нулевой толщиной.
  // Они участвуют в графе помещений (замыкают контуры), но не дают
  // площади стен и не вычитают площадь пола.
  const dividerWalls = dividers.map(d => ({
    id: `div_${d.id}`,
    x1: d.x1, y1: d.y1, x2: d.x2, y2: d.y2,
    cx1: d.x1, cy1: d.y1, cx2: d.x2, cy2: d.y2,
    thickness: 0,
    height: wallHeightFallback,
    offset: 'left',
    isDivider: true,
  }));

  const allWalls = [...walls, ...dividerWalls];
  if (allWalls.length < 3) {
    EventBus.emit('rooms:computed');
    return;
  }

  // 1. Строим граф по линиям рисования (cx/cy)
  const points = findAllIntersections(allWalls);
  if (points.length < 3) {
    EventBus.emit('rooms:computed');
    return;
  }

  const { vertices, edges } = buildWallGraph(allWalls, points);
  if (edges.length < 3) {
    EventBus.emit('rooms:computed');
    return;
  }

  // 1.5. ЧИСТКА ВИСЯЩИХ ХВОСТОВ.
  // Простенки, ниши, выступы — это легитимная геометрия. В графе они
  // выглядят как "хвосты": цепочки рёбер, ведущих к вершине степени 1
  // (конец стены, висящий в воздухе).
  //
  // Чтобы findFaces корректно нашёл замкнутый контур помещения, надо
  // временно удалить эти хвосты из графа. Удалённые стены потом учтутся
  // как interiorWalls помещения через clipWallAxisToPolygon — она найдёт
  // их геометрически как "стены внутри полигона комнаты".
  //
  // Алгоритм: итеративно удаляем рёбра при вершинах со степенью 1,
  // пока такие вершины ещё есть. Это срезает все хвосты целиком, не
  // трогая замкнутые циклы.
  const cleanEdges = pruneDanglingTails(vertices, edges);

  if (cleanEdges.length < 3) {
    EventBus.emit('rooms:computed');
    return;
  }

  // 2. Находим все грани в очищенном графе
  const faces = findFaces(vertices, cleanEdges);

  // Дедупликация фейсов: одинаковые полигоны (по центроиду + знаку площади)
  const dedupedFaces = [];
  const seenKeys = new Set();
  for (const face of faces) {
    const poly = face.map(v => ({ x: v.x, y: v.y }));
    const sArea = polygonSignedArea(poly);
    if (Math.abs(sArea) < 1) continue;
    const c = polygonCentroid(poly);
    const sign = sArea > 0 ? 'p' : 'n';
    const key = `${Math.round(c.x/10)}_${Math.round(c.y/10)}_${sign}`;
    if (seenKeys.has(key)) continue;
    seenKeys.add(key);
    dedupedFaces.push({ poly, sArea });
  }

  if (dedupedFaces.length === 0) {
    EventBus.emit('rooms:computed');
    return;
  }

  // 3. Внешний фейс — определяется по СОСТАВУ РЁБЕР, а не по bbox.
  //    Внешний контур здания по построению модели идёт по outer-граням
  //    стен (внешние грани, обращённые на улицу) и торцам. У него inner=0
  //    или очень мало.
  //
  //    Реальная комната, наоборот, имеет рёбра по inner-граням (внутренние
  //    грани стен, замыкающие контур помещения).
  //
  //    Правило: фейс — внешний ⇔ inner-рёбер строго меньше чем outer+торцов.
  //    Если фейсов с такой характеристикой несколько — берём тот с
  //    максимальной площадью (объемлющий внешний контур всего плана).
  let exteriorIndex = -1;
  let maxExteriorArea = -Infinity;
  const faceClassifications = dedupedFaces.map(f =>
    classifyFaceEdges(f.poly, vertices, cleanEdges)
  );
  for (let i = 0; i < dedupedFaces.length; i++) {
    const stats = faceClassifications[i];
    const otherCount = stats.outer + stats.endStart + stats.endEnd;
    if (stats.inner < otherCount) {
      const area = polygonArea(dedupedFaces[i].poly);
      if (area > maxExteriorArea) {
        maxExteriorArea = area;
        exteriorIndex = i;
      }
    }
  }
  // Fallback: если по составу не нашли (граф вырожденный) — берём по bbox
  if (exteriorIndex === -1) {
    exteriorIndex = 0;
    let maxBbox = -Infinity;
    for (let i = 0; i < dedupedFaces.length; i++) {
      const bb = polygonBboxArea(dedupedFaces[i].poly);
      if (bb > maxBbox) { maxBbox = bb; exteriorIndex = i; }
    }
  }

  // 4. Кандидаты в помещения — фейсы, у которых рёбра в основном по
  //    внутренним граням стен (inner). Фейсы по внешним граням и торцам —
  //    это либо внешний контур здания, либо мёртвые зоны (физические
  //    толщины стен), либо артефакты пересечения граней в углах.
  //
  //    Правило: фейс = комната ⇔ count(inner) > count(outer + torcy).
  //    Это математически чисто, не зависит от геометрических порогов
  //    и работает для любой формы и толщины стен.
  const roomCandidates = [];
  for (let i = 0; i < dedupedFaces.length; i++) {
    if (i === exteriorIndex) continue;
    const poly = dedupedFaces[i].poly;
    const area = polygonArea(poly);
    if (area < 50000) continue; // < 0.05 м² — мусорные фейсы

    const stats = faceClassifications[i];
    const innerCount = stats.inner;
    const otherCount = stats.outer + stats.endStart + stats.endEnd;
    if (innerCount <= otherCount) continue; // не комната, а артефакт/мёртвая зона

    roomCandidates.push({ poly, grossArea: area });
  }

  if (roomCandidates.length === 0) {
    EventBus.emit('rooms:computed');
    return;
  }

  // 5. Иерархия вложенности: для каждого кандидата находим родителя
  //    (помещение, внутри которого он лежит). Если родитель есть — это
  //    "помещение-в-помещении", и из родителя надо вычесть площадь дочернего.
  const parentIndex = new Array(roomCandidates.length).fill(-1);
  for (let i = 0; i < roomCandidates.length; i++) {
    const ci = polygonCentroid(roomCandidates[i].poly);
    let bestParent = -1;
    let bestParentArea = Infinity;
    for (let j = 0; j < roomCandidates.length; j++) {
      if (i === j) continue;
      if (isPointInPolygon(ci, roomCandidates[j].poly)) {
        // Берём наименьшего родителя (на случай тройной вложенности)
        if (roomCandidates[j].grossArea < bestParentArea) {
          bestParentArea = roomCandidates[j].grossArea;
          bestParent = j;
        }
      }
    }
    parentIndex[i] = bestParent;
  }

  // 6. Первый проход: собираем все комнаты с их boundary-данными.
  //    Окончательные метрики посчитаем во втором проходе, когда будем
  //    знать сколько комнат граничит с каждой стеной (внешняя или нет).
  const draftRooms = [];
  for (let i = 0; i < roomCandidates.length; i++) {
    const { poly, grossArea } = roomCandidates[i];

    const boundaryWallIds = new Set();
    const boundaryWallsList = [];
    let hasDividers = false;

    for (let k = 0; k < poly.length; k++) {
      const a = poly[k];
      const b = poly[(k + 1) % poly.length];
      const edgeWalls = findAllWallsForEdge(a.x, a.y, b.x, b.y, allWalls);
      for (const wall of edgeWalls) {
        if (wall.isDivider) {
          hasDividers = true;
        } else if (!boundaryWallIds.has(wall.id)) {
          boundaryWallIds.add(wall.id);
          boundaryWallsList.push(wall);
        }
      }
    }

    const interiorWalls = [];
    for (const w of walls) {
      if (boundaryWallIds.has(w.id)) continue;
      const clipped = clipWallAxisToPolygon(w, poly);
      let totalLen = 0;
      for (const seg of clipped) {
        totalLen += Math.hypot(seg.x2 - seg.x1, seg.y2 - seg.y1);
      }
      if (totalLen > 1) {
        interiorWalls.push({ wall: w, lengthMm: totalLen });
      }
    }

    draftRooms.push({
      candidateIndex: i,
      poly, grossArea,
      boundaryWallIds, boundaryWallsList,
      interiorWalls, hasDividers,
    });
  }

  // 7. Подсчёт: сколько комнат граничит с каждой стеной.
  //    Стена с counter == 1 → внешняя (с другой стороны улица/пустота).
  //    Стена с counter == 2 → межкомнатная (между двумя помещениями).
  const wallRoomCounter = new Map(); // wallId → число помещений
  for (const dr of draftRooms) {
    for (const wid of dr.boundaryWallIds) {
      wallRoomCounter.set(wid, (wallRoomCounter.get(wid) || 0) + 1);
    }
  }
  // exteriorWallIds = стены, граничащие ровно с одной комнатой
  exteriorWallIds = new Set();
  for (const [wid, count] of wallRoomCounter) {
    if (count === 1) exteriorWallIds.add(wid);
  }

  // 8. Второй проход: вычисляем окончательные метрики и создаём комнаты.
  for (const dr of draftRooms) {
    const { poly, grossArea, boundaryWallIds, boundaryWallsList,
            interiorWalls, hasDividers } = dr;

    // Чистая площадь пола = валовая
    //   − следы внутренних стен (висящих)
    //   − площади дочерних (вложенных) помещений
    //   + 1/2 площади проёмов в МЕЖКОМНАТНЫХ стенах (там пол есть на полную толщину)
    let netAreaMm2 = grossArea;
    for (const { wall, lengthMm } of interiorWalls) {
      netAreaMm2 -= wallFootprintArea(wall, lengthMm);
    }
    for (let j = 0; j < roomCandidates.length; j++) {
      if (parentIndex[j] === dr.candidateIndex) {
        netAreaMm2 -= roomCandidates[j].grossArea;
      }
    }
    // Доли проёмов в межкомнатных стенах: проём (ширина × толщина стены) — это
    // площадь пола, которая физически принадлежит обеим комнатам поровну.
    // На контур помещения (cx/cy) проём НЕ влияет, поэтому grossArea его не учитывает.
    // Прибавляем 1/2 этой площади к каждой из двух комнат.
    const roomOpenings = appState.openings.filter(op => boundaryWallIds.has(op.wallId));
    for (const op of roomOpenings) {
      if (op.type !== 'door') continue;
      const wall = boundaryWallsList.find(w => w.id === op.wallId);
      if (!wall) continue;
      const isInterior = !exteriorWallIds.has(op.wallId);
      if (isInterior) {
        // Межкомнатная дверь → +1/2 (ширина × толщина)
        netAreaMm2 += (op.width * (wall.thickness || 0)) / 2;
      }
      // Для входной двери (внешняя стена) — пол под проёмом считаем целиком
      // принадлежащим этой комнате (с другой стороны улица).
      else {
        netAreaMm2 += op.width * (wall.thickness || 0);
      }
    }

    if (netAreaMm2 < 10000) continue;

    // Высота помещения — взвешенная по длине граничных стен
    let totalLengthMm = 0;
    let weightedHeightSum = 0;
    for (const w of boundaryWallsList) {
      const len = wallFullLengthMm(w);
      const h = w.height || wallHeightFallback;
      totalLengthMm += len;
      weightedHeightSum += len * h;
    }
    const heightMm = totalLengthMm > 0 ? weightedHeightSum / totalLengthMm : wallHeightFallback;

    const entranceDoorId = detectEntranceDoor(roomOpenings, exteriorWallIds);

    const metrics = computeRoomMetrics({
      boundaryWalls: boundaryWallsList,
      interiorWalls,
      openings: roomOpenings,
      heightMm,
      polygon: poly,
      entranceDoorId,
      hasDividers,
      netAreaMm2,
      exteriorWallIds,
    });

    const key = generateRoomKey(poly);
    const defaultName = roomDefaultName(appState.rooms.length);
    const bbox = getBbox(poly);
    const center = polygonCentroid(poly);

    appState.rooms.push({
      key,
      polygon: poly,
      cells: [{ x1: bbox.minX, y1: bbox.minY, x2: bbox.maxX, y2: bbox.maxY }],
      boundarySegments: boundaryWallsList.map(w => ({
        orientation: Math.abs(w.y2 - w.y1) < Math.abs(w.x2 - w.x1) ? 'h' : 'v',
        x1: Math.min(w.x1, w.x2), y1: Math.min(w.y1, w.y2),
        x2: Math.max(w.x1, w.x2), y2: Math.max(w.y1, w.y2),
        length: Math.hypot(w.x2 - w.x1, w.y2 - w.y1),
        wall: w,
      })),
      center,
      defaultName,
      name: appState.roomNameOverrides[key] || defaultName,
      area: netAreaMm2 / 1e6,
      volume: netAreaMm2 * heightMm / 1e9,
      height: heightMm / 1000,
      perimeter: metrics.perimeterFloorM,
      wallArea: metrics.wallAreaNetM2,
      openingsArea: metrics.openingsAreaM2,
      metrics,
      wallIds: [...boundaryWallIds],
      // Висящие стены и простенки внутри помещения — для разметки в render.js
      // и других модулей. Каждая запись { wall, lengthMm }.
      interiorWalls,
    });
  }

  EventBus.emit('rooms:computed');
}

// ══════════════════════════════════════════════════════════════════
// МЕТРИКИ КОМНАТ
// ══════════════════════════════════════════════════════════════════
function round2(v) { return Math.round(v * 100) / 100; }

function wallStart(w) { return { x: w.cx1 ?? w.x1, y: w.cy1 ?? w.y1 }; }
function wallEnd(w)   { return { x: w.cx2 ?? w.x2, y: w.cy2 ?? w.y2 }; }

function wallFullLengthMm(w) {
  const s = wallStart(w), e = wallEnd(w);
  return Math.hypot(e.x - s.x, e.y - s.y);
}

/**
 * Длина граничной стены, относящаяся к данному помещению.
 *
 * Если в стену упираются разделители или другие стены (T-стыки изнутри),
 * стена логически нарезается на сегменты, и к этому помещению относится
 * только та часть оси, которая лежит вдоль рёбер полигона.
 *
 * Технически — суммируем длины рёбер полигона, для которых данная стена
 * входит в findAllWallsForEdge.
 */
function wallLengthInRoomMm(w, polygon, allWalls) {
  let total = 0;
  for (let k = 0; k < polygon.length; k++) {
    const a = polygon[k], b = polygon[(k + 1) % polygon.length];
    const edgeWalls = findAllWallsForEdge(a.x, a.y, b.x, b.y, allWalls);
    if (edgeWalls.some(ew => ew.id === w.id)) {
      total += Math.hypot(b.x - a.x, b.y - a.y);
    }
  }
  return total;
}

function buildWallSegments(walls, openings, polygon, allWallsForEdge) {
  return walls.map(wall => {
    const lenMm = wallLengthInRoomMm(wall, polygon, allWallsForEdge);
    if (lenMm < 1) return { wall, segments: [], totalLenMm: 0 };

    // Для проёмов нужна позиция вдоль ВСЕЙ стены (op.t × wallFullLength),
    // а сегмент в комнате — только часть оси. Чтобы корректно учесть проёмы,
    // нужно знать, где в комнате начинается и заканчивается стена. Пока что
    // упрощённо: считаем что все проёмы стены попадают в этот сегмент,
    // если она граничная для комнаты. Это работает для типичного случая
    // (одна стена = одна комната с одной стороны).
    const fullLen = wallFullLengthMm(wall);
    const wallOps = openings
      .filter(op => op.wallId === wall.id)
      .map(op => ({
        startMm: Math.max(0, (op.t * fullLen) - op.width / 2),
        endMm:   Math.min(fullLen, (op.t * fullLen) + op.width / 2),
        op,
      }))
      .filter(op => op.endMm > op.startMm)
      .sort((a, b) => a.startMm - b.startMm);

    // Сегменты заполнения (между проёмами) ОТ ВСЕЙ стены —
    // используется для подсчёта погонажа узких простенков
    const segments = [];
    let cursor = 0;
    for (const op of wallOps) {
      if (op.startMm > cursor + 0.5) {
        segments.push({ startMm: cursor, endMm: op.startMm, widthMm: op.startMm - cursor });
      }
      cursor = Math.max(cursor, op.endMm);
    }
    if (cursor < fullLen - 0.5) {
      segments.push({ startMm: cursor, endMm: fullLen, widthMm: fullLen - cursor });
    }

    return { wall, segments, totalLenMm: lenMm, fullLenMm: fullLen };
  });
}

function computeCornerStats(polygon) {
  const n = polygon.length;
  if (n < 3) return { inner: 0, outer: 0 };
  let inner = 0, outer = 0;

  // Знаковая площадь определяет направление обхода
  let signedArea = 0;
  for (let i = 0; i < n; i++) {
    const a = polygon[i], b = polygon[(i + 1) % n];
    signedArea += a.x * b.y - b.x * a.y;
  }

  for (let i = 0; i < n; i++) {
    const prev = polygon[(i - 1 + n) % n];
    const curr = polygon[i];
    const next = polygon[(i + 1) % n];
    const dx1 = curr.x - prev.x, dy1 = curr.y - prev.y;
    const dx2 = next.x - curr.x, dy2 = next.y - curr.y;
    const cross = dx1 * dy2 - dy1 * dx2;
    if (Math.abs(cross) < 0.001) continue;
    // Внутренний угол если поворот совпадает с направлением обхода
    const isInterior = signedArea < 0 ? cross < 0 : cross > 0;
    if (isInterior) inner++; else outer++;
  }
  return { inner, outer };
}

function computeRoomMetrics({
  boundaryWalls, interiorWalls, openings, heightMm, polygon,
  entranceDoorId, hasDividers, netAreaMm2,
}) {
  const heightM = heightMm / 1000;

  // Периметр комнаты — по полигону (это контур по cx/cy = внутренние грани)
  let perimeterMm = 0;
  for (let i = 0; i < polygon.length; i++) {
    const a = polygon[i], b = polygon[(i + 1) % polygon.length];
    perimeterMm += Math.hypot(b.x - a.x, b.y - a.y);
  }

  // Площадь стен помещения (gross) = сумма (длина в комнате × высота)
  // только для граничных стен (разделители не считаются — у них нет толщины
  // и нет физических стен).
  let wallAreaGrossM2 = 0;
  let narrowWallsLm = 0;

  // Если есть разделители — длина стены в комнате = wallLengthInRoomMm.
  // Иначе — полная длина стены (стандартный случай).
  const allWallsForEdge = [...boundaryWalls];

  let openingsAreaM2 = 0;
  let perimeterDeductMm = 0;
  let windowAreaM2 = 0, windowCount = 0, windowRevealsLm = 0;
  let entranceDoorAreaM2 = 0;

  for (const w of boundaryWalls) {
    const lenMm = hasDividers
      ? wallLengthInRoomMm(w, polygon, allWallsForEdge)
      : wallFullLengthMm(w);
    const lenM = lenMm / 1000;
    wallAreaGrossM2 += lenM * heightM;
  }

  // Висящие перегородки — добавляют площадь стен с двух сторон + торцы
  for (const { wall, lengthMm } of interiorWalls) {
    const lenM = lengthMm / 1000;
    const thickM = (wall.thickness || 0) / 1000;
    // Две длинные стороны
    wallAreaGrossM2 += 2 * lenM * heightM;
    // Торцы (если стена висящая — оба, если врезана одним концом — один)
    // Упрощённо: считаем оба торца. Для T-стыка где торец стыкуется со
    // стеной, его площадь обычно мала и в реальной отделке учитывается
    // отдельно. Можно уточнить позже при необходимости.
    wallAreaGrossM2 += 2 * thickM * heightM;
  }

  // Проёмы — считаются только в граничных стенах
  for (const op of openings) {
    const opArea = (op.width * op.height) / 1e6;
    openingsAreaM2 += opArea;

    if (op.type === 'door') {
      perimeterDeductMm += op.width;
      if (op.id === entranceDoorId) entranceDoorAreaM2 = opArea;
    } else if (op.type === 'window') {
      if (op.height >= heightMm * 0.95) perimeterDeductMm += op.width;
      windowAreaM2 += opArea;
      windowRevealsLm += (op.width + 2 * op.height) / 1000;
      windowCount++;
    }
  }

  // Узкие простенки — простенки между проёмами шириной < 500 мм
  for (const w of boundaryWalls) {
    const fullLen = wallFullLengthMm(w);
    const wallOps = openings
      .filter(op => op.wallId === w.id)
      .map(op => ({
        startMm: Math.max(0, (op.t * fullLen) - op.width / 2),
        endMm:   Math.min(fullLen, (op.t * fullLen) + op.width / 2),
      }))
      .filter(op => op.endMm > op.startMm)
      .sort((a, b) => a.startMm - b.startMm);
    let cursor = 0;
    for (const op of wallOps) {
      if (op.startMm > cursor + 0.5) {
        const gap = op.startMm - cursor;
        if (gap < 500) narrowWallsLm += heightM;
      }
      cursor = Math.max(cursor, op.endMm);
    }
    if (cursor < fullLen - 0.5) {
      const gap = fullLen - cursor;
      if (gap < 500) narrowWallsLm += heightM;
    }
  }

  const wallAreaNetM2 = Math.max(0, wallAreaGrossM2 - openingsAreaM2);
  const perimeterFloorM = Math.max(0, perimeterMm - perimeterDeductMm) / 1000;
  const cornerStats = computeCornerStats(polygon);

  const wallOuterCornersLm = round2(cornerStats.outer * heightM);
  let revealCornersLm = 0;
  for (const op of openings) {
    if (op.type === 'window') revealCornersLm += 2 * op.height / 1000;
  }
  const outerAnglesLm = round2(wallOuterCornersLm + revealCornersLm);
  const pogonazLm = round2(narrowWallsLm + windowRevealsLm);

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

function detectEntranceDoor(openings, exteriorWallIds) {
  for (const op of openings) {
    if (op.type === 'door' && exteriorWallIds.has(op.wallId)) return op.id;
  }
  return null;
}

// ══════════════════════════════════════════════════════════════════
// ВСПОМОГАТЕЛЬНЫЕ
// ══════════════════════════════════════════════════════════════════
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

// ══════════════════════════════════════════════════════════════════
// DOM И ЭКСПОРТ
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

// Экспорт для инструмента RoomTool – создаёт комнату по одному полигону
export function computeRoomForPolygon(poly) {
  const walls = appState.walls;
  const dividers = appState.dividers || [];
  const wallHeightFallback = _wallHeightFallback;

  const dividerWalls = dividers.map(d => ({
    id: `div_${d.id}`,
    x1: d.x1, y1: d.y1, x2: d.x2, y2: d.y2,
    cx1: d.x1, cy1: d.y1, cx2: d.x2, cy2: d.y2,
    thickness: 0,
    height: wallHeightFallback,
    offset: 'left',
    isDivider: true,
  }));

  const allWalls = [...walls, ...dividerWalls];
  const boundaryWallIds = new Set();
  const boundaryWallsList = [];
  let hasDividers = false;

  // 1. Определяем граничные стены (те, что лежат на рёбрах полигона)
  for (let k = 0; k < poly.length; k++) {
    const a = poly[k];
    const b = poly[(k + 1) % poly.length];
    const edgeWalls = findAllWallsForEdge(a.x, a.y, b.x, b.y, allWalls);
    for (const w of edgeWalls) {
      if (w.isDivider) {
        hasDividers = true;
      } else if (!boundaryWallIds.has(w.id)) {
        boundaryWallIds.add(w.id);
        boundaryWallsList.push(w);
      }
    }
  }

  // 2. Внутренние стены (висящие, но не входящие в boundary)
  const interiorWalls = [];
  for (const w of walls) {
    if (boundaryWallIds.has(w.id)) continue;
    const clipped = clipWallAxisToPolygon(w, poly);
    let totalLen = 0;
    for (const seg of clipped) {
      totalLen += Math.hypot(seg.x2 - seg.x1, seg.y2 - seg.y1);
    }
    if (totalLen > 1) {
      interiorWalls.push({ wall: w, lengthMm: totalLen });
    }
  }

  // 3. Площади и проёмы
  let grossArea = polygonArea(poly);
  let netAreaMm2 = grossArea;

  for (const { wall, lengthMm } of interiorWalls) {
    netAreaMm2 -= wallFootprintArea(wall, lengthMm);
  }

  const roomOpenings = appState.openings.filter(op => boundaryWallIds.has(op.wallId));
  for (const op of roomOpenings) {
    if (op.type !== 'door') continue;
    const wall = boundaryWallsList.find(w => w.id === op.wallId);
    if (!wall) continue;
    const isInterior = !exteriorWallIds.has(op.wallId);   // внешние стены определяются позже
    if (isInterior) {
      netAreaMm2 += (op.width * (wall.thickness || 0)) / 2;
    } else {
      netAreaMm2 += op.width * (wall.thickness || 0);
    }
  }

  if (netAreaMm2 < 10000) return null;   // меньше 0.01 м² – не комната

  // 4. Высота (средняя по граничным стенам)
  let totalLengthMm = 0, weightedHeightSum = 0;
  for (const w of boundaryWallsList) {
    const len = wallFullLengthMm(w);
    const h = w.height || wallHeightFallback;
    totalLengthMm += len;
    weightedHeightSum += len * h;
  }
  const heightMm = totalLengthMm > 0 ? weightedHeightSum / totalLengthMm : wallHeightFallback;

  const entranceDoorId = detectEntranceDoor(roomOpenings, exteriorWallIds);

  const metrics = computeRoomMetrics({
    boundaryWalls: boundaryWallsList,
    interiorWalls,
    openings: roomOpenings,
    heightMm,
    polygon: poly,
    entranceDoorId,
    hasDividers,
    netAreaMm2,
    exteriorWallIds,
  });

  const key = generateRoomKey(poly);
  const defaultName = roomDefaultName(appState.rooms.length);
  const bbox = getBbox(poly);
  const center = polygonCentroid(poly);

  return {
    key,
    polygon: poly,
    cells: [{ x1: bbox.minX, y1: bbox.minY, x2: bbox.maxX, y2: bbox.maxY }],
    boundarySegments: boundaryWallsList.map(w => ({
      orientation: Math.abs(w.y2 - w.y1) < Math.abs(w.x2 - w.x1) ? 'h' : 'v',
      x1: Math.min(w.x1, w.x2), y1: Math.min(w.y1, w.y2),
      x2: Math.max(w.x1, w.x2), y2: Math.max(w.y1, w.y2),
      length: Math.hypot(w.x2 - w.x1, w.y2 - w.y1),
      wall: w,
    })),
    center,
    defaultName,
    name: appState.roomNameOverrides[key] || defaultName,
    area: netAreaMm2 / 1e6,
    volume: netAreaMm2 * heightMm / 1e9,
    height: heightMm / 1000,
    perimeter: metrics.perimeterFloorM,
    wallArea: metrics.wallAreaNetM2,
    openingsArea: metrics.openingsAreaM2,
    metrics,
    wallIds: [...boundaryWallIds],
    interiorWalls,
  };
}

// Проверяет существующие комнаты и удаляет те, чей контур больше не существует
function purgeInvalidRooms() {
  const walls = appState.walls;
  const dividers = appState.dividers || [];

  // Строим граф как в RoomTool: только оси стен + разделители
  const slimWalls = walls.map(w => ({
    id: w.id,
    x1: w.x1, y1: w.y1, x2: w.x2, y2: w.y2,
    cx1: w.cx1 ?? w.x1, cy1: w.cy1 ?? w.y1,
    cx2: w.cx2 ?? w.x2, cy2: w.cy2 ?? w.y2,
    thickness: 0,
    height: w.height || 2700,
    offset: 'left',
    isDivider: false,
  }));
  const dividerWalls = dividers.map(d => ({
    id: `div_${d.id}`,
    x1: d.x1, y1: d.y1, x2: d.x2, y2: d.y2,
    cx1: d.x1, cy1: d.y1, cx2: d.x2, cy2: d.y2,
    thickness: 0,
    height: 2700,
    offset: 'left',
    isDivider: true,
  }));
  const allWalls = [...slimWalls, ...dividerWalls];
  if (allWalls.length < 3) {
    // Если стен мало, удаляем все комнаты
    if (appState.rooms.length) {
      appState.rooms = [];
      EventBus.emit('rooms:computed');
    }
    return;
  }

  try {
    const points = findAllIntersections(allWalls);
    if (!points || points.length < 3) {
      appState.rooms = [];
      EventBus.emit('rooms:computed');
      return;
    }
    const { vertices, edges } = buildWallGraph(allWalls, points);
    if (edges.length < 3) {
      appState.rooms = [];
      EventBus.emit('rooms:computed');
      return;
    }
    const faces = findFaces(vertices, edges);
    const validKeys = new Set();

    for (const face of faces) {
      const poly = face.map(v => ({ x: v.x, y: v.y }));
      if (polygonArea(poly) < 50000) continue;
      // Генерируем ключ и добавляем в множество существующих полигонов
      const key = generateRoomKey(poly);
      validKeys.add(key);
    }

    // Оставляем только комнаты, чей ключ есть среди найденных фейсов
    const previousCount = appState.rooms.length;
    appState.rooms = appState.rooms.filter(room => validKeys.has(room.key));
    if (appState.rooms.length !== previousCount) {
      EventBus.emit('rooms:computed');
    }
  } catch (e) {
    // Если граф не строится, не трогаем комнаты
  }
}

let debounceTimer = null;
const DEBOUNCE_MS = 20;

EventBus.on('walls:changed', () => {
  if (debounceTimer) clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => {
    purgeInvalidRooms();
    debounceTimer = null;
  }, DEBOUNCE_MS);
});

EventBus.on('dividers:changed', () => {
  if (debounceTimer) clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => {
    purgeInvalidRooms();
    debounceTimer = null;
  }, DEBOUNCE_MS);
});
