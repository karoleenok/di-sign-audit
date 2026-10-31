import { ZONES, LEVELS } from './texts.js';
import { say, btn, msg as msgText, delayOf } from './msgs.js';
import { sendPost, recordDeliveries, loadDocs } from './posts.js';
import { isAdmin } from './admin.js';

const CONSENT_VERSION = 'v1';

// Метка из ссылки теста: audit_<зона>_<уровень>[_course|_month], например audit_P_start_course, audit_top_pro
// course — выбрал бесплатный мини-курс, month — месяц полезных материалов
export function parseStart(payload) {
  const out = { source: payload || null, zone: null, levelRaw: null, track: null };
  const m = /^audit_([A-Za-z]+)_([a-z]+)(?:_(course|month))?$/.exec(payload || '');
  if (m) {
    const z = m[1] === 'top' ? 'top' : m[1].toUpperCase();
    if (ZONES[z]) out.zone = z;
    if (['start', 'free', 'pro'].includes(m[2])) out.levelRaw = m[2];
    if (m[3]) out.track = m[3] === 'course' ? 'course' : 'mat';
  }
  return out;
}
export const normLevel = (raw) => (raw === 'start' ? 'start' : raw === 'free' || raw === 'pro' ? 'pro' : null);

const kb = (rows) => ({ inline_keyboard: rows });

// ссылки на документы для подстановок {политика}, {согласие}, {оферта}, {владелец}
export async function docVars(ctx) {
  const d = await loadDocs(ctx);
  return {
    политика: d.policy || '— ссылка появится перед запуском —',
    согласие: d.consent || '— ссылка появится перед запуском —',
    оферта: d.offer || '— скоро —',
    владелец: d.owner || '',
  };
}

async function askLevel(ctx, id) {
  return tech(ctx, id, say(ctx, id, 'askLevel', {}, {
    reply_markup: kb([[{ text: await btn(ctx, 'levelBtnStart'), callback_data: 'lv:start' }], [{ text: await btn(ctx, 'levelBtnPro'), callback_data: 'lv:pro' }]]),
  }));
}

