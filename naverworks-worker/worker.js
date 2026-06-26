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

// 고객 상담 현장메모 AI 다듬기 — Claude(haiku)로 핸드 복붙용 요약 생성.
// env.ANTHROPIC_API_KEY 필요. 프론트는 WEBHOOK_SECRET 으로 인증.
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
