// Адаптер базы для обычного сервера (Node.js 22+). В сборку для Cloudflare не входит.
// Обычный SQLite-файл на любом сервере (Node 22+, встроенный модуль node:sqlite)
export async function nodeSqliteAdapter(file) {
  const { DatabaseSync } = await import('node:sqlite');
  const sdb = new DatabaseSync(file);
  sdb.exec('PRAGMA journal_mode=WAL');
  const norm = (params) => (params || []).map((x) => (x === undefined ? null : x));
  return {
    async all(sql, params) { return sdb.prepare(sql).all(...norm(params)); },
    async first(sql, params) { return sdb.prepare(sql).get(...norm(params)) || null; },
    async run(sql, params) { const r = sdb.prepare(sql).run(...norm(params)); return { changes: Number(r.changes) }; },
    _raw: sdb,
  };
}
