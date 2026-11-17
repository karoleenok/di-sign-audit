// Экран «Оплата» в панели: открывается из «Ещё», сохраняет ключи, не показывает секрет назад. Снимки: SHOTS=папка
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { server, initData, db } from './panel-server.mjs';
const require = createRequire('/home/claude/');
const { chromium } = require('playwright');
await new Promise((r) => server.listen(8789, r));
const OUT = process.env.SHOTS || '.';
const b = await chromium.launch();
const INIT = initData();
const stub = (init) => `try{localStorage.setItem('panelView','{"old":false}')}catch(e){};window.Telegram={WebApp:{initData:${JSON.stringify(init)},ready(){},expand(){},setHeaderColor(){},setBackgroundColor(){},HapticFeedback:{impactOccurred(){},notificationOccurred(){}},onEvent(){},offEvent(){},MainButton:{},BackButton:{show(){},hide(){},onClick(){},offClick(){}},themeParams:{},colorScheme:'light'}};`;
for (const w of [390, 320]) {
  const page = await b.newPage({ viewport: { width: w, height: 844 }, deviceScaleFactor: 2 });
  const errs = []; page.on('pageerror', (e) => errs.push(e.message));
  await page.route('**/telegram-web-app.js', (r) => r.fulfill({ contentType: 'application/javascript', body: stub(INIT) }));
  await page.goto('http://localhost:8789/admin');
  await page.waitForSelector('#tabs');
  await page.click('#tabs button[data-t="more"]');
  await page.click('[data-mr]:has-text("Оплата")');
  await page.waitForSelector('#pyShop');
  await page.screenshot({ path: `${OUT}/pay-${w}-1.png` });
  // ничто не вылезает за ширину экрана
  const over = await page.evaluate(() => [...document.querySelectorAll('#sheet input, #sheet button, #sheet p, #sheet h2, #sheet label')].filter((e) => e.getBoundingClientRect().right > window.innerWidth + 1).map((e) => e.id || e.tagName));
  assert.deepEqual(over, [], 'элементы шире экрана на ' + w + ': ' + over);
  await page.fill('#pyShop', '1486061');
  await page.fill('#pySecret', 'test_' + 'Q'.repeat(30));
  await page.click('#paySave');
  await page.waitForSelector('#pyHook, #payGen');
  if (await page.$('#payGen')) await page.click('#payGen');
  await page.waitForSelector('#pyHook');
  assert.match(await page.inputValue('#pyHook'), /\/yk\/[0-9a-f]{36}$/);
  await page.waitForFunction(() => { const e = document.getElementById('pySecret'); return e && e.value === ''; }, null, { timeout: 5000 }).catch(() => {});
  assert.equal(await page.inputValue('#pySecret'), '', 'секрет назад в поле не возвращается');
  assert.match(await page.getAttribute('#pySecret', 'placeholder'), /сохранён/);
  await page.evaluate(() => { document.getElementById('sheet').scrollTop = 700; });
  await page.screenshot({ path: `${OUT}/pay-${w}-2.png` });
  assert.ok(!(await page.content()).includes('QQQQQQQQQQ'), 'секрет попал в страницу');
  assert.deepEqual(errs, [], 'ошибки скриптов: ' + errs);
  await page.close();
}
const raw = (await db.first(`SELECT value FROM settings WHERE key = 'paycfg'`)).value;
assert.ok(!raw.includes('QQQQQQQQQQ'), 'секрет в базе открытым текстом');
console.log('✓ экран «Оплата»: открывается, сохраняет, не отдаёт секрет, влезает в 320 и 390');
await b.close(); server.close(); process.exit(0);
