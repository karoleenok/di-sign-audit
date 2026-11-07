// Кому и когда ушёл пост, и что пришло конкретному человеку. Только чтение.
import { audienceSql, dueSql, BASE, NOT_SENT, catchesUp } from './posts.js';

const nameOf = (u) => u.contact_name || u.first_name || (u.username ? '@' + u.username : 'без имени');
const titleOf = (p) => (p.title || (p.text || '').replace(/\s+/g, ' ').trim()).slice(0, 60) || 'без текста';

export async function postDelivery(ctx, id) {
  const p = await ctx.db.first(`SELECT * FROM posts WHERE id = ?`, [id]);
  if (!p) return null;
  const now = ctx.now;
  const rows = await ctx.db.all(
    `SELECT d.tg_id, d.sent_at, d.ok, u.first_name, u.username, u.contact_name, u.track, u.status
       FROM deliveries d LEFT JOIN users u ON u.tg_id = d.tg_id WHERE d.post_id = ? ORDER BY d.sent_at DESC LIMIT 500`, [id]);
  const sent = [], failed = [];
  for (const r of rows) {
    const o = { id: r.tg_id, name: nameOf(r), track: r.track || null, at: r.sent_at };
    if (r.ok) sent.push(o); else failed.push({ ...o, why: r.status === 'blocked' ? 'заблокировал бота' : 'Телеграм не доставил' });
  }
  const clicks = await ctx.db.first(`SELECT COUNT(DISTINCT tg_id) AS n FROM clicks WHERE post_id = ?`, [id]);
  const wait = [], skipped = [];
  if (p.kind === 'drip' || p.kind === 'date') {
    const a = audienceSql(p);
    if (p.kind === 'drip') {
      const due = dueSql(p);
      const q = await ctx.db.all(
        `SELECT u.tg_id, u.first_name, u.username, u.contact_name, u.track, ${due} AS at FROM users u WHERE ${BASE}${a.c} AND ${NOT_SENT} LIMIT 500`,
        [...a.p, id]);
      for (const u of q) {
        const o = { id: u.tg_id, name: nameOf(u), track: u.track || null, at: u.at };
        if (u.at === null || u.at === undefined) continue; // «после поста»: срок появится, когда он получит тот пост
        if (!catchesUp(p) && u.at < p.created_at) skipped.push({ ...o, why: 'его момент прошёл до создания поста' });
        else wait.push(o);
      }
    } else if (p.run_at) {
      const q = await ctx.db.all(
        `SELECT u.tg_id, u.first_name, u.username, u.contact_name, u.track FROM users u WHERE ${BASE}${a.c} AND ${NOT_SENT} AND u.joined_at <= ? LIMIT 500`,
        [...a.p, id, p.run_at]);
      for (const u of q) wait.push({ id: u.tg_id, name: nameOf(u), track: u.track || null, at: p.run_at });
    }
  }
  wait.sort((x, y) => (x.at || 0) - (y.at || 0));
  return { id, title: titleOf(p), status: p.status, kind: p.kind, now, clicked: clicks ? clicks.n : 0, counts: { sent: sent.length, wait: wait.length, skipped: skipped.length, failed: failed.length }, sent, wait, skipped, failed };
}

export async function personLog(ctx, tgId) {
  const u = await ctx.db.first(`SELECT * FROM users WHERE tg_id = ?`, [tgId]);
  if (!u) return null;
  const now = ctx.now;
  const got = await ctx.db.all(
    `SELECT d.post_id, d.sent_at, d.ok, p.title, p.text, p.kind FROM deliveries d JOIN posts p ON p.id = d.post_id WHERE d.tg_id = ? ORDER BY d.sent_at`, [tgId]);
  const items = got.map((r) => ({ post: r.post_id, title: titleOf(r), kind: r.kind, state: r.ok ? 'sent' : 'failed', at: r.sent_at }));
  const have = new Set(got.map((r) => r.post_id));
  const posts = await ctx.db.all(`SELECT * FROM posts WHERE status = 'active' AND kind IN ('drip', 'date') ORDER BY id`);
  for (const p of posts) {
    if (have.has(p.id)) continue;
    const a = audienceSql(p);
    let at = null;
    const mine = await ctx.db.first(`SELECT ${p.kind === 'drip' ? dueSql(p) : 'NULL'} AS at, ${p.kind === 'drip' ? '1' : `(u.joined_at <= ${Number(p.run_at) || 0})`} AS ok FROM users u WHERE u.tg_id = ? AND ${BASE}${a.c}`, [tgId, ...a.p].slice(0, 1 + a.p.length));
    if (!mine) { items.push({ post: p.id, title: titleOf(p), kind: p.kind, state: 'skip', why: 'не для него: другой трек или вход не пройден', at: null }); continue; }
    at = p.kind === 'date' ? p.run_at : mine.at;
    if (p.kind === 'date' && (!p.run_at || !mine.ok)) { items.push({ post: p.id, title: titleOf(p), kind: p.kind, state: 'skip', why: 'пришёл в бота позже даты', at: null }); continue; }
    if (at === null || at === undefined) { items.push({ post: p.id, title: titleOf(p), kind: p.kind, state: 'wait', why: 'после другого поста', at: null }); continue; }
    if (p.kind === 'drip' && !catchesUp(p) && at < p.created_at) { items.push({ post: p.id, title: titleOf(p), kind: p.kind, state: 'skip', why: 'его момент прошёл до создания поста', at }); continue; }
    items.push({ post: p.id, title: titleOf(p), kind: p.kind, state: 'wait', at });
  }
  const order = (x) => (x.at === null ? 9e12 : x.at);
  items.sort((x, y) => (x.state === 'skip') - (y.state === 'skip') || order(x) - order(y));
  return { id: tgId, name: nameOf(u), track: u.track || null, status: u.status, joined_at: u.joined_at, now, items };
}
