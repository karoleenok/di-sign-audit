#!/usr/bin/env bash
# Забрать токен бота со старого воркера Cloudflare (без ручного ввода), проверить и сохранить.
set -uo pipefail
ENVF=/etc/di-sign-bot.env
grep -q '^ADMIN_IDS="' "$ENVF" || sed -i 's/^ADMIN_IDS=\(.*\)$/ADMIN_IDS="\1"/' "$ENVF"
set -a; . "$ENVF"; set +a
OLD=https://di-sign-bot.karolinabelikova90.workers.dev
read -r -s -p "Ключ старого бота (SETUP_KEY, символы не видны): " K </dev/tty; echo
T=$(curl -fsS -m 30 "$OLD/pulltoken?key=$K") || { echo "✗ не получилось забрать токен (ключ неверный или воркер не обновлён)"; exit 1; }
T=$(printf '%s' "$T" | tr -d ' \r\n')
case "$T" in [0-9]*:*) ;; *) echo "✗ пришло не похоже на токен"; exit 1;; esac
ROOT=${TG_API_ROOT:-https://api.telegram.org}
OK=0
for i in 1 2 3 4 5; do
  R=$(curl -sS -m 25 -X POST ${TG_RELAY_KEY:+-H "x-relay-key: $TG_RELAY_KEY"} -H 'content-type: application/json' -d '{}' "${ROOT%/}/bot$T/getMe" 2>&1)
  if echo "$R" | grep -q '"ok":true'; then OK=1; echo "✓ токен рабочий: $(echo "$R" | grep -o '"username":"[^"]*"')"; break; fi
  echo "попытка $i: $(echo "$R" | head -c 120)"; sleep 3
done
[ "$OK" = 1 ] || { echo "✗ проверка не прошла, токен не меняю"; exit 1; }
grep -v '^BOT_TOKEN=' "$ENVF" > "$ENVF.new"; echo "BOT_TOKEN=$T" >> "$ENVF.new"
chmod 600 "$ENVF.new"; mv "$ENVF.new" "$ENVF"
systemctl restart di-sign-bot; sleep 3
echo "✓ токен сохранён, бот перезапущен"
