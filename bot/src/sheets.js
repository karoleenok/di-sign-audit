// Выгрузка заявок и отзывов в Google-таблицу через Apps Script (бесплатно, без ключей Google Cloud).
// Таблица принимает данные скриптом-приёмником (см. scriptFor): он находит строку по Telegram ID
// и обновляет только колонки бота, а твои заметки справа не трогает.
const MSK3 = 3 * 3600;
const fmt = (t) => {
  if (!t) return '';
  const d = new Date((t + MSK3) * 1000);
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getUTCDate())}.${p(d.getUTCMonth() + 1)}.${d.getUTCFullYear()} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`;
};
const TRACK = { course: 'мини-курс', mat: 'материалы' };
export const LEAD_HEAD = ['Telegram ID', 'Дата заявки', 'Имя', 'Ник', 'Телефон', 'Почта', 'Трек', 'Зона', 'Откуда'];
export const REVIEW_HEAD = ['Telegram ID', 'Дата отзыва', 'Имя', 'Ник', 'Что понравилось', 'Что улучшить', 'Бонус отправлен'];

async function getSet(db, key) { const r = await db.first(`SELECT value FROM settings WHERE key = ?`, [key]); return r ? r.value : ''; }
async function putSet(db, key, value) { await db.run(`INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`, [key, value]); }

export async function sheetsConfig(db) {
  let key = await getSet(db, 'sheets:key');
  if (!key) { key = [...crypto.getRandomValues(new Uint8Array(16))].map((b) => b.toString(16).padStart(2, '0')).join(''); await putSet(db, 'sheets:key', key); }
  let last = null; try { last = JSON.parse(await getSet(db, 'sheets:last') || 'null'); } catch { last = null; }
  return { url: await getSet(db, 'sheets:url'), doc: await getSet(db, 'sheets:doc'), key, last };
}
export async function saveSheetsUrl(db, url) { await putSet(db, 'sheets:url', url); }
export async function saveSheetsDoc(db, doc) { await putSet(db, 'sheets:doc', doc); }
export const validDocUrl = (u) => /^https:\/\/docs\.google\.com\/spreadsheets\/d\/[A-Za-z0-9_-]+/.test(String(u || '').trim());
export const validSheetsUrl = (u) => /^https:\/\/script\.google\.com\/macros\/s\/[A-Za-z0-9_-]+\/exec$/.test(String(u || '').trim());

// строки для таблицы: заявки (только принятые) и отзывы
export async function sheetRows(db) {
  const us = await db.all(
    `SELECT u.tg_id, u.first_name, u.username, u.contact_name, u.phone, u.email, u.track, u.zone, u.fb_like, u.fb_improve, u.fb_at,
            (SELECT MAX(created_at) FROM leads l WHERE l.tg_id = u.tg_id AND l.done = 1) AS lead_at,
            (SELECT source FROM leads l WHERE l.tg_id = u.tg_id AND l.done = 1 ORDER BY id DESC LIMIT 1) AS lead_src,
            (SELECT COUNT(*) FROM deliveries d JOIN posts p ON p.id = d.post_id WHERE p.kind = 'fb' AND d.ok = 1 AND d.tg_id = u.tg_id) AS bonus
       FROM users u
      WHERE u.fb_at IS NOT NULL OR EXISTS (SELECT 1 FROM leads l WHERE l.tg_id = u.tg_id AND l.done = 1)
      ORDER BY u.tg_id`);
  const name = (u) => u.contact_name || u.first_name || '';
  const nick = (u) => (u.username ? '@' + u.username : '');
  const leads = us.filter((u) => u.lead_at).map((u) => [String(u.tg_id), fmt(u.lead_at), name(u), nick(u), u.phone || '', u.email || '', TRACK[u.track] || '', u.zone || '', u.lead_src || '']);
  const reviews = us.filter((u) => u.fb_at).map((u) => [String(u.tg_id), fmt(u.fb_at), name(u), nick(u), u.fb_like || '', u.fb_improve || '', u.bonus ? 'да' : 'нет']);
  return { leads, reviews };
}

// отправить всё в таблицу; результат запоминаем, чтобы панель показала «когда и получилось ли»
export async function pushSheets(ctx) {
  const cfg = await sheetsConfig(ctx.db);
  if (!cfg.url) return { ok: false, error: 'Таблица не подключена' };
  const { leads, reviews } = await sheetRows(ctx.db);
  let res;
  try {
    const r = await fetch(cfg.url, { method: 'POST', redirect: 'follow', headers: { 'content-type': 'text/plain;charset=utf-8' }, body: JSON.stringify({ key: cfg.key, leadHead: LEAD_HEAD, reviewHead: REVIEW_HEAD, leads, reviews }), signal: AbortSignal.timeout(25000) });
    const txt = await r.text();
    let j = null; try { j = JSON.parse(txt); } catch { j = null; }
    if (!r.ok || !j) res = { ok: false, error: r.status === 200 ? 'Таблица ответила не так, как ждали: проверь, что скрипт выложен для «Все» и это самая новая версия' : 'Таблица не ответила (код ' + r.status + ')' };
    else if (!j.ok) res = { ok: false, error: j.error === 'key' ? 'Не совпал ключ: в Apps Script выбери функцию resetKey, нажми «Выполнить» и повтори выгрузку' : String(j.error || 'ошибка в скрипте').slice(0, 200) };
    else res = { ok: true, leads: leads.length, reviews: reviews.length };
  } catch (e) { res = { ok: false, error: 'Не достучалась до таблицы: ' + String((e && e.message) || e).slice(0, 120) }; }
  await putSet(ctx.db, 'sheets:last', JSON.stringify({ at: ctx.now, ...res }));
  return res;
}
// фоном: после новой заявки или отзыва (ошибку не показываем ученику, она видна в панели)
export function syncSoon(ctx) { return pushSheets(ctx).catch(() => {}); }

// скрипт для таблицы: вставляется в «Расширения → Apps Script»
export function scriptFor() {
  return `// Приёмник для бота Di Sign University. Вставь целиком, сохрани и выложи как веб-приложение.
