import { AUD, T } from './texts.js';
import { fmtTime, fmtWhen, MSK, DAY } from './time.js';

const CAPTION_MAX = 1024;
const j = (s, d) => { try { return s ? JSON.parse(s) : d; } catch { return d; } };

// Кнопки поста: [[{text, url} | {text, go} | {text, doc} | {text, pay}], ...]
//   url — ссылка (идёт через наш адрес /r/..., чтобы считать нажатия)
//   go  — открыть другой пост этого бота (пост-ответ, развилка)
//   doc — документ: политика, согласие, оферта (ссылка из настроек панели)
//   pay — оплата тарифа (продамус подключим позже — пока кнопка отвечает «скоро»)
export const TRACKS = { all: 'всем', course: 'мини-курс', mat: 'материалы' };
export const DOCS = { policy: 'Политика обработки данных', consent: 'Согласие на обработку данных', offer: 'Оферта' };
export function keyboard(post, uid, publicUrl, docs) {
  const rows = j(post.buttons, []);
  if (!rows.length) return undefined;
  const out = rows.map((row, ri) => row.map((b, bi) => {
    if (b.go) return { text: b.text, callback_data: post.id ? `go:${post.id}:${ri}-${bi}` : 'go:x' };
    if (b.pay) return { text: b.text, callback_data: post.id ? `buy:${post.id}:${ri}-${bi}` : 'buy:x' };
    if (b.doc) { const u = docs && docs[b.doc]; return u ? { text: b.text, url: u } : null; }
    return { text: b.text, url: publicUrl && post.id ? `${publicUrl}/r/${post.id}/${ri}-${bi}/${uid || 0}` : b.url };
  }).filter(Boolean)).filter((r) => r.length);
  return out.length ? { inline_keyboard: out } : undefined;
}

const stripCustom = (ents) => (ents || []).filter((e) => e.type !== 'custom_emoji');
const hasCustom = (ents) => (ents || []).some((e) => e.type === 'custom_emoji');

// Отправить пост одному человеку. Возвращает { warn } если премиум-эмодзи пришлось убрать.
export async function sendPost(tg, chatId, post, { uid, publicUrl, arrow, docs, extraRows } = {}) {
  const text = post.text || '';
  const ents = j(post.entities, []);
  const media = j(post.media, []);
  let kb = keyboard(post, uid, publicUrl, docs);
  if (extraRows && extraRows.length) kb = { inline_keyboard: [...((kb && kb.inline_keyboard) || []), ...extraRows] };
  let warn = null;

  const attempt = async (entities) => {
    if (!media.length) {
      await tg.call('sendMessage', { chat_id: chatId, text: text || '…', entities, reply_markup: kb, link_preview_options: { is_disabled: true } });
      return;
    }
    const fits = text.length <= CAPTION_MAX;
    if (media.length === 1) {
      const m = media[0];
      const method = { photo: 'sendPhoto', video: 'sendVideo', document: 'sendDocument', animation: 'sendAnimation' }[m.type] || 'sendDocument';
      const p = { chat_id: chatId, [m.type in { photo: 1, video: 1, document: 1, animation: 1 } ? m.type : 'document']: m.file_id };
      if (fits) { p.caption = text; p.caption_entities = entities; p.reply_markup = kb; }
      await tg.call(method, p);
      if (!fits) await tg.call('sendMessage', { chat_id: chatId, text, entities, reply_markup: kb, link_preview_options: { is_disabled: true } });
      return;
    }
    // Альбом: до 10 штук. Кнопки к альбому Telegram прикрепить не даёт — отправляем их следом.
    const group = media.slice(0, 10).map((m, i) => {
      const it = { type: m.type === 'animation' ? 'video' : m.type, media: m.file_id };
      if (i === 0 && fits && text) { it.caption = text; it.caption_entities = entities; }
      return it;
    });
    await tg.call('sendMediaGroup', { chat_id: chatId, media: group });
    if (!fits) await tg.call('sendMessage', { chat_id: chatId, text, entities, reply_markup: kb, link_preview_options: { is_disabled: true } });
    else if (kb) await tg.call('sendMessage', { chat_id: chatId, text: post.btn_text || arrow || T.buttonsArrow, reply_markup: kb });
  };

  try {
    await attempt(ents);
  } catch (e) {
    // Если Telegram не принял премиум-эмодзи — отправим без них и предупредим админа
    if (hasCustom(ents) && e.code === 400) {
      await attempt(stripCustom(ents));
      warn = 'Премиум-эмодзи не прошли и были заменены обычными: ' + e.message;
    } else throw e;
  }
  return { warn };
}

