// ─── BaseCommand.js ───────────────────────────────────────────────
// Базовый класс для всех команд.
// Контракт: execute() вызывается при redo (и при первичном выполнении
//           через executeCommand). undo() — при отмене.
// Исключение: "живые" команды (MoveWalls, UpdateWall для resize) — их
//           execute() re-applies after-snapshot, что идемпотентно
//           относительно уже применённых изменений.

export class BaseCommand {
  constructor() {
    this.description = 'Действие';
  }

  execute() {}   // redo (or first apply)
  undo()    {}   // undo

  // Вспомогательный snapshot геометрии + толщины/высоты стены
  static snapWall(wall) {
    return {
      x1: wall.x1,  y1: wall.y1,  x2: wall.x2,  y2: wall.y2,
      cx1: wall.cx1 ?? wall.x1,  cy1: wall.cy1 ?? wall.y1,
      cx2: wall.cx2 ?? wall.x2,  cy2: wall.cy2 ?? wall.y2,
      thickness:        wall.thickness,
      height:           wall.height,
      horizontalOffset: wall.horizontalOffset ?? 0,
    };
  }

  // Snapshot только позиционных данных (для MoveWalls)
  static snapWallPos(wall) {
    return {
      id:  wall.id,
      x1: wall.x1,  y1: wall.y1,  x2: wall.x2,  y2: wall.y2,
      cx1: wall.cx1 ?? wall.x1,  cy1: wall.cy1 ?? wall.y1,
      cx2: wall.cx2 ?? wall.x2,  cy2: wall.cy2 ?? wall.y2,
    };
  }
}