// ---------- «чистый» чат ----------
// Служебные сообщения (согласия, вопросы, предложение теста) запоминаем и убираем, когда они уже не нужны:
// Telegram сам красиво растворяет удалённое сообщение. Между сообщениями — пауза с «печатает…».
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// «Печатает…» и в шапке, и прямо в чате: пузырёк «•» → «• •» → «• • •», который исчезает перед сообщением.
// Вызывать только когда следом точно будет сообщение.
// пауза перед служебным сообщением — сколько задано в панели для этого сообщения
async function pauseFor(ctx, id, key) { return pause(ctx, id, (await delayOf(ctx, key)) * 1000); }
async function pause(ctx, id, ms) {
  const k = ctx.env.DELAY_FACTOR === undefined ? 1 : Number(ctx.env.DELAY_FACTOR);
  if (!(k > 0) || !(ms > 0)) return;
  const t = Math.max(450, ms * k);
  const t0 = Date.now();
  // «печатает» и правки пузырька не ждём: пока идут запросы через мост, пауза уже тикает
  ctx.tg.call('sendChatAction', { chat_id: id, action: 'typing' }).catch(() => {});
  if (ctx.env.TYPING_BUBBLE === '0') { await sleep(t); return; }
  const dots = await ctx.tg.call('sendMessage', { chat_id: id, text: '•', disable_notification: true }).catch(() => null);
  if (!dots) { await sleep(Math.max(0, t - (Date.now() - t0))); return; }
  const mid = dots.message_id;
  const edit = (text) => ctx.tg.call('editMessageText', { chat_id: id, message_id: mid, text }).catch(() => {});
  const e1 = sleep(Math.max(0, t / 3 - (Date.now() - t0))).then(() => edit('• •'));
  const e2 = sleep(Math.max(0, (2 * t) / 3 - (Date.now() - t0))).then(() => edit('• • •'));
  await sleep(Math.max(0, t - (Date.now() - t0)));
  await Promise.all([e1, e2]);
  await ctx.tg.call('deleteMessage', { chat_id: id, message_id: mid }).catch(() => {});
}
const techList = (u) => { try { return u && u.tech ? JSON.parse(u.tech) : []; } catch { return []; } };
async function tech(ctx, id, sending) {
  const m = await sending;
  if (m && m.message_id) {
    const u = await getUser(ctx, id);
    if (u) await ctx.db.run(`UPDATE users SET tech = ? WHERE tg_id = ?`, [JSON.stringify([...techList(u), ...(m.also || []), m.message_id].slice(-20)), id]);
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
  // двойное нажатие «Старт» (или повтор от Telegram) за пару секунд — не дублируем
  const k = 'start:' + from.id + ':' + (payload || '');
  const fresh = await ctx.db.run(
    `INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value WHERE CAST(settings.value AS INTEGER) <= ?`,
    [k, String(ctx.now), ctx.now - 4]);
  if (!fresh.changes) { await delMsg(ctx, from.id, msg.message_id); return; }
  let u = await getUser(ctx, from.id);
  if (!u) {
    await ctx.db.run(
      `INSERT INTO users (tg_id, first_name, username, level_raw, level, zone, source, track, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'new', ?)`,
      [from.id, from.first_name || null, from.username || null, st.levelRaw, normLevel(st.levelRaw), st.zone, st.source, st.track, ctx.now],
    );
  } else {
    // пришёл ещё раз: обновим результат теста, если он новый
    if (st.zone || st.levelRaw || st.track) {
      await ctx.db.run(`UPDATE users SET zone = COALESCE(?, zone), level_raw = COALESCE(?, level_raw), level = COALESCE(?, level), source = COALESCE(?, source), track = COALESCE(?, track), username = COALESCE(?, username) WHERE tg_id = ?`,
        [st.zone, st.levelRaw, normLevel(st.levelRaw), st.source, st.track, from.username || null, from.id]);
    }
    if (u.status === 'stopped' || u.status === 'blocked') await ctx.db.run(`UPDATE users SET status = 'new' WHERE tg_id = ?`, [from.id]);
  }
  // убираем саму команду /start и старые служебные сообщения (прошлое приветствие, вопросы, предложение теста)
  await delMsg(ctx, from.id, msg.message_id);
  await setUState(ctx, from.id, null);
  await cleanAll(ctx, from.id);
  u = await getUser(ctx, from.id);
  const name = from.first_name || 'друг';
  // зона из теста запоминается только как отметка «прошёл тест» — посты и подарки по зонам не делим
  await pauseFor(ctx, from.id, st.zone ? 'helloTest' : 'hello');
  await tech(ctx, from.id, say(ctx, from.id, st.zone ? 'helloTest' : 'hello', { имя: name }));
  return nextStep(ctx, u);
}

// Пошаговый вход:
//   согласие на данные -> согласие на рассылку -> уровень (если не пришёл из аудита) -> имя -> контакт (Telegram / телефон / почта)
//   -> отзыв о прототипе кабинета (по желанию, за бонус) -> мини-курс или материалы (если не выбрал в аудите)
//   -> (тест, если не проходил) -> подарок -> пост-расписание по треку -> дальше лента
// ---------- порядок шагов входа (меняется в панели: Сценарий → Вход в бот) ----------
export const FLOW_STEPS = ['consentPd', 'consentAds', 'askLevel', 'askName', 'askContact', 'fbOffer', 'askTrack', 'testOffer'];
export const FLOW_OPTIONAL = ['askName', 'askContact', 'fbOffer', 'askTrack', 'testOffer']; // эти можно выключить
export function normFlow(order, off) {
  const seen = [];
  for (const k of Array.isArray(order) ? order : []) if (FLOW_STEPS.includes(k) && !seen.includes(k)) seen.push(k);
  for (const k of FLOW_STEPS) if (!seen.includes(k)) seen.push(k);
  // согласие на данные всегда первое: без него ничего не собираем
  const o = ['consentPd', ...seen.filter((k) => k !== 'consentPd')];
  const f = (Array.isArray(off) ? off : []).filter((k) => FLOW_OPTIONAL.includes(k));
  return { order: o, off: [...new Set(f)] };
}
export async function loadFlow(ctx) {
  const rows = await ctx.db.all(`SELECT key, value FROM settings WHERE key IN ('flow:order', 'flow:off')`);
  const m = Object.fromEntries(rows.map((r) => [r.key, r.value]));
  const j = (v) => { try { return JSON.parse(v); } catch { return null; } };
  return normFlow(j(m['flow:order']), j(m['flow:off']));
}

// каждый шаг: если он ещё не пройден и включён — отправляет сообщение и возвращает true (ждём ответ)
const STEP_RUN = {
  async consentPd(ctx, u) {
    if (u.consent_pd_at) return false;
    await pauseFor(ctx, u.tg_id, 'consentPd');
    await tech(ctx, u.tg_id, say(ctx, u.tg_id, 'consentPd', await docVars(ctx), {
      link_preview_options: { is_disabled: true },
      reply_markup: kb([[{ text: await btn(ctx, 'consentPdBtn'), callback_data: 'c:pd' }]]),
    }));
    return true;
  },
  async consentAds(ctx, u) {
    if (u.consent_ads_at || u.status === 'stopped') return false;
    await pauseFor(ctx, u.tg_id, 'consentAds');
    await tech(ctx, u.tg_id, say(ctx, u.tg_id, 'consentAds', {}, {
      reply_markup: kb([[{ text: await btn(ctx, 'consentAdsYes'), callback_data: 'c:ads:1' }, { text: await btn(ctx, 'consentAdsNo'), callback_data: 'c:ads:0' }]]),
    }));
    return true;
  },
  async askLevel(ctx, u) {
    if (u.level) return false;
    await pauseFor(ctx, u.tg_id, 'askLevel');
    await askLevel(ctx, u.tg_id);
    return true;
  },
  async askName(ctx, u) {
    if (u.contact_name) return false;
    const id = u.tg_id;
    await pauseFor(ctx, id, 'askName');
    await setUState(ctx, id, 'u:name');
    await tech(ctx, id, say(ctx, id, 'askName', { имя: u.first_name || 'друг' }, { reply_markup: kb([[{ text: await btn(ctx, 'nameOk'), callback_data: 'n:ok' }]]) }));
    return true;
  },
  async askContact(ctx, u) {
    if (u.contact_at) return false;
    await askContact(ctx, u);
    return true;
  },
  async fbOffer(ctx, u) {
    if (u.fb_at || u.fb_skip) return false;
    const id = u.tg_id;
    await pauseFor(ctx, id, 'fbOffer');
    await tech(ctx, id, say(ctx, id, 'fbOffer', { кабинет: ctx.env.KABINET_URL || 'https://karoleenok.github.io/di-sign-audit/kabinet/' }, {
      reply_markup: kb([[{ text: await btn(ctx, 'fbYes'), callback_data: 'fb:yes' }], [{ text: await btn(ctx, 'fbNo'), callback_data: 'fb:no' }]]),
    }));
    return true;
  },
  async askTrack(ctx, u) {
    if (u.track) return false;
    const id = u.tg_id;
    await pauseFor(ctx, id, 'askTrack');
    await tech(ctx, id, say(ctx, id, 'askTrack', {}, {
      reply_markup: kb([[{ text: await btn(ctx, 'trackCourse'), callback_data: 'tr:course' }], [{ text: await btn(ctx, 'trackMat'), callback_data: 'tr:mat' }]]),
    }));
    return true;
  },
  async testOffer(ctx, u) {
    const id = u.tg_id;
    if (!u.zone) {
      // не проходил тест: один раз предлагаем (по кнопке в конце теста он вернётся в бот — тогда придёт подарок)
      const url = ctx.env.TEST_URL;
      if (!u.test_offered) {
        await ctx.db.run(`UPDATE users SET test_offered = 1 WHERE tg_id = ?`, [id]);
        await pauseFor(ctx, id, 'testOffer');
        await tech(ctx, id, say(ctx, id, 'testOffer', {}, url ? { reply_markup: kb([[{ text: await btn(ctx, 'testBtn'), url }]]) } : {}));
      }
    } else {
      await sendGift(ctx, u, (await delayOf(ctx, 'noGift')) * 1000);
    }
    return false; // на ответ не ждём
  },
};

export async function nextStep(ctx, u) {
  const id = u.tg_id;
  const { order, off } = await loadFlow(ctx);
  for (const k of order) {
    if (off.includes(k)) {
      if (k === 'testOffer' && u.zone) await sendGift(ctx, u, (await delayOf(ctx, 'noGift')) * 1000); // подарок после теста не теряем
      continue;
    }
    if (await STEP_RUN[k](ctx, u)) return;
  }
  if (!u.sched_at) {
    const key = u.track === 'course' ? 'schedCourse' : 'schedMat';
    await pauseFor(ctx, id, key);
    await say(ctx, id, key, {});
    // вход пройден — отсюда считается лента
    await ctx.db.run(`UPDATE users SET sched_at = ?, status = 'active', joined_at = COALESCE(joined_at, ?) WHERE tg_id = ?`, [ctx.now, ctx.now, id]);
  } else if (u.status !== 'active') {
    await ctx.db.run(`UPDATE users SET status = 'active', joined_at = COALESCE(joined_at, ?) WHERE tg_id = ?`, [ctx.now, id]);
  }
}

async function askContact(ctx, u) {
  const id = u.tg_id;
  await pauseFor(ctx, id, 'askContact');
  const rows = [];
  if (u.username) rows.push([{ text: (await btn(ctx, 'contactTg')) + ' · @' + u.username, callback_data: 'ct:tg' }]);
  rows.push([{ text: await btn(ctx, 'contactPhone'), callback_data: 'ct:phone' }], [{ text: await btn(ctx, 'contactEmail'), callback_data: 'ct:email' }]);
  return tech(ctx, id, say(ctx, id, 'askContact', {}, { reply_markup: kb(rows) }));
}

// ---------- ответы текстом во время входа: имя, телефон, почта, отзыв ----------
export async function getUState(ctx, id) {
  const r = await ctx.db.first(`SELECT state FROM states WHERE tg_id = ?`, [id]);
  return r && r.state && r.state.startsWith('u:') ? r.state : null;
}
async function setUState(ctx, id, state) {
  if (!state) { await ctx.db.run(`DELETE FROM states WHERE tg_id = ? AND state LIKE 'u:%'`, [id]); return; }
  await ctx.db.run(`INSERT INTO states (tg_id, state, data, updated_at) VALUES (?, ?, NULL, ?) ON CONFLICT(tg_id) DO UPDATE SET state = excluded.state, data = NULL, updated_at = excluded.updated_at`, [id, state, ctx.now]);
}
const removeKb = { remove_keyboard: true };
export async function onUserText(ctx, msg, state) {
  const id = msg.from.id;
  const u = await getUser(ctx, id);
  if (!u) { await setUState(ctx, id, null); return say(ctx, id, 'needStart'); }
  const txt = String(msg.text || '').trim();
  if (state === 'u:name') {
    if (!txt) return;
    await ctx.db.run(`UPDATE users SET contact_name = ? WHERE tg_id = ?`, [txt.replace(/\s+/g, ' ').slice(0, 60), id]);
    await setUState(ctx, id, null);
    await cleanAll(ctx, id);
    return nextStep(ctx, await getUser(ctx, id));
  }
  if (state === 'u:phone') {
    let phone = null;
    if (msg.contact) { if (msg.contact.user_id && msg.contact.user_id !== id) return say(ctx, id, 'badPhone'); phone = msg.contact.phone_number; }
    else { const d = txt.replace(/[^\d+]/g, ''); if (/^\+?\d{10,15}$/.test(d)) phone = d; }
    if (!phone) return tech(ctx, id, say(ctx, id, 'badPhone'));
    phone = phone.startsWith('+') ? phone : '+' + phone.replace(/^8(?=\d{10}$)/, '7');
    await ctx.db.run(`UPDATE users SET phone = ?, contact_at = ? WHERE tg_id = ?`, [phone, ctx.now, id]);
    await setUState(ctx, id, null);
    // убираем кнопку «Отправить телефон» снизу экрана
    const m = await ctx.tg.call('sendMessage', { chat_id: id, text: (await msgText(ctx, 'contactSaved')).text, reply_markup: removeKb, disable_notification: true }).catch(() => null);
    if (m) await tech(ctx, id, Promise.resolve(m));
    await cleanAll(ctx, id);
    return nextStep(ctx, await getUser(ctx, id));
  }
  if (state === 'u:email') {
    const e = txt.toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(e) || e.length > 120) return tech(ctx, id, say(ctx, id, 'badEmail'));
    await ctx.db.run(`UPDATE users SET email = ?, contact_at = ? WHERE tg_id = ?`, [e, ctx.now, id]);
    await setUState(ctx, id, null);
    await cleanAll(ctx, id);
    return nextStep(ctx, await getUser(ctx, id));
  }
  if (state === 'u:fb1') {
    if (!txt) return;
    await ctx.db.run(`UPDATE users SET fb_like = ? WHERE tg_id = ?`, [txt.slice(0, 1500), id]);
    await setUState(ctx, id, 'u:fb2');
    await pauseFor(ctx, id, 'fbQ2');
    return tech(ctx, id, say(ctx, id, 'fbQ2'));
  }
  if (state === 'u:fb2') {
    if (!txt) return;
    await ctx.db.run(`UPDATE users SET fb_improve = ?, fb_at = ? WHERE tg_id = ?`, [txt.slice(0, 1500), ctx.now, id]);
    await setUState(ctx, id, null);
    await cleanAll(ctx, id);
    await pauseFor(ctx, id, 'fbThanks');
    await sendFbBonus(ctx, await getUser(ctx, id));
    await notifyAdmins(ctx, await getUser(ctx, id));
    return nextStep(ctx, await getUser(ctx, id));
  }
}

