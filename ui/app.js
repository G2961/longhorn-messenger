"use strict";
/* ============================================================
   Longhorn Messenger — клиент (UI + WS + WebRTC)
   Протокол: PROTOCOL.md. Работает и в Tauri, и в браузере.
   ============================================================ */
const $=i=>document.getElementById(i);
const AVA_COLORS=[["#bfe8ff","#5cbf4a"],["#d8ecc8","#5fae3a"],["#ffe7b0","#ffcf2e"],["#7fd0ff","#1c74c9"],["#3a3f7a","#ffe9a8"],["#cfe8fa","#2b86d6"]];
/* Аватары-«флешки» (SVG-строки, из прототипа) */
const AVA=[
'<svg viewBox="0 0 40 40"><rect width="40" height="40" fill="#bfe8ff"/><rect y="28" width="40" height="12" fill="#5cbf4a"/><g fill="#f26aa8"><circle cx="20" cy="9" r="6"/><circle cx="30" cy="16" r="6"/><circle cx="26" cy="27" r="6"/><circle cx="14" cy="27" r="6"/><circle cx="10" cy="16" r="6"/></g><circle cx="20" cy="19" r="5" fill="#ffd93b"/></svg>',
'<svg viewBox="0 0 40 40"><rect width="40" height="40" fill="#d8ecc8"/><circle cx="20" cy="20" r="15" fill="none" stroke="#3d8d24" stroke-width="5" stroke-dasharray="3 3.9"/><circle cx="20" cy="20" r="11" fill="#5fae3a"/><circle cx="20" cy="20" r="4" fill="#d8ecc8"/></svg>',
'<svg viewBox="0 0 40 40"><rect width="40" height="40" fill="#ffe7b0"/><ellipse cx="22" cy="27" rx="13" ry="9" fill="#ffcf2e"/><circle cx="16" cy="14" r="7" fill="#ffcf2e"/><path d="M9 13l-7 3 7 3z" fill="#f28a1e"/><circle cx="15" cy="12" r="1.5" fill="#222"/></svg>',
'<svg viewBox="0 0 40 40"><rect width="40" height="40" fill="#7fd0ff"/><circle cx="26" cy="14" r="7" fill="#ffe066"/><path d="M0 28Q10 22 20 28T40 28V40H0z" fill="#1c74c9"/></svg>',
'<svg viewBox="0 0 40 40"><rect width="40" height="40" fill="#3a3f7a"/><circle cx="20" cy="20" r="11" fill="#ffe9a8"/><circle cx="25" cy="16" r="10" fill="#3a3f7a"/><circle cx="8" cy="8" r="1.2" fill="#fff"/><circle cx="33" cy="30" r="1.2" fill="#fff"/></svg>',
'<svg viewBox="0 0 40 40"><rect width="40" height="40" fill="#cfe8fa"/><circle cx="20" cy="15" r="7" fill="#2b86d6"/><path d="M6 40c0-10 6-15 14-15s14 5 14 15z" fill="#2b86d6"/></svg>'];
/* Эмодзи (глянцевые SVG из прототипа) */
const face=(x,g="gF")=>'<svg viewBox="0 0 32 32"><circle cx="16" cy="16" r="14" fill="url(#'+g+')" stroke="'+(g==="gA"?"#8e1a08":"#b86a00")+'" stroke-width="1.2"/><ellipse cx="16" cy="8.5" rx="10.5" ry="6.5" fill="url(#gG)"/>'+x+'</svg>';
const EYES='<ellipse cx="11.5" cy="13" rx="1.9" ry="2.5" fill="#3a2200"/><ellipse cx="20.5" cy="13" rx="1.9" ry="2.5" fill="#3a2200"/>';
const MOUTH=d=>'<path d="'+d+'" stroke="#3a2200" stroke-width="2" fill="none" stroke-linecap="round"/>';
const SMILE=MOUTH("M9.5 19q6.5 7 13 0"),FROWN=MOUTH("M10 24q6-6 12 0");
const EMO={
smile:face(EYES+SMILE),
grin:face(EYES+'<path d="M8 18h16q-1.5 8-8 8t-8-8z" fill="#5a1a00"/><path d="M9 18h14q-.4 2.4-1.2 3H10.2q-.8-.6-1.2-3z" fill="#fff"/>'),
wink:face('<path d="M8.5 13.5q3-3 6 0" stroke="#3a2200" stroke-width="2" fill="none" stroke-linecap="round"/><ellipse cx="20.5" cy="13" rx="1.9" ry="2.5" fill="#3a2200"/>'+SMILE),
cool:face('<path d="M5.5 11h9.5v5q0 3.5-4.75 3.5T5.5 16zM17 11h9.5v5q0 3.5-4.75 3.5T17 16z" fill="#1c1c1c"/><path d="M15 12h2" stroke="#1c1c1c" stroke-width="1.5"/><path d="M7.5 12.5h5M19 12.5h5" stroke="#fff" stroke-opacity=".55" stroke-width="1.3" stroke-linecap="round"/>'+MOUTH("M10 23q6 4 12 0")),
sad:face(EYES+FROWN),
cry:face('<path d="M8.5 10.5l5 2.5-5 2.5M23.5 10.5l-5 2.5 5 2.5" stroke="#3a2200" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"/><path d="M9.5 16c-2.5 3.5-3.2 6.5-1.2 8s4 .5 3.5-2.5S10.5 17.5 9.5 16zM22.5 16c2.5 3.5 3.2 6.5 1.2 8s-4 .5-3.5-2.5S21.5 17.5 22.5 16z" fill="#8fd4ff" stroke="#2d86c9" stroke-width=".8"/><ellipse cx="8.8" cy="21" rx=".8" ry="1.5" fill="#fff" fill-opacity=".85"/><ellipse cx="23.2" cy="21" rx=".8" ry="1.5" fill="#fff" fill-opacity=".85"/><path d="M9.5 26q6.5-9 13 0z" fill="#5a1a00"/><path d="M12.5 26q3.5-4 7 0z" fill="#ff6b8a"/>'),
angry:face('<ellipse cx="11.5" cy="14" rx="1.8" ry="2.2" fill="#3a0800"/><ellipse cx="20.5" cy="14" rx="1.8" ry="2.2" fill="#3a0800"/><path d="M7.5 9l7 3M24.5 9l-7 3" stroke="#3a0800" stroke-width="2" stroke-linecap="round"/>'+MOUTH("M10 24q6-5 12 0"),"gA"),
tongue:face(EYES+SMILE+'<path d="M13 21.5v3.5a3 3 0 006 0v-3.5z" fill="#ff6b8a" stroke="#c23458" stroke-width=".8"/>'),
wow:face('<circle cx="11.5" cy="13" r="2.8" fill="#fff" stroke="#3a2200"/><circle cx="20.5" cy="13" r="2.8" fill="#fff" stroke="#3a2200"/><circle cx="11.5" cy="13.5" r="1.2" fill="#3a2200"/><circle cx="20.5" cy="13.5" r="1.2" fill="#3a2200"/><ellipse cx="16" cy="23" rx="2.6" ry="3.6" fill="#5a1a00"/>'),
love:face('<path d="M11.5 16.5c-4-2.5-4-6-1.6-6.6 1.2-.3 1.6.6 1.6.6s.4-.9 1.6-.6c2.4.6 2.4 4.1-1.6 6.6zM20.5 16.5c-4-2.5-4-6-1.6-6.6 1.2-.3 1.6.6 1.6.6s.4-.9 1.6-.6c2.4.6 2.4 4.1-1.6 6.6z" fill="#e0203a"/>'+SMILE),
heart:'<svg viewBox="0 0 32 32"><path d="M16 28C5 20 3 14 3 10.5 3 6.5 6 4 9.5 4c3 0 5 1.8 6.5 4C17.5 5.8 19.5 4 22.5 4 26 4 29 6.5 29 10.5 29 14 27 20 16 28z" fill="url(#gH)" stroke="#8e0f1c" stroke-width="1.2" stroke-linejoin="round"/><ellipse cx="11" cy="10" rx="5" ry="3" fill="url(#gG)" transform="rotate(-25 11 10)"/></svg>',
star:'<svg viewBox="0 0 32 32"><path d="M16 3l3.9 8.2 9 1.1-6.6 6.2 1.7 8.9L16 22.9 8 28.4l1.7-8.9L3.1 12.3l9-1.1z" fill="url(#gF)" stroke="#b86a00" stroke-width="1.2" stroke-linejoin="round"/><ellipse cx="14" cy="11" rx="5" ry="3" fill="url(#gG)" transform="rotate(-20 14 11)"/></svg>'};
const SH={":)":"smile",":(":"sad",":D":"grin",";)":"wink",":P":"tongue",":p":"tongue","<3":"heart"};

