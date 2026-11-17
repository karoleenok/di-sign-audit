// Тест оплаты: тарифы, места, оплата сразу, уведомление ЮKassa, дубли, кампус, резерв, настройки панели. Деньги и ЮKassa — подмена.
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
const env = { YK_SHOP_ID: '1', YK_SECRET: 's', ADMIN_IDS: '9', CAMPUS_CHAT_ID: '-100', YK_HOOK_SECRET: 'hooksecret1234' };
const ctx = (now = T, e = env) => ({ db, tg, env: e, now, publicUrl: 'https://x.test' });
const cq = (id, d) => ({ id: 'q', from: { id }, data: d });
const sent = (re) => out.filter((o) => o.m === 'sendMessage' && re.test(o.text));
const notify = (c, id) => pay.onYkNotify(c, JSON.stringify({ object: { id } }), 'hooksecret1234');
const d = (s) => Date.parse(s + '+03:00') / 1000;

let n = 0;
const created = [];
globalThis.fetch = async (url, o = {}) => {
  if (String(url).endsWith('/v3/payments') && o.method === 'POST') {
    const b = JSON.parse(o.body); n++; created.push(b);
    return new Response(JSON.stringify({ id: 'pay-id-' + n + '-xxxxxxxx', status: 'pending', amount: b.amount, confirmation: { confirmation_url: 'https://pay.test/' + n } }), { status: 200 });
  }
  const m = /\/v3\/payments\/(.+)$/.exec(String(url));
  if (m) { const p = await db.first(`SELECT * FROM payments WHERE id = ?`, [m[1]]); return new Response(JSON.stringify({ id: m[1], status: 'succeeded', paid: true, amount: { value: p.amount.toFixed(2) } })); }
  throw new Error('неожиданный запрос ' + url);
};

await db.run(`INSERT INTO users (tg_id, first_name, username, phone, email, status, created_at) VALUES (1,'Маша','masha','+79990001122','m@x.ru','active',0)`);
await db.run(`INSERT INTO users (tg_id, first_name, status, created_at) VALUES (2,'Петя','active',0)`);

// предложение: цены предзаписи, описание и места; своих двух частей нет
await pay.sendOffer(ctx(), 1);
assert.match(out.at(-1).text, /77 777/); assert.match(out.at(-1).text, /Осталось мест: 5 из 5/); assert.match(out.at(-1).text, /20 из 20/);
assert.match(out.at(-1).text, /[Пп]ерсональное ведение/); assert.match(out.at(-1).text, /созвоны в конце каждой главы/);
assert.doesNotMatch(out.at(-1).text, /2 части|втор/i);
assert.doesNotMatch(out.at(-1).text, /Долями/, 'про рассрочку банка молчим, пока она не включена в панели');
await pay.sendOffer(ctx(d('2026-11-19T12:00:00')), 1);
assert.match(out.at(-1).text, /88 888/); // после предзаписи цены обычные

// тариф → кнопка оплаты → ссылка; повторное нажатие отдаёт ту же ссылку
await pay.onPayCallback(ctx(), cq(1, 'pay:t:prof'));
assert.match(out.at(-1).text, /оферты/); assert.doesNotMatch(out.at(-1).kb, /pay:s:|В 2 части/);
await pay.onPayCallback(ctx(), cq(1, 'pay:f:prof'));
await pay.onPayCallback(ctx(T + 30), cq(1, 'pay:f:prof'));
assert.equal((await db.all(`SELECT * FROM payments`)).length, 1);
const p1 = await db.first(`SELECT * FROM payments`);
assert.equal(p1.amount, 33333);
assert.equal(created[0].amount.value, '33333.00'); assert.equal(created[0].metadata.tg_id, '1'); assert.equal(created[0].metadata.tariff, 'prof');
assert.equal((await db.first(`SELECT COUNT(*) n FROM consents WHERE kind = 'offer'`)).n, 2); // согласие с офертой записано

