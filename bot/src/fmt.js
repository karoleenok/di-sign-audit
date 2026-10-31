// Простая разметка для текста поста в панели <-> оформление Telegram (entities).
//   **жирный**   __курсив__   ~~зачёркнутый~~   [текст](https://ссылка)
// Позиции в Telegram считаются в UTF-16 — как длина строки в JS, поэтому считаем прямо по строке.

const TAGS = [['**', 'bold'], ['__', 'italic'], ['~~', 'strikethrough']];

export function mdToEntities(src) {
  const s = String(src || '').replace(/\r\n?/g, '\n');
  let out = '';
  const ents = [];
  const open = {}; // тип -> offset в out
  let i = 0;
  while (i < s.length) {
    // ссылка [текст](url)
    if (s[i] === '[') {
      const m = /^\[([^\]\n]+)\]\((https?:\/\/[^\s)]+|t\.me\/[^\s)]+)\)/i.exec(s.slice(i));
      if (m) {
        const off = out.length;
        out += m[1];
        let url = m[2];
        if (/^t\.me\//i.test(url)) url = 'https://' + url;
        ents.push({ type: 'text_link', offset: off, length: m[1].length, url });
        i += m[0].length;
        continue;
      }
    }
    const t = TAGS.find(([mk]) => s.startsWith(mk, i));
    if (t) {
      const [mk, type] = t;
      if (open[type] === undefined) {
        // открываем, только если дальше есть закрывающая метка
        if (s.indexOf(mk, i + 2) > i + 2) { open[type] = out.length; i += 2; continue; }
      } else {
        const off = open[type];
        delete open[type];
        if (out.length > off) ents.push({ type, offset: off, length: out.length - off });
        i += 2;
        continue;
      }
    }
    out += s[i];
    i++;
  }
  ents.sort((a, b) => a.offset - b.offset || b.length - a.length);
  return { text: out, entities: ents };
}

const MD_OK = new Set(['bold', 'italic', 'strikethrough', 'text_link', 'url', 'mention', 'hashtag', 'email', 'phone_number', 'bot_command']);

// Обратно: можно ли править этот текст в панели без потерь и как он выглядит в разметке
export function entitiesToMd(text, entities) {
  const t = String(text || '');
  const ents = (entities || []).slice();
  const rich = ents.some((e) => !MD_OK.has(e.type));
  const marks = [];
  for (const e of ents) {
    if (e.type === 'bold') marks.push([e.offset, e.offset + e.length, '**', '**']);
    else if (e.type === 'italic') marks.push([e.offset, e.offset + e.length, '__', '__']);
    else if (e.type === 'strikethrough') marks.push([e.offset, e.offset + e.length, '~~', '~~']);
    else if (e.type === 'text_link') marks.push([e.offset, e.offset + e.length, '[', '](' + e.url + ')']);
  }
  const ins = {};
  const add = (pos, s, front) => { (ins[pos] = ins[pos] || []); front ? ins[pos].unshift(s) : ins[pos].push(s); };
  // закрывающие ставим раньше открывающих в одной точке
  for (const [a, b, o, c] of marks) { add(a, o, false); add(b, '\u0000' + c, true); }
  let out = '';
  for (let i = 0; i <= t.length; i++) {
    if (ins[i]) {
      const list = ins[i];
      out += list.filter((x) => x[0] === '\u0000').map((x) => x.slice(1)).join('') + list.filter((x) => x[0] !== '\u0000').join('');
    }
    if (i < t.length) out += t[i];
  }
  return { md: out, rich };
}
