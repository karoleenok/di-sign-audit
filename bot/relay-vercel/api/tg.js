// «Мост» к Telegram на Vercel (запасной к Cloudflare). Ничего не хранит:
// передаёт запрос бота в Telegram и ответ обратно. Ключ — переменная RELAY_KEY.
export const config = { runtime: 'edge', regions: ['fra1', 'arn1'] };

export default async function handler(request) {
  const key = process.env.RELAY_KEY;
  if (!key || request.headers.get('x-relay-key') !== key) return new Response('forbidden', { status: 403 });
  const p = new URL(request.url).searchParams.get('p') || '';
  if (!/^bot\d+:[\w-]+\/\w+$/.test(p)) return new Response('bad path', { status: 400 });
  const res = await fetch('https://api.telegram.org/' + p, {
    method: 'POST',
    headers: { 'content-type': request.headers.get('content-type') || 'application/json' },
    body: await request.arrayBuffer(),
  });
  return new Response(res.body, { status: res.status, headers: { 'content-type': 'application/json' } });
}
