#!/usr/bin/env bash
# Автообновление: раз в несколько минут (systemd-таймер) проверяем GitHub.
# Есть новая версия -> подтягиваем, проверяем синтаксис, перезапускаем бота.
# Если бот после перезапуска не поднялся -> откатываемся на прошлую версию.
set -uo pipefail
cd /opt/di-sign-bot || exit 1
git fetch -q origin main || exit 0
OLD=$(git rev-parse HEAD)
NEW=$(git rev-parse origin/main)
[ "$OLD" = "$NEW" ] && exit 0
git merge -q --ff-only origin/main || { echo "автообновление: не fast-forward, пропускаю"; exit 0; }
for f in bot/src/*.js; do
  node --check "$f" || { echo "автообновление: ошибка в $f, откат"; git reset -q --hard "$OLD"; exit 1; }
done
systemctl restart di-sign-bot
sleep 5
if systemctl is-active --quiet di-sign-bot; then
  echo "автообновление: $OLD -> $NEW, бот работает"
else
  echo "автообновление: бот не поднялся на $NEW, откат на $OLD"
  git reset -q --hard "$OLD"
  systemctl restart di-sign-bot
fi
