// Превращает src/panel.html в модуль src/panel-html.js (чтобы панель была внутри одного файла бота)
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
const src = readFileSync(new URL('../src/panel.html', import.meta.url), 'utf8');
const build = createHash('sha1').update(src).digest('hex').slice(0, 8); // версия панели: по ней открытая панель понимает, что устарела
const html = src.replace('@@BUILD@@', build);
writeFileSync(new URL('../src/panel-html.js', import.meta.url), '// Сгенерировано из panel.html — правь panel.html\nexport const BUILD = ' + JSON.stringify(build) + ';\nexport default ' + JSON.stringify(html) + ';\n');
console.log('панель собрана', html.length, build);