// уведомление ЮKassa: чужой id игнорируется, настоящий зачисляет один раз
await notify(ctx(T + 60), 'fake-fake-fake-fake');
assert.equal(sent(/зачислен/).length, 0);
await notify(ctx(T + 61), p1.id);
await notify(ctx(T + 62), p1.id);
assert.equal(sent(/Поздравляем/).length, 1);
const adm = sent(/💸/); assert.equal(adm.length, 1);
assert.match(adm[0].text, /\+79990001122/); assert.match(adm[0].text, /m@x\.ru/); assert.equal(adm[0].chat, 9);
const u1 = await db.first(`SELECT * FROM users WHERE tg_id = 1`);
assert.ok(u1.paid1_at && u1.paid_full_at && u1.pay_total === 33333);
assert.equal((await db.all(`SELECT * FROM pay_outbox`)).length, 1);
await pay.onPayCallback(ctx(T + 90), cq(1, 'pay:t:prof')); // уже оплатила
assert.match(out.at(-1).text, /уже зачислен/);

// места: 5 на ректора, шестой получает «мест нет» и лист ожидания
for (let i = 0; i < 5; i++) await db.run(`INSERT INTO users (tg_id, first_name, status, created_at, tariff, pay_total, paid1_at, paid_full_at) VALUES (?, 'R', 'active', 0, 'rector', 77777, ?, ?)`, [200 + i, T, T]);
assert.equal(await pay.seatsLeft(ctx(), 'rector'), 0);
await pay.onPayCallback(ctx(), cq(2, 'pay:t:rector'));
assert.match(out.at(-1).text, /места закончились/);
await pay.onPayCallback(ctx(), cq(2, 'pay:f:rector'));
assert.equal((await db.all(`SELECT * FROM payments WHERE tg_id = 2`)).length, 0);
await pay.onPayCallback(ctx(), cq(2, 'pay:w:rector'));
assert.equal(sent(/Лист ожидания/).length, 1);

// у Пети нет контактов: ссылку на оплату он получит только после телефона и почты
await pay.onPayCallback(ctx(), cq(2, 'pay:f:prof'));
assert.equal((await db.all(`SELECT * FROM payments WHERE tg_id = 2`)).length, 0, 'без контактов ссылку не даём');
assert.match(out.at(-1).text, /телефон/i);
const { onUserText } = await import('../src/users.js');
await onUserText(ctx(T + 95), { from: { id: 2 }, text: '+7 999 111-22-33' }, 'u:phone');
assert.equal((await db.all(`SELECT * FROM payments WHERE tg_id = 2`)).length, 0, 'без почты ссылку не даём');
assert.match(out.at(-1).text, /почт/i);
await onUserText(ctx(T + 96), { from: { id: 2 }, text: 'petya@x.ru' }, 'u:email');
const p2 = await db.first(`SELECT * FROM payments WHERE tg_id = 2`);
assert.ok(p2, 'после телефона и почты ссылка создана');
assert.match(out.at(-1).text, /К оплате: 33 333/); assert.match(out.at(-1).kb, /pay\.test/);
const u2 = await db.first(`SELECT * FROM users WHERE tg_id = 2`);
assert.equal(u2.phone, '+79991112233'); assert.equal(u2.email, 'petya@x.ru');
await notify(ctx(T + 100), p2.id);
assert.match(sent(/💸/).at(-1).text, /\+79991112233/);

// тексты можно править в /texts: своя версия подхватывается, картинка и кнопки остаются
const { saveMsg, resetMsg } = await import('../src/msgs.js');
await saveMsg(ctx(), 'payThanks', 'Ура, {тариф}! Логины {дата_доступов}.', []);
await db.run(`UPDATE payments SET status = 'pending', paid_at = NULL WHERE id = ?`, [p2.id]);
await db.run(`UPDATE users SET paid1_at = NULL, paid_full_at = NULL WHERE tg_id = 2`);
await notify(ctx(T + 101), p2.id);
assert.match(sent(/Ура, с профессором/).at(-1).text, /Логины 02\.12/);
await resetMsg(ctx(), 'payThanks');

