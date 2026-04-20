// ─── WallTool.js ──────────────────────────────────────────────────
import { BaseTool } from './BaseTool.js';
import { appState } from '../state.js';
import { executeCommand } from '../commands/CommandHistory.js';
import { CreateWallCommand } from '../commands/CreateWallCommand.js';
import {
  snap, toScreen, toWorld, setModifiers,
  findObjectSnapCandidate, findGuideCandidate, getNearestGuideAxis,
  projectPointToGuideLineWorld, getTrackingLines, snapToTrackingLines,
} from '../snapping.js';

export class WallTool extends BaseTool {
  constructor(ui) {
    super(ui);
    this.name = 'wall';
    
    // Локальное состояние рисования
    this.isDrawing = false;
    this.drawStart = null;
    this.drawEnd = null;
    this.chainMode = false;
    this.lengthInput = '';
    this.lengthMode = false;
    this.currentGuideLine = null;
    this.currentObjectSnap = null;
    
    // Отслеживание точки для рулетки
    this.activeTrackingPoint = null;
    this._snapHoverTimer = null;
    this._snapHoverKey = null;
  }

  activate() {
    this.reset();
    this.ui.canvas.style.cursor = 'crosshair';
  }

  deactivate() {
    this.clearTracking();
    this.reset();
  }

  reset() {
    this.isDrawing = false;
    this.chainMode = false;
    this.drawStart = null;
    this.drawEnd = null;
    this.currentGuideLine = null;
    this.currentObjectSnap = null;
    this.lengthInput = '';
    this.lengthMode = false;
    this.clearTracking();
    if (this.ui.dom.lengthOverlay) this.ui.dom.lengthOverlay.style.display = 'none';
    if (this.ui.dom.lblLen) this.ui.dom.lblLen.style.display = 'none';
  }

  clearTracking() {
    clearTimeout(this._snapHoverTimer);
    this._snapHoverTimer = null;
    this._snapHoverKey = null;
    this.activeTrackingPoint = null;
  }

  updateTrackingState(snap) {
    const trackable = snap && (
      snap.type === 'endpoint' || snap.type === 'corner' ||
      snap.type === 'intersection' || snap.type === 'midpoint'
    );
    if (!trackable) {
      clearTimeout(this._snapHoverTimer);
      this._snapHoverTimer = null;
      this._snapHoverKey = null;
      return;
    }
    const key = `${snap.type}:${Math.round(snap.x)},${Math.round(snap.y)}`;
    if (key === this._snapHoverKey) return;
    clearTimeout(this._snapHoverTimer);
    this._snapHoverKey = key;
    this._snapHoverTimer = setTimeout(() => {
      let wallDir = null;
      if (snap.wallId) {
        const wall = appState.walls.find(w => w.id === snap.wallId);
        if (wall) {
          const dx = (wall.cx2 ?? wall.x2) - (wall.cx1 ?? wall.x1);
          const dy = (wall.cy2 ?? wall.y2) - (wall.cy1 ?? wall.y1);
          const len = Math.hypot(dx, dy);
          if (len > 1) wallDir = { x: dx / len, y: dy / len };
        }
      }
      this.activeTrackingPoint = { x: snap.x, y: snap.y, type: snap.type, wallDir };
      this.ui.doRedraw();
    }, 400);
  }

  getCursor() {
    return 'crosshair';
  }

  getRenderState() {
    return {
      isDrawing: this.isDrawing,
      drawStart: this.drawStart,
      drawEnd: this.drawEnd,
      currentGuideLine: this.currentGuideLine,
      currentObjectSnap: this.currentObjectSnap,
      chainMode: this.chainMode,
      lengthMode: this.lengthMode,
      lengthInput: this.lengthInput,
      wallOffset: this.ui.wallOffset,
      activeTrackingPoint: this.activeTrackingPoint,
      trackingLines: this.activeTrackingPoint ? getTrackingLines(this.activeTrackingPoint) : [],
    };
  }

  onMouseDown(pos, world, e) {
    if (!this.isDrawing) {
      const snapped = snap(world.x, world.y, { screenPoint: pos });
      this.isDrawing = true;
      this.chainMode = false;
      this.drawStart = { x: snapped.x, y: snapped.y };
      this.drawEnd = { ...snapped };
      this.lengthInput = '';
      this.lengthMode = false;
      this.ui.doRedraw();
    } else {
      const end = this.getWallPreviewEnd(world);
      this.finalizeWall(end);
    }
    return true;
  }

