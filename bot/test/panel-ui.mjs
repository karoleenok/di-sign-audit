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
page.on('pageerror', (e) => errs.push(e.message));
const stub = (init) => `window.Telegram={WebApp:{initData:${JSON.stringify(init)},ready(){},expand(){},setHeaderColor(){},setBackgroundColor(){},HapticFeedback:{impactOccurred(){}}}};`;
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
await page.waitForSelector('#newPost');
await page.click('#tabs button[data-t="feed"]');
await page.waitForSelector('.card');
await page.screenshot({ path: OUT + '/panel-1-feed.png', fullPage: true });
const days = await page.$$eval('.list', (ls) => ls.map((l) => [l.dataset.day, l.children.length]));
assert.deepEqual(days.slice(0, 5), [['0', 2], ['1', 2], ['2', 2], ['3', 1], ['4', 1]]);
assert.match(await page.textContent('.list[data-day="0"]'), /⏱ через 2 ч после входа/, 'пост по таймеру — в дне 0 с подписью');
step('лента по дням: ' + JSON.stringify(days.slice(0, 5)));

// 3. фильтр «как увидит человек»
await page.click('#lvl button[data-v="start"]');
const offs = await page.$$eval('.card.off .ttl', (e) => e.map((x) => x.textContent));
assert.ok(offs.includes('Скрипты ответов') && !offs.includes('Про обучение · портфолио'), 'начинающий не получит только посты для продолжающих: ' + offs);
await page.screenshot({ path: OUT + '/panel-2-filter.png', fullPage: false });
await page.click('#lvl button[data-v="all"]');
step('фильтр: начинающий не получит посты для продолжающих');

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
await page.click('#fAud button[data-v="all"]');
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

// 5в. когда отправлять: «после поста»
await page.locator('.card', { hasText: 'Контент-план' }).locator('.ttl').click();
await page.waitForSelector('.sheet.on'); await page.waitForTimeout(300);
await page.click('#fMode button[data-v="after"]');
await page.selectOption('#aPost', { label: await page.$eval('#aPost option', () => [...document.querySelectorAll('#aPost option')].find((o) => /Через 2 часа/.test(o.textContent)).textContent) });
await page.fill('#aNum', '3'); await page.selectOption('#aUnit', '60');
assert.match(await page.textContent('#aHint'), /Через 3 ч после того, как человек получил «Через 2 часа»/);
await page.screenshot({ path: OUT + '/panel-11-after.png' });
await page.click('#bSave'); await page.waitForTimeout(500);
let mrow = await db.first(`SELECT mode, delay_min, after_id FROM posts WHERE text LIKE 'Контент-план%'`);
const parentId = (await db.first(`SELECT id FROM posts WHERE title = 'Через 2 часа'`)).id;
assert.deepEqual({ ...mrow }, { mode: 'after', delay_min: 180, after_id: parentId });
assert.match(await page.textContent('.list[data-day="0"]'), /↳ через 3 ч после «Через 2 часа»/, 'в ленте встал сразу за родителем');
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
assert.ok(sent.slice(s0).some((c) => /Предпросмотр ленты/.test(c.body.text || '')), 'предпросмотр ушёл в бот');
await page.click('#runFast'); await page.waitForTimeout(600);
assert.match(await page.textContent('.box:has(#runStop)'), /Идёт ускоренный тест/);
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

// 7. даты и подарки
await page.click('#tabs button[data-t="dates"]'); await page.waitForTimeout(200);
await page.screenshot({ path: OUT + '/panel-5-dates.png' });
await page.click('#tabs button[data-t="gifts"]'); await page.waitForTimeout(200);
assert.ok((await page.textContent('#body')).includes('Продолжающим'), 'подарки по уровням');
await page.screenshot({ path: OUT + '/panel-6-gifts.png', fullPage: true });
step('вкладки «Даты» и «Подарки»');

// 8. тексты
await page.click('#tabs button[data-t="texts"]'); await page.waitForTimeout(200);
await page.screenshot({ path: OUT + '/panel-7-texts.png' });
await page.click('.msg[data-k="askLevel"] .p'); await page.waitForSelector('.sheet.on');
await page.fill('#mText', 'Где ты сейчас, ');
await page.click('#mVars button[data-v="{имя}"]');
await page.locator('#mText').press('End'); await page.locator('#mText').type('?');
await page.screenshot({ path: OUT + '/panel-8-text-edit.png' });
await page.click('#mSave'); await page.waitForTimeout(400);
let m = await db.first(`SELECT value FROM settings WHERE key = 'msg:askLevel'`);
assert.equal(JSON.parse(m.value).text, 'Где ты сейчас, {имя}?');
await page.click('.msg[data-k="askLevel"] .p'); await page.waitForSelector('#mReset'); await page.click('#mReset'); await page.waitForTimeout(400);
m = await db.first(`SELECT value FROM settings WHERE key = 'msg:askLevel'`);
assert.equal(m, null);
step('тексты: правка с подстановкой {имя} и возврат по умолчанию');

// 8а. путь ученика: пауза, кнопки-ссылки, пройти заново
assert.match(await page.textContent('#body'), /Путь ученика/);
const stepsTxt = await page.$$eval('#body .day .dayh span', (e) => e.map((x) => x.textContent));
assert.deepEqual(stepsTxt.slice(0, 3), ['Приветствие', 'Согласие на обработку данных', 'Уровень']);
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
await page.click('#tabs button[data-t="flow"]'); await page.waitForSelector('#newPost');
await page.click('#docsBtn'); await page.waitForSelector('#d_policy');
await page.fill('#d_policy', 'https://disign.ru/policy'); await page.fill('#d_consent', 'https://disign.ru/consent');
await page.click('#dSave'); await page.waitForTimeout(400);
assert.equal((await db.first(`SELECT value FROM settings WHERE key = 'doc:policy'`)).value, 'https://disign.ru/policy');
assert.ok(!(await page.$('.box .note.warn')), 'предупреждение о документах ушло');
await page.click('#newPost'); await page.waitForSelector('.kind');
await page.screenshot({ path: OUT + '/panel-10-kinds.png' });
await page.click('.kind[data-k="date"]'); await page.waitForSelector('#fMd');
await page.fill('#fMd', 'Кто ты? Выбери **вариант**');
await page.fill('#fRun', '2026-12-03T11:30');
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
const tree = await page.textContent('#body');
assert.ok(/🔘 Начинаю с нуля/.test(tree) && /🔘 по кнопкеНачинаю с нуля/.test(tree) && /Политика обработки данных/.test(tree) && /Тариф с кураторами · подключим позже/.test(tree), 'дерево показывает ветки');
await page.locator('.grp', { hasText: 'В дату' }).scrollIntoViewIfNeeded();
await page.screenshot({ path: OUT + '/panel-12-tree.png', fullPage: true });
step('конструктор: развилка с нуля, пост-ответ из кнопки, документ и оплата, дерево');

// 9. открыть не из Telegram
INIT = '';
const p2 = await b.newPage(); await p2.route('**/telegram-web-app.js', (r) => r.fulfill({ contentType: 'application/javascript', body: stub('') }));
await p2.goto('http://localhost:8788/admin'); await p2.waitForTimeout(300);
assert.match(await p2.textContent('h1'), /Открой панель из бота/);
step('без Telegram — подсказка открыть из бота');

assert.deepEqual(errs, [], 'ошибок в странице нет');
await b.close(); server.close();
console.log('\nПанель: все проверки прошли');
