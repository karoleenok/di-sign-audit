// Проверка ленты на себе (для админа):
//  • предпросмотр — все посты сразу по порядку, с подписью «когда»;
//  • ускоренный тест — по-настоящему, с паузами, но 1 день = 1 минута (идёт через расписание раз в минуту).
import { sendPost, offsetMin, fmtDelay, loadDocs } from './posts.js';
import { btn } from './msgs.js';
import { AUD } from './texts.js';
import { loadFlow, previewStep } from './users.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const fitsLevel = () => true; // деление на начинающих и продолжающих убрано: важен только трек

// Посты ленты по порядку (как их получит человек выбранного уровня)
export async function feedOrder(db, level, { withDrafts = false } = {}) {
  const all = await db.all(`SELECT * FROM posts WHERE kind IN ('drip', 'gift') AND status IN (${withDrafts ? "'active','paused','draft'" : "'active'"})`);
  const byId = Object.fromEntries(all.map((p) => [p.id, p]));
  const gifts = all.filter((p) => p.kind === 'gift' && fitsLevel(p, level)).sort((a, b) => a.id - b.id);
  const drip = all.filter((p) => p.kind === 'drip' && fitsLevel(p, level))
    .map((p) => ({ p, off: offsetMin(p, byId) }))
    .sort((a, b) => a.off - b.off || (a.p.pos || 0) - (b.p.pos || 0) || a.p.id - b.p.id);
  return { gifts, drip, byId };
}

export function whenLabel(p, off, byId) {
  if (p.kind === 'gift') return '🎁 подарок после теста';
  if (p.mode === 'timer') return `⏱ через ${fmtDelay(p.delay_min)} после аудита${p.at_time ? ' в ' + p.at_time : ''}`;
  if (p.mode === 'after') {
    const par = byId && byId[p.after_id];
    return `↳ через ${fmtDelay(p.delay_min)} после «${par ? (par.title || (par.text || '').split('\n')[0]).slice(0, 30) : '#' + p.after_id}»`;
  }
  return Number(p.day) === 0 ? 'день 0 · сразу после входа' : `день ${p.day} · ${p.send_time}`;
}

// как пост называется в панели и где лежит: чтобы в тесте сразу было видно, какой пост продублировался
export const nameOf = (p) => String((p && (p.title || (p.text || '').split('\n')[0])) || '').trim().slice(0, 50) || ('без названия, #' + (p && p.id));
const SEC = { entry: 'Путь → ① Вход', gift: 'Путь → ② Подарок после теста', drip: 'Путь → ③ Лента по дням', fb: 'Путь → ④ После отзыва' };
export function whereOf(p, off, byId) {
  if (p.kind === 'gift') return SEC.gift;
  if (p.kind === 'fb') return SEC.fb;
  const trk = p.track === 'course' ? ' · 🎓 мини-курс' : p.track === 'mat' ? ' · 📚 материалы' : '';
  return SEC.drip + ' → ' + whenLabel(p, off, byId) + trk;
}
const labelOf = (name, where) => `🧪 «${name}»\n📍 ${where}`;

async function sendLabeled(ctx, chatId, p, where, arrow) {
  await ctx.tg.call('sendMessage', { chat_id: chatId, text: labelOf(nameOf(p), where), disable_notification: true });
  await sendPost(ctx.tg, chatId, p, { uid: chatId, publicUrl: ctx.publicUrl, arrow, docs: await loadDocs(ctx) });
}

// Предпросмотр: всё сразу. Ограничение бесплатного Cloudflare — около 50 запросов за раз, поэтому до 14 постов.
export async function runPreview(ctx, adminId, level, pauseMs = 900) {
  const { gifts, drip, byId } = await feedOrder(ctx.db, level);
  const items = [...gifts.map((p) => ({ p, off: -1 })), ...drip];
  const MAX = 14;
  const arrow = await btn(ctx, 'buttonsArrow');
  await ctx.tg.call('sendMessage', { chat_id: adminId, text: `🧪 Предпросмотр ленты — как её получит ученик.\nПостов: ${items.length}${items.length > MAX ? ` (покажу первые ${MAX})` : ''}. Подпись над каждым — когда он придёт.` });
  let n = 0;
  for (const it of items.slice(0, MAX)) {
    const k = ctx.env.DELAY_FACTOR === undefined ? 1 : Number(ctx.env.DELAY_FACTOR);
    if (pauseMs && k > 0) await sleep(pauseMs * k);
    try { await sendLabeled(ctx, adminId, it.p, whereOf(it.p, it.off, byId), arrow); n++; }
    catch (e) { await ctx.tg.call('sendMessage', { chat_id: adminId, text: `⚠️ «${nameOf(it.p)}» не отправился: ${e.message}` }).catch(() => {}); }
  }
  if (!items.length) await ctx.tg.call('sendMessage', { chat_id: adminId, text: 'Включённых постов пока нет — создай в боте: /new' });
  else await ctx.tg.call('sendMessage', { chat_id: adminId, text: `🧪 Конец предпросмотра · показано ${n}` });
  return n;
}


