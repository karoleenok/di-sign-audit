#!/usr/bin/env bash
# Перенос данных со старого бота (Cloudflare) на этот сервер + переключение Telegram.
# Запуск: bash /opt/di-sign-bot/bot/deploy/migrate.sh
set -euo pipefail
APP=/opt/di-sign-bot; DATA=/var/lib/di-sign-bot; ENVF=/etc/di-sign-bot.env
ask()  { local v; read -r -p "$1 " v </dev/tty || true; printf '%s' "$v"; }
asks() { local v; read -r -s -p "$1 " v </dev/tty || true; echo >&2; printf '%s' "$v"; }
[ -f "$ENVF" ] || { echo "Нет $ENVF — сначала установи бота."; exit 1; }
OLD=$(ask "Адрес старого бота на Cloudflare:")
OLDKEY=$(asks "Ключ старого бота (SETUP_KEY):")
curl -fsS -m 60 "${OLD%/}/export?key=$OLDKEY" -o /tmp/bot-backup.json || { echo "Не получилось скачать выгрузку. Проверь адрес и ключ."; exit 1; }
chmod 644 /tmp/bot-backup.json
systemctl stop di-sign-bot
[ -f "$DATA/bot.db" ] && mv "$DATA/bot.db" "$DATA/bot.db.empty-$(date +%s)"
rm -f "$DATA/bot.db-wal" "$DATA/bot.db-shm"
(cd "$APP/bot" && runuser -u bot -- env DB_FILE="$DATA/bot.db" node --no-warnings scripts/import.js /tmp/bot-backup.json)
shred -u /tmp/bot-backup.json 2>/dev/null || rm -f /tmp/bot-backup.json
systemctl start di-sign-bot
sleep 3
echo "✓ данные перенесены, бот запущен"
A=$(ask "Переключить Telegram на этот сервер? [да/нет]:")
case "$A" in да|lf|y|yes|Да|д)
  set -a; . "$ENVF"; set +a
  curl -fsS -m 30 "$PUBLIC_URL/setup?key=$SETUP_KEY" | sed 's/<[^>]*>/ /g' | tr -s ' ' | head -c 600; echo
  echo "✓ Telegram переключён. Теперь останови расписание (cron) у воркера di-sign-bot на Cloudflare.";;
  *) echo "Не переключал.";;
esac
