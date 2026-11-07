// «через N … в конкретное время»: срок считается по Москве; целые дни — по календарю
import assert from 'node:assert/strict';
import { nodeSqliteAdapter } from '../src/db-node.js';
import { migrate } from '../src/schema.js';
import { dueSql, setCohorts } from '../src/posts.js';
const db = await nodeSqliteAdapter(':memory:'); await migrate(db);
const U = (y, m, d, h, mi) => Date.UTC(y, m - 1, d, h, mi) / 1000 - 10800; // московское время -> unix
await db.run(`INSERT INTO users (tg_id, status, created_at, joined_at) VALUES (1, 'active', 0, ?)`, [U(2026, 11, 7, 15, 20)]);
const due = async (post) => (await db.first(`SELECT ${dueSql(post)} AS at FROM users u WHERE u.tg_id = 1`)).at;
assert.equal(await due({ mode: 'timer', delay_min: 2880, at_time: '11:00' }), U(2026, 11, 9, 11, 0), 'через 2 дня в 11:00 = послезавтра в 11:00');
assert.equal(await due({ mode: 'timer', delay_min: 0, at_time: '11:00' }), U(2026, 11, 8, 11, 0), 'сегодня 11:00 уже прошло: завтра');
assert.equal(await due({ mode: 'timer', delay_min: 0, at_time: '18:00' }), U(2026, 11, 7, 18, 0), 'сегодня 18:00 ещё впереди');
assert.equal(await due({ mode: 'timer', delay_min: 120, at_time: '10:00' }), U(2026, 11, 8, 10, 0), 'через 2 ч (17:20), ближайшие 10:00 — завтра');
assert.equal(await due({ mode: 'timer', delay_min: 30 }), U(2026, 11, 7, 15, 50), 'без времени как раньше');
console.log('✓ срок «через N в HH:MM» считается верно');
// старт потока: кто вошёл до даты старта, ждёт её; кто позже — считает от своего входа
await db.run(`INSERT INTO users (tg_id, status, created_at, joined_at) VALUES (2, 'active', 0, ?)`, [U(2026, 11, 3, 9, 0)]);
await db.run(`INSERT INTO users (tg_id, status, created_at, joined_at) VALUES (3, 'active', 0, ?)`, [U(2026, 11, 20, 14, 0)]);
setCohorts({ course: '2026-11-06', mat: '' });
const dueU = async (post, id) => (await db.first(`SELECT ${dueSql(post)} AS at FROM users u WHERE u.tg_id = ?`, [id])).at;
const P = (day, track = 'course', t = '11:00') => ({ mode: 'day', day, send_time: t, track });
assert.equal(await dueU(P(0), 2), U(2026, 11, 6, 11, 0), 'вошёл 3 нояб: день 0 в дату старта, 11:00');
assert.equal(await dueU(P(4), 2), U(2026, 11, 10, 11, 0), 'вошёл 3 нояб: день 4 = 10 нояб');
assert.equal(await dueU(P(4), 3), U(2026, 11, 24, 11, 0), 'вошёл 20 нояб: день 4 = 24 нояб, от своего входа');
assert.equal(await dueU(P(0), 3), U(2026, 11, 20, 14, 0), 'вошёл позже старта: день 0 сразу');
assert.equal(await dueU(P(4, 'mat'), 2), U(2026, 11, 7, 11, 0), 'трек без даты: от входа 3 нояб + 4 дня = 7 нояб');
setCohorts({});
console.log('✓ старт потока: ранние ждут дату, поздние считают от входа');
process.exit(0);