// сброс тестовых платежей: только у того, кто нажал команду
await db.run(`INSERT INTO users (tg_id, first_name, status, created_at) VALUES (9, 'Админ', 'active', 0)`);
// страховка: уведомление не пришло, платёж ловит опрос (и один раз предупреждает админов)
await db.run(`INSERT INTO users (tg_id, first_name, phone, email, status, created_at) VALUES (5, 'Опрос', '+79995550000', 'o@x.ru', 'active', 0)`);
await pay.onPayCallback(ctx(T + 200), cq(5, 'pay:f:prof'));
const pp = await db.first(`SELECT * FROM payments WHERE tg_id = 5`);
assert.equal(pp.status, 'pending');
const polled = await pay.pollPending(ctx(T + 600));
assert.equal(polled.paid, 1);
assert.equal((await db.first(`SELECT status FROM payments WHERE id = ?`, [pp.id])).status, 'succeeded');
assert.equal(sent(/Поздравляем/).filter((o) => o.chat === 5).length, 1, 'человек получил «зачислен(а)» без уведомления');
assert.equal((await pay.pollPending(ctx(T + 660))).paid, 0, 'повторно не зачисляем');
await notify(ctx(T + 700), pp.id);
assert.equal(sent(/Поздравляем/).filter((o) => o.chat === 5).length, 1, 'позднее уведомление дубль не шлёт');
await pay.payAdminCommand(ctx(), { from: { id: 9 } }, 'paycheck', '');
assert.match(out.at(-1).text, /Неоплаченных платежей за последние сутки нет|Проверила/);
await pay.payAdminCommand(ctx(), { from: { id: 5 } }, 'payreset', 'yes'); // чистим служебного студента

// вернулся из ЮKassa: платёж проверяется сразу; если банк ещё думает, человека успокаиваем
await db.run(`INSERT INTO users (tg_id, first_name, phone, email, status, created_at) VALUES (6, 'Возврат', '+79996660000', 'v@x.ru', 'active', 0)`);
await pay.onPayCallback(ctx(T + 800), cq(6, 'pay:f:prof'));
const realFetch = globalThis.fetch;
globalThis.fetch = async (url) => new Response(JSON.stringify({ id: 'x', status: 'pending', paid: false, amount: { value: '33333.00' } }));
await pay.payReturned(ctx(T + 810), 6);
globalThis.fetch = realFetch;
assert.match(out.at(-1).text, /Банк ещё подтверждает/);
assert.equal(sent(/Поздравляем/).filter((o) => o.chat === 6).length, 0);
await pay.payReturned(ctx(T + 820), 6);
assert.equal(sent(/Поздравляем/).filter((o) => o.chat === 6).length, 1, 'при возврате платёж зачтён сразу');
await pay.payAdminCommand(ctx(), { from: { id: 6 } }, 'payreset', 'yes');

// входы по ссылке: ?start=pay_prof сразу открывает тариф, новичок сначала проходит обычный вход
await db.run(`INSERT INTO users (tg_id, first_name, status, created_at, sched_at) VALUES (10, 'Ссылка', 'active', 0, ?)`, [T]);
await db.run(`UPDATE users SET phone = '+79990001000', email = 'l@x.ru' WHERE tg_id = 10`);
assert.equal(await pay.payEntry(ctx(), { from: { id: 10 } }, 'prof'), true);
assert.match(out.at(-1).text, /К оплате: 33 333/); assert.match(out.at(-1).text, /оферты/); assert.match(out.at(-1).kb, /pay\.test/);
assert.equal(await pay.payEntry(ctx(), { from: { id: 10 } }, ''), true);
assert.match(out.at(-1).text, /Набор в Di Sign University открыт/);
assert.equal(await pay.payEntry(ctx(), { from: { id: 11 }, chat: {} }, 'prof'), false, 'новичок идёт во вход');
await db.run(`INSERT INTO users (tg_id, first_name, status, created_at) VALUES (11, 'Новичок', 'new', 0)`);
await pay.payTick(ctx(T + 900));
assert.equal(out.filter((o) => o.chat === 11).length, 0, 'до конца входа ничего не уходит');
await db.run(`UPDATE users SET sched_at = ?, status = 'active' WHERE tg_id = 11`, [T + 910]);
await pay.payTick(ctx(T + 960));
assert.ok(out.filter((o) => o.m === 'sendMessage' && o.chat === 11 && /телефон/i.test(o.text)).length >= 1, 'после входа сразу к оплате: просит контакты');
assert.equal(sent(/Набор в Di Sign University открыт/).filter((o) => o.chat === 11).length, 0, 'выбранный тариф: общее предложение не шлём');
// после общей рассылки новичкам предложение приходит само через сутки после входа
await db.run(`INSERT OR REPLACE INTO settings (key, value) VALUES ('pay:broadcast', 'done')`);
await db.run(`INSERT INTO users (tg_id, first_name, status, created_at, sched_at) VALUES (12, 'Старый', 'active', 0, ?)`, [T - 90000]);
await db.run(`INSERT INTO users (tg_id, first_name, status, created_at, sched_at) VALUES (13, 'Свежий', 'active', 0, ?)`, [T + 1000]);
await pay.payTick(ctx(T + 1100));
const gotOffer = (id) => out.filter((o) => o.m === 'sendMessage' && o.chat === id && /Набор в Di Sign University открыт/.test(o.text)).length;
assert.equal(gotOffer(12), 1); assert.equal(gotOffer(13), 0);
await pay.payTick(ctx(T + 1160));
assert.equal(gotOffer(12), 1, 'второй раз не шлём');

