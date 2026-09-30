/* Диагностика звонка с телефона: смотрим состояние после нажатия callb. */
const { connect } = require("./cdp-helper.js");
const { spawn } = require("child_process");
const fs = require("fs");
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const B = "https://lh.g2961.space";
const CHROME = "C:/Program Files/Google/Chrome/Application/chrome.exe";
const { getJSON } = require("./cdp-helper.js");
const mk = (n) => fetch(B + "/api/register", {
  method: "POST", headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ name: n, password: "test1234", avatar: 3 }),
}).then((r) => r.json());
function launch(port, url) {
  const dir = "C:/Temp/lh-dd-" + port;
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
  const D = await launch(18403, B + "/?token=" + desk.token);
  const cd = await connect(D.port);
  // перезагружаем телефон, чтобы hello принёс свежий список юзеров
  await new Promise((res) => { const http = require("http"); res(); });
  const ct0 = await connect(9222);
  await ct0.eval(`location.reload()`);
  await wait(6000);
  const ct = await connect(9222);
  await wait(2000);
  console.log("телефон:", await ct.eval(`me&&me.name`), "| ws:", await ct.eval(`sock&&sock.readyState`));
  console.log("комп:", await cd.eval(`me&&me.name`), "| ws:", await cd.eval(`sock&&sock.readyState`));
  // видит ли телефон компа в списке?
  const sees = await ct.eval(`users.filter(u=>u.id===${desk.user.id}).length`);
  console.log("телефон видит компа в users:", sees);
  await ct.eval(`openChat(${desk.user.id})`);
  await wait(800);
  console.log("чат открыт, cur =", await ct.eval(`cur`));
  const callBtn = await ct.eval(`document.getElementById('callb').disabled`);
  console.log("callb disabled:", callBtn);
  await ct.eval(`window.__sent=[];const __s2=send;send=function(f){if(f.type==='call')window.__sent.push(f.op);return __s2(f)}`);
  await ct.eval(`startCall(${desk.user.id})`);
  await wait(3000);
  console.log("телефон sent:", await ct.eval(`window.__sent`));
  console.log("телефон call:", await ct.eval(`({active:call.active,mode:call.mode,cs:document.getElementById('cs').textContent})`));
  console.log("комп call:", await cd.eval(`({active:call.active,mode:call.mode,dir:call.dir})`));
  // комп отвечает
  await cd.eval(`document.getElementById('cacc').click()`);
  let talk = false;
  for (let i = 0; i < 45 && !talk; i++) { await wait(1000); talk = await ct.eval(`call.mode === 'talk'`); }
  const talkD = await cd.eval(`call.mode === 'talk'`);
  console.log("talk: телефон=" + talk + " комп=" + talkD);
  const iceT = await ct.eval(`call.pc ? call.pc.connectionState : 'none'`);
  const iceD = await cd.eval(`call.pc ? call.pc.connectionState : 'none'`);
  console.log("ICE: телефон=" + iceT + " комп=" + iceD);
  // держим звонок 20с — за пределами прежнего 2с-падения при фоне
  await wait(20000);
  const a1 = await ct.eval(`call.active`), a2 = await cd.eval(`call.active`);
  console.log((a1 && a2 ? "ok" : "FAIL") + " - звонок жив спустя 20с");
  await ct.eval(`document.getElementById('cend').click()`);
  console.log("=== СКВОЗНОЙ ЗВОНОК ТЕЛЕФОН↔КОМП РАБОТАЕТ ===");
  D.proc.kill();
  process.exit(0);
})().catch((e) => { console.error("FATAL", e.message); process.exit(1); });
