/* Стресс-сценарии звонков через реальный UI.
   Запуск: node test/prodstress.js */
const { spawn } = require("child_process");
const { connect, getJSON } = require("./cdp-helper.js");

const B = process.env.BASE || "https://lh.g2961.space";
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const CHROME = "C:/Program Files/Google/Chrome/Application/chrome.exe";

async function login(name) {
  return fetch(B + "/api/login", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name, password: "demo1234" }),
  }).then((x) => x.json());
}

/* Одноразовые тест-юзеры: три штуки, чтобы не звонить и не кикать сессии реальных юзеров.
   Для сценария «оффлайн» нужен юзер, который НЕ логинится — его просто регистрируем. */
let testUsers = null;
async function getTestUsers() {
  if (testUsers) return testUsers;
  const suf = Date.now().toString(36).slice(-5);
  const mk = (name) => fetch(B + "/api/register", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name, password: "test1234", avatar: 3 }),
  }).then((r) => r.json());
  testUsers = { a: await mk("ТестА" + suf), b: await mk("ТестБ" + suf), c: await mk("ТестВ" + suf), ghost: await mk("Призрак" + suf) };
  for (const k of ["a", "b", "c", "ghost"]) {
    if (!testUsers[k].token) throw new Error("не создался " + k + ": " + JSON.stringify(testUsers[k]));
  }
  return testUsers;
}

