/* Быстрый сквозной тест без телефона: два headless Chrome на проде.
   Проверяет: звонок, talk, обрыв WS в talk (фон) → звонок жив, реконнект,
   видео-добавление (renego) с fake-камеры, звук. */
const { spawn } = require("child_process");
const fs = require("fs");
const { connect, getJSON } = require("./cdp-helper.js");

const B = process.env.BASE || "https://lh.g2961.space";
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const CHROME = "C:/Program Files/Google/Chrome/Application/chrome.exe";

const mk = (n) => fetch(B + "/api/register", {
  method: "POST", headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ name: n, password: "test1234", avatar: 3 }),
}).then((r) => r.json());

function launch(port, url) {
  const dir = "C:/Temp/lh-bg-" + port;
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) {}
  return new Promise((resolve) => {
    const p = spawn(CHROME, [
      "--headless=new", "--disable-gpu", "--no-sandbox", "--user-data-dir=" + dir,
      "--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream",
      "--autoplay-policy=no-user-gesture-required",
      "--remote-debugging-port=" + port, "--no-first-run", url,
    ], { stdio: "ignore" });
    (async () => {
      for (let i = 0; i < 60; i++) {
        try { await getJSON(port, "/json/version"); resolve({ proc: p, port }); return; } catch (e) {}
        await wait(500);
      }
      resolve(null);
    })();
  });
}

(async () => {
  const suf = Date.now().toString(36).slice(-5);
  const U1 = await mk("ФонА" + suf), U2 = await mk("ФонБ" + suf);
  const A = await launch(18411, B + "/?token=" + U1.token);
  const Bc = await launch(18412, B + "/?token=" + U2.token);
  if (!A || !Bc) throw new Error("браузеры не поднялись");
  const ca = await connect(A.port), cb = await connect(Bc.port);
  console.log("оба клиента готовы");
  const ok = (c, n) => { console.log((c ? "ok" : "FAIL") + " - " + n); if (!c) process.exitCode = 1; };

  // 1) A звонит B
  await ca.eval(`openChat(${U2.user.id})`);
  await wait(400);
  await ca.eval(`document.getElementById('callb').click()`);
  let ring = false;
  for (let i = 0; i < 20 && !ring; i++) { await wait(500); ring = await cb.eval(`call.active && call.dir === "in"`); }
  ok(ring, "входящий дошёл");
  await cb.eval(`document.getElementById('cacc').click()`);

  let ta = false, tb = false;
  for (let i = 0; i < 40 && !(ta && tb); i++) {
    await wait(1000);
    if (!ta) ta = await ca.eval(`call.mode === "talk"`);
    if (!tb) tb = await cb.eval(`call.mode === "talk"`);
  }
  ok(ta && tb, "talk у обоих");

  // 2) обрыв WS у B во время talk (эмуляция сворачивания)
  await cb.eval(`sock.close()`);
  await wait(2500);
  const aAlive = await ca.eval(`call.active`);
  const bAlive = await cb.eval(`call.active`);
  ok(aAlive && bAlive, "звонок жив после обрыва WS (grace)");
  const bState = await cb.eval(`call.wsWasDown`);
  ok(bState === true, "клиент помнит обрыв и не убил звонок");

  // 3) B реконнектился (авто-reconnect уже должен был сработать)
  await wait(6000);
  const bSock = await cb.eval(`sock && sock.readyState`);
  ok(bSock === 1, "WS B восстановился");
  const stillTalk = await ca.eval(`call.mode`) === "talk" && await cb.eval(`call.mode`) === "talk";
  ok(stillTalk, "разговор продолжается после реконнекта");

  // 4) видео: B включает камеру → renego → у A появляется видеотрек
  await cb.eval(`document.getElementById('ccam').click()`);
  let vidA = false;
  for (let i = 0; i < 25 && !vidA; i++) {
    await wait(1000);
    vidA = await ca.eval(`!!document.getElementById('rvideo').srcObject`);
  }
  ok(vidA, "видео дошло до A (renego)");
  const ice = await ca.eval(`call.pc.connectionState`);
  ok(ice === "connected", "ICE жив (" + ice + ")");

  // 5) звук в обе стороны
  const measure = `new Promise(res=>{
    const el=document.getElementById('raudio');
    if(!el||!el.srcObject){res({has:false});return}
    const ac=new AudioContext();const an=ac.createAnalyser();
    ac.createMediaStreamSource(el.srcObject).connect(an);
    const buf=new Float32Array(an.fftSize);let peak=0;
    const iv=setInterval(()=>{an.getFloatTimeDomainData(buf);
      for(const v of buf){const q=Math.abs(v);if(q>peak)peak=q}},100);
    setTimeout(()=>{clearInterval(iv);res({has:true,peak:+peak.toFixed(3)})},2500)})`;
  const ra = await ca.evalAsync(measure), rb = await cb.evalAsync(measure);
  ok(ra.has && ra.peak > 0.01, "A слышит B (peak=" + (ra.peak || 0) + ")");
  ok(rb.has && rb.peak > 0.01, "B слышит A (peak=" + (rb.peak || 0) + ")");

  await ca.eval(`document.getElementById('cend').click()`);
  console.log("=== SMOKE DONE ===");
  A.proc.kill(); Bc.proc.kill();
  setTimeout(() => process.exit(process.exitCode || 0), 1500);
})().catch((e) => { console.error("FATAL", e.message); process.exit(1); });
