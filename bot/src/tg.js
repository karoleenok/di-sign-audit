// Клиент Telegram Bot API. Адрес API можно заменить на «мост» (TG_API_ROOT),
// если с сервера в России api.telegram.org не открывается.
export function makeTg({ token, root, fetchFn, relayKey }) {
  const base = (root || 'https://api.telegram.org').replace(/\/$/, '');
  const f = fetchFn || ((...a) => fetch(...a));
  const tg = {
    calls: 0,
    async call(method, params) {
      tg.calls++;
      const res = await f(`${base}/bot${token}/${method}`, {
        method: 'POST',
        headers: relayKey ? { 'content-type': 'application/json', 'x-relay-key': relayKey } : { 'content-type': 'application/json' },
        body: JSON.stringify(params || {}),
      });
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
      const res = await f(`${base}/bot${token}/${method}`, { method: 'POST', headers: relayKey ? { 'x-relay-key': relayKey } : {}, body: form });
      const j = await res.json().catch(() => ({ ok: false, description: 'bad response' }));
      if (!j.ok) { const e = new Error(j.description || 'telegram error'); e.code = j.error_code; throw e; }
      return j.result;
    },
    // скачать файл по file_id (превью картинки в панели)
    async download(fileId) {
      const file = await tg.call('getFile', { file_id: fileId });
      return f(`${base}/file/bot${token}/${file.file_path}`, { headers: relayKey ? { 'x-relay-key': relayKey } : {} });
    },
  };
  return tg;
}
