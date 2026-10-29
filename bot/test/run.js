// Прогон сценариев на фейковом Telegram и базе в памяти.
import assert from 'node:assert/strict';
import { nodeSqliteAdapter } from '../src/db-node.js';
import { migrate } from '../src/schema.js';
import { makeCtx, handleUpdate, tick, clickRedirect } from '../src/core.js';
import { parseWhen, fmtWhen } from '../src/time.js';

const calls = [];
let failEmoji = false, fail403 = new Set(), fail429 = false, msgId = 1000;
const fakeFetch = async (url, init) => {
  const method = url.split('/').pop();
  const body = JSON.parse(init.body);
  calls.push({ method, body });
  const ok = (result) => ({ json: async () => ({ ok: true, result }) });
  const err = (code, d, extra) => ({ json: async () => ({ ok: false, error_code: code, description: d, ...extra }) });
  const ents = [...(body.entities || []), ...(body.caption_entities || []), ...((body.media || [])[0]?.caption_entities || [])];
  if (failEmoji && ents.some((e) => e.type === 'custom_emoji')) return err(400, 'Bad Request: custom emoji not allowed');
  if (fail403.has(body.chat_id) && method.startsWith('send')) return err(403, 'Forbidden: bot was blocked by the user');
  if (fail429 && method.startsWith('send')) return err(429, 'Too Many Requests', { parameters: { retry_after: 7 } });
  if (method === 'getMe') return ok({ username: 'di_sign_university_bot' });
  if (method === 'getMyDescription') return ok({ description: 'бот с полезностями от Di Sign University' });
  if (method === 'getMyShortDescription') return ok({ short_description: 'полезности для дизайнеров' });
  if (method === 'getWebhookInfo') return ok({ url: 'https://x.workers.dev/tg', pending_update_count: 0 });
  if (method === 'sendMediaGroup') return ok(body.media.map(() => ({ message_id: ++msgId })));
  const r = { message_id: ++msgId }; calls[calls.length - 1].res = r;
  return ok(r);
};

const db = await nodeSqliteAdapter(':memory:');
await migrate(db);
const env = { DELAY_FACTOR: '0', BOT_TOKEN: '1:x', ADMIN_IDS: '100', POLICY_URL: 'https://disign.ru/policy', TEST_URL: 'https://example.com/test' };
let NOW = parseWhen('01.11.2026 10:00', Date.UTC(2026, 9, 29) / 1000);
const C = () => makeCtx({ db, env, fetchFn: fakeFetch, publicUrl: 'https://bot.test', now: NOW });
let upd = 1, mid = 1;
const msg = (from, text, extra = {}) => handleUpdate(C(), { update_id: upd++, message: { message_id: mid++, from: { id: from, first_name: 'U' + from }, chat: { id: from, type: 'private' }, text, ...extra } });
const cb = (from, data) => handleUpdate(C(), { update_id: upd++, callback_query: { id: 'q' + upd, from: { id: from }, data, message: { message_id: 1, chat: { id: from } } } });
const last = (chat, n = 1) => calls.filter((c) => c.body.chat_id === chat).slice(-n);
const lastText = (chat) => { const c = last(chat)[0]; return c && (c.body.text || c.body.caption || c.method); };
const sentTo = (chat, from) => calls.slice(from).filter((c) => c.body.chat_id === chat && c.method.startsWith('send'));
const step = (t) => console.log('✓', t);