let PORT = 18400 + (Date.now() % 500);
function launch(key, port, url) {
  return new Promise((resolve) => {
    const dir = "C:/Temp/lh-prof-" + key + "-" + port;
    try { require("fs").rmSync(dir, { recursive: true, force: true }); } catch (e) {}
    const p = spawn(CHROME, [
      "--headless=new", "--disable-gpu", "--no-sandbox",
      "--user-data-dir=" + dir,
      "--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream",
      "--autoplay-policy=no-user-gesture-required",
      "--remote-debugging-port=" + port,
      "--no-first-run", "--no-default-browser-check", url,
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
const nextPort = () => (PORT += 3);

const results = [];
const check = (name, ok, extra) => { results.push({ name, ok, extra }); console.log((ok ? "ok" : "FAIL") + " - " + name + (extra ? " (" + extra + ")" : "")); };

(async () => {
  const tu = await getTestUsers();
  const A_TOK = tu.a.token, B_TOK = tu.b.token, C_TOK = tu.c.token;
  const B_ID = tu.b.user.id, GHOST_ID = tu.ghost.user.id;

  // --- 1. Двойной клик по «Позвонить» ---
  {
    const A = await launch("s1a", nextPort(), B + "/?token=" + A_TOK);
    const K = await launch("s1k", nextPort(), B + "/?token=" + B_TOK);
    const a = await connect(A.port), k = await connect(K.port);
    await wait(3500);
    await a.eval(`openChat(${B_ID})`); await wait(600);
    await a.eval(`document.getElementById('callb').click(); document.getElementById('callb').click()`);
    await wait(1200);
    const state = await a.eval(`({active: call.active, mode: call.mode, callID: call.callID})`);
    check("двойной клик: один звонок", state.active === true && !!state.callID, JSON.stringify(state));
    // Катя отвечает и завершает
    await k.eval(`document.getElementById('cacc').click()`);
    await wait(2500);
    await a.eval(`document.getElementById('cend').click()`);
    await wait(800);
    const after = await a.eval(`call.active`);
    check("завершение после ответа", after === false);
    A.proc.kill(); K.proc.kill();
  }

  // --- 2. Звонок оффлайн (очередь) + отмена ---
  {
    const A = await launch("s2a", nextPort(), B + "/?token=" + A_TOK);
    const a = await connect(A.port);
    await wait(3500);
    await a.eval(`openChat(${GHOST_ID})`); await wait(600);
    await a.eval(`document.getElementById('callb').click()`);
    await wait(1200);
    const state = await a.eval(`({queued: call.queued, state: document.getElementById('cs').textContent})`);
    check("оффлайн: queued-состояние", state.queued === true && /очеред|В очереди|прозвоним/.test(state.state), JSON.stringify(state));
    await a.eval(`document.getElementById('cend').click()`);
    await wait(800);
    check("оффлайн: отмена из очереди", (await a.eval(`call.active`)) === false);
    A.proc.kill();
  }

  // --- 3. Занятость: третий не дозвонится ---
  {
    const A = await launch("s3a", nextPort(), B + "/?token=" + A_TOK);
    const K = await launch("s3k", nextPort(), B + "/?token=" + B_TOK);
    const D = await launch("s3d", nextPort(), B + "/?token=" + C_TOK);
    const a = await connect(A.port), k = await connect(K.port), d = await connect(D.port);
    await wait(3500);
    await d.eval(`window.__lastBusy=''; const _oh=sock.onmessage; sock.onmessage=ev=>{const f=JSON.parse(ev.data); if(f.type==='call'&&f.op==='busy') window.__lastBusy=f.callID; _oh(ev)};`);
    await a.eval(`openChat(${B_ID}); document.getElementById('callb').click()`);
    await wait(1000);
    await k.eval(`document.getElementById('cacc').click()`);
    await wait(1500);
    // Третий звонит занятому
    await d.eval(`openChat(${B_ID}); document.getElementById('callb').click()`);
    await wait(1500);
    const st = await d.eval(`({active: call.active, busySeen: window.__lastBusy || ''})`);
    check("занят: третьему отказ", st.active === false && st.busySeen !== "", JSON.stringify(st));
    // А тем временем разговор жив
    const talk = await a.eval(`call.mode`);
    check("занят: разговор не сломан", talk === "talk");
    await a.eval(`document.getElementById('cend').click()`);
    await wait(500);
    A.proc.kill(); K.proc.kill(); D.proc.kill();
  }

  // --- 4. Отклонение входящего ---
  {
    const A = await launch("s4a", nextPort(), B + "/?token=" + A_TOK);
    const K = await launch("s4k", nextPort(), B + "/?token=" + B_TOK);
    const a = await connect(A.port), k = await connect(K.port);
    await wait(3500);
    await a.eval(`openChat(${B_ID}); document.getElementById('callb').click()`);
    await wait(1200);
    await k.eval(`document.getElementById('cdec').click()`);
    await wait(1000);
    const stA = await a.eval(`({active: call.active, state: document.getElementById('cs').textContent})`);
    check("reject: звонящий видит отмену", stA.active === false, JSON.stringify(stA));
    const stK = await k.eval(`call.active`);
    check("reject: у отвечавшего чисто", stK === false);
    A.proc.kill(); K.proc.kill();
  }

  // --- 5. Неответ (таймаут не ждём 45с — только проверим, что гудки идут и можно отменить) ---
  {
    const A = await launch("s5a", nextPort(), B + "/?token=" + A_TOK);
    const K = await launch("s5k", nextPort(), B + "/?token=" + B_TOK);
    const a = await connect(A.port), k = await connect(K.port);
    await wait(3500);
    await a.eval(`openChat(${B_ID}); document.getElementById('callb').click()`);
    await wait(2000);
    const ringing = await k.eval(`({active: call.active, mode: call.mode, dir: call.dir})`);
    check("входящий: у Кати звонит", ringing.active && ringing.dir === "in", JSON.stringify(ringing));
    await a.eval(`document.getElementById('cend').click()`);
    await wait(900);
    const stK = await k.eval(`({active: call.active, state: document.getElementById('cs') ? document.getElementById('cs').textContent : ''})`);
    check("отмена до ответа: у Кати всё снялось", stK.active === false, JSON.stringify(stK));
    A.proc.kill(); K.proc.kill();
  }

  const fails = results.filter(r => !r.ok).length;
  console.log(fails ? `\n=== ПРОВАЛОВ: ${fails} ===` : "\n=== ВСЕ СЦЕНАРИИ ПРОШЛИ ===");
  process.exit(fails ? 1 : 0);
})().catch((e) => { console.error("FATAL", e.message); process.exit(1); });
