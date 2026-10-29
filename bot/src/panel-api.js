// API панели админа (Telegram Mini App).
// Вход: панель присылает initData от Telegram, мы проверяем подпись токеном бота
// (так подделать вход нельзя) и что человек — админ.
import { isAdmin } from './admin.js';
import { AUD, LEVELS } from './texts.js';
import { sendPost, audienceCount } from './posts.js';
import { listMsgs, saveMsg, resetMsg, btn, say, setMsgMedia, canMedia, msgInfo, loadMsgs } from './msgs.js';

const enc = new TextEncoder();
async function hmac(key, data) {
  const k = await crypto.subtle.importKey('raw', typeof key === 'string' ? enc.encode(key) : key, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return new Uint8Array(await crypto.subtle.sign('HMAC', k, enc.encode(data)));
}
const hex = (b) => [...b].map((x) => x.toString(16).padStart(2, '0')).join('');

// Проверка подписи Telegram: https://core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app
export async function checkInitData(initData, botToken, now, maxAge = 86400) {
  if (!initData || !botToken) return null;
  const p = new URLSearchParams(initData);
  const hash = p.get('hash');
  if (!hash) return null;
  p.delete('hash');
  const dcs = [...p.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([k, v]) => `${k}=${v}`).join('\n');
  const secret = await hmac('WebAppData', botToken);
  const calc = hex(await hmac(secret, dcs));
  if (calc.length !== hash.length) return null;
  let diff = 0;
  for (let i = 0; i < calc.length; i++) diff |= calc.charCodeAt(i) ^ hash.charCodeAt(i);
  if (diff) return null;
  const at = Number(p.get('auth_date') || 0);
  if (!at || now - at > maxAge) return null;
  try { return JSON.parse(p.get('user') || 'null'); } catch { return null; }
}

const json = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } });
const j = (s, d) => { try { return s ? JSON.parse(s) : d; } catch { return d; } };
const TIME = /^([01]?\d|2[0-3]):([0-5]\d)$/;
const pad = (t) => { const m = TIME.exec(t || ''); return m ? `${m[1].padStart(2, '0')}:${m[2]}` : null; };

function postOut(p, sent, clicks) {
  const media = j(p.media, []);
  return {
    id: p.id, kind: p.kind, status: p.status, title: p.title || '', text: (p.text || '').slice(0, 400),
    day: p.day, time: p.send_time, run_at: p.run_at, audience: p.audience, catchup: !!p.catchup, pos: p.pos || 0,
    media: media.map((m) => m.type), buttons: j(p.buttons, []).flat().map((b) => b.text), rows: j(p.buttons, []),
    emoji: j(p.entities, []).some((e) => e.type === 'custom_emoji'), sent: sent || 0, clicks: clicks || 0,
  };
}

