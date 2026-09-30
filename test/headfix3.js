/* Фокус textarea из JS + показ клавиатуры (showSoftInput нельзя из adb напрямую;
   используем тап с предварительным_RECORD). Упрощённо: фокус + замер. */
const { execSync } = require("child_process");
const { connect } = require("./cdp-helper.js");
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const adb = (c) => execSync(`adb -s 192.168.1.147:37707 shell "${c}"`, { encoding: "utf8" });

(async () => {
  execSync(`adb -s 192.168.1.147:37707 shell "input keyevent KEYCODE_WAKEUP; input keyevent 82; wm dismiss-keyguard; am start -n dev.longhorn.messenger/.MainActivity"`, { stdio: "ignore" });
  await wait(4000);
  const pid = adb("pidof dev.longhorn.messenger").trim();
  execSync(`adb -s 192.168.1.147:37707 forward tcp:9222 localabstract:webview_devtools_remote_${pid}`);
  const ct = await connect(9222);
  const botId = await ct.eval(`(users.find(u=>u.bot)||{}).id`);
  await ct.eval(`openChat(${botId})`);
  await wait(600);
  const b = JSON.parse(await ct.eval(`JSON.stringify({h:document.querySelector('.head').getBoundingClientRect().top,vh:innerHeight})`));
  console.log("до:", b);
  // реальный тап через uiautomator по видимой textarea — уже делали; теперь
  // пробуем тап с большей задержкой и проверкой фокуса
  const r = await ct.eval(`document.getElementById('txt').getBoundingClientRect()`);
  adb(`input tap ${Math.round(r.x + 60)} ${Math.round(r.y + r.height / 2)}`);
  await wait(3500);
  const focused = await ct.eval(`document.activeElement && document.activeElement.id`);
  const a = JSON.parse(await ct.eval(`JSON.stringify({h:document.querySelector('.head').getBoundingClientRect().top,vh:innerHeight})`));
  const kb = adb(`dumpsys input_method | grep -o "mInputShown=[a-z]*"`).trim();
  console.log("после:", a, "focus:", focused, kb);
  const ok = kb.includes("true") && Math.abs(a.h - b.h) < 2;
  console.log(ok ? "ok - ХЕДЕР ДЕРЖИТСЯ" : (Math.abs(a.h - b.h) < 2 ? "ok* - хедер держится (IME не открылся)" : "FAIL"));
  adb(`input keyevent 111`);
  process.exit(0);
})().catch((e) => { console.error("FATAL", e.message); process.exit(1); });
