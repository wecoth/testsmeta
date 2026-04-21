// ─── CreateDividerCommand.js ──────────────────────────────────────
import { BaseCommand } from './BaseCommand.js';
import { appState } from '../state.js';
import { EventBus } from '../eventBus.js';

export class CreateDividerCommand extends BaseCommand {
  constructor(x1, y1, x2, y2) {
    super();
    this._divider = {
      id: appState.idDivider,
      x1, y1, x2, y2,
    };
    this.description = `Линия зонирования`;
  }

  execute() {
    const existing = appState.dividers.find(d => d.id === this._divider.id);
    if (!existing) {
      appState.dividers.push({ ...this._divider });
      appState.idDivider++;
    }
    EventBus.emit('dividers:changed');
  }

  undo() {
    appState.dividers = appState.dividers.filter(d => d.id !== this._divider.id);
    EventBus.emit('dividers:changed');
  }
}
