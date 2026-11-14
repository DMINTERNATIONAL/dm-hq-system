/**
 * 해외 손님 예약 요청 (2026-11-14, 사용자: '보통 예약 문의는 외국인이 할 거고, 네이버 가입 절차가 너무 복잡해서').
 *
 * 공식 사이트 'Book a visit' 양식(영 · 중 · 일 · 한) → 사이트 서버가 POST /public/booking (X-Site-Key, X-Client-IP)
 *   → 저장 + 손님에게 '요청 받았어요' 메일(손님 언어) + 경영팀 · 그 지점 관리자에게 폰 알림(채팅방이 아니라 앱 '해외 예약' 메뉴로, 사용자 결정)
 * 본사 앱 '해외 예약' 화면(경영팀 · 관리자):
 *   POST /booking/list                       → 요청 목록(최근 것 먼저)
 *   POST /booking/update { id, status?, memo?, conf?, mail? }  — mail:'reply'(msg 필수) 이면 확정 전 답변 메일, 'confirm' 이면 확정 메일, 'decline' 이면 정중한 거절 메일
 *   POST /booking/delete { id }
 * 핸드SOS 자동 등록은 하지 않는다(공식 연결이 없고 예약 겹침 위험) — 직원이 핸드SOS 를 보고 확정하면 손님 연락만 자동.
 *
 * 저장: 잠긴 /authSecrets/__book/{id} (손님 이름 · 연락처 = 개인정보 — 직원 토큰으로 DB 를 직접 읽어도 안 보이게, 서버만)
 * 파기: 마지막으로 바뀐 지 1년 지나면 목록을 열 때 지운다.
 */

const LANGS = ['en', 'zh', 'ja', 'ko'];
const BRANCHES = { flagship: { ko: '플래그십', en: 'Flagship', zh: '旗舰店', ja: 'フラッグシップ' }, moment: { ko: '모먼트', en: 'Moment', zh: 'Moment 店', ja: 'モーメント' }, any: { ko: '아무 곳', en: 'Either branch', zh: '任意门店', ja: 'どちらでも' } };
const STATUSES = ['new', 'contacted', 'confirmed', 'declined', 'canceled'];
const SLOTS = ['any', 'morning', 'afternoon', 'evening'];
const CH = ['wa', 'ig', 'line', 'wechat', 'kakao'];
const KEEP_MS = 365 * 24 * 3600e3;
const BASE = '/authSecrets/__book';
const ID_RE = /^b[a-z0-9]{8,24}$/;
const clip = (s, n) => String(s == null ? '' : s).replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, n);
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const id36 = () => 'b' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

/* ── 손님 메일(손님 언어) ── */
const T = {
  en: { got: 'We received your booking request', hi: (n) => `Hi ${n},`, gotB: 'Thank you for choosing DAY:MEAN. We have received your request. Our team will reply soon and we will let you know by email. Your appointment is confirmed through a short chat consultation — once we agree on the time, we will send you a confirmation email.', yours: 'Your request', conf: 'Your appointment is confirmed', confB: 'As agreed in our chat, your appointment is confirmed. Here are the details:', dec: 'About your booking request', decB: 'Thank you for your request. Unfortunately we could not find an available time for the dates you chose. Please reply to this email or send another request with different dates — we would love to welcome you.', when: 'Date & time', where: 'Branch', who: 'Designer', what: 'Service', map: 'Directions', note: 'Message from us', note2: 'Your note', foot: 'If you need to change or cancel, simply reply to this email.' },
  zh: { got: '我们已收到您的预约申请', hi: (n) => `${n} 您好，`, gotB: '感谢您选择 DAY:MEAN。我们已收到您的预约申请。我们回复后会通过邮件通知您。预约将通过在线咨询确认——确定时间后，我们会再给您发送确认邮件。', yours: '您的申请', conf: '您的预约已确认', confB: '根据我们在线咨询的约定，您的预约已确认，详情如下：', dec: '关于您的预约申请', decB: '感谢您的申请。很抱歉，您选择的日期暂无空位。请直接回复此邮件或重新提交其他日期，我们非常期待为您服务。', when: '日期和时间', where: '门店', who: '设计师', what: '项目', map: '路线', note: '店铺留言', note2: '您的备注', foot: '如需更改或取消，请直接回复此邮件。' },
  ja: { got: 'ご予約リクエストを受け付けました', hi: (n) => `${n} 様`, gotB: 'DAY:MEAN をお選びいただきありがとうございます。リクエストを受け付けました。担当者よりご返信の際もメールでお知らせします。ご予約はチャットでのご相談で確定し、日時が決まりましたら確認メールをお送りします。', yours: 'ご依頼内容', conf: 'ご予約が確定しました', confB: 'チャットでのご相談のとおり、ご予約が確定しました。内容は以下のとおりです。', dec: 'ご予約リクエストについて', decB: 'リクエストありがとうございます。あいにくご希望の日時に空きがございませんでした。このメールにご返信いただくか、別の日程で再度リクエストをお送りください。', when: '日時', where: '店舗', who: 'デザイナー', what: 'メニュー', map: 'アクセス', note: '店舗からのメッセージ', note2: 'ご要望', foot: '変更・キャンセルの際は、このメールにご返信ください。' },
  ko: { got: '예약 요청을 받았어요', hi: (n) => `${n} 님, 안녕하세요.`, gotB: 'DAY:MEAN 을 찾아 주셔서 감사합니다. 예약 요청을 받았어요. 담당자가 답변을 보내면 메일로도 알려 드려요. 예약은 채팅 상담에서 확정돼요 — 상담에서 시간이 정해지면 확정 메일을 보내 드릴게요.', yours: '요청 내용', conf: '예약이 확정되었어요', confB: '상담에서 정한 대로 예약이 확정되었어요. 예약 내용은 아래와 같아요.', dec: '예약 요청 관련 안내', decB: '요청해 주셔서 감사합니다. 아쉽게도 고르신 날짜에는 가능한 시간이 없었어요. 이 메일에 답장하시거나 다른 날짜로 다시 요청해 주세요.', when: '날짜 · 시간', where: '지점', who: '디자이너', what: '시술', map: '오시는 길', note: '매장 메시지', note2: '요청 사항', foot: '변경 · 취소는 이 메일에 답장해 주세요.' },
};
/* 예약 정책 확정 문구(11/14 사용자 확정 · 사이트 번역표 lib/i18n/content.json 과 같은 글) — 확정 메일 아래에 붙인다 */
const POLICY_T = {
  ko: '[예약 관련 안내]\n\n1. 데이민은 100% 예약제로 운영됩니다.\n2. 방문이 어려우시면 최소 하루 전에 예약을 취소해 주세요.\n3. 10분 이상 늦으시면 당일 시술이 어려울 수 있습니다.\n4. 당일 취소 또는 노쇼가 3회 이상 누적되면, 다른 고객님의 원활한 예약을 위해 이후 예약이 제한됩니다. 너른 양해 부탁드립니다.',
  en: '[Booking information]\n\n1. DAY:MEAN operates by appointment only.\n2. If you are unable to visit, please cancel at least one day in advance.\n3. If you arrive more than 10 minutes late, we may not be able to provide your service that day.\n4. After three same-day cancellations or no-shows, future bookings will be restricted so that we can serve other guests smoothly. We appreciate your understanding.',
  ja: '[ご予約について]\n\n1. DAY:MEANは完全予約制です。\n2. ご来店が難しい場合は、少なくとも前日までにご予約のキャンセルをお願いいたします。\n3. 10分以上遅れてのご来店の場合、当日の施術が難しくなることがございます。\n4. 当日キャンセルまたは無断キャンセルが3回以上重なった場合、他のお客様のスムーズなご予約のため、以降のご予約をお受けできなくなります。何卒ご了承ください。',
  zh: '[预约须知]\n\n1. DAY:MEAN 实行全预约制。\n2. 如无法到店，请至少提前一天取消预约。\n3. 迟到10分钟以上，当天可能无法为您提供服务。\n4. 当天取消或爽约累计3次以上，为保障其他顾客的顺利预约，此后将无法再为您预约，敬请谅解。',
};
const policyBox = (L) => `<div style="margin-top:20px;background:#f5f5f5;border-radius:10px;padding:14px 16px;font-size:13px;color:#333;white-space:pre-line">${esc(POLICY_T[L] || POLICY_T.en)}</div>`;
const CHAT_T = { en: ['Questions? Continue the conversation with us in chat.', 'Chat with us'], zh: ['有任何问题？可以直接在线和我们继续沟通。', '在线咨询'], ja: ['ご不明な点はチャットでお気軽にご相談ください。', 'チャットで相談する'], ko: ['궁금한 점은 채팅으로 이어서 물어보세요.', '채팅으로 상담 이어가기'] };
/* 1번째 메일 — 확정 전 '답변이 왔어요'(11/14 사용자: 접수 메일 없이 답변 → 확정, 총 2번). 직원이 앱에서 쓴 답변(손님 언어)을 그대로 담는다 */
const REPLY_T = {
  en: { t: 'We have replied to your booking request', b: 'Thank you for your booking request. Here is our reply:', line: 'Please reply in chat — your booking will be confirmed there.', btn: 'Reply in chat' },
  zh: { t: '我们已回复您的预约申请', b: '感谢您的预约申请，以下是我们的回复：', line: '请在在线咨询中回复我们，预约将在咨询中确认。', btn: '在线回复' },
  ja: { t: 'ご予約リクエストへのご返信', b: 'ご予約リクエストありがとうございます。店舗からのご返信です：', line: 'チャットでご返信ください。ご予約はチャットで確定します。', btn: 'チャットで返信する' },
  ko: { t: '예약 요청에 답변이 왔어요', b: '예약 요청해 주셔서 감사합니다. 보내 주신 요청에 답변드려요.', line: '채팅으로 답해 주세요. 예약은 상담에서 확정돼요.', btn: '채팅으로 답하기' },
};
/* 확정 메일 '매장 메시지' — 11/14 사용자 '손님께 한마디는 기본적으로 통일'. 앱에서 따로 쓰지 않으면 이 문구가 나간다 */
const CONF_MSG_T = {
  en: 'We look forward to seeing you! If you are running late or your plans change, please let us know in chat in advance.',
  zh: '期待您的光临！如果会迟到或行程有变，请提前在在线咨询中告诉我们。',
  ja: 'ご来店を心よりお待ちしております！遅れる場合やご予定が変わった場合は、事前にチャットでお知らせください。',
  ko: '방문을 기다릴게요! 늦으시거나 일정이 바뀌면 채팅으로 미리 알려 주세요.',
};
/* 손님이 자기 예약 찾기(11/14 사용자 '비회원도 홈페이지에서 바로 — 예약 비밀번호 6자리 이상 + 메일로 찾기도'
   회원은 로그인만으로 마이 페이지). 비밀번호는 예약마다 PBKDF2(직원 · 회원과 같은 pwHash)로 따로 잠긴 곳에 둔다 — 목록 · 앱으로 안 나감 */
