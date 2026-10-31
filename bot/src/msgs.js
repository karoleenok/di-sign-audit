// Все сообщения бота для учеников — в одном месте.
// Админ может поменять любое (в боте через /texts или в панели), правка хранится в базе
// (settings: 'msg:<ключ>' -> {text, entities}). Здесь — тексты «по умолчанию».
// В тексте можно использовать подстановки в фигурных скобках, например {имя}.
import { USER_COMMANDS, ADMIN_COMMANDS } from './texts.js';
import { sendPost, loadDocs } from './posts.js';

export const MSG_GROUPS = [
  ['hello', '👋 Приветствие'],
  ['consent', '✅ Согласие на данные'],
  ['level', '🎚 Уровень'],
  ['test', '🧪 Аудит-тест и подарок'],
  ['ads', '📬 Согласие на рассылку'],
  ['contact', '📇 Имя и контакт'],
  ['fb', '💬 Отзыв о кабинете'],
  ['track', '🎓 Мини-курс или материалы'],
  ['cmd', '⚙️ Команды ученика'],
  ['profile', '🤖 Профиль бота и меню команд'],
];

// key: [группа, название для админа, текст по умолчанию, подстановки, это кнопка?]
export const MSG = {
  hello: ['hello', 'Приветствие (пришёл без теста)',
    'Привет, {имя}! Это бот Di Sign University 🐾\n\nЗдесь будут полезные материалы для дизайнеров и новости об обучении.', ['имя']],
  helloTest: ['hello', 'Приветствие (пришёл из теста)',
    'Привет, {имя}! Вижу, аудит пройден 🐾\nПодарок по итогам теста уже готов.', ['имя']],

  consentPd: ['consent', 'Просьба о согласии на обработку данных',
    'Чтобы присылать материалы, нам нужно твоё согласие на обработку персональных данных: имя, ник и id в Telegram, телефон или почта (если оставишь), ответы на вопросы бота и отзывы.\n\nПолитика обработки данных: {политика}\nТекст согласия: {согласие}', ['политика', 'согласие']],
  consentPdBtn: ['consent', 'Кнопка согласия', 'Даю согласие', [], true],
  consentThanks: ['consent', 'Всплывающее «спасибо» после согласия', 'Спасибо! ✅', []],

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
  adsYes: ['ads', 'Ответ на «да» (если вход уже пройден)', 'Готово! Материалы будут приходить сюда ✨', []],

  askName: ['contact', 'Как обращаться',
    'Как к тебе обращаться? Сейчас: {имя}.\n\nЕсли верно — жми кнопку. Если нет — напиши имя сообщением.', ['имя']],
  nameOk: ['contact', 'Кнопка «имя верно»', 'Всё верно', [], true],
  askContact: ['contact', 'Как связаться',
    'Как с тобой связаться, если понадобится? Например, чтобы напомнить про старт потока или ответить на вопрос. Выбери удобный способ 👇', []],
  contactTg: ['contact', 'Кнопка «пишите в Telegram»', 'Пишите в Telegram', [], true],
  contactPhone: ['contact', 'Кнопка «телефон»', '📱 Оставить телефон', [], true],
  contactEmail: ['contact', 'Кнопка «почта»', '✉️ Оставить почту', [], true],
  askPhone: ['contact', 'Просьба отправить телефон', 'Нажми кнопку «Отправить телефон» внизу экрана 👇 Или напиши номер сообщением.', []],
  phoneBtn: ['contact', 'Кнопка внизу «Отправить телефон»', 'Отправить телефон', [], true],
  askEmail: ['contact', 'Просьба написать почту', 'Напиши почту одним сообщением 👇', []],
  badEmail: ['contact', 'Если почта с ошибкой', 'Кажется, в почте ошибка. Пример: name@mail.ru', []],
  badPhone: ['contact', 'Если телефон с ошибкой', 'Кажется, в номере ошибка. Пример: +7 900 123-45-67', []],
  contactSaved: ['contact', 'Контакт записан (всплывашка)', 'Записали ✓', []],

  fbOffer: ['fb', 'Предложение оставить отзыв',
    'Хочешь помочь нам сделать личный кабинет лучше? 🐾\n\nПосмотри прототип и ответь на 2 коротких вопроса — за это пришлём секретный урок.\n\nПрототип кабинета: {кабинет}', ['кабинет']],
  fbYes: ['fb', 'Кнопка «ответить»', 'Ответить на 2 вопроса', [], true],
  fbNo: ['fb', 'Кнопка «пропустить»', 'Пропустить', [], true],
  fbQ1: ['fb', 'Вопрос 1', 'Что в кабинете понравилось больше всего?', []],
  fbQ2: ['fb', 'Вопрос 2', 'А что хотелось бы улучшить или добавить?', []],
  fbThanks: ['fb', 'Спасибо за отзыв', 'Спасибо! Это правда помогает нам 🐾 Лови бонус 👇', []],
  fbNoBonus: ['fb', 'Если бонус ещё не загружен', 'Бонус скоро появится здесь 🎁', []],

  askTrack: ['track', 'Мини-курс или материалы', 'Что тебе ближе?', []],
  trackCourse: ['track', 'Кнопка «мини-курс»', 'Бесплатный мини-курс', [], true],
  trackMat: ['track', 'Кнопка «материалы»', 'Полезные материалы', [], true],
  schedCourse: ['track', 'Расписание мини-курса (последний шаг входа)',
    'Готово, ты в списке предзаписи 🐾\n\nМини-курс приходит сюда, в бот: 12 материалов за неделю — по уроку каждый день в 11:00.\n\n1–3 · Добро пожаловать в мир дизайна\n4–6 · Уверенно сразу к делу\n7–9 · Повяжите бантик и готово\n10–12 · Сикрет-бокс\n\nПервый урок — совсем скоро.', []],
  schedMat: ['track', 'Расписание материалов (последний шаг входа)',
    'Готово, ты в списке предзаписи 🐾\n\nПолезные материалы приходят сюда, в бот: гайды, чек-листы и шаблоны — новый материал каждые пару дней в 11:00, от шрифтов до продаж.\n\nПервый — совсем скоро.', []],
  adsNo: ['ads', 'Ответ на «нет»', 'Хорошо, рассылки не будет. Если передумаешь — /start.', []],
  buttonsArrow: ['ads', 'Подпись над кнопками под альбомом', '👇', []],

  stopped: ['cmd', '/stop — отписка', 'Рассылка отключена. Вернуться: /start.', []],
  policy: ['cmd', '/policy — документы', 'Политика обработки данных: {политика}\nОферта: {оферта}\n{владелец}', ['политика', 'оферта', 'владелец']],
  deleteAsk: ['cmd', '/delete — вопрос', 'Удалить все твои данные из бота? Рассылка остановится, отменить это нельзя.', []],
  deleteYes: ['cmd', '/delete — кнопка «удалить»', 'Удалить', [], true],
  deleteNo: ['cmd', '/delete — кнопка «отмена»', 'Отмена', [], true],
  deleted: ['cmd', '/delete — данные удалены', 'Данные удалены. Спасибо, что были с нами 🐾', []],
  deleteCancel: ['cmd', '/delete — отмена (всплывающее)', 'Ок, ничего не удаляем.', []],
  needStart: ['cmd', 'Если человек не нажал /start', 'Нажми /start 🐾', []],
  payLater: ['cmd', 'Кнопка «оплатить», пока оплата не подключена (всплывашка)', 'Оплата откроется в день продаж — анонс придёт сюда, в бот 🐾', []],
  unknown: ['cmd', 'Ответ на непонятное сообщение',
    'Я бот с материалами 🐾 Команды: /level — сменить уровень, /stop — отписаться, /policy — документы, /delete — удалить данные.', []],

  // профиль бота: применяются в Telegram сразу после сохранения
  botDesc: ['profile', 'Описание до кнопки «Старт» (что умеет бот)', '', []],
  botShort: ['profile', 'Короткое описание в профиле бота', '', []],
  ...Object.fromEntries(USER_COMMANDS.map((c) => ['cmd_' + c.command, ['profile', 'Меню команд: /' + c.command, c.description, []]])),
};

