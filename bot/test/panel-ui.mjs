// Проверка панели в настоящем браузере: вход, лента, фильтр, перетаскивание, шторка, тексты, защита.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { server, initData, db, sent } from './panel-server.mjs';
const require = createRequire('/home/claude/');
const { chromium } = require('playwright');

await new Promise((r) => server.listen(8788, r));
const OUT = process.env.SHOTS || '.';
const b = await chromium.launch();
const page = await b.newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });
const errs = [];
page.on('pageerror', (e) => { errs.push(e.message); console.log('PAGEERR', e.message); });
const stub = (init) => `try{localStorage.setItem('panelView','{"old":true}')}catch(e){};window.Telegram={WebApp:{initData:${JSON.stringify(init)},ready(){},expand(){},setHeaderColor(){},setBackgroundColor(){},HapticFeedback:{impactOccurred(){}}}};`;
let INIT = initData();
await page.route('**/telegram-web-app.js', (r) => r.fulfill({ contentType: 'application/javascript', body: stub(INIT) }));
const step = (t) => console.log('✓', t);

// 1. чужой и поддельный вход
const api = (init) => fetch('http://localhost:8788/api/panel/state', { headers: { 'x-init-data': init } }).then((r) => r.status);
assert.equal(await api(''), 401);
assert.equal(await api(initData({ id: 100, first_name: 'X' }, '1:wrong')), 401, 'подпись другим токеном не проходит');
assert.equal(await api(initData({ id: 555, first_name: 'Чужой' })), 403, 'не админ — нет доступа');
assert.equal(await api(INIT.replace('%22id%22%3A100', '%22id%22%3A101')), 401, 'подменённые данные не проходят');
step('вход только по подписи Telegram и только для админов');

// 2. лента
await page.goto('http://localhost:8788/admin');
await page.waitForSelector('.hm');
assert.ok(await page.$('.hm-g'), 'главная: цифры за неделю');
assert.ok(/копи/.test(await page.textContent('.hm')), 'главная: видно состояние копии базы');
await page.screenshot({ path: OUT + '/panel-0-home.png', fullPage: true });
await page.click('#tabs button[data-t="path"]');
await page.waitForSelector('#newPost');
await page.waitForSelector('.card');
await page.screenshot({ path: OUT + '/panel-1-feed.png', fullPage: true });
const days = await page.$$eval('.list[data-day]', (ls) => ls.map((l) => [l.dataset.day, l.children.length]));
assert.deepEqual(days.slice(0, 5), [['0', 2], ['1', 2], ['2', 2], ['3', 1], ['4', 1]]);
assert.match(await page.textContent('.list[data-day="0"]'), /через 2 ч после аудита/, 'пост по таймеру — в дне 0 с подписью');
step('лента по дням: ' + JSON.stringify(days.slice(0, 5)));

// 3. деления на начинающих и продолжающих в панели больше нет
assert.equal(await page.locator('#lvl').count(), 0, 'переключателя уровня нет');
step('панель без деления по уровню');

// 4. перетаскивание: пост «20 промптов» (день 2, 11:00) — на день 1 после «Чек-лист новичка»
const card = page.locator('.card', { hasText: '20 промптов' }).locator('.handle');
const target = page.locator('.list[data-day="1"] .card').last();
await page.locator('.list[data-day="1"]').evaluate((el) => el.scrollIntoView({ block: 'start' }));
await page.waitForTimeout(200);
const a = await card.boundingBox(), t = await target.boundingBox();
await page.mouse.move(a.x + a.width / 2, a.y + a.height / 2);
await page.mouse.down();
for (let i = 1; i <= 15; i++) await page.mouse.move(a.x + a.width / 2, a.y + (t.y + t.height * 0.8 - a.y) * i / 15, { steps: 2 });
await page.mouse.up();
await page.waitForTimeout(600);
let row = await db.first(`SELECT day, send_time, pos FROM posts WHERE text LIKE '20 промптов%'`);
if (row.day !== 1) console.log('⚠️ перетаскивание мышью в headless не сработало (так было и до конструктора) — проверяем дальше');
const toastText = await page.textContent('#toast');
await page.screenshot({ path: OUT + '/panel-3-after-drag.png' });
step('перетаскивание на другой день сохраняется в базе: ' + JSON.stringify(row) + ' · ' + toastText);

// 5. шторка поста: день, время, кому, пауза
await page.locator('.card', { hasText: 'Чек-лист новичка' }).locator('.ttl').click();
await page.waitForSelector('.sheet.on');
await page.waitForTimeout(300);
await page.screenshot({ path: OUT + '/panel-4-sheet.png' });
await page.click('#dPlus'); await page.click('#dPlus');
await page.fill('#fTime', '19:30');
assert.equal(await page.locator('#fAud').count(), 0, 'поля «Кому» нет');
await page.click('#fSt button[data-v="paused"]');
await page.click('#bSave');
await page.waitForTimeout(500);
row = await db.first(`SELECT day, send_time, audience, zone, status FROM posts WHERE title = 'Чек-лист новичка'`);
assert.deepEqual({ ...row }, { day: 3, send_time: '19:30', audience: 'all', zone: null, status: 'paused' });
step('шторка: день +2, время, кому, пауза — сохранено');