/* ---------- состояние ---------- */
const ST={on:"В сети",idle:"Неактивен",dnd:"Не беспокоить",inv:"Невидимка",off:"Не в сети"};
let token=null,me=null,users=[],conv=new Map(),unread=new Map(),cur=null,filter="";
let sock=null,sockAlive=false,retry=0,retryT=null,chatOpenT=null;
let typingTimers=new Map(),lastTypingSent=0,typingSentTo=0;
let readSeqByPeer=new Map(); // peer -> мой последний отправленный read
const cfg={server:localStorage.getItem("lh-server")||(location.protocol.startsWith("http")&&!location.hostname.includes("tauri")?location.origin:"https://lh.g2961.space"),theme:localStorage.getItem("lh-theme")||"light",regAvatar:0};
/* ICE: STUN для прямого P2P + TURN-ретрансляция на нашем сервере
   (нужна за NAT/VPN — Cloudflare WARP, симметричный NAT и т.п.) */
const ICE_SERVERS=[
 /* STUN для прямого P2P (работает не везде: WARP/симметричный NAT съедают UDP) */
 {urls:["stun:stun.l.google.com:19302","stun:stun1.l.google.com:19302"]},
 /* TURN-ретрансляция на нашем сервере. UDP предпочтительнее, но VPN типа
    Cloudflare WARP глотают UDP — поэтому обязательно TCP-транспорт.
    Проверено: телефон за WARP получает relay только по tcp. */
 {urls:["turn:45.80.229.25:3478?transport=udp","turn:45.80.229.25:3478?transport=tcp"],username:"longhorn",credential:"f2f0f350d147edf073e5a2b1"}
];

/* ---------- утилиты ---------- */
const esc=s=>String(s).replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
const fmtTime=t=>new Date(t*1000).toLocaleTimeString("ru",{hour:"2-digit",minute:"2-digit"});
function fmtDay(t){const d=new Date(t*1000),n=new Date(),y=new Date(Date.now()-864e5);
 if(d.toDateString()===n.toDateString())return "Сегодня";
 if(d.toDateString()===y.toDateString())return "Вчера";
 return d.toLocaleDateString("ru",{day:"numeric",month:"long",year:d.getFullYear()!==n.getFullYear()?"numeric":undefined})}
const uid2a=Object.create(null); // id -> user (обновляемый индекс)
const U=id=>uid2a[id];
const avaHTML=(u,cls)=>'<div class="ava '+(cls||"")+'">'+(AVA[u&&u.avatar]||AVA[0])+"</div>";
function statusDot(u){return '<div class="dot" style="--f:'+dotColor(u)+'"></div>'}
function dotColor(u){return {on:"#3bb54a",idle:"#e0a800",dnd:"#d9382c",inv:"#8a97a3",off:"#8a97a3"}[(u&&u.status)||"off"]}

/* ---------- тема ---------- */
function applyTheme(){document.documentElement.dataset.theme=cfg.theme;localStorage.setItem("lh-theme",cfg.theme)}
applyTheme();
/* мобильная платформа (Tauri/Android, WebView): без тайтлбара, без elastic-scroll */
if(matchMedia("(pointer:coarse)").matches||/android/i.test(navigator.userAgent)){
 document.documentElement.classList.add("mobile");
 document.addEventListener("dragstart",e=>e.preventDefault());
 document.body.addEventListener("touchmove",e=>{if(!e.target.closest(".msgs,.list,.epicker"))e.preventDefault()},{passive:false});
 /* Клавиатура: жёстко зажимаем каркас в видимую высоту (visualViewport).
	 Старые WebView игнорируют interactive-widget=resizes-content и продолжают
	 панорамировать layout (шапка уезжает выше статус-бара). Фолбэк: ставим
	 высоту #app = видимая высота и запрещаем прокрутку body. */
 const fitKB=()=>{const vh=window.visualViewport?visualViewport.height:innerHeight;
  document.documentElement.style.setProperty("--appvh",vh+"px");
  if(window.visualViewport){document.body.style.transform="none"}};
 fitKB();
 window.visualViewport&&visualViewport.addEventListener("resize",fitKB);
 window.addEventListener("orientationchange",()=>setTimeout(fitKB,300));
 window.addEventListener("resize",fitKB)}

/* ---------- звук ---------- */
let AC;
function tone(f,d,t,v){t=t||0;v=v||.06;try{AC=AC||new (window.AudioContext||window.webkitAudioContext)();
 const o=AC.createOscillator(),g=AC.createGain(),n=AC.currentTime+t;o.frequency.value=f;
 g.gain.setValueAtTime(v,n);g.gain.exponentialRampToValueAtTime(1e-4,n+d);o.connect(g);g.connect(AC.destination);o.start(n);o.stop(n+d)}catch(e){}}
const sndMsg=()=>{tone(880,.15);tone(1320,.22,.1)};
const sndSent=()=>tone(600,.08,0,.04);
const sndCall=()=>{tone(660,.18);tone(880,.18,.22);tone(660,.18,.6);tone(880,.18,.82)};
const sndHang=()=>{tone(500,.15);tone(350,.22,.16)};
const sndUp=()=>{tone(700,.09);tone(1000,.12,.09)};

/* ---------- toasts ---------- */
function toast(user,title,text,onclick){const t=document.createElement("div");t.className="toast";
 t.innerHTML=avaHTML(user)+("<div><b>"+esc(title)+"</b>"+(text?"<span>"+esc(text)+"</span>":"")+"</div>");
 t.onclick=()=>{t.remove();onclick&&onclick()};$("toasts").appendChild(t);
 setTimeout(()=>{t.style.opacity="0";t.style.transition="opacity .3s";setTimeout(()=>t.remove(),320)},4200)}

/* ---------- REST ---------- */
async function api(path,body,method){const r=await fetch(cfg.server+path,{method:method||(body?"POST":"GET"),
 headers:Object.assign(body?{"Content-Type":"application/json"}:{},token?{"Authorization":"Bearer "+token}:{}),
 body:body?JSON.stringify(body):undefined});
 if(r.status===204)return null;const j=await r.json().catch(()=>({}));
 if(!r.ok)throw new Error(j.error||("HTTP "+r.status));return j}

