// Превращает src/panel.html в модуль src/panel-html.js (чтобы панель была внутри одного файла бота)
import { readFileSync, writeFileSync } from 'node:fs';
const html = readFileSync(new URL('../src/panel.html', import.meta.url), 'utf8');
writeFileSync(new URL('../src/panel-html.js', import.meta.url), '// Сгенерировано из panel.html — правь panel.html\nexport default ' + JSON.stringify(html) + ';\n');
console.log('панель собрана', html.length);
