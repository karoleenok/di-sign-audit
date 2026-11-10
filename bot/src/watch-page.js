// Страница видеоурока (мини-аппка в Телеграме): плеер YouTube, главы, водяной знак с именем ученика.
// Сама страница пустая и одинаковая для всех: ID видео приходит с сервера только после проверки подписи Telegram и доступа.
// Скрипт и стили отдаются отдельными файлами (/watch.js, /watch.css), чтобы в защите страницы не было 'unsafe-inline'.

export const WATCH_VER = '1';

export const WATCH_HTML = `<!doctype html><html lang="ru"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="referrer" content="strict-origin-when-cross-origin"><meta name="robots" content="noindex">
<title>Урок · Di Sign University</title>
<script src="https://telegram.org/js/telegram-web-app.js"></script>
<link rel="stylesheet" href="/watch.css?v=${WATCH_VER}"></head>
<body>
<main class="wrap">
  <header class="top"><span class="pill">Di Sign University</span></header>
  <h1 id="ttl">Открываю урок…</h1>
  <div class="player" id="player">
    <div class="stage" id="stage">
      <div id="yt"></div>
      <div class="mark" id="mark" aria-hidden="true"></div>
      <div class="state" id="state" role="status" aria-live="polite">
        <div class="spin" id="spin" aria-hidden="true"></div>
        <p class="st-t" id="stT">Открываю урок…</p>
        <p class="st-d" id="stD"></p>
        <button class="btn" id="stBtn" type="button" hidden>Повторить</button>
      </div>
      <button class="x" id="xBtn" type="button" aria-label="Выйти из полного экрана" hidden>✕</button>
    </div>
    <div class="bar">
      <button class="chip" id="fsBtn" type="button">⛶ На весь экран</button>
    </div>
  </div>
  <div class="resume" id="resume" hidden>
    <p>Ты остановился на <b id="resT">0:00</b></p>
    <div class="resume-b"><button class="btn" id="resGo" type="button">Продолжить</button><button class="btn ghost" id="resNo" type="button">С начала</button></div>
  </div>
  <section class="chs" id="chs" hidden>
    <h2>Главы</h2>
    <ol id="chList"></ol>
  </section>
  <p class="foot">Урок только для учеников Di Sign University. Пересылать и записывать нельзя: на видео стоит твоё имя.</p>
</main>
<script src="/watch.js?v=${WATCH_VER}"></script>
</body></html>`;

