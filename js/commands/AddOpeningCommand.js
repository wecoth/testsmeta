// ─── AddOpeningCommand.js ─────────────────────────────────────────
import { BaseCommand } from './BaseCommand.js';
import { appState } from '../state.js';
import { addOpening } from '../opening.js';
import { EventBus } from '../eventBus.js';

export class AddOpeningCommand extends BaseCommand {
  /**
   * @param {object} hoverOpening — {wall, t, width, height, type, hinge, swing, side}
   */
  constructor(hoverOpening) {
    super();
    // Копируем параметры; wall — ссылка, но нам нужен только wallId для undo
    this._ho      = hoverOpening;
    this._opening = null;   // заполняется при первом execute()
    this.description = `Добавление ${hoverOpening.type === 'window' ? 'окна' : 'двери'}`;
  }

  execute() {
    if (this._opening) {
      // redo: восстанавливаем тот же проём с тем же id
      appState.openings.push({ ...this._opening });
      appState.idOpen = Math.max(appState.idOpen, this._opening.id + 1);
    } else {
      // первичное выполнение
      const { wall, t, width, height, type, hinge, swing, side } = this._ho;
      addOpening(wall, t, width, height, type, { hinge, swing, side });
      this._opening = { ...appState.openings[appState.openings.length - 1] };
    }
    EventBus.emit('walls:changed');
  }

  undo() {
    if (!this._opening) return;
    appState.openings = appState.openings.filter(o => o.id !== this._opening.id);
    EventBus.emit('walls:changed');
  }
}
