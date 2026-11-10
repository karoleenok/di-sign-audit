// Видеоурок из YouTube: разбор ссылки и глав, кнопка поста, доступ, запоминание места, защита страницы
import assert from 'node:assert/strict';
import http from 'node:http';
import crypto from 'node:crypto';
import { nodeSqliteAdapter } from '../src/db-node.js';
import { migrate } from '../src/schema.js';
import { parseYouTubeId, parseChapters, cleanVideo, fmtClock, chaptersText, loadWatch, saveWatch } from '../src/video.js';
import { keyboard } from '../src/posts.js';
import { cleanButtons } from '../src/panel-api.js';
import { watchRoute, WATCH_CSP } from '../src/watch-route.js';
import { saveCfg, loadCfg, viewFor, cleanVideos, normalizeVideos } from '../src/appcfg.js';
import { WATCH_HTML, WATCH_JS, WATCH_CSS } from '../src/watch-page.js';

const VID = '-abc_DEF123'; // ID с дефисом в начале и подчёркиванием: такие бывают

// ---- ссылка ----
assert.equal(parseYouTubeId('https://youtu.be/' + VID), VID);
assert.equal(parseYouTubeId('https://youtu.be/' + VID + '?si=xyz&t=10'), VID);
assert.equal(parseYouTubeId('https://www.youtube.com/watch?v=' + VID + '&list=PL1'), VID);
assert.equal(parseYouTubeId('youtube.com/watch?v=' + VID), VID, 'без https');
assert.equal(parseYouTubeId('https://m.youtube.com/watch?v=' + VID), VID);
assert.equal(parseYouTubeId('https://www.youtube.com/embed/' + VID), VID);
assert.equal(parseYouTubeId('https://www.youtube.com/live/' + VID + '?feature=share'), VID);
assert.equal(parseYouTubeId('https://www.youtube.com/shorts/' + VID), VID);
assert.equal(parseYouTubeId(VID), VID, 'голый ID');
assert.equal(parseYouTubeId('https://vimeo.com/123456789'), null);
assert.equal(parseYouTubeId('https://evil.com/watch?v=' + VID), null, 'чужой сайт');
assert.equal(parseYouTubeId('https://youtube.com.evil.com/watch?v=' + VID), null, 'похожий адрес');
assert.equal(parseYouTubeId('https://youtu.be/коротко'), null);
assert.equal(parseYouTubeId(''), null);
assert.equal(parseYouTubeId(null), null);
console.log('✓ ссылки YouTube: все формы разбираются, чужие сайты нет');

// ---- главы ----
assert.equal(fmtClock(0), '0:00'); assert.equal(fmtClock(754), '12:34'); assert.equal(fmtClock(3723), '1:02:03');
const c = parseChapters('0:00 Вступление\n12:30 — Иерархия\n[1:02:03] Итоги\n\n');
assert.deepEqual(c.ch, [{ t: 0, title: 'Вступление' }, { t: 750, title: 'Иерархия' }, { t: 3723, title: 'Итоги' }]);
assert.deepEqual(parseChapters('20:00 Б\n5:00 А').ch.map((x) => x.title), ['А', 'Б'], 'сортируем по времени');
assert.ok(parseChapters('0:00').error, 'нет названия');
assert.ok(parseChapters('привет').error, 'нет времени');
assert.ok(parseChapters('0:75 Ошибка').error, 'секунд не больше 59');
assert.ok(parseChapters('1:00 А\n1:00 Б').error, 'одинаковое время');
assert.ok(parseChapters(Array.from({ length: 41 }, (_, i) => `${i}:00 Глава ${i}`).join('\n')).error, 'больше 40');
assert.equal(chaptersText(c.ch), '0:00 Вступление\n12:30 Иерархия\n1:02:03 Итоги');
const cv = cleanVideo({ url: 'https://youtu.be/' + VID, ch: '0:00 Старт' });
assert.deepEqual(cv.video, { id: VID, ch: [{ t: 0, title: 'Старт' }] });
assert.ok(cleanVideo({ url: 'нет' }).error); assert.ok(cleanVideo({ url: 'https://youtu.be/' + VID, ch: 'ерунда' }).error);
assert.deepEqual(cleanVideo({ id: VID, ch: [{ t: 5, title: 'А' }] }).video, { id: VID, ch: [{ t: 5, title: 'А' }] }, 'хранимый вид принимается обратно');
console.log('✓ главы: время, названия, порядок, ошибки понятным языком');

