import { ZONES, LEVELS } from './texts.js';
import { say, btn, msg as msgText } from './msgs.js';
import { sendPost, recordDeliveries } from './posts.js';

const CONSENT_VERSION = 'v1';

// Метка из ссылки теста: audit_<зона>_<уровень>, например audit_P_start, audit_top_pro
export function parseStart(payload) {
  const out = { source: payload || null, zone: null, levelRaw: null };
  const m = /^audit_([A-Za-z]+)_([a-z]+)$/.exec(payload || '');
  if (m) {
    const z = m[1] === 'top' ? 'top' : m[1].toUpperCase();
    if (ZONES[z]) out.zone = z;
    if (['start', 'free', 'pro'].includes(m[2])) out.levelRaw = m[2];
  }
  return out;
}
export const normLevel = (raw) => (raw === 'start' ? 'start' : raw === 'free' || raw === 'pro' ? 'pro' : null);

const kb = (rows) => ({ inline_keyboard: rows });

// ссылки на документы для подстановок {политика}, {согласие}, {оферта}, {владелец}
const docVars = (ctx) => ({
  политика: ctx.env.POLICY_URL || '— ссылка появится перед запуском —',
  согласие: ctx.env.CONSENT_URL || '— ссылка появится перед запуском —',
  оферта: ctx.env.OFFER_URL || '— скоро —',
  владелец: ctx.env.OWNER_INFO || '',
});

async function askLevel(ctx, id) {
  return tech(ctx, id, say(ctx, id, 'askLevel', {}, {
    reply_markup: kb([[{ text: await btn(ctx, 'levelBtnStart'), callback_data: 'lv:start' }], [{ text: await btn(ctx, 'levelBtnPro'), callback_data: 'lv:pro' }]]),
  }));
}

// ---------- «чистый» чат ----------
// Служебные сообщения (согласия, вопросы, предложение теста) запоминаем и убираем, когда они уже не нужны:
// Telegram сам красиво растворяет удалённое сообщение. Между сообщениями — пауза с «печатает…».
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function pause(ctx, id, ms) {
  const k = ctx.env.DELAY_FACTOR === undefined ? 1 : Number(ctx.env.DELAY_FACTOR);
  if (!(k > 0)) return;
  await ctx.tg.call('sendChatAction', { chat_id: id, action: 'typing' }).catch(() => {});
  await sleep(ms * k);
}
const techList = (u) => { try { return u && u.tech ? JSON.parse(u.tech) : []; } catch { return []; } };
async function tech(ctx, id, sending) {
  const m = await sending;
  if (m && m.message_id) {
    const u = await getUser(ctx, id);
    if (u) await ctx.db.run(`UPDATE users SET tech = ? WHERE tg_id = ?`, [JSON.stringify([...techList(u), m.message_id].slice(-20)), id]);
  }
  return m;
}
const delMsg = (ctx, id, mid) => mid ? ctx.tg.call('deleteMessage', { chat_id: id, message_id: mid }).catch(() => {}) : null;
async function untech(ctx, id, mid) {
  await delMsg(ctx, id, mid);
  const u = await getUser(ctx, id);
  if (u) await ctx.db.run(`UPDATE users SET tech = ? WHERE tg_id = ?`, [JSON.stringify(techList(u).filter((x) => x !== mid)), id]);
}
async function cleanAll(ctx, id) {
  const u = await getUser(ctx, id);
  const list = techList(u);
  if (!list.length) return;
  for (const mid of list) await delMsg(ctx, id, mid);
  await ctx.db.run(`UPDATE users SET tech = NULL WHERE tg_id = ?`, [id]);
}

export async function getUser(ctx, id) {
  return ctx.db.first(`SELECT * FROM users WHERE tg_id = ?`, [id]);
}

async function logConsent(ctx, id, kind, granted) {
  await ctx.db.run(`INSERT INTO consents (tg_id, kind, granted, version, at) VALUES (?, ?, ?, ?, ?)`, [id, kind, granted ? 1 : 0, CONSENT_VERSION, ctx.now]);
}