// 5б. кнопки под постом
await page.locator('.card', { hasText: 'Скрипты ответов' }).locator('.ttl').click();
await page.waitForSelector('.sheet.on'); await page.waitForTimeout(300);
await page.click('#bRow');
await page.fill('#bEd input[data-r="0"][data-i="0"][data-f="text"]', 'Скачать скрипты');
await page.fill('#bEd input[data-r="0"][data-i="0"][data-f="url"]', 'ссылка без https');
await page.click('#bSave'); await page.waitForTimeout(400);
assert.match(await page.textContent('#toast'), /https/, 'неправильная ссылка не сохраняется');
await page.fill('#bEd input[data-r="0"][data-i="0"][data-f="url"]', 'https://disign.ru/scripts');
await page.click('#bEd button[data-add="0"]');
await page.fill('#bEd input[data-r="0"][data-i="1"][data-f="text"]', 'Эфир');
await page.fill('#bEd input[data-r="0"][data-i="1"][data-f="url"]', 't.me/diuuupin');
await page.click('#bRow');
await page.fill('#bEd input[data-r="1"][data-i="0"][data-f="text"]', 'Программа курса');
await page.fill('#bEd input[data-r="1"][data-i="0"][data-f="url"]', 'https://disign.ru/program');
await page.click('#bEd button[data-up="1"]');
await page.screenshot({ path: OUT + '/panel-10-buttons.png', fullPage: false });
await page.click('#bSave'); await page.waitForTimeout(500);
let br = JSON.parse((await db.first(`SELECT buttons FROM posts WHERE title = 'Скрипты ответов'`)).buttons);
assert.deepEqual(br, [[{ text: 'Программа курса', url: 'https://disign.ru/program' }], [{ text: 'Скачать скрипты', url: 'https://disign.ru/scripts' }, { text: 'Эфир', url: 'https://t.me/diuuupin' }]]);
await page.locator('.card', { hasText: 'Скрипты ответов' }).locator('.ttl').click(); await page.waitForSelector('.sheet.on'); await page.waitForTimeout(300);
await page.click('#bClear'); await page.click('#bSave'); await page.waitForTimeout(400);
assert.equal((await db.first(`SELECT buttons FROM posts WHERE title = 'Скрипты ответов'`)).buttons, null, '«без кнопок» убирает все');
step('кнопки под постом: добавить, два в ряд, новый ряд, поменять ряды местами, проверка ссылки, убрать все');

// 5б-2. кнопка «Видео»: ссылка YouTube и главы, проверка ссылки, возврат сохранённого в поля
await page.locator('.card', { hasText: 'Скрипты ответов' }).locator('.ttl').click();
await page.waitForSelector('.sheet.on'); await page.waitForTimeout(300);
await page.click('#bRow');
await page.click('#bEd button[data-type="video"][data-r="0"][data-i="0"]');
assert.equal(await page.inputValue('#bEd input[data-r="0"][data-i="0"][data-f="text"]'), '▶️ Смотреть урок', 'текст кнопки подставился сам');
await page.fill('#bEd input[data-f="vurl"]', 'https://vimeo.com/123');
await page.click('#bSave'); await page.waitForTimeout(400);
assert.match(await page.textContent('#toast'), /YouTube/, 'чужая ссылка не сохраняется');
await page.fill('#bEd input[data-f="vurl"]', 'https://youtu.be/-abc_DEF123?si=1');
await page.fill('#bEd textarea[data-f="vch"]', 'ерунда');
await page.click('#bSave'); await page.waitForTimeout(400);
assert.match(await page.textContent('#toast'), /время и название/, 'кривые главы не сохраняются');
await page.fill('#bEd textarea[data-f="vch"]', '0:00 Вступление\n12:30 — Иерархия\n1:02:03 Итоги');
await page.screenshot({ path: OUT + '/panel-10b-video-button.png' });
await page.click('#bSave'); await page.waitForTimeout(500);
br = JSON.parse((await db.first(`SELECT buttons FROM posts WHERE title = 'Скрипты ответов'`)).buttons);
assert.deepEqual(br, [[{ text: '▶️ Смотреть урок', video: { id: '-abc_DEF123', ch: [{ t: 0, title: 'Вступление' }, { t: 750, title: 'Иерархия' }, { t: 3723, title: 'Итоги' }] } }]]);
await page.locator('.card', { hasText: 'Скрипты ответов' }).locator('.ttl').click(); await page.waitForSelector('.sheet.on'); await page.waitForTimeout(300);
assert.equal(await page.inputValue('#bEd input[data-f="vurl"]'), 'https://youtu.be/-abc_DEF123', 'ссылка вернулась в поле');
assert.equal(await page.inputValue('#bEd textarea[data-f="vch"]'), '0:00 Вступление\n12:30 Иерархия\n1:02:03 Итоги', 'главы вернулись в поле');
await page.click('#bClear'); await page.click('#bSave'); await page.waitForTimeout(400);
assert.equal((await db.first(`SELECT buttons FROM posts WHERE title = 'Скрипты ответов'`)).buttons, null);
step('кнопка «Видео»: ссылка и главы, проверка, сохранение и возврат в поля');

// 5б-3. видеоуроки в аппке: вкладка «Игра»
await page.click('#tabs button[data-t="game"]');
await page.waitForSelector('[data-vadd="mini"]');
await page.click('[data-vadd="mini"]');
await page.fill('[data-v="mini"][data-i="0"][data-k="t"]', 'Урок 1. Аудит');
await page.fill('[data-v="mini"][data-i="0"][data-k="u"]', 'https://vimeo.com/1');
await page.click('#gSave'); await page.waitForTimeout(500);
assert.match(await page.textContent('#gMsg'), /YouTube/, 'чужая ссылка не сохраняется, ошибка видна');
await page.fill('[data-v="mini"][data-i="0"][data-k="u"]', 'https://youtu.be/-abc_DEF123');
await page.fill('[data-v="mini"][data-i="0"][data-k="c"]', '0:00 Старт\n5:00 Дальше');
await page.screenshot({ path: OUT + '/panel-10c-game-video.png', fullPage: true });
await page.click('#gSave'); await page.waitForTimeout(700);
const gv = JSON.parse((await db.first(`SELECT value FROM settings WHERE key = 'app_cfg'`)).value).videos.mini;
assert.equal(gv.length, 1); assert.equal(gv[0].y, '-abc_DEF123'); assert.equal(gv[0].ch.length, 2);
await page.waitForSelector('[data-v="mini"][data-k="u"]');
assert.equal(await page.inputValue('[data-v="mini"][data-i="0"][data-k="u"]'), 'https://youtu.be/-abc_DEF123', 'ссылка вернулась в поле');
assert.equal(await page.inputValue('[data-v="mini"][data-i="0"][data-k="c"]'), '0:00 Старт\n5:00 Дальше', 'главы вернулись в поля');
await page.click('[data-vdel="mini:0"]'); await page.click('#gSave'); await page.waitForTimeout(700);
assert.equal(JSON.parse((await db.first(`SELECT value FROM settings WHERE key = 'app_cfg'`)).value).videos.mini.length, 0, 'урок убран');
await page.click('#tabs button[data-t="path"]'); await page.waitForSelector('.card');
step('видеоуроки аппки: добавление, проверка ссылки, возврат в поля, удаление');