// ---- база ----
const db = await nodeSqliteAdapter(':memory:'); await migrate(db);
const NOW = 1_800_000_000;
const ctx = { db, now: NOW, env: { ADMIN_IDS: '1', BOT_TOKEN: 'test-token-123' } };
const btn = { text: '▶️ Смотреть урок', video: { id: VID, ch: [{ t: 0, title: 'Старт' }] } };
await db.run(`INSERT INTO posts (id, title, kind, status, created_at, text, buttons) VALUES (7, 'Урок 1', 'drip', 'active', 0, 'x', ?)`, [JSON.stringify([[btn]])]);
await db.run(`INSERT INTO posts (id, title, kind, status, created_at, text, buttons) VALUES (8, 'Без видео', 'drip', 'active', 0, 'x', ?)`, [JSON.stringify([[{ text: 'a', url: 'https://x.ru' }]])]);
for (const id of [1, 2, 3]) await db.run(`INSERT INTO users (tg_id, first_name, status, created_at) VALUES (?, ?, 'active', 0)`, [id, 'Имя' + id]);
await db.run(`INSERT INTO deliveries (post_id, tg_id, sent_at, ok) VALUES (7, 2, ?, 1), (7, 3, ?, 0)`, [NOW, NOW]);
const U = (id) => ({ id, first_name: 'Имя' + id });

// кнопка поста -> мини-аппка
const kb = keyboard({ id: 7, buttons: JSON.stringify([[btn]]) }, 2, 'https://bot.example.ru');
assert.deepEqual(kb.inline_keyboard[0][0], { text: '▶️ Смотреть урок', web_app: { url: 'https://bot.example.ru/watch/7/0-0' } });
assert.ok(!JSON.stringify(kb).includes(VID), 'ID видео в клавиатуре не светится');
assert.equal(keyboard({ id: 7, buttons: JSON.stringify([[btn]]) }, 2, ''), undefined, 'без публичного адреса кнопки нет');

// панель сохраняет кнопку-видео и ругается на плохую ссылку
const ok = await cleanButtons(ctx, [[{ text: 'Смотреть', video: { url: 'https://youtu.be/' + VID, ch: '0:00 Старт' } }]], null);
assert.deepEqual(ok.rows, [[{ text: 'Смотреть', video: { id: VID, ch: [{ t: 0, title: 'Старт' }] } }]]);
assert.match((await cleanButtons(ctx, [[{ text: 'Смотреть', video: { url: 'https://vimeo.com/1', ch: '' } }]], null)).error, /Смотреть.*YouTube/);
assert.match((await cleanButtons(ctx, [[{ text: 'Смотреть', video: { url: 'https://youtu.be/' + VID, ch: 'ерунда' } }]], null)).error, /Смотреть/);

// доступ
let r = await loadWatch(ctx, { user: U(1), admin: true, pid: 7, bid: '0-0' });
assert.equal(r.code, 200); assert.equal(r.data.id, VID); assert.equal(r.data.admin, true);
// название: заголовок поста; без заголовка — первая строка текста; совсем пусто — «Урок»
await db.run(`INSERT INTO posts (id, title, kind, status, created_at, text, buttons) VALUES (9, '', 'drip', 'active', 0, ?, ?)`, ['\n  Вторая неделя: сетка и отступы\nдальше длинный текст', JSON.stringify([[btn]])]);
await db.run(`INSERT INTO posts (id, title, kind, status, created_at, text, buttons) VALUES (10, NULL, 'drip', 'active', 0, NULL, ?)`, [JSON.stringify([[btn]])]);
assert.equal((await loadWatch(ctx, { user: U(1), admin: true, pid: 9, bid: '0-0' })).data.title, 'Вторая неделя: сетка и отступы');
assert.equal((await loadWatch(ctx, { user: U(1), admin: true, pid: 10, bid: '0-0' })).data.title, 'Урок');
assert.equal((await loadWatch(ctx, { user: U(1), admin: true, pid: 7, bid: '0-0' })).data.title, 'Урок 1');
r = await loadWatch(ctx, { user: U(2), admin: false, pid: 7, bid: '0-0' });
assert.equal(r.code, 200, 'ученик, которому пост пришёл'); assert.equal(r.data.resume, 0); assert.ok(!('name' in r.data) && !('uid' in r.data), 'имя и id человека странице не отдаём');
assert.equal((await loadWatch(ctx, { user: U(3), admin: false, pid: 7, bid: '0-0' })).code, 403, 'отправка не удалась — доступа нет');
assert.equal((await loadWatch(ctx, { user: U(9), admin: false, pid: 7, bid: '0-0' })).code, 403, 'чужой человек');
assert.equal((await loadWatch(ctx, { user: U(1), admin: true, pid: 8, bid: '0-0' })).code, 404, 'в посте нет видео');
assert.equal((await loadWatch(ctx, { user: U(1), admin: true, pid: 7, bid: '0-5' })).code, 404, 'нет такой кнопки');
assert.equal((await loadWatch(ctx, { user: U(1), admin: true, pid: 999, bid: '0-0' })).code, 404);
assert.equal((await loadWatch(ctx, { user: U(1), admin: true, pid: '7; DROP', bid: '0-0' })).code, 404);
assert.equal((await loadWatch(ctx, { user: U(1), admin: true, pid: 7, bid: 'abc' })).code, 404);
// нажатие считается один раз за 10 минут
await loadWatch(ctx, { user: U(2), admin: false, pid: 7, bid: '0-0' });
assert.equal((await db.first(`SELECT COUNT(*) AS n FROM clicks WHERE post_id = 7 AND tg_id = 2`)).n, 1);
await loadWatch({ ...ctx, now: NOW + 601 }, { user: U(2), admin: false, pid: 7, bid: '0-0' });
assert.equal((await db.first(`SELECT COUNT(*) AS n FROM clicks WHERE post_id = 7 AND tg_id = 2`)).n, 2);
console.log('✓ доступ: админ всегда, ученик только после получения поста, мусорные адреса — 404');

