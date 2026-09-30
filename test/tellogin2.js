/* Логин телефона: токен в localStorage + reload (без async-eval). */
const { connect } = require("./cdp-helper.js");
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
(async () => {
  // 1) регистрируем юзера с компа
  const name = "тел" + Math.random().toString(36).slice(2, 7);
  const r = await fetch("https://lh.g2961.space/api/register", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name, password: "test1234", avatar: 1 }),
  }).then((x) => x.json());
  if (!r.token) throw new Error("register: " + JSON.stringify(r));
  console.log("аккаунт:", name, "id:", r.user.id);

  // 2) на телефоне: токен в localStorage
  const ct = await connect(9222);
  await ct.eval(`localStorage.setItem('lh-token','${r.token}')`);
  await ct.eval(`localStorage.setItem('lh-server','https://lh.g2961.space')`);
  await ct.eval(`location.reload()`);
  await wait(6000);

  // 3) проверяем (возможно, форвард слетел — перепробрасываем снаружи)
  console.log("проверь: node -e ... или следующий скрипт");
  process.exit(0);
})().catch((e) => { console.error("FATAL", e.message); process.exit(1); });
