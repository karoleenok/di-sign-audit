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

const API = 'https://api.yookassa.ru/v3';

// Цены. pre — цена предзаписи, base — после неё. Меняются только здесь.
export const TARIFFS = {
  rector: { title: 'с ректором', pre: 77777, base: 88888, seats: 5, about: 'персональное ведение проекта, личные созвоны' },
  prof: { title: 'с профессором', pre: 33333, base: 44444, seats: 20, about: 'группа, ответы в чате, созвоны в конце каждой главы' },
};

const msk = (s) => Math.floor(Date.parse(s + '+03:00') / 1000);
export function conf(env = {}) {
  return {
    preUntil: msk(env.PAY_PRE_UNTIL || '2026-11-18T23:59:59'),
    due2: msk(env.PAY_DUE2 || '2026-12-01T23:59:59'),
    inviteAt: msk(env.PAY_INVITE_AT || '2026-12-02T11:30:00'),
    start: msk(env.PAY_START || '2026-12-03T11:30:00'),
  };
}

const rub = (n) => n.toLocaleString('ru-RU').replace(/\s/g, ' ') + ' ₽';
const dm = (ts) => new Date((ts + 3 * 3600) * 1000).toISOString().slice(5, 10).split('-').reverse().join('.');
const half = (total) => { const a = Math.ceil(total / 2); return [a, total - a]; };
export const priceNow = (t, now, env) => (now <= conf(env).preUntil ? TARIFFS[t].pre : TARIFFS[t].base);

