// ─── UpdateWallCommand.js ─────────────────────────────────────────
// Универсальная команда для любых изменений одной стены:
//   • толщина / высота / длина (моментальные изменения из панели)
//   • resize — растяжка маркером (live feedback в onMouseMove,
//              команда создаётся в onMouseUp)
//
// Паттерн "record-it":
//   1. Вызывающий код снимает before-снапшот ДО мутации.
//   2. Применяет мутацию (напрямую или через addWall/setWallLength/…).
//   3. Снимает after-снапшот ПОСЛЕ мутации.
//   4. Вызывает executeCommand(new UpdateWallCommand(id, before, after)).
//
// execute() (redo) re-applies after-снапшот — при первом вызове
// through executeCommand это идемпотентно (стена уже в after-состоянии).

import { BaseCommand } from './BaseCommand.js';
import { appState } from '../state.js';
import { invalidateJointCache } from '../wall.js';
import { EventBus } from '../eventBus.js';

export class UpdateWallCommand extends BaseCommand {
  /**
   * @param {number} wallId
   * @param {object} before  — снапшот BaseCommand.snapWall() до мутации
   * @param {object} after   — снапшот BaseCommand.snapWall() после мутации
   * @param {string} description
   */
  constructor(wallId, before, after, description) {
    super();
    this.wallId      = wallId;
    this._before     = before;
    this._after      = after;
    this.description = description || 'Изменение стены';
  }

  execute() {  // redo (или первичный "re-apply" сразу после executeCommand)
    const wall = appState.walls.find(w => w.id === this.wallId);
    if (!wall) return;
    Object.assign(wall, this._after);
    invalidateJointCache();
    EventBus.emit('walls:changed');
  }

  undo() {
    const wall = appState.walls.find(w => w.id === this.wallId);
    if (!wall) return;
    Object.assign(wall, this._before);
    invalidateJointCache();
    EventBus.emit('walls:changed');
  }
}