// кнопки в постах и сообщениях: «Оплата тарифа» ведёт в оплату, старые названия (curator, mentor) понимаем
const { keyboard } = await import('../src/posts.js');
const kbp = keyboard({ id: 5, buttons: JSON.stringify([[{ text: 'Хочу', pay: 'prof' }, { text: 'Персонально', pay: 'mentor' }, { text: 'Оба', pay: 'all' }]]) }, 1, 'https://x.test', {});
assert.equal(kbp.inline_keyboard[0].length, 3);
assert.ok(kbp.inline_keyboard[0].every((b) => /^buy:5:0-\d$/.test(b.callback_data)));
const { payKey } = await import('../src/msgs.js');
assert.deepEqual(['curator', 'mentor', 'prof', 'rector', 'all', undefined].map(payKey), ['prof', 'rector', 'prof', 'rector', 'all', 'all']);
await db.run(`INSERT INTO users (tg_id, first_name, phone, email, status, created_at, sched_at) VALUES (14, 'Кнопка', '+79994440000', 'k@x.ru', 'active', 0, ?)`, [T]);
await pay.payFromButton(ctx(), { id: 'q', from: { id: 14 } }, 'prof');
assert.match(out.at(-1).text, /К оплате: 33 333/); assert.match(out.at(-1).kb, /pay\.test/);
await pay.payFromButton(ctx(), { id: 'q', from: { id: 14 } }, 'all');
assert.match(out.at(-1).text, /Набор в Di Sign University открыт/);
await pay.payFromButton(ctx(), { id: 'q', from: { id: 999 } }, 'prof');
assert.match(out.at(-1).text, /\/start/, 'незнакомому — сначала /start');
await pay.payFromButton(ctx(), { id: 'q', from: { id: 14 } }, 'check');
assert.match(out.at(-1).text, /Набор в Di Sign University открыт/, 'служебный тариф кнопкой не открыть');

