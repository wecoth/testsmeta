// ─── STORAGE.JS ───────────────────────────────────────────────────
import { appState } from './state.js';

const LS_KEY = 'remb_project_v1';

export function saveProject() {
  const data = {
    walls:             appState.walls.map(w => ({ ...w })),
    openings:          appState.openings.map(o => ({ ...o })),
    roomNameOverrides: { ...appState.roomNameOverrides },
    idWall:            appState.idWall,
    idOpen:            appState.idOpen,
    savedAt:           Date.now(),
  };
  return JSON.stringify(data);
}

export function loadProject(jsonStr) {
  const data = JSON.parse(jsonStr);
  appState.walls             = (data.walls || []).map(w => ({ ...w }));
  appState.openings          = (data.openings || []).map(o => ({ ...o }));
  appState.roomNameOverrides = data.roomNameOverrides || {};
  appState.idWall            = data.idWall || 1;
  appState.idOpen            = data.idOpen || 1;
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
