// ─── PasteCommand.js ──────────────────────────────────────────────
import { BaseCommand } from './BaseCommand.js';
import { appState } from '../state.js';
import { invalidateJointCache } from '../wall.js';
import { EventBus } from '../eventBus.js';

const PASTE_OFFSET = 300; // мм

export class PasteCommand extends BaseCommand {
  /**
   * @param {object} clipboard — { walls: [...], openings: [...] }
   */
  constructor(clipboard) {
    super();
    this._clipboard      = clipboard;
    this._pastedWalls    = null;   // заполняется при первом execute()
    this._pastedOpenings = null;
    this.description     = `Вставка ${clipboard.walls?.length || 0} ст.`;
  }

  execute() {
    if (!this._pastedWalls) {
      // Первичное выполнение: генерируем новые id и смещение
      const idMap = {};
      this._pastedWalls = this._clipboard.walls.map(w => {
        const newId = appState.idWall++;
        idMap[w.id] = newId;
        return {
          ...w, id: newId,
          x1:  w.x1  + PASTE_OFFSET, y1:  w.y1  + PASTE_OFFSET,
          x2:  w.x2  + PASTE_OFFSET, y2:  w.y2  + PASTE_OFFSET,
          cx1: (w.cx1 ?? w.x1) + PASTE_OFFSET, cy1: (w.cy1 ?? w.y1) + PASTE_OFFSET,
          cx2: (w.cx2 ?? w.x2) + PASTE_OFFSET, cy2: (w.cy2 ?? w.y2) + PASTE_OFFSET,
        };
      });
      this._pastedOpenings = (this._clipboard.openings || []).map(o => ({
        ...o, id: appState.idOpen++, wallId: idMap[o.wallId] ?? o.wallId,
      }));
    }
    // Redo: повторно добавляем те же объекты
    appState.walls.push(...this._pastedWalls.map(w => ({ ...w })));
    appState.openings.push(...this._pastedOpenings.map(o => ({ ...o })));
    // Обновляем счётчики (на случай если redo выполняется после других операций)
    appState.idWall = Math.max(appState.idWall, ...this._pastedWalls.map(w => w.id + 1), 1);
    appState.idOpen = Math.max(appState.idOpen, ...this._pastedOpenings.map(o => o.id + 1), 1);
    invalidateJointCache();
    EventBus.emit('walls:changed');
  }

  undo() {
    if (!this._pastedWalls) return;
    const wallIds = new Set(this._pastedWalls.map(w => w.id));
    const openIds = new Set(this._pastedOpenings.map(o => o.id));
    appState.walls    = appState.walls.filter(w => !wallIds.has(w.id));
    appState.openings = appState.openings.filter(o => !openIds.has(o.id));
    invalidateJointCache();
    EventBus.emit('walls:changed');
  }

  /** Возвращает id вставленных стен (для setSelection после вставки) */
  getPastedWallIds() {
    return this._pastedWalls?.map(w => w.id) ?? [];
  }
}
