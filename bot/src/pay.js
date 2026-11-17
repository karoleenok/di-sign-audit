// Оплата обучения через ЮKassa.
// Тарифы, оплата целиком или в 2 части, приём уведомлений от ЮKassa, напоминания,
// ссылки в «Внутренний кампус» за день до старта.
//
// Настройки (переменные окружения на сервере, в /etc/di-sign-bot.env):
//   YK_SHOP_ID, YK_SECRET   — из кабинета ЮKassa (Интеграция → Ключи API). В код и GitHub не класть.
//   YK_RECEIPT=1            — передавать данные для чека (включить, если ЮKassa попросит; см. ИНСТРУКЦИЯ)
//   CAMPUS_CHAT_ID          — id чата «Внутренний кампус» (бот должен быть там админом)
//   PAY_PRE_UNTIL, PAY_DUE2, PAY_INVITE_AT, PAY_START — даты в формате 2026-11-18T23:59:59 (Москва)
import { nowSec } from './time.js';
import { envAdmins } from './admin.js';
import { withPay } from './paycfg.js';
import { say, btn, msg as msgText, postOf } from './msgs.js';
import { setUState } from './users.js';

const API = 'https://api.yookassa.ru/v3';

// Цены. pre — цена предзаписи, base — после неё. Меняются только здесь.
export const TARIFFS = {
  rector: { title: 'с ректором', pre: 77777, base: 88888, seats: 5, about: 'персональное ведение проекта, личные созвоны' },
  prof: { title: 'с профессором', pre: 33333, base: 44444, seats: 20, about: 'группа, ответы в чате, созвоны в конце каждой главы' },
};

// служебный тариф для проверки оплаты настоящей картой: 1 ₽, только для админов (/paytest),
// в списке тарифов не виден (enumerable: false), места не занимает
Object.defineProperty(TARIFFS, 'check', { value: { title: 'проверка', pre: 1, base: 1, seats: 99, about: 'служебная проверка оплаты' }, enumerable: false });

const msk = (s) => Math.floor(Date.parse(s + '+03:00') / 1000);
export function conf(env = {}) {
  return {
    preUntil: msk(env.PAY_PRE_UNTIL || '2026-11-18T23:59:59'),
    inviteAt: msk(env.PAY_INVITE_AT || '2026-12-02T11:30:00'),
    start: msk(env.PAY_START || '2026-12-03T11:30:00'),
  };
}

const rub = (n) => n.toLocaleString('ru-RU').replace(/\s/g, ' ') + ' ₽';
const dm = (ts) => new Date((ts + 3 * 3600) * 1000).toISOString().slice(5, 10).split('-').reverse().join('.');
export const priceNow = (t, now, env) => (now <= conf(env).preUntil ? TARIFFS[t].pre : TARIFFS[t].base);

// Сколько мест осталось: занятые (оплатили первую часть) + те, кто сейчас держит ссылку на оплату (45 минут)
export async function seatsLeft(ctx, tariff, exceptTg) {
  const paid = await ctx.db.first(`SELECT COUNT(*) AS n FROM users WHERE tariff = ? AND paid1_at IS NOT NULL`, [tariff]);
  const hold = await ctx.db.first(
    `SELECT COUNT(DISTINCT p.tg_id) AS n FROM payments p JOIN users u ON u.tg_id = p.tg_id
     WHERE p.tariff = ? AND p.status = 'pending' AND p.part = 'full' AND p.created_at > ? AND u.paid1_at IS NULL AND p.tg_id != ?`,
    [tariff, ctx.now - 45 * 60, exceptTg || 0]);
  return Math.max(0, TARIFFS[tariff].seats - paid.n - hold.n);
}
const esc = (s) => String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));

