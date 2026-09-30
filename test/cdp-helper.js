/* Минимальный CDP-клиент на голом WebSocket (без зависимостей). */
const http = require("http");

async function getJSON(port, path) {
  return new Promise((resolve, reject) => {
    http.get({ host: "127.0.0.1", port, path }, (res) => {
      let d = "";
      res.on("data", (c) => (d += c));
      res.on("end", () => { try { resolve(JSON.parse(d)); } catch (e) { reject(e); } });
    }).on("error", reject);
  });
}

function wsConnect(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    ws.onopen = () => resolve(ws);
    ws.onerror = () => reject(new Error("ws " + url));
  });
}

async function connect(port) {
  // выбираем последний таб-страницу с реальным URL (не about:blank)
  let page = null;
  for (let i = 0; i < 30 && !page; i++) {
    const tabs = await getJSON(port, "/json");
    const pages = tabs.filter((t) => t.type === "page" && t.url && !t.url.startsWith("about:"));
    if (pages.length) page = pages[pages.length - 1];
    else await new Promise((r) => setTimeout(r, 500));
  }
  if (!page) throw new Error("no page tab");
  const ws = await wsConnect(page.webSocketDebuggerUrl);
  let id = 0;
  const pending = new Map();
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) {
      const { res, rej } = pending.get(m.id);
      pending.delete(m.id);
      if (m.error) rej(new Error(m.error.message));
      else res(m.result);
    }
  };
  const send = (method, params) => new Promise((res, rej) => {
    const mid = ++id;
    pending.set(mid, { res, rej });
    ws.send(JSON.stringify({ id: mid, method, params }));
  });
  await send("Runtime.enable");
  const c = {
    eval: async (expr) => {
      const r = await send("Runtime.evaluate", { expression: expr, returnByValue: true });
      if (r.exceptionDetails) {
        const d = r.exceptionDetails;
        const desc = d.exception && d.exception.description ? d.exception.description.split("\n")[0] : d.text;
        throw new Error(desc + (d.exception && d.exception.className ? " [" + d.exception.className + "]" : ""));
      }
      return r.result.value;
    },
    evalAsync: async (expr) => {
      const r = await send("Runtime.evaluate", {
        expression: expr, awaitPromise: true, returnByValue: true,
      });
      if (r.exceptionDetails) {
        const d = r.exceptionDetails;
        const desc = d.exception && d.exception.description ? d.exception.description.split("\n")[0] : d.text;
        throw new Error(desc + (d.exception && d.exception.className ? " [" + d.exception.className + "]" : ""));
      }
      return r.result.value;
    },
    close: () => ws.close(),
  };
  // ждём готовности приложения (app.js загружен)
  for (let i = 0; i < 30; i++) {
    try { await c.eval("typeof openChat"); if ((await c.eval("typeof openChat")) === "function") return c; } catch (e) {}
    await new Promise((r) => setTimeout(r, 500));
  }
  return c;
}

async function getJSON(port, path) {
  return new Promise((resolve, reject) => {
    http.get({ host: "127.0.0.1", port, path }, (res) => {
      let d = "";
      res.on("data", (c) => (d += c));
      res.on("end", () => { try { resolve(JSON.parse(d)); } catch (e) { reject(e); } });
    }).on("error", reject);
  });
}

module.exports = { connect, getJSON };
