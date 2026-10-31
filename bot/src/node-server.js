// Вход для обычного сервера (например, российский VPS или Amvera).
// Запуск: node node-server.js   (нужен Node.js 22+)
// Настройки — переменные окружения, те же, что в Cloudflare, плюс:
//   DB_FILE   — путь к файлу базы (по умолчанию ./data/bot.db)
//   PORT      — порт (по умолчанию 8080)
//   PUBLIC_URL — внешний адрес сервера (для кнопок и вебхука)
//   MODE      — webhook (по умолчанию) или polling (если Telegram не достучится до сервера)
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { nodeSqliteAdapter } from './db-node.js';
import { migrate } from './schema.js';
import { makeCtx, handleUpdate, tick, setup, clickRedirect, exportAll } from './core.js';
import { handlePanelApi } from './panel-api.js';
import { stepRuns } from './testrun.js';
import PANEL from './panel-html.js';

const env = process.env;
const file = env.DB_FILE || './data/bot.db';
fs.mkdirSync(path.dirname(file), { recursive: true });
const db = await nodeSqliteAdapter(file);
await migrate(db);
const ctxFor = () => makeCtx({ db, env, publicUrl: env.PUBLIC_URL });
const polling = (env.MODE || 'webhook') === 'polling';

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, env.PUBLIC_URL || 'http://localhost');
  const send = (code, body, type = 'text/html; charset=utf-8', headers = {}) => { res.writeHead(code, { 'content-type': type, ...headers }); res.end(body); };
  try {
    // панель админа (кнопка в боте) и её API
    if (url.pathname === '/admin' || url.pathname === '/admin/') return send(200, PANEL, 'text/html; charset=utf-8', { 'cache-control': 'no-store' });
    if (url.pathname.startsWith('/api/panel/')) {
      const chunks = []; for await (const ch of req) chunks.push(ch);
      const body = Buffer.concat(chunks);
      const hdr = new Headers(); for (const [k, v] of Object.entries(req.headers)) if (typeof v === 'string') hdr.set(k, v);
      const request = new Request(url, { method: req.method, headers: hdr, body: ['GET', 'HEAD'].includes(req.method) ? undefined : body });
      const ctx = ctxFor(); ctx.waitUntil = (p) => { Promise.resolve(p).catch((e) => console.error(e)); };
      const r = await handlePanelApi(ctx, request, url);
      const out = Buffer.from(await r.arrayBuffer());
      res.writeHead(r.status, Object.fromEntries(r.headers)); return res.end(out);
    }
    // страница аудит-теста: берём файл с GitHub и отдаём как обычную страницу
    if (url.pathname === '/test' || url.pathname === '/test/') {
      const src = env.TEST_SRC || 'https://raw.githubusercontent.com/karoleenok/di-sign-audit/main/index.html';
      const r = await fetch(src);
      return send(r.ok ? 200 : 502, await r.text());
    }
    if (url.pathname === '/tg' && req.method === 'POST') {
      if (env.WEBHOOK_SECRET && req.headers['x-telegram-bot-api-secret-token'] !== env.WEBHOOK_SECRET) return send(403, 'forbidden');
      let body = ''; for await (const ch of req) body += ch;
      try { await handleUpdate(ctxFor(), JSON.parse(body)); } catch (e) { console.error(e); }
      return send(200, 'ok');
    }
    if (url.pathname === '/setup') {
      if (!env.SETUP_KEY || url.searchParams.get('key') !== env.SETUP_KEY) return send(403, 'Нужен ключ');
      const out = await setup(ctxFor(), { webhookUrl: (env.PUBLIC_URL || '') + '/tg', polling });
      return send(200, '<meta charset=utf-8><h2>Готово</h2><ul>' + out.map((x) => `<li>${x}</li>`).join('') + '</ul>');
    }
    if (url.pathname === '/export') {
      if (!env.SETUP_KEY || url.searchParams.get('key') !== env.SETUP_KEY) return send(403, 'Нужен ключ');
      return send(200, JSON.stringify(await exportAll(db)), 'application/json', { 'content-disposition': 'attachment; filename="bot-backup.json"' });
    }
    const r = /^\/r\/(\d+)\/(\d+-\d+)\/(\d+)$/.exec(url.pathname);
    if (r) { const to = await clickRedirect(ctxFor(), +r[1], r[2], r[3]); return to ? send(302, '', 'text/plain', { location: to }) : send(404, 'not found'); }
    return send(200, 'Di Sign University bot');
  } catch (e) { console.error(e); return send(500, 'error'); }
});
server.listen(Number(env.PORT) || 8080, () => console.log('bot listening', Number(env.PORT) || 8080, polling ? '(polling)' : '(webhook)'));

// расписание раз в минуту
setInterval(async () => {
  try { await tick(ctxFor(), Number(env.TICK_BUDGET) || 600); await stepRuns(ctxFor(), 10); } catch (e) { console.error('tick', e); }
}, 60_000);

// режим без вебхука: сами забираем сообщения у Telegram (через мост, если нужен)
if (polling) {
  (async () => {
    const offRow = await db.first(`SELECT value FROM settings WHERE key = 'poll_offset'`);
    let offset = offRow ? +offRow.value : 0;
    for (;;) {
      try {
        const ctx = ctxFor();
        const ups = await ctx.tg.call('getUpdates', { offset, timeout: 25, allowed_updates: ['message', 'callback_query', 'my_chat_member'] });
        for (const u of ups) {
          offset = u.update_id + 1;
          try { await handleUpdate(ctxFor(), u); } catch (e) { console.error(e); }
          await db.run(`INSERT INTO settings (key, value) VALUES ('poll_offset', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`, [String(offset)]);
        }
      } catch (e) { console.error('poll', e.message); await new Promise((r) => setTimeout(r, 5000)); }
    }
  })();
}
