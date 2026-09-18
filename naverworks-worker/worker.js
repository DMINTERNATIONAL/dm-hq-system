/**
 * DM INTERNATIONAL — Naver Works (LINE WORKS) Notification Relay
 * + 휴게시간 자동 종료 cron (5분마다)
 *
 * Cloudflare Worker that receives order events from the DM system
 * and forwards them as bot messages to a Naver Works channel.
 * Also runs a scheduled cleanup of stale break records every 5 minutes.
 *
 * Required environment variables (set via `wrangler secret put`):
 *   - WEBHOOK_SECRET     : Shared secret with the DM system (any random string)
 *   - NW_CLIENT_ID       : Naver Works app Client ID
 *   - NW_CLIENT_SECRET   : Naver Works app Client Secret
 *   - NW_SERVICE_ACCOUNT : Service Account ID (e.g. abc.serviceaccount@yourcorp)
 *   - NW_PRIVATE_KEY     : RSA private key (PEM format, including -----BEGIN-----)
 *   - NW_BOT_ID          : Bot ID
 *   - NW_CHANNEL_ID      : Target channel ID
 *   - FIREBASE_URL       : Firebase Realtime DB URL (e.g. https://xxx.firebaseio.com)
 *   - ANTHROPIC_API_KEY  : (선택) 고객 상담 메모 AI 다듬기용 Claude API 키
 */

let _tokenCache = null;
const FB_DEFAULT = 'https://dm-orders-4792a-default-rtdb.firebaseio.com';
const BREAK_GRACE_MS = 5 * 60 * 1000; // 60분 + 5분 그레이스 = 65분 후 자동 종료

export default {
  async scheduled(event, env, ctx) {
    // cron 표현식에 따라 분기 (event.cron)
    if (event.cron === '0 18 * * *') {
      // 매일 03:00 KST (= 18:00 UTC 전날) — 5년 지난 데이터 자동 삭제
      ctx.waitUntil(cleanupOldRecords(env));
    } else {
      // 5분마다 — 휴게시간 자동 정리
      ctx.waitUntil(cleanupStaleBreaks(env));
    }
  },

  async fetch(request, env) {
    if (request.method === 'OPTIONS') return cors(new Response(null, { status: 204 }));
    if (request.method === 'GET') {
      return cors(new Response(JSON.stringify({ ok: true, service: 'dm-naverworks-relay' }), {
        headers: { 'Content-Type': 'application/json' }
      }));
    }
    if (request.method !== 'POST') return cors(new Response('Method not allowed', { status: 405 }));

    const pathname = new URL(request.url).pathname;

    let body;
    try { body = await request.json(); }
    catch (e) { return cors(new Response('Invalid JSON', { status: 400 })); }

    // 네이버 웍스 봇 콜백 — 채팅방 channelId 캡처용 (진단)
    if (pathname === '/callback' || pathname.endsWith('/callback')) {
      return cors(await handleBotCallback(body, env));
    }

    // 고객 상담 현장메모 AI 다듬기 (Claude 프록시) — 키는 Worker env에만 보관
    if (pathname === '/ai/polish' || pathname.endsWith('/ai/polish')) {
      return cors(await handleAIPolish(body, env));
    }

    // 전판 제품 맞춤 추천 (진단 답 + 제품목록 → Claude가 추천+이유)
    if (pathname === '/ai/recommend' || pathname.endsWith('/ai/recommend')) {
      return cors(await handleAIRecommend(body, env));
    }

    // 인턴 내수 — 송금 캡처 판독 (금액/계좌/보낸사람/이체일시 추출 + 신청내용 대조)
    if (pathname === '/ai/naesu-verify' || pathname.endsWith('/ai/naesu-verify')) {
      return cors(await handleNaesuVerify(body, env));
    }

    if (!body.secret || body.secret !== env.WEBHOOK_SECRET) {
      return cors(new Response(JSON.stringify({ ok: false, error: 'Unauthorized' }), { status: 401, headers: { 'Content-Type': 'application/json' } }));
    }

    let token;
    try { token = await getAccessToken(env); }
    catch (e) {
      return cors(new Response(JSON.stringify({ ok: false, error: 'Auth failed: ' + e.message }), { status: 500, headers: { 'Content-Type': 'application/json' } }));
    }

    const message = buildMessage(body);

    try {
      await sendMessage(env, token, message);
      return cors(new Response(JSON.stringify({ ok: true }), { headers: { 'Content-Type': 'application/json' } }));
    } catch (e) {
      return cors(new Response(JSON.stringify({ ok: false, error: 'Send failed: ' + e.message }), { status: 500, headers: { 'Content-Type': 'application/json' } }));
    }
  }
};