// ---------- ЮKassa ----------
function ykAuth(env) {
  if (!env.YK_SHOP_ID || !env.YK_SECRET) throw new Error('нет ключей ЮKassa');
  return 'Basic ' + btoa(`${env.YK_SHOP_ID}:${env.YK_SECRET}`);
}
async function ykCreate(ctx, { tgId, tariff, part, amount, botUrl }) {
  const key = `${tgId}-${tariff}-${part}-${Math.floor(ctx.now / 3000)}`; // защита от двойного нажатия (окно 50 минут)
  const body = {
    amount: { value: amount.toFixed(2), currency: 'RUB' },
    capture: true,
    confirmation: { type: 'redirect', return_url: botUrl },
    description: `Di Sign University, тариф ${TARIFFS[tariff].title}`,
    metadata: { tg_id: String(tgId), tariff, part },
  };
  if (ctx.env.YK_RECEIPT === '1' && ctx.env.YK_RECEIPT_EMAIL) {
    body.receipt = {
      customer: { email: ctx.env.YK_RECEIPT_EMAIL },
      items: [{ description: body.description.slice(0, 128), quantity: '1.00', amount: body.amount, vat_code: 1, payment_subject: 'service', payment_mode: 'full_payment' }],
    };
  }
  const r = await fetch(`${API}/payments`, {
    method: 'POST',
    headers: { authorization: ykAuth(ctx.env), 'idempotence-key': key, 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(20_000),
  });
  const j = await r.json();
  if (!r.ok) throw new Error('ЮKassa: ' + (j.description || r.status));
  return j;
}
async function ykGet(env, id) {
  const r = await fetch(`${API}/payments/${encodeURIComponent(id)}`, { headers: { authorization: ykAuth(env) }, signal: AbortSignal.timeout(20_000) });
  if (!r.ok) throw new Error('ЮKassa get ' + r.status);
  return r.json();
}

// ---------- тексты ----------
// строка про рассрочку банка (Долями, Сплит): показываем, только если админ включил её в панели
const bnplLine = (ctx) => (ctx.env.PAY_BNPL === '1' ? 'Оплатить можно картой, по СБП или по частям (Долями, Сплит), если банк одобрит рассрочку на странице оплаты.' : 'Оплата проходит на защищённой странице ЮKassa.');
// сроки цены и способы оплаты одной строкой для сообщений
const terms = (ctx, pre, c) => (pre ? `Цена предзаписи действует до ${dm(c.preUntil)} включительно.\n\n` : '') + bnplLine(ctx);
async function offerKb(ctx) {
  const row = async (t, icon, name) => {
    const left = await seatsLeft(ctx, t);
    return [{ text: left ? `${icon} ${name} · ${rub(priceNow(t, ctx.now, ctx.env))}` : `${icon} ${name} · мест нет`, callback_data: left ? `pay:t:${t}` : `pay:w:${t}` }];
  };
  return { inline_keyboard: [await row('rector', '🎓', 'С ректором'), await row('prof', '📐', 'С профессором')] };
}
const ofertaUrl = (ctx) => (ctx.publicUrl || '') + '/oferta';
const cap = (t) => (t ? t.charAt(0).toUpperCase() + t.slice(1) : t);
// Отправить сообщение; если можно, превращаем в него предыдущее (одно сообщение вместо двух)
async function sayOrEdit(ctx, id, mid, key, vars, extra = {}) {
  if (mid && !(await postOf(ctx, key))) {
    try {
      const m = await msgText(ctx, key, vars);
      if (!m.media) {
        await ctx.tg.call('editMessageText', { chat_id: id, message_id: mid, text: m.text || '…', ...(m.entities && m.entities.length ? { entities: m.entities } : {}), ...(extra.reply_markup ? { reply_markup: extra.reply_markup } : {}), link_preview_options: { is_disabled: true } });
        return;
      }
    } catch (e) { /* не вышло отредактировать: пришлём новым */ }
  }
  return say(ctx, id, key, vars, extra);
}
const nm = (u) => (u && (u.contact_name || u.first_name)) || 'друг';

async function send(ctx, chat, text, kb) {
  return ctx.tg.call('sendMessage', { chat_id: chat, text, parse_mode: 'HTML', disable_web_page_preview: true, ...(kb ? { reply_markup: kb } : {}) });
}
async function toAdmins(ctx, text) {
  const ids = new Set([...envAdmins(ctx.env), ...(await ctx.db.all(`SELECT tg_id FROM admins`)).map((r) => r.tg_id)]);
  for (const id of ids) await send(ctx, id, text).catch(() => {});
}
const who = (u) => `<a href="tg://user?id=${u.tg_id}">${esc(u.contact_name || u.first_name || 'без имени')}</a>${u.username ? ' @' + esc(u.username) : ''}\n   📞 ${u.phone ? esc(u.phone) : 'телефона нет'} · ✉️ ${u.email ? esc(u.email) : 'почты нет'}`;

export async function sendOffer(ctx, chat) {
  ctx = await withPay(ctx);
  const c = conf(ctx.env);
  const pre = ctx.now <= c.preUntil;
  const price = (t) => (pre ? `${rub(TARIFFS[t].pre)} (потом ${rub(TARIFFS[t].base)})` : rub(TARIFFS[t].base));
  const seats = async (t) => { const n = await seatsLeft(ctx, t); return n ? `Осталось мест: ${n} из ${TARIFFS[t].seats}` : 'Мест нет'; };
  return say(ctx, chat, 'payOffer', {
    старт: dm(c.start),
    цена_ректор: price('rector'), о_ректор: cap(TARIFFS.rector.about), места_ректор: await seats('rector'),
    цена_проф: price('prof'), о_проф: cap(TARIFFS.prof.about), места_проф: await seats('prof'),
    условия: terms(ctx, pre, c),
  }, { reply_markup: await offerKb(ctx), link_preview_options: { is_disabled: true } });
}

// ---------- кнопки ----------
export async function onPayCallback(ctx, cq) {
  ctx = await withPay(ctx);
  const id = cq.from.id;
  const [, act, arg] = (cq.data || '').split(':');
  if (arg === 'check') { await ctx.tg.call('answerCallbackQuery', { callback_query_id: cq.id }).catch(() => {}); return; } // служебный тариф только по /paytest
  const ack = (text) => ctx.tg.call('answerCallbackQuery', { callback_query_id: cq.id, ...(text ? { text } : {}) }).catch(() => {});
  const u = await ctx.db.first(`SELECT * FROM users WHERE tg_id = ?`, [id]);
  if (!u) { await ack(); return say(ctx, id, 'needStart'); }

  if (u.paid_full_at) { await ack(); return say(ctx, id, 'payAlready', { имя: nm(u) }); }
  if (act === 'back') { await ack(); return sendOffer(ctx, id); }
  if (act === 'o') { await ack(); return sendOferta(ctx, id); }

  // выбор тарифа → итог и кнопка оплаты
  if (act === 't' && TARIFFS[arg]) { await ack(); return showTariff(ctx, u, id, arg); }

  // кнопка оплаты → сначала телефон и почта (обязательно), потом ссылка на оплату
  if (act === 'f' && TARIFFS[arg]) {
    await ack();
    if ((await seatsLeft(ctx, arg, id)) < 1) return soldOut(ctx, id, arg);
    await ctx.db.run(`INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)`, ['payintent:' + id, JSON.stringify({ t: arg, at: ctx.now })]);
    return payContinue(ctx, id, true, cq.message && cq.message.message_id);
  }
  if (act === 's' || act === '2') { await ack(); return sendOffer(ctx, id); } // кнопки из прежней версии
  if (act === 'w' && TARIFFS[arg]) {
    await ack('Записала в лист ожидания');
    if (await flag(ctx, u, 'wait_' + arg)) await toAdmins(ctx, `🕐 Лист ожидания, тариф ${TARIFFS[arg].title}:\n${who(u)}`);
    return say(ctx, id, 'payWait', { тариф: TARIFFS[arg].title, имя: nm(u) });
  }
  await ack();
}

// Оферта прямо в чате: не зависит от ссылки и браузера
async function sendOferta(ctx, id) {
  let html = '';
  try { html = await (await import('node:fs/promises')).readFile(new URL('../docs/oferta.html', import.meta.url), 'utf8'); } catch { /* нет файла */ }
  let dd = '19.11.2026';
  try { const d = new Date((conf(ctx.env).preUntil + 3 * 3600) * 1000), p2 = (n) => String(n).padStart(2, '0'); dd = `${p2(d.getUTCDate())}.${p2(d.getUTCMonth() + 1)}.${d.getUTCFullYear()}`; } catch { /* оставим по умолчанию */ }
  const body = (html.split('<main>')[1] || '').split('</main>')[0]
    .replace(/\{\{ПРЕДЗАПИСЬ_ДО\}\}/g, dd)
    .replace(/<h[12][^>]*>/g, '\n\n').replace(/<\/(h[12]|p|ul)>/g, '\n').replace(/<li>/g, '• ').replace(/<\/li>/g, '\n')
    .replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&laquo;/g, '«').replace(/&raquo;/g, '»')
    .replace(/\n{3,}/g, '\n\n').trim();
  if (!body) return ctx.tg.call('sendMessage', { chat_id: id, text: 'Оферта: ' + ofertaUrl(ctx) });
  const parts = []; let cur = '';
  for (const para of body.split('\n\n')) { if ((cur + '\n\n' + para).length > 3800 && cur) { parts.push(cur); cur = para; } else cur = cur ? cur + '\n\n' + para : para; }
  if (cur) parts.push(cur);
  for (const t of parts) await ctx.tg.call('sendMessage', { chat_id: id, text: t, link_preview_options: { is_disabled: true } });
}

