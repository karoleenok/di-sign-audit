// Страница предпросмотра файла по кнопке: показываем картинку / видео / аудио / pdf и даём скачать.
const EXT = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', gif: 'image/gif', mp4: 'video/mp4', mov: 'video/quicktime', webm: 'video/webm', mp3: 'audio/mpeg', m4a: 'audio/mp4', wav: 'audio/wav', ogg: 'audio/ogg', pdf: 'application/pdf', txt: 'text/plain', zip: 'application/zip', fig: 'application/octet-stream', psd: 'application/octet-stream' };
export function mimeOf(meta) {
  const ext = String(meta.name || '').split('.').pop().toLowerCase();
  const t = String(meta.type || '').toLowerCase();
  if (/^(image\/(jpeg|png|webp|gif)|video\/|audio\/|application\/pdf)/.test(t)) return t;
  return EXT[ext] || 'application/octet-stream';
}
// что можно безопасно показать прямо в браузере (svg и html — нет: могут исполнять скрипты)
export const kindOf = (mime) => /^image\//.test(mime) ? 'image' : /^video\//.test(mime) ? 'video' : /^audio\//.test(mime) ? 'audio' : mime === 'application/pdf' ? 'pdf' : 'other';
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const size = (n) => n >= 1048576 ? (n / 1048576).toFixed(n >= 10485760 ? 0 : 1).replace('.', ',') + ' МБ' : Math.max(1, Math.round(n / 1024)) + ' КБ';
export function filePage(meta, base) {
  const mime = mimeOf(meta), kind = kindOf(mime);
  const raw = base + '?raw=1', dl = base + '?dl=1';
  const prev = kind === 'image' ? `<img src="${raw}" alt="${esc(meta.name)}">`
    : kind === 'video' ? `<video src="${raw}" controls playsinline preload="metadata"></video>`
    : kind === 'audio' ? `<audio src="${raw}" controls preload="metadata"></audio>`
    : kind === 'pdf' ? `<iframe src="${raw}" title="${esc(meta.name)}"></iframe><a class="open" href="${raw}">Открыть на весь экран</a>`
    : `<div class="ic">📄</div><p class="muted">Для этого файла предпросмотра нет — его можно скачать.</p>`;
  return `<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(meta.name)}</title>
<style>:root{--bg:#fffbf7;--ink:#2c0d02;--soft:rgba(44,13,2,.6);--line:rgba(44,13,2,.12)}@media(prefers-color-scheme:dark){:root{--bg:#1c120d;--ink:#fff3ea;--soft:rgba(255,243,234,.6);--line:rgba(255,243,234,.15)}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:16px/1.45 -apple-system,system-ui,sans-serif}.w{max-width:720px;margin:0 auto;padding:18px 16px 110px}
h1{font-size:20px;font-weight:600;margin:0 0 4px;word-break:break-word}.muted{color:var(--soft);margin:0}.box{margin-top:16px;border:1px solid var(--line);border-radius:18px;padding:10px;text-align:center;overflow:hidden}
img,video{max-width:100%;max-height:70vh;border-radius:12px;display:block;margin:0 auto}audio{width:100%}iframe{width:100%;height:65vh;border:0;border-radius:12px;background:#fff}.ic{font-size:56px;margin:18px 0 6px}.open{display:inline-block;margin:8px 0 2px;color:var(--soft);font-size:14px}
.bar{position:fixed;left:0;right:0;bottom:0;padding:12px 16px calc(12px + env(safe-area-inset-bottom));background:linear-gradient(transparent,var(--bg) 35%)}.dl{display:block;max-width:720px;margin:0 auto;text-align:center;background:var(--ink);color:var(--bg);text-decoration:none;font-weight:600;border-radius:16px;padding:15px}</style></head>
<body><div class="w"><h1>${esc(meta.name)}</h1><p class="muted">${size(meta.size || 0)}</p><div class="box">${prev}</div></div>
<div class="bar"><a class="dl" href="${dl}" download>⬇️ Скачать</a></div></body></html>`;
}