export async function handlePanelApi(ctx, request, url) {
  const init = request.headers.get('x-init-data') || '';
  const user = await checkInitData(init, ctx.env.BOT_TOKEN, ctx.now);
  if (!user) return json({ error: 'Открой панель из бота: /admin' }, 401);
  if (!(await isAdmin(ctx, user.id))) return json({ error: 'Панель только для админов' }, 403);
  ctx.userName = user.first_name;
  const path = url.pathname.replace(/^\/api\/panel/, '');

  // картинка к служебному сообщению: загрузить (multipart) / показать превью
  let mm = /^\/msg\/([A-Za-z_]+)\/media$/.exec(path);
  if (mm && request.method === 'POST') {
    const key = mm[1];
    if (!canMedia(key)) return json({ error: 'К этому сообщению картинку не прикрепить' }, 400);
    let file;
    try { file = (await request.formData()).get('file'); } catch { file = null; }
    if (!file || typeof file === 'string') return json({ error: 'Файл не пришёл' }, 400);
    const type = (file.type || '').toLowerCase();
    const kind = type === 'image/gif' ? 'animation' : type.startsWith('image/') ? 'photo' : type.startsWith('video/') ? 'video' : null;
    if (!kind) return json({ error: 'Нужна картинка (jpg, png, webp, gif) или видео mp4' }, 400);
    const max = kind === 'photo' ? 10 : 50;
    if (file.size > max * 1024 * 1024) return json({ error: `Файл больше ${max} МБ — Telegram такой не примет` }, 400);
    // Telegram хранит файлы сам: отправляем его тебе в бот, берём file_id и это служебное сообщение сразу убираем
    const form = new FormData();
    form.append('chat_id', String(user.id));
    form.append('disable_notification', 'true');
    form.append(kind, file, file.name || 'file');
    let res;
    try { res = await ctx.tg.upload({ photo: 'sendPhoto', video: 'sendVideo', animation: 'sendAnimation' }[kind], form); }
    catch (e) { return json({ error: 'Telegram не принял файл: ' + e.message }, 400); }
    const fid = kind === 'photo' ? res.photo && res.photo[res.photo.length - 1].file_id : (res[kind] || res.document || res.video || {}).file_id;
    if (!fid) return json({ error: 'Telegram не вернул файл' }, 400);
    await ctx.tg.call('deleteMessage', { chat_id: user.id, message_id: res.message_id }).catch(() => {});
    await setMsgMedia(ctx, key, { type: kind, file_id: fid });
    return json({ ok: true, msgs: await listMsgs(ctx) });
  }
  mm = /^\/msg\/([A-Za-z_]+)\/img$/.exec(path);
  if (mm) {
    const o = (await loadMsgs(ctx))[mm[1]];
    if (!o || !o.media) return json({ error: 'Картинки нет' }, 404);
    try {
      const r = await ctx.tg.download(o.media.file_id);
      return new Response(r.body, { headers: { 'content-type': r.headers.get('content-type') || 'image/jpeg', 'cache-control': 'private, max-age=300' } });
    } catch (e) { return json({ error: 'Не получилось загрузить превью' }, 400); }
  }

  const body = request.method === 'POST' ? await request.json().catch(() => ({})) : {};

  if (path === '/state') {
    const posts = await ctx.db.all(`SELECT * FROM posts WHERE status != 'archived' ORDER BY day, send_time, pos, id`);
    const sent = Object.fromEntries((await ctx.db.all(`SELECT post_id, COUNT(*) AS n FROM deliveries GROUP BY post_id`)).map((r) => [r.post_id, r.n]));
    const clicks = Object.fromEntries((await ctx.db.all(`SELECT post_id, COUNT(*) AS n FROM clicks GROUP BY post_id`)).map((r) => [r.post_id, r.n]));
    const people = await ctx.db.first(`SELECT COUNT(*) AS n, SUM(CASE WHEN status = 'active' THEN 1 ELSE 0 END) AS active FROM users`);
    return json({
      me: { id: user.id, name: user.first_name },
      audiences: AUD, levels: LEVELS,
      posts: posts.map((p) => postOut(p, sent[p.id], clicks[p.id])),
      msgs: await listMsgs(ctx),
      people: { all: people.n || 0, active: people.active || 0 },
    });
  }

  // правка одного поста: день, время, кому, статус, название, дата, догонять
  let m = /^\/post\/(\d+)$/.exec(path);
  if (m && request.method === 'POST') {
    const id = +m[1];
    const p = await ctx.db.first(`SELECT * FROM posts WHERE id = ?`, [id]);
    if (!p) return json({ error: 'Пост не найден' }, 404);
    const set = [], val = [];
    const put = (col, v) => { set.push(`${col} = ?`); val.push(v); };
    if (body.day !== undefined && p.kind === 'drip') { const d = parseInt(body.day, 10); if (!(d >= 0 && d <= 365)) return json({ error: 'День — от 0 до 365' }, 400); put('day', d); }
    if (body.time !== undefined) { const t = pad(body.time); if (!t) return json({ error: 'Время в формате 11:00' }, 400); put('send_time', t); }
    if (body.audience !== undefined) { if (!AUD[body.audience]) return json({ error: 'Неизвестная аудитория' }, 400); put('audience', body.audience); }
    if (body.status !== undefined) {
      if (!['active', 'paused', 'draft', 'archived'].includes(body.status)) return json({ error: 'Неизвестный статус' }, 400);
      if (body.status === 'active' && p.kind === 'date' && !(body.run_at || p.run_at)) return json({ error: 'Сначала задай дату' }, 400);
      put('status', body.status);
    }
    if (body.title !== undefined) put('title', String(body.title).slice(0, 80) || null);
    if (body.rows !== undefined) {
      // кнопки под постом: [[{text, url}], ...] — до 4 в ряд, текст до 60 знаков, ссылка https://
      if (!Array.isArray(body.rows) || body.rows.length > 10) return json({ error: 'Слишком много рядов (до 10)' }, 400);
      const rows = [];
      for (const row of body.rows) {
        if (!Array.isArray(row)) return json({ error: 'Неверные кнопки' }, 400);
        const r = [];
        for (const b of row) {
          const text = String((b && b.text) || '').trim().slice(0, 60);
          let link = String((b && b.url) || '').trim();
          if (!text && !link) continue;
          if (!text) return json({ error: 'У кнопки нет текста' }, 400);
          if (/^t\.me\//i.test(link)) link = 'https://' + link;
          if (!/^https?:\/\/\S+$/i.test(link)) return json({ error: `Ссылка у кнопки «${text}» должна начинаться с https://` }, 400);
          r.push({ text, url: link });
        }
        if (r.length > 4) return json({ error: 'В одном ряду не больше 4 кнопок' }, 400);
        if (r.length) rows.push(r);
      }
      put('buttons', rows.length ? JSON.stringify(rows) : null);
    }
    if (body.catchup !== undefined) put('catchup', body.catchup ? 1 : 0);
    if (body.run_at !== undefined && p.kind === 'date') { const t = Number(body.run_at); if (!(t > 0)) return json({ error: 'Неверная дата' }, 400); put('run_at', t); }
    if (set.length) await ctx.db.run(`UPDATE posts SET ${set.join(', ')} WHERE id = ?`, [...val, id]);
    const np = await ctx.db.first(`SELECT * FROM posts WHERE id = ?`, [id]);
    return json({ ok: true, post: postOut(np), reach: await audienceCount(ctx.db, np) });
  }

  // перетаскивание: новый день, время и порядок сразу для нескольких постов
  if (path === '/reorder' && request.method === 'POST') {
    const items = Array.isArray(body.items) ? body.items.slice(0, 200) : [];
    for (const it of items) {
      const d = parseInt(it.day, 10), t = pad(it.time), pos = parseInt(it.pos, 10) || 0;
      if (!(d >= 0 && d <= 365) || !t) return json({ error: 'Неверный день или время' }, 400);
    }
    for (const it of items) {
      await ctx.db.run(`UPDATE posts SET day = ?, send_time = ?, pos = ? WHERE id = ? AND kind = 'drip'`, [parseInt(it.day, 10), pad(it.time), parseInt(it.pos, 10) || 0, +it.id]);
    }
    return json({ ok: true, n: items.length });
  }

  m = /^\/post\/(\d+)\/preview$/.exec(path);
  if (m && request.method === 'POST') {
    const p = await ctx.db.first(`SELECT * FROM posts WHERE id = ?`, [+m[1]]);
    if (!p) return json({ error: 'Пост не найден' }, 404);
    try {
      const r = await sendPost(ctx.tg, user.id, p, { uid: user.id, publicUrl: ctx.publicUrl, arrow: await btn(ctx, 'buttonsArrow') });
      return json({ ok: true, warn: r.warn });
    } catch (e) { return json({ error: 'Telegram не принял пост: ' + e.message }, 400); }
  }

  m = /^\/msg\/([A-Za-z_]+)$/.exec(path);
  if (m && request.method === 'POST') {
    try {
      if (body.reset) await resetMsg(ctx, m[1]);
      else if (body.removeMedia) await setMsgMedia(ctx, m[1], null);
      else {
        const t = String(body.text || '');
        if (!t.trim()) return json({ error: 'Пустой текст' }, 400);
        if (t.length > 4000) return json({ error: 'Слишком длинно для Telegram' }, 400);
        if (body.text === undefined) return json({ error: 'Нет текста' }, 400);
        await saveMsg(ctx, m[1], t, []);
      }
      return json({ ok: true, msgs: await listMsgs(ctx) });
    } catch (e) { return json({ error: e.message }, 400); }
  }

  m = /^\/msg\/([A-Za-z_]+)\/preview$/.exec(path);
  if (m && request.method === 'POST') {
    await say(ctx, user.id, m[1], { уровень: LEVELS.start, политика: ctx.env.POLICY_URL || '— ссылка появится перед запуском —', согласие: ctx.env.CONSENT_URL || '— ссылка появится перед запуском —', оферта: ctx.env.OFFER_URL || '— скоро —', владелец: ctx.env.OWNER_INFO || '' });
    return json({ ok: true });
  }

  return json({ error: 'Нет такого действия' }, 404);
}
