#!/usr/bin/env bash
# Установка бота Di Sign University на обычный сервер (Ubuntu 24.04), от имени root.
# Запуск (одной строкой в консоли сервера):
#   curl -fsSL https://raw.githubusercontent.com/karoleenok/di-sign-audit/main/bot/deploy/install.sh | bash
# Секреты (токен бота, ключи) вводятся прямо здесь, в консоли, и лежат только на этом сервере.
set -euo pipefail

REPO="https://github.com/karoleenok/di-sign-audit"
APP=/opt/di-sign-bot
DATA=/var/lib/di-sign-bot
ENVF=/etc/di-sign-bot.env

say()  { printf '\n\033[1m▶ %s\033[0m\n' "$*"; }
ok()   { printf '  \033[32m✓\033[0m %s\n' "$*"; }
warn() { printf '  \033[33m!\033[0m %s\n' "$*"; }
die()  { printf '\n\033[31m✗ %s\033[0m\n' "$*"; exit 1; }
ask()  { local v; read -r -p "$1 " v </dev/tty || true; printf '%s' "$v"; }
asks() { local v; read -r -s -p "$1 " v </dev/tty || true; echo >&2; printf '%s' "$v"; }

[ "$(id -u)" = 0 ] || die "Запусти от root (в консоли сервера ты и так root)."
grep -qi ubuntu /etc/os-release || warn "Это не Ubuntu — скрипт рассчитан на Ubuntu 24.04, продолжаю на свой страх."

say "1/9  Системные пакеты"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq curl git ca-certificates xz-utils ufw caddy openssl >/dev/null
ok "пакеты установлены"