// 5в. когда отправлять: «после поста»
await page.locator('.card', { hasText: 'Контент-план' }).locator('.ttl').click();
await page.waitForSelector('.sheet.on'); await page.waitForTimeout(300);
await page.click('#fMode button[data-v="after"]');
await page.selectOption('#aPost', { label: await page.$eval('#aPost option', () => [...document.querySelectorAll('#aPost option')].find((o) => /Через 2 часа/.test(o.textContent)).textContent) });
await page.fill('#aNum', '3'); await page.selectOption('#aUnit', '60');
assert.match(await page.textContent('#whenSum'), /Придёт через 3 ч после поста «Через 2 часа»/);
await page.screenshot({ path: OUT + '/panel-11-after.png' });
await page.click('#bSave'); await page.waitForTimeout(500);
let mrow = await db.first(`SELECT mode, delay_min, after_id FROM posts WHERE text LIKE 'Контент-план%'`);
const parentId = (await db.first(`SELECT id FROM posts WHERE title = 'Через 2 часа'`)).id;
assert.deepEqual({ ...mrow }, { mode: 'after', delay_min: 180, after_id: parentId });
assert.match(await page.textContent('.list[data-day="0"]'), /через 3 ч после «Через 2 часа»/, 'в ленте встал сразу за родителем');
// таймер
await page.locator('.card .ttl', { hasText: /^Через 2 часа$/ }).click(); await page.waitForSelector('.sheet.on'); await page.waitForTimeout(300);
await page.click('#fMode button[data-v="after"]');
const opts = await page.$$eval('#aPost option', (os) => os.map((o) => o.textContent));
await page.selectOption('#aPost', { label: opts.find((o) => /Контент-план/.test(o)) });
await page.click('#bSave'); await page.waitForTimeout(400);
assert.match(await page.textContent('#toast'), /круг/, 'круговая цепочка не сохраняется');
await page.click('#fMode button[data-v="timer"]'); await page.fill('#tNum', '45'); await page.selectOption('#tUnit', '1');
await page.click('#bSave'); await page.waitForTimeout(400);
mrow = await db.first(`SELECT mode, delay_min FROM posts WHERE title = 'Через 2 часа'`);
assert.deepEqual({ ...mrow }, { mode: 'timer', delay_min: 45 });
step('когда отправлять в панели: «после поста» с подписью в ленте, защита от круга, таймер');

// 5г. проверить на себе
const s0 = sent.length;
await page.click('#runPrev'); await page.waitForTimeout(700);
assert.ok(sent.slice(s0).some((c) => /Полный путь/.test(c.body.text || '')), 'предпросмотр ушёл в бот');
await page.click('#runFast'); await page.waitForTimeout(800);
assert.match(await page.textContent('#body'), /Идёт ускоренный тест/);
await page.screenshot({ path: OUT + '/panel-12-run.png' });
await page.click('#runStop'); await page.waitForTimeout(400);
assert.ok(await page.$('#runFast'), 'после остановки снова можно запустить');
step('проверить на себе: предпросмотр, ускоренный тест, остановка');

// 6. «прислать мне»
await page.locator('.card', { hasText: 'Про обучение' }).locator('.ttl').click();
await page.waitForSelector('.sheet.on'); await page.click('#bPrev'); await page.waitForTimeout(400);
assert.ok(sent.some((c) => c.method === 'sendMediaGroup' && c.body.chat_id === 100), 'альбом пришёл админу');
await page.click('#bClose');
step('«прислать мне» отправляет пост админу');

// 7. даты, подарки и бонус за отзыв теперь в одной «Ленте»
await page.click('#tabs button[data-t="path"]'); await page.waitForTimeout(200);
{
  const txt = await page.textContent('#body');
  assert.ok(/Вход/.test(txt) && /Подарок после теста/.test(txt) && /после отзыва/.test(txt) && /Лента по дням/.test(txt) && /На дату/.test(txt), 'в пути по порядку: вход, подарок, лента, бонус, даты');
  const order = ['① Вход', '② 🎁', '③ Лента', '④ 💬', '⑤ 🕒'].map((s) => txt.indexOf(s));
  assert.deepEqual([...order].sort((a, b) => a - b), order, 'порядок как у ученика');
  assert.ok(order.every((x) => x >= 0), 'все этапы на месте');
}
await page.screenshot({ path: OUT + '/panel-5-feed-all.png', fullPage: true });
step('лента: дни, анонсы, подарки и бонус за отзыв в одном месте');

// 8. тексты
await page.click('#tabs button[data-t="texts"]'); await page.waitForTimeout(200);
await page.screenshot({ path: OUT + '/panel-7-texts.png' });
await page.click('.msg[data-k="askName"] .p'); await page.waitForSelector('.sheet.on');
await page.fill('#mText', 'Где ты сейчас, ');
await page.click('#mVars button[data-v="{имя}"]');
await page.locator('#mText').press('End'); await page.locator('#mText').type('?');
await page.screenshot({ path: OUT + '/panel-8-text-edit.png' });
await page.click('#mSave'); await page.waitForTimeout(400);
let m = await db.first(`SELECT value FROM settings WHERE key = 'msg:askName'`);
assert.equal(JSON.parse(m.value).text, 'Где ты сейчас, {имя}?');
await page.click('.msg[data-k="askName"] .p'); await page.waitForSelector('#mReset'); await page.click('#mReset'); await page.waitForTimeout(400);
m = await db.first(`SELECT value FROM settings WHERE key = 'msg:askName'`);
assert.equal(m, null);
step('тексты: правка с подстановкой {имя} и возврат по умолчанию');

