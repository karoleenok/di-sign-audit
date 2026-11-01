// Прогон сценариев на фейковом Telegram и базе в памяти.
import assert from 'node:assert/strict';
import { nodeSqliteAdapter } from '../src/db-node.js';
import { migrate } from '../src/schema.js';
import { makeCtx, handleUpdate, tick, clickRedirect } from '../src/core.js';
import { parseWhen, fmtWhen } from '../src/time.js';
import { saveBtnExtra, setMsgOff } from '../src/msgs.js';

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
// проход входа после согласий: уровень (если не из аудита) → имя → контакт → отзыв → трек
const pass = async (id, { level = 'start', track = 'mat', fb = null, email = null } = {}) => {
  let u = await db.first('SELECT * FROM users WHERE tg_id = ?', [id]);
  await cb(id, 'n:ok');
  await cb(id, 'ct:email'); await msg(id, email || `u${id}@mail.ru`);
  if (fb) { await cb(id, 'fb:yes'); await msg(id, fb[0]); await msg(id, fb[1]); } else await cb(id, 'fb:no');
  u = await db.first('SELECT * FROM users WHERE tg_id = ?', [id]);
  if (!u.track) await cb(id, 'tr:' + track);
};
// 200: из теста, зона P, уровень start
await msg(200, '/start audit_P_start');
assert.match(lastText(200), /согласие/);
await cb(200, 'c:pd');
assert.match(lastText(200), /рекламная рассылка/, 'сразу после согласия на данные — согласие на рассылку');
await cb(200, 'c:ads:1');
assert.match(lastText(200), /Как к тебе обращаться\? Сейчас: U200/, 'уровень известен из аудита — сразу имя');
const before = calls.length;
await pass(200);
const g = sentTo(200, before);
assert.ok(g.some((c) => c.method === 'sendMediaGroup'), 'получил подарок-альбом');
assert.match(lastText(200), /ты с нами[\s\S]*полезные материалы/, 'последним — расписание материалов');
let u = await db.first('SELECT * FROM users WHERE tg_id = 200');
assert.equal(u.status, 'active'); assert.equal(u.level, 'start'); assert.equal(u.zone, 'P'); assert.equal(u.track, 'mat'); assert.equal(u.email, 'u200@mail.ru'); assert.equal(u.contact_name, 'U200');
step('ученик из теста: согласия → имя → почта → отзыв пропустил → трек → подарок → расписание');

// 300: обычная ссылка, выбирает «продолжающий»
await msg(300, '/start');
await cb(300, 'c:pd'); await cb(300, 'c:ads:1');
assert.match(lastText(300), /обращаться/, 'после согласий сразу имя: вопроса про уровень больше нет');
{ const c0 = calls.length;
  await pass(300, { level: 'pro' });
  const off = sentTo(300, c0).find((c) => /аудит-тест/.test(c.body.text || ''));
  assert.ok(off, 'не проходил тест — предложение пройти тест');
  assert.equal(off.body.reply_markup.inline_keyboard[0][0].text, 'Пройти тест');
  assert.match(lastText(300), /ты с нами/); }
// прошёл тест и вернулся по ссылке из теста
{ const c0 = calls.length;
  await msg(300, '/start audit_S_pro');
  assert.ok(sentTo(300, c0).some((c) => c.method === 'sendMediaGroup'), 'после теста пришёл общий подарок (зона не важна)');
  assert.match(sentTo(300, c0)[0].body.text, /аудит пройден/);
  assert.ok(!sentTo(300, c0).some((c) => /ты с нами|обращаться/.test(c.body.text || '')), 'повторно вход не спрашивает'); }
u = await db.first('SELECT * FROM users WHERE tg_id = 300');
assert.equal(u.zone, 'S'); assert.equal(u.status, 'active');
// 400: отказался от рекламы
await msg(400, '/start audit_V_free'); await cb(400, 'c:pd'); await cb(400, 'c:ads:0');
u = await db.first('SELECT * FROM users WHERE tg_id = 400');
assert.equal(u.status, 'stopped'); assert.equal(u.level, 'pro');
step('обычный вход: уровень → контакты → «Пройти тест» → расписание; после теста — подарок; отказ от рассылки');

// ---------- расписание ----------
const tickAt = async (when) => { NOW = parseWhen(when, NOW); const c0 = calls.length; const r = await tick(C(), 40); return { r, c: calls.slice(c0) }; };
let t = await tickAt('01.11.2026 18:00');
assert.equal(t.c.length, 0, 'в день входа ничего лишнего');
t = await tickAt('02.11.2026 11:00');
assert.deepEqual(t.c.filter((c) => c.method.startsWith('send')).map((c) => c.body.chat_id), [200, 300], 'день 1 — всем: деления по уровню больше нет');
assert.match(t.c[0].body.reply_markup.inline_keyboard[0][0].url, /^https:\/\/bot\.test\/r\/\d+\/0-0\/200$/);
assert.equal(t.c[0].body.reply_markup.inline_keyboard[0].length, 2, 'две кнопки в ряд');
t = await tickAt('02.11.2026 11:01');
assert.equal(t.c.length, 0, 'повторно не шлёт');
t = await tickAt('03.11.2026 19:00');
const to = t.c.filter((c) => c.method.startsWith('send')).map((c) => c.body.chat_id).sort();
assert.deepEqual(to, [200, 300], 'эфир всем, кто был в боте');
t = await tickAt('03.11.2026 19:30');
assert.deepEqual(t.c.filter((c) => c.method.startsWith('send')).map((c) => c.body.chat_id).sort(), [200, 300], 'день 2 в 19:30 — всем');
step('лента: день 1 в 11:00 начинающим, день 2 в 19:30 продолжающим, пост в дату всем; без повторов');

// новый человек после даты эфира не получает старый пост
await msg(500, '/start audit_P_start'); await cb(500, 'c:pd'); await cb(500, 'c:ads:1'); await pass(500);
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
await cb(100, 't:g:contact');
await cb(100, 't:k:askName');
await cb(100, 't:e:askName');
{ const t = 'Привет, {имя}! Как тебя зовут? ✨'; const c0 = calls.length;
  await msg(100, t, { entities: [{ type: 'custom_emoji', offset: t.indexOf('✨'), length: 1, custom_emoji_id: '777' }] });
  assert.match(sentTo(100, c0).map((c) => c.body.text).join('|'), /Сохранено/); }
await msg(700, '/start'); await cb(700, 'c:pd'); await cb(700, 'c:ads:1');
const lvMsg = last(700)[0].body;
assert.equal(lvMsg.text, 'Привет, U700! Как тебя зовут? ✨', 'ученик видит новый текст с подстановкой');
assert.equal(lvMsg.entities[0].custom_emoji_id, '777', 'премиум-эмодзи сохранились');
assert.equal(lvMsg.text.substr(lvMsg.entities[0].offset, 1), '✨');
await cb(100, 't:r:askName');
await msg(701, '/start'); await cb(701, 'c:pd'); await cb(701, 'c:ads:1');
assert.match(lastText(701), /Как к тебе обращаться/, 'вернули как было');
step('тексты: правка в боте с подстановкой и премиум-эмодзи, возврат по умолчанию');

// ---------- чистый чат: служебное убирается ----------
{
  const c0 = calls.length;
  const sentIds = {};
  const idOf = (re) => { const c = calls.slice(c0).find((x) => x.method === 'sendMessage' && x.body.chat_id === 800 && re.test(x.body.text || '')); return c && c.res; };
  await msg(800, '/start');
  await cb(800, 'c:pd');
  await cb(800, 'c:ads:1');
  await pass(800);
  const after = calls.slice(c0).filter((x) => x.body.chat_id === 800);
  const dels = after.filter((x) => x.method === 'deleteMessage').map((x) => x.body.message_id);
  const thanks = calls.slice(c0).find((x) => x.method === 'answerCallbackQuery' && x.body.text);
  assert.equal(thanks.body.text, 'Спасибо! ✅', '«спасибо» — всплывающим уведомлением, а не сообщением');
  assert.ok(!after.some((x) => x.method === 'sendMessage' && /^Спасибо/.test(x.body.text || '')), 'отдельного сообщения «Спасибо» нет');
  assert.ok(dels.length >= 7, 'убраны: /start, согласия, вопросы про уровень, имя, контакт, почту, отзыв, трек — ' + dels);
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
  NOW += 20;
  await msg(900, '/start');
  assert.ok(calls.slice(c1).filter((c) => c.method === 'deleteMessage').some((c) => c.body.message_id === hp.res.message_id), 'старое приветствие-картинка исчезло');
  // картинку с подписью в режиме «Изменить» — и текст, и картинка
  await cb(100, 't:e:askName');
  await msg(100, undefined, { photo: [{ file_id: 'LV' }], caption: 'Кто ты сейчас, {имя}?' });
  const c2 = calls.length;
  await msg(901, '/start'); await cb(901, 'c:pd'); await cb(901, 'c:ads:1');
  const lp = calls.slice(c2).find((c) => c.method === 'sendPhoto' && c.body.chat_id === 901 && c.body.photo === 'LV');
  assert.ok(lp && lp.body.reply_markup && /Кто ты сейчас/.test(lp.body.caption), 'вопрос про уровень — картинка с подписью и кнопками');
  await cb(100, 't:x:hello');
  const c3 = calls.length; await msg(902, '/start');
  assert.ok(!calls.slice(c3).some((c) => c.method === 'sendPhoto' && c.body.chat_id === 902), 'картинку убрали — снова просто текст');
  await cb(100, 't:r:askName');
}
step('картинка в служебных сообщениях: добавить, с подписью, убрать; исчезает вместе с сообщением');

// ---------- без дублей ----------
{
  const c0 = calls.length;
  await msg(950, '/start audit_P_start'); await cb(950, 'c:pd');
  await msg(950, '/start'); await msg(950, '/start');
  const hellos = calls.slice(c0).filter((c) => c.method === 'sendMessage' && c.body.chat_id === 950 && /Привет/.test(c.body.text || ''));
  assert.equal(hellos.length, 2, 'второе быстрое нажатие «Старт» не дублирует приветствие');
  NOW += 60; await msg(950, '/start');
  const nog = calls.slice(c0).filter((c) => c.method === 'sendMessage' && c.body.chat_id === 950 && /Подарок скоро/.test(c.body.text || ''));
  assert.ok(nog.length <= 1, '«подарок скоро» — не больше одного раза: ' + nog.length);
}
step('без дублей: двойной «Старт» игнорируется, «подарок скоро» — один раз и исчезает');

