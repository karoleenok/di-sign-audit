#!/usr/bin/env bash
# Переключить Telegram на этот сервер (перерегистрировать webhook).
set -euo pipefail
ENVF=/etc/di-sign-bot.env
# ADMIN_IDS с пробелами должен быть в кавычках (иначе файл нельзя прочитать оболочкой)
grep -q '^ADMIN_IDS="' "$ENVF" || sed -i 's/^ADMIN_IDS=\(.*\)$/ADMIN_IDS="\1"/' "$ENVF"
set -a; . "$ENVF"; set +a
curl -fsS -m 30 "$PUBLIC_URL/setup?key=$SETUP_KEY" | sed 's/<[^>]*>/ /g' | tr -s ' ' | head -c 800; echo
echo "✓ готово. Теперь останови расписание (cron) у воркера di-sign-bot на Cloudflare."
