// Проверка переезда: выгрузили из одной базы — загрузили в другую — всё на месте.
import assert from 'node:assert/strict';
import { nodeSqliteAdapter } from '../src/db-node.js';
import { migrate } from '../src/schema.js';
import { exportAll, importAll, tick, makeCtx } from '../src/core.js';
const a = await nodeSqliteAdapter(':memory:'); await migrate(a);
await a.run(`INSERT INTO users (tg_id, first_name, level, zone, status, consent_pd_at, consent_ads_at, joined_at, created_at) VALUES (1,'A','start','P','active',1,1,1000,1000)`);
await a.run(`INSERT INTO posts (kind, audience, day, send_time, status, text, created_at) VALUES ('drip','all',1,'11:00','active','x',0)`);
await a.run(`INSERT INTO deliveries (post_id, tg_id, sent_at) VALUES (1,1,5)`);
const dump = JSON.parse(JSON.stringify(await exportAll(a)));
const b = await nodeSqliteAdapter(':memory:');
const c = await importAll(b, dump);
assert.deepEqual(c, { users: 1, consents: 0, admins: 0, posts: 1, deliveries: 1, clicks: 0, settings: 0 });
assert.equal((await b.first('SELECT text FROM posts')).text, 'x');
// после переезда уже отправленное не дублируется
const calls = [];
const ctx = makeCtx({ db: b, env: { BOT_TOKEN: 't' }, now: 10 ** 9, fetchFn: async (u, i) => { calls.push(u); return { json: async () => ({ ok: true, result: {} }) }; } });
await tick(ctx, 30);
assert.equal(calls.length, 0);
console.log('✓ переезд: выгрузка → загрузка, без повторных отправок');

// нагрузка: 70 человек, 5 постов, бесплатные лимиты — за несколько минут доходит до всех
const d = await nodeSqliteAdapter(':memory:'); await migrate(d);
for (let i = 1; i <= 70; i++) await d.run(`INSERT INTO users (tg_id, level, zone, status, consent_pd_at, consent_ads_at, joined_at, created_at) VALUES (?, ?, 'P', 'active', 1, 1, 1000, 1000)`, [i, i % 2 ? 'start' : 'pro']);
for (let k = 0; k < 5; k++) await d.run(`INSERT INTO posts (kind, audience, day, send_time, status, text, created_at) VALUES ('drip','all',0,'00:00','active','p${k}',0)`);
let sentTotal = 0, minutes = 0;
const fetchFn = async () => ({ json: async () => ({ ok: true, result: {} }) });
while (minutes < 60) {
  const r = await tick(makeCtx({ db: d, env: { BOT_TOKEN: 't' }, now: 2000 + minutes * 60, fetchFn }), 30, 40);
  assert.ok(r.queries <= 40, 'не больше 40 запросов к базе за запуск: ' + r.queries);
  sentTotal += r.sent; minutes++;
  if (sentTotal === 350) break;
}
assert.equal(sentTotal, 350);
console.log(`✓ нагрузка: 350 отправок (70 человек × 5 постов) за ${minutes} мин при лимитах бесплатного Cloudflare`);