// бонус за отзыв: посты вида «бонус за отзыв» (kind = 'fb'), по порядку
async function sendFbBonus(ctx, u) {
  const posts = await ctx.db.all(`SELECT * FROM posts WHERE kind = 'fb' AND status = 'active' AND NOT EXISTS (SELECT 1 FROM deliveries d WHERE d.post_id = posts.id AND d.tg_id = ?) ORDER BY pos, id`, [u.tg_id]);
  if (!posts.length) { await say(ctx, u.tg_id, 'fbNoBonus'); return; }
  await say(ctx, u.tg_id, 'fbThanks', { имя: u.contact_name || u.first_name || '' });
  const docs = await loadDocs(ctx);
  for (const p of posts) {
    await sendPost(ctx.tg, u.tg_id, p, { uid: u.tg_id, publicUrl: ctx.publicUrl, arrow: await btn(ctx, 'buttonsArrow'), docs });
    await recordDeliveries(ctx.db, p.id, [{ tg_id: u.tg_id, ok: true }], ctx.now);
  }
}

// новый отзыв о кабинете — админам в бот
async function notifyAdmins(ctx, u) {
  const ids = new Set([...String(ctx.env.ADMIN_IDS || '').split(/[\s,;]+/).filter(Boolean).map(Number), ...(await ctx.db.all(`SELECT tg_id FROM admins`)).map((r) => r.tg_id)]);
  const who = (u.contact_name || u.first_name || 'без имени') + (u.username ? ' · @' + u.username : '') + (u.phone ? ' · ' + u.phone : '') + (u.email ? ' · ' + u.email : '');
  const text = `💬 Новый отзыв о кабинете\n${who}\n\n👍 Понравилось:\n${u.fb_like || '—'}\n\n🛠 Улучшить:\n${u.fb_improve || '—'}`;
  for (const a of ids) if (a !== u.tg_id) await ctx.tg.call('sendMessage', { chat_id: a, text: text.slice(0, 4000), disable_notification: true }).catch(() => {});
}

