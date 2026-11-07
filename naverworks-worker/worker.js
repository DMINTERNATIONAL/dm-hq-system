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

/* ═══ RTDB 접근 ═══
   DB 를 보안 규칙으로 잠그면 무인증 호출이 401 이 된다. 서비스 계정 토큰을 붙여 부른다.
   FIREBASE_SA 가 없으면 예전처럼 무인증으로 간다 — 비밀을 넣기 전후 어느 쪽에서도
   휴게 자동종료·정리 작업이 멈추지 않게 하려는 것이다. */
let _saTok = null;
function _b64url(buf) {
  let s = ''; const b = new Uint8Array(buf);
  for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
let _saWarned = false;
async function saAccessToken(env) {
  if (!env || !env.FIREBASE_SA) {
    if (!_saWarned) { _saWarned = true; console.log('[rtdb] ⚠️ FIREBASE_SA 없음 — 무인증 접근(DB를 잠그면 401이 됩니다)'); }
    return null;
  }
  if (_saTok && _saTok.exp > Date.now() + 60000) return _saTok.v;
  const sa = JSON.parse(env.FIREBASE_SA);
  const now = Math.floor(Date.now() / 1000);
  const head = _b64url(new TextEncoder().encode(JSON.stringify({ alg: 'RS256', typ: 'JWT' })));
  const body = _b64url(new TextEncoder().encode(JSON.stringify({
    iss: sa.client_email,
    scope: 'https://www.googleapis.com/auth/firebase.database https://www.googleapis.com/auth/userinfo.email',
    aud: 'https://oauth2.googleapis.com/token', iat: now, exp: now + 3600,
  })));
  const raw = atob(sa.private_key.replace(/-----BEGIN[^-]+-----|-----END[^-]+-----/g, '').replace(/\s+/g, ''));
  const der = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) der[i] = raw.charCodeAt(i);
  const key = await crypto.subtle.importKey('pkcs8', der.buffer, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, new TextEncoder().encode(`${head}.${body}`));
  const r = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: `${head}.${body}.${_b64url(sig)}` }),
  });
  if (!r.ok) throw new Error(`서비스 계정 토큰 발급 실패 ${r.status}`);
  const j = await r.json();
  _saTok = { v: j.access_token, exp: Date.now() + (j.expires_in - 60) * 1000 };
  console.log(`[rtdb] 서비스 계정 인증 사용 (${sa.client_email})`);
  return _saTok.v;
}
/* path 에 이미 ?가 붙어 올 수 있어 구분자를 가려 쓴다 */
async function fbFetch(env, url, opts) {
  const t = await saAccessToken(env);
  if (t) url += (url.includes('?') ? '&' : '?') + 'access_token=' + t;
  return fetch(url, opts);
}
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
    /* DB 접근이 살아 있는지 확인용. 인증이 조용히 깨지면 휴게 자동종료와 정리 작업이
       아무 소리 없이 멈추기 때문에 바깥에서 찔러볼 수 있는 곳을 둔다. 데이터는 안 돌려준다. */
    if (pathname === '/health/db') {
      const FB = env.FIREBASE_URL || FB_DEFAULT;
      try {
        const r = await fbFetch(env, FB + '/breakActive.json?shallow=true', { cache: 'no-store' });
        return new Response(JSON.stringify({
          ok: r.ok, status: r.status,
          auth: env.FIREBASE_SA ? '서비스 계정' : '무인증',
        }), { status: r.ok ? 200 : 500, headers: { 'Content-Type': 'application/json' } });
      } catch (e) {
        return new Response(JSON.stringify({ ok: false, error: String(e && e.message || e) }),
          { status: 500, headers: { 'Content-Type': 'application/json' } });
      }
    }

    if (pathname === '/callback' || pathname.endsWith('/callback')) {
      return cors(await handleBotCallback(body, env));
    }

    // 고객 상담 현장메모 AI 다듬기 (Claude 프록시) — 키는 Worker env에만 보관
    if (pathname === '/ai/polish' || pathname.endsWith('/ai/polish')) {
      return cors(await withAi(body, await handleAIPolish(body, env)));
    }

    // 전판 제품 맞춤 추천 (진단 답 + 제품목록 → Claude가 추천+이유)
    // 채팅 '안 읽은 것 요약' — dm-contract-api 가 서비스 바인딩으로 부른다
    if (pathname === '/ai/chat-summary' || pathname.endsWith('/ai/chat-summary')) {
      return cors(await withAi(body, await handleAIChatSummary(body, env)));
    }
    // 인스타 AI 리포트 (디자이너 본인 · 경영팀 전체, Sonnet 5.5) — dm-contract-api 가 권한 확인 후 서비스 바인딩으로 부른다
    if (pathname === '/ai/ig-report' || pathname.endsWith('/ai/ig-report')) {
      return cors(await withAi(body, await handleAIIgReport(body, env)));
    }
    // 검색 노출(네이버 플레이스 · 구글) 주간 조사 — 웹 검색으로 기준 · 정책 변화를 찾고 이번 주 할 일을 쓴다 (dm-contract-api 가 매주 · 경영팀 요청 때 부른다)
    if (pathname === '/ai/seo-weekly' || pathname.endsWith('/ai/seo-weekly')) {
      return cors(await withAi(body, await handleAISeoWeekly(body, env)));
    }
    if (pathname === '/ai/recommend' || pathname.endsWith('/ai/recommend')) {
      return cors(await withAi(body, await handleAIRecommend(body, env)));
    }

    // 인턴 내수 — 송금 캡처 판독 (금액/계좌/보낸사람/이체일시 추출 + 신청내용 대조)
    if (pathname === '/ai/naesu-verify' || pathname.endsWith('/ai/naesu-verify')) {
      return cors(await withAi(body, await handleNaesuVerify(body, env)));
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
  const resp = await fbFetch(env, FB + '/breakActive.json', { cache: 'no-store' });
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
      await fbFetch(env, FB + '/break.json', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(record)
      });
    } catch (e) { console.log('break record err', e); continue; }

    // 2) /breakActive/{phone} 삭제
    try {
      await fbFetch(env, FB + '/breakActive/' + encodeURIComponent(phone) + '.json', {
        method: 'DELETE'
      });
    } catch (e) { console.log('breakActive del err', e); }

    // 3) /breakAutoEnded/{phone} 에 알림용 플래그 저장 (앱 다음 열 때 팝업)
    try {
      await fbFetch(env, FB + '/breakAutoEnded/' + encodeURIComponent(phone) + '.json', {
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
    const r = await fbFetch(env, FB + '/break.json', { cache: 'no-store' });
    const data = await r.json();
    if (data) {
      for (const id in data) {
        const rec = data[id];
        if (rec && rec.date && rec.date < cutoffStr) {
          await fbFetch(env, FB + '/break/' + id + '.json', { method: 'DELETE' });
          summary.break++;
        }
      }
    }
  } catch (e) { console.log('break cleanup err', e); }

  // 2) /meal/{uid}/{date} — meals
  try {
    const r = await fbFetch(env, FB + '/meal.json', { cache: 'no-store' });
    const data = await r.json();
    if (data) {
      for (const uid in data) {
        for (const date in data[uid]) {
          if (date < cutoffStr) {
            await fbFetch(env, FB + '/meal/' + encodeURIComponent(uid) + '/' + date + '.json', { method: 'DELETE' });
            summary.meal++;
          }
        }
      }
    }
  } catch (e) { console.log('meal cleanup err', e); }

  // 3) /late.json — keyed POST id, has .date
  try {
    const r = await fbFetch(env, FB + '/late.json', { cache: 'no-store' });
    const data = await r.json();
    if (data) {
      for (const id in data) {
        const rec = data[id];
        if (rec && rec.date && rec.date < cutoffStr) {
          await fbFetch(env, FB + '/late/' + id + '.json', { method: 'DELETE' });
          summary.late++;
        }
      }
    }
  } catch (e) { console.log('late cleanup err', e); }

  // 4) /practiceLog.json
  try {
    const r = await fbFetch(env, FB + '/practiceLog.json', { cache: 'no-store' });
    const data = await r.json();
    if (data) {
      for (const id in data) {
        const rec = data[id];
        if (rec && rec.date && rec.date < cutoffStr) {
          await fbFetch(env, FB + '/practiceLog/' + id + '.json', { method: 'DELETE' });
          summary.practiceLog++;
        }
      }
    }
  } catch (e) { console.log('practiceLog cleanup err', e); }

  // 5) /leave/requests
  try {
    const r = await fbFetch(env, FB + '/leave/requests.json', { cache: 'no-store' });
    const data = await r.json();
    if (data) {
      for (const id in data) {
        const rec = data[id];
        if (rec && rec.date && rec.date < cutoffStr) {
          await fbFetch(env, FB + '/leave/requests/' + id + '.json', { method: 'DELETE' });
          summary.leave++;
        }
      }
    }
  } catch (e) { console.log('leave cleanup err', e); }

  // 6) /education/logs
  try {
    const r = await fbFetch(env, FB + '/education/logs.json', { cache: 'no-store' });
    const data = await r.json();
    if (data) {
      for (const id in data) {
        const rec = data[id];
        if (rec && rec.date && rec.date < cutoffStr) {
          await fbFetch(env, FB + '/education/logs/' + id + '.json', { method: 'DELETE' });
          summary.eduLogs++;
        }
      }
    }
  } catch (e) { console.log('eduLogs cleanup err', e); }

  // 7) /orders/{brand}/{branch}/{id}
  try {
    const r = await fbFetch(env, FB + '/orders.json', { cache: 'no-store' });
    const data = await r.json();
    if (data) {
      for (const brand in data) {
        for (const branch in data[brand]) {
          for (const oid in data[brand][branch]) {
            const o = data[brand][branch][oid];
            if (o && o.date && o.date < cutoffStr) {
              await fbFetch(env, FB + '/orders/' + encodeURIComponent(brand) + '/' + encodeURIComponent(branch) + '/' + oid + '.json', { method: 'DELETE' });
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
    await fbFetch(env, FB + '/maintenance/cleanupLog.json', {
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

/* AI 사용량 기록용 — 각 AI 처리기가 Claude 답을 받은 직후 쓴 토큰 수를 body.__ai 에 적어 두면,
   withAi 가 돌려보내는 JSON 에 ai 칸으로 붙인다. 기록(저장·금액 계산)은 dm-contract-api 가 한다.
   답을 못 읽거나 거절돼도 토큰은 이미 쓴 것이라 그대로 붙인다. */
function aiMeter(body, data) {
  if (!body || !data || !data.usage) return;
  const u = data.usage;
  body.__ai = { m: String(data.model || ''), in: u.input_tokens || 0, out: u.output_tokens || 0,
    cr: u.cache_read_input_tokens || 0, cw: u.cache_creation_input_tokens || 0,
    ws: (u.server_tool_use && u.server_tool_use.web_search_requests) || 0 };   // 웹 검색 횟수 — 1,000번에 $10 따로 붙는다
}
async function withAi(body, resp) {
  if (!body || !body.__ai || !resp) return resp;
  try {
    const obj = await resp.clone().json();
    obj.ai = body.__ai;
    return new Response(JSON.stringify(obj), { status: resp.status, headers: { 'Content-Type': 'application/json' } });
  } catch (_) { return resp; }
}

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
    data = await r.json(); aiMeter(body, data);
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
    const data = await r.json(); aiMeter(body, data);
    let text = '';
    if (data && Array.isArray(data.content)) data.content.forEach((b) => { if (b && b.type === 'text') text += b.text; });
    return json({ ok: true, text: text.trim() });
  } catch (e) {
    return json({ ok: false, error: 'AI 오류: ' + (e && e.message || e) }, 500);
  }
}

/* 단체방 안 읽은 메시지를 몇 줄로 정리. 1:1 은 dm-contract-api 가 애초에 보내지 않는다.
   출력은 '- ' 로 시작하는 줄과, 나에게 확인·답이 필요한 것은 '! ' 로 시작하는 줄 — 그대로 잘라서 쓴다. */
async function handleAIChatSummary(body, env) {
  const json = (obj, status) => new Response(JSON.stringify(obj), { status: status || 200, headers: { 'Content-Type': 'application/json' } });
  if (!body.secret || body.secret !== env.WEBHOOK_SECRET) return json({ ok: false, error: 'Unauthorized' }, 401);
  if (!env.ANTHROPIC_API_KEY) return json({ ok: false, error: 'AI 미설정' }, 503);
  const msgs = Array.isArray(body.messages) ? body.messages.slice(-300) : [];
  if (!msgs.length) return json({ ok: true, lines: [], asks: [] });
  const me = String(body.me || '').slice(0, 20);
  const convo = msgs.map((m) => `${String(m.bn || '').slice(0, 20)}${m.me ? ' (나를 부름)' : ''}: ${String(m.x || '').replace(/\s+/g, ' ').slice(0, 400)}`).join('\n');
  const sys =
    '너는 헤어살롱 회사 직원 단체 채팅방의 안 읽은 메시지를 요약하는 도우미야. 읽는 사람은 "' + me + '"이고, 며칠 만에 들어와서 핵심만 빨리 알고 싶어 해.\n\n' +
    '규칙:\n' +
    '- 결정된 것, 해야 할 일, 날짜·수량·품목 같은 구체적인 내용을 우선한다. 잡담과 인사는 뺀다.\n' +
    '- 한 줄에 하나씩, 최대 6줄. 각 줄은 "- " 로 시작하고 누가 말했는지 괄호로 붙인다. 예: "- 내일 발주에 3SI 4개, 6MNV 2개 추가 (건아)"\n' +
    '- ' + me + '에게 확인이나 답을 요청한 것이 있으면 따로 "! " 로 시작하는 줄로 쓴다(최대 3줄). 없으면 쓰지 않는다.\n' +
    '- 메시지에 없는 내용을 지어내지 않는다. 다른 설명이나 머리말 없이 줄만 출력한다.';
  try {
    // api.anthropic.com 직접 호출은 엣지에서 403 → Cloudflare AI Gateway(dm-ai) 경유 (handleAIPolish 와 같음)
    const AIG = 'https://gateway.ai.cloudflare.com/v1/7a9ee76cb16dea27b9f46967c58e219d/dm-ai/anthropic/v1/messages';
    const r = await fetch(AIG, {
      method: 'POST',
      headers: { 'x-api-key': env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json', 'accept': 'application/json', 'user-agent': 'dm-hq-chat-summary/1.0' },
      /* Sonnet 5.5 — Opus 5.5 의 절반 값(11/8 사용자 결정). 요약은 어렵지 않은 일이라 충분하다.
         다른 모델로 넘어가는 fallback 은 끔 — 비싼 모델로 넘어가지 않게 (인스타 리포트와 같음) */
      body: JSON.stringify({
        model: 'claude-sonnet-5-5', max_tokens: 1500,
        system: sys,
        messages: [{ role: 'user', content: '방 이름: ' + String(body.room || '').slice(0, 40) + '\n\n' + convo }],
      }),
    });
    if (!r.ok) return json({ ok: false, error: 'AI 호출 실패 (' + r.status + ') ' + (await r.text()).slice(0, 160) }, 502);
    const data = await r.json(); aiMeter(body, data);
    if (data && data.stop_reason === 'refusal') return json({ ok: false, error: '이 대화는 요약할 수 없어요' }, 200);
    let text = '';
    if (data && Array.isArray(data.content)) data.content.forEach((b) => { if (b && b.type === 'text') text += b.text; });
    const rows = text.split('\n').map((l) => l.trim());
    return json({ ok: true,
      lines: rows.filter((l) => l.startsWith('- ')).map((l) => l.slice(2)).slice(0, 6),
      asks: rows.filter((l) => l.startsWith('! ')).map((l) => l.slice(2)).slice(0, 3) });
  } catch (e) {
    return json({ ok: false, error: 'AI 오류: ' + (e && e.message || e) }, 500);
  }
}

/* 인스타 AI 리포트. 숫자는 dm-contract-api 가 DB 에서 뽑아 글로 정리해 보낸다(facts). 여기서는 읽고 쓰기만 한다.
   mode: 'person' = 한 사람(본인) 주간 리포트 + 다음 콘텐츠 아이디어 / 'team' = 경영팀용 전체 리포트 */
/* ═══ 검색 노출 주간 조사 ═══
   Sonnet 5.5 + 웹 검색 · 웹 읽기(서버 도구). 검색 결과를 기다리는 동안 연결이 끊기지 않게 stream 으로 받고,
   서버 도구 반복이 한도에 걸리면(pause_turn) 받은 내용을 그대로 다시 보내 이어 가게 한다(최대 4번). */
async function claudeStream(env, req) {
  const AIG = 'https://gateway.ai.cloudflare.com/v1/7a9ee76cb16dea27b9f46967c58e219d/dm-ai/anthropic/v1/messages';
  const r = await fetch(AIG, {
    method: 'POST',
    headers: { 'x-api-key': env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json', 'accept': 'text/event-stream', 'user-agent': 'dm-hq-seo/1.0' },
    body: JSON.stringify({ ...req, stream: true }),
  });
  if (!r.ok) throw new Error('AI 호출 실패 (' + r.status + ') ' + (await r.text()).slice(0, 200));
  const blocks = [], partial = {};
  let usage = {}, stop = null, model = req.model, buf = '';
  const dec = new TextDecoder();
  const onEvent = (ev) => {
    if (ev.type === 'message_start' && ev.message) { model = ev.message.model || model; usage = { ...(ev.message.usage || {}) }; }
    else if (ev.type === 'content_block_start') { blocks[ev.index] = JSON.parse(JSON.stringify(ev.content_block)); if (ev.content_block && 'input' in ev.content_block) partial[ev.index] = ''; }
    else if (ev.type === 'content_block_delta') {
      const b = blocks[ev.index], d = ev.delta || {};
      if (!b) return;
      if (d.type === 'text_delta') b.text = (b.text || '') + d.text;
      else if (d.type === 'input_json_delta') partial[ev.index] = (partial[ev.index] || '') + (d.partial_json || '');
      else if (d.type === 'citations_delta') (b.citations = b.citations || []).push(d.citation);
      else if (d.type === 'thinking_delta') b.thinking = (b.thinking || '') + d.thinking;
      else if (d.type === 'signature_delta') b.signature = d.signature;
    } else if (ev.type === 'content_block_stop') {
      if (ev.index in partial) { try { blocks[ev.index].input = partial[ev.index] ? JSON.parse(partial[ev.index]) : {}; } catch (_) { blocks[ev.index].input = {}; } delete partial[ev.index]; }
    } else if (ev.type === 'message_delta') { if (ev.delta && ev.delta.stop_reason) stop = ev.delta.stop_reason; if (ev.usage) usage = { ...usage, ...ev.usage }; }
    else if (ev.type === 'error') throw new Error('AI 오류: ' + ((ev.error && ev.error.message) || '').slice(0, 200));
  };
  const reader = r.body.getReader();
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let i;
    while ((i = buf.indexOf('\n\n')) >= 0) {
      const chunk = buf.slice(0, i); buf = buf.slice(i + 2);
      const data = chunk.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trim()).join('');
      if (data) onEvent(JSON.parse(data));
    }
  }
  return { content: blocks.filter(Boolean), stop_reason: stop, usage, model };
}
async function handleAISeoWeekly(body, env) {
  const json = (obj, status) => new Response(JSON.stringify(obj), { status: status || 200, headers: { 'Content-Type': 'application/json' } });
  if (!body.secret || body.secret !== env.WEBHOOK_SECRET) return json({ ok: false, error: 'Unauthorized' }, 401);
  if (!env.ANTHROPIC_API_KEY) return json({ ok: false, error: 'AI 미설정' }, 503);
  const facts = String(body.facts || '').slice(0, 40000);
  const sys = '너는 한국 헤어살롱 회사(DAY:MEAN · ETOH, 서울 마포 · 합정 · 홍대 권역)의 지역 검색 노출 담당 연구원이야. 회사의 목표는 "예약을 늘리는 것"이고, 네이버 플레이스(스마트플레이스 · 네이버 예약)와 구글 비즈니스 프로필(구글 지도)의 검색 노출은 그 수단이다. 매주 한 번, 노출 기준 · 정책 변화를 조사하고 우리 숫자를 읽어서, 경영팀이 이번 주에 바로 할 수 있는 일로 정리한다. 경영팀은 마케팅 전문가가 아니다.\n\n' +
    '예약이 먼저:\n' +
    '- 예약은 "노출(검색에서 보이기) × 전환(본 사람이 예약하기)"이다. 할 일마다 kind 를 "노출" 또는 "예약 전환"으로 표시하고, 예상되는 예약 증가가 큰 순서로 정렬한다. 노출이 이미 충분한데 전환이 낮으면 전환 일을 먼저 낸다.\n' +
    '- 전환을 올리는 일의 예: 첫 화면 대표 사진 · 스타일 사진, 가격 · 시간이 분명한 메뉴와 예약 상품, 디자이너 소개 · 포트폴리오, 리뷰 답글, 예약 버튼을 네이버 예약으로 모으기, 첫 방문 쿠폰 같은 네이버 공식 혜택 기능. 예약 가능 시간 · 빈자리처럼 운영과 얽힌 건 "매장과 상의"라고 쓴다.\n' +
    '- [예약 전환] 숫자(조회 · 예약 · 전환율)와 [숫자]의 신규일반(소개 없이 온 새 손님) 추이로 지난주 적용한 일이 효과가 있었는지 조심스럽게 평가한다. 시즌 · 휴무 · 디자이너 사정 등 다른 이유가 있을 수 있으니 단정하지 않는다. 기록이 없으면 기록부터 하자고 한다.\n' +
    '- 검색량이 큰 검색어를 우선 노리고, 유행이 오르는 시술은 메뉴 · 소식 글 앞쪽에 둔다. 숫자는 데이터에 있는 것만 쓰고 지어내지 않는다.\n' +
    '- 스마트플레이스 통계 캡처 사진이 함께 오면 읽어서(유입 키워드 · 조회 · 예약 등) 근거로 쓴다. 안 읽히면 그렇다고 한다.\n\n' +
    '조사 방법:\n' +
    '- 웹 검색을 꼭 한다. 공식 출처를 먼저 찾는다: 네이버 스마트플레이스 공지 · 고객센터, 네이버 검색 공식 블로그 · 네이버 다이어리, 네이버 예약 공지, Google 비즈니스 프로필 고객센터, Google Search Central 블로그. 그다음 최근 뉴스(대략 최근 2~3주)와 업계 글을 본다.\n' +
    '- 공식 발표와 마케팅 업체 · 블로그의 주장을 반드시 구분한다(official). 업계 글만 있는 내용은 "확인 중인 소문"(watch)으로 보낸다. 출처 없는 내용은 쓰지 않는다.\n' +
    '- 데이터의 [지난 리포트] 에 이미 있는 변화는 다시 "바뀐 점"으로 쓰지 않는다. 새로 바뀐 게 없으면 changes 를 빈 배열로 두고 headline 에 "이번 주 새로 바뀐 공식 기준은 없어요"처럼 솔직하게 쓴다.\n' +
    '- 데이터에 우리 매장 네이버 플레이스 · 구글 지도 주소가 있으면 웹 읽기로 열어 보고, 읽히는 내용(소개글 · 메뉴 · 사진 수 · 리뷰 수 · 소식 날짜 등)으로 빠진 것을 찾는다. 안 읽히면 그렇다고 하고 일반 점검 항목을 준다. 지어내지 않는다.\n\n' +
    '할 일(todo) 규칙:\n' +
    '- 이번 주에 할 일 최대 6개, 효과가 큰 순서. 지난주 할 일 중 아직 안 한 것이 여전히 중요하면 다시 넣는다(why 에 "지난주에 이어서").\n' +
    '- 매장 이름은 데이터에 있는 이름 그대로, 모든 매장 공통이면 "전체".\n' +
    '- how 는 어디를 눌러 무엇을 하는지 단계로. 소개글 · 소식 글 · 리뷰 답글 · 키워드처럼 붙여넣을 수 있는 건 draft 에 완성된 한국어 문장으로 쓴다(그대로 붙여넣을 수 있게, 과장 · 최상급 · 의료 효능 표현 없이).\n' +
    '- 절대 권하지 않는 것: 가짜 · 대가성 리뷰, 리뷰 대행 · 영수증 조작, 트래픽 · 저장 · 클릭 작업, 순위 보장 업체, 경쟁 매장 비방. 네이버 · 구글 정책 위반은 노출 제재로 이어진다고 경고한다.\n\n' +
    '말투: 존댓말(해요체), 짧고 쉽게. 영어 용어는 피하거나 풀어서.\n' +
    '마지막에 다른 설명 없이 JSON 하나만 출력한다. 코드블록 표시(```)도 쓰지 않는다. 형식:\n' +
    '{"headline":"이번 주 한 줄 요약 (예약 관점)","pulse":"숫자로 본 이번 주 — 조회 · 예약 · 전환율 · 신규 손님 흐름 2~3문장 (숫자가 없으면 빈 문자열)","changes":[{"title":"바뀐 점","what":"무엇이 어떻게 바뀌었고 우리에게 무슨 뜻인지 2~3문장","impact":"high|mid|low","official":true,"date":"발표 · 보도 날짜(알면)","src":["출처 URL"]}],"todo":[{"branch":"매장 이름 또는 전체","kind":"노출|예약 전환","title":"할 일","why":"왜 (근거)","how":"단계별 방법","draft":"붙여넣을 글(없으면 빈 문자열)","time":"걸리는 시간(예: 10분)","src":["출처 URL"]}],"naver":[{"factor":"네이버 순위 요소","now":"지금 알려진 내용(공식인지 표시)","tip":"우리가 할 일 한 줄"}],"google":[{"factor":"구글 순위 요소","now":"지금 알려진 내용","tip":"우리가 할 일 한 줄"}],"watch":[{"title":"확인 중인 소문","why":"누가 주장하는지, 왜 아직 확인 안 됐는지"}],"sources":[{"title":"출처 제목","url":"URL"}]}\n' +
    '- changes 최대 6개, naver · google 각각 최대 8개, watch 최대 4개, sources 최대 20개.';
  const req = {
    model: 'claude-sonnet-5-5', max_tokens: 32000, system: sys,
    tools: [
      { type: 'web_search_20260209', name: 'web_search', max_uses: 14, user_location: { type: 'approximate', country: 'KR', city: 'Seoul', timezone: 'Asia/Seoul' } },
      { type: 'web_fetch_20260209', name: 'web_fetch', max_uses: 8 },
    ],
    messages: [{ role: 'user', content: (function () {
      /* 스마트플레이스 통계 캡처 (최대 3장) — 사진 앞에 설명 한 줄 */
      const imgs = (Array.isArray(body.images) ? body.images : []).filter((x) => x && /^image\/(jpeg|png|webp)$/.test(x.mt) && typeof x.b64 === 'string' && x.b64.length < 2400000).slice(0, 3);
      if (!imgs.length) return facts || '(데이터 없음)';
      const c = [];
      imgs.forEach((x) => { c.push({ type: 'text', text: '[사진] ' + String(x.label || '스마트플레이스 통계 캡처').slice(0, 80) }); c.push({ type: 'image', source: { type: 'base64', media_type: x.mt, data: x.b64 } }); });
      c.push({ type: 'text', text: facts || '(데이터 없음)' });
      return c;
    })() }],
  };
  const tot = { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, server_tool_use: { web_search_requests: 0 } };
  let res = null, model = req.model;
  try {
    for (let turn = 0; turn < 5; turn++) {
      res = await claudeStream(env, req);
      model = res.model || model;
      const u = res.usage || {};
      ['input_tokens', 'output_tokens', 'cache_read_input_tokens', 'cache_creation_input_tokens'].forEach((k) => { tot[k] += +u[k] || 0; });
      tot.server_tool_use.web_search_requests += +((u.server_tool_use && u.server_tool_use.web_search_requests) || 0);
      if (res.stop_reason !== 'pause_turn') break;
      req.messages = [req.messages[0], { role: 'assistant', content: res.content }];   // 그대로 다시 보내면 서버가 이어서 한다
    }
  } catch (e) {
    aiMeter(body, { model, usage: tot });
    return json({ ok: false, error: String((e && e.message) || e).slice(0, 300) }, 502);
  }
  aiMeter(body, { model, usage: tot });
  if (res.stop_reason === 'refusal') return json({ ok: false, error: '이번 조사는 AI 가 거절했어요' }, 200);
  /* 마지막 검색 결과 뒤에 쓴 글이 답 */
  let last = -1;
  res.content.forEach((b, i) => { if (b && /tool_result$|^server_tool_use$/.test(b.type)) last = i; });
  let text = '';
  res.content.slice(last + 1).forEach((b) => { if (b && b.type === 'text') text += b.text; });
  const a = text.indexOf('{'), z = text.lastIndexOf('}');
  let rep = null;
  try { rep = JSON.parse(text.slice(a, z + 1)); } catch (_) {}
  if (!rep || typeof rep !== 'object') return json({ ok: false, error: 'AI 답을 읽지 못했어요 (' + (res.stop_reason || '') + ')' }, 502);
  const S = (v, n) => String(v == null ? '' : v).trim().slice(0, n);
  const U = (v) => (Array.isArray(v) ? v : [v]).map((x) => S(x, 500)).filter((x) => /^https?:\/\//.test(x)).slice(0, 5);
  const A = (v, n) => (Array.isArray(v) ? v : []).filter((x) => x && typeof x === 'object').slice(0, n);
  const out = {
    headline: S(rep.headline, 300),
    pulse: S(rep.pulse, 600),
    changes: A(rep.changes, 6).map((x) => ({ title: S(x.title, 160), what: S(x.what, 800), impact: ['high', 'mid', 'low'].indexOf(x.impact) >= 0 ? x.impact : 'mid', official: x.official === true, date: S(x.date, 40), src: U(x.src) })).filter((x) => x.title),
    todo: A(rep.todo, 6).map((x) => ({ branch: S(x.branch, 40) || '전체', kind: x.kind === '노출' ? '노출' : x.kind === '예약 전환' ? '예약 전환' : '', title: S(x.title, 160), why: S(x.why, 600), how: S(x.how, 1500), draft: S(x.draft, 2500), time: S(x.time, 30), src: U(x.src) })).filter((x) => x.title),
    naver: A(rep.naver, 8).map((x) => ({ factor: S(x.factor, 80), now: S(x.now, 600), tip: S(x.tip, 300) })).filter((x) => x.factor),
    google: A(rep.google, 8).map((x) => ({ factor: S(x.factor, 80), now: S(x.now, 600), tip: S(x.tip, 300) })).filter((x) => x.factor),
    watch: A(rep.watch, 4).map((x) => ({ title: S(x.title, 160), why: S(x.why, 600) })).filter((x) => x.title),
    sources: A(rep.sources, 20).map((x) => ({ title: S(x.title, 160), url: U(x.url)[0] || '' })).filter((x) => x.url),
  };
  out.searches = tot.server_tool_use.web_search_requests;
  return json({ ok: true, report: out });
}

async function handleAIIgReport(body, env) {
  const json = (obj, status) => new Response(JSON.stringify(obj), { status: status || 200, headers: { 'Content-Type': 'application/json' } });
  if (!body.secret || body.secret !== env.WEBHOOK_SECRET) return json({ ok: false, error: 'Unauthorized' }, 401);
  if (!env.ANTHROPIC_API_KEY) return json({ ok: false, error: 'AI 미설정' }, 503);
  const mode = body.mode === 'team' ? 'team' : 'person';
  const facts = String(body.facts || '').slice(0, 40000);
  if (!facts) return json({ ok: false, error: '분석할 데이터가 없어요' }, 400);
  const common =
    '- 아래 데이터에 있는 숫자와 사실만 근거로 쓴다. 데이터에 없는 수치(조회수 · 도달 · 저장 수 등)는 지어내지 않는다. 우리가 볼 수 있는 건 팔로워 · 게시 수 · 좋아요 · 댓글 · 릴스/피드 구분 · 게시 시각 · 게시글뿐이다.\n' +
    '- 존댓말(해요체)로, 짧고 구체적으로. 한 항목은 한두 문장. 숫자를 넣어 말한다(예: "지난주보다 게시 2개 줄었어요").\n' +
    '- 혼내는 말투가 아니라 같이 성장하자는 코치 말투. 잘한 건 확실히 칭찬한다.\n' +
    '- 표본이 적거나(게시 3개 미만) 기간이 짧으면 단정하지 말고 "아직 판단하기 이르다"고 말한다.\n' +
    '- 다른 설명 없이 JSON 하나만 출력한다. 코드블록 표시(```)도 쓰지 않는다.\n';
  const sys = mode === 'team'
    ? '너는 헤어살롱 회사(DAY:MEAN · 에토바버샵) 경영팀을 돕는 인스타그램 마케팅 분석가야. 디자이너 · 인턴 개인 인스타 계정 전체의 최근 2주 숫자를 받아, 경영팀이 이번 주에 무엇을 챙겨야 하는지 알려 준다.\n\n규칙:\n' + common +
      '- 사람 이름은 데이터에 있는 이름 그대로 쓴다.\n' +
      '- 출력 형식: {"headline":"전체 흐름 한 문장","highlights":["좋은 흐름 (최대 4개)"],"concerns":["챙겨야 할 것 — 게시가 끊긴 사람, 반응이 크게 떨어진 사람 등 (최대 4개)"],"spotlight":[{"name":"이름","why":"이번 주 칭찬하거나 사례로 공유할 이유"}],"actions":["경영팀이 이번 주에 할 일 3개"]}\n' +
      '- spotlight 는 최대 3명.'
    : '너는 헤어 디자이너 · 인턴의 개인 인스타그램을 키워 주는 마케팅 코치야. 한 사람의 최근 숫자와 게시물(글 포함)을 받아, 본인에게 주는 주간 리포트와 다음 주 콘텐츠 아이디어를 쓴다. 읽는 사람은 그 디자이너 본인이다.\n\n규칙:\n' + common +
      '- 반응이 좋았던 게시물과 안 좋았던 게시물의 차이(릴스/피드, 요일 · 시간대, 글 내용 · 길이 · 해시태그)를 데이터에서 찾아 말한다.\n' +
      '- 콘텐츠 아이디어는 이 사람이 지금까지 올린 게시물(글)에서 읽히는 시그니처 시술 · 스타일 · 자주 다루는 주제 · 분위기를 이어 가는 것으로만 낸다. 다른 디자이너에게도 똑같이 줄 수 있는 일반적인 아이디어는 쓰지 않는다. 각 아이디어에는 근거가 된 본인 게시물(날짜)을 밝힌다. 게시물 글이 없거나 너무 적으면 그렇다고 말한다.\n' +
      '- 올릴 글(캡션) 문장은 써 주지 않는다. 말투는 본인 것이어야 하므로 글은 본인이 쓴다. 아이디어는 무엇을 · 어떻게 찍을지까지만.\n' +
      '- 해시태그는 데이터의 [해시태그 후보] 목록에 있는 태그만 고른다. 목록에 없는 태그는 절대 만들지 않는다. lift 가 1보다 큰 태그, 이 사람 시그니처와 맞는 시술 · 지역 태그를 우선한다. 최근 24시간 게시가 50개 이상인 큰 태그는 금방 묻히므로 많아야 1~2개만. "본인이 고른 참고 계정" 태그는 이 사람이 직접 고른 롤모델이 쓴 태그라 가장 먼저 고르고, why 에 "직접 고른 참고 계정 @아이디가 쓰고 반응이 좋았던 태그"처럼 근거를 쓴다. 회사 공통 참고 계정 태그는 이 사람 분야(시술 · 스타일)와 맞을 때만 고르고, why 에 "참고 계정 N곳이 쓰고 반응이 좋았던 태그"처럼 근거를 쓴다. 후보가 없으면 빈 배열.\n' +
      '- 출력 형식: {"headline":"이번 주 한 줄 요약","good":["잘한 점 (최대 3개)"],"improve":["아쉬운 점 (최대 3개)"],"try":["다음 주에 해볼 것 3개 — 언제 · 무엇을 · 몇 개"],"ideas":[{"title":"콘텐츠 아이디어 제목","why":"이 사람에게 맞는 이유 — 근거 게시물(날짜)과 반응","how":"찍는 방법 · 구성 (릴스면 장면 순서) 2~3줄"}],"hashtags":[{"tag":"#태그","why":"고른 이유 (lift · 최근 게시 수 등 근거)"}]}\n' +
      '- ideas 는 정확히 3개, hashtags 는 최대 8개.';
  try {
    const AIG = 'https://gateway.ai.cloudflare.com/v1/7a9ee76cb16dea27b9f46967c58e219d/dm-ai/anthropic/v1/messages';
    const r = await fetch(AIG, {
      method: 'POST',
      headers: { 'x-api-key': env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json', 'accept': 'application/json', 'user-agent': 'dm-hq-ig-report/1.0' },
      /* Sonnet 5.5 — Opus 5.5 의 절반 값, Haiku 보다 아이디어 · 글 품질이 낫다(11/8 사용자 결정). 리포트 한 건 약 40~90원.
         다른 모델로 넘어가는 fallback 은 끔 — 비싼 모델로 넘어가지 않게 */
      body: JSON.stringify({
        model: 'claude-sonnet-5-5', max_tokens: 6000,
        system: sys,
        messages: [{ role: 'user', content: facts }],
      }),
    });
    if (!r.ok) return json({ ok: false, error: 'AI 호출 실패 (' + r.status + ') ' + (await r.text()).slice(0, 160) }, 502);
    const data = await r.json(); aiMeter(body, data);
    if (data && data.stop_reason === 'refusal') return json({ ok: false, error: '이 데이터는 분석할 수 없어요' }, 200);
    let text = '';
    if (data && Array.isArray(data.content)) data.content.forEach((b) => { if (b && b.type === 'text') text += b.text; });
    const a = text.indexOf('{'), z = text.lastIndexOf('}');
    let rep = null;
    try { rep = JSON.parse(text.slice(a, z + 1)); } catch (_) {}
    if (!rep || typeof rep !== 'object') return json({ ok: false, error: 'AI 답을 읽지 못했어요. 잠시 뒤 다시 눌러 주세요' }, 502);
    const strs = (v, n) => (Array.isArray(v) ? v : []).map((x) => String(x == null ? '' : x).slice(0, 400)).filter(Boolean).slice(0, n);
    const out = { headline: String(rep.headline || '').slice(0, 300) };
    if (mode === 'team') {
      out.highlights = strs(rep.highlights, 4); out.concerns = strs(rep.concerns, 4); out.actions = strs(rep.actions, 3);
      out.spotlight = (Array.isArray(rep.spotlight) ? rep.spotlight : []).slice(0, 3).map((x) => ({ name: String((x && x.name) || '').slice(0, 30), why: String((x && x.why) || '').slice(0, 300) })).filter((x) => x.name);
    } else {
      out.good = strs(rep.good, 3); out.improve = strs(rep.improve, 3); out.try = strs(rep.try, 3);
      out.ideas = (Array.isArray(rep.ideas) ? rep.ideas : []).slice(0, 3).map((x) => ({
        title: String((x && x.title) || '').slice(0, 120), why: String((x && x.why) || '').slice(0, 400),
        how: String((x && x.how) || '').slice(0, 600),
      })).filter((x) => x.title);
      /* 태그는 dm-contract-api 가 후보 목록으로 한 번 더 거른다 */
      out.hashtags = (Array.isArray(rep.hashtags) ? rep.hashtags : []).slice(0, 8).map((x) => ({
        tag: String((x && x.tag) || '').trim().slice(0, 40), why: String((x && x.why) || '').slice(0, 200),
      })).filter((x) => /^#\S+$/.test(x.tag));
    }
    return json({ ok: true, report: out, model: String((data && data.model) || '') });
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
    const data = await r.json(); aiMeter(body, data);
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
      await fbFetch(env, FB + '/debug/botChannels/' + encodeURIComponent(channelId) + '.json', {
        method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(rec)
      });
    }
    await fbFetch(env, FB + '/debug/lastCallback.json', {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(rec)
    });
  } catch (e) { console.log('callback store err', e); }

  return new Response(JSON.stringify({ ok: true }), { headers: { 'Content-Type': 'application/json' } });
}
