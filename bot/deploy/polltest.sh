#!/usr/bin/env bash
# Меряет getUpdates (как у бота) через каждый мост и показывает свежий журнал со временем.
set -a; . /etc/di-sign-bot.env; set +a
cd /opt/di-sign-bot/bot
cat > /tmp/pt.mjs <<'JS'
import net from 'node:net'; import dns from 'node:dns';
net.setDefaultAutoSelectFamily(false); dns.setDefaultResultOrder('ipv4first');
const roots = String(process.env.TG_API_ROOT).split(',');
const keys = String(process.env.TG_RELAY_KEY).split(',');
for (let n = 0; n < 3; n++) for (let i = 0; i < roots.length; i++) {
  const k = keys.length > 1 ? keys[i] : keys[0];
  const t0 = Date.now();
  try {
    const r = await fetch(roots[i] + '/bot' + process.env.BOT_TOKEN + '/getUpdates', { method: 'POST', headers: { 'x-relay-key': k, 'content-type': 'application/json' }, body: JSON.stringify({ offset: -1, timeout: 4 }), signal: AbortSignal.timeout(15000) });
    console.log(' мост', i + 1, 'ок', r.status, Date.now() - t0, 'мс');
  } catch (e) { console.log(' мост', i + 1, 'сбой', e.message, e.cause && (e.cause.code || e.cause.message), Date.now() - t0, 'мс'); }
}
JS
systemctl stop di-sign-bot
node --no-warnings /tmp/pt.mjs
systemctl start di-sign-bot
echo "порядок мостов в настройке:"; echo "$TG_API_ROOT" | tr ',' '\n'
journalctl -u di-sign-bot --since "-3min" --no-pager | tail -8
