#!/usr/bin/env bash
# Автообновление: раз в минуту (по таймеру systemd) смотрит, есть ли в GitHub новая версия main.
# Если есть — подтягивает, перезапускает бота и проверяет, что он поднялся. Если не поднялся — откатывает.
# Код из репозитория здесь НЕ запускается (только git и «node --check» — проверка синтаксиса).
set -uo pipefail
APP="${APP:-/opt/di-sign-bot}"
SERVICE="${SERVICE:-di-sign-bot}"
LOCK="${LOCK:-/run/di-sign-autoupdate.lock}"
BAD="${BAD:-/var/lib/di-sign-autoupdate.bad}"   # коммит, на котором бот не поднялся: второй раз его не пробуем
G=(git -c safe.directory="$APP" -C "$APP")
log() { logger -t di-sign-autoupdate "$*"; echo "$*"; }

exec 9>"$LOCK"; flock -n 9 || exit 0

"${G[@]}" fetch --quiet origin main 2>/dev/null || { exit 0; }   # GitHub недоступен — спокойно ждём следующей минуты
OLD=$("${G[@]}" rev-parse HEAD); NEW=$("${G[@]}" rev-parse origin/main)
[ "$OLD" = "$NEW" ] && exit 0
[ "$(cat "$BAD" 2>/dev/null)" = "$NEW" ] && exit 0

if ! "${G[@]}" merge --ff-only --quiet origin/main; then log "не удалось обновить (не fast-forward), оставляю $OLD"; exit 1; fi

if ! (cd "$APP/bot" && node --check src/node-server.js && node --check src/core.js); then
  log "в новой версии ошибка синтаксиса, откат на $OLD"; echo "$NEW" > "$BAD"; "${G[@]}" reset --hard --quiet "$OLD"; exit 1
fi

systemctl restart "$SERVICE"; sleep 6
if ! systemctl is-active --quiet "$SERVICE" || [ "$(systemctl show -p NRestarts --value "$SERVICE")" != "0" ]; then
  log "бот не поднялся на $NEW, откат на $OLD"
  echo "$NEW" > "$BAD"; "${G[@]}" reset --hard --quiet "$OLD"; systemctl restart "$SERVICE"; exit 1
fi
log "обновлено: ${OLD:0:7} → ${NEW:0:7}"
