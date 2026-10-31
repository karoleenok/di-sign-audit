// src/db.js
function d1Adapter(d1) {
  const prep = (sql, params) => d1.prepare(sql).bind(...params || []);
  return {
    async all(sql, params) {
      const r = await prep(sql, params).all();
      return r.results || [];
    },
    async first(sql, params) {
      return await prep(sql, params).first() || null;
    },
    async run(sql, params) {
      const r = await prep(sql, params).run();
      return { changes: r.meta && r.meta.changes || 0 };
    }
  };
}

// src/schema.js
var MIGRATIONS = [
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
    `CREATE INDEX IF NOT EXISTS idx_posts_kind ON posts(kind, status)`
  ],
  // v2: порядок постов внутри одного дня и времени (меняется в панели перетаскиванием)
  [
    `ALTER TABLE posts ADD COLUMN pos INTEGER NOT NULL DEFAULT 0`
  ],
  // v3: служебные сообщения бота (согласия, вопросы), которые убираются, когда уже не нужны
  [
    `ALTER TABLE users ADD COLUMN tech TEXT`
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
    )`
  ],
  // v5: конструктор сценариев — посты-ответы (kind = 'node', уходят по кнопке «открыть пост»),
  //     «кнопки-выбор»: после нажатия под постом остаётся только выбранная
  [
    `ALTER TABLE posts ADD COLUMN once INTEGER NOT NULL DEFAULT 0`
  ]
];
var checked = false;
async function ensureSchema(db) {
  if (checked) return;
  await migrate(db);
  checked = true;
}
async function migrate(db) {
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

// src/tg.js
function makeTg({ token, root, fetchFn, relayKey }) {
  const base = (root || "https://api.telegram.org").replace(/\/$/, "");
  const f = fetchFn || ((...a) => fetch(...a));
  const tg = {
    calls: 0,
    async call(method, params) {
      tg.calls++;
      const res = await f(`${base}/bot${token}/${method}`, {
        method: "POST",
        headers: relayKey ? { "content-type": "application/json", "x-relay-key": relayKey } : { "content-type": "application/json" },
        body: JSON.stringify(params || {})
      });
      let j3;
      try {
        j3 = await res.json();
      } catch {
        j3 = { ok: false, error_code: res.status, description: "bad response" };
      }
      if (!j3.ok) {
        const e = new Error(j3.description || "telegram error");
        e.code = j3.error_code;
        e.retryAfter = j3.parameters && j3.parameters.retry_after;
        throw e;
      }
      return j3.result;
    },
    // загрузка файла (картинка из панели): multipart вместо JSON
    async upload(method, form) {
      tg.calls++;
      const res = await f(`${base}/bot${token}/${method}`, { method: "POST", headers: relayKey ? { "x-relay-key": relayKey } : {}, body: form });
      const j3 = await res.json().catch(() => ({ ok: false, description: "bad response" }));
      if (!j3.ok) {
        const e = new Error(j3.description || "telegram error");
        e.code = j3.error_code;
        throw e;
      }
      return j3.result;
    },
    // скачать файл по file_id (превью картинки в панели)
    async download(fileId) {
      const file = await tg.call("getFile", { file_id: fileId });
      return f(`${base}/file/bot${token}/${file.file_path}`, { headers: relayKey ? { "x-relay-key": relayKey } : {} });
    }
  };
  return tg;
}

// src/time.js
var MSK = 3 * 3600;
var DAY = 86400;
var nowSec = () => Math.floor(Date.now() / 1e3);
function parseTime(s) {
  const m = /^\s*(\d{1,2})[:.](\d{2})\s*$/.exec(s || "");
  if (!m) return null;
  const h = +m[1], mi = +m[2];
  if (h > 23 || mi > 59) return null;
  return h * 3600 + mi * 60;
}
var fmtTime = (sec) => `${String(Math.floor(sec / 3600)).padStart(2, "0")}:${String(Math.floor(sec % 3600 / 60)).padStart(2, "0")}`;
function parseWhen(s, now = nowSec()) {
  const str = (s || "").trim().toLowerCase();
  const mskNow = new Date((now + MSK) * 1e3);
  let y = mskNow.getUTCFullYear(), mo = mskNow.getUTCMonth() + 1, d = mskNow.getUTCDate(), rest = str, yearGiven = false;
  let m = /^(сегодня|завтра)\s+(.+)$/.exec(str);
  if (m) {
    if (m[1] === "завтра") {
      const t2 = new Date(Date.UTC(y, mo - 1, d + 1));
      y = t2.getUTCFullYear();
      mo = t2.getUTCMonth() + 1;
      d = t2.getUTCDate();
    }
    rest = m[2];
  } else {
    m = /^(\d{1,2})\.(\d{1,2})(?:\.(\d{2,4}))?\s+(.+)$/.exec(str);
    if (!m) return null;
    d = +m[1];
    mo = +m[2];
    if (m[3]) {
      y = +m[3] < 100 ? 2e3 + +m[3] : +m[3];
      yearGiven = true;
    }
    rest = m[4];
  }
  const t = parseTime(rest);
  if (t === null || mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  let ts = Date.UTC(y, mo - 1, d) / 1e3 + t - MSK;
  if (!yearGiven && ts < now - DAY) ts = Date.UTC(y + 1, mo - 1, d) / 1e3 + t - MSK;
  return ts;
}
function fmtWhen(ts) {
  const x = new Date((ts + MSK) * 1e3);
  const p = (n) => String(n).padStart(2, "0");
  return `${p(x.getUTCDate())}.${p(x.getUTCMonth() + 1)}.${x.getUTCFullYear()} ${p(x.getUTCHours())}:${p(x.getUTCMinutes())}`;
}

// src/texts.js
var ZONES = {
  B: "Визуальная база",
  P: "Портфолио",
  V: "Видимость",
  S: "Цена и продажа",
  C: "Работа с клиентом",
  I: "Внутренние блоки",
  T: "Скорость: Figma и ИИ",
  top: "Явных утечек нет"
};
var LEVELS = { start: "начинающий", pro: "продолжающий" };
var AUD = { all: "всем", start: "начинающим", pro: "продолжающим" };
var T = {
  hello: (name) => `Привет${name ? ", " + name : ""}! Это бот Di Sign University 🐾

Здесь будут полезные материалы для дизайнеров и новости об обучении.`,
  helloFromTest: (name, zone) => `Привет${name ? ", " + name : ""}! Вижу, аудит пройден 🐾
` + (zone && zone !== "top" ? `Главная зона роста — «${ZONES[zone]}». Подарок под неё уже готов.` : `Явных утечек нет, и подарок для тебя уже готов.`),
  consentPd: (policyUrl, consentUrl) => `Чтобы присылать материалы, нам нужно твоё согласие на обработку персональных данных (имя и id в Telegram, ответы на вопросы бота).

Политика обработки данных: ${policyUrl || "— ссылка появится перед запуском —"}
Текст согласия: ${consentUrl || "— ссылка появится перед запуском —"}`,
  consentPdBtn: "Даю согласие",
  consentPdNo: "Без согласия мы не сможем присылать материалы. Если передумаешь — нажми /start.",
  askLevel: "Где ты сейчас в дизайне?",
  levelBtnStart: "Начинаю, хочу зайти в дизайн",
  levelBtnPro: "Уже есть знания и заказы",
  testOffer: (hasUrl) => `У нас есть аудит-тест для дизайнеров 🐾

Он покажет твои сильные и слабые стороны и сразу после прохождения соберёт план: что прокачать в первую очередь.

В конце теста нажми «Забрать материал» — вернёшься сюда, и бот пришлёт подарок под твой результат.` + (hasUrl ? "" : `

Ссылка на тест появится здесь совсем скоро.`),
  testBtn: "Пройти тест",
  noGift: "Подарок скоро появится здесь 🎁",
  consentAds: `Хочешь получать полезные материалы по расписанию и новости об обучении Di Sign University?

Это рекламная рассылка. Отписаться можно в любой момент командой /stop.`,
  consentAdsYes: "Да, присылай",
  consentAdsNo: "Нет, спасибо",
  adsYes: "Готово! Материалы будут приходить сюда ✨",
  adsNo: "Хорошо, рассылки не будет. Если передумаешь — /start.",
  stopped: "Рассылка отключена. Вернуться: /start.",
  levelChanged: (lv) => `Готово, уровень: ${LEVELS[lv]}. Материалы будут приходить под него.`,
  deleteAsk: "Удалить все твои данные из бота? Рассылка остановится, отменить это нельзя.",
  deleteYes: "Удалить",
  deleteNo: "Отмена",
  deleted: "Данные удалены. Спасибо, что были с нами 🐾",
  policy: (policyUrl, offerUrl, owner) => `Политика обработки данных: ${policyUrl || "— скоро —"}
Оферта: ${offerUrl || "— скоро —"}
${owner || ""}`.trim(),
  unknown: "Я бот с материалами 🐾 Команды: /level — сменить уровень, /stop — отписаться, /policy — документы, /delete — удалить данные.",
  buttonsArrow: "👇"
};
var USER_COMMANDS = [
  { command: "start", description: "Начать" },
  { command: "level", description: "Сменить уровень" },
  { command: "stop", description: "Отписаться от рассылки" },
  { command: "policy", description: "Документы" },
  { command: "delete", description: "Удалить мои данные" }
];
var ADMIN_COMMANDS = [
  { command: "admin", description: "Панель: лента, порядок, тексты" },
  { command: "new", description: "Новый пост" },
  { command: "texts", description: "Тексты бота" },
  { command: "posts", description: "Все посты" },
  { command: "stats", description: "Статистика" },
  { command: "admins", description: "Админы" },
  { command: "check", description: "Проверка бота" },
  { command: "cancel", description: "Отменить действие" },
  { command: "help", description: "Помощь для админа" },
  ...USER_COMMANDS
];

// src/msgs.js
var MSG_GROUPS = [
  ["hello", "👋 Приветствие"],
  ["consent", "✅ Согласие на данные"],
  ["level", "🎚 Уровень"],
  ["test", "🧪 Аудит-тест и подарок"],
  ["ads", "📬 Согласие на рассылку"],
  ["cmd", "⚙️ Команды ученика"],
  ["profile", "🤖 Профиль бота и меню команд"]
];
var MSG = {
  hello: [
    "hello",
    "Приветствие (пришёл без теста)",
    "Привет, {имя}! Это бот Di Sign University 🐾\n\nЗдесь будут полезные материалы для дизайнеров и новости об обучении.",
    ["имя"]
  ],
  helloTest: [
    "hello",
    "Приветствие (пришёл из теста)",
    "Привет, {имя}! Вижу, аудит пройден 🐾\nПодарок по итогам теста уже готов.",
    ["имя"]
  ],
  consentPd: [
    "consent",
    "Просьба о согласии на обработку данных",
    "Чтобы присылать материалы, нам нужно твоё согласие на обработку персональных данных (имя и id в Telegram, ответы на вопросы бота).\n\nПолитика обработки данных: {политика}\nТекст согласия: {согласие}",
    ["политика", "согласие"]
  ],
  consentPdBtn: ["consent", "Кнопка согласия", "Даю согласие", [], true],
  consentThanks: ["consent", "Всплывающее «спасибо» после согласия", "Спасибо! ✅", []],
  askLevel: ["level", "Вопрос про уровень", "Где ты сейчас в дизайне?", []],
  levelBtnStart: ["level", "Кнопка «начинающий»", "Начинаю, хочу зайти в дизайн", [], true],
  levelBtnPro: ["level", "Кнопка «продолжающий»", "Уже есть знания и заказы", [], true],
  levelChanged: ["level", "Ответ после смены уровня (/level)", "Готово, уровень: {уровень}. Материалы будут приходить под него.", ["уровень"]],
  testOffer: [
    "test",
    "Предложение пройти тест",
    "У нас есть аудит-тест для дизайнеров 🐾\n\nОн покажет твои сильные и слабые стороны и сразу после прохождения соберёт план: что прокачать в первую очередь.\n\nВ конце теста нажми «Забрать материал» — вернёшься сюда, и бот пришлёт подарок под твой результат.",
    []
  ],
  testBtn: ["test", "Кнопка «Пройти тест»", "Пройти тест", [], true],
  noGift: ["test", "Если подарок ещё не загружен", "Подарок скоро появится здесь 🎁", []],
  consentAds: [
    "ads",
    "Вопрос про рассылку",
    "Хочешь получать полезные материалы по расписанию и новости об обучении Di Sign University?\n\nЭто рекламная рассылка. Отписаться можно в любой момент командой /stop.",
    []
  ],
  consentAdsYes: ["ads", "Кнопка «да»", "Да, присылай", [], true],
  consentAdsNo: ["ads", "Кнопка «нет»", "Нет, спасибо", [], true],
  adsYes: ["ads", "Ответ на «да»", "Готово! Материалы будут приходить сюда ✨", []],
  adsNo: ["ads", "Ответ на «нет»", "Хорошо, рассылки не будет. Если передумаешь — /start.", []],
  buttonsArrow: ["ads", "Подпись над кнопками под альбомом", "👇", []],
  stopped: ["cmd", "/stop — отписка", "Рассылка отключена. Вернуться: /start.", []],
  policy: ["cmd", "/policy — документы", "Политика обработки данных: {политика}\nОферта: {оферта}\n{владелец}", ["политика", "оферта", "владелец"]],
  deleteAsk: ["cmd", "/delete — вопрос", "Удалить все твои данные из бота? Рассылка остановится, отменить это нельзя.", []],
  deleteYes: ["cmd", "/delete — кнопка «удалить»", "Удалить", [], true],
  deleteNo: ["cmd", "/delete — кнопка «отмена»", "Отмена", [], true],
  deleted: ["cmd", "/delete — данные удалены", "Данные удалены. Спасибо, что были с нами 🐾", []],
  deleteCancel: ["cmd", "/delete — отмена (всплывающее)", "Ок, ничего не удаляем.", []],
  needStart: ["cmd", "Если человек не нажал /start", "Нажми /start 🐾", []],
  payLater: ["cmd", "Кнопка «оплатить», пока оплата не подключена (всплывашка)", "Оплата откроется в день продаж — анонс придёт сюда, в бот 🐾", []],
  unknown: [
    "cmd",
    "Ответ на непонятное сообщение",
    "Я бот с материалами 🐾 Команды: /level — сменить уровень, /stop — отписаться, /policy — документы, /delete — удалить данные.",
    []
  ],
  // профиль бота: применяются в Telegram сразу после сохранения
  botDesc: ["profile", "Описание до кнопки «Старт» (что умеет бот)", "", []],
  botShort: ["profile", "Короткое описание в профиле бота", "", []],
  ...Object.fromEntries(USER_COMMANDS.map((c) => ["cmd_" + c.command, ["profile", "Меню команд: /" + c.command, c.description, []]]))
};
var PROFILE_LIMIT = { botDesc: 512, botShort: 120 };
var isProfile = (key) => MSG[key] && MSG[key][0] === "profile";
var limitOf = (key) => PROFILE_LIMIT[key] || (key.startsWith("cmd_") ? 256 : null);
var msgInfo = (key) => {
  const m = MSG[key];
  if (!m) return null;
  const plain = !!m[4] || m[0] === "profile";
  return { key, group: m[0], title: m[1], def: m[2], vars: plain ? m[3] : [.../* @__PURE__ */ new Set(["имя", ...m[3]])], button: !!m[4], plain, limit: m[4] ? 64 : limitOf(key) };
};
async function loadMsgs(ctx) {
  if (ctx._msgs) return ctx._msgs;
  const rows = await ctx.db.all(`SELECT key, value FROM settings WHERE key LIKE 'msg:%' OR key LIKE 'msgx:%'`);
  const o = {}, x = {};
  for (const r of rows) {
    try {
      if (r.key.startsWith("msgx:")) x[r.key.slice(5)] = JSON.parse(r.value);
      else o[r.key.slice(4)] = JSON.parse(r.value);
    } catch {
    }
  }
  ctx._msgs = o;
  ctx._msgx = x;
  return o;
}
var DEFAULT_DELAY = { hello: 0.6, helloTest: 0.6, consentPd: 0.9, askLevel: 0.7, testOffer: 0.8, noGift: 0.8, consentAds: 1.2, adsYes: 0.5, adsNo: 0.5, levelChanged: 0.5 };
async function extraOf(ctx, key) {
  await loadMsgs(ctx);
  return ctx._msgx && ctx._msgx[key] || {};
}
async function delayOf(ctx, key) {
  const x = await extraOf(ctx, key);
  return typeof x.delay === "number" ? x.delay : DEFAULT_DELAY[key] ?? 0.7;
}
async function linksOf(ctx, key) {
  return (await extraOf(ctx, key)).links || [];
}
function cleanRows(rows) {
  if (!Array.isArray(rows) || rows.length > 10) throw new Error("Слишком много рядов (до 10)");
  const out = [];
  for (const row of rows) {
    if (!Array.isArray(row)) throw new Error("Неверные кнопки");
    const r = [];
    for (const b of row) {
      const text = String(b && b.text || "").trim().slice(0, 60);
      let link = String(b && b.url || "").trim();
      if (!text && !link) continue;
      if (!text) throw new Error("У кнопки нет текста");
      if (/^t\.me\//i.test(link)) link = "https://" + link;
      if (!/^https?:\/\/\S+$/i.test(link)) throw new Error(`Ссылка у кнопки «${text}» должна начинаться с https://`);
      r.push({ text, url: link });
    }
    if (r.length > 4) throw new Error("В одном ряду не больше 4 кнопок");
    if (r.length) out.push(r);
  }
  return out;
}
async function saveMsgExtra(ctx, key, { delay, links } = {}) {
  const i = msgInfo(key);
  if (!i || i.button || i.plain) throw new Error("Для этого сообщения пауза и кнопки не настраиваются");
  const x = { ...await extraOf(ctx, key) };
  if (delay !== void 0) {
    const d = Number(delay);
    if (!(d >= 0 && d <= 30)) throw new Error("Пауза — от 0 до 30 секунд");
    x.delay = Math.round(d * 10) / 10;
  }
  if (links !== void 0) x.links = cleanRows(links);
  await ctx.db.run(`INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`, ["msgx:" + key, JSON.stringify(x)]);
  if (ctx._msgx) ctx._msgx[key] = x;
  return x;
}
function fill(text, entities, vars) {
  let t = text;
  let ents = (entities || []).map((e) => ({ ...e }));
  const re = /\{([а-яёa-z_]+)\}/gi;
  const hits = [];
  let m;
  while (m = re.exec(text)) if (vars && Object.prototype.hasOwnProperty.call(vars, m[1].toLowerCase())) hits.push([m.index, m[0].length, String(vars[m[1].toLowerCase()] ?? "")]);
  for (let k = hits.length - 1; k >= 0; k--) {
    const [i, len, val] = hits[k];
    const d = val.length - len;
    t = t.slice(0, i) + val + t.slice(i + len);
    ents = ents.map((e) => {
      if (e.offset >= i + len) return { ...e, offset: e.offset + d };
      if (e.offset <= i && e.offset + e.length >= i + len) return { ...e, length: e.length + d };
      return e;
    });
  }
  return { text: t, entities: ents.filter((e) => e.length > 0) };
}
async function msg(ctx, key, vars) {
  const all = await loadMsgs(ctx);
  const o = all[key];
  if (isProfile(key) && !(o && o.text)) return { text: await liveProfile(ctx, key), entities: [] };
  const base = o && (o.text || o.media) ? o : { text: MSG[key] ? MSG[key][2] : key, entities: [] };
  const out = fill(base.text || "", base.entities, { имя: ctx.userName || "друг", ...vars || {} });
  if (base.media && base.media.file_id) out.media = base.media;
  return out;
}
async function btn(ctx, key, vars) {
  return (await msg(ctx, key, vars)).text.slice(0, 64);
}
var MEDIA_METHOD = { photo: "sendPhoto", video: "sendVideo", animation: "sendAnimation" };
var CAPTION_MAX = 1024;
async function withEmojiFallback(send, ents) {
  try {
    return await send(ents);
  } catch (e) {
    if (e.code === 400 && (ents || []).some((x) => x.type === "custom_emoji")) return send(ents.filter((x) => x.type !== "custom_emoji"));
    throw e;
  }
}
async function say(ctx, chatId, key, vars, extra = {}) {
  const m = await msg(ctx, key, vars);
  const links = await linksOf(ctx, key);
  if (links.length) extra = { ...extra, reply_markup: { inline_keyboard: [...extra.reply_markup && extra.reply_markup.inline_keyboard || [], ...links] } };
  const ents = m.entities.length ? m.entities : void 0;
  if (m.media) {
    const { link_preview_options, reply_markup, ...rest } = extra;
    const method = MEDIA_METHOD[m.media.type] || "sendPhoto";
    const field = MEDIA_METHOD[m.media.type] ? m.media.type : "photo";
    const fits = (m.text || "").length <= CAPTION_MAX;
    const first = await withEmojiFallback((e) => ctx.tg.call(method, {
      chat_id: chatId,
      [field]: m.media.file_id,
      ...rest,
      ...fits && m.text ? { caption: m.text, ...e && e.length ? { caption_entities: e } : {} } : {},
      ...fits && reply_markup ? { reply_markup } : {}
    }), ents);
    if (fits) return first;
    const second = await withEmojiFallback((e) => ctx.tg.call("sendMessage", { chat_id: chatId, text: m.text, ...e && e.length ? { entities: e } : {}, ...extra }), ents);
    return { ...second, also: [first.message_id] };
  }
  return withEmojiFallback((e) => ctx.tg.call("sendMessage", { chat_id: chatId, text: m.text || "…", ...extra, ...e && e.length ? { entities: e } : {} }), ents);
}
async function saveMsg(ctx, key, text, entities, media) {
  const info = msgInfo(key);
  if (!info) throw new Error("нет такого сообщения");
  let v;
  if (info.button) v = { text: String(text).replace(/\s+/g, " ").trim().slice(0, 64), entities: [] };
  else if (info.plain) {
    const t = String(text).trim();
    if (info.limit && t.length > info.limit) throw new Error(`Telegram разрешает до ${info.limit} знаков, сейчас ${t.length}`);
    if (key.startsWith("cmd_") && t.length < 3) throw new Error("Подпись команды — хотя бы 3 знака");
    v = { text: t, entities: [] };
  } else v = { text: String(text), entities: entities || [] };
  if (!info.plain && !info.button) {
    const prev = (await loadMsgs(ctx))[key];
    const md = media === void 0 ? prev && prev.media : media;
    if (md) v.media = md;
    if ((v.text || "").length > 4e3) throw new Error("Слишком длинно для Telegram");
  }
  if (isProfile(key)) await rememberOriginal(ctx, key);
  await ctx.db.run(`INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`, ["msg:" + key, JSON.stringify(v)]);
  if (ctx._msgs) ctx._msgs[key] = v;
  if (isProfile(key)) await applyProfile(ctx, key);
  return v;
}
async function setMsgMedia(ctx, key, media) {
  const info = msgInfo(key);
  if (!info || info.button || info.plain) throw new Error("К этому сообщению картинку не прикрепить");
  const o = (await loadMsgs(ctx))[key];
  return saveMsg(ctx, key, o ? o.text : info.def, o ? o.entities : [], media || null);
}
var canMedia = (key) => {
  const i = msgInfo(key);
  return !!(i && !i.button && !i.plain);
};
async function resetMsg(ctx, key) {
  await ctx.db.run(`DELETE FROM settings WHERE key = ?`, ["msg:" + key]);
  if (ctx._msgs) delete ctx._msgs[key];
  if (isProfile(key)) await applyProfile(ctx, key);
}
async function liveProfile(ctx, key) {
  try {
    if (key === "botDesc") return (await ctx.tg.call("getMyDescription", {})).description || "";
    if (key === "botShort") return (await ctx.tg.call("getMyShortDescription", {})).short_description || "";
  } catch {
  }
  return MSG[key] ? MSG[key][2] : "";
}
async function rememberOriginal(ctx, key) {
  if (key !== "botDesc" && key !== "botShort") return;
  const has = await ctx.db.first(`SELECT 1 FROM settings WHERE key = ?`, ["orig:" + key]);
  if (has) return;
  const all = await loadMsgs(ctx);
  if (all[key]) return;
  await ctx.db.run(`INSERT INTO settings (key, value) VALUES (?, ?)`, ["orig:" + key, await liveProfile(ctx, key)]);
}
async function profileText(ctx, key) {
  const all = await loadMsgs(ctx);
  if (all[key] && all[key].text) return all[key].text;
  const o = await ctx.db.first(`SELECT value FROM settings WHERE key = ?`, ["orig:" + key]);
  return o ? o.value : MSG[key] ? MSG[key][2] : "";
}
async function userCommands(ctx) {
  const all = await loadMsgs(ctx);
  return USER_COMMANDS.map((c) => ({ command: c.command, description: all["cmd_" + c.command] && all["cmd_" + c.command].text || c.description }));
}
async function adminCommands(ctx) {
  const userSet = new Set(USER_COMMANDS.map((c) => c.command));
  return [...ADMIN_COMMANDS.filter((c) => !userSet.has(c.command)), ...await userCommands(ctx)];
}
async function applyProfile(ctx, key) {
  if (key === "botDesc") return ctx.tg.call("setMyDescription", { description: await profileText(ctx, key) });
  if (key === "botShort") return ctx.tg.call("setMyShortDescription", { short_description: await profileText(ctx, key) });
  if (key.startsWith("cmd_")) {
    await ctx.tg.call("setMyCommands", { commands: await userCommands(ctx) });
    const env = String(ctx.env.ADMIN_IDS || "").split(/[\s,;]+/).filter(Boolean).map(Number);
    const extra = (await ctx.db.all(`SELECT tg_id FROM admins`)).map((r) => r.tg_id);
    const ac = await adminCommands(ctx);
    for (const a of /* @__PURE__ */ new Set([...env, ...extra])) await ctx.tg.call("setMyCommands", { commands: ac, scope: { type: "chat", chat_id: a } }).catch(() => {
    });
  }
}
async function listMsgs(ctx) {
  const all = await loadMsgs(ctx);
  return Promise.all(Object.keys(MSG).map((k) => {
    const i = msgInfo(k);
    const o = all[k];
    const x = ctx._msgx && ctx._msgx[k] || {};
    return { ...i, delay: typeof x.delay === "number" ? x.delay : DEFAULT_DELAY[k] ?? 0.7, defDelay: DEFAULT_DELAY[k] ?? 0.7, links: x.links || [], text: o ? o.text : i.def, changed: !!o, media: o && o.media ? o.media.type : null, canMedia: !i.button && !i.plain, emoji: !!(o && (o.entities || []).some((e) => e.type === "custom_emoji")) };
  }).map(async (m) => m.group === "profile" && !m.changed && (m.key === "botDesc" || m.key === "botShort") ? { ...m, text: await liveProfile(ctx, m.key), def: "(как задано в BotFather)" } : m));
}