// ----- кому отправлять -----
function audienceSql(post) {
  let c = '';
  const p = [];
  if (post.audience === 'start') c += ` AND u.level = 'start'`;
  else if (post.audience === 'pro') c += ` AND u.level = 'pro'`;
  // трек из аудита: мини-курс или материалы
  if (post.track === 'course' || post.track === 'mat') { c += ` AND u.track = ?`; p.push(post.track); }
  return { c, p };
}
const BASE = `u.status = 'active' AND u.consent_ads_at IS NOT NULL AND u.joined_at IS NOT NULL AND u.paid_at IS NULL`;
const NOT_SENT = `NOT EXISTS (SELECT 1 FROM deliveries d WHERE d.post_id = ? AND d.tg_id = u.tg_id)`;

// Лента по дням: когда этому человеку положен пост
//   день 0  -> сразу после входа
//   день N  -> полночь по Москве дня входа + N дней + время отправки
export function dueSql(post) {
  const delay = (Number(post.delay_min) || 0) * 60;
  // по таймеру: через N минут после входа
  if (post.mode === 'timer') return `(u.joined_at + ${delay})`;
  // после другого поста: через N минут после того, как этот человек получил тот пост
  if (post.mode === 'after') return `((SELECT d2.sent_at FROM deliveries d2 WHERE d2.post_id = ${Number(post.after_id) || 0} AND d2.tg_id = u.tg_id AND d2.ok = 1) + ${delay})`;
  const tod = timeSec(post.send_time);
  return Number(post.day) === 0
    ? `u.joined_at`
    : `(((u.joined_at + ${MSK}) / ${DAY}) * ${DAY} - ${MSK} + ${Number(post.day) * DAY} + ${tod})`;
}
export function timeSec(s) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(s || '11:00');
  return m ? +m[1] * 3600 + +m[2] * 60 : 11 * 3600;
}

export async function dueUsers(db, post, now, limit) {
  const a = audienceSql(post);
  if (post.kind === 'drip') {
    const due = dueSql(post);
    const catchup = post.catchup ? '' : ` AND ${due} >= ?`;
    const params = [...a.p, now, post.id, ...(post.catchup ? [] : [post.created_at]), limit];
    return db.all(
      `SELECT u.tg_id FROM users u WHERE ${BASE}${a.c} AND ${due} <= ? AND ${NOT_SENT}${catchup} ORDER BY u.joined_at LIMIT ?`,
      params,
    );
  }
  if (post.kind === 'date') {
    // только те, кто был в боте к моменту отправки
    const params = [...a.p, post.id, post.run_at, limit];
    return db.all(`SELECT u.tg_id FROM users u WHERE ${BASE}${a.c} AND ${NOT_SENT} AND u.joined_at <= ? ORDER BY u.joined_at LIMIT ?`, params);
  }
  return [];
}

// Кому пост уйдёт вообще (для подсказки админу)
export async function audienceCount(db, post) {
  const a = audienceSql(post);
  const r = await db.first(`SELECT COUNT(*) AS n FROM users u WHERE ${BASE}${a.c}`, a.p);
  return r ? r.n : 0;
}

