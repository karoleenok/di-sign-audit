// Локальная панель для проверки: база в памяти с примерами постов, фейковый Telegram.
// node test/panel-server.mjs  -> http://localhost:8788/admin  (initData подписывается тестовым токеном)
import http from 'node:http';
import { createHmac } from 'node:crypto';
import { nodeSqliteAdapter } from '../src/db-node.js';
import { migrate } from '../src/schema.js';
import { makeCtx } from '../src/core.js';
import { handlePanelApi } from '../src/panel-api.js';
import PANEL from '../src/panel-html.js';

const TOKEN = '1:test';
export const sent = [];
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
const fakeFetch = async (url, init = {}) => {
  if (url.includes('/file/bot')) return new Response(PNG, { headers: { 'content-type': 'image/png' } });
  const method = url.split('/').pop();
  if (init.body instanceof FormData) {
    const f = init.body.get('photo') || init.body.get('video') || init.body.get('animation');
    sent.push({ method, body: { chat_id: +init.body.get('chat_id'), file: f && f.name, size: f && f.size } });
    return { json: async () => ({ ok: true, result: { message_id: 77, photo: [{ file_id: 'small' }, { file_id: 'UPLOADED' }] } }) };
  }
  const body = JSON.parse(init.body || '{}');
  sent.push({ method, body });
  if (method === 'getFile') return { json: async () => ({ ok: true, result: { file_path: 'photos/x.png' } }) };
  return { json: async () => ({ ok: true, result: { message_id: 1 } }) };
};
const db = await nodeSqliteAdapter(':memory:');
await migrate(db);
const now = () => Math.floor(Date.now() / 1000);
const P = (o) => db.run(`INSERT INTO posts (title, kind, audience, zone, day, send_time, run_at, status, text, entities, media, buttons, created_at, pos) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  [o.title || null, o.kind, o.aud || 'all', o.zone || null, o.day ?? null, o.time || '11:00', o.run || null, o.st || 'active', o.text, o.ents || '[]', o.media || '[]', o.btns || null, now(), o.pos || 0]);
await P({ kind: 'gift', zone: 'P', text: 'Твой подарок 🎁 Шаблон кейса в Figma', media: '[{"type":"photo","file_id":"a"}]', btns: '[[{"text":"Открыть шаблон","url":"https://figma.com"}]]' });
await P({ kind: 'gift', zone: 'B', text: 'Чек-лист «10 ошибок новичка»' });
await P({ kind: 'drip', day: 0, text: 'Добро пожаловать! Вот как устроена неделя материалов' });
await P({ kind: 'drip', day: 1, time: '11:00', aud: 'start', title: 'Чек-лист новичка', text: 'Чек-лист «10 ошибок новичка» 📋\nПроверяй по нему каждую работу', btns: '[[{"text":"Открыть","url":"https://x.ru"}]]' });
await P({ kind: 'drip', day: 1, time: '11:00', aud: 'pro', title: 'Скрипты ответов', text: 'Скрипты ответов клиенту' });
await P({ kind: 'drip', day: 2, time: '11:00', text: '20 промптов для рабочих задач', ents: '[{"type":"custom_emoji","offset":0,"length":2,"custom_emoji_id":"5"}]' });
await P({ kind: 'drip', day: 2, time: '19:00', zone: 'P', title: 'Про обучение · портфолио', text: 'Почему красивые картинки не продают? Клиент смотрит портфолио 30 секунд…', media: '[{"type":"photo","file_id":"a"},{"type":"photo","file_id":"b"},{"type":"photo","file_id":"c"}]' });
await P({ kind: 'drip', day: 3, time: '11:00', st: 'paused', text: 'Контент-план для дизайнера на месяц' });
await P({ kind: 'drip', day: 4, time: '19:00', st: 'draft', text: 'История ученицы: было / стало' });
await db.run(`INSERT INTO posts (title, kind, audience, mode, delay_min, day, send_time, status, text, created_at) VALUES ('Через 2 часа', 'drip', 'all', 'timer', 120, 0, '11:00', 'active', 'Как пользоваться материалами', ${now()})`);
await P({ kind: 'date', run: now() + 5 * 86400, title: 'Эфир: разбор работ', text: 'В четверг в 19:00 разбираем работы в прямом эфире' });
await db.run(`INSERT INTO users (tg_id, first_name, status, level, zone, consent_ads_at, joined_at, created_at) VALUES (1,'A','active','start','P',1,1,1),(2,'B','active','pro','B',1,1,1),(3,'C','stopped','start',NULL,NULL,NULL,1)`);
await db.run(`INSERT INTO deliveries (post_id, tg_id, sent_at) VALUES (4,1,1),(3,1,1),(3,2,1)`);
await db.run(`INSERT INTO clicks (post_id, tg_id, btn, at) VALUES (4,1,'Открыть',1)`);

export function initData(user = { id: 100, first_name: 'Каролина' }, token = TOKEN) {
  const p = new URLSearchParams({ auth_date: String(now()), query_id: 'AAA', user: JSON.stringify(user) });
  const dcs = [...p.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, v]) => `${k}=${v}`).join('\n');
  const secret = createHmac('sha256', 'WebAppData').update(token).digest();
  p.set('hash', createHmac('sha256', secret).update(dcs).digest('hex'));
  return p.toString();
}
const env = { BOT_TOKEN: TOKEN, ADMIN_IDS: '100', DELAY_FACTOR: '0' };
export const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost:8788');
  if (url.pathname === '/admin') { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); return res.end(PANEL); }
  if (url.pathname.startsWith('/api/panel/')) {
    const chunks = []; for await (const c of req) chunks.push(c); const body = Buffer.concat(chunks);
    const request = new Request(url, { method: req.method, headers: req.headers, body: req.method === 'POST' ? body : undefined, duplex: 'half' });
    const r = await handlePanelApi(makeCtx({ db, env, fetchFn: fakeFetch, publicUrl: 'http://localhost:8788' }), request, url);
    res.writeHead(r.status, { 'content-type': r.headers.get('content-type') || 'application/json' }); return res.end(Buffer.from(await r.arrayBuffer()));
  }
  res.writeHead(404); res.end();
});
export { db };
if (process.argv[1] && process.argv[1].endsWith('panel-server.mjs')) server.listen(8788, () => console.log('http://localhost:8788/admin'));
