// Что уйдёт в ближайшие дни: для вкладки «Главная» в панели. Только чтение, ничего не отправляет.
// Считаем людей, которые уже в боте. Кто придёт позже, получит ленту по своему расписанию.
import { audienceSql, dueSql, BASE, NOT_SENT, catchesUp } from './posts.js';
import { MSK, DAY } from './time.js';

const mskDay = (ts) => Math.floor((ts + MSK) / DAY);
const dayIso = (d) => new Date(d * DAY * 1000).toISOString().slice(0, 10);
const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim().toLowerCase().slice(0, 120);

export async function upcoming(ctx, now, days = 7) {
  const to = now + days * DAY;
  const posts = await ctx.db.all(`SELECT * FROM posts WHERE status = 'active' AND kind IN ('drip', 'date') ORDER BY id`);
  const items = [], warns = [];
  let afterN = 0;
  for (const p of posts) {
    const a = audienceSql(p);
    const title = (p.title || p.text || '').replace(/\s+/g, ' ').trim().slice(0, 60) || 'без текста';
    if (p.kind === 'date') {
      if (!p.run_at) { warns.push({ id: p.id, text: `«${title}» включён, но дата не задана: он не уйдёт` }); continue; }
      if (p.run_at > to) continue;
      const joined = p.run_at <= now ? ' AND u.joined_at <= ?' : '';
      const r = await ctx.db.first(`SELECT COUNT(*) AS n FROM users u WHERE ${BASE}${a.c} AND ${NOT_SENT}${joined}`, [...a.p, p.id, ...(joined ? [p.run_at] : [])]);
      if (!r.n) continue;
      items.push({ id: p.id, title, kind: 'date', at: Math.max(p.run_at, now), now: p.run_at <= now, n: r.n });
      continue;
    }
    // лента: день 0 уходит сразу после входа, «после другого поста» зависит от человека: их в расписание не кладём
    if (p.mode === 'after') { afterN++; continue; }
    if (p.mode !== 'timer' && Number(p.day) === 0) continue;
    const due = dueSql(p);
    const catchup = catchesUp(p) ? '' : ` AND ${due} >= ?`;
    const rows = await ctx.db.all(
      `SELECT ${due} AS at FROM users u WHERE ${BASE}${a.c} AND ${NOT_SENT} AND ${due} <= ?${catchup} LIMIT 5000`,
      [...a.p, p.id, to, ...(catchesUp(p) ? [] : [p.created_at])]);
    const byDay = new Map();
    for (const r of rows) {
      const isNow = r.at <= now;
      const key = isNow ? 'now' : mskDay(r.at);
      const o = byDay.get(key) || { n: 0, at: isNow ? now : r.at };
      o.n++; if (!isNow && p.mode === 'timer' && !p.at_time) o.at = Math.min(o.at, r.at);
      byDay.set(key, o);
    }
    for (const [key, o] of byDay) items.push({ id: p.id, title, kind: 'drip', timer: p.mode === 'timer' && !p.at_time ? Number(p.delay_min) || 0 : null, at: o.at, now: key === 'now', n: o.n });
  }
  // одинаковые включённые посты: уйдут дважды
  const seen = new Map();
  for (const p of posts) {
    const k = p.kind + '|' + (p.track || 'all') + '|' + norm(p.text);
    if (!norm(p.text)) continue;
    (seen.get(k) || seen.set(k, []).get(k)).push(p);
  }
  for (const g of seen.values()) {
    if (g.length < 2) continue;
    const t = (g[0].title || g[0].text || '').replace(/\s+/g, ' ').trim().slice(0, 40);
    warns.push({ id: g[0].id, text: `Одинаковых включённых постов: ${g.length} («${t}»). Каждый человек получит ${g.length} раза` });
  }
  items.sort((x, y) => x.at - y.at);
  const dayList = [];
  for (const it of items) {
    const d = it.now ? mskDay(now) : mskDay(it.at);
    let g = dayList.find((x) => x.d === d);
    if (!g) { g = { d, date: dayIso(d), items: [] }; dayList.push(g); }
    g.items.push({ id: it.id, title: it.title, kind: it.kind, at: it.at, now: it.now, timer: it.timer ?? null, n: it.n });
  }
  return { today: dayIso(mskDay(now)), days: dayList.map(({ date, items }) => ({ date, items })), warns, afterN };
}