function cors(resp) {
  resp.headers.set('Access-Control-Allow-Origin', '*');
  resp.headers.set('Access-Control-Allow-Methods', 'POST, OPTIONS, GET');
  resp.headers.set('Access-Control-Allow-Headers', 'Content-Type');
  return resp;
}

async function getAccessToken(env) {
  if (_tokenCache && _tokenCache.expiresAt > Date.now() + 60000) return _tokenCache.token;

  const now = Math.floor(Date.now() / 1000);
  const header = { alg: 'RS256', typ: 'JWT' };
  const payload = { iss: env.NW_CLIENT_ID, sub: env.NW_SERVICE_ACCOUNT, iat: now, exp: now + 3600 };
  const jwt = await signJWT(header, payload, env.NW_PRIVATE_KEY);

  const params = new URLSearchParams();
  params.set('assertion', jwt);
  params.set('grant_type', 'urn:ietf:params:oauth:grant-type:jwt-bearer');
  params.set('client_id', env.NW_CLIENT_ID);
  params.set('client_secret', env.NW_CLIENT_SECRET);
  params.set('scope', 'bot');

  const resp = await fetch('https://auth.worksmobile.com/oauth2/v2.0/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params.toString()
  });
  if (!resp.ok) throw new Error('Token request failed: ' + resp.status + ' ' + (await resp.text()));
  const data = await resp.json();
  _tokenCache = { token: data.access_token, expiresAt: Date.now() + (data.expires_in * 1000) };
  return data.access_token;
}

async function signJWT(header, payload, privateKeyPem) {
  const enc = new TextEncoder();
  const headerB64 = base64UrlEncode(JSON.stringify(header));
  const payloadB64 = base64UrlEncode(JSON.stringify(payload));
  const signingInput = headerB64 + '.' + payloadB64;
  const key = await importPrivateKey(privateKeyPem);
  const sig = await crypto.subtle.sign(
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    key,
    enc.encode(signingInput)
  );
  return signingInput + '.' + base64UrlEncodeBuf(sig);
}

async function importPrivateKey(pem) {
  const cleaned = pem.replace(/-----BEGIN[^-]+-----/, '').replace(/-----END[^-]+-----/, '').replace(/\s+/g, '');
  const der = base64ToArrayBuffer(cleaned);
  return crypto.subtle.importKey('pkcs8', der, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign']);
}

function base64ToArrayBuffer(b64) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes.buffer;
}

function base64UrlEncode(str) {
  return btoa(str).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}

function base64UrlEncodeBuf(buf) {
  const bytes = new Uint8Array(buf);
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}

