#!/bin/bash
# Сценарий через настоящий Cloudflare-рантайм (wrangler dev) и фейковый Telegram
U=http://127.0.0.1:8787
i=1
post() { curl -s -X POST $U/tg -H 'content-type: application/json' -H 'x-telegram-bot-api-secret-token: s1' -d "$1" >/dev/null; i=$((i+1)); }
msg() { post "{\"update_id\":$i,\"message\":{\"message_id\":$i,\"from\":{\"id\":$1,\"first_name\":\"U$1\"},\"chat\":{\"id\":$1,\"type\":\"private\"},\"text\":\"$2\"$3}}"; }
cb() { post "{\"update_id\":$i,\"callback_query\":{\"id\":\"q$i\",\"from\":{\"id\":$1},\"data\":\"$2\",\"message\":{\"message_id\":1,\"chat\":{\"id\":$1}}}}"; }
# неправильный секрет — отказ
code=$(curl -s -o /dev/null -w '%{http_code}' -X POST $U/tg -H 'x-telegram-bot-api-secret-token: bad' -d '{}'); echo "чужой запрос: $code"
msg 100 "/new"
msg 100 "Привет! День 0 ✨" ',"entities":[{"type":"custom_emoji","offset":15,"length":1,"custom_emoji_id":"5368324170671202286"}]'
cb 100 "w:done"; cb 100 "w:kind:drip"; msg 100 "0"; cb 100 "w:aud:all"; cb 100 "w:zn:*"
msg 100 "Сайт | https://disign.ru"
cb 100 "w:save:1"
msg 200 "/start audit_P_start"; cb 200 "c:pd"; cb 200 "c:ads:1"
curl -s "$U/__scheduled?cron=*+*+*+*+*" >/dev/null
sleep 1
msg 100 "/stats"; msg 100 "/check"
curl -s "$U/export?key=k1" | head -c 300; echo
