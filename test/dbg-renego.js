/* Диагностика renego: что происходит при включении камеры. */
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
  const dir = "C:/Temp/lh-dg-" + port;
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
  const U1 = await mk("ДгА" + suf), U2 = await mk("ДгБ" + suf);
  const A = await launch(18421, B + "/?token=" + U1.token);
  const Bc = await launch(18422, B + "/?token=" + U2.token);
  const ca = await connect(A.port), cb = await connect(Bc.port);
  console.log("clients up");
  await wait(2000);
  const aMe = await ca.eval(`me && me.name`), bMe = await cb.eval(`me && me.name`);
  console.log("A=", aMe, " B=", bMe);
  // логируем отправку call-кадров у B
  await cb.eval(`window._sent=[];const _s=send;send=function(f){if(f.type==='call')window._sent.push({op:f.op,renego:!!f.renego,to:f.to});return _s(f)}`);
  const aSock = await ca.eval(`sock && sock.readyState`), bSock = await cb.eval(`sock && sock.readyState`);
  console.log("ws:", aSock, bSock);
  await ca.eval(`openChat(${U2.user.id})`); await wait(300);
  await ca.eval(`document.getElementById('callb').click()`);
  let ring = false;
  for (let i = 0; i < 20 && !ring; i++) { await wait(500); ring = await cb.eval(`call.active && call.dir === "in"`); }
  console.log("входящий у B:", ring);
  const bState1 = await cb.eval(`({active:call.active,mode:call.mode,dir:call.dir,cs:document.getElementById('cs').textContent})`);
  console.log("B до ответа:", JSON.stringify(bState1));
  await cb.eval(`document.getElementById('cacc').click()`);
  await wait(2000);
  const bState2 = await cb.eval(`({active:call.active,mode:call.mode,ice:call.pc?call.pc.connectionState:"none",cs:document.getElementById('cs').textContent})`);
  console.log("B после ответа:", JSON.stringify(bState2));
  const aState2 = await ca.eval(`({active:call.active,mode:call.mode,ice:call.pc?call.pc.connectionState:"none",cs:document.getElementById('cs').textContent})`);
  console.log("A после ответа B:", JSON.stringify(aState2));
  let tb = false;
  for (let i = 0; i < 60 && !tb; i++) { await wait(1000); tb = await cb.eval(`call.mode === "talk"`); }
  console.log("talk:", tb);
  await cb.eval(`document.getElementById('ccam').click()`);
  await wait(4000);
  const sent = await cb.eval(`window._sent`);
  console.log("B отправил call-кадры:", JSON.stringify(sent));
  const bSenders = await cb.eval(`call.pc.getSenders().map(s=>s.track?s.track.kind:'null')`);
  console.log("B senders:", JSON.stringify(bSenders));
  const aRecv = await ca.eval(`({rv:!!document.getElementById('rvideo').srcObject, rs:call.pc.getReceivers().map(r=>r.track?r.track.kind:'null')})`);
  console.log("A:", JSON.stringify(aRecv));
  A.proc.kill(); Bc.proc.kill();
  process.exit(0);
})().catch((e) => { console.error("FATAL", e.message); process.exit(1); });
