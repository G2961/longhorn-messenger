/* Обёртка над Tauri API: в браузере импорт молча провалится, в Tauri — работает.
   Здесь то, что реально нужно клиенту: окно (drag/min/max/close),
   invoke-команды (захват экрана, foreground-сервис) и Channel-стримы.
   Всё ленивое: internals могут появиться позже импорта (Android WebView). */
let api = null;
try { api = await import("./tauri-api.mjs"); } catch (e) { /* браузер */ }
export const window = api ? api.window : null;
export const invoke = api ? (...a) => api.invoke(...a) : null;
export const channel = api ? (...a) => api.channel(...a) : null;
export const available = api ? () => api.available() : () => false;
