/* Голое CDP-подключение к телефону без ожидания openChat (диагностика зависания). */
const { getJSON } = require("./cdp-helper.js");
(async () => {
  const tabs = await getJSON(9222, "/json/list");
  const page = tabs.find((t) => t.type === "page" && t.url && !t.url.startsWith("about"));
  console.log("page:", page.url);
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  const timeout = setTimeout(() => { console.log("WS не открылся за 8с — WebView заморожен"); process.exit(1); }, 8000);
  ws.onopen = async () => {
    clearTimeout(timeout);
    console.log("WS открыт");
    let id = 0;
    const send = (method, params) => new Promise((res) => {
      const mid = ++id;
      ws.addEventListener("message", function h(ev) {
        const m = JSON.parse(ev.data);
        if (m.id === mid) { ws.removeEventListener("message", h); res(m.result); }
      });
      ws.send(JSON.stringify({ id: mid, method, params }));
    });
    await send("Runtime.enable", {});
    const r = await send("Runtime.evaluate", { expression: "typeof me", returnByValue: true });
    console.log("typeof me:", r.result.value);
    const r2 = await send("Runtime.evaluate", { expression: "location.href + ' | ' + document.readyState", returnByValue: true });
    console.log(r2.result.value);
    process.exit(0);
  };
  ws.onerror = (e) => { console.log("ws error"); };
})();
