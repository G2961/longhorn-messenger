/* Диагностика CDP телефона: что происходит при подключении. */
const { getJSON } = require("./cdp-helper.js");
(async () => {
  try {
    const tabs = await getJSON(9222, "/json/list");
    console.log("tabs:", tabs.map((t) => ({ type: t.type, url: t.url, ws: !!t.webSocketDebuggerUrl })));
  } catch (e) { console.log("json/list fail:", e.message); }
  // голый WS
  await new Promise((resolve) => {
    const ws = new WebSocket("ws://127.0.0.1:9222/json/list");
    setTimeout(() => { console.log("raw ws: no open in 5s (ожидаемо — это не ws-endpoint)"); resolve(); }, 3000);
    ws.onopen = () => { console.log("raw ws open?!"); resolve(); };
  });
  process.exit(0);
})();
