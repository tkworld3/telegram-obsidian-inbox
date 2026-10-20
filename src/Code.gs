/**
 * telegram-obsidian-inbox
 * Send anything to a Telegram bot -> it lands as a Markdown note in your Obsidian vault on Google Drive.
 *
 * Runs entirely on Google Apps Script (free). No server, no webhook, no paid API.
 * Every minute it polls Telegram (getUpdates) and writes new messages to your vault's Inbox folder.
 *
 * Script properties (Project Settings > Script Properties)
 *   TELEGRAM_TOKEN   (required) Bot token from @BotFather
 *   INBOX_FOLDER_ID  (required) Google Drive ID of the Inbox folder inside your vault
 *   ALLOWED_CHAT_ID  (required) Your chat ID. Leave empty at first: the bot will tell you yours.
 *   TIMEZONE         (optional) e.g. "America/New_York". Default: the script's time zone.
 *   SAVE_PHOTOS      (optional) "true" to save photos. Default: photos are skipped, captions are kept.
 *   BLOCKED_EXTENSIONS (optional) Comma-separated file extensions never saved to Drive.
 *                    Default: executables, scripts, installers and macro-enabled Office files (see DEFAULT_BLOCKED).
 *
 * Never paste your token into this code. Put it in Script Properties only.
 */

const MAX_BYTES = 20 * 1024 * 1024; // Telegram bots can download files up to 20 MB

// Files that could run code on your computers after Drive syncs them. Never saved.
const DEFAULT_BLOCKED = [
  'exe', 'msi', 'bat', 'cmd', 'com', 'scr', 'pif', 'cpl', 'dll', 'sys', 'reg', 'lnk', 'url',
  'ps1', 'psm1', 'vbs', 'vbe', 'js', 'jse', 'wsf', 'wsh', 'hta', 'jar', 'sh', 'command',
  'apk', 'dmg', 'pkg', 'app', 'iso', 'img', 'msix', 'appx',
  'docm', 'xlsm', 'pptm', 'dotm', 'xltm', 'xlam'
];

function props_() {
  return PropertiesService.getScriptProperties();
}

function cfg_() {
  const p = props_();
  const token = (p.getProperty('TELEGRAM_TOKEN') || '').trim();
  const folderId = (p.getProperty('INBOX_FOLDER_ID') || '').trim();
  if (!token || !folderId) {
    throw new Error('Set TELEGRAM_TOKEN and INBOX_FOLDER_ID in Project Settings > Script Properties.');
  }
  return {
    token: token,
    folderId: folderId,
    allowed: (p.getProperty('ALLOWED_CHAT_ID') || '').trim(),
    tz: (p.getProperty('TIMEZONE') || '').trim() || Session.getScriptTimeZone(),
    savePhotos: (p.getProperty('SAVE_PHOTOS') || '').trim().toLowerCase() === 'true',
    blocked: blockedList_(p.getProperty('BLOCKED_EXTENSIONS'))
  };
}

function blockedList_(value) {
  if (value === null || value === undefined || !String(value).trim()) return DEFAULT_BLOCKED;
  return String(value).split(',').map(function (s) { return s.trim().toLowerCase().replace(/^\./, ''); }).filter(Boolean);
}

function extOf_(name) {
  const m = /\.([^.]+)$/.exec(String(name || ''));
  return m ? m[1].toLowerCase() : '';
}

function tg_(method, payload) {
  const res = UrlFetchApp.fetch('https://api.telegram.org/bot' + cfg_().token + '/' + method, {
    method: 'post',
    contentType: 'application/json',
    payload: JSON.stringify(payload || {}),
    muteHttpExceptions: true
  });
  const body = JSON.parse(res.getContentText());
  if (!body.ok) throw new Error(method + ' failed: ' + (body.description || res.getResponseCode()));
  return body.result;
}

/** Run once: grants permissions and checks the bot and the folder. */
function setup() {
  const c = cfg_();
  const me = tg_('getMe', {});
  tg_('deleteWebhook', {}); // getUpdates does not work while a webhook is set
  const folderName = DriveApp.getFolderById(c.folderId).getName();
  Logger.log('Connected: @' + me.username + ' -> folder "' + folderName + '" (time zone ' + c.tz + ')');
}

/** Run once: polls every minute. Safe to run again (no duplicate triggers). */
function installTrigger() {
  removeTrigger();
  ScriptApp.newTrigger('poll').timeBased().everyMinutes(1).create();
  Logger.log('Trigger installed: poll runs every minute.');
}

/** Stops the bot. Run installTrigger to start it again. */
function removeTrigger() {
  ScriptApp.getProjectTriggers()
    .filter(function (t) { return t.getHandlerFunction() === 'poll'; })
    .forEach(function (t) { ScriptApp.deleteTrigger(t); });
}

