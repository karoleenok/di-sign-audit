// Общее ядро бота. Не знает, где запущено: Cloudflare или обычный сервер.
import { migrate } from './schema.js';
import { makeTg } from './tg.js';
import { nowSec } from './time.js';
import { userCommands, adminCommands } from './msgs.js';
import { onStart, onUserCallback, onUserCommand, onUserText, getUState } from './users.js';
import { isAdmin, envAdmins, onAdminCommand, onAdminMessage, onAdminCallback } from './admin.js';
import { sendPost, dueUsers, recordDeliveries, loadDocs } from './posts.js';
import { btn } from './msgs.js';

export function makeCtx({ db, env, publicUrl, fetchFn, now }) {
  const tg = makeTg({ token: env.BOT_TOKEN, root: env.TG_API_ROOT, relayKey: env.TG_RELAY_KEY, fetchFn });
  return { db, env, tg, publicUrl: publicUrl || env.PUBLIC_URL || '', now: now || nowSec() };
}

const ALIAS = {
  'новый': 'new', 'посты': 'posts', 'стат': 'stats', 'статистика': 'stats', 'отмена': 'cancel', 'помощь': 'help',
  'админы': 'admins', 'панель': 'admin', 'тексты': 'texts', 'проверка': 'check', 'стоп': 'stop', 'уровень': 'level', 'удалить': 'delete', 'политика': 'policy',
};

export function parseCommand(text) {
  const m = /^\/([^\s@]+)(?:@\S+)?\s*([\s\S]*)$/.exec(text || '');
  if (!m) return null;
  const c = m[1].toLowerCase();
  return { cmd: ALIAS[c] || c, arg: m[2].trim() };
}

export async function handleUpdate(ctx, upd) {
  const who = (upd.message && upd.message.from) || (upd.callback_query && upd.callback_query.from);
  if (who && who.first_name) ctx.userName = who.first_name;
  if (upd.my_chat_member) {
    const st = upd.my_chat_member.new_chat_member && upd.my_chat_member.new_chat_member.status;
    if (st === 'kicked') await ctx.db.run(`UPDATE users SET status = 'blocked' WHERE tg_id = ?`, [upd.my_chat_member.from.id]);
    return;
  }
  if (upd.callback_query) {
    const cq = upd.callback_query;
    const d = cq.data || '';
    if (/^(w:|p:|pl|h:|t:)/.test(d)) {
      await ctx.tg.call('answerCallbackQuery', { callback_query_id: cq.id }).catch(() => {});
      if (!(await isAdmin(ctx, cq.from.id))) return;
      return onAdminCallback(ctx, cq);
    }
    return onUserCallback(ctx, cq);
  }
  const msg = upd.message;
  if (!msg || !msg.from || msg.chat.type !== 'private') return;
  const admin = await isAdmin(ctx, msg.from.id);
  const c = msg.text ? parseCommand(msg.text) : null;
  if (c) {
    if (c.cmd === 'start') return onStart(ctx, msg, c.arg);
    if (admin) { const r = await onAdminCommand(ctx, msg, c.cmd, c.arg); if (r !== null) return r; }
    return onUserCommand(ctx, msg, c.cmd);
  }
  // ответ на вопрос входа (имя, телефон, почта, отзыв) — в том числе у админа, который проходит путь ученика
  const us = await getUState(ctx, msg.from.id);
  if (us) return onUserText(ctx, msg, us);
  if (admin && (await onAdminMessage(ctx, msg))) return;
  return onUserCommand(ctx, msg, '');
}

