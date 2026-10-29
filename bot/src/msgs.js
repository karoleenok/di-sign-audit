// Все сообщения бота для учеников — в одном месте.
// Админ может поменять любое (в боте через /texts или в панели), правка хранится в базе
// (settings: 'msg:<ключ>' -> {text, entities}). Здесь — тексты «по умолчанию».
// В тексте можно использовать подстановки в фигурных скобках, например {имя}.

export const MSG_GROUPS = [
  ['hello', '👋 Приветствие'],
  ['consent', '✅ Согласие на данные'],
  ['level', '🎚 Уровень'],
  ['test', '🧪 Аудит-тест и подарок'],
  ['ads', '📬 Согласие на рассылку'],
  ['cmd', '⚙️ Команды ученика'],
];

// key: [группа, название для админа, текст по умолчанию, подстановки, это кнопка?]
export const MSG = {
  hello: ['hello', 'Приветствие (пришёл без теста)',
    'Привет, {имя}! Это бот Di Sign University 🐾\n\nЗдесь будут полезные материалы для дизайнеров и новости об обучении.', ['имя']],
  helloTest: ['hello', 'Приветствие (пришёл из теста)',
    'Привет, {имя}! Вижу, аудит пройден 🐾\nПодарок по итогам теста уже готов.', ['имя']],

  consentPd: ['consent', 'Просьба о согласии на обработку данных',
    'Чтобы присылать материалы, нам нужно твоё согласие на обработку персональных данных (имя и id в Telegram, ответы на вопросы бота).\n\nПолитика обработки данных: {политика}\nТекст согласия: {согласие}', ['политика', 'согласие']],
  consentPdBtn: ['consent', 'Кнопка согласия', 'Даю согласие', [], true],
  consentThanks: ['consent', 'Ответ после согласия', 'Спасибо! ✅', []],

  askLevel: ['level', 'Вопрос про уровень', 'Где ты сейчас в дизайне?', []],
  levelBtnStart: ['level', 'Кнопка «начинающий»', 'Начинаю, хочу зайти в дизайн', [], true],
  levelBtnPro: ['level', 'Кнопка «продолжающий»', 'Уже есть знания и заказы', [], true],
  levelChanged: ['level', 'Ответ после смены уровня (/level)', 'Готово, уровень: {уровень}. Материалы будут приходить под него.', ['уровень']],

  testOffer: ['test', 'Предложение пройти тест',
    'У нас есть аудит-тест для дизайнеров 🐾\n\nОн покажет твои сильные и слабые стороны и сразу после прохождения соберёт план: что прокачать в первую очередь.\n\nВ конце теста нажми «Забрать материал» — вернёшься сюда, и бот пришлёт подарок под твой результат.', []],
  testBtn: ['test', 'Кнопка «Пройти тест»', 'Пройти тест', [], true],
  noGift: ['test', 'Если подарок ещё не загружен', 'Подарок скоро появится здесь 🎁', []],

  consentAds: ['ads', 'Вопрос про рассылку',
    'Хочешь получать полезные материалы по расписанию и новости об обучении Di Sign University?\n\nЭто рекламная рассылка. Отписаться можно в любой момент командой /stop.', []],
  consentAdsYes: ['ads', 'Кнопка «да»', 'Да, присылай', [], true],
  consentAdsNo: ['ads', 'Кнопка «нет»', 'Нет, спасибо', [], true],
  adsYes: ['ads', 'Ответ на «да»', 'Готово! Материалы будут приходить сюда ✨', []],
  adsNo: ['ads', 'Ответ на «нет»', 'Хорошо, рассылки не будет. Если передумаешь — /start.', []],
  buttonsArrow: ['ads', 'Подпись над кнопками под альбомом', '👇', []],

  stopped: ['cmd', '/stop — отписка', 'Рассылка отключена. Вернуться: /start.', []],
  policy: ['cmd', '/policy — документы', 'Политика обработки данных: {политика}\nОферта: {оферта}\n{владелец}', ['политика', 'оферта', 'владелец']],
  deleteAsk: ['cmd', '/delete — вопрос', 'Удалить все твои данные из бота? Рассылка остановится, отменить это нельзя.', []],
  deleteYes: ['cmd', '/delete — кнопка «удалить»', 'Удалить', [], true],
  deleteNo: ['cmd', '/delete — кнопка «отмена»', 'Отмена', [], true],
  deleted: ['cmd', '/delete — данные удалены', 'Данные удалены. Спасибо, что были с нами 🐾', []],
  deleteCancel: ['cmd', '/delete — отмена', 'Ок, ничего не удаляем.', []],
  needStart: ['cmd', 'Если человек не нажал /start', 'Нажми /start 🐾', []],
  unknown: ['cmd', 'Ответ на непонятное сообщение',
    'Я бот с материалами 🐾 Команды: /level — сменить уровень, /stop — отписаться, /policy — документы, /delete — удалить данные.', []],
};

