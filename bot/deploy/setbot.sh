#!/usr/bin/env bash
# Заменить токен бота (BOT_TOKEN) на этом сервере, проверить его через мост и перезапустить бота.
set -uo pipefail
ENVF=/etc/di-sign-bot.env
[ -f "$ENVF" ] || { echo "Нет $ENVF"; exit 1; }
grep -q '^ADMIN_IDS="' "$ENVF" || sed -i 's/^ADMIN_IDS=\(.*\)$/ADMIN_IDS="\1"/' "$ENVF"
set -a; . "$ENVF"; set +a
read -r -p "Токен бота из BotFather (вводится на виду, чтобы проверить глазами): " T </dev/tty
T=$(printf '%s' "$T" | tr -d ' \r\n')
case "$T" in [0-9]*:*) ;; *) echo "Токен выглядит неправильно (должен быть вида 123456789:AAA...). Запусти заново."; exit 1;; esac
ROOT=${TG_API_ROOT:-https://api.telegram.org}
echo "Проверяю токен через ${ROOT} ..."
OK=0
for i in 1 2 3 4 5; do
  R=$(curl -sS -m 25 -X POST ${TG_RELAY_KEY:+-H "x-relay-key: $TG_RELAY_KEY"} -H 'content-type: application/json' -d '{}' "${ROOT%/}/bot$T/getMe" 2>&1)
  if echo "$R" | grep -q '"ok":true'; then OK=1; echo "✓ токен рабочий: $(echo "$R" | grep -o '"username":"[^"]*"')"; break; fi
  echo "попытка $i: $(echo "$R" | head -c 160)"
  if echo "$R" | grep -q 'Unauthorized'; then echo "✗ Telegram говорит: токен неверный. Скопируй его из BotFather заново."; exit 1; fi
  sleep 3
done
[ "$OK" = 1 ] || { echo "✗ Не достучались до Telegram через мост. Токен не меняю."; exit 1; }
grep -v '^BOT_TOKEN=' "$ENVF" > "$ENVF.new"; echo "BOT_TOKEN=$T" >> "$ENVF.new"
chmod 600 "$ENVF.new"; mv "$ENVF.new" "$ENVF"
systemctl restart di-sign-bot; sleep 3
echo "✓ токен сохранён, бот перезапущен"