// Экран тарифа: итог, условия и кнопка «Оплатить»
async function showTariff(ctx, u, id, t) {
  if ((await seatsLeft(ctx, t, id)) < 1) return soldOut(ctx, id, t);
  const total = priceNow(t, ctx.now, ctx.env);
  return say(ctx, id, 'payTariff',
    { тариф: TARIFFS[t].title, сумма: rub(total), о_тарифе: cap(TARIFFS[t].about), условия: bnplLine(ctx), оферта: ofertaUrl(ctx), имя: nm(u) },
    { reply_markup: { inline_keyboard: [
      [{ text: await btn(ctx, 'payBtnGo', { сумма: rub(total) }), callback_data: `pay:f:${t}` }],
      [{ text: await btn(ctx, 'payBtnOferta'), ...(/^https:/.test(ofertaUrl(ctx)) ? { web_app: { url: ofertaUrl(ctx) } } : { callback_data: 'pay:o' }) }],
      [{ text: await btn(ctx, 'payBtnBack'), callback_data: 'pay:back' }],
    ] }, link_preview_options: { is_disabled: true } });
}

// Сразу к оплате, без экрана тарифа: контакты (если их ещё нет), потом кнопка со ссылкой на ЮKassa
async function goPay(ctx, id, t) {
  if ((await seatsLeft(ctx, t, id)) < 1) return soldOut(ctx, id, t);
  await ctx.db.run(`INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)`, ['payintent:' + id, JSON.stringify({ t, at: ctx.now })]);
  return payContinue(ctx, id, true);
}

// Кнопка оплаты в посте или в сообщении бота: prof / rector — сразу к оплате, all — предложение с двумя тарифами
export async function payFromButton(ctx, cq, tariff) {
  ctx = await withPay(ctx);
  const id = cq.from.id;
  // оплата ещё не подключена (нет ключей ЮKassa): честно говорим, что она откроется позже
  if (!ctx.env.YK_SHOP_ID || !ctx.env.YK_SECRET) {
    return ctx.tg.call('answerCallbackQuery', { callback_query_id: cq.id, text: (await msgText(ctx, 'payLater')).text.slice(0, 190), show_alert: true }).catch(() => {});
  }
  await ctx.tg.call('answerCallbackQuery', { callback_query_id: cq.id }).catch(() => {});
  const t = TARIFFS[tariff] && tariff !== 'check' ? tariff : '';
  if (!(await payEntry(ctx, { from: cq.from }, t))) await say(ctx, id, 'needStart');
}

