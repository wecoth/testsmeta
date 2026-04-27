//AddRoomCommand.js
import { BaseCommand } from './BaseCommand.js';
import { appState } from '../state.js';
import { EventBus } from '../eventBus.js';

export class AddRoomCommand extends BaseCommand {
  constructor(roomData) {
    super();
    this._roomData = roomData;   // готовый объект комнаты
    this.description = `Добавление комнаты "${roomData.name}"`;
  }

  execute() {
    appState.rooms.push({ ...this._roomData });
    EventBus.emit('rooms:computed');
  }

  undo() {
    appState.rooms = appState.rooms.filter(r => r.key !== this._roomData.key);
    EventBus.emit('rooms:computed');
  }
}
