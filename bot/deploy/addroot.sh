#!/usr/bin/env bash
# Добавить второй мост (Vercel): бот будет пользоваться обоими и переключаться при сбоях.
set -euo pipefail
ENVF=/etc/di-sign-bot.env
grep -q '^ADMIN_IDS="' "$ENVF" || sed -i 's/^ADMIN_IDS=\(.*\)$/ADMIN_IDS="\1"/' "$ENVF"
set -a; . "$ENVF"; set +a
KEY=${1:-${RELAY_KEY_NEW:-$(head -c 24 /dev/urandom | base64 | tr -dc 'a-km-np-z2-9' | head -c 24)}}
echo
echo "Ключ для моста (переменная RELAY_KEY):"
echo
echo "    $KEY"
echo
URL=${2:-}
[ -n "$URL" ] || read -r -p "Адрес второго моста (например disign-tg-relay.netlify.app): " URL
URL=${URL%/}
case "$URL" in http*) ;; *) URL="https://$URL" ;; esac
[ -n "$URL" ] || { echo "адрес пустой"; exit 1; }
echo "проверяю мост..."
R=$(curl -sS -m 25 -X POST -H "x-relay-key: $KEY" -H 'content-type: application/json' -d '{}' "$URL/bot$BOT_TOKEN/getMe" 2>&1) || true
echo "$R" | grep -q '"ok":true' || { echo "мост не отвечает как надо: ${R:0:200}"; exit 1; }
echo "✓ мост работает, время ответа:"
curl -s -o /dev/null -w "  %{time_total} сек\n" -X POST -H "x-relay-key: $KEY" -H 'content-type: application/json' -d '{}' "$URL/bot$BOT_TOKEN/getMe"
FIRST_ROOT=${TG_API_ROOT%%,*}; FIRST_KEY=${TG_RELAY_KEY%%,*}
sed -i '/^TG_API_ROOT=/d;/^TG_RELAY_KEY=/d' "$ENVF"
echo "TG_API_ROOT=$FIRST_ROOT,$URL" >> "$ENVF"
echo "TG_RELAY_KEY=$FIRST_KEY,$KEY" >> "$ENVF"
systemctl restart di-sign-bot; sleep 2
systemctl is-active di-sign-bot
echo "✓ второй мост подключён"