// ---------- админ создаёт посты ----------
await msg(100, '/new');
assert.match(lastText(100), /Пришли пост/);
// альбом из 3 фото с подписью (приходит тремя сообщениями)
const cap = 'Ваш подарок 🎁 шаблон кейса';
await msg(100, undefined, { photo: [{ file_id: 'small' }, { file_id: 'ph1' }], media_group_id: 'g1', caption: cap, caption_entities: [{ type: 'custom_emoji', offset: 11, length: 2, custom_emoji_id: '5368' }] });
await msg(100, undefined, { photo: [{ file_id: 'ph2' }], media_group_id: 'g1' });
await msg(100, undefined, { photo: [{ file_id: 'ph3' }], media_group_id: 'g1' });
assert.equal(calls.filter((c) => c.body.chat_id === 100 && /Принято/.test(c.body.text || '')).length, 1, 'на альбом один ответ');
await cb(100, 'w:done');
await cb(100, 'w:kind:gift');
await cb(100, 'w:aud:all');
await msg(100, 'Открыть в Figma | https://figma.com/x');
// предпросмотр: альбом + сообщение с кнопкой
const pv = last(100, 3);
assert.equal(pv[0].method, 'sendMediaGroup');
assert.equal(pv[0].body.media.length, 3);
assert.equal(pv[0].body.media[0].caption, cap);
assert.equal(pv[1].method, 'sendMessage'); assert.ok(pv[1].body.reply_markup.inline_keyboard[0][0].url);
await cb(100, 'w:save:1');
assert.match(lastText(100), /Сохранено и включено/);
step('админ: подарок-альбом из 3 фото с премиум-эмодзи и кнопкой');

// пост по дням: день 1, 11:00, начинающим
await msg(100, '/new');
await msg(100, 'Материал дня 1 для начинающих', { entities: [{ type: 'bold', offset: 0, length: 8 }] });
await cb(100, 'w:done'); await cb(100, 'w:kind:drip');
await msg(100, '1'); await cb(100, 'w:tm:11:00'); await cb(100, 'w:aud:start');
await msg(100, 'Сайт | https://disign.ru; Чат | t.me/disign');
await cb(100, 'w:save:1');
// пост по дням: день 2, продолжающим
await msg(100, '/new'); await msg(100, 'Материал дня 2 для продолжающих');
await cb(100, 'w:done'); await cb(100, 'w:kind:drip'); await msg(100, '2'); await msg(100, '19:30'); await cb(100, 'w:aud:pro'); await cb(100, 'w:nobtn'); await cb(100, 'w:save:1');
// пост в дату: всем
await msg(100, '/new'); await msg(100, 'Эфир в четверг!');
await cb(100, 'w:done'); await cb(100, 'w:kind:date'); await msg(100, '03.11 19:00'); await cb(100, 'w:aud:all'); await cb(100, 'w:nobtn'); await cb(100, 'w:save:1');
const posts = await db.all('SELECT id, kind, audience, zone, day, send_time, run_at, status FROM posts');
assert.equal(posts.length, 4);
assert.deepEqual(posts.map((p) => p.kind), ['gift', 'drip', 'drip', 'date']);
assert.equal(posts[2].send_time, '19:30');
assert.equal(fmtWhen(posts[3].run_at), '03.11.2026 19:00');
step('админ: посты по дням (начинающим / продолжающим) и в дату, время и кнопки');

// ---------- ученики ----------
// 200: из теста, зона P, уровень start
await msg(200, '/start audit_P_start');
assert.match(lastText(200), /согласие/);
const before = calls.length;
await cb(200, 'c:pd');
const g = sentTo(200, before);
assert.ok(g.some((c) => c.method === 'sendMediaGroup'), 'получил подарок-альбом');
assert.match(lastText(200), /рекламная рассылка/);
await cb(200, 'c:ads:1');
let u = await db.first('SELECT * FROM users WHERE tg_id = 200');
assert.equal(u.status, 'active'); assert.equal(u.level, 'start'); assert.equal(u.zone, 'P');
step('ученик из теста: согласие → подарок после теста → согласие на рассылку');

// 300: обычная ссылка, выбирает «продолжающий» и зону
await msg(300, '/start');
await cb(300, 'c:pd');
assert.match(lastText(300), /Где ты сейчас/);
await cb(300, 'lv:pro');
const off = last(300, 2)[0];
assert.match(off.body.text, /аудит-тест/, 'после уровня — предложение пройти тест');
assert.equal(off.body.reply_markup.inline_keyboard[0][0].text, 'Пройти тест');
assert.match(lastText(300), /рекламная рассылка/, 'зону в боте не спрашиваем');
await cb(300, 'c:ads:1');
// прошёл тест и вернулся по ссылке из теста
{ const c0 = calls.length;
  await msg(300, '/start audit_S_pro');
  assert.ok(sentTo(300, c0).some((c) => c.method === 'sendMediaGroup'), 'после теста пришёл общий подарок (зона не важна)');
  assert.match(sentTo(300, c0)[0].body.text, /аудит пройден/); }
