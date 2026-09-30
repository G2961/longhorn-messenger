/* Тонкая обёртка над Tauri API — грузится только внутри Tauri.
   Файл существует отдельно, чтобы app.js не падал в обычном браузере.
   ВАЖНО: модуль может исполняться раньше, чем Tauri инжектит
   __TAURI_INTERNALS__ (Android WebView), поэтому всё — ленивое. */

/* eslint-disable no-undef */
const lazy = () => globalThis.__TAURI_INTERNALS__;

export function invoke(cmd, args) {
  const i = lazy();
  if (!i || !i.invoke) throw new Error("not in Tauri");
  return i.invoke(cmd, args || {});
}

/* Channel: числовой id от transformCallback; в Rust сериализуется
   как "__CHANNEL__:<id>". Колбэку приходит { message, index } | { end }. */
export function channel(onMessage, onEnd) {
  const i = lazy();
  if (!i || !i.transformCallback) throw new Error("not in Tauri");
  const id = i.transformCallback((data) => {
    if (data && data.end) { onEnd && onEnd(); return; }
    onMessage && onMessage(data && "message" in data ? data.message : data);
  });
  return "__CHANNEL__:" + id;
}

export function available() {
  const i = lazy();
  return !!(i && i.invoke);
}

/* Окно: команды window:allow-* из capabilities/default.json */
export const window = {
  getCurrentWindow() {
    const i = lazy();
    const label = (i && i.metadata && i.metadata.currentWindow && i.metadata.currentWindow.label) || "main";
    return {
      label,
      minimize() { return invoke("plugin:window|minimize", { label }); },
      toggleMaximize() { return invoke("plugin:window|toggle_maximize", { label }); },
      close() { return invoke("plugin:window|close", { label }); },
      startDragging() { return invoke("plugin:window|start_dragging", { label }); },
    };
  },
};