async function sendGift(ctx, u, pauseMs) {
  const gifts = await ctx.db.all(
    `SELECT * FROM posts WHERE kind = 'gift' AND status = 'active'
       AND (audience = 'all' OR audience = ?)
       AND (track = 'all' OR track = ?)
       AND NOT EXISTS (SELECT 1 FROM deliveries d WHERE d.post_id = posts.id AND d.tg_id = ?)
     ORDER BY id`,
    [u.level || 'all', u.track || 'all', u.tg_id],
  );
  if (!gifts.length) {
    // подарков ещё нет — говорим об этом один раз, и это служебное сообщение (уберётся при следующем /start)
    const any = await ctx.db.first(`SELECT 1 FROM deliveries d JOIN posts p ON p.id = d.post_id WHERE p.kind = 'gift' AND d.tg_id = ?`, [u.tg_id]);
    const told = await ctx.db.first(`SELECT 1 FROM settings WHERE key = ?`, ['nogift:' + u.tg_id]);
    if (!any && !told) {
      await ctx.db.run(`INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO NOTHING`, ['nogift:' + u.tg_id, String(ctx.now)]);
      if (pauseMs) await pause(ctx, u.tg_id, pauseMs);
      await tech(ctx, u.tg_id, say(ctx, u.tg_id, 'noGift'));
    }
    return;
  }
  for (const g of gifts) {
    if (pauseMs) await pause(ctx, u.tg_id, pauseMs);
    await sendPost(ctx.tg, u.tg_id, g, { uid: u.tg_id, publicUrl: ctx.publicUrl, arrow: await btn(ctx, 'buttonsArrow'), docs: await loadDocs(ctx) });
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
    if (key) { await pauseFor(ctx, id, key); await say(ctx, id, key, vars); }
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
      await ctx.db.run(`UPDATE users SET consent_ads_at = ? WHERE tg_id = ?`, [ctx.now, id]);
      // вход уже был пройден раньше (вернулся после /stop) — просто включаем рассылку
      if (u.sched_at) { await ctx.db.run(`UPDATE users SET status = 'active' WHERE tg_id = ?`, [id]); return done('adsYes'); }
      await done();
      return nextStep(ctx, await getUser(ctx, id));
    }
    await ctx.db.run(`UPDATE users SET consent_ads_at = NULL, status = 'stopped' WHERE tg_id = ?`, [id]);
    return done('adsNo');
  }
  if (d === 'del:yes') {
    await answer();
    await cleanAll(ctx, id); await delMsg(ctx, id, mid);
    for (const t of ['users', 'consents', 'deliveries', 'clicks', 'states']) await ctx.db.run(`DELETE FROM ${t} WHERE tg_id = ?`, [id]);
    await ctx.db.run(`DELETE FROM settings WHERE key = ? OR key LIKE ? OR key LIKE ?`, ['nogift:' + id, 'start:' + id + ':%', 'go:' + id + ':%']);
    return say(ctx, id, 'deleted');
  }
  if (d === 'del:no') { await answer('deleteCancel'); return done(); }
  if (d.startsWith('go:')) return onGo(ctx, cq, u, answer);
  if (d === 'n:ok') {
    await answer();
    await ctx.db.run(`UPDATE users SET contact_name = COALESCE(contact_name, ?) WHERE tg_id = ?`, [u.first_name || 'друг', id]);
    await setUState(ctx, id, null); await done();
    return nextStep(ctx, await getUser(ctx, id));
  }
  if (d.startsWith('ct:')) {
    const how = d.slice(3);
    if (how === 'tg') {
      await answer('contactSaved');
      await ctx.db.run(`UPDATE users SET contact_at = ?, username = COALESCE(?, username) WHERE tg_id = ?`, [ctx.now, cq.from.username || null, id]);
      await done();
      return nextStep(ctx, await getUser(ctx, id));
    }
    await answer(); await done();
    if (how === 'phone') {
      await setUState(ctx, id, 'u:phone');
      return tech(ctx, id, say(ctx, id, 'askPhone', {}, { reply_markup: { keyboard: [[{ text: await btn(ctx, 'phoneBtn'), request_contact: true }]], resize_keyboard: true, one_time_keyboard: true } }));
    }
    await setUState(ctx, id, 'u:email');
    return tech(ctx, id, say(ctx, id, 'askEmail'));
  }
  if (d === 'fb:yes') {
    await answer(); await done();
    await setUState(ctx, id, 'u:fb1');
    await pauseFor(ctx, id, 'fbQ1');
    return tech(ctx, id, say(ctx, id, 'fbQ1'));
  }
  if (d === 'fb:no') {
    await answer();
    await ctx.db.run(`UPDATE users SET fb_skip = 1 WHERE tg_id = ?`, [id]);
    await done();
    return nextStep(ctx, await getUser(ctx, id));
  }
  if (d.startsWith('tr:')) {
    await answer();
    await ctx.db.run(`UPDATE users SET track = ? WHERE tg_id = ?`, [d.slice(3) === 'course' ? 'course' : 'mat', id]);
    await done();
    return nextStep(ctx, await getUser(ctx, id));
  }
  if (d.startsWith('buy:')) {
    // оплата тарифа: продамус подключим позже — пока всплывашка
    await ctx.tg.call('answerCallbackQuery', { callback_query_id: cq.id, text: (await msgText(ctx, 'payLater')).text.slice(0, 190), show_alert: true }).catch(() => {});
    const m = /^buy:(\d+):(\d+)-(\d+)$/.exec(d);
    if (m) { const p = await ctx.db.first(`SELECT buttons FROM posts WHERE id = ?`, [+m[1]]); const b = p && (JSON.parse(p.buttons || '[]')[+m[2]] || [])[+m[3]]; if (b) await ctx.db.run(`INSERT INTO clicks (post_id, tg_id, btn, at) VALUES (?, ?, ?, ?)`, [+m[1], id, b.text, ctx.now]); }
    return;
  }
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
  if (cmd === 'policy') return say(ctx, id, 'policy', await docVars(ctx), { link_preview_options: { is_disabled: true } });
  if (cmd === 'delete') {
    return tech(ctx, id, say(ctx, id, 'deleteAsk', {}, { reply_markup: kb([[{ text: await btn(ctx, 'deleteYes'), callback_data: 'del:yes' }, { text: await btn(ctx, 'deleteNo'), callback_data: 'del:no' }]]) }));
  }
  if (cmd === 'id') return ctx.tg.call('sendMessage', { chat_id: id, text: `Твой Telegram-id: ${id}` });
  return say(ctx, id, 'unknown');
}

