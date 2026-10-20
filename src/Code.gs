/**
 * 텔레그램 → 옵시디언 Inbox 수집 봇 (Google Apps Script)
 *
 * 하는 일: 텔레그램 봇에게 보낸 메모·링크·파일을 구글 드라이브 볼트의 "00 Inbox" 폴더에 저장한다.
 * 사진(이미지 파일 포함)은 저장하지 않는다. 사진에 글이 붙어 있으면 글만 저장한다.
 * 정리(마크다운 노트 변환·분류)는 매일 저녁 Claude 예약 작업이 한다.
 *
 * 방식: 1분마다 텔레그램에 새 메시지가 있는지 확인(getUpdates 폴링). 웹 앱 배포나 서버가 필요 없다.
 *
 * 스크립트 속성(프로젝트 설정 > 스크립트 속성)에 넣을 값
 *   TELEGRAM_TOKEN   : BotFather에서 받은 새 봇 토큰
 *   INBOX_FOLDER_ID  : 볼트의 "00 Inbox" 폴더 ID
 *   ALLOWED_CHAT_ID  : 내 채팅 ID (처음엔 비워 두면 봇이 알려 준다)
 */

const MAX_BYTES = 20 * 1024 * 1024; // 텔레그램 봇이 내려받을 수 있는 최대 크기 (20MB)
const TZ = 'Asia/Seoul';

function props_() {
  return PropertiesService.getScriptProperties();
}

function cfg_() {
  const p = props_();
  const token = (p.getProperty('TELEGRAM_TOKEN') || '').trim();
  const folderId = (p.getProperty('INBOX_FOLDER_ID') || '').trim();
  if (!token || !folderId) {
    throw new Error('스크립트 속성에 TELEGRAM_TOKEN과 INBOX_FOLDER_ID를 넣어 주세요.');
  }
  return { token: token, folderId: folderId, allowed: (p.getProperty('ALLOWED_CHAT_ID') || '').trim() };
}

function tg_(method, payload) {
  const res = UrlFetchApp.fetch('https://api.telegram.org/bot' + cfg_().token + '/' + method, {
    method: 'post',
    contentType: 'application/json',
    payload: JSON.stringify(payload || {}),
    muteHttpExceptions: true
  });
  const body = JSON.parse(res.getContentText());
  if (!body.ok) throw new Error(method + ' 실패: ' + (body.description || res.getResponseCode()));
  return body.result;
}

/** 1회 실행: 권한 승인, 봇·폴더 연결 확인 */
function setup() {
  const c = cfg_();
  const me = tg_('getMe', {});
  tg_('deleteWebhook', {}); // 웹훅이 걸려 있으면 getUpdates가 동작하지 않는다
  const folderName = DriveApp.getFolderById(c.folderId).getName();
  Logger.log('봇 연결 OK: @' + me.username + ' / 저장 폴더: ' + folderName);
}

/** 1회 실행: 1분마다 poll이 돌도록 트리거 설치 (중복 설치 방지) */
function installTrigger() {
  removeTrigger();
  ScriptApp.newTrigger('poll').timeBased().everyMinutes(1).create();
  Logger.log('트리거 설치 완료: 1분마다 poll 실행');
}

/** 봇을 멈추고 싶을 때 실행 */
function removeTrigger() {
  ScriptApp.getProjectTriggers()
    .filter(function (t) { return t.getHandlerFunction() === 'poll'; })
    .forEach(function (t) { ScriptApp.deleteTrigger(t); });
}

/** 트리거가 1분마다 실행: 새 메시지를 Inbox에 저장 */
function poll() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(1000)) return; // 이전 실행이 아직 돌고 있으면 건너뜀
  try {
    const c = cfg_();
    const p = props_();
    let offset = Number(p.getProperty('OFFSET') || 0);
    const updates = tg_('getUpdates', { offset: offset, timeout: 0, allowed_updates: ['message'] });
    if (!updates.length) return;
    const folder = DriveApp.getFolderById(c.folderId);

    updates.forEach(function (u) {
      // 처리 전에 다음 위치를 저장: 한 메시지에서 오류가 나도 같은 메시지를 무한 반복하지 않는다
      offset = u.update_id + 1;
      p.setProperty('OFFSET', String(offset));

      const m = u.message;
      if (!m || !m.chat) return;
      const chatId = String(m.chat.id);

      if (!c.allowed) {
        tg_('sendMessage', {
          chat_id: chatId,
          text: '내 채팅 ID: ' + chatId + '\nApps Script 스크립트 속성 ALLOWED_CHAT_ID에 이 숫자를 넣으면 저장이 시작됩니다.'
        });
        return;
      }
      if (chatId !== c.allowed) return; // 다른 사람이 보낸 메시지는 무시

      try {
        const saved = saveMessage_(folder, m, c.token);
        const reply = saved ? '✅ Inbox에 저장했어요\n' + saved.join('\n') : 'ℹ️ 사진은 저장하지 않아요. 글이나 링크를 함께 보내면 글만 저장합니다.';
        tg_('sendMessage', { chat_id: chatId, reply_to_message_id: m.message_id, text: reply });
      } catch (err) {
        tg_('sendMessage', { chat_id: chatId, reply_to_message_id: m.message_id, text: '⚠️ 저장 실패: ' + err.message });
      }
    });
  } finally {
    lock.releaseLock();
  }
}

