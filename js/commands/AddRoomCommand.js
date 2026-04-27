// js/commands/AddRoomCommand.js
import { BaseCommand } from './BaseCommand.js';
import { createRoomFromCandidate, deleteRoom } from '../room.js';

export class AddRoomCommand extends BaseCommand {
  constructor(polygon) {
    super();
    this._polygon = polygon;        // массив точек {x,y} полигона кандидата
    this._key = null;               // ключ созданной комнаты (заполнится в execute)
    this.description = 'Добавление комнаты';
  }

  execute() {
    // создаём комнату (ключ генерируется внутри)
    const room = createRoomFromCandidate(this._polygon);
    if (!room) return false;       // комната уже существует или создать не удалось
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
      // пересоздаём комнату из исходного полигона (ключ будет тот же)
      createRoomFromCandidate(this._polygon);
    }
  }
}