const PW_BASE = '/authSecrets/__bookpw';
/* 확정서(11/14 사용자 '채널톡처럼 모든 예약 내용이랑 주소 등 전부 다') — 메일 · 채팅 카드 같은 줄 */
const LBL = {
  en: { no: 'Booking no.', name: 'Name', addr: 'Address', tel: 'Phone', card: 'Booking confirmation' },
  zh: { no: '预约编号', name: '预约人', addr: '地址', tel: '电话', card: '预约确认单' },
  ja: { no: '予約番号', name: 'ご予約者', addr: '住所', tel: '電話番号', card: 'ご予約確認書' },
  ko: { no: '예약 번호', name: '예약자', addr: '주소', tel: '전화', card: '예약 확정서' },
};
const WD = { en: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'], zh: ['周日', '周一', '周二', '周三', '周四', '周五', '周六'], ja: ['日', '月', '火', '水', '木', '金', '土'], ko: ['일', '월', '화', '수', '목', '금', '토'] };
const whenTxt = (c, L) => { const d = new Date(c.d + 'T00:00:00Z'); const w = isNaN(d) ? '' : (WD[L] || WD.en)[d.getUTCDay()]; return `${c.d}${w ? ` (${w})` : ''} ${c.t}`; };
const bkNo = (id) => String(id).slice(-6).toUpperCase();
const AD_RE = /^[A-Za-z0-9_-]{1,40}$/;
const adOf = (x) => (AD_RE.test(String(x || '')) ? String(x) : '');
const MID_RE = /^[ekg]_[A-Za-z0-9_-]{1,80}$/;
const REMIND_T = {
  en: { t: 'Your DAY:MEAN booking requests', b: 'Here are the booking requests made with this email. Tap a button to continue the chat consultation.', st: { new: 'Waiting for our reply', contacted: 'In consultation', confirmed: 'Confirmed', declined: 'Closed', canceled: 'Canceled' }, btn: 'Open chat' },
  zh: { t: '您在 DAY:MEAN 的预约申请', b: '以下是使用此邮箱提交的预约申请。点击按钮即可继续在线咨询。', st: { new: '等待回复', contacted: '咨询中', confirmed: '已确认', declined: '已结束', canceled: '已取消' }, btn: '打开在线咨询' },
  ja: { t: 'DAY:MEAN のご予約リクエスト', b: 'このメールアドレスで送信されたご予約リクエストです。ボタンからチャット相談を続けられます。', st: { new: '返信待ち', contacted: 'ご相談中', confirmed: '確定', declined: '終了', canceled: 'キャンセル' }, btn: 'チャットを開く' },
  ko: { t: 'DAY:MEAN 예약 요청 내역', b: '이 메일로 보내신 예약 요청이에요. 버튼을 누르면 채팅 상담을 이어갈 수 있어요.', st: { new: '답변 기다리는 중', contacted: '상담 중', confirmed: '확정', declined: '종료', canceled: '취소' }, btn: '채팅 열기' },
};
const START_T = { en: ['Please start your consultation with the button below — your booking is confirmed in the chat.', 'Start chat consultation'], zh: ['请点击下方按钮开始在线咨询，预约将在咨询中确认。', '开始在线咨询'], ja: ['下のボタンからチャット相談を始めてください。ご予約は相談の中で確定します。', 'チャット相談を始める'], ko: ['아래 버튼으로 채팅 상담을 시작해 주세요. 예약은 상담에서 확정돼요.', '채팅 상담 시작하기'] };
const chatBtn = (L, url, start) => { if (!url) return ''; const c = (start ? START_T : CHAT_T)[L] || (start ? START_T : CHAT_T).en; return `<p style="margin:18px 0 8px;font-size:14px">${esc(c[0])}</p><a href="${esc(url)}" style="display:inline-block;background:#111;color:#fff;text-decoration:none;font-weight:700;border-radius:10px;padding:12px 20px;font-size:14px">${esc(c[1])}</a>`; };
const SLOT_T = { en: { any: 'any time', morning: 'morning', afternoon: 'afternoon', evening: 'evening' }, zh: { any: '任何时间', morning: '上午', afternoon: '下午', evening: '晚上' }, ja: { any: '何時でも', morning: '午前', afternoon: '午後', evening: '夕方' }, ko: { any: '아무 때', morning: '오전', afternoon: '오후', evening: '저녁' } };
const prefTxt = (p, L) => `${p.d} ${/^\d{2}:\d{2}/.test(p.t || '') ? String(p.t).split(',').join(', ') : (SLOT_T[L] || SLOT_T.en)[p.t] || ''}`.trim();

function mailHtml(L, title, lines, rows, after, pre) {
  const t = T[L] || T.en;
  return `<div style="font-family:-apple-system,BlinkMacSystemFont,'Apple SD Gothic Neo','PingFang SC','Hiragino Sans',sans-serif;max-width:520px;margin:0 auto;color:#111;line-height:1.6">
<div style="font-weight:800;letter-spacing:.02em;font-size:18px;margin:8px 0 18px">DAY:MEAN</div>
<h2 style="font-size:19px;margin:0 0 12px">${esc(title)}</h2>${lines.map((l) => `<p style="margin:0 0 10px">${esc(l)}</p>`).join('')}${pre || ''}
${rows.length ? `<table style="width:100%;border-collapse:collapse;margin:14px 0;font-size:14px">${rows.map(([k, v]) => `<tr><td style="padding:8px 0;border-top:1px solid #eee;color:#666;width:34%;vertical-align:top">${esc(k)}</td><td style="padding:8px 0;border-top:1px solid #eee">${v}</td></tr>`).join('')}</table>` : ''}
${after || ''}<p style="font-size:12.5px;color:#888;margin-top:22px">${esc(t.foot)}</p></div>`;
}

/* 메일의 '채팅으로 상담 이어가기' 링크(11/14 사용자 '이메일에 상담 이어가는 링크') — {SITE_URL}/{lang}/booking/chat?b=id&k=서명.
   서명이 있어야 사이트가 /public/booking/peek 로 그 요청의 이름 · 메일 · 요약을 받아 채널톡을 손님 정보로 열 수 있다(번호만 알아선 못 봄) */
async function bkSig(env, id) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(String(env.SESSION_SECRET || env.SITE_KEY || 'x')), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode('book:' + id));
  return Array.from(new Uint8Array(sig).slice(0, 12), (b) => b.toString(16).padStart(2, '0')).join('');
}
async function chatUrl(env, id, L) {
  const base = String(env.SITE_URL || '').replace(/\/+$/, '');
  if (!base) return '';
  return `${base}${L === 'ko' ? '' : '/' + L}/booking/chat?b=${id}&k=${await bkSig(env, id)}`;
}

