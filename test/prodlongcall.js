/* Длинный звонок (>60с) через реальный UI: раньше WS idle-таймаут убивал звонок на ~60й секунде.
   Запуск: node test/prodlongcall.js */
const { spawn } = require("child_process");
const { connect, getJSON } = require("./cdp-helper.js");
const fs = require("fs");

const B = process.env.BASE || "https://lh.g2961.space";
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const CHROME = "C:/Program Files/Google/Chrome/Application/chrome.exe";

const mk = (n) => fetch(B + "/api/register", {
  method: "POST", headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ name: n, password: "test1234", avatar: 3 }),
}).then((r) => r.json());

function launch(key, port, url) {
  const dir = "C:/Temp/lh-long-" + port;
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) {}
  return new Promise((resolve) => {
    const p = spawn(CHROME, [
      "--headless=new", "--disable-gpu", "--no-sandbox",
      "--user-data-dir=" + dir,
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
  const a = await mk("ДлитА" + suf), b = await mk("ДлитБ" + suf);
  const A = await launch("a", 19201, B + "/?token=" + a.token);
  const K = await launch("k", 19202, B + "/?token=" + b.token);
  if (!A || !K) throw new Error("браузеры не поднялись");
  const ca = await connect(A.port), ck = await connect(K.port);
  await wait(4000);

  // следим за WS обеих сторон
  for (const c of [ca, ck]) {
    await c.eval(`window.__wsDied=false;
      const _oc=sock.onclose; sock.onclose=ev=>{window.__wsDied=true; _oc&&_oc(ev)};`);
  }

  // звонок
  await ca.eval(`openChat(${b.user.id}); document.getElementById('callb').click()`);

  // ждём, пока у принимающего реально зазвонит (до 15с)
  let ringing = false;
  for (let i = 0; i < 30 && !ringing; i++) {
    await wait(500);
    ringing = await ck.eval(`call.active && call.dir === "in"`);
  }
  if (!ringing) throw new Error("входящий не дошёл за 15с");
  console.log("входящий дошёл, отвечаем...");

  await ck.eval(`document.getElementById('cacc').click()`);

  // ждём, пока разговор начнётся у обеих сторон (до 15с)
  let talking = false;
  for (let i = 0; i < 30 && !talking; i++) {
    await wait(500);
    const ma = await ca.eval(`call.mode === "talk"`);
    const mk2 = await ck.eval(`call.mode === "talk"`);
    talking = ma && mk2;
  }
  if (!talking) throw new Error("разговор не начался за 15с");
  console.log("разговор начался. держим 80 секунд (порог смерти был ~60с)...");

  let alive = true;
  for (let t = 20; t <= 80; t += 20) {
    await wait(20000);
    const sa = await ca.eval(`({wsDied: window.__wsDied, active: call.active, mode: call.mode, ice: call.pc ? call.pc.connectionState : "none"})`);
    const sk = await ck.eval(`({wsDied: window.__wsDied, active: call.active, mode: call.mode, ice: call.pc ? call.pc.connectionState : "none"})`);
    console.log(`t=${t}с звонящий:`, JSON.stringify(sa), ` принимающий:`, JSON.stringify(sk));
    if (sa.wsDied || sk.wsDied || !sa.active || !sk.active || sa.mode !== "talk" || sk.mode !== "talk") alive = false;
  }

  // звук после 80с разговора
  const measure = `new Promise(res=>{
    const el=document.getElementById('raudio');
    if(!el||!el.srcObject){res({has:false});return}
    const ac=new AudioContext();const an=ac.createAnalyser();
    ac.createMediaStreamSource(el.srcObject).connect(an);
    const buf=new Float32Array(an.fftSize);let peak=0;
    const iv=setInterval(()=>{an.getFloatTimeDomainData(buf);
      for(const v of buf){const q=Math.abs(v);if(q>peak)peak=q}},100);
    setTimeout(()=>{clearInterval(iv);res({has:true,peak:+peak.toFixed(3)})},2500)})`;
  const ra = await ca.evalAsync(measure), rk = await ck.evalAsync(measure);
  console.log("звук после 80с — звонящий:", JSON.stringify(ra), "принимающий:", JSON.stringify(rk));

  await ca.eval(`document.getElementById('cend').click()`);
  A.proc.kill(); K.proc.kill();

  const ok = alive && ra.has && ra.peak > 0.01 && rk.has && rk.peak > 0.01;
  console.log(ok ? "=== ДЛИННЫЙ ЗВОНОК ВЫЖИЛ, ЗВУК ЕСТЬ ===" : "=== ПРОВАЛ ===");
  process.exit(ok ? 0 : 1);
})().catch((e) => { console.error("FATAL", e.message); process.exit(1); });