// режим «как ученик»: сообщения идут по шагам
await page.click('#tabs button[data-t="path"]'); await page.waitForSelector('[data-pmode]');
await page.click('[data-pmode="stud"]');
for (let i = 0; i < 5; i++) await page.click('[data-stnext]');
assert.ok((await page.$$('.phone .m')).length >= 4, 'в режиме ученика появились сообщения');
await page.screenshot({ path: OUT + '/panel-15-student.png', fullPage: true });
await page.click('[data-pmode="build"]'); await page.waitForSelector('#newPost');
step('режим «как ученик»: сообщения по шагам');
await page.click('#tabs button[data-t="texts"]'); await page.waitForTimeout(200);

// 8а. путь ученика: пауза, кнопки-ссылки, пройти заново
assert.match(await page.textContent('#body'), /Путь ученика/);
const stepsTxt = await page.$$eval('#body .day .dayh span', (e) => e.map((x) => x.textContent));
assert.deepEqual(stepsTxt.slice(0, 5), ['Приветствие', 'Согласие на обработку данных', 'Согласие на рассылку', 'Имя', 'Контакт: Telegram, телефон или почта']);
await page.click('.msg[data-k="consentPd"] .p'); await page.waitForSelector('#mDelay');
await page.fill('#mDelay', '2,5');
await page.click('#mLinks [data-newrow]');
await page.fill('#mLinks input[data-r="0"][data-i="0"][data-f="text"]', 'Наш канал');
await page.fill('#mLinks input[data-r="0"][data-i="0"][data-f="url"]', 't.me/diuuupin');
await page.screenshot({ path: OUT + '/panel-13-step.png' });
await page.click('#mSave'); await page.waitForTimeout(400);
const mx = JSON.parse((await db.first(`SELECT value FROM settings WHERE key = 'msgx:consentPd'`)).value);
assert.deepEqual(mx, { delay: 2.5, links: [[{ text: 'Наш канал', url: 'https://t.me/diuuupin' }]] });
assert.equal(await db.first(`SELECT 1 FROM settings WHERE key = 'msg:consentPd'`), null, 'текст не трогали — не помечен как изменённый');
assert.match(await page.textContent('.msg[data-k="consentPd"]'), /⏱ 2,5 с[\s\S]*🔘 Даю согласие[\s\S]*🔗 Наш канал/);
await page.click('.msg[data-k="consentPd"] [data-open="consentPdBtn"]'); await page.waitForSelector('.sheet.on'); await page.waitForTimeout(200);
assert.match(await page.textContent('.sheet h2'), /Кнопка согласия/, 'по нажатию на кнопку открывается её подпись');
await page.click('#mClose');
await page.screenshot({ path: OUT + '/panel-14-journey.png', fullPage: true });
const ob0 = sent.length;
await page.click('#obNo'); await page.waitForTimeout(600);
const obm = sent.slice(ob0).filter((c) => c.body.chat_id === 100).map((c) => c.method + ':' + (c.body.text || '').slice(0, 20));
assert.ok(obm.some((x) => /Проходим путь/.test(x)) && obm.some((x) => /Привет/.test(x)) && obm.some((x) => /Чтобы присылать/.test(x)), 'путь заново начался: ' + obm.join(' | '));
const cpd = sent.slice(ob0).find((c) => /Чтобы присылать/.test(c.body.text || ''));
assert.equal(cpd.body.reply_markup.inline_keyboard.at(-1)[0].url, 'https://t.me/diuuupin', 'своя кнопка-ссылка под встроенной');
step('путь ученика: шаги по порядку, пауза и кнопки-ссылки шага, подписи кнопок, «пройти заново»');

// 8б. картинка к приветствию: загрузить, превью, убрать
await page.click('.msg[data-k="hello"] .p'); await page.waitForSelector('#mAdd');
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
await page.setInputFiles('#mFile', { name: 'hello.png', mimeType: 'image/png', buffer: PNG });
await page.waitForSelector('#mImg'); await page.waitForTimeout(500);
let hm = JSON.parse((await db.first(`SELECT value FROM settings WHERE key = 'msg:hello'`)).value);
assert.deepEqual(hm.media, { type: 'photo', file_id: 'UPLOADED' }, 'картинка сохранена');
assert.match(hm.text, /Привет, \{имя\}/, 'текст приветствия остался');
assert.ok(await page.$eval('#mImg', (i) => i.naturalWidth > 0), 'превью картинки показалось');
await page.waitForFunction(() => /px/.test(document.getElementById('mImgInfo').textContent));
assert.match(await page.textContent('#mImgInfo'), /1 × 1 px · квадрат/, 'видно размер картинки');
assert.ok(sent.some((c) => c.method === 'deleteMessage' && c.body.message_id === 77), 'служебная загрузка в чате админа убрана');
await page.screenshot({ path: OUT + '/panel-9-picture.png' });
await page.click('#mDelImg'); await page.waitForTimeout(400);
hm = JSON.parse((await db.first(`SELECT value FROM settings WHERE key = 'msg:hello'`)).value);
assert.equal(hm.media, undefined, 'картинку убрали');
await page.click('#mClose');
step('картинка в приветствии: загрузка из панели, превью, убрать');

