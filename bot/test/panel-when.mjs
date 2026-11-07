// Проверка «Когда отправлять»: новый пост на выбранный день, смена способа (таймер/дата) с переносом между разделами.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { server, initData, db } from './panel-server.mjs';
const require = createRequire('/home/claude/');
const { chromium } = require('playwright');
await new Promise((r) => server.listen(8789, r));
const OUT = process.env.SHOTS || '.';
const b = await chromium.launch();
const INIT = initData();
const stub = `try{localStorage.setItem('panelView','{"old":true}')}catch(e){};window.Telegram={WebApp:{initData:${JSON.stringify(INIT)},ready(){},expand(){},setHeaderColor(){},setBackgroundColor(){},HapticFeedback:{impactOccurred(){}}}};`;
for (const w of [390, 320]) {
  const page = await b.newPage({ viewport: { width: w, height: 844 }, deviceScaleFactor: 1 });
  const errs = []; page.on('pageerror', (e) => errs.push(e.message));
  await page.route('**/telegram-web-app.js', (r) => r.fulfill({ contentType: 'application/javascript', body: stub }));
  await page.goto('http://localhost:8789/admin');
  await page.waitForSelector('.hm');
  await page.click('#tabs button[data-t="path"]'); await page.waitForSelector('#newPost');
  const before = (await db.all(`SELECT id FROM posts`)).length;
  await page.locator('[data-newday="1"]').first().click(); await page.waitForSelector('#fMd');
  assert.equal(await page.textContent('#dVal'), '1', 'новый пост встаёт на выбранный день');
  assert.match(await page.textContent('#whenSum'), /[Дд]ень 1/);
  await page.fill('#fMd', 'Второй пост дня ' + w);
  await page.click('#fMode button[data-v="timer"]');
  await page.click('.dtq[data-for="t"] .chip[data-m="5"]');
  assert.match(await page.textContent('#whenSum'), /через 5 мин после аудита/);
  if (w === 390) await page.screenshot({ path: OUT + '/panel-when-timer.png' });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, 'нет горизонтального скролла');
  await page.click('#bSave'); await page.waitForTimeout(500);
  const row = await db.first(`SELECT id, kind, mode, delay_min FROM posts WHERE text LIKE ?`, ['Второй пост дня ' + w + '%']);
  assert.deepEqual({ kind: row.kind, mode: row.mode, delay_min: row.delay_min }, { kind: 'drip', mode: 'timer', delay_min: 5 });
  assert.equal((await db.all(`SELECT id FROM posts`)).length, before + 1);
  await page.waitForTimeout(1500); await page.waitForSelector('.card');
  // в дату: пост переезжает в раздел «На дату»
  await page.locator('.card', { hasText: 'Второй пост дня ' + w }).first().locator('.ttl').click(); await page.waitForSelector('.sheet.on'); await page.waitForTimeout(300);
  await page.click('#fMode button[data-v="date"]');
  await page.locator('#pDate .dd').fill('2026-12-05'); await page.locator('#pDate .dtm').selectOption('18:30');
  assert.match(await page.textContent('#whenSum'), /5 дек/);
  if (w === 390) await page.screenshot({ path: OUT + '/panel-when-date.png' });
  await page.click('#bSave'); await page.waitForTimeout(600);
  const r2 = await db.first(`SELECT kind, run_at FROM posts WHERE id = ?`, [row.id]);
  assert.equal(r2.kind, 'date'); assert.equal(r2.run_at, Date.UTC(2026, 11, 5, 18, 30) / 1000 - 10800);
  // и обратно в ленту: после аудита
  await page.waitForTimeout(800); await page.evaluate(() => { const e = [...document.querySelectorAll('body *')].filter((x) => x.children.length < 4 && /^⑤/.test(x.textContent.trim())).pop(); e.click(); }); await page.waitForTimeout(400); await page.locator('.fn', { hasText: 'Второй пост дня ' + w }).first().locator('.ttl').click(); await page.waitForSelector('.sheet.on'); await page.waitForTimeout(300);
  assert.equal(await page.locator('#fMode .on').getAttribute('data-v'), 'date', 'пост на дату открывается с выбранной «датой»');
  await page.click('#fMode button[data-v="timer"]'); await page.fill('#tNum', '2'); await page.selectOption('#tUnit', '60');
  await page.click('#bSave'); await page.waitForTimeout(600);
  const r3 = await db.first(`SELECT kind, mode, delay_min FROM posts WHERE id = ?`, [row.id]);
  assert.deepEqual({ kind: r3.kind, mode: r3.mode, delay_min: r3.delay_min }, { kind: 'drip', mode: 'timer', delay_min: 120 });
  // составное: через 2 дня после аудита в 11:00
  await page.locator('.card', { hasText: 'Второй пост дня ' + w }).first().locator('.ttl').click(); await page.waitForSelector('.sheet.on'); await page.waitForTimeout(300);
  await page.fill('#tNum', '2'); await page.selectOption('#tUnit', '1440'); await page.check('#tAtOn'); await page.fill('#tAt', '11:00');
  assert.match(await page.textContent('#whenSum'), /через 2 дн после аудита, в 11:00/);
  await page.click('#bSave'); await page.waitForTimeout(600);
  const r4 = await db.first(`SELECT mode, delay_min, at_time FROM posts WHERE id = ?`, [row.id]);
  assert.deepEqual({ mode: r4.mode, delay_min: r4.delay_min, at_time: r4.at_time }, { mode: 'timer', delay_min: 2880, at_time: '11:00' });
  assert.deepEqual(errs, []);
  console.log('✓', w, 'px: новый пост на день, таймер после аудита, дата, обратно в ленту');
  await page.close();
}
await b.close(); server.close(); process.exit(0);