// Вход по ссылке t.me/бот?start=pay, pay_prof или pay_rector (с сайта, из постов, из кнопок).
// Новичку сначала нужен обычный вход (согласие на данные), предложение придёт сразу после него.
export async function payEntry(ctx, msg, tariff) {
  ctx = await withPay(ctx);
  const id = msg.from.id;
  const u = await ctx.db.first(`SELECT * FROM users WHERE tg_id = ?`, [id]);
  if (!u || !u.sched_at) {
    await ctx.db.run(`INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)`, ['payafter:' + id, tariff || '']);
    return false;
  }
  if (u.paid_full_at) { await say(ctx, id, 'payAlready', { имя: nm(u) }); return true; }
  if (tariff && TARIFFS[tariff]) await goPay(ctx, id, tariff); else await sendOffer(ctx, id);
  return true;
}

async function soldOut(ctx, id, t) {
  return say(ctx, id, 'paySoldOut', { тариф: TARIFFS[t].title },
    { reply_markup: { inline_keyboard: [[{ text: await btn(ctx, 'payBtnWait'), callback_data: `pay:w:${t}` }], [{ text: await btn(ctx, 'payBtnBack'), callback_data: 'pay:back' }]] } });
}

// Продолжение оплаты: пока нет телефона и почты, просим их; когда есть оба, выдаём ссылку.
// Вызывается с кнопки «Оплатить» и после каждого ответа человека (телефон, почта) из users.js.
export async function payContinue(ctx, id, first = false, mid = null) {
  ctx = await withPay(ctx);
  const key = 'payintent:' + id;
  const row = await ctx.db.first(`SELECT value FROM settings WHERE key = ?`, [key]);
  if (!row) return false;
  let it = null; try { it = JSON.parse(row.value); } catch {}
  const clear = () => ctx.db.run(`DELETE FROM settings WHERE key = ?`, [key]);
  if (!it || !TARIFFS[it.t] || ctx.now - it.at > 3 * 3600) { await clear(); return false; }
  const u = await ctx.db.first(`SELECT * FROM users WHERE tg_id = ?`, [id]);
  if (!u) { await clear(); return false; }
  if (!u.phone || !u.email) {
    if (first) await say(ctx, id, 'payNeedData', { имя: nm(u) });
    if (!u.phone) {
      await setUState(ctx, id, 'u:phone');
      await say(ctx, id, 'askPhone', {}, { reply_markup: { keyboard: [[{ text: await btn(ctx, 'phoneBtn'), request_contact: true }]], resize_keyboard: true, one_time_keyboard: true } });
    } else {
      await setUState(ctx, id, 'u:email');
      await say(ctx, id, 'askEmail');
    }
    return true;
  }
  await clear();
  if ((await seatsLeft(ctx, it.t, id)) < 1) { await soldOut(ctx, id, it.t); return true; }
  const total = priceNow(it.t, ctx.now, ctx.env);
  await ctx.db.run(`INSERT INTO consents (tg_id, kind, granted, version, at) VALUES (?, 'offer', 1, 'v1', ?)`, [id, ctx.now]);
  await ctx.db.run(`UPDATE users SET tariff = ?, pay_total = ? WHERE tg_id = ?`, [it.t, total, id]);
  await giveLink(ctx, null, async (t) => { if (t) await send(ctx, id, t); }, { ...u, tariff: it.t, pay_total: total }, 'full', total, mid);
  return true;
}

async function giveLink(ctx, cq, ack, u, part, amount, mid = null) {
  const id = u.tg_id;
  // уже есть свежая неоплаченная ссылка на то же самое — отдаём её, второй платёж не создаём
  let p = await ctx.db.first(
    `SELECT * FROM payments WHERE tg_id = ? AND tariff = ? AND part = ? AND amount = ? AND status = 'pending' AND created_at > ? ORDER BY created_at DESC LIMIT 1`,
    [id, u.tariff, part, amount, ctx.now - 45 * 60]);
  if (!p) {
    let yk;
    try {
      yk = await ykCreate(ctx, { tgId: id, tariff: u.tariff, part, amount, botUrl: 'https://t.me/di_sign_university_bot?start=paid' });
    } catch (e) {
      console.error('pay create', e.message);
      await ack('Платёжный сервис не ответил, попробуй через минуту');
      await toAdmins(ctx, `⚠️ Не создался платёж для ${who(u)}: ${e.message}`);
      return;
    }
    p = { id: yk.id, url: yk.confirmation && yk.confirmation.confirmation_url };
    await ctx.db.run(`INSERT OR IGNORE INTO payments (id, tg_id, tariff, part, amount, url, status, created_at) VALUES (?, ?, ?, ?, ?, ?, 'pending', ?)`,
      [p.id, id, u.tariff, part, amount, p.url, ctx.now]);
  }
  await ack();
  return sayOrEdit(ctx, id, mid, 'payLink', { сумма: rub(amount), тариф: TARIFFS[u.tariff].title, оферта: ofertaUrl(ctx), имя: nm(u) },
    { link_preview_options: { is_disabled: true }, reply_markup: { inline_keyboard: [
      [{ text: await btn(ctx, 'payBtnLink', { сумма: rub(amount) }), url: p.url }],
      [{ text: await btn(ctx, 'payBtnOferta'), ...(/^https:/.test(ofertaUrl(ctx)) ? { web_app: { url: ofertaUrl(ctx) } } : { callback_data: 'pay:o' }) }],
    ] } });
}