/** Called by the trigger every minute: saves new messages to the Inbox. */
function poll() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(1000)) return; // previous run still going
  try {
    const c = cfg_();
    const p = props_();
    let offset = Number(p.getProperty('OFFSET') || 0);
    const updates = tg_('getUpdates', { offset: offset, timeout: 0, allowed_updates: ['message'] });
    if (!updates.length) return;
    const folder = DriveApp.getFolderById(c.folderId);

    updates.forEach(function (u) {
      // Save the position first, so one bad message can never loop forever.
      offset = u.update_id + 1;
      p.setProperty('OFFSET', String(offset));

      const m = u.message;
      if (!m || !m.chat) return;
      const chatId = String(m.chat.id);

      if (!c.allowed) {
        tg_('sendMessage', {
          chat_id: chatId,
          text: 'Your chat ID: ' + chatId + '\nAdd it as ALLOWED_CHAT_ID in Script Properties to start saving.'
        });
        return;
      }
      // Only your private chat with the bot: both the chat and the sender must be you.
      // (In a group, chat.id is the group's ID, so a bot added to a group is ignored too.)
      if (chatId !== c.allowed || !m.from || String(m.from.id) !== c.allowed) return;

      try {
        const saved = saveMessage_(folder, m, c);
        const reply = saved
          ? '✅ Saved to Inbox\n' + saved.join('\n')
          : 'ℹ️ Photos are not saved. Add text or a link and only the text will be saved.';
        tg_('sendMessage', { chat_id: chatId, reply_to_message_id: m.message_id, text: reply });
      } catch (err) {
        tg_('sendMessage', { chat_id: chatId, reply_to_message_id: m.message_id, text: '⚠️ Could not save: ' + err.message });
      }
    });
  } finally {
    lock.releaseLock();
  }
}

/** Saves one message. Returns the saved file names, or null when nothing was saved. */
function saveMessage_(folder, m, c) {
  const when = new Date(m.date * 1000);
  const stamp = Utilities.formatDate(when, c.tz, 'yyyy-MM-dd_HHmmss') + '_' + m.message_id;
  const received = Utilities.formatDate(when, c.tz, "yyyy-MM-dd'T'HH:mm:ssXXX");
  const text = m.text || m.caption || '';
  const entities = m.entities || m.caption_entities || [];

  // Photos (sent as photos or as image files) are skipped unless SAVE_PHOTOS is "true".
  const isImageDoc = !!(m.document && /^image\//.test(m.document.mime_type || ''));
  const hasPhoto = !!(m.photo && m.photo.length) || isImageDoc;
  if (hasPhoto && !c.savePhotos && !text.trim()) return null; // photo only: no note

  const files = [];
  if (c.savePhotos && m.photo && m.photo.length) {
    files.push({ id: m.photo[m.photo.length - 1].file_id, name: stamp + '_photo.jpg' }); // largest size
  }
  if (m.document && (!isImageDoc || c.savePhotos)) {
    files.push({ id: m.document.file_id, size: m.document.file_size, name: stamp + '_' + safeName_(m.document.file_name || 'file') });
  }
  if (m.voice) files.push({ id: m.voice.file_id, size: m.voice.file_size, name: stamp + '_voice.ogg' });
  if (m.audio) files.push({ id: m.audio.file_id, size: m.audio.file_size, name: stamp + '_' + safeName_(m.audio.file_name || 'audio.mp3') });
  if (m.video) files.push({ id: m.video.file_id, size: m.video.file_size, name: stamp + '_' + safeName_(m.video.file_name || 'video.mp4') });

  const attached = [];
  const skipped = [];
  files.forEach(function (f) {
    if (c.blocked.indexOf(extOf_(f.name)) !== -1) {
      skipped.push(f.name + ' (blocked file type)');
      return;
    }
    if (f.size && f.size > MAX_BYTES) {
      skipped.push(f.name + ' (over 20 MB)');
      return;
    }
    const info = tg_('getFile', { file_id: f.id });
    const blob = UrlFetchApp.fetch('https://api.telegram.org/file/bot' + c.token + '/' + info.file_path).getBlob().setName(f.name);
    folder.createFile(blob);
    attached.push(f.name);
  });

  // Links hidden behind text (text_link entities), common in forwarded channel posts
  const hiddenLinks = entities
    .filter(function (e) { return e.type === 'text_link' && e.url; })
    .map(function (e) { return e.url; });

  // Where a forwarded message came from
  let from = '';
  const o = m.forward_origin;
  if (o) {
    if (o.chat && o.chat.title) from = o.chat.title;
    else if (o.sender_user) from = [o.sender_user.first_name, o.sender_user.last_name].filter(Boolean).join(' ');
    else if (o.sender_user_name) from = o.sender_user_name;
  }

  const fm = ['---', 'source: telegram', 'received: ' + received, 'status: inbox'];
  if (from) fm.push('forwarded_from: "' + from.replace(/"/g, "'") + '"');
  if (m.media_group_id) fm.push('media_group_id: "' + m.media_group_id + '"'); // album sent together
  if (attached.length) {
    fm.push('attachments:');
    attached.forEach(function (a) { fm.push('  - "' + a + '"'); });
  }
  fm.push('---', '');

  const body = [text || '(no text)'];
  if (hiddenLinks.length) {
    body.push('', '## Links in this message');
    hiddenLinks.forEach(function (u) { body.push('- ' + u); });
  }
  if (attached.length) {
    body.push('');
    attached.forEach(function (a) { body.push('![[' + a + ']]'); });
  }
  if (skipped.length) {
    body.push('', '> Not saved: ' + skipped.join(', '));
  }

  const noteName = stamp + '_' + (titleOf_(text) || (files.length ? 'attachment' : 'note')) + '.md';
  folder.createFile(Utilities.newBlob(fm.concat(body).join('\n') + '\n', 'text/markdown', noteName));
  return [noteName].concat(attached).concat(skipped.map(function (s) { return 'skipped: ' + s; }));
}

/** Short title for the file name: first line (30 chars), or "link" if it is just a URL. */
function titleOf_(text) {
  const first = (text || '').split('\n')[0].trim();
  if (!first) return '';
  if (/^https?:\/\/\S+$/.test(first)) return 'link';
  return safeName_(first).slice(0, 30).trim();
}

/** Replaces characters that break file names on Windows or links in Obsidian. */
function safeName_(s) {
  return String(s).replace(/[\\/:*?"<>|#^\[\]\r\n\t]/g, '_').replace(/\s+/g, ' ').trim();
}
