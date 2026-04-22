// ─── SelectTool.js ────────────────────────────────────────────────
import { BaseTool } from './BaseTool.js';
import { appState } from '../state.js';
import { executeCommand } from '../commands/CommandHistory.js';
import { BaseCommand } from '../commands/BaseCommand.js';
import { DeleteItemsCommand } from '../commands/DeleteItemsCommand.js';
import { UpdateWallCommand } from '../commands/UpdateWallCommand.js';
import { MoveWallsCommand } from '../commands/MoveWallsCommand.js';
import {
  snap, toScreen, toWorld,
  getSnappedWallResizePoint, findObjectSnapCandidate,
} from '../snapping.js';
import {
  getWallContourPoint, updateWallGeometry, getWallLength,
  invalidateJointCache,
} from '../wall.js';
import { hitTestWallResizeHandle, getOpeningScreenBounds } from '../render.js';
import { EventBus } from '../eventBus.js';

function distanceToSegment(px, py, x1, y1, x2, y2) {
  const dx = x2 - x1, dy = y2 - y1;
  const len2 = dx*dx + dy*dy;
  if (len2 === 0) return Math.hypot(px - x1, py - y1);
  let t = ((px - x1) * dx + (py - y1) * dy) / len2;
  t = Math.max(0, Math.min(1, t));
  const projX = x1 + t * dx, projY = y1 + t * dy;
  return Math.hypot(px - projX, py - projY);
}

function inflateBounds(bounds, pad) {
  return {
    left: bounds.left - pad,
    top: bounds.top - pad,
    right: bounds.right + pad,
    bottom: bounds.bottom + pad,
  };
}

function isBoundsInside(inner, outer, eps = 0) {
  return inner.left >= outer.left - eps &&
         inner.top >= outer.top - eps &&
         inner.right <= outer.right + eps &&
         inner.bottom <= outer.bottom + eps;
}

function lineBounds(p1, p2, pad = 0) {
  return {
    left: Math.min(p1.x, p2.x) - pad,
    top: Math.min(p1.y, p2.y) - pad,
    right: Math.max(p1.x, p2.x) + pad,
    bottom: Math.max(p1.y, p2.y) + pad,
  };
}

function screenPointToBounds(p) {
  return { left: p.x, top: p.y, right: p.x, bottom: p.y };
}

function boundsIntersect(a, b) {
  return !(a.right < b.left || a.left > b.right || a.bottom < b.top || a.top > b.bottom);
}

export class SelectTool extends BaseTool {
  constructor(ui) {
    super(ui);
    this.name = 'select';
    
    // Локальное состояние инструмента
    this.dragState = null;          // { startWorld, lastWorld, wallSnapshots }
    this.wallResizeState = null;    // { wallId, endpoint, fixedPoint, changed, geomBefore }
    this.selectBoxStart = null;
    this.selectBoxCurrent = null;
    this.selectClickCandidate = null;
    this.hoverItem = null;
    this.dragMeasureState = null;   // { measureId, startOffset, startWorld, measure }
  }

  activate() {
    this.reset();
    this.ui.canvas.style.cursor = 'default';
  }

  deactivate() {
    this.reset();
  }

  reset() {
    this.dragState = null;
    this.wallResizeState = null;
    this.selectBoxStart = null;
    this.selectBoxCurrent = null;
    this.selectClickCandidate = null;
    this.hoverItem = null;
    this.dragMeasureState = null;
  }

  getCursor() {
    return 'default';
  }

  getRenderState() {
    return {
      selectBoxStart: this.selectBoxStart,
      selectBoxCurrent: this.selectBoxCurrent,
      hoverItem: this.hoverItem,
    };
  }