// ---------- расписание: запускается раз в минуту ----------
// budget — сколько запросов к Telegram можно сделать за один запуск
// (на бесплатном Cloudflare лимит 50 на запуск, оставляем запас)
export async function tick(ctx, budget, queryBudget) {
  const now = ctx.now;
  // считаем запросы к базе: на бесплатном Cloudflare их число за запуск ограничено
  let q = 0;
  const raw = ctx.db;
  const db = { all: (...a) => (q++, raw.all(...a)), first: (...a) => (q++, raw.first(...a)), run: (...a) => (q++, raw.run(...a)) };
  ctx = { ...ctx, db };
  const maxQ = queryBudget || 1e9;
  await ctx.db.run(`INSERT INTO settings (key, value) VALUES ('last_tick', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`, [String(now)]);
  const pause = await ctx.db.first(`SELECT value FROM settings WHERE key = 'pause_until'`);
  if (pause && +pause.value > now) return { sent: 0, paused: true };

  const posts = await ctx.db.all(
    `SELECT * FROM posts WHERE status = 'active' AND ((kind = 'date' AND run_at <= ?) OR kind = 'drip')
     ORDER BY CASE kind WHEN 'date' THEN 0 ELSE 1 END, run_at, day, send_time, pos, id`, [now]);
  // по кругу: каждый запуск начинаем со следующего поста, чтобы до всех доходила очередь
  const posRow = await ctx.db.first(`SELECT value FROM settings WHERE key = 'tick_pos'`);
  const start = posts.length ? (posRow ? +posRow.value : 0) % posts.length : 0;
  const ordered = [...posts.slice(start), ...posts.slice(0, start)];
  let left = budget, sent = 0, done = 0, arrow = null;
  for (const p of ordered) {
    if (left <= 0 || q >= maxQ - 3) break;
    done++;
    const media = p.media ? JSON.parse(p.media) : [];
    const long = (p.text || '').length > 1024;
    const per = media.length > 1 ? 1 + ((p.buttons || long) ? 1 : 0) : media.length === 1 ? 1 + (long ? 1 : 0) : 1;
    const can = Math.floor(left / per);
    if (can <= 0) break;
    const users = await dueUsers(ctx.db, p, now, can);
    if (!users.length) continue;
    if (arrow === null) { arrow = await btn(ctx, 'buttonsArrow'); ctx.docs = await loadDocs(ctx); }
    const rows = [];
    let stop = false;
    for (const u of users) {
      try {
        await sendPost(ctx.tg, u.tg_id, p, { uid: u.tg_id, publicUrl: ctx.publicUrl, arrow, docs: ctx.docs });
        rows.push({ tg_id: u.tg_id, ok: true }); sent++;
      } catch (e) {
        if (e.code === 403) { rows.push({ tg_id: u.tg_id, ok: false }); await ctx.db.run(`UPDATE users SET status = 'blocked' WHERE tg_id = ?`, [u.tg_id]); }
        else if (e.code === 429) {
          await ctx.db.run(`INSERT INTO settings (key, value) VALUES ('pause_until', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`, [String(now + (e.retryAfter || 30))]);
          stop = true; break;
        } else if (e.code === 400) rows.push({ tg_id: u.tg_id, ok: false }); // пост сломан для этого человека — не повторяем
        else { stop = true; break; } // нет связи — попробуем в следующую минуту
      }
      left -= per;
    }
    await recordDeliveries(ctx.db, p.id, rows, now);
    if (stop) break;
  }
  if (posts.length) await ctx.db.run(`INSERT INTO settings (key, value) VALUES ('tick_pos', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`, [String((start + Math.max(done, 1)) % posts.length)]);
  return { sent, queries: q };
}

// ---------- первая настройка: база, вебхук, меню команд ----------
export async function setup(ctx, { webhookUrl, polling }) {
  const out = [];
  const v = await migrate(ctx.db);
  out.push(`База готова (версия ${v})`);
  if (polling) {
    await ctx.tg.call('deleteWebhook', {});
    out.push('Режим без вебхука: сервер сам забирает сообщения');
  } else {
    await ctx.tg.call('setWebhook', {
      url: webhookUrl, secret_token: ctx.env.WEBHOOK_SECRET || undefined,
      allowed_updates: ['message', 'callback_query', 'my_chat_member'], drop_pending_updates: false,
    });
    out.push('Вебхук установлен: ' + webhookUrl);
  }
  await ctx.tg.call('setMyCommands', { commands: await userCommands(ctx) });
  const admins = [...envAdmins(ctx.env), ...(await ctx.db.all(`SELECT tg_id FROM admins`)).map((r) => r.tg_id)];
  const ac = await adminCommands(ctx);
  for (const a of new Set(admins)) await ctx.tg.call('setMyCommands', { commands: ac, scope: { type: 'chat', chat_id: a } }).catch(() => {});
  out.push('Меню команд обновлено, админов: ' + new Set(admins).size);
  const me = await ctx.tg.call('getMe');
  out.push('Бот: @' + me.username);
  return out;
}

// ---------- переход по кнопке: считаем нажатие и ведём на ссылку ----------
export async function clickRedirect(ctx, postId, btn, uid) {
  const p = await ctx.db.first(`SELECT buttons FROM posts WHERE id = ?`, [postId]);
  if (!p || !p.buttons) return null;
  const [ri, bi] = String(btn).split('-').map(Number);
  const b = (JSON.parse(p.buttons)[ri] || [])[bi];
  if (!b) return null;
  await ctx.db.run(`INSERT INTO clicks (post_id, tg_id, btn, at) VALUES (?, ?, ?, ?)`, [postId, Number(uid) || null, b.text, ctx.now]);
  return b.url;
}

// ---------- переезд: выгрузка и загрузка всех данных ----------
const TABLES = ['users', 'consents', 'admins', 'posts', 'deliveries', 'clicks', 'settings'];
export async function exportAll(db) {
  const v = await db.first(`SELECT MAX(v) AS v FROM schema_version`);
  const out = { format: 'di-sign-bot-backup', schema: v ? v.v : 0, exported_at: new Date().toISOString(), tables: {} };
  for (const t of TABLES) out.tables[t] = await db.all(`SELECT * FROM ${t}`);
  return out;
}
export async function importAll(db, data) {
  if (!data || data.format !== 'di-sign-bot-backup') throw new Error('Это не файл выгрузки бота');
  await migrate(db);
  const counts = {};
  for (const t of TABLES) {
    const rows = (data.tables && data.tables[t]) || [];
    for (const r of rows) {
      const cols = Object.keys(r);
      await db.run(`INSERT OR REPLACE INTO ${t} (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`, cols.map((c) => r[c]));
    }
    counts[t] = rows.length;
  }
  return counts;
}
