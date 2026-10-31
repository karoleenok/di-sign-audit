#!/usr/bin/env bash
# Показать, что сейчас записано в тексте шага «согласие на данные».
set -euo pipefail
ENVF=/etc/di-sign-bot.env
set -a; . "$ENVF"; set +a
cd /opt/di-sign-bot/bot
runuser -u bot -- env DB_FILE="$DB_FILE" node --no-warnings --input-type=module -e '
import { nodeSqliteAdapter } from "./src/db-node.js";
const db = await nodeSqliteAdapter(process.env.DB_FILE);
const rows = await db.all("SELECT key, value FROM settings WHERE key IN (?, ?, ?)", ["msg:consentPd", "msgx:consentPd", "doc:policy"]);
for (const r of rows) console.log(r.key, "=>", r.value.slice(0, 700));
if (!rows.length) console.log("своих правок нет");
'