export const WATCH_CSS = `@font-face{font-family:'Inter Tight';font-weight:100 900;font-style:normal;src:url(/fonts/inter-tight.woff) format('woff');font-display:swap}
:root{--bg:#fffbf8;--card:#fff;--ink:#2c0d02;--text:#1c0408;--soft:rgba(28,4,8,.68);--line:rgba(44,13,2,.14);--blue:#1f73c4;--pink:#b82e85;--lilac:#f8e4f4;--outline:#66b8ff;--stage:#1c0408;
  --s1:4px;--s2:8px;--s3:12px;--s4:16px;--s5:24px;--s6:32px;--r-s:8px;--r-m:16px;--f:'Inter Tight',system-ui,-apple-system,'Segoe UI',Roboto,sans-serif;color-scheme:light}
*{box-sizing:border-box}
html{-webkit-text-size-adjust:100%}
body{margin:0;background:var(--bg);color:var(--text);font:400 16px/24px var(--f);-webkit-font-smoothing:antialiased;min-height:100dvh}
[hidden]{display:none!important}
.wrap{max-width:720px;margin:0 auto;padding:var(--s4) max(var(--s4),env(safe-area-inset-right)) calc(var(--s6) + env(safe-area-inset-bottom)) max(var(--s4),env(safe-area-inset-left))}
.top{margin:0 0 var(--s3)}
.pill{display:inline-block;padding:var(--s1) var(--s3);border-radius:999px;background:var(--lilac);color:var(--ink);font-size:13px;line-height:20px;font-weight:600;letter-spacing:.01em}
h1{margin:0 0 var(--s4);font-size:clamp(24px,6.5vw,32px);line-height:1.15;font-weight:600;letter-spacing:-.01em;color:var(--ink);text-wrap:balance;overflow-wrap:anywhere}
h2{margin:0 0 var(--s3);font-size:18px;line-height:24px;font-weight:600;color:var(--ink)}
/* плеер прилипает к верху: главы прокручиваются под ним, видео не пропадает */
.player{position:sticky;top:0;z-index:5;background:var(--bg);padding:var(--s1) 0 var(--s2)}
.stage{position:relative;aspect-ratio:16/9;background:var(--stage);border-radius:var(--r-m);overflow:hidden}
.stage iframe,.stage #yt{position:absolute;inset:0;width:100%;height:100%;border:0}
.mark{position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);z-index:2;max-width:70%;padding:0 var(--s2);font-size:clamp(11px,3.2vw,14px);line-height:1.3;font-weight:600;color:rgba(255,255,255,.4);text-shadow:0 1px 3px rgba(0,0,0,.55);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;pointer-events:none;user-select:none;-webkit-user-select:none;transition:left 1.2s ease,top 1.2s ease}
.state{position:absolute;inset:0;z-index:3;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:var(--s2);padding:var(--s4);text-align:center;background:var(--stage);color:#fff}
.state .st-t{margin:0;font-size:16px;line-height:22px;font-weight:600}
.state .st-d{margin:0;max-width:34ch;font-size:14px;line-height:20px;color:rgba(255,255,255,.78)}
.state .st-d:empty{display:none}
.spin{width:28px;height:28px;border-radius:50%;border:3px solid rgba(255,255,255,.25);border-top-color:#fff;animation:sp 0.9s linear infinite}
.state.err .spin{display:none}
@keyframes sp{to{transform:rotate(360deg)}}
.bar{display:flex;justify-content:flex-end;padding-top:var(--s2)}
.btn,.chip{font:600 15px/20px var(--f);cursor:pointer;-webkit-tap-highlight-color:transparent}
.btn{min-height:48px;padding:var(--s3) var(--s5);border:0;border-radius:999px;background:var(--blue);color:#fff}
.btn.ghost{background:transparent;color:var(--ink);box-shadow:inset 0 0 0 1.5px var(--line)}
.state .btn{margin-top:var(--s2);background:#fff;color:#1c0408}
.chip{min-height:44px;padding:var(--s2) var(--s4);border:0;border-radius:999px;background:var(--lilac);color:var(--ink)}
.btn:focus-visible,.chip:focus-visible,.ch:focus-visible,.x:focus-visible{outline:2px solid var(--outline);outline-offset:2px}
.x{position:absolute;top:max(var(--s3),env(safe-area-inset-top));right:max(var(--s3),env(safe-area-inset-right));z-index:4;width:44px;height:44px;border:0;border-radius:50%;background:rgba(0,0,0,.55);color:#fff;font-size:18px;cursor:pointer}
.stage.full{position:fixed;inset:0;z-index:50;aspect-ratio:auto;border-radius:0;width:100vw;height:100dvh}
.resume{margin:var(--s2) 0 var(--s4);padding:var(--s4);background:var(--card);border-radius:var(--r-m);box-shadow:inset 0 0 0 1px var(--line)}
.resume p{margin:0 0 var(--s3)}
.resume-b{display:grid;grid-template-columns:1fr 1fr;gap:var(--s2)}
.chs{margin-top:var(--s4)}
.chs ol{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:var(--s1)}
.ch{display:grid;grid-template-columns:auto 1fr;gap:var(--s3);align-items:baseline;width:100%;min-height:48px;padding:var(--s3) var(--s4);border:0;border-radius:var(--r-m);background:transparent;color:var(--text);font:400 16px/22px var(--f);text-align:left;cursor:pointer;-webkit-tap-highlight-color:transparent}
.ch time{min-width:var(--tw,4ch);font-size:14px;line-height:22px;font-weight:600;font-variant-numeric:tabular-nums;color:var(--blue)}
.ch span{overflow-wrap:anywhere}
.ch[aria-current=true]{background:var(--lilac);font-weight:600}
.ch[aria-current=true] time{color:var(--pink)}
.foot{margin:var(--s5) 0 0;font-size:13px;line-height:18px;color:var(--soft)}
@media (hover:hover){.ch:hover{background:var(--lilac)}}
@media (min-width:600px){.wrap{padding-top:var(--s5)}.player{position:static}}
@media (prefers-reduced-motion:reduce){.mark{transition:none}.spin{animation-duration:2.4s}}
`;

