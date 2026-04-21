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
    this.currentGuideLine = null;
    
    // Поля для ввода точной длины
    this.lengthInput = '';
    this.lengthMode = false;
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
    this.lengthInput = '';
    this.lengthMode = false;
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
      currentGuideLine: this.currentGuideLine,
      lengthMode: this.lengthMode,
      lengthInput: this.lengthInput,
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
      this.lengthInput = '';
      this.lengthMode = false;
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
    
    this.currentObjectSnap = findObjectSnapCandidate(world, pos, {
      includeEndpoint: true,
      includeCorner: true,
      includeMidpoint: true,
      includeIntersection: true,
      includeWallPoint: true,
      includePerpendicular: false,
    });

    this.updateGuideLine(world, pos);

    if (this.isDrawing && this.drawStart) {
      this.drawEnd = this.getMeasureEnd(world);
    }

    this.ui.updateCoordinatesLabel(world, this.currentObjectSnap, null);
    this.ui.doRedraw();
    return true;
  }

  onKeyDown(e) {
    if (!this.isDrawing) return false;

    // Ввод длины с клавиатуры
    if (/^[0-9]$/.test(e.key)) {
      this.lengthMode = true;
      this.lengthInput += e.key;
      e.preventDefault();
      this.ui.doRedraw();
      return true;
    }
    if (e.key === 'Backspace' && this.lengthMode) {
      this.lengthInput = this.lengthInput.slice(0, -1);
      if (!this.lengthInput) this.lengthMode = false;
      e.preventDefault();
      this.ui.doRedraw();
      return true;
    }
    if (e.key === 'Enter' && this.lengthMode && this.lengthInput) {
      const targetLen = parseFloat(this.lengthInput);
      if (!isNaN(targetLen) && targetLen > 0 && this.drawStart) {
        this.applyLength(targetLen);
      }
      this.lengthInput = '';
      this.lengthMode = false;
      e.preventDefault();
      this.ui.doRedraw();
      return true;
    }
    if (e.key === 'Escape') {
      this.reset();
      this.ui.doRedraw();
      return true;
    }
    return false;
  }

  onMouseUp(pos, world, e) { return false; }
  onKeyUp(e) { return false; }

  // ─── Направляющие (оси) ─────────────────────────────────────────
  updateGuideLine(world, screenPoint) {
    if (!this.isDrawing || !this.drawStart) {
      this.currentGuideLine = null;
      return;
    }
    const dx = world.x - this.drawStart.x;
    const dy = world.y - this.drawStart.y;
    const DIST_TOL = 30;
    
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
    // Если вводим длину, используем её для вычисления конечной точки
    if (this.lengthMode && this.lengthInput) {
      return this.computeEndFromLength(parseFloat(this.lengthInput));
    }

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
    
    if (this.currentGuideLine) {
      const proj = projectPointToGuideLineWorld(end, this.currentGuideLine);
      end = { x: proj.x, y: proj.y };
    }
    
    return end;
  }

  // Вычисляет конечную точку на основе заданной длины
  computeEndFromLength(targetLen) {
    if (!this.drawStart) return this.drawEnd || { x: 0, y: 0 };
    if (targetLen <= 0) return { ...this.drawStart };
    
    let dir;
    if (this.currentGuideLine) {
      dir = this.currentGuideLine.dir;
    } else {
      // Используем текущее направление от старта к мыши
      const world = this.ui.mouseScreen ? toWorld(this.ui.mouseScreen.x, this.ui.mouseScreen.y) : this.drawEnd;
      const dx = world.x - this.drawStart.x;
      const dy = world.y - this.drawStart.y;
      const len = Math.hypot(dx, dy);
      if (len > 1) {
        dir = { x: dx / len, y: dy / len };
      } else {
        dir = { x: 1, y: 0 };
      }
    }
    
    return {
      x: this.drawStart.x + dir.x * targetLen,
      y: this.drawStart.y + dir.y * targetLen,
    };
  }

  applyLength(targetLen) {
    if (!this.drawStart) return;
    const end = this.computeEndFromLength(targetLen);
    executeCommand(new CreateMeasureCommand(
      this.drawStart.x, this.drawStart.y,
      end.x, end.y
    ));
    this.reset();
    this.ui.doRedraw();
  }
}