// ---------- уведомление от ЮKassa ----------
// Самому уведомлению не верим: берём id платежа и спрашиваем статус у ЮKassa напрямую.
export async function onYkNotify(ctx, body, secret) {
  ctx = await withPay(ctx);
  // адрес уведомлений содержит секрет из панели: чужой запрос отбрасываем
  const want = ctx.env.YK_HOOK_SECRET || '';
  let diff = want.length === String(secret || '').length ? 0 : 1;
  for (let i = 0; i < want.length; i++) diff |= want.charCodeAt(i) ^ String(secret || '').charCodeAt(i);
  if (!want || diff) return false;
  let id;
  try { id = JSON.parse(body).object.id; } catch { return true; }
  if (!id || !/^[\w-]{10,60}$/.test(id)) return true;
  const row = await ctx.db.first(`SELECT id FROM payments WHERE id = ?`, [id]);
  if (!row) return true; // чужой или выдуманный id
  await checkPayment(ctx, id);
  return true;
}

export async function checkPayment(ctx, id) {
  const p = await ykGet(ctx.env, id);
  const out = p;
  if (p.status === 'succeeded' && p.paid) {
    // отмечаем один раз: повторные уведомления ничего не делают
    const r = await ctx.db.run(`UPDATE payments SET status = 'succeeded', paid_at = ? WHERE id = ? AND status != 'succeeded'`, [ctx.now, id]);
    if (r.changes === 1) await onPaid(ctx, await ctx.db.first(`SELECT * FROM payments WHERE id = ?`, [id]), p);
  } else if (p.status === 'canceled') {
    const r = await ctx.db.run(`UPDATE payments SET status = 'canceled' WHERE id = ? AND status = 'pending'`, [id]);
    if (r.changes === 1) {
      const row = await ctx.db.first(`SELECT * FROM payments WHERE id = ?`, [id]);
      await say(ctx, row.tg_id, 'payFail', {}, { reply_markup: { inline_keyboard: [[{ text: await btn(ctx, 'payBtnRetry'), callback_data: `pay:t:${row.tariff}` }]] } }).catch(() => {});
    }
  }
  return out;
}

// Человек вернулся из ЮKassa в бота (кнопка «Вернуться»): сразу проверяем его платёж, не ждём уведомления.
// Если банк ещё подтверждает (бывает при СБП), успокаиваем: ничего делать не нужно, подтверждение придёт сюда.
export async function payReturned(ctx, id) {
  ctx = await withPay(ctx);
  const u = await ctx.db.first(`SELECT * FROM users WHERE tg_id = ?`, [id]);
  if (!u || u.paid_full_at) return;
  const rows = await ctx.db.all(`SELECT id FROM payments WHERE tg_id = ? AND status = 'pending' AND created_at > ? ORDER BY created_at DESC LIMIT 3`, [id, ctx.now - 3 * 3600]);
  if (!rows.length) return sendOffer(ctx, id);
  let paid = false;
  for (const r of rows) { try { const yk = await checkPayment(ctx, r.id); if (yk.status === 'succeeded' && yk.paid) paid = true; } catch (e) { console.error('pay return', e.message); } }
  if (!paid) await say(ctx, id, 'payWaiting', { имя: nm(u) });
}

// Страховка на случай, если уведомление от ЮKassa не дошло: сами спрашиваем статус неоплаченных платежей.
// Возвращает {проверено, зачислено}. Если оплату поймал опрос спустя пару минут после списания, админам раз в сутки
// приходит предупреждение: значит, адрес уведомлений в ЮKassa вписан неверно или не сохранён.
export async function pollPending(ctx, limit = 25, windowSec = 2 * 3600) {
  const rows = await ctx.db.all(`SELECT id FROM payments WHERE status = 'pending' AND created_at > ? ORDER BY created_at DESC LIMIT ?`, [ctx.now - windowSec, limit]);
  let paid = 0, late = false;
  for (const r of rows) {
    try {
      const yk = await checkPayment(ctx, r.id);
      if (yk.status === 'succeeded' && yk.paid) {
        paid++;
        if (yk.captured_at && ctx.now - Date.parse(yk.captured_at) / 1000 > 120) late = true;
      }
    } catch (e) { console.error('pay poll', e.message); }
  }
  if (late) {
    const day = new Date((ctx.now + 3 * 3600) * 1000).toISOString().slice(0, 10);
    const f = await ctx.db.first(`SELECT value FROM settings WHERE key = 'pay:hookwarn'`);
    if (!f || f.value !== day) {
      await ctx.db.run(`INSERT OR REPLACE INTO settings (key, value) VALUES ('pay:hookwarn', ?)`, [day]);
      await toAdmins(ctx, '⚠️ Оплата дошла до бота с опозданием: уведомление от ЮKassa не пришло, платёж поймала проверка. Деньги не потеряны, но проверь, что адрес уведомлений вписан в боевой магазин ЮKassa (Интеграция → HTTP-уведомления, события payment.succeeded и payment.canceled).');
    }
  }
  return { checked: rows.length, paid };
}

