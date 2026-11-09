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
  // ряд кнопок компактный: «Проверить», «Как ученик», «Выбрать», «Порядок» прячутся под «Ещё»
  assert.equal(await page.locator('#scRe').count(), 0, 'редкие кнопки свёрнуты');
  await page.click('#scMore'); await page.waitForSelector('#scRe');
  // вкладки новые
  const tabs = await page.locator('#tabs button').allTextContents();
  assert.deepEqual(tabs.map((t) => t.replace(/ · \d+/, '')), ['Главная', 'Расписание', 'Люди', 'Игра', 'Ещё']);
  assert.match(await page.textContent('.sc-tl'), /Человек нажал «Старт»/);
  assert.match(await page.textContent('.sc-tl'), /Прошёл аудит и выбрал/);
  // памятка расписания: даты, дни, есть ли пост
  assert.equal(await page.locator('.pl-r').count(), 11, 'мини-курс: 11 уроков в памятке');
  assert.match(await page.textContent('.pl'), /день 18/);
  assert.ok(await noscroll(page), 'нет горизонтального скролла с памяткой');
  // в самой ленте у дней мини-курса есть дата и часть программы, а дни без поста помечены
  await page.click('[data-sctrk="course"]'); await page.waitForSelector('.sc-day');
  const tl = await page.textContent('.sc-tl');
  assert.match(tl, /пт, 6 ноя/, 'у дня ленты видна дата');
  assert.match(tl, /Часть 2 · уверенно сразу к делу/, 'у дня видна часть программы');
  assert.ok(await page.locator('[data-plday][data-pltr="course"]').count() > 0, 'урок без поста показан в ленте');
  assert.match(tl, /Поста на этот день нет/);
  assert.ok(await noscroll(page), 'нет горизонтального скролла с датами в днях');
  await page.click('[data-sctrk="all"]');
  if (w === 390) await page.screenshot({ path: OUT + '/sched-plan.png' });
  await page.click('[data-plt="mat"]'); await page.waitForSelector('.pl-r');
  assert.equal(await page.locator('.pl-r').count(), 9, 'материалы: 9 уроков');
  assert.ok(await noscroll(page), 'нет горизонтального скролла с памяткой материалов');
  await page.locator('.pl-r').first().click(); await page.waitForSelector('#psX'); await page.click('#psX'); await page.waitForTimeout(400);
  await page.click('[data-plt="course"]');
  // строка памятки без поста: «Написать новый» открывает пост с днём, треком и названием
  await page.locator('.pl-r').first().click(); await page.waitForSelector('#psNew');
  assert.ok(await noscroll(page), 'нет горизонтального скролла в окне урока');
  await page.waitForTimeout(500); if (w === 390) await page.screenshot({ path: OUT + '/sched-plan-add.png' });
  await page.click('#psNew'); await page.waitForSelector('#fTitle');
  assert.match(await page.inputValue('#fTitle'), /Карточки-разбор/);
  assert.equal(await page.textContent('#dVal'), '0');
  assert.equal(await page.locator('#fTrack .on').getAttribute('data-v'), 'course');
  assert.match(await page.textContent('#whenSum'), /^Итог: День 0/);
  await page.click('#sheet .sx'); await page.waitForTimeout(300);
  // «Взять готовый»: пост переезжает на день урока и получает трек
  await db.run(`INSERT INTO posts (kind, audience, track, day, send_time, status, text, created_by, created_at, mode, delay_min) VALUES ('drip', 'all', 'all', 30, '12:00', 'active', ?, 1, ?, 'day', 0)`, ['Перенос из памятки ' + w, Math.floor(Date.now() / 1000)]);
  await page.reload(); await page.waitForSelector('.pl-r');
  const ix = w === 390 ? 1 : 2;
  await page.locator('.pl-r').nth(ix).click(); await page.waitForSelector('#psPick'); await page.click('#psPick');
  await page.waitForSelector('#pkList .kind'); await page.fill('#pkQ', 'Перенос из памятки ' + w); await page.waitForTimeout(200);
  await page.click('#pkList .kind'); await page.waitForTimeout(900);
  const moved = await db.first(`SELECT track, day, kind, mode, status FROM posts WHERE text = ?`, ['Перенос из памятки ' + w]);
  assert.deepEqual([moved.track, moved.day, moved.kind, moved.mode, moved.status], ['course', ix, 'drip', 'day', 'paused'], 'пост перенесён на день урока, трек выставлен, пауза');
  await page.locator('.pl-r').nth(ix).click(); await page.waitForSelector('[data-psw]');
  await page.click('[data-psw]'); await page.waitForTimeout(900); await page.waitForSelector('[data-psw]');
  assert.equal((await db.first(`SELECT status FROM posts WHERE text = ?`, ['Перенос из памятки ' + w])).status, 'active', 'кнопка «Включить» в окне урока');
  // несколько постов на один день: список в окне урока, «ещё один» с часом позже
  assert.match(await page.textContent('#sheet'), /Постов на этот день: 1/);
  assert.match(await page.textContent('#psNew'), /Написать ещё один/);
  assert.ok(await noscroll(page), 'нет горизонтального скролла в окне со списком постов');
  await page.click('#psNew'); await page.waitForSelector('#fTitle');
  assert.equal(await page.inputValue('#fTitle'), '', 'у второго поста название пустое');
  assert.equal(await page.textContent('#dVal'), String(ix));
  const t2 = await page.inputValue('#fTime'); assert.ok(t2 > '11:00', 'второй пост на час позже, а не в ту же минуту: ' + t2);
  await page.click('#sheet .sx'); await page.waitForTimeout(300);
  await db.run(`INSERT INTO posts (kind, audience, track, day, send_time, status, text, created_by, created_at, mode, delay_min) VALUES ('drip', 'all', 'course', ?, '12:00', 'paused', ?, 1, ?, 'day', 0)`, [ix, 'Второй пост урока ' + w, Math.floor(Date.now() / 1000)]);
  await page.reload(); await page.waitForSelector('.pl-r');
  assert.match(await page.locator('.pl-r').nth(ix).textContent(), /1 из 2/, 'в строке видно: включён один из двух');
  // порядок и паузы прямо в окне дня
  await page.locator('.pl-r').nth(ix).click(); await page.waitForSelector('.ps');
  assert.equal(await page.locator('.ps').count(), 2, 'оба поста дня в списке');
  assert.ok(await noscroll(page), 'нет горизонтального скролла со списком и паузами');
  if (w === 390) { await page.waitForTimeout(400); await page.screenshot({ path: OUT + '/sched-slot.png' }); }
  const two = async () => db.all(`SELECT id, send_time, pos FROM posts WHERE track = 'course' AND day = ? AND kind = 'drip' AND status != 'archived' ORDER BY send_time, pos`, [ix]);
  const before2 = await two();
  await page.selectOption('[data-psg="1"]', '30'); await page.waitForTimeout(900); await page.waitForSelector('.ps');
  const mid2 = await two();
  assert.deepEqual(mid2.map((r) => r.send_time), ['11:00', '11:30'], 'пауза 30 минут: второй в 11:30');
  assert.deepEqual(mid2.map((r) => r.id), before2.map((r) => r.id), 'порядок остался');
  await page.click('[data-psd="0"]'); await page.waitForTimeout(900); await page.waitForSelector('.ps');
  const after2 = await two();
  assert.deepEqual(after2.map((r) => r.id), [mid2[1].id, mid2[0].id], 'посты поменялись местами');
  assert.deepEqual(after2.map((r) => r.send_time), ['11:00', '11:30'], 'время осталось на местах, поменялись посты');
  await page.fill('#psTime', '09:00'); await page.locator('#psTime').dispatchEvent('change'); await page.waitForTimeout(900); await page.waitForSelector('.ps');
  assert.deepEqual((await two()).map((r) => r.send_time), ['09:00', '09:30'], 'время первого сдвигает и второй');
  // «Убрать из дня»: пост уходит в «Новые из бота» и выключается
  const gone = (await two())[1].id;
  await page.click('[data-psr="' + gone + '"]'); await page.waitForTimeout(900); await page.waitForSelector('.ps');
  assert.equal(await page.locator('.ps').count(), 1, 'пост убран из списка дня');
  const gp = await db.first(`SELECT status, inbox FROM posts WHERE id = ?`, [gone]);
  assert.deepEqual([gp.status, gp.inbox], ['paused', 1], 'пост выключен и лежит среди новых из бота');
  await page.click('#sheet .sx'); await page.waitForTimeout(300);
  // день 0: пауза хранится как «через N минут после входа»
  await db.run(`DELETE FROM posts WHERE text LIKE 'День ноль %'`);
  for (const k of [0, 1]) await db.run(`INSERT INTO posts (kind, audience, track, day, send_time, status, text, created_by, created_at, mode, delay_min, pos) VALUES ('drip', 'all', 'mat', 0, '00:00', 'paused', ?, 1, ?, 'day', 0, ?)`, ['День ноль ' + k + ' ' + w, Math.floor(Date.now() / 1000), k]);
  await page.click('[data-plt="mat"]'); await page.reload(); await page.waitForSelector('.pl-r');
  if (!(await page.locator('[data-plt="mat"].on').count())) await page.click('[data-plt="mat"]');
  await page.locator('.pl-r').first().click(); await page.waitForSelector('.ps');
  assert.equal(await page.locator('.ps').count(), 2, 'день 0: два поста');
  await page.selectOption('[data-psg="1"]', '30'); await page.waitForTimeout(900);
  const d0 = await db.all(`SELECT mode, day, delay_min FROM posts WHERE track = 'mat' AND day = 0 AND text LIKE ? ORDER BY delay_min`, ['День ноль % ' + w]);
  assert.deepEqual(d0.map((r) => [r.mode, r.day, r.delay_min]), [['day', 0, 0], ['day', 0, 30]], 'день 0: второй через 30 минут после входа');
  await page.click('#sheet .sx'); await page.waitForTimeout(300);
  await page.click('[data-plt="course"]');
  await page.click('#plT'); assert.equal(await page.locator('.pl-r').count(), 0, 'памятка сворачивается'); await page.click('#plT'); await page.waitForSelector('.pl-r');
  assert.equal(await page.locator('.sc-entry .sc-step').count(), 0, 'вход свёрнут по умолчанию');
  await page.click('#scEntryT'); await page.waitForSelector('.sc-entry .sc-step');
  assert.ok(await page.locator('.sc-entry .sc-step').count() > 3, 'шаги входа внутри карточки «Вход в бота»');
  // библиотека всех постов: поиск, фильтры, открыть пост
  await page.click('#scLib'); await page.waitForSelector('#libL .lib');
  assert.ok((await page.locator('#libL .lib').count()) >= 3, 'в библиотеке есть посты');
  if (!(await noscroll(page))) console.log('OVERLIB', w, await page.evaluate(() => [document.documentElement.scrollWidth, [...document.querySelectorAll('body *')].filter((e) => e.scrollWidth > e.clientWidth + 1 && e.clientWidth > 0).slice(0, 8).map((e) => e.tagName + '.' + e.className + ' sw' + e.scrollWidth + ' cw' + e.clientWidth)]));
  assert.ok(await noscroll(page), 'нет горизонтального скролла в библиотеке');
  if (w === 390) { await page.screenshot({ path: OUT + '/sched-lib.png', fullPage: true }); }
  const allN = await page.locator('#libL .lib').count();
  await page.fill('#libQ', 'Перенос из памятки'); await page.waitForTimeout(200);
  assert.ok((await page.locator('#libL .lib').count()) < allN, 'поиск сужает список');
  await page.fill('#libQ', ''); await page.click('[data-lf="free"]'); await page.waitForTimeout(200);
  assert.ok(await noscroll(page));
  await page.click('[data-lf="all"]'); await page.waitForTimeout(200);
  await page.locator('#libL .lib').first().click(); await page.waitForSelector('#pvEdit'); await page.click('#pvEdit'); await page.waitForSelector('#fTitle');
  await page.click('#sheet .sx'); await page.waitForTimeout(300);
  await page.click('#backMore'); await page.waitForSelector('.sc-tl');
  // свой пост-шаг, выключенный во входе: есть метка и переключатель, и он включает шаг
  {
    let np = await db.first(`SELECT id FROM posts WHERE kind = 'node' AND status = 'active' LIMIT 1`);
    if (!np) { await db.run(`INSERT INTO posts (kind, audience, track, day, send_time, status, text, created_by, created_at, mode, delay_min) VALUES ('node', 'all', 'all', 0, '11:00', 'active', 'Welcome to Di Sign University', 1, ?, 'day', 0)`, [Math.floor(Date.now() / 1000)]); np = await db.first(`SELECT id FROM posts WHERE kind = 'node' AND status = 'active' ORDER BY id DESC LIMIT 1`); }
    if (np) {
      const k = 'post:' + np.id, put = (key, v) => db.run(`INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`, [key, JSON.stringify(v)]);
      const cur = await db.first(`SELECT value FROM settings WHERE key = 'flow:order'`);
      const ord = (cur ? JSON.parse(cur.value) : ['consentPd', 'consentAds', 'askName', 'askContact', 'fbOffer', 'askTrack', 'testOffer']).filter((x) => x !== k);
      ord.splice(2, 0, k); await put('flow:order', ord); await put('flow:off', [k]);
      await page.reload(); await page.waitForSelector('.sc-tl'); await page.waitForSelector('.sc-entry .sc-step');
      const row = page.locator('.sc-entry .sc-step[data-k="' + k + '"]');
      assert.match(await row.textContent(), /Выключен/, 'метка: пост выключен в самом входе');
      if (!(await noscroll(page))) console.log('OVER2', w, await page.evaluate(() => [document.documentElement.scrollWidth, [...document.querySelectorAll('body *')].filter((e) => e.getBoundingClientRect().right > innerWidth + 1).slice(0, 6).map((e) => e.tagName + '.' + e.className + ':' + e.textContent.slice(0, 18))]));
      assert.ok(await noscroll(page), 'нет горизонтального скролла со строкой выключенного поста');
      // нажатие на пост во входе: предпросмотр, правка и дубль для другого трека
      await row.click(); await page.waitForSelector('#pvEdit');
      assert.match(await page.textContent('#sheet'), /так увидит ученик/);
      assert.match(await page.textContent('#sheet'), /Welcome to Di Sign University/);
      assert.ok(await noscroll(page), 'нет горизонтального скролла в предпросмотре поста');
      await page.click('#pvEdit'); await page.waitForSelector('#fTitle'); await page.click('#sheet .sx'); await page.waitForTimeout(300);
      await row.click(); await page.waitForSelector('#pvDup'); await page.click('#pvDup'); await page.waitForSelector('[data-dt="mat"]');
      await page.click('[data-dt="mat"]'); await page.waitForSelector('#fTitle'); await page.waitForTimeout(300);
      const cp = await db.first(`SELECT id, track, status, kind, title FROM posts WHERE title LIKE '%(копия)' ORDER BY id DESC LIMIT 1`);
      assert.deepEqual([cp.track, cp.status, cp.kind], ['mat', 'draft', 'node'], 'копия: другой трек, черновик');
      assert.match(cp.title, /Welcome to Di Sign University \(копия\)/);
      await db.run(`DELETE FROM posts WHERE id = ?`, [cp.id]);
      await page.click('#sheet .sx'); await page.waitForTimeout(300); await page.reload(); await page.waitForSelector('.sc-tl'); await page.waitForSelector('.sc-entry .sc-step');
      await row.locator('[data-scoff]').click(); await page.waitForTimeout(700);
      const off = JSON.parse((await db.first(`SELECT value FROM settings WHERE key = 'flow:off'`)).value);
      assert.ok(!off.includes(k), 'переключатель включил шаг входа');
      await put('flow:order', ord.filter((x) => x !== k)); await put('flow:off', []);
      await page.reload(); await page.waitForSelector('.sc-tl'); await page.waitForSelector('.sc-entry .sc-step');
    }
  }
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
  // «Пройти путь»: одна кнопка, сообщения приходят сами; тап по сообщению: порядок меняется и в расписании
  await page.click('#scStud'); await page.waitForSelector('#stPlay');
  await page.click('#sheet [data-rsrc="audit"]'); await page.click('#sheet [data-ftrk="mat"]');
  await page.click('#stPlay'); await page.waitForTimeout(1800);
  const plEarly = await page.locator('#stBox .m').count();
  assert.ok(plEarly >= 1 && plEarly <= 4, 'сообщения приходят по одному, сами: ' + plEarly);
  await page.click('#stFull');
  const plFull = await page.locator('#stBox .m').count();
  assert.ok(plFull > plEarly, '«Показать всё сразу» показывает весь путь');
  const plBefore = await page.locator("#stBox .m").allTextContents();
  let plMoved = false;
  for (const el of await page.locator('#stBox [data-stsel]').all()) {
    await el.locator('.m').click({ position: { x: 8, y: 8 } });
    if (await page.locator('#stBox [data-sta^="mv:"]:not([disabled])').count()) { plMoved = true; break; }
  }
  assert.ok(plMoved, 'у поста ленты по тапу есть стрелки порядка');
  assert.ok(await page.locator('#stBox [data-sta^="op:"]').count(), 'у поста есть «Открыть пост»');
  await page.locator('#stBox [data-sta^="mv:"]:not([disabled])').first().click(); await page.waitForTimeout(700);
  const plAfter = await page.locator("#stBox .m").allTextContents();
  assert.notDeepEqual(plAfter, plBefore, 'порядок сообщений в плеере поменялся');
  assert.deepEqual([...plAfter].sort(), [...plBefore].sort(), 'те же сообщения, другой порядок');
  assert.ok(await noscroll(page), 'нет горизонтального скролла в «Пройти путь»');
  await page.click('#sheet .sx');
  // «Как ученик» показывает и посты на конкретные даты
  const RUN = Math.floor(Date.now() / 1000) + 5 * 86400;
  await db.run(`INSERT INTO posts (kind, audience, track, day, send_time, status, text, created_by, created_at, mode, delay_min, run_at) VALUES ('date', 'all', 'all', 0, '11:00', 'active', ?, 1, ?, 'day', 0, ?)`, [`Анонс эфира в конкретную дату ${w}`, RUN, RUN]);
  await page.reload(); await page.waitForSelector('#scStud'); await page.click('#scStud'); await page.waitForSelector('[data-stnext]');
  // из соцсетей: трека нет, выбора мини-курс/материалы нет; после аудита выбор появляется
  assert.equal(await page.locator('#sheet [data-ftrk]').count(), 0, 'из соцсетей нет выбора трека');
  assert.match(await page.textContent('#sheet'), /аудит ещё не проходил/);
  await page.click('#sheet [data-rsrc="audit"]'); await page.waitForSelector('#sheet [data-ftrk]');
  assert.match(await page.textContent('#sheet'), /прошёл аудит и вернулся/);
  await page.click('#sheet [data-rsrc="site"]'); await page.waitForTimeout(200);
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
  // окно шаблона: выбранный свой пост читается целиком, есть «Открыть» и «Дублировать»
  const pid = (await db.first(`SELECT id FROM posts WHERE text IS NOT NULL AND text <> '' LIMIT 1`)).id;
  await page.click('#tabs button[data-t="more"]'); await page.waitForSelector('[data-mr]');
  await page.locator('[data-mr]', { hasText: 'Тексты бота' }).click(); await page.waitForSelector('.msg');
  await page.locator('.msg', { hasText: 'Приветствие' }).first().click();
  await page.waitForSelector('#mPost', { timeout: 4000 });
  {
    await page.selectOption('#mPost', String(pid)); await page.waitForSelector('#mpOpen');
    assert.ok(await page.locator('#postBox .phone').count(), 'в окне шаблона виден пост целиком');
    assert.ok(await page.locator('#mpDup').count(), 'есть «Дублировать»');
    assert.ok(await noscroll(page), 'нет горизонтального скролла в окне шаблона');
    if (w === 390) await page.screenshot({ path: OUT + '/msg-post.png' });
    await page.evaluate(() => { const b = document.querySelector('#sheet .sx, #sheet [id$="X"], #sheet .back'); if (b) b.click(); else document.getElementById('sheet').classList.remove('open'); });
  }
  await page.reload(); await page.waitForSelector('#tabs button[data-t="more"]');
  // Ещё и запасной старый вид
  await page.click('#tabs button[data-t="more"]'); await page.waitForSelector('[data-mr]');
  assert.ok(await page.locator('[data-mr]').count() >= 10, 'в «Ещё» все редкие разделы');
  assert.ok(await noscroll(page));
  if (w === 390) await page.screenshot({ path: OUT + '/sched-more.png', fullPage: true });
  // старт потока: сохраняется в настройки и меняет подпись
  await page.locator('[data-mr]', { hasText: 'Старт потока' }).click(); await page.waitForSelector('#chC');
  assert.ok(await noscroll(page), 'нет горизонтального скролла в окне «Старт потока»');
  await page.fill('#chC', '2026-11-06'); await page.fill('#chM', '2026-11-07'); await page.click('#chOk'); await page.waitForTimeout(700);
  assert.equal(JSON.parse((await db.first(`SELECT value FROM settings WHERE key = 'cohort:course'`)).value), '2026-11-06');
  assert.match(await page.locator('[data-mr]', { hasText: 'Старт потока' }).textContent(), /2026-11-07/);
  await db.run(`DELETE FROM settings WHERE key LIKE 'cohort:%'`);
  await page.locator('[data-mr]', { hasText: 'Старый вид панели' }).click(); await page.waitForSelector('#goNew');
  assert.match(await page.textContent('#tabs'), /Путь/);
  await page.click('#goNew'); await page.waitForSelector('.sc-tl');
  assert.deepEqual(errs, []);
  console.log('✓', w, 'px: шкала, переключатель, порядок, «＋ Пост», «Ещё», запасной старый вид');
  await page.close();
}
process.exit(0);
