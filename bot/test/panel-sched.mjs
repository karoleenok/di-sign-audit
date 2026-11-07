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
  assert.equal(await page.locator('.sc-entry .sc-step').count(), 0, 'вход свёрнут по умолчанию');
  await page.click('#scEntryT'); await page.waitForSelector('.sc-entry .sc-step');
  assert.ok(await page.locator('.sc-entry .sc-step').count() > 3, 'шаги входа внутри карточки «Вход в бота»');
  if (w === 390) await page.screenshot({ path: OUT + '/sched-entry.png', fullPage: true });
  await page.locator('.sc-entry .sc-step[data-k="askName"]').evaluate((el) => el.click()); await page.waitForSelector('#sheet.on'); await page.evaluate(() => closeSheet && 0).catch(() => {}); await page.mouse.click(10, 10); await page.waitForTimeout(400);
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
  if (w === 390) await page.screenshot({ path: OUT + '/sched-reorder.png' });
  const first = page.locator('[data-scdn]:not([disabled])').first();
  const cardOf = await first.evaluate((el) => +el.closest('.sc-card').dataset.scid);
  const nextId = await first.evaluate((el) => { const all = [...document.querySelectorAll('.sc-card[data-scid]')]; return +all[all.indexOf(el.closest('.sc-card')) + 1].dataset.scid; });
  const T = (id) => db.first(`SELECT mode, day, send_time, delay_min, at_time FROM posts WHERE id = ?`, [id]);
  const Abefore = await T(cardOf), Bbefore = await T(nextId);
  await first.click(); await page.waitForTimeout(700);
  assert.deepEqual(await T(cardOf), Bbefore, 'пост получил время соседа');
  assert.deepEqual(await T(nextId), Abefore, 'сосед получил время поста');
  await page.click('#scRe');
  // порядок доступен и при фильтре по треку
  await page.click('[data-sctrk="mat"]'); assert.equal(await page.locator('#scRe').isDisabled(), false, 'кнопка «Порядок» доступна при фильтре'); await page.click('[data-sctrk="all"]');
  // «Как ученик»
  await page.click('#scStud'); await page.waitForSelector('[data-stnext]'); await page.click('[data-stnext]'); await page.waitForTimeout(200);
  assert.match(await page.textContent('#sheet'), /бот глазами ученика/i);
  assert.ok(await noscroll(page), 'нет горизонтального скролла в «Как ученик»');
  await page.click('#sheet .sx');
  // «Как ученик» показывает и посты на конкретные даты
  const RUN = Math.floor(Date.now() / 1000) + 5 * 86400;
  await db.run(`INSERT INTO posts (kind, audience, track, day, send_time, status, text, created_by, created_at, mode, delay_min, run_at) VALUES ('date', 'all', 'all', 0, '11:00', 'active', ?, 1, ?, 'day', 0, ?)`, [`Анонс эфира в конкретную дату ${w}`, RUN, RUN]);
  await page.reload(); await page.waitForSelector('#scStud'); await page.click('#scStud'); await page.waitForSelector('[data-stnext]');
  for (let i = 0; i < 80 && await page.locator('[data-stnext]').count(); i++) await page.click('[data-stnext]');
  const stTxt = await page.textContent('#sheet');
  assert.match(stTxt, /в конкретную дату/); assert.match(stTxt, new RegExp('Анонс эфира в конкретную дату ' + w));
  assert.ok(await noscroll(page), 'нет горизонтального скролла в «Как ученик» до конца');
  if (w === 390) await page.screenshot({ path: OUT + '/sched-student.png', fullPage: true });
  await page.click('#sheet .sx');
  // перенос в другой день (режим порядка)
  await page.click('#scRe'); await page.waitForSelector('[data-scday]');
  const dayCard = page.locator('[data-scday]').first();
  const did = await dayCard.evaluate((el) => +el.dataset.scday);
  await dayCard.click(); await page.waitForSelector('#dmOk'); await page.click('#dmP'); await page.click('#dmP'); await page.click('#dmOk'); await page.waitForTimeout(700);
  const mv = await db.first(`SELECT mode, day FROM posts WHERE id = ?`, [did]);
  assert.equal(mv.mode, 'day'); assert.ok(mv.day >= 2, 'пост перенесён в другой день');
  await page.click('#scRe');
  // выбор пачкой: выбрать два поста и выключить
  await page.click('#scSel'); await page.waitForSelector('#scBar');
  const cards = page.locator('.sc-card[data-scid]'); const ids2 = [await cards.nth(0).getAttribute('data-scid'), await cards.nth(1).getAttribute('data-scid')];
  await cards.nth(0).click(); await cards.nth(1).click();
  assert.match(await page.textContent('#scBar'), /Выбрано: 2/);
  if (w === 390) await page.screenshot({ path: OUT + '/sched-select.png' });
  assert.ok(await noscroll(page), 'нет горизонтального скролла в режиме выбора');
  await page.click('[data-sb="paused"]'); await page.waitForTimeout(800);
  for (const i of ids2) assert.equal((await db.first(`SELECT status FROM posts WHERE id = ?`, [+i])).status, 'paused', 'выбранные посты выключены');
  assert.equal(await page.locator('#scBar').count(), 0, 'панель выбора закрыта');
  // ответы на кнопки раскрываются
  if (await page.locator('#scNodes').count()) { await page.click('#scNodes'); await page.waitForSelector('#scMap'); }
  // дубли: два почти одинаковых включённых поста
  const T0 = Math.floor(Date.now() / 1000), txt = 'Уникальный текст про шрифты и сетку номер ' + w + ' для проверки дублей в расписании';
  for (const extra of ['', ' ещё']) await db.run(`INSERT INTO posts (kind, audience, track, day, send_time, status, text, created_by, created_at, mode, delay_min) VALUES ('drip', 'all', 'all', 3, '11:00', 'active', ?, 1, ?, 'day', 0)`, [txt + extra, T0]);
  await page.reload(); await page.waitForSelector('#scDup');
  assert.match(await page.textContent('#scDup'), /Дубли/);
  assert.ok(await page.locator('.sc-tg', { hasText: 'Похож на другой' }).count() >= 2, 'на карточках метка «Похож на другой»');
  await page.click('#scDup'); await page.waitForSelector('[data-dpoff]');
  assert.match(await page.textContent('#sheet'), /Слова только/);
  assert.ok(await noscroll(page), 'нет горизонтального скролла в «Дублях»');
  if (w === 390) await page.screenshot({ path: OUT + '/sched-dups.png' });
  const dpId = +(await page.locator('[data-dpoff]').first().getAttribute('data-dpoff'));
  await page.locator('[data-dpoff]').first().click(); await page.waitForTimeout(900);
  assert.equal((await db.first(`SELECT status FROM posts WHERE id = ?`, [dpId])).status, 'paused', 'лишний пост выключен');
  await page.mouse.click(10, 10); await page.waitForTimeout(300);
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
