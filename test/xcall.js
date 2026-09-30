/* Сквозной звонок: Android-телефон (CDP 9222) ↔ комп (headless Chrome).
   Оба за VPN (WARP/свой VPN) — раньше P2P падал, теперь должен пройти через TURN. */
const { spawn } = require("child_process");
const { connect, getJSON } = require("./cdp-helper.js");
const fs = require("fs");

const B = "https://lh.g2961.space";
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const CHROME = "C:/Program Files/Google/Chrome/Application/chrome.exe";

const mk = (n) => fetch(B + "/api/register", {
  method: "POST", headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ name: n, password: "test1234", avatar: 3 }),
}).then((r) => r.json());

function launch(key, port, url) {
  const dir = "C:/Temp/lh-xcall-" + port;
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
  const desktop = await mk("Комп" + suf);

  // 1) комп в headless Chrome
  const D = await launch("d", 18401, B + "/?token=" + desktop.token);
  if (!D) throw new Error("комп-браузер не поднялся");
  const cd = await connect(D.port);
  console.log("комп: браузер готов");

  // 2) телефон через CDP 9222 (проброшен adb forward)
  const ct = await connect(9222);
  console.log("телефон: WebView готов");

  await wait(2500);

  // телефон звонит компу
  await ct.eval(`openChat(${desktop.user.id})`);
  await wait(600);
  await ct.eval(`document.getElementById('callb').click()`);
  console.log("телефон: звонит");

  // комп ждёт входящий и отвечает
  let ringing = false;
  for (let i = 0; i < 30 && !ringing; i++) {
    await wait(500);
    ringing = await cd.eval(`call.active && call.dir === "in"`);
  }
  if (!ringing) throw new Error("входящий не дошёл до компа за 15с");
  console.log("комп: входящий, отвечаем");
  await cd.eval(`document.getElementById('cacc').click()`);

  // ждём talk у обоих (TURN по TCP может собираться до ~15с)
  let talkT = false, talkD = false;
  for (let i = 0; i < 40 && !(talkT && talkD); i++) {
    await wait(1000);
    if (!talkT) talkT = await ct.eval(`call.mode === "talk"`);
    if (!talkD) talkD = await cd.eval(`call.mode === "talk"`);
  }
  console.log("talk: телефон=" + talkT + " комп=" + talkD);

  const iceT = await ct.eval(`call.pc ? call.pc.connectionState : "none"`);
  const iceD = await cd.eval(`call.pc ? call.pc.connectionState : "none"`);
  console.log("ICE: телефон=" + iceT + " комп=" + iceD);

  if (talkT && talkD && iceT === "connected" && iceD === "connected") {
    // звук с обеих сторон
    const measure = `new Promise(res=>{
      const el=document.getElementById('raudio');
      if(!el||!el.srcObject){res({has:false});return}
      const ac=new AudioContext();const an=ac.createAnalyser();
      ac.createMediaStreamSource(el.srcObject).connect(an);
      const buf=new Float32Array(an.fftSize);let peak=0;
      const iv=setInterval(()=>{an.getFloatTimeDomainData(buf);
        for(const v of buf){const q=Math.abs(v);if(q>peak)peak=q}},100);
      setTimeout(()=>{clearInterval(iv);res({has:true,peak:+peak.toFixed(3)})},3000)})`;
    const ra = await ct.evalAsync(measure);
    const rb = await cd.evalAsync(measure);
    console.log("звук: телефон слышит", JSON.stringify(ra), "| комп слышит", JSON.stringify(rb));
    await ct.eval(`document.getElementById('cend').click()`);
    D.proc.kill();
    const ok = ra.has && ra.peak > 0.01 && rb.has && rb.peak > 0.01;
    console.log(ok ? "=== ЗВОНОК ТЕЛЕФОН↔КОМП РАБОТАЕТ (через TURN) ===" : "=== СОЕДИНЕНИЕ ЕСТЬ, НО ЗВУКА НЕТ ===");
    process.exit(ok ? 0 : 1);
  } else {
    const stT = await ct.eval(`({mode:call.mode, ice:call.pc?call.pc.connectionState:"none", cs:document.getElementById("cs").textContent})`);
    const stD = await cd.eval(`({mode:call.mode, ice:call.pc?call.pc.connectionState:"none", cs:document.getElementById("cs").textContent})`);
    console.log("ПРОВАЛ. телефон:", JSON.stringify(stT), "комп:", JSON.stringify(stD));
    D.proc.kill();
    process.exit(1);
  }
})().catch((e) => { console.error("FATAL", e.message); process.exit(1); });
