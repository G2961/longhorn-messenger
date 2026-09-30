/* Полная проверка клавиатуры: чат открыт → тап в поле → клавиатура →
   замер шапки/ленты/поля. Всё с реальным IME (тачу по EditText из uiautomator). */
const { execSync } = require("child_process");
const { connect } = require("./cdp-helper.js");
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const adb = (c) => execSync(`adb -s 192.168.1.147:37707 shell "${c}"`, { encoding: "utf8" });

(async () => {
  adb(`input keyevent KEYCODE_WAKEUP; input keyevent 82; wm dismiss-keyguard`);
  await wait(1500);
  adb(`am start -n dev.longhorn.messenger/.MainActivity`);
  await wait(4000);
  let pid = adb("pidof dev.longhorn.messenger").trim();
  execSync(`adb -s 192.168.1.147:37707 forward tcp:9222 localabstract:webview_devtools_remote_${pid}`);
  const ct = await connect(9222);
  const botId = await ct.eval(`(users.find(u=>u.bot)||{}).id`);
  await ct.eval(`openChat(${botId})`);
  await wait(800);

  const snap = () => ct.eval(`JSON.stringify({
    headTop:document.querySelector('.head').getBoundingClientRect().top,
    headH:document.querySelector('.head').getBoundingClientRect().height,
    msgsTop:document.getElementById('msgs').getBoundingClientRect().top,
    inputBottom:document.querySelector('.inputbar').getBoundingClientRect().bottom,
    vv:visualViewport.height, lh:innerHeight, appH:document.getElementById('app').getBoundingClientRect().height,
    scrollY:document.documentElement.scrollTop||document.body.scrollTop||window.scrollY||0
  })`);
  const before = JSON.parse(await snap());
  console.log("БЕЗ КЛАВИАТУРЫ:", JSON.stringify(before));

  // ищем EditText через uiautomator и тапаем
  adb(`uiautomator dump /sdcard/ui.xml >/dev/null 2>&1`);
  const ui = adb(`cat /sdcard/ui.xml`);
  const m = ui.match(/EditText[^>]*bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/);
  if (!m) { console.log("EditText не найден"); process.exit(1); }
  const x = Math.round((+m[1] + +m[3]) / 2), y = Math.round((+m[2] + +m[4]) / 2);
  console.log("тап по", x, y);
  adb(`input tap ${x} ${y}`);
  await wait(3000);

  const ime = adb(`dumpsys input_method | grep -oE "mInputShown=[a-z]*|mIsInputViewShown=[a-z]*"`).trim().replace(/\n/g, " ");
  const after = JSON.parse(await snap());
  console.log("С КЛАВИАТУРОЙ:", JSON.stringify(after), "|", ime);

  const okHead = Math.abs(after.headTop - before.headTop) < 3;
  const okFit = after.inputBottom <= after.vv + 3;
  const okScroll = after.scrollY === 0;
  console.log((okHead ? "ok" : "FAIL") + " - шапка на месте (" + before.headTop.toFixed(1) + " → " + after.headTop.toFixed(1) + ")");
  console.log((okFit ? "ok" : "FAIL") + " - поле ввода внутри видимой области (" + after.inputBottom.toFixed(0) + " ≤ " + after.vv.toFixed(0) + ")");
  console.log((okScroll ? "ok" : "FAIL") + " - страница не проскроллена (" + after.scrollY + ")");
  adb(`input keyevent 111`);
  const exit = okHead && okFit ? 0 : 1;
  console.log(exit === 0 ? "=== КЛАВИАТУРНЫЙ ФИКС РАБОТАЕТ ===" : "=== ЕСТЬ ПРОБЛЕМЫ ===");
  process.exit(exit);
})().catch((e) => { console.error("FATAL", e.message); process.exit(1); });
