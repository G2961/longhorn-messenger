/* Диагностика WebView на Android-устройстве через CDP (порт 9222, adb forward).
   Запуск: node test/androidcheck.js [выражение] */
const { connect } = require("./cdp-helper.js");

(async () => {
  const c = await connect(9222);
  if (process.argv[2]) {
    console.log(JSON.stringify(await c.eval(process.argv[2])));
    process.exit(0);
  }
  const info = await c.eval(`(()=>{
    const em=document.querySelector('.em');
    let emInfo=null;
    if(em){const cs=getComputedStyle(em);const r=em.getBoundingClientRect();
      const svg=em.querySelector('svg');const scs=svg?getComputedStyle(svg):null;
      emInfo={emW:r.width,emH:r.height,disp:cs.display,wCss:cs.width,svgW:scs?scs.width:null,svgDisp:scs?scs.display:null};}
    return {
      titlebarHidden:getComputedStyle(document.querySelector('.titlebar')).display==='none',
      mobile:document.documentElement.classList.contains('mobile'),
      logged:!document.getElementById('login').classList.contains('hidden'),
      em:emInfo,
      errs:window.__errs||[],
      ua:navigator.userAgent.slice(0,80)
    };
  })()`);
  console.log(JSON.stringify(info, null, 1));
  process.exit(0);
})().catch((e) => { console.error("ERR", e.message); process.exit(1); });
