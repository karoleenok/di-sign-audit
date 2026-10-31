import { AUD } from './texts.js';
import { sendPost, postSummary, postLabel, postWhen, audienceCount, loadDocs } from './posts.js';
import { parseTime, parseWhen, fmtTime, fmtWhen } from './time.js';
import { GUIDE, GUIDE_MENU } from './guide.js';
import { MSG, MSG_GROUPS, msgInfo, loadMsgs, saveMsg, resetMsg, setMsgMedia, canMedia, say as sayMsg, msg as msgText, adminCommands } from './msgs.js';
import { LEVELS } from './texts.js';

const kb = (rows) => ({ inline_keyboard: rows });
const say = (ctx, id, text, extra = {}) => ctx.tg.call('sendMessage', { chat_id: id, text, link_preview_options: { is_disabled: true }, ...extra });

// ---------- кто админ ----------
export function envAdmins(env) {
  return String(env.ADMIN_IDS || '').split(/[\s,;]+/).filter(Boolean).map(Number);
}
export async function isAdmin(ctx, id) {
  if (envAdmins(ctx.env).includes(Number(id))) return true;
  return !!(await ctx.db.first(`SELECT 1 FROM admins WHERE tg_id = ?`, [id]));
}

// ---------- состояние мастера ----------
async function getState(ctx, id) {
  const r = await ctx.db.first(`SELECT state, data FROM states WHERE tg_id = ?`, [id]);
  return r ? { state: r.state, data: r.data ? JSON.parse(r.data) : {} } : { state: null, data: {} };
}
async function setState(ctx, id, state, data) {
  await ctx.db.run(`INSERT INTO states (tg_id, state, data, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(tg_id) DO UPDATE SET state = excluded.state, data = excluded.data, updated_at = excluded.updated_at`,
    [id, state, JSON.stringify(data || {}), ctx.now]);
}
async function clearState(ctx, id) {
  await ctx.db.run(`DELETE FROM states WHERE tg_id = ?`, [id]);
  await ctx.db.run(`DELETE FROM draft_parts WHERE admin_id = ?`, [id]);
  await ctx.db.run(`DELETE FROM draft_groups WHERE admin_id = ?`, [id]);
}

const HELP =
  `Команды админа:\n` +
  `/new — новый пост (текст, картинки, альбом до 10, файлы, кнопки)\n` +
  `/posts — все посты: показать, править, пауза, отправить сейчас\n` +
  `/stats — сколько людей, уровни, нажатия\n` +
  `/admins — админы; /addadmin 123 — добавить по id; /deladmin 123 — убрать\n` +
  `/check — проверка, что бот и связь с Telegram в порядке\n` +
  `/cancel — отменить текущее действие\n\n` +
  `Виды постов:\n` +
  `• по дням — через N дней после входа человека, в выбранное время по Москве\n` +
  `• в дату — один раз в конкретные дату и время всем подходящим\n` +
  `• подарок — уходит сразу после теста (всем, начинающим или продолжающим)\n\n` +
  `Пост пиши прямо здесь, как обычное сообщение: форматирование и премиум-эмодзи сохранятся.`;

const CONTENT_PROMPT =
  `Пришли пост одним или несколькими сообщениями:\n` +
  `• текст (можно с жирным, ссылками и премиум-эмодзи)\n` +
  `• картинки, видео или файлы — можно альбомом до 10 штук; подпись к альбому станет текстом поста\n\n` +
  `Когда всё отправишь — нажми «Готово».`;
const contentKb = kb([[{ text: 'Готово ➜', callback_data: 'w:done' }], [{ text: 'Отмена', callback_data: 'w:cancel' }]]);

// ---------- команды ----------
export async function onAdminCommand(ctx, msg, cmd, arg) {
  const id = msg.from.id;
  switch (cmd) {
    case 'help': return showGuide(ctx, id, 'menu');
    case 'cancel': await clearState(ctx, id); return say(ctx, id, 'Отменено.');
    case 'new':
      await clearState(ctx, id);
      await setState(ctx, id, 'w:content', { target: 'new' });
      return say(ctx, id, CONTENT_PROMPT);
    case 'posts': return listPosts(ctx, id, false);
    case 'stats': return stats(ctx, id);
    case 'admins': return listAdmins(ctx, id);
    case 'addadmin': return addAdmin(ctx, id, arg);
    case 'deladmin': return delAdmin(ctx, id, arg);
    case 'check': return check(ctx, id);
    case 'texts': return textsMenu(ctx, id);
    case 'admin': case 'panel': return panelLink(ctx, id);
    default: return null; // не админская команда
  }
}

