// ─── MeasureTool.js ───────────────────────────────────────────────
import { BaseTool } from './BaseTool.js';
import { executeCommand } from '../commands/CommandHistory.js';
import { CreateMeasureCommand } from '../commands/CreateMeasureCommand.js';
import {
  snap, setModifiers, findObjectSnapCandidate, toScreen
} from '../snapping.js';

export class MeasureTool extends BaseTool {
  constructor(ui) {
    super(ui);
    this.name = 'measure';
    this.isDrawing = false;
    this.drawStart = null;
    this.drawEnd = null;
    this.currentObjectSnap = null;   // ← для отображения привязки
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
      currentObjectSnap: this.currentObjectSnap,   // ← чтобы render показал значок
      tool: this.name,
    };
  }

  onMouseDown(pos, world, e) {
    if (!this.isDrawing) {
      // Первый клик — используем текущую привязку, если есть, иначе snap
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
      // Второй клик — завершаем с привязкой
      let endPoint;
      if (this.currentObjectSnap) {
        endPoint = { x: this.currentObjectSnap.x, y: this.currentObjectSnap.y };
      } else {
        const snapped = snap(world.x, world.y, { screenPoint: pos });
        endPoint = { x: snapped.x, y: snapped.y };
      }
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
    
    // Обновляем привязку (как в WallTool)
    this.currentObjectSnap = findObjectSnapCandidate(world, pos, {
      includeEndpoint: true,
      includeCorner: true,
      includeMidpoint: true,
      includeIntersection: true,
      includeWallPoint: true,        // ← грани стен
      includePerpendicular: false,
    });

    if (this.isDrawing && this.drawStart) {
      // При движении с зажатой кнопкой обновляем временную конечную точку с учётом привязки
      let endPoint;
      if (this.currentObjectSnap) {
        endPoint = { x: this.currentObjectSnap.x, y: this.currentObjectSnap.y };
      } else {
        const snapped = snap(world.x, world.y, { screenPoint: pos });
        endPoint = { x: snapped.x, y: snapped.y };
      }
      this.drawEnd = endPoint;
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
}