export const msgInfo = (key) => {
  const m = MSG[key];
  // {имя} можно вставить в любое сообщение (кроме кнопок)
  return m && { key, group: m[0], title: m[1], def: m[2], vars: m[4] ? m[3] : [...new Set(['имя', ...m[3]])], button: !!m[4] };
};

// Все правки из базы — одним запросом на обновление
export async function loadMsgs(ctx) {
  if (ctx._msgs) return ctx._msgs;
  const rows = await ctx.db.all(`SELECT key, value FROM settings WHERE key LIKE 'msg:%'`);
  const o = {};
  for (const r of rows) { try { o[r.key.slice(4)] = JSON.parse(r.value); } catch {} }
  ctx._msgs = o;
  return o;
}

// Подставить {переменные}; сдвинуть оформление (жирный, премиум-эмодзи) после подстановки
export function fill(text, entities, vars) {
  let t = text;
  let ents = (entities || []).map((e) => ({ ...e }));
  const re = /\{([а-яёa-z_]+)\}/gi;
  const hits = [];
  let m;
  while ((m = re.exec(text))) if (vars && Object.prototype.hasOwnProperty.call(vars, m[1].toLowerCase())) hits.push([m.index, m[0].length, String(vars[m[1].toLowerCase()] ?? '')]);
  for (let k = hits.length - 1; k >= 0; k--) {
    const [i, len, val] = hits[k];
    const d = val.length - len;
    t = t.slice(0, i) + val + t.slice(i + len);
    ents = ents.map((e) => {
      if (e.offset >= i + len) return { ...e, offset: e.offset + d };
      if (e.offset <= i && e.offset + e.length >= i + len) return { ...e, length: e.length + d };
      return e;
    });
  }
  return { text: t, entities: ents.filter((e) => e.length > 0) };
}

// Готовое сообщение: {text, entities}
export async function msg(ctx, key, vars) {
  const all = await loadMsgs(ctx);
  const o = all[key];
  const base = o && o.text ? o : { text: MSG[key] ? MSG[key][2] : key, entities: [] };
  return fill(base.text, base.entities, { имя: ctx.userName || 'друг', ...(vars || {}) });
}
export async function btn(ctx, key, vars) {
  return (await msg(ctx, key, vars)).text.slice(0, 64);
}

// Отправить сообщение по ключу. Если премиум-эмодзи не прошли — отправим без них.
export async function say(ctx, chatId, key, vars, extra = {}) {
  const m = await msg(ctx, key, vars);
  const p = { chat_id: chatId, text: m.text || '…', ...extra };
  if (m.entities.length) p.entities = m.entities;
  try {
    return await ctx.tg.call('sendMessage', p);
  } catch (e) {
    if (e.code === 400 && p.entities) {
      p.entities = p.entities.filter((x) => x.type !== 'custom_emoji');
      if (!p.entities.length) delete p.entities;
      return ctx.tg.call('sendMessage', p);
    }
    throw e;
  }
}

export async function saveMsg(ctx, key, text, entities) {
  const info = msgInfo(key);
  if (!info) throw new Error('нет такого сообщения');
  const v = info.button ? { text: String(text).replace(/\s+/g, ' ').trim().slice(0, 64), entities: [] } : { text: String(text), entities: entities || [] };
  await ctx.db.run(`INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`, ['msg:' + key, JSON.stringify(v)]);
  if (ctx._msgs) ctx._msgs[key] = v;
  return v;
}
export async function resetMsg(ctx, key) {
  await ctx.db.run(`DELETE FROM settings WHERE key = ?`, ['msg:' + key]);
  if (ctx._msgs) delete ctx._msgs[key];
}

// Для панели: всё о сообщениях
export async function listMsgs(ctx) {
  const all = await loadMsgs(ctx);
  return Object.keys(MSG).map((k) => {
    const i = msgInfo(k);
    const o = all[k];
    return { ...i, text: o ? o.text : i.def, changed: !!o, emoji: !!(o && (o.entities || []).some((e) => e.type === 'custom_emoji')) };
  });
}
