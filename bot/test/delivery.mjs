// «Кому ушёл пост» и «Что пришло человеку»
import assert from 'node:assert/strict';
import { nodeSqliteAdapter } from '../src/db-node.js';
import { migrate } from '../src/schema.js';
import { postDelivery, personLog } from '../src/delivery.js';
const db = await nodeSqliteAdapter(':memory:'); await migrate(db);
const NOW = 1_800_000_000;
const ctx = { db, now: NOW };
const user = (id, name, track, joined, extra = '') => db.run(`INSERT INTO users (tg_id, first_name, status, track, consent_ads_at, joined_at, created_at) VALUES (?, ?, 'active', ?, 1, ?, 0)`, [id, name, track, joined]);
await user(1, 'Анна', 'mat', NOW - 3 * 3600);   // получила
await user(2, 'Мария', 'mat', NOW - 600);       // ждёт (через 2 часа)
await user(3, 'Лена', 'mat', NOW - 5 * 86400);  // момент прошёл до создания поста
await user(4, 'Ксения', 'course', NOW - 3 * 3600); // не её трек
await user(5, 'Виктор', 'mat', NOW - 3 * 3600); // не дошло
await db.run(`INSERT INTO posts (id, title, kind, track, status, mode, delay_min, day, send_time, created_at, text) VALUES (10, 'Добро пожаловать', 'drip', 'mat', 'active', 'timer', 120, 1, '11:00', ?, 'x')`, [NOW - 86400]);
await db.run(`INSERT INTO deliveries (post_id, tg_id, sent_at, ok) VALUES (10, 1, ?, 1), (10, 5, ?, 0)`, [NOW - 3600, NOW - 3500]);
const r = await postDelivery(ctx, 10);
assert.deepEqual(r.counts, { sent: 1, wait: 1, skipped: 1, failed: 1 }, JSON.stringify(r.counts));
assert.equal(r.sent[0].name, 'Анна');
assert.equal(r.wait[0].name, 'Мария');
assert.equal(r.wait[0].at, NOW - 600 + 7200, 'Мария получит через 2 часа после входа');
assert.equal(r.skipped[0].name, 'Лена');
assert.equal(r.failed[0].name, 'Виктор');
const log = await personLog(ctx, 2);
const it = log.items.find((x) => x.post === 10);
assert.equal(it.state, 'wait'); assert.equal(it.at, NOW - 600 + 7200);
const log4 = await personLog(ctx, 4);
assert.equal(log4.items.find((x) => x.post === 10).state, 'skip', 'другой трек');
const log1 = await personLog(ctx, 1);
assert.equal(log1.items.find((x) => x.post === 10).state, 'sent');
assert.equal(await postDelivery(ctx, 999), null);
console.log('✓ «Кому ушёл пост» и «Что пришло» считаются верно');
process.exit(0);
