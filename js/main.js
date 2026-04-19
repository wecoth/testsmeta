// ─── MAIN.JS ──────────────────────────────────────────────────────
import { appState } from './state.js';
import { computeRooms, updateExpl } from './room.js';
import { initPlanner, setTool, forceRedraw, getViewport } from './ui-planner.js';
import { renderToImage } from './render.js';
import { setViewport } from './snapping.js';
import {
  initSmeta, addRoom, recalcRooms, getRooms, handleLogo, handlePlan,
  handleSmr, initSmrManual, addSmrRow, recalcSmr,
  handleMat, initMatManual, addMatRow, recalcMat, renumRows,
  openPreview, closePreview, closePreviewOnBg, generatePDF,
  liveUpdate, updateSummary, syncEditorToDoc, importRoomsFromPlanner,
  captureCanvas,
} from './smeta.js';
import { autosaveToLocalStorage, loadFromLocalStorage, downloadProject, uploadProject } from './storage.js';
import { clearHistory } from './commands/CommandHistory.js';

// ── Expose smeta module globally (for inline oninput/onclick) ──────
window._smetaModule = {
  addRoom, recalcRooms, handleLogo, handlePlan,
  handleSmr, initSmrManual, addSmrRow, recalcSmr, collectSmrRows: () => {},
  handleMat, initMatManual, addMatRow, recalcMat, renumRows,
  liveUpdate, updateSummary, importRoomsFromPlanner,
  openPreview, closePreview, closePreviewOnBg, generatePDF,
  captureCanvas,
};

// Expose appState and viewport for captureCanvas
window._appState = appState;
Object.defineProperty(window, '_plannerViewport', { get: () => getViewport() });
window._renderModule = { renderToImage };

// main.js initializes modules and wires up tabs

// ── Tab switching ─────────────────────────────────────────────────

function switchTab(tab) {
  appState.activeTab = tab;
  const plannerView = document.getElementById('plannerView');
  const smetaView   = document.getElementById('smetaView');
  const btnPlanner  = document.getElementById('tabPlanner');
  const btnSmeta    = document.getElementById('tabSmeta');

  plannerView.style.display = tab === 'planner' ? 'flex' : 'none';
  smetaView.style.display   = tab === 'smeta'   ? 'block' : 'none';

  btnPlanner?.classList.toggle('active', tab === 'planner');
  btnSmeta?.classList.toggle('active',   tab === 'smeta');

  // Resize canvas when switching to planner tab
  if (tab === 'planner') {
    requestAnimationFrame(() => {
      const cw = document.getElementById('canvasWrap');
      const canvas = document.getElementById('planCanvas');
      if (cw && canvas) {
        const r = cw.getBoundingClientRect();
        canvas.width = r.width; canvas.height = r.height;
        forceRedraw();
      }
    });
  }
}

// ── DOM-ready init ────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', () => {
  // Tab buttons
  document.getElementById('tabPlanner')?.addEventListener('click', () => switchTab('planner'));
  document.getElementById('tabSmeta')?.addEventListener('click',   () => switchTab('smeta'));

  // ── Init planner ──
  const canvas     = document.getElementById('planCanvas');
  const canvasWrap = document.getElementById('canvasWrap');
  if (canvas && canvasWrap) {
    initPlanner({
      canvas, canvasWrap,
      toolGrid:        document.getElementById('toolGrid'),
      offsetBtns:      document.getElementById('offsetBtns'),
      doorHingeButtons:document.getElementById('doorHingeButtons'),
      doorSwingButtons:document.getElementById('doorSwingButtons'),
      editPanel:       document.getElementById('editPanel'),
      editContent:     document.getElementById('editContent'),
      btnDeleteSelected:document.getElementById('btnDeleteSelected'),
      btnUndo:         document.getElementById('btnUndo'),
      btnRedo:         document.getElementById('btnRedo'),
      btnNew:          document.getElementById('btnNew'),
      btnRecalc:       document.getElementById('btnRecalc'),
      btnZoomIn:       document.getElementById('btnZoomIn'),
      btnZoomOut:      document.getElementById('btnZoomOut'),
      btnZoomReset:    document.getElementById('btnZoomReset'),
      btnImportRooms:  document.getElementById('btnImportRooms'),
      explBody:        document.getElementById('explBody'),
      roomCount:       document.getElementById('roomCount'),
      lblTool:         document.getElementById('lblTool'),
      lblCoords:       document.getElementById('lblCoords'),
      lblLen:          document.getElementById('lblLen'),
      lblLenVal:       document.getElementById('lblLenVal'),
      snapBadge:       document.getElementById('snapBadge'),
      lengthOverlay:   document.getElementById('lengthOverlay'),
      lengthLabel:     document.getElementById('lengthLabel'),
      inpWallThick:    document.getElementById('inpWallThick'),
      inpWallHeight:   document.getElementById('inpWallHeight'),
    });
  }

  // ── Init smeta ──
  initSmeta();

  // ── Save/load project buttons ──
  document.getElementById('btnSaveProject')?.addEventListener('click', downloadProject);
  document.getElementById('btnLoadProject')?.addEventListener('change', e => {
    const f = e.target.files[0]; if (!f) return;
    uploadProject(f, err => {
      if (err) { alert('Ошибка загрузки: ' + err.message); return; }
      computeRooms(parseFloat(document.getElementById('inpWallHeight')?.value) || 2700);
      updateExpl(document.getElementById('explBody'), document.getElementById('roomCount'));
      clearHistory(); forceRedraw();
    });
  });

  // ── Autosave every 30s ──
  setInterval(autosaveToLocalStorage, 30000);

  // ── Start on smeta tab ──
  switchTab('smeta');
});
