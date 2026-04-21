// ─── BaseTool.js ──────────────────────────────────────────────────
export class BaseTool {
  constructor(uiPlanner) {
    this.ui = uiPlanner;          // ссылка на экземпляр UIPlanner (или модуль)
    this.name = 'base';
  }

  // Вызывается при активации инструмента
  activate() {}

  // Вызывается при деактивации
  deactivate() {}

  // Обработчики событий (возвращают true, если событие обработано и нужно прервать цепочку)
  onMouseDown(pos, world, e) { return false; }
  onMouseMove(pos, world, e) { return false; }
  onMouseUp(pos, world, e) { return false; }
  onKeyDown(e) { return false; }
  onKeyUp(e) { return false; }

  // Возвращает CSS-курсор для canvas
  getCursor() { return 'crosshair'; }

  // Возвращает дополнительные данные для рендера (объект, добавляемый к plannerState)
  getRenderState() { return {}; }
}