function buildMessage(body) {
  const type = body.type || 'new';
  const order = body.order || {};

  if (type === 'wig') {
    const o = order || {};
    const text = '🧑‍🦱 가발 공동구매 · 주문 가능!\n\n' +
      '📦 업체: ' + (o.vendor || '') + '\n' +
      '🔢 ' + (o.count || 0) + '개 모집 완료 · 참여 ' + (o.people || 0) + '명\n' +
      '👤 개설: ' + (o.createdBy || '') + '\n\n' +
      '→ 경영팀에서 주문 진행해주세요';
    return { content: { type: 'text', text } };
  }

  if (type === 'naesu') {
    const o = order || {};
    const won = (n) => Number(n || 0).toLocaleString('ko-KR') + '원';
    const who = (o.name || '') + ' · ' + (o.branch || '');
    // 제목 한 줄로 정상/오류가 바로 구분되게 (알림 미리보기에서 첫 줄만 보임)
    const f = o.flag || 'ok';
    let head, alert = '';
    if (f === 'short') {
      head = '⚠️ 내수 입금 부족 · ' + (o.name || '') + ' ' + won(o.diff) + ' 모자람';
      alert = '⚠️ 입금 ' + won(o.diff) + ' 부족\n   캡처 판독 ' + won(o.paid) + ' / 신청 ' + won(o.total) + '\n';
    } else if (f === 'over') {
      head = '⚠️ 내수 과입금 · ' + (o.name || '') + ' ' + won(o.diff) + ' 더 들어옴';
      alert = '⚠️ ' + won(o.diff) + ' 과입금 — 차액 반환 필요\n   캡처 판독 ' + won(o.paid) + ' / 신청 ' + won(o.total) + '\n';
    } else if (f === 'acct') {
      head = '⚠️ 내수 다른 계좌 입금 · ' + (o.name || '');
      alert = '⚠️ 근무지 계좌가 아닌 곳으로 입금됐어요\n   판독 계좌 ' + (o.readAcct || '읽지 못함') + '\n   근무지 계좌 ' + (o.acct || '') + '\n';
    } else if (f === 'dup') {
      head = '⚠️ 내수 캡처 중복 의심 · ' + (o.name || '');
      alert = '⚠️ 이전 신청에 쓰인 캡처와 같아 보여요\n   이체일시 ' + (o.when || '') + '\n';
    } else if (f === 'filled') {
      head = '✅ 내수 입금 보충 완료 · ' + (o.name || '') + ' ' + won(o.total);
      alert = '✅ 부족했던 차액이 채워졌어요 — 확인해주세요\n   캡처 판독 합계 ' + won(o.paid) + ' / 신청 ' + won(o.total) + '\n';
    } else if (f === 'unread') {
      head = '❓ 내수 캡처 확인 필요 · ' + (o.name || '');
      alert = '❓ 캡처를 자동으로 읽지 못했어요 — 직접 확인해주세요\n';
    } else {
      head = '🧴 내수 신청 · ' + (o.name || '') + ' ' + won(o.total);
      alert = '✅ 입금 ' + won(o.paid || o.total) + ' 일치\n';
    }
    const lines = (Array.isArray(o.items) ? o.items : [])
      .slice(0, 8).map(it => '• ' + (it.n || '') + ' ×' + (it.qty || 1)).join('\n');
    const more = (Array.isArray(o.items) && o.items.length > 8)
      ? '\n  ... 외 ' + (o.items.length - 8) + '품목' : '';
    const text = head + '\n\n' +
      '👤 ' + who + '\n' +
      '🧾 ' + (o.count || 0) + '개 품목 · 총 ' + (o.qty || 0) + '개\n' +
      '💰 신청 ' + won(o.total) + '\n\n' +
      alert +
      (lines ? '\n' + lines + more + '\n' : '') +
      '\n🕐 ' + (o.date || '') + ' ' + (o.time || '') +
      '\n\n→ 본사 시스템에서 확인해주세요';
    return { content: { type: 'text', text } };
  }

  let title;
  if (type === 'test') title = '✅ 테스트 메시지';
  else if (type === 'refund') title = '💰 환불 요청이 들어왔어요';
  else title = '🔔 새 발주가 들어왔어요!';

  // 제품명 대신 거래처별로 묶어서 표시 (제품/비품 모두 items[].supplier 사용)
  let itemList = '';
  if (order.items && typeof order.items === 'object') {
    const items = Object.values(order.items);
    const bySup = {};
    items.forEach(it => {
      const sup = (it.supplier || '').trim() || '거래처 미지정';
      if (!bySup[sup]) bySup[sup] = { qty: 0, kinds: 0 };
      bySup[sup].qty += Number(it.qty) || 0;
      bySup[sup].kinds += 1;
    });
    const rows = Object.keys(bySup)
      .map(s => ({ sup: s, qty: bySup[s].qty, kinds: bySup[s].kinds }))
      .sort((a, b) => b.qty - a.qty);
    itemList = rows.slice(0, 8)
      .map(r => '• ' + r.sup + ' ' + r.qty + '개' + (r.kinds > 1 ? ' (' + r.kinds + '품목)' : ''))
      .join('\n');
    if (rows.length > 8) itemList += '\n  ... 외 ' + (rows.length - 8) + '개 거래처';
  }

  let text = title;
  if (type === 'test') {
    text += '\n\n네이버 웍스 봇 연결이 정상입니다 👍';
  } else {
    text += '\n\n' +
      '📍 ' + (order.brand || '') + ' ' + (order.branch || '') + '\n' +
      '👤 신청자: ' + (order.orderedBy || '') + '\n' +
      '📦 ' + (order.type ? order.type + ' · ' : '') + '총 ' + (order.itemCount || 0) + '개 항목\n' +
      (itemList ? '\n' + itemList + '\n' : '') +
      (order.note ? '\n📝 메모: ' + order.note + '\n' : '') +
      '\n🕐 ' + (order.date || '') + ' ' + (order.time || '') +
      '\n\n→ 본사 시스템에서 확인하기';
  }

  return { content: { type: 'text', text } };
}