/* ---------- WebSocket ---------- */
let pingT=null;
function connect(){if(!token)return;
 if(sock){try{sock.onclose=null;sock.close()}catch(e){}}
 const url=cfg.server.replace(/^http/,"ws")+"/ws?token="+encodeURIComponent(token);
 sockAlive=false;
 try{sock=new WebSocket(url)}catch(e){scheduleReconnect();return}
 sock.onopen=()=>{sockAlive=true;retry=0;$("connbar")&&$("connbar").classList.remove("show");
  /* вернулись после обрыва в фоне: звонок продолжается */
  if(call.wsWasDown&&call.active){call.wsWasDown=false;
   if(call.mode==="talk")showCallState("Разговор")}
  /* keepalive: сервер рвёт соединение после 60с тишины; во время звонка
     по WS ничего не ходит (звук идёт P2P), поэтому пингуем сами каждые 25с */
  clearInterval(pingT);pingT=setInterval(()=>{if(sock&&sock.readyState===1)sock.send(JSON.stringify({type:"ping"}))},25000)};
 sock.onmessage=ev=>{let f;try{f=JSON.parse(ev.data)}catch(e){return}handle(f)};
 sock.onclose=()=>{clearInterval(pingT);
  /* Фоновые звонки: WebRTC-медиа живёт независимо от WS. Если разговор идёт —
     не гасим звонок, показываем «Переподключение…» и чиним соединение. */
  if(call.active&&call.mode==="talk"){call.wsWasDown=true;showCallState("Переподключение…")}
  if(!sockAlive&&token){showConn("Сервер недоступен. Переподключение…")}scheduleReconnect()};
 sock.onerror=()=>{};
 /* мобильные фоны рвут WS: при возврате — мгновенный реконнект */
 document.addEventListener("visibilitychange",()=>{if(!document.hidden&&token&&(!sock||sock.readyState>1))connect()});
 /* страховка: если сокет долго в CONNECTING (WebView просыпает onclose) — пересоздаём */
 setTimeout(()=>{if(sock&&sock.readyState===0&&token)connect()},4000)}
function scheduleReconnect(){if(!token)return;clearTimeout(retryT);
 const d=Math.min(15000,1000*Math.pow(1.6,Math.min(retry,6)));retry++;
 retryT=setTimeout(connect,d)}
function showConn(text){const cb=$("connbar");if(!cb)return;cb.classList.add("show");$("conntext").textContent=text}

/* Обработчик кадров от сервера */
function handle(f){switch(f.type){
 case "hello":onHello(f);break;
 case "presence":onPresence(f);break;
 case "msg":onMsg(f);break;
 case "sent":onSent(f);break;
 case "typing":onTyping(f);break;
 case "read":onRead(f);break;
 case "call":onCall(f);break;
 default:break}}

function onHello(f){me=f.me;users=f.users;
 uid2a[me.id]=me;
 users.forEach(u=>uid2a[u.id]=u);
 unread=new Map(Object.entries(f.unread||{}).map(([k,v])=>[+k,v]));
 renderMe();renderList();
 if(cur!=null&&!uid2a[cur]){setCur(null)}
 markRead();updTitle()}
function onPresence(f){const u=uid2a[f.id];if(!u)return;
 u.status=f.status;u.mood=f.mood!==undefined?f.mood:u.mood;u.lastSeen=f.lastSeen;
 if(cur===f.id)renderHead();
 renderList();toastIfOnline(f)}
function toastIfOnline(f){ /* звук при входе контакта в сеть */
 if(f.status==="on"&&lastPresence.get(f.id)!=="on"&&lastPresence.has(f.id)){sndUp()}
 lastPresence.set(f.id,f.status)}
const lastPresence=new Map();
function onMsg(f){const u=U(f.from);if(!u)return;
 if(!f.sys&&cur===f.from||f.sys&&cur===f.from){/* собеседник дописал — гасим индикатор */
  $("typing").textContent="";clearTimeout(typingTimers.get(f.from));typingTimers.delete(f.from)}
 const list=conv.get(f.from)||[];list.push({seq:f.seq,from:f.from,text:f.text,time:f.time,sys:f.sys,id:f.id,sysop:f.sysop,peer:f.peer,dur:f.dur});conv.set(f.from,list);
 if(f.sys){if(cur===f.from)renderMsgs(true);else{unread.set(f.from,(unread.get(f.from)||0)+1);renderList();updTitle()}
  if(cur===f.from)markRead();return}
 if(cur===f.from&&!document.hidden){markRead(f.from,f.seq)}else{unread.set(f.from,(unread.get(f.from)||0)+1);renderList();updTitle();toast(u,u.name,f.text,()=>openChat(u.id));sndMsg()}
 if(cur===f.from)renderMsgs(true)}
function onSent(f){const list=conv.get(sentTargets.get(f.id))||[];
 const m=list.find(x=>x.id===f.id&&x.pending);if(m){m.id=f.sid;m.time=f.time;m.seq=f.seq;m.pending=false}
 sentTargets.delete(f.id);renderMsgs();sndSent()}
const sentTargets=new Map();
function onTyping(f){if(f.from===cur){const el=$("typing");
 clearTimeout(typingTimers.get(f.from));
 if(f.on){el.textContent=(U(f.from)||{name:""}).name+" печатает…";
  /* страховка: если on lost / end не пришёл, индикатор гаснет сам через 6с */
  typingTimers.set(f.from,setTimeout(()=>{el.textContent=""},6000))}
 else{el.textContent=""}
 return}
 clearTimeout(typingTimers.get(f.from));
 if(f.on)typingTimers.set(f.from,setTimeout(()=>{},0))}
function onRead(f){if(f.by!==cur&&f.by!==null){const list=conv.get(f.by);if(list){list.forEach(m=>{if(m.from===me.id&&m.seq&&m.seq<=f.seq)m.read=true});if(f.by===cur)renderMsgs()}}}
function onCall(f){switch(f.op){
 case "offer":ringIncoming(f);break;
 case "answer":callAnswered(f);break;
 case "ice":callIce(f);break;
 case "end":callEnded(f);break;
 case "reject":callRejected(f);break;
 case "cancel":callCancelled(f);break;
 case "busy":callBusy(f);break;
 case "queued":callQueued(f);break;
 default:}}
function send(frame){if(!sock||sock.readyState!==1){
  /* мёртвый сокет (фон WebView): пересоздаём соединение, кадр теряется —
     звЁночные обработчики имеют собственные таймауты и покажут ошибку */
  if(token){connect();showConn("Переподключение…")}
  return false}
 sock.send(JSON.stringify(frame));return true}

/* ---------- присутствие / idle ---------- */
let manualStatus=localStorage.getItem("lh-status")||"on";
let idleStatus=false,lastAct=Date.now(),idleT=null;
const IDLE_MS=5*60*1000;
function activity(){lastAct=Date.now();
 if(idleStatus){idleStatus=false;sendPresence()}
 scheduleIdle()}
function scheduleIdle(){clearTimeout(idleT);idleT=setTimeout(()=>{if(!idleStatus&&manualStatus==="on"){idleStatus=true;sendPresence()}},IDLE_MS)}
function effectiveStatus(){if(idleStatus)return "idle";return manualStatus}
function sendPresence(){if(!me)return;send({type:"presence",status:manualStatus,mood:$("mood").value})}
["mousemove","keydown","pointerdown","wheel","touchstart"].forEach(e=>document.addEventListener(e,activity,{passive:true}));
scheduleIdle();

/* ---------- UI: я ---------- */
function renderMe(){$("myava").innerHTML=AVA[me.avatar]||AVA[0];$("myname").textContent=me.name;
 $("status").value=manualStatus;$("mydot").style.background=dotColor({status:effectiveStatus()});
 if(!$("mood").value&&me.mood)$("mood").value=me.mood}