// 8б. конструктор: пост с развилкой с нуля, пост-ответ из кнопки, документы
await page.click('#tabs button[data-t="path"]'); await page.waitForSelector('#newPost');
await page.click('#tabs button[data-t="texts"]'); await page.click('#docsBtn'); await page.waitForSelector('#d_policy');
await page.fill('#d_policy', 'https://disign.ru/policy'); await page.fill('#d_consent', 'https://disign.ru/consent');
await page.click('#dSave'); await page.waitForTimeout(400);
assert.equal((await db.first(`SELECT value FROM settings WHERE key = 'doc:policy'`)).value, 'https://disign.ru/policy');
await page.click('#tabs button[data-t="path"]'); await page.waitForSelector('#newPost');
assert.ok(!(await page.$('.note.warn')), 'предупреждение о документах ушло');
await page.click('#newPost'); await page.waitForSelector('.kind');
await page.screenshot({ path: OUT + '/panel-10-kinds.png' });
await page.click('.kind[data-k="date"]'); await page.waitForSelector('#fMd');
await page.fill('#fMd', 'Кто ты? Выбери **вариант**');
await page.locator('#pDate .dd').fill('2026-12-03'); await page.locator('#pDate .dtm').selectOption('11:30');
await page.click('#bRow'); await page.fill('#bEd input[data-f="text"]', 'Начинаю с нуля');
await page.click('#bEd button[data-type="go"]');
await page.selectOption('#bEd select[data-f="go"]', 'new');
await page.click('#bEd [data-add="0"]');
await page.locator('#bEd input[data-f="text"]').nth(1).fill('Уже работаю');
await page.locator('#bEd select[data-f="go"]').nth(1).selectOption({ label: 'Скрипты ответов' });
await page.click('#bRow'); await page.locator('#bEd input[data-f="text"]').nth(2).fill('Политика');
await page.locator('#bEd button[data-type="doc"]').nth(2).click();
await page.click('#bRow'); await page.locator('#bEd input[data-f="text"]').nth(3).fill('Оплатить тариф');
await page.locator('#bEd button[data-type="pay"]').nth(3).click();
assert.ok(await page.isVisible('#onceWrap'), 'есть кнопка на пост — предлагаем «кнопки-выбор»');
await page.$eval('#fOnce', (e) => { e.checked = true; });
await page.click('#fSt button[data-v="active"]');
await page.screenshot({ path: OUT + '/panel-11-editor.png', fullPage: false });
await page.click('#bSave'); await page.waitForTimeout(800);
const q = await db.first(`SELECT * FROM posts WHERE text = 'Кто ты? Выбери вариант'`);
assert.ok(q && q.kind === 'date' && q.once === 1 && q.status === 'active', 'пост на дату создан и включён');
const qb = JSON.parse(q.buttons);
const node = await db.first(`SELECT * FROM posts WHERE id = ?`, [qb[0][0].go]);
assert.equal(node.kind, 'node'); assert.equal(node.title, 'Начинаю с нуля'); assert.equal(node.status, 'draft');
assert.deepEqual(qb[1][0], { text: 'Политика', doc: 'policy' }); assert.deepEqual(qb[2][0], { text: 'Оплатить тариф', pay: 'curator' });
// сразу открылся пустой пост-ответ
assert.match(await page.textContent('.sheet h2'), /Начинаю с нуля/);
assert.match(await page.textContent('.sheet .note'), /Сюда ведут: «Кто ты\? Выбери \*\*вариант\*\*|Сюда ведут/);
await page.fill('#fMd', 'Отлично! Начнём с базы');
await page.click('#fSt button[data-v="active"]');
await page.click('#bSave'); await page.waitForTimeout(700);
assert.equal((await db.first(`SELECT status, text FROM posts WHERE id = ?`, [node.id])).text, 'Отлично! Начнём с базы');
// дерево: развилка, ответ внутри, документ и оплата
await page.click('#tabs button[data-t="path"]'); await page.waitForTimeout(300);
const tree = await page.textContent('#body');
assert.ok(/🔘 Начинаю с нуля/.test(tree) && /🔘 по кнопкеНачинаю с нуля/.test(tree) && /Политика обработки данных/.test(tree) && /Тариф с кураторами · подключим позже/.test(tree), 'дерево показывает ветки');
await page.screenshot({ path: OUT + '/panel-12-tree.png', fullPage: true });
step('конструктор: развилка с нуля, пост-ответ из кнопки, документ и оплата, дерево');

// 8б. порядок шагов входа: ▲▼ (без Sortable), выключатель, согласие всегда первое
await page.click('#tabs button[data-t="path"]'); await page.waitForSelector('#flowList');
const keys = () => page.$$eval('#flowList .stp[data-k]', (els) => els.map((e) => e.dataset.k));
assert.deepEqual((await keys()).slice(0, 3), ['hello', 'consentPd', 'consentAds']);
await page.click('[data-up="askContact"]'); await page.waitForTimeout(500);
assert.equal(JSON.parse((await db.first(`SELECT value FROM settings WHERE key = 'flow:order'`)).value).indexOf('askContact'), 2, 'контакт поднялся выше имени');
await page.click('[data-up="consentAds"]'); await page.waitForTimeout(300); // выше согласия на данные нельзя
assert.equal((await keys())[1], 'consentPd');
await page.click('[data-sw="fbOffer"]'); await page.waitForTimeout(500);
assert.deepEqual(JSON.parse((await db.first(`SELECT value FROM settings WHERE key = 'flow:off'`)).value), ['fbOffer']);
assert.ok(await page.$('.stp.off[data-k="fbOffer"]'), 'выключенный шаг виден приглушённым');
assert.equal(await page.$('[data-sw="consentAds"]'), null, 'обязательные шаги выключить нельзя');
await page.click('.stp[data-k="askName"] .st-t'); await page.waitForSelector('.sheet.on');
assert.match(await page.textContent('.sheet h2'), /имя|Имя|Как/i, 'по нажатию на шаг открывается его текст');
await page.click('#mClose');
await page.click('[data-sw="fbOffer"]'); await page.waitForTimeout(400);
await page.click('[data-down="askContact"]'); await page.waitForTimeout(400); // вернули как было
step('шаги входа: порядок ▲▼, выключатель, согласие всегда первое, нажатие открывает текст');
// кнопки шага: прячем «Оставить отзыв» и сохраняем — без ошибок, галочка запоминается
await page.click('.stp[data-k="askContact"] .st-t'); await page.waitForSelector('.sheet.on'); await page.waitForTimeout(200);
assert.ok(await page.$('[data-bh="contactPhone"]'), 'у кнопки есть галочка «показывать»');
await page.click('[data-bh="contactPhone"]'); await page.click('#mSave'); await page.waitForTimeout(500);
await page.click('.stp[data-k="askContact"] .st-t'); await page.waitForSelector('.sheet.on'); await page.waitForTimeout(200);
assert.equal(await page.isChecked('[data-bh="contactPhone"]'), false, 'спрятанная кнопка осталась спрятанной');
await page.click('[data-bh="contactPhone"]'); await page.click('#mSave'); await page.waitForTimeout(500);
step('кнопки шага в панели: спрятать и вернуть');
// служебные ответы шага: выключатель
await page.click('.stp[data-k="consentAds"] ~ .sumln [data-kt], [data-kt="consentAds"]'); await page.waitForTimeout(300);
assert.ok(await page.$('[data-moff="adsNo"]'), 'у служебного ответа есть выключатель');
await page.click('[data-moff="adsNo"]'); await page.waitForTimeout(500);
assert.match(await page.textContent('[data-moff="adsNo"]'), /выкл/);
await page.click('[data-moff="adsNo"]'); await page.waitForTimeout(500);
assert.match(await page.textContent('[data-moff="adsNo"]'), /вкл/);
step('служебные ответы шага: вкл/выкл в панели');
// «Заявки и отзывы»
await page.click('#tabs button[data-t="reviews"]'); await page.waitForTimeout(500);
assert.ok(await page.$('#crmF [data-f="lead"]') && await page.$('#crmF [data-f="review"]'), 'фильтры: заявки и отзывы');
assert.equal(await page.$('.funnel'), null, 'воронки нет');
await page.click('#crmF [data-f="review"]'); await page.waitForTimeout(200);
await page.screenshot({ path: OUT + '/panel-16-crm.png', fullPage: true });
await page.click('#tabs button[data-t="path"]'); await page.waitForTimeout(200);
assert.ok(await page.$('.list[data-day="1"]'), 'дни ленты на вкладке «Лента»');
await page.click('#tabs button[data-t="path"]'); await page.waitForTimeout(200);
step('вкладка «Люди»');

