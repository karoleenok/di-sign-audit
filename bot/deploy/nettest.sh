#!/usr/bin/env bash
# Почему node не достучался до мостов, когда curl достучался: пробуем по-разному и меряем время.
set -a; . /etc/di-sign-bot.env; set +a
cd /opt/di-sign-bot/bot
cat > /tmp/nt.mjs <<'JS'
const roots = String(process.env.TG_API_ROOT).split(',');
const keys = String(process.env.TG_RELAY_KEY).split(',');
for (let i = 0; i < roots.length; i++) {
  const k = keys.length > 1 ? keys[i] : keys[0];
  const t0 = Date.now();
  try {
    const r = await fetch(roots[i] + '/bot' + process.env.BOT_TOKEN + '/getMe', { method: 'POST', headers: { 'x-relay-key': k }, signal: AbortSignal.timeout(15000) });
    console.log('  мост', i + 1, 'ок', r.status, Date.now() - t0, 'мс');
  } catch (e) { console.log('  мост', i + 1, 'сбой', e.message, e.cause && (e.cause.code || e.cause.message), Date.now() - t0, 'мс'); }
}
JS
echo "обычный node:"; node --no-warnings /tmp/nt.mjs
echo "node, сначала IPv4:"; node --no-warnings --dns-result-order=ipv4first /tmp/nt.mjs
echo "node, без автоподбора семейства:"; node --no-warnings --no-network-family-autoselection --dns-result-order=ipv4first /tmp/nt.mjs
echo "настройки прокси в окружении:"; env | grep -ci proxy
