// ─── DividerTool.js ───────────────────────────────────────────────
import { BaseTool } from './BaseTool.js';
import { appState } from '../state.js';
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
      const extended = this.extendDividerToWalls(this.drawStart, end);
      const finalStart = extended ? extended.start : this.drawStart;
      const finalEnd = extended ? extended.end : end;
      const len = Math.hypot(finalEnd.x - finalStart.x, finalEnd.y - finalStart.y);
      if (len > 1) {
        executeCommand(new CreateDividerCommand(finalStart.x, finalStart.y, finalEnd.x, finalEnd.y));
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

    if (this.currentGuideLine && shouldKeepGuideLine(screenPoint, this.currentGuideLine, 54, 70)) {
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

    if (this.currentGuideLine && !shouldKeepGuideLine(screenPoint, this.currentGuideLine, 54, 70)) {
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

  intersectInfiniteLineWithSegment(origin, dir, a, b) {
    const sx = b.x - a.x;
    const sy = b.y - a.y;
    const denom = dir.x * sy - dir.y * sx;
    if (Math.abs(denom) < 1e-6) return null;

    const qx = a.x - origin.x;
    const qy = a.y - origin.y;
    const t = (qx * sy - qy * sx) / denom;
    const u = (qx * dir.y - qy * dir.x) / denom;
    if (u < -0.02 || u > 1.02) return null;

    return { t, x: origin.x + dir.x * t, y: origin.y + dir.y * t };
  }

  extendDividerToWalls(start, end) {
    const len = Math.hypot(end.x - start.x, end.y - start.y);
    if (len < 10 || !Array.isArray(appState.walls) || appState.walls.length < 1) return null;

    const dir = { x: (end.x - start.x) / len, y: (end.y - start.y) / len };
    const ts = [];

    for (const wall of appState.walls) {
      const a = { x: wall.cx1 ?? wall.x1, y: wall.cy1 ?? wall.y1 };
      const b = { x: wall.cx2 ?? wall.x2, y: wall.cy2 ?? wall.y2 };
      const hit = this.intersectInfiniteLineWithSegment(start, dir, a, b);
      if (!hit) continue;
      ts.push(hit.t);
    }

    if (ts.length < 2) return null;
    ts.sort((a, b) => a - b);

    const dedup = [];
    for (const t of ts) {
      if (!dedup.length || Math.abs(dedup[dedup.length - 1] - t) > 2) dedup.push(t);
    }
    if (dedup.length < 2) return null;

    const mid = len / 2;
    const left = dedup.filter(t => t <= mid + 1);
    const right = dedup.filter(t => t >= mid - 1);
    if (!left.length || !right.length) return null;

    const t1 = left[left.length - 1];
    const t2 = right[0];
    if (!Number.isFinite(t1) || !Number.isFinite(t2) || (t2 - t1) < 50) return null;

    return {
      start: { x: start.x + dir.x * t1, y: start.y + dir.y * t1 },
      end: { x: start.x + dir.x * t2, y: start.y + dir.y * t2 },
    };
  }
}
