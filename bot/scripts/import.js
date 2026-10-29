// Загрузить выгрузку в базу на новом сервере:
//   node scripts/import.js bot-backup.json            (база по умолчанию ./data/bot.db)
//   DB_FILE=/path/bot.db node scripts/import.js bot-backup.json
import fs from 'node:fs';
import path from 'node:path';
import { nodeSqliteAdapter } from '../src/db-node.js';
import { importAll } from '../src/core.js';

const src = process.argv[2];
if (!src) { console.log('Укажите файл: node scripts/import.js bot-backup.json'); process.exit(1); }
const file = process.env.DB_FILE || './data/bot.db';
fs.mkdirSync(path.dirname(file), { recursive: true });
const db = await nodeSqliteAdapter(file);
const counts = await importAll(db, JSON.parse(fs.readFileSync(src, 'utf8')));
console.log('Загружено в', file);
for (const [t, n] of Object.entries(counts)) console.log(' ', t, n);
