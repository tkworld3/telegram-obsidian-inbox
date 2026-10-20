// Apps Script 없이 Code.gs 동작을 확인하는 모의 테스트: node test/mock-test.js
const fs = require('fs');
const vm = require('vm');
const assert = require('assert');
const path = require('path');

const props = { TELEGRAM_TOKEN: 'TEST', INBOX_FOLDER_ID: 'FOLDER', ALLOWED_CHAT_ID: '' };
const created = [];
const sent = [];
let updates = [];

const ctx = {
  PropertiesService: { getScriptProperties: () => ({ getProperty: k => props[k] ?? null, setProperty: (k, v) => { props[k] = v; } }) },
  LockService: { getScriptLock: () => ({ tryLock: () => true, releaseLock: () => {} }) },
  Logger: { log: () => {} },
  DriveApp: { getFolderById: () => ({ getName: () => '00 Inbox', createFile: b => created.push(b) }) },
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
      if (method === 'getUpdates') result = updates.filter(u => u.update_id >= p.offset);
      if (method === 'getFile') result = { file_path: 'photos/x.jpg' };
      if (method === 'sendMessage') sent.push(p);
      return { getContentText: () => JSON.stringify({ ok: true, result }), getResponseCode: () => 200 };
    }
  },
  ScriptApp: {}
};
vm.createContext(ctx);
vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'src', 'Code.gs'), 'utf8'), ctx);

// 1) 채팅 ID 미등록: 저장하지 않고 채팅 ID를 알려 준다
updates = [{ update_id: 10, message: { message_id: 1, date: 0, chat: { id: 555 }, text: 'hi' } }];
ctx.poll();
assert.strictEqual(created.length, 0);
assert.ok(sent.pop().text.includes('555'));

// 2) 등록 후: 다른 사람 메시지는 무시, 내 메시지는 저장
props.ALLOWED_CHAT_ID = '555';
updates.push({ update_id: 11, message: { message_id: 2, date: 0, chat: { id: 999 }, text: 'spam' } });
updates.push({ update_id: 12, message: {
  message_id: 3, date: 0, chat: { id: 555 }, caption: 'NotebookLM 팁',
  caption_entities: [{ type: 'text_link', url: 'https://example.com/a' }],
  photo: [{ file_id: 's' }, { file_id: 'L' }],
  forward_origin: { type: 'channel', chat: { title: 'AI 채널' } }, media_group_id: '77'
} });
updates.push({ update_id: 13, message: { message_id: 4, date: 0, chat: { id: 555 }, text: 'https://x.com/abc' } });
updates.push({ update_id: 14, message: { message_id: 5, date: 0, chat: { id: 555 }, document: { file_id: 'd', file_size: 30e6, file_name: 'big.pdf' } } });
updates.push({ update_id: 15, message: { message_id: 6, date: 0, chat: { id: 555 }, photo: [{ file_id: 'p' }] } });
updates.push({ update_id: 16, message: { message_id: 7, date: 0, chat: { id: 555 }, document: { file_id: 'i', file_name: 'shot.png', mime_type: 'image/png' } } });
updates.push({ update_id: 17, message: { message_id: 8, date: 0, chat: { id: 555 }, document: { file_id: 'f', file_size: 1000, file_name: 'guide.pdf', mime_type: 'application/pdf' } } });
ctx.poll();

const notes = created.filter(c => c.name.endsWith('.md'));
assert.strictEqual(notes.length, 4, '글이 있는 내 메시지 4건만 노트로 저장 (사진만 보낸 2건 제외)');
assert.ok(!created.some(c => /\.(jpg|png)$/.test(c.name)), '사진·이미지 파일은 저장하지 않음');
assert.ok(created.some(c => c.name.endsWith('_guide.pdf')), 'PDF 같은 일반 파일은 저장');
assert.strictEqual(sent.filter(m => m.text.includes('사진은 저장하지 않아요')).length, 2, '사진만 보내면 안내 답장');
assert.ok(!created.some(c => (c.data || '').includes('spam')), '다른 사람 메시지 무시');
const photoNote = notes.find(n => n.name.includes('NotebookLM'));
assert.ok(photoNote.data.includes('forwarded_from: "AI 채널"'));
assert.ok(photoNote.data.includes('https://example.com/a'));
assert.ok(!photoNote.data.includes('![['), '사진에 붙은 글만 저장, 임베드 없음');
assert.ok(notes.some(n => n.name.endsWith('_링크.md')));
assert.ok(notes.find(n => n.name.endsWith('_첨부.md')).data.includes('20MB 초과'));
assert.strictEqual(props.OFFSET, '18');

// 3) 다시 실행해도 중복 저장 없음
const before = created.length;
ctx.poll();
assert.strictEqual(created.length, before);

console.log('모든 테스트 통과');
