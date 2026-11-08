// Галерея «примеры работ» на экране результата теста.
// Список лежит в таблице settings (ключ gallery), картинки — на диске сервера рядом с базой (папка gallery),
// а не в репозитории: автообновление из GitHub их не трогает. Править может только админ.
export const STYLES = ['br', 'sw', 'rf', 'ad', 'mm', 'nw', 'bh', 'jp'];
export const MAX_PER_STYLE = 12;
export const MAX_IMG = 600 * 1024; // после сжатия в аппке выходит ~150 КБ, 600 — запас
const KEY = 'gallery';
const IMG_NAME = /^[a-z0-9-]{1,40}\.(webp|jpg)$/;
const str = (v, n) => String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, n);

// что угодно из базы или из запроса -> только допустимые поля
export function clean(raw) {
  const out = {};
  const src = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  for (const k of STYLES) {
    if (!Array.isArray(src[k])) continue;
    const list = src[k].slice(0, MAX_PER_STYLE).map(cleanItem).filter(Boolean);
    if (list.length) out[k] = list;
  }
  return out;
}
export function cleanItem(x) {
  if (!x || typeof x !== 'object') return null;
  const a = str(x.a, 80);
  if (!a) return null; // без автора работа не показывается
  const it = { a };
  const t = str(x.t, 120), y = str(x.y, 20);
  let u = str(x.u, 500);
  if (/^(www\.)?t\.me\//i.test(u)) u = 'https://' + u.replace(/^www\./i, '');
  if (t) it.t = t;
  if (y) it.y = y;
  if (/^https:\/\/[^\s<>"']+$/i.test(u)) it.u = u;
  if (typeof x.i === 'string' && IMG_NAME.test(x.i)) it.i = x.i;
  return it;
}

export async function loadGallery(ctx, seed) {
  const r = await ctx.db.first(`SELECT value FROM settings WHERE key = ?`, [KEY]);
  if (!r) return clean(seed);
  try { return clean(JSON.parse(r.value)); } catch { return clean(seed); }
}
export async function saveGallery(ctx, data) {
  await ctx.db.run(`INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`, [KEY, JSON.stringify(data)]);
}

// картинка приходит base64 (можно с префиксом data:). Смотрим не на заявленный тип, а на первые байты файла.
export function parseImage(b64) {
  const s = String(b64 || '').replace(/^data:[^,]*,/, '');
  if (!/^[A-Za-z0-9+/=\s]+$/.test(s) || s.length < 100) return { error: 'Не получилось прочитать картинку' };
  const buf = Buffer.from(s, 'base64');
  if (buf.length > MAX_IMG) return { error: 'Картинка тяжелее 600 КБ, попробуй другую' };
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return { buf, ext: 'jpg' };
  if (buf.length > 12 && buf.toString('latin1', 0, 4) === 'RIFF' && buf.toString('latin1', 8, 12) === 'WEBP') return { buf, ext: 'webp' };
  return { error: 'Нужна картинка JPG или WebP' };
}

// ops: add / edit / del / move. Возвращает { data, drop } (drop — имя файла, который можно удалить с диска) или { error }
export function applyOp(data, op, imgName) {
  const o = op && typeof op === 'object' ? op : {};
  if (!STYLES.includes(o.style)) return { error: 'Не понял, для какого стиля' };
  const cur = { ...data }, list = (cur[o.style] || []).slice();
  if (o.op === 'add') {
    if (list.length >= MAX_PER_STYLE) return { error: `В стиле уже ${MAX_PER_STYLE} работ, убери одну` };
    const it = cleanItem({ ...o, i: imgName });
    if (!it) return { error: 'Нужно имя автора' };
    list.push(it); cur[o.style] = list;
    return { data: cur };
  }
  const idx = Number(o.idx);
  if (!Number.isInteger(idx) || idx < 0 || idx >= list.length) return { error: 'Такой работы уже нет, обнови список' };
  if (o.op === 'del') {
    const drop = list[idx].i || null;
    list.splice(idx, 1);
    if (list.length) cur[o.style] = list; else delete cur[o.style];
    return { data: cur, drop };
  }
  if (o.op === 'edit') {
    const it = cleanItem({ ...o, i: list[idx].i });
    if (!it) return { error: 'Нужно имя автора' };
    list[idx] = it; cur[o.style] = list;
    return { data: cur };
  }
  if (o.op === 'move') {
    const to = idx + (Number(o.dir) < 0 ? -1 : 1);
    if (to < 0 || to >= list.length) return { data: cur };
    [list[idx], list[to]] = [list[to], list[idx]]; cur[o.style] = list;
    return { data: cur };
  }
  return { error: 'Неизвестное действие' };
}
