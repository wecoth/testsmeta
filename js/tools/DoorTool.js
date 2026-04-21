// ─── DoorTool.js ──────────────────────────────────────────────────
import { BaseTool } from './BaseTool.js';
import { executeCommand } from '../commands/CommandHistory.js';
import { AddOpeningCommand } from '../commands/AddOpeningCommand.js';
import { findClosestWall } from '../wall.js';

export class DoorTool extends BaseTool {
  constructor(ui) {
    super(ui);
    this.name = 'door';
    this.hoverOpening = null;
  }

  activate() {
    this.hoverOpening = null;
    this.ui.canvas.style.cursor = 'crosshair';
    this.ui.doRedraw();
  }

  deactivate() {
    this.hoverOpening = null;
  }

  getCursor() {
    return 'crosshair';
  }

  getRenderState() {
    return { hoverOpening: this.hoverOpening };
  }

  onMouseDown(pos, world, e) {
    if (this.hoverOpening) {
      executeCommand(new AddOpeningCommand(this.hoverOpening));
      this.ui.doRedraw();
      return true;
    }
    return false;
  }

  onMouseMove(pos, world, e) {
    const hit = findClosestWall(world.x, world.y);
    if (hit) {
      const w = parseFloat(this.ui.dom.inpDoorWidth?.value) || 900;
      const h = parseFloat(this.ui.dom.inpDoorHeight?.value) || 2100;
      const wlen = Math.hypot(hit.wall.x2 - hit.wall.x1, hit.wall.y2 - hit.wall.y1);
      const angle = Math.atan2(hit.wall.y2 - hit.wall.y1, hit.wall.x2 - hit.wall.x1);
      const nx = -Math.sin(angle), ny = Math.cos(angle);
      const px = hit.wall.x1 + (hit.wall.x2 - hit.wall.x1) * hit.t;
      const py = hit.wall.y1 + (hit.wall.y2 - hit.wall.y1) * hit.t;
      const side = ((world.x - px) * nx + (world.y - py) * ny) >= 0 ? 1 : -1;
      this.hoverOpening = wlen > w + 1
        ? {
            wall: hit.wall,
            t: hit.t,
            width: w,
            height: h,
            type: 'door',
            hinge: this.ui.defaultDoorHinge,
            swing: this.ui.defaultDoorSwing,
            side,
          }
        : null;
    } else {
      this.hoverOpening = null;
    }
    this.ui.updateCoordinatesLabel(world, null, null);
    this.ui.doRedraw();
    return true;
  }

  onKeyDown(e) {
    if (e.key === 'Escape') {
      this.hoverOpening = null;
      this.ui.doRedraw();
      return true;
    }
    return false;
  }
}
