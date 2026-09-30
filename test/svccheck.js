/* Проверка foreground-сервиса звонка: звоним, ждём talk, смотрим dumpsys. */
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
  const dir = "C:/Temp/lh-svc-" + port;
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
  const D = await launch(18405, B + "/?token=" + desk.token);
  const cd = await connect(D.port);
  const ct0 = await connect(9222);
  await ct0.eval(`location.reload()`);
  await wait(6000);
  const ct = await connect(9222);
  await ct.eval(`openChat(${desk.user.id})`);
  await wait(500);
  await ct.eval(`startCall(${desk.user.id})`);
  let ring = false;
  for (let i = 0; i < 25 && !ring; i++) { await wait(500); ring = await cd.eval(`call.active && call.dir === 'in'`); }
  if (!ring) throw new Error("нет входящего");
  await cd.eval(`document.getElementById('cacc').click()`);
  let talk = false;
  for (let i = 0; i < 45 && !talk; i++) { await wait(1000); talk = await ct.eval(`call.mode === 'talk'`); }
  console.log("talk:", talk);
  if (talk) {
    // сервис должен работать во время talk — проверяем из adb (снаружи не можем, просто ждём и логируем из JS)
    const tauriOk = await ct.eval(`(typeof tauri !== 'undefined') && !!tauri.invoke`);
    console.log("tauri.invoke доступен:", tauriOk);
    await wait(3000);
    console.log("режим звонка:", await ct.eval(`call.mode`));
  }
  await ct.eval(`document.getElementById('cend').click()`);
  D.proc.kill();
  process.exit(0);
})().catch((e) => { console.error("FATAL", e.message); process.exit(1); });
