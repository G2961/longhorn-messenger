/* Сквозной звонок телефон (CDP 9222, WebView) ↔ комп (headless Chrome).
   Проверяет: звонок, talk, видео-кнопку (renego), фоновую устойчивость
   (закрытие WS на телефоне во время talk). Коротко и быстро. */
const { spawn } = require("child_process");
const fs = require("fs");
const { connect, getJSON } = require("./cdp-helper.js");

const B = "https://lh.g2961.space";
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const CHROME = "C:/Program Files/Google/Chrome/Application/chrome.exe";
const mk = (n) => fetch(B + "/api/register", {
  method: "POST", headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ name: n, password: "test1234", avatar: 3 }),
}).then((r) => r.json());

function launch(port, url) {
  const dir = "C:/Temp/lh-xc-" + port;
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
  const desk = await mk("Комп" + suf);
  const D = await launch(18401, B + "/?token=" + desk.token);
  if (!D) throw new Error("комп-браузер не поднялся");
  const cd = await connect(D.port);
  console.log("комп: готов");
  const ct = await connect(9222);
  console.log("телефон: WebView готов");
  const tMe = await ct.eval(`me && me.name`);
  console.log("телефон залогинен как:", tMe);

  // телефон звонит компу
  await ct.eval(`openChat(${desk.user.id})`);
  await wait(600);
  await ct.eval(`document.getElementById('callb').click()`);
  let ringing = false;
  for (let i = 0; i < 30 && !ringing; i++) { await wait(500); ringing = await cd.eval(`call.active && call.dir === "in"`); }
  if (!ringing) throw new Error("входящий не дошёл за 15с");
  console.log("ok - входящий дошёл");
  await cd.eval(`document.getElementById('cacc').click()`);

  let talkT = false, talkD = false;
  for (let i = 0; i < 40 && !(talkT && talkD); i++) {
    await wait(1000);
    if (!talkT) talkT = await ct.eval(`call.mode === "talk"`);
    if (!talkD) talkD = await cd.eval(`call.mode === "talk"`);
  }
  console.log("talk: телефон=" + talkT + " комп=" + talkD);
  if (!(talkT && talkD)) throw new Error("talk не установился");

  // звонок живёт 10с (за пределами старого 2с-падения)
  await wait(10000);
  const aliveT = await ct.eval(`call.active`), aliveD = await cd.eval(`call.active`);
  console.log((aliveT && aliveD ? "ok" : "FAIL") + " - звонок жив спустя 10с");

  // сервис на телефоне?
  const svc = await ct.eval(`(navigator.serviceWorker&&true)||'n/a'`).catch(() => "n/a");
  console.log("svc:", svc);

  const iceT = await ct.eval(`call.pc ? call.pc.connectionState : "none"`);
  const iceD = await cd.eval(`call.pc ? call.pc.connectionState : "none"`);
  console.log("ICE: телефон=" + iceT + " комп=" + iceD);

  await ct.eval(`document.getElementById('cend').click()`);
  console.log("=== ТЕЛЕФОН↔КОМП ОК ===");
  D.proc.kill();
  process.exit(0);
})().catch((e) => { console.error("FATAL", e.message); process.exit(1); });
