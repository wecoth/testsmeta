// ─── tools/index.js ───────────────────────────────────────────────
import { SelectTool } from './SelectTool.js';
import { WallTool } from './WallTool.js';
import { WindowTool } from './WindowTool.js';
import { DoorTool } from './DoorTool.js';
import { DividerTool } from './DividerTool.js';

export function createTool(toolId, uiPlanner) {
  switch (toolId) {
    case 'select':  return new SelectTool(uiPlanner);
    case 'wall':    return new WallTool(uiPlanner);
    case 'window':  return new WindowTool(uiPlanner);
    case 'door':    return new DoorTool(uiPlanner);
    case 'divider': return new DividerTool(uiPlanner);
    default:        return null;
  }
}
