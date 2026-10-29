// Все тексты бота для учеников. Меняются здесь, код трогать не нужно.
// {name} подставляется автоматически.

export const ZONES = {
  B: 'Визуальная база',
  P: 'Портфолио',
  V: 'Видимость',
  S: 'Цена и продажа',
  C: 'Работа с клиентом',
  I: 'Внутренние блоки',
  T: 'Скорость: Figma и ИИ',
  top: 'Явных утечек нет',
};
export const LEVELS = { start: 'начинающий', pro: 'продолжающий' };
export const AUD = { all: 'всем', start: 'начинающим', pro: 'продолжающим' };

export const T = {
  hello: (name) =>
    `Привет${name ? ', ' + name : ''}! Это бот Di Sign University 🐾\n\n` +
    `Здесь будут полезные материалы для дизайнеров и новости об обучении.`,
  helloFromTest: (name, zone) =>
    `Привет${name ? ', ' + name : ''}! Вижу, аудит пройден 🐾\n` +
    (zone && zone !== 'top' ? `Главная зона роста — «${ZONES[zone]}». Подарок под неё уже готов.` : `Явных утечек нет, и подарок для тебя уже готов.`),

  consentPd: (policyUrl, consentUrl) =>
    `Чтобы присылать материалы, нам нужно твоё согласие на обработку персональных данных ` +
    `(имя и id в Telegram, ответы на вопросы бота).\n\n` +
    `Политика обработки данных: ${policyUrl || '— ссылка появится перед запуском —'}\n` +
    `Текст согласия: ${consentUrl || '— ссылка появится перед запуском —'}`,
  consentPdBtn: 'Даю согласие',
  consentPdNo: 'Без согласия мы не сможем присылать материалы. Если передумаешь — нажми /start.',

  askLevel: 'Где ты сейчас в дизайне?',
  levelBtnStart: 'Начинаю, хочу зайти в дизайн',
  levelBtnPro: 'Уже есть знания и заказы',

  testOffer: (hasUrl) =>
    `У нас есть аудит-тест для дизайнеров 🐾\n\n` +
    `Он покажет твои сильные и слабые стороны и сразу после прохождения соберёт план: что прокачать в первую очередь.\n\n` +
    `В конце теста нажми «Забрать материал» — вернёшься сюда, и бот пришлёт подарок под твой результат.` +
    (hasUrl ? '' : `\n\nСсылка на тест появится здесь совсем скоро.`),
  testBtn: 'Пройти тест',

  noGift: 'Подарок скоро появится здесь 🎁',

  consentAds:
    `Хочешь получать полезные материалы по расписанию и новости об обучении Di Sign University?\n\n` +
    `Это рекламная рассылка. Отписаться можно в любой момент командой /stop.`,
  consentAdsYes: 'Да, присылай',
  consentAdsNo: 'Нет, спасибо',
  adsYes: 'Готово! Материалы будут приходить сюда ✨',
  adsNo: 'Хорошо, рассылки не будет. Если передумаешь — /start.',

  stopped: 'Рассылка отключена. Вернуться: /start.',
  levelChanged: (lv) => `Готово, уровень: ${LEVELS[lv]}. Материалы будут приходить под него.`,
  deleteAsk: 'Удалить все твои данные из бота? Рассылка остановится, отменить это нельзя.',
  deleteYes: 'Удалить',
  deleteNo: 'Отмена',
  deleted: 'Данные удалены. Спасибо, что были с нами 🐾',
  policy: (policyUrl, offerUrl, owner) =>
    `Политика обработки данных: ${policyUrl || '— скоро —'}\nОферта: ${offerUrl || '— скоро —'}\n${owner || ''}`.trim(),
  unknown: 'Я бот с материалами 🐾 Команды: /level — сменить уровень, /stop — отписаться, /policy — документы, /delete — удалить данные.',
  buttonsArrow: '👇',
};

// Команды в меню Telegram (только латиница — так требует Telegram)
export const USER_COMMANDS = [
  { command: 'start', description: 'Начать' },
  { command: 'level', description: 'Сменить уровень' },
  { command: 'stop', description: 'Отписаться от рассылки' },
  { command: 'policy', description: 'Документы' },
  { command: 'delete', description: 'Удалить мои данные' },
];
export const ADMIN_COMMANDS = [
  { command: 'admin', description: 'Панель: лента, порядок, тексты' },
  { command: 'new', description: 'Новый пост' },
  { command: 'texts', description: 'Тексты бота' },
  { command: 'posts', description: 'Все посты' },
  { command: 'stats', description: 'Статистика' },
  { command: 'admins', description: 'Админы' },
  { command: 'check', description: 'Проверка бота' },
  { command: 'cancel', description: 'Отменить действие' },
  { command: 'help', description: 'Помощь для админа' },
  ...USER_COMMANDS,
];
