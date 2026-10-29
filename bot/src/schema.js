// Схема базы. Обычный SQLite: работает и в Cloudflare D1, и на любом российском сервере.
// Новые изменения добавляем В КОНЕЦ списка MIGRATIONS (старые не трогаем).
export const MIGRATIONS = [
  // 1: основа
  [
    `CREATE TABLE IF NOT EXISTS users (
      tg_id INTEGER PRIMARY KEY,
      first_name TEXT, username TEXT,
      level TEXT,            -- start | pro | NULL
      level_raw TEXT,        -- start | free | pro (как в тесте)
      zone TEXT,             -- B P V S C I T top | NULL
      source TEXT,           -- метка из ссылки
      status TEXT NOT NULL DEFAULT 'new',   -- new | active | stopped | blocked
      consent_pd_at INTEGER, consent_ads_at INTEGER,
      joined_at INTEGER,     -- когда пошла лента (после согласия на рассылку)
      paid_at INTEGER,
      created_at INTEGER NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS consents (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tg_id INTEGER NOT NULL, kind TEXT NOT NULL, granted INTEGER NOT NULL,
      version TEXT, at INTEGER NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS admins (
      tg_id INTEGER PRIMARY KEY, name TEXT, added_at INTEGER NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS posts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT,
      kind TEXT NOT NULL,                  -- drip | date | gift
      audience TEXT NOT NULL DEFAULT 'all',-- all | start | pro
      zone TEXT,                           -- NULL = для всех зон; для gift обязательно
      day INTEGER,                         -- drip: через сколько дней от входа (0 = сразу)
      send_time TEXT NOT NULL DEFAULT '11:00',  -- drip: время по Москве
      run_at INTEGER,                      -- date: когда отправить (unix)
      catchup INTEGER NOT NULL DEFAULT 0,  -- догонять тех, для кого время уже прошло
      status TEXT NOT NULL DEFAULT 'draft',-- draft | active | paused | archived
      text TEXT, entities TEXT, media TEXT, buttons TEXT,
      created_by INTEGER, created_at INTEGER NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS deliveries (
      post_id INTEGER NOT NULL, tg_id INTEGER NOT NULL,
      sent_at INTEGER NOT NULL, ok INTEGER NOT NULL DEFAULT 1,
      PRIMARY KEY (post_id, tg_id)
    )`,
    `CREATE TABLE IF NOT EXISTS clicks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      post_id INTEGER, tg_id INTEGER, btn TEXT, at INTEGER NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS states (
      tg_id INTEGER PRIMARY KEY, state TEXT, data TEXT, updated_at INTEGER
    )`,
    `CREATE TABLE IF NOT EXISTS draft_parts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      admin_id INTEGER NOT NULL, message_id INTEGER NOT NULL,
      group_id TEXT, text TEXT, entities TEXT, media_type TEXT, file_id TEXT
    )`,
    `CREATE TABLE IF NOT EXISTS draft_groups (
      admin_id INTEGER NOT NULL, group_id TEXT NOT NULL,
      PRIMARY KEY (admin_id, group_id)
    )`,
    `CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY, value TEXT
    )`,
    `CREATE INDEX IF NOT EXISTS idx_users_status ON users(status)`,
    `CREATE INDEX IF NOT EXISTS idx_posts_kind ON posts(kind, status)`,
  ],
  // v2: порядок постов внутри одного дня и времени (меняется в панели перетаскиванием)
  [
    `ALTER TABLE posts ADD COLUMN pos INTEGER NOT NULL DEFAULT 0`,
  ],
  // v3: служебные сообщения бота (согласия, вопросы), которые убираются, когда уже не нужны
  [
    `ALTER TABLE users ADD COLUMN tech TEXT`,
  ],
  // v4: когда отправлять пост ленты — в день и время / по таймеру после входа / после другого поста;
  //     тестовые прогоны ленты для админа (1 день = 1 минута)
  [
    `ALTER TABLE posts ADD COLUMN mode TEXT NOT NULL DEFAULT 'day'`,
    `ALTER TABLE posts ADD COLUMN delay_min INTEGER`,
    `ALTER TABLE posts ADD COLUMN after_id INTEGER`,
    `CREATE TABLE IF NOT EXISTS test_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      admin_id INTEGER NOT NULL, level TEXT, started_at INTEGER NOT NULL, scale INTEGER NOT NULL DEFAULT 1440,
      status TEXT NOT NULL DEFAULT 'active'
    )`,
    `CREATE TABLE IF NOT EXISTS test_sent (
      run_id INTEGER NOT NULL, post_id INTEGER NOT NULL, at INTEGER NOT NULL, PRIMARY KEY (run_id, post_id)
    )`,
  ],
];

// Обновить базу при первом запуске после выкладки новой версии (один раз на процесс)
let checked = false;
export async function ensureSchema(db) {
  if (checked) return;
  await migrate(db);
  checked = true;
}

export async function migrate(db) {
  await db.run(`CREATE TABLE IF NOT EXISTS schema_version (v INTEGER NOT NULL)`);
  const row = await db.first(`SELECT MAX(v) AS v FROM schema_version`);
  let cur = row && row.v ? row.v : 0;
  for (let i = cur; i < MIGRATIONS.length; i++) {
    for (const sql of MIGRATIONS[i]) await db.run(sql);
    await db.run(`INSERT INTO schema_version (v) VALUES (?)`, [i + 1]);
    cur = i + 1;
  }
  return cur;
}