/* ═══ 휴게시간 자동 종료 (cron) ═══ */
async function cleanupStaleBreaks(env) {
  const FB = env.FIREBASE_URL || FB_DEFAULT;
  const now = Date.now();

  // 모든 활성 휴게 가져오기
  const resp = await fetch(FB + '/breakActive.json', { cache: 'no-store' });
  if (!resp.ok) return;
  const ba = await resp.json();
  if (!ba) return;

  // KST(한국시간) 날짜/시각 계산 (Worker는 UTC라 +9 보정)
  const kstNow = new Date(now + 9 * 60 * 60 * 1000);
  const y = kstNow.getUTCFullYear();
  const m = kstNow.getUTCMonth() + 1;
  const d = kstNow.getUTCDate();
  const dateStr = y + '-' + (m < 10 ? '0' : '') + m + '-' + (d < 10 ? '0' : '') + d;
  const hh = kstNow.getUTCHours();
  const mm = kstNow.getUTCMinutes();
  const timeStr = (hh < 10 ? '0' : '') + hh + ':' + (mm < 10 ? '0' : '') + mm;

  for (const phone in ba) {
    const b = ba[phone];
    if (!b || !b.endsAt) continue;

    // 종료 시각이 5분 이상 지난 것만 자동 정리 (= 시작 후 65분+)
    if (now - b.endsAt < BREAK_GRACE_MS) continue;

    // 1) /break.json 에 60분 사용 기록 추가
    const record = {
      userId: phone,
      userName: b.name || '',
      brand: b.brand || '',
      branch: b.branch || '',
      date: dateStr,
      time: timeStr,
      year: y,
      month: m,
      usedMin: 60,
      autoEnded: true,
      ts: now
    };
    try {
      await fetch(FB + '/break.json', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(record)
      });
    } catch (e) { console.log('break record err', e); continue; }

    // 2) /breakActive/{phone} 삭제
    try {
      await fetch(FB + '/breakActive/' + encodeURIComponent(phone) + '.json', {
        method: 'DELETE'
      });
    } catch (e) { console.log('breakActive del err', e); }

    // 3) /breakAutoEnded/{phone} 에 알림용 플래그 저장 (앱 다음 열 때 팝업)
    try {
      await fetch(FB + '/breakAutoEnded/' + encodeURIComponent(phone) + '.json', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ts: now,
          startedAt: b.startedAt,
          endedAt: b.endsAt,
          date: dateStr,
          time: timeStr
        })
      });
    } catch (e) { console.log('breakAutoEnded put err', e); }
  }
}

/* ═══ 5년 지난 데이터 자동 삭제 (cron, 매일 03:00 KST) ═══ */
async function cleanupOldRecords(env) {
  const FB = env.FIREBASE_URL || FB_DEFAULT;
  // 컷오프 = 오늘 - 5년 (YYYY-MM-DD)
  const now = new Date();
  const cutoff = new Date(now.getFullYear() - 5, now.getMonth(), now.getDate());
  const y = cutoff.getFullYear();
  const m = cutoff.getMonth() + 1;
  const d = cutoff.getDate();
  const cutoffStr = y + '-' + (m < 10 ? '0' : '') + m + '-' + (d < 10 ? '0' : '') + d;

  let summary = { break: 0, meal: 0, late: 0, practiceLog: 0, leave: 0, eduLogs: 0, orders: 0 };

  // 1) /break.json — keyed POST id, has .date
  try {
    const r = await fetch(FB + '/break.json', { cache: 'no-store' });
    const data = await r.json();
    if (data) {
      for (const id in data) {
        const rec = data[id];
        if (rec && rec.date && rec.date < cutoffStr) {
          await fetch(FB + '/break/' + id + '.json', { method: 'DELETE' });
          summary.break++;
        }
      }
    }
  } catch (e) { console.log('break cleanup err', e); }

  // 2) /meal/{uid}/{date} — meals
  try {
    const r = await fetch(FB + '/meal.json', { cache: 'no-store' });
    const data = await r.json();
    if (data) {
      for (const uid in data) {
        for (const date in data[uid]) {
          if (date < cutoffStr) {
            await fetch(FB + '/meal/' + encodeURIComponent(uid) + '/' + date + '.json', { method: 'DELETE' });
            summary.meal++;
          }
        }
      }
    }
  } catch (e) { console.log('meal cleanup err', e); }

  // 3) /late.json — keyed POST id, has .date
  try {
    const r = await fetch(FB + '/late.json', { cache: 'no-store' });
    const data = await r.json();
    if (data) {
      for (const id in data) {
        const rec = data[id];
        if (rec && rec.date && rec.date < cutoffStr) {
          await fetch(FB + '/late/' + id + '.json', { method: 'DELETE' });
          summary.late++;
        }
      }
    }
  } catch (e) { console.log('late cleanup err', e); }

  // 4) /practiceLog.json
  try {
    const r = await fetch(FB + '/practiceLog.json', { cache: 'no-store' });
    const data = await r.json();
    if (data) {
      for (const id in data) {
        const rec = data[id];
        if (rec && rec.date && rec.date < cutoffStr) {
          await fetch(FB + '/practiceLog/' + id + '.json', { method: 'DELETE' });
          summary.practiceLog++;
        }
      }
    }
  } catch (e) { console.log('practiceLog cleanup err', e); }

  // 5) /leave/requests
  try {
    const r = await fetch(FB + '/leave/requests.json', { cache: 'no-store' });
    const data = await r.json();
    if (data) {
      for (const id in data) {
        const rec = data[id];
        if (rec && rec.date && rec.date < cutoffStr) {
          await fetch(FB + '/leave/requests/' + id + '.json', { method: 'DELETE' });
          summary.leave++;
        }
      }
    }
  } catch (e) { console.log('leave cleanup err', e); }

  // 6) /education/logs
  try {
    const r = await fetch(FB + '/education/logs.json', { cache: 'no-store' });
    const data = await r.json();
    if (data) {
      for (const id in data) {
        const rec = data[id];
        if (rec && rec.date && rec.date < cutoffStr) {
          await fetch(FB + '/education/logs/' + id + '.json', { method: 'DELETE' });
          summary.eduLogs++;
        }
      }
    }
  } catch (e) { console.log('eduLogs cleanup err', e); }

  // 7) /orders/{brand}/{branch}/{id}
  try {
    const r = await fetch(FB + '/orders.json', { cache: 'no-store' });
    const data = await r.json();
    if (data) {
      for (const brand in data) {
        for (const branch in data[brand]) {
          for (const oid in data[brand][branch]) {
            const o = data[brand][branch][oid];
            if (o && o.date && o.date < cutoffStr) {
              await fetch(FB + '/orders/' + encodeURIComponent(brand) + '/' + encodeURIComponent(branch) + '/' + oid + '.json', { method: 'DELETE' });
              summary.orders++;
            }
          }
        }
      }
    }
  } catch (e) { console.log('orders cleanup err', e); }

  console.log('cleanup summary (cutoff ' + cutoffStr + '):', JSON.stringify(summary));
  // 로그를 Firebase에 남기기 (감사용)
  try {
    await fetch(FB + '/maintenance/cleanupLog.json', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ts: Date.now(), cutoff: cutoffStr, summary })
    });
  } catch (e) {}
}