// Ключ бота скрипт запоминает при первом обращении, поэтому одинаковый скрипт подходит всем.
function put_(ss, name, head, rows) {
  let sh = ss.getSheetByName(name);
  if (!sh) sh = ss.insertSheet(name);
  if (sh.getLastRow() === 0) {
    sh.getRange(1, 1, 1, head.length).setValues([head]).setFontWeight('bold');
    sh.setFrozenRows(1);
  }
  const n = head.length;
  const last = sh.getLastRow();
  const ids = last > 1 ? sh.getRange(2, 1, last - 1, 1).getValues().map((r) => String(r[0])) : [];
  const at = {};
  ids.forEach((v, i) => { at[v] = i + 2; });
  const add = [];
  rows.forEach((r) => {
    const row = at[String(r[0])];
    if (row) sh.getRange(row, 1, 1, n).setValues([r]);
    else add.push(r);
  });
  if (add.length) sh.getRange(sh.getLastRow() + 1, 1, add.length, n).setValues(add);
}
function doPost(e) {
  let d;
  try { d = JSON.parse(e.postData.contents); } catch (err) { return out_({ ok: false, error: 'json' }); }
  const props = PropertiesService.getScriptProperties();
  let k = props.getProperty('KEY');
  if (!k && d.key) { props.setProperty('KEY', d.key); k = d.key; }
  if (!k || d.key !== k) return out_({ ok: false, error: 'key' });
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  put_(ss, 'Заявки', d.leadHead, d.leads || []);
  put_(ss, 'Отзывы', d.reviewHead, d.reviews || []);
  return out_({ ok: true });
}
function resetKey() { PropertiesService.getScriptProperties().deleteProperty('KEY'); }
function out_(o) { return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON); }
`;
}