u = await db.first('SELECT * FROM users WHERE tg_id = 300');
assert.equal(u.zone, 'S'); assert.equal(u.status, 'active');
// 400: отказался от рекламы
await msg(400, '/start audit_V_free'); await cb(400, 'c:pd'); await cb(400, 'c:ads:0');
u = await db.first('SELECT * FROM users WHERE tg_id = 400');
assert.equal(u.status, 'stopped'); assert.equal(u.level, 'pro');
step('обычный вход: уровень → кнопка «Пройти тест» → рассылка; после теста — подарок; отказ от рассылки');

// ---------- расписание ----------
const tickAt = async (when) => { NOW = parseWhen(when, NOW); const c0 = calls.length; const r = await tick(C(), 40); return { r, c: calls.slice(c0) }; };
let t = await tickAt('01.11.2026 18:00');
assert.equal(t.c.length, 0, 'в день входа ничего лишнего');
t = await tickAt('02.11.2026 11:00');
assert.deepEqual(t.c.filter((c) => c.method.startsWith('send')).map((c) => c.body.chat_id), [200], 'день 1 — только начинающему');
assert.match(t.c[0].body.reply_markup.inline_keyboard[0][0].url, /^https:\/\/bot\.test\/r\/\d+\/0-0\/200$/);
assert.equal(t.c[0].body.reply_markup.inline_keyboard[0].length, 2, 'две кнопки в ряд');
t = await tickAt('02.11.2026 11:01');
assert.equal(t.c.length, 0, 'повторно не шлёт');
t = await tickAt('03.11.2026 19:00');
const to = t.c.filter((c) => c.method.startsWith('send')).map((c) => c.body.chat_id).sort();
assert.deepEqual(to, [200, 300], 'эфир всем, кто был в боте');
t = await tickAt('03.11.2026 19:30');
assert.deepEqual(t.c.filter((c) => c.method.startsWith('send')).map((c) => c.body.chat_id), [300], 'день 2 в 19:30 — только продолжающему');
step('лента: день 1 в 11:00 начинающим, день 2 в 19:30 продолжающим, пост в дату всем; без повторов');

// новый человек после даты эфира не получает старый пост
await msg(500, '/start audit_P_start'); await cb(500, 'c:pd'); await cb(500, 'c:ads:1');
t = await tickAt('03.11.2026 19:35');
assert.equal(t.c.length, 0, 'опоздавшему старый эфир не приходит');
step('опоздавшим старый пост в дату не уходит');

// ---------- клики ----------
const pid = posts[1].id;
const url = await clickRedirect(C(), pid, '0-1', 200);
assert.equal(url, 'https://t.me/disign');
assert.equal((await db.first('SELECT COUNT(*) AS n FROM clicks')).n, 1);
step('нажатие кнопки считается и ведёт на ссылку');

// ---------- ошибки отправки ----------
await msg(100, '/new'); await msg(100, 'Срочно всем'); await cb(100, 'w:done'); await cb(100, 'w:kind:date'); await msg(100, 'завтра 12:00'); await cb(100, 'w:aud:all'); await cb(100, 'w:nobtn'); await cb(100, 'w:save:1');
const urgent = await db.first(`SELECT * FROM posts ORDER BY id DESC LIMIT 1`);
fail403.add(300);
fail429 = false;
t = await tickAt('04.11.2026 12:00');
assert.equal((await db.first('SELECT status FROM users WHERE tg_id = 300')).status, 'blocked');
step('кто заблокировал бота — помечается и больше не получает');

await msg(100, '/new'); await msg(100, 'Ещё один'); await cb(100, 'w:done'); await cb(100, 'w:kind:date'); await msg(100, 'завтра 12:00'); await cb(100, 'w:aud:all'); await cb(100, 'w:nobtn'); await cb(100, 'w:save:1');
fail429 = true;
t = await tickAt('05.11.2026 12:00');
assert.ok(+(await db.first(`SELECT value FROM settings WHERE key='pause_until'`)).value > NOW);
fail429 = false;
t = await tickAt('05.11.2026 12:00');
assert.equal(t.c.length, 0, 'во время паузы не шлёт');
t = await tickAt('05.11.2026 12:01');
assert.ok(t.c.length > 0, 'после паузы дослал');
step('лимит Telegram (429): пауза и досылка');

