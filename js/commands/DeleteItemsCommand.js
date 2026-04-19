// ─── DeleteItemsCommand.js ────────────────────────────────────────
import { BaseCommand } from './BaseCommand.js';
import { appState } from '../state.js';
import { invalidateJointCache } from '../wall.js';
import { EventBus } from '../eventBus.js';

export class DeleteItemsCommand extends BaseCommand {
  /**
   * Конструктор вызывается ДО удаления: снапшот объектов берётся здесь.
   * @param {Array} items — [{ type: 'wall'|'opening', id }]
   */
  constructor(items) {
    super();
    const wallIds = new Set(items.filter(i => i.type === 'wall').map(i => i.id));
    const openIds = new Set(items.filter(i => i.type === 'opening').map(i => i.id));

    // Сохраняем удаляемые стены
    this._walls = appState.walls
      .filter(w => wallIds.has(w.id))
      .map(w => ({ ...w }));

    // Сохраняем удаляемые проёмы: явно выбранные + все принадлежащие удаляемым стенам
    this._openings = appState.openings
      .filter(o => openIds.has(o.id) || wallIds.has(o.wallId))
      .map(o => ({ ...o }));

    this.description = `Удаление: ${this._walls.length} ст., ${this._openings.length} пр.`;
  }

  execute() {
    // Первичное удаление И redo
    const wallIds = new Set(this._walls.map(w => w.id));
    const openIds = new Set(this._openings.map(o => o.id));
    appState.walls    = appState.walls.filter(w => !wallIds.has(w.id));
    appState.openings = appState.openings.filter(o => !openIds.has(o.id));
    invalidateJointCache();
    EventBus.emit('walls:changed');
  }

  undo() {
    // Восстанавливаем в конец массива (порядок не критичен для рендера)
    appState.walls.push(...this._walls.map(w => ({ ...w })));
    appState.openings.push(...this._openings.map(o => ({ ...o })));
    invalidateJointCache();
    EventBus.emit('walls:changed');
  }
}
