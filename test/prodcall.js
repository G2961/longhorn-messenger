/* Генерация тестового звонка на проде: node test/prodcall.js <кто-звонит> <кому>
   Алиса звонит Катя: node test/prodcall.js Алиса Катя */
const B = process.env.BASE || "http://45.80.229.25:8082";
const [callerName, calleeName] = [process.argv[2] || "Алиса", process.argv[3] || "Катя"];
const api = async (p, body, method, tok) => {
  const r = await fetch(B + p, { method: method || (body ? "POST" : "GET"),
    headers: Object.assign(body ? { "Content-Type": "application/json" } : {}, tok ? { Authorization: "Bearer " + tok } : {}),
    body: body ? JSON.stringify(body) : undefined });
  if (r.status === 204) return null;
  const j = await r.json();
  if (!r.ok) throw new Error(p + " -> " + JSON.stringify(j));
  return j;
};
const guard = setTimeout(() => { console.log("GUARD EXIT"); process.exit(1); }, 25000);
(async () => {
  const c = await api("/api/login", { name: callerName, password: "demo1234" });
  const e = await api("/api/login", { name: calleeName, password: "demo1234" });
  const users = await api("/api/users", null, "GET", c.token);
  const callee = users.find(u => u.name === calleeName);
  const wc = new WebSocket(B.replace(/^http/, "ws") + "/ws?token=" + c.token);
  const we = new WebSocket(B.replace(/^http/, "ws") + "/ws?token=" + e.token);
  const wait = (ws, pred, label) => new Promise((res, rej) => {
    const t = setTimeout(() => rej(new Error("timeout " + label)), 8000);
    const h = ev => { const f = JSON.parse(ev.data); if (pred(f)) { clearTimeout(t); ws.removeEventListener("message", h); res(f); } };
    ws.addEventListener("message", h);
  });
  await Promise.all([wait(wc, f => f.type === "hello", "hello c"), wait(we, f => f.type === "hello", "hello e")]);
  console.log("1 both hello");
  wc.send(JSON.stringify({ type: "call", op: "offer", to: callee.id, callID: "prod1", sdp: "x" }));
  await wait(we, f => f.type === "call" && f.op === "offer", "offer");
  console.log("2 offer");
  we.send(JSON.stringify({ type: "call", op: "answer", to: c.user.id, callID: "prod1", sdp: "y" }));
  await wait(wc, f => f.type === "call" && f.op === "answer", "answer");
  console.log("3 answer");
  await new Promise(r => setTimeout(r, 3000)); // 3 секунды «разговора»
  wc.send(JSON.stringify({ type: "call", op: "end", to: callee.id, callID: "prod1" }));
  await new Promise(r => setTimeout(r, 600));
  wc.close(); we.close();
  clearTimeout(guard);
  console.log("done: звонок ~3с записан");
  process.exit(0);
})().catch(err => { console.error("ERR", err.message); process.exit(1); });
