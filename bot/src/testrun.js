// Проверка ленты на себе (для админа):
//  • предпросмотр — все посты сразу по порядку, с подписью «когда»;
//  • ускоренный тест — по-настоящему, с паузами, но 1 день = 1 минута (идёт через расписание раз в минуту).
import { sendPost, offsetMin, fmtDelay, loadDocs } from './posts.js';
import { btn } from './msgs.js';
import { AUD } from './texts.js';
import { loadFlow, previewStep } from './users.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const fitsLevel = (p, level) => !level || level === 'all' || p.audience === 'all' || p.audience === level;

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
  if (p.mode === 'timer') return `⏱ через ${fmtDelay(p.delay_min)} после входа`;
  if (p.mode === 'after') {
    const par = byId && byId[p.after_id];
    return `↳ через ${fmtDelay(p.delay_min)} после «${par ? (par.title || (par.text || '').split('\n')[0]).slice(0, 30) : '#' + p.after_id}»`;
  }
  return Number(p.day) === 0 ? 'день 0 · сразу после входа' : `день ${p.day} · ${p.send_time}`;
}

async function sendLabeled(ctx, chatId, p, label, arrow) {
  await ctx.tg.call('sendMessage', { chat_id: chatId, text: '🧪 ' + label + (p.title ? ` · «${p.title}»` : ''), disable_notification: true });
  await sendPost(ctx.tg, chatId, p, { uid: chatId, publicUrl: ctx.publicUrl, arrow, docs: await loadDocs(ctx) });
}

// Предпросмотр: всё сразу. Ограничение бесплатного Cloudflare — около 50 запросов за раз, поэтому до 14 постов.
export async function runPreview(ctx, adminId, level, pauseMs = 900) {
  const { gifts, drip, byId } = await feedOrder(ctx.db, level);
  const items = [...gifts.map((p) => ({ p, off: -1 })), ...drip];
  const MAX = 14;
  const arrow = await btn(ctx, 'buttonsArrow');
  await ctx.tg.call('sendMessage', { chat_id: adminId, text: `🧪 Предпросмотр ленты — как её получит ${level && level !== 'all' ? AUD[level].replace(/им$/, 'ий') : 'любой ученик'}.\nПостов: ${items.length}${items.length > MAX ? ` (покажу первые ${MAX})` : ''}. Подпись над каждым — когда он придёт.` });
  let n = 0;
  for (const it of items.slice(0, MAX)) {
    const k = ctx.env.DELAY_FACTOR === undefined ? 1 : Number(ctx.env.DELAY_FACTOR);
    if (pauseMs && k > 0) await sleep(pauseMs * k);
    try { await sendLabeled(ctx, adminId, it.p, whenLabel(it.p, it.off, byId), arrow); n++; }
    catch (e) { await ctx.tg.call('sendMessage', { chat_id: adminId, text: `⚠️ Пост #${it.p.id} не отправился: ${e.message}` }).catch(() => {}); }
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
  let n = 0, step = 0;
  const run = async (label, fn) => {
    await wait();
    try { await tg('🧪 ' + label); await fn(); n++; }
    catch (e) { await ctx.tg.call('sendMessage', { chat_id: adminId, text: `⚠️ ${label}: не отправилось — ${e.message}` }).catch(() => {}); }
  };
  await tg(`🧪 Полный путь — ${fromAudit ? 'человек пришёл после аудита' : 'человек пришёл с сайта, не пройдя аудит'}, уровень: ${lv === 'pro' ? 'продолжающий' : 'начинающий'}.\nКнопки в этих сообщениях настоящие, но это только показ: нажимать не нужно. Подпись над каждым — что это и когда придёт.`);
  await run(`шаг ${++step} · ${STEP_TITLE[fromAudit ? 'helloTest' : 'hello']}`, () => previewStep(ctx, adminId, fromAudit ? 'helloTest' : 'hello', me));
  for (const key of order) {
    if (off.includes(key)) continue;
    if (fromAudit && (key === 'askLevel' || key === 'askTrack' || key === 'testOffer')) continue; // эти из аудита уже известны
    await run(`шаг ${++step} · ${STEP_TITLE[key] || 'свой пост'}`, () => previewStep(ctx, adminId, key, me));
  }
  if (fromAudit) for (const p of gifts) await run(`шаг ${++step} · 🎁 подарок после теста · «${p.title || 'без названия'}»`, async () => sendPost(ctx.tg, adminId, p, { uid: adminId, publicUrl: ctx.publicUrl, arrow, docs: await loadDocs(ctx) }));
  await run(`шаг ${++step} · ${STEP_TITLE.schedCourse} (если выбрал мини-курс)`, () => previewStep(ctx, adminId, 'schedCourse', me));
  await run(`шаг ${++step} · ${STEP_TITLE.schedMat} (если выбрал материалы)`, () => previewStep(ctx, adminId, 'schedMat', me));
  await tg('🧪 дальше — лента: посты приходят по расписанию');
  const MAX = 30;
  for (const it of drip.slice(0, MAX)) await run(whenLabel(it.p, it.off, byId) + (it.p.title ? ` · «${it.p.title}»` : ''), async () => sendPost(ctx.tg, adminId, it.p, { uid: adminId, publicUrl: ctx.publicUrl, arrow, docs: await loadDocs(ctx) }));
  if (drip.length > MAX) await tg(`🧪 показала первые ${MAX} из ${drip.length} постов ленты`);
  if (fb.length) {
    await tg('🧪 бонус за отзыв — приходит, когда человек оставил отзыв о кабинете');
    for (const p of fb) await run(`💬 бонус за отзыв · «${p.title || 'без названия'}»`, async () => sendPost(ctx.tg, adminId, p, { uid: adminId, publicUrl: ctx.publicUrl, arrow, docs: await loadDocs(ctx) }));
  }
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
      try { await sendLabeled(ctx, run.admin_id, it.p, whenLabel(it.p, it.off, byId), arrow); } catch (e) {
        await ctx.tg.call('sendMessage', { chat_id: run.admin_id, text: `⚠️ Пост #${it.p.id} не отправился: ${e.message}` }).catch(() => {});
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