// ---------- кнопка «открыть пост» ----------
// go:<пост с кнопкой>:<ряд>-<кнопка> -> бот присылает пост, на который ведёт кнопка.
// Если у поста включено «кнопки-выбор» — после нажатия под ним остаётся только выбранный вариант с ✓.
async function onGo(ctx, cq, u, answer) {
  const id = cq.from.id;
  const m = /^go:(\d+):(\d+)-(\d+)$/.exec(cq.data || '');
  if (!m) return answer();
  const src = await ctx.db.first(`SELECT id, buttons, once FROM posts WHERE id = ?`, [+m[1]]);
  const rows = src ? JSON.parse(src.buttons || '[]') : [];
  const b = (rows[+m[2]] || [])[+m[3]];
  if (!b || !b.go) return answer();
  // защита от двойного нажатия: одна и та же кнопка у одного человека — не чаще раза в 3 секунды
  const k = 'go:' + id + ':' + cq.data.slice(3);
  const fresh = await ctx.db.run(
    `INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value WHERE CAST(settings.value AS INTEGER) <= ?`,
    [k, String(ctx.now), ctx.now - 3]);
  if (!fresh.changes) return answer();
  await answer();
  await ctx.db.run(`INSERT INTO clicks (post_id, tg_id, btn, at) VALUES (?, ?, ?, ?)`, [src.id, id, b.text, ctx.now]);
  const mid = cq.message && cq.message.message_id;
  if (src.once && mid) {
    const kb = { inline_keyboard: [[{ text: '✓ ' + b.text, callback_data: 'go:done' }]] };
    await ctx.tg.call('editMessageReplyMarkup', { chat_id: id, message_id: mid, reply_markup: kb }).catch(() => {});
  }
  const target = await ctx.db.first(`SELECT * FROM posts WHERE id = ?`, [+b.go]);
  const admin = await isAdmin(ctx, id);
  if (!target || target.status === 'archived' || (target.status !== 'active' && !admin)) return;
  try {
    await sendPost(ctx.tg, id, target, { uid: id, publicUrl: ctx.publicUrl, arrow: await btn(ctx, 'buttonsArrow'), docs: await loadDocs(ctx) });
    // отметка «получил»: от неё считаются посты «после этого поста»
    await ctx.db.run(`INSERT INTO deliveries (post_id, tg_id, sent_at, ok) VALUES (?, ?, ?, 1) ON CONFLICT(post_id, tg_id) DO UPDATE SET sent_at = excluded.sent_at, ok = 1`, [target.id, id, ctx.now]);
  } catch (e) {
    if (e.code === 403) await ctx.db.run(`UPDATE users SET status = 'blocked' WHERE tg_id = ?`, [id]);
  }
}
