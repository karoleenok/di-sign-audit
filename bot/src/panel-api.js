// API панели админа (Telegram Mini App).
// Вход: панель присылает initData от Telegram, мы проверяем подпись токеном бота
// (так подделать вход нельзя) и что человек — админ.
import { isAdmin } from './admin.js';
import { AUD, LEVELS } from './texts.js';
import { sendPost, audienceCount, loadDocs, DOCS, TRACKS } from './posts.js';
import { mdToEntities, entitiesToMd } from './fmt.js';
import { runPreview, startFastRun, stopRuns, stepRuns, activeRun } from './testrun.js';
import { onStart, docVars, loadFlow, normFlow, FLOW_OPTIONAL } from './users.js';
import { saveMsgExtra } from './msgs.js';
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
  const f = entitiesToMd(p.text || '', j(p.entities, []));
  return {
    id: p.id, kind: p.kind, status: p.status, title: p.title || '', text: (p.text || '').slice(0, 400),
    md: f.md, rich: f.rich, once: !!p.once, files: media, track: p.track || 'all',
    day: p.day, time: p.send_time, mode: p.mode || 'day', delay: p.delay_min || 0, after: p.after_id || null, run_at: p.run_at, audience: p.audience, catchup: !!p.catchup, pos: p.pos || 0,
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

  // файл для поста: загрузить в Telegram и вернуть file_id (пост сохраняется отдельно)
  if (path === '/upload' && request.method === 'POST') {
    let file;
    try { file = (await request.formData()).get('file'); } catch { file = null; }
    const r = await uploadFile(ctx, user, file, true);
    return json(r, r.error ? 400 : 200);
  }
  // превью картинки поста по file_id (только для админов — проверка выше)
  if (path === '/file') {
    const fid = url.searchParams.get('id') || '';
    if (!/^[\w-]{10,200}$/.test(fid)) return json({ error: 'Неверный файл' }, 400);
    try {
      const r = await ctx.tg.download(fid);
      return new Response(r.body, { headers: { 'content-type': r.headers.get('content-type') || 'image/jpeg', 'cache-control': 'private, max-age=600' } });
    } catch (e) { return json({ error: 'Не получилось загрузить превью' }, 400); }
  }

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
      docs: await loadDocs(ctx), docNames: DOCS, tracks: TRACKS, flow: await loadFlow(ctx), flowOptional: FLOW_OPTIONAL,
      fbCount: ((await ctx.db.first(`SELECT COUNT(*) AS n FROM users WHERE fb_at IS NOT NULL`)) || {}).n || 0,
      people: { all: people.n || 0, active: people.active || 0 },
      run: await activeRun(ctx.db, user.id),
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
    if (body.mode !== undefined && p.kind === 'drip') {
      if (!['day', 'timer', 'after'].includes(body.mode)) return json({ error: 'Неизвестный способ отправки' }, 400);
      put('mode', body.mode);
      if (body.mode !== 'day') {
        const dm = parseInt(body.delay_min, 10);
        if (!(dm >= 0 && dm <= 365 * 1440)) return json({ error: 'Время — от 0 минут до 365 дней' }, 400);
        put('delay_min', dm);
      }
      if (body.mode === 'after') {
        const aid = parseInt(body.after_id, 10);
        if (!aid || aid === p.id) return json({ error: 'Выбери пост, после которого отправлять' }, 400);
        // не даём сделать круг: A после B, B после A
        let cur = await ctx.db.first(`SELECT id, kind, mode, after_id FROM posts WHERE id = ?`, [aid]);
        if (!cur || !['drip', 'node', 'gift'].includes(cur.kind)) return json({ error: 'Такого поста нет' }, 400);
        for (let i = 0; cur && cur.mode === 'after' && i < 50; i++) {
          if (cur.after_id === p.id) return json({ error: 'Получится круг: тот пост уже идёт после этого' }, 400);
          cur = await ctx.db.first(`SELECT id, kind, mode, after_id FROM posts WHERE id = ?`, [cur.after_id]);
        }
        put('after_id', aid);
      }
    }
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
      const r = await cleanButtons(ctx, body.rows, id);
      if (r.error) return json({ error: r.error }, 400);
      put('buttons', r.rows.length ? JSON.stringify(r.rows) : null);
    }
    if (body.once !== undefined) put('once', body.once ? 1 : 0);
    if (body.track !== undefined) { if (!TRACKS[body.track]) return json({ error: 'Неизвестный трек' }, 400); put('track', body.track); }
    if (body.md !== undefined) {
      const f = mdToEntities(body.md);
      if (f.text.length > 4096) return json({ error: 'Текст длиннее 4096 знаков — Telegram не примет' }, 400);
      put('text', f.text); put('entities', JSON.stringify(f.entities));
    }
    if (body.files !== undefined) {
      const r = cleanFiles(body.files);
      if (r.error) return json({ error: r.error }, 400);
      put('media', JSON.stringify(r.files));
    }
    if (body.catchup !== undefined) put('catchup', body.catchup ? 1 : 0);
    if (body.run_at !== undefined && p.kind === 'date') { const t = Number(body.run_at); if (!(t > 0)) return json({ error: 'Неверная дата' }, 400); put('run_at', t); }
    if (set.length) await ctx.db.run(`UPDATE posts SET ${set.join(', ')} WHERE id = ?`, [...val, id]);
    let np = await ctx.db.first(`SELECT * FROM posts WHERE id = ?`, [id]);
    if (np.status === 'active' && !(np.text || '').trim() && !j(np.media, []).length) {
      await ctx.db.run(`UPDATE posts SET status = 'draft' WHERE id = ?`, [id]);
      return json({ error: 'Пустой пост нельзя включить — добавь текст или картинку. Остальное сохранено, пост в черновиках.' }, 400);
    }
    return json({ ok: true, post: postOut(np), reach: await audienceCount(ctx.db, np) });
  }

  // новый пост прямо из панели
  if (path === '/post/new' && request.method === 'POST') {
    const kind = body.kind;
    if (!['drip', 'date', 'gift', 'node', 'fb'].includes(kind)) return json({ error: 'Выбери, когда уходит пост' }, 400);
    const f = mdToEntities(body.md || '');
    const files = cleanFiles(body.files || []);
    if (files.error) return json({ error: files.error }, 400);
    if (f.text.length > 4096) return json({ error: 'Текст длиннее 4096 знаков — Telegram не примет' }, 400);
    const status = ['active', 'draft', 'paused'].includes(body.status) ? body.status : 'draft';
    // пустой можно сохранить только черновиком (например, пост-ответ, созданный из кнопки)
    if (!f.text.trim() && !files.files.length && status !== 'draft') return json({ error: 'Добавь текст или картинку' }, 400);
    if (status === 'active' && kind === 'date' && !(Number(body.run_at) > 0)) return json({ error: 'Сначала задай дату' }, 400);
    const audience = AUD[body.audience] ? body.audience : 'all';
    const day = Math.max(0, Math.min(365, parseInt(body.day, 10) || 0));
    const time = pad(body.time) || '11:00';
    const mode = ['day', 'timer', 'after'].includes(body.mode) ? body.mode : 'day';
    await ctx.db.run(
      `INSERT INTO posts (title, kind, audience, day, send_time, run_at, catchup, status, text, entities, media, buttons, created_by, created_at, mode, delay_min, after_id, once)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?)`,
      [String(body.title || '').slice(0, 80) || null, kind, audience, kind === 'drip' ? day : null, day === 0 && kind === 'drip' && mode === 'day' ? '00:00' : time,
        kind === 'date' ? (Number(body.run_at) || null) : null, body.catchup ? 1 : 0, status, f.text, JSON.stringify(f.entities), JSON.stringify(files.files),
        user.id, ctx.now, kind === 'drip' ? mode : 'day', Math.max(0, parseInt(body.delay_min, 10) || 0), parseInt(body.after_id, 10) || null, body.once ? 1 : 0]);
    const row = await ctx.db.first(`SELECT * FROM posts WHERE created_by = ? ORDER BY id DESC LIMIT 1`, [user.id]);
    if (TRACKS[body.track] && body.track !== 'all') await ctx.db.run(`UPDATE posts SET track = ? WHERE id = ?`, [body.track, row.id]);
    if (body.rows) {
      const r = await cleanButtons(ctx, body.rows, row.id);
      if (r.error) { await ctx.db.run(`UPDATE posts SET status = 'draft' WHERE id = ?`, [row.id]); return json({ error: r.error, post: postOut(row) }, 400); }
      if (r.rows.length) await ctx.db.run(`UPDATE posts SET buttons = ? WHERE id = ?`, [JSON.stringify(r.rows), row.id]);
    }
    const np = await ctx.db.first(`SELECT * FROM posts WHERE id = ?`, [row.id]);
    return json({ ok: true, post: postOut(np), reach: await audienceCount(ctx.db, np) });
  }

  // люди: контакты, выбор из аудита, отзывы о кабинете (последние 200)
  if (path === '/people') {
    const rows = await ctx.db.all(`SELECT tg_id, first_name, username, contact_name, phone, email, level, zone, track, status, fb_like, fb_improve, fb_at, created_at, sched_at FROM users ORDER BY COALESCE(fb_at, 0) DESC, created_at DESC LIMIT 200`);
    const n = await ctx.db.first(`SELECT COUNT(*) AS all_n, SUM(CASE WHEN sched_at IS NOT NULL THEN 1 ELSE 0 END) AS done, SUM(CASE WHEN track = 'course' THEN 1 ELSE 0 END) AS course, SUM(CASE WHEN track = 'mat' THEN 1 ELSE 0 END) AS mat, SUM(CASE WHEN fb_at IS NOT NULL THEN 1 ELSE 0 END) AS fb FROM users`);
    return json({ people: rows, totals: n });
  }

  // порядок и включение шагов входа
  if (path === '/flow' && request.method === 'POST') {
    const f = normFlow(body.order, body.off);
    const put = (k, v) => ctx.db.run(`INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`, [k, JSON.stringify(v)]);
    await put('flow:order', f.order);
    await put('flow:off', f.off);
    return json({ ok: true, flow: f });
  }

  // ссылки на документы (политика, согласие, оферта) и данные владельца
  if (path === '/docs' && request.method === 'POST') {
    for (const k of ['policy', 'consent', 'offer', 'owner']) {
      if (body[k] === undefined) continue;
      let v = String(body[k] || '').trim().slice(0, 400);
      if (k !== 'owner' && v) {
        if (/^t\.me\//i.test(v)) v = 'https://' + v;
        if (!/^https?:\/\/\S+$/i.test(v)) return json({ error: `Ссылка «${DOCS[k]}» должна начинаться с https://` }, 400);
      }
      if (v) await ctx.db.run(`INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`, ['doc:' + k, v]);
      else await ctx.db.run(`DELETE FROM settings WHERE key = ?`, ['doc:' + k]);
    }
    ctx._docs = null;
    return json({ ok: true, docs: await loadDocs(ctx) });
  }

  // перетаскивание: новый день, время и порядок сразу для нескольких постов
  if (path === '/reorder' && request.method === 'POST') {
    const items = Array.isArray(body.items) ? body.items.slice(0, 200) : [];
    for (const it of items) {
      const d = parseInt(it.day, 10), t = pad(it.time), pos = parseInt(it.pos, 10) || 0;
      if (!(d >= 0 && d <= 365) || !t) return json({ error: 'Неверный день или время' }, 400);
    }
    for (const it of items) {
      // перетаскивание = «в этот день»: пост по таймеру или «после поста» становится постом «в день и время»
      await ctx.db.run(`UPDATE posts SET day = ?, send_time = ?, pos = ?, mode = 'day' WHERE id = ? AND kind = 'drip'`, [parseInt(it.day, 10), pad(it.time), parseInt(it.pos, 10) || 0, +it.id]);
    }
    return json({ ok: true, n: items.length });
  }

  // проверка ленты на себе
  if (path === '/run/preview' && request.method === 'POST') {
    const level = ['start', 'pro'].includes(body.level) ? body.level : 'all';
    const job = runPreview(ctx, user.id, level).catch((e) => console.log('preview', e && e.stack));
    if (ctx.waitUntil) ctx.waitUntil(job); else await job;
    return json({ ok: true });
  }
  if (path === '/run/fast' && request.method === 'POST') {
    const level = ['start', 'pro'].includes(body.level) ? body.level : 'all';
    await startFastRun(ctx, user.id, level);
    const job = stepRuns(ctx, 12).catch((e) => console.log('run', e && e.stack));
    if (ctx.waitUntil) ctx.waitUntil(job); else await job;
    return json({ ok: true, run: await activeRun(ctx.db, user.id) });
  }
  // пройти путь ученика заново: анкета админа сбрасывается, бот ведёт по входу как нового человека
  if (path === '/run/onboarding' && request.method === 'POST') {
    const id = user.id;
    for (const t of ['users', 'consents', 'states']) await ctx.db.run(`DELETE FROM ${t} WHERE tg_id = ?`, [id]);
    await ctx.db.run(`DELETE FROM deliveries WHERE tg_id = ? AND post_id IN (SELECT id FROM posts WHERE kind IN ('gift', 'fb', 'node'))`, [id]);
    await ctx.db.run(`DELETE FROM settings WHERE key = ? OR key LIKE ?`, ['nogift:' + id, 'start:' + id + ':%']);
    await ctx.tg.call('sendMessage', { chat_id: id, text: '🧪 Проходим путь ученика заново' + (body.fromTest ? ' — как будто ты пришла из теста.' : ' — как будто ты пришла без теста.') + ' Твоя анкета сброшена, ответь на вопросы бота.', disable_notification: true }).catch(() => {});
    const job = onStart(ctx, { from: { id, first_name: user.first_name, username: user.username }, message_id: 0 }, body.fromTest ? 'audit_P_' + (body.level === 'pro' ? 'pro' : 'start') + (body.track === 'course' ? '_course' : body.track === 'mat' ? '_month' : '') : '').catch((e) => console.log('onboarding', e && e.stack));
    if (ctx.waitUntil) ctx.waitUntil(job); else await job;
    return json({ ok: true });
  }
  if (path === '/run/stop' && request.method === 'POST') {
    await stopRuns(ctx, user.id);
    await ctx.tg.call('sendMessage', { chat_id: user.id, text: '⏹ Ускоренный тест остановлен' }).catch(() => {});
    return json({ ok: true });
  }

  m = /^\/post\/(\d+)\/preview$/.exec(path);
  if (m && request.method === 'POST') {
    const p = await ctx.db.first(`SELECT * FROM posts WHERE id = ?`, [+m[1]]);
    if (!p) return json({ error: 'Пост не найден' }, 404);
    try {
      const r = await sendPost(ctx.tg, user.id, p, { uid: user.id, publicUrl: ctx.publicUrl, arrow: await btn(ctx, 'buttonsArrow'), docs: await loadDocs(ctx) });
      return json({ ok: true, warn: r.warn });
    } catch (e) { return json({ error: 'Telegram не принял пост: ' + e.message }, 400); }
  }

  m = /^\/msg\/([A-Za-z_]+)$/.exec(path);
  if (m && request.method === 'POST') {
    try {
      if (body.reset) await resetMsg(ctx, m[1]);
      else if (body.removeMedia) await setMsgMedia(ctx, m[1], null);
      else {
        // пауза перед сообщением и свои кнопки-ссылки
        if (body.delay !== undefined || body.links !== undefined) await saveMsgExtra(ctx, m[1], { delay: body.delay, links: body.links });
        if (body.text === undefined) return json({ ok: true, msgs: await listMsgs(ctx) });
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
    await say(ctx, user.id, m[1], { уровень: LEVELS.start, ...(await docVars(ctx)) });
    return json({ ok: true });
  }

  return json({ error: 'Нет такого действия' }, 404);
}

// Кнопки под постом: до 10 рядов, до 4 в ряд, текст до 60 знаков.
//   {text, url} ссылка https:// · {text, go} другой пост бота · {text, doc} документ · {text, pay} оплата тарифа
export async function cleanButtons(ctx, rowsIn, selfId) {
  if (!Array.isArray(rowsIn) || rowsIn.length > 10) return { error: 'Слишком много рядов (до 10)' };
  const rows = [];
  for (const row of rowsIn) {
    if (!Array.isArray(row)) return { error: 'Неверные кнопки' };
    const r = [];
    for (const b of row) {
      if (!b) continue;
      const text = String(b.text || '').trim().slice(0, 60);
      let link = String(b.url || '').trim();
      const go = parseInt(b.go, 10) || null;
      if (!text && !link && !go && !b.doc && !b.pay) continue;
      if (!text) return { error: 'У кнопки нет текста' };
      if (go) {
        if (go === selfId) return { error: `Кнопка «${text}» ведёт на этот же пост` };
        const t = await ctx.db.first(`SELECT id FROM posts WHERE id = ? AND status != 'archived'`, [go]);
        if (!t) return { error: `Пост для кнопки «${text}» не найден` };
        r.push({ text, go }); continue;
      }
      if (b.doc) { if (!DOCS[b.doc]) return { error: 'Неизвестный документ' }; r.push({ text, doc: b.doc }); continue; }
      if (b.pay) { const pay = ['curator', 'mentor'].includes(b.pay) ? b.pay : 'curator'; r.push({ text, pay }); continue; }
      if (/^t\.me\//i.test(link)) link = 'https://' + link;
      if (!/^https?:\/\/\S+$/i.test(link)) return { error: `Ссылка у кнопки «${text}» должна начинаться с https://` };
      r.push({ text, url: link });
    }
    if (r.length > 4) return { error: 'В одном ряду не больше 4 кнопок' };
    if (r.length) rows.push(r);
  }
  return { rows };
}

const FILE_TYPES = ['photo', 'video', 'document', 'animation'];
function cleanFiles(list) {
  if (!Array.isArray(list)) return { error: 'Неверные вложения' };
  if (list.length > 10) return { error: 'Не больше 10 вложений' };
  const files = [];
  for (const f of list) {
    if (!f || !FILE_TYPES.includes(f.type) || !/^[\w-]{10,200}$/.test(String(f.file_id || ''))) return { error: 'Неверное вложение' };
    files.push({ type: f.type, file_id: String(f.file_id) });
  }
  // в альбоме Telegram не даёт смешивать файлы с фото и видео
  if (files.length > 1 && files.some((f) => f.type === 'document') && files.some((f) => f.type !== 'document')) return { error: 'В одном посте нельзя смешивать файлы с картинками и видео' };
  return { files };
}

// Загрузка файла: отправляем админу в бот, берём file_id и это сообщение сразу убираем
async function uploadFile(ctx, user, file, allowDocs) {
  if (!file || typeof file === 'string') return { error: 'Файл не пришёл' };
  const type = (file.type || '').toLowerCase();
  let kind = type === 'image/gif' ? 'animation' : /^image\/(jpeg|png|webp)$/.test(type) ? 'photo' : type.startsWith('video/') ? 'video' : null;
  if (!kind && allowDocs) kind = 'document';
  if (!kind) return { error: 'Нужна картинка (jpg, png, webp, gif) или видео mp4' };
  const max = kind === 'photo' ? 10 : 50;
  if (file.size > max * 1024 * 1024) return { error: `Файл больше ${max} МБ — Telegram такой не примет` };
  const form = new FormData();
  form.append('chat_id', String(user.id));
  form.append('disable_notification', 'true');
  form.append(kind, file, file.name || 'file');
  let res;
  try { res = await ctx.tg.upload({ photo: 'sendPhoto', video: 'sendVideo', animation: 'sendAnimation', document: 'sendDocument' }[kind], form); }
  catch (e) { return { error: 'Telegram не принял файл: ' + e.message }; }
  const fid = kind === 'photo' ? res.photo && res.photo[res.photo.length - 1].file_id : (res[kind] || res.document || res.video || res.animation || {}).file_id;
  if (!fid) return { error: 'Telegram не вернул файл' };
  await ctx.tg.call('deleteMessage', { chat_id: user.id, message_id: res.message_id }).catch(() => {});
  return { ok: true, file: { type: kind, file_id: fid, name: file.name || '' } };
}
