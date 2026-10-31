// Клиент Telegram Bot API. Адрес API можно заменить на «мост» (TG_API_ROOT),
// если с сервера в России api.telegram.org не открывается.
//
// Мостов может быть несколько: TG_API_ROOT="https://a.workers.dev,https://b.vercel.app",
// TG_RELAY_KEY="ключ_a,ключ_b" (если ключ один — он общий). Бот держится за тот, что отвечает,
// а при обрыве или долгом ответе переходит на следующий.
const SLOW_MS = 6000;
const sticky = new Map(); // список мостов -> номер текущего
export function makeTg({ token, root, fetchFn, relayKey }) {
  const roots = String(root || 'https://api.telegram.org').split(',').map((s) => s.trim().replace(/\/$/, '')).filter(Boolean);
  const keys = String(relayKey || '').split(',').map((s) => s.trim());
  const id = roots.join(',');
  const keyOf = (i) => (keys.length > 1 ? keys[i] : keys[0]) || '';
  const f = fetchFn || ((...a) => fetch(...a));
  // выполняет запрос через текущий мост, при сбое — через следующий
  async function viaRoots(path, mk, isPoll) {
    const n = roots.length;
    let last;
    for (let a = 0; a < n; a++) {
      const i = ((sticky.get(id) || 0) + a) % n;
      const t0 = Date.now();
      try {
        const res = await f(`${roots[i]}${path}`, mk(keyOf(i)));
        if (n > 1 && !isPoll && Date.now() - t0 > SLOW_MS) sticky.set(id, (i + 1) % n);
        else if (a) sticky.set(id, i);
        return res;
      } catch (e) {
        last = e;
        if (n > 1) sticky.set(id, (i + 1) % n);
      }
    }
    throw last;
  }
  const tg = {
    calls: 0,
    async call(method, params) {
      tg.calls++;
      const res = await viaRoots(`/bot${token}/${method}`, (key) => ({
        method: 'POST',
        headers: key ? { 'content-type': 'application/json', 'x-relay-key': key } : { 'content-type': 'application/json' },
        body: JSON.stringify(params || {}),
      }), method === 'getUpdates');
      let j;
      try { j = await res.json(); } catch { j = { ok: false, error_code: res.status, description: 'bad response' }; }
      if (!j.ok) {
        const e = new Error(j.description || 'telegram error');
        e.code = j.error_code;
        e.retryAfter = j.parameters && j.parameters.retry_after;
        throw e;
      }
      return j.result;
    },
    // загрузка файла (картинка из панели): multipart вместо JSON
    async upload(method, form) {
      tg.calls++;
      const res = await viaRoots(`/bot${token}/${method}`, (key) => ({ method: 'POST', headers: key ? { 'x-relay-key': key } : {}, body: form }));
      const j = await res.json().catch(() => ({ ok: false, description: 'bad response' }));
      if (!j.ok) { const e = new Error(j.description || 'telegram error'); e.code = j.error_code; throw e; }
      return j.result;
    },
    // скачать файл по file_id (превью картинки в панели)
    async download(fileId) {
      const file = await tg.call('getFile', { file_id: fileId });
      return viaRoots(`/file/bot${token}/${file.file_path}`, (key) => ({ headers: key ? { 'x-relay-key': key } : {} }));
    },
  };
  return tg;
}
