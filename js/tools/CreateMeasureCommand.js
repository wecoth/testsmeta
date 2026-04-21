// ─── CreateMeasureCommand.js ──────────────────────────────────────
import { BaseCommand } from './BaseCommand.js';
import { appState } from '../state.js';
import { EventBus } from '../eventBus.js';

export class CreateMeasureCommand extends BaseCommand {
  constructor(x1, y1, x2, y2) {
    super();
    const dist = Math.round(Math.hypot(x2 - x1, y2 - y1));
    this._measure = {
      id: appState.idMeasure,
      x1, y1, x2, y2,
      label: `${dist} мм`,
    };
    this.description = `Рулетка ${dist} мм`;
  }

  execute() {
    const existing = appState.measures.find(m => m.id === this._measure.id);
    if (!existing) {
      appState.measures.push({ ...this._measure });
      appState.idMeasure++;
    }
    EventBus.emit('measures:changed');
  }

  undo() {
    appState.measures = appState.measures.filter(m => m.id !== this._measure.id);
    EventBus.emit('measures:changed');
  }
}
