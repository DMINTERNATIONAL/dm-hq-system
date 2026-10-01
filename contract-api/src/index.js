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

const LOCKED = ['contracts', 'statements', 'counters', 'auditLogs', 'authSecrets'];
const ALLOWED_ORIGINS = [
  'https://dminternational.github.io',
  'http://localhost:8012',
  'http://127.0.0.1:8012',
];
const TOKEN_TTL_SEC = 12 * 60 * 60;        // 12시간
const REMEMBER_TTL_SEC = 30 * 24 * 60 * 60; // 로그인 유지 30일

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
    'Access-Control-Allow-Methods': 'GET,POST,DELETE,OPTIONS',
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
  if (value === undefined) throw new Error('DB 쓰기 거부: ' + path + ' 값이 undefined 입니다');
  const t = await accessToken(env);
  const r = await fetch(`${env.FIREBASE_URL}${path}.json?access_token=${t}`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(value),
  });
  if (!r.ok) throw new Error('DB 쓰기 실패 ' + r.status);
  return r.json();
}
async function dbDelete(env, path) {
  const t = await accessToken(env);
  const r = await fetch(`${env.FIREBASE_URL}${path}.json?access_token=${t}`, { method: 'DELETE' });
  if (!r.ok) throw new Error('DB 삭제 실패 ' + r.status);
  return true;
}
async function dbPush(env, path, value) {
  const t = await accessToken(env);
  const r = await fetch(`${env.FIREBASE_URL}${path}.json?access_token=${t}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(value),
  });
  if (!r.ok) throw new Error('DB 추가 실패 ' + r.status);
  return r.json();     // { name: '-Oxxxx' }
}

/* ═══ 비밀번호 ═══
   users 트리는 앱이 직접 읽어야 해서 공개로 둘 수밖에 없다. RTDB 규칙은 위에서
   아래로만 전파되므로 users/$ph/pw 만 따로 잠글 방법이 없다. 그래서 비밀번호는
   users 밖의 잠긴 경로(/authSecrets)로 빼고, 평문이 아니라 PBKDF2 해시로 둔다.
   이 Worker는 서비스 계정으로 붙으므로 규칙과 무관하게 읽고 쓴다. */
const PW_ITER = 100000;

function b64(bytes) {
  let s = '';
  const b = new Uint8Array(bytes);
  for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]);
  return btoa(s);
}
function unb64(str) {
  const bin = atob(str);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
async function pwDerive(pw, salt, iter) {
  const key = await crypto.subtle.importKey('raw', enc.encode(String(pw)), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt, iterations: iter, hash: 'SHA-256' }, key, 256);
  return b64(bits);
}
async function pwHash(pw) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  return { alg: 'pbkdf2-sha256', iter: PW_ITER, salt: b64(salt), hash: await pwDerive(pw, salt, PW_ITER), at: Date.now() };
}
/* 타이밍으로 글자가 새지 않게 길이·내용을 한 번에 비교한다 */
function sameStr(a, b) {
  a = String(a); b = String(b);
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}
async function pwVerify(rec, pw) {
  if (!rec || !rec.hash || !rec.salt) return false;
  return sameStr(rec.hash, await pwDerive(pw, unb64(rec.salt), +rec.iter || PW_ITER));
}
async function pwSet(env, phone, pw) {
  await dbPut(env, '/authSecrets/' + encodeURIComponent(String(phone)), await pwHash(pw));
}
/* 로그인 성공 시 호출. 아직 평문으로 남아 있으면 그 자리에서 해시로 바꾸고 평문을 지운다.
   한 번에 다 못 옮기더라도 쓰는 사람부터 저절로 정리된다. */
async function pwUpgrade(env, phone, pw) {
  try {
    await pwSet(env, phone, pw);
    await dbDelete(env, '/users/' + encodeURIComponent(String(phone)) + '/pw');
  } catch (e) { /* 전환 실패가 로그인을 막아서는 안 된다 */ }
}
/* 비밀번호를 남의 것까지 바꿀 수 있는 사람을 서버에서 판정한다.
   config/gradePerms 는 공개 경로라 조작될 수 있으므로 서버는 읽지 않는다.
   여기서 정한 경영팀·관리자가 상한이고, 그 안에서 화면 설정이 더 좁힐 수 있다. */
const PW_ADMIN_GRADES = ['경영팀', '관리자'];
async function canManageStaff(env, me) {
  if (me && me.role === 'owner') return true;
  const u = await dbGet(env, '/users/' + encodeURIComponent(String(me.ph))).catch(() => null);
  if (!u || u.status === '퇴사') return false;
  if (u.systemGrade) return PW_ADMIN_GRADES.indexOf(u.systemGrade) >= 0;
  /* systemGrade 가 없는 옛 계정은 본사 소속 + 경영팀/관리자 직급으로 본다 */
  return u.branch === '본사' && PW_ADMIN_GRADES.indexOf(u.role) >= 0;
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

/* ═══ 고유식별정보 차단 ═══
   주민등록번호는 문서 생성에만 쓰고 저장하지 않는다(개인정보보호법 §24).
   앱이 실수로 보내와도 서버에서 걷어내고, 걷어낸 사실을 감사 로그에 남긴다. */
const RRN_VALUE = /\b\d{6}\s*-\s*\d{7}\b/;
/* 부분문자열로 판정하면 안 된다 — /ssn/i 는 'businessName' 에 걸린다.
   카멜케이스·구분자로 쪼갠 뒤 단어 단위로 본다. */
function isSensitiveKey(k) {
  if (/resident|주민/i.test(k)) return true;
  return String(k).split(/[^A-Za-z가-힣]+|(?=[A-Z])/).some(w => /^(?:rrn|ssn)$/i.test(w));
}
function stripSensitive(v, hit) {
  if (Array.isArray(v)) return v.map(x => stripSensitive(x, hit));
  if (v && typeof v === 'object') {
    const out = {};
    for (const k of Object.keys(v)) {
      if (isSensitiveKey(k)) { hit.push(k); continue; }
      out[k] = stripSensitive(v[k], hit);
    }
    return out;
  }
  if (typeof v === 'string' && RRN_VALUE.test(v)) { hit.push('value'); return v.replace(RRN_VALUE, '******-*******'); }
  return v;
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
        const { phone, pw, remember } = await request.json().catch(() => ({}));
        if (!phone || !pw) return json({ ok: false, error: '전화번호와 비밀번호가 필요합니다' }, 400, origin);
        const ph = encodeURIComponent(String(phone));
        const u = await dbGet(env, '/users/' + ph);
        if (!u) return json({ ok: false, error: '전화번호 또는 비밀번호가 맞지 않습니다' }, 401, origin);

        /* 해시가 있으면 해시로, 아직 안 옮긴 계정은 평문으로 확인하고 그 자리에서 전환한다.
           전환 기간에 아무도 로그인 못 하는 구간이 생기지 않게 두 길을 다 연다. */
        const sec = await dbGet(env, '/authSecrets/' + ph).catch(() => null);
        let ok = false, upgrade = false;
        if (sec && sec.hash) ok = await pwVerify(sec, pw);
        else if (u.pw != null) { ok = sameStr(u.pw, pw); upgrade = ok; }
        if (!ok) return json({ ok: false, error: '전화번호 또는 비밀번호가 맞지 않습니다' }, 401, origin);
        if (u.status === '퇴사') return json({ ok: false, error: '퇴사 처리된 계정입니다' }, 403, origin);
        if (upgrade) await pwUpgrade(env, phone, pw);

        const { role, branches } = await resolveRole(env, String(phone), u);
        const now = Math.floor(Date.now() / 1000);
        /* 로그인 유지를 켜면 길게 준다. 예전에는 이걸 위해 평문 비밀번호를 폰에 저장해
           두고 만료될 때마다 다시 보냈는데, 토큰만 두면 그럴 필요가 없다. */
        const ttl = remember ? REMEMBER_TTL_SEC : TOKEN_TTL_SEC;
        const token = await signToken(env, {
          ph: String(phone), name: u.nick || u.name || '', role, branches,
          iat: now, exp: now + ttl,
        });
        delete u.pw;                 // 혹시 남아 있어도 내보내지 않는다
        return json({ ok: true, token, role, branches, expiresIn: ttl, user: u }, 200, origin);
      }

      /* 가입 신청 — 로그인 전이라 무인증. 비밀번호는 해시로만 들어간다.
         이미 쓰는 번호면 거부한다. 안 그러면 남의 번호로 신청해서 그 사람 비밀번호를 갈아치울 수 있다. */
      if (path === '/auth/signup' && request.method === 'POST') {
        const body = await request.json().catch(() => ({}));
        const phone = String(body.phone || '').trim();
        const pw = String(body.pw || '');
        const profile = body.profile || {};
        if (!/^[0-9]{8,12}$/.test(phone)) return json({ ok: false, error: '전화번호 형식이 올바르지 않습니다' }, 400, origin);
        if (pw.length < 4) return json({ ok: false, error: '비밀번호는 4자 이상이어야 합니다' }, 400, origin);
        const ph = encodeURIComponent(phone);
        const existing = await dbGet(env, '/users/' + ph).catch(() => null);
        if (existing) return json({ ok: false, error: '이미 등록된 전화번호입니다. 로그인해주세요.' }, 409, origin);
        const dup = await dbGet(env, '/pending/' + ph).catch(() => null);
        if (dup) return json({ ok: false, error: '이미 가입 신청이 접수되어 있습니다.' }, 409, origin);
        delete profile.pw;
        await dbPut(env, '/pending/' + ph, profile);
        await pwSet(env, phone, pw);
        return json({ ok: true }, 200, origin);
      }

      /* 이하 인증 필요 */
      const bearer = (request.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '');
      const me = await verifyToken(env, bearer);
      if (!me) return json({ ok: false, error: '로그인이 필요합니다(토큰 없음/만료)' }, 401, origin);
      me.phone = me.ph;   // 토큰에는 ph 로 들어 있다. 둘 다 쓰이므로 여기서 맞춰 둔다.

      if (path === '/me') return json({ ok: true, me }, 200, origin);

      /* 비밀번호 설정 — 본인이거나 직원 관리 권한자. 관리자 재발급·직원 직접 추가가 여기로 온다. */
      if (path === '/auth/setpw' && request.method === 'POST') {
        const { phone, newPw } = await request.json().catch(() => ({}));
        const target = String(phone || '').trim();
        if (!/^[0-9]{8,12}$/.test(target)) return json({ ok: false, error: '전화번호 형식이 올바르지 않습니다' }, 400, origin);
        if (String(newPw || '').length < 4) return json({ ok: false, error: '비밀번호는 4자 이상이어야 합니다' }, 400, origin);
        const self = target === String(me.ph);
        if (!self && !(await canManageStaff(env, me)))
          return json({ ok: false, error: '비밀번호를 변경할 권한이 없습니다' }, 403, origin);
        await pwSet(env, target, String(newPw));
        /* 옛 평문이 남아 있으면 같이 지운다. 안 지우면 바꾼 비밀번호와 따로 놀며 계속 노출된다. */
        await dbDelete(env, '/users/' + encodeURIComponent(target) + '/pw').catch(() => {});
        if (!self) await dbPush(env, '/auditLogs', {
          at: Date.now(), by: String(me.ph), byName: me.name || '', action: 'pw.reset', target,
        }).catch(() => {});
        return json({ ok: true }, 200, origin);
      }

      /* 본인 비밀번호 확인 — 시험 점수 수정처럼 민감한 동작 직전의 재확인용.
         남의 비밀번호는 확인해 주지 않는다(맞다/틀리다만 줘도 대입 통로가 된다). */
      if (path === '/auth/verify' && request.method === 'POST') {
        const { pw } = await request.json().catch(() => ({}));
        if (!pw) return json({ ok: false, error: '비밀번호가 필요합니다' }, 400, origin);
        const ph = encodeURIComponent(String(me.ph));
        const sec = await dbGet(env, '/authSecrets/' + ph).catch(() => null);
        let ok = false;
        if (sec && sec.hash) ok = await pwVerify(sec, pw);
        else {
          const u = await dbGet(env, '/users/' + ph).catch(() => null);
          if (u && u.pw != null) { ok = sameStr(u.pw, pw); if (ok) await pwUpgrade(env, String(me.ph), pw); }
        }
        return json({ ok: true, match: ok }, 200, origin);
      }

      /* 평문 비밀번호 일괄 전환 — 1회성. 멱등하므로 중간에 끊기면 다시 돌리면 된다. */
      if (path === '/auth/migrate' && request.method === 'POST') {
        if (!(await canManageStaff(env, me)))
          return json({ ok: false, error: '권한이 없습니다' }, 403, origin);
        const { dry } = await request.json().catch(() => ({}));
        const users = (await dbGet(env, '/users').catch(() => null)) || {};
        const out = { total: 0, 전환: 0, 이미됨: 0, 비밀번호없음: 0, 실패: [] };
        for (const phone of Object.keys(users)) {
          out.total++;
          const u = users[phone] || {};
          const ph = encodeURIComponent(phone);
          const sec = await dbGet(env, '/authSecrets/' + ph).catch(() => null);
          if (sec && sec.hash) {
            out.이미됨++;
            if (u.pw != null && !dry) await dbDelete(env, '/users/' + ph + '/pw').catch(() => {});
            continue;
          }
          if (u.pw == null) { out.비밀번호없음++; continue; }
          if (dry) { out.전환++; continue; }
          try { await pwSet(env, phone, String(u.pw)); await dbDelete(env, '/users/' + ph + '/pw'); out.전환++; }
          catch (e) { out.실패.push(phone + ': ' + e.message); }
        }
        return json({ ok: true, dry: !!dry, result: out }, 200, origin);
      }

      /* 지점 계약 기본값 수정 — owner 만. 변경 전후를 감사 로그에 남긴다.
         brands 는 외부 쓰기가 막혀 있어 이 경로가 유일한 수정 통로다. */
      if (path === '/branch/update' && request.method === 'POST') {
        if (me.role !== 'owner') return json({ ok: false, error: '마스터 데이터 수정 권한이 없습니다' }, 403, origin);
        const { brandId, branchId, patch, reason } = await request.json().catch(() => ({}));
        if (!brandId || !branchId || !patch || typeof patch !== 'object')
          return json({ ok: false, error: 'brandId / branchId / patch 가 필요합니다' }, 400, origin);
        if (!/^[a-z0-9\-]{2,40}$/.test(brandId) || !/^[a-z0-9\-]{2,40}$/.test(branchId))
          return json({ ok: false, error: 'id 형식이 올바르지 않습니다' }, 400, origin);

        const base = `/brands/${brandId}/branches/${branchId}`;
        const before = await dbGet(env, base);
        if (!before) return json({ ok: false, error: '지점을 찾을 수 없습니다' }, 404, origin);

        // patch 는 { 'contractDefaults.prepaidPolicy': 'onPayment' } 같은 점 표기를 받는다
        const changes = [];
        const next = JSON.parse(JSON.stringify(before));
        for (const key of Object.keys(patch)) {
          const parts = key.split('.');
          let cur = next, old = before;
          for (let i = 0; i < parts.length - 1; i++) {
            cur[parts[i]] = cur[parts[i]] || {};
            cur = cur[parts[i]];
            old = (old && old[parts[i]]) || {};
          }
          const leaf = parts[parts.length - 1];
          changes.push({ field: key, oldValue: old ? old[leaf] : null, newValue: patch[key] });
          cur[leaf] = patch[key];
        }
        next.updatedAt = new Date().toISOString().slice(0, 10);
        next.updatedBy = me.ph;
        await dbPut(env, base, next);
        for (const c of changes) {
          await auditLog(env, {
            kind: 'branch.update', by: me.phone,      // 다른 기록과 모양을 맞춘다
            targetType: 'branch', targetId: `${brandId}/${branchId}`,
            field: c.field, oldValue: c.oldValue === undefined ? null : c.oldValue,
            newValue: c.newValue, changedByName: me.name || '',
            reason: reason || null,
          });
        }
        return json({ ok: true, changes }, 200, origin);
      }

      /* 감사 로그 조회 — owner 만 */
      if (path === '/auditlogs' && request.method === 'GET') {
        if (me.role !== 'owner') return json({ ok: false, error: '조회 권한이 없습니다' }, 403, origin);
        const all = (await dbGet(env, '/auditLogs')) || {};
        const rows = Object.keys(all).map(k => ({ id: k, ...all[k] })).sort((a, b) => (b.at || 0) - (a.at || 0));
        return json({ ok: true, rows: rows.slice(0, 100) }, 200, origin);
      }

      /* 발행번호 채번 — owner/manager 만 */
      if (path === '/counters/next' && request.method === 'POST') {
        if (me.role === 'staff') return json({ ok: false, error: '발행 권한이 없습니다' }, 403, origin);
        const { counterId, pad } = await request.json().catch(() => ({}));
        if (!counterId || !/^[A-Za-z0-9\-]{3,40}$/.test(counterId))
          return json({ ok: false, error: 'counterId 형식이 올바르지 않습니다' }, 400, origin);
        const number = await nextNumber(env, counterId, pad || 4);
        return json({ ok: true, number }, 200, origin);
      }

      /* ═══ 계약서 발행 ═══
         확정 시점의 지점 설정·템플릿 버전·치환값을 통째로 스냅샷 저장한다.
         이후 지점 주소가 바뀌어도 이 계약서는 옛 주소로 다시 출력된다. */
      if (path === '/contracts' && request.method === 'POST') {
        if (me.role === 'staff') return json({ ok: false, error: '발행 권한이 없습니다' }, 403, origin);
        const body = await request.json().catch(() => null);
        if (!body) return json({ ok: false, error: '요청 본문을 읽지 못했습니다' }, 400, origin);
        const { brandId, branchId, templateVersion, values, staffName } = body;
        if (!brandId || !branchId) return json({ ok: false, error: '브랜드·지점이 필요합니다' }, 400, origin);
        if (!templateVersion) return json({ ok: false, error: '템플릿 버전이 필요합니다' }, 400, origin);
        if (!staffName || !String(staffName).trim()) return json({ ok: false, error: '계약자 성명이 필요합니다' }, 400, origin);

        const hit = [];
        const safeValues = stripSensitive(values || {}, hit);

        const branch = await dbGet(env, `/brands/${brandId}/branches/${branchId}`);
        if (!branch) return json({ ok: false, error: '지점을 찾을 수 없습니다' }, 404, origin);
        const brandDefaults = (await dbGet(env, `/brands/${brandId}/defaults`)) || {};

        const year = new Date().getFullYear();
        const number = await nextNumber(env, `${brandId.toUpperCase()}-${year}`, 4);

        /* 발행번호는 채번 후에 정해지므로 스냅샷에 여기서 박아 넣는다.
           그러지 않으면 재다운로드 때 문서번호 칸이 비어서 나온다. */
        if (safeValues.terms && typeof safeValues.terms === 'object') safeValues.terms.documentNumber = number;

        const rec = {
          number, brandId, branchId, templateVersion,
          staffName: String(staffName).trim(),
          status: 'issued',
          issuedAt: Date.now(),
          issuedBy: { phone: me.phone, name: me.name || '', role: me.role },
          snapshot: { branch, brandDefaults, values: safeValues },
        };
        const id = (await dbPush(env, '/contracts', rec)).name;   // dbPush 는 {name} 을 돌려준다
        await auditLog(env, { kind: 'contract.issue', by: me.phone, contractId: id, number,
          brandId, branchId, staffName: rec.staffName, stripped: hit.length ? hit : undefined });
        return json({ ok: true, id, number, contract: { id, ...rec }, stripped: hit }, 200, origin);
      }

      /* 계약서 목록 */
      if (path === '/contracts' && request.method === 'GET') {
        if (me.role === 'staff') return json({ ok: false, error: '조회 권한이 없습니다' }, 403, origin);
        const all = (await dbGet(env, '/contracts')) || {};
        const rows = Object.keys(all).map(k => {
          const c = all[k];
          return { id: k, number: c.number, brandId: c.brandId, branchId: c.branchId,
            staffName: c.staffName, status: c.status, issuedAt: c.issuedAt,
            issuedBy: (c.issuedBy || {}).name || '',
            startDate: (((c.snapshot || {}).values || {}).terms || {}).startDate || '',
            endDate: (((c.snapshot || {}).values || {}).terms || {}).endDate || '',
            voidReason: c.voidReason || '' };
        }).sort((a, b) => (b.issuedAt || 0) - (a.issuedAt || 0));
        return json({ ok: true, rows }, 200, origin);
      }

      /* 계약서 단건 — 재다운로드용 스냅샷 */
      if (/^\/contracts\/[A-Za-z0-9_-]+$/.test(path) && request.method === 'GET') {
        if (me.role === 'staff') return json({ ok: false, error: '조회 권한이 없습니다' }, 403, origin);
        const id = path.split('/')[2];
        const c = await dbGet(env, '/contracts/' + id);
        if (!c) return json({ ok: false, error: '계약서를 찾을 수 없습니다' }, 404, origin);
        await auditLog(env, { kind: 'contract.read', by: me.phone, contractId: id, number: c.number });
        return json({ ok: true, contract: { id, ...c } }, 200, origin);
      }

      /* 무효 처리 — owner 만. 수정이 아니라 void 후 재발행이다. */
      if (/^\/contracts\/[A-Za-z0-9_-]+\/void$/.test(path) && request.method === 'POST') {
        if (me.role !== 'owner') return json({ ok: false, error: '무효 처리는 대표만 가능합니다' }, 403, origin);
        const id = path.split('/')[2];
        const { reason } = await request.json().catch(() => ({}));
        if (!reason || String(reason).trim().length < 2) return json({ ok: false, error: '무효 사유를 적어주세요' }, 400, origin);
        const c = await dbGet(env, '/contracts/' + id);
        if (!c) return json({ ok: false, error: '계약서를 찾을 수 없습니다' }, 404, origin);
        if (c.status === 'void') return json({ ok: false, error: '이미 무효 처리된 계약서입니다' }, 400, origin);
        await dbPut(env, `/contracts/${id}/status`, 'void');
        await dbPut(env, `/contracts/${id}/voidReason`, String(reason).trim());
        await dbPut(env, `/contracts/${id}/voidedAt`, Date.now());
        await dbPut(env, `/contracts/${id}/voidedBy`, me.phone);
        await auditLog(env, { kind: 'contract.void', by: me.phone, contractId: id, number: c.number, reason: String(reason).trim() });
        return json({ ok: true }, 200, origin);
      }

      /* 카운터 삭제 — owner 만. 테스트로 만든 채번기를 지울 때 쓴다. */
      if (/^\/counters\/[A-Za-z0-9\-]{3,40}$/.test(path) && request.method === 'DELETE') {
        if (me.role !== 'owner') return json({ ok: false, error: '삭제 권한이 없습니다' }, 403, origin);
        const cid = path.split('/')[2];
        const used = (await dbGet(env, '/contracts')) || {};
        const inUse = Object.keys(used).some(k => String((used[k] || {}).number || '').startsWith(cid + '-'));
        if (inUse) return json({ ok: false, error: '이 채번기로 발행된 문서가 있어 지울 수 없습니다' }, 400, origin);
        await dbPut(env, '/counters/' + cid, null);
        await auditLog(env, { kind: 'counter.delete', by: me.phone, counterId: cid });
        return json({ ok: true }, 200, origin);
      }

      /* 무효 처리된 계약서 삭제 — owner 만.
         발행 상태인 문서는 지울 수 없다. 반드시 void 를 거쳐야 한다.
         지워도 감사 로그에는 남으므로 흔적 없는 삭제는 되지 않는다. */
      if (/^\/contracts\/[A-Za-z0-9_-]+$/.test(path) && request.method === 'DELETE') {
        if (me.role !== 'owner') return json({ ok: false, error: '삭제 권한이 없습니다' }, 403, origin);
        const id = path.split('/')[2];
        const c = await dbGet(env, '/contracts/' + id);
        if (!c) return json({ ok: false, error: '계약서를 찾을 수 없습니다' }, 404, origin);
        if (c.status !== 'void')
          return json({ ok: false, error: '무효 처리된 계약서만 지울 수 있습니다. 먼저 무효 처리하세요.' }, 400, origin);
        await dbPut(env, '/contracts/' + id, null);
        await auditLog(env, { kind: 'contract.delete', by: me.phone, contractId: id,
          number: c.number, staffName: c.staffName, voidReason: c.voidReason || '' });
        return json({ ok: true }, 200, origin);
      }

      /* 계약 모듈 역할 조회·지정 — owner 만.
         /contractRoles 는 보안 규칙으로 잠겨 있어 앱에서 직접 못 건드린다. */
      if (path === '/roles' && request.method === 'GET') {
        if (me.role !== 'owner') return json({ ok: false, error: '조회 권한이 없습니다' }, 403, origin);
        const all = (await dbGet(env, '/contractRoles')) || {};
        return json({ ok: true, roles: all }, 200, origin);
      }
      if (path === '/roles' && request.method === 'POST') {
        if (me.role !== 'owner') return json({ ok: false, error: '역할 지정은 대표만 가능합니다' }, 403, origin);
        const { phone, role, branches } = await request.json().catch(() => ({}));
        if (!phone || !/^0\d{9,10}$/.test(String(phone)))
          return json({ ok: false, error: '전화번호 형식이 올바르지 않습니다' }, 400, origin);
        if (!['owner', 'manager', 'staff'].includes(role))
          return json({ ok: false, error: 'role 은 owner / manager / staff 중 하나입니다' }, 400, origin);
        const user = await dbGet(env, '/users/' + phone);
        if (!user) return json({ ok: false, error: '등록되지 않은 계정입니다' }, 404, origin);
        if (user.status === '퇴사') return json({ ok: false, error: '퇴사 처리된 계정입니다' }, 400, origin);
        const before = await dbGet(env, '/contractRoles/' + phone).catch(() => null);
        await dbPut(env, '/contractRoles/' + phone, {
          role, branches: Array.isArray(branches) ? branches : [],
          name: user.name || '', setBy: me.phone, setAt: Date.now(),
        });
        await auditLog(env, { kind: 'role.set', by: me.phone, phone,
          name: user.name || '', from: (before && before.role) || 'staff', to: role });
        return json({ ok: true, phone, name: user.name || '', role }, 200, origin);
      }

      /* ═══ 수수료명세서 ═══
         계산은 브라우저에서 하고, 서버는 확정 시점의 설정·입력·결과를
         통째로 받아 스냅샷으로 저장한다. 발행 후 재계산은 하지 않는다. */
      if (path === '/statements' && request.method === 'POST') {
        if (me.role === 'staff') return json({ ok: false, error: '발행 권한이 없습니다' }, 403, origin);
        const body = await request.json().catch(() => null);
        if (!body) return json({ ok: false, error: '요청 본문을 읽지 못했습니다' }, 400, origin);
        const { brandId, branchId, period, staffPhone, staffName, birthDate, input, result, terms, displayMode } = body;
        if (!brandId || !branchId) return json({ ok: false, error: '브랜드·지점이 필요합니다' }, 400, origin);
        if (!/^\d{4}-\d{2}$/.test(String(period || ''))) return json({ ok: false, error: '기간은 YYYY-MM 형식입니다' }, 400, origin);
        if (!staffName || !String(staffName).trim()) return json({ ok: false, error: '대상자 성명이 필요합니다' }, 400, origin);
        if (!result || typeof result !== 'object') return json({ ok: false, error: '계산 결과가 없습니다' }, 400, origin);

        const hit = [];
        const safe = (v) => stripSensitive(v, hit);

        const branch = await dbGet(env, `/brands/${brandId}/branches/${branchId}`);
        if (!branch) return json({ ok: false, error: '지점을 찾을 수 없습니다' }, 404, origin);

        const ym = String(period).replace('-', '');
        const number = await nextNumber(env, `${brandId.toUpperCase()}-${ym}`, 4);

        const rec = {
          number, brandId, branchId, period,
          staffPhone: staffPhone ? String(staffPhone) : '',
          staffName: String(staffName).trim(),
          birthDate: birthDate ? String(birthDate) : '',
          status: 'issued',
          displayMode: displayMode || (branch.contractDefaults || {}).displayMode || 'gross',
          issuedAt: Date.now(),
          issuedBy: { phone: me.phone, name: me.name || '', role: me.role },
          snapshot: {
            branch,
            terms: safe(terms || (branch.contractDefaults || {})),
            input: safe(input || {}),
            result: safe(result),
          },
          netPayout: Number(result.netPayout) || 0,
          grossSales: Number((result.totals || {}).grossSales) || 0,
        };
        const id = (await dbPush(env, '/statements', rec)).name;
        await auditLog(env, { kind: 'statement.issue', by: me.phone, statementId: id, number,
          brandId, branchId, period, staffName: rec.staffName, netPayout: rec.netPayout });
        return json({ ok: true, id, number, statement: { id, ...rec } }, 200, origin);
      }

      /* 명세서 목록 — 기간·대상자로 좁힐 수 있다 */
      if (path === '/statements' && request.method === 'GET') {
        if (me.role === 'staff') return json({ ok: false, error: '조회 권한이 없습니다' }, 403, origin);
        const qPeriod = url.searchParams.get('period') || '';
        const all = (await dbGet(env, '/statements')) || {};
        let rows = Object.keys(all).map(k => {
          const c = all[k];
          const res = ((c.snapshot || {}).result) || {};
          return { id: k, number: c.number, brandId: c.brandId, branchId: c.branchId,
            period: c.period, staffName: c.staffName, staffPhone: c.staffPhone || '', status: c.status,
            grossSales: c.grossSales || 0, netPayout: c.netPayout || 0,
            supportAmount: +res.businessSupportAmount || 0,   // 정착지금 지급 횟수 집계용
            issuedAt: c.issuedAt, issuedBy: (c.issuedBy || {}).name || '',
            acknowledgedAt: c.acknowledgedAt || null, voidReason: c.voidReason || '' };
        });
        if (qPeriod) rows = rows.filter(r => r.period === qPeriod);
        rows.sort((a, b) => (b.issuedAt || 0) - (a.issuedAt || 0));
        return json({ ok: true, rows }, 200, origin);
      }

      /* 명세서 단건 — 인쇄·재출력용. 저장된 result 만 돌려준다. */
      if (/^\/statements\/[A-Za-z0-9_-]+$/.test(path) && request.method === 'GET') {
        if (me.role === 'staff') return json({ ok: false, error: '조회 권한이 없습니다' }, 403, origin);
        const id = path.split('/')[2];
        const c = await dbGet(env, '/statements/' + id);
        if (!c) return json({ ok: false, error: '명세서를 찾을 수 없습니다' }, 404, origin);
        await auditLog(env, { kind: 'statement.read', by: me.phone, statementId: id, number: c.number });
        return json({ ok: true, statement: { id, ...c } }, 200, origin);
      }

      /* 무효 처리 — 수정이 아니라 void 후 재발행이다 */
      if (/^\/statements\/[A-Za-z0-9_-]+\/void$/.test(path) && request.method === 'POST') {
        if (me.role !== 'owner') return json({ ok: false, error: '무효 처리는 대표만 가능합니다' }, 403, origin);
        const id = path.split('/')[2];
        const { reason } = await request.json().catch(() => ({}));
        if (!reason || String(reason).trim().length < 2) return json({ ok: false, error: '무효 사유를 적어주세요' }, 400, origin);
        const c = await dbGet(env, '/statements/' + id);
        if (!c) return json({ ok: false, error: '명세서를 찾을 수 없습니다' }, 404, origin);
        if (c.status === 'void') return json({ ok: false, error: '이미 무효 처리된 명세서입니다' }, 400, origin);
        await dbPut(env, `/statements/${id}/status`, 'void');
        await dbPut(env, `/statements/${id}/voidReason`, String(reason).trim());
        await dbPut(env, `/statements/${id}/voidedAt`, Date.now());
        await dbPut(env, `/statements/${id}/voidedBy`, me.phone || '');
        await auditLog(env, { kind: 'statement.void', by: me.phone, statementId: id, number: c.number, reason: String(reason).trim() });
        return json({ ok: true }, 200, origin);
      }

      /* 무효건 삭제 — owner 만. 발행 상태는 거부한다. */
      if (/^\/statements\/[A-Za-z0-9_-]+$/.test(path) && request.method === 'DELETE') {
        if (me.role !== 'owner') return json({ ok: false, error: '삭제 권한이 없습니다' }, 403, origin);
        const id = path.split('/')[2];
        const c = await dbGet(env, '/statements/' + id);
        if (!c) return json({ ok: false, error: '명세서를 찾을 수 없습니다' }, 404, origin);
        if (c.status !== 'void')
          return json({ ok: false, error: '무효 처리된 명세서만 지울 수 있습니다. 먼저 무효 처리하세요.' }, 400, origin);
        await dbPut(env, '/statements/' + id, null);
        await auditLog(env, { kind: 'statement.delete', by: me.phone, statementId: id,
          number: c.number, period: c.period, staffName: c.staffName });
        return json({ ok: true }, 200, origin);
      }

      /* ═══ 월 확정 재수집 실행 ═══
         핸드SOS 는 Cloudflare 발신을 막고 자격증명도 GitHub 시크릿에만 있다.
         그래서 여기서 직접 긁지 않고 GitHub Actions 를 대신 실행시킨다.
         (GitHub API 는 Cloudflare 에서 잘 나간다) */
      if (path === '/collect/month' && request.method === 'POST') {
        if (me.role === 'staff') return json({ ok: false, error: '재수집 권한이 없습니다' }, 403, origin);
        if (!env.GH_TOKEN || !env.GH_REPO)
          return json({ ok: false, error: '재수집이 아직 설정되지 않았습니다 (GH_TOKEN/GH_REPO 미설정)' }, 503, origin);
        const { ym, shop } = await request.json().catch(() => ({}));
        if (!/^\d{4}-\d{2}$/.test(String(ym || '')))
          return json({ ok: false, error: '기간은 YYYY-MM 형식입니다' }, 400, origin);
        if (shop && !['eto', 'daymean', 'all'].includes(String(shop)))
          return json({ ok: false, error: '지점은 eto / daymean / all 중 하나입니다' }, 400, origin);
        const now = new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 7);
        if (ym > now) return json({ ok: false, error: '아직 오지 않은 달입니다' }, 400, origin);

        const wf = env.GH_WORKFLOW || 'hermes-kpi.yml';
        const r = await fetch(`https://api.github.com/repos/${env.GH_REPO}/actions/workflows/${wf}/dispatches`, {
          method: 'POST',
          headers: {
            'Authorization': 'Bearer ' + env.GH_TOKEN,
            'Accept': 'application/vnd.github+json',
            'X-GitHub-Api-Version': '2022-11-28',
            'User-Agent': 'dm-contract-api',
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ ref: env.GH_REF || 'main',
            inputs: Object.assign({ mode: 'month', ym }, shop && shop !== 'all' ? { shop } : {}) }),
        });
        if (r.status !== 204) {
          const t = await r.text().catch(() => '');
          return json({ ok: false, error: `재수집 실행 실패 (${r.status}) ${t.slice(0, 160)}` }, 502, origin);
        }
        await auditLog(env, { kind: 'collect.month', by: me.phone, period: ym, shop: shop || 'all' });
        return json({ ok: true, ym, shop: shop || 'all' }, 200, origin);
      }

      /* 재수집 진행 상황 — 최근 실행의 상태를 그대로 돌려준다 */
      if (path === '/collect/status' && request.method === 'GET') {
        if (me.role === 'staff') return json({ ok: false, error: '조회 권한이 없습니다' }, 403, origin);
        if (!env.GH_TOKEN || !env.GH_REPO) return json({ ok: true, configured: false }, 200, origin);
        const wf = env.GH_WORKFLOW || 'hermes-kpi.yml';
        const r = await fetch(`https://api.github.com/repos/${env.GH_REPO}/actions/workflows/${wf}/runs?per_page=1`, {
          headers: { 'Authorization': 'Bearer ' + env.GH_TOKEN, 'Accept': 'application/vnd.github+json',
                     'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'dm-contract-api' },
        });
        if (!r.ok) return json({ ok: false, error: '상태 조회 실패 ' + r.status }, 502, origin);
        const j = await r.json();
        const run = (j.workflow_runs || [])[0];
        return json({ ok: true, configured: true, run: run ? {
          id: run.id, status: run.status, conclusion: run.conclusion,
          started: run.run_started_at, url: run.html_url } : null }, 200, origin);
      }

      return json({ ok: false, error: '없는 경로입니다' }, 404, origin);

    } catch (e) {
      return json({ ok: false, error: String((e && e.message) || e).slice(0, 200) }, 500, origin);
    }
  },
};
