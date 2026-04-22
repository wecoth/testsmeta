// ─── STORAGE.JS ───────────────────────────────────────────────────
import { appState } from './state.js';

const LS_KEY = 'remb_project_v1';

function nextId(items, field = 'id', min = 1) {
  let maxId = min - 1;
  for (const item of items || []) {
    const v = Number(item?.[field]);
    if (Number.isFinite(v) && v > maxId) maxId = v;
  }
  return Math.max(min, maxId + 1);
}

export function saveProject() {
  const walls = appState.walls.map(w => ({ ...w }));
  const openings = appState.openings.map(o => ({ ...o }));
  const dividers = (appState.dividers || []).map(d => ({ ...d }));
  const measures = (appState.measures || []).map(m => ({ ...m }));

  const data = {
    walls,
    openings,
    dividers,
    measures,
    roomNameOverrides: { ...appState.roomNameOverrides },
    idWall:            appState.idWall ?? nextId(walls, 'id', 1),
    idOpen:            appState.idOpen ?? nextId(openings, 'id', 1),
    idDivider:         appState.idDivider ?? nextId(dividers, 'id', 1),
    idMeasure:         appState.idMeasure ?? nextId(measures, 'id', 1),
    savedAt:           Date.now(),
  };
  return JSON.stringify(data);
}

export function loadProject(jsonStr) {
  const data = JSON.parse(jsonStr);
  appState.walls             = (data.walls || []).map(w => ({ ...w }));
  appState.openings          = (data.openings || []).map(o => ({ ...o }));
  appState.dividers          = (data.dividers || []).map(d => ({ ...d }));
  appState.measures          = (data.measures || []).map(m => ({ ...m }));
  appState.roomNameOverrides = data.roomNameOverrides || {};
  appState.idWall            = Number.isFinite(Number(data.idWall)) ? Number(data.idWall) : nextId(appState.walls, 'id', 1);
  appState.idOpen            = Number.isFinite(Number(data.idOpen)) ? Number(data.idOpen) : nextId(appState.openings, 'id', 1);
  appState.idDivider         = Number.isFinite(Number(data.idDivider)) ? Number(data.idDivider) : nextId(appState.dividers, 'id', 1);
  appState.idMeasure         = Number.isFinite(Number(data.idMeasure)) ? Number(data.idMeasure) : nextId(appState.measures, 'id', 1);
}

export function autosaveToLocalStorage() {
  try { localStorage.setItem(LS_KEY, saveProject()); } catch {}
}

export function loadFromLocalStorage() {
  try {
    const data = localStorage.getItem(LS_KEY);
    if (data) { loadProject(data); return true; }
  } catch {}
  return false;
}

export function downloadProject() {
  const json = saveProject();
  const blob = new Blob([json], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'remb_project.json';
  a.click();
}

export function uploadProject(file, onLoaded) {
  const r = new FileReader();
  r.onload = e => { try { loadProject(e.target.result); onLoaded?.(null); } catch (err) { onLoaded?.(err); } };
  r.readAsText(file);
}
