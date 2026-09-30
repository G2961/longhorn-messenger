/* Полный цикл: логин телефона через localStorage + reload + сквозной звонок
   с проверкой foreground-сервиса. Всё в одном скрипте. */
const { connect } = require("./cdp-helper.js");
const { spawn } = require("child_process");
const fs = require("fs");
const { execSync } = require("child_process");
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const B = "https://lh.g2961.space";
const CHROME = "C:/Program Files/Google/Chrome/Application/chrome.exe";
const { getJSON } = require("./cdp-helper.js");
const mk = (n) => fetch(B + "/api/register", {
  method: "POST", headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ name: n, password: "test1234", avatar: 3 }),
}).then((r) => r.json());
function launch(port, url) {
  const dir = "C:/Temp/lh-full-" + port;
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
function adb(cmd) { try { return execSync(`adb -s 192.168.1.147:37707 shell "${cmd}"`, { encoding: "utf8" }); } catch (e) { return e.stdout || ""; } }

(async () => {
  // 1) логин телефона
  const telName = "тел" + Math.random().toString(36).slice(2, 7);
  const tel = await mk(telName);
  let ct = await connect(9222);
  await ct.eval(`localStorage.setItem('lh-token','${tel.token}')`);
  await ct.eval(`location.reload()`);
  await wait(6000);

  const pid = adb("pidof dev.longhorn.messenger").trim();
  execSync(`adb -s 192.168.1.147:37707 forward tcp:9222 localabstract:webview_devtools_remote_${pid}`);
  ct = await connect(9222);
  const me = await ct.eval(`me && me.name`);
  console.log("телефон залогинен:", me);
  if (!me) throw new Error("телефон не залогинился");

  // 2) комп
  const suf = Date.now().toString(36).slice(-5);
  const desk = await mk("Комп" + suf);
  const D = await launch(18407, B + "/?token=" + desk.token);
  const cd = await connect(D.port);
  // refresh списка на телефоне
  await ct.eval(`location.reload()`);
  await wait(6000);
  const pid2 = adb("pidof dev.longhorn.messenger").trim();
  execSync(`adb -s 192.168.1.147:37707 forward tcp:9222 localabstract:webview_devtools_remote_${pid2}`);
  ct = await connect(9222);
  await wait(1500);

  // 3) звонок телефон → комп
  await ct.eval(`openChat(${desk.user.id})`);
  await wait(500);
  await ct.eval(`startCall(${desk.user.id})`);
  let ring = false;
  for (let i = 0; i < 25 && !ring; i++) { await wait(500); ring = await cd.eval(`call.active && call.dir === 'in'`); }
  console.log(ring ? "ok - входящий" : "FAIL - входящий");
  if (!ring) throw new Error("нет входящего");
  await cd.eval(`document.getElementById('cacc').click()`);
  let talk = false;
  for (let i = 0; i < 45 && !talk; i++) { await wait(1000); talk = await ct.eval(`call.mode === 'talk'`); }
  console.log("talk:", talk);

  // 4) foreground-сервис во время talk
  if (talk) {
    await wait(2500);
    const svc = adb("dumpsys activity services dev.longhorn.messenger | grep -c CallService").trim();
    console.log("CallService в dumpsys (строк):", svc, svc > 0 ? "→ СЕРВИС РАБОТАЕТ" : "→ СЕРВИСА НЕТ");
    const notif = adb("dumpsys notification --noredact 2>/dev/null | grep -A2 'Longhorn' | head -4");
    console.log("уведомление:", JSON.stringify(notif.slice(0, 200)));
  }

  // 5) живёт 15с
  await wait(15000);
  const a1 = await ct.eval(`call.active`).catch(() => null);
  const a2 = await cd.eval(`call.active`).catch(() => null);
  console.log((a1 && a2 ? "ok" : "FAIL") + " - звонок жив спустя 15с (" + a1 + "/" + a2 + ")");

  await ct.eval(`document.getElementById('cend').click()`).catch(() => {});
  console.log("=== ГОТОВО ===");
  D.proc.kill();
  process.exit(0);
})().catch((e) => { console.error("FATAL", e.message); process.exit(1); });
