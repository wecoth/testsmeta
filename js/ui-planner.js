// ─── UI-PLANNER.JS ─────────────────────────────────────────────────
import { appState, updateState } from './state.js';
import { EventBus } from './eventBus.js';
import {
  addWall, findClosestWall, findClosestWallSel,
  getWallContourPoint, updateWallGeometry, setWallLength, getWallLength,
  invalidateJointCache, recalculateContourFromBase,
} from './wall.js';
import { addOpening, findClosestOpening, updateDoorOpening } from './opening.js';
import { updateExpl, getComputedRooms, renameRoom, setWallHeight } from './room.js';
import {
  snap, setViewport, setModifiers, toScreen, toWorld,
  findObjectSnapCandidate, findGuideCandidate, getNearestGuideAxis,
  projectPointToGuideLineWorld, getSnappedWallResizePoint,
  getTrackingLines, snapToTrackingLines,
} from './snapping.js';
import {
  redraw, initRenderer, getOpeningScreenBounds,
  hitTestWallResizeHandle, boundsIntersect,
} from './render.js';
import { VoiceInput } from './voiceInput.js';

// ── Stage 5: Command Pattern ──────────────────────────────────────
import { executeCommand, undo, redo, canUndo, canRedo, clearHistory } from './commands/CommandHistory.js';
import { BaseCommand }         from './commands/BaseCommand.js';
import { CreateWallCommand }   from './commands/CreateWallCommand.js';
import { DeleteItemsCommand }  from './commands/DeleteItemsCommand.js';
import { AddOpeningCommand }   from './commands/AddOpeningCommand.js';
import { UpdateWallCommand }   from './commands/UpdateWallCommand.js';
import { MoveWallsCommand }    from './commands/MoveWallsCommand.js';
import { PasteCommand }        from './commands/PasteCommand.js';
import { RenameRoomCommand }   from './commands/RenameRoomCommand.js';

// ── Module state ──────────────────────────────────────────────────
let canvas, canvasWrap;
let tool = 'select';
let isDrawing = false, drawStart = null, drawEnd = null;
let chainMode = false, lengthInput = '', lengthMode = false;
let wallOffset = 'center';
let hoverOpening = null;
let hoverItem = null;
let defaultDoorHinge = 'start', defaultDoorSwing = 1;
let selectedItems = [], wallResizeState = null, wallLengthAnchor = 'start';
let scale = 0.12, panX = 200, panY = 150;
let shiftDown = false, ctrlDown = false;
let isPanning = false, panStartX, panStartY, panStartOffX, panStartOffY;
let mouseScreen = null, selectBoxStart = null, selectBoxCurrent = null, selectClickCandidate = null;
let currentGuideLine = null, currentObjectSnap = null;
// Drag-перемещение выделенных объектов
let dragState = null; // { startWorld, lastWorld, wallSnapshots, openingSnapshots }
// Буфер копирования
let clipboard = null; // { walls, openings }
// Голосовой ввод
let voiceKeyPressed = false;
// Stage 3: отслеживание точки привязки (tracking lines)
let _snapHoverTimer    = null;
let _snapHoverKey      = null;
let activeTrackingPoint = null;

// ── DOM refs ──────────────────────────────────────────────────────
let dom = {};

