/* Логин телефона через CDP: регистрирует одноразовый аккаунт прямо из WebView. */
const { connect } = require("./cdp-helper.js");
(async () => {
  const ct = await connect(9222);
  const r = await ct.evalAsync(`(async()=>{
    const name='тел'+Math.random().toString(36).slice(2,7);
    const r=await fetch('https://lh.g2961.space/api/register',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name,password:'test1234',avatar:1})});
    const j=await r.json();
    if(!j.token) return 'no token: '+JSON.stringify(j);
    localStorage.setItem('lh-token',j.token);
    return 'ok '+name;
  })()`);
  console.log("регистрация:", r);
  if (String(r).startsWith("ok")) await ct.eval(`location.reload()`);
  process.exit(0);
})().catch((e) => { console.error("FATAL", e.message); process.exit(1); });