  onMouseDown(pos, world, e) {
    // Проверка: не тянем ли маркер размера
    const selectedMeasure = this.ui.selectedItems.length === 1 && this.ui.selectedItems[0].type === 'measure'
      ? appState.measures.find(m => m.id === this.ui.selectedItems[0].id)
      : null;
    if (selectedMeasure && this.hitTestMeasureMarker(selectedMeasure, world, pos, 12)) {
      this.dragMeasureState = {
        measureId: selectedMeasure.id,
        startOffset: selectedMeasure.offset || 0,
        startWorld: { x: world.x, y: world.y },
        measure: selectedMeasure
      };
      this.ui.canvas.style.cursor = 'grabbing';
      this.ui.doRedraw();
      return true;
    }

    const handle = hitTestWallResizeHandle(pos, this.ui.tool, this.ui.selectedItems);
    if (handle) {
      this.wallResizeState = {
        wallId:    handle.wall.id,
        endpoint:  handle.endpoint,
        fixedPoint: getWallContourPoint(handle.wall, handle.endpoint === 'start' ? 'end' : 'start'),
        changed:   false,
        geomBefore: BaseCommand.snapWall(handle.wall),
      };
      this.ui.canvas.style.cursor = 'grabbing';
      this.ui.doRedraw();
      return true;
    }

    const hit = this.hitTestObject(world.x, world.y, pos);
    if (hit) {
      const isSelected = this.ui.selectedItems.some(i => i.type === hit.type && i.id === hit.id);
      if (isSelected && this.ui.selectedItems.length > 0) {
        // Подготовка к перетаскиванию
        const seedIds = this.ui.selectedItems.filter(i => i.type === 'wall').map(i => i.id);
        if (seedIds.length) {
          const connectedIds = this.getTopologicallyConnected(seedIds);
          const wallSnapshots = [...connectedIds].map(id => {
            const w = appState.walls.find(v => v.id === id);
            return w ? BaseCommand.snapWallPos(w) : null;
          }).filter(Boolean);
          if (wallSnapshots.length) {
            this.dragState = {
              startWorld: { x: world.x, y: world.y },
              lastWorld: { x: world.x, y: world.y },
              wallSnapshots,
            };
            this.ui.canvas.style.cursor = 'grabbing';
            return true;
          }
        }
      }
      this.selectClickCandidate = hit;
    } else {
      if (!this.ui.shiftDown) {
        this.ui.clearSelection();
        this.reset();
      }  
      this.selectClickCandidate = null;
      this.selectBoxStart = { x: pos.x, y: pos.y };
      this.selectBoxCurrent = { x: pos.x, y: pos.y };
      this.ui.doRedraw();
    }
    return false;
  }

  onMouseMove(pos, world, e) {
    // Перетаскивание размера
    if (this.dragMeasureState) {
      const m = this.dragMeasureState.measure;
      const segVec = { x: m.x2 - m.x1, y: m.y2 - m.y1 };
      const len = Math.hypot(segVec.x, segVec.y);
      if (len > 1) {
        const perpX = -segVec.y / len;
        const perpY = segVec.x / len;
        const mid = { x: (m.x1 + m.x2) / 2, y: (m.y1 + m.y2) / 2 };
        const toMouse = { x: world.x - mid.x, y: world.y - mid.y };
        const newOffset = toMouse.x * perpX + toMouse.y * perpY;
        m.offset = newOffset;
      }
      this.ui.doRedraw();
      return true;
    }

    // Изменение размера стены
    if (this.wallResizeState) {
      const wall = appState.walls.find(w => w.id === this.wallResizeState.wallId);
      if (!wall) {
        this.wallResizeState = null;
        this.ui.doRedraw();
        return true;
      }
      const moved = getSnappedWallResizePoint(
        this.wallResizeState.fixedPoint, world, pos, this.ui.shiftDown
      );
      const ns = this.wallResizeState.endpoint === 'start' ? moved : this.wallResizeState.fixedPoint;
      const ne = this.wallResizeState.endpoint === 'start' ? this.wallResizeState.fixedPoint : moved;
      if (Math.hypot(ne.x - ns.x, ne.y - ns.y) >= 1) {
        const changed = updateWallGeometry(wall, ns, ne, {
          preserveFrom: this.wallResizeState.endpoint === 'start' ? 'end' : 'start'
        });
        this.wallResizeState.changed = this.wallResizeState.changed || changed;
        this.ui.debouncedComputeRooms();
      }
      this.ui.canvas.style.cursor = 'grabbing';
      this.ui.doRedraw();
      return true;
    }

    // Перетаскивание группы стен
    if (this.dragState) {
      for (const snap of this.dragState.wallSnapshots) {
        const wall = appState.walls.find(w => w.id === snap.id);
        if (!wall) continue;
        const ddx = world.x - this.dragState.startWorld.x;
        const ddy = world.y - this.dragState.startWorld.y;
        wall.cx1 = snap.cx1 + ddx; wall.cy1 = snap.cy1 + ddy;
        wall.cx2 = snap.cx2 + ddx; wall.cy2 = snap.cy2 + ddy;
        wall.x1  = snap.x1  + ddx; wall.y1  = snap.y1  + ddy;
        wall.x2  = snap.x2  + ddx; wall.y2  = snap.y2  + ddy;
      }
      invalidateJointCache();
      this.ui.canvas.style.cursor = 'grabbing';
      this.ui.doRedraw();
      return true;
    }

    // Обновление hover при движении
    if (!this.selectBoxStart && !this.wallResizeState && !this.dragState && !this.dragMeasureState) {
      const hit = this.hitTestObject(world.x, world.y, pos);
      if (hit?.type !== this.hoverItem?.type || hit?.id !== this.hoverItem?.id) {
        this.hoverItem = hit;
        this.ui.doRedraw();
      }
    } else {
      if (this.hoverItem) {
        this.hoverItem = null;
        this.ui.doRedraw();
      }
    }

    // Рамка выделения
    if (this.selectBoxStart) {
      this.selectBoxCurrent = { x: pos.x, y: pos.y };
      this.ui.doRedraw();
      return true;
    }

    return false;
  }