// src/posts.js
var CAPTION_MAX2 = 1024;
var j = (s, d) => {
  try {
    return s ? JSON.parse(s) : d;
  } catch {
    return d;
  }
};
var DOCS = { policy: "Политика обработки данных", consent: "Согласие на обработку данных", offer: "Оферта" };
function keyboard(post, uid, publicUrl, docs) {
  const rows = j(post.buttons, []);
  if (!rows.length) return void 0;
  const out = rows.map((row, ri) => row.map((b, bi) => {
    if (b.go) return { text: b.text, callback_data: post.id ? `go:${post.id}:${ri}-${bi}` : "go:x" };
    if (b.pay) return { text: b.text, callback_data: post.id ? `buy:${post.id}:${ri}-${bi}` : "buy:x" };
    if (b.doc) {
      const u = docs && docs[b.doc];
      return u ? { text: b.text, url: u } : null;
    }
    return { text: b.text, url: publicUrl && post.id ? `${publicUrl}/r/${post.id}/${ri}-${bi}/${uid || 0}` : b.url };
  }).filter(Boolean)).filter((r) => r.length);
  return out.length ? { inline_keyboard: out } : void 0;
}
var stripCustom = (ents) => (ents || []).filter((e) => e.type !== "custom_emoji");
var hasCustom = (ents) => (ents || []).some((e) => e.type === "custom_emoji");
async function sendPost(tg, chatId, post, { uid, publicUrl, arrow, docs } = {}) {
  const text = post.text || "";
  const ents = j(post.entities, []);
  const media = j(post.media, []);
  const kb3 = keyboard(post, uid, publicUrl, docs);
  let warn = null;
  const attempt = async (entities) => {
    if (!media.length) {
      await tg.call("sendMessage", { chat_id: chatId, text: text || "…", entities, reply_markup: kb3, link_preview_options: { is_disabled: true } });
      return;
    }
    const fits = text.length <= CAPTION_MAX2;
    if (media.length === 1) {
      const m = media[0];
      const method = { photo: "sendPhoto", video: "sendVideo", document: "sendDocument", animation: "sendAnimation" }[m.type] || "sendDocument";
      const p = { chat_id: chatId, [m.type in { photo: 1, video: 1, document: 1, animation: 1 } ? m.type : "document"]: m.file_id };
      if (fits) {
        p.caption = text;
        p.caption_entities = entities;
        p.reply_markup = kb3;
      }
      await tg.call(method, p);
      if (!fits) await tg.call("sendMessage", { chat_id: chatId, text, entities, reply_markup: kb3, link_preview_options: { is_disabled: true } });
      return;
    }
    const group = media.slice(0, 10).map((m, i) => {
      const it = { type: m.type === "animation" ? "video" : m.type, media: m.file_id };
      if (i === 0 && fits && text) {
        it.caption = text;
        it.caption_entities = entities;
      }
      return it;
    });
    await tg.call("sendMediaGroup", { chat_id: chatId, media: group });
    if (!fits) await tg.call("sendMessage", { chat_id: chatId, text, entities, reply_markup: kb3, link_preview_options: { is_disabled: true } });
    else if (kb3) await tg.call("sendMessage", { chat_id: chatId, text: post.btn_text || arrow || T.buttonsArrow, reply_markup: kb3 });
  };
  try {
    await attempt(ents);
  } catch (e) {
    if (hasCustom(ents) && e.code === 400) {
      await attempt(stripCustom(ents));
      warn = "Премиум-эмодзи не прошли и были заменены обычными: " + e.message;
    } else throw e;
  }
  return { warn };
}
function audienceSql(post) {
  let c = "";
  const p = [];
  if (post.audience === "start") c += ` AND u.level = 'start'`;
  else if (post.audience === "pro") c += ` AND u.level = 'pro'`;
  return { c, p };
}
var BASE = `u.status = 'active' AND u.consent_ads_at IS NOT NULL AND u.joined_at IS NOT NULL AND u.paid_at IS NULL`;
var NOT_SENT = `NOT EXISTS (SELECT 1 FROM deliveries d WHERE d.post_id = ? AND d.tg_id = u.tg_id)`;
function dueSql(post) {
  const delay = (Number(post.delay_min) || 0) * 60;
  if (post.mode === "timer") return `(u.joined_at + ${delay})`;
  if (post.mode === "after") return `((SELECT d2.sent_at FROM deliveries d2 WHERE d2.post_id = ${Number(post.after_id) || 0} AND d2.tg_id = u.tg_id AND d2.ok = 1) + ${delay})`;
  const tod = timeSec(post.send_time);
  return Number(post.day) === 0 ? `u.joined_at` : `(((u.joined_at + ${MSK}) / ${DAY}) * ${DAY} - ${MSK} + ${Number(post.day) * DAY} + ${tod})`;
}
function timeSec(s) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(s || "11:00");
  return m ? +m[1] * 3600 + +m[2] * 60 : 11 * 3600;
}
async function dueUsers(db, post, now, limit) {
  const a = audienceSql(post);
  if (post.kind === "drip") {
    const due = dueSql(post);
    const catchup = post.catchup ? "" : ` AND ${due} >= ?`;
    const params = [...a.p, now, post.id, ...post.catchup ? [] : [post.created_at], limit];
    return db.all(
      `SELECT u.tg_id FROM users u WHERE ${BASE}${a.c} AND ${due} <= ? AND ${NOT_SENT}${catchup} ORDER BY u.joined_at LIMIT ?`,
      params
    );
  }
  if (post.kind === "date") {
    const params = [...a.p, post.id, post.run_at, limit];
    return db.all(`SELECT u.tg_id FROM users u WHERE ${BASE}${a.c} AND ${NOT_SENT} AND u.joined_at <= ? ORDER BY u.joined_at LIMIT ?`, params);
  }
  return [];
}
async function audienceCount(db, post) {
  const a = audienceSql(post);
  const r = await db.first(`SELECT COUNT(*) AS n FROM users u WHERE ${BASE}${a.c}`, a.p);
  return r ? r.n : 0;
}
async function recordDeliveries(db, postId, rows, now) {
  if (!rows.length) return;
  const vals = rows.map(() => "(?, ?, ?, ?)").join(", ");
  const params = [];
  rows.forEach((r) => params.push(postId, r.tg_id, now, r.ok ? 1 : 0));
  await db.run(`INSERT OR IGNORE INTO deliveries (post_id, tg_id, sent_at, ok) VALUES ${vals}`, params);
}
function postLabel(p) {
  const t = (p.title || p.text || "").replace(/\s+/g, " ").trim().slice(0, 38) || "без текста";
  const media = j(p.media, []);
  const ic = media.length > 1 ? `🖼×${media.length} ` : media.length ? "🖼 " : "";
  return `${ic}${t}`;
}
function postWhen(p) {
  if (p.kind === "gift") return "подарок после теста";
  if (p.kind === "node") return "по нажатию кнопки";
  if (p.kind === "date") return p.run_at ? `дата ${fmtWhen(p.run_at)}` : "дата не задана";
  if (p.mode === "timer") return `через ${fmtDelay(p.delay_min)} после входа`;
  if (p.mode === "after") return `через ${fmtDelay(p.delay_min)} после поста #${p.after_id}`;
  return Number(p.day) === 0 ? "день 0 · сразу" : `день ${p.day} · ${p.send_time}`;
}
function postSummary(p) {
  const st = { draft: "📝 черновик", active: "✅ включён", paused: "⏸ на паузе", archived: "🗄 в архиве" }[p.status] || p.status;
  const btns = j(p.buttons, []).flat().length;
  return [
    `#${p.id} · ${st}`,
    `Когда: ${postWhen(p)}`,
    ...p.kind === "node" ? [] : [`Кому: ${AUD[p.audience] || p.audience}`],
    `Кнопок: ${btns}${p.kind === "drip" ? ` · догонять опоздавших: ${p.catchup ? "да" : "нет"}` : ""}`
  ].join("\n");
}
function fmtDelay(min) {
  const m = Number(min) || 0;
  if (m === 0) return "0 мин (сразу)";
  const d = Math.floor(m / 1440), h = Math.floor(m % 1440 / 60), mm = m % 60;
  return [d ? d + " дн" : "", h ? h + " ч" : "", mm ? mm + " мин" : ""].filter(Boolean).join(" ");
}
function offsetMin(p, byId, depth = 0) {
  if (!p || depth > 20) return 0;
  if (p.mode === "timer") return Number(p.delay_min) || 0;
  if (p.mode === "after") return offsetMin(byId[p.after_id], byId, depth + 1) + (Number(p.delay_min) || 0);
  const day = Number(p.day) || 0;
  if (day === 0) return 0;
  const t = timeSec(p.send_time) / 60;
  return day * 1440 + t - 600;
}
async function loadDocs(ctx) {
  if (ctx._docs) return ctx._docs;
  const rows = await ctx.db.all(`SELECT key, value FROM settings WHERE key LIKE 'doc:%'`);
  const o = Object.fromEntries(rows.map((r) => [r.key.slice(4), r.value]));
  const env = ctx.env || {};
  ctx._docs = {
    policy: o.policy || env.POLICY_URL || "",
    consent: o.consent || env.CONSENT_URL || "",
    offer: o.offer || env.OFFER_URL || "",
    owner: o.owner || env.OWNER_INFO || ""
  };
  return ctx._docs;
}

// src/guide.js
var GUIDE_MENU = [
  ["start", "🚀 Первый пост за 2 минуты"],
  ["how", "🧭 Как устроен бот"],
  ["post", "✍️ Как сделать красивый пост"],
  ["manage", "🗂 Управление постами"],
  ["panel", "🧩 Панель: как двигать посты"],
  ["msgs", "✏️ Тексты бота: как поменять"],
  ["plan", "📅 Что выкладывать: план прогрева"],
  ["texts", "💬 Примеры постов"],
  ["stats", "📊 Статистика и проверка"],
  ["rules", "⚖️ Важно: правила и безопасность"]
];
var GUIDE = {
  menu: `<b>Памятка админа Di Sign University 🐾</b>

Здесь всё о боте: как он работает, как делать посты и что выкладывать. Выбери раздел.

Быстрые команды: /admin — панель · /texts — тексты бота · /new — пост · /posts — все посты · /stats — цифры · /check — проверка · /cancel — отменить`,
  start: `<b>🚀 Первый пост за 2 минуты</b>

1. Отправь /new
2. Пришли пост как обычное сообщение: текст, картинку или альбом. Премиум-эмодзи и жирный шрифт сохранятся.
3. Нажми <b>Готово ➜</b>
4. Выбери, когда: <i>через N дней после входа</i>, <i>в дату и время</i> или <i>подарок после теста</i>
5. Кому: всем / начинающим / продолжающим
6. Кнопки: <code>Текст | https://ссылка</code> или «Без кнопок»
7. Посмотри предпросмотр — так увидят ученики — и нажми <b>Сохранить и включить</b>

Не уверена — сохрани черновиком: он никому не уйдёт, пока не включишь в /posts.
Запуталась на любом шаге — /cancel.`,
  how: `<b>🧭 Как устроен бот</b>

<b>Путь ученика</b>
1. Проходит тест на сайте и жмёт «Забрать материал» — бот узнаёт из ссылки, что тест пройден, и уровень.
2. Даёт согласие на обработку данных — без него бот ничего не присылает.
3. Сразу получает <b>подарок</b> после теста.
4. Отдельно соглашается на рассылку — с этой минуты для него идёт <b>лента</b>.

<b>Если пришёл без теста</b>: бот спросит только уровень и предложит пройти аудит-тест (кнопка «Пройти тест»). Слабые места в боте не спрашиваем — их показывает сам тест. Подарок придёт, когда человек пройдёт тест и вернётся по кнопке; лента идёт в любом случае.

В боте делим людей только на <b>начинающих</b> и <b>продолжающих</b> — отдельных постов под слабые места из теста нет.

<b>Уровни</b>
• начинающие — в тесте «учусь, хочу к первым клиентам»
• продолжающие — «беру небольшие заказы» и «работаю давно»

<b>Три вида постов</b>
• <b>через N дней</b> — у каждого свой отсчёт от входа. День 0 — сразу, день 1 — на следующий день в выбранное время по Москве.
• <b>в дату</b> — один раз всем подходящим, кто уже в боте. Тем, кто придёт позже, не уйдёт.
• <b>подарок</b> — сразу после теста (всем, начинающим или продолжающим).

<b>Кто не получает рассылку</b>: кто отписался (/stop), заблокировал бота, не дал согласие, уже оплатил курс.

<b>Чистый чат</b>: бот пишет постепенно: перед каждым сообщением «печатает…» и пузырёк с точками • • • прямо в чате, а служебные сообщения — согласия, вопрос про уровень, вопрос про рассылку — исчезают, как только человек нажал кнопку. Предложение пройти тест исчезает, когда человек вернулся из теста. В чате остаются приветствие, подарок и материалы.

Бот проверяет расписание раз в минуту и рассылает пачками — большая рассылка может идти несколько минут, это нормально.`,
  post: `<b>✍️ Как сделать красивый пост</b>

<b>Текст.</b> Пиши прямо в боте. Жирный, курсив, ссылки, премиум-эмодзи — всё сохранится.

<b>Картинки.</b> Одна картинка + текст до 1024 знаков = подпись под картинкой, кнопки прямо на ней. Текст длиннее — уйдёт отдельным сообщением под картинкой.

<b>Альбом</b> (2–10 фото/видео): отправь одним альбомом, подпись станет текстом поста. Кнопки к альбому Telegram прикрепить не даёт — бот пришлёт их следующим сообщением сразу под ним.
Нельзя смешивать в одном альбоме файлы (PDF) с фото — Telegram не примет.

<b>Файлы</b> (PDF, Figma-ссылки): PDF можно прислать как файл. Для Figma, таблиц и папок лучше кнопка-ссылка.

<b>Кнопки</b>: по строке на ряд
<code>Скачать чек-лист | https://…
Эфир | https://…; Курс | https://…</code>
Через «;» — несколько кнопок в один ряд (до 4). Бот считает нажатия.

<b>Совет:</b> первая строка поста — главная мысль, она видна в уведомлении. Одна кнопка с понятным действием работает лучше трёх.`,
  manage: `<b>🗂 Управление постами — /posts и /admin</b>

<b>Панель /admin</b> — самое удобное: лента по дням, посты перетаскиваются за ⋮⋮ на другой день и в другом порядке, по нажатию меняются день, время, кому и пауза. Сверху фильтр «Как увидит человек»: выбери начинающего или продолжающего — увидишь, что именно он получит. Там же даты, подарки и все тексты бота.

<b>В боте /posts</b>:
Значки: ✅ включён · 📝 черновик · ⏸ пауза. Нажми на пост — откроется карточка:

• <b>👁 Показать мне</b> — пост придёт тебе, как ученику
• <b>⏸ Пауза / ▶️ Включить</b>
• <b>✏️ Текст и картинки</b> — прислать новое содержимое
• <b>🔘 Кнопки</b>, <b>🕒 Когда</b>, <b>👥 Кому</b>
• <b>↩️ Догонять</b> (для постов по дням): «нет» — пост получат только новые люди; «да» — его получат и те, у кого этот день уже прошёл
• <b>🚀 Отправить сейчас</b> (для постов в дату)
• <b>🗄 В архив</b> — убрать из списка, ничего не удаляется

Каждый пост приходит человеку только один раз — даже если его поправить и включить снова.
В карточке видно: сколько отправлено, сколько нажатий, сколько людей подходит сейчас.`,
  panel: `<b>🧩 Панель: как двигать посты</b>

<b>Как открыть</b>: /admin → «🗂 Открыть панель». Или кнопка наверху /help.

<b>Вкладки</b>
• <b>Лента</b> — посты «через N дней», по дням: День 0, День 1…
• <b>Даты</b> — посты на конкретную дату (эфиры, анонсы)
• <b>Подарки</b> — что приходит после теста: всем, начинающим, продолжающим
• <b>Тексты</b> — все сообщения бота

<b>Перенести пост на другой день</b>
1. Зажми значок ⋮⋮ слева на карточке
2. Тяни на нужный день — в пустой день тоже можно
3. Отпусти — сохранится сразу, внизу появится «Перенесено на день N»

<b>Поменять порядок в одном дне</b>: так же тяни выше или ниже. Если поставишь пост между постами в 11:00 и 19:00, а у него время 21:00 — время подстроится само, бот напишет об этом.

<b>Поменять день, время, кнопки, кому, паузу</b>: нажми на карточку → в окне кнопки − и + для дня, поле времени, кнопки под постом (текст + ссылка, «＋ Кнопка в этот ряд», «＋ Новый ряд», ↑ ↓, ✕), «Всем / Начинающим / Продолжающим», статус → «Сохранить». Внизу покажет, скольким людям пост подходит сейчас.

<b>Проверить, что получит человек</b>: наверху «Как увидит человек» — выбери начинающего или продолжающего. Посты, которые он не получит, станут бледными с пометкой «не получит». Переключатель прячет их совсем.

<b>Когда отправлять</b> (в окне поста): 📅 <b>В день</b> — день и время по Москве; ⏱ <b>Таймер</b> — через N минут / часов / дней после того, как человек подписался; ↳ <b>После поста</b> — через N после того, как человек получил выбранный пост (цепочка: пока тот не ушёл, этот ждёт). В ленте на карточке видно, почему пост стоит здесь.

<b>Проверить на себе</b> (наверху ленты): ▶️ «Посмотреть ленту сейчас» — все включённые посты придут тебе подряд с подписью «когда»; ⏩ «Ускоренный тест» — по-настоящему, с паузами, но 1 день = 1 минута, есть «⏹ Остановить». Для кого — выбери выше в «Как увидит человек».

<b>👁 Прислать мне</b> — пост придёт тебе в бот, как ученику.

Новый пост, его текст и картинки — только в боте: /new и /posts → ✏️. Так сохраняются альбомы и премиум-эмодзи.`,
  msgs: `<b>✏️ Тексты бота: как поменять</b>

Все сообщения, которые бот пишет ученикам (приветствие, согласия, вопрос про уровень, предложение пройти тест, ответы на команды), и подписи кнопок можно поменять.

<b>Способ 1 — в боте /texts</b> (с премиум-эмодзи)
1. /texts → выбери группу → сообщение
2. Бот покажет, как его видит ученик
3. «✏️ Изменить» — бот пришлёт текущий текст, скопируй и поправь
4. Пришли новый вариант одним сообщением. Жирный, курсив, ссылки и премиум-эмодзи сохранятся

<b>Способ 2 — в панели</b>, вкладка «Тексты» → «Путь ученика»: шаги по порядку (приветствие → согласие → уровень → тест или подарок → рассылка → ответ). У каждого шага — текст, картинка, <b>пауза перед ним</b> (сколько бот «печатает») и <b>свои кнопки-ссылки</b>; подписи встроенных кнопок — по нажатию на них. Кнопка «▶️ Пройти путь заново» сбрасывает твою анкету и проводит по всем шагам как нового ученика (без теста или как из теста). Порядок шагов фиксирован: согласие на данные — всегда первым.
Обычный текст тоже правится там. Удобно для обычного текста. Премиум-эмодзи так не вставить, а если они уже были — после сохранения из панели станут обычными (панель предупредит).

<b>Подстановки</b> — бот заменит сам:
• <code>{имя}</code> — имя ученика из Telegram, можно в любом сообщении
• <code>{уровень}</code> — начинающий / продолжающий (после /level)
• <code>{политика}</code>, <code>{согласие}</code>, <code>{оферта}</code> — ссылки на документы

<b>🖼 Картинка</b>: к любому сообщению (кроме кнопок и профиля) можно прикрепить картинку, гифку или видео — текст станет подписью. В /texts → сообщение → «🖼 Добавить картинку» (пришли фото; с подписью — заменится и текст). В панели — «＋ Добавить картинку» в окне сообщения, там же превью, «Заменить» и «Убрать». Подпись — до 1024 знаков, длиннее уйдёт следующим сообщением.

<b>Кнопки</b> — до 64 знаков, без оформления.

<b>🤖 Профиль бота и меню команд</b> — последняя группа: описание до кнопки «Старт» (до 512 знаков), короткое описание профиля (до 120) и подписи команд в «Меню». Обычный текст, применяется в Telegram сразу после сохранения. «Вернуть как было» вернёт текст из BotFather.

<b>Вернуть как было</b>: в /texts — «↩️ Вернуть как было», в панели — «Вернуть текст по умолчанию». ✎ рядом с названием значит, что текст уже менялся.

<b>Проверка</b>: в панели «👁 Прислать мне» — сообщение придёт тебе так, как его видит ученик.`,
  plan: `<b>📅 Что выкладывать: план прогрева</b>

Правило: <b>2 пользы на 1 пост про обучение</b> и не больше одного поста в день. Материалы — утром (11:00), посты про курс — вечером (19:00).

<b>Неделя из теста</b> (её обещает страница теста — держим слово):
• день 0 — 🎁 подарок после теста (вид «подарок»)
• день 1 — материал + короткое «как пользоваться»
• день 2 — материал · вечером: как устроен курс, карта глав
• день 3 — материал
• день 4 — материал · вечером: история ученика / разбор работы
• день 5 — материал
• день 6 — материал · вечером: приглашение на эфир
• день 7 — эфир: разбор работ (вид «в дату» или «через 7 дней»)

<b>Материалы теста и кому</b>
• «10 ошибок новичка» — начинающим
• шаблон кейса для портфолио — всем (начинающим как старт)
• 20 промптов для рабочих задач — всем
• контент-план для дизайнера — всем
• что заказывают дизайнерам в 2026 — всем
• скрипты ответов клиенту — продолжающим
• калькулятор цены и шаблон КП — продолжающим
• шаблон брифа — продолжающим

Тест обещает каждому 6 материалов за неделю. Если в какой-то день материал только для одного уровня — поставь в тот же день замену для другого уровня.

<b>После недели</b>: 2–3 поста в неделю — польза, истории, ответы на вопросы, «что внутри главы», сроки записи.`,
  texts: `<b>💬 Примеры постов</b>

<b>Материал (утро)</b>
<i>Чек-лист «10 ошибок новичка» 📋
Проверяй по нему каждую работу перед сдачей — половина правок исчезнет.
Кнопка: Открыть чек-лист</i>

<b>Про обучение (вечер)</b>
<i>Почему красивые картинки не продают? Клиент смотрит портфолио 30 секунд и ищет не красоту, а то, как ты решаешь задачи.
В главах 03–04 мы упаковываем работы в кейсы: задача → процесс → результат. Выходишь с 4 кейсами.
Кнопка: Посмотреть программу</i>

<b>История</b>
<i>Было / стало: работа ученицы до и после главы 01 (альбом из 2–4 картинок) + 2–3 строки, что изменилось.</i>

<b>Эфир</b>
<i>В четверг в 19:00 разбираем работы в прямом эфире. Пришли свой макет до среды — разберём на твоём примере.
Кнопки: Прислать работу · Подробнее об эфире</i>

Тон: на «ты», просто и тепло, без давления. Один пост — одна мысль — одно действие.`,
  stats: `<b>📊 Статистика и проверка</b>

/stats — сколько людей, кто получает рассылку, кто отписался, уровни, сколько прошли тест, откуда пришли, нажатия по постам.

В карточке поста (/posts) — отправлено, нажатия, сколько людей подходит сейчас.

/check — если что-то не так: связь с Telegram, вебхук, база, когда последний раз работало расписание. Всё должно быть с ✅. Если есть ❌ — пришли скриншот Каролине.

<b>На что смотреть</b>: много отписок после поста — пост навязчивый; мало нажатий — неясная кнопка или нет пользы в первой строке.`,
  rules: `<b>⚖️ Важно: правила и безопасность</b>

• Токен бота нигде не публикуем и не пересылаем — он только в настройках сервера.
• Пока бот на Cloudflare — это тест: пользуемся только мы и знакомые. Публичную ссылку из теста включаем после переезда на российский сервер.
• Бот спрашивает два отдельных согласия: на обработку данных и на рассылку. Без второго — только подарок, ленты нет.
• Ученик в любой момент может: /stop — отписаться, /delete — удалить свои данные. Мы это не обходим.
• Не просим в боте телефон, паспорт, номера карт. Оплата — только по кнопке на странице платёжного сервиса.
• Добавлять админов — только тех, кто ведёт курс: /addadmin, убрать — /deladmin.
• Перед большой рассылкой — «👁 Показать мне».`
};

