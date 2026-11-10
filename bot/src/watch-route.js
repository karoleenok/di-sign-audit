// Маршруты видеоурока: страница /watch/<пост>/<кнопка>, её скрипт со стилями и два запроса:
//   POST /api/watch/load      — открыть урок (ID видео, главы, где остановился)
//   POST /api/watch/progress  — запомнить место просмотра
// Оба запроса принимаются только с подписью Telegram (заголовок x-init-data).
import { checkInitData } from './panel-api.js';
import { isAdmin } from './admin.js';
import { loadWatch, saveWatch, loadAppWatch, saveAppWatch } from './video.js';
import { loadCfg, appTrack } from './appcfg.js';
import { WATCH_HTML, WATCH_CSS, WATCH_JS } from './watch-page.js';

// Что странице можно: свои файлы, скрипт Телеграма и плеер YouTube. Встраивать её можно только в Телеграм.
// Без 'unsafe-inline' для скриптов: код страницы лежит в отдельном файле.
export const WATCH_CSP = [
  "default-src 'none'",
  "script-src 'self' https://telegram.org https://www.youtube.com https://s.ytimg.com",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: https://i.ytimg.com",
  "font-src 'self'",
  "connect-src 'self'",
  'frame-src https://www.youtube-nocookie.com https://www.youtube.com',
  "base-uri 'none'", "form-action 'none'",
  "frame-ancestors 'self' https://web.telegram.org https://*.telegram.org https://telegram.org",
].join('; ');
// YouTube не показывает плеер без адреса страницы, откуда его открыли (ошибка 153), поэтому здесь referrer не прячем целиком
const PAGE_HEADERS = { 'content-security-policy': WATCH_CSP, 'referrer-policy': 'strict-origin-when-cross-origin', 'x-robots-tag': 'noindex', 'cache-control': 'no-cache' };
const JSON_HEADERS = { 'cache-control': 'no-store' };

async function readJson(req, limit = 2048) {
  let body = '', big = false;
  await new Promise((ok) => { req.on('data', (c) => { body += c; if (body.length > limit) { big = true; req.destroy(); } }); req.on('end', ok); req.on('close', ok); req.on('error', ok); });
  if (big) return null;
  try { return JSON.parse(body || '{}'); } catch { return null; }
}

// урок из аппки: те же правила, что у /api/app/load. Админ видит всё, ученик — только свой трек и только когда аппка открыта для всех
async function appVideo(ctx, user, admin, k, v) {
  if ((k !== 'mini' && k !== 'mat') || !/^[a-z0-9]{6}$/.test(String(v || ''))) return { code: 404, error: 'Урок не найден' };
  const cfg = await loadCfg(ctx);
  if (!admin) {
    if (!cfg.public) return { code: 403, error: 'Этот урок пока закрыт' };
    const u = await ctx.db.first(`SELECT track FROM users WHERE tg_id = ?`, [user.id]);
    if (appTrack(u && u.track) !== k) return { code: 403, error: 'Этот урок из другого раздела. Открой аппку из бота и выбери свой раздел.' };
  }
  const vid = cfg.videos[k].find((x) => x.id === v);
  return vid ? { vid } : { code: 404, error: 'Урок не найден' };
}

// true — запрос наш и уже обработан
export async function watchRoute({ req, res, url, send, env, ctxFor }) {
  const p = url.pathname;
  if (p === '/watch.js') { send(200, WATCH_JS, 'text/javascript; charset=utf-8', { 'cache-control': 'no-cache' }); return true; }
  if (p === '/watch.css') { send(200, WATCH_CSS, 'text/css; charset=utf-8', { 'cache-control': 'no-cache' }); return true; }
  if (/^\/watch\/(?:\d+\/\d+-\d+|a\/(?:mini|mat)\/[a-z0-9]{6})\/?$/.test(p)) { send(200, WATCH_HTML, 'text/html; charset=utf-8', PAGE_HEADERS); return true; }
  if (p !== '/api/watch/load' && p !== '/api/watch/progress') return false;
  const J = (code, o) => send(code, typeof o === 'string' ? o : JSON.stringify(o), typeof o === 'string' ? 'text/plain; charset=utf-8' : 'application/json; charset=utf-8', JSON_HEADERS);
  if (req.method !== 'POST') { J(405, 'method not allowed'); return true; }
  const user = await checkInitData(String(req.headers['x-init-data'] || ''), env.BOT_TOKEN, Math.floor(Date.now() / 1000));
  if (!user || !user.id) { J(401, 'unauthorized'); return true; }
  const body = await readJson(req);
  if (!body) { J(400, 'bad request'); return true; }
  const ctx = ctxFor();
  const admin = await isAdmin(ctx, user.id);
  let r;
  if (body.k !== undefined) {
    const a = await appVideo(ctx, user, admin, body.k, body.v);
    r = a.error ? a : p === '/api/watch/load'
      ? await loadAppWatch(ctx, { user, admin, k: body.k, vid: a.vid })
      : await saveAppWatch(ctx, { user, k: body.k, vid: a.vid, sec: body.s, dur: body.d });
  } else r = p === '/api/watch/load'
    ? await loadWatch(ctx, { user, admin, pid: body.p, bid: body.b })
    : await saveWatch(ctx, { user, admin, pid: body.p, bid: body.b, sec: body.s, dur: body.d });
  if (r.error) J(r.code, r.error); else J(200, r.data);
  return true;
}