export function initPlanner(domRefs) {
  dom = domRefs;
  canvas = domRefs.canvas;
  canvasWrap = domRefs.canvasWrap;

  // Stage 2: цепочка walls:changed → computeRooms → rooms:computed → updateExpl
  setWallHeight(parseFloat(dom.inpWallHeight?.value) || 2700);
  EventBus.on('rooms:computed', () => {
    updateExpl(dom.explBody, dom.roomCount);
  });

  // Stage 5: кнопки undo/redo обновляются автоматически при любом изменении истории
  EventBus.on('history:changed', updateHistoryBtns);

  initRenderer(canvas, canvas.getContext('2d'), () => scale);

  resizeCanvas();
  window.addEventListener('resize', resizeCanvas);

  canvas.addEventListener('mousedown', onMouseDown);
  canvas.addEventListener('mousemove', onMouseMove);
  canvas.addEventListener('mouseup',   onMouseUp);
  window.addEventListener('mouseup',   onMouseUp);
  canvas.addEventListener('contextmenu', e => e.preventDefault());
  canvas.addEventListener('wheel', onWheel, { passive: false });
  window.addEventListener('keydown', onKeyDown);
  window.addEventListener('keyup',   onKeyUp);

  // Tool buttons (event delegation)
  dom.toolGrid?.addEventListener('click', e => {
    const btn = e.target.closest('[data-tool]');
    if (btn) setTool(btn.dataset.tool);
  });

  // Wall offset buttons (delegation)
  dom.offsetBtns?.addEventListener('click', e => {
    const btn = e.target.closest('[data-offset]');
    if (!btn) return;
    dom.offsetBtns.querySelectorAll('.offset-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    wallOffset = btn.dataset.offset;
  });

  // Door hinge/swing defaults (delegation)
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

  // Edit panel (delegation)
  dom.editContent?.addEventListener('click', e => {
    if (selectedItems.length !== 1) return;
    const wall = selectedItems[0].type === 'wall' ? appState.walls.find(w => w.id === selectedItems[0].id) : null;
    const anchBtn = e.target.closest('[data-wall-anchor]');
    if (anchBtn && wall) { wallLengthAnchor = anchBtn.dataset.wallAnchor === 'end' ? 'end' : 'start'; updateEditPanel(); return; }
    const hingeBtn = e.target.closest('[data-edit-door-hinge]');
    if (hingeBtn && selectedItems[0].type === 'opening') { updateDoorOpening(selectedItems[0].id, { hinge: hingeBtn.dataset.editDoorHinge }); syncDoorButtons(); doRedraw(); return; }
    const swingBtn = e.target.closest('[data-edit-door-swing]');
    if (swingBtn && selectedItems[0].type === 'opening') { updateDoorOpening(selectedItems[0].id, { swing: Number(swingBtn.dataset.editDoorSwing) }); syncDoorButtons(); doRedraw(); }
  });
  dom.editContent?.addEventListener('keydown', e => {
    if (!e.target.matches('[data-wall-length-input]')) return;
    if (e.key === 'Enter') { e.preventDefault(); commitWallLengthInput(e.target); }
  });
  dom.editContent?.addEventListener('change', e => {
    if (e.target.matches('[data-wall-length-input]')) commitWallLengthInput(e.target);
  });

  // Delete button
  dom.btnDeleteSelected?.addEventListener('click', () => {
    if (!selectedItems.length) return;
    executeCommand(new DeleteItemsCommand(selectedItems));
    clearSelection();
    doRedraw();
  });

  // Undo/Redo buttons
  dom.btnUndo?.addEventListener('click', () => { undo(); onHistoryRestore(); });
  dom.btnRedo?.addEventListener('click', () => { redo(); onHistoryRestore(); });

  // New project
  dom.btnNew?.addEventListener('click', () => {
    if (!confirm('Создать новый проект? Текущий чертёж будет очищен.')) return;
    updateState('walls', []);
    updateState('openings', []);
    updateState('rooms', []);
    updateState('idWall', 1);
    updateState('idOpen', 1);
    updateState('roomNameOverrides', {});
    hoverOpening = null; wallResizeState = null;
    resetDrawingState(); clearSelectionBox(); clearSelection();
    clearHistory();
    EventBus.emit('walls:changed');
    doRedraw();
  });

  // Recalc rooms (ручная кнопка)
  dom.btnRecalc?.addEventListener('click', () => {
    EventBus.emit('walls:changed');
    doRedraw();
  });

  // Zoom
  dom.btnZoomIn?.addEventListener('click',    () => { scale = Math.min(2, scale * 1.25); syncViewport(); doRedraw(); });
  dom.btnZoomOut?.addEventListener('click',   () => { scale = Math.max(0.03, scale / 1.25); syncViewport(); doRedraw(); });
  dom.btnZoomReset?.addEventListener('click', () => { scale = 0.12; panX = 200; panY = 150; syncViewport(); doRedraw(); });

  // Wall param inputs
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

  // Explication rename (delegation)
  dom.explBody?.addEventListener('focusin', e => { if (e.target.matches('.room-name-input')) e.target.select(); });
  dom.explBody?.addEventListener('keydown', e => {
    if (e.target.matches('.room-name-input') && e.key === 'Enter') { e.preventDefault(); e.target.blur(); }
  });
  dom.explBody?.addEventListener('change', e => {
    if (!e.target.matches('.room-name-input')) return;
    const key     = e.target.dataset.roomKey;
    const newName = e.target.value || e.target.dataset.roomDefault || '';
    executeCommand(new RenameRoomCommand(key, newName));
    doRedraw();
  });
  
  // Import rooms from planner into smeta
  dom.btnImportRooms?.addEventListener('click', () => {
    const rooms = getComputedRooms();
    if (!rooms.length) { alert('Нарисуйте план и пересчитайте помещения'); return; }
    window._smetaModule?.importRoomsFromPlanner(rooms);
  });

  // Инициализация голосового ввода
  VoiceInput.init();

  setTool('select');
  syncDoorButtons();
  clearHistory();   // Stage 5: вместо recordHistory() — очистка стека (нет «пустого» снапшота)
  doRedraw();
}

// ── Helpers ───────────────────────────────────────────────────────

function getWallHeightFallback() {
  return parseFloat(dom.inpWallHeight?.value) || 2700;
}

function syncViewport() {
  setViewport(scale, panX, panY);
}

function doRedraw() {
  syncViewport();
  redraw(getPlannerState());
}

function getPlannerState() {
  const trackingLines = activeTrackingPoint ? getTrackingLines(activeTrackingPoint) : [];
  return {
    scale, selectedItems, tool, isDrawing, drawStart, drawEnd,
    currentGuideLine, currentObjectSnap, hoverOpening, hoverItem,
    selectBoxStart, selectBoxCurrent, chainMode, lengthMode, lengthInput,
    wallResizeState, wallOffset, defaultDoorHinge, defaultDoorSwing,
    inpWallThick: dom.inpWallThick,
    lengthOverlay: dom.lengthOverlay, lengthLabel: dom.lengthLabel,
    lblLen: dom.lblLen, lblLenVal: dom.lblLenVal,
    mouseScreen, isPanning,
    activeTrackingPoint, trackingLines,
  };
}

function resizeCanvas() {
  const r = canvasWrap.getBoundingClientRect();
  canvas.width = r.width; canvas.height = r.height;
  doRedraw();
}

function resetDrawingState() {
  isDrawing = false; chainMode = false; drawStart = null; drawEnd = null;
  currentGuideLine = null; currentObjectSnap = null;
  lengthInput = ''; lengthMode = false;
  clearTracking();
  if (dom.lengthOverlay) dom.lengthOverlay.style.display = 'none';
  if (dom.lblLen) dom.lblLen.style.display = 'none';
}

function clearSelectionBox() { selectBoxStart = null; selectBoxCurrent = null; }

// ── Stage 3: tracking lines helpers ──────────────────────────────

function clearTracking() {
  clearTimeout(_snapHoverTimer);
  _snapHoverTimer     = null;
  _snapHoverKey       = null;
  activeTrackingPoint = null;
}

function updateTrackingState(snap) {
  const trackable = snap && (
    snap.type === 'endpoint' || snap.type === 'corner' ||
    snap.type === 'intersection' || snap.type === 'midpoint'
  );
  if (!trackable) {
    clearTimeout(_snapHoverTimer);
    _snapHoverTimer = null;
    _snapHoverKey   = null;
    return;
  }
  const key = `${snap.type}:${Math.round(snap.x)},${Math.round(snap.y)}`;
  if (key === _snapHoverKey) return;
  clearTimeout(_snapHoverTimer);
  _snapHoverKey = key;
  _snapHoverTimer = setTimeout(() => {
    let wallDir = null;
    if (snap.wallId) {
      const wall = appState.walls.find(w => w.id === snap.wallId);
      if (wall) {
        const dx = (wall.cx2 ?? wall.x2) - (wall.cx1 ?? wall.x1);
        const dy = (wall.cy2 ?? wall.y2) - (wall.cy1 ?? wall.y1);
        const len = Math.hypot(dx, dy);
        if (len > 1) wallDir = { x: dx / len, y: dy / len };
      }
    }
    activeTrackingPoint = { x: snap.x, y: snap.y, type: snap.type, wallDir };
    doRedraw();
  }, 400);
}

function clearSelection() {
  selectedItems = []; wallResizeState = null;
  if (dom.editPanel) dom.editPanel.style.display = 'none';
  if (dom.editContent) dom.editContent.innerHTML = '';
  syncDoorButtons(); doRedraw();
}

function setSelection(items) {
  const seen = new Set(), unique = [];
  for (const i of items) { const k = `${i.type}:${i.id}`; if (!seen.has(k)) { seen.add(k); unique.push(i); } }
  selectedItems = unique;
  if (dom.editPanel) dom.editPanel.style.display = selectedItems.length ? 'block' : 'none';
  updateEditPanel(); syncDoorButtons(); doRedraw();
}

function selectObject(type, id) { setSelection([{ type, id }]); }

function toggleSelection(type, id) {
  const k = `${type}:${id}`;
  if (selectedItems.some(i => `${i.type}:${i.id}` === k))
    setSelection(selectedItems.filter(i => `${i.type}:${i.id}` !== k));
  else
    setSelection([...selectedItems, { type, id }]);
}

function getSelectedWall() {
  if (selectedItems.length !== 1 || selectedItems[0].type !== 'wall') return null;
  return appState.walls.find(w => w.id === selectedItems[0].id) || null;
}

function updateHistoryBtns() {
  if (dom.btnUndo) dom.btnUndo.disabled = !canUndo();
  if (dom.btnRedo) dom.btnRedo.disabled = !canRedo();
}

function onHistoryRestore() {
  // Команды сами эмитят walls:changed в undo/execute — здесь только UI-сброс
  hoverOpening = null; hoverItem = null; mouseScreen = null; wallResizeState = null;
  resetDrawingState(); clearSelectionBox(); clearSelection();
  updateHistoryBtns(); doRedraw();
}

function updateSnapBadge() {
  if (!dom.snapBadge) return;
  dom.snapBadge.textContent = (shiftDown && ctrlDown) ? 'Привязка: 100 мм'
    : shiftDown ? 'Привязка: 10 мм' : 'Привязка: 1 мм';
}

function isEditableTarget(target) {
  return !!target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable);
}

