// «через N … в конкретное время»: срок считается по Москве; целые дни — по календарю
import assert from 'node:assert/strict';
import { nodeSqliteAdapter } from '../src/db-node.js';
import { migrate } from '../src/schema.js';
import { dueSql, setCohorts, dueUsers, catchesUp, isStreamPost } from '../src/posts.js';
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
// день 0 с паузой: второй пост дня 0 — через N минут после входа (или после старта потока)
const D0 = (delay_min) => ({ mode: 'day', day: 0, send_time: '00:00', track: 'course', delay_min });
assert.equal(await dueU(D0(30), 3), U(2026, 11, 20, 14, 30), 'день 0 с паузой 30 мин: вошёл 20 нояб 14:00 -> 14:30');
assert.equal(await dueU(D0(30), 2), U(2026, 11, 6, 11, 30), 'вошёл до старта: в дату старта 11:00 + 30 мин');
setCohorts({});
assert.equal(await dueU(D0(30), 3), U(2026, 11, 20, 14, 30), 'без даты старта пауза та же');
// посты потока догоняют сами: у них не нужен переключатель «срок прошёл»
await db.run(`UPDATE users SET consent_ads_at = 1, paid_at = NULL, track = 'course' WHERE tg_id IN (2, 3)`);
const LATE = { id: 77, kind: 'drip', audience: 'all', track: 'course', mode: 'day', day: 1, send_time: '11:00', delay_min: 0, catchup: 0, created_at: U(2026, 11, 9, 12, 0) };
setCohorts({ course: '2026-11-06', mat: '' });
assert.ok(isStreamPost(LATE) && catchesUp(LATE), 'пост трека с датой старта — пост потока');
assert.ok(!isStreamPost({ ...LATE, track: 'mat' }) && !catchesUp({ ...LATE, track: 'mat' }), 'у трека без даты старта всё как раньше');
assert.ok(!isStreamPost({ ...LATE, mode: 'timer' }), 'таймер не пост потока');
const NOW = U(2026, 11, 9, 12, 5);
assert.deepEqual((await dueUsers(db, LATE, NOW, 10)).map((r) => r.tg_id), [2], 'пост создан позже срока: ранний получает без переключателя, поздний (вход 20 нояб) ещё нет');
assert.deepEqual((await dueUsers(db, { ...LATE, track: 'all' }, NOW, 10)).map((r) => r.tg_id), [], 'пост трека «для всех» без переключателя опоздавшим не уходит');
// из соцсетей: вошёл 3 нояб, аудит и выбор трека 20 нояб -> уроки считаются от 20 нояб, а не от 3
await db.run(`INSERT INTO users (tg_id, status, created_at, joined_at, track, track_at) VALUES (4, 'active', 0, ?, 'course', ?)`, [U(2026, 11, 3, 9, 0), U(2026, 11, 20, 14, 0)]);
setCohorts({});
assert.equal(await dueU(P(4), 4), U(2026, 11, 24, 11, 0), 'вошёл 3 нояб, выбрал трек 20 нояб: день 4 = 24 нояб');
assert.equal(await dueU(P(0), 4), U(2026, 11, 20, 14, 0), 'день 0 сразу после выбора трека');
assert.equal(await dueU({ ...P(4), track: 'all' }, 4), U(2026, 11, 7, 11, 0), 'пост «для всех» считается от входа');
assert.equal(await dueU({ mode: 'timer', delay_min: 60, track: 'course' }, 4), U(2026, 11, 20, 15, 0), 'таймер поста трека — от выбора трека');
setCohorts({ course: '2026-11-06', mat: '' });
setCohorts({});
console.log('✓ старт потока: ранние ждут дату, поздние считают от входа');
process.exit(0);
