#!/usr/bin/env bash
# Диагностика панели на настоящей базе: список сообщений, цепочка админ-API, ошибки.
set -uo pipefail
set -a; . /etc/di-sign-bot.env; set +a
cd /opt/di-sign-bot/bot
runuser -u bot -- env DB_FILE="$DB_FILE" BOT_TOKEN="$BOT_TOKEN" node --no-warnings --input-type=module -e '
import { nodeSqliteAdapter } from "./src/db-node.js";
import { makeCtx } from "./src/core.js";
import { listMsgs } from "./src/msgs.js";
const db = await nodeSqliteAdapter(process.env.DB_FILE);
const ctx = makeCtx({ db, env: process.env, publicUrl: "x", fetchFn: fetch });
try { const m = await listMsgs(ctx); console.log("listMsgs ок:", m.length, "сообщений; кнопок:", m.filter((x) => x.button).length); }
catch (e) { console.log("listMsgs ОШИБКА:", e.stack); }
for (const t of ["posts","settings","users"]) { try { const r = await db.first("SELECT COUNT(*) n FROM " + t); console.log(t, r.n); } catch (e) { console.log(t, "ОШИБКА", e.message); } }
const rows = await db.all("SELECT key FROM settings WHERE key LIKE ? OR key LIKE ?", ["msgx:%", "flow%"]);
console.log("msgx/flow:", rows.map((r) => r.key).join(", "));
'
journalctl -u di-sign-bot -n 40 --no-pager -o cat | grep -i -E "error|ошибк|throw|TypeError|ReferenceError" | tail -8