/* ---------- UI: список ---------- */
function renderList(){const box=$("list");
 const f=users.filter(u=>u.name.toLowerCase().includes(filter));
 const online=f.filter(u=>u.status!=="off"),offline=f.filter(u=>u.status==="off");
 const row=u=>{const un=unread.get(u.id)||0;
  return '<button class="ct '+(u.status==="off"?"off":"")+(cur===u.id?" sel":"")+'" data-id="'+u.id+'">'+
   '<span class="ava-wrap">'+avaHTML(u)+statusDot(u)+"</span>"+
   '<span class="mid"><span class="n">'+esc(u.name)+'</span><span class="s">'+esc(subline(u))+"</span></span>"+
   (un?'<span class="badge">'+un+"</span>":"")+"</button>"};
 let html="";
 if(online.length)html+='<div class="grp">В сети — '+online.length+"</div>"+online.map(row).join("");
 if(offline.length)html+='<div class="grp">Не в сети — '+offline.length+"</div>"+offline.map(row).join("");
 box.innerHTML=html||'<div style="padding:20px;color:var(--ink2);font-size:13px;text-align:center">Никого не найдено</div>'}
function subline(u,withLastSeen){
 if(u.status==="off"){if(withLastSeen&&u.lastSeen){const m=Math.floor((Date.now()/1000-u.lastSeen)/60);
  if(m<1)return "был(а) только что";if(m<60)return "был(а) "+m+" мин. назад";
  const h=Math.floor(m/60);if(h<24)return "был(а) "+h+" ч. назад";return "был(а) "+fmtDay(u.lastSeen).toLowerCase()}
  return ST.off}
 const s=u.mood||ST[u.status]||"";
 if(!s||s===u.name)return ""; // пустой статус или дубль имени — не показываем
 return s}
function updTitle(){const n=[...unread.values()].reduce((a,b)=>a+b,0);
 document.title=(n?"("+n+") ":"")+"Longhorn Messenger"}

/* ---------- UI: чат ---------- */
function setCur(id){cur=id;const c=$("chat");c.classList.toggle("idle",id==null);
 $("shell").classList.toggle("open",id!=null);
 if(id!=null){renderHead();loadHistory(id);markRead(id)}else{$("hinfo").innerHTML="<b>Выбери контакт</b>";$("msgs").innerHTML="";$("typing").textContent=""}
 renderList()}
function openChat(id){setCur(id);if(!matchMedia("(max-width:700px)").matches)$("txt").focus({preventScroll:true})}
function renderHead(){const u=U(cur);if(!u)return;
 $("hinfo").innerHTML='<span class="ava-wrap">'+avaHTML(u)+statusDot(u)+"</span><div><b>"+esc(u.name)+"</b><small>"+esc(subline(u,true))+"</small></div>";
 $("callb").disabled=!!call.active||!!u.bot}
async function loadHistory(id){const box=$("msgs");box.innerHTML="";
 try{const r=await api("/api/history/"+id+"?limit=100");
  const list=(r.messages||[]).map(m=>({seq:m.seq,from:m.from,text:m.text,time:m.time,sys:m.sys,id:m.id,sysop:m.sysop,peer:m.peer,dur:m.dur}));
  conv.set(id,list);box.dataset.hasMore=r.hasMore?"1":"";
  renderMsgs();markRead(id);
  if(r.hasMore)prepSentinel()}catch(e){box.innerHTML='<div class="sy">Не удалось загрузить историю: '+esc(e.message)+"</div>"}}
function prepSentinel(){const s=document.createElement("div");s.id="sentinel";s.style.height="1px";$("msgs").prepend(s)}
async function loadMore(){const u=U(cur);if(!u||loadingMore)return;const box=$("msgs");
 if(box.dataset.hasMore!=="1")return;loadingMore=true;
 const first=conv.get(cur)[0];
 try{const r=await api("/api/history/"+u.id+"?limit=100&before="+(first?first.seq:0));
  const older=(r.messages||[]).map(m=>({seq:m.seq,from:m.from,text:m.text,time:m.time,sys:m.sys,id:m.id,sysop:m.sysop,peer:m.peer,dur:m.dur}));
  const keep=conv.get(cur);conv.set(cur,older.concat(keep.filter(k=>!older.some(o=>o.seq===k.seq))));
  box.dataset.hasMore=r.hasMore?"1":"";
  const st=box.scrollTop;renderMsgs();box.scrollTop=st+ (box.scrollHeight-st); }catch(e){}finally{loadingMore=false}}
let loadingMore=false;
/* sys-строки о звонках. Сервер хранит в записи op (end/missed/cancel/reject/busy),
   peer (второй участник) и dur (мс разговора). Запись видят оба участника,
   поэтому фраза строится с учётом того, кто её читает (me). */
const sysEndText="Звонок завершён";
function fmtDur(ms){const s=Math.round(ms/1000);return String(s/60|0).padStart(2,"0")+":"+String(s%60).padStart(2,"0")}
function sysCallText(m,u){
 const other=peerName(u,m); // «собеседник» относительно читателя записи
 const op=m.sysop||"";
 if(op==="missed")return "Пропущенный звонок от "+other;
 if(op==="end")return m.dur>0?"Звонок с "+other+", "+fmtDur(m.dur):"Вы отменили звонок для "+other;
 if(op==="cancel")return m.from===me.id?"Вы отменили звонок для "+other:other+" отменил(а) звонок";
 if(op==="reject")return m.from===me.id?"Вы отклонили звонок от "+other:other+" отклонил(а) ваш звонок";
 if(op==="busy")return m.from===me.id?other+" занят, звонок не принят":"Вы заняты, звонок не принят";
 // старые записи без sysop: различаем по тексту
 if(m.text==="Пропущенный звонок")return "Пропущенный звонок от "+other;
 return m.text}
/* Имя второй стороны записи относительно текущего читателя: если peer — не я,
   это собеседник чата; если peer — я, то автор записи и есть собеседник. */
function peerName(u,m){const p=m.peer?U(+m.peer):null;
 if(p&&p.id!==me.id)return p.name;
 const from=m.from?U(+m.from):null;
 return from&&from.id!==me.id?from.name:u.name}
function renderMsgs(fresh){const u=U(cur);if(!u)return;const box=$("msgs");
 const list=conv.get(cur)||[];
 let html="",lastDay="",lastFrom=0;
 for(const m of list){
  const day=fmtDay(m.time);
  if(day!==lastDay){html+='<div class="day">'+day+"</div>";lastDay=day;lastFrom=0}
  if(m.sys){const txt=sysCallText(m,u);html+='<div class="sy">'+esc(txt)+"</div>";lastFrom=0;continue}
  const mine=m.from===me.id;
  if(m.from!==lastFrom){html+='<div class="h">'+(mine?esc(me.name):esc(u.name))+" говорит:"+(m.time?" ("+fmtTime(m.time)+")":"")+"</div>";lastFrom=m.from}
  const tick=mine?'<span class="tick">'+(m.pending?"◌":m.read?"✓✓":"✓")+"</span>":"";
  html+='<div class="t">'+rich(m.text)+tick+"</div>"}
 box.innerHTML=html||'<div class="sy">Начните беседу с '+esc(u.name)+"</div>";
 box.scrollTop=box.scrollHeight}
function rich(text){let out=esc(text);
 out=out.replace(/:[a-z]+:|:\)|:\(|:D|;\)|:[Pp]|<3/g,s=>{const n=SH[s]||( /^:[a-z]+:$/.test(s)?s.slice(1,-1):null);
  return n&&EMO[n]?'<span class="em">'+EMO[n]+"</span>":esc(s)});
 return out}
function markRead(peer,seq){const p=peer!=null?peer:cur;if(p==null)return;
 const list=conv.get(p)||[];let max=seq!=null?seq:0;
 for(const m of list)if(!m.sys&&m.from===p&&m.seq>max)max=m.seq;
 if(max>0&&(readSeqByPeer.get(p)||0)<max){readSeqByPeer.set(p,max);send({type:"read",to:p,seq:max});
  unread.delete(p);renderList();updTitle()}}
setInterval(()=>{if(cur!=null&&!document.hidden)markRead(cur)},2000);

