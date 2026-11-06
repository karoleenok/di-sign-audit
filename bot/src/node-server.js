// Вход для обычного сервера (например, российский VPS или Amvera).
// Запуск: node node-server.js   (нужен Node.js 22+)
// Настройки — переменные окружения, те же, что в Cloudflare, плюс:
//   DB_FILE   — путь к файлу базы (по умолчанию ./data/bot.db)
//   PORT      — порт (по умолчанию 8080)
//   PUBLIC_URL — внешний адрес сервера (для кнопок и вебхука)
//   MODE      — webhook (по умолчанию) или polling (если Telegram не достучится до сервера)
import http from 'node:http';
import { checkInitData as __checkInit } from './panel-api.js';
import { isAdmin as __isAdmin } from './admin.js';
import { loadCfg as __loadCfg, saveCfg as __saveCfg, viewFor as __viewFor } from './appcfg.js';
import __GATE from './workshop-gate.js';
import net from 'node:net';
import dns from 'node:dns';
// На этом сервере node 22 при «автоподборе IPv4/IPv6» зависал на 10 секунд при подключении к Cloudflare-мосту
// (curl и node без автоподбора отвечают за 0,3 с). Выключаем автоподбор и берём IPv4 первым — бот отвечает быстро.
net.setDefaultAutoSelectFamily(false);
dns.setDefaultResultOrder('ipv4first');
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import { nodeSqliteAdapter } from './db-node.js';
import { migrate } from './schema.js';
import { makeCtx, handleUpdate, tick, setup, syncMenu, clickRedirect, exportAll } from './core.js';
import { handlePanelApi, panelAdmin } from './panel-api.js';
import { stepRuns } from './testrun.js';
import { backupTick, makeBackup } from './backup.js';
import { archiveOldDates } from './posts.js';
import PANEL, { BUILD } from './panel-html.js';
import { filePage, mimeOf, kindOf } from './filepage.js';

const env = process.env;
const file = env.DB_FILE || './data/bot.db';
fs.mkdirSync(path.dirname(file), { recursive: true });
const db = await nodeSqliteAdapter(file);
await migrate(db);
// запросы к Telegram через мост иногда зависают — режем по времени и повторяем
async function tgFetch(url, opts) {
  const isPoll = String(url).endsWith('/getUpdates');
  let last;
  for (let i = 0; i < (isPoll ? 1 : 3); i++) {
    try { return await fetch(url, { ...opts, signal: AbortSignal.timeout(isPoll ? 9_000 : 25_000) }); }
    catch (e) {
      last = e;
      const code = e && e.cause && e.cause.code;
      const beforeSend = code === 'UND_ERR_CONNECT_TIMEOUT' || code === 'ECONNREFUSED' || code === 'ENETUNREACH';
      if (!(beforeSend || isPoll)) break; // отправка могла дойти — повторять нельзя
      await new Promise((r) => setTimeout(r, 1000 * (i + 1)));
    }
  }
  throw last;
}
const ctxFor = () => makeCtx({ db, env, publicUrl: env.PUBLIC_URL, fetchFn: tgFetch });
const polling = (env.MODE || 'webhook') === 'polling';

