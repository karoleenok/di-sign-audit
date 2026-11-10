// Видеоурок из YouTube: кнопка под постом открывает мини-аппку с плеером (страница /watch).
// Здесь только чистая логика: разбор ссылки и глав, проверка кнопки, доступ и запоминание места просмотра.
// Проверка подписи Telegram и список админов делает вызывающий код (watch-route.js), сюда приходит уже проверенный человек.

const j = (s, d) => { try { return s ? JSON.parse(s) : d; } catch { return d; } };
const ID = /^[\w-]{11}$/;

// ссылка или голый ID -> ID видео (11 знаков). Понимает youtu.be, watch?v=, embed, live, shorts
export function parseYouTubeId(input) {
  const s = String(input || '').trim();
  if (ID.test(s)) return s;
  let u;
  try { u = new URL(/^https?:\/\//i.test(s) ? s : 'https://' + s); } catch { return null; }
  const h = u.hostname.toLowerCase().replace(/^(www|m|music)\./, '');
  let id = null;
  if (h === 'youtu.be') id = u.pathname.split('/')[1];
  else if (h === 'youtube.com' || h === 'youtube-nocookie.com') {
    if (u.pathname === '/watch') id = u.searchParams.get('v');
    else { const m = /^\/(?:embed|live|shorts|v)\/([\w-]{11})(?:[/?]|$)/.exec(u.pathname); id = m && m[1]; }
  }
  return id && ID.test(id) ? id : null;
}

// «1:05:30» / «12:30» -> секунды
export const fmtClock = (sec) => {
  const s = Math.max(0, Math.floor(Number(sec) || 0)), h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = s % 60;
  return (h ? h + ':' + String(m).padStart(2, '0') : String(m)) + ':' + String(r).padStart(2, '0');
};

// Главы: по строке на главу, «12:30 Название». Подходят «[12:30] Название», «12:30 — Название»
const LINE = /^\W*(?:(\d{1,2}):)?(\d{1,2}):(\d{2})\s*[-–—.:)\]]*\s*(.*)$/;
export function parseChapters(text) {
  const out = [];
  for (const raw of String(text || '').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const m = LINE.exec(line);
    const h = m && m[1] !== undefined ? +m[1] : 0, mi = m ? +m[2] : 0, s = m ? +m[3] : 0;
    if (!m || s > 59 || (m[1] !== undefined && mi > 59)) return { error: `Не понял строку «${line.slice(0, 40)}». Пиши время и название, например: 12:30 Что такое иерархия` };
    const title = m[4].trim().slice(0, 80);
    if (!title) return { error: `У главы «${line.slice(0, 20)}» нет названия` };
    out.push({ t: h * 3600 + mi * 60 + s, title });
  }
  if (out.length > 40) return { error: 'Глав слишком много (до 40)' };
  out.sort((a, b) => a.t - b.t);
  for (let i = 1; i < out.length; i++) if (out[i].t === out[i - 1].t) return { error: `Две главы на одном времени (${fmtClock(out[i].t)})` };
  return { ch: out };
}
export const chaptersText = (ch) => (ch || []).map((c) => `${fmtClock(c.t)} ${c.title}`).join('\n');

// что хранится в кнопке: { id, ch: [{t, title}] }. На входе — { url, ch: «текст» } из панели
export function cleanVideo(v) {
  if (!v || typeof v !== 'object') return { error: 'Не заполнено видео' };
  const id = parseYouTubeId(v.url || v.id);
  if (!id) return { error: 'Не получилось понять ссылку на YouTube. Вставь ссылку вида youtu.be/… или youtube.com/watch?v=…' };
  let ch = [];
  if (Array.isArray(v.ch)) {
    ch = v.ch.filter((c) => c && Number.isFinite(+c.t) && String(c.title || '').trim()).map((c) => ({ t: Math.max(0, Math.floor(+c.t)), title: String(c.title).trim().slice(0, 80) })).slice(0, 40);
  } else if (typeof v.ch === 'string' && v.ch.trim()) {
    const r = parseChapters(v.ch);
    if (r.error) return r;
    ch = r.ch;
  }
  return { video: { id, ch } };
}

