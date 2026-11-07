// «Кому ушёл пост» и «Что пришло человеку» в панели
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { server, initData, db } from './panel-server.mjs';
const require = createRequire('/home/claude/');
const { chromium } = require('playwright');
await new Promise((r) => server.listen(8790, r));
const OUT = process.env.SHOTS || '.';
const b = await chromium.launch();
const INIT = initData();
const stub = `window.Telegram={WebApp:{initData:${JSON.stringify(INIT)},ready(){},expand(){},setHeaderColor(){},setBackgroundColor(){},HapticFeedback:{impactOccurred(){}}}};`;
const now = Math.floor(Date.now() / 1000);
await db.run(`INSERT OR REPLACE INTO users (tg_id, first_name, status, track, consent_ads_at, joined_at, created_at) VALUES (9001, 'Анна', 'active', 'mat', 1, ?, ?)`, [now - 7200, now - 7200]);
const post = await db.first(`SELECT id FROM posts WHERE kind = 'drip' ORDER BY id LIMIT 1`);
await db.run(`INSERT OR REPLACE INTO deliveries (post_id, tg_id, sent_at, ok) VALUES (?, 9001, ?, 1)`, [post.id, now - 3600]);
for (const w of [390, 320]) {
  const page = await b.newPage({ viewport: { width: w, height: 844 }, deviceScaleFactor: 1 });
  const errs = []; page.on('pageerror', (e) => errs.push(e.message));
  await page.route('**/telegram-web-app.js', (r) => r.fulfill({ contentType: 'application/javascript', body: stub }));
  await page.goto('http://localhost:8790/admin'); await page.waitForSelector('.hm');
  await page.click('#tabs button[data-t="path"]'); await page.waitForSelector('.card');
  await page.locator('.card .ttl').first().click(); await page.waitForSelector('#bDeliv'); await page.click('#bDeliv'); await page.waitForSelector('[data-dt]');
  assert.match(await page.textContent('#sheet'), /получили \d/);
  await page.click('[data-dt="wait"]');
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, 'нет горизонтального скролла');
  if (w === 390) await page.screenshot({ path: OUT + '/panel-delivery.png' });
  await page.click('#sheet .sx'); await page.click('#tabs button[data-t="home"]').catch(() => {}); await page.click('#tabs button[data-t="texts"]'); await page.click('#peopleBtn'); await page.waitForSelector('[data-log="9001"]'); await page.click('[data-log="9001"]'); await page.waitForSelector('[data-lt]');
  assert.match(await page.textContent('#sheet'), /Анна/);
  assert.match(await page.textContent('#sheet'), /получил\(а\)/);
  if (w === 390) await page.screenshot({ path: OUT + '/panel-log.png' });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, 'нет горизонтального скролла в журнале');
  assert.deepEqual(errs, []);
  console.log('✓', w, 'px: кому ушёл пост и что пришло человеку');
  await page.close();
}
process.exit(0);