// ---------- премиум-эмодзи: запасной вариант ----------
failEmoji = true;
const c0 = calls.length;
await cb(100, 'p:' + posts[0].id + ':t');
const tries = calls.slice(c0).filter((c) => c.method === 'sendMediaGroup');
assert.equal(tries.length, 2, 'вторая попытка без премиум-эмодзи');
assert.match(lastText(100), /Премиум-эмодзи не прошли/);
failEmoji = false;
step('если премиум-эмодзи не пройдут — пост всё равно уйдёт, админ увидит предупреждение');

// ---------- админка ----------
await msg(100, '/posts');
assert.ok(last(100)[0].body.reply_markup.inline_keyboard.length >= 6);
await cb(100, 'p:' + pid);
assert.match(lastText(100), /день 1 · 11:00/);
await cb(100, 'p:' + pid + ':off');
assert.equal((await db.first('SELECT status FROM posts WHERE id = ?', [pid])).status, 'paused');
await cb(100, 'p:' + pid + ':ew'); await msg(100, '3'); await msg(100, '10:15');
assert.match(lastText(100), /день 3 · 10:15/);
await cb(100, 'p:' + pid + ':ec'); await msg(100, 'Новый текст'); await cb(100, 'w:done');
assert.equal((await db.first('SELECT text FROM posts WHERE id = ?', [pid])).text, 'Новый текст');
await msg(100, '/stats');
assert.match(lastText(100), /Всего в боте: 4/);
await msg(100, '/check');
assert.match(lastText(100), /Связь с Telegram есть/);
await msg(100, '/addadmin 777');
assert.ok(calls.some((c) => c.method === 'setMyCommands' && c.body.scope && c.body.scope.chat_id === 777));
// новый админ может работать
await msg(777, '/posts');
assert.match(lastText(777), /Посты/);
// обычный человек админку не видит
await msg(500, '/posts');
assert.match(lastText(500), /Я бот с материалами/);
await cb(500, 'p:' + pid + ':on');
assert.equal((await db.first('SELECT status FROM posts WHERE id = ?', [pid])).status, 'paused', 'чужие нажатия игнорируются');
step('админка: список, карточка, пауза, смена дня и времени, замена текста, статистика, проверка, второй админ, защита от чужих');

// ---------- ученик: команды ----------
await msg(200, '/level'); await cb(200, 'lv:pro');
assert.match(lastText(200), /продолжающий/);
await msg(200, '/stop');
assert.equal((await db.first('SELECT status FROM users WHERE tg_id = 200')).status, 'stopped');
await msg(200, '/delete'); await cb(200, 'del:yes');
assert.equal(await db.first('SELECT * FROM users WHERE tg_id = 200'), null);
step('ученик: смена уровня, отписка, удаление данных');

// ---------- памятка ----------
await msg(100, '/help');
let h = last(100)[0];
assert.equal(h.body.parse_mode, 'HTML');
assert.equal(h.body.reply_markup.inline_keyboard.filter((r) => r[0].callback_data).length, 10);
assert.ok(h.body.reply_markup.inline_keyboard[0][0].web_app, 'кнопка панели в памятке');
for (const [k] of (await import('../src/guide.js')).GUIDE_MENU) {
  await cb(100, 'h:' + k);
  h = last(100)[0];
  assert.ok(h.body.text.length < 4096, k + ' короче лимита Telegram: ' + h.body.text.length);
  assert.ok(!/<(?!\/?(b|i|code)>)/.test(h.body.text), k + ': только разрешённые теги');
}
await cb(500, 'h:plan');
assert.doesNotMatch(lastText(500) || '', /план прогрева/, 'обычным людям памятка не открывается');
step('памятка админа: меню из 10 разделов, все в пределах лимита, только для админов');