  onMouseMove(pos, world, e) {
    setModifiers(this.ui.shiftDown, this.ui.ctrlDown);
    
    this.updateWallObjectSnap(world, pos);
    this.updateTrackingState(this.currentObjectSnap);

    if (this.isDrawing && this.drawStart) {
      this.updateWallGuide(world, pos);
      this.drawEnd = this.getWallPreviewEnd(world);
    }
    
    // Обновление статусбара с расстоянием от активной точки
    this.ui.updateCoordinatesLabel(world, this.currentObjectSnap, this.activeTrackingPoint);
    
    this.ui.doRedraw();
    return true;
  }

  onMouseUp(pos, world, e) {
    // Ничего не делаем, стена завершается по второму клику
    return false;
  }

  onKeyDown(e) {
    if (!this.isDrawing) return false;

    // Голосовой ввод
    if (e.code === 'Space' && !this.ui.voiceKeyPressed) {
      e.preventDefault();
      this.ui.voiceKeyPressed = true;
      // Запуск голосового ввода (через VoiceInput)
      import('../voiceInput.js').then(({ VoiceInput }) => {
        VoiceInput.startListening((lengthMm) => {
          if (!this.isDrawing) return;
          this.lengthInput = lengthMm.toString();
          this.lengthMode = true;
          this.ui.doRedraw();
        });
      });
      return true;
    }

    // Ввод длины цифрами
    if (/^[0-9]$/.test(e.key)) {
      this.lengthMode = true;
      this.lengthInput += e.key;
      e.preventDefault();
      this.ui.doRedraw();
      return true;
    } else if (e.key === 'Backspace' && this.lengthMode) {
      this.lengthInput = this.lengthInput.slice(0, -1);
      if (!this.lengthInput) this.lengthMode = false;
      e.preventDefault();
      this.ui.doRedraw();
      return true;
    } else if (e.key === 'Enter' && this.lengthMode && this.lengthInput) {
      const targetLen = parseFloat(this.lengthInput);
      if (!isNaN(targetLen) && targetLen > 0 && this.drawEnd && this.drawStart) {
        const end = this.getWallPreviewEnd(this.drawEnd);
        this.finalizeWall(end);
      }
      this.lengthInput = '';
      this.lengthMode = false;
      e.preventDefault();
      this.ui.doRedraw();
      return true;
    }

    // Escape — отмена рисования
    if (e.key === 'Escape') {
      this.reset();
      this.ui.doRedraw();
      return true;
    }

    return false;
  }

  onKeyUp(e) {
    if (e.code === 'Space' && this.ui.voiceKeyPressed) {
      this.ui.voiceKeyPressed = false;
      import('../voiceInput.js').then(({ VoiceInput }) => {
        VoiceInput.stopListening();
      });
      e.preventDefault();
      return true;
    }
    return false;
  }

  // ─── Вспомогательные методы WallTool ─────────────────────────────

  updateWallObjectSnap(world, screenPoint) {
    this.currentObjectSnap = findObjectSnapCandidate(world, screenPoint, {
      includeEndpoint: true,
      includeCorner: true,
      includeMidpoint: true,
      includeIntersection: true,
      includeWallPoint: true,
      includePerpendicular: this.isDrawing && !!this.drawStart,
      startPoint: this.drawStart,
    });
  }

  updateWallGuide(world, screenPoint) {
    if (!this.isDrawing || !this.drawStart) {
      this.currentGuideLine = null;
      return;
    }
    const candidate = findGuideCandidate(screenPoint);
    if (candidate) {
      this.currentGuideLine = candidate;
      return;
    }
    if (this.currentGuideLine) {
      const nearest = getNearestGuideAxis(screenPoint, this.currentGuideLine);
      const guideDistance = nearest ? nearest.distance : Infinity;
      const anchorScreen = toScreen(this.currentGuideLine.anchor.x, this.currentGuideLine.anchor.y);
      const anchorDistance = Math.hypot(screenPoint.x - anchorScreen.x, screenPoint.y - anchorScreen.y);
      if (guideDistance <= 18 || anchorDistance <= 20) return;
    }
    this.currentGuideLine = null;
  }

