/**
 * DM INTERNATIONAL — 계약서 · 수수료명세서 API (Phase 0 공통 기반)
 *
 * 왜 이 Worker가 있는가
 *   /contracts, /statements, /counters, /auditLogs 는 RTDB 보안 규칙으로 잠근다.
 *   브라우저는 그 경로를 직접 읽을 수 없고 반드시 이 Worker를 거친다.
 *   앱의 can()/systemGrade 는 화면 표시용이라 curl 한 줄로 우회된다.
 *   계약서·명세서는 개인 소득과 신상이 들어가므로 권한 판정을 서버에서 한다.
 *
 * 담당 범위 (Phase 0)
 *   - 로그인 → 서명 토큰 발급 / 검증
 *   - owner / manager / staff 역할 판정
 *   - 발행번호 원자적 채번 (동시 발행 시 중복 방지)
 *   - 마스터 데이터 변경 감사 로그
 */

const LOCKED = ['contracts', 'statements', 'counters', 'auditLogs'];
const ALLOWED_ORIGINS = [
  'https://dminternational.github.io',
  'http://localhost:8012',
  'http://127.0.0.1:8012',
];
const TOKEN_TTL_SEC = 12 * 60 * 60;   // 12시간

/* ═══ 공통 유틸 ═══ */
const enc = new TextEncoder();
function b64url(bytes) {
  let s = '';
  const b = new Uint8Array(bytes);
  for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]);
  return btoa(s).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}
function b64urlStr(str) { return b64url(enc.encode(str)); }
function b64urlDecode(s) {
  const p = s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4);
  return decodeURIComponent(Array.from(atob(p), c =>
    '%' + c.charCodeAt(0).toString(16).padStart(2, '0')).join(''));
}
function cors(origin) {
  const ok = ALLOWED_ORIGINS.includes(origin);
  return {
    'Access-Control-Allow-Origin': ok ? origin : ALLOWED_ORIGINS[0],
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type,Authorization',
    'Access-Control-Max-Age': '86400',
    'Vary': 'Origin',
  };
}
const json = (obj, status, origin) => new Response(JSON.stringify(obj), {
  status: status || 200,
  headers: { 'Content-Type': 'application/json', ...cors(origin) },
});

/* ═══ 서비스 계정 → Google 액세스 토큰 ═══ */
let _tok = null;
async function importKey(pem) {
  const body = pem.replace(/-----BEGIN[^-]+-----|-----END[^-]+-----/g, '').replace(/\s+/g, '');
  const bin = atob(body);
  const der = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) der[i] = bin.charCodeAt(i);
  return crypto.subtle.importKey('pkcs8', der.buffer,
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign']);
}
async function accessToken(env) {
  if (_tok && _tok.exp > Date.now() + 60000) return _tok.v;
  const sa = JSON.parse(env.FIREBASE_SA);
  const now = Math.floor(Date.now() / 1000);
  const input = b64urlStr(JSON.stringify({ alg: 'RS256', typ: 'JWT' })) + '.' + b64urlStr(JSON.stringify({
    iss: sa.client_email,
    scope: 'https://www.googleapis.com/auth/firebase.database https://www.googleapis.com/auth/userinfo.email',
    aud: 'https://oauth2.googleapis.com/token', iat: now, exp: now + 3600,
  }));
  const key = await importKey(sa.private_key);
  const sig = await crypto.subtle.sign({ name: 'RSASSA-PKCS1-v1_5' }, key, enc.encode(input));
  const r = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=' + encodeURIComponent(input + '.' + b64url(sig)),
  });
  if (!r.ok) throw new Error('구글 인증 실패 ' + r.status);
  const j = await r.json();
  _tok = { v: j.access_token, exp: Date.now() + (j.expires_in - 60) * 1000 };
  return _tok.v;
}

