// ─── CommandHistory.js ────────────────────────────────────────────
// Заменяет history.js. Вместо снапшотов — стек именованных команд.
//
// Ключевой контракт:
//   executeCommand(cmd)  — выполняет cmd.execute() и пишет в стек.
//   undo()               — вызывает cmd.undo() последней команды.
//   redo()               — вызывает cmd.execute() отменённой команды.
//
// Все команды в cmd.execute() сами эмитят нужные EventBus-события.
// Вызывающий код НЕ обязан делать EventBus.emit вручную после
// executeCommand — достаточно doRedraw() при необходимости.

import { EventBus } from '../eventBus.js';

let _past   = [];   // стек выполненных команд
let _future = [];   // стек отменённых команд (для redo)

/**
 * Выполняет команду и добавляет её в стек истории.
 * cmd.execute() вызывается внутри этой функции.
 */
export function executeCommand(cmd) {
  cmd.execute();
  _past.push(cmd);
  _future = [];           // новое действие → redo-стек очищается
  EventBus.emit('history:changed');
}

export function undo() {
  if (!_past.length) return;
  const cmd = _past.pop();
  cmd.undo();
  _future.push(cmd);
  EventBus.emit('history:changed');
}

export function redo() {
  if (!_future.length) return;
  const cmd = _future.pop();
  cmd.execute();
  _past.push(cmd);
  EventBus.emit('history:changed');
}

export function canUndo() { return _past.length > 0; }
export function canRedo() { return _future.length > 0; }

/** Полная очистка истории (при «Новый проект» и при инициализации). */
export function clearHistory() {
  _past   = [];
  _future = [];
  EventBus.emit('history:changed');
}

/** Только для отладки — список описаний команд в стеке */
export function getHistoryStack() {
  return {
    past:   _past.map(c => c.description),
    future: _future.map(c => c.description),
  };
}
