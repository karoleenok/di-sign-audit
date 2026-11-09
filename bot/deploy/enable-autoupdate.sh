#!/usr/bin/env bash
# Включает автообновление (можно запускать сколько угодно раз). Делает root на сервере.
set -euo pipefail
APP=/opt/di-sign-bot
cat > /etc/systemd/system/di-sign-autoupdate.service <<EOT
[Unit]
Description=Di Sign bot: подтянуть новую версию из GitHub
After=network-online.target

[Service]
Type=oneshot
ExecStart=/usr/bin/env bash $APP/bot/deploy/autoupdate.sh
EOT
cat > /etc/systemd/system/di-sign-autoupdate.timer <<EOT
[Unit]
Description=Di Sign bot: проверка обновлений раз в минуту

[Timer]
OnBootSec=1min
OnUnitActiveSec=1min
AccuracySec=10s

[Install]
WantedBy=timers.target
EOT
systemctl daemon-reload
systemctl enable --now di-sign-autoupdate.timer
echo "Автообновление включено. Журнал: journalctl -t di-sign-autoupdate"
