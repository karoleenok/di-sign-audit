// Новая вкладка «Расписание»: шкала, переключатели, порядок, «＋ Пост», «Ещё», запасной старый вид
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { server, initData, db } from './panel-server.mjs';
const require = createRequire('/home/claude/');
const { chromium } = require('playwright');
await new Promise((r) => server.listen(8791, r));
const OUT = process.env.SHOTS || '.';
const b = await chromium.launch();
const INIT = initData();
const stub = `window.Telegram={WebApp:{initData:${JSON.stringify(INIT)},ready(){},expand(){},setHeaderColor(){},setBackgroundColor(){},HapticFeedback:{impactOccurred(){}}}};`;
const noscroll = (page) => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth);
for (const w of [390, 320]) {
  const page = await b.newPage({ viewport: { width: w, height: 844 }, deviceScaleFactor: 1 });
  const errs = []; page.on('pageerror', (e) => errs.push(e.message));
  await page.route('**/telegram-web-app.js', (r) => r.fulfill({ contentType: 'application/javascript', body: stub }));
  await page.goto('http://localhost:8791/admin');
  await page.waitForSelector('.sc-tl');
  // вкладки новые
  const tabs = await page.locator('#tabs button').allTextContents();
  assert.deepEqual(tabs.map((t) => t.replace(/ · \d+/, '')), ['Главная', 'Расписание', 'Люди', 'Игра', 'Ещё']);
  assert.match(await page.textContent('.sc-tl'), /Человек нажал «Старт»/);
  assert.match(await page.textContent('.sc-tl'), /Прошёл аудит и выбрал/);
  assert.equal(await page.locator('.sc-entry .stp').count(), 0, 'вход свёрнут по умолчанию');
  await page.click('#scEntryT'); await page.waitForSelector('.sc-entry .stp');
  assert.ok(await page.locator('.sc-entry .stp').count() > 3, 'шаги входа внутри карточки «Вход в бота»');
  await page.locator('.sc-entry .stp[data-k="askName"]').evaluate((el) => el.click()); await page.waitForSelector('#sheet.on'); await page.evaluate(() => closeSheet && 0).catch(() => {}); await page.mouse.click(10, 10); await page.waitForTimeout(400);
  await page.click('#scEntryT');
  assert.ok(await page.locator('.sc-card').count() >= 2, 'посты на шкале');
  if (!(await noscroll(page))) console.log('OVER', w, await page.evaluate(() => [document.documentElement.scrollWidth, [...document.querySelectorAll('body *')].filter((e) => e.getBoundingClientRect().right > innerWidth + 1).slice(0, 6).map((e) => e.tagName + '.' + e.className + ':' + e.textContent.slice(0, 18))]));
  assert.ok(await noscroll(page), 'нет горизонтального скролла на шкале');
  if (w === 390) await page.screenshot({ path: OUT + '/sched-main.png', fullPage: true });
  // переключатель включает и выключает
  const card = page.locator('.sc-card[data-scid]').first();
  const id = +(await card.getAttribute('data-scid'));
  const before = (await db.first(`SELECT status FROM posts WHERE id = ?`, [id])).status;
  await card.locator('[data-scsw]').click(); await page.waitForTimeout(700);
  const after = (await db.first(`SELECT status FROM posts WHERE id = ?`, [id])).status;
  assert.notEqual(after, before, 'переключатель меняет статус поста');
  // порядок: два соседних поста ленты меняются местами, время остаётся
  const drip = await db.all(`SELECT id, mode, day, send_time, delay_min FROM posts WHERE kind = 'drip' AND status != 'archived' ORDER BY day, send_time, id`);
  await page.click('#scRe'); await page.waitForSelector('[data-scdn]');
  assert.ok(await noscroll(page), 'нет горизонтального скролла в режиме порядка');
  const first = page.locator('[data-scdn]:not([disabled])').first();
  const cardOf = await first.evaluate((el) => +el.closest('.sc-card').dataset.scid);
  const A = await db.first(`SELECT id, mode, day, send_time, delay_min FROM posts WHERE id = ?`, [cardOf]);
  await first.click(); await page.waitForTimeout(700);
  const A2 = await db.first(`SELECT id, mode, day, send_time, delay_min FROM posts WHERE id = ?`, [cardOf]);
  assert.notDeepEqual(A2, A, 'после стрелки у поста другое время (посты поменялись местами)');
  await page.click('#scRe');
  // + Пост
  await page.click('#scAdd'); await page.waitForSelector('#acNew');
  assert.match(await page.textContent('#sheet'), /Написать здесь/); assert.match(await page.textContent('#sheet'), /Взять готовый/);
  assert.ok(await noscroll(page));
  if (w === 390) await page.screenshot({ path: OUT + '/sched-add.png' });
  await page.click('#acPick'); await page.waitForSelector('[data-pk]'); await page.click('#sheet .sx');
  // проверить
  await page.click('#scCheck'); await page.waitForSelector('#runPrev'); await page.click('#sheet .sx');
  // нажали на пост: открывается редактор с «Кому ушёл» и «Заменить»
  await page.locator('.sc-card[data-scid]').first().click(); await page.waitForSelector('#bDeliv');
  assert.ok(await page.locator('#bRepl').count(), 'есть «Заменить другим постом»');
  await page.click('#bRepl'); await page.waitForSelector('[data-rp]'); await page.click('#sheet .sx');
  // Ещё и запасной старый вид
  await page.click('#tabs button[data-t="more"]'); await page.waitForSelector('[data-mr]');
  assert.ok(await page.locator('[data-mr]').count() >= 10, 'в «Ещё» все редкие разделы');
  assert.ok(await noscroll(page));
  if (w === 390) await page.screenshot({ path: OUT + '/sched-more.png', fullPage: true });
  await page.locator('[data-mr]', { hasText: 'Старый вид панели' }).click(); await page.waitForSelector('#goNew');
  assert.match(await page.textContent('#tabs'), /Путь/);
  await page.click('#goNew'); await page.waitForSelector('.sc-tl');
  assert.deepEqual(errs, []);
  console.log('✓', w, 'px: шкала, переключатель, порядок, «＋ Пост», «Ещё», запасной старый вид');
  await page.close();
}
process.exit(0);
