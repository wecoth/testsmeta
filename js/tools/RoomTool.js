// RoomTool.js
import { BaseTool } from './BaseTool.js';
import { appState } from '../state.js';
import { EventBus } from '../eventBus.js';
import { executeCommand } from '../commands/CommandHistory.js';
import { AddRoomCommand } from '../commands/AddRoomCommand.js';
import { computeRoomForPolygon } from '../room.js';  // скоро появится
import {
  findAllIntersections, buildWallGraph, findFaces,
  polygonArea, isPointInPolygon
} from '../geometry.js';

export class RoomTool extends BaseTool {
  constructor(ui) {
    super(ui);
    this.name = 'room';
  }

  activate() {
    this.ui.canvas.style.cursor = 'crosshair';
    this.ui.doRedraw();
  }

  deactivate() {}

  onMouseDown(pos, world, e) {
    const walls = appState.walls;
    const dividers = appState.dividers || [];

    // Стены превращаем в тонкие линии (толщина 0) – используем только оси
    const slimWalls = walls.map(w => ({
      id: w.id,
      x1: w.x1, y1: w.y1, x2: w.x2, y2: w.y2,
      cx1: w.cx1 ?? w.x1, cy1: w.cy1 ?? w.y1,
      cx2: w.cx2 ?? w.x2, cy2: w.cy2 ?? w.y2,
      thickness: 0,
      height: w.height || 2700,
      offset: 'left',
      isDivider: false,
    }));

    const dividerWalls = dividers.map(d => ({
      id: `div_${d.id}`,
      x1: d.x1, y1: d.y1, x2: d.x2, y2: d.y2,
      cx1: d.x1, cy1: d.y1, cx2: d.x2, cy2: d.y2,
      thickness: 0,
      height: 2700,
      offset: 'left',
      isDivider: true,
    }));

    const allWallsForGraph = [...slimWalls, ...dividerWalls];
    if (allWallsForGraph.length < 3) {
      alert('Слишком мало стен – нарисуйте замкнутый контур');
      return false;
    }

    // Строим граф по линиям
    const points = findAllIntersections(allWallsForGraph);
    if (!points || points.length < 3) return false;
    const { vertices, edges } = buildWallGraph(allWallsForGraph, points);
    if (edges.length < 3) return false;

    const faces = findFaces(vertices, edges);
    const clickPoint = { x: world.x, y: world.y };

    for (const face of faces) {
      const poly = face.map(v => ({ x: v.x, y: v.y }));
      if (polygonArea(poly) < 50000) continue;   // игнорируем мусор

      if (isPointInPolygon(clickPoint, poly)) {
        // Нашли нужный полигон
        const room = computeRoomForPolygon(poly);
        if (!room) {
          alert('Не удалось создать комнату – проверьте замкнутость контура');
          return false;
        }
        executeCommand(new AddRoomCommand(room));
        this.ui.doRedraw();
        return true;
      }
    }

    alert('Кликните внутри замкнутой области, ограниченной стенами или разделителями');
    return false;
  }
}