// ---------- сбор содержимого поста ----------
export async function onAdminMessage(ctx, msg) {
  const id = msg.from.id;
  const s = await getState(ctx, id);
  if (!s.state) return false;

  // картинка к служебному сообщению
  const mediaOf = (m) => m.photo ? { type: 'photo', file_id: m.photo[m.photo.length - 1].file_id } : m.video ? { type: 'video', file_id: m.video.file_id } : m.animation ? { type: 'animation', file_id: m.animation.file_id } : null;
  if (s.state.startsWith('e:pic:')) {
    const key = s.state.slice(6);
    const md = mediaOf(msg);
    if (!md) { await say(ctx, id, 'Пришли картинку, видео или гифку одним сообщением. Или /cancel.'); return true; }
    try {
      if (msg.caption) await saveMsg(ctx, key, msg.caption, msg.caption_entities || [], md);
      else await setMsgMedia(ctx, key, md);
    } catch (e) { await say(ctx, id, '⚠️ ' + e.message); return true; }
    await clearState(ctx, id);
    await showMsg(ctx, id, key, msg.caption ? 'Картинка и текст сохранены ✓' : 'Картинка сохранена ✓ Текст остался прежним — он стал подписью.');
    return true;
  }
  if (s.state.startsWith('e:msg:')) {
    const key = s.state.slice(6);
    const md = canMedia(key) ? mediaOf(msg) : null;
    if (md) {
      try { await saveMsg(ctx, key, msg.caption || '', msg.caption_entities || [], md); } catch (e) { await say(ctx, id, '⚠️ ' + e.message); return true; }
      await clearState(ctx, id);
      await showMsg(ctx, id, key, 'Сохранено ✓ Так это сообщение теперь увидят ученики:');
      return true;
    }
    if (!msg.text) { await say(ctx, id, 'Нужен текст одним сообщением. Или /cancel.'); return true; }
    try { await saveMsg(ctx, key, msg.text, msg.entities || []); }
    catch (e) { await say(ctx, id, '⚠️ ' + e.message + '. Пришли покороче или /cancel.'); return true; }
    await clearState(ctx, id);
    await showMsg(ctx, id, key, 'Сохранено ✓ Так это сообщение теперь увидят ученики:');
    return true;
  }

  if (s.state === 'w:content') {
    let mediaType = null, fileId = null;
    if (msg.photo) { mediaType = 'photo'; fileId = msg.photo[msg.photo.length - 1].file_id; }
    else if (msg.video) { mediaType = 'video'; fileId = msg.video.file_id; }
    else if (msg.animation) { mediaType = 'animation'; fileId = msg.animation.file_id; }
    else if (msg.document) { mediaType = 'document'; fileId = msg.document.file_id; }
    const text = msg.text || msg.caption || null;
    const ents = msg.entities || msg.caption_entities || null;
    if (!text && !fileId) { await say(ctx, id, 'Такое сообщение не поддерживается. Пришли текст, картинку, видео или файл.'); return true; }
    await ctx.db.run(`INSERT INTO draft_parts (admin_id, message_id, group_id, text, entities, media_type, file_id) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [id, msg.message_id, msg.media_group_id || null, text, ents ? JSON.stringify(ents) : null, mediaType, fileId]);
    if (msg.media_group_id) {
      const r = await ctx.db.run(`INSERT OR IGNORE INTO draft_groups (admin_id, group_id) VALUES (?, ?)`, [id, msg.media_group_id]);
      if (!r.changes) return true; // на альбом отвечаем один раз
    }
    await say(ctx, id, 'Принято ✓ Можно добавить ещё текст или картинки. Когда всё — «Готово».', { reply_markup: contentKb });
    return true;
  }

  const txt = (msg.text || '').trim();
  const d = s.data;
  if (s.state === 'w:day' || s.state.startsWith('e:day:')) {
    const n = parseInt(txt, 10);
    if (!(n >= 0 && n <= 365)) { await say(ctx, id, 'Нужно число от 0 до 365. Например: 2'); return true; }
    if (s.state === 'w:day') {
      d.post.day = n;
      await setState(ctx, id, 'w:time', d);
      await say(ctx, id, n === 0 ? 'День 0 уходит сразу после входа. Время не нужно — выберем, кому.' : 'Во сколько по Москве отправить? Например: 11:00', n === 0 ? {} : { reply_markup: kb([[{ text: '11:00', callback_data: 'w:tm:11:00' }, { text: '19:00', callback_data: 'w:tm:19:00' }]]) });
      if (n === 0) { d.post.send_time = '00:00'; await setState(ctx, id, 'w:aud', d); { await askAudience(ctx, id); return true; } }
      return true;
    }
    const pid = +s.state.split(':')[2];
    await setState(ctx, id, 'e:time:' + pid, { day: n });
    await say(ctx, id, n === 0 ? 'День 0 — сразу после входа. Напиши любое время, например 00:00' : 'Во сколько по Москве? Например: 11:00');
    return true;
  }
  if (s.state === 'w:time' || s.state.startsWith('e:time:')) {
    const t = parseTime(txt);
    if (t === null) { await say(ctx, id, 'Не понял время. Формат: 11:00'); return true; }
    if (s.state === 'w:time') { d.post.send_time = fmtTime(t); await setState(ctx, id, 'w:aud', d); await askAudience(ctx, id); return true; }
    const pid = +s.state.split(':')[2];
    await ctx.db.run(`UPDATE posts SET day = ?, send_time = ? WHERE id = ?`, [d.day, fmtTime(t), pid]);
    await clearState(ctx, id);
    { await showPost(ctx, id, pid, 'Готово ✓'); return true; }
  }
  if (s.state === 'w:when' || s.state.startsWith('e:when:')) {
    const ts = parseWhen(txt, ctx.now);
    if (!ts) { await say(ctx, id, 'Не понял дату. Примеры: 05.11 19:00 · 05.11.2026 19:00 · завтра 11:00'); return true; }
    if (ts < ctx.now - 60) { await say(ctx, id, 'Это время уже прошло. Напиши будущее время.'); return true; }
    if (s.state === 'w:when') { d.post.run_at = ts; await setState(ctx, id, 'w:aud', d); await askAudience(ctx, id); return true; }
    const pid = +s.state.split(':')[2];
    await ctx.db.run(`UPDATE posts SET run_at = ? WHERE id = ?`, [ts, pid]);
    await clearState(ctx, id);
    { await showPost(ctx, id, pid, `Отправка: ${fmtWhen(ts)} ✓`); return true; }
  }
  if (s.state === 'w:btns' || s.state.startsWith('e:btns:')) {
    const r = parseButtons(txt);
    if (r.error) { await say(ctx, id, r.error); return true; }
    const ge = await checkGo(ctx, r.rows);
    if (ge) { await say(ctx, id, ge); return true; }
    if (s.state === 'w:btns') { d.post.buttons = JSON.stringify(r.rows); await setState(ctx, id, 'w:preview', d); { await preview(ctx, id, d); return true; } }
    const pid = +s.state.split(':')[2];
    await ctx.db.run(`UPDATE posts SET buttons = ? WHERE id = ?`, [JSON.stringify(r.rows), pid]);
    await clearState(ctx, id);
    { await showPost(ctx, id, pid, 'Кнопки обновлены ✓'); return true; }
  }
  if (s.state === 'w:title') {
    d.post.title = txt.slice(0, 80);
    await setState(ctx, id, 'w:preview', d);
    { await preview(ctx, id, d); return true; }
  }
  return false;
}

// «Текст | ссылка», по строке на ряд; несколько кнопок в ряд — через ;
export function parseButtons(txt) {
  const rows = [];
  for (const line of (txt || '').split('\n').map((l) => l.trim()).filter(Boolean)) {
    const row = [];
    for (const part of line.split(';').map((x) => x.trim()).filter(Boolean)) {
      const m = /^(.+?)\s*\|\s*(\S+)$/.exec(part);
      if (!m) return { error: `Не понял строку «${part}». Формат: Текст кнопки | https://ссылка` };
      // «Текст | #12» — открыть пост №12 этого бота; «Текст | политика» — документ
      const go = /^#(\d+)$/.exec(m[2]);
      if (go) { row.push({ text: m[1].slice(0, 60), go: +go[1] }); continue; }
      const doc = { 'политика': 'policy', 'согласие': 'consent', 'оферта': 'offer' }[m[2].toLowerCase()];
      if (doc) { row.push({ text: m[1].slice(0, 60), doc }); continue; }
      let url = m[2];
      if (/^t\.me\//i.test(url)) url = 'https://' + url;
      if (!/^https?:\/\//i.test(url)) return { error: `Ссылка должна начинаться с https:// — «${m[2]}»` };
      row.push({ text: m[1].slice(0, 60), url });
    }
    if (row.length > 4) return { error: 'В одном ряду не больше 4 кнопок.' };
    if (row.length) rows.push(row);
  }
  if (!rows.length) return { error: 'Не нашёл ни одной кнопки. Формат: Текст кнопки | https://ссылка' };
  return { rows };
}

async function assemble(ctx, id) {
  const parts = await ctx.db.all(`SELECT * FROM draft_parts WHERE admin_id = ? ORDER BY message_id, id`, [id]);
  const textOnly = parts.filter((p) => !p.file_id && p.text);
  const withCap = parts.filter((p) => p.file_id && p.text);
  const src = textOnly.length ? textOnly[textOnly.length - 1] : withCap[0];
  const media = parts.filter((p) => p.file_id).map((p) => ({ type: p.media_type, file_id: p.file_id }));
  return { text: src ? src.text : '', entities: src && src.entities ? src.entities : '[]', media: JSON.stringify(media.slice(0, 10)), extra: Math.max(0, media.length - 10) };
}

async function askAudience(ctx, id) {
  return say(ctx, id, 'Кому отправлять?', { reply_markup: kb([[{ text: 'Всем', callback_data: 'w:aud:all' }], [{ text: 'Начинающим', callback_data: 'w:aud:start' }, { text: 'Продолжающим', callback_data: 'w:aud:pro' }]]) });
}

async function preview(ctx, id, d) {
  const p = { ...d.post, id: 0 };
  try {
    const r = await sendPost(ctx.tg, id, p, { docs: await loadDocs(ctx) });
    if (r.warn) await say(ctx, id, '⚠️ ' + r.warn);
  } catch (e) {
    await say(ctx, id, `⚠️ Telegram не принял пост: ${e.message}\nПроверьте: в альбоме нельзя смешивать файлы с фото/видео.`);
  }
  return say(ctx, id, `Так пост увидят ученики ☝️\n\n${postSummary({ ...p, status: 'draft', id: '—' })}`, {
    reply_markup: kb([
      [{ text: '✅ Сохранить и включить', callback_data: 'w:save:1' }],
      [{ text: '📝 Сохранить черновиком', callback_data: 'w:save:0' }],
      [{ text: '🏷 Название для списка', callback_data: 'w:ttl' }, { text: 'Отмена', callback_data: 'w:cancel' }],
    ]),
  });
}

// ---------- кнопки админки ----------
export async function onAdminCallback(ctx, cq) {
  const id = cq.from.id;
  const data = cq.data || '';
  const s = await getState(ctx, id);
  const d = s.data || {};

  if (data === 'w:cancel') { await clearState(ctx, id); return say(ctx, id, 'Отменено.'); }
  if (data === 'w:reset') {
    await ctx.db.run(`DELETE FROM draft_parts WHERE admin_id = ?`, [id]);
    await ctx.db.run(`DELETE FROM draft_groups WHERE admin_id = ?`, [id]);
    return say(ctx, id, 'Начинаем заново. ' + CONTENT_PROMPT);
  }
  if (data === 'w:done') {
    if (s.state !== 'w:content') return say(ctx, id, 'Сначала /new');
    const c = await assemble(ctx, id);
    if (!c.text && c.media === '[]') return say(ctx, id, 'Пока ничего не пришло. Пришли текст или картинку.');
    if (c.extra) await say(ctx, id, `В альбоме максимум 10 вложений — ${c.extra} лишних не войдут.`);
    if (d.target && d.target.startsWith('edit:')) {
      const pid = +d.target.split(':')[1];
      await ctx.db.run(`UPDATE posts SET text = ?, entities = ?, media = ? WHERE id = ?`, [c.text, c.entities, c.media, pid]);
      await clearState(ctx, id);
      return showPost(ctx, id, pid, 'Содержимое обновлено ✓');
    }
    d.post = { text: c.text, entities: c.entities, media: c.media, audience: 'all', catchup: 0, send_time: '11:00', buttons: null };
    await setState(ctx, id, 'w:kind', d);
    await ctx.db.run(`DELETE FROM draft_parts WHERE admin_id = ?`, [id]);
    await ctx.db.run(`DELETE FROM draft_groups WHERE admin_id = ?`, [id]);
    return say(ctx, id, 'Когда отправлять?', { reply_markup: kb([
      [{ text: '📅 Через N дней после входа', callback_data: 'w:kind:drip' }],
      [{ text: '🕒 В конкретные дату и время', callback_data: 'w:kind:date' }],
      [{ text: '🎁 Подарок после теста', callback_data: 'w:kind:gift' }],
      [{ text: '🔘 Ответ на кнопку (приходит по нажатию)', callback_data: 'w:kind:node' }],
    ]) });
  }
  if (data.startsWith('w:kind:') && d.post) {
    d.post.kind = data.slice(7);
    if (d.post.kind === 'drip') { await setState(ctx, id, 'w:day', d); return say(ctx, id, 'Через сколько дней после входа? 0 — сразу, 1 — на следующий день, 2 — через день…'); }
    if (d.post.kind === 'date') { await setState(ctx, id, 'w:when', d); return say(ctx, id, 'Когда отправить? Например: 05.11 19:00 или завтра 11:00 (время московское)'); }
    if (d.post.kind === 'node') return askButtons(ctx, id, d);
    await setState(ctx, id, 'w:aud', d);
    return askAudience(ctx, id);
  }
  if (data.startsWith('w:tm:') && d.post) { d.post.send_time = data.slice(5); await setState(ctx, id, 'w:aud', d); return askAudience(ctx, id); }
  if (data.startsWith('w:aud:') && d.post) {
    d.post.audience = data.slice(6);
    return askButtons(ctx, id, d);
  }
  if (data === 'w:nobtn' && d.post) { d.post.buttons = null; await setState(ctx, id, 'w:preview', d); return preview(ctx, id, d); }
  if (data === 'w:ttl' && d.post) { await setState(ctx, id, 'w:title', d); return say(ctx, id, 'Короткое название для списка постов (видишь только ты):'); }
  if (data.startsWith('w:save:') && d.post) {
    const on = data.endsWith(':1');
    const p = d.post;
    await ctx.db.run(
      `INSERT INTO posts (title, kind, audience, zone, day, send_time, run_at, catchup, status, text, entities, media, buttons, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [p.title || null, p.kind, p.audience, null, p.day ?? null, p.send_time || '11:00', p.run_at || null, p.catchup ? 1 : 0, on ? 'active' : 'draft', p.text, p.entities, p.media, p.buttons, id, ctx.now],
    );
    const row = await ctx.db.first(`SELECT MAX(id) AS id FROM posts WHERE created_by = ?`, [id]);
    await clearState(ctx, id);
    return showPost(ctx, id, row.id, on ? 'Сохранено и включено ✅' : 'Сохранено черновиком 📝');
  }

  if (data.startsWith('h:')) return showGuide(ctx, id, data.slice(2));
  // тексты бота
  if (data === 't:menu') return textsMenu(ctx, id);
  if (data.startsWith('t:g:')) return textsGroup(ctx, id, data.slice(4));
  if (data.startsWith('t:k:')) return showMsg(ctx, id, data.slice(4));
  if (data.startsWith('t:e:')) {
    const key = data.slice(4); const i = msgInfo(key); if (!i) return;
    await clearState(ctx, id);
    await setState(ctx, id, 'e:msg:' + key, {});
    return say(ctx, id,
      `Пришли новый текст для «${i.title}» одним сообщением.` +
      (i.button ? `\nЭто кнопка: до 64 знаков, без оформления.` : i.plain ? `\nЭто часть профиля бота: обычный текст${i.limit ? ', до ' + i.limit + ' знаков' : ''}. Применится в Telegram сразу.` : `\nЖирный, курсив, ссылки и премиум-эмодзи сохранятся. Можно прислать картинку с подписью — тогда будет картинка с этим текстом.`) +
      (i.vars.length ? `

Можно вставить подстановки: ${i.vars.map((v) => '{' + v + '}').join(' ')} — бот заменит их сам.` : '') +
      `

Текущий текст, чтобы скопировать и поправить:`,
      { reply_markup: kb([[{ text: 'Отмена', callback_data: 'w:cancel' }]]) })
      .then(async () => { const all = await loadMsgs(ctx); const o = all[key]; const cur = o ? o.text : (i.plain ? (await msgText(ctx, key)).text : i.def); await ctx.tg.call('sendMessage', { chat_id: id, text: cur || '(пусто)', ...(o && o.entities && o.entities.length ? { entities: o.entities } : {}) }).catch(() => say(ctx, id, cur || '(пусто)')); });
  }
  if (data.startsWith('t:p:')) {
    const key = data.slice(4); if (!canMedia(key)) return;
    await clearState(ctx, id);
    await setState(ctx, id, 'e:pic:' + key, {});
    return say(ctx, id, 'Пришли картинку, видео или гифку одним сообщением.\nМожно сразу с подписью — она станет новым текстом. Без подписи текст останется прежним.', { reply_markup: kb([[{ text: 'Отмена', callback_data: 'w:cancel' }]]) });
  }
  if (data.startsWith('t:x:')) { const key = data.slice(4); await setMsgMedia(ctx, key, null); return showMsg(ctx, id, key, 'Картинку убрали — остался только текст.'); }
  if (data.startsWith('t:r:')) { const key = data.slice(4); await resetMsg(ctx, key); return showMsg(ctx, id, key, 'Вернули текст по умолчанию ↩️'); }
  // список и карточка поста
  if (data === 'pl') return listPosts(ctx, id, false);
  if (data === 'pl:arch') return listPosts(ctx, id, true);
  const m = /^p:(\d+)(?::(.*))?$/.exec(data);
  if (m) return postAction(ctx, id, +m[1], m[2] || '');
  return null;
}

async function buttonsHelp(ctx) {
  const recent = await ctx.db.all(`SELECT * FROM posts WHERE status != 'archived' ORDER BY id DESC LIMIT 8`);
  return 'Пришли по строке на ряд:\n' +
    'Текст кнопки | https://ссылка\n' +
    'Текст кнопки | #12 — откроет пост №12 этого бота\n' +
    'Текст кнопки | политика — документ (ещё: согласие, оферта)\n' +
    'Несколько кнопок в ряд — через «;»' +
    (recent.length ? '\n\nПосты: ' + recent.map((p) => `#${p.id} ${postLabel(p).slice(0, 26)}`).join(' · ') : '') +
    '\n\nДерево сценария удобнее собирать в панели: /admin';
}
async function askButtons(ctx, id, d) {
  await setState(ctx, id, 'w:btns', d);
  return say(ctx, id, 'Кнопки под постом? ' + (await buttonsHelp(ctx)), { reply_markup: kb([[{ text: 'Без кнопок', callback_data: 'w:nobtn' }]]) });
}
async function checkGo(ctx, rows) {
  for (const b of rows.flat()) {
    if (!b.go) continue;
    const t = await ctx.db.first(`SELECT id FROM posts WHERE id = ? AND status != 'archived'`, [b.go]);
    if (!t) return `Поста #${b.go} нет. Номера постов видно в /posts.`;
  }
  return null;
}

// ---------- список постов ----------
async function listPosts(ctx, id, archived) {
  const rows = await ctx.db.all(
    archived ? `SELECT * FROM posts WHERE status = 'archived' ORDER BY id DESC LIMIT 60`
      : `SELECT * FROM posts WHERE status != 'archived' ORDER BY CASE kind WHEN 'gift' THEN 0 WHEN 'drip' THEN 1 WHEN 'date' THEN 2 ELSE 3 END, day, send_time, run_at, id LIMIT 90`, []);
  if (!rows.length) return say(ctx, id, archived ? 'Архив пуст.' : 'Постов пока нет. Создай первый: /new');
  const icon = { active: '✅', draft: '📝', paused: '⏸', archived: '🗄' };
  const btns = rows.map((p) => [{ text: `${icon[p.status] || ''} ${postWhen(p).replace(' · ', ' ')} — ${postLabel(p)}`.slice(0, 64), callback_data: 'p:' + p.id }]);
  btns.push(archived ? [{ text: '← Активные посты', callback_data: 'pl' }] : [{ text: '🗄 Архив', callback_data: 'pl:arch' }]);
  return say(ctx, id, archived ? 'Архив постов:' : 'Посты: ✅ включён · 📝 черновик · ⏸ пауза. Нажми, чтобы открыть.', { reply_markup: kb(btns) });
}

export async function showPost(ctx, id, pid, note) {
  const p = await ctx.db.first(`SELECT * FROM posts WHERE id = ?`, [pid]);
  if (!p) return say(ctx, id, 'Пост не найден.');
  const sent = await ctx.db.first(`SELECT COUNT(*) AS n FROM deliveries WHERE post_id = ?`, [pid]);
  const clicks = await ctx.db.first(`SELECT COUNT(*) AS n FROM clicks WHERE post_id = ?`, [pid]);
  const aud = await audienceCount(ctx.db, p);
  const text = `${note ? note + '\n\n' : ''}${p.title ? '«' + p.title + '»\n' : ''}${postSummary(p)}\nОтправлено: ${sent.n} · нажатий: ${clicks.n} · подходит сейчас: ${aud}`;
  const onOff = p.status === 'active' ? [{ text: '⏸ Пауза', callback_data: `p:${pid}:off` }] : [{ text: '▶️ Включить', callback_data: `p:${pid}:on` }];
  const rows = [
    [{ text: '👁 Показать мне', callback_data: `p:${pid}:t` }, ...onOff],
    [{ text: '✏️ Текст и картинки', callback_data: `p:${pid}:ec` }, { text: '🔘 Кнопки', callback_data: `p:${pid}:eb` }],
    [{ text: '🕒 Когда', callback_data: `p:${pid}:ew` }, { text: '👥 Кому', callback_data: `p:${pid}:ea` }],
  ];
  if (p.kind === 'date') rows.push([{ text: '🚀 Отправить сейчас', callback_data: `p:${pid}:sn` }]);
  if ((p.buttons || '').includes('"go"')) rows.push([{ text: `☑️ Кнопки-выбор: ${p.once ? 'да' : 'нет'}`, callback_data: `p:${pid}:once` }]);
  rows.push([{ text: p.status === 'archived' ? '↩️ Из архива' : '🗄 В архив', callback_data: `p:${pid}:${p.status === 'archived' ? 'un' : 'ar'}` }, { text: '← Список', callback_data: 'pl' }]);
  return say(ctx, id, text, { reply_markup: kb(rows) });
}

async function postAction(ctx, id, pid, act) {
  const p = await ctx.db.first(`SELECT * FROM posts WHERE id = ?`, [pid]);
  if (!p) return say(ctx, id, 'Пост не найден.');
  const upd = async (sql, params, note) => { await ctx.db.run(sql, [...params, pid]); return showPost(ctx, id, pid, note); };
  if (!act) return showPost(ctx, id, pid);
  if (act === 't') {
    try { const r = await sendPost(ctx.tg, id, p, { uid: id, publicUrl: ctx.publicUrl, docs: await loadDocs(ctx) }); if (r.warn) await say(ctx, id, '⚠️ ' + r.warn); }
    catch (e) { await say(ctx, id, '⚠️ Telegram не принял пост: ' + e.message); }
    return;
  }
  if (act === 'on') {
    if (p.kind === 'date' && !p.run_at) return say(ctx, id, 'Сначала задай дату: «🕒 Когда».');
    return upd(`UPDATE posts SET status = 'active' WHERE id = ?`, [], 'Включён ✅');
  }
  if (act === 'off') return upd(`UPDATE posts SET status = 'paused' WHERE id = ?`, [], 'На паузе ⏸');
  if (act === 'ar') return upd(`UPDATE posts SET status = 'archived' WHERE id = ?`, [], 'В архиве 🗄');
  if (act === 'un') return upd(`UPDATE posts SET status = 'paused' WHERE id = ?`, [], 'Вернули из архива, пост на паузе');
  if (act === 'once') return upd(`UPDATE posts SET once = 1 - once WHERE id = ?`, [], p.once ? 'Кнопки остаются после нажатия' : 'После нажатия под постом останется только выбранная кнопка с ✓');
  if (act === 'cu') return upd(`UPDATE posts SET catchup = 1 - catchup WHERE id = ?`, [], p.catchup ? 'Опоздавших не догоняем' : 'Будем догонять тех, для кого время уже прошло');
  if (act === 'ec') {
    await clearState(ctx, id);
    await setState(ctx, id, 'w:content', { target: 'edit:' + pid });
    return say(ctx, id, 'Пришли новое содержимое поста. ' + CONTENT_PROMPT);
  }
  if (act === 'eb') {
    await setState(ctx, id, 'e:btns:' + pid, {});
    return say(ctx, id, 'Кнопки заново. ' + (await buttonsHelp(ctx)), { reply_markup: kb([[{ text: 'Убрать все кнопки', callback_data: `p:${pid}:bn` }]]) });
  }
  if (act === 'bn') { await clearState(ctx, id); return upd(`UPDATE posts SET buttons = NULL WHERE id = ?`, [], 'Кнопки убраны'); }
  if (act === 'ew') {
    if (p.kind === 'drip') { await setState(ctx, id, 'e:day:' + pid, {}); return say(ctx, id, `Сейчас: ${postWhen(p)}. Через сколько дней после входа? (число)`); }
    if (p.kind === 'date') { await setState(ctx, id, 'e:when:' + pid, {}); return say(ctx, id, `Сейчас: ${postWhen(p)}. Новая дата и время, например 05.11 19:00`); }
    if (p.kind === 'node') return say(ctx, id, 'Пост-ответ приходит сразу, когда человек нажимает кнопку, которая ведёт сюда. Время для него не задаётся.');
    return say(ctx, id, 'Подарок уходит сразу после теста — время для него не задаётся. Кому он уходит — кнопка «👥 Кому».');
  }
  if (act === 'ea') return say(ctx, id, 'Кому отправлять?', { reply_markup: kb([[{ text: 'Всем', callback_data: `p:${pid}:a:all` }], [{ text: 'Начинающим', callback_data: `p:${pid}:a:start` }, { text: 'Продолжающим', callback_data: `p:${pid}:a:pro` }]]) });
  if (act.startsWith('a:')) return upd(`UPDATE posts SET audience = ? WHERE id = ?`, [act.slice(2)], 'Аудитория обновлена ✓');
  if (act === 'sn') {
    const n = await audienceCount(ctx.db, p);
    return say(ctx, id, `Отправить пост #${pid} сейчас? Подходит людей: ${n}.`, { reply_markup: kb([[{ text: '🚀 Да, отправить', callback_data: `p:${pid}:sy` }, { text: 'Нет', callback_data: `p:${pid}` }]]) });
  }
  if (act === 'sy') return upd(`UPDATE posts SET run_at = ?, status = 'active' WHERE id = ?`, [ctx.now], 'Рассылка начнётся в течение минуты 🚀');
  return showPost(ctx, id, pid);
}

// ---------- статистика ----------
async function stats(ctx, id) {
  const q = (sql, p = []) => ctx.db.first(sql, p);
  const all = await q(`SELECT COUNT(*) AS n FROM users`);
  const act = await q(`SELECT COUNT(*) AS n FROM users WHERE status = 'active'`);
  const stop = await q(`SELECT COUNT(*) AS n FROM users WHERE status = 'stopped'`);
  const blk = await q(`SELECT COUNT(*) AS n FROM users WHERE status = 'blocked'`);
  const paid = await q(`SELECT COUNT(*) AS n FROM users WHERE paid_at IS NOT NULL`);
  const wk = await q(`SELECT COUNT(*) AS n FROM users WHERE created_at >= ?`, [ctx.now - 7 * 86400]);
  const lv = await ctx.db.all(`SELECT level, COUNT(*) AS n FROM users WHERE status = 'active' GROUP BY level`);
  const src = await ctx.db.all(`SELECT CASE WHEN source LIKE 'audit_%' THEN 'тест' WHEN source IS NULL OR source = '' THEN 'без метки' ELSE source END AS s, COUNT(*) AS n FROM users GROUP BY s ORDER BY n DESC LIMIT 8`);
  const day = await q(`SELECT COUNT(*) AS n FROM deliveries WHERE sent_at >= ?`, [ctx.now - 86400]);
  const top = await ctx.db.all(`SELECT p.id, p.title, p.text, COUNT(c.id) AS n FROM clicks c JOIN posts p ON p.id = c.post_id GROUP BY p.id ORDER BY n DESC LIMIT 5`);
  const L = { start: 'начинающие', pro: 'продолжающие', null: 'не выбрали' };
  const lines = [
    `👥 Всего в боте: ${all.n} (за 7 дней: +${wk.n})`,
    `✅ Получают рассылку: ${act.n} · отписались: ${stop.n} · заблокировали бота: ${blk.n}`,
    `💳 Оплатили: ${paid.n}`,
    '',
    'Уровни (активные): ' + (lv.map((r) => `${L[r.level] || L.null} ${r.n}`).join(' · ') || '—'),
    'Прошли тест: ' + ((await ctx.db.first(`SELECT COUNT(*) AS n FROM users WHERE zone IS NOT NULL`)).n),
    'Откуда: ' + (src.map((r) => `${r.s} ${r.n}`).join(' · ') || '—'),
    '',
    `📨 Отправлено за сутки: ${day.n}`,
    'Больше всего нажатий: ' + (top.map((r) => `#${r.id} ${(r.title || r.text || '').slice(0, 20)} — ${r.n}`).join('; ') || 'пока нет'),
  ];
  return say(ctx, id, lines.join('\n'));
}

// ---------- админы ----------
async function listAdmins(ctx, id) {
  const rows = await ctx.db.all(`SELECT * FROM admins ORDER BY added_at`);
  const env = envAdmins(ctx.env);
  const lines = [
    'Главные админы (из настроек сервера): ' + (env.join(', ') || '—'),
    'Добавленные: ' + (rows.map((r) => `${r.name || ''} ${r.tg_id}`.trim()).join(', ') || '—'),
    '',
    'Чтобы добавить: человек пишет боту /id, присылает тебе число, ты отправляешь /addadmin ЧИСЛО',
  ];
  return say(ctx, id, lines.join('\n'));
}
async function addAdmin(ctx, id, arg) {
  const n = parseInt(arg, 10);
  if (!n) return say(ctx, id, 'Формат: /addadmin 123456789');
  const u = await ctx.db.first(`SELECT first_name FROM users WHERE tg_id = ?`, [n]);
  await ctx.db.run(`INSERT OR IGNORE INTO admins (tg_id, name, added_at) VALUES (?, ?, ?)`, [n, u ? u.first_name : null, ctx.now]);
  await ctx.tg.call('setMyCommands', { commands: await adminCommands(ctx), scope: { type: 'chat', chat_id: n } }).catch(() => {});
  await ctx.tg.call('sendMessage', { chat_id: n, text: 'Тебе выдали права админа бота 🐾 Команды: /help' }).catch(() => {});
  return say(ctx, id, `Готово: ${n} теперь админ.`);
}
async function delAdmin(ctx, id, arg) {
  const n = parseInt(arg, 10);
  if (!n) return say(ctx, id, 'Формат: /deladmin 123456789');
  if (envAdmins(ctx.env).includes(n)) return say(ctx, id, 'Главного админа можно убрать только в настройках сервера.');
  await ctx.db.run(`DELETE FROM admins WHERE tg_id = ?`, [n]);
  await ctx.tg.call('deleteMyCommands', { scope: { type: 'chat', chat_id: n } }).catch(() => {});
  return say(ctx, id, `Готово: ${n} больше не админ.`);
}

// ---------- проверка ----------
async function check(ctx, id) {
  const lines = [];
  try { const me = await ctx.tg.call('getMe'); lines.push(`✅ Связь с Telegram есть: @${me.username}`); } catch (e) { lines.push('❌ Нет связи с Telegram: ' + e.message); }
  try {
    const w = await ctx.tg.call('getWebhookInfo');
    lines.push(w.url ? `✅ Вебхук: ${w.url}` : '❌ Вебхук не установлен — открой адрес /setup');
    if (w.pending_update_count) lines.push(`⏳ В очереди сообщений: ${w.pending_update_count}`);
    if (w.last_error_message) lines.push(`⚠️ Последняя ошибка Telegram: ${w.last_error_message}`);
  } catch {}
  const u = await ctx.db.first(`SELECT COUNT(*) AS n FROM users`);
  const p = await ctx.db.first(`SELECT COUNT(*) AS n FROM posts WHERE status = 'active'`);
  lines.push(`✅ База отвечает: людей ${u.n}, включённых постов ${p.n}`);
  const last = await ctx.db.first(`SELECT value FROM settings WHERE key = 'last_tick'`);
  lines.push(last ? `✅ Расписание работает, последний запуск ${fmtWhen(+last.value)}` : '❌ Расписание ещё ни разу не запускалось');
  lines.push(`Сервер: ${ctx.env.HOST_NAME || 'cloudflare'} · мост к Telegram: ${ctx.env.TG_API_ROOT ? 'включён' : 'не нужен'}`);
  return say(ctx, id, lines.join('\n'));
}

// ---------- памятка ----------
export async function showGuide(ctx, id, key) {
  const text = GUIDE[key] || GUIDE.menu;
  const rows = key === 'menu' || !GUIDE[key]
    ? [...(ctx.publicUrl ? [[{ text: '🗂 Открыть панель', web_app: { url: ctx.publicUrl + '/admin' } }]] : []), ...GUIDE_MENU.map(([k, t]) => [{ text: t, callback_data: 'h:' + k }])]
    : (() => {
        const i = GUIDE_MENU.findIndex(([k]) => k === key);
        const next = GUIDE_MENU[i + 1];
        const r = [];
        if (next) r.push([{ text: 'Дальше: ' + next[1], callback_data: 'h:' + next[0] }]);
        r.push([{ text: '← Все разделы', callback_data: 'h:menu' }]);
        return r;
      })();
  return say(ctx, id, text, { parse_mode: 'HTML', reply_markup: kb(rows) });
}

// ---------- тексты бота ----------
const sampleVars = (ctx, id) => ({
  имя: 'Каролина', уровень: LEVELS.start,
  политика: ctx.env.POLICY_URL || '— ссылка появится перед запуском —',
  согласие: ctx.env.CONSENT_URL || '— ссылка появится перед запуском —',
  оферта: ctx.env.OFFER_URL || '— скоро —', владелец: ctx.env.OWNER_INFO || '',
});

export async function textsMenu(ctx, id) {
  const all = await loadMsgs(ctx);
  const rows = MSG_GROUPS.map(([g, t]) => {
    const n = Object.keys(MSG).filter((k) => MSG[k][0] === g && all[k]).length;
    return [{ text: t + (n ? ` · изменено ${n}` : ''), callback_data: 't:g:' + g }];
  });
  if (ctx.publicUrl) rows.push([{ text: '🗂 Открыть панель (удобнее)', web_app: { url: ctx.publicUrl + '/admin' } }]);
  return say(ctx, id, 'Тексты бота. Выбери, что поменять — покажу, как сообщение видят ученики, и можно прислать новый вариант (с премиум-эмодзи).', { reply_markup: kb(rows) });
}
async function textsGroup(ctx, id, g) {
  const all = await loadMsgs(ctx);
  const rows = Object.keys(MSG).filter((k) => MSG[k][0] === g).map((k) => [{ text: (all[k] ? '✎ ' : '') + MSG[k][1], callback_data: 't:k:' + k }]);
  rows.push([{ text: '← Все группы', callback_data: 't:menu' }]);
  const t = (MSG_GROUPS.find(([x]) => x === g) || [, ''])[1];
  return say(ctx, id, `${t}\n✎ — уже изменено`, { reply_markup: kb(rows) });
}
async function showMsg(ctx, id, key, note) {
  const i = msgInfo(key); if (!i) return;
  const all = await loadMsgs(ctx);
  await say(ctx, id, `${note ? note + '\n\n' : ''}«${i.title}»${i.button ? ' — это кнопка' : ''}${all[key] ? ' · изменено' : ' · по умолчанию'}\n${i.group === 'profile' ? 'Сейчас в Telegram так 👇' : 'Ученик видит так 👇'}`);
  await sayMsg(ctx, id, key, sampleVars(ctx, id));
  const rows = [[{ text: '✏️ Изменить', callback_data: 't:e:' + key }]];
  if (canMedia(key)) rows.push(all[key] && all[key].media
    ? [{ text: '🖼 Заменить картинку', callback_data: 't:p:' + key }, { text: '✖️ Убрать картинку', callback_data: 't:x:' + key }]
    : [{ text: '🖼 Добавить картинку', callback_data: 't:p:' + key }]);
  if (all[key]) rows.push([{ text: '↩️ Вернуть как было', callback_data: 't:r:' + key }]);
  rows.push([{ text: '← Назад', callback_data: 't:g:' + i.group }]);
  return say(ctx, id, i.vars.length ? `Подстановки: ${i.vars.map((v) => '{' + v + '}').join(' ')} (в примере — образец)` : 'Что дальше?', { reply_markup: kb(rows) });
}

// ---------- панель ----------
export async function panelLink(ctx, id) {
  if (!ctx.publicUrl) return say(ctx, id, 'Панель откроется, когда у бота будет адрес в интернете.');
  return say(ctx, id, 'Панель: лента постов по дням (можно перетаскивать), даты, подарки и все тексты бота.', {
    reply_markup: kb([[{ text: '🗂 Открыть панель', web_app: { url: ctx.publicUrl + '/admin' } }]]),
  });
}
