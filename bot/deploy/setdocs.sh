#!/usr/bin/env bash
# Вписать ссылки на политику и согласие и данные владельца в настройки бота.
set -euo pipefail
ENVF=/etc/di-sign-bot.env
grep -q '^ADMIN_IDS="' "$ENVF" || sed -i 's/^ADMIN_IDS=\(.*\)$/ADMIN_IDS="\1"/' "$ENVF"
set -a; . "$ENVF"; set +a
cd /opt/di-sign-bot/bot
runuser -u bot -- env DB_FILE="$DB_FILE" PUB="$PUBLIC_URL" node --no-warnings --input-type=module -e '
import { nodeSqliteAdapter } from "./src/db-node.js";
const db = await nodeSqliteAdapter(process.env.DB_FILE);
const set = (k, v) => db.run("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", [k, v]);
await set("doc:policy", process.env.PUB + "/policy");
await set("doc:consent", process.env.PUB + "/consent");
await set("doc:owner", "Дупина Диана Николаевна, самозанятая, ИНН 271705350550, diana.dupina@mail.ru");
const rows = await db.all("SELECT key, value FROM settings WHERE key LIKE \"doc:%\"");
for (const r of rows) console.log(r.key, "=", r.value);
'
echo "✓ ссылки на документы и данные владельца записаны"
