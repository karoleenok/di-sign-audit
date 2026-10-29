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
await page.waitForSelector('.card');
await page.screenshot({ path: OUT + '/panel-1-feed.png', fullPage: true });
const days = await page.$$eval('.list', (ls) => ls.map((l) => [l.dataset.day, l.children.length]));
assert.deepEqual(days.slice(0, 5), [['0', 1], ['1', 2], ['2', 2], ['3', 1], ['4', 1]]);
step('лента по дням: ' + JSON.stringify(days.slice(0, 5)));

// 3. фильтр «как увидит человек»
await page.click('#lvl button[data-v="start"]');
await page.click('#zn button[data-z="B"]');
const offs = await page.$$eval('.card.off .ttl', (e) => e.map((x) => x.textContent));
assert.ok(offs.includes('Скрипты ответов') && offs.includes('Про обучение · портфолио'), 'продолжающим и зоне P — не получит: ' + offs);
await page.screenshot({ path: OUT + '/panel-2-filter.png', fullPage: false });
await page.click('#lvl button[data-v="all"]'); await page.click('#zn button[data-z=""]');
step('фильтр: начинающий из зоны «Визуальная база» не получит посты для продолжающих и для зоны «Портфолио»');

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
assert.equal(row.day, 1, 'перенесён на день 1');
const toastText = await page.textContent('#toast');
await page.screenshot({ path: OUT + '/panel-3-after-drag.png' });
step('перетаскивание на другой день сохраняется в базе: ' + JSON.stringify(row) + ' · ' + toastText);

// 5. шторка поста: день, время, кому, зона, пауза
await page.locator('.card', { hasText: 'Чек-лист новичка' }).locator('.ttl').click();
await page.waitForSelector('.sheet.on');
await page.waitForTimeout(300);
await page.screenshot({ path: OUT + '/panel-4-sheet.png' });
await page.click('#dPlus'); await page.click('#dPlus');
await page.fill('#fTime', '19:30');
await page.click('#fAud button[data-v="all"]');
await page.selectOption('#fZone', 'B');
await page.click('#fSt button[data-v="paused"]');
await page.click('#bSave');
await page.waitForTimeout(500);
row = await db.first(`SELECT day, send_time, audience, zone, status FROM posts WHERE title = 'Чек-лист новичка'`);
assert.deepEqual({ ...row }, { day: 3, send_time: '19:30', audience: 'all', zone: 'B', status: 'paused' });
step('шторка: день +2, время, кому, зона, пауза — сохранено');

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
assert.ok((await page.textContent('#body')).includes('Подарка нет'), 'пустые зоны подсвечены');
await page.screenshot({ path: OUT + '/panel-6-gifts.png', fullPage: true });
step('вкладки «Даты» и «Подарки»');

// 8. тексты
await page.click('#tabs button[data-t="texts"]'); await page.waitForTimeout(200);
await page.screenshot({ path: OUT + '/panel-7-texts.png' });
await page.click('.msg[data-k="askLevel"]'); await page.waitForSelector('.sheet.on');
await page.fill('#mText', 'Где ты сейчас, ');
await page.click('#mVars button[data-v="{имя}"]');
await page.locator('#mText').press('End'); await page.locator('#mText').type('?');
await page.screenshot({ path: OUT + '/panel-8-text-edit.png' });
await page.click('#mSave'); await page.waitForTimeout(400);
let m = await db.first(`SELECT value FROM settings WHERE key = 'msg:askLevel'`);
assert.equal(JSON.parse(m.value).text, 'Где ты сейчас, {имя}?');
await page.click('.msg[data-k="askLevel"]'); await page.waitForSelector('#mReset'); await page.click('#mReset'); await page.waitForTimeout(400);
m = await db.first(`SELECT value FROM settings WHERE key = 'msg:askLevel'`);
assert.equal(m, null);
step('тексты: правка с подстановкой {имя} и возврат по умолчанию');

// 9. открыть не из Telegram
INIT = '';
const p2 = await b.newPage(); await p2.route('**/telegram-web-app.js', (r) => r.fulfill({ contentType: 'application/javascript', body: stub('') }));
await p2.goto('http://localhost:8788/admin'); await p2.waitForTimeout(300);
assert.match(await p2.textContent('h1'), /Открой панель из бота/);
step('без Telegram — подсказка открыть из бота');

assert.deepEqual(errs, [], 'ошибок в странице нет');
await b.close(); server.close();
console.log('\nПанель: все проверки прошли');