// кому можно смотреть: админам всегда, ученикам — только когда пост с кнопкой им пришёл
async function access(ctx, { user, admin, pid, bid }) {
  const m = /^(\d+)-(\d+)$/.exec(String(bid || ''));
  const id = Number(pid);
  if (!m || !Number.isInteger(id) || id <= 0) return { code: 404, error: 'Урок не найден' };
  const post = await ctx.db.first(`SELECT id, title, text, buttons FROM posts WHERE id = ?`, [id]);
  const b = post && (j(post.buttons, [])[+m[1]] || [])[+m[2]];
  if (!b || !b.video || !ID.test(String(b.video.id || ''))) return { code: 404, error: 'Урок не найден' };
  if (!admin) {
    const d = await ctx.db.first(`SELECT 1 AS x FROM deliveries WHERE post_id = ? AND tg_id = ? AND ok = 1`, [id, user.id]);
    if (!d) return { code: 403, error: 'Не получилось проверить доступ. Закрой урок и открой его из бота ещё раз через минуту.' };
  }
  return { post, b, id, bid: `${+m[1]}-${+m[2]}` };
}

// название урока на странице: заголовок поста, иначе первая строка его текста, иначе «Урок»
function lessonTitle(post) {
  const t = String(post.title || '').trim() || String(post.text || '').split(/\r?\n/).map((x) => x.trim()).find(Boolean) || '';
  return t.slice(0, 80) || 'Урок';
}

// открыть урок: отдаём ID видео, главы и место, где человек остановился. ID не лежит ни в сообщении, ни в странице — только здесь
export async function loadWatch(ctx, { user, admin, pid, bid }) {
  const a = await access(ctx, { user, admin, pid, bid });
  if (a.error) return a;
  const pr = await ctx.db.first(`SELECT sec, dur FROM watch_progress WHERE tg_id = ? AND post_id = ? AND btn = ?`, [user.id, a.id, a.bid]);
  // нажатие считаем один раз за 10 минут, чтобы возврат к уроку не раздувал статистику
  await ctx.db.run(
    `INSERT INTO clicks (post_id, tg_id, btn, at) SELECT ?, ?, ?, ? WHERE NOT EXISTS (SELECT 1 FROM clicks WHERE post_id = ? AND tg_id = ? AND btn = ? AND at > ?)`,
    [a.id, user.id, a.b.text, ctx.now, a.id, user.id, a.b.text, ctx.now - 600]);
  return {
    code: 200,
    data: {
      id: a.b.video.id, ch: a.b.video.ch || [], title: lessonTitle(a.post),
      name: String(user.first_name || '').slice(0, 40), uid: user.id, admin: !!admin,
      resume: pr ? pr.sec : 0, dur: pr ? pr.dur : 0,
    },
  };
}

// запомнить, где человек остановился (раз в ~15 секунд, на паузе и при выходе)
export async function saveWatch(ctx, { user, admin, pid, bid, sec, dur }) {
  const a = await access(ctx, { user, admin, pid, bid });
  if (a.error) return a;
  let s = Math.floor(Number(sec)), d = Math.floor(Number(dur));
  if (!Number.isFinite(s) || s < 0 || s > 86400) return { code: 400, error: 'Неверное время' };
  if (!Number.isFinite(d) || d < 0 || d > 86400) d = 0;
  const max = s;
  if (d && s >= d - 20) s = 0; // досмотрел до конца: в следующий раз начнём с начала
  await ctx.db.run(
    `INSERT INTO watch_progress (tg_id, post_id, btn, sec, max_sec, dur, at) VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(tg_id, post_id, btn) DO UPDATE SET sec = excluded.sec, max_sec = MAX(max_sec, excluded.max_sec), dur = CASE WHEN excluded.dur > 0 THEN excluded.dur ELSE dur END, at = excluded.at`,
    [user.id, a.id, a.bid, s, max, d, ctx.now]);
  return { code: 200, data: { ok: true } };
}