async function sendMessage(env, token, message) {
  const url = 'https://www.worksapis.com/v1.0/bots/' + env.NW_BOT_ID + '/channels/' + env.NW_CHANNEL_ID + '/messages';
  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json' },
    body: JSON.stringify(message)
  });
  if (!resp.ok) throw new Error('Send failed: ' + resp.status + ' ' + (await resp.text()));
  return resp;
}

// 고객 상담 현장메모 AI 다듬기 — Claude(haiku)로 핸드 복붙용 요약 생성.
// env.ANTHROPIC_API_KEY 필요. 프론트는 WEBHOOK_SECRET 으로 인증.
/* ═══ 인턴 내수 송금 캡처 판독 ═══
   클라이언트가 900px 로 줄인 캡처(base64)를 보내면 Claude 비전으로 읽어서
   금액·받는계좌·보낸사람·이체일시를 뽑고, 신청 내용과 대조한 결과를 돌려준다.
   판독은 '참고'용이다 — 확인 처리는 반드시 사람이 한다. */
const NAESU_SYS =
  '너는 한국 은행·송금 앱의 "이체 완료" 화면을 읽는 판독기다.\n' +
  '이미지에 실제로 적힌 값만 읽어서 JSON 객체 하나만 출력한다. 설명·마크다운·코드펜스 금지.\n\n' +
  '{"isTransfer":true,"amount":159390,"toAccount":"3333-27-5577737","toBank":"카카오뱅크",' +
  '"toName":"김세운","sender":"김민경","when":"2026-09-18 18:24","confidence":0.95}\n\n' +
  '규칙:\n' +
  '- 화면에 없는 값은 null. 절대 추측하거나 지어내지 않는다.\n' +
  '- amount 는 "보낸 금액/이체 금액/출금액"이다. 잔액·수수료·한도는 절대 쓰지 않는다. 쉼표를 뺀 정수로 쓴다.\n' +
  '- toAccount 는 받는 계좌번호만. 숫자와 하이픈만 남긴다.\n' +
  '- sender 는 보낸 사람(출금 계좌 주인) 이름이다. 받는 사람과 헷갈리지 않는다.\n' +
  '- when 은 이체 일시를 "YYYY-MM-DD HH:MM" 로 쓴다. 연도가 없으면 null.\n' +
  '- 이체·송금 완료 화면이 아니면 isTransfer=false 로 하고 나머지는 전부 null.\n' +
  '- 글자가 흐리거나 가려서 확신이 없으면 그 값은 null 로 두고 confidence 를 낮춘다.';