export const WATCH_JS = `(function(){
'use strict';
var tg=window.Telegram&&window.Telegram.WebApp;
var $=function(i){return document.getElementById(i)};
var m=/^\\/watch\\/(\\d+)\\/(\\d+-\\d+)\\/?$/.exec(location.pathname);
var D=null,player=null,ready=false,timers={},lastSave=0,lastSec=0,wantResume=0;
var stage=$('stage');

function fmt(s){s=Math.max(0,Math.floor(s||0));var h=Math.floor(s/3600),mi=Math.floor(s%3600/60),r=s%60;return (h?h+':'+(mi<10?'0':'')+mi:String(mi))+':'+(r<10?'0':'')+r}
/* страница всегда светлая, как весь бренд, даже если в Телеграме тёмная тема: красим и шапку самого Телеграма */
function setTheme(){try{var c='#fffbf8';tg&&tg.setHeaderColor&&tg.setHeaderColor(c);tg&&tg.setBackgroundColor&&tg.setBackgroundColor(c);tg&&tg.setBottomBarColor&&tg.setBottomBarColor(c)}catch(e){}}
function state(kind,title,text,btn){
  var s=$('state');s.hidden=false;s.className='state'+(kind==='err'?' err':'');
  $('stT').textContent=title;$('stD').textContent=text||'';
  var b=$('stBtn');b.hidden=!btn;if(btn){b.textContent=btn.label;b.onclick=btn.fn}
}
function hideState(){$('state').hidden=true}
function fail(title,text,retry){state('err',title,text,retry?{label:'Повторить',fn:function(){location.reload()}}:null)}
function vpn(){fail('YouTube не отвечает','Видео лежит на YouTube. Без VPN он в России не открывается. Включи VPN и нажми «Повторить».',true)}

function api(path,body,keep){
  return fetch(path,{method:'POST',keepalive:!!keep,headers:{'content-type':'application/json','x-init-data':tg.initData},body:JSON.stringify(body)});
}

/* водяной знак: имя и id ученика, плавно переезжает по кадру (не закрывает управление плеера внизу и название сверху) */
function startMark(){
  var el=$('mark');var nm=(D.name||'').split(/\s+/)[0].slice(0,18);el.textContent=(nm?nm+' · ':'')+'id '+D.uid;
  var spots=[[26,40],[72,42],[50,56],[28,64],[74,62],[50,38]],i=Math.floor(Math.random()*spots.length);
  function go(){var p=spots[i],jx=(Math.random()*8-4),jy=(Math.random()*6-3);el.style.left=(p[0]+jx)+'%';el.style.top=(p[1]+jy)+'%';var n;do{n=Math.floor(Math.random()*spots.length)}while(n===i);i=n}
  go();setInterval(go,14000);
}

/* главы */
function drawChapters(){
  var list=$('chList');list.textContent='';
  if(!D.ch||!D.ch.length){$('chs').hidden=true;return}
  var tw=0;D.ch.forEach(function(c){var f=fmt(c.t),co=f.split(':').length-1;tw=Math.max(tw,f.length-co*0.6)});list.style.setProperty('--tw',tw.toFixed(1)+'ch');
  D.ch.forEach(function(c,k){
    var li=document.createElement('li'),b=document.createElement('button');b.type='button';b.className='ch';b.dataset.k=k;
    var t=document.createElement('time');t.textContent=fmt(c.t);var s=document.createElement('span');s.textContent=c.title;
    b.appendChild(t);b.appendChild(s);b.onclick=function(){seek(c.t)};li.appendChild(b);list.appendChild(li);
  });
  $('chs').hidden=false;
}
function markChapter(sec){
  if(!D||!D.ch||!D.ch.length)return;var cur=-1;
  for(var k=0;k<D.ch.length;k++){if(D.ch[k].t<=sec+1)cur=k}
  var bs=$('chList').children;
  for(var q=0;q<bs.length;q++){var b=bs[q].firstChild;if(q===cur)b.setAttribute('aria-current','true');else b.removeAttribute('aria-current')}
}
function seek(t){if(!ready)return;try{player.seekTo(t,true);player.playVideo()}catch(e){}}

/* где остановился */
function save(force){
  if(!ready||!D)return;
  var now=Date.now();if(!force&&now-lastSave<14000)return;
  var s=0,d=0;try{s=player.getCurrentTime();d=player.getDuration()}catch(e){return}
  if(!(s>=0))return;lastSave=now;lastSec=s;
  api('/api/watch/progress',{p:+m[1],b:m[2],s:Math.floor(s),d:Math.floor(d||0)},true).catch(function(){});
}

/* полный экран: свой, чтобы водяной знак не пропадал (у YouTube он бы ушёл) */
function fullOn(){stage.classList.add('full');$('xBtn').hidden=false;
  try{if(stage.requestFullscreen)stage.requestFullscreen().catch(function(){});else if(stage.webkitRequestFullscreen)stage.webkitRequestFullscreen()}catch(e){}}
function fullOff(){stage.classList.remove('full');$('xBtn').hidden=true;
  try{if(document.fullscreenElement)document.exitFullscreen()}catch(e){}}
document.addEventListener('fullscreenchange',function(){if(!document.fullscreenElement&&stage.classList.contains('full'))fullOff()});
document.addEventListener('keydown',function(e){if(e.key==='Escape')fullOff()});
$('fsBtn').onclick=function(){stage.classList.contains('full')?fullOff():fullOn()};
$('xBtn').onclick=fullOff;

/* плеер YouTube */
function initPlayer(){
  clearTimeout(timers.api);
  player=new YT.Player('yt',{
    host:'https://www.youtube-nocookie.com',videoId:D.id,
    playerVars:{playsinline:1,rel:0,modestbranding:1,fs:0,iv_load_policy:3,enablejsapi:1,hl:'ru',cc_lang_pref:'ru',origin:location.origin},
    events:{
      onReady:function(){ready=true;clearTimeout(timers.ready);hideState();
        if(D.resume>=15&&(!D.dur||D.dur-D.resume>30)){$('resT').textContent=fmt(D.resume);$('resume').hidden=false;wantResume=D.resume}},
      onStateChange:function(e){
        if(e.data===1){setInterval_();$('resume').hidden=true}
        if(e.data===2||e.data===0)save(true);
        if(e.data===0)markChapter(0);
      },
      onError:function(e){
        var c=e.data;
        if(c===101||c===150||c===153)fail('Видео не открывается',D.admin?'YouTube не даёт показать это видео здесь (код '+c+'). Включи в настройках видео «Разрешить встраивание».':'Видео сейчас недоступно. Напиши в бота, мы поправим.',true);
        else if(c===100)fail('Видео не найдено',D.admin?'Видео удалено или закрыто (код 100). Для урока нужен доступ «По ссылке», а не «Закрытый».':'Видео сейчас недоступно. Напиши в бота, мы поправим.',false);
        else fail('Видео не открывается','Попробуй ещё раз. Если не выйдет, напиши в бота.',true);
      }
    }
  });
  timers.ready=setTimeout(function(){if(!ready)vpn()},15000);
}
var tick=null;
function setInterval_(){
  if(tick)return;
  tick=setInterval(function(){
    if(!ready)return;var s=0,st=-1;try{s=player.getCurrentTime();st=player.getPlayerState()}catch(e){return}
    markChapter(s);if(st===1)save(false);
  },1000);
}
function loadYT(){
  if(window.YT&&window.YT.Player){initPlayer();return}
  window.onYouTubeIframeAPIReady=initPlayer;
  var s=document.createElement('script');s.src='https://www.youtube.com/iframe_api';s.async=true;s.onerror=vpn;document.head.appendChild(s);
  timers.api=setTimeout(function(){if(!(window.YT&&window.YT.Player))vpn()},9000);
}
$('resGo').onclick=function(){$('resume').hidden=true;seek(wantResume)};
$('resNo').onclick=function(){$('resume').hidden=true;seek(0)};
document.addEventListener('visibilitychange',function(){if(document.hidden)save(true)});
window.addEventListener('pagehide',function(){save(true)});

/* старт */
setTheme();
if(tg){try{tg.ready();tg.expand();tg.disableVerticalSwipes&&tg.disableVerticalSwipes();tg.onEvent&&tg.onEvent('themeChanged',setTheme)}catch(e){}}
if(!m||!tg||!tg.initData){$('ttl').textContent='Урок';fail('Открой урок из бота','Нажми кнопку «Смотреть урок» под постом в чате с ботом.',false)}
else{
  state('load','Открываю урок…','');
  api('/api/watch/load',{p:+m[1],b:m[2]}).then(function(r){
    if(r.status===401){fail('Открой урок из бота','Нажми кнопку «Смотреть урок» под постом в чате с ботом.',false);return null}
    if(r.status===403||r.status===404){return r.text().then(function(t){fail(r.status===404?'Урок не найден':'Пока нельзя открыть',t,false);return null})}
    if(!r.ok){fail('Не получилось открыть','Попробуй ещё раз.',true);return null}
    return r.json();
  }).then(function(d){
    if(!d)return;D=d;$('ttl').textContent=d.title;document.title=d.title+' · Di Sign University';
    drawChapters();startMark();state('load','Загружаю видео…','');loadYT();
  }).catch(function(){fail('Нет связи','Проверь интернет и нажми «Повторить».',true)});
}
})();
`;
