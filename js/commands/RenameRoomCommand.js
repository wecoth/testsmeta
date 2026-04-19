// ─── RenameRoomCommand.js ─────────────────────────────────────────
import { BaseCommand } from './BaseCommand.js';
import { appState } from '../state.js';
import { renameRoom } from '../room.js';
import { EventBus } from '../eventBus.js';

export class RenameRoomCommand extends BaseCommand {
  /**
   * Конструктор вызывается ДО переименования.
   * @param {string} roomKey  — ключ помещения (floor:X:Y или id)
   * @param {string} newName
   */
  constructor(roomKey, newName) {
    super();
    this.roomKey  = roomKey;
    this.newName  = newName;
    // Текущее имя (может быть undefined если комната ещё не переименовывалась)
    this._oldName = appState.roomNameOverrides[roomKey];
    this.description = `Переименование: "${newName}"`;
  }

  execute() {
    renameRoom(this.roomKey, this.newName);
    EventBus.emit('rooms:computed');
  }

  undo() {
    if (this._oldName !== undefined) {
      appState.roomNameOverrides[this.roomKey] = this._oldName;
      renameRoom(this.roomKey, this._oldName);
    } else {
      delete appState.roomNameOverrides[this.roomKey];
    }
    EventBus.emit('rooms:computed');
  }
}