function naesuDigits(v) { return String(v == null ? '' : v).replace(/[^0-9]/g, ''); }

async function handleNaesuVerify(body, env) {
  const json = (obj, status) => new Response(JSON.stringify(obj), { status: status || 200, headers: { 'Content-Type': 'application/json' } });
  if (!body.secret || body.secret !== env.WEBHOOK_SECRET) return json({ ok: false, error: 'Unauthorized' }, 401);
  if (!env.ANTHROPIC_API_KEY) return json({ ok: false, error: 'AI 미설정 (ANTHROPIC_API_KEY 없음)' }, 503);

  // 이미지: 클라이언트가 줄여 보낸 base64 우선, 없으면 저장된 URL 에서 가져옴
  let b64 = (body.imageB64 || '').replace(/^data:image\/[a-z]+;base64,/, '');
  let mediaType = body.mediaType || 'image/jpeg';
  if (!b64) {
    const url = String(body.url || '');
    if (!/^https:\/\//.test(url)) return json({ ok: false, error: '판독할 이미지가 없어요' }, 400);
    const ir = await fetch(url, { cf: { cacheTtl: 300 } });
    if (!ir.ok) return json({ ok: false, error: '캡처를 불러오지 못했어요 (' + ir.status + ')' }, 502);
    mediaType = ir.headers.get('Content-Type') || 'image/jpeg';
    const buf = new Uint8Array(await ir.arrayBuffer());
    if (buf.byteLength > 4 * 1024 * 1024) return json({ ok: false, error: '캡처가 너무 커요' }, 413);
    let bin = '';
    for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode.apply(null, buf.subarray(i, i + 0x8000));
    b64 = btoa(bin);
  }

  const AIG = 'https://gateway.ai.cloudflare.com/v1/7a9ee76cb16dea27b9f46967c58e219d/dm-ai/anthropic/v1/messages';
  let data;
  try {
    const r = await fetch(AIG, {
      method: 'POST',
      headers: { 'x-api-key': env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json', 'accept': 'application/json', 'user-agent': 'dm-hq-naesu-verify/1.0' },
      body: JSON.stringify({
        model: 'claude-haiku-4-5', max_tokens: 400, system: NAESU_SYS,
        messages: [{ role: 'user', content: [
          { type: 'image', source: { type: 'base64', media_type: mediaType, data: b64 } },
          { type: 'text', text: '이 화면을 판독해서 JSON 하나만 출력해줘.' }
        ] }]
      })
    });
    if (!r.ok) return json({ ok: false, error: '판독 호출 실패 (' + r.status + ') ' + (await r.text()).slice(0, 160) }, 502);
    data = await r.json();
  } catch (e) {
    return json({ ok: false, error: '판독 실패: ' + (e && e.message || e) }, 502);
  }

  let text = '';
  if (data && Array.isArray(data.content)) data.content.forEach((b) => { if (b && b.type === 'text') text += b.text; });
  const m = text.match(/\{[\s\S]*\}/);
  let read;
  try { read = JSON.parse(m ? m[0] : text); }
  catch (e) { return json({ ok: false, error: '판독 결과를 해석하지 못했어요', raw: text.slice(0, 300) }, 502); }

  const amount = (read.amount == null || isNaN(+read.amount)) ? null : Math.round(+read.amount);
  const expect = (body.expectAmount == null || isNaN(+body.expectAmount)) ? null : Math.round(+body.expectAmount);
  const acctRead = naesuDigits(read.toAccount);
  const acctWant = naesuDigits(body.expectAcct);

  return json({
    ok: true,
    read: {
      isTransfer: read.isTransfer !== false,
      amount: amount,
      toAccount: read.toAccount || null,
      toBank: read.toBank || null,
      toName: read.toName || null,
      sender: read.sender || null,
      when: read.when || null,
      confidence: (read.confidence == null ? null : +read.confidence)
    },
    check: {
      amountMatch: (amount != null && expect != null) ? (amount === expect) : null,
      diff: (amount != null && expect != null) ? (expect - amount) : null,
      acctMatch: (acctRead && acctWant) ? (acctRead.slice(-8) === acctWant.slice(-8)) : null
    },
    usage: (data && data.usage) || null
  });
}

async function handleAIPolish(body, env) {
  const json = (obj, status) => new Response(JSON.stringify(obj), { status: status || 200, headers: { 'Content-Type': 'application/json' } });
  if (!body.secret || body.secret !== env.WEBHOOK_SECRET) return json({ ok: false, error: 'Unauthorized' }, 401);
  if (!env.ANTHROPIC_API_KEY) return json({ ok: false, error: 'AI 미설정 (ANTHROPIC_API_KEY 없음)' }, 503);
  const raw = (body.raw == null ? '' : String(body.raw)).trim();
  if (!raw) return json({ ok: false, error: '내용이 비어 있어요' }, 400);
  const dateStr = (body.date == null ? '' : String(body.date)).trim() || 'YY.MM.DD';
  const sys =
    '너는 헤어샵 디자이너의 상담 메모를 정리하는 도우미야. 디자이너가 상담하면서 빠르게 단어·핵심만 적은 메모를 받아서, 핸드(POS)에 붙여넣을 깔끔한 한국어 상담 요약으로 다듬어.\n\n' +
    '규칙:\n' +
    '- 맨 앞에 날짜를 "' + dateStr + ' - " 형식으로 먼저 쓴다.\n' +
    '- 항목들은 " / "(공백 슬래시 공백)로 구분한다.\n' +
    '- 적힌 단어를 자연스러운 짧은 구/문장으로 다듬되, 없는 내용을 절대 지어내지 않는다.\n' +
    '- 헤어 전문 용어(레이어, 홀슈, 질감처리, 스퀘어레이어 등)는 그대로 살린다.\n' +
    '- 인사말·설명·군더더기 없이 정리된 요약문 한 줄만 출력한다.\n\n' +
    '예시 입력: "하이레이어 / 미들구간 홀슈 질감 / 끝선 가벼운거 / 스퀘어레이어 선호"\n' +
    '예시 출력: "26.06.22 - 하이레이어 / 미들구간과 홀슈 위주로 질감처리 진행 / 끝선 무거운 것보다 가벼운 것 선호 / 라운드레이어보다 스퀘어레이어 선호"';
  try {
    // Cloudflare Worker에서 api.anthropic.com 직접 호출은 엣지에서 403 차단됨.
    // → Cloudflare AI Gateway(dm-ai, 인증 OFF) 경유로 프록시.
    const AIG = 'https://gateway.ai.cloudflare.com/v1/7a9ee76cb16dea27b9f46967c58e219d/dm-ai/anthropic/v1/messages';
    const r = await fetch(AIG, {
      method: 'POST',
      headers: { 'x-api-key': env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json', 'accept': 'application/json', 'user-agent': 'dm-hq-consult-relay/1.0' },
      body: JSON.stringify({ model: 'claude-haiku-4-5', max_tokens: 1024, system: sys, messages: [{ role: 'user', content: raw }] })
    });
    if (!r.ok) return json({ ok: false, error: 'AI 호출 실패 (' + r.status + ') ' + (await r.text()).slice(0, 160) }, 502);
    const data = await r.json();
    let text = '';
    if (data && Array.isArray(data.content)) data.content.forEach((b) => { if (b && b.type === 'text') text += b.text; });
    return json({ ok: true, text: text.trim() });
  } catch (e) {
    return json({ ok: false, error: 'AI 오류: ' + (e && e.message || e) }, 500);
  }
}

async function handleAIRecommend(body, env) {
  const json = (obj, status) => new Response(JSON.stringify(obj), { status: status || 200, headers: { 'Content-Type': 'application/json' } });
  if (!body.secret || body.secret !== env.WEBHOOK_SECRET) return json({ ok: false, error: 'Unauthorized' }, 401);
  if (!env.ANTHROPIC_API_KEY) return json({ ok: false, error: 'AI 미설정' }, 503);
  const summary = (body.summary == null ? '' : String(body.summary)).trim();
  const products = Array.isArray(body.products) ? body.products : [];
  if (!summary) return json({ ok: false, error: '진단 정보가 비어 있어요' }, 400);
  if (!products.length) return json({ ok: false, error: '제품이 없어요' }, 400);
  const langName = ({ ko: '한국어', en: 'English', zh: '中文', ja: '日本語' })[body.lang] || '한국어';
  const list = products.slice(0, 80).map((p, i) => {
    const nm = String(p.name || '').slice(0, 80);
    const pr = p.price ? ' (' + String(p.price).slice(0, 30) + ')' : '';
    const ds = p.desc ? ' — ' + String(p.desc).slice(0, 200) : '';
    return (i + 1) + '. ' + nm + pr + ds;
  }).join('\n');
  const sys =
    '너는 헤어샵의 제품 추천 상담가야. 고객의 모발·두피 진단 결과와 매장 전판 제품 목록을 받아서, 그 고객에게 가장 잘 맞는 제품 2~3개를 골라 추천해.\n\n' +
    '규칙:\n' +
    '- 반드시 아래 "제품 목록"에 있는 제품만 추천한다. 목록에 없는 제품은 절대 만들지 않는다.\n' +
    '- 제품명은 목록에 적힌 그대로(정확히) 쓴다.\n' +
    '- 각 제품마다 이 고객에게 왜 맞는지 1~2문장으로 따뜻하고 전문가답게 설명한다.\n' +
    '- 진단에 맞는 제품이 부족하면 1~2개만 추천해도 된다.\n' +
    '- 모든 문장은 ' + langName + '(으)로 쓴다.\n' +
    '- 출력은 오직 JSON만. 형식: {"intro":"한두 문장 요약","items":[{"name":"정확한 제품명","reason":"추천 이유"}]}\n' +
    '- JSON 외 다른 텍스트(설명, 코드펜스)는 절대 출력하지 않는다.';
  const userMsg = '고객 진단 결과: ' + summary + '\n\n제품 목록:\n' + list;
  try {
    const AIG = 'https://gateway.ai.cloudflare.com/v1/7a9ee76cb16dea27b9f46967c58e219d/dm-ai/anthropic/v1/messages';
    const r = await fetch(AIG, {
      method: 'POST',
      headers: { 'x-api-key': env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json', 'accept': 'application/json', 'user-agent': 'dm-hq-consult-relay/1.0' },
      body: JSON.stringify({ model: 'claude-haiku-4-5', max_tokens: 900, system: sys, messages: [{ role: 'user', content: userMsg }] })
    });
    if (!r.ok) return json({ ok: false, error: 'AI 호출 실패 (' + r.status + ') ' + (await r.text()).slice(0, 160) }, 502);
    const data = await r.json();
    let text = '';
    if (data && Array.isArray(data.content)) data.content.forEach((b) => { if (b && b.type === 'text') text += b.text; });
    text = text.trim();
    const s = text.indexOf('{'), e = text.lastIndexOf('}');
    if (s < 0 || e < 0) return json({ ok: false, error: 'AI 응답 형식 오류' }, 502);
    let parsed;
    try { parsed = JSON.parse(text.slice(s, e + 1)); }
    catch (pe) { return json({ ok: false, error: 'AI 응답 파싱 실패' }, 502); }
    const names = {};
    products.forEach((p) => { names[String(p.name || '').trim()] = true; });
    const items = (Array.isArray(parsed.items) ? parsed.items : [])
      .filter((it) => it && names[String(it.name || '').trim()])
      .slice(0, 3)
      .map((it) => ({ name: String(it.name).trim(), reason: String(it.reason || '').slice(0, 300) }));
    return json({ ok: true, intro: String(parsed.intro || '').slice(0, 400), items: items });
  } catch (e) {
    return json({ ok: false, error: 'AI 오류: ' + (e && e.message || e) }, 500);
  }
}

// 봇 콜백 수신 — 봇이 들어간 채팅방의 channelId를 캡처해 Firebase에 저장.
// 새 알림 채팅방의 Channel ID를 알아내는 용도. 봇을 @멘션하면 콜백이 들어온다.
async function handleBotCallback(body, env) {
  const FB = env.FIREBASE_URL || FB_DEFAULT;
  const src = (body && body.source) || {};
  const channelId = src.channelId || null;
  const rec = {
    channelId: channelId,
    type: (body && body.type) || null,
    userId: src.userId || null,
    domainId: src.domainId || null,
    issuedTime: (body && body.issuedTime) || null,
    capturedAt: Date.now(),
    raw: body || null
  };

  // 채널 정보(이름/유형) 조회 — 확인용. 실패해도 무시.
  if (channelId) {
    try {
      const token = await getAccessToken(env);
      const r = await fetch('https://www.worksapis.com/v1.0/bots/' + env.NW_BOT_ID + '/channels/' + channelId, {
        headers: { 'Authorization': 'Bearer ' + token }
      });
      if (r.ok) rec.channelInfo = await r.json();
      else rec.channelInfoError = r.status + ' ' + (await r.text());
    } catch (e) { rec.channelInfoError = String(e); }
  }

  try {
    if (channelId) {
      await fetch(FB + '/debug/botChannels/' + encodeURIComponent(channelId) + '.json', {
        method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(rec)
      });
    }
    await fetch(FB + '/debug/lastCallback.json', {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(rec)
    });
  } catch (e) { console.log('callback store err', e); }

  return new Response(JSON.stringify({ ok: true }), { headers: { 'Content-Type': 'application/json' } });
}
