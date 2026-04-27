// js/commands/AddRoomCommand.js
import { BaseCommand } from './BaseCommand.js';
import { createRoomFromCandidate, deleteRoom } from '../room.js';
import { appState } from '../state.js';

export class AddRoomCommand extends BaseCommand {
  constructor(polygon) {
    super();
    this._polygon = polygon;
    this._key = null;
    this.description = 'Добавление комнаты';
  }

  execute() {
    // Если команда уже выполнялась и комната есть — просто обновим ключ
    if (this._key) {
      const exists = appState.rooms.find(r => r.key === this._key);
      if (exists) return true; // уже в списке, ничего не делаем
      // иначе попробуем создать заново
      const room = createRoomFromCandidate(this._polygon);
      return !!room;
    }

    // Первый вызов – создаём через общую логику
    const room = createRoomFromCandidate(this._polygon);
    if (!room) return false;
    this._key = room.key;
    this.description = `Добавление комнаты "${room.name}"`;
    return true;
  }

  undo() {
    if (this._key) {
      deleteRoom(this._key);
    }
  }

  redo() {
    if (this._key) {
      // При redo комнаты может уже не быть (контур мог измениться)
      if (!appState.rooms.find(r => r.key === this._key)) {
        createRoomFromCandidate(this._polygon);
      }
    }
  }
}