export async function onStart(ctx, msg, payload) {
  const from = msg.from;
  const st = parseStart(payload);
  let u = await getUser(ctx, from.id);
  if (!u) {
    await ctx.db.run(
      `INSERT INTO users (tg_id, first_name, username, level_raw, level, zone, source, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'new', ?)`,
      [from.id, from.first_name || null, from.username || null, st.levelRaw, normLevel(st.levelRaw), st.zone, st.source, ctx.now],
    );
  } else {
    // пришёл ещё раз: обновим результат теста, если он новый
    if (st.zone || st.levelRaw) {
      await ctx.db.run(`UPDATE users SET zone = COALESCE(?, zone), level_raw = COALESCE(?, level_raw), level = COALESCE(?, level), source = COALESCE(?, source) WHERE tg_id = ?`,
        [st.zone, st.levelRaw, normLevel(st.levelRaw), st.source, from.id]);
    }
    if (u.status === 'stopped' || u.status === 'blocked') await ctx.db.run(`UPDATE users SET status = 'new' WHERE tg_id = ?`, [from.id]);
  }
  // убираем саму команду /start и старые служебные сообщения (прошлое приветствие, вопросы, предложение теста)
  await delMsg(ctx, from.id, msg.message_id);
  await cleanAll(ctx, from.id);
  u = await getUser(ctx, from.id);
  const name = from.first_name || 'друг';
  // зона из теста запоминается только как отметка «прошёл тест» — посты и подарки по зонам не делим
  await tech(ctx, from.id, say(ctx, from.id, st.zone ? 'helloTest' : 'hello', { имя: name }));
  return nextStep(ctx, u);
}

// Пошаговый вход: согласие -> уровень -> (тест) -> подарок -> согласие на рассылку
export async function nextStep(ctx, u) {
  const id = u.tg_id;
  if (!u.consent_pd_at) {
    await pause(ctx, id, 900);
    return tech(ctx, id, say(ctx, id, 'consentPd', docVars(ctx), {
      link_preview_options: { is_disabled: true },
      reply_markup: kb([[{ text: await btn(ctx, 'consentPdBtn'), callback_data: 'c:pd' }]]),
    }));
  }
  if (!u.level) { await pause(ctx, id, 700); return askLevel(ctx, id); }
  if (!u.zone) {
    // ещё не проходил тест: предлагаем пройти, по кнопке в конце теста он вернётся в бот (тогда это сообщение уберём)
    const url = ctx.env.TEST_URL;
    await pause(ctx, id, 800);
    await tech(ctx, id, say(ctx, id, 'testOffer', {}, url ? { reply_markup: kb([[{ text: await btn(ctx, 'testBtn'), url }]]) } : {}));
  } else {
    // прошёл тест — подарок (один раз): общий и/или под его уровень
    await pause(ctx, id, 800);
    await sendGift(ctx, u);
  }
  if (!u.consent_ads_at && u.status !== 'stopped') {
    await pause(ctx, id, 1200);
    return tech(ctx, id, say(ctx, id, 'consentAds', {}, {
      reply_markup: kb([[{ text: await btn(ctx, 'consentAdsYes'), callback_data: 'c:ads:1' }, { text: await btn(ctx, 'consentAdsNo'), callback_data: 'c:ads:0' }]]),
    }));
  }
  if (u.consent_ads_at && u.status !== 'active') {
    await ctx.db.run(`UPDATE users SET status = 'active', joined_at = COALESCE(joined_at, ?) WHERE tg_id = ?`, [ctx.now, id]);
  }
}

async function sendGift(ctx, u) {
  const gifts = await ctx.db.all(
    `SELECT * FROM posts WHERE kind = 'gift' AND status = 'active'
       AND (audience = 'all' OR audience = ?)
       AND NOT EXISTS (SELECT 1 FROM deliveries d WHERE d.post_id = posts.id AND d.tg_id = ?)
     ORDER BY id`,
    [u.level || 'all', u.tg_id],
  );
  if (!gifts.length) {
    const any = await ctx.db.first(`SELECT 1 FROM deliveries d JOIN posts p ON p.id = d.post_id WHERE p.kind = 'gift' AND d.tg_id = ?`, [u.tg_id]);
    if (!any) await say(ctx, u.tg_id, 'noGift');
    return;
  }
  for (const g of gifts) {
    await sendPost(ctx.tg, u.tg_id, g, { uid: u.tg_id, publicUrl: ctx.publicUrl, arrow: await btn(ctx, 'buttonsArrow') });
    await recordDeliveries(ctx.db, g.id, [{ tg_id: u.tg_id, ok: true }], ctx.now);
  }
}

