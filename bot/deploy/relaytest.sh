#!/usr/bin/env bash
# Проверка мостов к Telegram: отвечает ли каждый и за сколько.
. /etc/di-sign-bot.env
i=0
IFS=',' read -ra ROOTS <<< "$TG_API_ROOT"
IFS=',' read -ra KEYS <<< "$TG_RELAY_KEY"
for r in "${ROOTS[@]}"; do
  k="${KEYS[$i]:-${KEYS[0]}}"
  echo "мост $((i+1)): $r"
  curl -m 12 -s -o /tmp/rt.out -w "  код %{http_code}, время %{time_total} c\n" -X POST -H "x-relay-key: $k" "$r/bot$BOT_TOKEN/getMe" || echo "  не ответил за 12 с"
  head -c 120 /tmp/rt.out; echo
  i=$((i+1))
done
echo "напрямую:"
curl -m 8 -s -o /dev/null -w "  код %{http_code}, время %{time_total} c\n" "https://api.telegram.org" || echo "  напрямую недоступно (это нормально)"