// Ограничения Telegram для профиля
const PROFILE_LIMIT = { botDesc: 512, botShort: 120 };
const isProfile = (key) => MSG[key] && MSG[key][0] === 'profile';
const limitOf = (key) => PROFILE_LIMIT[key] || (key.startsWith('cmd_') ? 256 : null);

export const msgInfo = (key) => {
  const m = MSG[key];
  // {имя} можно вставить в любое сообщение (кроме кнопок)
  if (!m) return null;
  const plain = !!m[4] || m[0] === 'profile';
  return { key, group: m[0], title: m[1], def: m[2], vars: plain ? m[3] : [...new Set(['имя', ...m[3]])], button: !!m[4], plain, limit: m[4] ? 64 : limitOf(key) };
};

// Все правки из базы — одним запросом на обновление
export async function loadMsgs(ctx) {
  if (ctx._msgs) return ctx._msgs;
  const rows = await ctx.db.all(`SELECT key, value FROM settings WHERE key LIKE 'msg:%' OR key LIKE 'msgx:%'`);
  const o = {}, x = {};
  for (const r of rows) {
    try {
      if (r.key.startsWith('msgx:')) x[r.key.slice(5)] = JSON.parse(r.value);
      else o[r.key.slice(4)] = JSON.parse(r.value);
    } catch {}
  }
  ctx._msgs = o; ctx._msgx = x;
  return o;
}