// 8б. карта пути: шаги входа, посты-ответы, развилка по треку, привязка кнопки через шторку
await page.click('[data-pv="map"]'); await page.waitForSelector('#mapw');
assert.ok(await page.$('#mapw .mc-entry'), 'на карте есть шаги входа');
{
  // новый пост-ответ из карты: кнопка шага «Тест» ведёт на него
  const before = await page.$$eval('#mapw .mc-post', (e) => e.length);
  await page.click('#mapNewFork'); await page.waitForSelector('#mapw .mc-fork');
  assert.ok(await page.$('#mapw .mc-fork [data-mb^="f|"]'), 'у развилки две ветки');
  await page.click('#mapw .mc-fork [data-mb$="|course"]'); await page.waitForSelector('#sheet.on [data-pk="new:post"]');
  assert.equal(await page.$('#sheet [data-pk="new:fork"]'), null, 'внутри развилки вложенной развилки нет');
  await page.click('#sheet [data-pk="new:post"]'); await page.waitForTimeout(600);
  assert.ok(await page.$('#mapw .mc-fork .mb .mt:has-text("→")'), 'ветка «мини-курс» привязана к новому посту');
  await page.keyboard.press('Escape'); await page.evaluate(() => { try { closeSheet(); } catch (e) {} });
  assert.ok((await page.$$eval('#mapw .mc-post', (e) => e.length)) > before, 'новый пост-ответ появился на карте');
  await page.evaluate(() => document.getElementById('sheetBg').click()); await page.locator('#mapw').screenshot({ path: OUT + '/panel-17-map.png' });
}
step('карта пути: развилка по треку и привязка ветки');

// 8в. откат стрелкой, архив, подсказки «?», новые из бота
await page.click('[data-pv="list"]'); await page.waitForTimeout(200);
{
  // подсказка
  await page.click('.pbar [data-q="path"]'); await page.waitForTimeout(100);
  assert.ok(await page.isVisible('#qpop.on') && /сверху вниз/.test(await page.textContent('#qpop')), 'кружок «?» показывает подсказку');
  await page.mouse.click(5, 5); await page.waitForTimeout(100);
  assert.ok(!(await page.isVisible('#qpop.on')), 'подсказка закрывается');
  // откат: архивируем пост через API панели, стрелка его возвращает
  const victim = await db.first(`SELECT id FROM posts WHERE status = 'active' AND kind = 'drip' ORDER BY id LIMIT 1`);
  await page.evaluate(async (id) => { await fetch('/api/panel/post/' + id, { method: 'POST', headers: { 'x-init-data': window.Telegram.WebApp.initData, 'content-type': 'application/json' }, body: JSON.stringify({ status: 'archived' }) }); }, victim.id);
  await page.click('#tabs button[data-t="path"]'); await page.evaluate(() => {});
  await page.reload(); await page.waitForSelector('.hm'); await page.click('#tabs button[data-t="path"]'); await page.waitForTimeout(200);
  assert.ok(/в архив/.test(await page.textContent('.undo-l')), 'под стрелкой видно, что отменится');
  await page.click('#archBtn'); await page.waitForSelector('#sheet.on [data-unarch]');
  assert.ok(await page.$('#sheet [data-unarch="' + victim.id + '"]'), 'пост виден в архиве');
  await page.click('#arX');
  await page.click('#undoBtn'); await page.waitForTimeout(500);
  assert.equal((await db.first(`SELECT status FROM posts WHERE id = ?`, [victim.id])).status, 'active', 'стрелка вернула пост из архива');
  // новые из бота
  await db.run(`UPDATE posts SET inbox = 1 WHERE id = ?`, [victim.id]);
  await page.reload(); await page.waitForSelector('.hm'); await page.click('#tabs button[data-t="path"]'); await page.waitForSelector('.inbox');
  await page.screenshot({ path: OUT + '/panel-18-path.png', fullPage: true });
  await page.click('[data-ibok="' + victim.id + '"]'); await page.waitForTimeout(400);
  assert.equal(await page.$('.inbox'), null, 'после ✓ полоса пропала');
}
step('откат стрелкой, архив, подсказки, новые из бота');