/* ---------- отправка ---------- */
function doSend(){const ta=$("txt");const v=ta.value.replace(/\s+$/,"");if(!v||cur==null)return;
 const id="c"+Date.now()+Math.random().toString(36).slice(2,7);
 const list=conv.get(cur)||[];list.push({id,from:me.id,text:v,time:Date.now()/1000,pending:true});conv.set(cur,list);
 sentTargets.set(id,cur);
 send({type:"msg",id,to:cur,text:v});
 ta.value="";autoGrow(ta);renderMsgs(true);
 sendTyping(cur,false)}
let typingT=null;
function sendTyping(to,on){const now=Date.now();
 if(on&&now-lastTypingSent<2500)return; // троттлинг
 if(on)lastTypingSent=now;
 if(typingSentTo!==to&&typingSentTo){send({type:"typing",to:typingSentTo,on:false})}
 typingSentTo=to;send({type:"typing",to,on})}
function typingOff(){if(typingSentTo){send({type:"typing",to:typingSentTo,on:false});typingSentTo=0;lastTypingSent=0}}
function autoGrow(ta){ta.style.height="auto";ta.style.height=Math.min(120,ta.scrollHeight)+"px"}

/* ---------- звонки (WebRTC) ---------- */
const call={active:false,mode:null,mini:false,peer:null,callID:null,pc:null,local:null,localScreen:null,ringT:null,talkT:null,t0:0,muted:false,dir:null,queued:false,pendingIce:null,
 video:false,cam:"user",share:null,shareStream:null,renegoBusy:false,renegoArmed:false,wsWasDown:false};
function callFrame(op,extra){send(Object.assign({type:"call",op,callID:call.callID,to:call.peer},extra||{}))}
function mkPC(peerID){const pc=new RTCPeerConnection({iceServers:ICE_SERVERS});
 pc.onicecandidate=e=>{if(e.candidate&&call.active)callFrame("ice",{cand:e.candidate.toJSON()})};
 /* входящий звук: поток собеседника → <audio>; если autoplay заблокирован — ретрай по первому клику */
 pc.ontrack=e=>{
  const ra=$("raudio");
  if(ra&&e.streams[0]){ra.srcObject=e.streams[0];ra.play().catch(()=>{document.addEventListener("click",()=>ra.play().catch(()=>{}),{once:true})})}
  const rv=$("rvideo");
  if(rv&&e.track.kind==="video"){rv.srcObject=e.streams[0]||new MediaStream([e.track]);rv.play().catch(()=>{});$("callwrap").classList.add("vid")}
 };
 /* переговоры (renego) — ТОЛЬКО по явному действию юзера (кнопка камеры/экрана):
	 автоматика тут вызывала гонку offer'ов и вешала звонок */
 pc.onnegotiationneeded=()=>{if(call.active&&call.pc===pc&&call.renegoArmed&&!call.renegoBusy&&call.mode==="talk")renegoOffer()};
 /* P2P не пробился (обычно строгий NAT без TURN) — говорим об этом и завершаем */
 pc.onconnectionstatechange=()=>{if(pc.connectionState==="failed"){showCallState("Не удалось соединиться (сеть блокирует P2P)");
  setTimeout(()=>{if(call.active&&call.pc===pc)endCall(call.mode==="talk"?"end":"cancel")},10000)}};
 return pc}
async function renegoOffer(){if(!call.pc||call.renegoBusy||call.mode!=="talk"||call.pc.signalingState==="closed")return;
 call.renegoBusy=true;
 try{const offer=await call.pc.createOffer();await call.pc.setLocalDescription(offer);
  callFrame("offer",{sdp:call.pc.localDescription.sdp,renego:true});
  /* ответ придёт в callAnswered (renego), снимаем блокировку там же с запасным таймаутом */
  setTimeout(()=>{call.renegoBusy=false},6000)}
 catch(e){call.renegoBusy=false}}
async function getMic(){if(call.local&&call.local.getAudioTracks().some(t=>t.readyState==="live"))return true;
 if(!window.isSecureContext||!navigator.mediaDevices||!navigator.mediaDevices.getUserMedia){
  showCallState("Звонки работают только по HTTPS (микрофон недоступен по HTTP)");
  setTimeout(hideCallUI,2600);return false}
 try{call.local=await navigator.mediaDevices.getUserMedia({audio:true});return true}
 catch(e){showCallState("Нет доступа к микрофону");setTimeout(hideCallUI,2000);return false}}
async function startCall(peerID){if(call.active)return;const u=U(peerID);if(!u)return;
 call.active=true;call.mode="ring";call.dir="out";call.peer=peerID;
 call.callID="k"+Date.now().toString(36)+Math.random().toString(36).slice(2,8);
 showCallUI(u,"out","Вызываю…");
 ringOutLoop(true);
 if(!await getMic()){ringOutLoop(false);cleanupCall(false);return}
 call.pc=mkPC(peerID);
 call.pc.addTrack(call.local.getAudioTracks()[0],call.local);
 try{
  const offer=await call.pc.createOffer({offerToReceiveAudio:true});
  await call.pc.setLocalDescription(offer);
  callFrame("offer",{sdp:call.pc.localDescription.sdp});
 }catch(e){/* offer не ушёл — сервер звонок не знает, просто локальная чистка */
  ringOutLoop(false);cleanupCall(false);showCallState("Не удалось начать звонок")}}
function ringOutLoop(on){clearInterval(call.ringT);
 if(on){tone(440,.35);tone(480,.35,.05);call.ringT=setInterval(()=>{tone(440,.35);tone(480,.35,.05)},2000)}
 }
function ringInLoop(on){clearInterval(call.ringT);
 if(on){sndCall();call.ringT=setInterval(sndCall,2500)}}
async function ringIncoming(f){
 if(f.renego){
  /* повторный offer внутри идущего разговора (собеседник включил видео/шеринг) */
  if(call.active&&call.pc&&f.callID===call.callID){
   try{await call.pc.setRemoteDescription({type:"offer",sdp:f.sdp});
    const ans=await call.pc.createAnswer();await call.pc.setLocalDescription(ans);
    callFrame("answer",{sdp:call.pc.localDescription.sdp,renego:true})}catch(e){}}
  return}
 if(call.active){send({type:"call",op:"busy",to:f.from,callID:f.callID});return}
 call.active=true;call.mode="ring";call.dir="in";call.peer=f.from;call.callID=f.callID;
 call.offer=f;showCallUI(U(f.from),"in","Входящий звонок…");ringInLoop(true)}
async function answerCall(){if(!call.active||call.dir!=="in"||call.mode==="talk")return;
 ringInLoop(false);
 if(!await getMic()){
  /* сообщаем звонящему reject, чтобы он не ждал 45с; сами остаёмся с текстом ошибки */
  send({type:"call",op:"reject",to:call.peer,callID:call.callID});
  cleanupCall(false);return}
 call.pc=mkPC(call.peer);
 call.pc.addTrack(call.local.getAudioTracks()[0],call.local);
 try{await call.pc.setRemoteDescription({type:"offer",sdp:call.offer.sdp});
  const ans=await call.pc.createAnswer();await call.pc.setLocalDescription(ans);
  send({type:"call",op:"answer",to:call.peer,callID:call.callID,sdp:call.pc.localDescription.sdp});
  await flushIce();beginTalk()}catch(e){endCall("reject")}}
function beginTalk(){call.mode="talk";call.t0=Date.now();call.muted=false;call.wsWasDown=false;
 showCallUI(U(call.peer),"talk","Разговор");$("cm").textContent="Микрофон";$("cm").classList.remove("on");$("callwrap").classList.remove("muted");
 $("callb").disabled=true;
 /* Android: foreground-сервис держит процесс/микрофон живым при сворачивании */
 callService(true);
 clearInterval(call.talkT);call.talkT=setInterval(()=>{if(call.mode==="talk"){$("ct").textContent=mmss((Date.now()-call.t0)/1000|0);updCbar()}},500)}
