/* Сквозной тест WebRTC-звука на проде: два headless Chrome (fake audio) →
   offer/answer/ice через наш сервер → замер амплитуды входящего потока.
   Запуск: node test/prodrtc.js */
const { spawn } = require("child_process");
const fs = require("fs");
const http = require("http");
const B = process.env.BASE || "https://lh.g2961.space";

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function login(name) {
  const r = await fetch(B + "/api/login", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name, password: "demo1234" }),
  }).then((x) => x.json());
  if (!r.token) throw new Error("login fail " + name);
  return r;
}

/* Страница-агент: WS + WebRTC + замер входящего звука; результат в console */
function agent(token, role, peerID) {
  return `<!DOCTYPE html><meta charset="utf-8"><script>
(async () => {
  const done = (o) => { console.log("RTC_RESULT: " + JSON.stringify(o)); document.title = "RTC_DONE"; };
  try {
    const BASE = ${JSON.stringify(B)};
    const ws = new WebSocket(BASE.replace(/^http/, "ws") + "/ws?token=${token}");
    const send = (o) => ws.send(JSON.stringify(o));
    const waitFrame = (pred, label) => new Promise((res, rej) => {
      const to = setTimeout(() => rej(new Error("timeout " + label)), 25000);
      ws.addEventListener("message", function h(ev) {
        const f = JSON.parse(ev.data);
        if (pred(f)) { clearTimeout(to); ws.removeEventListener("message", h); res(f); }
      });
    });
    await new Promise((r, j) => { ws.onopen = r; ws.onerror = () => j(new Error("ws")); });
    await waitFrame((f) => f.type === "hello", "hello");

    const pc = new RTCPeerConnection({ iceServers: [{ urls: "stun:stun.l.google.com:19302" }] });
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    stream.getAudioTracks().forEach((t) => pc.addTrack(t, stream));
    pc.onicecandidate = (e) => { if (e.candidate) { sentIce++; send({ type: "call", op: "ice", to: ${peerID}, callID: "rtcx", cand: e.candidate.toJSON() }); } };
    let sentIce = 0, gotIce = 0;
    ws.addEventListener("message", (ev) => { const f = JSON.parse(ev.data); if (f.type === "call" && f.op === "ice" && f.cand) { gotIce++; try { pc.addIceCandidate(f.cand); } catch (e) {} } });

    let analyser = null, ac = null;
    pc.ontrack = (e) => {
      const el = document.createElement("audio");
      el.autoplay = true; el.srcObject = e.streams[0]; el.play().catch(() => {});
      ac = new AudioContext();
      analyser = ac.createAnalyser();
      ac.createMediaStreamSource(e.streams[0]).connect(analyser);
    };

    if (${JSON.stringify(role)} === "caller") {
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      send({ type: "call", op: "offer", to: ${peerID}, callID: "rtcx", sdp: pc.localDescription.sdp });
      const ans = await waitFrame((f) => f.type === "call" && f.op === "answer", "answer");
      await pc.setRemoteDescription({ type: "answer", sdp: ans.sdp });
    } else {
      const off = await waitFrame((f) => f.type === "call" && f.op === "offer" && f.sdp && f.sdp.startsWith("v="), "offer");
      await pc.setRemoteDescription({ type: "offer", sdp: off.sdp });
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      send({ type: "call", op: "answer", to: ${peerID}, callID: "rtcx", sdp: pc.localDescription.sdp });
    }

    for (let i = 0; i < 50 && (!analyser || pc.connectionState !== "connected"); i++) await new Promise((r) => setTimeout(r, 500));
    for (let i = 0; i < 50 && (!analyser || pc.connectionState !== "connected"); i++) await new Promise((r) => setTimeout(r, 500));
    await new Promise((r) => setTimeout(r, 800));
    let peak = 0;
    if (analyser) {
      const buf = new Float32Array(analyser.fftSize);
      const t0 = Date.now();
      while (Date.now() - t0 < 3000) {
        analyser.getFloatTimeDomainData(buf);
        for (const v of buf) { const a = Math.abs(v); if (a > peak) peak = a; }
        await new Promise((r) => setTimeout(r, 100));
      }
    }
    const out = { role: ${JSON.stringify(role)}, state: pc.connectionState, ice: pc.iceConnectionState, sentIce, gotIce, hasIncoming: !!analyser, peak: +peak.toFixed(4) };
    if (ac) ac.close();
    stream.getTracks().forEach((t) => t.stop());
    done(out);
  } catch (e) { done({ role: ${JSON.stringify(role)}, err: e.message }); }
})();
</script>`;
}

(async () => {
  const alice = await login("Алиса");
  const users = await fetch(B + "/api/users", { headers: { Authorization: "Bearer " + alice.token } }).then((r) => r.json());
  const katya = users.find((u) => u.name === "Катя");
  const klogin = await login("Катя");

  fs.writeFileSync("C:/Temp/lh-agent-a.html", agent(alice.token, "caller", katya.id));
  fs.writeFileSync("C:/Temp/lh-agent-k.html", agent(klogin.token, "callee", alice.user.id));

  const srv = http.createServer((req, res) => {
    const f = req.url.startsWith("/k") ? "C:/Temp/lh-agent-k.html" : "C:/Temp/lh-agent-a.html";
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.end(fs.readFileSync(f));
  }).listen(18099, "127.0.0.1");
  await wait(400);

  const chrome = "C:/Program Files/Google/Chrome/Application/chrome.exe";
  const procs = [];
  const runAgent = (url, key) => {
    const out = fs.openSync("C:/Temp/lh-rtc-" + key + ".log", "w");
    const p = spawn(chrome, [
      "--headless=new", "--disable-gpu", "--no-sandbox",
      "--user-data-dir=C:/Temp/lh-prof-" + key,
      "--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream",
      "--autoplay-policy=no-user-gesture-required",
      "--enable-logging=stderr", "--v=0", url,
    ], { stdio: ["ignore", out, out] });
    procs.push(p);
  };

  console.log("старт: два агента, звонок Алиса → Катя через " + B);
  runAgent("http://127.0.0.1:18099/a.html", "a");
  runAgent("http://127.0.0.1:18099/k.html", "k");

  let results = {};
  for (let t = 0; t < 45; t++) {
    await wait(2000);
    results = {};
    for (const k of ["a", "k"]) {
      try {
        const log = fs.readFileSync("C:/Temp/lh-rtc-" + k + ".log", "utf8");
        const m = log.match(/RTC_RESULT: ?(\{.*\})/);
        if (m) results[k] = m[1];
      } catch (e) {}
    }
    if (results.a && results.k) break;
  }
  procs.forEach((p) => { try { p.kill(); } catch (e) {} });
  try { srv.close(); } catch (e) {}

  const fa = results.a ? JSON.parse(results.a) : { err: "нет результата" };
  const fk = results.k ? JSON.parse(results.k) : { err: "нет результата" };
  console.log("Алиса (звонила):", JSON.stringify(fa));
  console.log("Катя (приняла): ", JSON.stringify(fk));

  const ok = fa.hasIncoming && fk.hasIncoming && fa.peak > 0.01 && fk.peak > 0.01 && fa.state === "connected" && fk.state === "connected";
  console.log(ok ? "=== ЗВУК ИДЁТ В ОБЕ СТОРОНЫ ===" : "=== ЗВУКА НЕТ ===");
  process.exit(ok ? 0 : 1);
})().catch((e) => { console.error("FATAL", e.message); process.exit(1); });
