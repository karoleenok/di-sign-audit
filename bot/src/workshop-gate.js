// Закрытая страница игры-прогрева: сама страница-ворота пустая, игру отдаёт сервер только админам.
// Проверка по подписи Telegram (initData) и списку админов, как в панели.
export default `<!doctype html><html lang="ru" data-theme="light"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>Di Sign University</title><meta name="robots" content="noindex">
<script src="https://telegram.org/js/telegram-web-app.js"></script>
<style>body{margin:0;min-height:100dvh;display:grid;place-items:center;font:16px/24px system-ui,sans-serif;background:#fffbf7;color:#2c0d02;padding:16px;text-align:center}</style></head>
<body><p id="m">Открываю…</p>
<script>
(function(){
  var m=document.getElementById('m'),tg=window.Telegram&&window.Telegram.WebApp;
  if(!tg||!tg.initData){m.textContent='Открой игру из бота: команда /game.';return}
  fetch('/api/app/load',{method:'POST',headers:{'x-init-data':tg.initData}}).then(function(r){
    if(r.status===403){m.textContent='Игра пока только для админов.';return null}
    if(!r.ok){m.textContent='Не получилось открыть (код '+r.status+'). Попробуй ещё раз из бота.';return null}
    return r.text()}).then(function(h){if(!h)return;document.open();document.write(h);document.close()}).catch(function(){m.textContent='Нет связи. Попробуй ещё раз.'});
})();
</script></body></html>`;
