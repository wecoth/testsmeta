// ─── MeasureTool.js ───────────────────────────────────────────────
import { BaseTool } from './BaseTool.js';
import { executeCommand } from '../commands/CommandHistory.js';
import { CreateMeasureCommand } from '../commands/CreateMeasureCommand.js';
import { snap, setModifiers, findObjectSnapCandidate } from '../snapping.js';

export class MeasureTool extends BaseTool {
  constructor(ui) {
    super(ui);
    this.name = 'measure';
    this.isDrawing = false;
    this.drawStart = null;
    this.drawEnd = null;
    this.currentObjectSnap = null;
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
      tool: this.name,
    };
  }

  onMouseDown(pos, world, e) {
    if (!this.isDrawing) {
      // Первый клик — фиксируем стартовую точку с привязкой
      const snapped = snap(world.x, world.y, { screenPoint: pos });
      this.isDrawing = true;
      this.drawStart = { x: snapped.x, y: snapped.y };
      this.drawEnd = { ...snapped };
      this.ui.doRedraw();
    } else {
      // Второй клик — завершаем измерение
      const end = this.getMeasureEnd(world);
      const len = Math.hypot(end.x - this.drawStart.x, end.y - this.drawStart.y);
      if (len > 1) {
        executeCommand(new CreateMeasureCommand(this.drawStart.x, this.drawStart.y, end.x, end.y));
      }
      this.reset();
      this.ui.doRedraw();
    }
    return true;
  }

  onMouseMove(pos, world, e) {
    setModifiers(this.ui.shiftDown, this.ui.ctrlDown);
    this.updateObjectSnap(world, pos);
    
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

  updateObjectSnap(world, screenPoint) {
    this.currentObjectSnap = findObjectSnapCandidate(world, screenPoint, {
      includeEndpoint: true,
      includeCorner: true,
      includeMidpoint: true,
      includeIntersection: true,
      includeWallPoint: true,   // ← важно для привязки к граням
      includePerpendicular: false,
    });
  }

  getMeasureEnd(world) {
    const screenPt = this.ui.mouseScreen || toScreen(world.x, world.y);
    // Используем обычный snap, но разрешаем привязку к граням
    return snap(world.x, world.y, {
      screenPoint: screenPt,
      includePerpendicular: false,
    });
  }
}
