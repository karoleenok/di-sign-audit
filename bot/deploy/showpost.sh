#!/usr/bin/env bash
# Показать кнопки постов, в тексте которых есть слово (по умолчанию «плюшка»).
set -euo pipefail
ENVF=/etc/di-sign-bot.env
set -a; . "$ENVF"; set +a
cd /opt/di-sign-bot/bot
runuser -u bot -- env DB_FILE="$DB_FILE" Q="${1:-плюшка}" node --no-warnings --input-type=module -e '
import { nodeSqliteAdapter } from "./src/db-node.js";
const db = await nodeSqliteAdapter(process.env.DB_FILE);
const rows = await db.all("SELECT id, kind, status, title, substr(text,1,30) AS t, buttons, media FROM posts WHERE text LIKE ? OR title LIKE ?", ["%" + process.env.Q + "%", "%" + process.env.Q + "%"]);
for (const r of rows) console.log(r.id, r.kind, r.status, JSON.stringify(r.t), "btn=" + (r.buttons || "[]").slice(0, 300));
if (!rows.length) console.log("постов не нашла");
'
