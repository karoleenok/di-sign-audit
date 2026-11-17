// Тест оплаты: тарифы, места, 2 части, уведомление ЮKassa, дубли, напоминания, файлы-резерв. Деньги и ЮKassa — подмена.
import assert from 'node:assert/strict';
import { nodeSqliteAdapter } from '../src/db-node.js';
import { migrate } from '../src/schema.js';
import * as pay from '../src/pay.js';

const db = await nodeSqliteAdapter(':memory:');
await migrate(db);
const T = Date.parse('2026-11-18T12:00:00+03:00') / 1000;
const out = [];
const tg = {
  call: async (m, p) => { out.push({ m, text: p.text || '', kb: JSON.stringify(p.reply_markup || ''), chat: p.chat_id }); return { invite_link: 'https://t.me/+one', message_id: 1 }; },
  upload: async (m, f) => { out.push({ m, name: f.get('document').name, body: await f.get('document').text() }); },
};
const env = { YK_SHOP_ID: '1', YK_SECRET: 's', ADMIN_IDS: '9', CAMPUS_CHAT_ID: '-100' };
const ctx = (now = T) => ({ db, tg, env, now, publicUrl: 'https://x.test' });
const cq = (id, d) => ({ id: 'q', from: { id }, data: d });
const sent = (re) => out.filter((o) => o.m === 'sendMessage' && re.test(o.text));

let n = 0;
globalThis.fetch = async (url, o = {}) => {
  if (String(url).endsWith('/v3/payments') && o.method === 'POST') {
    const b = JSON.parse(o.body); n++;
    return new Response(JSON.stringify({ id: 'pay-id-' + n + '-xxxxxxxx', status: 'pending', amount: b.amount, confirmation: { confirmation_url: 'https://pay.test/' + n } }), { status: 200 });
  }
  const m = /\/v3\/payments\/(.+)$/.exec(String(url));
  if (m) { const p = await db.first(`SELECT * FROM payments WHERE id = ?`, [m[1]]); return new Response(JSON.stringify({ id: m[1], status: 'succeeded', paid: true, amount: { value: p.amount.toFixed(2) } })); }
  throw new Error('неожиданный запрос ' + url);
};

await db.run(`INSERT INTO users (tg_id, first_name, username, phone, email, status, created_at) VALUES (1,'Маша','masha','+79990001122','m@x.ru','active',0)`);
await db.run(`INSERT INTO users (tg_id, first_name, status, created_at) VALUES (2,'Петя','active',0)`.replace("'Петя','active'", "'Петя',NULL,'active'").replace('(tg_id, first_name, status', '(tg_id, first_name, username, status'));

// предложение: цены предзаписи и места
await pay.sendOffer(ctx(), 1);
assert.match(out.at(-1).text, /77 777/); assert.match(out.at(-1).text, /Осталось мест: 5 из 5/); assert.match(out.at(-1).text, /20 из 20/);
// после предзаписи цены другие
await pay.sendOffer(ctx(Date.parse('2026-11-19T12:00:00+03:00') / 1000), 1);
assert.match(out.at(-1).text, /88 888/);

// тариф → 2 части → ссылка; второе нажатие отдаёт ту же ссылку
await pay.onPayCallback(ctx(), cq(1, 'pay:t:prof'));
await pay.onPayCallback(ctx(), cq(1, 'pay:s:prof'));
await pay.onPayCallback(ctx(T + 30), cq(1, 'pay:s:prof'));
assert.equal((await db.all(`SELECT * FROM payments`)).length, 1);
const p1 = await db.first(`SELECT * FROM payments`);
assert.equal(p1.amount, 16667);
assert.equal((await db.first(`SELECT COUNT(*) n FROM consents WHERE kind = 'offer'`)).n, 2); // согласие с офертой записано

