// Mock test: runs Code.gs without Google Apps Script.  Usage: node test/mock-test.js
const fs = require('fs');
const vm = require('vm');
const assert = require('assert');
const path = require('path');

function makeEnv(extraProps) {
  const env = {
    props: Object.assign({ TELEGRAM_TOKEN: 'TEST', INBOX_FOLDER_ID: 'FOLDER', ALLOWED_CHAT_ID: '' }, extraProps || {}),
    created: [],
    sent: [],
    updates: []
  };
  const ctx = {
    PropertiesService: { getScriptProperties: () => ({ getProperty: k => env.props[k] ?? null, setProperty: (k, v) => { env.props[k] = v; } }) },
    LockService: { getScriptLock: () => ({ tryLock: () => true, releaseLock: () => {} }) },
    Session: { getScriptTimeZone: () => 'Etc/UTC' },
    Logger: { log: () => {} },
    DriveApp: { getFolderById: () => ({ getName: () => 'Inbox', createFile: b => env.created.push(b) }) },
    Utilities: {
      formatDate: (d, tz, f) => (f.includes('XXX') ? '2026-10-20T15:10:00+09:00' : '2026-10-20_151000'),
      newBlob: (data, type, name) => ({ name, type, data })
    },
    UrlFetchApp: {
      fetch: (url, opt) => {
        if (url.includes('/file/bot')) return { getBlob: () => ({ setName(n) { this.name = n; return this; } }) };
        const method = url.split('/').pop();
        const p = opt && opt.payload ? JSON.parse(opt.payload) : {};
        let result = {};
        if (method === 'getUpdates') result = env.updates.filter(u => u.update_id >= p.offset);
        if (method === 'getFile') result = { file_path: 'files/x' };
        if (method === 'sendMessage') env.sent.push(p);
        return { getContentText: () => JSON.stringify({ ok: true, result }), getResponseCode: () => 200 };
      }
    },
    ScriptApp: {}
  };
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'src', 'Code.gs'), 'utf8'), ctx);
  env.poll = ctx.poll;
  return env;
}

const msg = (id, extra) => ({ update_id: 100 + id, message: Object.assign({ message_id: id, date: 0, chat: { id: 555 } }, extra) });

// 1) No ALLOWED_CHAT_ID yet: nothing is saved, the bot replies with the chat ID
let env = makeEnv();
env.updates = [msg(1, { text: 'hi' })];
env.poll();
assert.strictEqual(env.created.length, 0);
assert.ok(env.sent.pop().text.includes('555'));

// 2) Default settings (photos off)
env = makeEnv({ ALLOWED_CHAT_ID: '555' });
env.updates = [
  { update_id: 200, message: { message_id: 2, date: 0, chat: { id: 999 }, text: 'spam from a stranger' } },
  msg(3, {
    caption: 'NotebookLM tips',
    caption_entities: [{ type: 'text_link', url: 'https://example.com/a' }],
    photo: [{ file_id: 's' }, { file_id: 'L' }],
    forward_origin: { type: 'channel', chat: { title: 'AI Channel' } }
  }),
  msg(4, { text: 'https://x.com/abc' }),
  msg(5, { document: { file_id: 'd', file_size: 30e6, file_name: 'big.pdf' } }),
  msg(6, { photo: [{ file_id: 'p' }] }),
  msg(7, { document: { file_id: 'i', file_name: 'shot.png', mime_type: 'image/png' } }),
  msg(8, { document: { file_id: 'f', file_size: 1000, file_name: 'guide.pdf', mime_type: 'application/pdf' } })
];
env.poll();

const notes = env.created.filter(c => c.name.endsWith('.md'));
assert.strictEqual(notes.length, 4, 'only my 4 messages with text/files become notes');
assert.ok(!env.created.some(c => (c.data || '').includes('stranger')), 'strangers are ignored');
assert.ok(!env.created.some(c => /\.(jpg|png)$/.test(c.name)), 'photos are not saved by default');
assert.ok(env.created.some(c => c.name.endsWith('_guide.pdf')), 'regular files are saved');
assert.strictEqual(env.sent.filter(m => m.text.includes('Photos are not saved')).length, 2, 'photo-only messages get a notice');
const fwd = notes.find(n => n.name.includes('NotebookLM'));
assert.ok(fwd.data.includes('forwarded_from: "AI Channel"'));
assert.ok(fwd.data.includes('https://example.com/a'));
assert.ok(!fwd.data.includes('![['), 'caption kept, photo dropped');
assert.ok(notes.some(n => n.name.endsWith('_link.md')));
assert.ok(notes.find(n => n.name.endsWith('_attachment.md')).data.includes('over 20 MB'));
assert.strictEqual(env.props.OFFSET, '109');

// 3) Running again saves nothing new
const before = env.created.length;
env.poll();
assert.strictEqual(env.created.length, before, 'no duplicates');

// 4) SAVE_PHOTOS=true saves photos and embeds them
env = makeEnv({ ALLOWED_CHAT_ID: '555', SAVE_PHOTOS: 'true' });
env.updates = [msg(9, { photo: [{ file_id: 's' }, { file_id: 'L' }] })];
env.poll();
assert.ok(env.created.some(c => c.name.endsWith('_photo.jpg')), 'photo saved when enabled');
assert.ok(env.created.find(c => c.name.endsWith('.md')).data.includes('![[2026-10-20_151000_9_photo.jpg]]'));

console.log('All tests passed');
