/* Диагностика: почему doLogin не работает на телефоне. */
const { connect } = require("./cdp-helper.js");
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
(async () => {
  const ct = await connect(9222);
  const r = await ct.evalAsync(`(async()=>{
    const res=await fetch('https://lh.g2961.space/api/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name:'тел5hitc',password:'test1234'})});
    return {status:res.status, body:(await res.text()).slice(0,120)};
  })()`);
  console.log("login fetch из WebView:", JSON.stringify(r));
  process.exit(0);
})().catch((e) => { console.error("FATAL", e.message); process.exit(1); });