// одно сообщение вместо двух: экран тарифа превращается в ссылку на оплату на месте, оферта — кнопкой
const n0 = out.length;
await pay.onPayCallback(ctx(), { id: 'q', from: { id: 14 }, data: 'pay:f:prof', message: { message_id: 77, chat: { id: 14 } } });
const ed = out.slice(n0).find((o) => o.m === 'editMessageText');
assert.ok(ed && /К оплате: 33 333/.test(ed.text), 'экран тарифа заменён ссылкой');
assert.match(ed.kb, /pay\.test/); assert.match(ed.kb, /Оферта/);
assert.doesNotMatch(ed.text, /https?:\/\//, 'длинной ссылки на оферту в тексте нет');
assert.equal(out.slice(n0).filter((o) => o.m === 'sendMessage').length, 0, 'новое сообщение не отправлялось');
await pay.onPayCallback(ctx(), cq(14, 'pay:t:prof'));
assert.match(out.at(-1).kb, /Оферта/); assert.match(out.at(-1).text, /^Тариф с профессором — 33 333 ₽\.\nГруппа, /);

// проверка настоящей оплаты на 1 ₽: только по команде админа, в списке тарифов её нет
assert.deepEqual(Object.keys(pay.TARIFFS), ['rector', 'prof']);
const before = (await db.all(`SELECT * FROM payments`)).length;
await pay.onPayCallback(ctx(), cq(2, 'pay:t:check')); await pay.onPayCallback(ctx(), cq(2, 'pay:f:check'));
assert.equal((await db.all(`SELECT * FROM payments`)).length, before, 'студент не может запустить служебный тариф');
await db.run(`UPDATE users SET phone = '+79990000000', email = 'a@x.ru' WHERE tg_id = 9`);
await pay.payAdminCommand(ctx(), { from: { id: 9 } }, 'paytest', '');
const pc9 = await db.first(`SELECT * FROM payments WHERE tg_id = 9`);
assert.ok(pc9 && pc9.amount === 1 && pc9.tariff === 'check');
assert.equal(created.at(-1).amount.value, '1.00');
await notify(ctx(T + 120), pc9.id);
assert.match(sent(/💸/).at(-1).text, /тариф проверка: 1 ₽/);
assert.equal(await pay.seatsLeft(ctx(), 'prof'), 20 - 4, 'проверка не занимает места (заняты: две оплаты и две ссылки в ожидании)');
await pay.payAdminCommand(ctx(), { from: { id: 9 } }, 'payreset', '');
assert.match(out.at(-1).text, /payreset yes/);
await pay.payAdminCommand(ctx(), { from: { id: 9 } }, 'payreset', 'yes');
assert.equal((await db.all(`SELECT * FROM payments WHERE tg_id = 2`)).length, 1, 'чужие платежи не трогаем');
assert.equal((await db.all(`SELECT * FROM payments WHERE tg_id = 9`)).length, 0, 'свои платежи стёрты');

// никаких напоминаний про вторую часть и закрытия доступа
await pay.payTick(ctx(d('2026-11-29T12:00:00')));
await pay.payTick(ctx(d('2026-12-02T10:30:00')));
assert.equal(sent(/втор(ая|ую|ой) част/i).length, 0);
assert.equal(out.filter((o) => o.m === 'createChatInviteLink').length, 0, 'до назначенного времени ссылок нет');
// за день до старта: личные ссылки в кампус всем оплатившим (5 ректоров + Маша + Петя + «Ссылка», которого зачёл опрос) и список для логинов
await pay.payTick(ctx(d('2026-12-02T11:31:00')));
assert.equal(out.filter((o) => o.m === 'createChatInviteLink').length, 8);
await pay.payTick(ctx(d('2026-12-02T11:45:00')));
assert.equal(out.filter((o) => o.m === 'createChatInviteLink').length, 8, 'повторно ссылки не создаются');
assert.equal(sent(/Пора выдать логины/).length, 1);

// резерв: два файла с контактами, без колонок про части
await pay.sendFiles(ctx(), 9, 'тест');
const files = out.filter((o) => o.m === 'sendDocument');
assert.equal(files.length, 2);
assert.match(files[0].body, /Имя;Ник;Telegram ID;Телефон;Почта;Тариф;Оплачено;Дата оплаты/);
assert.match(files[0].body, /Маша;@masha;1;\+79990001122;m@x\.ru;с профессором;33333;2026-11-18 12:01/);
assert.doesNotMatch(files[0].body + files[1].body, /часть|План|Осталось/i);

// вкладка «Оплаты» во внутренней таблице: контакты, тариф, статус
const { sheetRows, buildXlsx } = await import('../src/export.js');
const tbl = await sheetRows(ctx());
const masha = tbl.pays.find((r) => r[0] === '1');
assert.ok(masha && masha[2] === 'Маша' && masha[3] === '@masha' && masha[4] === '+79990001122' && masha[5] === 'm@x.ru' && masha[6] === 'с профессором' && masha[7] === '33333' && masha[8] === 'оплачено');
assert.ok(Buffer.isBuffer(buildXlsx([{ name: 'Оплаты', head: ['a'], rows: tbl.pays.map((r) => [r[0]]), widths: [10] }])));

// настройки из панели: шифрование, проверки ввода, секрет адреса, сроки, рассрочка банка
const { payPanelSave, payPanelState, withPay } = await import('../src/paycfg.js');
const pc = { db, tg, env: { BOT_TOKEN: '123:abc' }, now: T, publicUrl: 'https://x.test' };
const KEY = 'test_' + 'A'.repeat(30);
const r = await payPanelSave(pc, { shopId: '1486061', secret: KEY, genHook: true, campus: '-1001234567890', preUntil: '2026-11-21T23:59', sheetUrl: 'https://script.google.com/macros/s/AKfy-1/exec', sheetKey: 'sheetsecret99' });
assert.ok(r.ok, JSON.stringify(r));
const raw = (await db.first(`SELECT value FROM settings WHERE key = 'paycfg'`)).value;
assert.ok(!raw.includes('AAAAAAAAAA') && !raw.includes('sheetsecret99'), 'секреты в базе открытым текстом');
assert.ok(!JSON.stringify(r.state).includes('AAAAAAAAAA'), 'панель отдала секрет назад');
assert.equal(r.state.mode, 'test'); assert.equal(r.state.sheetKeySet, true); assert.equal(r.state.bnpl, false);
assert.match(r.state.hookUrl, /^https:\/\/x\.test\/yk\/[0-9a-f]{36}$/);
const w = await withPay(pc);
assert.equal(w.env.YK_SECRET, KEY); assert.equal(w.env.PAY_PRE_UNTIL, '2026-11-21T23:59:00'); assert.equal(w.env.CAMPUS_CHAT_ID, '-1001234567890');
assert.equal((await withPay({ db, env: { BOT_TOKEN: 'другой' }, now: T })).env.YK_SECRET, '', 'с чужим токеном ключ не расшифровать');
assert.ok((await payPanelSave(pc, { secret: 'abc' })).error);
assert.ok((await payPanelSave(pc, { secret: 'live_' + 'B'.repeat(20) + ' чужой текст' })).error);
const dirty = await payPanelSave(pc, { secret: ' «live_' + 'C'.repeat(25) + '​" ' });
assert.ok(dirty.ok && dirty.state.mode === 'live', JSON.stringify(dirty));
assert.equal((await withPay(pc)).env.YK_SECRET, 'live_' + 'C'.repeat(25));
assert.equal((await payPanelSave(pc, { secret: 'X'.repeat(40) })).state.mode, 'other'); // ключ без префикса не отвергаем
await payPanelSave(pc, { secret: KEY });
assert.ok((await payPanelSave(pc, { shopId: 'x1' })).error);
assert.ok((await payPanelSave(pc, { sheetUrl: 'http://evil.test' })).error);
assert.ok((await payPanelSave(pc, { preUntil: 'вчера' })).error);
assert.equal((await payPanelSave(pc, { shopId: '1486061' })).state.secretSet, true, 'пустое поле ключа не стирает старый');
const hook = r.state.hookUrl.split('/yk/')[1];
assert.equal(await pay.onYkNotify(pc, '{}', 'wrongwrongwrong'), false);
assert.equal(await pay.onYkNotify(pc, '{}', hook), true);
// сроки из панели влияют на цену
out.length = 0; await pay.sendOffer({ ...pc, now: d('2026-11-22T12:00:00') }, 1);
assert.match(out.at(-1).text, /88 888/);
// рассрочка банка: пока выключена — молчим, включили в панели — упоминаем
assert.doesNotMatch(out.at(-1).text, /Долями/);
assert.equal((await payPanelSave(pc, { bnpl: true })).state.bnpl, true);
out.length = 0; await pay.sendOffer({ ...pc, now: d('2026-11-22T12:00:00') }, 1);
assert.match(out.at(-1).text, /Долями, Сплит/);
console.log('✓ оплата сразу: тарифы, места, дубли, кампус, резерв; настройки панели и рассрочка банка');
