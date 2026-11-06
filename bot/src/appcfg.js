// Расписание открытия игр в мини-аппке. Лежит в таблице settings (ключ app_cfg), отдельная миграция не нужна.
// Режимы игры: open — открыта, closed — закрыта, sched — открыть с даты (from) и закрыть к дате (until, можно не задавать).
export const ITEMS = [
  { id: 'poster', name: 'Принципы дизайна', track: 'Мини-курс' },
  { id: 'fonts', name: 'Шрифтовая примерочная', track: 'Месяц материалов' },
];
const KEY = 'app_cfg';
const MODES = ['open', 'closed', 'sched'];
const MAX_TS = 4102444800; // 2100 год: всё, что больше, считаем мусором

export function defaults() {
  const items = {};
  for (const it of ITEMS) items[it.id] = { mode: 'open', from: null, until: null };
  return { public: false, items };
}

const ts = (v) => {
  if (v === null || v === undefined || v === '') return null;
  const n = Math.floor(Number(v));
  return Number.isFinite(n) && n > 0 && n < MAX_TS ? n : null;
};

// Приводит любые входные данные к безопасному виду: лишние игры и режимы отбрасываются
export function normalize(raw) {
  const d = defaults();
  const src = raw && typeof raw === 'object' ? raw : {};
  d.public = src.public === true;
  const items = src.items && typeof src.items === 'object' ? src.items : {};
  for (const it of ITEMS) {
    const r = items[it.id];
    if (!r || typeof r !== 'object') continue;
    const mode = MODES.includes(r.mode) ? r.mode : 'open';
    const from = ts(r.from), until = ts(r.until);
    d.items[it.id] = mode === 'sched' ? { mode, from, until } : { mode, from: null, until: null };
  }
  return d;
}

export function isOpen(item, now) {
  if (!item || item.mode === 'open') return true;
  if (item.mode === 'closed') return false;
  if (item.from && now < item.from) return false;
  if (item.until && now >= item.until) return false;
  return true;
}

// Проверка при сохранении: ошибка человеку понятным языком
export function validate(cfg) {
  for (const it of ITEMS) {
    const r = cfg.items[it.id];
    if (r.mode !== 'sched') continue;
    if (!r.from && !r.until) return `«${it.name}»: выбери дату открытия или закрытия`;
    if (r.from && r.until && r.until <= r.from) return `«${it.name}»: закрытие должно быть позже открытия`;
  }
  return null;
}

export async function loadCfg(ctx) {
  const r = await ctx.db.first(`SELECT value FROM settings WHERE key = ?`, [KEY]);
  if (!r) return defaults();
  try { return normalize(JSON.parse(r.value)); } catch { return defaults(); }
}

export async function saveCfg(ctx, input) {
  const cfg = normalize(input);
  const err = validate(cfg);
  if (err) return { error: err };
  await ctx.db.run(`INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`, [KEY, JSON.stringify(cfg)]);
  return { cfg };
}

// Что отдаём аппке. Обычному человеку: только открыта ли игра и когда откроется. Админу: всё.
export function viewFor(cfg, now, admin) {
  const items = {};
  for (const it of ITEMS) {
    const r = cfg.items[it.id];
    const open = isOpen(r, now);
    items[it.id] = admin
      ? { open, mode: r.mode, from: r.from, until: r.until, name: it.name, track: it.track }
      : { open, from: r.mode === 'sched' && !open && r.from && now < r.from ? r.from : null };
  }
  return { admin: !!admin, now, public: cfg.public, items };
}
