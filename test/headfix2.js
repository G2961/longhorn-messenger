/* Точечная проверка хедера: чат уже открыт, тап по textarea по её координатам. */
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
  await wait(1000);
  const botId = await ct.eval(`(users.find(u=>u.bot)||{}).id`);
  await ct.eval(`openChat(${botId})`);
  await wait(800);
  const before = await ct.eval(`JSON.stringify({head:document.querySelector('.head').getBoundingClientRect(), txt:document.getElementById('txt').getBoundingClientRect(), vh:innerHeight})`);
  const b = JSON.parse(before);
  console.log("до: head.top=", b.head.top.toFixed(1), "vh=", b.vh);

  // тап точно по центру textarea
  const tx = Math.round(b.txt.x + b.txt.width / 2), ty = Math.round(b.txt.y + b.txt.height / 2);
  adb(`input tap ${tx} ${ty}`);
  await wait(2500);
  const after = await ct.eval(`JSON.stringify({head:document.querySelector('.head').getBoundingClientRect(), txt:document.getElementById('txt').getBoundingClientRect(), vh:innerHeight})`);
  const a = JSON.parse(after);
  const kb = adb(`dumpsys input_method | grep -o "mInputShown=[a-z]*"`).trim();
  console.log("после: head.top=", a.head.top.toFixed(1), "vh=", a.vh, "|", kb);

  const ok = kb.includes("true") && Math.abs(a.head.top - b.head.top) < 2;
  console.log(ok ? "ok - ХЕДЕР ПРИКРЕПЛЁН ПРИ КЛАВИАТУРЕ" : "FAIL - хедер сместился или клавиатура не открылась");
  adb(`input keyevent 111`);
  process.exit(ok ? 0 : 1);
})().catch((e) => { console.error("FATAL", e.message); process.exit(1); });