// ---------- пауза перед сообщением и кнопки-ссылки (отдельно от текста) ----------
// Сколько секунд бот «печатает» перед служебным сообщением
export const DEFAULT_DELAY = { hello: 0.6, helloTest: 0.6, consentPd: 0.9, askLevel: 0.7, testOffer: 0.8, noGift: 0.8, consentAds: 1.0, adsYes: 0.5, adsNo: 0.5, levelChanged: 0.5, askName: 0.7, askContact: 0.7, askPhone: 0.4, askEmail: 0.4, fbOffer: 0.9, fbQ1: 0.5, fbQ2: 0.6, fbThanks: 0.6, askTrack: 0.7, schedCourse: 0.9, schedMat: 0.9 };
async function extraOf(ctx, key) { await loadMsgs(ctx); return (ctx._msgx && ctx._msgx[key]) || {}; }
export async function delayOf(ctx, key) {
  const x = await extraOf(ctx, key);
  return typeof x.delay === 'number' ? x.delay : (DEFAULT_DELAY[key] ?? 0.7);
}
export async function linksOf(ctx, key) { return (await extraOf(ctx, key)).links || []; }
// кнопки-ссылки: [[{text, url}]], до 4 в ряд; ошибки — понятным текстом
export function cleanRows(rows) {
  if (!Array.isArray(rows) || rows.length > 10) throw new Error('Слишком много рядов (до 10)');
  const out = [];
  for (const row of rows) {
    if (!Array.isArray(row)) throw new Error('Неверные кнопки');
    const r = [];
    for (const b of row) {
      const text = String((b && b.text) || '').trim().slice(0, 60);
      let link = String((b && b.url) || '').trim();
      if (!text && !link) continue;
      if (!text) throw new Error('У кнопки нет текста');
      if (/^t\.me\//i.test(link)) link = 'https://' + link;
      if (!/^https?:\/\/\S+$/i.test(link)) throw new Error(`Ссылка у кнопки «${text}» должна начинаться с https://`);
      r.push({ text, url: link });
    }
    if (r.length > 4) throw new Error('В одном ряду не больше 4 кнопок');
    if (r.length) out.push(r);
  }
  return out;
}
export async function saveMsgExtra(ctx, key, { delay, links, post } = {}) {
  const i = msgInfo(key);
  if (!i || i.button || i.plain) throw new Error('Для этого сообщения пауза и кнопки не настраиваются');
  const x = { ...(await extraOf(ctx, key)) };
  if (delay !== undefined) {
    const d = Number(delay);
    if (!(d >= 0 && d <= 30)) throw new Error('Пауза — от 0 до 30 секунд');
    x.delay = Math.round(d * 10) / 10;
  }
  if (links !== undefined) x.links = cleanRows(links);
  if (post !== undefined) {
    if (post === null || post === '' || post === 0) delete x.post;
    else {
      const row = await ctx.db.first(`SELECT id FROM posts WHERE id = ? AND status != 'archived'`, [Number(post)]);
      if (!row) throw new Error('Такого поста нет');
      x.post = row.id;
    }
  }
  await ctx.db.run(`INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`, ['msgx:' + key, JSON.stringify(x)]);
  if (ctx._msgx) ctx._msgx[key] = x;
  return x;
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
  // строка вида «Политика: {политика}», где ссылку убрали (она ушла в кнопку), — удаляем целиком
  if (hits.some((h) => h[2] === '')) {
    let pos = 0;
    for (const line of t.split('\n')) {
      const end = pos + line.length + 1; // вместе с переносом
      if (line.trim() && /^[^{}]*:\s*$/.test(line) && hits.some((h) => h[2] === '')) {
        const len = Math.min(end, t.length) - pos;
        t = t.slice(0, pos) + t.slice(pos + len);
        ents = ents.filter((e) => !(e.offset >= pos && e.offset < pos + len)).map((e) => (e.offset >= pos + len ? { ...e, offset: e.offset - len } : e));
        continue;
      }
      pos = end;
    }
    const cut = t.length - t.trimEnd().length;
    if (cut) { t = t.trimEnd(); ents = ents.map((e) => ({ ...e, length: Math.min(e.length, t.length - e.offset) })); }
  }
  return { text: t, entities: ents.filter((e) => e.length > 0) };
}

// Готовое сообщение: {text, entities}
export async function msg(ctx, key, vars) {
  const all = await loadMsgs(ctx);
  const o = all[key];
  if (isProfile(key) && !(o && o.text)) return { text: await liveProfile(ctx, key), entities: [] };
  const base = o && (o.text || o.media) ? o : { text: MSG[key] ? MSG[key][2] : key, entities: [] };
  const out = fill(base.text || '', base.entities, { имя: ctx.userName || 'друг', ...(vars || {}) });
  if (base.media && base.media.file_id) out.media = base.media;
  return out;
}
export async function btn(ctx, key, vars) {
  return (await msg(ctx, key, vars)).text.slice(0, 64);
}

// Отправить сообщение по ключу. Если премиум-эмодзи не прошли — отправим без них.
const j0 = (s) => { try { return s ? JSON.parse(s) : []; } catch { return []; } };
const MEDIA_METHOD = { photo: 'sendPhoto', video: 'sendVideo', animation: 'sendAnimation' };
const CAPTION_MAX = 1024;
// повторить без премиум-эмодзи, если Telegram их не принял
async function withEmojiFallback(send, ents) {
  try { return await send(ents); } catch (e) {
    if (e.code === 400 && (ents || []).some((x) => x.type === 'custom_emoji')) return send(ents.filter((x) => x.type !== 'custom_emoji'));
    throw e;
  }
}
export async function say(ctx, chatId, key, vars, extra = {}) {
  // вместо шаблона — свой пост из ленты; встроенные кнопки шага встают под кнопками поста
  const pid = (await extraOf(ctx, key)).post;
  if (pid) {
    const p = await ctx.db.first(`SELECT * FROM posts WHERE id = ? AND status != 'archived'`, [pid]);
    if (p) {
      const f = fill(p.text || '', j0(p.entities), { имя: ctx.userName || 'друг', ...(vars || {}) });
      const own = [...(((extra.reply_markup && extra.reply_markup.inline_keyboard) || [])), ...(await linksOf(ctx, key))];
      const rm = extra.reply_markup;
      if (rm && !rm.inline_keyboard) {
        // обычная клавиатура (например «поделиться телефоном») — шлём отдельным коротким сообщением
        await sendPost(ctx.tg, chatId, { ...p, text: f.text, entities: JSON.stringify(f.entities) }, { uid: chatId, publicUrl: ctx.publicUrl, docs: await loadDocs(ctx) });
        return ctx.tg.call('sendMessage', { chat_id: chatId, text: '👇', reply_markup: rm });
      }
      return sendPost(ctx.tg, chatId, { ...p, text: f.text, entities: JSON.stringify(f.entities) }, { uid: chatId, publicUrl: ctx.publicUrl, docs: await loadDocs(ctx), extraRows: own });
    }
  }
  const m = await msg(ctx, key, vars);
  // свои кнопки-ссылки — под встроенными
  const links = await linksOf(ctx, key);
  if (links.length) extra = { ...extra, reply_markup: { inline_keyboard: [...((extra.reply_markup && extra.reply_markup.inline_keyboard) || []), ...links] } };
  const ents = m.entities.length ? m.entities : undefined;
  if (m.media) {
    // с картинкой: текст становится подписью; если он длиннее 1024 знаков — отдельным сообщением следом
    const { link_preview_options, reply_markup, ...rest } = extra;
    const method = MEDIA_METHOD[m.media.type] || 'sendPhoto';
    const field = MEDIA_METHOD[m.media.type] ? m.media.type : 'photo';
    const fits = (m.text || '').length <= CAPTION_MAX;
    const first = await withEmojiFallback((e) => ctx.tg.call(method, { chat_id: chatId, [field]: m.media.file_id, ...rest,
      ...(fits && m.text ? { caption: m.text, ...(e && e.length ? { caption_entities: e } : {}) } : {}), ...(fits && reply_markup ? { reply_markup } : {}) }), ents);
    if (fits) return first;
    const second = await withEmojiFallback((e) => ctx.tg.call('sendMessage', { chat_id: chatId, text: m.text, ...(e && e.length ? { entities: e } : {}), ...extra }), ents);
    return { ...second, also: [first.message_id] };
  }
  return withEmojiFallback((e) => ctx.tg.call('sendMessage', { chat_id: chatId, text: m.text || '…', ...extra, ...(e && e.length ? { entities: e } : {}) }), ents);
}

export async function saveMsg(ctx, key, text, entities, media) {
  const info = msgInfo(key);
  if (!info) throw new Error('нет такого сообщения');
  let v;
  if (info.button) v = { text: String(text).replace(/\s+/g, ' ').trim().slice(0, 64), entities: [] };
  else if (info.plain) {
    const t = String(text).trim();
    if (info.limit && t.length > info.limit) throw new Error(`Telegram разрешает до ${info.limit} знаков, сейчас ${t.length}`);
    if (key.startsWith('cmd_') && t.length < 3) throw new Error('Подпись команды — хотя бы 3 знака');
    v = { text: t, entities: [] };
  } else v = { text: String(text), entities: entities || [] };
  // картинка: undefined — оставить как была, null — убрать
  if (!info.plain && !info.button) {
    const prev = (await loadMsgs(ctx))[key];
    const md = media === undefined ? prev && prev.media : media;
    if (md) v.media = md;
    if ((v.text || '').length > 4000) throw new Error('Слишком длинно для Telegram');
  }
  if (isProfile(key)) await rememberOriginal(ctx, key);
  await ctx.db.run(`INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`, ['msg:' + key, JSON.stringify(v)]);
  if (ctx._msgs) ctx._msgs[key] = v;
  if (isProfile(key)) await applyProfile(ctx, key);
  return v;
}
// Поставить / убрать картинку, текст оставить как есть
export async function setMsgMedia(ctx, key, media) {
  const info = msgInfo(key);
  if (!info || info.button || info.plain) throw new Error('К этому сообщению картинку не прикрепить');
  const o = (await loadMsgs(ctx))[key];
  return saveMsg(ctx, key, o ? o.text : info.def, o ? o.entities : [], media || null);
}
export const canMedia = (key) => { const i = msgInfo(key); return !!(i && !i.button && !i.plain); };

export async function resetMsg(ctx, key) {
  await ctx.db.run(`DELETE FROM settings WHERE key = ?`, ['msg:' + key]);
  if (ctx._msgs) delete ctx._msgs[key];
  if (isProfile(key)) await applyProfile(ctx, key);
}

// ---------- профиль бота в Telegram ----------
// Текущее описание (как задано в BotFather или нами)
async function liveProfile(ctx, key) {
  try {
    if (key === 'botDesc') return (await ctx.tg.call('getMyDescription', {})).description || '';
    if (key === 'botShort') return (await ctx.tg.call('getMyShortDescription', {})).short_description || '';
  } catch {}
  return MSG[key] ? MSG[key][2] : '';
}
// Перед первой правкой запоминаем то, что было в BotFather, — чтобы «вернуть как было» вернуло именно это
async function rememberOriginal(ctx, key) {
  if (key !== 'botDesc' && key !== 'botShort') return;
  const has = await ctx.db.first(`SELECT 1 FROM settings WHERE key = ?`, ['orig:' + key]);
  if (has) return;
  const all = await loadMsgs(ctx);
  if (all[key]) return;
  await ctx.db.run(`INSERT INTO settings (key, value) VALUES (?, ?)`, ['orig:' + key, await liveProfile(ctx, key)]);
}
async function profileText(ctx, key) {
  const all = await loadMsgs(ctx);
  if (all[key] && all[key].text) return all[key].text;
  const o = await ctx.db.first(`SELECT value FROM settings WHERE key = ?`, ['orig:' + key]);
  return o ? o.value : (MSG[key] ? MSG[key][2] : '');
}
export async function userCommands(ctx) {
  const all = await loadMsgs(ctx);
  return USER_COMMANDS.map((c) => ({ command: c.command, description: (all['cmd_' + c.command] && all['cmd_' + c.command].text) || c.description }));
}
export async function adminCommands(ctx) {
  const userSet = new Set(USER_COMMANDS.map((c) => c.command));
  return [...ADMIN_COMMANDS.filter((c) => !userSet.has(c.command)), ...(await userCommands(ctx))];
}
export async function applyProfile(ctx, key) {
  if (key === 'botDesc') return ctx.tg.call('setMyDescription', { description: await profileText(ctx, key) });
  if (key === 'botShort') return ctx.tg.call('setMyShortDescription', { short_description: await profileText(ctx, key) });
  if (key.startsWith('cmd_')) {
    await ctx.tg.call('setMyCommands', { commands: await userCommands(ctx) });
    const env = String(ctx.env.ADMIN_IDS || '').split(/[\s,;]+/).filter(Boolean).map(Number);
    const extra = (await ctx.db.all(`SELECT tg_id FROM admins`)).map((r) => r.tg_id);
    const ac = await adminCommands(ctx);
    for (const a of new Set([...env, ...extra])) await ctx.tg.call('setMyCommands', { commands: ac, scope: { type: 'chat', chat_id: a } }).catch(() => {});
  }
}

// Для панели: всё о сообщениях
export async function listMsgs(ctx) {
  const all = await loadMsgs(ctx);
  return Promise.all(Object.keys(MSG).map((k) => {
    const i = msgInfo(k);
    const o = all[k];
    const x = (ctx._msgx && ctx._msgx[k]) || {};
    return { ...i, delay: typeof x.delay === 'number' ? x.delay : (DEFAULT_DELAY[k] ?? 0.7), defDelay: DEFAULT_DELAY[k] ?? 0.7, links: x.links || [], post: x.post || null, text: o ? o.text : i.def, changed: !!o, media: o && o.media ? o.media.type : null, canMedia: !i.button && !i.plain, emoji: !!(o && (o.entities || []).some((e) => e.type === 'custom_emoji')) };
  }).map(async (m) => (m.group === 'profile' && !m.changed && (m.key === 'botDesc' || m.key === 'botShort') ? { ...m, text: await liveProfile(ctx, m.key), def: '(как задано в BotFather)' } : m)));
}
