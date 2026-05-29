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

  let title;
  if (type === 'test') title = '✅ 테스트 메시지';
  else if (type === 'refund') title = '💰 환불 요청이 들어왔어요';
  else title = '🔔 새 발주가 들어왔어요!';

  let itemList = '';
  if (order.items && typeof order.items === 'object') {
    const items = Object.values(order.items);
    const top = items.slice(0, 5);
    itemList = top.map(it => '• ' + (it.name || '?') + ' ' + (it.qty || 0) + '개' + (it.unit ? ' (1주문=' + it.unit + '개)' : '')).join('\n');
    if (items.length > 5) itemList += '\n  ... 외 ' + (items.length - 5) + '건';
  }

  let text = title;
  if (type === 'test') {
    text += '\n\n네이버 웍스 봇 연결이 정상입니다 👍';
  } else {
    text += '\n\n' +
      '📍 ' + (order.brand || '') + ' ' + (order.branch || '') + '\n' +
      '👤 신청자: ' + (order.orderedBy || '') + '\n' +
      '📦 총 ' + (order.itemCount || 0) + '개 항목\n' +
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
