// ─── tools/index.js ───────────────────────────────────────────────
import { SelectTool } from './SelectTool.js';
import { WallTool } from './WallTool.js';
import { WindowTool } from './WindowTool.js';
import { DoorTool } from './DoorTool.js';
import { DividerTool } from './DividerTool.js';
import { MeasureTool } from './MeasureTool.js';

export function createTool(toolId, uiPlanner) {
  switch (toolId) {
    case 'select':  return new SelectTool(uiPlanner);
    case 'wall':    return new WallTool(uiPlanner);
    case 'window':  return new WindowTool(uiPlanner);
    case 'door':    return new DoorTool(uiPlanner);
    case 'divider': return new DividerTool(uiPlanner);
    case 'measure': return new MeasureTool(uiPlanner);
    case 'room':    return new RoomTool(uiPlanner);   // <-- добавьте
    default:        return null;
  }
}
