// Google Таблицы: принимает записи об оплатах от бота и добавляет строки на лист «Платежи».
// Вставить в Расширения → Apps Script, заменить СЕКРЕТ, развернуть как веб-приложение (доступ: все).
const KEY = 'СЕКРЕТ';
const HEAD = ['Дата (МСК)', 'ID платежа', 'Имя', 'Ник', 'Telegram ID', 'Телефон', 'Почта', 'Тариф', 'Часть', 'Сумма', 'Цена тарифа'];

function doPost(e) {
  try {
    const d = JSON.parse(e.postData.contents);
    if (d.key !== KEY) return ContentService.createTextOutput('no key');
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const sh = ss.getSheetByName('Платежи') || ss.insertSheet('Платежи');
    if (sh.getLastRow() === 0) { sh.appendRow(HEAD); sh.setFrozenRows(1); sh.getRange(1, 1, 1, HEAD.length).setFontWeight('bold'); }
    // тот же платёж второй раз не записываем
    const hit = sh.getRange(1, 2, sh.getLastRow(), 1).createTextFinder(d.payment_id).matchEntireCell(true).findNext();
    if (!hit) {
      const r = sh.getLastRow() + 1;
      sh.getRange(r, 1, 1, 11).setNumberFormats([['@', '@', '@', '@', '@', '@', '@', '@', '@', '0', '0']])
        .setValues([[d.date, d.payment_id, d.name, d.username, d.tg_id, d.phone, d.email, d.tariff, d.part, d.amount, d.total]]);
    }
    return ContentService.createTextOutput('ok');
  } catch (err) {
    return ContentService.createTextOutput('error ' + err);
  }
}
