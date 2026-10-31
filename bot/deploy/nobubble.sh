#!/bin/bash
# выключает пузырёк «• • •» в чате (остаётся «печатает…» в шапке) и перезапускает бота
set -e
F=/etc/di-sign-bot.env
sed -i '/^TYPING_BUBBLE=/d' "$F"
echo 'TYPING_BUBBLE=0' >> "$F"
systemctl restart di-sign-bot
sleep 2
systemctl is-active di-sign-bot
grep TYPING_BUBBLE "$F"