/* ═══ 채널톡 상담방 자동 열기 (11/14 사용자 '예약 요청 들어오는 순간 상담방이 열리게') ═══
   채널톡 Open API(https://api.channel.io, Channel-Version 2026-06-01, 헤더 x-access-key · x-access-secret = 시크릿 CHANNEL_ACCESS_KEY · CHANNEL_ACCESS_SECRET).
   1) PUT /open/users/@{memberId} — 손님을 memberId 로 만들거나 고침(이름 · 이메일 · 전화 · booking* 프로필 · 태그 '웹사이트')
      memberId = 'bk' + HMAC(이메일) — 같은 이메일이면 같은 손님, 남이 이메일만 알아서는 못 만든다. 사이트는 이 값으로 채널톡을 다시 띄워 같은 상담방을 본다.
   2) POST /open/users/{userId}/user-chats — 상담방 열기
   3) 손님에게 보이는 첫 메시지(손님 언어 · 지점 → 디자이너 → 희망 날짜 → 성별 → 시술 → 이메일) — 손님 알림은 끔(silentToUser, 접수 메일을 뺀 것과 같은 이유)
   4) 직원만 보는 메모(private, 한국어 요약)
   시크릿이 없거나 채널톡이 실패해도 예약 요청 저장 · 직원 폰 알림은 그대로 된다(답변 메일로 대신 연락). */
