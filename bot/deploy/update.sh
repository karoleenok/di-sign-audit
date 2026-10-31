#!/usr/bin/env bash
# Обновить бота до свежей версии из GitHub и перезапустить.
set -euo pipefail
git -C /opt/di-sign-bot pull --ff-only
systemctl restart di-sign-bot
sleep 2
systemctl is-active di-sign-bot