// Сколько мест осталось: занятые (оплатили первую часть) + те, кто сейчас держит ссылку на оплату (45 минут)
export async function seatsLeft(ctx, tariff, exceptTg) {
  const paid = await ctx.db.first(`SELECT COUNT(*) AS n FROM users WHERE tariff = ? AND paid1_at IS NOT NULL`, [tariff]);
  const hold = await ctx.db.first(
    `SELECT COUNT(DISTINCT p.tg_id) AS n FROM payments p JOIN users u ON u.tg_id = p.tg_id
     WHERE p.tariff = ? AND p.status = 'pending' AND p.part IN ('full', '1') AND p.created_at > ? AND u.paid1_at IS NULL AND p.tg_id != ?`,
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
    description: `Di Sign University, тариф ${TARIFFS[tariff].title}` + (part === 'full' ? '' : `, часть ${part} из 2`),
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
async function offerText(ctx) {
  const L = { rector: await seatsLeft(ctx, 'rector'), prof: await seatsLeft(ctx, 'prof') };
  const c = conf(ctx.env);
  const pre = ctx.now <= c.preUntil;
  const p = (t) => (pre ? `<s>${rub(TARIFFS[t].base)}</s> <b>${rub(TARIFFS[t].pre)}</b>` : `<b>${rub(TARIFFS[t].base)}</b>`);
  return (
    `Набор в Di Sign University открыт 🐾\n\n` +
    `Старт — <b>${dm(c.start)}</b>. Выбирай формат:\n\n` +
    `🎓 <b>С ректором</b> — ${p('rector')}\n${TARIFFS.rector.about}. ${L.rector ? `Осталось мест: ${L.rector} из ${TARIFFS.rector.seats}` : 'Мест нет'}\n\n` +
    `📐 <b>С профессором</b> — ${p('prof')}\n${TARIFFS.prof.about}. ${L.prof ? `Осталось мест: ${L.prof} из ${TARIFFS.prof.seats}` : 'Мест нет'}\n\n` +
    (pre ? `Цена предзаписи действует до ${dm(c.preUntil)} включительно, потом ${rub(TARIFFS.prof.base)} и ${rub(TARIFFS.rector.base)}.\n\n` : '') +
    `Можно оплатить целиком или в 2 части: половина сейчас, вторая до ${dm(c.due2)}.`
  );
}
async function offerKb(ctx) {
  const row = async (t, icon, name) => {
    const left = await seatsLeft(ctx, t);
    return [{ text: left ? `${icon} ${name} · ${rub(priceNow(t, ctx.now, ctx.env))}` : `${icon} ${name} · мест нет`, callback_data: left ? `pay:t:${t}` : `pay:w:${t}` }];
  };
  return { inline_keyboard: [await row('rector', '🎓', 'С ректором'), await row('prof', '📐', 'С профессором')] };
}
const ofertaUrl = (ctx) => (ctx.publicUrl || '') + '/oferta';

async function send(ctx, chat, text, kb) {
  return ctx.tg.call('sendMessage', { chat_id: chat, text, parse_mode: 'HTML', disable_web_page_preview: true, ...(kb ? { reply_markup: kb } : {}) });
}
async function toAdmins(ctx, text) {
  const ids = new Set([...envAdmins(ctx.env), ...(await ctx.db.all(`SELECT tg_id FROM admins`)).map((r) => r.tg_id)]);
  for (const id of ids) await send(ctx, id, text).catch(() => {});
}
const who = (u) => `<a href="tg://user?id=${u.tg_id}">${esc(u.contact_name || u.first_name || 'без имени')}</a>${u.username ? ' @' + esc(u.username) : ''}\n   📞 ${u.phone ? esc(u.phone) : 'телефона нет'} · ✉️ ${u.email ? esc(u.email) : 'почты нет'}`;

export async function sendOffer(ctx, chat) {
  return send(ctx, chat, await offerText(ctx), await offerKb(ctx));
}

// ---------- кнопки ----------
export async function onPayCallback(ctx, cq) {
  const id = cq.from.id;
  const [, act, arg] = (cq.data || '').split(':');
  const ack = (text) => ctx.tg.call('answerCallbackQuery', { callback_query_id: cq.id, ...(text ? { text } : {}) }).catch(() => {});
  const u = await ctx.db.first(`SELECT * FROM users WHERE tg_id = ?`, [id]);
  if (!u) { await ack(); return send(ctx, id, 'Нажми /start, и продолжим 🐾'); }
  const c = conf(ctx.env);

  if (u.paid_full_at) { await ack(); return send(ctx, id, 'Ты уже зачислен(а) в Di Sign University 🎓 Подробности придут за день до старта.'); }
  if (act === 'back') { await ack(); return sendOffer(ctx, id); }

  // выбор тарифа → как платить
  if (act === 't' && TARIFFS[arg]) {
    await ack();
    if (u.paid1_at) return askSecond(ctx, u);
    if ((await seatsLeft(ctx, arg, id)) < 1) return soldOut(ctx, id, arg);
    const total = priceNow(arg, ctx.now, ctx.env);
    const [a, b] = half(total);
    return send(ctx, id,
      `Тариф <b>${TARIFFS[arg].title}</b> — ${rub(total)}.\n\nКак удобнее оплатить?\n\n` +
      `• <b>Целиком</b> — ${rub(total)}\n` +
      `• <b>В 2 части</b> — ${rub(a)} сейчас и ${rub(b)} до ${dm(c.due2)}. Без второй части доступ к обучению и кампусу не откроется.\n\n` +
      `Нажимая кнопку оплаты, ты принимаешь условия <a href="${ofertaUrl(ctx)}">оферты</a>.`,
      { inline_keyboard: [
        [{ text: `Целиком · ${rub(total)}`, callback_data: `pay:f:${arg}` }],
        [{ text: `В 2 части · ${rub(a)} сейчас`, callback_data: `pay:s:${arg}` }],
        [{ text: '← Другой тариф', callback_data: 'pay:back' }],
      ] });
  }

  // целиком / первая часть / вторая часть → ссылка на оплату
  if ((act === 'f' || act === 's') && TARIFFS[arg]) {
    if (u.paid1_at) { await ack(); return askSecond(ctx, u); }
    if ((await seatsLeft(ctx, arg, id)) < 1) { await ack(); return soldOut(ctx, id, arg); }
    const total = priceNow(arg, ctx.now, ctx.env);
    await ctx.db.run(`INSERT INTO consents (tg_id, kind, granted, version, at) VALUES (?, 'offer', 1, 'v1', ?)`, [id, ctx.now]);
    await ctx.db.run(`UPDATE users SET tariff = ?, pay_total = ?, pay_plan = ? WHERE tg_id = ?`, [arg, total, act === 'f' ? 'full' : 'split', id]);
    const part = act === 'f' ? 'full' : '1';
    return giveLink(ctx, cq, ack, { ...u, tariff: arg, pay_total: total }, part, act === 'f' ? total : half(total)[0]);
  }
  if (act === '2') {
    if (!u.paid1_at || !u.pay_total) { await ack(); return sendOffer(ctx, id); }
    return giveLink(ctx, cq, ack, u, '2', half(u.pay_total)[1]);
  }
  if (act === 'w' && TARIFFS[arg]) {
    await ack('Записала в лист ожидания');
    if (await flag(ctx, u, 'wait_' + arg)) await toAdmins(ctx, `🕐 Лист ожидания, тариф ${TARIFFS[arg].title}:\n${who(u)}`);
    return send(ctx, id, `Записала тебя в лист ожидания на тариф ${TARIFFS[arg].title}. Если место освободится, напишу сюда первой 🐾`);
  }
  await ack();
}

async function soldOut(ctx, id, t) {
  return send(ctx, id, `На тариф <b>${TARIFFS[t].title}</b> места закончились.\nМожно записаться в лист ожидания или выбрать другой формат.`,
    { inline_keyboard: [[{ text: 'В лист ожидания', callback_data: `pay:w:${t}` }], [{ text: '← Другой тариф', callback_data: 'pay:back' }]] });
}

async function giveLink(ctx, cq, ack, u, part, amount) {
  const id = u.tg_id;
  // уже есть свежая неоплаченная ссылка на то же самое — отдаём её, второй платёж не создаём
  let p = await ctx.db.first(
    `SELECT * FROM payments WHERE tg_id = ? AND tariff = ? AND part = ? AND amount = ? AND status = 'pending' AND created_at > ? ORDER BY created_at DESC LIMIT 1`,
    [id, u.tariff, part, amount, ctx.now - 45 * 60]);
  if (!p) {
    let yk;
    try {
      yk = await ykCreate(ctx, { tgId: id, tariff: u.tariff, part, amount, botUrl: 'https://t.me/di_sign_university_bot' });
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
  const label = part === 'full' ? 'Оплата целиком' : part === '1' ? 'Первая часть' : 'Вторая часть';
  return send(ctx, id,
    `${label}: <b>${rub(amount)}</b>, тариф ${TARIFFS[u.tariff].title}.\n\nСсылка действует около часа. Как только оплата пройдёт, я сразу напишу сюда.`,
    { inline_keyboard: [[{ text: `Оплатить ${rub(amount)}`, url: p.url }]] });
}

async function askSecond(ctx, u) {
  const [, b] = half(u.pay_total);
  return send(ctx, u.tg_id,
    `Первая часть уже оплачена ✅\nОсталась вторая — <b>${rub(b)}</b>, до ${dm(conf(ctx.env).due2)}.`,
    { inline_keyboard: [[{ text: `Оплатить вторую часть · ${rub(b)}`, callback_data: 'pay:2' }]] });
}

// ---------- уведомление от ЮKassa ----------
// Самому уведомлению не верим: берём id платежа и спрашиваем статус у ЮKassa напрямую.
export async function onYkNotify(ctx, body) {
  let id;
  try { id = JSON.parse(body).object.id; } catch { return; }
  if (!id || !/^[\w-]{10,60}$/.test(id)) return;
  const row = await ctx.db.first(`SELECT id FROM payments WHERE id = ?`, [id]);
  if (!row) return; // чужой или выдуманный id
  await checkPayment(ctx, id);
}

export async function checkPayment(ctx, id) {
  const p = await ykGet(ctx.env, id);
  if (p.status === 'succeeded' && p.paid) {
    // отмечаем один раз: повторные уведомления ничего не делают
    const r = await ctx.db.run(`UPDATE payments SET status = 'succeeded', paid_at = ? WHERE id = ? AND status != 'succeeded'`, [ctx.now, id]);
    if (r.changes === 1) await onPaid(ctx, await ctx.db.first(`SELECT * FROM payments WHERE id = ?`, [id]), p);
  } else if (p.status === 'canceled') {
    const r = await ctx.db.run(`UPDATE payments SET status = 'canceled' WHERE id = ? AND status = 'pending'`, [id]);
    if (r.changes === 1) {
      const row = await ctx.db.first(`SELECT * FROM payments WHERE id = ?`, [id]);
      await send(ctx, row.tg_id, 'Оплата не прошла или ссылка истекла. Ничего не списано — можно попробовать ещё раз 🐾',
        { inline_keyboard: [[{ text: 'Попробовать ещё раз', callback_data: row.part === '2' ? 'pay:2' : `pay:t:${row.tariff}` }]] }).catch(() => {});
    }
  }
}

async function onPaid(ctx, row, yk) {
  // сверяем сумму: оплачено должно быть ровно столько, сколько мы выставили
  if (Number(yk.amount.value) !== row.amount) {
    await toAdmins(ctx, `⚠️ Платёж ${row.id}: сумма ${yk.amount.value} не совпала с ожидаемой ${row.amount}. Проверьте вручную.`);
    return;
  }
  const id = row.tg_id;
  const c = conf(ctx.env);
  if (row.part === 'full') await ctx.db.run(`UPDATE users SET paid1_at = ?, paid_full_at = ? WHERE tg_id = ?`, [ctx.now, ctx.now, id]);
  if (row.part === '1') await ctx.db.run(`UPDATE users SET paid1_at = ? WHERE tg_id = ?`, [ctx.now, id]);
  if (row.part === '2') await ctx.db.run(`UPDATE users SET paid_full_at = ? WHERE tg_id = ?`, [ctx.now, id]);
  const u = await ctx.db.first(`SELECT * FROM users WHERE tg_id = ?`, [id]);

  await enqueueSheet(ctx, row, u);
  const next =
    `Что дальше:\n` +
    `• ${dm(c.inviteAt)} куратор или Диана пришлют личный логин и пароль от кабинета;\n` +
    `• в тот же день я пришлю ссылку во «Внутренний кампус» — общий чат потока;\n` +
    `• ${dm(c.start)} стартуем.\n\n` +
    `А пока продолжай мини-курс и забирай материалы из библиотеки — они твои весь ноябрь.`;
  if (row.part === '1') {
    await send(ctx, id,
      `Первая часть получена, ты в Di Sign University 🎓🐾\n\n` +
      `Вторая часть — <b>${rub(row.amount === u.pay_total ? 0 : u.pay_total - row.amount)}</b>, до ${dm(c.due2)}. Я напомню заранее. Без неё доступ к обучению не откроется.\n\n` + next,
      { inline_keyboard: [[{ text: 'Оплатить вторую часть сразу', callback_data: 'pay:2' }]] });
  } else {
    await send(ctx, id, `Поздравляем, ты зачислен(а) в Di Sign University 🎓🐾\n\nТариф ${TARIFFS[row.tariff].title}, оплата получена полностью.\n\n` + next);
  }
  if (!u.phone && !u.email) {
    await send(ctx, id, 'Оставь телефон или почту: так куратору будет проще прислать тебе доступы и связаться, если что-то пойдёт не так.',
      { inline_keyboard: [[{ text: '📞 Телефон', callback_data: 'ct:phone' }, { text: '✉️ Почта', callback_data: 'ct:email' }]] }).catch(() => {});
  }
  await toAdmins(ctx, `💸 ${who(u)} — тариф ${TARIFFS[row.tariff].title}, ${row.part === 'full' ? 'целиком' : 'часть ' + row.part}: ${rub(row.amount)}`);
}

// ---------- резерв: таблица и файлы ----------
const fmtD = (ts) => (ts ? new Date((ts + 3 * 3600) * 1000).toISOString().replace('T', ' ').slice(0, 16) : '');
const partLabel = (p) => (p === 'full' ? 'целиком' : p === '1' ? 'часть 1 из 2' : 'часть 2 из 2');
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
  const a = [['Имя', 'Ник', 'Telegram ID', 'Телефон', 'Почта', 'Тариф', 'План', 'Цена тарифа', 'Оплачено', 'Осталось', 'Первая оплата', 'Оплачено полностью']];
  for (const u of users) a.push([u.contact_name || u.first_name, u.username ? '@' + u.username : '', u.tg_id, u.phone, u.email,
    TARIFFS[u.tariff] ? TARIFFS[u.tariff].title : u.tariff, u.pay_plan === 'full' ? 'целиком' : '2 части', u.pay_total, sums[u.tg_id] || 0,
    (u.pay_total || 0) - (sums[u.tg_id] || 0), fmtD(u.paid1_at), fmtD(u.paid_full_at)]);
  const pays = await ctx.db.all(`SELECT p.*, u.first_name, u.contact_name, u.username, u.phone, u.email FROM payments p LEFT JOIN users u ON u.tg_id = p.tg_id WHERE p.status = 'succeeded' ORDER BY p.paid_at`);
  const b = [['Дата', 'ID платежа', 'Имя', 'Ник', 'Telegram ID', 'Телефон', 'Почта', 'Тариф', 'Часть', 'Сумма']];
  for (const p of pays) b.push([fmtD(p.paid_at), p.id, p.contact_name || p.first_name, p.username ? '@' + p.username : '', p.tg_id, p.phone, p.email,
    TARIFFS[p.tariff] ? TARIFFS[p.tariff].title : p.tariff, partLabel(p.part), p.amount]);
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
    tg_id: u.tg_id, phone: u.phone || '', email: u.email || '', tariff: TARIFFS[row.tariff].title, part: partLabel(row.part),
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
  if (!ctx.env.YK_SHOP_ID) return;
  const now = ctx.now;
  const c = conf(ctx.env);

  await flushSheet(ctx).catch((e) => console.error('sheet', e.message));
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

  // 3) вторая часть: напоминания и закрытие доступа
  const split = await ctx.db.all(`SELECT * FROM users WHERE paid1_at IS NOT NULL AND paid_full_at IS NULL`);
  const daytime = msk.getUTCHours() >= 10 && msk.getUTCHours() < 20; // напоминания только днём по Москве, не ночью
  for (const u of split) {
    if (!daytime) break;
    if (now >= c.due2 - 3 * 86400 && now < c.due2 - 12 * 3600 && (await flag(ctx, u, 'r3'))) await askSecond(ctx, u).catch(() => {});
    else if (now >= c.due2 - 12 * 3600 && now < c.due2 && (await flag(ctx, u, 'r0'))) await askSecond(ctx, u).catch(() => {});
    else if (now >= c.due2 && (await flag(ctx, u, 'late'))) {
      await send(ctx, u.tg_id, 'Срок второй части прошёл, поэтому доступ к обучению пока закрыт. Если оплатишь сейчас — откроем 🐾',
        { inline_keyboard: [[{ text: 'Оплатить вторую часть', callback_data: 'pay:2' }]] }).catch(() => {});
      await toAdmins(ctx, `⏰ Не доплатил(а) вторую часть: ${who(u)}`);
    }
  }

  // 4) за день до старта: ссылки в кампус и список для выдачи доступов
  if (now >= c.inviteAt && now < c.start + 14 * 86400) {
    const paid = await ctx.db.all(`SELECT * FROM users WHERE paid_full_at IS NOT NULL AND (pay_flags IS NULL OR pay_flags NOT LIKE '%campus%')`);
    for (const u of paid) {
      if (!ctx.env.CAMPUS_CHAT_ID) break;
      try {
        const link = await ctx.tg.call('createChatInviteLink', { chat_id: ctx.env.CAMPUS_CHAT_ID, member_limit: 1, expire_date: c.start + 7 * 86400, name: `id${u.tg_id}` });
        await send(ctx, u.tg_id, `Завтра стартуем 🎓\n\nВот твоя личная ссылка во «Внутренний кампус» Di Sign University — она одноразовая, не пересылай её:`,
          { inline_keyboard: [[{ text: 'Войти в кампус', url: link.invite_link }]] });
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
  const id = msg.from.id;
  if (cmd === 'payoffer') {
    if (arg === 'test') return sendOffer(ctx, id);
    if (arg !== 'go') return send(ctx, id, 'Рассылка с тарифами уйдёт всем подписчикам, кто ещё не оплатил.\n\n/payoffer test — прислать только мне\n/payoffer go — разослать всем');
    await ctx.db.run(`INSERT OR REPLACE INTO settings (key, value) VALUES ('pay:broadcast', 'on')`);
    return send(ctx, id, 'Запустила рассылку: уходит по 150 человек в минуту. Напишу, когда закончится.');
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
      (rows.map((u) => `${u.paid_full_at ? '✅' : '½'} ${TARIFFS[u.tariff] ? TARIFFS[u.tariff].title : '?'}\n${who(u)}`).join('\n\n') || 'пока никого'));
  }
  return null;
}
