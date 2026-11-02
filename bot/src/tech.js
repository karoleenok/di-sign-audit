// Технические аккаунты: свои тестовые заявки и отзывы (админы, Диана, второй аккаунт для проверок).
// Они не попадают в таблицу, в списки «Люди» и в счётчики. Админы бота считаются техническими всегда,
// остальных добавляют по @нику или Telegram ID.
import { envAdmins } from './admin.js';
const KEY = 'tech:list';

async function raw(db) {
  const r = await db.first(`SELECT value FROM settings WHERE key = ?`, [KEY]);
  try { const a = JSON.parse((r && r.value) || '[]'); return Array.isArray(a) ? a : []; } catch { return []; }
}
const save = (db, list) => db.run(`INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`, [KEY, JSON.stringify(list)]);
const keyOf = (e) => (e.id ? 'id:' + e.id : 'u:' + e.name);

// разобрать то, что ввели: @ник, ник, ссылка t.me/ник или число (ID)
export function parseTech(text) {
  const t = String(text || '').trim().replace(/^https?:\/\/t\.me\//i, '').replace(/^@/, '');
  if (/^-?\d{4,15}$/.test(t)) return { id: Number(t) };
  if (/^[A-Za-z][A-Za-z0-9_]{3,31}$/.test(t)) return { name: t.toLowerCase() };
  return null;
}
export async function addTech(db, text) {
  const e = parseTech(text);
  if (!e) throw new Error('Не поняла: напиши @ник (например, @dopamine_fish) или Telegram ID цифрами');
  const list = await raw(db);
  if (!list.some((x) => keyOf(x) === keyOf(e))) list.push(e);
  await save(db, list);
  return e;
}
export async function removeTech(db, key) { await save(db, (await raw(db)).filter((x) => keyOf(x) !== key)); }

// кто технический сейчас: ручной список + админы; names — ники в нижнем регистре
export async function techSet(ctx) {
  const list = await raw(ctx.db);
  const admins = new Set([...envAdmins(ctx.env), ...(await ctx.db.all(`SELECT tg_id FROM admins`)).map((r) => Number(r.tg_id))]);
  const ids = new Set([...admins, ...list.filter((x) => x.id).map((x) => x.id)]);
  const names = new Set(list.filter((x) => x.name).map((x) => x.name));
  return { list, admins: [...admins], has: (u) => ids.has(Number(u.tg_id)) || (!!u.username && names.has(String(u.username).toLowerCase())) };
}
