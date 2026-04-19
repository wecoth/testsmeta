// ─── SHARED APPLICATION STATE ─────────────────────────────────────
import { EventBus } from './eventBus.js';

// Внутреннее хранилище — сырой объект без Proxy
const _state = {
  // ── Planner ──
  walls: [],       // {id, x1,y1,x2,y2, cx1,cy1,cx2,cy2, thickness, height, offset}
  openings: [],    // {id, wallId, t, width, height, type, hinge?, swing?}
  rooms: [],       // computed by room.js
  roomNameOverrides: {},
  idWall: 1,
  idOpen: 1,

  // ── Smeta ──
  logoData: null,
  planData: null,

  // ── UI ──
  activeTab: 'smeta',  // 'planner' | 'smeta'
};

// Proxy-обёртка: любое прямое присвоение свойства верхнего уровня
// автоматически испускает событие 'state:<prop>:changed'.
//
// Важно: мутации вложенных объектов/массивов (push, splice, obj.field = ...)
// через Proxy НЕ перехватываются — это известное ограничение ES Proxy.
// Для таких случаев вызывай updateState() или EventBus.emit() вручную.
//
// Примеры:
//   appState.walls = []         → emit('state:walls:changed', [])  ✓
//   appState.idWall++           → emit('state:idWall:changed', 2)  ✓
//   appState.walls.push(wall)   → НЕТ события, нужен EventBus.emit ручной
export const appState = new Proxy(_state, {
  set(target, prop, value) {
    target[prop] = value;
    EventBus.emit(`state:${String(prop)}:changed`, value);
    return true;
  },

  get(target, prop) {
    return target[prop];
  },
});

// ── Утилита для явного реактивного обновления ──────────────────────
// Используй когда хочешь заменить всё значение (иммутабельный стиль):
//   updateState('walls', [...appState.walls, newWall])
//
// Proxy сам испустит событие state:<key>:changed.
export function updateState(key, newValue) {
  appState[key] = newValue;
}

// ── Draw colours (canvas) — shared between render + snapping ──────
export const DRAW_COLORS = {
  wallFill:            '#cfd4da',
  wallFillSelected:    '#b9c0c8',
  wallStroke:          '#5f6771',
  wallStrokeSelected:  '#353c45',
  wallHatch:           'rgba(95,103,113,0.15)',
  roomLabel:           '#4b5563',
  roomMeta:            '#6b7280',
  windowStroke:        '#8e96a0',
  windowFill:          '#eef1f4',
  windowHover:         'rgba(238,241,244,0.82)',
  doorStroke:          '#a0a7b0',
  doorFill:            '#f4f5f7',
  doorHover:           'rgba(244,245,247,0.82)',
  dimension:           'rgba(71,85,105,0.7)',
  previewFill:         'rgba(120,127,136,0.12)',
  previewStroke:       '#4b5563',
  previewCenterLine:   'rgba(107,114,128,0.35)',
  selectionFill:       'rgba(75,85,99,0.10)',
  selectionStroke:     'rgba(75,85,99,0.78)',
  corner:              '#111827',
  endpoint:            '#374151',
  midpoint:            '#6b7280',
  intersection:        '#111827',
  perpendicular:       '#9ca3af',
  wallFace:            '#4b5563',
  wallAxis:            '#9ca3af',
  guidePrimary:        '#5f6771',
  guideSecondary:      '#9aa1a9',
  handleFill:          '#f8fafc',
  handleStroke:        '#4b5563',
  handleActive:        '#111827',
};

export const ROOM_COLORS  = ['rgba(223,227,231,0.86)'];
export const ROOM_STROKES = ['rgba(120,127,136,0.4)'];
