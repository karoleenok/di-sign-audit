// Собирает один файл для вставки в Cloudflare: dist/worker.js (и dist/relay.js — мост)
import { build } from 'esbuild';
for (const [entry, out] of [['src/worker.js', 'dist/worker.js'], ['src/relay.js', 'dist/relay.js']]) {
  await build({ entryPoints: [entry], bundle: true, format: 'esm', platform: 'neutral', target: 'es2022', outfile: out, legalComments: 'none', charset: 'utf8' });
  console.log('собрано', out);
}