// ---------- «печатает…» в чате ----------
{
  const slowEnv = { ...env, DELAY_FACTOR: '0.001' };
  const S = () => makeCtx({ db, env: slowEnv, fetchFn: fakeFetch, publicUrl: 'https://bot.test', now: (NOW += 10) });
  const c0 = calls.length;
  await handleUpdate(S(), { message: { message_id: 5001, from: { id: 970, first_name: 'Аня' }, chat: { id: 970, type: 'private' }, text: '/start' } });
  const seq = calls.slice(c0).filter((c) => c.body.chat_id === 970).map((c) => c.method + (c.body.text ? ':' + c.body.text.slice(0, 12) : ''));
  const i = seq.indexOf('sendMessage:•');
  assert.ok(i >= 0 && seq[i + 1] === 'editMessageText:• •' && seq[i + 2] === 'editMessageText:• • •' && seq[i + 3] === 'deleteMessage', 'пузырёк с точками растёт и исчезает: ' + seq.join(' → '));
  assert.match(seq[i + 4], /sendMessage:Привет/, 'сразу после пузырька — приветствие');
  const bubbles = seq.filter((x) => x === 'sendMessage:•').length;
  const real = seq.filter((x) => x.startsWith('sendMessage:') && x !== 'sendMessage:•').length;
  assert.equal(bubbles, real, 'перед каждым сообщением ровно один пузырёк');
  // уже прошёл весь путь: «Старт» → только приветствие, без пустого «печатает…»
  await handleUpdate(S(), { callback_query: { id: 'x1', from: { id: 970 }, data: 'c:pd', message: { message_id: 1, chat: { id: 970 } } } });
  await handleUpdate(S(), { callback_query: { id: 'x3', from: { id: 970 }, data: 'c:ads:1', message: { message_id: 1, chat: { id: 970 } } } });
  await db.run(`UPDATE users SET contact_name = 'Аня', contact_at = 1, fb_skip = 1, track = 'mat', sched_at = 1 WHERE tg_id = 970`);
  await db.run(`UPDATE users SET zone = 'B' WHERE tg_id = 970`);
  await db.run(`INSERT INTO settings (key, value) VALUES ('nogift:970', '1') ON CONFLICT(key) DO NOTHING`);
  await db.run(`UPDATE posts SET status = 'paused' WHERE kind = 'gift'`);
  const c1 = calls.length;
  await handleUpdate(S(), { message: { message_id: 5002, from: { id: 970, first_name: 'Аня' }, chat: { id: 970, type: 'private' }, text: '/start' } });
  const s2 = calls.slice(c1).filter((c) => c.body.chat_id === 970 && (c.method === 'sendMessage' || c.method === 'sendChatAction'));
  assert.equal(s2.filter((c) => c.method === 'sendChatAction').length, 1, 'одно «печатает…» — перед приветствием, лишних нет');
  await db.run(`UPDATE posts SET status = 'active' WHERE kind = 'gift'`);
}
step('«печатает…» в чате: пузырёк • → • • → • • • перед каждым сообщением, без пустых пауз');