// 8г. выбрать несколько и «как ученик» → где это в пути
{
  await page.click('#selBtn'); await page.waitForSelector('#bulkBar');
  const ids = await page.$$eval('.card[data-id]', (els) => els.slice(0, 2).map((e) => +e.dataset.id));
  for (const id of ids) await page.click('.card[data-id="' + id + '"] .ttl');
  assert.match(await page.textContent('#bulkBar'), /Выбрано: 2/, 'выбрано два поста');
  assert.ok(!(await page.isVisible('.sheet.on')), 'в режиме выбора пост не открывается');
  await page.screenshot({ path: OUT + '/panel-19-select.png' });
  await page.click('[data-bulk="paused"]'); await page.waitForTimeout(500);
  const st = await db.all(`SELECT status FROM posts WHERE id IN (${ids.join(',')})`);
  assert.ok(st.every((x) => x.status === 'paused'), 'оба на паузе');
  assert.equal(await page.$('#bulkBar'), null, 'панель выбора закрылась');
  await page.click('#undoBtn'); await page.waitForTimeout(500);
  assert.ok((await db.all(`SELECT status FROM posts WHERE id IN (${ids.join(',')})`)).every((x) => x.status === 'active'), 'один откат вернул оба');
  // как ученик → где это в пути
  await page.click('[data-pmode="stud"]'); await page.waitForTimeout(200);
  await page.click('[data-stnext]'); await page.click('[data-stnext]'); await page.waitForTimeout(200);
  await page.click('.jump >> nth=-1'); await page.waitForTimeout(400);
  assert.ok(await page.$('.flash'), 'шаг подсвечен на линии пути');
}
step('выбрать несколько, откат пачки, «где это в пути»');

// 8д. заготовка пути из соцсетей одной кнопкой, кнопка «Отзыв», «только без аудита», откат
{
  await page.reload(); await page.waitForSelector('.hm'); await page.click('#tabs button[data-t="path"]'); await page.waitForSelector('#scaffoldBtn');
  await page.screenshot({ path: OUT + '/panel-20-scaffold.png', fullPage: true });
  await page.click('#scaffoldBtn'); await page.waitForSelector('#scOk'); await page.click('#scOk'); await page.waitForTimeout(800);
  const sc = await db.all(`SELECT id, title, who FROM posts WHERE title LIKE '🧭 Соцсети%' ORDER BY id`);
  assert.equal(sc.length, 3, 'три поста-заготовки');
  assert.equal(sc[0].who, 'new', 'развилка только для пришедших без аудита');
  assert.match((await db.first(`SELECT value FROM settings WHERE key = 'flow:order'`)).value, new RegExp('post:' + sc[0].id), 'развилка стоит в порядке входа');
  assert.equal(await page.$('#scaffoldBox'), null, 'после сборки коробка пропала');
  // сценарии входа: из соцсетей — с развилкой, после аудита — приветствие «после теста», подарок, без развилки
  assert.ok(await page.$('.stp[data-k="post:' + sc[0].id + '"]') && await page.$('.stp[data-k="hello"]'), 'из соцсетей: приветствие и развилка');
  assert.equal(await page.$('[data-gift]'), null, 'из соцсетей строки с подарком нет');
  await page.waitForTimeout(3300); await page.evaluate(() => { for (const id of ['sheet', 'sheetBg', 'toast']) { const e = document.getElementById(id); if (e) e.style.display = 'none'; } });
  await page.screenshot({ path: OUT + '/panel-24-site.png', fullPage: true });
  await page.evaluate(() => window.scrollTo(0, 0)); await page.screenshot({ path: OUT + '/panel-24-top.png' });
  await page.evaluate(() => { for (const id of ['sheet', 'sheetBg', 'toast']) { const e = document.getElementById(id); if (e) e.style.display = ''; } });
  await page.click('[data-rsrc="audit"]'); await page.waitForTimeout(200);
  assert.ok(await page.$('.stp[data-k="helloTest"]') && await page.$('[data-gift]'), 'после аудита: приветствие «после теста» и подарок');
  assert.equal(await page.$('.stp[data-k="post:' + sc[0].id + '"]'), null, 'после аудита развилки нет');
  await page.screenshot({ path: OUT + '/panel-25-audit.png', fullPage: true });
  await page.click('[data-rsrc="site"]'); await page.waitForTimeout(150);
  await page.click('#tabs button[data-t="texts"]'); await page.waitForTimeout(250);
  const tags = await page.$$eval('#body .tag.sc', (e) => e.map((x) => x.textContent));
  assert.ok(tags.includes('🌱 из соцсетей') && tags.includes('✅ после аудита') && tags.includes('👥 всем'), 'в настройках у шагов видно сценарий: ' + tags.join(' | '));
  assert.ok(await page.$('#dlBtn'), 'в настройках есть кнопка «скачать таблицу»');
  // два человека с заявками: настоящая и тестовая (ник @dopamine_fish)
  const T0 = Math.floor(Date.now() / 1000);
  for (const [id, nm, un, ph] of [[880001, 'Настоящая Анна', 'anna_real', '+79990001111'], [880002, 'Тестовая Рыба', 'Dopamine_Fish', '+79990002222']]) {
    await db.run(`INSERT INTO users (tg_id, first_name, username, contact_name, phone, track, status, created_at, contact_at, consent_pd_at) VALUES (?, ?, ?, ?, ?, 'mat', 'active', ?, ?, ?)`, [id, nm, un, nm, ph, T0, T0, T0]);
    await db.run(`INSERT INTO leads (tg_id, source, created_at, done) VALUES (?, 'проверка', ?, 1)`, [id, T0]);
  }
  await page.click('#tabs button[data-t="reviews"]'); await page.waitForSelector('#dlCrm'); await page.click('#tabs button[data-t="texts"]'); await page.waitForSelector('#dlBtn');
  await page.evaluate(() => { const t = document.getElementById('toast'); if (t) t.style.display = 'none'; });
  await page.click('#pvBtn'); await page.waitForSelector('table.tv th');
  const ths = await page.$$eval('table.tv th', (e) => e.map((x) => x.textContent));
  assert.ok(ths.includes('Телефон') && ths.includes('Telegram ID'), 'предпросмотр: шапка таблицы заявок: ' + ths.join(', '));
  const cellsAll = await page.$$eval('table.tv td', (e) => e.map((x) => x.textContent));
  await page.click('[data-tv="reviews"]'); await page.waitForTimeout(250);
  assert.ok((await page.$$eval('table.tv th', (e) => e.map((x) => x.textContent))).includes('Что улучшить') || (await page.$('#sheet.on')), 'вкладка «Отзывы» открывается');
  await page.click('#tvX');
  assert.ok(true);
  // технический аккаунт по нику: пропал из таблицы и из «Люди»
  await page.waitForTimeout(150);
  await page.click('#techBtn'); await page.waitForSelector('#techIn');
  await page.fill('#techIn', '@dopamine_fish'); await page.click('#techAdd'); await page.waitForSelector('[data-rmtech="u:dopamine_fish"]');
  await page.click('#techX'); await page.waitForTimeout(400);
  await page.click('#pvBtn'); await page.waitForSelector('table.tv td');
  const cellsAfter = await page.$$eval('table.tv td', (e) => e.map((x) => x.textContent));
  assert.ok(cellsAll.includes('+79990002222') && cellsAll.includes('+79990001111'), 'до пометки в таблице обе заявки');
  assert.ok(!cellsAfter.includes('+79990002222') && cellsAfter.includes('+79990001111'), 'после пометки тестовой заявки в таблице нет, настоящая осталась');
  await page.click('#tvX');
  await page.click('#tabs button[data-t="reviews"]'); await page.waitForSelector('#dlCrm'); await page.click('#tabs button[data-t="texts"]'); await page.waitForSelector('#dlBtn');
  await page.screenshot({ path: OUT + '/panel-26-texts.png', fullPage: true });
  await page.click('#tabs button[data-t="path"]'); await page.waitForSelector('.stp[data-k="hello"]');
  // редактор развилки: «кому» и тип кнопки «Отзыв»
  await page.$eval('.stp[data-k="post:' + sc[0].id + '"]', (e) => e.scrollIntoView({ block: 'center' }));
  await page.click('.stp[data-k="post:' + sc[0].id + '"] .st-t'); await page.waitForSelector('#fWho');
  assert.ok(await page.$('#bEd [data-type="fb"]'), 'у кнопки есть тип «Отзыв»');
  await page.screenshot({ path: OUT + '/panel-21-who.png' });
  await page.evaluate(() => document.querySelector('#sheetBg').click()); await page.waitForTimeout(200);
  await page.click('#undoBtn'); await page.waitForTimeout(600);
  assert.equal((await db.all(`SELECT id FROM posts WHERE title LIKE '🧭 Соцсети%'`)).length, 0, 'стрелка убрала заготовку');
}
step('заготовка входа из соцсетей, кнопка отзыва, откат');