say "2/9  Node.js 22"
NEED=1
if command -v node >/dev/null 2>&1; then [ "$(node -p 'process.versions.node.split(".")[0]')" -ge 22 ] && NEED=0; fi
if [ "$NEED" = 1 ]; then
  F=$(curl -fsSL https://nodejs.org/dist/latest-v22.x/SHASUMS256.txt | awk '/linux-x64\.tar\.xz/{print $2}')
  [ -n "$F" ] || die "Не получилось узнать версию Node.js (nodejs.org недоступен?)."
  curl -fsSL "https://nodejs.org/dist/latest-v22.x/$F" -o /tmp/node.tar.xz
  tar -xJf /tmp/node.tar.xz -C /usr/local --strip-components=1
  rm -f /tmp/node.tar.xz
fi
ok "Node $(node -v)"

say "3/9  Код бота"
if [ -d "$APP/.git" ]; then git -C "$APP" pull -q --ff-only; else git clone -q --depth 1 "$REPO" "$APP"; fi
id bot >/dev/null 2>&1 || useradd -r -m -d "$DATA" -s /usr/sbin/nologin bot
mkdir -p "$DATA"; chown -R bot:bot "$DATA"
ok "код в $APP, база будет в $DATA"

say "4/9  Связь с Telegram"
CODE=$(curl -s -m 12 -o /dev/null -w '%{http_code}' https://api.telegram.org || true)
MODE=webhook; TG_API_ROOT=""; TG_RELAY_KEY=""
if [ "$CODE" = "000" ] || [ -z "$CODE" ]; then
  warn "Telegram с этого сервера не отвечает (так бывает у российских серверов). Нужен «мост»."
  TG_API_ROOT=$(ask "Адрес моста (например https://tg-relay.твой-аккаунт.workers.dev):")
  TG_RELAY_KEY=$(asks "Ключ моста (RELAY_KEY):")
  [ -n "$TG_API_ROOT" ] || die "Без моста бот не достучится до Telegram. Подготовим мост и запустим скрипт заново."
  MODE=polling
else
  ok "Telegram отвечает напрямую"
fi

say "5/9  Секреты и адрес"
if [ -f "$ENVF" ]; then
  warn "Настройки уже есть ($ENVF) — использую их."
  set -a; . "$ENVF"; set +a
else
  BOT_TOKEN=$(asks "Токен бота (из BotFather, не отображается при вводе):")
  [ -n "$BOT_TOKEN" ] || die "Токен нужен."
  ADMIN_IDS=$(ask "Твой Telegram id (и других админов через пробел):")
  ADMIN_IDS=$(printf '%s' "$ADMIN_IDS" | grep -oE '[0-9]+' | tr '\n' ' ' | sed 's/ *$//')
  [ -n "$ADMIN_IDS" ] || die "Нужен хотя бы один числовой id."
  SETUP_KEY=$(openssl rand -hex 16); WEBHOOK_SECRET=$(openssl rand -hex 16)
  IP=$(curl -4 -s -m 8 https://ifconfig.me || hostname -I | awk '{print $1}')
  DOM=$(ask "Свой домен (если нет — просто Enter, возьмём бесплатный адрес):")
  [ -n "$DOM" ] || DOM="$(printf '%s' "$IP" | tr . -).sslip.io"
  PUBLIC_URL="https://$DOM"
  umask 077
  cat > "$ENVF" <<EOT
BOT_TOKEN=$BOT_TOKEN
ADMIN_IDS="$ADMIN_IDS"
SETUP_KEY=$SETUP_KEY
WEBHOOK_SECRET=$WEBHOOK_SECRET
PUBLIC_URL=$PUBLIC_URL
MODE=$MODE
TG_API_ROOT=$TG_API_ROOT
TG_RELAY_KEY=$TG_RELAY_KEY
DB_FILE=$DATA/bot.db
PORT=8080
HOST_NAME=russia-vps
TEST_URL=$PUBLIC_URL/test
EOT
  chmod 600 "$ENVF"
fi
DOM=${PUBLIC_URL#https://}
ok "адрес бота: $PUBLIC_URL"

say "6/9  Перенос данных со старого бота (по желанию)"
if [ -f "$DATA/bot.db" ]; then
  ok "база уже есть, ничего не переношу"
else
  OLD=$(ask "Адрес старого бота на Cloudflare (Enter — пропустить):")
  if [ -n "$OLD" ]; then
    OLDKEY=$(asks "Ключ старого бота (SETUP_KEY):")
    curl -fsS -m 60 "${OLD%/}/export?key=$OLDKEY" -o /tmp/bot-backup.json || die "Не получилось скачать выгрузку. Проверь адрес и ключ."
    chmod 644 /tmp/bot-backup.json
    (cd "$APP/bot" && runuser -u bot -- env DB_FILE="$DATA/bot.db" node --no-warnings scripts/import.js /tmp/bot-backup.json)
    shred -u /tmp/bot-backup.json 2>/dev/null || rm -f /tmp/bot-backup.json
    ok "данные перенесены, временный файл удалён"
  else
    warn "перенос пропущен — база будет пустой"
  fi
fi

say "7/9  Служба бота"
cat > /etc/systemd/system/di-sign-bot.service <<EOT
[Unit]
Description=Di Sign University bot
After=network-online.target
Wants=network-online.target

[Service]
User=bot
WorkingDirectory=$APP/bot
EnvironmentFile=$ENVF
ExecStart=/usr/local/bin/node --no-warnings src/node-server.js
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
EOT
systemctl daemon-reload
systemctl enable --now di-sign-bot >/dev/null 2>&1
systemctl restart di-sign-bot
sleep 3
curl -fsS -m 5 http://127.0.0.1:8080/ >/dev/null && ok "бот запущен" || { journalctl -u di-sign-bot -n 20 --no-pager; die "Бот не запустился (лог выше)."; }

say "8/9  HTTPS-адрес и защита"
cat > /etc/caddy/Caddyfile <<EOT
$DOM {
  reverse_proxy 127.0.0.1:8080
}
EOT
systemctl enable --now caddy >/dev/null 2>&1
systemctl reload caddy 2>/dev/null || systemctl restart caddy
ufw allow OpenSSH >/dev/null; ufw allow 80/tcp >/dev/null; ufw allow 443/tcp >/dev/null
ufw --force enable >/dev/null
for i in $(seq 1 30); do
  curl -fsS -m 5 "$PUBLIC_URL/" >/dev/null 2>&1 && break
  sleep 3
done
curl -fsS -m 5 "$PUBLIC_URL/" >/dev/null 2>&1 && ok "$PUBLIC_URL открывается с сертификатом" || warn "адрес пока не открылся (сертификат ещё выпускается) — подожди минуту и открой его в браузере"

say "9/9  Переключить Telegram на этот сервер?"
echo "  После «да» все новые сообщения от людей пойдут сюда, а не на Cloudflare."
echo "  Сразу после этого остановите расписание (cron) на Cloudflare, иначе посты уйдут дважды."
A=$(ask "Переключить сейчас? [да/нет]:")
if [ "$A" = "да" ] || [ "$A" = "y" ] || [ "$A" = "yes" ]; then
  set -a; . "$ENVF"; set +a
  curl -fsS -m 30 "$PUBLIC_URL/setup?key=$SETUP_KEY" | sed 's/<[^>]*>/ /g' | tr -s ' ' | head -c 600; echo
  ok "Telegram переключён"
else
  warn "Не переключал. Когда будешь готова: открой в браузере $PUBLIC_URL/setup?key=<SETUP_KEY из $ENVF>"
fi

set -a; . "$ENVF"; set +a
cat <<EOT

════════════════════════════════════════════
Готово.
  Адрес бота:   $PUBLIC_URL
  Панель:       $PUBLIC_URL/admin  (открывается кнопкой из бота)
  Проверка:     напиши боту /check
  Ключ SETUP_KEY (сохрани у себя, он нужен для /setup и /export):
  $SETUP_KEY
  Настройки лежат в $ENVF (читать может только root).
  Обновить бота потом:  bash $APP/bot/deploy/update.sh
════════════════════════════════════════════
EOT