  getWallPreviewEnd(world) {
    const screenPt = this.ui.mouseScreen ? { ...this.ui.mouseScreen } : toScreen(world.x, world.y);
    const snappedBase = snap(world.x, world.y, {
      screenPoint: screenPt,
      includePerpendicular: !!this.drawStart,
      startPoint: this.drawStart,
    });
    let rawEnd = { ...snappedBase };
    const hardSnap = snappedBase.snapType === 'endpoint' || snappedBase.snapType === 'corner' || snappedBase.snapType === 'intersection';

    if (!hardSnap && !this.ui.shiftDown && this.drawStart) {
      const dx = rawEnd.x - this.drawStart.x;
      const dy = rawEnd.y - this.drawStart.y;
      const len = Math.hypot(dx, dy);
      if (len > 1) {
        let angle = Math.atan2(dy, dx);
        for (const sa of [0, Math.PI / 2, Math.PI, -Math.PI / 2]) {
          const diff = Math.abs(angle - sa);
          if (diff < 0.15 || Math.abs(diff - 2 * Math.PI) < 0.15) {
            angle = sa;
            rawEnd = {
              x: this.drawStart.x + Math.cos(angle) * len,
              y: this.drawStart.y + Math.sin(angle) * len,
            };
            if (snappedBase.snapType === 'wallFace' || snappedBase.snapType === 'wallAxis') {
              rawEnd.snapType = null;
            }
            break;
          }
        }
      }
    }

    if (this.currentGuideLine && !snappedBase.snapType) {
      const nearest = getNearestGuideAxis(screenPt, this.currentGuideLine);
      const axisGuide = nearest ? { anchor: this.currentGuideLine.anchor, dir: nearest.dir } : this.currentGuideLine;
      rawEnd = { ...rawEnd, ...projectPointToGuideLineWorld(rawEnd, axisGuide) };
    }

    // Stage 3: tracking lines
    if (this.activeTrackingPoint && !snappedBase.snapType && !this.currentGuideLine) {
      const tLines = getTrackingLines(this.activeTrackingPoint);
      const tSnap = snapToTrackingLines(rawEnd, screenPt, tLines, 16);
      if (tSnap) {
        rawEnd = { ...rawEnd, x: tSnap.x, y: tSnap.y, snapType: 'tracking' };
      }
    }

    if (this.lengthMode && this.lengthInput && this.drawStart) {
      const targetLen = parseFloat(this.lengthInput);
      if (!isNaN(targetLen) && targetLen > 0) {
        if (this.currentGuideLine) {
          const nearest = getNearestGuideAxis(screenPt, this.currentGuideLine);
          const axisDir = nearest ? nearest.dir : this.currentGuideLine.dir;
          const axisGuide = { anchor: this.currentGuideLine.anchor, dir: axisDir };
          const ax = axisGuide.anchor.x - this.drawStart.x;
          const ay = axisGuide.anchor.y - this.drawStart.y;
          const dot = ax * axisGuide.dir.x + ay * axisGuide.dir.y;
          const dist2 = ax * ax + ay * ay;
          const disc = dot * dot - (dist2 - targetLen * targetLen);
          if (disc >= 0) {
            const sq = Math.sqrt(disc);
            const p1 = {
              x: axisGuide.anchor.x + axisGuide.dir.x * (-dot + sq),
              y: axisGuide.anchor.y + axisGuide.dir.y * (-dot + sq),
            };
            const p2 = {
              x: axisGuide.anchor.x + axisGuide.dir.x * (-dot - sq),
              y: axisGuide.anchor.y + axisGuide.dir.y * (-dot - sq),
            };
            rawEnd = Math.hypot(rawEnd.x - p1.x, rawEnd.y - p1.y) <= Math.hypot(rawEnd.x - p2.x, rawEnd.y - p2.y)
              ? p1 : p2;
          }
        } else {
          const dx = rawEnd.x - this.drawStart.x;
          const dy = rawEnd.y - this.drawStart.y;
          const curLen = Math.hypot(dx, dy);
          if (curLen > 0.1) {
            rawEnd = {
              x: this.drawStart.x + (dx / curLen) * targetLen,
              y: this.drawStart.y + (dy / curLen) * targetLen,
            };
          }
        }
      }
    }

    rawEnd.snappedToEndpoint = snappedBase.snappedToEndpoint;
    rawEnd.snapType = snappedBase.snapType;
    return rawEnd;
  }

  finalizeWall(end) {
    if (!this.drawStart) return false;
    const len = Math.hypot(end.x - this.drawStart.x, end.y - this.drawStart.y);
    if (len <= 1) return false;

    const thick = parseFloat(this.ui.dom.inpWallThick?.value) || 200;
    const height = parseFloat(this.ui.dom.inpWallHeight?.value) || 2700;

    executeCommand(new CreateWallCommand(this.drawStart, end, thick, height, this.ui.wallOffset));

    this.drawStart = { x: end.x, y: end.y };
    this.drawEnd = { x: end.x, y: end.y };
    this.currentGuideLine = null;
    this.currentObjectSnap = null;
    this.lengthInput = '';
    this.lengthMode = false;
    this.chainMode = true;
    this.isDrawing = true;
    this.ui.doRedraw();
    return true;
  }
}
