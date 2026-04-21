// ─── UI-PLANNER.JS (рефакторинг с tools) ──────────────────────────
import { appState, updateState } from './state.js';
import { EventBus } from './eventBus.js';
import { executeCommand, undo, redo, canUndo, canRedo, clearHistory } from './commands/CommandHistory.js';
import { BaseCommand } from './commands/BaseCommand.js';
import { DeleteItemsCommand } from './commands/DeleteItemsCommand.js';
import { RenameRoomCommand } from './commands/RenameRoomCommand.js';
import { updateExpl, getComputedRooms, renameRoom, setWallHeight } from './room.js';
import { setViewport, setModifiers, toScreen, toWorld } from './snapping.js';
import { redraw, initRenderer } from './render.js';
import { createTool } from './tools/index.js';
import { VoiceInput } from './voiceInput.js';
import { UpdateWallCommand } from './commands/UpdateWallCommand.js';

// ── Module state ──────────────────────────────────────────────────
let canvas, canvasWrap;
let tool = 'select';
let activeTool = null;          // экземпляр текущего инструмента
let scale = 0.12, panX = 200, panY = 150;
let shiftDown = false, ctrlDown = false;
let isPanning = false, panStartX, panStartY, panStartOffX, panStartOffY;
let mouseScreen = null;
let selectedItems = [];
let defaultDoorHinge = 'start', defaultDoorSwing = 1;
let wallOffset = 'center';
let clipboard = null;           // { walls, openings }
let voiceKeyPressed = false;

// ── DOM refs ──────────────────────────────────────────────────────
let dom = {};