  onMouseUp(pos, world, e) {
    // Завершение перетаскивания размера
    if (this.dragMeasureState) {
      const { measureId, startOffset } = this.dragMeasureState;
      const measure = appState.measures.find(m => m.id === measureId);
      if (measure && Math.abs((measure.offset || 0) - startOffset) > 0.1) {
        EventBus.emit('measures:changed');
      }
      this.dragMeasureState = null;
      this.ui.canvas.style.cursor = 'default';
      this.ui.doRedraw();
      return true;
    }

    // Завершение drag перемещения стен
    if (this.dragState) {
      const moved = this.dragState.wallSnapshots.some(snap => {
        const wall = appState.walls.find(w => w.id === snap.id);
        return wall && (Math.abs(wall.x1 - snap.x1) > 2 || Math.abs(wall.y1 - snap.y1) > 2);
      });
      if (moved) {
        const afterPositions = this.dragState.wallSnapshots.map(snap => {
          const wall = appState.walls.find(w => w.id === snap.id);
          return wall ? BaseCommand.snapWallPos(wall) : null;
        }).filter(Boolean);
        executeCommand(new MoveWallsCommand(this.dragState.wallSnapshots, afterPositions));
      }
      this.dragState = null;
      this.ui.canvas.style.cursor = 'default';
      this.ui.doRedraw();
      return true;
    }

    // Завершение resize стены
    if (this.wallResizeState) {
      const shouldRecord = this.wallResizeState.changed;
      if (shouldRecord) {
        const wall = appState.walls.find(w => w.id === this.wallResizeState.wallId);
        if (wall) {
          executeCommand(new UpdateWallCommand(
            wall.id,
            this.wallResizeState.geomBefore,
            BaseCommand.snapWall(wall),
            'Изменение размера стены'
          ));
        }
      }
      this.wallResizeState = null;
      this.ui.canvas.style.cursor = 'default';
      this.ui.doRedraw();
      return true;
    }

    // Выделение кликом
    if (this.selectClickCandidate) {
      const hit = this.selectClickCandidate;
      this.selectClickCandidate = null;
      if (this.ui.shiftDown) {
        this.ui.toggleSelection(hit.type, hit.id);
      } else {
        this.ui.selectObject(hit.type, hit.id);
      }
      this.ui.doRedraw();
      return true;
    }

    // Выделение рамкой
    if (this.selectBoxStart) {
      const box = {
        left: Math.min(this.selectBoxStart.x, this.selectBoxCurrent.x),
        top: Math.min(this.selectBoxStart.y, this.selectBoxCurrent.y),
        right: Math.max(this.selectBoxStart.x, this.selectBoxCurrent.x),
        bottom: Math.max(this.selectBoxStart.y, this.selectBoxCurrent.y),
      };
      if ((box.right - box.left) > 5 && (box.bottom - box.top) > 5) {
  const items = [];
  const pxScale = Math.abs(toScreen(1, 0).x - toScreen(0, 0).x) || 0.12;
  const wallPadPx = 6;

  for (const wall of appState.walls) {
    const s1 = toScreen(wall.x1, wall.y1);
    const s2 = toScreen(wall.x2, wall.y2);
    const halfTpx = Math.max(2, (wall.thickness * pxScale) / 2) + wallPadPx;
    const wb = {
      left: Math.min(s1.x, s2.x) - halfTpx,
      right: Math.max(s1.x, s2.x) + halfTpx,
      top: Math.min(s1.y, s2.y) - halfTpx,
      bottom: Math.max(s1.y, s2.y) + halfTpx,
    };
    if (boundsIntersect(wb, box)) items.push({ type: 'wall', id: wall.id });
  }
  for (const op of appState.openings) {
    const ob = getOpeningScreenBounds(op);
    if (ob && boundsIntersect(ob, box)) items.push({ type: 'opening', id: op.id });
  }
  for (const m of (appState.measures || [])) {
    const p1 = toScreen(m.x1, m.y1);
    const p2 = toScreen(m.x2, m.y2);
    const mb = lineBounds(p1, p2, 6);
    if (boundsIntersect(mb, box)) items.push({ type: 'measure', id: m.id });
  }
  for (const d of (appState.dividers || [])) {
    const p1 = toScreen(d.x1, d.y1);
    const p2 = toScreen(d.x2, d.y2);
    const db = lineBounds(p1, p2, 8);
    if (boundsIntersect(db, box)) items.push({ type: 'divider', id: d.id });
  }
  ...
}

    return false;
  }

  onKeyDown(e) {
    if (e.key === 'Delete' || e.key === 'Backspace') {
      const items = this.ui.selectedItems;
      if (items && items.length) {
        executeCommand(new DeleteItemsCommand(items));
        this.ui.clearSelection();
        this.ui.doRedraw();
        e.preventDefault();
        return true;
      }
    }
    if (e.key === 'Escape') {
      this.ui.clearSelection();
      this.reset();
      this.ui.doRedraw();
      return true;
    }
    return false;
  }

  // Вспомогательные методы
  hitTestObject(wx, wy, screenPoint) {
    if (!screenPoint) return null;

    const MEASURE_HIT_PX = 12;
    const DIVIDER_HIT_PX = 12;
    const OPENING_HIT_PAD_PX = 10;
    const WALL_HIT_PX = 12;
    const pxScale = Math.abs(toScreen(1, 0).x - toScreen(0, 0).x) || 0.12;

    for (const m of (appState.measures || [])) {
      const p1 = toScreen(m.x1, m.y1);
      const p2 = toScreen(m.x2, m.y2);
      const dist = distanceToSegment(screenPoint.x, screenPoint.y, p1.x, p1.y, p2.x, p2.y);
      if (dist <= MEASURE_HIT_PX) return { type: 'measure', id: m.id };
    }

    for (const d of (appState.dividers || [])) {
      const p1 = toScreen(d.x1, d.y1);
      const p2 = toScreen(d.x2, d.y2);
      const dist = distanceToSegment(screenPoint.x, screenPoint.y, p1.x, p1.y, p2.x, p2.y);
      if (dist <= DIVIDER_HIT_PX) return { type: 'divider', id: d.id };
    }

    for (const op of (appState.openings || [])) {
      const bounds = getOpeningScreenBounds(op);
      if (!bounds) continue;
      if (isBoundsInside(screenPointToBounds(screenPoint), inflateBounds(bounds, OPENING_HIT_PAD_PX))) {
        return { type: 'opening', id: op.id };
      }
    }

    let bestWall = null;
    let bestScore = WALL_HIT_PX;
    for (const wall of appState.walls) {
      const s1 = toScreen(wall.cx1 ?? wall.x1, wall.cy1 ?? wall.y1);
      const s2 = toScreen(wall.cx2 ?? wall.x2, wall.cy2 ?? wall.y2);
      const distPx = distanceToSegment(screenPoint.x, screenPoint.y, s1.x, s1.y, s2.x, s2.y);
      const halfTpx = Math.max(2, (wall.thickness * pxScale) / 2);
      const score = distPx - halfTpx;
      if (score < bestScore) {
        bestScore = score;
        bestWall = wall;
      }
    }
    if (bestWall) return { type: 'wall', id: bestWall.id };

    return null;
  }

  hitTestMeasureMarker(measure, worldPoint, screenPoint, tolerancePx = 10) {
    if (!measure) return false;
    const { x1, y1, x2, y2, offset = 0 } = measure;
    const segVec = { x: x2 - x1, y: y2 - y1 };
    const len = Math.hypot(segVec.x, segVec.y);
    if (len < 1) return false;
    const perpX = -segVec.y / len;
    const perpY = segVec.x / len;
    const mid = { x: (x1 + x2) / 2, y: (y1 + y2) / 2 };
    const markerWorld = {
      x: mid.x + perpX * offset,
      y: mid.y + perpY * offset
    };
    const screenMarker = toScreen(markerWorld.x, markerWorld.y);
    const dist = Math.hypot(screenPoint.x - screenMarker.x, screenPoint.y - screenMarker.y);
    return dist <= tolerancePx;
  }
  
  getTopologicallyConnected(seedWallIds) {
    const SNAP = 2;
    const visited = new Set(seedWallIds);
    const queue = [...seedWallIds];
    while (queue.length) {
      const id = queue.shift();
      const wall = appState.walls.find(w => w.id === id);
      if (!wall) continue;
      const myPts = [
        { x: wall.cx1 ?? wall.x1, y: wall.cy1 ?? wall.y1 },
        { x: wall.cx2 ?? wall.x2, y: wall.cy2 ?? wall.y2 },
      ];
      for (const other of appState.walls) {
        if (visited.has(other.id)) continue;
        const otherPts = [
          { x: other.cx1 ?? other.x1, y: other.cy1 ?? other.y1 },
          { x: other.cx2 ?? other.x2, y: other.cy2 ?? other.y2 },
        ];
        const connected = myPts.some(mp => otherPts.some(op =>
          Math.hypot(mp.x - op.x, mp.y - op.y) <= SNAP
        ));
        if (connected) {
          visited.add(other.id);
          queue.push(other.id);
        }
      }
    }
    return visited;
  }
}
