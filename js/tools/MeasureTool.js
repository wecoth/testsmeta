// ─── MeasureTool.js ───────────────────────────────────────────────
import { BaseTool } from './BaseTool.js';
import { executeCommand } from '../commands/CommandHistory.js';
import { CreateMeasureCommand } from '../commands/CreateMeasureCommand.js';
import {
  snap, setModifiers, findObjectSnapCandidate, toScreen, toWorld,
  findGuideCandidate, getNearestGuideLineAxis, projectPointToGuideLineWorld,
  shouldKeepGuideLine,
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

  // Стадии выноса размера
  this.isSettingOffset = false;
  this.measurementSegment = null; // { p1, p2, distance }
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
  this.isSettingOffset = false;
  this.measurementSegment = null;
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
    isSettingOffset: this.isSettingOffset,
    measurementSegment: this.measurementSegment,
  };
}

  onMouseDown(pos, world, e) {
  if (!this.isDrawing) {
    // Первый клик: начало измерения
    let startPoint;
    if (this.currentObjectSnap) {
      startPoint = { x: this.currentObjectSnap.x, y: this.currentObjectSnap.y };
    } else {
      const snapped = snap(world.x, world.y, { screenPoint: pos, tolerance: 24 });
      startPoint = { x: snapped.x, y: snapped.y };
    }
    this.isDrawing = true;
    this.drawStart = startPoint;
    this.drawEnd = { ...startPoint };
    this.lengthInput = '';
    this.lengthMode = false;
    this.ui.doRedraw();
  } else if (!this.isSettingOffset) {
    // Второй клик: фиксируем отрезок и переходим к выносу
    let endPoint = this.getMeasureEnd(world);
    const len = Math.hypot(endPoint.x - this.drawStart.x, endPoint.y - this.drawStart.y);
    if (len > 1) {
      this.measurementSegment = {
        p1: { ...this.drawStart },
        p2: { ...endPoint },
        distance: len
      };
      this.isSettingOffset = true;
      this.drawEnd = this.getOffsetPosition(world);
    } else {
      this.reset();
    }
    this.ui.doRedraw();
  } else {
    // Третий клик: создаём размер с выносом
    let offsetPoint = this.getOffsetPosition(world);
    // Вычисляем смещение от середины отрезка
    const mid = {
      x: (this.measurementSegment.p1.x + this.measurementSegment.p2.x) / 2,
      y: (this.measurementSegment.p1.y + this.measurementSegment.p2.y) / 2
    };
    const offsetDist = Math.hypot(offsetPoint.x - mid.x, offsetPoint.y - mid.y);
    
    // Пока создаём обычный размер (без сохранения смещения в команде)
    // В будущем можно доработать CreateMeasureCommand для поддержки offset
    executeCommand(new CreateMeasureCommand(
      this.measurementSegment.p1.x, this.measurementSegment.p1.y,
      this.measurementSegment.p2.x, this.measurementSegment.p2.y
    ));
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
      tolerance: 24,
    });

    this.updateGuideLine(world, pos);

    if (this.isSettingOffset) {
  this.drawEnd = this.getOffsetPosition(world);
} else if (this.isDrawing && this.drawStart) {
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

  // Если уже есть объектная направляющая — проверяем, не пора ли её сбросить
  if (this.currentGuideLine && this.currentGuideLine.id !== 'measure:start-axis') {
    if (shouldKeepGuideLine(screenPoint, this.currentGuideLine, 36, 48)) {
      return;
    } else {
      this.currentGuideLine = null;
    }
  }

  // Ищем только реальные объектные направляющие (стены, проёмы, другие рулетки)
  const candidate = findGuideCandidate(screenPoint);
  if (candidate) {
    this.currentGuideLine = candidate;
  } else {
    this.currentGuideLine = null;   // НЕ создаём автоматическую ось
  }
}

  getMeasureEnd(world) {
  // Если вводим длину, используем её для вычисления конечной точки
  if (this.lengthMode && this.lengthInput) {
    return this.computeEndFromLength(parseFloat(this.lengthInput));
  }

  const screenPt = this.ui.mouseScreen || toScreen(world.x, world.y);
  
  // Базовая привязка
  let end;
  if (this.currentObjectSnap) {
    end = { x: this.currentObjectSnap.x, y: this.currentObjectSnap.y };
  } else {
    end = snap(world.x, world.y, {
      screenPoint: screenPt,
      includePerpendicular: false,
      includeWallPoint: true,
      tolerance: 24,
    });
  }
  
  const hardSnap = this.currentObjectSnap && 
    (this.currentObjectSnap.type === 'endpoint' || 
     this.currentObjectSnap.type === 'corner' || 
     this.currentObjectSnap.type === 'intersection');

  // ⭐ ОРТОГОНАЛЬНАЯ ПРИВЯЗКА (как в WallTool)
  if (!hardSnap && !this.ui.shiftDown && this.drawStart) {
    const dx = end.x - this.drawStart.x;
    const dy = end.y - this.drawStart.y;
    const len = Math.hypot(dx, dy);
    if (len > 1) {
      let angle = Math.atan2(dy, dx);
      for (const sa of [0, Math.PI / 2, Math.PI, -Math.PI / 2]) {
        const diff = Math.abs(angle - sa);
        if (diff < 0.15 || Math.abs(diff - 2 * Math.PI) < 0.15) {
          angle = sa;
          end = {
            x: this.drawStart.x + Math.cos(angle) * len,
            y: this.drawStart.y + Math.sin(angle) * len,
          };
          break;
        }
      }
    }
  }

  // Применение объектной направляющей (если есть)
  if (this.currentGuideLine) {
    // Применяем только объектные направляющие, не автоматическую ось
    if (this.currentGuideLine.id !== 'measure:start-axis') {
      const axisGuide = getNearestGuideLineAxis(screenPt, this.currentGuideLine);
      const proj = projectPointToGuideLineWorld(end, axisGuide);
      end = { x: proj.x, y: proj.y };
    }
  }
  
  return end;
}

// Вычисляет положение размерной линии при выносе (перпендикулярно отрезку)
getOffsetPosition(world) {
  if (!this.measurementSegment) return world;
  const seg = this.measurementSegment;
  
  const segVec = { x: seg.p2.x - seg.p1.x, y: seg.p2.y - seg.p1.y };
  const perpVec = { x: -segVec.y, y: segVec.x };
  const perpLen = Math.hypot(perpVec.x, perpVec.y);
  
  if (perpLen > 0) {
    perpVec.x /= perpLen;
    perpVec.y /= perpLen;
  }

  const mid = { x: (seg.p1.x + seg.p2.x) / 2, y: (seg.p1.y + seg.p2.y) / 2 };
  const toMouse = { x: world.x - mid.x, y: world.y - mid.y };
  const offsetDist = toMouse.x * perpVec.x + toMouse.y * perpVec.y;
  
  return {
    x: mid.x + perpVec.x * offsetDist,
    y: mid.y + perpVec.y * offsetDist
  };
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
  // Цепной режим: продолжаем от конечной точки
  this.drawStart = { x: end.x, y: end.y };
  this.drawEnd = { x: end.x, y: end.y };
  this.lengthInput = '';
  this.lengthMode = false;
  this.isDrawing = true;
  this.ui.doRedraw();
  }
}