// файл аппки ~2 МБ: читаем с диска только когда он изменился (после автообновления)
let __appCache = { m: 0, html: '' };
function __appHtml() {
  const f = new URL('../app/workshop.html', import.meta.url), m = fs.statSync(f).mtimeMs;
  if (m !== __appCache.m) __appCache = { m, html: fs.readFileSync(f, 'utf8') };
  return __appCache.html;
}
const testCache = { html: '', at: 0 };
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, env.PUBLIC_URL || 'http://localhost');
  const send = (code, body, type = 'text/html; charset=utf-8', headers = {}) => {
    // страницы сжимаем: 300 КБ теста превращаются в ~60 КБ
    if (typeof body === 'string' && body.length > 2000 && /\bgzip\b/.test(req.headers['accept-encoding'] || '')) {
      res.writeHead(code, { 'content-type': type, 'content-encoding': 'gzip', vary: 'accept-encoding', ...headers });
      return res.end(zlib.gzipSync(body));
    }
    res.writeHead(code, { 'content-type': type, ...headers }); res.end(body);
  };
  try {
    // панель админа (кнопка в боте) и её API
    if (url.pathname === '/admin/build') return send(200, BUILD, 'text/plain; charset=utf-8', { 'cache-control': 'no-store' });
    // игра-прогрев: пока только админам. Ворота пустые, игра отдаётся после проверки подписи Telegram
    if (url.pathname === '/app' || url.pathname === '/app/') return send(200, __GATE, 'text/html; charset=utf-8', { 'cache-control': 'no-store', 'x-robots-tag': 'noindex' });
    if (url.pathname === '/api/app/load' && req.method === 'POST') {
      const __u = await __checkInit(String(req.headers['x-init-data'] || ''), env.BOT_TOKEN, Math.floor(Date.now() / 1000));
      if (!__u) return send(401, 'unauthorized', 'text/plain; charset=utf-8', { 'cache-control': 'no-store' });
      const __c = ctxFor(), __admin = await __isAdmin(__c, __u.id), __cfg = await __loadCfg(__c);
      // не админам аппка открыта только когда админ включил «Показывать всем»
      if (!__admin && !__cfg.public) return send(403, 'forbidden', 'text/plain; charset=utf-8', { 'cache-control': 'no-store' });
      const __view = __viewFor(__cfg, Math.floor(Date.now() / 1000), __admin);
      const __html = __appHtml().replace('/*__APPCFG__*/null', () => JSON.stringify(__view).replace(/</g, '\\u003c'));
      return send(200, __html, 'text/html; charset=utf-8', { 'cache-control': 'no-store' });
    }
    // расписание открытия игр: сохраняет только админ
    if (url.pathname === '/api/app/cfg' && req.method === 'POST') {
      const J = (code, o) => send(code, JSON.stringify(o), 'application/json; charset=utf-8', { 'cache-control': 'no-store' });
      const __u = await __checkInit(String(req.headers['x-init-data'] || ''), env.BOT_TOKEN, Math.floor(Date.now() / 1000));
      if (!__u) return J(401, { error: 'Открой аппку из бота' });
      const __c = ctxFor();
      if (!(await __isAdmin(__c, __u.id))) return J(403, { error: 'Только для админов' });
      let body = ''; let big = false;
      await new Promise((ok) => { req.on('data', (c) => { body += c; if (body.length > 16384) { big = true; req.destroy(); } }); req.on('end', ok); req.on('close', ok); req.on('error', ok); });
      if (big) return J(413, { error: 'Слишком большой запрос' });
      let input; try { input = JSON.parse(body || '{}'); } catch { return J(400, { error: 'Не получилось прочитать данные' }); }
      const r = await __saveCfg(__c, input);
      if (r.error) return J(400, { error: r.error });
      syncMenu(__c).catch((e) => console.error('menu', e));
      return J(200, { ok: true, view: __viewFor(r.cfg, Math.floor(Date.now() / 1000), true) });
    }
    if (url.pathname === '/admin' || url.pathname === '/admin/') return send(200, PANEL, 'text/html; charset=utf-8', { 'cache-control': 'no-store' });
    // большие файлы для кнопок: кладём на диск сервера (Telegram принимает от бота не больше 50 МБ)
    if (url.pathname === '/api/panel/bigfile' && req.method === 'POST') {
      const hdr = new Headers(); for (const [k, v] of Object.entries(req.headers)) if (typeof v === 'string') hdr.set(k, v);
      const user = await panelAdmin(ctxFor(), new Request(url, { method: 'GET', headers: hdr }));
      if (!user) { res.writeHead(401, { 'content-type': 'application/json' }); return res.end('{"error":"Открой панель из бота: /admin"}'); }
      const MAX = 1024 * 1024 * 1024;
      const len = Number(req.headers['content-length'] || 0);
      const fail = (code, msg) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: msg })); };
      if (len > MAX) { req.resume(); return fail(400, 'Файл больше 1 ГБ — на сервере столько не держим'); }
      const name = (url.searchParams.get('name') || 'file').replace(/[\\/\r\n"]+/g, '_').slice(0, 80) || 'file';
      const token = crypto.randomBytes(18).toString('hex').slice(0, 24);
      const dir = path.join(path.dirname(file), 'files'); fs.mkdirSync(dir, { recursive: true });
      const target = path.join(dir, token);
      let size = 0, tooBig = false;
      const out = fs.createWriteStream(target);
      req.on('data', (c) => { size += c.length; if (size > MAX && !tooBig) { tooBig = true; req.destroy(); out.destroy(); } });
      await new Promise((ok) => { req.pipe(out); out.on('finish', ok); out.on('error', ok); req.on('error', ok); req.on('close', ok); });
      if (tooBig || (len && size < len)) { fs.rmSync(target, { force: true }); return fail(400, 'Файл не дозагрузился — попробуй ещё раз'); }
      fs.writeFileSync(target + '.json', JSON.stringify({ name, type: url.searchParams.get('type') || '', size }));
      const base = env.PUBLIC_URL || ('https://' + (req.headers.host || 'localhost'));
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ ok: true, file: { type: 'link', url: `${base}/f/${token}/${encodeURIComponent(name)}`, name, size } }));
    }
    // открытая ссылка на такой файл: страница предпросмотра с кнопкой «Скачать»; ?raw=1 — сам файл, ?dl=1 — скачать
    { const fm = /^\/f\/([a-z0-9]{24})\//.exec(url.pathname);
      if (fm) {
        const target = path.join(path.dirname(file), 'files', fm[1]);
        let meta; try { meta = JSON.parse(fs.readFileSync(target + '.json', 'utf8')); } catch { res.writeHead(404); return res.end('not found'); }
        const dl = url.searchParams.get('dl') === '1', rawQ = url.searchParams.get('raw') === '1';
        const wantsHtml = /text\/html/.test(req.headers.accept || '');
        const mime = mimeOf(meta), safe = kindOf(mime) !== 'other';
        if (!dl && !rawQ && wantsHtml) return send(200, filePage(meta, url.origin + url.pathname), 'text/html; charset=utf-8', { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
        const inline = rawQ && safe;
        const hd = { 'content-type': inline ? mime : 'application/octet-stream', 'accept-ranges': 'bytes', 'x-content-type-options': 'nosniff', 'content-security-policy': 'sandbox', 'cache-control': 'public, max-age=3600',
          'content-disposition': `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(meta.name)}` };
        let start = 0, end = meta.size - 1, code = 200;
        const rg = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || '');
        if (rg && (rg[1] || rg[2])) {
          if (rg[1]) { start = +rg[1]; if (rg[2]) end = Math.min(end, +rg[2]); } else { start = Math.max(0, meta.size - +rg[2]); }
          if (start > end || start >= meta.size) { res.writeHead(416, { 'content-range': `bytes */${meta.size}` }); return res.end(); }
          code = 206; hd['content-range'] = `bytes ${start}-${end}/${meta.size}`;
        }
        hd['content-length'] = end - start + 1;
        res.writeHead(code, hd);
        if (req.method === 'HEAD') return res.end();
        return fs.createReadStream(target, { start, end }).pipe(res);
      } }
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
    // открытые страницы документов (политика, согласие) — лежат в bot/docs
    if (url.pathname === '/policy' || url.pathname === '/consent') {
      const f = new URL('../docs/' + url.pathname.slice(1) + '.html', import.meta.url);
      return send(200, fs.readFileSync(f, 'utf8'), 'text/html; charset=utf-8', { 'cache-control': 'public, max-age=300' });
    }
    // страница аудит-теста: берём файл с GitHub и отдаём как обычную страницу
    if (url.pathname === '/test' || url.pathname === '/test/') {
      // страница тянется с GitHub раз в 5 минут и хранится в памяти (раньше — при каждом открытии, а это 300 КБ)
      const src = env.TEST_SRC || 'https://raw.githubusercontent.com/karoleenok/di-sign-audit/main/index.html';
      if (!testCache.html || Date.now() - testCache.at > 300_000) {
        try {
          const r = await fetch(src, { signal: AbortSignal.timeout(15_000) });
          if (r.ok) { testCache.html = await r.text(); testCache.at = Date.now(); }
        } catch (e) { console.error('test fetch', e.message); }
      }
      if (!testCache.html) return send(502, 'Тест временно недоступен, попробуй через минуту');
      return send(200, testCache.html, 'text/html; charset=utf-8', { 'cache-control': 'public, max-age=300' });
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

// при каждом запуске обновляем меню и кнопку игры (после автообновления это единственный способ, чтобы они появились)
setTimeout(() => syncMenu(ctxFor()).catch((e) => console.error('menu', e)), 3000);

// расписание раз в минуту
setInterval(async () => {
  try { await tick(ctxFor(), Number(env.TICK_BUDGET) || 600); await stepRuns(ctxFor(), 10); } catch (e) { console.error('tick', e); }
  try { await backupTick(ctxFor(), file); await archiveOldDates(ctxFor()); } catch (e) { console.error('backup', e); }
}, 60_000);

// режим без вебхука: сами забираем сообщения у Telegram (через мост, если нужен)
// каждый человек обрабатывается по очереди, но разные люди — одновременно:
// раньше один ученик с паузами «печатает…» задерживал всех остальных
const lanes = new Map();
function dispatch(u) {
  const who = (u.message && u.message.from) || (u.callback_query && u.callback_query.from) || (u.my_chat_member && u.my_chat_member.from);
  const key = who ? who.id : 'x';
  const prev = lanes.get(key) || Promise.resolve();
  const next = prev.then(() => handleUpdate(ctxFor(), u)).catch((e) => console.error(e)).finally(() => { if (lanes.get(key) === next) lanes.delete(key); });
  lanes.set(key, next);
}
if (polling) {
  (async () => {
    const offRow = await db.first(`SELECT value FROM settings WHERE key = 'poll_offset'`);
    let offset = offRow ? +offRow.value : 0;
    for (;;) {
      try {
        const ctx = ctxFor();
        const ups = await ctx.tg.call('getUpdates', { offset, timeout: Number(env.POLL_TIMEOUT) || 4, allowed_updates: ['message', 'callback_query', 'my_chat_member'] });
        for (const u of ups) {
          offset = u.update_id + 1;
          dispatch(u);
        }
        if (ups.length) await db.run(`INSERT INTO settings (key, value) VALUES ('poll_offset', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`, [String(offset)]);
      } catch (e) { console.error('poll', e.message, e.cause && e.cause.code); await new Promise((r) => setTimeout(r, 500)); }
    }
  })();
}