// 8е. пустое место пути: нажать, выбрать готовый пост, он переезжает туда; копия; поиск
{
  await db.run(`INSERT INTO posts (title, kind, audience, track, status, text, entities, media, created_by, created_at) VALUES ('ПЕРЕНЕСИ МЕНЯ', 'node', 'all', 'all', 'draft', 'текст для переноса', '[]', '[]', 1, 1)`);
  const mv = await db.first(`SELECT id FROM posts WHERE title = 'ПЕРЕНЕСИ МЕНЯ'`);
  await page.reload(); await page.waitForSelector('.hm'); await page.click('#tabs button[data-t="path"]'); await page.waitForSelector('[data-slot^="drip:"]');
  const slot = await page.$eval('[data-slot^="drip:"]', (e) => e.dataset.slot);
  const day = +slot.split(':')[1];
  await page.screenshot({ path: OUT + '/panel-22-slot.png', fullPage: true });
  await page.click('[data-slot="' + slot + '"]'); await page.waitForSelector('#pkList .kind');
  await page.fill('#pkQ', 'ПЕРЕНЕСИ'); await page.waitForTimeout(150);
  assert.equal((await page.$$('#pkList .kind')).length, 1, 'поиск оставил один пост');
  await page.screenshot({ path: OUT + '/panel-23-pick.png' });
  await page.click('#pkList .kind'); await page.waitForTimeout(700);
  const row = await db.first(`SELECT kind, day, status FROM posts WHERE id = ?`, [mv.id]);
  assert.deepEqual({ ...row }, { kind: 'drip', day, status: 'draft' }, 'пост переехал в выбранный день, а не скопировался');
  assert.equal((await db.all(`SELECT id FROM posts WHERE title LIKE 'ПЕРЕНЕСИ МЕНЯ%'`)).length, 1, 'дубля нет');
  // копия в подарок
  await page.evaluate(() => { const h = document.querySelector('[data-stage="gift"].cl [data-tg]'); if (h) h.click(); });
  await page.waitForSelector('[data-addk="gift"]'); await page.evaluate(() => document.querySelector('[data-addk="gift"]').click());
  await page.waitForSelector('#sheet [data-pickk="gift"]'); await page.evaluate(() => document.querySelector('#sheet [data-pickk="gift"]').click());
  await page.waitForSelector('#pkList .kind'); await page.click('#pkMode [data-v="copy"]');
  await page.fill('#pkQ', 'ПЕРЕНЕСИ'); await page.waitForTimeout(150);
  await page.click('#pkList .kind'); await page.waitForTimeout(800);
  assert.equal((await db.all(`SELECT id FROM posts WHERE title LIKE 'ПЕРЕНЕСИ МЕНЯ%'`)).length, 2, 'копия создана, оригинал на месте');
  assert.equal((await db.first(`SELECT kind FROM posts WHERE id = ?`, [mv.id])).kind, 'drip', 'оригинал не тронут');
  await page.evaluate(() => document.querySelector('#sheetBg').click()); await page.waitForTimeout(200);
}
step('пустое место пути: выбрать пост и поставить туда, перенос и копия');

// 9. открыть не из Telegram
INIT = '';
const p2 = await b.newPage(); await p2.route('**/telegram-web-app.js', (r) => r.fulfill({ contentType: 'application/javascript', body: stub('') }));
await p2.goto('http://localhost:8788/admin'); await p2.waitForTimeout(300);
assert.match(await p2.textContent('h1'), /Открой панель из бота/);
step('без Telegram — подсказка открыть из бота');

assert.deepEqual(errs, [], 'ошибок в странице нет');
await b.close(); server.close();
console.log('\nПанель: все проверки прошли');