/* ═══ RTDB (서비스 계정 권한 — 보안 규칙 우회) ═══ */
async function dbGet(env, path) {
  const t = await accessToken(env);
  const r = await fetch(`${env.FIREBASE_URL}${path}.json?access_token=${t}`, { cache: 'no-store' });
  if (!r.ok) throw new Error('DB 읽기 실패 ' + r.status);
  return r.json();
}
async function dbPut(env, path, value) {
  const t = await accessToken(env);
  const r = await fetch(`${env.FIREBASE_URL}${path}.json?access_token=${t}`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(value),
  });
  if (!r.ok) throw new Error('DB 쓰기 실패 ' + r.status);
  return r.json();
}
async function dbPush(env, path, value) {
  const t = await accessToken(env);
  const r = await fetch(`${env.FIREBASE_URL}${path}.json?access_token=${t}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(value),
  });
  if (!r.ok) throw new Error('DB 추가 실패 ' + r.status);
  return r.json();     // { name: '-Oxxxx' }
}

/* ═══ 세션 토큰 (HMAC 서명) ═══ */
async function hmacKey(env) {
  return crypto.subtle.importKey('raw', enc.encode(env.SESSION_SECRET),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
}
async function signToken(env, payload) {
  const body = b64urlStr(JSON.stringify(payload));
  const sig = await crypto.subtle.sign('HMAC', await hmacKey(env), enc.encode(body));
  return body + '.' + b64url(sig);
}
async function verifyToken(env, token) {
  if (!token || token.indexOf('.') < 0) return null;
  const [body, sig] = token.split('.');
  const expect = b64url(await crypto.subtle.sign('HMAC', await hmacKey(env), enc.encode(body)));
  // 길이·내용 비교를 상수 시간에 가깝게
  if (sig.length !== expect.length) return null;
  let diff = 0;
  for (let i = 0; i < sig.length; i++) diff |= sig.charCodeAt(i) ^ expect.charCodeAt(i);
  if (diff !== 0) return null;
  let p;
  try { p = JSON.parse(b64urlDecode(body)); } catch (_) { return null; }
  if (!p.exp || p.exp < Math.floor(Date.now() / 1000)) return null;
  return p;
}

/* ═══ 역할 판정 ═══
   앱의 systemGrade 는 비어 있는 계정이 41/51 이라 그대로 못 쓴다.
   /contractRoles/{phone} 의 명시적 지정이 우선이고, 없으면 staff 다.
   기본을 staff 로 두면 새 기능이라 아무도 못 쓰는 상태에서 시작한다 — 안전한 방향. */
async function resolveRole(env, phone, user) {
  const explicit = await dbGet(env, '/contractRoles/' + phone).catch(() => null);
  if (explicit && explicit.role) return { role: explicit.role, branches: explicit.branches || [] };
  return { role: 'staff', branches: [] };
}

async function auditLog(env, entry) {
  return dbPush(env, '/auditLogs', { ...entry, at: Date.now() });
}

/* ═══ 발행번호 원자적 채번 ═══
   RTDB REST 의 ETag + if-match 로 compare-and-swap 한다.
   동시에 두 건을 발행해도 번호가 겹치지 않는다. */
async function nextNumber(env, counterId, pad = 4) {
  const t = await accessToken(env);
  const url = `${env.FIREBASE_URL}/counters/${encodeURIComponent(counterId)}.json?access_token=${t}`;
  for (let i = 0; i < 30; i++) {
    const g = await fetch(url, { headers: { 'X-Firebase-ETag': 'true' }, cache: 'no-store' });
    const etag = g.headers.get('ETag');
    const cur = await g.json();
    const seq = (typeof cur === 'number' ? cur : 0) + 1;
    const p = await fetch(url, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', 'if-match': etag },
      body: JSON.stringify(seq),
    });
    if (p.ok) return `${counterId}-${String(seq).padStart(pad, '0')}`;
    if (p.status !== 412) throw new Error('채번 실패 ' + p.status);
    // 경합 → 지수 백오프 + 지터. 같은 순간에 몰린 요청이 같은 간격으로 재충돌하지 않게 한다.
    const wait = Math.min(400, 20 * Math.pow(1.4, i)) * (0.5 + Math.random());
    await new Promise(r => setTimeout(r, wait));
  }
  throw new Error('채번 경합이 계속됩니다. 다시 시도해주세요.');
}

/* ═══ 라우팅 ═══ */
export default {
  async fetch(request, env) {
    const origin = request.headers.get('Origin') || '';
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, '') || '/';

    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors(origin) });

    try {
      /* 상태 확인 */
      if (path === '/' ) return json({ ok: true, service: 'dm-contract-api' }, 200, origin);

      /* 자체 점검 — 키·인증·DB 접근이 살아 있는지 (내용은 반환하지 않음) */
      if (path === '/selftest') {
        const sa = JSON.parse(env.FIREBASE_SA);
        await accessToken(env);
        await dbGet(env, '/naesuProducts/커리쉴/o');
        return json({
          ok: true, projectId: sa.project_id, googleAuth: 'ok', dbRead: 'ok',
          sessionSecretSet: !!env.SESSION_SECRET, lockedPaths: LOCKED,
        }, 200, origin);
      }

      /* 로그인 → 토큰 발급.
         비밀번호 대조를 브라우저가 아니라 여기서 한다. */
      if (path === '/auth/login' && request.method === 'POST') {
        const { phone, pw } = await request.json().catch(() => ({}));
        if (!phone || !pw) return json({ ok: false, error: '전화번호와 비밀번호가 필요합니다' }, 400, origin);
        const u = await dbGet(env, '/users/' + encodeURIComponent(String(phone)));
        if (!u || String(u.pw) !== String(pw)) return json({ ok: false, error: '전화번호 또는 비밀번호가 맞지 않습니다' }, 401, origin);
        if (u.status === '퇴사') return json({ ok: false, error: '퇴사 처리된 계정입니다' }, 403, origin);
        const { role, branches } = await resolveRole(env, String(phone), u);
        const now = Math.floor(Date.now() / 1000);
        const token = await signToken(env, {
          ph: String(phone), name: u.nick || u.name || '', role, branches,
          iat: now, exp: now + TOKEN_TTL_SEC,
        });
        return json({ ok: true, token, role, branches, expiresIn: TOKEN_TTL_SEC }, 200, origin);
      }

      /* 이하 인증 필요 */
      const bearer = (request.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '');
      const me = await verifyToken(env, bearer);
      if (!me) return json({ ok: false, error: '로그인이 필요합니다(토큰 없음/만료)' }, 401, origin);

      if (path === '/me') return json({ ok: true, me }, 200, origin);

      /* 발행번호 채번 — owner/manager 만 */
      if (path === '/counters/next' && request.method === 'POST') {
        if (me.role === 'staff') return json({ ok: false, error: '발행 권한이 없습니다' }, 403, origin);
        const { counterId, pad } = await request.json().catch(() => ({}));
        if (!counterId || !/^[A-Za-z0-9\-]{3,40}$/.test(counterId))
          return json({ ok: false, error: 'counterId 형식이 올바르지 않습니다' }, 400, origin);
        const number = await nextNumber(env, counterId, pad || 4);
        return json({ ok: true, number }, 200, origin);
      }

      return json({ ok: false, error: '없는 경로입니다' }, 404, origin);

    } catch (e) {
      return json({ ok: false, error: String((e && e.message) || e).slice(0, 200) }, 500, origin);
    }
  },
};
