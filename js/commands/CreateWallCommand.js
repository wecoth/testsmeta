// ─── CreateWallCommand.js ─────────────────────────────────────────
import { BaseCommand } from './BaseCommand.js';
import { appState } from '../state.js';
import { addWall, invalidateJointCache } from '../wall.js';
import { EventBus } from '../eventBus.js';

export class CreateWallCommand extends BaseCommand {
  /**
   * @param {object} start    — {x, y}
   * @param {object} end      — {x, y}
   * @param {number} thickness
   * @param {number} height
   * @param {string} offset   — 'center' | 'left' | 'right'
   */
  constructor(start, end, thickness, height, offset) {
    super();
    this.start     = { ...start };
    this.end       = { ...end };
    this.thickness = thickness;
    this.height    = height;
    this.offset    = offset;
    this._wall     = null;   // заполняется при первом execute()
    this.description = 'Создание стены';
  }

  execute() {
    if (this._wall) {
      // redo: повторно добавляем ту же стену с тем же id
      appState.walls.push({ ...this._wall });
      appState.idWall = Math.max(appState.idWall, this._wall.id + 1);
      invalidateJointCache();
    } else {
      // первичное выполнение
      addWall(this.start, this.end, this.thickness, this.height, this.offset);
      this._wall = { ...appState.walls[appState.walls.length - 1] };
      this.description = `Создание стены #${this._wall.id}`;
    }
    EventBus.emit('walls:changed');
  }

  undo() {
    if (!this._wall) return;
    appState.walls    = appState.walls.filter(w => w.id !== this._wall.id);
    // Удаляем проёмы, которые могли быть размещены в этой стене
    appState.openings = appState.openings.filter(o => o.wallId !== this._wall.id);
    invalidateJointCache();
    EventBus.emit('walls:changed');
  }
}
