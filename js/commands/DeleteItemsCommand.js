// ─── DeleteItemsCommand.js ────────────────────────────────────────
import { BaseCommand } from './BaseCommand.js';
import { appState } from '../state.js';
import { invalidateJointCache } from '../wall.js';
import { EventBus } from '../eventBus.js';

export class DeleteItemsCommand extends BaseCommand {
  constructor(items) {
    super();
    const wallIds = new Set(items.filter(i => i.type === 'wall').map(i => i.id));
    const openIds = new Set(items.filter(i => i.type === 'opening').map(i => i.id));
    const measureIds = new Set(items.filter(i => i.type === 'measure').map(i => i.id));
    const dividerIds = new Set(items.filter(i => i.type === 'divider').map(i => i.id));
    const roomKeys = new Set(items.filter(i => i.type === 'room').map(i => i.id));   // id комнаты – это её key

    this._walls = appState.walls.filter(w => wallIds.has(w.id)).map(w => ({ ...w }));
    this._openings = appState.openings.filter(o => openIds.has(o.id) || wallIds.has(o.wallId)).map(o => ({ ...o }));
    this._measures = appState.measures?.filter(m => measureIds.has(m.id)).map(m => ({ ...m })) || [];
    this._dividers = appState.dividers?.filter(d => dividerIds.has(d.id)).map(d => ({ ...d })) || [];
    this._rooms = appState.rooms.filter(r => roomKeys.has(r.key)).map(r => ({ ...r }));

    const parts = [];
    if (this._walls.length) parts.push(`${this._walls.length} ст.`);
    if (this._openings.length) parts.push(`${this._openings.length} пр.`);
    if (this._measures.length) parts.push(`${this._measures.length} изм.`);
    if (this._dividers.length) parts.push(`${this._dividers.length} зон`);
    if (this._rooms.length) parts.push(`${this._rooms.length} комн.`);
    this.description = `Удаление: ${parts.join(', ') || 'ничего'}`;
  }

  execute() {
    const wallIds = new Set(this._walls.map(w => w.id));
    const openIds = new Set(this._openings.map(o => o.id));
    const measureIds = new Set(this._measures.map(m => m.id));
    const dividerIds = new Set(this._dividers.map(d => d.id));
    const roomKeys = new Set(this._rooms.map(r => r.key));

    appState.walls    = appState.walls.filter(w => !wallIds.has(w.id));
    appState.openings = appState.openings.filter(o => !openIds.has(o.id));
    if (appState.measures) appState.measures = appState.measures.filter(m => !measureIds.has(m.id));
    if (appState.dividers) appState.dividers = appState.dividers.filter(d => !dividerIds.has(d.id));
    if (appState.rooms) appState.rooms = appState.rooms.filter(r => !roomKeys.has(r.key));

    invalidateJointCache();
    EventBus.emit('walls:changed');
    if (appState.measures) EventBus.emit('measures:changed');
    if (appState.dividers) EventBus.emit('dividers:changed');
    EventBus.emit('rooms:computed');
  }

  undo() {
    appState.walls.push(...this._walls.map(w => ({ ...w })));
    appState.openings.push(...this._openings.map(o => ({ ...o })));
    if (appState.measures) appState.measures.push(...this._measures.map(m => ({ ...m })));
    if (appState.dividers) appState.dividers.push(...this._dividers.map(d => ({ ...d })));
    appState.rooms.push(...this._rooms.map(r => ({ ...r })));

    invalidateJointCache();
    EventBus.emit('walls:changed');
    if (appState.measures) EventBus.emit('measures:changed');
    if (appState.dividers) EventBus.emit('dividers:changed');
    EventBus.emit('rooms:computed');
  }
}
