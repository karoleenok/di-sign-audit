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
  // v5: конструктор сценариев — посты-ответы (kind = 'node', уходят по кнопке «открыть пост»),
  //     «кнопки-выбор»: после нажатия под постом остаётся только выбранная
  [
    `ALTER TABLE posts ADD COLUMN once INTEGER NOT NULL DEFAULT 0`,
  ],
  // v6: вход в бота — выбор из аудита (мини-курс или материалы), имя и контакт, отзыв о кабинете;
  //     посты по треку (всем / мини-курс / материалы); kind = 'fb' — бонус за отзыв
  [
    `ALTER TABLE users ADD COLUMN track TEXT`,
    `ALTER TABLE users ADD COLUMN contact_name TEXT`,
    `ALTER TABLE users ADD COLUMN phone TEXT`,
    `ALTER TABLE users ADD COLUMN email TEXT`,
    `ALTER TABLE users ADD COLUMN contact_at INTEGER`,
    `ALTER TABLE users ADD COLUMN fb_like TEXT`,
    `ALTER TABLE users ADD COLUMN fb_improve TEXT`,
    `ALTER TABLE users ADD COLUMN fb_at INTEGER`,
    `ALTER TABLE users ADD COLUMN fb_skip INTEGER`,
    `ALTER TABLE users ADD COLUMN test_offered INTEGER`,
    `ALTER TABLE users ADD COLUMN sched_at INTEGER`,
    `ALTER TABLE posts ADD COLUMN track TEXT NOT NULL DEFAULT 'all'`,
  ],
  [
    `CREATE TABLE IF NOT EXISTS leads (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tg_id INTEGER NOT NULL, source TEXT, created_at INTEGER NOT NULL
    )`,
  ],
  // v8: заявка считается принятой, когда человек оставил имя и способ связи (done = 1)
  [
    `ALTER TABLE leads ADD COLUMN done INTEGER NOT NULL DEFAULT 1`,
  ],
  // v: развилка по треку (мини-курс / материалы)
  [`ALTER TABLE posts ADD COLUMN fork TEXT`],
  // история текста постов: прежние версии, чтобы можно было вернуть
  [
    `CREATE TABLE IF NOT EXISTS post_versions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      post_id INTEGER NOT NULL, text TEXT, entities TEXT, media TEXT,
      by_id INTEGER, by_name TEXT, at INTEGER NOT NULL
    )`,
    `CREATE INDEX IF NOT EXISTS post_versions_post ON post_versions (post_id, id)`,
  ],
  // откат на шаг назад; посты из бота (/new) — во «входящих», пока их не поставили в путь
  [
    `CREATE TABLE IF NOT EXISTS undo_log (id INTEGER PRIMARY KEY AUTOINCREMENT, snap TEXT NOT NULL, label TEXT, by_id INTEGER, by_name TEXT, at INTEGER NOT NULL)`,
    `ALTER TABLE posts ADD COLUMN inbox INTEGER NOT NULL DEFAULT 0`,
  ],
  // кому шаг входа: all — всем, new — только тем, кто пришёл без аудита
  [`ALTER TABLE posts ADD COLUMN who TEXT`],
  // v7: вкладка «Задачи» в панели — общие отметки «сделано» (список задач лежит в panel.html, тут только отметки)
  [
    `CREATE TABLE IF NOT EXISTS team_tasks (
      task_id TEXT NOT NULL, owner TEXT NOT NULL,
      done_at INTEGER NOT NULL, done_by INTEGER,
      PRIMARY KEY (task_id, owner)
    )`,
  ],
  // v8: «через N после … в конкретное время суток» для постов по таймеру и «после поста»
  [`ALTER TABLE posts ADD COLUMN at_time TEXT`],
  // v9: у постов «в день ленты» пауза после входа (delay_min) теперь значит что-то только у дня 0; старые хвосты от прошлых режимов обнуляем
  [`UPDATE posts SET delay_min = 0 WHERE kind = 'drip' AND (mode IS NULL OR mode = 'day')`],
  // v10: когда человек выбрал трек (прошёл аудит или нажал в боте): уроки мини-курса и материалов считаются от этого момента, а не от первого входа из соцсетей
  [`ALTER TABLE users ADD COLUMN track_at INTEGER`],
  // v11: журнал действий человека (повторный аудит, смена трека), чтобы путь ученика было видно целиком
  [
    `CREATE TABLE IF NOT EXISTS user_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tg_id INTEGER NOT NULL, kind TEXT NOT NULL, data TEXT, at INTEGER NOT NULL
    )`,
    `CREATE INDEX IF NOT EXISTS idx_user_events_tg ON user_events(tg_id, at)`,
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