const STEP_TITLE = { hello: 'приветствие', helloTest: 'приветствие', consentPd: 'согласие на данные', consentAds: 'согласие на рассылку', askLevel: 'уровень', askName: 'как обращаться', askContact: 'контакт', fbOffer: 'предложение отзыва', askTrack: 'мини-курс или материалы', testOffer: 'предложение теста', schedCourse: 'расписание (мини-курс)', schedMat: 'расписание (материалы)' };

// Полный путь: вход → подарок (если из аудита) → расписание → лента → бонус за отзыв.
// fromAudit: true — пришёл после аудита (уровень, подарок известны); false — с сайта, не пройдя аудит.
export async function runFullPath(ctx, adminId, level, fromAudit, pauseMs = 900) {
  const lv = level === 'pro' ? 'pro' : 'start';
  const { order, off } = await loadFlow(ctx);
  const { gifts, drip, byId } = await feedOrder(ctx.db, lv);
  const fb = await ctx.db.all(`SELECT * FROM posts WHERE kind = 'fb' AND status = 'active' ORDER BY pos, id`);
  const arrow = await btn(ctx, 'buttonsArrow');
  const k = ctx.env.DELAY_FACTOR === undefined ? 1 : Number(ctx.env.DELAY_FACTOR);
  const tg = (text) => ctx.tg.call('sendMessage', { chat_id: adminId, text, disable_notification: true });
  const wait = async () => { if (pauseMs && k > 0) await sleep(pauseMs * k); };
  const me = { first_name: ctx.userName || 'друг', username: ctx.userUsername || '' };
  let n = 0;
  const run = async (name, where, fn) => {
    await wait();
    try { await tg(labelOf(name, where)); await fn(); n++; }
    catch (e) { await ctx.tg.call('sendMessage', { chat_id: adminId, text: `⚠️ «${name}»: не отправилось — ${e.message}` }).catch(() => {}); }
  };
  await tg(`🧪 Полный путь — ${fromAudit ? 'человек пришёл после аудита' : 'человек пришёл с сайта, не пройдя аудит'}.\nПеред каждым сообщением — название и где оно лежит в панели. Кнопки настоящие, но нажимать не нужно.`);
  await run(STEP_TITLE[fromAudit ? 'helloTest' : 'hello'], SEC.entry, () => previewStep(ctx, adminId, fromAudit ? 'helloTest' : 'hello', me));
  // новый вход из соцсетей: в пути есть пост «только без аудита» (тогда без аудита не спрашиваем трек и отзыв вслепую)
  const postRow = async (key) => (/^post:\d+$/.test(key) ? ctx.db.first(`SELECT * FROM posts WHERE id = ?`, [+key.slice(5)]) : null);
  let social = false;
  for (const key of order) if (!off.includes(key)) { const pr = await postRow(key); if (pr && pr.who === 'new' && pr.status === 'active') social = true; }
  for (const key of order) {
    if (off.includes(key)) continue;
    if (fromAudit && (key === 'askLevel' || key === 'askTrack' || key === 'testOffer')) continue; // эти из аудита уже известны
    if (!fromAudit && social && (key === 'askTrack' || key === 'fbOffer')) continue;
    const pr = await postRow(key);
    if (pr && pr.who === 'new' && fromAudit) continue; // «только без аудита»
    await run(pr ? nameOf(pr) : (STEP_TITLE[key] || key), SEC.entry + (pr ? ' (свой пост)' : ''), () => previewStep(ctx, adminId, key, me));
  }
  if (fromAudit) for (const p of gifts) await run(nameOf(p), SEC.gift, async () => sendPost(ctx.tg, adminId, p, { uid: adminId, publicUrl: ctx.publicUrl, arrow, docs: await loadDocs(ctx) }));
  if (!social || fromAudit) {
    await run(STEP_TITLE.schedCourse + ', если выбрал мини-курс', SEC.entry, () => previewStep(ctx, adminId, 'schedCourse', me));
    await run(STEP_TITLE.schedMat + ', если выбрал материалы', SEC.entry, () => previewStep(ctx, adminId, 'schedMat', me));
  }
  const MAX = 30;
  for (const it of drip.slice(0, MAX)) await run(nameOf(it.p), whereOf(it.p, it.off, byId), async () => sendPost(ctx.tg, adminId, it.p, { uid: adminId, publicUrl: ctx.publicUrl, arrow, docs: await loadDocs(ctx) }));
  if (drip.length > MAX) await tg(`🧪 показала первые ${MAX} из ${drip.length} постов ленты`);
  for (const p of fb) await run(nameOf(p), SEC.fb, async () => sendPost(ctx.tg, adminId, p, { uid: adminId, publicUrl: ctx.publicUrl, arrow, docs: await loadDocs(ctx) }));
  await tg(`🧪 конец полного пути · показано ${n}`);
  return n;
}

