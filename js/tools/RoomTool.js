// js/tools/RoomTool.js
import { BaseTool } from './BaseTool.js';
import { appState } from '../state.js';
import { EventBus } from '../eventBus.js';
import { executeCommand } from '../commands/CommandHistory.js';
import { AddRoomCommand } from '../commands/AddRoomCommand.js';
import {
  getCandidateAtPoint,
  createRoomFromCandidate
} from '../room.js';
import { polygonArea } from '../geometry.js';
import { toScreen } from '../snapping.js';

export class RoomTool extends BaseTool {
  constructor(ui) {
    super(ui);
    this.name = 'room';
    this.hoveredCandidate = null;   // полигон под курсором (мировые координаты)
    this.hoverLabel = '';           // текст подсказки
    this.labelScreenPos = { x: 0, y: 0 };
  }

  activate() {
    this.ui.canvas.style.cursor = 'crosshair';
    this.hoveredCandidate = null;
    this.ui.doRedraw();
  }

  deactivate() {
    this.hoveredCandidate = null;
    this.ui.doRedraw();
  }

  onMouseMove(pos, world) {
    const old = this.hoveredCandidate;
    // ищем кандидата под курсором
    const poly = getCandidateAtPoint(world);
    if (poly) {
      // убедимся, что комнаты с таким ключём ещё нет (чтобы не предлагать создать дубликат)
      const key = candidateKey(poly);
      if (appState.rooms.some(r => r.key === key)) {
        this.hoveredCandidate = null;
        this.hoverLabel = '';
      } else {
        this.hoveredCandidate = poly;
        const area = (polygonArea(poly) / 1e6).toFixed(2);
        const nextIndex = appState.rooms.length + 1;
        this.hoverLabel = `Комната ${nextIndex}\n${area} м²`;
        // экранные координаты для подсказки (покажем справа-снизу от курсора)
        const sp = toScreen(polygonCentroidSimple(poly).x, polygonCentroidSimple(poly).y);
        this.labelScreenPos = { x: sp.x + 15, y: sp.y + 15 };
      }
    } else {
      this.hoveredCandidate = null;
      this.hoverLabel = '';
    }

    if (old !== this.hoveredCandidate) {
      this.ui.doRedraw(); // перерисуем, чтобы показать/скрыть подсказку
    }
  }

  onMouseDown(pos, world, e) {
    if (!this.hoveredCandidate) {
      alert('Кликните внутри замкнутого контура, образованного стенами или разделителями');
      return false;
    }

    const room = createRoomFromCandidate(this.hoveredCandidate);
    if (!room) {
      alert('Не удалось создать комнату (возможно, она уже существует)');
      return false;
    }

    // выполняем команду (для истории undo/redo)
    executeCommand(new AddRoomCommand(room.polygon, room.key));
    this.hoveredCandidate = null;
    this.hoverLabel = '';
    this.ui.doRedraw();
    return true;
  }

  // Рендер дополнительной информации (вызывается из ui.redraw после основной отрисовки)
  renderOverlay(ctx) {
    if (!this.hoveredCandidate || !this.hoverLabel) return;

    const sp = this.labelScreenPos;
    
    // простой белый фон для читаемости
    const metrics = ctx.measureText(this.hoverLabel.split('\n')[0]); // грубо
    const lines = this.hoverLabel.split('\n');
    const fontSize = 14;
    ctx.save();
    ctx.font = `500 ${fontSize}px Merriweather, Onest, Inter, sans-serif`;
    ctx.fillStyle = '#333';
    ctx.textBaseline = 'top';
    
    // рисуем полупрозрачную плашку
    const lineHeight = fontSize * 1.4;
    const boxWidth = Math.max(...lines.map(l => ctx.measureText(l).width)) + 12;
    const boxHeight = lines.length * lineHeight + 8;
    ctx.fillStyle = 'rgba(255,255,255,0.9)';
    ctx.fillRect(sp.x, sp.y, boxWidth, boxHeight);
    ctx.strokeStyle = '#aaa';
    ctx.strokeRect(sp.x, sp.y, boxWidth, boxHeight);
    
    ctx.fillStyle = '#111';
    lines.forEach((line, idx) => {
      ctx.fillText(line, sp.x + 6, sp.y + 4 + idx * lineHeight);
    });
    
    ctx.restore();
  }
}

// Вспомогательная функция (копия из room.js, чтобы не дублировать)
function candidateKey(poly) {
  const c = polygonCentroidSimple(poly);
  return `${Math.round(c.x/50)*50},${Math.round(c.y/50)*50}`;
}

// Простой центроид для вычислений на лету
function polygonCentroidSimple(poly) {
  if (poly.length === 0) return { x: 0, y: 0 };
  let cx = 0, cy = 0, area = 0;
  for (let i = 0; i < poly.length; i++) {
    const p1 = poly[i];
    const p2 = poly[(i + 1) % poly.length];
    const cross = p1.x * p2.y - p2.x * p1.y;
    area += cross;
    cx += (p1.x + p2.x) * cross;
    cy += (p1.y + p2.y) * cross;
  }
  area /= 2;
  if (Math.abs(area) < 0.0001) {
    cx = poly.reduce((s, p) => s + p.x, 0) / poly.length;
    cy = poly.reduce((s, p) => s + p.y, 0) / poly.length;
    return { x: cx, y: cy };
  }
  return { x: cx / (6 * area), y: cy / (6 * area) };
}