export function initPlanner(domRefs) {
  dom = domRefs;
  canvas = domRefs.canvas;
  canvasWrap = domRefs.canvasWrap;

  setWallHeight(parseFloat(dom.inpWallHeight?.value) || 2700);
  EventBus.on('rooms:computed', () => {
  updateExpl(dom.explBody, dom.roomCount);
  doRedraw();   // ← ДОБАВИТЬ
});
  EventBus.on('history:changed', updateHistoryBtns);
  EventBus.on('dividers:changed', () => {
    // просто перерисовка, комнаты пересчитаются по подписке в room.js
    doRedraw();
  });

  const redrawOnChange = () => doRedraw();
  EventBus.on('walls:changed', redrawOnChange);
  EventBus.on('openings:changed', redrawOnChange);
  EventBus.on('dividers:changed', redrawOnChange);
  EventBus.on('measures:changed', () => doRedraw());
  
  initRenderer(canvas, canvas.getContext('2d'), () => scale);

  resizeCanvas();
  window.addEventListener('resize', resizeCanvas);

  canvas.addEventListener('mousedown', onMouseDown);
  canvas.addEventListener('mousemove', onMouseMove);
  canvas.addEventListener('mouseup', onMouseUp);
  window.addEventListener('mouseup', onMouseUp);
  canvas.addEventListener('contextmenu', e => e.preventDefault());
  canvas.addEventListener('wheel', onWheel, { passive: false });
  window.addEventListener('keydown', onKeyDown);
  window.addEventListener('keyup', onKeyUp);

  // Инициализация тулбара
  dom.toolGrid?.addEventListener('click', e => {
    const btn = e.target.closest('[data-tool]');
    if (btn) setTool(btn.dataset.tool);
  });

  dom.offsetBtns?.addEventListener('click', e => {
    const btn = e.target.closest('[data-offset]');
    if (!btn) return;
    dom.offsetBtns.querySelectorAll('.offset-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    wallOffset = btn.dataset.offset;
  });

  dom.doorHingeButtons?.addEventListener('click', e => {
    const btn = e.target.closest('[data-default-door-hinge]');
    if (!btn) return;
    defaultDoorHinge = btn.dataset.defaultDoorHinge;
    syncDoorButtons();
    doRedraw();
  });
  dom.doorSwingButtons?.addEventListener('click', e => {
    const btn = e.target.closest('[data-default-door-swing]');
    if (!btn) return;
    defaultDoorSwing = Number(btn.dataset.defaultDoorSwing);
    syncDoorButtons();
    doRedraw();
  });

  // Кнопки
  dom.btnDeleteSelected?.addEventListener('click', () => {
    if (!selectedItems.length) return;
    executeCommand(new DeleteItemsCommand(selectedItems));
    clearSelection();
    doRedraw();
  });

  dom.btnUndo?.addEventListener('click', () => { undo(); onHistoryRestore(); });
  dom.btnRedo?.addEventListener('click', () => { redo(); onHistoryRestore(); });

  dom.btnNew?.addEventListener('click', () => {
    if (!confirm('Создать новый проект? Текущий чертёж будет очищен.')) return;
    updateState('walls', []);
    updateState('openings', []);
    updateState('dividers', []);
    updateState('rooms', []);
    updateState('idWall', 1);
    updateState('idOpen', 1);
    updateState('idDivider', 1);
    updateState('roomNameOverrides', {});
    clearSelection();
    clearHistory();
    EventBus.emit('walls:changed');
    doRedraw();
  });

  dom.btnRecalc?.addEventListener('click', () => {
    EventBus.emit('walls:changed');
    doRedraw();
  });

  dom.btnZoomIn?.addEventListener('click', () => { scale = Math.min(2, scale * 1.25); syncViewport(); doRedraw(); });
  dom.btnZoomOut?.addEventListener('click', () => { scale = Math.max(0.03, scale / 1.25); syncViewport(); doRedraw(); });
  dom.btnZoomReset?.addEventListener('click', () => { scale = 0.12; panX = 200; panY = 150; syncViewport(); doRedraw(); });

  const paramInputs = [dom.inpWallThick, dom.inpWallHeight, dom.inpWindowWidth, dom.inpWindowHeight, dom.inpDoorWidth, dom.inpDoorHeight];
  paramInputs.forEach(inp => {
    if (!inp) return;
    inp.addEventListener('change', () => {
      if (Number(inp.value) < Number(inp.min || 0)) inp.value = inp.min || 0;
      if (inp === dom.inpWallHeight) setWallHeight(parseFloat(inp.value) || 2700);
      EventBus.emit('walls:changed');
      doRedraw();
    });
    inp.addEventListener('focus', e => e.target.select());
  });

  dom.explBody?.addEventListener('focusin', e => { if (e.target.matches('.room-name-input')) e.target.select(); });
  dom.explBody?.addEventListener('keydown', e => {
    if (e.target.matches('.room-name-input') && e.key === 'Enter') { e.preventDefault(); e.target.blur(); }
  });
  dom.explBody?.addEventListener('change', e => {
    if (!e.target.matches('.room-name-input')) return;
    const key = e.target.dataset.roomKey;
    const newName = e.target.value || e.target.dataset.roomDefault || '';
    executeCommand(new RenameRoomCommand(key, newName));
    doRedraw();
  });

  dom.btnImportRooms?.addEventListener('click', () => {
    const rooms = getComputedRooms();
    if (!rooms.length) { alert('Нарисуйте план и пересчитайте помещения'); return; }
    window._smetaModule?.importRoomsFromPlanner(rooms);
  });

  VoiceInput.init();

  setTool('select');
  syncDoorButtons();
  clearHistory();
  doRedraw();
}

// ── Вспомогательные функции ───────────────────────────────────────

function syncViewport() {
  setViewport(scale, panX, panY);
}

export function doRedraw() {
  if (!canvas || !canvas.getContext) return;
  syncViewport();
  const toolState = activeTool ? activeTool.getRenderState() : {};
  const plannerState = {
    scale, selectedItems, tool,
    defaultDoorHinge, defaultDoorSwing,
    wallOffset,
    mouseScreen, isPanning,
    inpWallThick: dom.inpWallThick,
    lengthOverlay: dom.lengthOverlay,
    lengthLabel: dom.lengthLabel,
    lblLen: dom.lblLen,
    lblLenVal: dom.lblLenVal,
    ...toolState,
  };
  redraw(plannerState);
}

function resizeCanvas() {
  const r = canvasWrap.getBoundingClientRect();
  canvas.width = r.width; canvas.height = r.height;
  doRedraw();
}

export function clearSelection() {
  selectedItems = [];
  if (dom.editPanel) dom.editPanel.style.display = 'none';
  if (dom.editContent) dom.editContent.innerHTML = '';
  syncDoorButtons();
  doRedraw();
}

export function setSelection(items) {
  const seen = new Set();
  const unique = [];
  for (const i of items) {
    const k = `${i.type}:${i.id}`;
    if (!seen.has(k)) { seen.add(k); unique.push(i); }
  }
  selectedItems = unique;
  if (dom.editPanel) dom.editPanel.style.display = selectedItems.length ? 'block' : 'none';
  updateEditPanel();
  syncDoorButtons();
  doRedraw();
}

export function selectObject(type, id) {
  setSelection([{ type, id }]);
}

export function toggleSelection(type, id) {
  const k = `${type}:${id}`;
  if (selectedItems.some(i => `${i.type}:${i.id}` === k)) {
    setSelection(selectedItems.filter(i => `${i.type}:${i.id}` !== k));
  } else {
    setSelection([...selectedItems, { type, id }]);
  }
}

function updateEditPanel() {
  if (!dom.editContent) return;
  if (!selectedItems.length) { dom.editContent.innerHTML = ''; return; }
  if (selectedItems.length > 1) {
    const wc = selectedItems.filter(i => i.type === 'wall').length;
    const oc = selectedItems.filter(i => i.type === 'opening').length;
    dom.editContent.innerHTML = `<div class="edit-row"><label>Выбрано</label><b>${selectedItems.length}</b></div>
      <div class="edit-row"><label>Стены</label><b>${wc}</b></div>
      <div class="edit-row"><label>Проёмы</label><b>${oc}</b></div>`;
    return;
  }
  
  const it = selectedItems[0];
  if (it.type === 'wall') {
    const w = appState.walls.find(v => v.id === it.id);
    if (!w) return;
    const len = Math.round(Math.hypot(w.x2 - w.x1, w.y2 - w.y1));
    const offsetLabels = { left: 'Слева', center: 'Центр', right: 'Справа' };
    const offsetOptions = ['left', 'center', 'right'].map(v => 
      `<button class="choice-btn compact${w.offset === v ? ' active' : ''}" type="button" data-wall-offset="${v}">${offsetLabels[v]}</button>`
    ).join('');
    
    dom.editContent.innerHTML = `
      <div class="param-group">
        <div class="param-label">Длина <span class="param-unit">мм</span></div>
        <div class="param-input-wrap"><input class="param-input" type="number" min="1" step="1" value="${len}" data-wall-length-input><span class="param-input-unit">мм</span></div>
      </div>
      <div class="param-group">
        <div class="param-label">Смещение</div>
        <div class="choice-grid">${offsetOptions}</div>
      </div>
      <div class="param-group">
        <div class="param-label">Толщина <span class="param-unit">мм</span></div>
        <div class="param-input-wrap"><input class="param-input" type="number" min="50" max="1000" step="10" value="${w.thickness}" data-wall-thick-input><span class="param-input-unit">мм</span></div>
      </div>
      <div class="param-group">
        <div class="param-label">Высота <span class="param-unit">мм</span></div>
        <div class="param-input-wrap"><input class="param-input" type="number" min="1000" max="6000" step="100" value="${w.height}" data-wall-height-input><span class="param-input-unit">мм</span></div>
      </div>
    `;
    
    // Обработчики кнопок смещения
    dom.editContent.querySelectorAll('[data-wall-offset]').forEach(btn => {
      btn.addEventListener('click', e => {
        const newOffset = btn.dataset.wallOffset;
        const before = BaseCommand.snapWall(w);
        w.offset = newOffset;
        // Пересчёт контура стены на основе нового offset
        import('./wall.js').then(({ recalculateContourFromBase }) => {
          recalculateContourFromBase(w);
          const after = BaseCommand.snapWall(w);
          executeCommand(new UpdateWallCommand(w.id, before, after, 'Изменение смещения'));
          doRedraw();
        });
      });
    });
    
    // Обработчик изменения длины
    const lengthInput = dom.editContent.querySelector('[data-wall-length-input]');
    if (lengthInput) {
      lengthInput.addEventListener('change', e => {
        const val = Math.max(20, parseFloat(e.target.value) || 0);
        const before = BaseCommand.snapWall(w);
        import('./wall.js').then(({ setWallLength }) => {
          setWallLength(w, val, 'start');
          const after = BaseCommand.snapWall(w);
          executeCommand(new UpdateWallCommand(w.id, before, after, 'Изменение длины'));
          doRedraw();
        });
      });
    }
    
    // Толщина
    const thickInput = dom.editContent.querySelector('[data-wall-thick-input]');
    if (thickInput) {
      thickInput.addEventListener('change', e => {
        const v = Math.max(50, Number(e.target.value) || 200);
        const before = BaseCommand.snapWall(w);
        w.thickness = v;
        import('./wall.js').then(({ recalculateContourFromBase }) => {
          recalculateContourFromBase(w);
          const after = BaseCommand.snapWall(w);
          executeCommand(new UpdateWallCommand(w.id, before, after, 'Изменение толщины'));
          doRedraw();
        });
      });
    }
    
    // Высота
    const heightInput = dom.editContent.querySelector('[data-wall-height-input]');
    if (heightInput) {
      heightInput.addEventListener('change', e => {
        const v = Math.max(1000, Number(e.target.value) || 2700);
        const before = BaseCommand.snapWall(w);
        w.height = v;
        const after = BaseCommand.snapWall(w);
        executeCommand(new UpdateWallCommand(w.id, before, after, 'Изменение высоты'));
        doRedraw();
      });
    }
  } else if (it.type === 'opening') {
    const op = appState.openings.find(o => o.id === it.id);
    if (!op) return;
    const tl = op.type === 'window' ? 'Окно' : 'Дверь';
    let html = `<div class="edit-row"><label>Тип</label><b>${tl}</b></div>
      <div class="edit-row"><label>Ширина</label><b>${op.width} мм</b></div>
      <div class="edit-row"><label>Высота</label><b>${op.height} мм</b></div>`;
    if (op.type === 'door') {
      html += `<div class="param-group" style="margin-top:6px"><div class="param-label">Петля</div>
        <div class="choice-grid"><button class="choice-btn compact" type="button" data-edit-door-hinge="start">Слева</button><button class="choice-btn compact" type="button" data-edit-door-hinge="end">Справа</button></div></div>
        <div class="param-group"><div class="param-label">Открывание</div>
        <div class="choice-grid"><button class="choice-btn compact" type="button" data-edit-door-swing="-1">На себя</button><button class="choice-btn compact" type="button" data-edit-door-swing="1">От себя</button></div></div>`;
    }
    dom.editContent.innerHTML = html;
  }
  syncDoorButtons();
}

function updateHistoryBtns() {
  if (dom.btnUndo) dom.btnUndo.disabled = !canUndo();
  if (dom.btnRedo) dom.btnRedo.disabled = !canRedo();
}

function onHistoryRestore() {
  clearSelection();
  if (activeTool) activeTool.deactivate();
  updateHistoryBtns();
  doRedraw();
}

function syncDoorButtons() { /* ... как раньше ... */ }

export function setTool(t) {
  if (activeTool) activeTool.deactivate();
  tool = t;

  // Создаём объект ui с актуальными геттерами для изменяемых свойств
  const uiContext = {
    canvas,
    dom,
    get tool() { return tool; },
    get selectedItems() { return selectedItems; },
    get shiftDown() { return shiftDown; },
    get ctrlDown() { return ctrlDown; },
    get wallOffset() { return wallOffset; },
    get defaultDoorHinge() { return defaultDoorHinge; },
    get defaultDoorSwing() { return defaultDoorSwing; },
    get voiceKeyPressed() { return voiceKeyPressed; },
    get mouseScreen() { return mouseScreen; },
    doRedraw: () => doRedraw(),
    clearSelection: () => clearSelection(),
    setSelection: (items) => setSelection(items),
    selectObject: (type, id) => selectObject(type, id),
    toggleSelection: (type, id) => toggleSelection(type, id),
    updateCoordinatesLabel: (world, snap, track) => updateCoordinatesLabel(world, snap, track),
    clearTracking: () => {},
    debouncedComputeRooms: () => { EventBus.emit('walls:changed'); },
  };

  activeTool = createTool(tool, uiContext);
  if (activeTool) activeTool.activate();
  
  document.querySelectorAll('.tool-btn').forEach(b => b.classList.remove('active'));
  document.getElementById('tool' + t.charAt(0).toUpperCase() + t.slice(1))?.classList.add('active');
  const labels = { select: 'Выбор', wall: 'Стена', window: 'Окно', door: 'Дверь', divider: 'Зона', measure: 'Рулетка' };
  if (dom.lblTool) dom.lblTool.textContent = labels[t] || t;
  
  canvas.style.cursor = activeTool ? activeTool.getCursor() : 'default';
  document.getElementById('windowParams')?.classList.toggle('active', t === 'window');
  document.getElementById('doorParams')?.classList.toggle('active', t === 'door');
  
  if (t !== 'select') clearSelection();
  doRedraw();
}

export function clearTracking() {
  // Используется инструментами
}

export function updateCoordinatesLabel(world, objectSnap, trackingPoint) {
  // Обновление статусбара
  if (dom.lblCoords) {
    let text = `X: ${Math.round(world.x)} мм  Y: ${Math.round(world.y)} мм`;
    if (objectSnap) text += `  ·  ${objectSnap.label}`;
    if (trackingPoint) {
      const dist = Math.hypot(world.x - trackingPoint.x, world.y - trackingPoint.y);
      text += `  ·  📏 ${Math.round(dist)} мм`;
    }
    dom.lblCoords.textContent = text;
  }

  // Обновление всплывающего окошка у курсора (для ввода смещения или расстояния)
    if (dom.rulerTooltip) {
    let tooltipText = '';
    let showTooltip = false;
    
    if (activeTool && activeTool.offsetMode) {
      tooltipText = `↔ ${activeTool.offsetInput || '0'} мм`;
      showTooltip = true;
    } else if (trackingPoint && activeTool?.isDrawing && activeTool?.name !== 'measure') {
      // Для рулетки тултип не показываем — размер отображается прямо на линии
      let dist;
      const dir = activeTool?.trackingDirection;
      if (dir) {
        const dx = world.x - trackingPoint.x;
        const dy = world.y - trackingPoint.y;
        dist = Math.abs(dx * dir.x + dy * dir.y);
      } else {
        dist = Math.hypot(world.x - trackingPoint.x, world.y - trackingPoint.y);
      }
      tooltipText = `📏 ${Math.round(dist)} мм`;
      showTooltip = true;
    }
    
    if (showTooltip) {
      dom.rulerTooltip.textContent = tooltipText;
      dom.rulerTooltip.style.display = 'block';
      const screen = toScreen(world.x, world.y);
      dom.rulerTooltip.style.left = (screen.x + 20) + 'px';
      dom.rulerTooltip.style.top  = (screen.y - 30) + 'px';
    } else {
      dom.rulerTooltip.style.display = 'none';
    }
  }
}
// ── Обработчики событий ───────────────────────────────────────────

function getCanvasPos(e) {
  const r = canvas.getBoundingClientRect();
  return { x: e.clientX - r.left, y: e.clientY - r.top };
}

function onMouseDown(e) {
  if (e.button === 2 || e.button === 1) {
    isPanning = true;
    panStartX = e.clientX; panStartY = e.clientY;
    panStartOffX = panX; panStartOffY = panY;
    canvas.style.cursor = 'grabbing';
    e.preventDefault();
    return;
  }
  const pos = getCanvasPos(e);
  const world = toWorld(pos.x, pos.y);
  mouseScreen = { x: pos.x, y: pos.y };

  if (activeTool) {
    const handled = activeTool.onMouseDown(pos, world, e);
    if (handled) return;
  }

  // Если инструмент не обработал (например, select при клике мимо)
  if (tool !== 'select' && selectedItems.length && !shiftDown) {
    clearSelection();
  }
}

function onMouseMove(e) {
  if (isPanning) {
    panX = panStartOffX + (e.clientX - panStartX);
    panY = panStartOffY + (e.clientY - panStartY);
    syncViewport();
    doRedraw();
    return;
  }
  const pos = getCanvasPos(e);
  const world = toWorld(pos.x, pos.y);
  mouseScreen = { x: pos.x, y: pos.y };
  setModifiers(shiftDown, ctrlDown);

  if (activeTool) {
    activeTool.onMouseMove(pos, world, e);
  }

  if (!activeTool) {
    updateCoordinatesLabel(world, null, null);
    doRedraw();
  }
}

function onMouseUp(e) {
  if (isPanning) {
    isPanning = false;
    canvas.style.cursor = activeTool ? activeTool.getCursor() : 'default';
    doRedraw();
    return;
  }
  const pos = getCanvasPos(e);
  const world = toWorld(pos.x, pos.y);
  mouseScreen = { x: pos.x, y: pos.y };

  if (activeTool) {
    activeTool.onMouseUp(pos, world, e);
  }
}

function onWheel(e) {
  e.preventDefault();
  const pos = getCanvasPos(e);
  const factor = e.deltaY < 0 ? 1.12 : 0.88;
  const newScale = Math.min(2, Math.max(0.03, scale * factor));
  panX = pos.x - (pos.x - panX) * (newScale / scale);
  panY = pos.y - (pos.y - panY) * (newScale / scale);
  scale = newScale;
  syncViewport();
  doRedraw();
}

function onKeyDown(e) {
  const editable = e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' || e.target.isContentEditable;

  // Ctrl+C
  if (!editable && (e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'c') {
    if (selectedItems.length) {
      const wallIds = new Set(selectedItems.filter(i => i.type === 'wall').map(i => i.id));
      const walls = appState.walls.filter(w => wallIds.has(w.id)).map(w => ({ ...w }));
      const openings = appState.openings.filter(o => wallIds.has(o.wallId)).map(o => ({ ...o }));
      clipboard = { walls, openings };
    }
    e.preventDefault(); return;
  }

  // Ctrl+V
  if (!editable && (e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'v') {
    if (clipboard?.walls?.length) {
      import('./commands/PasteCommand.js').then(({ PasteCommand }) => {
        const cmd = new PasteCommand(clipboard);
        executeCommand(cmd);
        setSelection(cmd.getPastedWallIds().map(id => ({ type: 'wall', id })));
        doRedraw();
      });
    }
    e.preventDefault(); return;
  }

  // Ctrl+Z / Ctrl+Y
  if (!editable && (e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') {
    e.preventDefault();
    if (e.shiftKey) { redo(); } else { undo(); }
    onHistoryRestore(); return;
  }
  if (!editable && (e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'y') {
    e.preventDefault(); redo(); onHistoryRestore(); return;
  }

  // Модификаторы
  if (e.key === 'Shift') { shiftDown = true; setModifiers(true, ctrlDown); updateSnapBadge(); }
  if (e.key === 'Control') { ctrlDown = true; setModifiers(shiftDown, true); updateSnapBadge(); }

  // Инструменты по клавишам
  if (!editable && !e.ctrlKey && !e.metaKey) {
    if (e.key === 'v' || e.key === 'V') setTool('select');
    if (e.key === 'w' || e.key === 'W') setTool('wall');
    if (e.key === 'o' || e.key === 'O') setTool('window');
    if (e.key === 'd' || e.key === 'D') setTool('door');
    if (e.key === 'l' || e.key === 'L') setTool('divider');
  }

  // Делегирование активному инструменту
  if (activeTool && !editable) {
    const handled = activeTool.onKeyDown(e);
    if (handled) return;
  }

  // Общие клавиши
  if (e.key === 'Escape') {
    if (activeTool) activeTool.onKeyDown(e); // пусть инструмент тоже узнает
    clearSelection();
    doRedraw();
  }
}

function onKeyUp(e) {
  if (e.key === 'Shift') { shiftDown = false; setModifiers(false, ctrlDown); updateSnapBadge(); }
  if (e.key === 'Control') { ctrlDown = false; setModifiers(shiftDown, false); updateSnapBadge(); }
  if (activeTool) activeTool.onKeyUp(e);
}

function updateSnapBadge() {
  if (!dom.snapBadge) return;
  dom.snapBadge.textContent = (shiftDown && ctrlDown) ? 'Привязка: 100 мм'
    : shiftDown ? 'Привязка: 10 мм' : 'Привязка: 1 мм';
}

export function getViewport() { return { scale, panX, panY }; }

// Экспорт для совместимости с main.js и другими модулями
export const forceRedraw = doRedraw;
