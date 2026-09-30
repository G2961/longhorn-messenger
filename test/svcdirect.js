/* Проверка call_service_start из WebView: что возвращает invoke. */
const { connect } = require("./cdp-helper.js");
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
(async () => {
  const ct = await connect(9222);
  console.log("available:", await ct.eval(`tauri && tauri.available()`));
  await ct.eval(`window.__svc=null;tauri.invoke('call_service_start',{peer:'Тест'}).then(r=>{window.__svc='ok '+JSON.stringify(r)}).catch(e=>{window.__svc='err '+e})`);
  await wait(2500);
  console.log("call_service_start:", await ct.eval(`window.__svc`));
  process.exit(0);
})().catch((e) => { console.error("FATAL", e.message); process.exit(1); });