// место просмотра
assert.equal((await saveWatch(ctx, { user: U(2), admin: false, pid: 7, bid: '0-0', sec: 754, dur: 3600 })).code, 200);
r = await loadWatch(ctx, { user: U(2), admin: false, pid: 7, bid: '0-0' });
assert.equal(r.data.resume, 754); assert.equal(r.data.dur, 3600);
await saveWatch(ctx, { user: U(2), admin: false, pid: 7, bid: '0-0', sec: 100, dur: 3600 });
assert.equal((await db.first(`SELECT sec, max_sec FROM watch_progress WHERE tg_id = 2`)).max_sec, 754, 'самое дальнее место помним');
assert.equal((await db.first(`SELECT sec FROM watch_progress WHERE tg_id = 2`)).sec, 100);
await saveWatch(ctx, { user: U(2), admin: false, pid: 7, bid: '0-0', sec: 3590, dur: 3600 });
assert.equal((await loadWatch(ctx, { user: U(2), admin: false, pid: 7, bid: '0-0' })).data.resume, 0, 'досмотрел — начнёт сначала');
assert.equal((await saveWatch(ctx, { user: U(2), admin: false, pid: 7, bid: '0-0', sec: -5, dur: 1 })).code, 400);
assert.equal((await saveWatch(ctx, { user: U(2), admin: false, pid: 7, bid: '0-0', sec: 'x', dur: 1 })).code, 400);
assert.equal((await saveWatch(ctx, { user: U(9), admin: false, pid: 7, bid: '0-0', sec: 5, dur: 10 })).code, 403, 'чужому место не пишем');
assert.equal((await db.first(`SELECT COUNT(*) AS n FROM watch_progress WHERE tg_id = 9`)).n, 0);
console.log('✓ «продолжить с места»: запоминаем, дальше помним, после конца — с начала');

// ---- страница и защита ----
assert.ok(!WATCH_HTML.includes(VID) && !WATCH_JS.includes(VID) && !WATCH_CSS.includes(VID), 'в самой странице ID нет');
assert.ok(!/<script(?![^>]*\bsrc=)[^>]*>/i.test(WATCH_HTML), 'в странице нет встроенных скриптов');
assert.ok(!/ on\w+=/i.test(WATCH_HTML), 'в странице нет onclick и подобных');
assert.ok(/script-src 'self' https:\/\/telegram\.org https:\/\/www\.youtube\.com/.test(WATCH_CSP) && !/script-src[^;]*unsafe-inline/.test(WATCH_CSP), 'скрипты только свои, Telegram и YouTube');
assert.ok(/frame-ancestors[^;]*telegram/.test(WATCH_CSP) && /frame-src https:\/\/www\.youtube-nocookie\.com/.test(WATCH_CSP));
// скрипт страницы читается без ошибок
new Function(WATCH_JS.replace(/^\(function\(\)\{/, 'return (function(){'));
console.log('✓ страница: без встроенных скриптов, ID внутри нет, защита страницы строгая');

// ---- маршруты ----
const TOKEN = ctx.env.BOT_TOKEN;
const sign = (user, authDate = Math.floor(Date.now() / 1000)) => {
  const p = new URLSearchParams({ auth_date: String(authDate), query_id: 'AA', user: JSON.stringify(user) });
  const dcs = [...p.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, v]) => `${k}=${v}`).join('\n');
  const secret = crypto.createHmac('sha256', 'WebAppData').update(TOKEN).digest();
  p.set('hash', crypto.createHmac('sha256', secret).update(dcs).digest('hex'));
  return p.toString();
};
const send = (code, body, type = 'text/html; charset=utf-8', headers = {}) => ({ code, body, type, headers });
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const out = (code, body, type = 'text/html; charset=utf-8', headers = {}) => { res.writeHead(code, { 'content-type': type, ...headers }); res.end(body); };
  const handled = await watchRoute({ req, res, url, send: out, env: ctx.env, ctxFor: () => ({ ...ctx, now: Math.floor(Date.now() / 1000) }) });
  if (!handled) out(404, 'nf');
});
await new Promise((ok) => server.listen(0, ok));
const base = 'http://127.0.0.1:' + server.address().port;
const post = (path, body, init) => fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json', ...(init ? { 'x-init-data': init } : {}) }, body: JSON.stringify(body) });

