/* Проверка: хедер не уезжает при открытой клавиатуре.
   Меряем положение .head до и после показа клавиатуры (через adb). */
const { execSync } = require("child_process");
const { connect } = require("./cdp-helper.js");
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const adb = (c) => execSync(`adb -s 192.168.1.147:37707 shell "${c}"`, { encoding: "utf8" });

(async () => {
  execSync(`adb -s 192.168.1.147:37707 shell "input keyevent KEYCODE_WAKEUP; input keyevent 82; wm dismiss-keyguard; am start -n dev.longhorn.messenger/.MainActivity"`, { stdio: "ignore" });
  await wait(5000);
  const pid = adb("pidof dev.longhorn.messenger").trim();
  execSync(`adb -s 192.168.1.147:37707 forward tcp:9222 localabstract:webview_devtools_remote_${pid}`);
  const ct = await connect(9222);
  const me = await ct.eval(`me && me.name`);
  if (!me) { console.log("не залогинен — логиню"); 
    const r = await fetch("https://lh.g2961.space/api/register", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: "хедер" + Math.random().toString(36).slice(2, 6), password: "test1234", avatar: 1 }) }).then((x) => x.json());
    await ct.eval(`localStorage.setItem('lh-token','${r.token}');location.reload()`);
    await wait(5000);
    const pid2 = adb("pidof dev.longhorn.messenger").trim();
    execSync(`adb -s 192.168.1.147:37707 forward tcp:9222 localabstract:webview_devtools_remote_${pid2}`);
  }
  const ct2 = await connect(9222);
  await wait(1000);
  // открыть чат с Эхо-ботом (id из users)
  const botId = await ct2.eval(`(users.find(u=>u.bot)||{}).id`);
  console.log("чат с:", botId);
  await ct2.eval(`openChat(${botId})`);
  await wait(800);
  const headBefore = await ct2.eval(`JSON.stringify(document.querySelector('.head').getBoundingClientRect())`);
  console.log("head до клавиатуры:", headBefore);

  // показать клавиатуру: тап по полю ввода
  adb(`input tap 540 2200`);
  await wait(2500);
  const headAfter = await ct2.eval(`JSON.stringify(document.querySelector('.head').getBoundingClientRect())`);
  console.log("head при клавиатуре:", headAfter);
  const kb = adb(`dumpsys input_method | grep -o "mInputShown=[a-z]*"`).trim();
  console.log("клавиатура:", kb);

  const ok = JSON.parse(headBefore).top === JSON.parse(headAfter).top;
  console.log(ok ? "ok - ХЕДЕР НЕ УЕХАЛ" : "FAIL - хедер сместился");
  adb(`input keyevent 111`); // esc
  process.exit(ok ? 0 : 1);
})().catch((e) => { console.error("FATAL", e.message); process.exit(1); });
