/* Скриншот-сценарий: логин, открытие чата с ботом, отправка сообщения, скриншот после ответа.
   Использует Chrome headless через --dump-dom + CDP невозможен без зависимостей,
   поэтому вместо этого: отправляем сообщение ОТ Алисы боту через REST? Нет — msg только через WS.
   Проще: WS-клиент от имени Алисы шлёт боту сообщение, ждёт эхо, затем скриншот делает Chrome. */
const BASE = "http://127.0.0.1:8080";
(async () => {
  const login = async (name) => {
    const r = await fetch(BASE + "/api/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name, password: "demo1234" }) });
    return r.json();
  };
  const A = await login("Алиса");
  const users = await (await fetch(BASE + "/api/users", { headers: { Authorization: "Bearer " + A.token } })).json();
  const bot = users.find(u => u.bot);
  console.log(JSON.stringify({ token: A.token, botID: bot ? bot.id : null }));
})().catch(e => { console.error(e.message); process.exit(1) });
