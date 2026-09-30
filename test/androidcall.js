/* Трассировка звонка Android-WebView (CDP) -> вторая сторона на node-WS. */
const { connect } = require("./cdp-helper.js");
const fs = require("fs");
const B = "https://lh.g2961.space";
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const LOG = [];
const log = (...a) => { const s = a.map(x => typeof x === "string" ? x : JSON.stringify(x)).join(" "); LOG.push(s); console.log(s); };
(async () => {
  const c = await connect(9222);
  log("подключён к WebView");
  await c.eval(`window.__log=[];
    const _om=sock.onmessage;
    sock.onmessage=ev=>{const f=JSON.parse(ev.data);
      if(f.type==='call'||f.type==='msg')window.__log.push((f.type==='call'?('call:'+f.op):'msg')+' cid='+(f.callID||'')+(f.cand?'+cand':''));
      _om(ev)};`);
  const st0 = await c.eval(`({me:me.name, active:call.active, wsOpen:sock.readyState})`);
  log("телефон:", st0);
  const suf = Date.now().toString(36).slice(-5);
  const reg = await fetch(B + "/api/register", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: "Пир" + suf, password: "test1234", avatar: 3 }),
  }).then((r) => r.json());
  log("вторая сторона создана:", reg.user.name, "id", reg.user.id);
  const ws = new WebSocket(B.replace(/^http/, "ws") + "/ws?token=" + reg.token);
  const frames = [];
  const waitF = (pred, label, timeout = 25000) => new Promise((res, rej) => {
    const t = setTimeout(() => rej(new Error("timeout: " + label)), timeout);
    const h = (ev) => { const f = JSON.parse(ev.data); frames.push(f.type + (f.op ? ":" + f.op : ""));
      if (pred(f)) { clearTimeout(t); ws.removeEventListener("message", h); res(f); } };
    ws.addEventListener("message", h);
  });
  await new Promise((r, j) => { ws.onopen = r; ws.onerror = () => j(new Error("ws open fail")); });
  await waitF((f) => f.type === "hello", "hello");
  log("вторая сторона: WS открыт");
  await c.eval(`openChat(${reg.user.id})`);
  await wait(700);
  await c.eval(`document.getElementById('callb').click()`);
  log("телефон нажал Позвонить");
  let offer;
  try { offer = await waitF((f) => f.type === "call" && f.op === "offer", "offer"); }
  catch (e) { log("ПРОВАЛ:", e.message, "кадры:", frames.join(",")); throw e; }
  log("offer дошёл, sdp len:", (offer.sdp || "").length, "from", offer.from);
  ws.send(JSON.stringify({ type: "call", op: "answer", to: offer.from, callID: offer.callID, sdp: offer.sdp }));
  log("answer (эхо) отправлен");
  ws.addEventListener("message", (ev) => {
    const f = JSON.parse(ev.data);
    if (f.type === "call" && f.op === "ice") {
      ws.send(JSON.stringify({ type: "call", op: "ice", to: f.from, callID: f.callID, cand: f.cand }));
    }
  });
  await wait(6000);
  const st = await c.eval(`({active:call.active, mode:call.mode, ice:call.pc?call.pc.connectionState:'no pc', cs:(document.getElementById('cs')||{}).textContent||'', log:window.__log})`);
  log("телефон через 6с:", st);
  await wait(6000);
  const st2 = await c.eval(`({active:call.active, mode:call.mode, ice:call.pc?call.pc.connectionState:'no pc', log:window.__log})`);
  log("телефон через 12с:", st2);
  ws.close();
  fs.writeFileSync("test/androidcall-result.log", LOG.join("\n"));
  process.exit(0);
})().catch((e) => { LOG.push("FATAL " + e.message); fs.writeFileSync("test/androidcall-result.log", LOG.join("\n")); process.exit(1); });
