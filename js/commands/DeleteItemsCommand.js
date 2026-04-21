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

    this._walls = appState.walls.filter(w => wallIds.has(w.id)).map(w => ({ ...w }));
    this._openings = appState.openings.filter(o => openIds.has(o.id) || wallIds.has(o.wallId)).map(o => ({ ...o }));
    this._measures = appState.measures?.filter(m => measureIds.has(m.id)).map(m => ({ ...m })) || [];
    this._dividers = appState.dividers?.filter(d => dividerIds.has(d.id)).map(d => ({ ...d })) || [];

    this.description = `Удаление: ${this._walls.length} ст., ${this._openings.length} пр., ${this._measures.length} изм., ${this._dividers.length} зон`;
  }

  execute() {
    const wallIds = new Set(this._walls.map(w => w.id));
    const openIds = new Set(this._openings.map(o => o.id));
    const measureIds = new Set(this._measures.map(m => m.id));
    const dividerIds = new Set(this._dividers.map(d => d.id));

    appState.walls    = appState.walls.filter(w => !wallIds.has(w.id));
    appState.openings = appState.openings.filter(o => !openIds.has(o.id));
    if (appState.measures) appState.measures = appState.measures.filter(m => !measureIds.has(m.id));
    if (appState.dividers) appState.dividers = appState.dividers.filter(d => !dividerIds.has(d.id));

    invalidateJointCache();
    EventBus.emit('walls:changed');
    if (appState.measures) EventBus.emit('measures:changed');
    if (appState.dividers) EventBus.emit('dividers:changed');
  }

  undo() {
    appState.walls.push(...this._walls.map(w => ({ ...w })));
    appState.openings.push(...this._openings.map(o => ({ ...o })));
    if (appState.measures) appState.measures.push(...this._measures.map(m => ({ ...m })));
    if (appState.dividers) appState.dividers.push(...this._dividers.map(d => ({ ...d })));

    invalidateJointCache();
    EventBus.emit('walls:changed');
    if (appState.measures) EventBus.emit('measures:changed');
    if (appState.dividers) EventBus.emit('dividers:changed');
  }
}