const CH_API = 'https://api.channel.io', CH_VER = '2026-06-01', CH_BOT = '데이민 예약';
const GENDER_T = { en: { '여성': 'Female', '남성': 'Male' }, zh: { '여성': '女', '남성': '男' }, ja: { '여성': '女性', '남성': '男性' }, ko: { '여성': '여성', '남성': '남성' } };
const CHMSG_T = {
  en: { hi: (n) => `Hello ${n}, thank you for your booking request! Our consultant is checking your requested booking. When we reply, you can see it here and in your email.`, g: 'Gender', e: 'Email' },
  zh: { hi: (n) => `${n} 您好，感谢您的预约申请！我们的顾问正在确认您申请的预约。回复后，您可以在这里或通过邮件查看。`, g: '性别', e: '邮箱' },
  ja: { hi: (n) => `${n} 様、ご予約リクエストありがとうございます！担当者がご希望のご予約を確認しております。返信はこちらのチャットとメールでご確認いただけます。`, g: '性別', e: 'メール' },
  ko: { hi: (n) => `${n} 님, 예약 요청 감사합니다! 상담사가 요청하신 예약을 확인하고 있어요. 답변이 오면 이 채팅과 이메일로 확인하실 수 있어요.`, g: '성별', e: '이메일' },
};
async function chMemberOf(env, email) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(String(env.SESSION_SECRET || env.SITE_KEY || 'x')), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode('chm:' + String(email).toLowerCase()));
  return 'bk' + Array.from(new Uint8Array(sig).slice(0, 10), (b) => b.toString(16).padStart(2, '0')).join('');
}
/* 채널톡 멤버 인증(memberHash) — HMAC-SHA256(memberId, 시크릿 키를 hex 로 푼 바이트) 를 hex 로. 시크릿 CHANNEL_MEMBER_SECRET 이 없으면 '' (멤버 인증이 꺼져 있으면 채널톡이 무시) */
async function chHashOf(env, memberId) {
  const sec = String(env.CHANNEL_MEMBER_SECRET || '').trim();
  if (!memberId || !/^([0-9a-fA-F]{2})+$/.test(sec)) return '';
  const raw = new Uint8Array(sec.match(/../g).map((h) => parseInt(h, 16)));
  const key = await crypto.subtle.importKey('raw', raw, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(memberId));
  return Array.from(new Uint8Array(sig), (b) => b.toString(16).padStart(2, '0')).join('');
}
export { chHashOf };
async function chCall(env, method, path, body) {
  const r = await fetch(CH_API + path, { method, headers: { 'x-access-key': env.CHANNEL_ACCESS_KEY, 'x-access-secret': env.CHANNEL_ACCESS_SECRET, 'Channel-Version': CH_VER, 'Content-Type': 'application/json', accept: 'application/json' }, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(8000) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`channel ${method} ${path.split('/').slice(0, 4).join('/')} ${r.status} ${(j.errors && j.errors[0] && j.errors[0].type) || ''}`);
  return j;
}
/* 봇으로 메시지 — 봇 '데이민 예약'이 없으면 한 번 만들고 다시 보낸다(봇 이름엔 ':' 못 씀) */
async function chSend(env, c, body) {
  const path = `/open/user-chats/${c}/messages?botName=${encodeURIComponent(CH_BOT)}`;
  try { return await chCall(env, 'POST', path, body); } catch (e) {
    const bots = await chCall(env, 'GET', '/open/bots').catch(() => ({}));
    if ((bots.bots || []).some((b) => b && b.name === CH_BOT)) throw e;
    await chCall(env, 'POST', '/open/bots', { name: CH_BOT, color: '#111111', description: '홈페이지 해외 예약 요청 (DM 본사 앱)' });
    return chCall(env, 'POST', path, body);
  }
}
/* 예약 요약 — 손님 언어(x)와 직원용 한국어(xk). 우리 앱 상담방 첫 안내(11/14)와 채널톡(유료 API) 첫 메시지가 같이 쓴다 */
function bkSummary(id, r) {
  const L = r.lang, t = T[L] || T.en, M = CHMSG_T[L] || CHMSG_T.en, br = BRANCHES[r.branch] || BRANCHES.any;
  const lines = [M.hi(r.name), '', `[#${id}]`, `${t.where}: ${br[L] || br.en}`];
  if (r.designer) lines.push(`${t.who}: ${r.designer}`);
  lines.push(`${t.when}: ${r.prefs.map((p) => prefTxt(p, L)).join(' / ')}`, `${M.g}: ${(GENDER_T[L] || GENDER_T.en)[r.gender] || r.gender}`);
  if (r.svcL || r.service) lines.push(`${t.what}: ${r.svcL || r.service}`);
  lines.push(`${M.e}: ${r.email}`);
  if (r.ch && r.ch.wechat) lines.push(`WeChat: ${r.ch.wechat}`);
  if (r.ch && r.ch.ig) lines.push(`Instagram: @${String(r.ch.ig).replace(/^@/, '')}`);
  const ko = [`[해외 예약 요청 #${id} · ${({ en: '영어', zh: '중국어', ja: '일본어', ko: '한국어' })[L] || L}]`, `지점: ${br.ko}`, `디자이너: ${r.designer || '미지정'}`, `희망: ${r.prefs.map((p) => prefTxt(p, 'ko')).join(' / ')}`, `성별: ${r.gender}`, `시술: ${r.service || '-'}`, `이메일: ${r.email}`];
  if (r.phone) ko.push(`전화: ${r.phone}`);
  if (r.ch && r.ch.wechat) ko.push(`WeChat: ${r.ch.wechat}`);
  if (r.ch && r.ch.ig) ko.push(`Instagram: @${String(r.ch.ig).replace(/^@/, '')}`);
  if (r.note) ko.push(`요청 사항: ${r.note.slice(0, 300)}`);
  ko.push('확정은 \'해외 예약\'에서 (확정 메일이 나가요)');
  return { x: lines.join('\n'), xk: ko.join('\n') };
}
/* 상담방 열기 — 성공하면 { u 손님 id, c 상담방 id, m memberId } */
async function chOpen(env, id, r) {
  if (!env.CHANNEL_ACCESS_KEY || !env.CHANNEL_ACCESS_SECRET) return null;
  const L = r.lang, t = T[L] || T.en, M = CHMSG_T[L] || CHMSG_T.en, md = (d) => `${+d.slice(5, 7)}/${+d.slice(8, 10)}`;
  const m = await chMemberOf(env, r.email);
  const profile = { name: r.name, email: r.email, bookingId: id, bookingBranch: r.branch, bookingDates: r.prefs.map((p) => `${md(p.d)} ${p.t}`).join(' · '), bookingServices: (r.service || '').slice(0, 200), bookingGender: r.gender, bookingDesigner: r.designer || '', bookingNote: (r.note || '').slice(0, 100), bookingLang: L };
  if (/^\+\d{6,15}$/.test(String(r.phone || '').replace(/[\s-]/g, ''))) profile.mobileNumber = String(r.phone).replace(/[\s-]/g, '');
  for (const k of Object.keys(profile)) if (!profile[k]) delete profile[k];
  const up = await chCall(env, 'PUT', `/open/users/@${m}`, { profile, tags: ['웹사이트'] });
  const u = up.user && up.user.id;
  if (!u) throw new Error('channel user');
  const uc = await chCall(env, 'POST', `/open/users/${u}/user-chats`);
  const c = uc.userChat && uc.userChat.id;
  if (!c) throw new Error('channel chat');
  const br = BRANCHES[r.branch] || BRANCHES.any;
  const lines = [M.hi(r.name), '', `${t.where}: ${br[L] || br.en}`];
  if (r.designer) lines.push(`${t.who}: ${r.designer}`);
  lines.push(`${t.when}: ${r.prefs.map((p) => prefTxt(p, L)).join(' / ')}`, `${M.g}: ${(GENDER_T[L] || GENDER_T.en)[r.gender] || r.gender}`);
  if (r.svcL || r.service) lines.push(`${t.what}: ${r.svcL || r.service}`);
  lines.push(`${M.e}: ${r.email}`);
  await chSend(env, c, { plainText: lines.join('\n'), options: ['displayAsChannel', 'silentToUser'] });
  const ko = [`[해외 예약 요청 · ${({ en: '영어', zh: '중국어', ja: '일본어', ko: '한국어' })[L] || L}]`, `지점: ${br.ko}`, r.designer ? `디자이너: ${r.designer}` : '디자이너: 미지정', `희망: ${r.prefs.map((p) => prefTxt(p, 'ko')).join(' / ')}`, `성별: ${r.gender}`, `시술: ${r.service || '-'}`, `이메일: ${r.email}`];
  if (r.phone) ko.push(`전화: ${r.phone}`);
  if (r.note) ko.push(`요청 사항: ${r.note.slice(0, 300)}`);
  ko.push('확정은 DM 앱 > 해외 예약에서 (확정 메일이 나가요)');
  await chSend(env, c, { plainText: ko.join('\n'), options: ['private'] }).catch((e) => console.log('channel note', e && e.message));
  return { u, c, m };
}

export function makeBooking(deps) {
  const { webOpen, webSig, webCard, webTr, webAttach, dbGet, dbPatch, dbPut, rlHit, rlBlocked, ipKey, ipOf, sameStr, canManageStaff, sendMail, pushToPhones, pwHash, pwVerify, sha256hex } = deps;
  const siteOk = (request, env) => !!(env.SITE_KEY && sameStr(request.headers.get('X-Site-Key') || '', env.SITE_KEY));
  const rate = async (request, env, tag, max) => {
    const cip = String(request.headers.get('X-Client-IP') || '').slice(0, 64);
    if (!cip) return true;   // 사이트 서버(Vercel) IP 하나로 모든 손님이 같이 잠기지 않게 — 이 경로들은 X-Site-Key 가 있어야만 부를 수 있다
    return rlHit(env, tag + await ipKey(cip), max, 60 * 60 * 1000);
  };

  function clean(b) {
    const name = clip(b.name, 60);
    const email = clip(b.email, 120).toLowerCase();
    if (!name) throw new Error('name');
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) throw new Error('email');
    if (b.consent !== true) throw new Error('consent');
    if (!['여성', '남성'].includes(b.gender)) throw new Error('gender');   // 성별 필수(11/14 사용자)
    const lang = LANGS.includes(b.lang) ? b.lang : 'en';
    const branch = BRANCHES[b.branch] ? b.branch : 'any';
    const ch = {};
    for (const k of CH) { const v = clip(b.ch && b.ch[k], 60); if (v) ch[k] = v; }
    if (!ch.wechat && !ch.ig) throw new Error('ch');   // 위챗 아이디 · 인스타그램 아이디 중 하나는 필수(11/14 사용자)
    const today = new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10);
    // 시간(11/14 사용자 '무관 또는 10:00~18:30 30분 단위 여러 개'): t = 'any' 또는 'HH:MM,HH:MM,…'(30분 단위 · 최대 18개). 예전 morning/afternoon/evening 도 받음
    const slotOk = (t) => { const v = String(t || ''); if (SLOTS.includes(v)) return v; const xs = [...new Set(v.split(',').map((x) => x.trim()).filter(Boolean))].slice(0, 18); if (!xs.length || !xs.every((x) => /^(1[0-8]):(00|30)$/.test(x))) return ''; return xs.sort().join(','); };
    const prefs = (Array.isArray(b.prefs) ? b.prefs : []).slice(0, 3).map((p) => ({ d: clip(p && p.d, 10), t: slotOk(p && p.t) }))
      .filter((p) => /^\d{4}-\d{2}-\d{2}$/.test(p.d) && p.d >= today && p.t);
    if (!prefs.length) throw new Error('prefs');
    return { name, email, phone: clip(b.phone, 30), ch, lang, branch, designer: clip(b.designer, 40), service: clip(Array.isArray(b.services) ? b.services.map((x) => clip(x, 40)).filter(Boolean).slice(0, 20).join(', ') : b.service, 400), prefs, note: clip(b.note, 1000), len: clip(b.len, 20), gender: ['여성', '남성'].includes(b.gender) ? b.gender : '', svcL: clip(b.servicesLabel, 400), ...(adOf(b.ad) ? { ad: adOf(b.ad) } : {}) };   // svcL: 손님 언어로 쓴 시술 이름(메일용) — service 는 직원용 한국어   // gender: 성별(11/14 사용자 '머리 길이 대신 성별') · len 은 예전 값 호환   // len: 머리 길이(가격표 기장 — 숏컷/남자 · 목선 · 쇄골선 · 가슴 윗선 …)   // service: 메뉴 여러 개(11/14 '우리 메뉴 다 보여주자') — services 배열 또는 service 글자
  }

  /* 알림 받을 사람: 경영팀 전원 + (지점을 골랐으면) 그 지점 관리자, 아무 곳이면 DAY:MEAN 관리자 전원 */
  async function staffFor(env, branch) {
    const us = (await dbGet(env, '/users').catch(() => null)) || {};
    const brKo = { flagship: '플래그십', moment: '모먼트' }[branch];
    const out = [];
    for (const [ph, u] of Object.entries(us)) {
      if (!u || u.status === '퇴사') continue;
      const g = u.systemGrade || '';
      const hq = g === '경영팀' || u.role === '경영팀' || u.role === '본사경영팀';
      const mgr = g === '관리자' || u.role === '관리자' || (Array.isArray(u.roles) && u.roles.includes('관리자'));
      if (hq) out.push(ph);
      else if (mgr && u.brand === 'DAY:MEAN' && (!brKo || String(u.branch || '').includes(brKo))) out.push(ph);
    }
    return out;
  }

  /* 지점 주소 · 전화 · 구글 지도 — 매장 정보 관리(/salonInfo/store/branches) 그대로 */
  async function branchInfo(env, branch) {
    const brs = (await dbGet(env, '/salonInfo/store/branches').catch(() => null)) || [];
    const key = { flagship: /플래그십|flagship/i, moment: /모먼트|moment/i }[branch];
    if (!key) return {};
    // 11/14 사용자 '네이버 지도 말고 구글 링크' — 외국 손님은 네이버 지도 앱이 없다. 사이트 지점 화면과 같은 'DAY:MEAN + 주소' 구글 검색
    for (const b of Object.values(brs)) if (b && key.test(String(b.name || ''))) {
      const address = clip(b.address, 200), phone = clip(b.phone, 40);
      return { address, phone, map: address ? 'https://www.google.com/maps/search/?api=1&query=' + encodeURIComponent('DAY:MEAN ' + address) : '' };
    }
    return {};
  }
  /* 손님에게 보낼 채팅 링크 — 상담방이 있으면 그 방(사이트 위젯), 없으면 예약 링크 */
  async function talkUrl(env, id, cur, L) {
    const base = String(env.SITE_URL || '').replace(/\/+$/, '');
    if (cur.web && webSig && base) return `${base}${L === 'ko' ? '' : '/' + L}/?chat=1&w=${cur.web}&k=${await webSig(env, cur.web)}`;
    return chatUrl(env, id, L);
  }
  function confRows(id, cur, c, L, bi) {
    const t = T[L] || T.en, l = LBL[L] || LBL.en;
    const r = [[l.no, '#' + bkNo(id)], [l.name, cur.name || ''], [t.when, whenTxt(c, L)], [t.where, 'DAY:MEAN ' + ((BRANCHES[c.branch] || BRANCHES.flagship)[L] || BRANCHES[c.branch].en)]];
    if (bi.address) r.push([l.addr, bi.address]);
    if (bi.phone) r.push([l.tel, bi.phone]);
    if (c.designer) r.push([t.who, (L === 'ko' && c.designerKo) || c.designer]);   // 직원 앱(한국어)엔 한국 이름
    const svc = L === 'ko' ? (c.svc || cur.service || '') : (c.svcL || cur.svcL || c.svc || cur.service || '');
    if (svc) r.push([t.what, svc]);
    return r;
  }
  function confOf(cIn, cur, who) {
    const c = cIn || {};
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(c.d || '')) || !/^\d{2}:\d{2}$/.test(String(c.t || ''))) throw new Error('확정 날짜 · 시간을 넣어 주세요');
    return { d: c.d, t: c.t, branch: BRANCHES[c.branch] && c.branch !== 'any' ? c.branch : (cur.branch && cur.branch !== 'any' ? cur.branch : 'flagship'), designer: clip(c.designer, 40), ...(c.designerKo ? { designerKo: clip(c.designerKo, 40) } : {}), msg: clip(c.msg, 500), ...(c.svc ? { svc: clip(c.svc, 200) } : {}), ...(c.svcL ? { svcL: clip(c.svcL, 300) } : {}), by: who };
  }
  /* 확정 — 손님 언어 확정서 메일 + (상담방이 있으면) 채팅에 확정서 카드. 예약 페이지 · 상담방 둘 다 여기로 */
  /* 광고 → 예약 요청 · 확정 숫자(chat.js adFunnel 과 같은 곳) */
  const adFunnel = (env, ad, k) => (adOf(ad) ? dbPatch(env, `/adFunnel/${new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10)}/${ad}`, { [k]: { '.sv': { increment: 1 } } }).catch(() => {}) : Promise.resolve());
  async function confirmBooking(env, id, cur, c, who) {
    const was = cur.status;   // 확정 전 상태(같은 예약을 다시 확정하면 광고 확정 숫자는 안 올림)
    const L = cur.lang || 'en', t = T[L] || T.en, l = LBL[L] || LBL.en;
    const bi = await branchInfo(env, c.branch);
    const msg = c.msg || CONF_MSG_T[L] || CONF_MSG_T.en;
    const rows = confRows(id, cur, c, L, bi).map(([k, v]) => [k, esc(v)]);
    if (bi.map) rows.push([t.map, `<a href="${esc(bi.map)}" style="color:#111;font-weight:700">Google Maps →</a>`]);
    rows.push([t.note, esc(msg)]);
    const cu = await talkUrl(env, id, cur, L);
    const plain = confRows(id, cur, c, L, bi).map(([k, v]) => `${k}: ${v}`).join('\n');
    await sendMail(env, cur.email, `DAY:MEAN — ${t.conf} #${bkNo(id)}`, mailHtml(L, t.conf, [t.hi(cur.name), t.confB], rows, policyBox(L) + chatBtn(L, cu)), `${t.hi(cur.name)}\n${t.confB}\n\n${plain}${bi.map ? '\n' + bi.map : ''}\n\n${msg}\n\n${POLICY_T[L] || POLICY_T.en}${cu ? '\n\n' + cu : ''}`);
    const up = { up: Date.now(), conf: c, status: 'confirmed', mailed: { k: 'confirm', at: Date.now(), by: who } };
    await dbPatch(env, `${BASE}/${id}`, up);
    if (cur.ad && was !== 'confirmed') await adFunnel(env, cur.ad, 'conf');   // 같은 예약을 다시 확정해도 한 번만
    if (cur.web && webCard) {
      const card = { no: bkNo(id), g: { title: l.card, rows: confRows(id, cur, c, L, bi), map: bi.map || '', msg, policy: POLICY_T[L] || POLICY_T.en, mail: cur.email }, ko: { title: LBL.ko.card, rows: confRows(id, cur, c, 'ko', bi), map: bi.map || '', msg: c.msg || CONF_MSG_T.ko, mail: cur.email } };
      await webCard(env, cur.web, card, who).catch((e) => console.log('web card', e && e.message));
    }
    return up;
  }
  /* 상담방에서 확정 — 예약 요청으로 시작한 방이면 그 요청을, 일반 문의 방이면 예약을 새로 만들어(해외 예약 목록에도 보이게) 확정 */
  async function chatConfirm(env, o) {
    let id = o.room && ID_RE.test(String(o.room.wb || '')) ? String(o.room.wb) : '';
    let cur = id ? await dbGet(env, `${BASE}/${id}`).catch(() => null) : null;
    if (!cur) {
      confOf(o.conf, { branch: 'any' }, o.who);   // 날짜 · 시간이 틀리면 예약을 만들기 전에 멈춤(다시 눌러도 예약이 쌓이지 않게)
      id = id36();
      cur = { name: clip(o.priv.name, 60), email: clip(o.priv.email, 120).toLowerCase(), lang: LANGS.includes(o.priv.lang) ? o.priv.lang : 'en', branch: BRANCHES[o.conf && o.conf.branch] ? o.conf.branch : 'any', prefs: [], service: clip(o.conf && o.conf.svc, 400), ...(o.conf && o.conf.svcL ? { svcL: clip(o.conf.svcL, 400) } : {}), status: 'contacted', src: 'chat', web: o.v, ...(adOf(o.room && o.room.wad) ? { ad: o.room.wad } : {}), at: Date.now(), up: Date.now() };
      await dbPut(env, `${BASE}/${id}`, cur);
      if (o.link) await o.link(id);   // 메일이 실패해 다시 눌러도 같은 예약으로
    } else if (!cur.web) { cur.web = o.v; await dbPatch(env, `${BASE}/${id}`, { web: o.v }); }
    const c = confOf(o.conf, cur, o.who);
    await confirmBooking(env, id, cur, c, o.who);
    return { id };
  }

  const pubItem = async (env, id, v) => ({ id, k: await bkSig(env, id), status: v.status || 'new', branch: v.branch, designer: v.designer || '', prefs: v.prefs || [], gender: v.gender || '', services: v.svcL || v.service || '', conf: v.conf ? { d: v.conf.d, t: v.conf.t, branch: v.conf.branch, designer: v.conf.designer || '' } : null, createdAt: v.at || 0, ...(v.web && webSig ? { webW: v.web, webK: await webSig(env, v.web) } : {}) });
  const byEmail = async (env, email) => Object.entries((await dbGet(env, BASE).catch(() => null)) || {})
    .filter(([id, v]) => v && ID_RE.test(id) && Date.now() - (v.up || v.at || 0) <= KEEP_MS && String(v.email || '').toLowerCase() === email)
    .sort((x, y) => (y[1].at || 0) - (x[1].at || 0)).slice(0, 20);
  const emailOf = (x) => { const e = String(x || '').trim().toLowerCase().slice(0, 120); return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(e) ? e : ''; };

  async function site(path, request, env, ctx) {
    /* 비회원 내 예약 찾기 — 이메일 + 예약 비밀번호. 틀린 이메일 · 틀린 비번 같은 응답(404 nomatch). 같은 이메일 5번 틀리면 1시간 · IP 시간당 20번 */
    if (path === '/public/booking/lookup' && request.method === 'POST') {
      if (!siteOk(request, env)) return [403, { ok: false, error: 'site' }];
      if (!(await rate(request, env, 'bkl_', 20))) return [429, { ok: false, error: 'rate' }];
      const q = await request.json().catch(() => ({}));
      const email = emailOf(q.email), pw = typeof q.pw === 'string' ? q.pw.slice(0, 64) : '';
      if (!email || pw.length < 6) return [404, { ok: false, error: 'nomatch' }];
      const fk = 'bkf_' + (await sha256hex('bkmail:' + email)).slice(0, 24);
      if (await rlBlocked(env, fk, 5, 60 * 60 * 1000)) return [429, { ok: false, error: 'locked' }];
      const list = await byEmail(env, email);
      const out = [];
      for (const [id, v] of list.slice(0, 10)) { const h = await dbGet(env, `${PW_BASE}/${id}`).catch(() => null); if (h && (await pwVerify(h, pw))) out.push(await pubItem(env, id, v)); }
      if (!list.length) await pwVerify({ hash: 'x', salt: 'AAAAAAAAAAAAAAAAAAAAAA==' }, pw).catch(() => false);   // 예약이 없어도 걸리는 시간을 비슷하게
      if (!out.length) { await rlHit(env, fk, 5, 60 * 60 * 1000); return [404, { ok: false, error: 'nomatch' }]; }
      return [200, { ok: true, bookings: out }];
    }
    /* 비밀번호를 잊은 손님 — 그 이메일로 예약 목록 + 각 채팅 링크 메일. 있든 없든 늘 같은 200. 같은 이메일 1시간 3번 · IP 시간당 10번 */
    if (path === '/public/booking/remind' && request.method === 'POST') {
      if (!siteOk(request, env)) return [403, { ok: false, error: 'site' }];
      if (!(await rate(request, env, 'bkm_', 10))) return [429, { ok: false, error: 'rate' }];
      const q = await request.json().catch(() => ({}));
      const email = emailOf(q.email);
      if (!email) return [200, { ok: true }];
      if (!(await rlHit(env, 'bkme_' + (await sha256hex('bkmail:' + email)).slice(0, 24), 3, 60 * 60 * 1000))) return [200, { ok: true }];
      const job = (async () => {
        const list = await byEmail(env, email);
        if (!list.length) return;
        const L = LANGS.includes(q.lang) ? q.lang : (list[0][1].lang || 'en'), t = T[L] || T.en, M = REMIND_T[L] || REMIND_T.en;
        const blocks = [], text = [];
        for (const [id, v] of list) {
          const cu = await chatUrl(env, id, L);
          const st = M.st[v.status] || M.st.new;
          const when = v.conf ? `${v.conf.d} ${v.conf.t}` : (v.prefs || []).map((p) => prefTxt(p, L)).join(' · ');
          const br = BRANCHES[(v.conf && v.conf.branch) || v.branch] || BRANCHES.any;
          blocks.push(`<div style="border:1px solid #eee;border-radius:10px;padding:12px 14px;margin:0 0 10px"><div style="font-size:12px;color:#666">${esc(st)}</div><div style="font-weight:700;margin:2px 0">${esc('DAY:MEAN ' + (br[L] || br.en))} · ${esc(when)}</div>${v.svcL || v.service ? `<div style="font-size:13px;color:#444">${esc(v.svcL || v.service)}</div>` : ''}${cu ? `<a href="${esc(cu)}" style="display:inline-block;margin-top:8px;background:#111;color:#fff;text-decoration:none;font-weight:700;border-radius:8px;padding:8px 14px;font-size:13px">${esc(M.btn)}</a>` : ''}</div>`);
          text.push(`- ${st} · ${when}${cu ? '\n  ' + cu : ''}`);
        }
        await sendMail(env, email, `DAY:MEAN — ${M.t}`, mailHtml(L, M.t, [M.b], [], blocks.join('')), `${M.b}\n\n${text.join('\n')}`);
      })().catch((e) => console.log('booking remind', e && e.message));
      if (ctx && ctx.waitUntil) ctx.waitUntil(job); else await job;
      return [200, { ok: true }];
    }
    /* 회원 마이 페이지 — 사이트 서버가 로그인 세션에서 꺼낸 회원번호(mid)로만 부른다 */
    if (path === '/public/booking/mine' && request.method === 'POST') {
      if (!siteOk(request, env)) return [403, { ok: false, error: 'site' }];
      if (!(await rate(request, env, 'bkn_', 60))) return [429, { ok: false, error: 'rate' }];
      const q = await request.json().catch(() => ({}));
      const mid = String(q.mid || '');
      if (!MID_RE.test(mid)) return [400, { ok: false, error: 'mid' }];
      const all = (await dbGet(env, BASE).catch(() => null)) || {};
      const list = Object.entries(all).filter(([id, v]) => v && ID_RE.test(id) && v.mid === mid && Date.now() - (v.up || v.at || 0) <= KEEP_MS).sort((x, y) => (y[1].at || 0) - (x[1].at || 0)).slice(0, 30);
      const out = []; for (const [id, v] of list) out.push(await pubItem(env, id, v));
      return [200, { ok: true, bookings: out }];
    }
    if (path === '/public/booking/peek' && request.method === 'POST') {
      if (!siteOk(request, env)) return [403, { ok: false, error: 'site' }];
      if (!(await rate(request, env, 'bkp_', 30))) return [429, { ok: false, error: 'rate' }];
      const q = await request.json().catch(() => ({}));
      const id = String(q.b || ''), k = String(q.k || '');
      if (!ID_RE.test(id) || !/^[0-9a-f]{24}$/.test(k) || !sameStr(k, await bkSig(env, id))) return [404, { ok: false, error: 'link' }];
      const v = await dbGet(env, `${BASE}/${id}`).catch(() => null);
      if (!v || Date.now() - (v.up || v.at || 0) > KEEP_MS) return [404, { ok: false, error: 'gone' }];
      return [200, { ok: true, booking: { id, name: v.name, email: v.email, phone: v.phone || '', lang: v.lang, branch: v.branch, designer: v.designer || '', prefs: v.prefs || [], gender: v.gender || '', services: v.svcL || v.service || '', status: v.status, conf: v.conf ? { d: v.conf.d, t: v.conf.t, branch: v.conf.branch, designer: v.conf.designer || '' } : null, ...(v.web && webSig ? { webW: v.web, webK: await webSig(env, v.web) } : {}), chMember: (v.cht && v.cht.m) || '', chHash: await chHashOf(env, v.cht && v.cht.m), chChat: (v.cht && v.cht.c) || '' } }];
    }
    if (path !== '/public/booking' || request.method !== 'POST') return null;
    if (!siteOk(request, env)) return [403, { ok: false, error: 'site' }];
    if (!(await rate(request, env, 'bk_', 5))) return [429, { ok: false, error: 'rate' }];
    const b = await request.json().catch(() => ({}));
    if (b.hp) return [200, { ok: true }];   // 숨은 칸을 채운 로봇 — 저장하지 않고 '됐다'고만
    let r; try { r = clean(b); } catch (e) { return [400, { ok: false, error: e.message }]; }
    // 예약 비밀번호(6~64자) — 회원(mid, 사이트 서버가 로그인 세션에서 붙임)이면 선택, 아니면 필수
    const mid = MID_RE.test(String(b.mid || '')) ? String(b.mid) : '';
    const pw = typeof b.pw === 'string' ? b.pw : '';
    if (pw && (pw.length < 6 || pw.length > 64)) return [400, { ok: false, error: 'pw' }];
    if (!pw && !mid) return [400, { ok: false, error: 'pw' }];
    const id = id36(), now = Date.now();
    if (pw) await dbPut(env, `${PW_BASE}/${id}`, await pwHash(pw));
    await dbPut(env, `${BASE}/${id}`, { ...r, ...(mid ? { mid } : {}), status: 'new', at: now, up: now });
    const jobs = [
      /* 접수 메일은 보내지 않는다(11/14 사용자 '예약 요청하면 한 번은 필요 없고, 우리가 답변할 때 요청 내용까지 한 번에') — 메일은 답변 · 확정 2번 */
      staffFor(env, r.branch).then((to) => to.length && pushToPhones(env, to, { title: '[해외 예약] 새 요청', body: `${r.name} · ${BRANCHES[r.branch].ko} · ${prefTxt(r.prefs[0], 'ko')}${r.prefs.length > 1 ? ` 외 ${r.prefs.length - 1}` : ''}`, url: './#booking', tag: 'book-' + id }, { urgency: 'high' })).catch((e) => console.log('booking push', e && e.message)),
    ];
    if (ctx && ctx.waitUntil) ctx.waitUntil(Promise.all(jobs)); else await Promise.all(jobs);
    let cht = null;
    try { cht = await chOpen(env, id, r); } catch (e) { console.log('booking channel', e && e.message); }
    /* 우리 앱 상담방(11/14 사용자 '채널톡 대신 우리 앱으로') — 경영팀이 받는 홈페이지 상담방을 예약 요약과 함께 연다. 알림은 위 '[해외 예약] 새 요청'이 이미 간다 */
    let web = null;
    // 이미 상담 중인 방이 있으면(사이트가 webW · webK 를 보냄) 그 방에 붙이고, 열쇠가 틀리거나 방이 없으면 새 방
    if (webAttach && b.webW && b.webK) { try { web = await webAttach(env, ctx, { w: b.webW, k: b.webK, b: id, ad: r.ad, first: bkSummary(id, r) }); if (web) await dbPatch(env, `${BASE}/${id}`, { web: web.v, ...(!r.ad && web.ad ? { ad: web.ad } : {}) }).catch(() => {}); if (web && !r.ad && web.ad) r.ad = web.ad; } catch (e) { console.log('booking attach', e && e.message); web = null; } }
    if (!web && webOpen) { try { web = await webOpen(env, ctx, { name: r.name, email: r.email, lang: r.lang, b: id, ad: r.ad, first: bkSummary(id, r), push: false }); await dbPatch(env, `${BASE}/${id}`, { web: web.v }).catch(() => {}); } catch (e) { console.log('booking web', e && e.message); } }
    /* 무료 방법(11/14 사용자 — Open API 는 유료라 '무료로'): 사이트가 손님 브라우저의 채널톡 고객 번호(boot 콜백 user.id)를 chUser 로 넘긴다.
       직원 앱 '채널톡 상담 열기' → 채널톡의 그 손님 화면 → '새 상담 열기'. API 키가 생기면 위 chOpen 이 상담방까지 연다 */
    const chUser = /^[A-Za-z0-9]{8,40}$/.test(String(b.chUser || '')) ? String(b.chUser) : '';
    if (!cht && chUser) cht = { u: chUser };
    if (cht) await dbPatch(env, `${BASE}/${id}`, { cht }).catch(() => {});
    if (r.ad) await adFunnel(env, r.ad, 'book');
    return [200, { ok: true, id, k: await bkSig(env, id), ...(web ? { webW: web.v, webK: web.k } : {}), chMember: (cht && cht.m) || '', chHash: cht && cht.m ? await chHashOf(env, cht.m) : '', chChat: (cht && cht.c) || '' }];
  }

  async function route(path, request, env, me, json, origin) {
    if (!path.startsWith('/booking/')) return null;
    if (request.method !== 'POST') return json({ ok: false, error: 'POST 만 받습니다' }, 405, origin);
    if (!(await canManageStaff(env, me))) return json({ ok: false, error: '경영팀 · 관리자만 볼 수 있어요' }, 403, origin);
    const b = await request.json().catch(() => ({}));
    try {
      if (path === '/booking/list') {
        const all = (await dbGet(env, BASE).catch(() => null)) || {};
        const old = Object.entries(all).filter(([, v]) => v && Date.now() - (v.up || v.at || 0) > KEEP_MS).map(([k]) => k);
        if (old.length) await dbPatch(env, '/', Object.fromEntries(old.flatMap((k) => [[`${BASE.slice(1)}/${k}`, null], [`${PW_BASE.slice(1)}/${k}`, null]])));
        const items = Object.entries(all).filter(([k, v]) => v && !old.includes(k)).map(([id, v]) => ({ id, ...v })).sort((x, y) => (y.at || 0) - (x.at || 0));
        return json({ ok: true, items }, 200, origin);
      }
      const id = String(b.id || '');
      if (!ID_RE.test(id)) throw new Error('요청 정보가 올바르지 않습니다');
      const cur = await dbGet(env, `${BASE}/${id}`);
      if (!cur) throw new Error('없는 요청이에요');
      if (path === '/booking/delete') { await dbPut(env, `${BASE}/${id}`, null); await dbPut(env, `${PW_BASE}/${id}`, null).catch(() => {}); return json({ ok: true }, 200, origin); }
      if (path !== '/booking/update') return json({ ok: false, error: '없는 기능입니다' }, 404, origin);
      const u = await dbGet(env, '/users/' + encodeURIComponent(String(me.ph))).catch(() => null);
      const who = (u && (u.nick || u.name)) || '경영팀';
      const up = { up: Date.now() };
      if (b.status != null) { if (!STATUSES.includes(b.status)) throw new Error('상태가 올바르지 않습니다'); up.status = b.status; }
      if (b.memo != null) up.memo = clip(b.memo, 1000);
      if (b.conf) {
        up.conf = confOf(b.conf, cur, who);
        // 시술: 손님이 고른 그대로면 손님 언어 글(svcL)을 쓰고, 직원이 바꿨으면 손님 언어로 번역
        if (up.conf.svc && up.conf.svc === cur.service) delete up.conf.svc;
        else if (up.conf.svc && (cur.lang || 'en') !== 'ko' && webTr) { const tl = await webTr(env, up.conf.svc, cur.lang || 'en').catch(() => ''); up.conf.svcL = clip(tl || up.conf.svc, 300); }
      }
      const L = cur.lang || 'en', t = T[L] || T.en;
      if (b.mail === 'reply') {
        const msg = clip(b.msg, 1500);
        if (!msg) throw new Error('손님께 보낼 답변을 적어 주세요');
        if (cur.status === 'declined' || cur.status === 'canceled') throw new Error('거절 · 취소된 요청이에요');
        const R2 = REPLY_T[L] || REPLY_T.en;
        // 요청 내용 — 손님이 보낸 것 전부(접수 메일이 없으므로 여기서 처음 보여 준다). 순서: 지점 · 디자이너 · 희망 날짜 · 시술
        const rows = [[t.where, esc(BRANCHES[cur.branch] ? (BRANCHES[cur.branch][L] || BRANCHES[cur.branch].en) : '')]];
        if (cur.designer) rows.push([t.who, esc(cur.designer)]);
        rows.push([t.when, (cur.prefs || []).map((p) => esc(prefTxt(p, L))).join('<br>')]);
        if (cur.svcL || cur.service) rows.push([t.what, esc(cur.svcL || cur.service)]);
        if (cur.note) rows.push([t.note2 || 'Note', esc(cur.note)]);
        const cu = await talkUrl(env, id, cur, L);
        const box = `<div style="margin:4px 0 18px;border-left:3px solid #111;background:#f5f5f5;border-radius:0 10px 10px 0;padding:12px 14px;font-size:14.5px;white-space:pre-line">${esc(msg)}</div>`;
        const btn = cu ? `<p style="margin:18px 0 8px;font-size:14px">${esc(R2.line)}</p><a href="${esc(cu)}" style="display:inline-block;background:#111;color:#fff;text-decoration:none;font-weight:700;border-radius:10px;padding:12px 20px;font-size:14px">${esc(R2.btn)}</a>` : '';
        const html = mailHtml(L, R2.t, [t.hi(cur.name), R2.b], rows, btn, box + `<p style="font-size:12.5px;color:#888;margin:18px 0 0">${esc(t.yours)}</p>`);
        await sendMail(env, cur.email, `DAY:MEAN — ${R2.t}`, html, `${t.hi(cur.name)}\n${R2.b}\n\n${msg}${cu ? '\n\n' + R2.line + '\n' + cu : ''}`);
        if (cur.status === 'new') up.status = 'contacted';
        up.mailed = { k: 'reply', at: Date.now(), by: who };
        up.replied = { at: Date.now(), by: who, n: ((cur.replied && cur.replied.n) || 0) + 1, msg };
      } else if (b.mail === 'confirm') {
        const c = up.conf || cur.conf;
        if (!c) throw new Error('확정 날짜 · 시간을 먼저 정해 주세요');
        if (cur.status === 'new') throw new Error('먼저 \'상담방 열기\'로 상담을 시작해 주세요 — 확정서는 상담에서 정한 뒤에 보내요');
        Object.assign(up, await confirmBooking(env, id, cur, c, who));
      } else if (b.mail === 'decline') {
        const msg = clip(b.msg, 500);
        const cu = await talkUrl(env, id, cur, L);
        await sendMail(env, cur.email, `DAY:MEAN — ${t.dec}`, mailHtml(L, t.dec, [t.hi(cur.name), t.decB].concat(msg ? [msg] : []), [], chatBtn(L, cu)), `${t.hi(cur.name)}\n${t.decB}${msg ? '\n' + msg : ''}`);
        up.status = 'declined'; up.mailed = { k: 'decline', at: Date.now(), by: who };
      }
      await dbPatch(env, `${BASE}/${id}`, up);
      return json({ ok: true, item: { id, ...cur, ...up } }, 200, origin);
    } catch (e) {
      return json({ ok: false, error: String(e.message || e) }, 400, origin);
    }
  }

  return { site, route, confirm: chatConfirm, get: (env, id) => (ID_RE.test(String(id || '')) ? dbGet(env, `${BASE}/${id}`) : Promise.resolve(null)) };
}