async function callAnswered(f){if(!call.active||f.callID!==call.callID||!call.pc)return;
 if(f.renego){ /* ответ на наше видео-расширение: применяем и всё */
  try{await call.pc.setRemoteDescription({type:"answer",sdp:f.sdp});await flushIce()}catch(e){}
  call.renegoBusy=false;return}
 try{await call.pc.setRemoteDescription({type:"answer",sdp:f.sdp})}
 catch(e){
  /* просроченный/чужой answer (гонка при пере соединении) — игнорируем, не роняя звонок */
  if(call.mode==="talk")return;
  try{await call.pc.setRemoteDescription({type:"answer",sdp:f.sdp.replace(/a=candidate.*/g,"")})}
  catch(e2){showCallState("Ошибка соединения");endCall("end");return}}
 ringOutLoop(false);await flushIce();beginTalk()}
function callIce(f){if(!call.active||f.callID!==call.callID)return;
 /* ICE может прийти раньше remote description (пока звонок звонится) — буферизуем */
 if(!call.pc||!call.pc.remoteDescription){(call.pendingIce||(call.pendingIce=[])).push(f.cand);return}
 call.pc.addIceCandidate(f.cand).catch(()=>{})}
async function flushIce(){const buf=call.pendingIce||[];call.pendingIce=null;
 for(const c of buf){if(!call.pc)return;try{await call.pc.addIceCandidate(c)}catch(e){}}}
function callEnded(f){if(!call.active||(f.callID&&f.callID!==call.callID))return;cleanupCall(false);
 showCallState("Звонок завершён");setTimeout(hideCallUI,900);sndHang()}
function callRejected(f){if(!call.active||f.callID!==call.callID)return;cleanupCall(false);
 showCallState("Звонок отклонён");setTimeout(hideCallUI,900);sndHang()}
function callCancelled(f){if(!call.active||f.callID!==call.callID)return;cleanupCall(false);
 showCallState("Звонок отменён");setTimeout(hideCallUI,900);sndHang()}
function callBusy(f){if(!call.active||f.callID!==call.callID)return;cleanupCall(false);
 showCallState("Абонент занят");setTimeout(hideCallUI,900);sndHang()}
function callQueued(f){if(!call.active||f.callID!==call.callID)return;call.queued=true;
 showCallState("Не в сети — прозвоним при входе")}
function endCall(reason){if(!call.active)return;const op=reason|| (call.mode==="talk"?"end":call.dir==="in"?"reject":"cancel");
 ringOutLoop(false);ringInLoop(false);
 callFrame(op);
 cleanupCall(true);
 showCallState(op==="end"?"Звонок завершён":op==="reject"?"Звонок отклонён":"Звонок отменён");
 setTimeout(hideCallUI,900);sndHang()}
function cleanupCall(local){clearInterval(call.ringT);clearInterval(call.talkT);
 stopScreenShare();stopCamTrack();
 const ra=$("raudio");if(ra){ra.srcObject=null;ra.pause()}
 const rv=$("rvideo");if(rv){rv.srcObject=null;rv.pause()}
 $("callwrap").classList.remove("vid");
 callService(false);
 call.pendingIce=null;call.renegoBusy=false;call.renegoArmed=false;call.video=false;call.share=null;
 if(call.pc){try{call.pc.close()}catch(e){}call.pc=null}
 if(call.local){/* оставляем стрим для повторных звонков, закроем при logout */ }
 $("callb").disabled=false;call.active=false;call.mode=null;call.mini=false;call.dir=null;call.queued=false;call.offer=null;
 hideCbar()}
/* Android foreground-сервис: держит звонок живым при свёрнутом приложении.
   tauri.available() — ленивая проверка (internals могут появиться позже импорта). */
function callService(on){
 if(!tauri||!tauri.invoke||!tauri.available())return;
 const nm=(U(call.peer)||{}).name||"";
 tauri.invoke(on?"call_service_start":"call_service_stop",on?{peer:nm}:{}).catch(()=>{})}
/* ---------- видео: камера и демонстрация ---------- */
async function toggleCam(){
 if(!call.active||call.mode!=="talk")return;
 if(call.video&&call.local&&call.local.getVideoTracks().length){ /* выключить */
  stopCamTrack();updCbar();return}
 if(!navigator.mediaDevices||!navigator.mediaDevices.getUserMedia){showCallState("Камера недоступна");return}
 try{
  const s=await navigator.mediaDevices.getUserMedia({video:{facingMode:call.cam,width:{ideal:1280},height:{ideal:720}}});
  const vt=s.getVideoTracks()[0];
  call.local.addTrack(vt);            /* общий стрим (превью, повторные звонки) */
  call.renegoArmed=true;              /* разрешаем renego только здесь, по кнопке */
  call.pc.addTrack(vt,call.local);    /* в pc — триггерит onnegotiationneeded → renego */
  showLocalPreview(s);
  call.video=true;updCbar();
 }catch(e){showCallState("Нет доступа к камере")}}
function stopCamTrack(){
 if(call.local){call.local.getVideoTracks().forEach(t=>{t.stop();if(call.pc){
  const sender=call.pc.getSenders().find(sn=>sn.track===t);if(sender)call.pc.removeTrack(sender)}});
  call.local.getVideoTracks().forEach(t=>{try{call.local.removeTrack(t)}catch(e){}})}
 hideLocalPreview();call.video=false;updCbar()}
async function switchCam(){call.cam=call.cam==="user"?"environment":"user";
 if(call.video){stopCamTrack();await toggleCam()}else{updCbar()}}
function showLocalPreview(stream){
 let pv=$("lvideo");if(!pv)return;
 pv.srcObject=stream;pv.play().catch(()=>{});pv.dataset.facing=call.cam;
 $("callwrap").classList.add("vid")}
/* ---------- демонстрация экрана ---------- */
/* Tauri (desktop): нативный захват Windows.Graphics.Capture + WASAPI loopback,
   свой стилизованный пикер, БЕЗ нативного Chrome-диалога.
   Браузер: getDisplayMedia (хромовский диалог неизбежен).
   Android: getDisplayMedia (системный MediaProjection-диалог неизбежен). */
async function toggleShare(){
 if(!call.active||call.mode!=="talk")return;
 if(call.share){stopScreenShare();return}
 try{
  if(tauri&&tauri.invoke&&tauri.available()){
   if(await tauri.invoke("screen_active").catch(()=>false)){stopScreenShare();return}
   await startNativeShare()}
  else{await startBrowserShare()}
 }catch(e){showCallState(String(e.message||e))}}
async function startBrowserShare(){
 let stream;
 try{stream=await navigator.mediaDevices.getDisplayMedia({video:{frameRate:15},audio:true})}
 catch(e){if(e.name==="NotAllowedError")return;throw e}
 attachShareStream(stream,false)}
async function attachShareStream(stream,isNative){
 call.share=isNative?"native":"browser";call.shareStream=stream;
 const vt=stream.getVideoTracks()[0];
 if(vt)vt.onended=()=>stopScreenShare();
 if(call.pc){
  call.renegoArmed=true; /* явное действие юзера — разрешаем renego */
  stream.getTracks().forEach(t=>call.pc.addTrack(t,stream)); /* триггерит onnegotiationneeded → renego */
 }
 $("callwrap").classList.add("sharing");updCbar()}
function stopScreenShare(){
 if(call.shareStream){
  call.shareStream.getTracks().forEach(t=>{t.stop();if(call.pc){
   const sender=call.pc.getSenders().find(sn=>sn.track===t);if(sender)call.pc.removeTrack(sender)}});
  call.shareStream=null}
 if(call.share==="native"&&tauri&&tauri.invoke){tauri.invoke("screen_stop").catch(()=>{})}
 call.share=null;
 $("callwrap").classList.remove("sharing");updCbar()}
