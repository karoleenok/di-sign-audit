// Внутренняя таблица: заявки и отзывы одним файлом .xlsx (два листа). Файл бот присылает админу в чат.
// Данные остаются на твоём сервере: никуда, кроме чата Telegram с тобой, они не уходят.
import { crc32, deflateRawSync } from 'node:zlib';
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


const esc = (s) => String(s).replace(/[&<>\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c] || ''));
const colName = (i) => String.fromCharCode(65 + i);
function sheetXml(head, rows, widths) {
  const cell = (v, r, c, st) => `<c r="${colName(c)}${r}" t="inlineStr"${st ? ' s="1"' : ''}><is><t xml:space="preserve">${esc(v)}</t></is></c>`;
  const line = (arr, r, st) => `<row r="${r}">${arr.map((v, c) => cell(v, r, c, st)).join('')}</row>`;
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">` +
    `<sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>` +
    `<cols>${widths.map((w, i) => `<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"/>`).join('')}</cols>` +
    `<sheetData>${line(head, 1, true)}${rows.map((r, i) => line(r, i + 2, false)).join('')}</sheetData></worksheet>`;
}
// zip без сторонних библиотек: имена и содержимое в UTF-8, сжатие deflate
function zip(files) {
  const enc = new TextEncoder(), parts = [], central = [];
  let off = 0;
  const u16 = (n) => [n & 255, (n >> 8) & 255], u32 = (n) => [n & 255, (n >>> 8) & 255, (n >>> 16) & 255, (n >>> 24) & 255];
  for (const [name, text] of files) {
    const nb = enc.encode(name), raw = enc.encode(text), def = deflateRawSync(raw), crc = crc32(raw);
    const head = Uint8Array.from([0x50, 0x4b, 3, 4, ...u16(20), ...u16(0x0800), ...u16(8), ...u16(0), ...u16(0x21), ...u32(crc), ...u32(def.length), ...u32(raw.length), ...u16(nb.length), ...u16(0)]);
    parts.push(head, nb, def);
    central.push(Uint8Array.from([0x50, 0x4b, 1, 2, ...u16(20), ...u16(20), ...u16(0x0800), ...u16(8), ...u16(0), ...u16(0x21), ...u32(crc), ...u32(def.length), ...u32(raw.length), ...u16(nb.length), ...u16(0), ...u16(0), ...u16(0), ...u16(0), ...u32(0), ...u32(off)]), nb);
    off += head.length + nb.length + def.length;
  }
  const cLen = central.reduce((n, p) => n + p.length, 0);
  const end = Uint8Array.from([0x50, 0x4b, 5, 6, ...u16(0), ...u16(0), ...u16(files.length), ...u16(files.length), ...u32(cLen), ...u32(off), ...u16(0)]);
  return Buffer.concat([...parts, ...central, end]);
}
export function buildXlsx(sheets) {
  const X = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';
  const files = [
    ['[Content_Types].xml', X + '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>' + sheets.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('') + '</Types>'],
    ['_rels/.rels', X + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>'],
    ['xl/workbook.xml', X + '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>' + sheets.map((s, i) => `<sheet name="${esc(s.name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('') + '</sheets></workbook>'],
    ['xl/_rels/workbook.xml.rels', X + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' + sheets.map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('') + `<Relationship Id="rId${sheets.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`],
    ['xl/styles.xml', X + '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/></cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>'],
    ...sheets.map((s, i) => [`xl/worksheets/sheet${i + 1}.xml`, sheetXml(s.head, s.rows, s.widths)]),
  ];
  return zip(files);
}

// файл для скачивания: два листа, ширина колонок под содержимое
export async function exportXlsx(db) {
  const { leads, reviews } = await sheetRows(db);
  return { leads: leads.length, reviews: reviews.length, file: buildXlsx([
    { name: 'Заявки', head: LEAD_HEAD, rows: leads, widths: [14, 17, 22, 18, 17, 24, 13, 12, 18] },
    { name: 'Отзывы', head: REVIEW_HEAD, rows: reviews, widths: [14, 17, 22, 18, 50, 50, 16] },
  ]) };
}