const page = await fetch(base + '/watch/7/0-0');
assert.equal(page.status, 200);
assert.equal(page.headers.get('content-security-policy'), WATCH_CSP);
assert.equal(page.headers.get('referrer-policy'), 'strict-origin-when-cross-origin', 'YouTube без адреса страницы плеер не покажет');
assert.equal(page.headers.get('x-robots-tag'), 'noindex');
assert.ok(!(await page.text()).includes(VID));
assert.equal((await fetch(base + '/watch.js')).status, 200); assert.equal((await fetch(base + '/watch.css')).status, 200);
assert.equal((await fetch(base + '/watch/abc/0-0')).status, 404, 'кривой адрес страницы');
assert.equal((await fetch(base + '/api/watch/load')).status, 405);

assert.equal((await post('/api/watch/load', { p: 7, b: '0-0' })).status, 401, 'без подписи');
assert.equal((await post('/api/watch/load', { p: 7, b: '0-0' }, 'user=%7B%22id%22%3A1%7D&hash=00')).status, 401, 'поддельная подпись');
assert.equal((await post('/api/watch/load', { p: 7, b: '0-0' }, sign({ id: 2, first_name: 'Имя2' }, 1_000_000))).status, 401, 'подпись просрочена');
const good = sign({ id: 2, first_name: 'Имя2' });
const lr = await post('/api/watch/load', { p: 7, b: '0-0' }, good);
assert.equal(lr.status, 200); assert.equal(lr.headers.get('cache-control'), 'no-store');
assert.equal((await lr.json()).id, VID);
assert.equal((await post('/api/watch/load', { p: 7, b: '0-0' }, sign({ id: 9, first_name: 'Чужой' }))).status, 403, 'подпись верна, но пост человеку не приходил');
assert.equal((await post('/api/watch/load', { p: 7, b: '0-0' }, sign({ id: 1, first_name: 'Админ' }))).status, 200, 'админ (ADMIN_IDS)');
assert.equal((await post('/api/watch/progress', { p: 7, b: '0-0', s: 42, d: 600 }, good)).status, 200);
assert.equal((await db.first(`SELECT sec FROM watch_progress WHERE tg_id = 2`)).sec, 42);
try { const big = await post('/api/watch/load', { p: 7, b: '0-0', junk: 'x'.repeat(5000) }, good); assert.notEqual(big.status, 200, 'слишком большой запрос не принимаем'); } catch { /* сервер оборвал соединение — тоже верно */ }
assert.equal((await fetch(base + '/watch.js')).status, 200, 'после большого запроса сервер жив');

