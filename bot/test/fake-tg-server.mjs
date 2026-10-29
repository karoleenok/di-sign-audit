// Фейковый Telegram для проверки собранного бота в настоящей среде Cloudflare (workerd)
import http from 'node:http';
import fs from 'node:fs';
let n = 1000;
const log = [];
http.createServer(async (req, res) => {
  let b = ''; for await (const c of req) b += c;
  const method = req.url.split('/').pop();
  log.push({ method, body: JSON.parse(b || '{}') });
  fs.writeFileSync(process.argv[2], JSON.stringify(log, null, 1));
  const result = method === 'getMe' ? { username: 'di_sign_university_bot' } : method === 'sendMediaGroup' ? [{ message_id: ++n }] : method === 'getWebhookInfo' ? { url: 'x' } : { message_id: ++n };
  res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ ok: true, result }));
}).listen(8799, () => console.log('fake tg on 8799'));
