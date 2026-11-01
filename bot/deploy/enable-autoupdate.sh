#!/usr/bin/env bash
# Включить автообновление бота с GitHub (раз в 3 минуты). Запустить один раз.
set -euo pipefail
cat > /etc/systemd/system/di-sign-autoupdate.service <<'UNIT'
[Unit]
Description=Di Sign bot autoupdate from GitHub
[Service]
Type=oneshot
ExecStart=/usr/bin/env bash /opt/di-sign-bot/bot/deploy/autoupdate.sh
UNIT
cat > /etc/systemd/system/di-sign-autoupdate.timer <<'UNIT'
[Unit]
Description=Di Sign bot autoupdate every 3 minutes
[Timer]
OnBootSec=2min
OnUnitActiveSec=3min
[Install]
WantedBy=timers.target
UNIT
systemctl daemon-reload
systemctl enable --now di-sign-autoupdate.timer
systemctl is-active di-sign-autoupdate.timer
echo "автообновление включено"