// src/admin.js
var kb = (rows) => ({ inline_keyboard: rows });
var say2 = (ctx, id, text, extra = {}) => ctx.tg.call("sendMessage", { chat_id: id, text, link_preview_options: { is_disabled: true }, ...extra });
function envAdmins(env) {
  return String(env.ADMIN_IDS || "").split(/[\s,;]+/).filter(Boolean).map(Number);
}
async function isAdmin(ctx, id) {
  if (envAdmins(ctx.env).includes(Number(id))) return true;
  return !!await ctx.db.first(`SELECT 1 FROM admins WHERE tg_id = ?`, [id]);
}
async function getState(ctx, id) {
  const r = await ctx.db.first(`SELECT state, data FROM states WHERE tg_id = ?`, [id]);
  return r ? { state: r.state, data: r.data ? JSON.parse(r.data) : {} } : { state: null, data: {} };
}
async function setState(ctx, id, state, data) {
  await ctx.db.run(
    `INSERT INTO states (tg_id, state, data, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(tg_id) DO UPDATE SET state = excluded.state, data = excluded.data, updated_at = excluded.updated_at`,
    [id, state, JSON.stringify(data || {}), ctx.now]
  );
}
async function clearState(ctx, id) {
  await ctx.db.run(`DELETE FROM states WHERE tg_id = ?`, [id]);
  await ctx.db.run(`DELETE FROM draft_parts WHERE admin_id = ?`, [id]);
  await ctx.db.run(`DELETE FROM draft_groups WHERE admin_id = ?`, [id]);
}
var CONTENT_PROMPT = `Пришли пост одним или несколькими сообщениями:
• текст (можно с жирным, ссылками и премиум-эмодзи)
• картинки, видео или файлы — можно альбомом до 10 штук; подпись к альбому станет текстом поста

Когда всё отправишь — нажми «Готово».`;
var contentKb = kb([[{ text: "Готово ➜", callback_data: "w:done" }], [{ text: "Начать заново", callback_data: "w:reset" }, { text: "Отмена", callback_data: "w:cancel" }]]);
async function onAdminCommand(ctx, msg2, cmd, arg) {
  const id = msg2.from.id;
  switch (cmd) {
    case "help":
      return showGuide(ctx, id, "menu");
    case "cancel":
      await clearState(ctx, id);
      return say2(ctx, id, "Отменено.");
    case "new":
      await clearState(ctx, id);
      await setState(ctx, id, "w:content", { target: "new" });
      return say2(ctx, id, CONTENT_PROMPT);
    case "posts":
      return listPosts(ctx, id, false);
    case "stats":
      return stats(ctx, id);
    case "admins":
      return listAdmins(ctx, id);
    case "addadmin":
      return addAdmin(ctx, id, arg);
    case "deladmin":
      return delAdmin(ctx, id, arg);
    case "check":
      return check(ctx, id);
    case "texts":
      return textsMenu(ctx, id);
    case "admin":
    case "panel":
      return panelLink(ctx, id);
    default:
      return null;
  }
}
async function onAdminMessage(ctx, msg2) {
  const id = msg2.from.id;
  const s = await getState(ctx, id);
  if (!s.state) return false;
  const mediaOf = (m) => m.photo ? { type: "photo", file_id: m.photo[m.photo.length - 1].file_id } : m.video ? { type: "video", file_id: m.video.file_id } : m.animation ? { type: "animation", file_id: m.animation.file_id } : null;
  if (s.state.startsWith("e:pic:")) {
    const key = s.state.slice(6);
    const md = mediaOf(msg2);
    if (!md) {
      await say2(ctx, id, "Пришли картинку, видео или гифку одним сообщением. Или /cancel.");
      return true;
    }
    try {
      if (msg2.caption) await saveMsg(ctx, key, msg2.caption, msg2.caption_entities || [], md);
      else await setMsgMedia(ctx, key, md);
    } catch (e) {
      await say2(ctx, id, "⚠️ " + e.message);
      return true;
    }
    await clearState(ctx, id);
    await showMsg(ctx, id, key, msg2.caption ? "Картинка и текст сохранены ✓" : "Картинка сохранена ✓ Текст остался прежним — он стал подписью.");
    return true;
  }
  if (s.state.startsWith("e:msg:")) {
    const key = s.state.slice(6);
    const md = canMedia(key) ? mediaOf(msg2) : null;
    if (md) {
      try {
        await saveMsg(ctx, key, msg2.caption || "", msg2.caption_entities || [], md);
      } catch (e) {
        await say2(ctx, id, "⚠️ " + e.message);
        return true;
      }
      await clearState(ctx, id);
      await showMsg(ctx, id, key, "Сохранено ✓ Так это сообщение теперь увидят ученики:");
      return true;
    }
    if (!msg2.text) {
      await say2(ctx, id, "Нужен текст одним сообщением. Или /cancel.");
      return true;
    }
    try {
      await saveMsg(ctx, key, msg2.text, msg2.entities || []);
    } catch (e) {
      await say2(ctx, id, "⚠️ " + e.message + ". Пришли покороче или /cancel.");
      return true;
    }
    await clearState(ctx, id);
    await showMsg(ctx, id, key, "Сохранено ✓ Так это сообщение теперь увидят ученики:");
    return true;
  }
  if (s.state === "w:content") {
    let mediaType = null, fileId = null;
    if (msg2.photo) {
      mediaType = "photo";
      fileId = msg2.photo[msg2.photo.length - 1].file_id;
    } else if (msg2.video) {
      mediaType = "video";
      fileId = msg2.video.file_id;
    } else if (msg2.animation) {
      mediaType = "animation";
      fileId = msg2.animation.file_id;
    } else if (msg2.document) {
      mediaType = "document";
      fileId = msg2.document.file_id;
    }
    const text = msg2.text || msg2.caption || null;
    const ents = msg2.entities || msg2.caption_entities || null;
    if (!text && !fileId) {
      await say2(ctx, id, "Такое сообщение не поддерживается. Пришли текст, картинку, видео или файл.");
      return true;
    }
    await ctx.db.run(
      `INSERT INTO draft_parts (admin_id, message_id, group_id, text, entities, media_type, file_id) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [id, msg2.message_id, msg2.media_group_id || null, text, ents ? JSON.stringify(ents) : null, mediaType, fileId]
    );
    if (msg2.media_group_id) {
      const r = await ctx.db.run(`INSERT OR IGNORE INTO draft_groups (admin_id, group_id) VALUES (?, ?)`, [id, msg2.media_group_id]);
      if (!r.changes) return true;
    }
    await say2(ctx, id, "Принято ✓ Можно добавить ещё текст или картинки. Когда всё — «Готово».", { reply_markup: contentKb });
    return true;
  }
  const txt = (msg2.text || "").trim();
  const d = s.data;
  if (s.state === "w:day" || s.state.startsWith("e:day:")) {
    const n = parseInt(txt, 10);
    if (!(n >= 0 && n <= 365)) {
      await say2(ctx, id, "Нужно число от 0 до 365. Например: 2");
      return true;
    }
    if (s.state === "w:day") {
      d.post.day = n;
      await setState(ctx, id, "w:time", d);
      await say2(ctx, id, n === 0 ? "День 0 уходит сразу после входа. Время не нужно — выберем, кому." : "Во сколько по Москве отправить? Например: 11:00", n === 0 ? {} : { reply_markup: kb([[{ text: "11:00", callback_data: "w:tm:11:00" }, { text: "19:00", callback_data: "w:tm:19:00" }]]) });
      if (n === 0) {
        d.post.send_time = "00:00";
        await setState(ctx, id, "w:aud", d);
        {
          await askAudience(ctx, id);
          return true;
        }
      }
      return true;
    }
    const pid = +s.state.split(":")[2];
    await setState(ctx, id, "e:time:" + pid, { day: n });
    await say2(ctx, id, n === 0 ? "День 0 — сразу после входа. Напиши любое время, например 00:00" : "Во сколько по Москве? Например: 11:00");
    return true;
  }
  if (s.state === "w:time" || s.state.startsWith("e:time:")) {
    const t = parseTime(txt);
    if (t === null) {
      await say2(ctx, id, "Не понял время. Формат: 11:00");
      return true;
    }
    if (s.state === "w:time") {
      d.post.send_time = fmtTime(t);
      await setState(ctx, id, "w:aud", d);
      await askAudience(ctx, id);
      return true;
    }
    const pid = +s.state.split(":")[2];
    await ctx.db.run(`UPDATE posts SET day = ?, send_time = ? WHERE id = ?`, [d.day, fmtTime(t), pid]);
    await clearState(ctx, id);
    {
      await showPost(ctx, id, pid, "Готово ✓");
      return true;
    }
  }
  if (s.state === "w:when" || s.state.startsWith("e:when:")) {
    const ts = parseWhen(txt, ctx.now);
    if (!ts) {
      await say2(ctx, id, "Не понял дату. Примеры: 05.11 19:00 · 05.11.2026 19:00 · завтра 11:00");
      return true;
    }
    if (ts < ctx.now - 60) {
      await say2(ctx, id, "Это время уже прошло. Напиши будущее время.");
      return true;
    }
    if (s.state === "w:when") {
      d.post.run_at = ts;
      await setState(ctx, id, "w:aud", d);
      await askAudience(ctx, id);
      return true;
    }
    const pid = +s.state.split(":")[2];
    await ctx.db.run(`UPDATE posts SET run_at = ? WHERE id = ?`, [ts, pid]);
    await clearState(ctx, id);
    {
      await showPost(ctx, id, pid, `Отправка: ${fmtWhen(ts)} ✓`);
      return true;
    }
  }
  if (s.state === "w:btns" || s.state.startsWith("e:btns:")) {
    const r = parseButtons(txt);
    if (r.error) {
      await say2(ctx, id, r.error);
      return true;
    }
    const ge = await checkGo(ctx, r.rows);
    if (ge) {
      await say2(ctx, id, ge);
      return true;
    }
    if (s.state === "w:btns") {
      d.post.buttons = JSON.stringify(r.rows);
      await setState(ctx, id, "w:preview", d);
      {
        await preview(ctx, id, d);
        return true;
      }
    }
    const pid = +s.state.split(":")[2];
    await ctx.db.run(`UPDATE posts SET buttons = ? WHERE id = ?`, [JSON.stringify(r.rows), pid]);
    await clearState(ctx, id);
    {
      await showPost(ctx, id, pid, "Кнопки обновлены ✓");
      return true;
    }
  }
  if (s.state === "w:title") {
    d.post.title = txt.slice(0, 80);
    await setState(ctx, id, "w:preview", d);
    {
      await preview(ctx, id, d);
      return true;
    }
  }
  return false;
}
function parseButtons(txt) {
  const rows = [];
  for (const line of (txt || "").split("\n").map((l) => l.trim()).filter(Boolean)) {
    const row = [];
    for (const part of line.split(";").map((x) => x.trim()).filter(Boolean)) {
      const m = /^(.+?)\s*\|\s*(\S+)$/.exec(part);
      if (!m) return { error: `Не понял строку «${part}». Формат: Текст кнопки | https://ссылка` };
      const go = /^#(\d+)$/.exec(m[2]);
      if (go) {
        row.push({ text: m[1].slice(0, 60), go: +go[1] });
        continue;
      }
      const doc = { "политика": "policy", "согласие": "consent", "оферта": "offer" }[m[2].toLowerCase()];
      if (doc) {
        row.push({ text: m[1].slice(0, 60), doc });
        continue;
      }
      let url = m[2];
      if (/^t\.me\//i.test(url)) url = "https://" + url;
      if (!/^https?:\/\//i.test(url)) return { error: `Ссылка должна начинаться с https:// — «${m[2]}»` };
      row.push({ text: m[1].slice(0, 60), url });
    }
    if (row.length > 4) return { error: "В одном ряду не больше 4 кнопок." };
    if (row.length) rows.push(row);
  }
  if (!rows.length) return { error: "Не нашёл ни одной кнопки. Формат: Текст кнопки | https://ссылка" };
  return { rows };
}
async function assemble(ctx, id) {
  const parts = await ctx.db.all(`SELECT * FROM draft_parts WHERE admin_id = ? ORDER BY message_id, id`, [id]);
  const textOnly = parts.filter((p) => !p.file_id && p.text);
  const withCap = parts.filter((p) => p.file_id && p.text);
  const src = textOnly.length ? textOnly[textOnly.length - 1] : withCap[0];
  const media = parts.filter((p) => p.file_id).map((p) => ({ type: p.media_type, file_id: p.file_id }));
  return { text: src ? src.text : "", entities: src && src.entities ? src.entities : "[]", media: JSON.stringify(media.slice(0, 10)), extra: Math.max(0, media.length - 10) };
}
async function askAudience(ctx, id) {
  return say2(ctx, id, "Кому отправлять?", { reply_markup: kb([[{ text: "Всем", callback_data: "w:aud:all" }], [{ text: "Начинающим", callback_data: "w:aud:start" }, { text: "Продолжающим", callback_data: "w:aud:pro" }]]) });
}
async function preview(ctx, id, d) {
  const p = { ...d.post, id: 0 };
  try {
    const r = await sendPost(ctx.tg, id, p, { docs: await loadDocs(ctx) });
    if (r.warn) await say2(ctx, id, "⚠️ " + r.warn);
  } catch (e) {
    await say2(ctx, id, `⚠️ Telegram не принял пост: ${e.message}
Проверьте: в альбоме нельзя смешивать файлы с фото/видео.`);
  }
  return say2(ctx, id, `Так пост увидят ученики ☝️

${postSummary({ ...p, status: "draft", id: "—" })}`, {
    reply_markup: kb([
      [{ text: "✅ Сохранить и включить", callback_data: "w:save:1" }],
      [{ text: "📝 Сохранить черновиком", callback_data: "w:save:0" }],
      [{ text: "🏷 Название для списка", callback_data: "w:ttl" }, { text: "Отмена", callback_data: "w:cancel" }]
    ])
  });
}
async function onAdminCallback(ctx, cq) {
  const id = cq.from.id;
  const data = cq.data || "";
  const s = await getState(ctx, id);
  const d = s.data || {};
  if (data === "w:cancel") {
    await clearState(ctx, id);
    return say2(ctx, id, "Отменено.");
  }
  if (data === "w:reset") {
    await ctx.db.run(`DELETE FROM draft_parts WHERE admin_id = ?`, [id]);
    await ctx.db.run(`DELETE FROM draft_groups WHERE admin_id = ?`, [id]);
    return say2(ctx, id, "Начинаем заново. " + CONTENT_PROMPT);
  }
  if (data === "w:done") {
    if (s.state !== "w:content") return say2(ctx, id, "Сначала /new");
    const c = await assemble(ctx, id);
    if (!c.text && c.media === "[]") return say2(ctx, id, "Пока ничего не пришло. Пришли текст или картинку.");
    if (c.extra) await say2(ctx, id, `В альбоме максимум 10 вложений — ${c.extra} лишних не войдут.`);
    if (d.target && d.target.startsWith("edit:")) {
      const pid = +d.target.split(":")[1];
      await ctx.db.run(`UPDATE posts SET text = ?, entities = ?, media = ? WHERE id = ?`, [c.text, c.entities, c.media, pid]);
      await clearState(ctx, id);
      return showPost(ctx, id, pid, "Содержимое обновлено ✓");
    }
    d.post = { text: c.text, entities: c.entities, media: c.media, audience: "all", catchup: 0, send_time: "11:00", buttons: null };
    await setState(ctx, id, "w:kind", d);
    await ctx.db.run(`DELETE FROM draft_parts WHERE admin_id = ?`, [id]);
    await ctx.db.run(`DELETE FROM draft_groups WHERE admin_id = ?`, [id]);
    return say2(ctx, id, "Когда отправлять?", { reply_markup: kb([
      [{ text: "📅 Через N дней после входа", callback_data: "w:kind:drip" }],
      [{ text: "🕒 В конкретные дату и время", callback_data: "w:kind:date" }],
      [{ text: "🎁 Подарок после теста", callback_data: "w:kind:gift" }],
      [{ text: "🔘 Ответ на кнопку (приходит по нажатию)", callback_data: "w:kind:node" }]
    ]) });
  }
  if (data.startsWith("w:kind:") && d.post) {
    d.post.kind = data.slice(7);
    if (d.post.kind === "drip") {
      await setState(ctx, id, "w:day", d);
      return say2(ctx, id, "Через сколько дней после входа? 0 — сразу, 1 — на следующий день, 2 — через день…");
    }
    if (d.post.kind === "date") {
      await setState(ctx, id, "w:when", d);
      return say2(ctx, id, "Когда отправить? Например: 05.11 19:00 или завтра 11:00 (время московское)");
    }
    if (d.post.kind === "node") return askButtons(ctx, id, d);
    await setState(ctx, id, "w:aud", d);
    return askAudience(ctx, id);
  }
  if (data.startsWith("w:tm:") && d.post) {
    d.post.send_time = data.slice(5);
    await setState(ctx, id, "w:aud", d);
    return askAudience(ctx, id);
  }
  if (data.startsWith("w:aud:") && d.post) {
    d.post.audience = data.slice(6);
    return askButtons(ctx, id, d);
  }
  if (data === "w:nobtn" && d.post) {
    d.post.buttons = null;
    await setState(ctx, id, "w:preview", d);
    return preview(ctx, id, d);
  }
  if (data === "w:ttl" && d.post) {
    await setState(ctx, id, "w:title", d);
    return say2(ctx, id, "Короткое название для списка постов (видишь только ты):");
  }
  if (data.startsWith("w:save:") && d.post) {
    const on = data.endsWith(":1");
    const p = d.post;
    await ctx.db.run(
      `INSERT INTO posts (title, kind, audience, zone, day, send_time, run_at, catchup, status, text, entities, media, buttons, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [p.title || null, p.kind, p.audience, null, p.day ?? null, p.send_time || "11:00", p.run_at || null, p.catchup ? 1 : 0, on ? "active" : "draft", p.text, p.entities, p.media, p.buttons, id, ctx.now]
    );
    const row = await ctx.db.first(`SELECT MAX(id) AS id FROM posts WHERE created_by = ?`, [id]);
    await clearState(ctx, id);
    return showPost(ctx, id, row.id, on ? "Сохранено и включено ✅" : "Сохранено черновиком 📝");
  }
  if (data.startsWith("h:")) return showGuide(ctx, id, data.slice(2));
  if (data === "t:menu") return textsMenu(ctx, id);
  if (data.startsWith("t:g:")) return textsGroup(ctx, id, data.slice(4));
  if (data.startsWith("t:k:")) return showMsg(ctx, id, data.slice(4));
  if (data.startsWith("t:e:")) {
    const key = data.slice(4);
    const i = msgInfo(key);
    if (!i) return;
    await clearState(ctx, id);
    await setState(ctx, id, "e:msg:" + key, {});
    return say2(
      ctx,
      id,
      `Пришли новый текст для «${i.title}» одним сообщением.` + (i.button ? `
Это кнопка: до 64 знаков, без оформления.` : i.plain ? `
Это часть профиля бота: обычный текст${i.limit ? ", до " + i.limit + " знаков" : ""}. Применится в Telegram сразу.` : `
Жирный, курсив, ссылки и премиум-эмодзи сохранятся. Можно прислать картинку с подписью — тогда будет картинка с этим текстом.`) + (i.vars.length ? `

Можно вставить подстановки: ${i.vars.map((v) => "{" + v + "}").join(" ")} — бот заменит их сам.` : "") + `

Текущий текст, чтобы скопировать и поправить:`,
      { reply_markup: kb([[{ text: "Отмена", callback_data: "w:cancel" }]]) }
    ).then(async () => {
      const all = await loadMsgs(ctx);
      const o = all[key];
      const cur = o ? o.text : i.plain ? (await msg(ctx, key)).text : i.def;
      await ctx.tg.call("sendMessage", { chat_id: id, text: cur || "(пусто)", ...o && o.entities && o.entities.length ? { entities: o.entities } : {} }).catch(() => say2(ctx, id, cur || "(пусто)"));
    });
  }
  if (data.startsWith("t:p:")) {
    const key = data.slice(4);
    if (!canMedia(key)) return;
    await clearState(ctx, id);
    await setState(ctx, id, "e:pic:" + key, {});
    return say2(ctx, id, "Пришли картинку, видео или гифку одним сообщением.\nМожно сразу с подписью — она станет новым текстом. Без подписи текст останется прежним.", { reply_markup: kb([[{ text: "Отмена", callback_data: "w:cancel" }]]) });
  }
  if (data.startsWith("t:x:")) {
    const key = data.slice(4);
    await setMsgMedia(ctx, key, null);
    return showMsg(ctx, id, key, "Картинку убрали — остался только текст.");
  }
  if (data.startsWith("t:r:")) {
    const key = data.slice(4);
    await resetMsg(ctx, key);
    return showMsg(ctx, id, key, "Вернули текст по умолчанию ↩️");
  }
  if (data === "pl") return listPosts(ctx, id, false);
  if (data === "pl:arch") return listPosts(ctx, id, true);
  const m = /^p:(\d+)(?::(.*))?$/.exec(data);
  if (m) return postAction(ctx, id, +m[1], m[2] || "");
  return null;
}
async function buttonsHelp(ctx) {
  const recent = await ctx.db.all(`SELECT * FROM posts WHERE status != 'archived' ORDER BY id DESC LIMIT 8`);
  return "Пришли по строке на ряд:\nТекст кнопки | https://ссылка\nТекст кнопки | #12 — откроет пост №12 этого бота\nТекст кнопки | политика — документ (ещё: согласие, оферта)\nНесколько кнопок в ряд — через «;»" + (recent.length ? "\n\nПосты: " + recent.map((p) => `#${p.id} ${postLabel(p).slice(0, 26)}`).join(" · ") : "") + "\n\nДерево сценария удобнее собирать в панели: /admin";
}
async function askButtons(ctx, id, d) {
  await setState(ctx, id, "w:btns", d);
  return say2(ctx, id, "Кнопки под постом? " + await buttonsHelp(ctx), { reply_markup: kb([[{ text: "Без кнопок", callback_data: "w:nobtn" }]]) });
}
async function checkGo(ctx, rows) {
  for (const b of rows.flat()) {
    if (!b.go) continue;
    const t = await ctx.db.first(`SELECT id FROM posts WHERE id = ? AND status != 'archived'`, [b.go]);
    if (!t) return `Поста #${b.go} нет. Номера постов видно в /posts.`;
  }
  return null;
}
async function listPosts(ctx, id, archived) {
  const rows = await ctx.db.all(
    archived ? `SELECT * FROM posts WHERE status = 'archived' ORDER BY id DESC LIMIT 60` : `SELECT * FROM posts WHERE status != 'archived' ORDER BY CASE kind WHEN 'gift' THEN 0 WHEN 'drip' THEN 1 WHEN 'date' THEN 2 ELSE 3 END, day, send_time, run_at, id LIMIT 90`,
    []
  );
  if (!rows.length) return say2(ctx, id, archived ? "Архив пуст." : "Постов пока нет. Создай первый: /new");
  const icon = { active: "✅", draft: "📝", paused: "⏸", archived: "🗄" };
  const btns = rows.map((p) => [{ text: `${icon[p.status] || ""} ${postWhen(p).replace(" · ", " ")} — ${postLabel(p)}`.slice(0, 64), callback_data: "p:" + p.id }]);
  btns.push(archived ? [{ text: "← Активные посты", callback_data: "pl" }] : [{ text: "🗄 Архив", callback_data: "pl:arch" }]);
  return say2(ctx, id, archived ? "Архив постов:" : "Посты: ✅ включён · 📝 черновик · ⏸ пауза. Нажми, чтобы открыть.", { reply_markup: kb(btns) });
}
async function showPost(ctx, id, pid, note) {
  const p = await ctx.db.first(`SELECT * FROM posts WHERE id = ?`, [pid]);
  if (!p) return say2(ctx, id, "Пост не найден.");
  const sent = await ctx.db.first(`SELECT COUNT(*) AS n FROM deliveries WHERE post_id = ?`, [pid]);
  const clicks = await ctx.db.first(`SELECT COUNT(*) AS n FROM clicks WHERE post_id = ?`, [pid]);
  const aud = await audienceCount(ctx.db, p);
  const text = `${note ? note + "\n\n" : ""}${p.title ? "«" + p.title + "»\n" : ""}${postSummary(p)}
Отправлено: ${sent.n} · нажатий: ${clicks.n} · подходит сейчас: ${aud}`;
  const onOff = p.status === "active" ? [{ text: "⏸ Пауза", callback_data: `p:${pid}:off` }] : [{ text: "▶️ Включить", callback_data: `p:${pid}:on` }];
  const rows = [
    [{ text: "👁 Показать мне", callback_data: `p:${pid}:t` }, ...onOff],
    [{ text: "✏️ Текст и картинки", callback_data: `p:${pid}:ec` }, { text: "🔘 Кнопки", callback_data: `p:${pid}:eb` }],
    [{ text: "🕒 Когда", callback_data: `p:${pid}:ew` }, { text: "👥 Кому", callback_data: `p:${pid}:ea` }]
  ];
  if (p.kind === "drip") rows.push([{ text: `↩️ Догонять: ${p.catchup ? "да" : "нет"}`, callback_data: `p:${pid}:cu` }]);
  if (p.kind === "date") rows.push([{ text: "🚀 Отправить сейчас", callback_data: `p:${pid}:sn` }]);
  if ((p.buttons || "").includes('"go"')) rows.push([{ text: `☑️ Кнопки-выбор: ${p.once ? "да" : "нет"}`, callback_data: `p:${pid}:once` }]);
  rows.push([{ text: p.status === "archived" ? "↩️ Из архива" : "🗄 В архив", callback_data: `p:${pid}:${p.status === "archived" ? "un" : "ar"}` }, { text: "← Список", callback_data: "pl" }]);
  return say2(ctx, id, text, { reply_markup: kb(rows) });
}
async function postAction(ctx, id, pid, act) {
  const p = await ctx.db.first(`SELECT * FROM posts WHERE id = ?`, [pid]);
  if (!p) return say2(ctx, id, "Пост не найден.");
  const upd = async (sql, params, note) => {
    await ctx.db.run(sql, [...params, pid]);
    return showPost(ctx, id, pid, note);
  };
  if (!act) return showPost(ctx, id, pid);
  if (act === "t") {
    try {
      const r = await sendPost(ctx.tg, id, p, { uid: id, publicUrl: ctx.publicUrl, docs: await loadDocs(ctx) });
      if (r.warn) await say2(ctx, id, "⚠️ " + r.warn);
    } catch (e) {
      await say2(ctx, id, "⚠️ Telegram не принял пост: " + e.message);
    }
    return;
  }
  if (act === "on") {
    if (p.kind === "date" && !p.run_at) return say2(ctx, id, "Сначала задай дату: «🕒 Когда».");
    return upd(`UPDATE posts SET status = 'active' WHERE id = ?`, [], "Включён ✅");
  }
  if (act === "off") return upd(`UPDATE posts SET status = 'paused' WHERE id = ?`, [], "На паузе ⏸");
  if (act === "ar") return upd(`UPDATE posts SET status = 'archived' WHERE id = ?`, [], "В архиве 🗄");
  if (act === "un") return upd(`UPDATE posts SET status = 'paused' WHERE id = ?`, [], "Вернули из архива, пост на паузе");
  if (act === "once") return upd(`UPDATE posts SET once = 1 - once WHERE id = ?`, [], p.once ? "Кнопки остаются после нажатия" : "После нажатия под постом останется только выбранная кнопка с ✓");
  if (act === "cu") return upd(`UPDATE posts SET catchup = 1 - catchup WHERE id = ?`, [], p.catchup ? "Опоздавших не догоняем" : "Будем догонять тех, для кого время уже прошло");
  if (act === "ec") {
    await clearState(ctx, id);
    await setState(ctx, id, "w:content", { target: "edit:" + pid });
    return say2(ctx, id, "Пришли новое содержимое поста. " + CONTENT_PROMPT);
  }
  if (act === "eb") {
    await setState(ctx, id, "e:btns:" + pid, {});
    return say2(ctx, id, "Кнопки заново. " + await buttonsHelp(ctx), { reply_markup: kb([[{ text: "Убрать все кнопки", callback_data: `p:${pid}:bn` }]]) });
  }
  if (act === "bn") {
    await clearState(ctx, id);
    return upd(`UPDATE posts SET buttons = NULL WHERE id = ?`, [], "Кнопки убраны");
  }
  if (act === "ew") {
    if (p.kind === "drip") {
      await setState(ctx, id, "e:day:" + pid, {});
      return say2(ctx, id, `Сейчас: ${postWhen(p)}. Через сколько дней после входа? (число)`);
    }
    if (p.kind === "date") {
      await setState(ctx, id, "e:when:" + pid, {});
      return say2(ctx, id, `Сейчас: ${postWhen(p)}. Новая дата и время, например 05.11 19:00`);
    }
    if (p.kind === "node") return say2(ctx, id, "Пост-ответ приходит сразу, когда человек нажимает кнопку, которая ведёт сюда. Время для него не задаётся.");
    return say2(ctx, id, "Подарок уходит сразу после теста — время для него не задаётся. Кому он уходит — кнопка «👥 Кому».");
  }
  if (act === "ea") return say2(ctx, id, "Кому отправлять?", { reply_markup: kb([[{ text: "Всем", callback_data: `p:${pid}:a:all` }], [{ text: "Начинающим", callback_data: `p:${pid}:a:start` }, { text: "Продолжающим", callback_data: `p:${pid}:a:pro` }]]) });
  if (act.startsWith("a:")) return upd(`UPDATE posts SET audience = ? WHERE id = ?`, [act.slice(2)], "Аудитория обновлена ✓");
  if (act === "sn") {
    const n = await audienceCount(ctx.db, p);
    return say2(ctx, id, `Отправить пост #${pid} сейчас? Подходит людей: ${n}.`, { reply_markup: kb([[{ text: "🚀 Да, отправить", callback_data: `p:${pid}:sy` }, { text: "Нет", callback_data: `p:${pid}` }]]) });
  }
  if (act === "sy") return upd(`UPDATE posts SET run_at = ?, status = 'active' WHERE id = ?`, [ctx.now], "Рассылка начнётся в течение минуты 🚀");
  return showPost(ctx, id, pid);
}
async function stats(ctx, id) {
  const q = (sql, p = []) => ctx.db.first(sql, p);
  const all = await q(`SELECT COUNT(*) AS n FROM users`);
  const act = await q(`SELECT COUNT(*) AS n FROM users WHERE status = 'active'`);
  const stop = await q(`SELECT COUNT(*) AS n FROM users WHERE status = 'stopped'`);
  const blk = await q(`SELECT COUNT(*) AS n FROM users WHERE status = 'blocked'`);
  const paid = await q(`SELECT COUNT(*) AS n FROM users WHERE paid_at IS NOT NULL`);
  const wk = await q(`SELECT COUNT(*) AS n FROM users WHERE created_at >= ?`, [ctx.now - 7 * 86400]);
  const lv = await ctx.db.all(`SELECT level, COUNT(*) AS n FROM users WHERE status = 'active' GROUP BY level`);
  const src = await ctx.db.all(`SELECT CASE WHEN source LIKE 'audit_%' THEN 'тест' WHEN source IS NULL OR source = '' THEN 'без метки' ELSE source END AS s, COUNT(*) AS n FROM users GROUP BY s ORDER BY n DESC LIMIT 8`);
  const day = await q(`SELECT COUNT(*) AS n FROM deliveries WHERE sent_at >= ?`, [ctx.now - 86400]);
  const top = await ctx.db.all(`SELECT p.id, p.title, p.text, COUNT(c.id) AS n FROM clicks c JOIN posts p ON p.id = c.post_id GROUP BY p.id ORDER BY n DESC LIMIT 5`);
  const L = { start: "начинающие", pro: "продолжающие", null: "не выбрали" };
  const lines = [
    `👥 Всего в боте: ${all.n} (за 7 дней: +${wk.n})`,
    `✅ Получают рассылку: ${act.n} · отписались: ${stop.n} · заблокировали бота: ${blk.n}`,
    `💳 Оплатили: ${paid.n}`,
    "",
    "Уровни (активные): " + (lv.map((r) => `${L[r.level] || L.null} ${r.n}`).join(" · ") || "—"),
    "Прошли тест: " + (await ctx.db.first(`SELECT COUNT(*) AS n FROM users WHERE zone IS NOT NULL`)).n,
    "Откуда: " + (src.map((r) => `${r.s} ${r.n}`).join(" · ") || "—"),
    "",
    `📨 Отправлено за сутки: ${day.n}`,
    "Больше всего нажатий: " + (top.map((r) => `#${r.id} ${(r.title || r.text || "").slice(0, 20)} — ${r.n}`).join("; ") || "пока нет")
  ];
  return say2(ctx, id, lines.join("\n"));
}
async function listAdmins(ctx, id) {
  const rows = await ctx.db.all(`SELECT * FROM admins ORDER BY added_at`);
  const env = envAdmins(ctx.env);
  const lines = [
    "Главные админы (из настроек сервера): " + (env.join(", ") || "—"),
    "Добавленные: " + (rows.map((r) => `${r.name || ""} ${r.tg_id}`.trim()).join(", ") || "—"),
    "",
    "Чтобы добавить: человек пишет боту /id, присылает тебе число, ты отправляешь /addadmin ЧИСЛО"
  ];
  return say2(ctx, id, lines.join("\n"));
}
async function addAdmin(ctx, id, arg) {
  const n = parseInt(arg, 10);
  if (!n) return say2(ctx, id, "Формат: /addadmin 123456789");
  const u = await ctx.db.first(`SELECT first_name FROM users WHERE tg_id = ?`, [n]);
  await ctx.db.run(`INSERT OR IGNORE INTO admins (tg_id, name, added_at) VALUES (?, ?, ?)`, [n, u ? u.first_name : null, ctx.now]);
  await ctx.tg.call("setMyCommands", { commands: await adminCommands(ctx), scope: { type: "chat", chat_id: n } }).catch(() => {
  });
  await ctx.tg.call("sendMessage", { chat_id: n, text: "Тебе выдали права админа бота 🐾 Команды: /help" }).catch(() => {
  });
  return say2(ctx, id, `Готово: ${n} теперь админ.`);
}
async function delAdmin(ctx, id, arg) {
  const n = parseInt(arg, 10);
  if (!n) return say2(ctx, id, "Формат: /deladmin 123456789");
  if (envAdmins(ctx.env).includes(n)) return say2(ctx, id, "Главного админа можно убрать только в настройках сервера.");
  await ctx.db.run(`DELETE FROM admins WHERE tg_id = ?`, [n]);
  await ctx.tg.call("deleteMyCommands", { scope: { type: "chat", chat_id: n } }).catch(() => {
  });
  return say2(ctx, id, `Готово: ${n} больше не админ.`);
}
async function check(ctx, id) {
  const lines = [];
  try {
    const me = await ctx.tg.call("getMe");
    lines.push(`✅ Связь с Telegram есть: @${me.username}`);
  } catch (e) {
    lines.push("❌ Нет связи с Telegram: " + e.message);
  }
  try {
    const w = await ctx.tg.call("getWebhookInfo");
    lines.push(w.url ? `✅ Вебхук: ${w.url}` : "❌ Вебхук не установлен — открой адрес /setup");
    if (w.pending_update_count) lines.push(`⏳ В очереди сообщений: ${w.pending_update_count}`);
    if (w.last_error_message) lines.push(`⚠️ Последняя ошибка Telegram: ${w.last_error_message}`);
  } catch {
  }
  const u = await ctx.db.first(`SELECT COUNT(*) AS n FROM users`);
  const p = await ctx.db.first(`SELECT COUNT(*) AS n FROM posts WHERE status = 'active'`);
  lines.push(`✅ База отвечает: людей ${u.n}, включённых постов ${p.n}`);
  const last = await ctx.db.first(`SELECT value FROM settings WHERE key = 'last_tick'`);
  lines.push(last ? `✅ Расписание работает, последний запуск ${fmtWhen(+last.value)}` : "❌ Расписание ещё ни разу не запускалось");
  lines.push(`Сервер: ${ctx.env.HOST_NAME || "cloudflare"} · мост к Telegram: ${ctx.env.TG_API_ROOT ? "включён" : "не нужен"}`);
  return say2(ctx, id, lines.join("\n"));
}
async function showGuide(ctx, id, key) {
  const text = GUIDE[key] || GUIDE.menu;
  const rows = key === "menu" || !GUIDE[key] ? [...ctx.publicUrl ? [[{ text: "🗂 Открыть панель", web_app: { url: ctx.publicUrl + "/admin" } }]] : [], ...GUIDE_MENU.map(([k, t]) => [{ text: t, callback_data: "h:" + k }])] : (() => {
    const i = GUIDE_MENU.findIndex(([k]) => k === key);
    const next = GUIDE_MENU[i + 1];
    const r = [];
    if (next) r.push([{ text: "Дальше: " + next[1], callback_data: "h:" + next[0] }]);
    r.push([{ text: "← Все разделы", callback_data: "h:menu" }]);
    return r;
  })();
  return say2(ctx, id, text, { parse_mode: "HTML", reply_markup: kb(rows) });
}
var sampleVars = (ctx, id) => ({
  имя: "Каролина",
  уровень: LEVELS.start,
  политика: ctx.env.POLICY_URL || "— ссылка появится перед запуском —",
  согласие: ctx.env.CONSENT_URL || "— ссылка появится перед запуском —",
  оферта: ctx.env.OFFER_URL || "— скоро —",
  владелец: ctx.env.OWNER_INFO || ""
});
async function textsMenu(ctx, id) {
  const all = await loadMsgs(ctx);
  const rows = MSG_GROUPS.map(([g, t]) => {
    const n = Object.keys(MSG).filter((k) => MSG[k][0] === g && all[k]).length;
    return [{ text: t + (n ? ` · изменено ${n}` : ""), callback_data: "t:g:" + g }];
  });
  if (ctx.publicUrl) rows.push([{ text: "🗂 Открыть панель (удобнее)", web_app: { url: ctx.publicUrl + "/admin" } }]);
  return say2(ctx, id, "Тексты бота. Выбери, что поменять — покажу, как сообщение видят ученики, и можно прислать новый вариант (с премиум-эмодзи).", { reply_markup: kb(rows) });
}
async function textsGroup(ctx, id, g) {
  const all = await loadMsgs(ctx);
  const rows = Object.keys(MSG).filter((k) => MSG[k][0] === g).map((k) => [{ text: (all[k] ? "✎ " : "") + MSG[k][1], callback_data: "t:k:" + k }]);
  rows.push([{ text: "← Все группы", callback_data: "t:menu" }]);
  const t = (MSG_GROUPS.find(([x]) => x === g) || [, ""])[1];
  return say2(ctx, id, `${t}
✎ — уже изменено`, { reply_markup: kb(rows) });
}
async function showMsg(ctx, id, key, note) {
  const i = msgInfo(key);
  if (!i) return;
  const all = await loadMsgs(ctx);
  await say2(ctx, id, `${note ? note + "\n\n" : ""}«${i.title}»${i.button ? " — это кнопка" : ""}${all[key] ? " · изменено" : " · по умолчанию"}
${i.group === "profile" ? "Сейчас в Telegram так 👇" : "Ученик видит так 👇"}`);
  await say(ctx, id, key, sampleVars(ctx, id));
  const rows = [[{ text: "✏️ Изменить", callback_data: "t:e:" + key }]];
  if (canMedia(key)) rows.push(all[key] && all[key].media ? [{ text: "🖼 Заменить картинку", callback_data: "t:p:" + key }, { text: "✖️ Убрать картинку", callback_data: "t:x:" + key }] : [{ text: "🖼 Добавить картинку", callback_data: "t:p:" + key }]);
  if (all[key]) rows.push([{ text: "↩️ Вернуть как было", callback_data: "t:r:" + key }]);
  rows.push([{ text: "← Назад", callback_data: "t:g:" + i.group }]);
  return say2(ctx, id, i.vars.length ? `Подстановки: ${i.vars.map((v) => "{" + v + "}").join(" ")} (в примере — образец)` : "Что дальше?", { reply_markup: kb(rows) });
}
async function panelLink(ctx, id) {
  if (!ctx.publicUrl) return say2(ctx, id, "Панель откроется, когда у бота будет адрес в интернете.");
  return say2(ctx, id, "Панель: лента постов по дням (можно перетаскивать), даты, подарки и все тексты бота.", {
    reply_markup: kb([[{ text: "🗂 Открыть панель", web_app: { url: ctx.publicUrl + "/admin" } }]])
  });
}

// src/users.js
var CONSENT_VERSION = "v1";
function parseStart(payload) {
  const out = { source: payload || null, zone: null, levelRaw: null };
  const m = /^audit_([A-Za-z]+)_([a-z]+)$/.exec(payload || "");
  if (m) {
    const z = m[1] === "top" ? "top" : m[1].toUpperCase();
    if (ZONES[z]) out.zone = z;
    if (["start", "free", "pro"].includes(m[2])) out.levelRaw = m[2];
  }
  return out;
}
var normLevel = (raw) => raw === "start" ? "start" : raw === "free" || raw === "pro" ? "pro" : null;
var kb2 = (rows) => ({ inline_keyboard: rows });
async function docVars(ctx) {
  const d = await loadDocs(ctx);
  return {
    политика: d.policy || "— ссылка появится перед запуском —",
    согласие: d.consent || "— ссылка появится перед запуском —",
    оферта: d.offer || "— скоро —",
    владелец: d.owner || ""
  };
}
async function askLevel(ctx, id) {
  return tech(ctx, id, say(ctx, id, "askLevel", {}, {
    reply_markup: kb2([[{ text: await btn(ctx, "levelBtnStart"), callback_data: "lv:start" }], [{ text: await btn(ctx, "levelBtnPro"), callback_data: "lv:pro" }]])
  }));
}
var sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function pauseFor(ctx, id, key) {
  return pause(ctx, id, await delayOf(ctx, key) * 1e3);
}
async function pause(ctx, id, ms) {
  const k = ctx.env.DELAY_FACTOR === void 0 ? 1 : Number(ctx.env.DELAY_FACTOR);
  if (!(k > 0) || !(ms > 0)) return;
  const t = Math.max(450, ms * k);
  await ctx.tg.call("sendChatAction", { chat_id: id, action: "typing" }).catch(() => {
  });
  if (ctx.env.TYPING_BUBBLE === "0") {
    await sleep(t);
    return;
  }
  const dots = await ctx.tg.call("sendMessage", { chat_id: id, text: "•", disable_notification: true }).catch(() => null);
  if (!dots) {
    await sleep(t);
    return;
  }
  await sleep(t / 3);
  await ctx.tg.call("editMessageText", { chat_id: id, message_id: dots.message_id, text: "• •" }).catch(() => {
  });
  await sleep(t / 3);
  await ctx.tg.call("editMessageText", { chat_id: id, message_id: dots.message_id, text: "• • •" }).catch(() => {
  });
  await sleep(t / 3);
  await ctx.tg.call("deleteMessage", { chat_id: id, message_id: dots.message_id }).catch(() => {
  });
}
var techList = (u) => {
  try {
    return u && u.tech ? JSON.parse(u.tech) : [];
  } catch {
    return [];
  }
};
async function tech(ctx, id, sending) {
  const m = await sending;
  if (m && m.message_id) {
    const u = await getUser(ctx, id);
    if (u) await ctx.db.run(`UPDATE users SET tech = ? WHERE tg_id = ?`, [JSON.stringify([...techList(u), ...m.also || [], m.message_id].slice(-20)), id]);
  }
  return m;
}
var delMsg = (ctx, id, mid) => mid ? ctx.tg.call("deleteMessage", { chat_id: id, message_id: mid }).catch(() => {
}) : null;
async function untech(ctx, id, mid) {
  await delMsg(ctx, id, mid);
  const u = await getUser(ctx, id);
  if (u) await ctx.db.run(`UPDATE users SET tech = ? WHERE tg_id = ?`, [JSON.stringify(techList(u).filter((x) => x !== mid)), id]);
}
async function cleanAll(ctx, id) {
  const u = await getUser(ctx, id);
  const list = techList(u);
  if (!list.length) return;
  for (const mid of list) await delMsg(ctx, id, mid);
  await ctx.db.run(`UPDATE users SET tech = NULL WHERE tg_id = ?`, [id]);
}
async function getUser(ctx, id) {
  return ctx.db.first(`SELECT * FROM users WHERE tg_id = ?`, [id]);
}
async function logConsent(ctx, id, kind, granted) {
  await ctx.db.run(`INSERT INTO consents (tg_id, kind, granted, version, at) VALUES (?, ?, ?, ?, ?)`, [id, kind, granted ? 1 : 0, CONSENT_VERSION, ctx.now]);
}
async function onStart(ctx, msg2, payload) {
  const from = msg2.from;
  const st = parseStart(payload);
  const k = "start:" + from.id + ":" + (payload || "");
  const fresh = await ctx.db.run(
    `INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value WHERE CAST(settings.value AS INTEGER) <= ?`,
    [k, String(ctx.now), ctx.now - 4]
  );
  if (!fresh.changes) {
    await delMsg(ctx, from.id, msg2.message_id);
    return;
  }
  let u = await getUser(ctx, from.id);
  if (!u) {
    await ctx.db.run(
      `INSERT INTO users (tg_id, first_name, username, level_raw, level, zone, source, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'new', ?)`,
      [from.id, from.first_name || null, from.username || null, st.levelRaw, normLevel(st.levelRaw), st.zone, st.source, ctx.now]
    );
  } else {
    if (st.zone || st.levelRaw) {
      await ctx.db.run(
        `UPDATE users SET zone = COALESCE(?, zone), level_raw = COALESCE(?, level_raw), level = COALESCE(?, level), source = COALESCE(?, source) WHERE tg_id = ?`,
        [st.zone, st.levelRaw, normLevel(st.levelRaw), st.source, from.id]
      );
    }
    if (u.status === "stopped" || u.status === "blocked") await ctx.db.run(`UPDATE users SET status = 'new' WHERE tg_id = ?`, [from.id]);
  }
  await delMsg(ctx, from.id, msg2.message_id);
  await cleanAll(ctx, from.id);
  u = await getUser(ctx, from.id);
  const name = from.first_name || "друг";
  await pauseFor(ctx, from.id, st.zone ? "helloTest" : "hello");
  await tech(ctx, from.id, say(ctx, from.id, st.zone ? "helloTest" : "hello", { имя: name }));
  return nextStep(ctx, u);
}
async function nextStep(ctx, u) {
  const id = u.tg_id;
  if (!u.consent_pd_at) {
    await pauseFor(ctx, id, "consentPd");
    return tech(ctx, id, say(ctx, id, "consentPd", await docVars(ctx), {
      link_preview_options: { is_disabled: true },
      reply_markup: kb2([[{ text: await btn(ctx, "consentPdBtn"), callback_data: "c:pd" }]])
    }));
  }
  if (!u.level) {
    await pauseFor(ctx, id, "askLevel");
    return askLevel(ctx, id);
  }
  if (!u.zone) {
    const url = ctx.env.TEST_URL;
    await pauseFor(ctx, id, "testOffer");
    await tech(ctx, id, say(ctx, id, "testOffer", {}, url ? { reply_markup: kb2([[{ text: await btn(ctx, "testBtn"), url }]]) } : {}));
  } else {
    await sendGift(ctx, u, await delayOf(ctx, "noGift") * 1e3);
  }
  if (!u.consent_ads_at && u.status !== "stopped") {
    await pauseFor(ctx, id, "consentAds");
    return tech(ctx, id, say(ctx, id, "consentAds", {}, {
      reply_markup: kb2([[{ text: await btn(ctx, "consentAdsYes"), callback_data: "c:ads:1" }, { text: await btn(ctx, "consentAdsNo"), callback_data: "c:ads:0" }]])
    }));
  }
  if (u.consent_ads_at && u.status !== "active") {
    await ctx.db.run(`UPDATE users SET status = 'active', joined_at = COALESCE(joined_at, ?) WHERE tg_id = ?`, [ctx.now, id]);
  }
}
async function sendGift(ctx, u, pauseMs) {
  const gifts = await ctx.db.all(
    `SELECT * FROM posts WHERE kind = 'gift' AND status = 'active'
       AND (audience = 'all' OR audience = ?)
       AND NOT EXISTS (SELECT 1 FROM deliveries d WHERE d.post_id = posts.id AND d.tg_id = ?)
     ORDER BY id`,
    [u.level || "all", u.tg_id]
  );
  if (!gifts.length) {
    const any = await ctx.db.first(`SELECT 1 FROM deliveries d JOIN posts p ON p.id = d.post_id WHERE p.kind = 'gift' AND d.tg_id = ?`, [u.tg_id]);
    const told = await ctx.db.first(`SELECT 1 FROM settings WHERE key = ?`, ["nogift:" + u.tg_id]);
    if (!any && !told) {
      await ctx.db.run(`INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO NOTHING`, ["nogift:" + u.tg_id, String(ctx.now)]);
      if (pauseMs) await pause(ctx, u.tg_id, pauseMs);
      await tech(ctx, u.tg_id, say(ctx, u.tg_id, "noGift"));
    }
    return;
  }
  for (const g of gifts) {
    if (pauseMs) await pause(ctx, u.tg_id, pauseMs);
    await sendPost(ctx.tg, u.tg_id, g, { uid: u.tg_id, publicUrl: ctx.publicUrl, arrow: await btn(ctx, "buttonsArrow"), docs: await loadDocs(ctx) });
    await recordDeliveries(ctx.db, g.id, [{ tg_id: u.tg_id, ok: true }], ctx.now);
  }
}
async function onUserCallback(ctx, cq) {
  const id = cq.from.id;
  const d = cq.data || "";
  const answer = async (key, vars) => ctx.tg.call("answerCallbackQuery", { callback_query_id: cq.id, ...key ? { text: (await msg(ctx, key, vars)).text.slice(0, 190) } : {} }).catch(() => {
  });
  const u = await getUser(ctx, id);
  if (!u) {
    await answer();
    return say(ctx, id, "needStart");
  }
  const mid = cq.message && cq.message.message_id;
  const done = async (key, vars) => {
    await untech(ctx, id, mid);
    if (key) {
      await pauseFor(ctx, id, key);
      await say(ctx, id, key, vars);
    }
  };
  if (d === "c:pd") {
    await answer("consentThanks");
    if (!u.consent_pd_at) {
      await ctx.db.run(`UPDATE users SET consent_pd_at = ? WHERE tg_id = ?`, [ctx.now, id]);
      await logConsent(ctx, id, "pd", true);
    }
    await done();
    return nextStep(ctx, await getUser(ctx, id));
  }
  if (d.startsWith("lv:")) {
    await answer();
    const lv = d.slice(3) === "start" ? "start" : "pro";
    await ctx.db.run(`UPDATE users SET level = ?, level_raw = COALESCE(level_raw, ?) WHERE tg_id = ?`, [lv, lv === "start" ? "start" : "free", id]);
    if (u.consent_pd_at && u.consent_ads_at) {
      await done("levelChanged", { уровень: LEVELS[lv] });
      return;
    }
    await done();
    return nextStep(ctx, await getUser(ctx, id));
  }
  if (d.startsWith("c:ads:")) {
    await answer();
    const yes = d.endsWith(":1");
    await logConsent(ctx, id, "ads", yes);
    if (yes) {
      await ctx.db.run(`UPDATE users SET consent_ads_at = ?, status = 'active', joined_at = COALESCE(joined_at, ?) WHERE tg_id = ?`, [ctx.now, ctx.now, id]);
      return done("adsYes");
    }
    await ctx.db.run(`UPDATE users SET consent_ads_at = NULL, status = 'stopped' WHERE tg_id = ?`, [id]);
    return done("adsNo");
  }
  if (d === "del:yes") {
    await answer();
    await cleanAll(ctx, id);
    await delMsg(ctx, id, mid);
    for (const t of ["users", "consents", "deliveries", "clicks", "states"]) await ctx.db.run(`DELETE FROM ${t} WHERE tg_id = ?`, [id]);
    await ctx.db.run(`DELETE FROM settings WHERE key = ? OR key LIKE ? OR key LIKE ?`, ["nogift:" + id, "start:" + id + ":%", "go:" + id + ":%"]);
    return say(ctx, id, "deleted");
  }
  if (d === "del:no") {
    await answer("deleteCancel");
    return done();
  }
  if (d.startsWith("go:")) return onGo(ctx, cq, u, answer);
  if (d.startsWith("buy:")) {
    await ctx.tg.call("answerCallbackQuery", { callback_query_id: cq.id, text: (await msg(ctx, "payLater")).text.slice(0, 190), show_alert: true }).catch(() => {
    });
    const m = /^buy:(\d+):(\d+)-(\d+)$/.exec(d);
    if (m) {
      const p = await ctx.db.first(`SELECT buttons FROM posts WHERE id = ?`, [+m[1]]);
      const b = p && (JSON.parse(p.buttons || "[]")[+m[2]] || [])[+m[3]];
      if (b) await ctx.db.run(`INSERT INTO clicks (post_id, tg_id, btn, at) VALUES (?, ?, ?, ?)`, [+m[1], id, b.text, ctx.now]);
    }
    return;
  }
  await answer();
}
async function onUserCommand(ctx, msg2, cmd) {
  const id = msg2.from.id;
  const u = await getUser(ctx, id);
  if (cmd === "level" || cmd === "delete") await delMsg(ctx, id, msg2.message_id);
  if (cmd === "stop") {
    if (u) {
      await ctx.db.run(`UPDATE users SET status = 'stopped', consent_ads_at = NULL WHERE tg_id = ?`, [id]);
      await logConsent(ctx, id, "ads", false);
    }
    return say(ctx, id, "stopped");
  }
  if (cmd === "level") return u ? askLevel(ctx, id) : say(ctx, id, "needStart");
  if (cmd === "policy") return say(ctx, id, "policy", await docVars(ctx), { link_preview_options: { is_disabled: true } });
  if (cmd === "delete") {
    return tech(ctx, id, say(ctx, id, "deleteAsk", {}, { reply_markup: kb2([[{ text: await btn(ctx, "deleteYes"), callback_data: "del:yes" }, { text: await btn(ctx, "deleteNo"), callback_data: "del:no" }]]) }));
  }
  if (cmd === "id") return ctx.tg.call("sendMessage", { chat_id: id, text: `Твой Telegram-id: ${id}` });
  return say(ctx, id, "unknown");
}
async function onGo(ctx, cq, u, answer) {
  const id = cq.from.id;
  const m = /^go:(\d+):(\d+)-(\d+)$/.exec(cq.data || "");
  if (!m) return answer();
  const src = await ctx.db.first(`SELECT id, buttons, once FROM posts WHERE id = ?`, [+m[1]]);
  const rows = src ? JSON.parse(src.buttons || "[]") : [];
  const b = (rows[+m[2]] || [])[+m[3]];
  if (!b || !b.go) return answer();
  const k = "go:" + id + ":" + cq.data.slice(3);
  const fresh = await ctx.db.run(
    `INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value WHERE CAST(settings.value AS INTEGER) <= ?`,
    [k, String(ctx.now), ctx.now - 3]
  );
  if (!fresh.changes) return answer();
  await answer();
  await ctx.db.run(`INSERT INTO clicks (post_id, tg_id, btn, at) VALUES (?, ?, ?, ?)`, [src.id, id, b.text, ctx.now]);
  const mid = cq.message && cq.message.message_id;
  if (src.once && mid) {
    const kb3 = { inline_keyboard: [[{ text: "✓ " + b.text, callback_data: "go:done" }]] };
    await ctx.tg.call("editMessageReplyMarkup", { chat_id: id, message_id: mid, reply_markup: kb3 }).catch(() => {
    });
  }
  const target = await ctx.db.first(`SELECT * FROM posts WHERE id = ?`, [+b.go]);
  const admin = await isAdmin(ctx, id);
  if (!target || target.status === "archived" || target.status !== "active" && !admin) return;
  try {
    await sendPost(ctx.tg, id, target, { uid: id, publicUrl: ctx.publicUrl, arrow: await btn(ctx, "buttonsArrow"), docs: await loadDocs(ctx) });
    await ctx.db.run(`INSERT INTO deliveries (post_id, tg_id, sent_at, ok) VALUES (?, ?, ?, 1) ON CONFLICT(post_id, tg_id) DO UPDATE SET sent_at = excluded.sent_at, ok = 1`, [target.id, id, ctx.now]);
  } catch (e) {
    if (e.code === 403) await ctx.db.run(`UPDATE users SET status = 'blocked' WHERE tg_id = ?`, [id]);
  }
}

// src/core.js
function makeCtx({ db, env, publicUrl, fetchFn, now }) {
  const tg = makeTg({ token: env.BOT_TOKEN, root: env.TG_API_ROOT, relayKey: env.TG_RELAY_KEY, fetchFn });
  return { db, env, tg, publicUrl: publicUrl || env.PUBLIC_URL || "", now: now || nowSec() };
}
var ALIAS = {
  "новый": "new",
  "посты": "posts",
  "стат": "stats",
  "статистика": "stats",
  "отмена": "cancel",
  "помощь": "help",
  "админы": "admins",
  "панель": "admin",
  "тексты": "texts",
  "проверка": "check",
  "стоп": "stop",
  "уровень": "level",
  "удалить": "delete",
  "политика": "policy"
};
function parseCommand(text) {
  const m = /^\/([^\s@]+)(?:@\S+)?\s*([\s\S]*)$/.exec(text || "");
  if (!m) return null;
  const c = m[1].toLowerCase();
  return { cmd: ALIAS[c] || c, arg: m[2].trim() };
}
async function handleUpdate(ctx, upd) {
  const who = upd.message && upd.message.from || upd.callback_query && upd.callback_query.from;
  if (who && who.first_name) ctx.userName = who.first_name;
  if (upd.my_chat_member) {
    const st = upd.my_chat_member.new_chat_member && upd.my_chat_member.new_chat_member.status;
    if (st === "kicked") await ctx.db.run(`UPDATE users SET status = 'blocked' WHERE tg_id = ?`, [upd.my_chat_member.from.id]);
    return;
  }
  if (upd.callback_query) {
    const cq = upd.callback_query;
    const d = cq.data || "";
    if (/^(w:|p:|pl|h:|t:)/.test(d)) {
      await ctx.tg.call("answerCallbackQuery", { callback_query_id: cq.id }).catch(() => {
      });
      if (!await isAdmin(ctx, cq.from.id)) return;
      return onAdminCallback(ctx, cq);
    }
    return onUserCallback(ctx, cq);
  }
  const msg2 = upd.message;
  if (!msg2 || !msg2.from || msg2.chat.type !== "private") return;
  const admin = await isAdmin(ctx, msg2.from.id);
  const c = msg2.text ? parseCommand(msg2.text) : null;
  if (c) {
    if (c.cmd === "start") return onStart(ctx, msg2, c.arg);
    if (admin) {
      const r = await onAdminCommand(ctx, msg2, c.cmd, c.arg);
      if (r !== null) return r;
    }
    return onUserCommand(ctx, msg2, c.cmd);
  }
  if (admin && await onAdminMessage(ctx, msg2)) return;
  return onUserCommand(ctx, msg2, "");
}
async function tick(ctx, budget, queryBudget) {
  const now = ctx.now;
  let q = 0;
  const raw = ctx.db;
  const db = { all: (...a) => (q++, raw.all(...a)), first: (...a) => (q++, raw.first(...a)), run: (...a) => (q++, raw.run(...a)) };
  ctx = { ...ctx, db };
  const maxQ = queryBudget || 1e9;
  await ctx.db.run(`INSERT INTO settings (key, value) VALUES ('last_tick', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`, [String(now)]);
  const pause2 = await ctx.db.first(`SELECT value FROM settings WHERE key = 'pause_until'`);
  if (pause2 && +pause2.value > now) return { sent: 0, paused: true };
  const posts = await ctx.db.all(
    `SELECT * FROM posts WHERE status = 'active' AND ((kind = 'date' AND run_at <= ?) OR kind = 'drip')
     ORDER BY CASE kind WHEN 'date' THEN 0 ELSE 1 END, run_at, day, send_time, pos, id`,
    [now]
  );
  const posRow = await ctx.db.first(`SELECT value FROM settings WHERE key = 'tick_pos'`);
  const start = posts.length ? (posRow ? +posRow.value : 0) % posts.length : 0;
  const ordered = [...posts.slice(start), ...posts.slice(0, start)];
  let left = budget, sent = 0, done = 0, arrow = null;
  for (const p of ordered) {
    if (left <= 0 || q >= maxQ - 3) break;
    done++;
    const media = p.media ? JSON.parse(p.media) : [];
    const long = (p.text || "").length > 1024;
    const per = media.length > 1 ? 1 + (p.buttons || long ? 1 : 0) : media.length === 1 ? 1 + (long ? 1 : 0) : 1;
    const can = Math.floor(left / per);
    if (can <= 0) break;
    const users = await dueUsers(ctx.db, p, now, can);
    if (!users.length) continue;
    if (arrow === null) {
      arrow = await btn(ctx, "buttonsArrow");
      ctx.docs = await loadDocs(ctx);
    }
    const rows = [];
    let stop = false;
    for (const u of users) {
      try {
        await sendPost(ctx.tg, u.tg_id, p, { uid: u.tg_id, publicUrl: ctx.publicUrl, arrow, docs: ctx.docs });
        rows.push({ tg_id: u.tg_id, ok: true });
        sent++;
      } catch (e) {
        if (e.code === 403) {
          rows.push({ tg_id: u.tg_id, ok: false });
          await ctx.db.run(`UPDATE users SET status = 'blocked' WHERE tg_id = ?`, [u.tg_id]);
        } else if (e.code === 429) {
          await ctx.db.run(`INSERT INTO settings (key, value) VALUES ('pause_until', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`, [String(now + (e.retryAfter || 30))]);
          stop = true;
          break;
        } else if (e.code === 400) rows.push({ tg_id: u.tg_id, ok: false });
        else {
          stop = true;
          break;
        }
      }
      left -= per;
    }
    await recordDeliveries(ctx.db, p.id, rows, now);
    if (stop) break;
  }
  if (posts.length) await ctx.db.run(`INSERT INTO settings (key, value) VALUES ('tick_pos', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`, [String((start + Math.max(done, 1)) % posts.length)]);
  return { sent, queries: q };
}
async function setup(ctx, { webhookUrl, polling }) {
  const out = [];
  const v = await migrate(ctx.db);
  out.push(`База готова (версия ${v})`);
  if (polling) {
    await ctx.tg.call("deleteWebhook", {});
    out.push("Режим без вебхука: сервер сам забирает сообщения");
  } else {
    await ctx.tg.call("setWebhook", {
      url: webhookUrl,
      secret_token: ctx.env.WEBHOOK_SECRET || void 0,
      allowed_updates: ["message", "callback_query", "my_chat_member"],
      drop_pending_updates: false
    });
    out.push("Вебхук установлен: " + webhookUrl);
  }
  await ctx.tg.call("setMyCommands", { commands: await userCommands(ctx) });
  const admins = [...envAdmins(ctx.env), ...(await ctx.db.all(`SELECT tg_id FROM admins`)).map((r) => r.tg_id)];
  const ac = await adminCommands(ctx);
  for (const a of new Set(admins)) await ctx.tg.call("setMyCommands", { commands: ac, scope: { type: "chat", chat_id: a } }).catch(() => {
  });
  out.push("Меню команд обновлено, админов: " + new Set(admins).size);
  const me = await ctx.tg.call("getMe");
  out.push("Бот: @" + me.username);
  return out;
}
async function clickRedirect(ctx, postId, btn2, uid) {
  const p = await ctx.db.first(`SELECT buttons FROM posts WHERE id = ?`, [postId]);
  if (!p || !p.buttons) return null;
  const [ri, bi] = String(btn2).split("-").map(Number);
  const b = (JSON.parse(p.buttons)[ri] || [])[bi];
  if (!b) return null;
  await ctx.db.run(`INSERT INTO clicks (post_id, tg_id, btn, at) VALUES (?, ?, ?, ?)`, [postId, Number(uid) || null, b.text, ctx.now]);
  return b.url;
}
var TABLES = ["users", "consents", "admins", "posts", "deliveries", "clicks", "settings"];
async function exportAll(db) {
  const v = await db.first(`SELECT MAX(v) AS v FROM schema_version`);
  const out = { format: "di-sign-bot-backup", schema: v ? v.v : 0, exported_at: (/* @__PURE__ */ new Date()).toISOString(), tables: {} };
  for (const t of TABLES) out.tables[t] = await db.all(`SELECT * FROM ${t}`);
  return out;
}

// src/fmt.js
var TAGS = [["**", "bold"], ["__", "italic"], ["~~", "strikethrough"]];
function mdToEntities(src) {
  const s = String(src || "").replace(/\r\n?/g, "\n");
  let out = "";
  const ents = [];
  const open = {};
  let i = 0;
  while (i < s.length) {
    if (s[i] === "[") {
      const m = /^\[([^\]\n]+)\]\((https?:\/\/[^\s)]+|t\.me\/[^\s)]+)\)/i.exec(s.slice(i));
      if (m) {
        const off = out.length;
        out += m[1];
        let url = m[2];
        if (/^t\.me\//i.test(url)) url = "https://" + url;
        ents.push({ type: "text_link", offset: off, length: m[1].length, url });
        i += m[0].length;
        continue;
      }
    }
    const t = TAGS.find(([mk]) => s.startsWith(mk, i));
    if (t) {
      const [mk, type] = t;
      if (open[type] === void 0) {
        if (s.indexOf(mk, i + 2) > i + 2) {
          open[type] = out.length;
          i += 2;
          continue;
        }
      } else {
        const off = open[type];
        delete open[type];
        if (out.length > off) ents.push({ type, offset: off, length: out.length - off });
        i += 2;
        continue;
      }
    }
    out += s[i];
    i++;
  }
  ents.sort((a, b) => a.offset - b.offset || b.length - a.length);
  return { text: out, entities: ents };
}
var MD_OK = /* @__PURE__ */ new Set(["bold", "italic", "strikethrough", "text_link", "url", "mention", "hashtag", "email", "phone_number", "bot_command"]);
function entitiesToMd(text, entities) {
  const t = String(text || "");
  const ents = (entities || []).slice();
  const rich = ents.some((e) => !MD_OK.has(e.type));
  const marks = [];
  for (const e of ents) {
    if (e.type === "bold") marks.push([e.offset, e.offset + e.length, "**", "**"]);
    else if (e.type === "italic") marks.push([e.offset, e.offset + e.length, "__", "__"]);
    else if (e.type === "strikethrough") marks.push([e.offset, e.offset + e.length, "~~", "~~"]);
    else if (e.type === "text_link") marks.push([e.offset, e.offset + e.length, "[", "](" + e.url + ")"]);
  }
  const ins = {};
  const add = (pos, s, front) => {
    ins[pos] = ins[pos] || [];
    front ? ins[pos].unshift(s) : ins[pos].push(s);
  };
  for (const [a, b, o, c] of marks) {
    add(a, o, false);
    add(b, "\0" + c, true);
  }
  let out = "";
  for (let i = 0; i <= t.length; i++) {
    if (ins[i]) {
      const list = ins[i];
      out += list.filter((x) => x[0] === "\0").map((x) => x.slice(1)).join("") + list.filter((x) => x[0] !== "\0").join("");
    }
    if (i < t.length) out += t[i];
  }
  return { md: out, rich };
}

// src/testrun.js
var sleep2 = (ms) => new Promise((r) => setTimeout(r, ms));
var fitsLevel = (p, level) => !level || level === "all" || p.audience === "all" || p.audience === level;
async function feedOrder(db, level, { withDrafts = false } = {}) {
  const all = await db.all(`SELECT * FROM posts WHERE kind IN ('drip', 'gift') AND status IN (${withDrafts ? "'active','paused','draft'" : "'active'"})`);
  const byId = Object.fromEntries(all.map((p) => [p.id, p]));
  const gifts = all.filter((p) => p.kind === "gift" && fitsLevel(p, level)).sort((a, b) => a.id - b.id);
  const drip = all.filter((p) => p.kind === "drip" && fitsLevel(p, level)).map((p) => ({ p, off: offsetMin(p, byId) })).sort((a, b) => a.off - b.off || (a.p.pos || 0) - (b.p.pos || 0) || a.p.id - b.p.id);
  return { gifts, drip, byId };
}
function whenLabel(p, off, byId) {
  if (p.kind === "gift") return "🎁 подарок после теста";
  if (p.mode === "timer") return `⏱ через ${fmtDelay(p.delay_min)} после входа`;
  if (p.mode === "after") {
    const par = byId && byId[p.after_id];
    return `↳ через ${fmtDelay(p.delay_min)} после «${par ? (par.title || (par.text || "").split("\n")[0]).slice(0, 30) : "#" + p.after_id}»`;
  }
  return Number(p.day) === 0 ? "день 0 · сразу после входа" : `день ${p.day} · ${p.send_time}`;
}
async function sendLabeled(ctx, chatId, p, label, arrow) {
  await ctx.tg.call("sendMessage", { chat_id: chatId, text: "🧪 " + label + (p.title ? ` · «${p.title}»` : ""), disable_notification: true });
  await sendPost(ctx.tg, chatId, p, { uid: chatId, publicUrl: ctx.publicUrl, arrow, docs: await loadDocs(ctx) });
}
async function runPreview(ctx, adminId, level, pauseMs = 900) {
  const { gifts, drip, byId } = await feedOrder(ctx.db, level);
  const items = [...gifts.map((p) => ({ p, off: -1 })), ...drip];
  const MAX = 14;
  const arrow = await btn(ctx, "buttonsArrow");
  await ctx.tg.call("sendMessage", { chat_id: adminId, text: `🧪 Предпросмотр ленты — как её получит ${level && level !== "all" ? AUD[level].replace(/им$/, "ий") : "любой ученик"}.
Постов: ${items.length}${items.length > MAX ? ` (покажу первые ${MAX})` : ""}. Подпись над каждым — когда он придёт.` });
  let n = 0;
  for (const it of items.slice(0, MAX)) {
    const k = ctx.env.DELAY_FACTOR === void 0 ? 1 : Number(ctx.env.DELAY_FACTOR);
    if (pauseMs && k > 0) await sleep2(pauseMs * k);
    try {
      await sendLabeled(ctx, adminId, it.p, whenLabel(it.p, it.off, byId), arrow);
      n++;
    } catch (e) {
      await ctx.tg.call("sendMessage", { chat_id: adminId, text: `⚠️ Пост #${it.p.id} не отправился: ${e.message}` }).catch(() => {
      });
    }
  }
  if (!items.length) await ctx.tg.call("sendMessage", { chat_id: adminId, text: "Включённых постов пока нет — создай в боте: /new" });
  else await ctx.tg.call("sendMessage", { chat_id: adminId, text: `🧪 Конец предпросмотра · показано ${n}` });
  return n;
}
async function startFastRun(ctx, adminId, level) {
  await ctx.db.run(`UPDATE test_runs SET status = 'stopped' WHERE admin_id = ? AND status = 'active'`, [adminId]);
  await ctx.db.run(`INSERT INTO test_runs (admin_id, level, started_at, scale, status) VALUES (?, ?, ?, 1440, 'active')`, [adminId, level || "all", ctx.now]);
  const run = await ctx.db.first(`SELECT * FROM test_runs WHERE admin_id = ? AND status = 'active' ORDER BY id DESC LIMIT 1`, [adminId]);
  const { drip } = await feedOrder(ctx.db, level);
  const last = drip.length ? Math.max(...drip.map((x) => x.off)) : 0;
  await ctx.tg.call("sendMessage", { chat_id: adminId, text: `⏩ Ускоренный тест начался: 1 день = 1 минута.
Лента придёт тебе в реальном порядке и с паузами, примерно за ${Math.max(1, Math.ceil(last / 1440) + 1)} мин. Остановить — в панели «⏹ Остановить».` });
  return run;
}
async function stopRuns(ctx, adminId) {
  await ctx.db.run(`UPDATE test_runs SET status = 'stopped' WHERE admin_id = ? AND status = 'active'`, [adminId]);
}
async function stepRuns(ctx, budget = 10) {
  const runs = await ctx.db.all(`SELECT * FROM test_runs WHERE status = 'active' ORDER BY id LIMIT 3`);
  let left = budget;
  for (const run of runs) {
    if (ctx.now - run.started_at > 3 * 3600) {
      await ctx.db.run(`UPDATE test_runs SET status = 'done' WHERE id = ?`, [run.id]);
      continue;
    }
    const vmin = (ctx.now - run.started_at) * (run.scale || 1440) / 60;
    const { gifts, drip, byId } = await feedOrder(ctx.db, run.level);
    const sent = new Set((await ctx.db.all(`SELECT post_id FROM test_sent WHERE run_id = ?`, [run.id])).map((r) => r.post_id));
    const queue = [...gifts.map((p) => ({ p, off: -1 })), ...drip].filter((x) => !sent.has(x.p.id));
    const due = queue.filter((x) => x.off <= vmin);
    const arrow = due.length ? await btn(ctx, "buttonsArrow") : "";
    for (const it of due) {
      if (left < 3) break;
      try {
        await sendLabeled(ctx, run.admin_id, it.p, whenLabel(it.p, it.off, byId), arrow);
      } catch (e) {
        await ctx.tg.call("sendMessage", { chat_id: run.admin_id, text: `⚠️ Пост #${it.p.id} не отправился: ${e.message}` }).catch(() => {
        });
      }
      left -= 3;
      await ctx.db.run(`INSERT OR IGNORE INTO test_sent (run_id, post_id, at) VALUES (?, ?, ?)`, [run.id, it.p.id, ctx.now]);
      sent.add(it.p.id);
    }
    if (queue.every((x) => sent.has(x.p.id))) {
      await ctx.db.run(`UPDATE test_runs SET status = 'done' WHERE id = ?`, [run.id]);
      await ctx.tg.call("sendMessage", { chat_id: run.admin_id, text: "⏩ Ускоренный тест закончен — это вся лента 🐾" }).catch(() => {
      });
    }
  }
}
async function activeRun(db, adminId) {
  const r = await db.first(`SELECT * FROM test_runs WHERE admin_id = ? AND status = 'active' ORDER BY id DESC LIMIT 1`, [adminId]);
  if (!r) return null;
  const sent = await db.first(`SELECT COUNT(*) AS n FROM test_sent WHERE run_id = ?`, [r.id]);
  return { id: r.id, level: r.level, started_at: r.started_at, sent: sent.n };
}

// src/panel-api.js
var enc = new TextEncoder();
async function hmac(key, data) {
  const k = await crypto.subtle.importKey("raw", typeof key === "string" ? enc.encode(key) : key, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", k, enc.encode(data)));
}
var hex = (b) => [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
async function checkInitData(initData, botToken, now, maxAge = 86400) {
  if (!initData || !botToken) return null;
  const p = new URLSearchParams(initData);
  const hash = p.get("hash");
  if (!hash) return null;
  p.delete("hash");
  const dcs = [...p.entries()].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([k, v]) => `${k}=${v}`).join("\n");
  const secret = await hmac("WebAppData", botToken);
  const calc = hex(await hmac(secret, dcs));
  if (calc.length !== hash.length) return null;
  let diff = 0;
  for (let i = 0; i < calc.length; i++) diff |= calc.charCodeAt(i) ^ hash.charCodeAt(i);
  if (diff) return null;
  const at = Number(p.get("auth_date") || 0);
  if (!at || now - at > maxAge) return null;
  try {
    return JSON.parse(p.get("user") || "null");
  } catch {
    return null;
  }
}
var json = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });
var j2 = (s, d) => {
  try {
    return s ? JSON.parse(s) : d;
  } catch {
    return d;
  }
};
var TIME = /^([01]?\d|2[0-3]):([0-5]\d)$/;
var pad = (t) => {
  const m = TIME.exec(t || "");
  return m ? `${m[1].padStart(2, "0")}:${m[2]}` : null;
};
function postOut(p, sent, clicks) {
  const media = j2(p.media, []);
  const f = entitiesToMd(p.text || "", j2(p.entities, []));
  return {
    id: p.id,
    kind: p.kind,
    status: p.status,
    title: p.title || "",
    text: (p.text || "").slice(0, 400),
    md: f.md,
    rich: f.rich,
    once: !!p.once,
    files: media,
    day: p.day,
    time: p.send_time,
    mode: p.mode || "day",
    delay: p.delay_min || 0,
    after: p.after_id || null,
    run_at: p.run_at,
    audience: p.audience,
    catchup: !!p.catchup,
    pos: p.pos || 0,
    media: media.map((m) => m.type),
    buttons: j2(p.buttons, []).flat().map((b) => b.text),
    rows: j2(p.buttons, []),
    emoji: j2(p.entities, []).some((e) => e.type === "custom_emoji"),
    sent: sent || 0,
    clicks: clicks || 0
  };
}
async function handlePanelApi(ctx, request, url) {
  const init = request.headers.get("x-init-data") || "";
  const user = await checkInitData(init, ctx.env.BOT_TOKEN, ctx.now);
  if (!user) return json({ error: "Открой панель из бота: /admin" }, 401);
  if (!await isAdmin(ctx, user.id)) return json({ error: "Панель только для админов" }, 403);
  ctx.userName = user.first_name;
  const path = url.pathname.replace(/^\/api\/panel/, "");
  if (path === "/upload" && request.method === "POST") {
    let file;
    try {
      file = (await request.formData()).get("file");
    } catch {
      file = null;
    }
    const r = await uploadFile(ctx, user, file, true);
    return json(r, r.error ? 400 : 200);
  }
  if (path === "/file") {
    const fid = url.searchParams.get("id") || "";
    if (!/^[\w-]{10,200}$/.test(fid)) return json({ error: "Неверный файл" }, 400);
    try {
      const r = await ctx.tg.download(fid);
      return new Response(r.body, { headers: { "content-type": r.headers.get("content-type") || "image/jpeg", "cache-control": "private, max-age=600" } });
    } catch (e) {
      return json({ error: "Не получилось загрузить превью" }, 400);
    }
  }
  let mm = /^\/msg\/([A-Za-z_]+)\/media$/.exec(path);
  if (mm && request.method === "POST") {
    const key = mm[1];
    if (!canMedia(key)) return json({ error: "К этому сообщению картинку не прикрепить" }, 400);
    let file;
    try {
      file = (await request.formData()).get("file");
    } catch {
      file = null;
    }
    if (!file || typeof file === "string") return json({ error: "Файл не пришёл" }, 400);
    const type = (file.type || "").toLowerCase();
    const kind = type === "image/gif" ? "animation" : type.startsWith("image/") ? "photo" : type.startsWith("video/") ? "video" : null;
    if (!kind) return json({ error: "Нужна картинка (jpg, png, webp, gif) или видео mp4" }, 400);
    const max = kind === "photo" ? 10 : 50;
    if (file.size > max * 1024 * 1024) return json({ error: `Файл больше ${max} МБ — Telegram такой не примет` }, 400);
    const form = new FormData();
    form.append("chat_id", String(user.id));
    form.append("disable_notification", "true");
    form.append(kind, file, file.name || "file");
    let res;
    try {
      res = await ctx.tg.upload({ photo: "sendPhoto", video: "sendVideo", animation: "sendAnimation" }[kind], form);
    } catch (e) {
      return json({ error: "Telegram не принял файл: " + e.message }, 400);
    }
    const fid = kind === "photo" ? res.photo && res.photo[res.photo.length - 1].file_id : (res[kind] || res.document || res.video || {}).file_id;
    if (!fid) return json({ error: "Telegram не вернул файл" }, 400);
    await ctx.tg.call("deleteMessage", { chat_id: user.id, message_id: res.message_id }).catch(() => {
    });
    await setMsgMedia(ctx, key, { type: kind, file_id: fid });
    return json({ ok: true, msgs: await listMsgs(ctx) });
  }
  mm = /^\/msg\/([A-Za-z_]+)\/img$/.exec(path);
  if (mm) {
    const o = (await loadMsgs(ctx))[mm[1]];
    if (!o || !o.media) return json({ error: "Картинки нет" }, 404);
    try {
      const r = await ctx.tg.download(o.media.file_id);
      return new Response(r.body, { headers: { "content-type": r.headers.get("content-type") || "image/jpeg", "cache-control": "private, max-age=300" } });
    } catch (e) {
      return json({ error: "Не получилось загрузить превью" }, 400);
    }
  }
  const body = request.method === "POST" ? await request.json().catch(() => ({})) : {};
  if (path === "/state") {
    const posts = await ctx.db.all(`SELECT * FROM posts WHERE status != 'archived' ORDER BY day, send_time, pos, id`);
    const sent = Object.fromEntries((await ctx.db.all(`SELECT post_id, COUNT(*) AS n FROM deliveries GROUP BY post_id`)).map((r) => [r.post_id, r.n]));
    const clicks = Object.fromEntries((await ctx.db.all(`SELECT post_id, COUNT(*) AS n FROM clicks GROUP BY post_id`)).map((r) => [r.post_id, r.n]));
    const people = await ctx.db.first(`SELECT COUNT(*) AS n, SUM(CASE WHEN status = 'active' THEN 1 ELSE 0 END) AS active FROM users`);
    return json({
      me: { id: user.id, name: user.first_name },
      audiences: AUD,
      levels: LEVELS,
      posts: posts.map((p) => postOut(p, sent[p.id], clicks[p.id])),
      msgs: await listMsgs(ctx),
      docs: await loadDocs(ctx),
      docNames: DOCS,
      people: { all: people.n || 0, active: people.active || 0 },
      run: await activeRun(ctx.db, user.id)
    });
  }
  let m = /^\/post\/(\d+)$/.exec(path);
  if (m && request.method === "POST") {
    const id = +m[1];
    const p = await ctx.db.first(`SELECT * FROM posts WHERE id = ?`, [id]);
    if (!p) return json({ error: "Пост не найден" }, 404);
    const set = [], val = [];
    const put = (col, v) => {
      set.push(`${col} = ?`);
      val.push(v);
    };
    if (body.mode !== void 0 && p.kind === "drip") {
      if (!["day", "timer", "after"].includes(body.mode)) return json({ error: "Неизвестный способ отправки" }, 400);
      put("mode", body.mode);
      if (body.mode !== "day") {
        const dm = parseInt(body.delay_min, 10);
        if (!(dm >= 0 && dm <= 365 * 1440)) return json({ error: "Время — от 0 минут до 365 дней" }, 400);
        put("delay_min", dm);
      }
      if (body.mode === "after") {
        const aid = parseInt(body.after_id, 10);
        if (!aid || aid === p.id) return json({ error: "Выбери пост, после которого отправлять" }, 400);
        let cur = await ctx.db.first(`SELECT id, kind, mode, after_id FROM posts WHERE id = ?`, [aid]);
        if (!cur || !["drip", "node", "gift"].includes(cur.kind)) return json({ error: "Такого поста нет" }, 400);
        for (let i = 0; cur && cur.mode === "after" && i < 50; i++) {
          if (cur.after_id === p.id) return json({ error: "Получится круг: тот пост уже идёт после этого" }, 400);
          cur = await ctx.db.first(`SELECT id, kind, mode, after_id FROM posts WHERE id = ?`, [cur.after_id]);
        }
        put("after_id", aid);
      }
    }
    if (body.day !== void 0 && p.kind === "drip") {
      const d = parseInt(body.day, 10);
      if (!(d >= 0 && d <= 365)) return json({ error: "День — от 0 до 365" }, 400);
      put("day", d);
    }
    if (body.time !== void 0) {
      const t = pad(body.time);
      if (!t) return json({ error: "Время в формате 11:00" }, 400);
      put("send_time", t);
    }
    if (body.audience !== void 0) {
      if (!AUD[body.audience]) return json({ error: "Неизвестная аудитория" }, 400);
      put("audience", body.audience);
    }
    if (body.status !== void 0) {
      if (!["active", "paused", "draft", "archived"].includes(body.status)) return json({ error: "Неизвестный статус" }, 400);
      if (body.status === "active" && p.kind === "date" && !(body.run_at || p.run_at)) return json({ error: "Сначала задай дату" }, 400);
      put("status", body.status);
    }
    if (body.title !== void 0) put("title", String(body.title).slice(0, 80) || null);
    if (body.rows !== void 0) {
      const r = await cleanButtons(ctx, body.rows, id);
      if (r.error) return json({ error: r.error }, 400);
      put("buttons", r.rows.length ? JSON.stringify(r.rows) : null);
    }
    if (body.once !== void 0) put("once", body.once ? 1 : 0);
    if (body.md !== void 0) {
      const f = mdToEntities(body.md);
      if (f.text.length > 4096) return json({ error: "Текст длиннее 4096 знаков — Telegram не примет" }, 400);
      put("text", f.text);
      put("entities", JSON.stringify(f.entities));
    }
    if (body.files !== void 0) {
      const r = cleanFiles(body.files);
      if (r.error) return json({ error: r.error }, 400);
      put("media", JSON.stringify(r.files));
    }
    if (body.catchup !== void 0) put("catchup", body.catchup ? 1 : 0);
    if (body.run_at !== void 0 && p.kind === "date") {
      const t = Number(body.run_at);
      if (!(t > 0)) return json({ error: "Неверная дата" }, 400);
      put("run_at", t);
    }
    if (set.length) await ctx.db.run(`UPDATE posts SET ${set.join(", ")} WHERE id = ?`, [...val, id]);
    let np = await ctx.db.first(`SELECT * FROM posts WHERE id = ?`, [id]);
    if (np.status === "active" && !(np.text || "").trim() && !j2(np.media, []).length) {
      await ctx.db.run(`UPDATE posts SET status = 'draft' WHERE id = ?`, [id]);
      return json({ error: "Пустой пост нельзя включить — добавь текст или картинку. Остальное сохранено, пост в черновиках." }, 400);
    }
    return json({ ok: true, post: postOut(np), reach: await audienceCount(ctx.db, np) });
  }
  if (path === "/post/new" && request.method === "POST") {
    const kind = body.kind;
    if (!["drip", "date", "gift", "node"].includes(kind)) return json({ error: "Выбери, когда уходит пост" }, 400);
    const f = mdToEntities(body.md || "");
    const files = cleanFiles(body.files || []);
    if (files.error) return json({ error: files.error }, 400);
    if (f.text.length > 4096) return json({ error: "Текст длиннее 4096 знаков — Telegram не примет" }, 400);
    const status = ["active", "draft", "paused"].includes(body.status) ? body.status : "draft";
    if (!f.text.trim() && !files.files.length && status !== "draft") return json({ error: "Добавь текст или картинку" }, 400);
    if (status === "active" && kind === "date" && !(Number(body.run_at) > 0)) return json({ error: "Сначала задай дату" }, 400);
    const audience = AUD[body.audience] ? body.audience : "all";
    const day = Math.max(0, Math.min(365, parseInt(body.day, 10) || 0));
    const time = pad(body.time) || "11:00";
    const mode = ["day", "timer", "after"].includes(body.mode) ? body.mode : "day";
    await ctx.db.run(
      `INSERT INTO posts (title, kind, audience, day, send_time, run_at, catchup, status, text, entities, media, buttons, created_by, created_at, mode, delay_min, after_id, once)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?)`,
      [
        String(body.title || "").slice(0, 80) || null,
        kind,
        audience,
        kind === "drip" ? day : null,
        day === 0 && kind === "drip" && mode === "day" ? "00:00" : time,
        kind === "date" ? Number(body.run_at) || null : null,
        body.catchup ? 1 : 0,
        status,
        f.text,
        JSON.stringify(f.entities),
        JSON.stringify(files.files),
        user.id,
        ctx.now,
        kind === "drip" ? mode : "day",
        Math.max(0, parseInt(body.delay_min, 10) || 0),
        parseInt(body.after_id, 10) || null,
        body.once ? 1 : 0
      ]
    );
    const row = await ctx.db.first(`SELECT * FROM posts WHERE created_by = ? ORDER BY id DESC LIMIT 1`, [user.id]);
    if (body.rows) {
      const r = await cleanButtons(ctx, body.rows, row.id);
      if (r.error) {
        await ctx.db.run(`UPDATE posts SET status = 'draft' WHERE id = ?`, [row.id]);
        return json({ error: r.error, post: postOut(row) }, 400);
      }
      if (r.rows.length) await ctx.db.run(`UPDATE posts SET buttons = ? WHERE id = ?`, [JSON.stringify(r.rows), row.id]);
    }
    const np = await ctx.db.first(`SELECT * FROM posts WHERE id = ?`, [row.id]);
    return json({ ok: true, post: postOut(np), reach: await audienceCount(ctx.db, np) });
  }
  if (path === "/docs" && request.method === "POST") {
    for (const k of ["policy", "consent", "offer", "owner"]) {
      if (body[k] === void 0) continue;
      let v = String(body[k] || "").trim().slice(0, 400);
      if (k !== "owner" && v) {
        if (/^t\.me\//i.test(v)) v = "https://" + v;
        if (!/^https?:\/\/\S+$/i.test(v)) return json({ error: `Ссылка «${DOCS[k]}» должна начинаться с https://` }, 400);
      }
      if (v) await ctx.db.run(`INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`, ["doc:" + k, v]);
      else await ctx.db.run(`DELETE FROM settings WHERE key = ?`, ["doc:" + k]);
    }
    ctx._docs = null;
    return json({ ok: true, docs: await loadDocs(ctx) });
  }
  if (path === "/reorder" && request.method === "POST") {
    const items = Array.isArray(body.items) ? body.items.slice(0, 200) : [];
    for (const it of items) {
      const d = parseInt(it.day, 10), t = pad(it.time), pos = parseInt(it.pos, 10) || 0;
      if (!(d >= 0 && d <= 365) || !t) return json({ error: "Неверный день или время" }, 400);
    }
    for (const it of items) {
      await ctx.db.run(`UPDATE posts SET day = ?, send_time = ?, pos = ?, mode = 'day' WHERE id = ? AND kind = 'drip'`, [parseInt(it.day, 10), pad(it.time), parseInt(it.pos, 10) || 0, +it.id]);
    }
    return json({ ok: true, n: items.length });
  }
  if (path === "/run/preview" && request.method === "POST") {
    const level = ["start", "pro"].includes(body.level) ? body.level : "all";
    const job = runPreview(ctx, user.id, level).catch((e) => console.log("preview", e && e.stack));
    if (ctx.waitUntil) ctx.waitUntil(job);
    else await job;
    return json({ ok: true });
  }
  if (path === "/run/fast" && request.method === "POST") {
    const level = ["start", "pro"].includes(body.level) ? body.level : "all";
    await startFastRun(ctx, user.id, level);
    const job = stepRuns(ctx, 12).catch((e) => console.log("run", e && e.stack));
    if (ctx.waitUntil) ctx.waitUntil(job);
    else await job;
    return json({ ok: true, run: await activeRun(ctx.db, user.id) });
  }
  if (path === "/run/onboarding" && request.method === "POST") {
    const id = user.id;
    for (const t of ["users", "consents", "states"]) await ctx.db.run(`DELETE FROM ${t} WHERE tg_id = ?`, [id]);
    await ctx.db.run(`DELETE FROM deliveries WHERE tg_id = ? AND post_id IN (SELECT id FROM posts WHERE kind = 'gift')`, [id]);
    await ctx.db.run(`DELETE FROM settings WHERE key = ? OR key LIKE ?`, ["nogift:" + id, "start:" + id + ":%"]);
    await ctx.tg.call("sendMessage", { chat_id: id, text: "🧪 Проходим путь ученика заново" + (body.fromTest ? " — как будто ты пришла из теста." : " — как будто ты пришла без теста.") + " Твоя анкета сброшена, ответь на вопросы бота.", disable_notification: true }).catch(() => {
    });
    const job = onStart(ctx, { from: { id, first_name: user.first_name }, message_id: 0 }, body.fromTest ? "audit_P_" + (body.level === "pro" ? "pro" : "start") : "").catch((e) => console.log("onboarding", e && e.stack));
    if (ctx.waitUntil) ctx.waitUntil(job);
    else await job;
    return json({ ok: true });
  }
  if (path === "/run/stop" && request.method === "POST") {
    await stopRuns(ctx, user.id);
    await ctx.tg.call("sendMessage", { chat_id: user.id, text: "⏹ Ускоренный тест остановлен" }).catch(() => {
    });
    return json({ ok: true });
  }
  m = /^\/post\/(\d+)\/preview$/.exec(path);
  if (m && request.method === "POST") {
    const p = await ctx.db.first(`SELECT * FROM posts WHERE id = ?`, [+m[1]]);
    if (!p) return json({ error: "Пост не найден" }, 404);
    try {
      const r = await sendPost(ctx.tg, user.id, p, { uid: user.id, publicUrl: ctx.publicUrl, arrow: await btn(ctx, "buttonsArrow"), docs: await loadDocs(ctx) });
      return json({ ok: true, warn: r.warn });
    } catch (e) {
      return json({ error: "Telegram не принял пост: " + e.message }, 400);
    }
  }
  m = /^\/msg\/([A-Za-z_]+)$/.exec(path);
  if (m && request.method === "POST") {
    try {
      if (body.reset) await resetMsg(ctx, m[1]);
      else if (body.removeMedia) await setMsgMedia(ctx, m[1], null);
      else {
        if (body.delay !== void 0 || body.links !== void 0) await saveMsgExtra(ctx, m[1], { delay: body.delay, links: body.links });
        if (body.text === void 0) return json({ ok: true, msgs: await listMsgs(ctx) });
        const t = String(body.text || "");
        if (!t.trim()) return json({ error: "Пустой текст" }, 400);
        if (t.length > 4e3) return json({ error: "Слишком длинно для Telegram" }, 400);
        if (body.text === void 0) return json({ error: "Нет текста" }, 400);
        await saveMsg(ctx, m[1], t, []);
      }
      return json({ ok: true, msgs: await listMsgs(ctx) });
    } catch (e) {
      return json({ error: e.message }, 400);
    }
  }
  m = /^\/msg\/([A-Za-z_]+)\/preview$/.exec(path);
  if (m && request.method === "POST") {
    await say(ctx, user.id, m[1], { уровень: LEVELS.start, ...await docVars(ctx) });
    return json({ ok: true });
  }
  return json({ error: "Нет такого действия" }, 404);
}
async function cleanButtons(ctx, rowsIn, selfId) {
  if (!Array.isArray(rowsIn) || rowsIn.length > 10) return { error: "Слишком много рядов (до 10)" };
  const rows = [];
  for (const row of rowsIn) {
    if (!Array.isArray(row)) return { error: "Неверные кнопки" };
    const r = [];
    for (const b of row) {
      if (!b) continue;
      const text = String(b.text || "").trim().slice(0, 60);
      let link = String(b.url || "").trim();
      const go = parseInt(b.go, 10) || null;
      if (!text && !link && !go && !b.doc && !b.pay) continue;
      if (!text) return { error: "У кнопки нет текста" };
      if (go) {
        if (go === selfId) return { error: `Кнопка «${text}» ведёт на этот же пост` };
        const t = await ctx.db.first(`SELECT id FROM posts WHERE id = ? AND status != 'archived'`, [go]);
        if (!t) return { error: `Пост для кнопки «${text}» не найден` };
        r.push({ text, go });
        continue;
      }
      if (b.doc) {
        if (!DOCS[b.doc]) return { error: "Неизвестный документ" };
        r.push({ text, doc: b.doc });
        continue;
      }
      if (b.pay) {
        const pay = ["curator", "mentor"].includes(b.pay) ? b.pay : "curator";
        r.push({ text, pay });
        continue;
      }
      if (/^t\.me\//i.test(link)) link = "https://" + link;
      if (!/^https?:\/\/\S+$/i.test(link)) return { error: `Ссылка у кнопки «${text}» должна начинаться с https://` };
      r.push({ text, url: link });
    }
    if (r.length > 4) return { error: "В одном ряду не больше 4 кнопок" };
    if (r.length) rows.push(r);
  }
  return { rows };
}
var FILE_TYPES = ["photo", "video", "document", "animation"];
function cleanFiles(list) {
  if (!Array.isArray(list)) return { error: "Неверные вложения" };
  if (list.length > 10) return { error: "Не больше 10 вложений" };
  const files = [];
  for (const f of list) {
    if (!f || !FILE_TYPES.includes(f.type) || !/^[\w-]{10,200}$/.test(String(f.file_id || ""))) return { error: "Неверное вложение" };
    files.push({ type: f.type, file_id: String(f.file_id) });
  }
  if (files.length > 1 && files.some((f) => f.type === "document") && files.some((f) => f.type !== "document")) return { error: "В одном посте нельзя смешивать файлы с картинками и видео" };
  return { files };
}
async function uploadFile(ctx, user, file, allowDocs) {
  if (!file || typeof file === "string") return { error: "Файл не пришёл" };
  const type = (file.type || "").toLowerCase();
  let kind = type === "image/gif" ? "animation" : /^image\/(jpeg|png|webp)$/.test(type) ? "photo" : type.startsWith("video/") ? "video" : null;
  if (!kind && allowDocs) kind = "document";
  if (!kind) return { error: "Нужна картинка (jpg, png, webp, gif) или видео mp4" };
  const max = kind === "photo" ? 10 : 50;
  if (file.size > max * 1024 * 1024) return { error: `Файл больше ${max} МБ — Telegram такой не примет` };
  const form = new FormData();
  form.append("chat_id", String(user.id));
  form.append("disable_notification", "true");
  form.append(kind, file, file.name || "file");
  let res;
  try {
    res = await ctx.tg.upload({ photo: "sendPhoto", video: "sendVideo", animation: "sendAnimation", document: "sendDocument" }[kind], form);
  } catch (e) {
    return { error: "Telegram не принял файл: " + e.message };
  }
  const fid = kind === "photo" ? res.photo && res.photo[res.photo.length - 1].file_id : (res[kind] || res.document || res.video || res.animation || {}).file_id;
  if (!fid) return { error: "Telegram не вернул файл" };
  await ctx.tg.call("deleteMessage", { chat_id: user.id, message_id: res.message_id }).catch(() => {
  });
  return { ok: true, file: { type: kind, file_id: fid, name: file.name || "" } };
}

// src/panel-html.js
var panel_html_default = `<!doctype html>
<html lang="ru">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>Панель бота</title>
<script src="https://telegram.org/js/telegram-web-app.js"></script>
<script src="https://cdnjs.cloudflare.com/ajax/libs/Sortable/1.15.2/Sortable.min.js"></script>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=Inter+Tight:wght@400;500;600&family=Instrument+Serif:ital@0;1&display=swap" rel="stylesheet">
<style>
:root{
  --bg:#fffbf7; --card:#fff; --ink:#2c0d02; --soft:rgba(44,13,2,.6); --faint:rgba(44,13,2,.38);
  --line:rgba(44,13,2,.12); --pill:rgba(244,201,246,.45); --blue:#e3f0fc; --good:#3f7d2e; --good-bg:#eaf4e2;
  --warn:#a4421b; --warn-bg:#fbe9df; --shadow:0 1px 2px rgba(44,13,2,.06),0 6px 20px rgba(44,13,2,.06);
  --serif:'Instrument Serif',Georgia,serif; --sans:'Inter Tight',system-ui,-apple-system,Segoe UI,Roboto,sans-serif;
}
*{box-sizing:border-box;-webkit-tap-highlight-color:transparent}
html,body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.4 var(--sans)}
button,input,select,textarea{font:inherit;color:inherit}
.wrap{max-width:640px;margin:0 auto;padding:16px 16px 120px}
.top{display:flex;align-items:center;justify-content:space-between;gap:8px}
.pill{display:inline-block;background:var(--pill);border-radius:99px;padding:5px 12px;font-size:13px}
h1{font:400 34px/1.05 var(--serif);margin:12px 0 4px}
h1 i{font-style:italic}
.lead{color:var(--soft);margin:0 0 14px}
.tabs{position:sticky;top:0;z-index:20;background:var(--bg);padding:8px 0 10px;margin:0 -16px;padding-left:16px;padding-right:16px;border-bottom:1px solid var(--line)}
.seg{display:flex;gap:4px;background:rgba(44,13,2,.06);border-radius:14px;padding:4px}
.seg button{flex:1;border:0;background:transparent;border-radius:10px;padding:9px 6px;font-weight:500;cursor:pointer;white-space:nowrap}
.seg button.on{background:var(--card);box-shadow:var(--shadow)}
.seg.sm button{padding:7px 6px;font-size:14px}
.chips{display:flex;gap:6px;overflow-x:auto;padding:2px 0 4px;scrollbar-width:none}
.chips::-webkit-scrollbar{display:none}
.chip{flex:none;border:1px solid var(--line);background:var(--card);border-radius:99px;padding:6px 12px;font-size:13px;cursor:pointer}
.chip.on{background:var(--ink);color:var(--bg);border-color:var(--ink)}
.box{background:var(--card);border:1px solid var(--line);border-radius:18px;padding:14px;margin:14px 0}
.box h3{margin:0 0 8px;font-size:13px;font-weight:600;letter-spacing:.02em;text-transform:uppercase;color:var(--soft)}
.row{display:flex;align-items:center;gap:10px}
.muted{color:var(--soft)}
.small{font-size:13px}
.day{margin:22px 0 0}
.dayh{display:flex;align-items:baseline;gap:8px;margin:0 2px 8px}
.dayh b{font:400 24px/1 var(--serif)}
.dayh span{color:var(--soft);font-size:13px}
.list{display:flex;flex-direction:column;gap:8px;min-height:54px;border-radius:16px}
.list:empty{border:1.5px dashed var(--line);display:flex;align-items:center;justify-content:center}
.list:empty::after{content:'перетащи сюда пост';color:var(--faint);font-size:13px}
.card{display:flex;gap:10px;align-items:stretch;background:var(--card);border:1px solid var(--line);border-radius:16px;padding:12px 12px 12px 6px;box-shadow:var(--shadow);cursor:pointer;transition:opacity .2s}
.card.off{opacity:.38}
.card.ghost{opacity:.3;background:var(--blue)}
.card.chosen{box-shadow:0 10px 30px rgba(44,13,2,.18)}
.handle{flex:none;width:22px;display:flex;align-items:center;justify-content:center;color:var(--faint);cursor:grab;touch-action:none;font-size:18px;letter-spacing:-3px}
.cbody{flex:1;min-width:0}
.ctop{display:flex;gap:8px;align-items:center;margin-bottom:4px;flex-wrap:wrap}
.time{background:var(--blue);border-radius:8px;padding:2px 8px;font-weight:600;font-size:13px}
.ttl{font-weight:500;overflow:hidden;text-overflow:ellipsis;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical}
.meta{display:flex;flex-wrap:wrap;gap:6px;margin-top:6px}
.tag{font-size:12px;border-radius:99px;padding:2px 8px;background:rgba(44,13,2,.06)}
.tag.zone{background:var(--pill)}
.tag.paused{background:var(--warn-bg);color:var(--warn)}
.tag.draft{background:rgba(44,13,2,.08)}
.tag.no{background:transparent;border:1px dashed var(--faint);color:var(--soft)}
.stat{font-size:12px;color:var(--soft);margin-left:auto}
.empty{color:var(--soft);text-align:center;padding:28px 12px}
.btn{display:inline-flex;align-items:center;justify-content:center;gap:6px;border:0;border-radius:14px;background:var(--ink);color:var(--bg);padding:13px 16px;font-weight:600;cursor:pointer;width:100%}
.btn.ghost{background:transparent;color:var(--ink);border:1px solid var(--line)}
.btn.danger{background:transparent;color:var(--warn);border:1px solid var(--warn-bg)}
.btns{display:grid;gap:8px;margin-top:14px}
.btns.two{grid-template-columns:1fr 1fr}
label.f{display:block;margin:14px 0 6px;font-size:13px;color:var(--soft);font-weight:500}
input[type=text],input[type=time],input[type=datetime-local],select,textarea{width:100%;border:1px solid var(--line);background:var(--card);border-radius:12px;padding:11px 12px;outline:none}
input:focus,select:focus,textarea:focus{border-color:var(--ink)}
textarea{min-height:120px;resize:vertical;line-height:1.45}
.step{display:flex;align-items:center;gap:10px}
.step button{width:44px;height:44px;border-radius:12px;border:1px solid var(--line);background:var(--card);font-size:20px;cursor:pointer}
.step b{min-width:64px;text-align:center;font:400 28px/1 var(--serif)}
.toggle{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-top:14px}
.sw{position:relative;width:48px;height:28px;flex:none}
.sw input{opacity:0;width:0;height:0}
.sw span{position:absolute;inset:0;background:rgba(44,13,2,.15);border-radius:99px;transition:.2s}
.sw span::before{content:'';position:absolute;width:22px;height:22px;left:3px;top:3px;background:#fff;border-radius:50%;transition:.2s;box-shadow:0 1px 3px rgba(0,0,0,.2)}
.sw input:checked+span{background:var(--good)}
.sw input:checked+span::before{transform:translateX(20px)}
.note{background:var(--blue);border-radius:12px;padding:10px 12px;font-size:13px;margin-top:12px}
.note.warn{background:var(--warn-bg);color:var(--warn)}
.preview{white-space:pre-wrap;background:rgba(44,13,2,.04);border-radius:12px;padding:10px 12px;font-size:14px;max-height:180px;overflow:auto}
.sheet-bg{position:fixed;inset:0;background:rgba(44,13,2,.35);z-index:50;opacity:0;pointer-events:none;transition:.2s}
.sheet-bg.on{opacity:1;pointer-events:auto}
.sheet{position:fixed;left:0;right:0;bottom:0;z-index:60;background:var(--bg);border-radius:22px 22px 0 0;max-height:92vh;overflow:auto;transform:translateY(105%);transition:transform .25s ease;padding:8px 16px 28px;max-width:640px;margin:0 auto}
.sheet.on{transform:none}
.grab{width:40px;height:5px;border-radius:9px;background:var(--line);margin:4px auto 10px}
.sheet h2{font:400 26px/1.1 var(--serif);margin:4px 0 6px}
.toast{position:fixed;left:50%;bottom:24px;transform:translate(-50%,40px);background:var(--ink);color:var(--bg);padding:10px 16px;border-radius:12px;opacity:0;transition:.25s;z-index:80;font-size:14px;max-width:90vw;text-align:center}
.toast.on{opacity:1;transform:translate(-50%,0)}
.grp{margin:22px 0 8px;font:400 22px/1.1 var(--serif)}
.msg{background:var(--card);border:1px solid var(--line);border-radius:16px;padding:12px;margin-bottom:8px;cursor:pointer}
.msg .t{font-weight:500;display:flex;gap:8px;align-items:center}
.msg .p{color:var(--soft);font-size:13px;margin-top:4px;white-space:pre-wrap;overflow:hidden;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical}
.vars{display:flex;flex-wrap:wrap;gap:6px;margin-top:8px}
.vars button{border:1px dashed var(--ink);background:transparent;border-radius:99px;padding:4px 10px;font-size:13px;cursor:pointer}
.legend{display:flex;gap:12px;flex-wrap:wrap;font-size:12px;color:var(--soft);margin-top:10px}
.gate{min-height:80vh;display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center;gap:10px}
@media (min-width:700px){ h1{font-size:44px} }
/* конструктор сценария */
#tabs{overflow-x:auto;scrollbar-width:none}#tabs::-webkit-scrollbar{display:none}
#tabs button{flex:1 0 auto;padding:9px 12px}
.tree{margin:0 0 12px}
.fn{background:var(--card);border:1px solid var(--line);border-radius:16px;padding:12px 14px;box-shadow:var(--shadow);cursor:pointer}
.fn.dim{opacity:.6}
.fn-top{display:flex;gap:6px;align-items:center;flex-wrap:wrap;margin-bottom:4px}
.kids{margin:0 0 0 14px;padding:6px 0 2px 12px;border-left:1.5px solid var(--line);display:flex;flex-direction:column;gap:8px}
.fb{display:flex;flex-direction:column;gap:6px}
.fb-l{font-size:13px;font-weight:500;display:flex;gap:6px;align-items:baseline}
.fb-r{font-size:13px;color:var(--soft);margin:-4px 0 0 22px}
.ref{align-self:flex-start;border:1px dashed var(--faint);background:transparent;border-radius:12px;padding:8px 12px;font-size:13px;cursor:pointer;text-align:left}
.addb{align-self:flex-start;border:0;background:transparent;color:var(--soft);font-size:13px;padding:6px 0;cursor:pointer;min-height:36px}
.dash{border:1.5px dashed var(--line);border-radius:16px;padding:12px;margin:6px 0}
.ok-t{color:var(--good);font-weight:600}.warn-t{color:var(--warn);font-weight:600}
.steps{display:flex;flex-direction:column;align-items:stretch}
.stp{display:flex;gap:10px;align-items:center;text-align:left;border:1px solid var(--line);background:var(--bg);border-radius:14px;padding:10px 12px;cursor:pointer;min-height:44px}
.stp b{flex:none;width:24px;height:24px;border-radius:50%;background:var(--pill);display:grid;place-items:center;font-size:12px}
.stp .st-t{display:flex;flex-direction:column;font-size:14px;min-width:0}.stp .st-t i{display:block;font-style:normal;font-size:12px;color:var(--soft);margin-top:2px}
.stp.last{cursor:default;border-style:dashed}
.arr{text-align:center;color:var(--faint);font-size:12px;line-height:1;padding:3px 0}
.docs-row{display:flex;justify-content:space-between;align-items:center;gap:10px;margin-top:12px;padding-top:12px;border-top:1px solid var(--line)}
.kinds{display:grid;gap:8px;margin-top:10px}
.kind{text-align:left;border:1px solid var(--line);background:var(--card);border-radius:16px;padding:14px;cursor:pointer;display:flex;flex-direction:column;gap:4px}
.kind b{font-weight:600}.kind span{font-size:13px;color:var(--soft)}
.shd{position:sticky;top:-8px;z-index:3;display:flex;justify-content:space-between;align-items:center;gap:10px;background:var(--bg);margin:0 -16px;padding:6px 16px 8px}
.sx{flex:none;width:40px;height:40px;border-radius:50%;border:1px solid var(--line);background:var(--card);font-size:16px;cursor:pointer}
.fmt{display:flex;gap:6px;flex-wrap:wrap;margin:0 0 6px}
.fmt button{min-width:40px;height:36px;border:1px solid var(--line);background:var(--card);border-radius:10px;padding:0 10px;cursor:pointer;font-size:14px}
.files{display:grid;grid-template-columns:repeat(auto-fill,minmax(84px,1fr));gap:8px}
.fl{position:relative;aspect-ratio:1;border-radius:12px;overflow:hidden;background:rgba(44,13,2,.05);border:1px solid var(--line)}
.fl img{width:100%;height:100%;object-fit:cover;display:block}
.fl-ic{display:flex;flex-direction:column;align-items:center;justify-content:center;height:100%;font-size:26px;gap:4px}.fl-ic i{font-style:normal;font-size:11px;color:var(--soft);padding:0 4px;text-align:center;word-break:break-all}
.fl-x,.fl-l{position:absolute;top:4px;width:28px;height:28px;border-radius:50%;border:0;background:rgba(255,255,255,.92);cursor:pointer;font-size:13px;box-shadow:0 1px 3px rgba(0,0,0,.15)}
.fl-x{right:4px}.fl-l{left:4px}
.fl.add{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:2px;cursor:pointer;font-size:22px;border-style:dashed;color:var(--soft)}.fl.add span{font-size:12px}
.brow{background:var(--card);border:1px solid var(--line);border-radius:16px;padding:10px;margin:8px 0}
.bcard{display:grid;gap:6px;padding:8px 0;border-bottom:1px dashed var(--line);margin-bottom:6px}.bcard:last-of-type{border-bottom:0}
.btype{display:grid;grid-template-columns:repeat(4,1fr);gap:4px;background:rgba(44,13,2,.06);border-radius:12px;padding:3px}
.btype button{border:0;background:transparent;border-radius:9px;padding:7px 2px;font-size:12.5px;cursor:pointer;white-space:nowrap;min-height:34px}
.btype button.on{background:var(--card);box-shadow:var(--shadow);font-weight:600}
@media (max-width:360px){ .btype{grid-template-columns:repeat(2,1fr)} }

</style>
</head>
<body>
<div class="wrap" id="app">
  <div class="gate" id="gate"><span class="pill">Di Sign University</span><h1>Загружаю панель…</h1><p class="lead" id="gateText"></p></div>
</div>
<div class="sheet-bg" id="sheetBg"></div>
<div class="sheet" id="sheet"></div>
<div class="toast" id="toast"></div>

<script>
(function(){
const tg = window.Telegram && Telegram.WebApp;
if (tg) { tg.ready(); tg.expand(); try{ tg.setHeaderColor('#fffbf7'); tg.setBackgroundColor('#fffbf7'); }catch(e){} }
const INIT = tg ? tg.initData : '';
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
let S = null;                // всё, что пришло с сервера
let tab = 'flow';
let view = { level: 'all', hide: false };
try { const v = JSON.parse(localStorage.getItem('panelView') || 'null'); if (v) view = Object.assign(view, v); } catch (e) {}
const saveView = () => { try { localStorage.setItem('panelView', JSON.stringify(view)); } catch (e) {} };

async function api(path, body) {
  const r = await fetch('/api/panel' + path, { method: body ? 'POST' : 'GET', headers: { 'x-init-data': INIT, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  const d = await r.json().catch(() => ({ error: 'Сервер не ответил' }));
  if (!r.ok || d.error) throw new Error(d.error || 'Ошибка');
  return d;
}
function toast(t) { const el = $('toast'); el.textContent = t; el.classList.add('on'); clearTimeout(toast._t); toast._t = setTimeout(() => el.classList.remove('on'), 2200); }
const haptic = (k) => { try { tg && tg.HapticFeedback.impactOccurred(k || 'light'); } catch (e) {} };

async function load() {
  if (!INIT) { $('gate').querySelector('h1').textContent = 'Открой панель из бота'; $('gateText').textContent = 'Напиши боту команду /admin и нажми «Открыть панель».'; return; }
  try { S = await api('/state'); render(); }
  catch (e) { $('gate').querySelector('h1').textContent = 'Нет доступа'; $('gateText').textContent = e.message; }
}

// ---------- помощники ----------
const postName = (p) => p.title || (p.text || '').split('\\n')[0] || (p.media.length ? 'Картинки без текста' : 'Без текста');
const fmtRun = (t) => { if (!t) return 'дата не задана'; const d = new Date((t + 10800) * 1000); const wd = ['вс','пн','вт','ср','чт','пт','сб'][d.getUTCDay()]; const mon = ['янв','фев','мар','апр','мая','июн','июл','авг','сен','окт','ноя','дек'][d.getUTCMonth()]; return wd + ', ' + d.getUTCDate() + ' ' + mon + ' · ' + String(d.getUTCHours()).padStart(2,'0') + ':' + String(d.getUTCMinutes()).padStart(2,'0'); };
const toLocal = (t) => t ? new Date((t + 10800) * 1000).toISOString().slice(0, 16) : '';
const fromLocal = (s) => { const m = /^(\\d{4})-(\\d{2})-(\\d{2})T(\\d{2}):(\\d{2})$/.exec(s || ''); return m ? Date.UTC(+m[1], +m[2]-1, +m[3], +m[4], +m[5]) / 1000 - 10800 : null; };
const dayLabel = (d) => d === 0 ? 'сразу после согласия на рассылку' : d === 1 ? 'на следующий день' : 'через ' + d + ' ' + (d % 10 === 1 && d % 100 !== 11 ? 'день' : (d % 10 >= 2 && d % 10 <= 4 && (d % 100 < 10 || d % 100 >= 20)) ? 'дня' : 'дней') + ' после входа';
// когда уходит пост ленты: в день и время / по таймеру после входа / после другого поста
const timeMin = (t) => { const m = /^(\\d{1,2}):(\\d{2})$/.exec(t || '11:00'); return m ? +m[1] * 60 + +m[2] : 660; };
const fmtDelay = (min) => { const m = +min || 0; if (!m) return '0 мин'; const d = Math.floor(m / 1440), h = Math.floor((m % 1440) / 60), mm = m % 60; return [d ? d + ' дн' : '', h ? h + ' ч' : '', mm ? mm + ' мин' : ''].filter(Boolean).join(' '); };
const byIdMap = () => Object.fromEntries(S.posts.map((p) => [p.id, p]));
// смещение от входа (вход условно в 10:00), в минутах
function offMin(p, ids, depth) { depth = depth || 0; if (!p || depth > 20) return 0;
  if (p.mode === 'timer') return p.delay || 0;
  if (p.mode === 'after') return offMin(ids[p.after], ids, depth + 1) + (p.delay || 0);
  return p.day ? p.day * 1440 + timeMin(p.time) - 600 : 0; }
const bucketDay = (p, ids) => p.mode === 'day' || !p.mode ? (p.day || 0) : Math.floor(Math.max(0, offMin(p, ids) + 600) / 1440);
function whenShort(p, ids) {
  if (p.mode === 'timer') return '⏱ через ' + fmtDelay(p.delay) + ' после входа';
  if (p.mode === 'after') { const par = ids[p.after]; return '↳ через ' + fmtDelay(p.delay) + ' после «' + (par ? postName(par).slice(0, 26) : '#' + p.after) + '»'; }
  return p.day === 0 ? 'сразу' : p.time;
}
// получит ли этот пост выбранный человек
function gets(p) {
  return view.level === 'all' || p.audience === 'all' || p.audience === view.level;
}
function tags(p) {
  let h = '';
  if (p.audience !== 'all') h += '<span class="tag">' + esc(S.audiences[p.audience]) + '</span>';
  if (p.status === 'paused') h += '<span class="tag paused">⏸ пауза</span>';
  if (p.status === 'draft') h += '<span class="tag draft">📝 черновик</span>';
  if (p.media.length) h += '<span class="tag">🖼 ' + (p.media.length > 1 ? '×' + p.media.length : '') + '</span>';
  if (p.buttons.length) h += '<span class="tag">🔘 ' + p.buttons.length + '</span>';
  if (p.emoji) h += '<span class="tag">✨ премиум</span>';
  if (view.level !== 'all' && !gets(p)) h += '<span class="tag no">не получит</span>';
  return h;
}
function cardHtml(p, opts) {
  opts = opts || {};
  const off = view.level !== 'all' && !gets(p);
  const time = opts.time != null ? opts.time : (p.kind === 'drip' ? whenShort(p, byIdMap()) : '');
  return '<div class="card' + (off ? ' off' : '') + '" data-id="' + p.id + '">' +
    (opts.drag ? '<div class="handle" aria-label="перетащить">⋮⋮</div>' : '<div style="width:6px"></div>') +
    '<div class="cbody"><div class="ctop">' + (time ? '<span class="time">' + esc(time) + '</span>' : '') +
    '<span class="stat">' + (p.sent ? 'отправлено ' + p.sent : 'ещё не отправлялся') + (p.clicks ? ' · нажатий ' + p.clicks : '') + '</span></div>' +
    '<div class="ttl">' + esc(postName(p)) + '</div><div class="meta">' + tags(p) + '</div></div></div>';
}

// ---------- отрисовка ----------
function render() {
  const app = $('app');
  const counts = { feed: S.posts.filter((p) => p.kind === 'drip').length, dates: S.posts.filter((p) => p.kind === 'date').length, gifts: S.posts.filter((p) => p.kind === 'gift').length };
  app.innerHTML =
    '<div class="top"><span class="pill">Di Sign University · панель</span><span class="small muted">людей: ' + S.people.all + ' · в рассылке: ' + S.people.active + '</span></div>' +
    (tab === 'flow' ? '<h1>Сценарий <i>бота</i></h1><p class="lead">Собирай посты с нуля и связывай кнопками: ссылка, другой пост, документ или оплата. Нажми на пост — откроется редактор.</p>'
      : tab === 'texts' ? '<h1>Тексты <i>бота</i></h1><p class="lead">Служебные сообщения: приветствие, согласия, вопросы, команды.</p>'
      : '<h1>Лента <i>бота</i></h1><p class="lead">Перетаскивай посты за ⋮⋮, нажми на пост — чтобы поменять день, время и кому он уходит.</p>') +
    '<div class="tabs"><div class="seg" id="tabs">' +
    [['flow','Сценарий'],['feed','Лента · ' + counts.feed],['dates','Даты · ' + counts.dates],['gifts','Подарки · ' + counts.gifts],['texts','Тексты']].map(([k,t]) => '<button data-t="' + k + '" class="' + (tab === k ? 'on' : '') + '">' + t + '</button>').join('') +
    '</div></div><div id="body"></div>';
  $('tabs').onclick = (e) => { const b = e.target.closest('button'); if (!b) return; tab = b.dataset.t; haptic(); render(); window.scrollTo(0, 0); };
  ({ flow: renderFlow, feed: renderFeed, dates: renderDates, gifts: renderGifts, texts: renderTexts })[tab]();
}

function viewBox() {
  return '<div class="box"><h3>Как увидит человек</h3>' +
    '<div class="seg sm" id="lvl">' + [['all','Все посты'],['start','Начинающий'],['pro','Продолжающий']].map(([k,t]) => '<button data-v="' + k + '" class="' + (view.level === k ? 'on' : '') + '">' + t + '</button>').join('') + '</div>' +
    ((view.level !== 'all') ? '<div class="toggle"><span class="small">Прятать посты, которые этот человек не получит</span><label class="sw"><input type="checkbox" id="hide" ' + (view.hide ? 'checked' : '') + '><span></span></label></div>' : '') +
    '</div>';
}
function bindView() {
  $('lvl').onclick = (e) => { const b = e.target.closest('button'); if (!b) return; view.level = b.dataset.v; saveView(); haptic(); render(); };
  if ($('hide')) $('hide').onchange = (e) => { view.hide = e.target.checked; saveView(); render(); };
}

function renderFeed() {
  const drip = S.posts.filter((p) => p.kind === 'drip');
  const ids = byIdMap();
  const maxDay = drip.reduce((m, p) => Math.max(m, bucketDay(p, ids)), 0);
  const last = Math.max(7, maxDay + 1);
  const filtered = (view.hide && view.level !== 'all') ? drip.filter(gets) : drip;
  let h = viewBox() + runBox();
  if (!drip.length) h += '<div class="empty">Постов по дням пока нет.<br>Создай первый: «Сценарий» → «＋ Новый пост».</div>';
  for (let d = 0; d <= last; d++) {
    const items = filtered.filter((p) => bucketDay(p, ids) === d).sort((a, b) => offMin(a, ids) - offMin(b, ids) || a.pos - b.pos || a.id - b.id);
    h += '<section class="day"><div class="dayh"><b>День ' + d + '</b><span>' + dayLabel(d) + '</span></div><div class="list" data-day="' + d + '">' + items.map((p) => cardHtml(p, { drag: true })).join('') + '</div></section>';
  }
  h += '<div class="note" style="margin-top:22px">Новый пост — во вкладке «Сценарий» → «＋ Новый пост» или в боте: <b>/new</b>. Посты-ответы и цепочки «после поста» видно деревом в «Сценарии».</div>';
  $('body').innerHTML = h;
  bindView(); bindRun();
  if (window.Sortable) document.querySelectorAll('.list').forEach((el) => {
    Sortable.create(el, {
      group: 'drip', handle: '.handle', animation: 160, ghostClass: 'ghost', chosenClass: 'chosen', forceFallback: true, fallbackTolerance: 4, scroll: true, bubbleScroll: true,
      onEnd: (ev) => onDrop(ev),
    });
  });
  bindCards();
}

// после перетаскивания: новый день и порядок; время подстраиваем только у перенесённого поста
async function onDrop(ev) {
  const id = +ev.item.dataset.id;
  const moved = S.posts.find((p) => p.id === id);
  const toDay = +ev.to.dataset.day;
  const ids = [...ev.to.children].map((c) => +c.dataset.id);
  const list = ids.map((i) => S.posts.find((p) => p.id === i));
  const k = ids.indexOf(id);
  const old = { day: moved.day, time: moved.time, mode: moved.mode };
  moved.day = toDay;
  let note = '';
  if (moved.mode && moved.mode !== 'day') { moved.mode = 'day'; moved.time = moved.time && moved.time !== '00:00' ? moved.time : '11:00'; note = 'теперь «в день и время»'; }
  if (toDay > 0) {
    const isDay = (p) => p && (!p.mode || p.mode === 'day');
    let prev = null, next = null;
    for (let i = k - 1; i >= 0; i--) if (isDay(list[i])) { prev = list[i]; break; }
    for (let i = k + 1; i < list.length; i++) if (isDay(list[i])) { next = list[i]; break; }
    if (prev && moved.time < prev.time) { moved.time = prev.time; note = 'время подстроено: ' + moved.time; }
    else if (next && moved.time > next.time) { moved.time = next.time; note = 'время подстроено: ' + moved.time; }
    if (old.day === 0 && !prev && !next) { moved.time = moved.time && moved.time !== '00:00' ? moved.time : '11:00'; }
  }
  // сохраняем только посты «в день и время» (таймеры и цепочки остаются как были) + перенесённый
  const dayOnly = (p) => p === moved || !p.mode || p.mode === 'day';
  const items = list.map((p, i) => ({ p, i })).filter((x) => dayOnly(x.p)).map(({ p, i }) => ({ id: p.id, day: toDay, time: p.time || '11:00', pos: i }));
  if (ev.from !== ev.to) [...ev.from.children].forEach((c, i) => { const p = S.posts.find((x) => x.id === +c.dataset.id); if (dayOnly(p)) items.push({ id: p.id, day: p.day, time: p.time || '11:00', pos: i }); });
  list.forEach((p, i) => { p.pos = i; });
  haptic('medium');
  try {
    await api('/reorder', { items });
    toast(old.day !== toDay ? 'Перенесено на день ' + toDay + (note ? ' · ' + note : '') : 'Порядок сохранён' + (note ? ' · ' + note : ''));
  } catch (e) { moved.day = old.day; moved.time = old.time; moved.mode = old.mode; toast('Не сохранилось: ' + e.message); }
  renderFeed();
}

// ---------- проверить ленту на себе ----------
function runBox() {
  const who = view.level === 'start' ? 'начинающего' : view.level === 'pro' ? 'продолжающего' : 'любого ученика';
  const r = S.run;
  return '<div class="box"><h3>Проверить на себе</h3><p class="small muted" style="margin:0 0 10px">Лента придёт тебе в бот — как её получит ' + who + ' (выбирается выше). Включённые посты, с подписью «когда».</p>' +
    '<div class="btns" style="margin-top:0"><button class="btn" id="runPrev" type="button">▶️ Посмотреть ленту сейчас</button>' +
    (r ? '<div class="note" style="margin:0">⏩ Идёт ускоренный тест (1 день = 1 минута) · уже пришло: ' + r.sent + '</div><button class="btn danger" id="runStop" type="button">⏹ Остановить тест</button>'
       : '<button class="btn ghost" id="runFast" type="button">⏩ Ускоренный тест: 1 день = 1 минута</button>') + '</div></div>';
}
function bindRun() {
  const lvl = view.level;
  if ($('runPrev')) $('runPrev').onclick = async () => { try { await api('/run/preview', { level: lvl }); haptic('medium'); toast('Отправляю ленту тебе в бот 👀'); } catch (e) { toast(e.message); } };
  if ($('runFast')) $('runFast').onclick = async () => { try { const r = await api('/run/fast', { level: lvl }); S.run = r.run; haptic('medium'); toast('Тест пошёл — смотри в боте ⏩'); renderFeed(); } catch (e) { toast(e.message); } };
  if ($('runStop')) $('runStop').onclick = async () => { try { await api('/run/stop', {}); S.run = null; toast('Тест остановлен'); renderFeed(); } catch (e) { toast(e.message); } };
}

function renderDates() {
  const ds = S.posts.filter((p) => p.kind === 'date').sort((a, b) => (a.run_at || 9e12) - (b.run_at || 9e12));
  const now = Date.now() / 1000;
  let h = viewBox();
  if (!ds.length) h += '<div class="empty">Постов на конкретную дату пока нет.<br>Создай в боте: <b>/new</b> → «В конкретные дату и время». Подходит для эфиров и анонсов.</div>';
  ds.forEach((p) => {
    const past = p.run_at && p.run_at < now;
    h += '<div style="margin-top:10px">' + cardHtml(p, { time: fmtRun(p.run_at) + (past ? ' · уже ушёл' : '') }) + '</div>';
  });
  h += '<div class="note" style="margin-top:18px">Пост на дату уходит один раз всем подходящим, кто уже в боте в этот момент.</div>';
  $('body').innerHTML = h; bindView(); bindCards();
}

function renderGifts() {
  const gs = S.posts.filter((p) => p.kind === 'gift');
  let h = '<p class="muted" style="margin-top:16px">Подарок уходит сразу после теста. Начинающий получит подарки «всем» и «начинающим», продолжающий — «всем» и «продолжающим», по порядку.</p>';
  [['all','Всем'],['start','Начинающим'],['pro','Продолжающим']].forEach(([a, t]) => {
    const list = gs.filter((p) => p.audience === a);
    h += '<div class="grp">' + t + '</div>' + (list.length ? list.map((p) => cardHtml(p)).join('<div style="height:8px"></div>') : '<p class="small muted" style="margin:6px 2px;border:1.5px dashed var(--line);border-radius:16px;padding:12px">Пока нет. Создай в боте: <b>/new</b> → «Подарок после теста».</p>');
  });
  if (!gs.length) h += '<div class="note warn" style="margin-top:16px">Подарков нет — после теста люди получат «Подарок скоро появится здесь 🎁».</div>';
  $('body').innerHTML = h; bindCards();
}

// путь ученика: служебные сообщения по порядку (порядок фиксирован — согласие на данные по закону первое)
const FLOW = [
  { key: 'hello', alt: ['helloTest'], title: 'Приветствие', note: 'Сразу после «Старт». Если человек пришёл из теста — вариант «после теста».' },
  { key: 'consentPd', btns: ['consentPdBtn'], alt: ['consentThanks'], title: 'Согласие на обработку данных', note: 'Всегда первым вопросом: без согласия бот не имеет права ничего присылать.' },
  { key: 'askLevel', btns: ['levelBtnStart', 'levelBtnPro'], alt: ['levelChanged'], title: 'Уровень' },
  { key: 'testOffer', btns: ['testBtn'], alt: ['noGift'], title: 'Предложение пройти тест', note: 'Если человек пришёл из теста — вместо этого сообщения сразу подарок (вкладка «Подарки»).' },
  { key: 'consentAds', btns: ['consentAdsYes', 'consentAdsNo'], title: 'Согласие на рассылку' },
  { key: 'adsYes', alt: ['adsNo'], title: 'Ответ на «да» / «нет»', note: 'После «да» начинается лента (вкладка «Лента»).' },
];
const mOf = (k) => S.msgs.find((x) => x.key === k);
const mediaTag = (m) => m && m.media ? '<span class="tag">' + ({ photo: '🖼 картинка', video: '🎬 видео', animation: '🎞 гифка' }[m.media] || '🖼') + '</span>' : '';
function renderTexts() {
  let h = '<div class="box" style="margin-top:16px"><h3>Путь ученика</h3><p class="small muted" style="margin:0 0 10px">Так бот встречает нового человека — шаг за шагом. Нажми на шаг или на кнопку, чтобы поменять текст, картинку, паузу и кнопки-ссылки.</p>' +
    '<div class="btns" style="margin-top:0"><button class="btn" type="button" id="obNo">▶️ Пройти путь заново — без теста</button><button class="btn ghost" type="button" id="obTest">▶️ Пройти путь заново — как из теста</button></div>' +
    '<p class="small muted" style="margin:8px 2px 0">Твоя анкета в боте сбросится, и бот проведёт тебя по всем шагам с настоящими кнопками.</p></div>';
  const used = new Set();
  FLOW.forEach((st, i) => {
    const m = mOf(st.key); if (!m) return;
    [st.key, ...(st.btns || []), ...(st.alt || [])].forEach((k) => used.add(k));
    h += '<div class="day"><div class="dayh"><b>' + (i + 1) + '</b><span>' + esc(st.title) + '</span></div>' +
      '<div class="msg" data-k="' + m.key + '" style="margin-bottom:0"><div class="t"><span class="time">⏱ ' + String(m.delay).replace('.', ',') + ' с</span>' + (m.changed ? '<span class="tag">✎ изменено</span>' : '') + mediaTag(m) + '</div><div class="p" style="-webkit-line-clamp:3">' + esc(m.text) + '</div>' +
      (((st.btns || []).length || m.links.length) ? '<div class="meta" style="margin-top:8px">' + (st.btns || []).map((b) => { const bm = mOf(b); return bm ? '<button type="button" class="chip" data-open="' + b + '">🔘 ' + esc(bm.text) + '</button>' : ''; }).join('') + m.links.flat().map((l) => '<span class="chip" style="cursor:default">🔗 ' + esc(l.text) + '</span>').join('') + '</div>' : '') +
      '</div>' + (st.alt || []).map((a) => { const am = mOf(a); return am ? '<div class="msg" data-k="' + a + '" style="margin:6px 0 0 18px;padding:10px 12px"><div class="t small">↳ ' + esc(am.title) + (am.changed ? ' ✎' : '') + mediaTag(am) + '</div><div class="p">' + esc(am.text) + '</div></div>' : ''; }).join('') +
      (st.note ? '<p class="small muted" style="margin:6px 2px 0">' + esc(st.note) + '</p>' : '') + '</div>';
  });
  const groups = {};
  S.msgs.filter((m) => !used.has(m.key)).forEach((m) => { const g = m.group === 'cmd' || m.group === 'profile' ? m.group : 'other'; (groups[g] = groups[g] || []).push(m); });
  const names = { other: '🧩 Прочее', cmd: '⚙️ Команды ученика', profile: '🤖 Профиль бота и меню команд' };
  Object.keys(names).forEach((g) => {
    if (!groups[g]) return;
    h += '<div class="grp">' + names[g] + '</div>';
    groups[g].forEach((m) => {
      h += '<div class="msg" data-k="' + m.key + '"><div class="t">' + (m.changed ? '✎ ' : '') + esc(m.title) + (m.button ? '<span class="tag">кнопка</span>' : '') + mediaTag(m) + '</div><div class="p">' + esc(m.text) + '</div></div>';
    });
  });
  h += '<p class="small muted" style="margin-top:16px">Премиум-эмодзи вставляются только в самом боте: <b>/texts</b>.</p>';
  $('body').innerHTML = h;
  document.querySelectorAll('.msg').forEach((el) => el.onclick = (e) => { const b = e.target.closest('[data-open]'); openMsg(b ? b.dataset.open : el.dataset.k); });
  const ob = async (fromTest) => { try { await api('/run/onboarding', { fromTest, level: view.level }); haptic('medium'); toast('Открой бот — путь начался 👀'); try { tg && tg.close && setTimeout(() => {}, 0); } catch (e) {} } catch (e) { toast(e.message); } };
  $('obNo').onclick = () => ob(false); $('obTest').onclick = () => ob(true);
}

// редактор кнопок-ссылок (общий)
function rowsEditor(el, rows) {
  const sync = () => { el.querySelectorAll('[data-r]').forEach((i) => { const r = +i.dataset.r, k = +i.dataset.i; if (rows[r] && rows[r][k]) rows[r][k][i.dataset.f] = i.value; }); };
  const draw = () => {
    el.innerHTML = (rows.length ? rows.map((row, r) => '<div class="box" style="margin:8px 0;padding:10px"><div class="row" style="justify-content:space-between;margin-bottom:6px"><span class="small muted">Ряд ' + (r + 1) + '</span><span>' +
      (r > 0 ? '<button type="button" class="chip" data-up="' + r + '">↑</button> ' : '') + (r < rows.length - 1 ? '<button type="button" class="chip" data-down="' + r + '">↓</button>' : '') + '</span></div>' +
      row.map((b, i) => '<div style="display:grid;grid-template-columns:1fr auto;gap:6px;margin-bottom:6px"><input type="text" placeholder="Текст кнопки" maxlength="60" data-r="' + r + '" data-i="' + i + '" data-f="text" value="' + esc(b.text) + '"><button type="button" class="chip" data-del="' + r + ':' + i + '">✕</button><input type="text" placeholder="https://ссылка" inputmode="url" data-r="' + r + '" data-i="' + i + '" data-f="url" value="' + esc(b.url) + '" style="grid-column:1/-1"></div>').join('') +
      (row.length < 4 ? '<button type="button" class="chip" data-add="' + r + '">＋ Кнопка в этот ряд</button>' : '') + '</div>').join('') : '<p class="small muted" style="margin:2px">Своих кнопок нет.</p>') +
      '<button type="button" class="btn ghost" data-newrow="1" style="margin-top:6px">＋ Кнопка-ссылка</button>';
  };
  el.addEventListener('input', sync);
  el.addEventListener('click', (e) => {
    const t = e.target.closest('button'); if (!t) return; sync();
    if (t.dataset.newrow) rows.push([{ text: '', url: '' }]);
    if (t.dataset.add !== undefined) rows[+t.dataset.add].push({ text: '', url: '' });
    if (t.dataset.del) { const [r, i] = t.dataset.del.split(':').map(Number); rows[r].splice(i, 1); if (!rows[r].length) rows.splice(r, 1); }
    if (t.dataset.up) { const r = +t.dataset.up; [rows[r - 1], rows[r]] = [rows[r], rows[r - 1]]; }
    if (t.dataset.down) { const r = +t.dataset.down; [rows[r + 1], rows[r]] = [rows[r], rows[r + 1]]; }
    haptic(); draw();
  });
  draw();
  return () => { sync(); return rows; };
}

function bindCards() {
  document.querySelectorAll('.card').forEach((el) => el.addEventListener('click', (e) => { if (e.target.closest('.handle')) return; openPost(+el.dataset.id); }));
}

// ---------- шторка ----------
function sheet(html) { $('sheet').innerHTML = '<div class="grab"></div>' + html; $('sheet').classList.add('on'); $('sheetBg').classList.add('on'); $('sheet').scrollTop = 0; }
function closeSheet() { $('sheet').classList.remove('on'); $('sheetBg').classList.remove('on'); }
$('sheetBg').onclick = closeSheet;

function segHtml(id, opts, cur) { return '<div class="seg sm" id="' + id + '">' + opts.map(([k,t]) => '<button type="button" data-v="' + k + '" class="' + (cur === k ? 'on' : '') + '">' + t + '</button>').join('') + '</div>'; }
function segBind(id, on) { $(id).onclick = (e) => { const b = e.target.closest('button'); if (!b) return; [...$(id).children].forEach((x) => x.classList.toggle('on', x === b)); on(b.dataset.v); }; }

// ---------- сценарий: дерево постов и кнопок ----------
const KIND = { drip: '📅 Пост ленты', date: '🕒 Пост на дату', gift: '🎁 Подарок после теста', node: '🔘 Пост-ответ' };
const KIND_NOTE = {
  drip: 'Уходит каждому в свой день после входа: в день и время, по таймеру или после другого поста.',
  date: 'Уходит один раз в выбранные дату и время всем, кто уже в боте. Для эфиров и анонсов.',
  gift: 'Уходит сразу после аудит-теста.',
  node: 'Приходит, только когда человек нажимает кнопку, которая ведёт сюда. Так строятся развилки: «выбери вариант → следующий пост».',
};
const TARIFF = { curator: 'Тариф с кураторами', mentor: 'Тариф с ментором' };
const parentsOf = (id) => { const out = []; S.posts.forEach((p) => (p.rows || []).forEach((row) => row.forEach((b) => { if (+b.go === id) out.push({ p, b }); }))); return out; };
const afterKids = (id) => S.posts.filter((x) => x.kind === 'drip' && x.mode === 'after' && x.after === id);
const domainOf = (u) => { try { return new URL(u).host.replace(/^www\\./, ''); } catch (e) { return u || 'ссылка не задана'; } };
const stTag = (p) => p.status === 'draft' ? '<span class="tag draft">📝 черновик</span>' : p.status === 'paused' ? '<span class="tag paused">⏸ пауза</span>' : '';
const emptyTag = (p) => !(p.text || '').trim() && !p.media.length ? '<span class="tag no">нужно заполнить</span>' : '';
function whenOf(p) {
  if (p.kind === 'gift') return '🎁 после теста';
  if (p.kind === 'node') return '🔘 по кнопке';
  if (p.kind === 'date') return '🕒 ' + fmtRun(p.run_at);
  if (p.mode === 'after') return '⏱ через ' + fmtDelay(p.delay);
  return '📅 ' + (p.mode === 'timer' ? 'через ' + fmtDelay(p.delay) + ' после входа' : p.day === 0 ? 'день 0 · сразу' : 'день ' + p.day + ' · ' + p.time);
}

function renderFlow() {
  const ids = byIdMap();
  const shown = new Set();
  const node = (p, depth, path) => {
    const loop = path.includes(p.id);
    if (loop || shown.has(p.id) || depth > 6) {
      return '<button type="button" class="ref" data-id="' + p.id + '">' + (loop ? '↩ снова к ' : '→ ') + '«' + esc(postName(p).slice(0, 40)) + '»</button>';
    }
    shown.add(p.id);
    const np = path.concat(p.id);
    let h = '<div class="fn' + (p.status !== 'active' ? ' dim' : '') + '" data-id="' + p.id + '"><div class="fn-top"><span class="time">' + esc(whenOf(p)) + '</span>' + stTag(p) + emptyTag(p) +
      '<span class="stat">' + (p.sent ? '↗ ' + p.sent : '') + (p.clicks ? ' · 👆 ' + p.clicks : '') + '</span></div>' +
      '<div class="ttl">' + esc(postName(p)) + '</div>' + (p.media.length ? '<div class="meta"><span class="tag">🖼 ' + (p.media.length > 1 ? '×' + p.media.length : '') + '</span>' + (p.audience !== 'all' && p.kind !== 'node' ? '<span class="tag">' + esc(S.audiences[p.audience]) + '</span>' : '') + '</div>' : (p.audience !== 'all' && p.kind !== 'node' ? '<div class="meta"><span class="tag">' + esc(S.audiences[p.audience]) + '</span></div>' : '')) + '</div>';
    let kids = '';
    (p.rows || []).forEach((row) => row.forEach((b) => {
      if (b.go) { const t = ids[+b.go]; kids += '<div class="fb"><span class="fb-l">🔘 ' + esc(b.text) + (p.once ? ' <i class="muted small">выбор</i>' : '') + '</span>' + (t ? node(t, depth + 1, np) : '<span class="tag no">пост в архиве</span>') + '</div>'; }
      else if (b.doc) kids += '<div class="fb"><span class="fb-l">📄 ' + esc(b.text) + '</span><span class="fb-r">' + esc(S.docNames[b.doc] || '') + (S.docs[b.doc] ? '' : ' · <b class="warn-t">ссылка не задана</b>') + '</span></div>';
      else if (b.pay) kids += '<div class="fb"><span class="fb-l">💳 ' + esc(b.text) + '</span><span class="fb-r">' + esc(TARIFF[b.pay] || 'оплата') + ' · подключим позже</span></div>';
      else kids += '<div class="fb"><span class="fb-l">🔗 ' + esc(b.text) + '</span><span class="fb-r">' + esc(domainOf(b.url)) + '</span></div>';
    }));
    afterKids(p.id).sort((a, b) => (a.delay || 0) - (b.delay || 0)).forEach((k) => { kids += '<div class="fb"><span class="fb-l">⏱ потом, через ' + esc(fmtDelay(k.delay)) + '</span>' + node(k, depth + 1, np) + '</div>'; });
    kids += '<button type="button" class="addb" data-add="' + p.id + '">＋ кнопка или следующий пост</button>';
    return h + '<div class="kids">' + kids + '</div>';
  };
  const isRoot = (p) => !(p.kind === 'drip' && p.mode === 'after' && ids[p.after]);
  const gifts = S.posts.filter((p) => p.kind === 'gift' && isRoot(p)).sort((a, b) => a.id - b.id);
  const drip = S.posts.filter((p) => p.kind === 'drip' && isRoot(p)).sort((a, b) => offMin(a, ids) - offMin(b, ids) || a.pos - b.pos || a.id - b.id);
  const dates = S.posts.filter((p) => p.kind === 'date').sort((a, b) => (a.run_at || 9e12) - (b.run_at || 9e12));
  let h = '<div class="btns" style="margin-top:16px"><button class="btn" type="button" id="newPost">＋ Новый пост</button></div>';
  h += entryBox();
  const sec = (title, note, list) => '<div class="grp">' + title + '</div>' + (note ? '<p class="small muted" style="margin:-2px 2px 10px">' + note + '</p>' : '') +
    (list.length ? list.map((p) => '<div class="tree">' + node(p, 0, []) + '</div>').join('') : '<p class="small muted dash">Пока пусто.</p>');
  h += sec('🎁 После теста', 'Подарок уходит сразу после аудит-теста.', gifts);
  h += sec('📅 Лента', 'По порядку от входа в бот. Дни и время удобно двигать во вкладке «Лента».', drip);
  h += sec('🕒 В дату', '', dates);
  const lost = S.posts.filter((p) => p.kind === 'node' && !shown.has(p.id));
  if (lost.length) h += sec('🔘 Посты-ответы без кнопки', 'На них пока не ведёт ни одна кнопка — человек их не получит. Привяжи: открой нужный пост → «＋ кнопка» → «Пост».', lost);
  $('body').innerHTML = h;
  $('newPost').onclick = openNew;
  bindEntry();
  document.querySelectorAll('.fn,.ref').forEach((el) => el.onclick = () => openPost(+el.dataset.id));
  document.querySelectorAll('[data-add]').forEach((el) => el.onclick = () => openPost(+el.dataset.add, { focus: 'buttons' }));
}

// вход в бот: служебные шаги по порядку + документы
function entryBox() {
  const d = S.docs || {};
  const ok = (k) => d[k] ? '<span class="ok-t">✓</span>' : '<span class="warn-t">не задана</span>';
  const steps = [
    ['hello', '👋 Приветствие'],
    ['consentPd', '✅ Согласие на данные', 'политика ' + ok('policy') + ' · согласие ' + ok('consent')],
    ['askLevel', '🎚 Уровень: начинающий / продолжающий'],
    ['testOffer', '🧪 Тест → 🎁 подарок', S.posts.filter((p) => p.kind === 'gift' && p.status === 'active').length + ' подарк. включено'],
    ['consentAds', '📬 Согласие на рассылку'],
  ];
  const miss = !d.policy || !d.consent;
  return '<div class="box"><h3>Вход в бот</h3><p class="small muted" style="margin:0 0 10px">Так бот встречает нового человека. Порядок фиксированный: по закону сначала согласие. Нажми на шаг — поменять текст.</p><div class="steps">' +
    steps.map(([k, t, sub], i) => '<button type="button" class="stp" data-k="' + k + '"><b>' + (i + 1) + '</b><span class="st-t">' + t + (sub ? '<i>' + sub + '</i>' : '') + '</span></button>').join('<div class="arr">↓</div>') +
    '<div class="arr">↓</div><div class="stp last"><b>→</b><span class="st-t">дальше — лента и посты ниже</span></div></div>' +
    '<div class="docs-row"><div><b>Документы</b><div class="small muted">политика ' + ok('policy') + ' · согласие ' + ok('consent') + ' · оферта ' + ok('offer') + '</div></div><button type="button" class="chip" id="docsBtn">изменить</button></div>' +
    (miss ? '<div class="note warn">Без ссылок на политику и согласие бот нельзя открывать для всех (152-ФЗ). Пока бот только для своих.</div>' : '') + '</div>';
}
function bindEntry() {
  document.querySelectorAll('.stp[data-k]').forEach((el) => el.onclick = () => { if (el.dataset.k === 'testOffer') { tab = 'gifts'; render(); window.scrollTo(0, 0); return; } openMsg(el.dataset.k); });
  $('docsBtn').onclick = openDocs;
}
function openDocs() {
  const d = S.docs || {};
  const f = (k, t, ph, hint) => '<label class="f">' + t + '</label><input type="text" id="d_' + k + '" inputmode="url" placeholder="' + ph + '" value="' + esc(d[k] || '') + '">' + (hint ? '<p class="small muted" style="margin:6px 2px 0">' + hint + '</p>' : '');
  sheet('<span class="pill">Документы</span><h2>Политика, согласие, оферта</h2>' +
    '<p class="small muted">Ссылки подставляются в шаг «Согласие на данные» ({политика}, {согласие}), в команду /policy и в кнопки-документы под постами.</p>' +
    f('policy', 'Политика обработки данных', 'https://…', '') + f('consent', 'Текст согласия на обработку данных', 'https://…', '') + f('offer', 'Оферта', 'https://…', 'Нужна к старту продаж.') +
    '<label class="f">Кто владелец (для /policy)</label><input type="text" id="d_owner" placeholder="Самозанятая Иванова К. И., ИНН …" value="' + esc(d.owner || '') + '">' +
    '<div class="btns"><button class="btn" id="dSave">Сохранить</button><button class="btn ghost" id="dClose">Закрыть</button></div>');
  $('dClose').onclick = closeSheet;
  $('dSave').onclick = async () => {
    const body = {}; ['policy', 'consent', 'offer', 'owner'].forEach((k) => body[k] = $('d_' + k).value.trim());
    try { const r = await api('/docs', body); S.docs = r.docs; closeSheet(); haptic('medium'); toast('Документы сохранены ✓'); render(); } catch (e) { toast(e.message); }
  };
}

// ---------- новый пост ----------
function openNew(preset) {
  preset = preset || {};
  if (preset.kind) return openPost(null, { draft: Object.assign(blankPost(preset.kind), preset) });
  sheet('<span class="pill">Новый пост</span><h2>Когда он уходит?</h2><div class="kinds">' +
    ['drip', 'node', 'date', 'gift'].map((k) => '<button type="button" class="kind" data-k="' + k + '"><b>' + KIND[k] + '</b><span>' + KIND_NOTE[k] + '</span></button>').join('') +
    '</div><div class="btns"><button class="btn ghost" id="nClose">Закрыть</button></div>');
  document.querySelectorAll('.kind').forEach((el) => el.onclick = () => { haptic(); openPost(null, { draft: blankPost(el.dataset.k) }); });
  $('nClose').onclick = closeSheet;
}
function blankPost(kind) {
  return { id: null, kind, status: 'draft', title: '', text: '', md: '', rich: false, once: false, files: [], media: [], day: 1, time: '11:00', mode: 'day', delay: 0, after: null, run_at: null, audience: 'all', catchup: false, pos: 0, rows: [], sent: 0, clicks: 0 };
}

// превью картинки поста
function thumb(img, fid) {
  fetch('/api/panel/file?id=' + encodeURIComponent(fid), { headers: { 'x-init-data': INIT } }).then((r) => r.ok ? r.blob() : null).then((b) => { if (b) img.src = URL.createObjectURL(b); }).catch(() => {});
}

// ---------- редактор поста (новый и существующий) ----------
function openPost(id, opt) {
  opt = opt || {};
  const p = opt.draft || S.posts.find((x) => x.id === id); if (!p) return;
  const isNew = !p.id;
  const st = { day: p.day ?? 1, time: p.time || '11:00', audience: p.audience, status: p.status, catchup: p.catchup, run_at: p.run_at, mode: p.mode || 'day', delay: p.delay || 0, after: p.after, once: !!p.once, files: JSON.parse(JSON.stringify(p.files || [])), editRich: false };
  const unitOf = (m) => (m >= 1440 && m % 1440 === 0 ? 1440 : m >= 60 && m % 60 === 0 ? 60 : 1);
  const unitSel = (sid, m) => '<select id="' + sid + '" style="width:auto;flex:none">' + [[1, 'минут'], [60, 'часов'], [1440, 'дней']].map(([v, t]) => '<option value="' + v + '"' + (unitOf(m) === v ? ' selected' : '') + '>' + t + '</option>').join('') + '</select>';
  const others = S.posts.filter((x) => ['drip', 'node', 'gift'].includes(x.kind) && x.id !== p.id);
  const parents = p.id ? parentsOf(p.id) : [];
  let h = '<div class="shd"><span class="pill">' + KIND[p.kind] + (p.id ? ' · #' + p.id : ' · новый') + '</span><button type="button" class="sx" id="bX" aria-label="закрыть">✕</button></div><h2>' + (isNew ? 'Новый пост' : esc(postName(p))) + '</h2>' +
    '<p class="small muted" style="margin:0 0 4px">' + KIND_NOTE[p.kind] + '</p>';
  // текст
  h += '<label class="f">Текст поста</label>';
  if (p.rich) h += '<div class="note warn" id="richNote">В тексте премиум-эмодзи или особое оформление из бота. Если править здесь — они станут обычными. Чтобы сохранить — правь в боте: <b>/posts</b> → #' + p.id + ' → ✏️.<br><button type="button" class="chip" id="richEdit" style="margin-top:8px">всё равно править здесь</button></div>';
  h += '<div class="fmt" id="fmtBar"' + (p.rich ? ' hidden' : '') + '><button type="button" data-w="**" title="жирный"><b>Ж</b></button><button type="button" data-w="__" title="курсив"><i>К</i></button><button type="button" data-w="~~" title="зачёркнутый"><s>З</s></button><button type="button" data-l="1">🔗 ссылка</button><button type="button" data-v="{имя}">{имя}</button></div>' +
    '<textarea id="fMd" placeholder="Напиши текст. **жирный**, __курсив__, [текст](https://ссылка)"' + (p.rich ? ' readonly' : '') + '>' + esc(p.md || '') + '</textarea>' +
    '<p class="small muted" id="mdCount" style="margin:6px 2px 0"></p>';
  // вложения
  h += '<label class="f">Картинки, видео, файлы</label><div class="files" id="fFiles"></div><input type="file" id="fFile" multiple hidden accept="image/*,video/mp4,application/pdf,.pdf,.zip,.fig,.psd">' +
    '<p class="small muted" style="margin:6px 2px 0">До 10 штук — уйдут альбомом, текст станет подписью (до 1024 знаков, длиннее — следующим сообщением). Файлы с картинками не смешиваются.</p>';
  h += '<label class="f">Название для себя</label><input type="text" id="fTitle" maxlength="80" placeholder="Например: «Развилка: кто ты»" value="' + esc(p.title) + '">';
  // когда
  if (p.kind === 'drip') {
    h += '<label class="f">Когда отправлять</label>' + segHtml('fMode', [['day', '📅 В день'], ['timer', '⏱ Таймер'], ['after', '↳ После поста']], st.mode) +
      '<div id="pDay" style="margin-top:10px"><div class="row" style="justify-content:space-between;flex-wrap:wrap;gap:12px"><div class="step"><button type="button" id="dMinus">−</button><b id="dVal">' + st.day + '</b><button type="button" id="dPlus">+</button></div>' +
      '<div id="tWrap" style="flex:1;min-width:140px"><input type="time" id="fTime" value="' + esc(st.time) + '"></div></div><p class="small muted" id="dHint" style="margin:6px 2px 0"></p></div>' +
      '<div id="pTimer" style="margin-top:10px"><div class="row"><span>через</span><input type="number" id="tNum" min="0" step="1" style="width:90px" value="' + (st.mode === 'timer' ? st.delay / unitOf(st.delay) : 30) + '">' + unitSel('tUnit', st.mode === 'timer' ? st.delay : 1) + '</div><p class="small muted" id="tHint" style="margin:6px 2px 0"></p></div>' +
      '<div id="pAfter" style="margin-top:10px">' + (others.length ? '<select id="aPost">' + others.map((x) => '<option value="' + x.id + '"' + (st.after === x.id ? ' selected' : '') + '>' + esc((x.kind === 'node' ? '🔘 ' : x.kind === 'gift' ? '🎁 ' : '') + postName(x).slice(0, 40)) + ' — ' + esc(whenOf(x)) + '</option>').join('') + '</select>' +
        '<div class="row" style="margin-top:8px"><span>через</span><input type="number" id="aNum" min="0" step="1" style="width:90px" value="' + (st.mode === 'after' ? st.delay / unitOf(st.delay) : 1) + '">' + unitSel('aUnit', st.mode === 'after' ? st.delay : 60) + '</div><p class="small muted" id="aHint" style="margin:6px 2px 0"></p>'
        : '<p class="small muted">Других постов пока нет.</p>') + '</div>' +
      '<div class="toggle"><span><b>Догонять опоздавших</b><br><span class="small muted">Пост получат и те, у кого этот день уже прошёл</span></span><label class="sw"><input type="checkbox" id="fCatch" ' + (st.catchup ? 'checked' : '') + '><span></span></label></div>';
  }
  if (p.kind === 'date') h += '<label class="f">Дата и время (по Москве)</label><input type="datetime-local" id="fRun" value="' + toLocal(st.run_at) + '">';
  if (p.kind === 'node') h += '<div class="note">' + (parents.length ? 'Сюда ведут: ' + parents.map((x) => '«' + esc(postName(x.p).slice(0, 30)) + '» → кнопка «' + esc(x.b.text) + '»').join('; ') : 'Пока сюда не ведёт ни одна кнопка. Привяжи его: в нужном посте добавь кнопку → «Пост» → выбери этот.') + '</div>';
  // кнопки
  h += '<label class="f" id="btnsLbl">Кнопки под постом</label><div id="bEd"></div>' +
    '<div class="btns two" style="margin-top:8px"><button class="btn ghost" type="button" id="bRow">＋ Кнопка</button><button class="btn ghost" type="button" id="bNext">＋ Следующий пост</button></div>' +
    '<div class="toggle" id="onceWrap"><span><b>Кнопки-выбор</b><br><span class="small muted">После нажатия под постом остаётся только выбранный вариант с ✓ — человек не нажмёт второй</span></span><label class="sw"><input type="checkbox" id="fOnce" ' + (st.once ? 'checked' : '') + '><span></span></label></div>';
  if (p.kind !== 'node') h += '<label class="f">Кому</label>' + segHtml('fAud', [['all', 'Всем'], ['start', 'Начинающим'], ['pro', 'Продолжающим']], st.audience);
  h += '<label class="f">Статус</label>' + segHtml('fSt', [['active', '✅ Включён'], ['paused', '⏸ Пауза'], ['draft', '📝 Черновик']], st.status);
  h += '<div class="btns"><button class="btn" id="bSave">' + (isNew ? 'Создать пост' : 'Сохранить') + '</button>' +
    (isNew ? '<button class="btn ghost" id="bClose">Отмена</button>' : '<div class="btns two" style="margin:0"><button class="btn ghost" id="bPrev">👁 Прислать мне</button><button class="btn ghost" id="bClose">Закрыть</button></div><button class="btn danger" id="bArch">🗄 Убрать в архив</button>') + '</div>';
  sheet(h);

  // текст: панель оформления и счётчик
  const ta = $('fMd');
  const count = () => { const n = ta.value.replace(/\\*\\*|__|~~/g, '').replace(/\\[([^\\]]*)\\]\\([^)]*\\)/g, '$1').length; $('mdCount').textContent = n + ' / ' + (st.files.length ? '1024 в подписи' : '4096') + (st.files.length && n > 1024 ? ' — текст уйдёт отдельным сообщением под картинками' : ''); };
  ta.oninput = count;
  $('fmtBar').onclick = (e) => {
    const b = e.target.closest('button'); if (!b) return;
    const s = ta.selectionStart, en = ta.selectionEnd, sel = ta.value.slice(s, en);
    let ins, cur;
    if (b.dataset.w) { ins = b.dataset.w + (sel || 'текст') + b.dataset.w; cur = sel ? s + ins.length : s + b.dataset.w.length; }
    else if (b.dataset.l) { ins = '[' + (sel || 'текст') + '](https://)'; cur = s + ins.length - 1; }
    else { ins = b.dataset.v; cur = s + ins.length; }
    ta.value = ta.value.slice(0, s) + ins + ta.value.slice(en); ta.focus();
    if (b.dataset.w && !sel) { ta.selectionStart = s + b.dataset.w.length; ta.selectionEnd = s + b.dataset.w.length + 5; } else ta.selectionStart = ta.selectionEnd = cur;
    count(); haptic();
  };
  if ($('richEdit')) $('richEdit').onclick = () => { st.editRich = true; ta.readOnly = false; $('fmtBar').hidden = false; $('richNote').remove(); ta.focus(); };
  count();

  // вложения
  const drawFiles = () => {
    $('fFiles').innerHTML = st.files.map((f, i) => '<div class="fl">' + (f.type === 'photo' ? '<img alt="" data-fid="' + esc(f.file_id) + '">' : '<span class="fl-ic">' + ({ video: '🎬', animation: '🎞', document: '📄' }[f.type] || '📎') + '<i>' + esc((f.name || f.type).slice(0, 14)) + '</i></span>') +
      '<button type="button" class="fl-x" data-del="' + i + '" aria-label="убрать">✕</button>' + (i > 0 ? '<button type="button" class="fl-l" data-left="' + i + '" aria-label="левее">‹</button>' : '') + '</div>').join('') +
      (st.files.length < 10 ? '<button type="button" class="fl add" id="fAdd">＋<span>добавить</span></button>' : '');
    $('fFiles').querySelectorAll('img[data-fid]').forEach((img) => thumb(img, img.dataset.fid));
    if ($('fAdd')) $('fAdd').onclick = () => $('fFile').click();
    count();
  };
  $('fFiles').onclick = (e) => {
    const b = e.target.closest('button'); if (!b) return;
    if (b.dataset.del) { st.files.splice(+b.dataset.del, 1); haptic(); drawFiles(); }
    if (b.dataset.left) { const i = +b.dataset.left; [st.files[i - 1], st.files[i]] = [st.files[i], st.files[i - 1]]; haptic(); drawFiles(); }
  };
  $('fFile').onchange = async () => {
    const list = [...$('fFile').files].slice(0, 10 - st.files.length); $('fFile').value = '';
    for (const f of list) {
      toast('Загружаю ' + f.name + '…');
      const fd = new FormData(); fd.append('file', f);
      try {
        const r = await fetch('/api/panel/upload', { method: 'POST', headers: { 'x-init-data': INIT }, body: fd });
        const d = await r.json().catch(() => ({ error: 'Сервер не ответил' }));
        if (!r.ok || d.error) throw new Error(d.error || 'Ошибка');
        st.files.push(d.file); drawFiles();
      } catch (e) { toast(f.name + ': ' + e.message); }
    }
    if (list.length) { haptic('medium'); toast('Загружено ✓'); }
  };
  drawFiles();

  // когда (лента)
  const showMode = () => { if (!$('pDay')) return; $('pDay').style.display = st.mode === 'day' ? '' : 'none'; $('pTimer').style.display = st.mode === 'timer' ? '' : 'none'; $('pAfter').style.display = st.mode === 'after' ? '' : 'none'; hints(); };
  const delayOf = (n, u) => Math.max(0, Math.round((+$(n).value || 0) * +$(u).value));
  const hints = () => {
    if ($('tHint')) $('tHint').textContent = 'Через ' + fmtDelay(delayOf('tNum', 'tUnit')) + ' после того, как человек согласился на рассылку (в любое время суток).';
    if ($('aHint') && $('aPost')) { const par = S.posts.find((x) => x.id === +$('aPost').value); $('aHint').textContent = 'Через ' + fmtDelay(delayOf('aNum', 'aUnit')) + ' после того, как человек получил «' + (par ? postName(par).slice(0, 40) : '') + '»' + (par && par.kind === 'node' ? ' (то есть нажал кнопку, которая ведёт туда)' : '') + '. Пока тот пост не пришёл — этот не уйдёт.'; }
  };
  if ($('fMode')) { segBind('fMode', (v) => { st.mode = v; haptic(); showMode(); }); ['tNum', 'tUnit', 'aNum', 'aUnit', 'aPost'].forEach((i) => { if ($(i)) $(i).oninput = hints; }); showMode(); }
  const upd = () => { if (!$('dVal')) return; $('dVal').textContent = st.day; $('tWrap').style.display = st.day === 0 ? 'none' : ''; $('dHint').textContent = 'День ' + st.day + ' — ' + dayLabel(st.day) + (st.day ? ', в ' + ($('fTime').value || st.time) + ' по Москве' : ''); };
  if ($('dMinus')) { $('dMinus').onclick = () => { st.day = Math.max(0, st.day - 1); haptic(); upd(); }; $('dPlus').onclick = () => { st.day = Math.min(365, st.day + 1); haptic(); upd(); }; $('fTime').oninput = upd; upd(); }
  if ($('fAud')) segBind('fAud', (v) => st.audience = v);
  segBind('fSt', (v) => st.status = v);

  // кнопки: ссылка / пост / документ / оплата
  let rows = JSON.parse(JSON.stringify(p.rows || [])).map((row) => row.map((b) => Object.assign({ t: b.go ? 'go' : b.doc ? 'doc' : b.pay ? 'pay' : 'url' }, b)));
  const targets = S.posts.filter((x) => x.id !== p.id);
  const optPosts = (cur) => '<option value="">— выбери пост —</option><option value="new"' + (cur === 'new' ? ' selected' : '') + '>＋ Новый пост-ответ (создам пустой)</option>' +
    ['node', 'drip', 'date', 'gift'].map((k) => { const l = targets.filter((x) => x.kind === k); return l.length ? '<optgroup label="' + KIND[k] + '">' + l.map((x) => '<option value="' + x.id + '"' + (+cur === x.id ? ' selected' : '') + '>' + esc(postName(x).slice(0, 44)) + (x.status !== 'active' ? ' · ' + (x.status === 'draft' ? 'черновик' : 'пауза') : '') + '</option>').join('') + '</optgroup>' : ''; }).join('');
  const valueField = (b, r, i) => {
    const a = 'data-r="' + r + '" data-i="' + i + '"';
    if (b.t === 'go') return '<select ' + a + ' data-f="go">' + optPosts(b.go) + '</select>';
    if (b.t === 'doc') return '<select ' + a + ' data-f="doc">' + Object.keys(S.docNames).map((k) => '<option value="' + k + '"' + (b.doc === k ? ' selected' : '') + '>' + esc(S.docNames[k]) + (S.docs[k] ? '' : ' — ссылка не задана') + '</option>').join('') + '</select>';
    if (b.t === 'pay') return '<select ' + a + ' data-f="pay">' + Object.keys(TARIFF).map((k) => '<option value="' + k + '"' + (b.pay === k ? ' selected' : '') + '>' + TARIFF[k] + '</option>').join('') + '</select><p class="small muted" style="margin:2px">Оплату через продамус подключим позже — пока кнопка отвечает «откроется в день продаж».</p>';
    return '<input type="text" placeholder="https://ссылка" inputmode="url" ' + a + ' data-f="url" value="' + esc(b.url || '') + '">';
  };
  const sync = () => { document.querySelectorAll('#bEd [data-f]').forEach((el) => { const r = +el.dataset.r, i = +el.dataset.i; if (rows[r] && rows[r][i]) rows[r][i][el.dataset.f] = el.value; }); };
  const drawRows = () => {
    $('bEd').innerHTML = rows.length ? rows.map((row, r) =>
      '<div class="brow"><div class="row" style="justify-content:space-between;margin-bottom:6px"><span class="small muted">' + (row.length > 1 ? 'Ряд ' + (r + 1) + ' · кнопки рядом' : 'Ряд ' + (r + 1)) + '</span><span>' +
      (r > 0 ? '<button type="button" class="chip" data-up="' + r + '" aria-label="выше">↑</button> ' : '') + (r < rows.length - 1 ? '<button type="button" class="chip" data-down="' + r + '" aria-label="ниже">↓</button>' : '') + '</span></div>' +
      row.map((b, i) => '<div class="bcard"><div style="display:grid;grid-template-columns:1fr auto;gap:6px"><input type="text" placeholder="Текст кнопки" maxlength="60" data-r="' + r + '" data-i="' + i + '" data-f="text" value="' + esc(b.text || '') + '"><button type="button" class="chip" data-del="' + r + ':' + i + '" aria-label="убрать кнопку">✕</button></div>' +
        '<div class="btype">' + [['url', '🔗 Ссылка'], ['go', '➡️ Пост'], ['doc', '📄 Документ'], ['pay', '💳 Оплата']].map(([k, t]) => '<button type="button" data-type="' + k + '" data-r="' + r + '" data-i="' + i + '" class="' + (b.t === k ? 'on' : '') + '">' + t + '</button>').join('') + '</div>' + valueField(b, r, i) + '</div>').join('') +
      (row.length < 4 ? '<button type="button" class="chip" data-add="' + r + '">＋ кнопка рядом</button>' : '') + '</div>').join('')
      + '<button type="button" class="addb" id="bClear" data-clear="1">убрать все кнопки</button>'
      : '<p class="small muted" style="margin:2px">Кнопок нет. Кнопка может вести на ссылку, на другой пост бота (развилка), на документ или на оплату тарифа.</p>';
    $('onceWrap').style.display = rows.some((row) => row.some((b) => b.t === 'go')) ? '' : 'none';
  };
  $('bEd').addEventListener('input', sync);
  $('bEd').addEventListener('change', sync);
  $('bEd').addEventListener('click', (e) => {
    const t = e.target.closest('button'); if (!t) return; sync();
    if (t.dataset.type) { const b = rows[+t.dataset.r][+t.dataset.i]; b.t = t.dataset.type; if (b.t === 'doc' && !b.doc) b.doc = 'policy'; if (b.t === 'pay' && !b.pay) b.pay = 'curator'; }
    if (t.dataset.add !== undefined) { const rr = rows[+t.dataset.add]; rr.push({ t: rr[rr.length - 1].t, text: '', url: '', go: '', doc: 'policy', pay: 'curator' }); }
    if (t.dataset.clear) rows = [];
    if (t.dataset.del) { const [r, i] = t.dataset.del.split(':').map(Number); rows[r].splice(i, 1); if (!rows[r].length) rows.splice(r, 1); }
    if (t.dataset.up) { const r = +t.dataset.up; [rows[r - 1], rows[r]] = [rows[r], rows[r - 1]]; }
    if (t.dataset.down) { const r = +t.dataset.down; [rows[r + 1], rows[r]] = [rows[r], rows[r + 1]]; }
    haptic(); drawRows();
  });
  $('bRow').onclick = () => { sync(); rows.push([{ t: 'url', text: '', url: '' }]); drawRows(); const l = $('bEd').querySelectorAll('input[data-f="text"]'); if (l.length) l[l.length - 1].focus(); };
  // следующий пост по времени — без кнопки: «через N после этого»
  $('bNext').onclick = () => {
    if (!p.id) return toast('Сначала создай этот пост — потом добавишь следующий');
    openNew({ kind: 'drip', mode: 'after', after: p.id, delay: 1440 });
  };
  drawRows();
  if (opt.focus === 'buttons') setTimeout(() => { $('btnsLbl').scrollIntoView({ block: 'start', behavior: 'smooth' }); }, 280);

  const close = () => closeSheet();
  $('bX').onclick = close; $('bClose').onclick = close;
  if ($('bPrev')) $('bPrev').onclick = async () => { try { const r = await api('/post/' + p.id + '/preview', {}); toast(r.warn ? '⚠️ ' + r.warn : 'Отправила тебе в бот 👀'); } catch (e) { toast(e.message); } };
  if ($('bArch')) $('bArch').onclick = async () => { try { await api('/post/' + p.id, { status: 'archived' }); closeSheet(); toast('В архиве. Вернуть можно в боте: /posts → 🗄 Архив'); await reload(); } catch (e) { toast(e.message); } };
  $('bSave').onclick = async () => {
    sync();
    const btn = $('bSave'); btn.disabled = true;
    try {
      // кнопки «＋ новый пост-ответ»: сначала создаём пустые посты-ответы
      const created = [];
      for (const row of rows) for (const b of row) {
        if (b.t === 'go' && b.go === 'new') {
          if (!b.text.trim()) throw new Error('Сначала напиши текст кнопки, потом создавай пост-ответ');
          const r = await api('/post/new', { kind: 'node', title: b.text.trim(), md: '', status: 'draft' });
          b.go = r.post.id; created.push(r.post.id);
        }
      }
      const outRows = rows.map((row) => row.map((b) => b.t === 'go' ? { text: b.text, go: +b.go || null } : b.t === 'doc' ? { text: b.text, doc: b.doc } : b.t === 'pay' ? { text: b.text, pay: b.pay } : { text: b.text, url: b.url }));
      for (const b of outRows.flat()) if (b.go === null && b.text) throw new Error('У кнопки «' + b.text + '» не выбран пост');
      const body = { title: $('fTitle').value.trim(), status: st.status, rows: outRows, once: $('fOnce').checked, files: st.files };
      if (!p.rich || st.editRich) body.md = ta.value;
      if (p.kind !== 'node') body.audience = st.audience;
      if (p.kind === 'drip') {
        body.mode = st.mode; body.catchup = $('fCatch').checked;
        if (st.mode === 'day') { body.day = st.day; body.time = st.day > 0 ? ($('fTime').value || st.time) : '00:00'; }
        if (st.mode === 'timer') body.delay_min = delayOf('tNum', 'tUnit');
        if (st.mode === 'after') { if (!$('aPost')) throw new Error('Нет поста, после которого отправлять'); body.after_id = +$('aPost').value; body.delay_min = delayOf('aNum', 'aUnit'); }
      }
      if (p.kind === 'date') { const t = fromLocal($('fRun').value); if (!t && st.status === 'active') throw new Error('Выбери дату и время'); if (t) body.run_at = t; }
      let r;
      if (isNew) r = await api('/post/new', Object.assign({ kind: p.kind }, body));
      else r = await api('/post/' + p.id, body);
      haptic('medium');
      await reload();
      if (created.length) { toast('Сохранено. Теперь заполни пост-ответ 👇'); openPost(created[0]); return; }
      closeSheet(); toast(isNew ? 'Пост создан ✓' : 'Сохранено ✓' + (r.reach !== undefined && p.kind !== 'node' ? ' · сейчас подходит людей: ' + r.reach : ''));
    } catch (e) { toast(e.message); }
    finally { btn.disabled = false; }
  };
}
async function reload() { try { S = await api('/state'); render(); } catch (e) { toast(e.message); } }

function openMsg(key) {
  const m = S.msgs.find((x) => x.key === key); if (!m) return;
  let h = '<span class="pill">' + (m.button ? 'Кнопка' : m.group === 'profile' ? 'Профиль бота' : 'Сообщение') + '</span><h2>' + esc(m.title) + '</h2>' +
    (m.group === 'profile' ? '<div class="note">' + (m.key === 'botDesc' ? 'Этот текст человек видит в пустом чате до нажатия «Старт».' : m.key === 'botShort' ? 'Виден в профиле бота и когда ссылку на бота пересылают.' : 'Подпись команды в меню «Меню» слева от поля ввода.') + ' Обычный текст до ' + m.limit + ' знаков. Применится в Telegram сразу после сохранения.</div>' : '') +
    (m.emoji ? '<div class="note warn">В этом тексте есть премиум-эмодзи. Если сохранить его отсюда, они станут обычными. Чтобы оставить премиум — меняй в боте: <b>/texts</b>.</div>' : '') +
    (m.button ? '<input type="text" id="mText" maxlength="64" value="' + esc(m.text) + '">' : '<textarea id="mText"' + (m.limit ? ' maxlength="' + m.limit + '"' : '') + '>' + esc(m.text) + '</textarea>') +
    (m.limit && !m.button ? '<p class="small muted" style="margin:6px 2px 0" id="mCount"></p>' : '') +
    (m.canMedia ? '<label class="f">Картинка над текстом</label>' + (m.media
      ? (m.media === 'photo' ? '<div style="background:rgba(44,13,2,.05);border-radius:14px;padding:6px;text-align:center"><img id="mImg" alt="" style="display:block;max-width:100%;max-height:60vh;width:auto;height:auto;margin:0 auto;border-radius:10px;min-height:60px"></div><p class="small muted" id="mImgInfo" style="margin:6px 2px 0">загружаю превью…</p>' : '<div class="preview">' + (m.media === 'video' ? '🎬 видео прикреплено' : '🎞 гифка прикреплена') + '</div>') +
        '<div class="btns two" style="margin-top:8px"><button class="btn ghost" id="mAdd" type="button">Заменить</button><button class="btn ghost" id="mDelImg" type="button">Убрать</button></div>'
      : '<button class="btn ghost" id="mAdd" type="button">＋ Добавить картинку, гифку или видео</button>') +
      '<input type="file" id="mFile" accept="image/jpeg,image/png,image/webp,image/gif,video/mp4" hidden><p class="small muted" style="margin:6px 2px 0">Текст станет подписью под картинкой (до 1024 знаков — длиннее уйдёт следующим сообщением).</p>' : '') +
    (m.canMedia ? '<label class="f">Пауза перед сообщением</label><div class="row"><input type="text" inputmode="decimal" id="mDelay" style="width:90px" value="' + String(m.delay).replace('.', ',') + '"><span class="muted">сек — столько бот «печатает» (• • •) перед ним' + (m.delay !== m.defDelay ? ' · было ' + String(m.defDelay).replace('.', ',') : '') + '</span></div>' +
      '<label class="f">Свои кнопки-ссылки под сообщением</label><div id="mLinks"></div><p class="small muted" style="margin:6px 2px 0">Например «Наш канал» или «Сайт школы». Встают под встроенными кнопками.</p>' : '') +
    (m.vars.length ? '<p class="small muted" style="margin:10px 2px 0">Нажми, чтобы вставить — бот подставит сам:</p><div class="vars" id="mVars">' + m.vars.map((v) => '<button type="button" data-v="{' + v + '}">{' + v + '}</button>').join('') + '</div>' : '') +
    '<div class="btns"><button class="btn" id="mSave">Сохранить</button><div class="btns two" style="margin:0"><button class="btn ghost" id="mPrev">👁 Прислать мне</button><button class="btn ghost" id="mClose">Закрыть</button></div>' +
    (m.changed ? '<button class="btn danger" id="mReset">↩️ Вернуть текст по умолчанию</button>' : '') + '</div>' +
    (m.changed ? '<p class="small muted" style="margin-top:12px">По умолчанию было:</p><div class="preview">' + esc(m.def) + '</div>' : '');
  sheet(h);
  const ta = $('mText');
  const getLinks = $('mLinks') ? rowsEditor($('mLinks'), JSON.parse(JSON.stringify(m.links || []))) : null;
  if ($('mImg')) fetch('/api/panel/msg/' + key + '/img', { headers: { 'x-init-data': INIT } }).then((r) => r.ok ? r.blob() : null).then((b) => {
    if (!b) { $('mImgInfo').textContent = 'превью не загрузилось — в боте картинка есть'; return; }
    const img = $('mImg');
    img.onload = () => {
      const w = img.naturalWidth, h = img.naturalHeight;
      const g = (a, c) => (c ? g(c, a % c) : a), d = g(w, h);
      const known = { '1:1': 'квадрат', '16:9': 'горизонтальная 16:9', '9:16': 'вертикальная 9:16', '4:3': '4:3', '3:4': '3:4', '3:2': '3:2', '2:3': '2:3', '4:5': '4:5', '5:4': '5:4' };
      const r = (w / h);
      const name = known[w / d + ':' + h / d] || (Math.abs(r - 1) < 0.03 ? 'почти квадрат' : r > 1 ? 'горизонтальная' : 'вертикальная');
      const kb = b.size / 1024;
      $('mImgInfo').textContent = 'В Telegram: ' + w + ' × ' + h + ' px · ' + name + ' · ' + (kb > 1024 ? (kb / 1024).toFixed(1) + ' МБ' : Math.round(kb) + ' КБ') + '. Показана целиком, как увидит ученик.';
    };
    img.src = URL.createObjectURL(b);
  }).catch(() => {});
  if ($('mAdd')) {
    $('mAdd').onclick = () => $('mFile').click();
    $('mFile').onchange = async () => {
      const f = $('mFile').files[0]; if (!f) return;
      toast('Загружаю ' + f.name + ' · ' + (f.size > 1048576 ? (f.size / 1048576).toFixed(1) + ' МБ' : Math.round(f.size / 1024) + ' КБ'));
      const fd = new FormData(); fd.append('file', f);
      $('mAdd').textContent = 'Загружаю…'; $('mAdd').disabled = true;
      try {
        const r = await fetch('/api/panel/msg/' + key + '/media', { method: 'POST', headers: { 'x-init-data': INIT }, body: fd });
        const d = await r.json().catch(() => ({ error: 'Сервер не ответил' }));
        if (!r.ok || d.error) throw new Error(d.error || 'Ошибка');
        S.msgs = d.msgs; haptic('medium'); toast('Картинка сохранена ✓'); openMsg(key); render();
      } catch (e) { toast(e.message); $('mAdd').textContent = 'Попробовать ещё раз'; $('mAdd').disabled = false; }
    };
  }
  if ($('mDelImg')) $('mDelImg').onclick = async () => { try { const r = await api('/msg/' + key, { removeMedia: true }); S.msgs = r.msgs; toast('Картинку убрали'); openMsg(key); render(); } catch (e) { toast(e.message); } };
  if ($('mCount')) { const upc = () => { $('mCount').textContent = ta.value.length + ' / ' + m.limit; }; ta.oninput = upc; upc(); }
  if ($('mVars')) $('mVars').onclick = (e) => { const b = e.target.closest('button'); if (!b) return; const s = ta.selectionStart ?? ta.value.length, en = ta.selectionEnd ?? s; ta.value = ta.value.slice(0, s) + b.dataset.v + ta.value.slice(en); ta.focus(); ta.selectionStart = ta.selectionEnd = s + b.dataset.v.length; };
  $('mClose').onclick = closeSheet;
  $('mPrev').onclick = async () => { try { await api('/msg/' + key + '/preview', {}); toast('Отправила тебе в бот — так видит ученик (сохранённая версия)'); } catch (e) { toast(e.message); } };
  $('mSave').onclick = async () => {
    const body = {};
    if (ta.value !== m.text) body.text = ta.value;
    if ($('mDelay')) { body.delay = parseFloat(String($('mDelay').value).replace(',', '.')) || 0; body.links = getLinks(); }
    try { const r = await api('/msg/' + key, body); S.msgs = r.msgs; closeSheet(); haptic('medium'); toast('Сохранено ✓'); render(); } catch (e) { toast(e.message); }
  };
  if ($('mReset')) $('mReset').onclick = async () => { try { const r = await api('/msg/' + key, { reset: true }); S.msgs = r.msgs; closeSheet(); toast('Вернули как было ↩️'); render(); } catch (e) { toast(e.message); } };
}

load();
})();
</script>
</body>
</html>
`;

// src/worker.js
var html = (body, status = 200) => new Response(`<!doctype html><meta charset="utf-8"><body style="font:16px system-ui;padding:24px;max-width:640px">${body}</body>`, { status, headers: { "content-type": "text/html; charset=utf-8" } });
var worker_default = {
  async fetch(request, env, execCtx) {
    const url = new URL(request.url);
    const db = d1Adapter(env.DB);
    const ctx = makeCtx({ db, env, publicUrl: url.origin });
    if (url.pathname === "/tg" || url.pathname.startsWith("/api/")) await ensureSchema(db);
    if (url.pathname === "/admin" || url.pathname === "/admin/") return new Response(panel_html_default, { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });
    if (url.pathname.startsWith("/api/panel/")) {
      ctx.waitUntil = (p) => execCtx.waitUntil(p);
      return handlePanelApi(ctx, request, url);
    }
    if (url.pathname === "/tg" && request.method === "POST") {
      if (env.WEBHOOK_SECRET && request.headers.get("x-telegram-bot-api-secret-token") !== env.WEBHOOK_SECRET) return new Response("forbidden", { status: 403 });
      const upd = await request.json().catch(() => null);
      if (upd) {
        const job = handleUpdate(ctx, upd).catch((e) => console.log("update error", e && e.stack));
        if (execCtx && execCtx.waitUntil) execCtx.waitUntil(job);
        else await job;
      }
      return new Response("ok");
    }
    if (url.pathname === "/setup") {
      if (!env.SETUP_KEY || url.searchParams.get("key") !== env.SETUP_KEY) return html("Нужен правильный ключ: /setup?key=…", 403);
      try {
        const out = await setup(ctx, { webhookUrl: url.origin + "/tg" });
        return html("<h2>Готово 🐾</h2><ul>" + out.map((x) => `<li>${x}</li>`).join("") + "</ul><p>Теперь напиши боту /start, а затем /check.</p>");
      } catch (e) {
        return html("<h2>Ошибка</h2><p>" + String(e.message) + "</p>", 500);
      }
    }
    if (url.pathname === "/export") {
      if (!env.SETUP_KEY || url.searchParams.get("key") !== env.SETUP_KEY) return html("Нужен правильный ключ", 403);
      const data = await exportAll(db);
      return new Response(JSON.stringify(data), { headers: { "content-type": "application/json", "content-disposition": `attachment; filename="bot-backup-${(/* @__PURE__ */ new Date()).toISOString().slice(0, 10)}.json"` } });
    }
    if (url.pathname === "/test" || url.pathname === "/test/") {
      const src = env.TEST_SRC || "https://raw.githubusercontent.com/karoleenok/di-sign-audit/main/index.html";
      const res = await fetch(src, { cf: { cacheTtl: 300, cacheEverything: true } });
      return new Response(await res.text(), { status: res.ok ? 200 : 502, headers: { "content-type": "text/html; charset=utf-8" } });
    }
    const r = /^\/r\/(\d+)\/(\d+-\d+)\/(\d+)$/.exec(url.pathname);
    if (r) {
      const to = await clickRedirect(ctx, +r[1], r[2], r[3]).catch(() => null);
      return to ? Response.redirect(to, 302) : new Response("not found", { status: 404 });
    }
    return html("Di Sign University bot 🐾");
  },
  async scheduled(event, env, execCtx) {
    const ctx = makeCtx({ db: d1Adapter(env.DB), env });
    await ensureSchema(ctx.db);
    await tick(ctx, Number(env.TICK_BUDGET) || 30, Number(env.QUERY_BUDGET) || 40);
    await stepRuns(ctx, 10).catch((e) => console.log("test run", e && e.stack));
  }
};
export {
  worker_default as default
};
