#!/bin/bash
# замер скорости: мост до Telegram, ответ локального бота, нагрузка сервера, последние ошибки
set -a; . /etc/di-sign-bot.env; set +a
echo "== мост до Telegram (getMe), 5 раз, секунды"
for i in 1 2 3 4 5; do
  curl -s -o /dev/null -w "%{time_connect} connect, %{time_starttransfer} ответ, %{time_total} всего\n" -X POST -H "x-relay-key: $TG_RELAY_KEY" "$TG_API_ROOT/bot$BOT_TOKEN/getMe"
done
echo "== прямой api.telegram.org (должен не открыться)"
curl -s -m 5 -o /dev/null -w "%{http_code} %{time_total}\n" https://api.telegram.org || echo "не открывается"
echo "== локальный сервер бота"
curl -s -o /dev/null -w "%{time_total} сек\n" http://127.0.0.1:${PORT:-8080}/policy
echo "== нагрузка"
uptime; free -m | sed -n 2p
echo "== последние строки журнала"
journalctl -u di-sign-bot -n 15 --no-pager | cut -c1-160
