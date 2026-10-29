import { AUD, ZONES, T } from './texts.js';
import { fmtTime, fmtWhen, MSK, DAY } from './time.js';

const CAPTION_MAX = 1024;
const j = (s, d) => { try { return s ? JSON.parse(s) : d; } catch { return d; } };

// Кнопки поста: [[{text,url}], ...]. Ссылки идут через наш адрес /r/..., чтобы считать нажатия.
export function keyboard(post, uid, publicUrl) {
  const rows = j(post.buttons, []);
  if (!rows.length) return undefined;
  return {
    inline_keyboard: rows.map((row, ri) => row.map((b, bi) => ({
      text: b.text,
      url: publicUrl && post.id ? `${publicUrl}/r/${post.id}/${ri}-${bi}/${uid || 0}` : b.url,
    }))),
  };
}

const stripCustom = (ents) => (ents || []).filter((e) => e.type !== 'custom_emoji');
const hasCustom = (ents) => (ents || []).some((e) => e.type === 'custom_emoji');

// Отправить пост одному человеку. Возвращает { warn } если премиум-эмодзи пришлось убрать.
export async function sendPost(tg, chatId, post, { uid, publicUrl, arrow } = {}) {
  const text = post.text || '';
  const ents = j(post.entities, []);
  const media = j(post.media, []);
  const kb = keyboard(post, uid, publicUrl);
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
  if (post.zone) { c += ` AND u.zone = ?`; p.push(post.zone); }
  return { c, p };
}
const BASE = `u.status = 'active' AND u.consent_ads_at IS NOT NULL AND u.joined_at IS NOT NULL AND u.paid_at IS NULL`;
const NOT_SENT = `NOT EXISTS (SELECT 1 FROM deliveries d WHERE d.post_id = ? AND d.tg_id = u.tg_id)`;

// Лента по дням: когда этому человеку положен пост
//   день 0  -> сразу после входа
//   день N  -> полночь по Москве дня входа + N дней + время отправки
export function dueSql(post) {
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
  if (p.kind === 'gift') return `подарок · зона «${ZONES[p.zone] || p.zone}»`;
  if (p.kind === 'date') return p.run_at ? `дата ${fmtWhen(p.run_at)}` : 'дата не задана';
  return Number(p.day) === 0 ? 'день 0 · сразу' : `день ${p.day} · ${p.send_time}`;
}
export function postSummary(p) {
  const st = { draft: '📝 черновик', active: '✅ включён', paused: '⏸ на паузе', archived: '🗄 в архиве' }[p.status] || p.status;
  const btns = j(p.buttons, []).flat().length;
  return [
    `#${p.id} · ${st}`,
    `Когда: ${postWhen(p)}`,
    `Кому: ${AUD[p.audience] || p.audience}${p.zone && p.kind !== 'gift' ? ` · зона «${ZONES[p.zone] || p.zone}»` : ''}`,
    `Кнопок: ${btns}${p.kind === 'drip' ? ` · догонять опоздавших: ${p.catchup ? 'да' : 'нет'}` : ''}`,
  ].join('\n');
}
export { fmtTime };