// уведомление ЮKassa: чужой id игнорируется, настоящий зачисляет один раз
await pay.onYkNotify(ctx(T + 60), JSON.stringify({ object: { id: 'fake-fake-fake-fake' } }));
assert.equal(sent(/получена/).length, 0);
await pay.onYkNotify(ctx(T + 61), JSON.stringify({ object: { id: p1.id } }));
await pay.onYkNotify(ctx(T + 62), JSON.stringify({ object: { id: p1.id } }));
assert.equal(sent(/Первая часть получена/).length, 1);
const adm = sent(/💸/); assert.equal(adm.length, 1);
assert.match(adm[0].text, /\+79990001122/); assert.match(adm[0].text, /m@x\.ru/); assert.equal(adm[0].chat, 9);
const u1 = await db.first(`SELECT * FROM users WHERE tg_id = 1`);
assert.ok(u1.paid1_at && !u1.paid_full_at && u1.pay_total === 33333);
assert.equal((await db.all(`SELECT * FROM pay_outbox`)).length, 1);

// места: 5 на ректора, шестой получает «мест нет»
for (let i = 0; i < 5; i++) await db.run(`INSERT INTO users (tg_id, first_name, status, created_at, tariff, pay_total, paid1_at, paid_full_at) VALUES (?, 'R', 'active', 0, 'rector', 77777, ?, ?)`, [200 + i, T, T]);
assert.equal(await pay.seatsLeft(ctx(), 'rector'), 0);
await pay.onPayCallback(ctx(), cq(2, 'pay:t:rector'));
assert.match(out.at(-1).text, /места закончились/);
await pay.onPayCallback(ctx(), cq(2, 'pay:s:rector'));
assert.equal((await db.all(`SELECT * FROM payments WHERE tg_id = 2`)).length, 0);

// у Пети нет контактов: после оплаты бот просит телефон или почту
await pay.onPayCallback(ctx(), cq(2, 'pay:s:prof'));
const p2 = await db.first(`SELECT * FROM payments WHERE tg_id = 2`);
await pay.onYkNotify(ctx(T + 100), JSON.stringify({ object: { id: p2.id } }));
assert.ok(sent(/Оставь телефон или почту/).length === 1);

// вторая часть: напоминания и закрытие доступа
const d = (s) => Date.parse(s + '+03:00') / 1000;
await pay.payTick(ctx(d('2026-11-29T03:00:00'))); // ночью ничего не уходит
assert.equal(sent(/Осталась вторая/).length, 0);
await pay.payTick(ctx(d('2026-11-29T12:00:00')));
await pay.payTick(ctx(d('2026-11-29T12:01:00')));
assert.equal(sent(/Осталась вторая/).length, 2); // по одному на Машу и Петю, повтора нет
await pay.payTick(ctx(d('2026-12-01T13:00:00')));
await pay.payTick(ctx(d('2026-12-02T00:10:00'))); // ночью о закрытии доступа не пишем
assert.equal(sent(/доступ к обучению пока закрыт/).length, 0);
await pay.payTick(ctx(d('2026-12-02T10:30:00')));
assert.equal(sent(/доступ к обучению пока закрыт/).length, 2);
assert.equal(sent(/Не доплатил/).length, 2);

// Маша доплачивает: полная оплата → кампус
await pay.onPayCallback(ctx(d('2026-12-02T01:00:00')), cq(1, 'pay:2'));
const p3 = await db.first(`SELECT * FROM payments WHERE tg_id = 1 AND part = '2'`);
assert.equal(p3.amount, 16666);
await pay.onYkNotify(ctx(d('2026-12-02T01:01:00')), JSON.stringify({ object: { id: p3.id } }));
assert.ok((await db.first(`SELECT paid_full_at FROM users WHERE tg_id = 1`)).paid_full_at);
await pay.payTick(ctx(d('2026-12-02T11:31:00')));
assert.equal(out.filter((o) => o.m === 'createChatInviteLink').length, 6); // 5 полностью оплативших из теста + Маша
assert.ok(sent(/Пора выдать логины/).length === 1);

// резерв: два файла с контактами
await pay.sendFiles(ctx(), 9, 'тест');
const files = out.filter((o) => o.m === 'sendDocument');
assert.equal(files.length, 2);
assert.match(files[0].body, /Маша;@masha;1;\+79990001122;m@x\.ru;с профессором;2 части;33333;33333;0/);
console.log('✓ оплата: тарифы, места, 2 части, дубли, напоминания, кампус, резерв');
