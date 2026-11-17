// Настройки оплаты, которые админ вводит в панели (Ещё → Оплата).
// Секреты лежат в базе только в зашифрованном виде: ключ шифрования берётся из BOT_TOKEN,
// которого нет ни в базе, ни в её копиях. Из панели секретные поля назад не отдаются никогда.
import { TARIFFS, seatsLeft } from './pay.js';

const KEY = 'paycfg';
const te = new TextEncoder();
const b64 = (u8) => btoa(String.fromCharCode(...u8));
const unb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
async function aesKey(env) {
  const raw = await crypto.subtle.digest('SHA-256', te.encode('di-sign-pay:' + (env.BOT_TOKEN || '')));
  return crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt']);
}
export async function seal(env, text) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await aesKey(env), te.encode(text)));
  return b64(iv) + '.' + b64(ct);
}
export async function unseal(env, s) {
  try {
    const [iv, ct] = String(s).split('.');
    return new TextDecoder().decode(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(iv) }, await aesKey(env), unb64(ct)));
  } catch { return ''; }
}

export async function loadPayCfg(ctx) {
  const r = await ctx.db.first(`SELECT value FROM settings WHERE key = ?`, [KEY]);
  try { return r ? JSON.parse(r.value) : {}; } catch { return {}; }
}
async function savePayCfg(ctx, c) {
  await ctx.db.run(`INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`, [KEY, JSON.stringify(c)]);
}

// ctx с настройками оплаты: то, что задано в панели, главнее переменных окружения сервера
export async function withPay(ctx) {
  if (ctx._payEnv) return ctx;
  const c = await loadPayCfg(ctx);
  const e = { ...ctx.env };
  if (c.shop_id) e.YK_SHOP_ID = c.shop_id;
  if (c.secret) e.YK_SECRET = await unseal(ctx.env, c.secret);
  if (c.hook) e.YK_HOOK_SECRET = c.hook;
  if (c.campus) e.CAMPUS_CHAT_ID = c.campus;
  if (c.sheet_url) e.SHEET_HOOK_URL = c.sheet_url;
  if (c.sheet_key) e.SHEET_HOOK_KEY = await unseal(ctx.env, c.sheet_key);
  if (c.pre_until) e.PAY_PRE_UNTIL = c.pre_until;
  if (c.due2) e.PAY_DUE2 = c.due2;
  if (c.invite_at) e.PAY_INVITE_AT = c.invite_at;
  if (c.start) e.PAY_START = c.start;
  return { ...ctx, env: e, _payEnv: true };
}

const DATE_RX = /^\d{4}-\d\d-\d\dT\d\d:\d\d(:\d\d)?$/;
const short = (s) => (s || '').slice(0, 16); // для поля datetime-local

export async function payPanelState(ctx) {
  const c = await loadPayCfg(ctx);
  const x = await withPay(ctx);
  const seats = {};
  for (const t of Object.keys(TARIFFS)) seats[t] = { title: TARIFFS[t].title, left: await seatsLeft(x, t), total: TARIFFS[t].seats };
  const paid = await ctx.db.first(`SELECT COUNT(*) AS n FROM users WHERE paid1_at IS NOT NULL`);
  const full = await ctx.db.first(`SELECT COUNT(*) AS n FROM users WHERE paid_full_at IS NOT NULL`);
  const e = x.env;
  return {
    shopId: e.YK_SHOP_ID || '', secretSet: !!e.YK_SECRET, mode: !e.YK_SECRET ? 'none' : String(e.YK_SECRET).startsWith('test_') ? 'test' : 'live',
    secretFrom: c.secret ? 'panel' : ctx.env.YK_SECRET ? 'server' : '',
    hookUrl: e.YK_HOOK_SECRET ? (ctx.publicUrl || '') + '/yk/' + e.YK_HOOK_SECRET : '',
    campus: e.CAMPUS_CHAT_ID || '', sheetUrl: e.SHEET_HOOK_URL || '', sheetKeySet: !!e.SHEET_HOOK_KEY,
    preUntil: short(e.PAY_PRE_UNTIL || '2026-11-18T23:59'), due2: short(e.PAY_DUE2 || '2026-12-01T23:59'),
    inviteAt: short(e.PAY_INVITE_AT || '2026-12-02T11:30'), start: short(e.PAY_START || '2026-12-03T11:30'),
    seats, paid: paid.n, full: full.n,
  };
}