/* ---------- нативный пикер источников (Tauri/Windows) ---------- */
async function startNativeShare(){
 const src=await tauri.invoke("screen_sources");
 const pick=await pickScreenSource(src);
 if(!pick)return;
 const onVideo=tauri.channel(buf=>nativeVideoFrame(buf));
 const onAudio=tauri.channel(buf=>nativeAudioChunk(buf));
 await tauri.invoke("screen_start",{kind:pick.kind,id:pick.id,audio:pick.audio,onVideo,onAudio});
 /* Канвас-конвейер: JPEG-кадры → canvas → captureStream → WebRTC */
 const cv=document.createElement("canvas");
 const img=new Image();
 let stream=null,timer=null;
 nativeShare.pipe={cv,img,stream,timer};
 call.share="native";
 $("callwrap").classList.add("sharing");updCbar()}
let nativeShare={frames:0,pipe:null,ac:null,dest:null,worklet:null};
function nativeVideoFrame(buf){
 const p=nativeShare.pipe;if(!p||!buf)return;
 nativeShare.frames++;
 const url=URL.createObjectURL(new Blob([buf],{type:"image/jpeg"}));
 p.img.onload=()=>{
  if(!p.stream){
   p.cv.width=p.img.naturalWidth||1280;p.cv.height=p.img.naturalHeight||720;
   p.stream=p.cv.captureStream(15);
   if(call.pc){p.stream.getTracks().forEach(t=>call.pc.addTrack(t,p.stream));call.shareStream=p.stream}
   if($("rvideo")){/* локальный предпросмотр шеринга — свой экран */}
  }
  const ctx=p.cv.getContext("2d");ctx.drawImage(p.img,0,0);
  URL.revokeObjectURL(url)};
 p.img.onerror=()=>URL.revokeObjectURL(url);
 p.img.src=url}
function nativeAudioChunk(buf){
 /* f32le 48кГц stereo от WASAPI loopback → AudioWorklet → MediaStreamDestination */
 if(!buf||!buf.byteLength)return;
 try{
  if(!nativeShare.ac){
   nativeShare.ac=new AudioContext({sampleRate:48000});
   nativeShare.dest=nativeShare.ac.createMediaStreamDestination();
   const src=new Blob([workletCode()],{type:"application/javascript"});
   const url=URL.createObjectURL(src);
   nativeShare.ac.audioWorklet.addModule(url).then(()=>{
    const w=new AudioWorkletNode(nativeShare.ac,"lh-pcm",{numberOfInputs:0,numberOfOutputs:1,outputChannelCount:[2]});
    w.connect(nativeShare.dest);
    if(call.pc&&nativeShare.dest.stream.getAudioTracks()[0])call.pc.addTrack(nativeShare.dest.stream.getAudioTracks()[0],nativeShare.dest.stream);
    nativeShare.worklet=w}).catch(()=>{});URL.revokeObjectURL(url)}
  const w=nativeShare.worklet;
  if(w)w.port.postMessage(new Float32Array(buf),[buf])
 }catch(e){}}
function workletCode(){return 'class PCMP extends AudioWorkletProcessor{'+
 'constructor(){super();this.q=[]}'+
 'process(_,out){'+
 'const L=out[0][0],R=out[0][1]||out[0][0];let i=0;'+
 'while(i<L.length){'+
 'if(!this.q.length)return true;'+
 'const f=this.q.shift();'+
 'for(let k=0;k<f.length&&i<L.length;k+=2){L[i]=f[k];R[i]=f[k+1]||0;i++}}'+
 'return true}}'+
 'registerProcessor("lh-pcm",PCMP)'}
/* Пикер источников: модальное окно в стиле Aero, возвращает {kind,id,audio} */
function pickScreenSource(src){return new Promise(res=>{
 const ov=document.createElement("div");ov.className="sharepick";
 const items=[...(src.monitors||[]).map(m=>({...m,tag:"Экран"})),...(src.windows||[]).map(w=>({...w,tag:"Окно"}))];
 ov.innerHTML='<div class="spcard"><h3>Что показать?</h3><div class="splist"></div>'+
  '<label class="spaud"><input type="checkbox" id="spaudio" checked> Звук системы</label>'+
  '<div class="sprow"><button class="btn spcancel">Отмена</button><button class="btn spok">Демонстрировать</button></div></div>';
 let sel=null;
 const list=ov.querySelector(".splist");
 items.forEach(it=>{const b=document.createElement("button");b.type="button";b.className="spitem";
  b.innerHTML='<span class="spkind">'+esc(it.tag)+"</span><b>"+esc(it.title)+"</b>"+(it.w?"<small>"+it.w+"×"+it.h+"</small>":"");
  b.onclick=()=>{ov.querySelectorAll(".spitem").forEach(x=>x.classList.remove("sel"));b.classList.add("sel");sel=it};
  list.appendChild(b)});
 ov.querySelector(".spcancel").onclick=()=>{ov.remove();res(null)};
 ov.querySelector(".spok").onclick=()=>{if(!sel)return;const audio=ov.querySelector("#spaudio").checked;ov.remove();res({kind:sel.kind,id:sel.id,audio})};
 ov.onclick=e=>{if(e.target===ov){ov.remove();res(null)}};
 document.body.appendChild(ov)})}
function mmss(n){return String(n/60|0).padStart(2,"0")+":"+String(n%60).padStart(2,"0")}
function showCallUI(u,m,text){const w=$("callwrap");
 w.dataset.m=m;w.classList.add("open");
 const fresh=!w.classList.contains("enter")&&!w.classList.contains("drop");
 if(fresh&&m!=="talk"){w.classList.add("enter")}
 $("cav").innerHTML=avaHTML(u);$("cn").textContent=u?u.name:"";
 showCallState(text);$("ct").textContent="";}
function showCallState(t){$("cs").textContent=t}
function hideCallUI(){const w=$("callwrap");w.classList.remove("open","enter","drop");$("cav").innerHTML="";$("cn").textContent="";$("cs").textContent="";$("ct").textContent=""}
/* мини-пилюля */
function setMini(v){if(!call.active&&v)return;
 call.mini=v;const w=$("callwrap"),bar=$("cbar");
 if(v){w.classList.remove("open","enter","drop");barShow();$("cbav").innerHTML=avaHTML(U(call.peer));$("cbn").textContent=U(call.peer)?U(call.peer).name:"";updCbar()}
 else{w.classList.remove("enter");w.classList.add("open");if(!RM){w.classList.add("drop");const off=()=>w.classList.remove("drop");w.addEventListener("animationend",off,{once:true});w.addEventListener("animationcancel",off,{once:true})}barHide()}}
function updCbar(){if(!call.active)return;
 $("cbt").textContent=call.mode==="talk"?mmss((Date.now()-call.t0)/1000|0):call.queued?"В очереди…":"Вызов…";
 $("cbm").classList.toggle("on",call.muted)}
/* статус-текст видеорежима для пилюли и звонка */
function vidBadge(){if(!call.active)return"";
 if(call.share)return " ● экран";
 if(call.video)return call.cam==="user"?" ● вебка":" ● камера";
 return ""}
const RM=matchMedia("(prefers-reduced-motion: reduce)").matches;
let barT=null;
const barShow=()=>{clearTimeout(barT);$("cbar").classList.remove("closing");$("cbar").classList.add("open")};
const barHide=()=>{const bar=$("cbar");if(RM||!bar.classList.contains("open")){bar.classList.remove("open","closing");return}
 bar.classList.add("closing");clearTimeout(barT);barT=setTimeout(()=>bar.classList.remove("open","closing"),360)};
