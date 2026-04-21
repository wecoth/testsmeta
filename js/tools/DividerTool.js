// ─── DividerTool.js ───────────────────────────────────────────────
import { BaseTool } from './BaseTool.js';
import { executeCommand } from '../commands/CommandHistory.js';
import { CreateDividerCommand } from '../commands/CreateDividerCommand.js';
import {
  snap, setModifiers, findObjectSnapCandidate, findGuideCandidate,
  shouldKeepGuideLine, getNearestGuideLineAxis, projectPointToGuideLineWorld,
} from '../snapping.js';

export class DividerTool extends BaseTool {
  constructor(ui) {
    super(ui);
    this.name = 'divider';
    this.isDrawing = false;
    this.drawStart = null;
    this.drawEnd = null;
    this.currentObjectSnap = null;
    this.currentGuideLine = null;
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
      currentGuideLine: this.currentGuideLine,
      wallOffset: 'center', // не важно
      tool: this.name,
    };
  }

  onMouseDown(pos, world, e) {
    if (!this.isDrawing) {
      const snapped = this.currentObjectSnap
        ? { x: this.currentObjectSnap.x, y: this.currentObjectSnap.y }
        : snap(world.x, world.y, { screenPoint: pos, tolerance: 24 });
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
    this.updateGuideLine(world, pos);
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
    this.currentObjectSnap = findObjectSnapCandidate(world, screenPoint, {
      includeEndpoint: true,
      includeCorner: true,
      includeMidpoint: true,
      includeIntersection: true,
      includeWallPoint: true,
      includePerpendicular: false,
      tolerance: 24,
    });
  }

  updateGuideLine(world, screenPoint) {
    if (!this.isDrawing || !this.drawStart) {
      this.currentGuideLine = null;
      return;
    }

    const candidate = findGuideCandidate(screenPoint);
    if (candidate) {
      this.currentGuideLine = candidate;
      return;
    }

    const dx = world.x - this.drawStart.x;
    const dy = world.y - this.drawStart.y;
    const travel = Math.hypot(dx, dy);
    const axisDir = Math.abs(dx) >= Math.abs(dy) ? { x: 1, y: 0 } : { x: 0, y: 1 };
    const axisGuide = { id: 'divider:start-axis', anchor: this.drawStart, dir: axisDir };

    if (!this.currentGuideLine && travel > 12) {
      this.currentGuideLine = axisGuide;
      return;
    }

    if (this.currentGuideLine?.id === 'divider:start-axis') {
      this.currentGuideLine = axisGuide;
    }

    if (this.currentGuideLine && !shouldKeepGuideLine(screenPoint, this.currentGuideLine, 36, 42)) {
      this.currentGuideLine = null;
    }
  }

  getDividerEnd(world) {
    const snapped = this.currentObjectSnap
      ? { x: this.currentObjectSnap.x, y: this.currentObjectSnap.y, snapType: this.currentObjectSnap.type }
      : snap(world.x, world.y, { screenPoint: this.ui.mouseScreen, tolerance: 24 });

    let end = { x: snapped.x, y: snapped.y };
    const hardSnap = snapped.snapType === 'endpoint' || snapped.snapType === 'corner' || snapped.snapType === 'intersection';
    if (this.currentGuideLine && !hardSnap && this.ui.mouseScreen) {
      const axisGuide = getNearestGuideLineAxis(this.ui.mouseScreen, this.currentGuideLine);
      end = projectPointToGuideLineWorld(end, axisGuide);
    }

    return end;
  }
}