export async function onUserCallback(ctx, cq) {
  const id = cq.from.id;
  const d = cq.data || '';
  // ответ на нажатие: убирает «часики» на кнопке; с текстом — короткое всплывающее уведомление
  const answer = async (key, vars) => ctx.tg.call('answerCallbackQuery', { callback_query_id: cq.id, ...(key ? { text: (await msgText(ctx, key, vars)).text.slice(0, 190) } : {}) }).catch(() => {});
  const u = await getUser(ctx, id);
  if (!u) { await answer(); return say(ctx, id, 'needStart'); }
  const mid = cq.message && cq.message.message_id;
  // кнопка нажата — служебное сообщение больше не нужно: убираем его (Telegram растворяет с анимацией)
  const done = async (key, vars) => {
    await untech(ctx, id, mid);
    if (key) { await pause(ctx, id, 500); await say(ctx, id, key, vars); }
  };

  if (d === 'c:pd') {
    await answer('consentThanks');
    if (!u.consent_pd_at) { await ctx.db.run(`UPDATE users SET consent_pd_at = ? WHERE tg_id = ?`, [ctx.now, id]); await logConsent(ctx, id, 'pd', true); }
    await done();
    return nextStep(ctx, await getUser(ctx, id));
  }
  if (d.startsWith('lv:')) {
    await answer();
    const lv = d.slice(3) === 'start' ? 'start' : 'pro';
    await ctx.db.run(`UPDATE users SET level = ?, level_raw = COALESCE(level_raw, ?) WHERE tg_id = ?`, [lv, lv === 'start' ? 'start' : 'free', id]);
    if (u.consent_pd_at && u.consent_ads_at) { await done('levelChanged', { уровень: LEVELS[lv] }); return; }
    await done();
    return nextStep(ctx, await getUser(ctx, id));
  }
  if (d.startsWith('c:ads:')) {
    await answer();
    const yes = d.endsWith(':1');
    await logConsent(ctx, id, 'ads', yes);
    if (yes) {
      await ctx.db.run(`UPDATE users SET consent_ads_at = ?, status = 'active', joined_at = COALESCE(joined_at, ?) WHERE tg_id = ?`, [ctx.now, ctx.now, id]);
      return done('adsYes');
    }
    await ctx.db.run(`UPDATE users SET consent_ads_at = NULL, status = 'stopped' WHERE tg_id = ?`, [id]);
    return done('adsNo');
  }
  if (d === 'del:yes') {
    await answer();
    await cleanAll(ctx, id); await delMsg(ctx, id, mid);
    for (const t of ['users', 'consents', 'deliveries', 'clicks', 'states']) await ctx.db.run(`DELETE FROM ${t} WHERE tg_id = ?`, [id]);
    return say(ctx, id, 'deleted');
  }
  if (d === 'del:no') { await answer('deleteCancel'); return done(); }
  await answer();
}

export async function onUserCommand(ctx, msg, cmd) {
  const id = msg.from.id;
  const u = await getUser(ctx, id);
  // команды /level и /delete — служебные: саму команду убираем, вопрос уберётся после ответа
  if (cmd === 'level' || cmd === 'delete') await delMsg(ctx, id, msg.message_id);
  if (cmd === 'stop') {
    if (u) { await ctx.db.run(`UPDATE users SET status = 'stopped', consent_ads_at = NULL WHERE tg_id = ?`, [id]); await logConsent(ctx, id, 'ads', false); }
    return say(ctx, id, 'stopped');
  }
  if (cmd === 'level') return u ? askLevel(ctx, id) : say(ctx, id, 'needStart');
  if (cmd === 'policy') return say(ctx, id, 'policy', docVars(ctx), { link_preview_options: { is_disabled: true } });
  if (cmd === 'delete') {
    return tech(ctx, id, say(ctx, id, 'deleteAsk', {}, { reply_markup: kb([[{ text: await btn(ctx, 'deleteYes'), callback_data: 'del:yes' }, { text: await btn(ctx, 'deleteNo'), callback_data: 'del:no' }]]) }));
  }
  if (cmd === 'id') return ctx.tg.call('sendMessage', { chat_id: id, text: `Твой Telegram-id: ${id}` });
  return say(ctx, id, 'unknown');
}