// Ускоренный тест: запускаем, а дальше его ведёт расписание (stepRuns)
export async function startFastRun(ctx, adminId, level) {
  await ctx.db.run(`UPDATE test_runs SET status = 'stopped' WHERE admin_id = ? AND status = 'active'`, [adminId]);
  await ctx.db.run(`INSERT INTO test_runs (admin_id, level, started_at, scale, status) VALUES (?, ?, ?, 1440, 'active')`, [adminId, level || 'all', ctx.now]);
  const run = await ctx.db.first(`SELECT * FROM test_runs WHERE admin_id = ? AND status = 'active' ORDER BY id DESC LIMIT 1`, [adminId]);
  const { drip } = await feedOrder(ctx.db, level);
  const last = drip.length ? Math.max(...drip.map((x) => x.off)) : 0;
  await ctx.tg.call('sendMessage', { chat_id: adminId, text: `⏩ Ускоренный тест начался: 1 день = 1 минута.\nЛента придёт тебе в реальном порядке и с паузами, примерно за ${Math.max(1, Math.ceil(last / 1440) + 1)} мин. Остановить — в панели «⏹ Остановить».` });
  return run;
}
export async function stopRuns(ctx, adminId) {
  await ctx.db.run(`UPDATE test_runs SET status = 'stopped' WHERE admin_id = ? AND status = 'active'`, [adminId]);
}

// Шаг ускоренных тестов — вызывается раз в минуту из расписания (и сразу после старта)
export async function stepRuns(ctx, budget = 10) {
  const runs = await ctx.db.all(`SELECT * FROM test_runs WHERE status = 'active' ORDER BY id LIMIT 3`);
  let left = budget;
  for (const run of runs) {
    if (ctx.now - run.started_at > 3 * 3600) { await ctx.db.run(`UPDATE test_runs SET status = 'done' WHERE id = ?`, [run.id]); continue; }
    const vmin = ((ctx.now - run.started_at) * (run.scale || 1440)) / 60; // сколько «минут ленты» прошло
    const { gifts, drip, byId } = await feedOrder(ctx.db, run.level);
    const sent = new Set((await ctx.db.all(`SELECT post_id FROM test_sent WHERE run_id = ?`, [run.id])).map((r) => r.post_id));
    const queue = [...gifts.map((p) => ({ p, off: -1 })), ...drip].filter((x) => !sent.has(x.p.id));
    const due = queue.filter((x) => x.off <= vmin);
    const arrow = due.length ? await btn(ctx, 'buttonsArrow') : '';
    for (const it of due) {
      if (left < 3) break;
      try { await sendLabeled(ctx, run.admin_id, it.p, whereOf(it.p, it.off, byId), arrow); } catch (e) {
        await ctx.tg.call('sendMessage', { chat_id: run.admin_id, text: `⚠️ «${nameOf(it.p)}» не отправился: ${e.message}` }).catch(() => {});
      }
      left -= 3;
      await ctx.db.run(`INSERT OR IGNORE INTO test_sent (run_id, post_id, at) VALUES (?, ?, ?)`, [run.id, it.p.id, ctx.now]);
      sent.add(it.p.id);
    }
    if (queue.every((x) => sent.has(x.p.id))) {
      await ctx.db.run(`UPDATE test_runs SET status = 'done' WHERE id = ?`, [run.id]);
      await ctx.tg.call('sendMessage', { chat_id: run.admin_id, text: '⏩ Ускоренный тест закончен — это вся лента 🐾' }).catch(() => {});
    }
  }
}

export async function activeRun(db, adminId) {
  const r = await db.first(`SELECT * FROM test_runs WHERE admin_id = ? AND status = 'active' ORDER BY id DESC LIMIT 1`, [adminId]);
  if (!r) return null;
  const sent = await db.first(`SELECT COUNT(*) AS n FROM test_sent WHERE run_id = ?`, [r.id]);
  return { id: r.id, level: r.level, started_at: r.started_at, sent: sent.n };
}
