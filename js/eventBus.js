// ─── EVENT BUS ────────────────────────────────────────────────────
// Лёгкая шина событий — «нервная система» планировщика.
// Позволяет модулям общаться без прямых зависимостей.
//
// Ключевые события:
//   'walls:changed'    — стены добавлены/удалены/изменены (из ui-planner)
//   'openings:changed' — проёмы добавлены/удалены/изменены
//   'state:<prop>:changed' — прямое присвоение свойства appState (из Proxy)
//
// Использование:
//   EventBus.on('walls:changed', () => { ... });
//   EventBus.emit('walls:changed', payload);
//   EventBus.off('walls:changed', handler);

export const EventBus = {
  /** @type {Map<string, Function[]>} */
  listeners: new Map(),

  /**
   * Подписаться на событие.
   * @param {string}   event
   * @param {Function} callback  fn(payload)
   */
  on(event, callback) {
    if (!this.listeners.has(event)) this.listeners.set(event, []);
    this.listeners.get(event).push(callback);
    return this; // для chaining
  },

  /**
   * Отписаться от события.
   * @param {string}   event
   * @param {Function} callback  та же ссылка, что передавалась в on()
   */
  off(event, callback) {
    if (!this.listeners.has(event)) return this;
    const arr = this.listeners.get(event);
    const index = arr.indexOf(callback);
    if (index > -1) arr.splice(index, 1);
    return this;
  },

  /**
   * Опубликовать событие. Все подписчики вызываются синхронно.
   * @param {string} event
   * @param {*}      [payload=null]
   */
  emit(event, payload = null) {
    if (!this.listeners.has(event)) return this;
    // Копируем массив — защита от мутации списка во время итерации
    [...this.listeners.get(event)].forEach(cb => cb(payload));
    return this;
  },

  /**
   * Отписать всех слушателей события (или всех вообще).
   * @param {string} [event]  если не передан — очищает всё
   */
  clear(event) {
    if (event) this.listeners.delete(event);
    else this.listeners.clear();
    return this;
  },
};
