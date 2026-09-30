/* Логин телефона через UI-форму (надёжно, как руками). */
const { connect } = require("./cdp-helper.js");
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
(async () => {
  const ct = await connect(9222);
  const name = "тел" + Math.random().toString(36).slice(2, 7);
  // регистрируем юзера с компа
  const r = await fetch("https://lh.g2961.space/api/register", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name, password: "test1234", avatar: 1 }),
  }).then((r) => r.json());
  if (!r.token) throw new Error("register: " + JSON.stringify(r));
  console.log("аккаунт:", name);
  // заполняем форму и зовём doLogin напрямую (клик в замороженном WebView ненадёжен)
  await ct.eval(`document.getElementById('lname').value=${JSON.stringify(name)}`);
  await ct.eval(`document.getElementById('lpass').value='test1234'`);
  const hidden = await ct.eval(`document.getElementById('login').classList.contains('hidden')`);
  if (hidden) { console.log("уже залогинен?"); process.exit(0); }
  await ct.eval(`doLogin()`);
  for (let i = 0; i < 15; i++) {
    await wait(1000);
    const me = await ct.eval(`me && me.name`);
    if (me) { console.log("залогинен:", me, "| ws:", await ct.eval(`sock && sock.readyState`)); process.exit(0); }
  }
  const err = await ct.eval(`document.getElementById('lerr').textContent`);
  console.log("FAIL, ошибка формы:", JSON.stringify(err));
  process.exit(1);
})().catch((e) => { console.error("FATAL", e.message); process.exit(1); });
