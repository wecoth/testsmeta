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
  invalidateJointCache, findClosestWallSel,
} from '../wall.js';
import { findClosestOpening } from '../opening.js';
import { hitTestWallResizeHandle, getOpeningScreenBounds, boundsIntersect } from '../render.js';

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

    const hit = this.hitTestObject(world.x, world.y);
    if (hit) {
      const isSelected = this.ui.selectedItems.some(i => i.type === hit.type && i.id === hit.id);
      if (isSelected && this.ui.selectedItems.length > 0) {
        // Подготовка к перетаскиванию
        const seedIds = this.ui.selectedItems.filter(i => i.type === 'wall').map(i => i.id);
        const connectedIds = this.getTopologicallyConnected(seedIds);
        const wallSnapshots = [...connectedIds].map(id => {
          const w = appState.walls.find(v => v.id === id);
          return w ? BaseCommand.snapWallPos(w) : null;
        }).filter(Boolean);
        this.dragState = {
          startWorld: { x: world.x, y: world.y },
          lastWorld: { x: world.x, y: world.y },
          wallSnapshots,
        };
        this.ui.canvas.style.cursor = 'grabbing';
        return true;
      }
      this.selectClickCandidate = hit;
    } else {
      if (!this.ui.shiftDown) 
      this.ui.clearSelection();
      this.reset();   
      this.selectClickCandidate = null;
      this.selectBoxStart = { x: pos.x, y: pos.y };
      this.selectBoxCurrent = { x: pos.x, y: pos.y };
      this.ui.doRedraw();
    }
    return false;
  }

  onMouseMove(pos, world, e) {
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

    if (!this.selectBoxStart && !this.wallResizeState) {
      const hit = this.hitTestObject(world.x, world.y);
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

    if (this.selectBoxStart) {
      this.selectBoxCurrent = { x: pos.x, y: pos.y };
      this.ui.doRedraw();
      return true;
    }

    return false;
  }

  onMouseUp(pos, world, e) {
    // Завершение drag перемещения
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

    // Завершение resize
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
        for (const wall of appState.walls) {
          const wb = {
            left: Math.min(toScreen(wall.x1, wall.y1).x, toScreen(wall.x2, wall.y2).x) - wall.thickness,
            right: Math.max(toScreen(wall.x1, wall.y1).x, toScreen(wall.x2, wall.y2).x) + wall.thickness,
            top: Math.min(toScreen(wall.x1, wall.y1).y, toScreen(wall.x2, wall.y2).y) - wall.thickness,
            bottom: Math.max(toScreen(wall.x1, wall.y1).y, toScreen(wall.x2, wall.y2).y) + wall.thickness,
          };
          if (boundsIntersect(wb, box)) items.push({ type: 'wall', id: wall.id });
        }
        for (const op of appState.openings) {
          const ob = getOpeningScreenBounds(op);
          if (ob && boundsIntersect(ob, box)) items.push({ type: 'opening', id: op.id });
        }
        if (items.length) {
          this.ui.setSelection(this.ui.shiftDown ? [...this.ui.selectedItems, ...items] : items);
        } else if (!this.ui.shiftDown) {
          this.ui.clearSelection();
        }
      } else if (!this.ui.shiftDown) {
        this.ui.clearSelection();
      }
      this.selectBoxStart = null;
      this.selectBoxCurrent = null;
      this.ui.doRedraw();
      return true;
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
  hitTestObject(wx, wy) {
    const op = findClosestOpening(wx, wy);
    if (op) return { type: 'opening', id: op.id };
    const wall = findClosestWallSel(wx, wy);
    if (wall) return { type: 'wall', id: wall.id };
    return null;
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
