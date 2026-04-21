// ─── MoveWallsCommand.js ──────────────────────────────────────────
// Перемещение одной или нескольких стен (drag).
//
// Паттерн "record-it": onMouseMove мутирует стены в реальном времени
// для визуальной обратной связи. onMouseUp создаёт команду с
// before/after позициями и вызывает executeCommand.
//
// execute() re-applies after-позиции — при первом вызове это
// идемпотентно (стены уже на конечных позициях).

import { BaseCommand } from './BaseCommand.js';
import { appState } from '../state.js';
import { invalidateJointCache } from '../wall.js';
import { EventBus } from '../eventBus.js';

export class MoveWallsCommand extends BaseCommand {
  /**
   * @param {Array} beforePositions — [{id, x1,y1,x2,y2,cx1,cy1,cx2,cy2}]
   * @param {Array} afterPositions  — то же, после перемещения
   */
  constructor(beforePositions, afterPositions) {
    super();
    this._before = beforePositions;
    this._after  = afterPositions;
    this.description = `Перемещение ${beforePositions.length} ст.`;
  }

  _apply(positions) {
    for (const pos of positions) {
      const wall = appState.walls.find(w => w.id === pos.id);
      if (wall) Object.assign(wall, pos);
    }
    invalidateJointCache();
    EventBus.emit('walls:changed');
  }

  execute() { this._apply(this._after);  }   // redo (+ first re-apply)
  undo()    { this._apply(this._before); }
}
