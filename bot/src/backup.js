// Ежедневная копия базы: файл на диске сервера (последние 7) + файл в телеграм первому админу.
// В базе есть имена и телефоны учеников — копия уходит только админам из ADMIN_IDS.
import fs from 'node:fs';
import path from 'node:path';
import { envAdmins } from './admin.js';

const KEY = 'backup:last';
const mskParts = (ms) => { const d = new Date(ms + 3 * 3600e3); return { day: d.toISOString().slice(0, 10), hour: d.getUTCHours() }; };

export async function lastBackup(ctx) {
  const r = await ctx.db.first(`SELECT value FROM settings WHERE key = ?`, [KEY]);
  try { return r ? JSON.parse(r.value) : null; } catch { return null; }
}

// сделать копию сейчас; sendTo — кому отправить файл (или никому)
export async function makeBackup(ctx, file, { send = true } = {}) {
  const dir = path.join(path.dirname(file), 'backup');
  fs.mkdirSync(dir, { recursive: true });
  const { day } = mskParts(Date.now());
  const out = path.join(dir, `bot-${day}.db`);
  if (fs.existsSync(out)) fs.unlinkSync(out);
  ctx.db._raw.exec(`VACUUM INTO '${out.replace(/'/g, "''")}'`);
  const size = fs.statSync(out).size;
  fs.readdirSync(dir).filter((f) => /^bot-\d{4}-\d\d-\d\d\.db$/.test(f)).sort().slice(0, -7).forEach((f) => fs.unlinkSync(path.join(dir, f)));
  let sent = false, err = null;
  const to = envAdmins(ctx.env)[0];
  if (send && to && size < 45 * 1024 * 1024) {
    try {
      const fd = new FormData();
      fd.append('chat_id', String(to));
      fd.append('caption', `копия базы за ${day}. внутри имена и телефоны учеников, храни только у себя`);
      fd.append('document', new Blob([fs.readFileSync(out)]), `bot-${day}.db`);
      await ctx.tg.upload('sendDocument', fd);
      sent = true;
    } catch (e) { err = e.message; }
  }
  const info = { at: Date.now(), day, size, sent, err };
  await ctx.db.run(`INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`, [KEY, JSON.stringify(info)]);
  return info;
}

// раз в минуту: после 04:00 по Москве, если сегодня ещё не делали
export async function backupTick(ctx, file) {
  const { day, hour } = mskParts(Date.now());
  if (hour < 4) return null;
  const last = await lastBackup(ctx);
  if (last && last.day === day) return null;
  return makeBackup(ctx, file);
}