/** 메시지 하나를 Inbox에 저장하고, 저장한 파일 이름 목록을 돌려준다 (저장하지 않았으면 null) */
function saveMessage_(folder, m, token) {
  const when = new Date(m.date * 1000);
  const stamp = Utilities.formatDate(when, TZ, 'yyyy-MM-dd_HHmmss') + '_' + m.message_id;
  const received = Utilities.formatDate(when, TZ, "yyyy-MM-dd'T'HH:mm:ssXXX");
  const text = m.text || m.caption || '';
  const entities = m.entities || m.caption_entities || [];

  // 사진은 저장하지 않는다 (사진으로 보낸 것, 이미지 파일로 보낸 것 모두)
  const isImageDoc = !!(m.document && /^image\//.test(m.document.mime_type || ''));
  const hasPhoto = !!(m.photo && m.photo.length) || isImageDoc;
  if (hasPhoto && !text.trim()) return null; // 사진만 보낸 메시지는 노트도 만들지 않는다

  // 첨부 파일 (사진 제외)
  const files = [];
  if (m.document && !isImageDoc) files.push({ id: m.document.file_id, size: m.document.file_size, name: stamp + '_' + safeName_(m.document.file_name || '파일') });
  if (m.voice) files.push({ id: m.voice.file_id, size: m.voice.file_size, name: stamp + '_음성.ogg' });
  if (m.audio) files.push({ id: m.audio.file_id, size: m.audio.file_size, name: stamp + '_' + safeName_(m.audio.file_name || '오디오.mp3') });
  if (m.video) files.push({ id: m.video.file_id, size: m.video.file_size, name: stamp + '_' + safeName_(m.video.file_name || '영상.mp4') });

  const attached = [];
  const skipped = [];
  files.forEach(function (f) {
    if (f.size && f.size > MAX_BYTES) {
      skipped.push(f.name + ' (20MB 초과)');
      return;
    }
    const info = tg_('getFile', { file_id: f.id });
    const blob = UrlFetchApp.fetch('https://api.telegram.org/file/bot' + token + '/' + info.file_path).getBlob().setName(f.name);
    folder.createFile(blob);
    attached.push(f.name);
  });

  // 본문에 숨어 있는 링크(글자에 걸린 링크)
  const hiddenLinks = entities
    .filter(function (e) { return e.type === 'text_link' && e.url; })
    .map(function (e) { return e.url; });

  // 전달(forward)된 메시지의 출처
  let from = '';
  const o = m.forward_origin;
  if (o) {
    if (o.chat && o.chat.title) from = o.chat.title;
    else if (o.sender_user) from = [o.sender_user.first_name, o.sender_user.last_name].filter(Boolean).join(' ');
    else if (o.sender_user_name) from = o.sender_user_name;
  }

  const fm = ['---', 'source: telegram', 'received: ' + received, 'status: inbox'];
  if (from) fm.push('forwarded_from: "' + from.replace(/"/g, "'") + '"');
  if (m.media_group_id) fm.push('media_group_id: "' + m.media_group_id + '"'); // 앨범으로 보낸 사진 묶음
  if (attached.length) {
    fm.push('attachments:');
    attached.forEach(function (a) { fm.push('  - "' + a + '"'); });
  }
  fm.push('---', '');

  const body = [text || '(본문 없음)'];
  if (hiddenLinks.length) {
    body.push('', '## 본문 속 링크');
    hiddenLinks.forEach(function (u) { body.push('- ' + u); });
  }
  if (attached.length) {
    body.push('');
    attached.forEach(function (a) { body.push('![[' + a + ']]'); });
  }
  if (skipped.length) {
    body.push('', '> 크기 때문에 저장하지 못한 파일: ' + skipped.join(', '));
  }

  const noteName = stamp + '_' + (titleOf_(text) || (files.length ? '첨부' : '메모')) + '.md';
  folder.createFile(Utilities.newBlob(fm.concat(body).join('\n') + '\n', 'text/markdown', noteName));
  return [noteName].concat(attached).concat(skipped.map(function (s) { return '건너뜀: ' + s; }));
}

/** 파일 이름에 쓸 짧은 제목: 본문 첫 줄 30자, 링크만 있으면 "링크" */
function titleOf_(text) {
  const first = (text || '').split('\n')[0].trim();
  if (!first) return '';
  if (/^https?:\/\/\S+$/.test(first)) return '링크';
  return safeName_(first).slice(0, 30).trim();
}

/** 윈도우·옵시디언에서 문제가 되는 문자를 바꾼다 */
function safeName_(s) {
  return String(s).replace(/[\\/:*?"<>|#^\[\]\r\n\t]/g, '_').replace(/\s+/g, ' ').trim();
}
