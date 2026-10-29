// Вход для Cloudflare Workers. Вся логика — в core.js.
import { d1Adapter } from './db.js';
import { makeCtx, handleUpdate, tick, setup, clickRedirect, exportAll } from './core.js';
import { ensureSchema } from './schema.js';
import { handlePanelApi } from './panel-api.js';
import PANEL from './panel-html.js';

const html = (body, status = 200) => new Response(`<!doctype html><meta charset="utf-8"><body style="font:16px system-ui;padding:24px;max-width:640px">${body}</body>`, { status, headers: { 'content-type': 'text/html; charset=utf-8' } });

export default {
  async fetch(request, env, execCtx) {
    const url = new URL(request.url);
    const db = d1Adapter(env.DB);
    const ctx = makeCtx({ db, env, publicUrl: url.origin });
    if (url.pathname === '/tg' || url.pathname.startsWith('/api/')) await ensureSchema(db);

    // панель админа (открывается кнопкой из бота) и её API
    if (url.pathname === '/admin' || url.pathname === '/admin/') return new Response(PANEL, { headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' } });
    if (url.pathname.startsWith('/api/panel/')) return handlePanelApi(ctx, request, url);

    if (url.pathname === '/tg' && request.method === 'POST') {
      if (env.WEBHOOK_SECRET && request.headers.get('x-telegram-bot-api-secret-token') !== env.WEBHOOK_SECRET) return new Response('forbidden', { status: 403 });
      const upd = await request.json().catch(() => null);
      if (upd) {
        // отвечаем Telegram сразу, а сообщения бот досылает следом (с паузами «печатает…»)
        const job = handleUpdate(ctx, upd).catch((e) => console.log('update error', e && e.stack));
        if (execCtx && execCtx.waitUntil) execCtx.waitUntil(job); else await job;
      }
      return new Response('ok');
    }
    if (url.pathname === '/setup') {
      if (!env.SETUP_KEY || url.searchParams.get('key') !== env.SETUP_KEY) return html('Нужен правильный ключ: /setup?key=…', 403);
      try {
        const out = await setup(ctx, { webhookUrl: url.origin + '/tg' });
        return html('<h2>Готово 🐾</h2><ul>' + out.map((x) => `<li>${x}</li>`).join('') + '</ul><p>Теперь напиши боту /start, а затем /check.</p>');
      } catch (e) { return html('<h2>Ошибка</h2><p>' + String(e.message) + '</p>', 500); }
    }
    if (url.pathname === '/export') {
      if (!env.SETUP_KEY || url.searchParams.get('key') !== env.SETUP_KEY) return html('Нужен правильный ключ', 403);
      const data = await exportAll(db);
      return new Response(JSON.stringify(data), { headers: { 'content-type': 'application/json', 'content-disposition': `attachment; filename="bot-backup-${new Date().toISOString().slice(0, 10)}.json"` } });
    }
    // страница аудит-теста: берём файл из репозитория на GitHub и отдаём как обычную страницу
    if (url.pathname === '/test' || url.pathname === '/test/') {
      const src = env.TEST_SRC || 'https://raw.githubusercontent.com/karoleenok/di-sign-audit/main/index.html';
      const res = await fetch(src, { cf: { cacheTtl: 300, cacheEverything: true } });
      return new Response(await res.text(), { status: res.ok ? 200 : 502, headers: { 'content-type': 'text/html; charset=utf-8' } });
    }
    const r = /^\/r\/(\d+)\/(\d+-\d+)\/(\d+)$/.exec(url.pathname);
    if (r) {
      const to = await clickRedirect(ctx, +r[1], r[2], r[3]).catch(() => null);
      return to ? Response.redirect(to, 302) : new Response('not found', { status: 404 });
    }
    return html('Di Sign University bot 🐾');
  },

  async scheduled(event, env, execCtx) {
    const ctx = makeCtx({ db: d1Adapter(env.DB), env });
    await ensureSchema(ctx.db);
    // бесплатный Cloudflare: до 50 внешних запросов и до 50 запросов к базе за запуск — берём с запасом
    await tick(ctx, Number(env.TICK_BUDGET) || 30, Number(env.QUERY_BUDGET) || 40);
  },
};
