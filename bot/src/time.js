// Всё время в боте — московское (UTC+3, без перехода на летнее).
export const MSK = 3 * 3600;
export const DAY = 86400;
export const nowSec = () => Math.floor(Date.now() / 1000);

// "11:00" -> секунды от полуночи или null
export function parseTime(s) {
  const m = /^\s*(\d{1,2})[:.](\d{2})\s*$/.exec(s || '');
  if (!m) return null;
  const h = +m[1], mi = +m[2];
  if (h > 23 || mi > 59) return null;
  return h * 3600 + mi * 60;
}
export const fmtTime = (sec) => `${String(Math.floor(sec / 3600)).padStart(2, '0')}:${String(Math.floor((sec % 3600) / 60)).padStart(2, '0')}`;

// "29.10 19:00", "29.10.2026 19:00", "сегодня 19:00", "завтра 11:00" -> unix или null
export function parseWhen(s, now = nowSec()) {
  const str = (s || '').trim().toLowerCase();
  const mskNow = new Date((now + MSK) * 1000);
  let y = mskNow.getUTCFullYear(), mo = mskNow.getUTCMonth() + 1, d = mskNow.getUTCDate(), rest = str, yearGiven = false;
  let m = /^(сегодня|завтра)\s+(.+)$/.exec(str);
  if (m) {
    if (m[1] === 'завтра') { const t = new Date(Date.UTC(y, mo - 1, d + 1)); y = t.getUTCFullYear(); mo = t.getUTCMonth() + 1; d = t.getUTCDate(); }
    rest = m[2];
  } else {
    m = /^(\d{1,2})\.(\d{1,2})(?:\.(\d{2,4}))?\s+(.+)$/.exec(str);
    if (!m) return null;
    d = +m[1]; mo = +m[2];
    if (m[3]) { y = +m[3] < 100 ? 2000 + +m[3] : +m[3]; yearGiven = true; }
    rest = m[4];
  }
  const t = parseTime(rest);
  if (t === null || mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  let ts = Date.UTC(y, mo - 1, d) / 1000 + t - MSK;
  if (!yearGiven && ts < now - DAY) ts = Date.UTC(y + 1, mo - 1, d) / 1000 + t - MSK;
  return ts;
}

export function fmtWhen(ts) {
  const x = new Date((ts + MSK) * 1000);
  const p = (n) => String(n).padStart(2, '0');
  return `${p(x.getUTCDate())}.${p(x.getUTCMonth() + 1)}.${x.getUTCFullYear()} ${p(x.getUTCHours())}:${p(x.getUTCMinutes())}`;
}

// Полночь по Москве для дня, в который был момент ts
export const mskMidnight = (ts) => Math.floor((ts + MSK) / DAY) * DAY - MSK;