// ---------- таймер и «после поста» ----------
{
  await db.run(`UPDATE posts SET status = 'paused' WHERE kind IN ('drip', 'date')`);
  const ins = async (o) => { await db.run(`INSERT INTO posts (title, kind, audience, mode, delay_min, after_id, day, send_time, status, text, created_at) VALUES (?, 'drip', 'all', ?, ?, ?, 0, '11:00', 'active', ?, ?)`, [o.title, o.mode, o.delay, o.after || null, o.title, NOW - 10]); return (await db.first('SELECT MAX(id) AS id FROM posts')).id; };
  const tA = await ins({ title: 'Таймер 2ч', mode: 'timer', delay: 120 });
  const tB = await ins({ title: 'После таймера +1ч', mode: 'after', delay: 60, after: tA });
  // новый ученик подписался сейчас
  await msg(1100, '/start'); await cb(1100, 'c:pd'); await cb(1100, 'c:ads:1'); await pass(1100);
  const base = NOW;
  const got = () => calls.filter((c) => c.body.chat_id === 1100 && c.method === 'sendMessage' && /Таймер 2ч|После таймера/.test(c.body.text || '')).map((c) => c.body.text);
  NOW = base + 119 * 60; await tick(C(), 40);
  assert.deepEqual(got(), [], 'за минуту до таймера — ничего');
  NOW = base + 121 * 60; await tick(C(), 40);
  assert.deepEqual(got(), ['Таймер 2ч'], 'через 2 часа после входа — пост по таймеру');
  NOW = base + 170 * 60; await tick(C(), 40);
  assert.deepEqual(got(), ['Таймер 2ч'], 'цепочка ждёт час после предыдущего поста');
  NOW = base + 182 * 60; await tick(C(), 40);
  assert.deepEqual(got(), ['Таймер 2ч', 'После таймера +1ч'], 'через час после первого — второй');
  NOW = base + 300 * 60; await tick(C(), 40);
  assert.equal(got().length, 2, 'без повторов');
  // ---------- тест на себе ----------
  const { runPreview, startFastRun, stepRuns } = await import('../src/testrun.js');
  await db.run(`UPDATE posts SET status = 'active' WHERE kind = 'drip' AND mode = 'day' AND day > 0`);
  const p0 = calls.length;
  await runPreview(C(), 100, 'start', 0);
  const pv = calls.slice(p0).filter((c) => c.body.chat_id === 100 && c.method === 'sendMessage').map((c) => c.body.text || '');
  assert.match(pv[0], /Предпросмотр ленты — как её получит ученик/);
  const labels = pv.filter((t) => t.startsWith('🧪 ') && !/Конец/.test(t));
  assert.ok(labels.some((t) => /⏱ через 2 ч после входа/.test(t)) && labels.some((t) => /↳ через 1 ч после «Таймер 2ч»/.test(t)), 'подписи «когда»: ' + labels.join(' | '));
  assert.ok(labels.findIndex((t) => /Таймер 2ч/.test(t)) < labels.findIndex((t) => /После таймера/.test(t)), 'порядок по времени');
  assert.ok(labels.some((t) => /^🧪 «Таймер 2ч»\n📍 Путь → ③ Лента по дням → ⏱ через 2 ч после входа$/.test(t)), 'подпись: название и где пост лежит в панели: ' + labels.join(' | '));
  assert.ok(!labels.some((t) => /шаг \d|#\d/.test(t)), 'технических пометок нет');
  // ускоренный: 1 день = 1 минута
  const f0 = calls.length;
  await startFastRun(C(), 100, 'start'); const st0 = NOW;
  await stepRuns(C(), 30);
  const after0 = calls.slice(f0).filter((c) => c.body.chat_id === 100 && /^🧪 /.test(c.body.text || '')).map((c) => c.body.text);
  assert.ok(after0.some((t) => /подарок/i.test(t)) && !after0.some((t) => /день 1/.test(t)), 'сначала подарок, день 1 ещё не пришёл: ' + after0.join(' | '));
  NOW = st0 + 10; await stepRuns(C(), 30);
  const after10 = calls.slice(f0).filter((c) => c.body.chat_id === 100 && /^🧪 /.test(c.body.text || '')).map((c) => c.body.text);
  assert.ok(after10.some((t) => /через 2 ч/.test(t)), 'через 10 секунд (= 4 часа ленты) пришёл пост «через 2 ч»');
  NOW = st0 + 170; await stepRuns(C(), 30);
  let got3 = calls.slice(f0).filter((c) => c.body.chat_id === 100 && /^🧪 /.test(c.body.text || '')).map((c) => c.body.text);
  assert.ok(!got3.some((t) => /день 3 · 10:15/.test(t)), 'день 3 ещё рано (прошло меньше 3 минут)');
  NOW = st0 + 190; await stepRuns(C(), 30);
  got3 = calls.slice(f0).filter((c) => c.body.chat_id === 100 && /^🧪 /.test(c.body.text || '')).map((c) => c.body.text);
  assert.ok(got3.some((t) => /день 3 · 10:15/.test(t)), 'через ~3 минуты (= 3 дня) — пост дня 3: ' + got3.join(' | '));
  NOW = st0 + 400; await stepRuns(C(), 30);
  assert.ok(calls.slice(f0).some((c) => c.body.chat_id === 100 && /тест закончен/.test(c.body.text || '')), 'тест сам заканчивается');
  await db.run(`UPDATE posts SET status = 'paused' WHERE id IN (?, ?)`, [tA, tB]);
}
step('когда отправлять: по таймеру после входа и «после поста»; проверка на себе — предпросмотр и ускоренный тест');

// ---------- пауза шага и кнопки-ссылки ----------
{
  const { saveMsgExtra } = await import('../src/msgs.js');
  await saveMsgExtra(C(), 'consentPd', { links: [[{ text: 'Наш канал', url: 't.me/diuuupin' }]] });
  await saveMsgExtra(C(), 'hello', { delay: 0 });
  const slowEnv = { ...env, DELAY_FACTOR: '0.001' };
  const c0 = calls.length;
  await handleUpdate(makeCtx({ db, env: slowEnv, fetchFn: fakeFetch, publicUrl: 'https://bot.test', now: (NOW += 10) }), { message: { message_id: 6001, from: { id: 1200, first_name: 'Оля' }, chat: { id: 1200, type: 'private' }, text: '/start' } });
  const seq = calls.slice(c0).filter((c) => c.body.chat_id === 1200 && c.method.startsWith('send'));
  assert.match(seq[0].body.text, /^Привет, Оля/, 'пауза 0 — приветствие сразу, без «печатает»');
  const cp = seq.find((c) => /Чтобы присылать/.test(c.body.text || ''));
  assert.deepEqual(cp.body.reply_markup.inline_keyboard.map((r) => r.map((b) => b.text)), [['📄 Политика обработки данных'], ['Даю согласие'], ['Наш канал']], 'документы кнопками, потом согласие, своя кнопка-ссылка под встроенной');
  assert.ok(!/disign\.ru\/policy/.test(cp.body.text), 'голой ссылки на политику в тексте нет — она в кнопке');
  await saveMsgExtra(C(), 'hello', { delay: 0.6 });
  await saveMsgExtra(C(), 'consentPd', { links: [] });
  await assert.rejects(() => saveMsgExtra(C(), 'consentPdBtn', { delay: 1 }), /не настраиваются/);
  await assert.rejects(() => saveMsgExtra(C(), 'hello', { delay: 99 }), /до 30/);
}
step('путь ученика: пауза перед шагом и свои кнопки-ссылки');
// ---------- шаг пути заменён своим постом ----------
{
  const { saveMsgExtra } = await import('../src/msgs.js');
  const ins = await db.run(`INSERT INTO posts (kind, status, title, text, entities, buttons, created_at) VALUES ('drip', 'active', 'Мой привет', 'Мой пост для {имя}', '[]', ?, 1)`, [JSON.stringify([[{ text: 'Сайт', url: 'https://example.org' }]])]);
  const pid = (await db.first(`SELECT id FROM posts WHERE title = 'Мой привет'`)).id;
  await saveMsgExtra(C(), 'consentPd', { post: pid, delay: 0 });
  const c0 = calls.length;
  await handleUpdate(C(), { message: { message_id: 6101, from: { id: 1300, first_name: 'Аня' }, chat: { id: 1300, type: 'private' }, text: '/start' } });
  const cp = calls.slice(c0).find((c) => c.body.chat_id === 1300 && /Мой пост для Аня/.test(c.body.text || ''));
  assert.ok(cp, 'вместо шаблона согласия ушёл свой пост с подстановкой имени');
  const rows = cp.body.reply_markup.inline_keyboard.map((r) => r.map((b) => b.text));
  assert.equal(rows[0][0], 'Сайт', 'кнопки поста сверху');
  assert.ok(rows.flat().includes('Даю согласие'), 'кнопка согласия шага осталась — путь не ломается');
  await assert.rejects(() => saveMsgExtra(C(), 'consentPd', { post: 99999 }), /нет/);
  await saveMsgExtra(C(), 'consentPd', { post: null });
}
step('шаг пути можно заменить своим постом: текст, кнопки поста + встроенные кнопки шага');
{
  const { saveMsgExtra } = await import('../src/msgs.js');
  const t = (await db.first(`SELECT id FROM posts WHERE title = 'Мой привет'`)).id;
  await saveMsgExtra(C(), 'askName', { links: [[{ text: 'Читать пост', go: t }], [{ text: 'Оферта', doc: 'offer' }, { text: 'Тариф', pay: 'mentor' }]] });
  await assert.rejects(() => saveMsgExtra(C(), 'askName', { links: [[{ text: 'X', go: 99999 }]] }), /не найден/);
  const c0 = calls.length;
  await handleUpdate(C(), { message: { message_id: 6201, from: { id: 1400, first_name: 'Ира' }, chat: { id: 1400, type: 'private' }, text: '/start' } });
  await cb(1400, 'c:pd'); await cb(1400, 'c:ads:1');
  const withBtn = calls.slice(c0).find((c) => c.body.chat_id === 1400 && (c.body.reply_markup?.inline_keyboard || []).flat().some((b) => b.text === 'Читать пост'));
  assert.ok(withBtn, 'шаг с кнопками дошёл до ученика');
  {
    const kb = withBtn.body.reply_markup.inline_keyboard.flat();
    const g = kb.find((b) => b.text === 'Читать пост');
    assert.match(g.callback_data, /^gm:askName:0-0$/, 'кнопка-пост шага идёт через gm:');
    assert.ok(kb.some((b) => b.text === 'Тариф' && /^gp:askName$/.test(b.callback_data)), 'оплата — заглушка gp:');
    const c1 = calls.length;
    await cb(1400, g.callback_data);
    assert.ok(calls.slice(c1).some((c) => c.body.chat_id === 1400 && /Мой пост для/.test(c.body.text || '')), 'нажатие кнопки-поста шлёт выбранный пост');
  }
  await saveMsgExtra(C(), 'askName', { links: [] });
}
step('кнопки шага: ссылка, пост, документ, оплата');
{
  const { saveMsgExtra } = await import('../src/msgs.js');
  const file = { type: 'document', file_id: 'BQACAgIAAxkBAAIBfileid123', name: 'чеклист.pdf' };
  await assert.rejects(() => saveMsgExtra(C(), 'askName', { links: [[{ text: 'Файл', file: { type: 'document', file_id: 'x' } }]] }), /не выбран файл/);
  await saveMsgExtra(C(), 'askName', { links: [[{ text: 'Скачать чеклист', file }]] });
  const c0 = calls.length;
  await handleUpdate(C(), { message: { message_id: 6301, from: { id: 1500, first_name: 'Лена' }, chat: { id: 1500, type: 'private' }, text: '/start' } });
  await cb(1500, 'c:pd'); await cb(1500, 'c:ads:1');
  const kbm = calls.slice(c0).find((c) => c.body.chat_id === 1500 && (c.body.reply_markup?.inline_keyboard || []).flat().some((b) => b.text === 'Скачать чеклист'));
  assert.ok(kbm, 'кнопка-файл дошла до ученика');
  const fb = kbm.body.reply_markup.inline_keyboard.flat().find((b) => b.text === 'Скачать чеклист');
  assert.match(fb.callback_data, /^fm:askName:0-0$/);
  const c1 = calls.length;
  await cb(1500, fb.callback_data);
  const sent = calls.slice(c1).find((c) => c.method === 'sendDocument' && c.body.chat_id === 1500);
  assert.equal(sent && sent.body.document, file.file_id, 'по нажатию ушёл файл');
  await saveMsgExtra(C(), 'askName', { links: [] });
  // у поста
  const pid = (await db.first(`SELECT id FROM posts WHERE title = 'Мой привет'`)).id;
  await db.run(`UPDATE posts SET buttons = ? WHERE id = ?`, [JSON.stringify([[{ text: 'Скачать', file }]]), pid]);
  const c2 = calls.length;
  await cb(1500, `fl:${pid}:0-0`);
  assert.ok(calls.slice(c2).some((c) => c.method === 'sendDocument' && c.body.document === file.file_id), 'кнопка-файл у поста тоже отдаёт файл');
}

{
  const { saveMsgExtra, linkRows } = await import('../src/msgs.js');
  const big = { type: 'link', url: 'https://bot.test/f/0123456789abcdef01234567/%D1%84.pdf', name: 'большой.pdf', size: 99000000 };
  await assert.rejects(() => saveMsgExtra(C(), 'askName', { links: [[{ text: 'Скачать', file: { type: 'link', url: 'https://evil.test/x' } }]] }), /не выбран файл/);
  await saveMsgExtra(C(), 'askName', { links: [[{ text: 'Большой файл', file: big }]] });
  const rows = await linkRows(C(), 'askName');
  assert.equal(rows[0][0].url, big.url, 'большой файл — обычная ссылка-кнопка на наш сервер');
  await saveMsgExtra(C(), 'askName', { links: [] });
}
step('кнопка «файл»: у шага и у поста по нажатию приходит файл');




// ---------- конструктор сценариев: пост-ответ, кнопки-выбор, документы, оплата ----------
{
  const { handlePanelApi } = await import('../src/panel-api.js');
  const { mdToEntities, entitiesToMd } = await import('../src/fmt.js');
  const crypto = await import('node:crypto');
  // подписанный вход в панель, как его даёт Telegram
  const initFor = (uid) => {
    const p = new URLSearchParams({ auth_date: String(NOW), user: JSON.stringify({ id: uid, first_name: 'Админ' }) });
    const dcs = [...p.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, v]) => `${k}=${v}`).join('\n');
    const secret = crypto.createHmac('sha256', 'WebAppData').update(env.BOT_TOKEN).digest();
    p.set('hash', crypto.createHmac('sha256', secret).update(dcs).digest('hex'));
    return p.toString();
  };
  const api = async (path, body, uid = 100) => {
    const req = new Request('https://bot.test/api/panel' + path, { method: body ? 'POST' : 'GET', headers: { 'x-init-data': initFor(uid), 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    const r = await handlePanelApi(C(), req, new URL(req.url));
    return { status: r.status, ...(await r.json()) };
  };
  // разметка
  const f = mdToEntities('Привет, **дизайнер**! Читай __внимательно__ и [наш сайт](t.me/diuuupin)');
  assert.equal(f.text, 'Привет, дизайнер! Читай внимательно и наш сайт');
  assert.deepEqual(f.entities.map((e) => e.type), ['bold', 'italic', 'text_link']);
  assert.equal(f.entities[2].url, 'https://t.me/diuuupin');
  assert.equal(entitiesToMd(f.text, f.entities).md, 'Привет, **дизайнер**! Читай __внимательно__ и [наш сайт](https://t.me/diuuupin)', 'обратно без потерь');
  assert.equal(entitiesToMd('a 🐾', [{ type: 'custom_emoji', offset: 2, length: 2 }]).rich, true, 'премиум-эмодзи — предупреждаем');
  assert.equal((await api('/state', null, 555)).status, 403, 'чужой в панель не войдёт');

  // документы из панели
  let r = await api('/docs', { policy: 'disign.ru/policy' });
  assert.match(r.error, /https/);
  r = await api('/docs', { policy: 'https://disign.ru/policy-v2', offer: 'https://disign.ru/offer', owner: 'Самозанятая К. Б.' });
  assert.equal(r.docs.policy, 'https://disign.ru/policy-v2');

  // два поста-ответа и пост с развилкой
  const a1 = (await api('/post/new', { kind: 'node', title: 'Ответ: с нуля', md: 'Отлично, начнём с **базы**', status: 'active' })).post;
  const a2 = (await api('/post/new', { kind: 'node', title: 'Ответ: уже работаю', md: 'Тогда тебе в портфолио', status: 'active' })).post;
  assert.equal((await api('/post/new', { kind: 'node', md: '   ', status: 'active' })).error, 'Добавь текст или картинку');
  r = await api('/post/new', { kind: 'date', md: 'Кто ты?', run_at: NOW + 60, status: 'active', once: true, audience: 'all',
    rows: [[{ text: 'Начинаю с нуля', go: a1.id }, { text: 'Уже работаю', go: a2.id }], [{ text: 'Политика', doc: 'policy' }], [{ text: 'Оплатить тариф', pay: 'mentor' }]] });
  const q = r.post;
  assert.deepEqual(q.rows[0].map((b) => b.go), [a1.id, a2.id]);
  assert.equal((await api('/post/' + q.id, { rows: [[{ text: 'Сам на себя', go: q.id }]] })).error, 'Кнопка «Сам на себя» ведёт на этот же пост');
  assert.match((await api('/post/' + q.id, { rows: [[{ text: 'Нет такого', go: 99999 }]] })).error, /не найден/);
  // пост «через 1 день после ответа»
  const fol = (await api('/post/new', { kind: 'drip', md: 'Как успехи с базой?', status: 'active', mode: 'after', after_id: a1.id, delay_min: 1440 })).post;
  assert.equal(fol.after, a1.id);
  // правка текста в панели
  r = await api('/post/' + a2.id, { md: 'Тогда тебе в **портфолио**' });
  assert.equal(r.post.md, 'Тогда тебе в **портфолио**');
  const st = await api('/state');
  assert.ok(st.posts.some((p) => p.kind === 'node') && st.docs.offer === 'https://disign.ru/offer', 'панель видит посты-ответы и документы');

  // ученик в рассылке получает развилку
  const U = 1300;
  await msg(U, '/start'); await cb(U, 'c:pd'); await cb(U, 'c:ads:1'); await pass(U);
  NOW += 120; const t0 = calls.length;
  await tick(C(), 40);
  const ask = calls.slice(t0).find((c) => c.body.chat_id === U && c.body.text === 'Кто ты?');
  assert.ok(ask, 'пост с развилкой пришёл');
  const kbd = ask.body.reply_markup.inline_keyboard;
  assert.deepEqual(kbd[0].map((b) => b.callback_data), [`go:${q.id}:0-0`, `go:${q.id}:0-1`]);
  assert.equal(kbd[1][0].url, 'https://disign.ru/policy-v2', 'кнопка-документ ведёт на ссылку из панели');
  assert.equal(kbd[2][0].callback_data, `buy:${q.id}:2-0`);
  // нажимает «Начинаю с нуля»
  const g0 = calls.length;
  await handleUpdate(C(), { callback_query: { id: 'g1', from: { id: U }, data: `go:${q.id}:0-0`, message: { message_id: ask.res.message_id, chat: { id: U } } } });
  const gs = calls.slice(g0).filter((c) => c.body.chat_id === U);
  const edit = gs.find((c) => c.method === 'editMessageReplyMarkup');
  assert.deepEqual(edit.body.reply_markup.inline_keyboard, [[{ text: '✓ Начинаю с нуля', callback_data: 'go:done' }]], 'кнопки-выбор: осталась выбранная с ✓');
  const ans = gs.find((c) => c.method === 'sendMessage');
  assert.equal(ans.body.text, 'Отлично, начнём с базы');
  assert.equal(ans.body.entities[0].type, 'bold');
  // двойное нажатие — без дубля
  const g1 = calls.length;
  await handleUpdate(C(), { callback_query: { id: 'g2', from: { id: U }, data: `go:${q.id}:0-0`, message: { message_id: ask.res.message_id, chat: { id: U } } } });
  assert.ok(!calls.slice(g1).some((c) => c.body.chat_id === U && c.method === 'sendMessage'), 'второе быстрое нажатие не дублирует пост');
  const clicks = await db.first(`SELECT COUNT(*) AS n FROM clicks WHERE post_id = ? AND tg_id = ?`, [q.id, U]);
  assert.equal(clicks.n, 1, 'нажатие посчитано');
  // через сутки после ответа — следующий пост цепочки; второй ветки человек не выбирал
  NOW += 1440 * 60 + 60; const t1 = calls.length;
  await tick(C(), 40);
  const later = calls.slice(t1).filter((c) => c.body.chat_id === U && c.method === 'sendMessage').map((c) => c.body.text);
  assert.ok(later.includes('Как успехи с базой?'), 'пост «через 1 день после ответа» пришёл');
  assert.ok(!later.includes('Тогда тебе в портфолио'), 'пост-ответ сам по расписанию не уходит');
  // оплата: пока всплывашка
  const b0 = calls.length;
  await handleUpdate(C(), { callback_query: { id: 'b1', from: { id: U }, data: `buy:${q.id}:2-0`, message: { message_id: 5, chat: { id: U } } } });
  const pop = calls.slice(b0).find((c) => c.method === 'answerCallbackQuery');
  assert.ok(pop.body.show_alert && /день продаж/.test(pop.body.text), 'оплата: пока «откроется в день продаж»');
  // черновик-ответ ученику не уходит
  await api('/post/' + a2.id, { status: 'draft' });
  const d0 = calls.length;
  await handleUpdate(C(), { callback_query: { id: 'g3', from: { id: U }, data: `go:${q.id}:0-1`, message: { message_id: 7, chat: { id: U } } } });
  assert.ok(!calls.slice(d0).some((c) => c.body.chat_id === U && c.method === 'sendMessage'), 'черновик-ответ ученику не уходит');
  // в чате админа: кнопка «на пост» через #номер
  await msg(100, '/new'); await msg(100, 'Выбери вариант'); await cb(100, 'w:done'); await cb(100, 'w:kind:node');
  await msg(100, `Вариант Б | #99999`);
  assert.match(lastText(100), /Поста #99999 нет/);
  await msg(100, `Вариант А | #${a1.id}; Наш сайт | https://disign.ru\nПолитика | политика`);
  const pvb = calls.filter((c) => c.body.chat_id === 100 && c.body.text === 'Выбери вариант').pop();
  assert.equal(pvb.body.reply_markup.inline_keyboard[0][0].callback_data, 'go:x', 'предпросмотр с кнопкой на пост');
  assert.equal(pvb.body.reply_markup.inline_keyboard[1][0].url, 'https://disign.ru/policy-v2', 'документ в предпросмотре');
  await cb(100, 'w:save:1');
  const saved = await db.first(`SELECT * FROM posts ORDER BY id DESC LIMIT 1`);
  assert.equal(saved.kind, 'node'); assert.equal(JSON.parse(saved.buttons)[0][0].go, a1.id);
  await db.run(`UPDATE posts SET status = 'archived' WHERE id IN (?, ?, ?, ?, ?)`, [a1.id, a2.id, q.id, fol.id, saved.id]);
  // порядок шагов входа меняется из панели
  {
  const rr = await api('/flow', { order: ['consentAds', 'askName', 'askContact', 'askLevel', 'fbOffer', 'askTrack', 'testOffer'], off: ['fbOffer', 'consentPd'] });
  assert.deepEqual(rr.flow.order.slice(0, 3), ['consentPd', 'consentAds', 'askName'], 'согласие на данные всегда первое');
  assert.deepEqual(rr.flow.off, ['fbOffer'], 'обязательный шаг выключить нельзя');
  const W = 1500;
  await msg(W, '/start audit_P_start_course'); await cb(W, 'c:pd'); await cb(W, 'c:ads:1');
  assert.match(lastText(W), /имя|зовут|называть/i, 'после согласий сначала имя');
  await cb(W, 'n:ok'); await cb(W, 'ct:email'); await msg(W, 'w@mail.ru');
  const w = await db.first('SELECT * FROM users WHERE tg_id = ?', [W]);
  assert.equal(w.status, 'active', 'вход пройден без выключенного отзыва'); assert.equal(w.fb_at, null);
  assert.ok(!calls.some((c) => c.body.chat_id === W && /прототип/.test(c.body.text || '')), 'отзыв пропущен');
  await api('/flow', { order: [], off: [] });
  }
  // копия поста в другой раздел («из существующих»)
  {
    const pid = (await db.first(`SELECT id FROM posts WHERE title = 'Мой привет'`)).id;
    const r = await api(`/post/${pid}/copy`, { kind: 'fb' });
    assert.equal(r.post.kind, 'fb'); assert.equal(r.post.status, 'draft'); assert.notEqual(r.post.id, pid);
    const a = await db.first(`SELECT text, entities, buttons FROM posts WHERE id = ?`, [pid]);
    const b = await db.first(`SELECT text, entities, buttons FROM posts WHERE id = ?`, [r.post.id]);
    assert.deepEqual({ ...b }, { ...a }, 'копия повторяет текст, оформление и кнопки');
    assert.equal((await api(`/post/${pid}/copy`, { kind: 'zzz' })).status, 400);
    // бонус за отзыв — тем, кто оставил отзыв раньше
    await db.run(`UPDATE posts SET status = 'active' WHERE id = ?`, [r.post.id]);
    await db.run(`UPDATE users SET fb_at = ?, status = 'active' WHERE tg_id = 1500`, [NOW]);
    const dry = await api('/fb/backfill', { since: 'today', dry: true });
    assert.equal(dry.people >= 1, true, 'нашла того, кто оставил отзыв сегодня');
    const c0 = calls.length;
    const go = await api('/fb/backfill', { since: 'today' });
    assert.ok(go.sent >= 1 && calls.slice(c0).some((c) => c.body.chat_id === 1500), 'бонус ушёл');
    const again = await api('/fb/backfill', { since: 'today' });
    assert.equal(again.sent, 0, 'второй раз никому не уходит');
    // CRM отзывов
    await db.run(`UPDATE users SET fb_at = ?, fb_like = 'круто', fb_improve = 'быстрее', status = 'active' WHERE tg_id = 1400`, [NOW - 60]);
    const rv = await api('/reviews');
    const u1400 = rv.reviews.find((x) => x.tg_id === 1400), u1500 = rv.reviews.find((x) => x.tg_id === 1500);
    assert.equal(u1400.bonus.pending, 1, 'у 1400 бонус ещё не отправлен');
    assert.equal(u1500.bonus.pending, 0); assert.ok(u1500.bonus.last_at, 'у 1500 видно, когда отправили');
    assert.equal((await api('/fb/send', { tg_id: 1400 })).sent, 1);
    assert.equal((await api('/reviews')).reviews.find((x) => x.tg_id === 1400).bonus.pending, 0, 'после отправки статус «отправлен»');
    assert.equal((await api('/fb/send', { tg_id: 424242 })).status, 404);
    await db.run(`UPDATE users SET fb_at = NULL, fb_like = NULL, fb_improve = NULL WHERE tg_id IN (1400, 1500)`);
    await db.run(`DELETE FROM deliveries WHERE tg_id IN (1400, 1500)`);
  }
  // свой пост — отдельный шаг входа между другими шагами
  {
    const sp = (await api('/post/new', { kind: 'node', title: 'Шаг-пост', md: 'ВСТАВНОЙ ШАГ ТЕКСТ', status: 'active' })).post;
    const fr = await api('/flow', { order: ['consentAds', 'post:' + sp.id, 'askName', 'post:99999x'], off: [] });
    assert.equal(fr.flow.order[2], 'post:' + sp.id, 'пост встал между шагами'); assert.ok(!fr.flow.order.includes('post:99999x'), 'мусорный ключ убран');
    const X = 1600;
    await msg(X, '/start audit_P_start_course'); await cb(X, 'c:pd'); await cb(X, 'c:ads:1');
    const got = calls.filter((c) => c.body.chat_id === X && /ВСТАВНОЙ ШАГ/.test(c.body.text || ''));
    assert.equal(got.length, 1, 'свой пост-шаг пришёл один раз');
    assert.match(lastText(X), /имя|зовут|называть/i, 'после него вход идёт дальше');
    await cb(X, 'n:ok');
    assert.equal(calls.filter((c) => c.body.chat_id === X && /ВСТАВНОЙ ШАГ/.test(c.body.text || '')).length, 1, 'второй раз не уходит');
    assert.equal((await api('/run/preview', { level: 'start', full: true, fromAudit: false })).ok, true);
    await api('/flow', { order: [], off: [] });
    await db.run(`UPDATE posts SET status = 'archived' WHERE id = ?`, [sp.id]);
  }
  // кнопка «Оставить заявку»
  {
    const lp = (await api('/post/new', { kind: 'node', title: 'С заявкой', md: 'Хочешь в предзапись?', status: 'active', rows: [[{ text: 'Оставить заявку', lead: true }]] })).post;
    assert.equal(lp.rows[0][0].lead, true, 'кнопка-заявка сохранилась');
    const Y = 1800;
    await msg(Y, '/start audit_P_start_course'); await cb(Y, 'c:pd'); await cb(Y, 'c:ads:1');
    const kb = (await import('../src/posts.js')).keyboard({ id: lp.id, buttons: JSON.stringify(lp.rows) }, Y, 'https://bot.test', {});
    assert.equal(kb.inline_keyboard[0][0].callback_data, 'ld:p:' + lp.id);
    const c0 = calls.length;
    await cb(Y, 'ld:p:' + lp.id);
    assert.equal((await db.first(`SELECT COUNT(*) AS n FROM leads WHERE tg_id = ?`, [Y])).n, 1, 'заявка записана');
    assert.equal((await db.first(`SELECT done FROM leads WHERE tg_id = ?`, [Y])).done, 0, 'без имени и контакта заявка не считается принятой');
    assert.ok(!calls.slice(c0).some((c) => c.body.chat_id === 100 && /Новая заявка/.test(c.body.text || '')), 'админу карточка пока не ушла');
    assert.ok(calls.slice(c0).some((c) => c.body.chat_id === Y && /имя и номер телефона/.test(c.body.text || '')), 'человека просят оставить имя и телефон');
    await cb(Y, 'n:ok');
    assert.equal((await db.first(`SELECT done FROM leads WHERE tg_id = ?`, [Y])).done, 0, 'одного имени мало: нужен телефон');
    await db.run(`UPDATE users SET email = 'y@mail.ru' WHERE tg_id = ?`, [Y]);
    assert.ok(calls.slice(c0).some((c) => c.body.chat_id === Y && /Отправить телефон|номер/.test(JSON.stringify(c.body))), 'просят именно телефон');
    await msg(Y, '+79991234567');
    assert.equal((await db.first(`SELECT done FROM leads WHERE tg_id = ?`, [Y])).done, 1, 'после имени и телефона заявка принята');
    assert.ok(calls.slice(c0).some((c) => c.body.chat_id === Y && /Заявка принята/.test(c.body.text || '')), 'человеку «заявка принята»');
    assert.ok(calls.slice(c0).some((c) => c.body.chat_id === 100 && /Новая заявка/.test(c.body.text || '')), 'админу пришла карточка');
    await cb(Y, 'ld:p:' + lp.id);
    assert.equal((await db.first(`SELECT COUNT(*) AS n FROM leads WHERE tg_id = ?`, [Y])).n, 1, 'второй раз не дублируется');
    assert.equal((await api('/reviews')).leads.length >= 1, true, 'заявки видны в панели');
    await db.run(`UPDATE posts SET status = 'archived' WHERE id = ?`, [lp.id]);
  }
  // перенос между лентой и постами для шагов
  {
    const np = (await api('/post/new', { kind: 'drip', title: 'Переносимый', md: 'текст', status: 'active', day: 2, time: '12:00' })).post;
    assert.equal((await api('/post/' + np.id + '/move', { to: 'node' })).ok, true);
    let row = await db.first(`SELECT kind, day, mode FROM posts WHERE id = ?`, [np.id]);
    assert.equal(row.kind, 'node'); assert.equal(row.day, null);
    assert.equal((await api('/post/' + np.id + '/move', { to: 'node' })).ok, true, 'перенос туда, где пост уже лежит, ничего не ломает');
    assert.equal((await api('/post/' + np.id + '/move', { to: 'drip', day: 3 })).ok, true);
    row = await db.first(`SELECT kind, day, mode, send_time FROM posts WHERE id = ?`, [np.id]);
    assert.deepEqual({ ...row }, { kind: 'drip', day: 3, mode: 'day', send_time: '11:00' });
    assert.equal((await api('/post/' + np.id + '/move', { to: 'drip', day: 999 })).status, 400);
    // любой раздел: включённый пост при переносе встаёт на паузу
    for (const to of ['gift', 'fb', 'date', 'node']) {
      await db.run(`UPDATE posts SET status = 'active' WHERE id = ?`, [np.id]);
      assert.equal((await api('/post/' + np.id + '/move', { to })).ok, true, 'в ' + to);
      row = await db.first(`SELECT kind, day, status, run_at FROM posts WHERE id = ?`, [np.id]);
      assert.equal(row.kind, to); assert.equal(row.day, null); assert.equal(row.status, 'paused', 'включённый пост на паузе после переноса в ' + to);
    }
    assert.equal((await api('/post/' + np.id + '/move', { to: 'вселенная' })).status, 400);
    // в боте: /new умеет «бонус за отзыв», на карточке поста есть «в другой раздел»
    await msg(100, '/new'); await msg(100, 'Бонус из бота');
    await cb(100, 'w:done'); await cb(100, 'w:kind:fb'); await cb(100, 'w:aud:course'); await cb(100, 'w:nobtn'); await cb(100, 'w:save:0');
    const bp = await db.first(`SELECT id, kind, track, status FROM posts WHERE text = 'Бонус из бота'`);
    assert.deepEqual({ kind: bp.kind, track: bp.track, status: bp.status }, { kind: 'fb', track: 'course', status: 'draft' }, '/new создал бонус за отзыв для мини-курса');
    const c1 = calls.length;
    await cb(100, 'p:' + bp.id + ':mv');
    assert.ok(calls.slice(c1).some((c) => c.body.chat_id === 100 && /Куда перенести/.test(c.body.text || '')), 'бот спрашивает, куда перенести');
    await cb(100, 'p:' + bp.id + ':mv:gift');
    assert.equal((await db.first(`SELECT kind FROM posts WHERE id = ?`, [bp.id])).kind, 'gift', 'перенесён в подарки');
    await cb(100, 'p:' + bp.id + ':mv:drip'); await msg(100, '4'); await msg(100, '10:00');
    row = await db.first(`SELECT kind, day, send_time FROM posts WHERE id = ?`, [bp.id]);
    assert.deepEqual({ ...row }, { kind: 'drip', day: 4, send_time: '10:00' }, 'в ленту: бот спросил день и время');
    await db.run(`UPDATE posts SET status = 'archived' WHERE id IN (?, ?)`, [bp.id, np.id]);
  }
  // полный путь: после аудита и с сайта
  for (const fromAudit of [true, false]) {
    const f0 = calls.length;
    assert.equal((await api('/run/preview', { level: 'start', full: true, fromAudit })).ok, true);
    const txt = calls.slice(f0).filter((c) => c.body.chat_id === 100 && c.method === 'sendMessage').map((c) => c.body.text || '');
    assert.ok(txt.some((t) => /Полный путь/.test(t) && (fromAudit ? /после аудита/ : /с сайта/).test(t)), 'шапка пути');
    assert.ok(txt.some((t) => /согласие на данные/.test(t)), 'шаг согласия показан');
    assert.ok(!txt.some((t) => /· уровень/.test(t)), 'вопроса про уровень в пути нет');
    assert.ok(txt.some((t) => /конец полного пути/.test(t)), 'конец');
  }
}
step('конструктор сценариев: порядок и выключатели шагов входа, посты-ответы, кнопки-выбор, цепочка после ответа, документы из панели, оплата-заглушка, #номер в чате');

// ---------- вход: выбор из аудита, телефон, отзыв с бонусом, лента по треку ----------
{
  await db.run(`UPDATE posts SET status = 'paused' WHERE kind IN ('drip', 'date', 'gift')`);
  const ins = async (o) => { await db.run(`INSERT INTO posts (title, kind, audience, track, mode, delay_min, day, send_time, status, text, created_at) VALUES (?, ?, 'all', ?, 'timer', ?, 0, '11:00', 'active', ?, ?)`, [o.t, o.kind || 'drip', o.track || 'all', o.delay || 0, o.t, NOW - 10]); return (await db.first('SELECT MAX(id) AS id FROM posts')).id; };
  const pc = await ins({ t: 'Урок 1 мини-курса', track: 'course', delay: 60 });
  const pm = await ins({ t: 'Гайд по шрифтам', track: 'mat', delay: 60 });
  const pa = await ins({ t: 'Новости школы', track: 'all', delay: 60 });
  const fbp = await ins({ t: 'Секретный урок 🤫', kind: 'fb' });
  const U = 1400, from = (x = {}) => ({ id: U, first_name: 'Лиза', username: 'liza_d', ...x });
  const m = (text, extra = {}) => handleUpdate(C(), { message: { message_id: mid++, from: from(), chat: { id: U, type: 'private' }, text, ...extra } });
  await m('/start audit_P_start_course');
  let u = await db.first('SELECT * FROM users WHERE tg_id = ?', [U]);
  assert.equal(u.zone, 'P'); assert.equal(u.track, 'course', 'выбор «мини-курс» из аудита запомнился'); assert.equal(u.level, 'start');
  await cb(U, 'c:pd'); await cb(U, 'c:ads:1');
  // имя пишет сама
  await m('Елизавета');
  assert.equal((await db.first('SELECT contact_name FROM users WHERE tg_id = ?', [U])).contact_name, 'Елизавета');
  const ask = calls.filter((c) => c.body.chat_id === U && /Как с тобой связаться/.test(c.body.text || '')).pop();
  assert.deepEqual(ask.body.reply_markup.inline_keyboard.map((r) => r[0].callback_data), ['ct:tg', 'ct:phone', 'ct:email'], 'есть ник — можно оставить Telegram');
  // телефон кнопкой «Отправить телефон»
  await cb(U, 'ct:phone');
  const kb2 = calls.filter((c) => c.body.chat_id === U && c.body.reply_markup && c.body.reply_markup.keyboard).pop();
  assert.ok(kb2.body.reply_markup.keyboard[0][0].request_contact, 'кнопка внизу экрана «Отправить телефон»');
  await m(undefined, { contact: { phone_number: '79001234567', user_id: 999 } });
  assert.equal((await db.first('SELECT phone FROM users WHERE tg_id = ?', [U])).phone, null, 'чужой контакт не принимаем');
  await m(undefined, { contact: { phone_number: '79001234567', user_id: U } });
  u = await db.first('SELECT * FROM users WHERE tg_id = ?', [U]);
  assert.equal(u.phone, '+79001234567'); assert.ok(u.contact_at);
  assert.ok(calls.some((c) => c.body.chat_id === U && c.body.reply_markup && c.body.reply_markup.remove_keyboard), 'кнопку телефона убрали');
  // отзыв о кабинете → бонус → админам уведомление
  assert.match(lastText(U), /прототип[\s\S]*kabinet/i);
  const f0 = calls.length;
  await cb(U, 'fb:yes'); await m('Карта кампуса и такса!'); await m('Добавить тёмную тему');
  u = await db.first('SELECT * FROM users WHERE tg_id = ?', [U]);
  assert.equal(u.fb_like, 'Карта кампуса и такса!'); assert.equal(u.fb_improve, 'Добавить тёмную тему'); assert.ok(u.fb_at);
  const after = calls.slice(f0);
  assert.ok(after.some((c) => c.body.chat_id === U && c.body.text === 'Секретный урок 🤫'), 'пришёл бонус за отзыв');
  const note = after.find((c) => c.body.chat_id === 100 && /Новый отзыв/.test(c.body.text || ''));
  assert.ok(note && /Елизавета · @liza_d · \+79001234567/.test(note.body.text) && /тёмную тему/.test(note.body.text), 'админу пришёл отзыв с контактом');
  // трек уже выбран в аудите — не спрашиваем; дальше подарок и расписание мини-курса
  assert.ok(!after.some((c) => c.body.chat_id === U && /Что тебе ближе/.test(c.body.text || '')), 'трек не спрашиваем повторно');
  assert.match(lastText(U), /ты с нами/);
  u = await db.first('SELECT * FROM users WHERE tg_id = ?', [U]);
  assert.equal(u.status, 'active'); assert.ok(u.joined_at && u.sched_at);
  // лента по треку
  NOW += 61 * 60; const t0 = calls.length;
  await tick(C(), 40);
  const got = calls.slice(t0).filter((c) => c.body.chat_id === U && c.method === 'sendMessage').map((c) => c.body.text);
  assert.ok(got.includes('Урок 1 мини-курса') && got.includes('Новости школы') && !got.includes('Гайд по шрифтам'), 'выбрал мини-курс — получает курс и общее, без материалов: ' + got);
  // повторный отзыв не просим, бонус не дублируем
  const r0 = calls.length; NOW += 20; await m('/start');
  assert.ok(!calls.slice(r0).some((c) => c.body.chat_id === U && /Секретный урок|прототип|обращаться/.test(c.body.text || '')), 'вход повторно не спрашивает');
  // почта с ошибкой и без отзыва — материалы
  const V = 1401;
  await msg(V, '/start audit_top_pro_month'); await cb(V, 'c:pd'); await cb(V, 'c:ads:1'); await cb(V, 'n:ok'); await cb(V, 'ct:email');
  await msg(V, 'мояпочта'); assert.match(lastText(V), /ошибка/);
  await msg(V, 'Liza@Mail.ru'); await cb(V, 'fb:no');
  const v = await db.first('SELECT * FROM users WHERE tg_id = ?', [V]);
  assert.equal(v.email, 'liza@mail.ru'); assert.equal(v.track, 'mat'); assert.equal(v.fb_skip, 1); assert.match(lastText(V), /ты с нами/);
  await db.run(`UPDATE posts SET status = 'archived' WHERE id IN (?, ?, ?, ?)`, [pc, pm, pa, fbp]);
}
step('вход: выбор из аудита (мини-курс/материалы), имя, телефон кнопкой или почта, отзыв о кабинете → бонус и уведомление админу, лента по треку');


// кнопки шага: можно спрятать и привязать пост
{
  const W = 1501; const kbOf = (chat) => { const c = last(chat)[0]; return ((c && c.body.reply_markup && c.body.reply_markup.inline_keyboard) || []).flat().map((b) => b.callback_data); };
  await db.run(`INSERT INTO posts (kind, title, text, entities, buttons, status, created_at) VALUES ('node', 'После пропуска', 'Привет из поста кнопки', '[]', '[]', 'active', ?)`, [NOW]); const pb = (await db.first(`SELECT id FROM posts WHERE title = 'После пропуска'`)).id;
  const C0 = C();
  await assert.rejects(() => saveBtnExtra(C0, 'consentPdBtn', { hide: true }), /нельзя/);
  await saveBtnExtra(C0, 'fbYes', { hide: true });
  await assert.rejects(() => saveBtnExtra(C0, 'fbNo', { hide: true }), /хотя бы одна/);
  await saveBtnExtra(C0, 'fbNo', { post: Number(pb) });
  await msg(W, '/start'); await cb(W, 'c:pd'); await cb(W, 'c:ads:1'); await cb(W, 'n:ok'); await cb(W, 'ct:tg');
  const fbKb = calls.filter((c) => c.body.chat_id === W && /fb:/.test(JSON.stringify(c.body.reply_markup || {}))).pop();
  assert.ok(fbKb && !JSON.stringify(fbKb.body.reply_markup).includes('fb:yes') && JSON.stringify(fbKb.body.reply_markup).includes('fb:no'), 'спрятанная кнопка не показывается');
  const w0 = calls.length; await cb(W, 'fb:no');
  assert.ok(calls.slice(w0).some((c) => c.body.chat_id === W && /Привет из поста кнопки/.test(c.body.text || c.body.caption || '')), 'пост кнопки пришёл');
  await saveBtnExtra(C0, 'fbYes', { hide: false }); await saveBtnExtra(C0, 'fbNo', { post: null });
  await db.run(`UPDATE posts SET status = 'archived' WHERE id = ?`, [pb]);
}
step('кнопки шага: спрятать и прислать пост после нажатия');
// финальное сообщение входа можно выключить: вход всё равно завершается, лента идёт
{
  const Z = 1601; const C1 = C();
  await C1.db.run(`INSERT INTO settings (key, value) VALUES ('flow:off', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`, [JSON.stringify(['sched'])]);
  await msg(Z, '/start audit_top_pro_month'); await cb(Z, 'c:pd'); await cb(Z, 'c:ads:1'); await cb(Z, 'n:ok'); await cb(Z, 'ct:tg'); await cb(Z, 'fb:no');
  const z = await C1.db.first('SELECT * FROM users WHERE tg_id = ?', [Z]);
  assert.ok(z.sched_at && z.status === 'active', 'вход завершён');
  assert.ok(!/ты с нами/.test(lastText(Z) || ''), 'финальное сообщение не прислано');
  await C1.db.run(`DELETE FROM settings WHERE key = 'flow:off'`);
}
step('финальное сообщение входа можно выключить');
// служебные ответы можно выключить, обязательные — нет
{
  const C2 = C();
  await setMsgOff(C2, 'unknown', true);
  await assert.rejects(() => setMsgOff(C2, 'policy', true), /нельзя/);
  await msg(1701, '/start'); await cb(1701, 'c:pd'); await cb(1701, 'c:ads:1');
  const q0 = calls.length; await msg(1701, '/blabla');
  assert.equal(calls.slice(q0).filter((c) => c.body.chat_id === 1701 && c.method === 'sendMessage').length, 0, 'выключенный ответ не уходит');
  await setMsgOff(C2, 'unknown', false);
  const q1 = calls.length; await msg(1701, '/blabla');
  assert.ok(calls.slice(q1).some((c) => c.body.chat_id === 1701 && c.method === 'sendMessage'), 'включённый уходит');
}
step('служебные ответы: вкл/выкл');

// развилка по треку: мини-курс и материалы получают каждый свой пост
{
  const { handlePanelApi } = await import('../src/panel-api.js');
  const crypto = await import('node:crypto');
  const initFor = (uid) => {
    const p = new URLSearchParams({ auth_date: String(NOW), user: JSON.stringify({ id: uid, first_name: 'Админ' }) });
    const dcs = [...p.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, v]) => `${k}=${v}`).join('\n');
    const secret = crypto.createHmac('sha256', 'WebAppData').update(env.BOT_TOKEN).digest();
    p.set('hash', crypto.createHmac('sha256', secret).update(dcs).digest('hex'));
    return p.toString();
  };
  const api = async (path, body) => {
    const req = new Request('https://bot.test/api/panel' + path, { method: body ? 'POST' : 'GET', headers: { 'x-init-data': initFor(100), 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    const r = await handlePanelApi(C(), req, new URL(req.url));
    return { status: r.status, ...(await r.json()) };
  };
  const bc = (await api('/post/new', { kind: 'node', md: 'ВЕТКА-КУРС', status: 'active' })).post;
  const bm = (await api('/post/new', { kind: 'node', md: 'ВЕТКА-МАТЕРИАЛЫ', status: 'active' })).post;
  const fk = (await api('/post/new', { fork: 'track', title: 'Развилка', rows: [[{ text: 'Мини-курс', go: bc.id, branch: 'course' }], [{ text: 'Материалы', go: bm.id, branch: 'mat' }]] })).post;
  assert.equal(fk.fork, 'track', 'развилка создана без текста');
  const hub = (await api('/post/new', { kind: 'node', md: 'Выбирай', status: 'active', rows: [[{ text: 'Дальше', go: fk.id }]] })).post;
  for (const [uid, track, want] of [[1801, 'course', 'ВЕТКА-КУРС'], [1802, 'mat', 'ВЕТКА-МАТЕРИАЛЫ']]) {
    await msg(uid, '/start'); await cb(uid, 'c:pd'); await cb(uid, 'c:ads:1');
    await C().db.run(`UPDATE users SET track = ? WHERE tg_id = ?`, [track, uid]);
    const k0 = calls.length;
    await handleUpdate(C(), { callback_query: { id: 'fk' + uid, from: { id: uid }, data: `go:${hub.id}:0-0`, message: { message_id: 9, chat: { id: uid } } } });
    const sent = calls.slice(k0).filter((c) => c.body.chat_id === uid && c.method === 'sendMessage').map((c) => c.body.text);
    assert.deepEqual(sent, [want], 'по развилке ' + track + ' получает свой пост');
  }
}
step('развилка по треку');
// заменить содержимое готового поста через бота (из панели)
{
  const { handlePanelApi } = await import('../src/panel-api.js');
  const crypto = await import('node:crypto');
  const p = new URLSearchParams({ auth_date: String(NOW), user: JSON.stringify({ id: 100, first_name: 'Админ' }) });
  const dcs = [...p.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, v]) => `${k}=${v}`).join('\n');
  const secret = crypto.createHmac('sha256', 'WebAppData').update(env.BOT_TOKEN).digest();
  p.set('hash', crypto.createHmac('sha256', secret).update(dcs).digest('hex'));
  const call = async (path, body) => { const req = new Request('https://bot.test/api/panel' + path, { method: 'POST', headers: { 'x-init-data': p.toString(), 'content-type': 'application/json' }, body: JSON.stringify(body) }); const r = await handlePanelApi(C(), req, new URL(req.url)); return r.json(); };
  const np = (await call('/post/new', { kind: 'node', md: 'СТАРЫЙ ТЕКСТ', status: 'active', rows: [[{ text: 'Ссылка', url: 'https://disign.ru' }]] })).post;
  assert.ok((await call('/post/' + np.id + '/rewrite', {})).ok, 'панель включила режим замены');
  await msg(100, 'НОВЫЙ ТЕКСТ'); await cb(100, 'w:done');
  const row = await C().db.first('SELECT text, buttons FROM posts WHERE id = ?', [np.id]);
  assert.equal(row.text, 'НОВЫЙ ТЕКСТ', 'содержимое заменено'); assert.ok(row.buttons && /disign\.ru/.test(row.buttons), 'кнопки сохранились');
}
step('замена содержимого поста через бота');
// история версий: правка из панели и из бота сохраняет прежний текст, возврат работает
{
  const { handlePanelApi } = await import('../src/panel-api.js');
  const crypto = await import('node:crypto');
  const pp = new URLSearchParams({ auth_date: String(NOW), user: JSON.stringify({ id: 100, first_name: 'Админ' }) });
  const dcs = [...pp.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, v]) => `${k}=${v}`).join('\n');
  const secret = crypto.createHmac('sha256', 'WebAppData').update(env.BOT_TOKEN).digest();
  pp.set('hash', crypto.createHmac('sha256', secret).update(dcs).digest('hex'));
  const call = async (path, body) => { const req = new Request('https://bot.test/api/panel' + path, { method: body ? 'POST' : 'GET', headers: { 'x-init-data': pp.toString(), 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined }); const r = await handlePanelApi(C(), req, new URL(req.url)); return r.json(); };
  const hp = (await call('/post/new', { kind: 'node', md: 'ВЕРСИЯ 1', status: 'active' })).post;
  assert.equal((await call('/post/' + hp.id + '/versions')).versions.length, 0, 'у нового поста истории нет');
  await call('/post/' + hp.id, { md: 'ВЕРСИЯ 2' });
  await call('/post/' + hp.id, { md: 'ВЕРСИЯ 3' });
  let vs = (await call('/post/' + hp.id + '/versions')).versions;
  assert.deepEqual(vs.map((v) => v.md), ['ВЕРСИЯ 2', 'ВЕРСИЯ 1'], 'прежние тексты сохранены, свежие сверху');
  await call('/post/' + hp.id, { title: 'Только название' });
  assert.equal((await call('/post/' + hp.id + '/versions')).versions.length, 2, 'правка названия историю не плодит');
  const back = await call('/post/' + hp.id + '/restore', { version: vs[1].id });
  assert.equal(back.post.md, 'ВЕРСИЯ 1', 'версия возвращена');
  vs = (await call('/post/' + hp.id + '/versions')).versions;
  assert.equal(vs[0].md, 'ВЕРСИЯ 3', 'возврат запомнил текущий текст');
  for (let i = 0; i < 14; i++) await call('/post/' + hp.id, { md: 'Правка ' + i });
  assert.equal((await call('/post/' + hp.id + '/versions')).versions.length, 10, 'хранится не больше 10 версий');
  assert.equal((await call('/post/' + hp.id + '/restore', { version: 999999 })).error, 'Такой версии нет');
}
step('история версий текста поста');
// откат на шаг назад, архив, «новые из бота»
{
  const { handlePanelApi } = await import('../src/panel-api.js');
  const crypto = await import('node:crypto');
  const pp = new URLSearchParams({ auth_date: String(NOW), user: JSON.stringify({ id: 100, first_name: 'Каролина' }) });
  const dcs = [...pp.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, v]) => `${k}=${v}`).join('\n');
  const secret = crypto.createHmac('sha256', 'WebAppData').update(env.BOT_TOKEN).digest();
  pp.set('hash', crypto.createHmac('sha256', secret).update(dcs).digest('hex'));
  const call = async (path, body) => { const req = new Request('https://bot.test/api/panel' + path, { method: body ? 'POST' : 'GET', headers: { 'x-init-data': pp.toString(), 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined }); const r = await handlePanelApi(C(), req, new URL(req.url)); return r.json(); };
  const up = (await call('/post/new', { kind: 'node', md: 'ДО ОТКАТА', status: 'active' })).post;
  await call('/post/' + up.id, { md: 'ПОСЛЕ ПРАВКИ' });
  let st = await call('/state');
  assert.match(st.undo.label, /правка «ПОСЛЕ ПРАВКИ»|правка «ДО ОТКАТА»/, 'панель знает, что можно отменить');
  assert.equal(st.undo.by, 'Каролина');
  let u = await call('/undo', {});
  assert.ok(u.ok, 'откат прошёл');
  assert.equal((await C().db.first('SELECT text FROM posts WHERE id = ?', [up.id])).text, 'ДО ОТКАТА', 'текст вернулся');
  u = await call('/undo', {});
  assert.equal(await C().db.first('SELECT id FROM posts WHERE id = ?', [up.id]), null, 'второй откат убирает созданный пост');
  // откат текста бота и порядка шагов
  await call('/msg/unknown', { text: 'ИЗМЕНЁННЫЙ ОТВЕТ' });
  await call('/undo', {});
  assert.notEqual(((await C().db.first(`SELECT value FROM settings WHERE key = 'msg:unknown'`)) || {}).value || '', JSON.stringify({ text: 'ИЗМЕНЁННЫЙ ОТВЕТ' }), 'текст бота откатился');
  assert.ok(!/ИЗМЕНЁННЫЙ/.test(((await C().db.first(`SELECT value FROM settings WHERE key = 'msg:unknown'`)) || {}).value || ''), 'в базе нет изменённого текста');
  // ошибка не попадает в откат
  const before = (await call('/state')).undo;
  await call('/post/999999', { md: 'x' });
  assert.deepEqual((await call('/state')).undo, before, 'неудачная правка не плодит откат');
  // архив
  const ar = (await call('/post/new', { kind: 'node', md: 'В АРХИВ', status: 'active' })).post;
  await call('/post/' + ar.id, { status: 'archived' });
  assert.ok((await call('/archive')).posts.some((p) => p.id === ar.id), 'пост в архиве');
  assert.ok(!(await call('/state')).posts.some((p) => p.id === ar.id), 'в пути его нет');
  await call('/post/' + ar.id, { status: 'active' });
  assert.ok((await call('/state')).posts.some((p) => p.id === ar.id && p.status === 'active'), 'вернулся из архива');
  // пост из бота попадает во «входящие», правка в панели убирает отметку
  await msg(100, '/new'); await msg(100, 'ИЗ БОТА ВО ВХОДЯЩИЕ'); await cb(100, 'w:done'); await cb(100, 'w:kind:node'); await cb(100, 'w:nobtn'); await cb(100, 'w:save:0');
  const ib = (await call('/state')).posts.find((p) => p.text === 'ИЗ БОТА ВО ВХОДЯЩИЕ');
  assert.ok(ib && ib.inbox, 'пост из /new помечен как новый');
  await call('/post/' + ib.id, { inbox: 0 });
  assert.ok(!(await call('/state')).posts.find((p) => p.id === ib.id).inbox, 'отметка снята');
}
step('откат на шаг назад, архив, новые из бота');
// несколько постов сразу и автоархив старых анонсов
{
  const { handlePanelApi } = await import('../src/panel-api.js');
  const { archiveOldDates } = await import('../src/posts.js');
  const crypto = await import('node:crypto');
  const pp = new URLSearchParams({ auth_date: String(NOW), user: JSON.stringify({ id: 100, first_name: 'Каролина' }) });
  const dcs = [...pp.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, v]) => `${k}=${v}`).join('\n');
  const secret = crypto.createHmac('sha256', 'WebAppData').update(env.BOT_TOKEN).digest();
  pp.set('hash', crypto.createHmac('sha256', secret).update(dcs).digest('hex'));
  const call = async (path, body) => { const req = new Request('https://bot.test/api/panel' + path, { method: body ? 'POST' : 'GET', headers: { 'x-init-data': pp.toString(), 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined }); const r = await handlePanelApi(C(), req, new URL(req.url)); return r.json(); };
  const a1 = (await call('/post/new', { kind: 'drip', md: 'ПАЧКА 1', status: 'active', day: 5 })).post;
  const a2 = (await call('/post/new', { kind: 'drip', md: 'ПАЧКА 2', status: 'active', day: 6 })).post;
  const empty = (await call('/post/new', { kind: 'node', md: '', status: 'draft' })).post;
  let r = await call('/bulk', { ids: [a1.id, a2.id], action: 'paused' });
  assert.equal(r.done, 2);
  assert.deepEqual((await C().db.all(`SELECT status FROM posts WHERE id IN (?, ?)`, [a1.id, a2.id])).map((x) => x.status), ['paused', 'paused'], 'обе на паузе');
  r = await call('/bulk', { ids: [a1.id, empty.id], action: 'active' });
  assert.deepEqual([r.done, r.skipped], [1, 1], 'пустой пост не включается');
  const n0 = (await C().db.first(`SELECT COUNT(*) AS n FROM posts`)).n;
  await call('/bulk', { ids: [a1.id, a2.id], action: 'copy' });
  assert.equal((await C().db.first(`SELECT COUNT(*) AS n FROM posts`)).n, n0 + 2, 'две копии');
  assert.match((await call('/state')).undo.label, /дублировать: постов 2/);
  await call('/undo', {});
  assert.equal((await C().db.first(`SELECT COUNT(*) AS n FROM posts`)).n, n0, 'один откат убирает обе копии');
  // старый анонс уходит в архив, свежий и «догонять» остаются
  const ctx1 = C();
  await ctx1.db.run(`INSERT INTO posts (kind, audience, status, text, entities, media, created_by, created_at, run_at, catchup) VALUES ('date','all','active','СТАРЫЙ АНОНС','[]','[]',100,?,?,0)`, [NOW, NOW - 8 * 86400]);
  await ctx1.db.run(`INSERT INTO posts (kind, audience, status, text, entities, media, created_by, created_at, run_at, catchup) VALUES ('date','all','active','СТАРЫЙ ДОГОНЯТЬ','[]','[]',100,?,?,1)`, [NOW, NOW - 8 * 86400]);
  await ctx1.db.run(`INSERT INTO posts (kind, audience, status, text, entities, media, created_by, created_at, run_at, catchup) VALUES ('date','all','active','СВЕЖИЙ АНОНС','[]','[]',100,?,?,0)`, [NOW, NOW - 2 * 86400]);
  await archiveOldDates(ctx1);
  const st = Object.fromEntries((await ctx1.db.all(`SELECT text, status FROM posts WHERE kind = 'date' AND text IN ('СТАРЫЙ АНОНС','СТАРЫЙ ДОГОНЯТЬ','СВЕЖИЙ АНОНС')`)).map((x) => [x.text, x.status]));
  assert.deepEqual(st, { 'СТАРЫЙ АНОНС': 'archived', 'СТАРЫЙ ДОГОНЯТЬ': 'active', 'СВЕЖИЙ АНОНС': 'active' }, 'автоархив только прошедших больше недели');
}
step('несколько постов сразу, автоархив анонсов');

