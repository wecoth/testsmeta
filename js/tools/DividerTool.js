// ─── DividerTool.js ───────────────────────────────────────────────
import { BaseTool } from './BaseTool.js';
import { executeCommand } from '../commands/CommandHistory.js';
import { CreateDividerCommand } from '../commands/CreateDividerCommand.js';
import { snap, setModifiers } from '../snapping.js';

export class DividerTool extends BaseTool {
  constructor(ui) {
    super(ui);
    this.name = 'divider';
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
      wallOffset: 'center', // не важно
    };
  }

  onMouseDown(pos, world, e) {
    if (!this.isDrawing) {
      const snapped = snap(world.x, world.y, { screenPoint: pos });
      this.isDrawing = true;
      this.drawStart = { x: snapped.x, y: snapped.y };
      this.drawEnd = { ...snapped };
      this.ui.doRedraw();
    } else {
      const end = this.getDividerEnd(world);
      const len = Math.hypot(end.x - this.drawStart.x, end.y - this.drawStart.y);
      if (len > 1) {
        executeCommand(new CreateDividerCommand(this.drawStart.x, this.drawStart.y, end.x, end.y));
        this.reset();
        this.ui.doRedraw();
      }
    }
    return true;
  }

  onMouseMove(pos, world, e) {
    setModifiers(this.ui.shiftDown, this.ui.ctrlDown);
    this.updateObjectSnap(world, pos);
    if (this.isDrawing && this.drawStart) {
      this.drawEnd = this.getDividerEnd(world);
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
    // Используем те же привязки, что и для стены
    import('../snapping.js').then(({ findObjectSnapCandidate }) => {
      this.currentObjectSnap = findObjectSnapCandidate(world, screenPoint, {
        includeEndpoint: true,
        includeCorner: true,
        includeMidpoint: true,
        includeIntersection: true,
        includeWallPoint: false,
        includePerpendicular: false,
      });
    });
  }

  getDividerEnd(world) {
    // Используем базовый snap без ортогонализации
    const snapped = snap(world.x, world.y, { screenPoint: this.ui.mouseScreen });
    // Для разделителя не нужны сложные направляющие
    return { x: snapped.x, y: snapped.y };
  }
}
