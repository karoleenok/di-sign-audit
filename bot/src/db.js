// Тонкий слой над базой. Всё остальное в боте пользуется только этими тремя функциями,
// поэтому переезд = заменить адаптер.
//   all(sql, params)   -> массив строк
//   first(sql, params) -> одна строка или null
//   run(sql, params)   -> { changes }

// Cloudflare D1
export function d1Adapter(d1) {
  const prep = (sql, params) => d1.prepare(sql).bind(...(params || []));
  return {
    async all(sql, params) { const r = await prep(sql, params).all(); return r.results || []; },
    async first(sql, params) { return (await prep(sql, params).first()) || null; },
    async run(sql, params) { const r = await prep(sql, params).run(); return { changes: (r.meta && r.meta.changes) || 0 }; },
  };
}