// ---------- тексты бота ----------
{
  const { fill } = await import('../src/msgs.js');
  const t0 = 'Привет, {имя}! 🐾 жирный';
  const f1 = fill(t0, [{ type: 'bold', offset: t0.indexOf('жирный'), length: 6 }, { type: 'custom_emoji', offset: t0.indexOf('🐾'), length: 2, custom_emoji_id: '1' }], { имя: 'Каролина' });
  assert.equal(f1.text, 'Привет, Каролина! 🐾 жирный');
  assert.equal(f1.text.substr(f1.entities[0].offset, f1.entities[0].length), 'жирный', 'оформление сдвинулось вместе с текстом');
  assert.equal(f1.text.substr(f1.entities[1].offset, f1.entities[1].length), '🐾');
}
await msg(100, '/texts');
assert.match(lastText(100), /Тексты бота/);
await cb(100, 't:g:level');
await cb(100, 't:k:askLevel');
await cb(100, 't:e:askLevel');
{ const t = 'Привет, {имя}! На каком ты уровне? ✨'; const c0 = calls.length;
  await msg(100, t, { entities: [{ type: 'custom_emoji', offset: t.indexOf('✨'), length: 1, custom_emoji_id: '777' }] });
  assert.match(sentTo(100, c0).map((c) => c.body.text).join('|'), /Сохранено/); }
await msg(700, '/start'); await cb(700, 'c:pd');
const lvMsg = last(700)[0].body;
assert.equal(lvMsg.text, 'Привет, друг! На каком ты уровне? ✨', 'ученик видит новый текст с подстановкой');
assert.equal(lvMsg.entities[0].custom_emoji_id, '777', 'премиум-эмодзи сохранились');
assert.equal(lvMsg.text.substr(lvMsg.entities[0].offset, 1), '✨');
await cb(100, 't:r:askLevel');
await msg(701, '/start'); await cb(701, 'c:pd');
assert.equal(lastText(701), 'Где ты сейчас в дизайне?', 'вернули как было');
step('тексты: правка в боте с подстановкой и премиум-эмодзи, возврат по умолчанию');

// ---------- чистый чат: служебное убирается ----------
{
  const c0 = calls.length;
  const sentIds = {};
  const idOf = (re) => { const c = calls.slice(c0).find((x) => x.method === 'sendMessage' && x.body.chat_id === 800 && re.test(x.body.text || '')); return c && c.res; };
  await msg(800, '/start');
  await cb(800, 'c:pd');
  await cb(800, 'lv:start');
  await cb(800, 'c:ads:1');
  const after = calls.slice(c0).filter((x) => x.body.chat_id === 800);
  const dels = after.filter((x) => x.method === 'deleteMessage').map((x) => x.body.message_id);
  const thanks = calls.slice(c0).find((x) => x.method === 'answerCallbackQuery' && x.body.text);
  assert.equal(thanks.body.text, 'Спасибо! ✅', '«спасибо» — всплывающим уведомлением, а не сообщением');
  assert.ok(!after.some((x) => x.method === 'sendMessage' && /^Спасибо/.test(x.body.text || '')), 'отдельного сообщения «Спасибо» нет');
  assert.equal(dels.length, 4, 'убраны: /start, согласие, вопрос про уровень, вопрос про рассылку — ' + dels);
  const offer = after.find((x) => x.method === 'sendMessage' && /аудит-тест/.test(x.body.text || ''));
  assert.ok(offer, 'предложение теста осталось, пока тест не пройден');
  // вернулся из теста: предложение теста и прошлое приветствие уходят, /start тоже
  const c1 = calls.length;
  await msg(800, '/start audit_B_start');
  const d2 = calls.slice(c1).filter((x) => x.method === 'deleteMessage').length;
  assert.ok(d2 >= 3, 'после теста убраны /start, старое приветствие и предложение теста: ' + d2);
  const u8 = await db.first('SELECT tech FROM users WHERE tg_id = 800');
  assert.equal(JSON.parse(u8.tech).length, 1, 'в списке служебных осталось только новое приветствие');
}
step('чистый чат: «печатает…», служебные сообщения исчезают после нажатия, «спасибо» — всплывашкой');

