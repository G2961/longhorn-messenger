/* E2E звонка через реальный UI: два headless Chrome открывают прод,
   реальными кликами начинают/принимают звонок, замеряют входящий звук.
   Запуск: node test/produicall.js */
const { spawn } = require("child_process");
const fs = require("fs");
const http = require("http");
const { connect, getJSON } = require("./cdp-helper.js");

const B = process.env.BASE || "https://lh.g2961.space";
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/* Одноразовые тест-юзеры: не демо-аккаунты, чтобы не звонить и не кикать сессии реальных юзеров */
let testUsers = null;
async function getTestUsers() {
  if (testUsers) return testUsers;
  const suf = Date.now().toString(36).slice(-5);
  const mk = (name) => fetch(B + "/api/register", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name, password: "test1234", avatar: 3 }),
  }).then((r) => r.json());
  testUsers = { a: await mk("Звонилка" + suf), b: await mk("Приёмка" + suf) };
  if (!testUsers.a.token || !testUsers.b.token) throw new Error("не создались тест-юзеры: " + JSON.stringify(testUsers));
  return testUsers;
}

(async () => {
  const chrome = "C:/Program Files/Google/Chrome/Application/chrome.exe";
  const launch = (key, port, url) => new Promise((resolve) => {
    const p = spawn(chrome, [
      "--headless=new", "--disable-gpu", "--no-sandbox",
      "--user-data-dir=C:/Temp/lh-prof-" + key,
      "--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream",
      "--autoplay-policy=no-user-gesture-required",
      "--remote-debugging-port=" + port,
      "--no-first-run", "--no-default-browser-check",
      url,
    ], { stdio: ["ignore", "ignore", "ignore"] });
    const waitReady = async () => {
      for (let i = 0; i < 40; i++) {
        try { await getJSON(port, "/json/version"); resolve({ proc: p, port }); return; } catch (e) {}
        await wait(500);
      }
    };
    waitReady();
  });

  console.log("поднимаем два браузера с продом...");
  const tu = await getTestUsers();
  const A = await launch("ui-a", 18101, B + "/?token=" + tu.a.token);
  const K = await launch("ui-k", 18102, B + "/?token=" + tu.b.token);
  console.log("CDP порты:", A.port, K.port);

  const cdpA = await connect(A.port);
  const cdpK = await connect(K.port);

  await wait(4000); // ждём hello и список

  // Звонилка открывает чат с Приёмкой и жмёт «Позвонить»
  await cdpA.eval(`(() => {
    const row = [...document.querySelectorAll('.ct')].find(b => b.textContent.includes(${JSON.stringify(tu.b.user.name)}));
    row.click();
  })()`);
  await wait(800);
  await cdpA.eval(`document.getElementById('callb').click()`);
  console.log("звонящий нажал «Позвонить");

  await wait(1500);

  // Приёмка отвечает
  await cdpK.eval(`document.getElementById('cacc').click()`);
  console.log("принимающий нажал «Ответить»");

  // ждём соединения и меряем звук с обеих сторон через AnalyserNode на #raudio
  const measure = `new Promise(res => {
    const el = document.getElementById('raudio');
    const t0 = Date.now();
    const tryIt = () => {
      if (el && el.srcObject) {
        const ac = new AudioContext();
        const an = ac.createAnalyser();
        ac.createMediaStreamSource(el.srcObject).connect(an);
        const buf = new Float32Array(an.fftSize);
        let peak = 0;
        const iv = setInterval(() => {
          an.getFloatTimeDomainData(buf);
          for (const v of buf) if (Math.abs(v) > peak) peak = Math.abs(v);
        }, 100);
        setTimeout(() => { clearInterval(iv); res({peak: +peak.toFixed(4), hasStream: true}); }, 3000);
      } else if (Date.now() - t0 > 15000) res({peak: 0, hasStream: false});
      else setTimeout(tryIt, 500);
    };
    tryIt();
  })`;

  const [ra, rk] = await Promise.all([cdpA.evalAsync(measure), cdpK.evalAsync(measure)]);
  console.log("звонящий слышит:", JSON.stringify(ra));
  console.log("принимающий слышит:", JSON.stringify(rk));

  // статус звонка в UI
  const stA = await cdpA.eval(`({mode: document.getElementById('callwrap').dataset.m, state: document.getElementById('cs').textContent})`);
  console.log("UI звонящего:", JSON.stringify(stA));

  A.proc.kill(); K.proc.kill();
  const ok = ra.peak > 0.01 && rk.peak > 0.01;
  console.log(ok ? "=== ЗВУК В ОБЕ СТОРОНЫ ЧЕРЕЗ РЕАЛЬНЫЙ UI ===" : "=== ПРОВАЛ ===");
  process.exit(ok ? 0 : 1);
})().catch((e) => { console.error("FATAL", e.message); process.exit(1); });