async function onPaid(ctx, row, yk) {
  // сверяем сумму: оплачено должно быть ровно столько, сколько мы выставили
  if (Number(yk.amount.value) !== row.amount) {
    await toAdmins(ctx, `⚠️ Платёж ${row.id}: сумма ${yk.amount.value} не совпала с ожидаемой ${row.amount}. Проверьте вручную.`);
    return;
  }
  const id = row.tg_id;
  const c = conf(ctx.env);
  await ctx.db.run(`UPDATE users SET paid1_at = ?, paid_full_at = ? WHERE tg_id = ?`, [ctx.now, ctx.now, id]);
  const u = await ctx.db.first(`SELECT * FROM users WHERE tg_id = ?`, [id]);

  await enqueueSheet(ctx, row, u);
  await say(ctx, id, 'payThanks', { тариф: TARIFFS[row.tariff].title, сумма: rub(row.amount), дата_доступов: dm(c.inviteAt), дата_старта: dm(c.start), имя: nm(u) });
  await toAdmins(ctx, `💸 ${who(u)} — тариф ${TARIFFS[row.tariff].title}: ${rub(row.amount)}`);
}

// ---------- резерв: таблица и файлы ----------
const fmtD = (ts) => (ts ? new Date((ts + 3 * 3600) * 1000).toISOString().replace('T', ' ').slice(0, 16) : '');
const csv = (rows) => '﻿' + rows.map((r) => r.map((c) => {
  const s = c == null ? '' : String(c);
  return /[";\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}).join(';')).join('\r\n');

async function adminIds(ctx) {
  return [...new Set([...envAdmins(ctx.env), ...(await ctx.db.all(`SELECT tg_id FROM admins`)).map((r) => r.tg_id)])];
}

// Два файла: «оплатившие» (по одной строке на человека) и «платежи» (каждый платёж отдельно)
export async function sendFiles(ctx, chat, caption) {
  const users = await ctx.db.all(`SELECT * FROM users WHERE paid1_at IS NOT NULL ORDER BY paid1_at`);
  const sums = Object.fromEntries((await ctx.db.all(`SELECT tg_id, SUM(amount) AS s FROM payments WHERE status = 'succeeded' GROUP BY tg_id`)).map((r) => [r.tg_id, r.s]));
  const a = [['Имя', 'Ник', 'Telegram ID', 'Телефон', 'Почта', 'Тариф', 'Оплачено', 'Дата оплаты']];
  for (const u of users) a.push([u.contact_name || u.first_name, u.username ? '@' + u.username : '', u.tg_id, u.phone, u.email,
    TARIFFS[u.tariff] ? TARIFFS[u.tariff].title : u.tariff, sums[u.tg_id] || 0, fmtD(u.paid_full_at || u.paid1_at)]);
  const pays = await ctx.db.all(`SELECT p.*, u.first_name, u.contact_name, u.username, u.phone, u.email FROM payments p LEFT JOIN users u ON u.tg_id = p.tg_id WHERE p.status = 'succeeded' ORDER BY p.paid_at`);
  const b = [['Дата', 'ID платежа', 'Имя', 'Ник', 'Telegram ID', 'Телефон', 'Почта', 'Тариф', 'Сумма']];
  for (const p of pays) b.push([fmtD(p.paid_at), p.id, p.contact_name || p.first_name, p.username ? '@' + p.username : '', p.tg_id, p.phone, p.email,
    TARIFFS[p.tariff] ? TARIFFS[p.tariff].title : p.tariff, p.amount]);
  const day = new Date((ctx.now + 3 * 3600) * 1000).toISOString().slice(0, 10);
  for (const [name, rows, cap] of [['oplativshie', a, `Оплатившие: ${a.length - 1}. ${caption || ''}`], ['platezhi', b, `Платежи: ${b.length - 1}`]]) {
    const f = new FormData();
    f.append('chat_id', String(chat));
    f.append('caption', cap);
    f.append('document', new Blob([csv(rows)], { type: 'text/csv' }), `${name}-${day}.csv`);
    await ctx.tg.upload('sendDocument', f);
  }
}

// Запись об оплате уходит в очередь, оттуда во внешнюю таблицу (Google Таблицы через Apps Script)
async function enqueueSheet(ctx, row, u) {
  await ctx.db.run(`INSERT INTO pay_outbox (payload, created_at) VALUES (?, ?)`, [JSON.stringify({
    date: fmtD(ctx.now), payment_id: row.id, name: u.contact_name || u.first_name || '', username: u.username ? '@' + u.username : '',
    tg_id: u.tg_id, phone: u.phone || '', email: u.email || '', tariff: TARIFFS[row.tariff].title,
    amount: row.amount, total: u.pay_total || row.amount,
  }), ctx.now]);
}
async function flushSheet(ctx) {
  const url = ctx.env.SHEET_HOOK_URL;
  if (!url) return;
  const q = await ctx.db.all(`SELECT * FROM pay_outbox WHERE sent_at IS NULL AND tries < 30 ORDER BY id LIMIT 10`);
  for (const o of q) {
    let ok = false;
    try {
      const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'text/plain;charset=utf-8' }, redirect: 'follow',
        body: JSON.stringify({ key: ctx.env.SHEET_HOOK_KEY || '', ...JSON.parse(o.payload) }), signal: AbortSignal.timeout(20_000) });
      ok = r.ok && (await r.text()).trim().startsWith('ok');
    } catch (e) { /* повторим в следующую минуту */ }
    if (ok) await ctx.db.run(`UPDATE pay_outbox SET sent_at = ? WHERE id = ?`, [ctx.now, o.id]);
    else {
      await ctx.db.run(`UPDATE pay_outbox SET tries = tries + 1 WHERE id = ?`, [o.id]);
      if (o.tries + 1 === 5) await toAdmins(ctx, '⚠️ Таблица не принимает записи об оплатах. Платёж не потерян: он в базе бота и придёт в ежедневном файле. Повторить отправку в таблицу: /paysync');
    }
  }
}

// ---------- расписание (раз в минуту из tick) ----------
const flag = async (ctx, u, f) => {
  const fl = (u.pay_flags || '').split(',');
  if (fl.includes(f)) return false;
  await ctx.db.run(`UPDATE users SET pay_flags = ? WHERE tg_id = ?`, [[...fl.filter(Boolean), f].join(','), u.tg_id]);
  return true;
};

export async function payTick(ctx) {
  ctx = await withPay(ctx);
  if (!ctx.env.YK_SHOP_ID) return;
  const now = ctx.now;
  const c = conf(ctx.env);

  await flushSheet(ctx).catch((e) => console.error('sheet', e.message));
  await pollPending(ctx).catch((e) => console.error('pay poll', e.message));
  // каждый день в 10:00 по Москве — два файла со списком оплативших всем админам
  const msk = new Date((now + 3 * 3600) * 1000), dayKey = msk.toISOString().slice(0, 10);
  if (msk.getUTCHours() === 10 && msk.getUTCMinutes() < 5) {
    const last = await ctx.db.first(`SELECT value FROM settings WHERE key = 'pay:csv_day'`);
    if (!last || last.value !== dayKey) {
      await ctx.db.run(`INSERT OR REPLACE INTO settings (key, value) VALUES ('pay:csv_day', ?)`, [dayKey]);
      for (const a of await adminIds(ctx)) await sendFiles(ctx, a, 'Ежедневная копия.').catch((e) => console.error('csv', e.message));
    }
  }

  // 1) подстраховка: если уведомление от ЮKassa потерялось, сами проверяем свежие платежи
  const pend = await ctx.db.all(`SELECT id FROM payments WHERE status = 'pending' AND created_at < ? AND created_at > ? LIMIT 15`, [now - 120, now - 3 * 3600]);
  for (const p of pend) await checkPayment(ctx, p.id).catch((e) => console.error('pay check', e.message));

  // 2) рассылка предложения (запускается командой /payoffer), по 150 человек за минуту
  const bc = await ctx.db.first(`SELECT value FROM settings WHERE key = 'pay:broadcast'`);
  if (bc && bc.value === 'on') {
    const list = await ctx.db.all(
      `SELECT * FROM users WHERE status = 'active' AND paid1_at IS NULL AND (pay_flags IS NULL OR pay_flags NOT LIKE '%offer%') LIMIT 150`);
    if (!list.length) {
      await ctx.db.run(`UPDATE settings SET value = 'done' WHERE key = 'pay:broadcast'`);
      await toAdmins(ctx, '✅ Рассылка с тарифами разослана всем.');
    }
    for (const u of list) {
      await flag(ctx, u, 'offer');
      await sendOffer(ctx, u.tg_id).catch(async (e) => { if (e.code === 403) await ctx.db.run(`UPDATE users SET status = 'blocked' WHERE tg_id = ?`, [u.tg_id]); });
      await new Promise((r) => setTimeout(r, 45));
    }
  }

  // 2б) пришёл по ссылке на оплату, но сначала проходил вход: предложение — как только вход закончен
  const waiting = await ctx.db.all(`SELECT u.*, s.value AS want FROM users u JOIN settings s ON s.key = 'payafter:' || u.tg_id WHERE u.sched_at IS NOT NULL LIMIT 20`);
  for (const u of waiting) {
    await ctx.db.run(`DELETE FROM settings WHERE key = ?`, ['payafter:' + u.tg_id]);
    if (u.paid_full_at) continue;
    await flag(ctx, u, 'offer');
    const send1 = u.want && TARIFFS[u.want] ? goPay(ctx, u.tg_id, u.want) : sendOffer(ctx, u.tg_id);
    await send1.catch(async (e) => { if (e.code === 403) await ctx.db.run(`UPDATE users SET status = 'blocked' WHERE tg_id = ?`, [u.tg_id]); });
  }
  // 2в) когда общая рассылка уже прошла, новичкам предложение приходит сам через сутки после входа
  if (bc && bc.value === 'done') {
    const fresh = await ctx.db.all(
      `SELECT * FROM users WHERE status = 'active' AND paid1_at IS NULL AND sched_at IS NOT NULL AND sched_at < ? AND (pay_flags IS NULL OR pay_flags NOT LIKE '%offer%') LIMIT 20`, [now - 86400]);
    for (const u of fresh) {
      await flag(ctx, u, 'offer');
      await sendOffer(ctx, u.tg_id).catch(async (e) => { if (e.code === 403) await ctx.db.run(`UPDATE users SET status = 'blocked' WHERE tg_id = ?`, [u.tg_id]); });
    }
  }

  // 3) за день до старта: ссылки в кампус и список для выдачи доступов
  if (now >= c.inviteAt && now < c.start + 14 * 86400) {
    const paid = await ctx.db.all(`SELECT * FROM users WHERE paid_full_at IS NOT NULL AND (pay_flags IS NULL OR pay_flags NOT LIKE '%campus%')`);
    for (const u of paid) {
      if (!ctx.env.CAMPUS_CHAT_ID) break;
      try {
        const link = await ctx.tg.call('createChatInviteLink', { chat_id: ctx.env.CAMPUS_CHAT_ID, member_limit: 1, expire_date: c.start + 7 * 86400, name: `id${u.tg_id}` });
        await say(ctx, u.tg_id, 'payCampus', { имя: nm(u) }, { reply_markup: { inline_keyboard: [[{ text: await btn(ctx, 'payBtnCampus'), url: link.invite_link }]] } });
        await flag(ctx, u, 'campus');
      } catch (e) { console.error('campus', e.message); }
    }
    const done = await ctx.db.first(`SELECT value FROM settings WHERE key = 'pay:list_sent'`);
    if (!done) {
      await ctx.db.run(`INSERT OR REPLACE INTO settings (key, value) VALUES ('pay:list_sent', '1')`);
      const all = await ctx.db.all(`SELECT * FROM users WHERE paid_full_at IS NOT NULL ORDER BY tariff`);
      await toAdmins(ctx, `📋 Пора выдать логины и пароли. Оплатили полностью (${all.length}):\n\n` +
        all.map((u) => `• ${TARIFFS[u.tariff] ? TARIFFS[u.tariff].title : u.tariff}\n${who(u)}`).join('\n\n'));
    }
  }
}

// ---------- команды ----------
export async function payAdminCommand(ctx, msg, cmd, arg) {
  ctx = await withPay(ctx);
  const id = msg.from.id;
  if (cmd === 'payoffer') {
    if (arg === 'test') return sendOffer(ctx, id);
    if (arg !== 'go') return send(ctx, id, 'Рассылка с тарифами уйдёт всем подписчикам, кто ещё не оплатил.\n\n/payoffer test — прислать только мне\n/payoffer go — разослать всем');
    await ctx.db.run(`INSERT OR REPLACE INTO settings (key, value) VALUES ('pay:broadcast', 'on')`);
    return send(ctx, id, 'Запустила рассылку: уходит по 150 человек в минуту. Напишу, когда закончится.');
  }
  if (cmd === 'paycheck') {
    const r = await pollPending(ctx, 100, 24 * 3600);
    return send(ctx, id, r.checked ? `Проверила неоплаченных платежей за сутки: ${r.checked}. Зачислено сейчас: ${r.paid}.` : 'Неоплаченных платежей за последние сутки нет.');
  }
  if (cmd === 'paytest') {
    if (!ctx.env.YK_SHOP_ID || !ctx.env.YK_SECRET) return send(ctx, id, 'Сначала впиши ключи ЮKassa в панели: «Ещё → Оплата».');
    await ctx.db.run(`INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)`, ['payintent:' + id, JSON.stringify({ t: 'check', at: ctx.now })]);
    await send(ctx, id, 'Проверка оплаты на 1 ₽. Пройди путь как студент: оставь телефон и почту, оплати. Потом верни рубль в ЮKassa («Операции» → платёж → «Вернуть») и отправь /payreset yes.');
    return payContinue(ctx, id, true);
  }
  if (cmd === 'payreset') {
    const n = (await ctx.db.first(`SELECT COUNT(*) AS n FROM payments WHERE tg_id = ?`, [id])).n;
    if (arg !== 'yes') return send(ctx, id, `Сотру только твои платежи в боте: сейчас их ${n}. Место, которое они занимали, освободится.\n\nНужно подтвердить: /payreset yes\n\nВ ЮKassa платёж останется (его видно в «Операциях»), а строку в Google Таблице, если она там уже есть, придётся удалить руками.`);
    await ctx.db.run(`DELETE FROM payments WHERE tg_id = ?`, [id]);
    await ctx.db.run(`DELETE FROM pay_outbox WHERE sent_at IS NULL AND payload LIKE ?`, [`%"tg_id":${id},%`]);
    await ctx.db.run(`DELETE FROM settings WHERE key = ?`, ['payintent:' + id]);
    await ctx.db.run(`UPDATE users SET tariff = NULL, pay_total = NULL, paid1_at = NULL, paid_full_at = NULL, pay_flags = NULL WHERE tg_id = ?`, [id]);
    return send(ctx, id, `Готово: твои платежи (${n}) стёрты, места свободны. Можно проверять оплату заново.`);
  }
  if (cmd === 'paysfile') { await sendFiles(ctx, id, 'По запросу.'); return true; }
  if (cmd === 'paysync') {
    await ctx.db.run(`UPDATE pay_outbox SET tries = 0 WHERE sent_at IS NULL`);
    const n = await ctx.db.first(`SELECT COUNT(*) AS n FROM pay_outbox WHERE sent_at IS NULL`);
    return send(ctx, id, `Отправлю в таблицу заново. В очереди записей: ${n.n}.`);
  }
  if (cmd === 'pays') {
    const rows = await ctx.db.all(`SELECT * FROM users WHERE paid1_at IS NOT NULL ORDER BY paid1_at`);
    const sum = await ctx.db.first(`SELECT COALESCE(SUM(amount), 0) AS s FROM payments WHERE status = 'succeeded'`);
    return send(ctx, id, `Зачислены: ${rows.length}, получено ${rub(sum.s)}\nСвободно мест: ректор ${await seatsLeft(ctx, 'rector')} из ${TARIFFS.rector.seats}, профессор ${await seatsLeft(ctx, 'prof')} из ${TARIFFS.prof.seats}\n\n` +
      (rows.map((u) => `✅ ${TARIFFS[u.tariff] ? TARIFFS[u.tariff].title : '?'}\n${who(u)}`).join('\n\n') || 'пока никого'));
  }
  return null;
}
