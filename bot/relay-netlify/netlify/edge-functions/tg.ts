// «Мост» к Telegram на Netlify (запасной к Cloudflare). Ничего не хранит:
// передаёт запрос бота в Telegram и ответ обратно. Ключ — переменная окружения RELAY_KEY.
// Это edge-функция: она выполняется в ближайшем к серверу бота дата-центре.
declare const Netlify: { env: { get(k: string): string | undefined } };

export default async (req: Request) => {
  const key = Netlify.env.get("RELAY_KEY");
  if (!key || req.headers.get("x-relay-key") !== key) return new Response("forbidden", { status: 403 });
  const path = new URL(req.url).pathname;
  if (!/^\/bot\d+:[\w-]+\/\w+$/.test(path)) return new Response("bad path", { status: 400 });
  const res = await fetch("https://api.telegram.org" + path, {
    method: "POST",
    headers: { "content-type": req.headers.get("content-type") || "application/json" },
    body: await req.arrayBuffer(),
  });
  return new Response(res.body, { status: res.status, headers: { "content-type": "application/json" } });
};

export const config = { path: "/bot*" };