// ---------- профиль бота и меню команд ----------
{
  const c0 = calls.length;
  await cb(100, 't:k:botDesc');
  assert.ok(sentTo(100, c0).some((c) => /бот с полезностями/.test(c.body.text || '')), 'показывает текущее описание из BotFather');
  await cb(100, 't:e:botDesc');
  await msg(100, 'Привет! Здесь аудит для дизайнеров и полезности 🐾');
  let set = calls.slice(c0).filter((c) => c.method === 'setMyDescription');
  assert.equal(set.at(-1).body.description, 'Привет! Здесь аудит для дизайнеров и полезности 🐾', 'описание применилось в Telegram');
  await cb(100, 't:r:botDesc');
  set = calls.slice(c0).filter((c) => c.method === 'setMyDescription');
  assert.equal(set.at(-1).body.description, 'бот с полезностями от Di Sign University', '«вернуть как было» возвращает текст из BotFather');
  await cb(100, 't:e:botShort');
  await msg(100, 'х'.repeat(130));
  assert.match(lastText(100), /до 120 знаков/, 'слишком длинное короткое описание не принимается');
  await msg(100, '/cancel');
  await cb(100, 't:e:cmd_level');
  await msg(100, 'Поменять уровень 🎚');
  const cm = calls.slice(c0).filter((c) => c.method === 'setMyCommands');
  assert.equal(cm.find((c) => !c.body.scope).body.commands.find((x) => x.command === 'level').description, 'Поменять уровень 🎚', 'меню учеников');
  assert.ok(cm.some((c) => c.body.scope && c.body.commands.some((x) => x.command === 'level' && x.description === 'Поменять уровень 🎚') && c.body.commands.some((x) => x.command === 'admin')), 'меню админа тоже обновилось');
}
step('профиль бота: описание до «Старт», короткое описание и подписи команд меняются и применяются в Telegram');

// ---------- картинка в служебном сообщении ----------
{
  await cb(100, 't:k:hello');
  assert.ok(last(100)[0].body.reply_markup.inline_keyboard.some((r) => r.some((b) => b.callback_data === 't:p:hello')), 'кнопка «Добавить картинку»');
  await cb(100, 't:p:hello');
  await msg(100, undefined, { photo: [{ file_id: 'sm' }, { file_id: 'HELLO_PIC' }] });
  assert.match(sentTo(100, calls.length - 6).map((c) => c.body.text || '').join('|'), /Картинка сохранена/);
  const c0 = calls.length;
  await msg(900, '/start');
  const hp = calls.slice(c0).find((c) => c.method === 'sendPhoto' && c.body.chat_id === 900);
  assert.ok(hp, 'приветствие пришло картинкой');
  assert.equal(hp.body.photo, 'HELLO_PIC');
  assert.match(hp.body.caption, /Привет, U900!/, 'текст стал подписью с подстановкой имени');
  // повторный /start убирает и картинку-приветствие
  const c1 = calls.length;
  await msg(900, '/start');
  assert.ok(calls.slice(c1).filter((c) => c.method === 'deleteMessage').some((c) => c.body.message_id === hp.res.message_id), 'старое приветствие-картинка исчезло');
  // картинку с подписью в режиме «Изменить» — и текст, и картинка
  await cb(100, 't:e:askLevel');
  await msg(100, undefined, { photo: [{ file_id: 'LV' }], caption: 'Кто ты сейчас, {имя}?' });
  const c2 = calls.length;
  await msg(901, '/start'); await cb(901, 'c:pd');
  const lp = calls.slice(c2).find((c) => c.method === 'sendPhoto' && c.body.chat_id === 901 && c.body.photo === 'LV');
  assert.ok(lp && lp.body.reply_markup && /Кто ты сейчас/.test(lp.body.caption), 'вопрос про уровень — картинка с подписью и кнопками');
  await cb(100, 't:x:hello');
  const c3 = calls.length; await msg(902, '/start');
  assert.ok(!calls.slice(c3).some((c) => c.method === 'sendPhoto' && c.body.chat_id === 902), 'картинку убрали — снова просто текст');
  await cb(100, 't:r:askLevel');
}
step('картинка в служебных сообщениях: добавить, с подписью, убрать; исчезает вместе с сообщением');

console.log('\nВсе сценарии прошли. Запросов к фейковому Telegram:', calls.length);