// Записать отправки одним запросом (экономим лимиты бесплатного Cloudflare)
export async function recordDeliveries(db, postId, rows, now) {
  if (!rows.length) return;
  const vals = rows.map(() => '(?, ?, ?, ?)').join(', ');
  const params = [];
  rows.forEach((r) => params.push(postId, r.tg_id, now, r.ok ? 1 : 0));
  await db.run(`INSERT OR IGNORE INTO deliveries (post_id, tg_id, sent_at, ok) VALUES ${vals}`, params);
}

// ----- описание поста для админки -----
export function postLabel(p) {
  const t = (p.title || p.text || '').replace(/\s+/g, ' ').trim().slice(0, 38) || 'без текста';
  const media = j(p.media, []);
  const ic = media.length > 1 ? `🖼×${media.length} ` : media.length ? '🖼 ' : '';
  return `${ic}${t}`;
}
export function postWhen(p) {
  if (p.kind === 'gift') return 'подарок после теста';
  if (p.kind === 'node') return 'по нажатию кнопки';
  if (p.kind === 'fb') return 'бонус за отзыв о кабинете';
  if (p.kind === 'date') return p.run_at ? `дата ${fmtWhen(p.run_at)}` : 'дата не задана';
  if (p.mode === 'timer') return `через ${fmtDelay(p.delay_min)} после входа`;
  if (p.mode === 'after') return `через ${fmtDelay(p.delay_min)} после поста #${p.after_id}`;
  return Number(p.day) === 0 ? 'день 0 · сразу' : `день ${p.day} · ${p.send_time}`;
}
export function postSummary(p) {
  const st = { draft: '📝 черновик', active: '✅ включён', paused: '⏸ на паузе', archived: '🗄 в архиве' }[p.status] || p.status;
  const btns = j(p.buttons, []).flat().length;
  return [
    `#${p.id} · ${st}`,
    `Когда: ${postWhen(p)}`,
    ...(p.kind === 'node' ? [] : [`Кому: ${AUD[p.audience] || p.audience}`]),
    `Кнопок: ${btns}${p.kind === 'drip' ? ` · догонять опоздавших: ${p.catchup ? 'да' : 'нет'}` : ''}`,
  ].join('\n');
}
export { fmtTime };

// «через 30 мин», «через 2 ч», «через 3 дн», «через 1 дн 4 ч»
export function fmtDelay(min) {
  const m = Number(min) || 0;
  if (m === 0) return '0 мин (сразу)';
  const d = Math.floor(m / 1440), h = Math.floor((m % 1440) / 60), mm = m % 60;
  return [d ? d + ' дн' : '', h ? h + ' ч' : '', mm ? mm + ' мин' : ''].filter(Boolean).join(' ');
}

// Смещение поста от входа человека, в минутах — для порядка в ленте и для тестового прогона.
// Вход считаем в 10:00 по Москве (как средний случай). Цепочки «после поста» разворачиваем.
export function offsetMin(p, byId, depth = 0) {
  if (!p || depth > 20) return 0;
  if (p.mode === 'timer') return Number(p.delay_min) || 0;
  if (p.mode === 'after') return offsetMin(byId[p.after_id], byId, depth + 1) + (Number(p.delay_min) || 0);
  const day = Number(p.day) || 0;
  if (day === 0) return 0;
  const t = timeSec(p.send_time) / 60;
  return day * 1440 + t - 600;
}

// Ссылки на документы: из панели (settings doc:*), если там пусто — из настроек Cloudflare
export async function loadDocs(ctx) {
  if (ctx._docs) return ctx._docs;
  const rows = await ctx.db.all(`SELECT key, value FROM settings WHERE key LIKE 'doc:%'`);
  const o = Object.fromEntries(rows.map((r) => [r.key.slice(4), r.value]));
  const env = ctx.env || {};
  ctx._docs = {
    policy: o.policy || env.POLICY_URL || '',
    consent: o.consent || env.CONSENT_URL || '',
    offer: o.offer || env.OFFER_URL || '',
    owner: o.owner || env.OWNER_INFO || '',
  };
  return ctx._docs;
}