// ---- видеоуроки внутри аппки ----
{
  const cv1 = cleanVideos({ mini: [{ t: '  Урок   1 ', url: 'https://youtu.be/' + VID, ch: '0:00 Старт\n5:00 Дальше' }], mat: [] });
  assert.ok(!cv1.error); const v0 = cv1.videos.mini[0];
  assert.match(v0.id, /^[a-z0-9]{6}$/); assert.equal(v0.t, 'Урок 1'); assert.equal(v0.y, VID); assert.equal(v0.ch.length, 2);
  assert.ok(cleanVideos({ mini: [{ t: 'А', url: 'нет' }] }).error, 'плохая ссылка не пропадает молча');
  assert.ok(cleanVideos({ mini: [{ t: '', url: 'https://youtu.be/' + VID }] }).error, 'без названия');
  assert.ok(cleanVideos({ mini: [{ t: 'А', url: VID, ch: 'ерунда' }] }).error, 'плохие главы');
  assert.ok(cleanVideos({ mat: Array.from({ length: 13 }, () => ({ t: 'А', url: VID })) }).error, 'больше 12');
  assert.equal(cleanVideos({ mini: [{ id: 'abc123', t: 'А', url: VID }, { id: 'abc123', t: 'Б', url: VID }] }).videos.mini.map((x) => x.id)[0], 'abc123', 'свой id сохраняется');
  assert.notEqual(new Set(cleanVideos({ mini: [{ id: 'abc123', t: 'А', url: VID }, { id: 'abc123', t: 'Б', url: VID }] }).videos.mini.map((x) => x.id)).size, 1, 'одинаковые id разводятся');
  assert.deepEqual(normalizeVideos({ mini: [{ id: 'bad id', t: 'А', y: VID }, { id: 'abc123', t: 'А', y: 'нет' }] }).mini, [], 'мусор из базы отбрасывается');

  const r1 = await saveCfg(ctx, { public: true, videos: { mini: [{ t: 'Первый урок', url: 'https://youtu.be/' + VID, ch: '0:00 Старт' }], mat: [{ t: 'Урок материалов', url: VID }] } });
  assert.ok(!r1.error, r1.error);
  const idMini = r1.cfg.videos.mini[0].id, idMat = r1.cfg.videos.mat[0].id;
  await saveCfg(ctx, { public: true }); // другое поле не стирает видео
  assert.equal((await loadCfg(ctx)).videos.mini[0].id, idMini);
  assert.ok((await saveCfg(ctx, { videos: { mini: [{ t: 'Х', url: 'ерунда' }] } })).error);
  assert.equal((await loadCfg(ctx)).videos.mini[0].id, idMini, 'после ошибки старое осталось');
  const vs = viewFor(await loadCfg(ctx), NOW, false).videos.mini[0];
  assert.deepEqual(vs, { id: idMini, t: 'Первый урок', n: 1 }, 'ученику ID видео не отдаём');
  assert.ok(!JSON.stringify(viewFor(await loadCfg(ctx), NOW, false)).includes(VID));
  assert.equal(viewFor(await loadCfg(ctx), NOW, true).videos.mini[0].y, VID, 'админу для редактора отдаём');

  await db.run(`UPDATE users SET track = 'course' WHERE tg_id = 2`);
  await db.run(`UPDATE users SET track = 'mat' WHERE tg_id = 3`);
  const A = (init, body, path = '/api/watch/load') => post(path, body, init);
  const u2 = sign({ id: 2, first_name: 'Имя2' }), u3 = sign({ id: 3, first_name: 'Имя3' }), adm = sign({ id: 1, first_name: 'Админ' });
  assert.equal((await fetch(base + '/watch/a/mini/' + idMini)).status, 200);
  assert.equal((await fetch(base + '/watch/a/xxx/' + idMini)).status, 404);
  const ok = await A(u2, { k: 'mini', v: idMini }); assert.equal(ok.status, 200);
  const okj = await ok.json(); assert.equal(okj.id, VID); assert.equal(okj.title, 'Первый урок');
  assert.equal((await A(u2, { k: 'mat', v: idMat })).status, 403, 'чужой раздел');
  assert.equal((await A(u3, { k: 'mini', v: idMini })).status, 403, 'чужой раздел');
  assert.equal((await A(u3, { k: 'mat', v: idMat })).status, 200);
  assert.equal((await A(u2, { k: 'mini', v: 'zzzzzz' })).status, 404);
  assert.equal((await A(adm, { k: 'mat', v: idMat })).status, 200, 'админ видит оба раздела');
  assert.equal((await A('', { k: 'mini', v: idMini })).status, 401);
  assert.equal((await A(u2, { k: 'mini', v: idMini, s: 77, d: 900 }, '/api/watch/progress')).status, 200);
  assert.equal((await db.first(`SELECT sec FROM watch_progress WHERE tg_id = 2 AND post_id = -1 AND btn = ?`, [idMini])).sec, 77);
  assert.equal((await (await A(u2, { k: 'mini', v: idMini })).json()).resume, 77, 'место просмотра вернулось');
  await saveCfg(ctx, { public: false });
  assert.equal((await A(u2, { k: 'mini', v: idMini })).status, 403, 'аппка закрыта для всех — уроки тоже');
  assert.equal((await A(adm, { k: 'mini', v: idMini })).status, 200);
  console.log('✓ видеоуроки аппки: сохранение, ID не уходит ученикам, доступ по разделу и «показывать всем», место просмотра');
}
server.close();
console.log('✓ маршруты: подпись Telegram обязательна, чужим 403, админам можно, заголовки защиты на месте');
process.exit(0);
