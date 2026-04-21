// ─── MeasureTool.js ───────────────────────────────────────────────
import { BaseTool } from './BaseTool.js';
import { executeCommand } from '../commands/CommandHistory.js';
import { CreateMeasureCommand } from '../commands/CreateMeasureCommand.js';
import {
  snap, setModifiers, findObjectSnapCandidate, toScreen, toWorld,
  findGuideCandidate, getNearestGuideAxis, projectPointToGuideLineWorld
} from '../snapping.js';

export class MeasureTool extends BaseTool {
  constructor(ui) {
    super(ui);
    this.name = 'measure';
    this.isDrawing = false;
    this.drawStart = null;
    this.drawEnd = null;
    this.currentObjectSnap = null;
    this.currentGuideLine = null;   // ← для направляющих (оси)
  }

  activate() {
    this.reset();
    this.ui.canvas.style.cursor = 'crosshair';
  }

  deactivate() {
    this.reset();
  }

  reset() {
    this.isDrawing = false;
    this.drawStart = null;
    this.drawEnd = null;
    this.currentObjectSnap = null;
    this.currentGuideLine = null;
  }

  getCursor() {
    return 'crosshair';
  }

  getRenderState() {
    return {
      isDrawing: this.isDrawing,
      drawStart: this.drawStart,
      drawEnd: this.drawEnd,
      currentObjectSnap: this.currentObjectSnap,
      currentGuideLine: this.currentGuideLine,   // ← чтобы render нарисовал направляющие
      tool: this.name,
    };
  }

  onMouseDown(pos, world, e) {
    if (!this.isDrawing) {
      let startPoint;
      if (this.currentObjectSnap) {
        startPoint = { x: this.currentObjectSnap.x, y: this.currentObjectSnap.y };
      } else {
        const snapped = snap(world.x, world.y, { screenPoint: pos });
        startPoint = { x: snapped.x, y: snapped.y };
      }
      this.isDrawing = true;
      this.drawStart = startPoint;
      this.drawEnd = { ...startPoint };
      this.ui.doRedraw();
    } else {
      let endPoint = this.getMeasureEnd(world);
      const len = Math.hypot(endPoint.x - this.drawStart.x, endPoint.y - this.drawStart.y);
      if (len > 1) {
        executeCommand(new CreateMeasureCommand(
          this.drawStart.x, this.drawStart.y,
          endPoint.x, endPoint.y
        ));
      }
      this.reset();
      this.ui.doRedraw();
    }
    return true;
  }

  onMouseMove(pos, world, e) {
    setModifiers(this.ui.shiftDown, this.ui.ctrlDown);
    
    // Обновляем объектную привязку
    this.currentObjectSnap = findObjectSnapCandidate(world, pos, {
      includeEndpoint: true,
      includeCorner: true,
      includeMidpoint: true,
      includeIntersection: true,
      includeWallPoint: true,
      includePerpendicular: false,
    });

    // Обновляем направляющие (оси)
    this.updateGuideLine(world, pos);

    if (this.isDrawing && this.drawStart) {
      this.drawEnd = this.getMeasureEnd(world);
    }

    this.ui.updateCoordinatesLabel(world, this.currentObjectSnap, null);
    this.ui.doRedraw();
    return true;
  }

  onKeyDown(e) {
    if (e.key === 'Escape') {
      this.reset();
      this.ui.doRedraw();
      return true;
    }
    return false;
  }

  // ─── Направляющие (оси) ─────────────────────────────────────────
  updateGuideLine(world, screenPoint) {
    if (!this.isDrawing || !this.drawStart) {
      this.currentGuideLine = null;
      return;
    }
    const dx = world.x - this.drawStart.x;
    const dy = world.y - this.drawStart.y;
    const DIST_TOL = 30;   // мм
    
    let dir = null;
    if (Math.abs(dx) > Math.abs(dy)) {
      if (Math.abs(dy) < DIST_TOL) dir = { x: 1, y: 0 };
    } else {
      if (Math.abs(dx) < DIST_TOL) dir = { x: 0, y: 1 };
    }
    
    if (dir) {
      this.currentGuideLine = {
        anchor: { x: this.drawStart.x, y: this.drawStart.y },
        dir: dir,
      };
    } else {
      this.currentGuideLine = null;
    }
  }

  getMeasureEnd(world) {
    const screenPt = this.ui.mouseScreen || toScreen(world.x, world.y);
    
    let end;
    if (this.currentObjectSnap) {
      end = { x: this.currentObjectSnap.x, y: this.currentObjectSnap.y };
    } else {
      end = snap(world.x, world.y, {
        screenPoint: screenPt,
        includePerpendicular: false,
        includeWallPoint: true,
      });
    }
    
    // Примагничиваем к текущей направляющей, если она есть
    if (this.currentGuideLine) {
      const proj = projectPointToGuideLineWorld(end, this.currentGuideLine);
      end = { x: proj.x, y: proj.y };
    }
    
    return end;
  }
}