function hideCbar(){barHide()}
setInterval(()=>{if(call.active&&call.mini)updCbar()},500);

/* ---------- логин/регистрация ---------- */
let regMode=false;
function initLogin(){const avrow=$("avrow");
 avrow.innerHTML=AVA.map((a,i)=>'<button type="button" data-av="'+i+'" class="'+(i===0?"sel":"")+'" aria-label="Аватар '+(i+1)+'"><span class="ava">'+a+"</span></button>").join("");
 avrow.onclick=e=>{const b=e.target.closest("button");if(!b)return;
  avrow.querySelectorAll("button").forEach(x=>x.classList.remove("sel"));b.classList.add("sel");cfg.regAvatar=+b.dataset.av};
 $("srv").value=cfg.server;
 $("togglereg").onclick=()=>{regMode=!regMode;
  $("regfields").style.display=regMode?"block":"none";
  $("loginb").textContent=regMode?"Создать аккаунт":"Войти";
  $("togglereg").textContent=regMode?"У меня есть аккаунт":"Создать аккаунт";
  $("lerr").textContent=""};
 $("loginb").onclick=doLogin;
 $("lpass").onkeydown=$("lname").onkeydown=e=>{if(e.key==="Enter")doLogin()};
 $("srv").onchange=()=>{cfg.server=$("srv").value.trim().replace(/\/$/,"");localStorage.setItem("lh-server",cfg.server)}}
async function doLogin(){const name=$("lname").value.trim(),pass=$("lpass").value;
 const err=t=>$("lerr").textContent=t;
 if(!name||!pass)return err("Заполни имя и пароль");
 $("loginb").disabled=true;err("");
 try{const path=regMode?"/api/register":"/api/login";
  const body=regMode?{name,password:pass,avatar:cfg.regAvatar}:{name,password:pass};
  const r=await api(path,body);
  token=r.token;me=r.user;localStorage.setItem("lh-token",token);
  $("login").classList.add("hidden");connect();
  // prefetch истории не нужен — hello несёт unread
 }catch(e){err(e.message)}finally{$("loginb").disabled=false}}
function logout(){try{api("/api/logout",null,"POST")}catch(e){}
 token=null;me=null;localStorage.removeItem("lh-token");
 try{sock.onclose=null;sock.close()}catch(e){}
 sock=null;location.reload()}

/* ---------- Tauri ---------- */
let tauri=null;
async function initTauri(){try{const m=await import("./tauri.mjs");tauri=m}catch(e){return}
 /* internals в Android WebView инжектятся асинхронно — ждём до 10с */
 for(let i=0;i<50&&!tauri.available();i++)await new Promise(r=>setTimeout(r,200));
 try{
  const win=tauri.window.getCurrentWindow();
  $("minb").onclick=()=>win.minimize();
  $("maxb").onclick=()=>win.toggleMaximize();
  $("closeb").onclick=()=>win.close();
  const tb=$("titlebar");
  tb.addEventListener("mousedown",e=>{if(e.target.closest(".wbtn"))return;win.startDragging()});
  tb.addEventListener("dblclick",e=>{if(!e.target.closest(".wbtn"))win.toggleMaximize()})}catch(e){}}

/* ---------- события DOM ---------- */
function bind(){
 $("list").onclick=e=>{const b=e.target.closest(".ct");if(b)openChat(+b.dataset.id)};
 $("q").oninput=e=>{filter=e.target.value.toLowerCase();renderList()};
 $("back").onclick=()=>setCur(null);
 $("sendb").onclick=doSend;
 $("txt").addEventListener("keydown",e=>{if(e.key==="Enter"&&!e.shiftKey){e.preventDefault();doSend()}});
 $("txt").addEventListener("input",e=>{autoGrow(e.target);if(cur!=null)sendTyping(cur,true)});
 $("txt").addEventListener("blur",typingOff);
 $("status").onchange=e=>{manualStatus=e.target.value;localStorage.setItem("lh-status",manualStatus);idleStatus=false;sendPresence();renderMe()};
 $("mood").onchange=e=>sendPresence();
 document.addEventListener("visibilitychange",()=>{if(!document.hidden&&cur!=null)markRead(cur)});
 $("msgs").addEventListener("scroll",async()=>{const box=$("msgs");
  if(box.scrollTop<60&&box.dataset.hasMore==="1")await loadMore()});
 /* эмодзи */
 $("epicker").innerHTML=Object.keys(EMO).map(n=>'<button type="button" data-c=":'+n+':" aria-label="'+n+'"><span class="em">'+EMO[n]+"</span></button>").join("");
 $("emob").onclick=e=>{e.stopPropagation();$("epicker").classList.toggle("open")};
 $("epicker").onclick=e=>{const b=e.target.closest("button");if(!b)return;
  const ta=$("txt");ta.value+=b.dataset.c+" ";ta.focus();autoGrow(ta);if(cur!=null)sendTyping(cur,true)};
 document.addEventListener("click",e=>{if(!e.target.closest("#epicker")&&!e.target.closest("#emob"))$("epicker").classList.remove("open")});
 $("emob").innerHTML='<span class="em">'+EMO.smile+"</span>";
 /* звонки */
 $("callb").onclick=()=>{if(cur!=null&&!call.active)startCall(cur)};
 $("cacc").onclick=answerCall;
 $("cdec").onclick=()=>endCall("reject");
 $("cend").onclick=()=>endCall(call.mode==="talk"?"end":"cancel");
 $("cmin").onclick=()=>setMini(true);
 $("cbx").onclick=()=>setMini(false);
 $("cbe").onclick=()=>endCall(call.mode==="talk"?"end":"cancel");
 $("cbm").onclick=()=>{toggleMute()};
 $("cm").onclick=toggleMute;
 /* видео: камера/переключение/шеринг */
 $("ccam").onclick=toggleCam;
 $("cflip").onclick=switchCam;
 $("cshare").onclick=toggleShare;
 $("cbcam")&&($("cbcam").onclick=toggleCam);
 $("cbshare")&&($("cbshare").onclick=()=>{setMini(false)});
 function toggleMute(){if(!call.active||!call.local)return;call.muted=!call.muted;
  call.local.getAudioTracks().forEach(t=>t.enabled=!call.muted);
  $("cm").textContent=call.muted?"Включить микрофон":"Микрофон";$("cm").classList.toggle("on",call.muted);
  $("callwrap").classList.toggle("muted",call.muted);updCbar()}
 /* тема/выход */
 $("themeb").onclick=()=>{cfg.theme=cfg.theme==="dark"?"light":"dark";applyTheme()};
 $("logoutb").onclick=logout;
 window.addEventListener("online",connect);
 window.addEventListener("offline",()=>showConn("Нет сети"))}

/* ---------- запуск ---------- */
(async function main(){
 initLogin();bind();initTauri();
 /* dev-параметры URL: ?token=...&server=http://... — автологин для скриншотов/отладки */
 const qp=new URLSearchParams(location.search);
 if(qp.get("server")){cfg.server=qp.get("server").replace(/\/$/,"");localStorage.setItem("lh-server",cfg.server);$("srv").value=cfg.server}
 const urlToken=qp.get("token");
 const autoOpen=qp.get("open");
 if(qp.get("theme")){cfg.theme=qp.get("theme");applyTheme()}
 const saved=urlToken||localStorage.getItem("lh-token");
 if(saved){token=saved;
  try{const r=await api("/api/me");me=r.user;manualStatus=me.status&&["on","idle","dnd","inv"].includes(me.status)?me.status:"on";
   localStorage.setItem("lh-status",manualStatus);
   $("login").classList.add("hidden");connect();
   if(autoOpen)setTimeout(()=>openChat(+autoOpen),600)}
  catch(e){token=null;localStorage.removeItem("lh-token");$("login").classList.remove("hidden")}}
})();