// новый вход из соцсетей: развилка → экскурсия → меню (аудит / тарифы / отзыв); для пришедших из аудита — без развилки
{
  const { handlePanelApi } = await import('../src/panel-api.js');
  const crypto = await import('node:crypto');
  const pp = new URLSearchParams({ auth_date: String(NOW), user: JSON.stringify({ id: 100, first_name: 'Каролина' }) });
  const dcs = [...pp.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, v]) => `${k}=${v}`).join('\n');
  const secret = crypto.createHmac('sha256', 'WebAppData').update(env.BOT_TOKEN).digest();
  pp.set('hash', crypto.createHmac('sha256', secret).update(dcs).digest('hex'));
  const call = async (path, body) => { const req = new Request('https://bot.test/api/panel' + path, { method: body ? 'POST' : 'GET', headers: { 'x-init-data': pp.toString(), 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined }); return (await handlePanelApi(C(), req, new URL(req.url))).json(); };
  const tar = (await call('/post/new', { kind: 'node', title: 'Тарифы', md: 'ТАРИФЫ: куратор и наставник', status: 'active' })).post;
  const sc = await call('/path/scaffold', { apply: true });
  assert.ok(sc.ok && sc.applied && sc.tariffs === tar.id, 'заготовка собрана, тарифы найдены');
  const forkRow = await C().db.first('SELECT * FROM posts WHERE id = ?', [sc.ids.fork]);
  assert.equal(forkRow.who, 'new');
  const mrow = await C().db.first('SELECT buttons FROM posts WHERE id = ?', [sc.ids.menu]);
  const mb = JSON.parse(mrow.buttons).flat();
  assert.ok(mb.some((b) => b.fb) && mb.some((b) => b.go === tar.id) && mb.some((b) => b.url === 'https://example.com/test'), 'в меню: отзыв, тарифы, аудит');
  // 7700: из соцсетей
  await msg(7700, '/start'); await cb(7700, 'c:pd');
  { const c0 = calls.length; await cb(7700, 'c:ads:1');
    const out = sentTo(7700, c0);
    assert.ok(out.some((c) => /два пути/.test(c.body.text || '')), 'после согласий — развилка');
    assert.ok(!out.some((c) => /обращаться|ты с нами|Хочешь помочь нам/.test(c.body.text || '')), 'ни имени, ни отзыва, ни расписания'); }
  let f = last(7700)[0].body.reply_markup.inline_keyboard.flat();
  assert.deepEqual(f.map((b) => b.text), ['🧭 Экскурсия по прототипу', '📝 Пройти аудит']);
  await cb(7700, f[0].callback_data);
  assert.match(lastText(7700), /прототип кабинета/, 'экскурсия');
  const tb = last(7700)[0].body.reply_markup.inline_keyboard.flat();
  await cb(7700, tb[1].callback_data);
  assert.match(lastText(7700), /ну как тебе/, 'меню после экскурсии');
  const mk = last(7700)[0].body.reply_markup.inline_keyboard.flat();
  await cb(7700, mk.find((b) => /тариф/i.test(b.text)).callback_data);
  assert.match(lastText(7700), /ТАРИФЫ/, 'тарифы по кнопке');
  await cb(7700, mk.find((b) => /отзыв/i.test(b.text)).callback_data);
  assert.match(lastText(7700), /понравилось/, 'кнопка отзыва задаёт первый вопрос');
  await msg(7700, 'всё круто'); await msg(7700, 'добавьте больше примеров');
  let u7 = await C().db.first('SELECT * FROM users WHERE tg_id = 7700');
  assert.ok(u7.fb_at && u7.fb_like === 'всё круто', 'отзыв записан');
  assert.equal(u7.track, null, 'трек вслепую не спрашивали');
  { const c0 = calls.length; await cb(7700, mk.find((b) => /отзыв/i.test(b.text)).callback_data);
    assert.match(lastText(7700), /уже оставил/, 'второй раз отзыв не просим'); }
  // 7701: из аудита — развилки нет, подарок, трек, отзыв
  await msg(7701, '/start audit_P_start'); await cb(7701, 'c:pd');
  { const c0 = calls.length; await cb(7701, 'c:ads:1');
    const out = sentTo(7701, c0);
    assert.ok(!out.some((c) => /два пути/.test(c.body.text || '')), 'из аудита развилки нет');
    assert.ok(out.some((c) => /Что тебе ближе/.test(c.body.text || '')), 'трек спрашиваем (из аудита он не выбран)'); }
  await call('/post/new', { kind: 'gift', md: 'ПОДАРОК ПОСЛЕ АУДИТА', status: 'active' });
  { const c0 = calls.length; await cb(7701, 'tr:mat');
    assert.ok(sentTo(7701, c0).some((c) => /ПОДАРОК ПОСЛЕ АУДИТА/.test(c.body.text || '')), 'после выбора трека — подарок'); }
  assert.match(lastText(7701), /Хочешь помочь нам/, 'после подарка — отзыв о кабинете');
  await cb(7701, 'fb:no');
  assert.match(lastText(7701), /ты с нами/, 'в конце расписание');
  // откат вернёт прежний вход (первый откат убирает подарок, второй — всю заготовку)
  await call('/undo', {}); await call('/undo', {});
  assert.ok(!(await C().db.first('SELECT id FROM posts WHERE id = ?', [sc.ids.fork])), 'откат убрал заготовку');
  assert.ok(!/post:/.test((await C().db.first(`SELECT value FROM settings WHERE key = 'flow:order'`) || {}).value || ''), 'и порядок входа');
}
step('новый вход из соцсетей: развилка, экскурсия, меню; из аудита без развилки');

console.log('\nВсе сценарии прошли. Запросов к фейковому Telegram:', calls.length);
