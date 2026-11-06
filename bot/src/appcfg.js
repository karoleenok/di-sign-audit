// Расписание открытия игр в мини-аппке. Лежит в таблице settings (ключ app_cfg), отдельная миграция не нужна.
// Режимы игры: open — открыта, closed — закрыта, sched — открыть с даты (from) и закрыть к дате (until, можно не задавать).
export const ITEMS = [
  { id: 'poster', name: 'Принципы дизайна', track: 'Мини-курс' },
  { id: 'fonts', name: 'Шрифтовая примерочная', track: 'Месяц материалов' },
];
const KEY = 'app_cfg';
const MODES = ['open', 'closed', 'sched'];
const MAX_TS = 4102444800; // 2100 год: всё, что больше, считаем мусором

// «Дальше в ноябре»: что скоро появится на главном экране аппки. d — дата показа в формате ГГГГ-ММ-ДД или null («скоро»)
const SOON_DEFAULT = {
  mini: [{ t: 'Рандомайзер ТЗ от таксёнышей', d: null }, { t: 'Промпты для мокапов', d: null }, { t: 'Шаблон кейсов', d: null }],
  mat: [{ t: 'Мокап-пак, сделанный ИИ', d: null }, { t: 'Калькулятор цены и КП', d: null }, { t: 'Красные флаги в брифе', d: null }],
};
const clone = (o) => JSON.parse(JSON.stringify(o));
const validDay = (s) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(s || ''));
  if (!m) return null;
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  return d.getUTCFullYear() === +m[1] && d.getUTCMonth() === +m[2] - 1 && d.getUTCDate() === +m[3] && +m[1] >= 2024 && +m[1] <= 2100 ? String(s) : null;
};
export function normalizeSoon(v, fallback) {
  const out = {};
  const src = v && typeof v === 'object' ? v : {};
  for (const k of ['mini', 'mat']) {
    if (!Array.isArray(src[k])) { out[k] = clone(fallback[k]); continue; }
    out[k] = src[k].slice(0, 8).map((x) => ({ t: String((x && x.t) || '').replace(/\s+/g, ' ').trim().slice(0, 60), d: validDay(x && x.d) })).filter((x) => x.t);
  }
  return out;
}

export function defaults() {
  const items = {};
  for (const it of ITEMS) items[it.id] = { mode: 'open', from: null, until: null };
  return { public: false, items, soon: clone(SOON_DEFAULT) };
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
  d.soon = normalizeSoon(src.soon, d.soon);
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
  // что не прислали, то не трогаем: ползунок «показывать всем» шлёт только public, расписание шлёт public и items
  const cur = await loadCfg(ctx), inp = input && typeof input === 'object' ? input : {};
  const cfg = normalize({ public: inp.public === undefined ? cur.public : inp.public, items: inp.items === undefined ? cur.items : inp.items, soon: inp.soon === undefined ? cur.soon : inp.soon });
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
  return { admin: !!admin, now, public: cfg.public, items, soon: cfg.soon };
}

// ---------- кнопка «Игра» у человека рядом со строкой ввода ----------
// Есть только у тех, кто уже выбрал «мини-курс» или «материалы», и только когда админ открыл аппку для всех.
export const appTrack = (t) => (t === 'course' ? 'mini' : t === 'mat' ? 'mat' : null);
export const MENU_TEXT = 'Забрать материалы'; // у тех, кто уже выбрал трек
export const AUDIT_TEXT = 'Пройти аудит'; // у тех, кто ещё без трека: аппка покажет экран с аудитом
// инлайн-кнопка под приветствием: открывает кабинет, пока аппка включена для всех
export async function openKb(ctx, track) {
  if (!ctx.publicUrl) return {};
  const c = await loadCfg(ctx);
  return c.public ? { reply_markup: { inline_keyboard: [[{ text: appTrack(track) ? MENU_TEXT : AUDIT_TEXT, web_app: { url: ctx.publicUrl + '/app' } }]] } } : {};
}
export async function userMenu(ctx, id, cfg) {
  if (!ctx.publicUrl) return false;
  try {
    const c = cfg || (await loadCfg(ctx));
    const u = await ctx.db.first(`SELECT track FROM users WHERE tg_id = ?`, [id]);
    const on = !!c.public; // кнопка у всех: без выбранного трека аппка предложит пройти аудит
    await ctx.tg.call('setChatMenuButton', { chat_id: id, menu_button: on ? { type: 'web_app', text: appTrack(u && u.track) ? MENU_TEXT : AUDIT_TEXT, web_app: { url: ctx.publicUrl + '/app' } } : { type: 'commands' } });
    return true;
  } catch (e) { return String((e && (e.description || e.message)) || e).slice(0, 140); /* кнопка не критична: причину покажем в панели */ }
}
// всем, кто выбрал трек: вызываем, когда админ включил или выключил «Показывать всем». Идём не быстрее ~20 человек в секунду
export async function allUsersMenu(ctx) {
  const cfg = await loadCfg(ctx);
  const rows = await ctx.db.all(`SELECT tg_id FROM users WHERE status NOT IN ('blocked') LIMIT 5000`);
  let ok = 0, fail = 0, err = null;
  for (const r of rows) { const x = await userMenu(ctx, r.tg_id, cfg); if (x === true) ok++; else { fail++; err = err || (x === false ? 'в боте не задан адрес PUBLIC_URL' : x); } await new Promise((res) => setTimeout(res, 50)); }
  // итог виден в панели: сколько человек получили кнопку и у скольких не вышло
  const res = { at: Math.floor(Date.now() / 1000), on: cfg.public, ok, fail, total: rows.length, err };
  await ctx.db.run(`INSERT INTO settings (key, value) VALUES ('game_menu', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`, [JSON.stringify(res)]);
  return res;
}

// сохранить расписание; если «Показывать всем» поменялось, обновляем кнопку «Игра» у людей в фоне
export async function saveCfgAndMenu(ctx, input) {
  const before = (await loadCfg(ctx)).public;
  const r = await saveCfg(ctx, input);
  if (r.cfg && r.cfg.public !== before) allUsersMenu(ctx).catch((e) => console.error('menu users', e));
  return r;
}
