#!/usr/bin/env bash
# Переключить Telegram на этот сервер (перерегистрировать webhook).
set -euo pipefail
ENVF=/etc/di-sign-bot.env
set -a; . "$ENVF"; set +a
curl -fsS -m 30 "$PUBLIC_URL/setup?key=$SETUP_KEY" | sed 's/<[^>]*>/ /g' | tr -s ' ' | head -c 800; echo
echo "✓ готово. Теперь останови расписание (cron) у воркера di-sign-bot на Cloudflare."