export async function payPanelSave(ctx, b) {
  const c = await loadPayCfg(ctx);
  const str = (v) => String(v == null ? '' : v).trim();
  if (b.shopId !== undefined) {
    const v = str(b.shopId);
    if (v && !/^\d{3,12}$/.test(v)) return { error: 'Номер магазина — только цифры, из кабинета ЮKassa' };
    c.shop_id = v;
  }
  if (str(b.secret)) {
    const v = str(b.secret);
    if (!/^(test|live)_[\w-]{20,120}$/.test(v)) return { error: 'Секретный ключ начинается с test_ или live_ (ЮKassa → Интеграция → Ключи API)' };
    c.secret = await seal(ctx.env, v);
  }
  if (b.genHook && !c.hook) c.hook = [...crypto.getRandomValues(new Uint8Array(18))].map((x) => x.toString(16).padStart(2, '0')).join('');
  if (b.campus !== undefined) {
    const v = str(b.campus);
    if (v && !/^-?\d{5,20}$/.test(v)) return { error: 'ID чата — число, например -1001234567890' };
    c.campus = v;
  }
  if (b.sheetUrl !== undefined) {
    const v = str(b.sheetUrl);
    if (v && !/^https:\/\/script\.google\.com\/macros\/s\/[\w-]+\/exec$/.test(v)) return { error: 'Адрес таблицы должен выглядеть как https://script.google.com/macros/s/…/exec' };
    c.sheet_url = v;
  }
  if (str(b.sheetKey)) {
    const v = str(b.sheetKey);
    if (v.length < 8 || v.length > 100) return { error: 'Ключ таблицы: от 8 до 100 символов' };
    c.sheet_key = await seal(ctx.env, v);
  }
  for (const [k, f, name] of [['preUntil', 'pre_until', 'конца цены предзаписи'], ['due2', 'due2', 'второй части'], ['inviteAt', 'invite_at', 'ссылок в кампус'], ['start', 'start', 'старта']]) {
    if (b[k] === undefined) continue;
    const v = str(b[k]);
    if (v && !DATE_RX.test(v)) return { error: 'Дата ' + name + ' не распознана' };
    c[f] = v ? (v.length === 16 ? v + ':00' : v) : '';
  }
  await savePayCfg(ctx, c);
  return { ok: true, state: await payPanelState(ctx) };
}

// «Проверить подключение»: спрашиваем у ЮKassa, чей это магазин и тестовый ли он
export async function payPanelCheck(ctx) {
  const x = await withPay(ctx);
  if (!x.env.YK_SHOP_ID || !x.env.YK_SECRET) return { error: 'Сначала сохрани номер магазина и секретный ключ' };
  try {
    const r = await fetch('https://api.yookassa.ru/v3/me', { headers: { authorization: 'Basic ' + btoa(`${x.env.YK_SHOP_ID}:${x.env.YK_SECRET}`) }, signal: AbortSignal.timeout(15_000) });
    const j = await r.json().catch(() => ({}));
    if (r.status === 401) return { error: 'ЮKassa не приняла номер магазина или ключ. Проверь, что они из одного магазина' };
    if (!r.ok) return { error: 'ЮKassa ответила ошибкой ' + r.status };
    return { ok: true, test: !!j.test, status: j.status || '', fiscal: !!j.fiscalization_enabled, methods: j.payment_methods || [] };
  } catch (e) { return { error: 'ЮKassa не отвечает: ' + e.message }; }
}