// ── Tool ──────────────────────────────────────────────────────────

export function setTool(t) {
  tool = t;
  wallResizeState = null;
  if (t !== 'wall') resetDrawingState();
  clearSelectionBox(); hoverOpening = null; hoverItem = null; currentObjectSnap = null;
  clearTracking();
  document.querySelectorAll('.tool-btn').forEach(b => b.classList.remove('active'));
  document.getElementById('tool' + t.charAt(0).toUpperCase() + t.slice(1))?.classList.add('active');
  const labels = { select: 'Выбор', wall: 'Стена', window: 'Окно', door: 'Дверь' };
  if (dom.lblTool) dom.lblTool.textContent = labels[t] || t;
  canvas.style.cursor = t === 'select' ? 'default' : 'crosshair';
  document.getElementById('windowParams')?.classList.toggle('active', t === 'window');
  document.getElementById('doorParams')?.classList.toggle('active', t === 'door');
  if (t !== 'select') clearSelection();
  doRedraw();
}

// ── Edit panel ────────────────────────────────────────────────────

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
    const w = appState.walls.find(v => v.id === it.id); if (!w) return;
    const len = Math.round(getWallLength(w));
    dom.editContent.innerHTML = `
      <div class="param-group">
        <div class="param-label">Длина <span class="param-unit">мм</span></div>
        <div class="param-input-wrap"><input class="param-input" type="number" min="1" step="1" value="${len}" data-wall-length-input><span class="param-input-unit">мм</span></div>
      </div>
      <div class="param-group">
        <div class="param-label">Фиксировать край</div>
        <div class="choice-grid">
          <button class="choice-btn compact${wallLengthAnchor === 'start' ? ' active' : ''}" type="button" data-wall-anchor="start">Начало</button>
          <button class="choice-btn compact${wallLengthAnchor === 'end' ? ' active' : ''}" type="button" data-wall-anchor="end">Конец</button>
        </div>
      </div>
      <div class="param-group">
        <div class="param-label">Толщина <span class="param-unit">мм</span></div>
        <div class="param-input-wrap"><input class="param-input" type="number" min="50" max="1000" step="10" value="${w.thickness}" data-wall-thick-input><span class="param-input-unit">мм</span></div>
      </div>
      <div class="param-group">
        <div class="param-label">Высота <span class="param-unit">мм</span></div>
        <div class="param-input-wrap"><input class="param-input" type="number" min="1000" max="6000" step="100" value="${w.height}" data-wall-height-input><span class="param-input-unit">мм</span></div>
      </div>
      <div class="edit-note">Длину можно ввести вручную или потянуть маркеры на концах стены.</div>`;

    // Stage 5: толщина — UpdateWallCommand (before/after через BaseCommand.snapWall)
    dom.editContent.querySelector('[data-wall-thick-input]')?.addEventListener('change', e => {
      const v = Math.max(50, Number(e.target.value) || 200);
      const before = BaseCommand.snapWall(w);
      w.thickness = v;
      recalculateContourFromBase(w);
      const after = BaseCommand.snapWall(w);
      executeCommand(new UpdateWallCommand(w.id, before, after, 'Изменение толщины'));
      doRedraw();
    });
    // Stage 5: высота — UpdateWallCommand
    dom.editContent.querySelector('[data-wall-height-input]')?.addEventListener('change', e => {
      const v = Math.max(1000, Number(e.target.value) || 2700);
      const before = BaseCommand.snapWall(w);
      w.height = v;
      const after = BaseCommand.snapWall(w);
      executeCommand(new UpdateWallCommand(w.id, before, after, 'Изменение высоты'));
      doRedraw();
    });
  } else if (it.type === 'opening') {
    const op = appState.openings.find(o => o.id === it.id); if (!op) return;
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

function commitWallLengthInput(inputEl) {
  const wall = getSelectedWall(); if (!wall) return;
  const val = Math.max(20, parseFloat(inputEl.value) || 0);
  inputEl.value = val;
  const before = BaseCommand.snapWall(wall);
  setWallLength(wall, val, wallLengthAnchor);
  const after = BaseCommand.snapWall(wall);
  executeCommand(new UpdateWallCommand(wall.id, before, after, 'Изменение длины'));
  doRedraw();
}

function syncDoorButtons() {
  document.querySelectorAll('[data-default-door-hinge]').forEach(b => b.classList.toggle('active', b.dataset.defaultDoorHinge === defaultDoorHinge));
  document.querySelectorAll('[data-default-door-swing]').forEach(b => b.classList.toggle('active', Number(b.dataset.defaultDoorSwing) === defaultDoorSwing));
  const selDoor = selectedItems.length === 1 && selectedItems[0].type === 'opening'
    ? appState.openings.find(o => o.id === selectedItems[0].id && o.type === 'door') : null;
  if (!selDoor) return;
  document.querySelectorAll('[data-edit-door-hinge]').forEach(b => b.classList.toggle('active', b.dataset.editDoorHinge === (selDoor.hinge || defaultDoorHinge)));
  document.querySelectorAll('[data-edit-door-swing]').forEach(b => b.classList.toggle('active', Number(b.dataset.editDoorSwing) === (selDoor.swing ?? defaultDoorSwing)));
}

// ── Wall preview / finalize ───────────────────────────────────────

function getWallPreviewEnd(world) {
  const screenPt = mouseScreen ? { ...mouseScreen } : toScreen(world.x, world.y);
  const snappedBase = snap(world.x, world.y, { screenPoint: screenPt, includePerpendicular: !!drawStart, startPoint: drawStart });
  let rawEnd = { ...snappedBase };
  const hardSnap = snappedBase.snapType === 'endpoint' || snappedBase.snapType === 'corner' || snappedBase.snapType === 'intersection';
  if (!hardSnap && !shiftDown && drawStart) {
    const dx = rawEnd.x - drawStart.x, dy = rawEnd.y - drawStart.y, len = Math.hypot(dx, dy);
    if (len > 1) {
      let angle = Math.atan2(dy, dx);
      for (const sa of [0, Math.PI / 2, Math.PI, -Math.PI / 2]) {
        const diff = Math.abs(angle - sa);
        if (diff < 0.15 || Math.abs(diff - 2 * Math.PI) < 0.15) {
          angle = sa;
          rawEnd = { x: drawStart.x + Math.cos(angle) * len, y: drawStart.y + Math.sin(angle) * len };
          if (snappedBase.snapType === 'wallFace' || snappedBase.snapType === 'wallAxis') {
            rawEnd.snapType = null;
          }
          break;
        }
      }
    }
  }
  if (currentGuideLine && !snappedBase.snapType) {
    const nearest = getNearestGuideAxis(screenPt, currentGuideLine);
    const axisGuide = nearest ? { anchor: currentGuideLine.anchor, dir: nearest.dir } : currentGuideLine;
    rawEnd = { ...rawEnd, ...projectPointToGuideLineWorld(rawEnd, axisGuide) };
  }

  // Stage 3: tracking lines
  if (activeTrackingPoint && !snappedBase.snapType && !currentGuideLine) {
    const tLines = getTrackingLines(activeTrackingPoint);
    const tSnap  = snapToTrackingLines(rawEnd, screenPt, tLines, 16);
    if (tSnap) {
      rawEnd = { ...rawEnd, x: tSnap.x, y: tSnap.y, snapType: 'tracking' };
    }
  }
  if (lengthMode && lengthInput && drawStart) {
    const targetLen = parseFloat(lengthInput);
    if (!isNaN(targetLen) && targetLen > 0) {
      if (currentGuideLine) {
        const nearest = getNearestGuideAxis(screenPt, currentGuideLine);
        const axisDir = nearest ? nearest.dir : currentGuideLine.dir;
        const axisGuide = { anchor: currentGuideLine.anchor, dir: axisDir };
        const ax = axisGuide.anchor.x - drawStart.x, ay = axisGuide.anchor.y - drawStart.y;
        const dot = ax * axisGuide.dir.x + ay * axisGuide.dir.y;
        const dist2 = ax * ax + ay * ay, disc = dot * dot - (dist2 - targetLen * targetLen);
        if (disc >= 0) {
          const sq = Math.sqrt(disc);
          const p1 = { x: axisGuide.anchor.x + axisGuide.dir.x * (-dot + sq), y: axisGuide.anchor.y + axisGuide.dir.y * (-dot + sq) };
          const p2 = { x: axisGuide.anchor.x + axisGuide.dir.x * (-dot - sq), y: axisGuide.anchor.y + axisGuide.dir.y * (-dot - sq) };
          rawEnd = Math.hypot(rawEnd.x - p1.x, rawEnd.y - p1.y) <= Math.hypot(rawEnd.x - p2.x, rawEnd.y - p2.y) ? p1 : p2;
        }
      } else {
        const dx = rawEnd.x - drawStart.x, dy = rawEnd.y - drawStart.y, curLen = Math.hypot(dx, dy);
        if (curLen > 0.1) rawEnd = { x: drawStart.x + (dx / curLen) * targetLen, y: drawStart.y + (dy / curLen) * targetLen };
      }
    }
  }
  rawEnd.snappedToEndpoint = snappedBase.snappedToEndpoint;
  rawEnd.snapType = snappedBase.snapType;
  return rawEnd;
}

function finalizeWall(end) {
  if (!drawStart) return false;
  const len = Math.hypot(end.x - drawStart.x, end.y - drawStart.y);
  if (len <= 1) return false;

  const thick  = parseFloat(dom.inpWallThick?.value) || 200;
  const height = parseFloat(dom.inpWallHeight?.value) || 2700;

  // Stage 5: CreateWallCommand делает addWall + EventBus.emit('walls:changed') внутри
  executeCommand(new CreateWallCommand(drawStart, end, thick, height, wallOffset));

  drawStart = { x: end.x, y: end.y }; drawEnd = { x: end.x, y: end.y };
  currentGuideLine = null; currentObjectSnap = null;
  lengthInput = ''; lengthMode = false; chainMode = true; isDrawing = true;
  doRedraw(); return true;
}

// ── Snap helpers ──────────────────────────────────────────────────

function updateWallObjectSnap(worldPoint, screenPoint) {
  if (tool !== 'wall') { currentObjectSnap = null; return; }
  currentObjectSnap = findObjectSnapCandidate(worldPoint, screenPoint, {
    includeEndpoint: true, includeCorner: true, includeMidpoint: true,
    includeIntersection: true, includeWallPoint: true,
    includePerpendicular: isDrawing && !!drawStart, startPoint: drawStart,
  });
}

function updateWallGuide(worldPoint, screenPoint) {
  if (tool !== 'wall' || !isDrawing || !drawStart) { currentGuideLine = null; return; }
  const candidate = findGuideCandidate(screenPoint);
  if (candidate) { currentGuideLine = candidate; return; }
  if (currentGuideLine) {
    const nearest = getNearestGuideAxis(screenPoint, currentGuideLine);
    const guideDistance = nearest ? nearest.distance : Infinity;
    const anchorScreen = toScreen(currentGuideLine.anchor.x, currentGuideLine.anchor.y);
    const anchorDistance = Math.hypot(screenPoint.x - anchorScreen.x, screenPoint.y - anchorScreen.y);
    if (guideDistance <= 18 || anchorDistance <= 20) return;
  }
  currentGuideLine = null;
}

// ── Canvas events ─────────────────────────────────────────────────

function getCanvasPos(e) {
  const r = canvas.getBoundingClientRect();
  return { x: e.clientX - r.left, y: e.clientY - r.top };
}

function onMouseDown(e) {
  if (e.button === 2 || e.button === 1) {
    isPanning = true; panStartX = e.clientX; panStartY = e.clientY;
    panStartOffX = panX; panStartOffY = panY;
    canvas.style.cursor = 'grabbing'; e.preventDefault(); return;
  }
  const pos = getCanvasPos(e);
  const world = toWorld(pos.x, pos.y);
  mouseScreen = { x: pos.x, y: pos.y };
  if (tool !== 'select' && selectedItems.length && !shiftDown) clearSelection();

  if (tool === 'wall') {
    if (!isDrawing) {
      const snapped = snap(world.x, world.y, { screenPoint: pos });
      isDrawing = true; chainMode = false;
      drawStart = { x: snapped.x, y: snapped.y }; drawEnd = { ...snapped };
      lengthInput = ''; lengthMode = false; doRedraw();
    } else {
      const end = getWallPreviewEnd(world); finalizeWall(end);
    }
  } else if (tool === 'window' || tool === 'door') {
    if (hoverOpening) {
      // Stage 5: AddOpeningCommand делает addOpening + EventBus.emit внутри
      executeCommand(new AddOpeningCommand(hoverOpening));
      doRedraw();
    }
  } else if (tool === 'select') {
    const handle = hitTestWallResizeHandle(pos, tool, selectedItems);
    if (handle) {
      wallResizeState = {
        wallId:    handle.wall.id,
        endpoint:  handle.endpoint,
        fixedPoint: getWallContourPoint(handle.wall, handle.endpoint === 'start' ? 'end' : 'start'),
        changed:   false,
        // Stage 5: снапшот геометрии ДО начала resize
        geomBefore: BaseCommand.snapWall(handle.wall),
      };
      selectBoxStart = null; selectBoxCurrent = null; selectClickCandidate = null;
      canvas.style.cursor = 'grabbing'; return;
    }
    const hit = hitTestObject(world.x, world.y);
    if (hit) {
      const isSelected = selectedItems.some(i => i.type === hit.type && i.id === hit.id);
      if (isSelected && selectedItems.length > 0) {
        const seedIds = selectedItems.filter(i => i.type === 'wall').map(i => i.id);
        const connectedIds = getTopologicallyConnected(seedIds);
        const wallSnapshots = [...connectedIds].map(id => {
          const w = appState.walls.find(v => v.id === id);
          return w ? BaseCommand.snapWallPos(w) : null;
        }).filter(Boolean);
        dragState = { startWorld: { x: world.x, y: world.y }, lastWorld: { x: world.x, y: world.y }, wallSnapshots };
        selectBoxStart = null; selectBoxCurrent = null; selectClickCandidate = null;
        canvas.style.cursor = 'grabbing'; return;
      }
      selectClickCandidate = hit; clearSelectionBox();
    } else {
      if (!shiftDown) clearSelection(); selectClickCandidate = null;
      selectBoxStart = { x: pos.x, y: pos.y }; selectBoxCurrent = { x: pos.x, y: pos.y }; doRedraw();
    }
  }
}

function hitTestObject(wx, wy) {
  const op = findClosestOpening(wx, wy); if (op) return { type: 'opening', id: op.id };
  const wall = findClosestWallSel(wx, wy); if (wall) return { type: 'wall', id: wall.id };
  return null;
}

function getTopologicallyConnected(seedWallIds) {
  const SNAP = 2;
  const visited = new Set(seedWallIds);
  const queue = [...seedWallIds];
  while (queue.length) {
    const id = queue.shift();
    const wall = appState.walls.find(w => w.id === id);
    if (!wall) continue;
    const myPts = [
      { x: wall.cx1 ?? wall.x1, y: wall.cy1 ?? wall.y1 },
      { x: wall.cx2 ?? wall.x2, y: wall.cy2 ?? wall.y2 },
    ];
    for (const other of appState.walls) {
      if (visited.has(other.id)) continue;
      const otherPts = [
        { x: other.cx1 ?? other.x1, y: other.cy1 ?? other.y1 },
        { x: other.cx2 ?? other.x2, y: other.cy2 ?? other.y2 },
      ];
      const connected = myPts.some(mp => otherPts.some(op =>
        Math.hypot(mp.x - op.x, mp.y - op.y) <= SNAP
      ));
      if (connected) { visited.add(other.id); queue.push(other.id); }
    }
  }
  return visited;
}

let _resizeDebounce = null;
function debouncedComputeRooms() {
  clearTimeout(_resizeDebounce);
  _resizeDebounce = setTimeout(() => {
    EventBus.emit('walls:changed');
    doRedraw();
  }, 80);
}

function onMouseMove(e) {
  if (isPanning) {
    panX = panStartOffX + (e.clientX - panStartX);
    panY = panStartOffY + (e.clientY - panStartY);
    syncViewport(); doRedraw(); return;
  }
  const pos = getCanvasPos(e), world = toWorld(pos.x, pos.y);
  mouseScreen = { x: pos.x, y: pos.y };
  setModifiers(shiftDown, ctrlDown);

  if (wallResizeState) {
    const wall = appState.walls.find(w => w.id === wallResizeState.wallId);
    if (!wall) { wallResizeState = null; doRedraw(); return; }
    currentGuideLine = null; currentObjectSnap = null;
    const moved = getSnappedWallResizePoint(wallResizeState.fixedPoint, world, pos, shiftDown);
    const ns = wallResizeState.endpoint === 'start' ? moved : wallResizeState.fixedPoint;
    const ne = wallResizeState.endpoint === 'start' ? wallResizeState.fixedPoint : moved;
    if (Math.hypot(ne.x - ns.x, ne.y - ns.y) >= 1) {
      const changed = updateWallGeometry(wall, ns, ne, { preserveFrom: wallResizeState.endpoint === 'start' ? 'end' : 'start' });
      wallResizeState.changed = wallResizeState.changed || changed;
      debouncedComputeRooms();
    }
    canvas.style.cursor = 'grabbing'; doRedraw(); return;
  }

  if (tool === 'wall') {
    updateWallObjectSnap(world, pos);
    updateTrackingState(currentObjectSnap);
  } else {
    currentObjectSnap = null;
    clearTracking();
  }

  if (tool === 'select' && dragState) {
    for (const snap of dragState.wallSnapshots) {
      const wall = appState.walls.find(w => w.id === snap.id);
      if (!wall) continue;
      const ddx = world.x - dragState.startWorld.x;
      const ddy = world.y - dragState.startWorld.y;
      wall.cx1 = snap.cx1 + ddx; wall.cy1 = snap.cy1 + ddy;
      wall.cx2 = snap.cx2 + ddx; wall.cy2 = snap.cy2 + ddy;
      wall.x1  = snap.x1  + ddx; wall.y1  = snap.y1  + ddy;
      wall.x2  = snap.x2  + ddx; wall.y2  = snap.y2  + ddy;
    }
    invalidateJointCache();
    canvas.style.cursor = 'grabbing'; doRedraw(); return;
  }

  if (tool === 'select' && !selectBoxStart && !wallResizeState) {
    const hit = hitTestObject(world.x, world.y);
    if (hit?.type !== hoverItem?.type || hit?.id !== hoverItem?.id) {
      hoverItem = hit; doRedraw();
    }
  } else if (hoverItem) {
    hoverItem = null;
  }

  if (dom.lblCoords) dom.lblCoords.textContent = `X: ${Math.round(world.x)} мм  Y: ${Math.round(world.y)} мм${tool === 'wall' && currentObjectSnap ? `  ·  ${currentObjectSnap.label}` : ''}`;

  if (tool === 'select' && selectBoxStart) { selectBoxCurrent = { x: pos.x, y: pos.y }; doRedraw(); return; }

  if (tool === 'window' || tool === 'door') {
    const hit = findClosestWall(world.x, world.y);
    if (hit) {
      const thick = parseFloat(dom.inpWallThick?.value) || 200;
      const w = parseFloat(document.getElementById(tool === 'window' ? 'inpWindowWidth' : 'inpDoorWidth')?.value) || (tool === 'window' ? 1200 : 900);
      const h = parseFloat(document.getElementById(tool === 'window' ? 'inpWindowHeight' : 'inpDoorHeight')?.value) || (tool === 'window' ? 1500 : 2100);
      const wlen = Math.hypot(hit.wall.x2 - hit.wall.x1, hit.wall.y2 - hit.wall.y1);
      const angle = Math.atan2(hit.wall.y2 - hit.wall.y1, hit.wall.x2 - hit.wall.x1);
      const nx = -Math.sin(angle), ny = Math.cos(angle);
      const px = hit.wall.x1 + (hit.wall.x2 - hit.wall.x1) * hit.t, py = hit.wall.y1 + (hit.wall.y2 - hit.wall.y1) * hit.t;
      const side = ((world.x - px) * nx + (world.y - py) * ny) >= 0 ? 1 : -1;
      hoverOpening = wlen > w + 1 ? { wall: hit.wall, t: hit.t, width: w, height: h, type: tool, hinge: defaultDoorHinge, swing: defaultDoorSwing, side } : null;
    } else hoverOpening = null;
    doRedraw();
  } else if (hoverOpening) { hoverOpening = null; doRedraw(); }

  if (isDrawing && tool === 'wall' && drawStart) {
    updateWallGuide(world, pos); drawEnd = getWallPreviewEnd(world); doRedraw();
  } else if (tool === 'wall' && !isDrawing) doRedraw();

  if (tool === 'select' && !selectBoxStart) {
    canvas.style.cursor = hitTestWallResizeHandle(pos, tool, selectedItems) ? 'grab' : 'default';
  }
}

function onMouseUp(e) {
  // Drag (перемещение выделенных стен)
  if (dragState) {
    const moved = dragState.wallSnapshots.some(snap => {
      const wall = appState.walls.find(w => w.id === snap.id);
      return wall && (Math.abs(wall.x1 - snap.x1) > 2 || Math.abs(wall.y1 - snap.y1) > 2);
    });
    if (moved) {
      // Stage 5: MoveWallsCommand (re-apply final positions, идемпотентно)
      const afterPositions = dragState.wallSnapshots.map(snap => {
        const wall = appState.walls.find(w => w.id === snap.id);
        return wall ? BaseCommand.snapWallPos(wall) : null;
      }).filter(Boolean);
      executeCommand(new MoveWallsCommand(dragState.wallSnapshots, afterPositions));
    }
    dragState = null;
    canvas.style.cursor = tool === 'select' ? 'default' : 'crosshair';
    doRedraw(); return;
  }

  // Resize маркером
  if (wallResizeState) {
    const shouldRecord = wallResizeState.changed;
    if (shouldRecord) {
      const wall = appState.walls.find(w => w.id === wallResizeState.wallId);
      if (wall) {
        // Stage 5: UpdateWallCommand (re-apply after-снапшот, идемпотентно)
        executeCommand(new UpdateWallCommand(
          wall.id,
          wallResizeState.geomBefore,
          BaseCommand.snapWall(wall),
          'Изменение размера стены',
        ));
      }
    }
    wallResizeState = null;
    canvas.style.cursor = tool === 'select' ? 'default' : 'crosshair';
    doRedraw(); return;
  }

  if (tool === 'select' && selectClickCandidate) {
    const hit = selectClickCandidate; selectClickCandidate = null;
    if (shiftDown) toggleSelection(hit.type, hit.id);
    else selectObject(hit.type, hit.id);
    doRedraw(); return;
  }
  if (tool === 'select' && selectBoxStart) {
    const box = selectBoxStart && selectBoxCurrent ? {
      left: Math.min(selectBoxStart.x, selectBoxCurrent.x), top: Math.min(selectBoxStart.y, selectBoxCurrent.y),
      right: Math.max(selectBoxStart.x, selectBoxCurrent.x), bottom: Math.max(selectBoxStart.y, selectBoxCurrent.y),
    } : null;
    if (box && (box.right - box.left) > 5 && (box.bottom - box.top) > 5) {
      const items = [];
      for (const wall of appState.walls) {
        const wb = { left: Math.min(toScreen(wall.x1, wall.y1).x, toScreen(wall.x2, wall.y2).x) - wall.thickness,
          right: Math.max(toScreen(wall.x1, wall.y1).x, toScreen(wall.x2, wall.y2).x) + wall.thickness,
          top: Math.min(toScreen(wall.x1, wall.y1).y, toScreen(wall.x2, wall.y2).y) - wall.thickness,
          bottom: Math.max(toScreen(wall.x1, wall.y1).y, toScreen(wall.x2, wall.y2).y) + wall.thickness };
        if (boundsIntersect(wb, box)) items.push({ type: 'wall', id: wall.id });
      }
      for (const op of appState.openings) {
        const ob = getOpeningScreenBounds(op);
        if (ob && boundsIntersect(ob, box)) items.push({ type: 'opening', id: op.id });
      }
      if (items.length) setSelection(shiftDown ? [...selectedItems, ...items] : items);
      else if (!shiftDown) clearSelection();
    } else if (!shiftDown) clearSelection();
    clearSelectionBox(); doRedraw(); return;
  }
  if (isPanning) { isPanning = false; canvas.style.cursor = tool === 'select' ? 'default' : 'crosshair'; doRedraw(); }
}

function onWheel(e) {
  e.preventDefault();
  const pos = getCanvasPos(e), factor = e.deltaY < 0 ? 1.12 : 0.88;
  const newScale = Math.min(2, Math.max(0.03, scale * factor));
  panX = pos.x - (pos.x - panX) * (newScale / scale);
  panY = pos.y - (pos.y - panY) * (newScale / scale);
  scale = newScale; syncViewport(); doRedraw();
}

function onKeyDown(e) {
  const editable = isEditableTarget(e.target);

  // Ctrl+C — копирование
  if (!editable && (e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'c') {
    if (selectedItems.length) {
      const wallIds = new Set(selectedItems.filter(i => i.type === 'wall').map(i => i.id));
      const walls = appState.walls.filter(w => wallIds.has(w.id)).map(w => ({ ...w }));
      const openings = appState.openings.filter(o => wallIds.has(o.wallId)).map(o => ({ ...o }));
      clipboard = { walls, openings };
    }
    e.preventDefault(); return;
  }

  // Ctrl+V — вставка (Stage 5: PasteCommand)
  if (!editable && (e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'v') {
    if (clipboard?.walls?.length) {
      const cmd = new PasteCommand(clipboard);
      executeCommand(cmd);
      setSelection(cmd.getPastedWallIds().map(id => ({ type: 'wall', id })));
      doRedraw();
    }
    e.preventDefault(); return;
  }

  // Ctrl+Z — undo / redo (Stage 5)
  if (!editable && (e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') {
    e.preventDefault();
    if (e.shiftKey) { redo(); } else { undo(); }
    onHistoryRestore(); return;
  }

  // Ctrl+Y — redo (Stage 5)
  if (!editable && (e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'y') {
    e.preventDefault(); redo(); onHistoryRestore(); return;
  }

  if (e.key === 'Shift') { shiftDown = true; setModifiers(true, ctrlDown); updateSnapBadge(); }
  if (e.key === 'Control') { ctrlDown = true; setModifiers(shiftDown, true); updateSnapBadge(); }
  if (e.key === 'Escape') {
    if (isDrawing) { resetDrawingState(); doRedraw(); }
    clearSelectionBox(); clearSelection(); hoverOpening = null; doRedraw();
  }
  if (!editable && (e.key === 'Delete' || e.key === 'Backspace') && selectedItems.length) {
    dom.btnDeleteSelected?.click(); e.preventDefault();
  }
    if (!editable && (e.key === 'Delete' || e.key === 'Backspace') && selectedItems.length) {
    dom.btnDeleteSelected?.click(); e.preventDefault();
  }
  
  if (!editable && isDrawing && tool === 'wall') {
    // ─────────────────────────────────────────────────────────────
    // ВОТ СЮДА ВСТАВЛЯЕМ НОВЫЙ КОД (перед проверкой цифр)
    // Голосовой ввод по зажатому Space (только при рисовании стены)
    if (e.code === 'Space' && !voiceKeyPressed) {
      e.preventDefault();
      voiceKeyPressed = true;
      
      VoiceInput.startListening((lengthMm) => {
        if (!isDrawing || tool !== 'wall') return;
        lengthInput = lengthMm.toString();
        lengthMode = true;
        forceRedraw();
      });
      
      return;
    }
    // ─────────────────────────────────────────────────────────────

    if (/^[0-9]$/.test(e.key)) { lengthMode = true; lengthInput += e.key; e.preventDefault(); doRedraw(); }
    else if (e.key === 'Backspace' && lengthMode) {
      lengthInput = lengthInput.slice(0, -1); if (!lengthInput) lengthMode = false; e.preventDefault(); doRedraw();
    } else if (e.key === 'Enter' && lengthMode && lengthInput) {
      const targetLen = parseFloat(lengthInput);
      if (!isNaN(targetLen) && targetLen > 0 && drawEnd && drawStart) {
        const end = getWallPreviewEnd(drawEnd); finalizeWall(end);
      }
      lengthInput = ''; lengthMode = false; e.preventDefault(); doRedraw();
    }
  }
  
  if (!editable && !e.ctrlKey && !e.metaKey) {
    if (e.key === 'v' || e.key === 'V') setTool('select');
    if (e.key === 'w' || e.key === 'W') setTool('wall');
    if (e.key === 'o' || e.key === 'O') setTool('window');
    if (e.key === 'd' || e.key === 'D') setTool('door');
  }
}

function onKeyUp(e) {
  if (e.key === 'Shift') { shiftDown = false; setModifiers(false, ctrlDown); updateSnapBadge(); }
  if (e.key === 'Control') { ctrlDown = false; setModifiers(shiftDown, false); updateSnapBadge(); }
  // ─── СБРОС ГОЛОСОВОЙ КЛАВИШИ ─────────────────────────────────
  if (e.code === 'Space' && voiceKeyPressed) {
    voiceKeyPressed = false;
    VoiceInput.stopListening();
    e.preventDefault();
  }
}

export function forceRedraw() { doRedraw(); }
export function getViewport() { return { scale, panX, panY }; }
