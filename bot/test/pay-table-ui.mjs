// Вкладка «Оплаты» во внутренней таблице панели: открывается, показывает контакты и статус, влезает в экран. Снимки: SHOTS=папка
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { server, initData, db } from './panel-server.mjs';
const require = createRequire('/home/claude/');
const { chromium } = require('playwright');
await new Promise((r) => server.listen(8790, r));
const OUT = process.env.SHOTS || '.';
const now = Math.floor(Date.now() / 1000);
await db.run(`INSERT OR IGNORE INTO users (tg_id, first_name, username, phone, email, status, created_at, tariff, pay_total, paid1_at, paid_full_at) VALUES (777, 'Маша', 'masha', '+79990001122', 'm@x.ru', 'active', 0, 'prof', 33333, ?, ?)`, [now, now]);
await db.run(`INSERT OR IGNORE INTO payments (id, tg_id, tariff, part, amount, url, status, created_at, paid_at) VALUES ('t-pay-1-xxxxxxxx', 777, 'prof', 'full', 33333, 'u', 'succeeded', ?, ?)`, [now, now]);
await db.run(`INSERT OR IGNORE INTO users (tg_id, first_name, phone, email, status, created_at) VALUES (778, 'Петя', '+79991112233', 'p@x.ru', 'active', 0)`);
await db.run(`INSERT OR IGNORE INTO payments (id, tg_id, tariff, part, amount, url, status, created_at) VALUES ('t-pay-2-xxxxxxxx', 778, 'rector', 'full', 77777, 'u', 'pending', ?)`, [now]);
const b = await chromium.launch();
const INIT = initData();
const stub = (init) => `try{localStorage.setItem('panelView','{"old":false}')}catch(e){};window.Telegram={WebApp:{initData:${JSON.stringify(init)},ready(){},expand(){},setHeaderColor(){},setBackgroundColor(){},HapticFeedback:{impactOccurred(){},notificationOccurred(){}},colorScheme:'light',themeParams:{},BackButton:{show(){},hide(){},onClick(){}},MainButton:{hide(){}},isVersionAtLeast(){return true}}};`;
for (const w of [390, 320]) {
  const page = await b.newPage({ viewport: { width: w, height: 844 }, deviceScaleFactor: 2 });
  const errs = []; page.on('pageerror', (e) => errs.push(e.message));
  await page.route('**/telegram-web-app.js', (r) => r.fulfill({ contentType: 'application/javascript', body: stub(INIT) }));
  await page.goto('http://localhost:8790/admin');
  await page.waitForSelector('#tabs');
  await page.click('#tabs button[data-t="more"]');
  await page.click('[data-mr]:has-text("Заявки, отзывы и оплаты")');
  await page.waitForSelector('[data-tv="pays"]');
  await page.click('[data-tv="pays"]');
  await page.waitForSelector('table.tv');
  const txt = await page.innerText('table.tv');
  assert.match(txt, /Маша/); assert.match(txt, /\+79990001122/); assert.match(txt, /оплачено/); assert.match(txt, /ждёт оплаты/); assert.match(txt, /с ректором/);
  await page.screenshot({ path: `${OUT}/table-${w}.png` });
  const over = await page.evaluate(() => [...document.querySelectorAll('#sheet h2, #sheet .seg, #sheet .btns, #sheet .btn')].filter((e) => e.getBoundingClientRect().right > window.innerWidth + 1).map((e) => e.className));
  assert.deepEqual(over, [], 'шире экрана на ' + w + ': ' + over);
  assert.deepEqual(errs, [], 'ошибки скриптов: ' + errs);
  await page.close();
}
console.log('✓ таблица: вкладка «Оплаты» открывается, показывает контакты и статус, влезает в 320 и 390');
await b.close(); server.close(); process.exit(0);
