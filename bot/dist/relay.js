// src/relay.js
var relay_default = {
  async fetch(request, env) {
    if (!env.RELAY_KEY || request.headers.get("x-relay-key") !== env.RELAY_KEY) return new Response("forbidden", { status: 403 });
    const url = new URL(request.url);
    if (!/^\/bot\d+:[\w-]+\/\w+$/.test(url.pathname)) return new Response("bad path", { status: 400 });
    const res = await fetch("https://api.telegram.org" + url.pathname, {
      method: "POST",
      headers: { "content-type": request.headers.get("content-type") || "application/json" },
      body: await request.arrayBuffer()
    });
    return new Response(res.body, { status: res.status, headers: { "content-type": "application/json" } });
  }
};
export {
  relay_default as default
};
