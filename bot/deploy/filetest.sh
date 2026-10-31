#!/usr/bin/env bash
# Проверка превью картинок: берёт фото из поста, скачивает через мосты, показывает код ответа.
set -euo pipefail
# аргумент v4 — сначала IPv4 (проверка гипотезы про зависание соединений)
OPT=''; [ "${1:-}" = v4 ] && OPT='--dns-result-order=ipv4first'
set -a; . /etc/di-sign-bot.env; set +a
cd /opt/di-sign-bot/bot
runuser -u bot -- env NODE_OPTIONS="$OPT" DB_FILE="$DB_FILE" BOT_TOKEN="$BOT_TOKEN" TG_API_ROOT="$TG_API_ROOT" TG_RELAY_KEY="$TG_RELAY_KEY" node --no-warnings --input-type=module -e '
import { nodeSqliteAdapter } from "./src/db-node.js";
import { makeTg } from "./src/tg.js";
const db = await nodeSqliteAdapter(process.env.DB_FILE);
const rows = await db.all("SELECT id, media FROM posts WHERE media LIKE ? LIMIT 5", ["%photo%"]);
let fid = null;
for (const r of rows) { try { const m = JSON.parse(r.media).find((x) => x.type === "photo"); if (m) { fid = m.file_id; console.log("пост", r.id, "file_id", fid.slice(0, 12) + "…"); break; } } catch {} }
if (!fid) { console.log("фото в постах не нашла"); process.exit(0); }
const tg = makeTg({ token: process.env.BOT_TOKEN, root: process.env.TG_API_ROOT, relayKey: process.env.TG_RELAY_KEY });
try { const f = await tg.call("getFile", { file_id: fid }); console.log("getFile ок:", f.file_path, f.file_size); }
catch (e) { console.log("getFile ошибка:", e.message, e.cause && (e.cause.code || e.cause.message)); process.exit(0); }
try { const r = await tg.download(fid); const b = await r.arrayBuffer(); console.log("скачано:", r.status, r.headers.get("content-type"), b.byteLength, "байт"); }
catch (e) { console.log("скачивание ошибка:", e.message); }
'
