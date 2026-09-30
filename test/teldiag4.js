/* Смотрим консоль WebView: почему после reload не логинится. */
const { connect } = require("./cdp-helper.js");
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
(async () => {
  const ct = await connect(9222);
  const logs = [];
  await ct.eval(`window.__errs=[];window.addEventListener('error',e=>__errs.push(String(e.message)));window.addEventListener('unhandledrejection',e=>__errs.push('rej:'+String(e.reason)))`).catch(() => {});
  const tok = await ct.eval(`localStorage.getItem('lh-token')`);
  console.log("токен в localStorage:", tok ? tok.slice(0, 12) + "…" : null);
  const srv = await ct.eval(`localStorage.getItem('lh-server')`);
  console.log("сервер:", srv);
  const hidden = await ct.eval(`document.getElementById('login').classList.contains('hidden')`);
  console.log("логин скрыт:", hidden);
  // проверим /api/me из самого WebView синхронно нельзя — сделаем через глобус
  await ct.eval(`window.__me=null;fetch('https://lh.g2961.space/api/me',{headers:{Authorization:'Bearer '+localStorage.getItem('lh-token')}}).then(r=>r.json()).then(j=>{window.__me=JSON.stringify(j).slice(0,100)}).catch(e=>{window.__me='err '+e})`);
  await wait(3000);
  console.log("api/me:", await ct.eval(`window.__me`));
  console.log("ошибки:", await ct.eval(`window.__errs`));
  process.exit(0);
})().catch((e) => { console.error("FATAL", e.message); process.exit(1); });
