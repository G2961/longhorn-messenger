/* Интеграционный тест: полный сценарий против живого сервера.
   Запуск: node test/e2e.js (сервер должен быть запущен на :8080 с -seed) */
const BASE = process.env.BASE || "http://localhost:8080";
let failures = 0;
const ok = (cond, name) => { console.log((cond ? "ok" : "FAIL") + " - " + name); if (!cond) failures++; };

async function api(path, body, method, token) {
  const r = await fetch(BASE + path, {
    method: method || (body ? "POST" : "GET"),
    headers: Object.assign(body ? { "Content-Type": "application/json" } : {}, token ? { Authorization: "Bearer " + token } : {}),
    body: body ? JSON.stringify(body) : undefined,
  });
  if (r.status === 204) return null;
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(path + " -> " + r.status + " " + (j.error || ""));
  return j;
}

/* --- минимальный WS-обвязок поверх браузерного WebSocket (Node 22+) --- */
function ws(url) {
  return new Promise((resolve, reject) => {
    const s = new WebSocket(url);
    const q = [];
    s.onopen = () => resolve({
      send: o => s.send(JSON.stringify(o)),
      close: () => s.close(),
      expect(pred, label, timeout = 5000) {
        return new Promise((res2, rej2) => {
          const t = setTimeout(() => rej2(new Error("timeout: " + label)), timeout);
          const tryMatch = f => { if (pred(f)) { clearTimeout(t); res2(f); return true; } return false; };
          while (q.length) { if (tryMatch(q.shift())) return; }
          s.addEventListener("message", function h(ev) {
            const f = JSON.parse(ev.data);
            if (tryMatch(f)) s.removeEventListener("message", h);
          });
        });
      },
    });
    s.onerror = () => reject(new Error("ws error " + url));
    s.onmessage = ev => q.push(JSON.parse(ev.data));
  });
}

const W = p => ws(BASE.replace(/^http/, "ws") + p);

(async () => {
  const h = await fetch(BASE + "/health");
  ok(h.status === 200, "health");

  const uniq = Date.now().toString(36);
  const A = await api("/api/register", { name: "Тестер" + uniq, password: "pass1234", avatar: 1 });
  const B = await api("/api/register", { name: "Беседник" + uniq, password: "pass1234", avatar: 2 });
  ok(A.token && B.token, "register x2");
  const bad = await fetch(BASE + "/api/register", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: "Тестер" + uniq, password: "pass1234" }) });
  ok(bad.status === 409, "duplicate name -> 409");

  const a = await W("/ws?token=" + A.token);
  const b = await W("/ws?token=" + B.token);
  const ha = await a.expect(f => f.type === "hello", "hello A");
  const hb = await b.expect(f => f.type === "hello", "hello B");
  ok(ha.me && ha.me.id === A.user.id, "hello.me A");
  ok(Array.isArray(hb.users) && hb.users.some(u => u.id === A.user.id), "hello.users B содержит A");

  a.send({ type: "msg", id: "c1", to: B.user.id, text: "привет :)" });
  const sent = await a.expect(f => f.type === "sent" && f.id === "c1", "sent");
  ok(sent.seq > 0 && sent.sid, "sent ack");
  const got = await b.expect(f => f.type === "msg" && f.from === A.user.id, "msg to B");
  ok(got.text === "привет :)" && got.seq === sent.seq, "msg доставлено, seq совпадает");

  a.send({ type: "typing", to: B.user.id, on: true });
  await b.expect(f => f.type === "typing" && f.on === true, "typing B");
  b.send({ type: "read", to: A.user.id, seq: sent.seq });
  const rd = await a.expect(f => f.type === "read" && f.seq === sent.seq, "read receipt");
  ok(rd.by === B.user.id, "read ack от B");

  a.send({ type: "presence", status: "dnd", mood: "тестирую" });
  await b.expect(f => f.type === "presence" && f.id === A.user.id && f.status === "dnd", "presence dnd");
  ok(true, "presence рассылка");

  a.send({ type: "call", op: "offer", to: B.user.id, callID: "t1", sdp: "v=0 fake" });
  const off = await b.expect(f => f.type === "call" && f.op === "offer" && f.callID === "t1", "offer B");
  ok(off.sdp === "v=0 fake" && off.from === A.user.id, "offer проброшен");
  b.send({ type: "call", op: "answer", to: A.user.id, callID: "t1", sdp: "v=0 ans" });
  const ans = await a.expect(f => f.type === "call" && f.op === "answer", "answer A");
  ok(ans.sdp === "v=0 ans", "answer проброшен");
  a.send({ type: "call", op: "ice", to: B.user.id, callID: "t1", cand: { candidate: "x" } });
  const ice = await b.expect(f => f.type === "call" && f.op === "ice", "ice B");
  ok(ice.cand.candidate === "x", "ice проброшен");
  a.send({ type: "call", op: "end", to: B.user.id, callID: "t1" });
  await b.expect(f => f.type === "call" && f.op === "end", "end B");
  await b.expect(f => f.type === "msg" && f.sys === true, "sys звонок завершён");
  ok(true, "end + sys-лог");

  b.close();
  await new Promise(r => setTimeout(r, 400));
  a.send({ type: "call", op: "offer", to: B.user.id, callID: "t2", sdp: "v=0 q" });
  const qd = await a.expect(f => f.type === "call" && f.op === "queued", "queued");
  ok(qd.callID === "t2", "звонок в очереди");

  const b2 = await W("/ws?token=" + B.token);
  const off2 = await b2.expect(f => f.type === "call" && f.op === "offer" && f.callID === "t2", "offer после входа B");
  ok(off2.from === A.user.id, "queued-offer доставлен B");
  b2.send({ type: "call", op: "answer", to: A.user.id, callID: "t2", sdp: "v=0 ans2" });
  await a.expect(f => f.type === "call" && f.op === "answer" && f.callID === "t2", "answer2 A");
  a.send({ type: "call", op: "end", to: B.user.id, callID: "t2" });
  await b2.expect(f => f.type === "call" && f.op === "end" && f.callID === "t2", "end2 B");
  ok(true, "сквозной звонок после очереди");

  const bots = hb.users.filter(u => u.bot);
  ok(bots.length === 1, "эхо-бот в списке");
  if (bots.length) {
    a.send({ type: "msg", id: "c2", to: bots[0].id, text: "проверка" });
    const echo = await a.expect(f => f.type === "msg" && f.from === bots[0].id && !f.sys, "эхо бота", 8000);
    ok(echo.text.includes("проверка"), "бот ответил эхом");
  }

  const hist = await api("/api/history/" + B.user.id + "?limit=100", null, "GET", A.token);
  ok(hist.messages.some(m => m.text === "привет :)"), "история содержит сообщение");
  ok(typeof hist.hasMore === "boolean", "история hasMore");

  a.close(); b2.close();
  console.log(failures ? "\n=== ЕСТЬ ПРОБЛЕМЫ: " + failures + " ===" : "\n=== ВСЕ ПРОВЕРКИ ПРОШЛИ ===");
  process.exit(failures ? 1 : 0);
})().catch(e => { console.error("E2E ERROR:", e.message); process.exit(1) });
