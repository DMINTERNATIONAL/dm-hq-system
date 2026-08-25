// DM INTERNATIONAL — 인스타그램 아이디 검증 Worker
// 직원관리에서 IG 아이디 입력 후 "확인" → 이 Worker가 Graph API business_discovery로
// 실시간 조회 → 성공(팔로워 수)/실패(사유) 즉시 반환. IG 토큰을 브라우저에 노출하지 않기 위한 프록시.
//
// ⚠️ business_discovery는 "프로페셔널(비즈니스/크리에이터) 공개 계정"만 조회됨.
//    개인계정·비공개·오타·없는 아이디 → 실패로 응답.
//
// 배포:   cd workers/ig-verify && npx wrangler deploy
// 시크릿: npx wrangler secret put IG_TOKEN        (DM Analytics 시스템사용자 무만료 토큰)
//         (선택) npx wrangler secret put IG_USER_ID  — 미설정 시 토큰에서 자동조회

const ALLOWED_ORIGINS = [
  'https://dminternational.github.io', // GitHub Pages (운영)
  'http://localhost:8012',             // 로컬 미리보기
  'http://localhost:8013',
  'http://127.0.0.1:8012',
];
const IG_API = 'https://graph.facebook.com/v21.0';
const UA = 'Mozilla/5.0 (compatible; DM-IG-Verify/1.0)';

function corsHeaders(origin) {
  const ok = ALLOWED_ORIGINS.includes(origin);
  return {
    'Access-Control-Allow-Origin': ok ? origin : ALLOWED_ORIGINS[0],
    'Access-Control-Allow-Methods': 'GET,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
    'Vary': 'Origin',
  };
}
function json(obj, status, origin) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json', ...corsHeaders(origin) },
  });
}

// IG_USER_ID: env 우선, 없으면 토큰으로 자동조회(모듈 캐시)
let _igUserId = null;
async function resolveIgUserId(env) {
  if (env.IG_USER_ID) return env.IG_USER_ID;
  if (_igUserId) return _igUserId;
  const url = `${IG_API}/me/accounts?fields=instagram_business_account{id,username}&access_token=${encodeURIComponent(env.IG_TOKEN)}`;
  const data = await (await fetch(url, { headers: { 'User-Agent': UA } })).json();
  if (data.error) throw new Error('IG_USER_ID 자동조회 실패: ' + data.error.message);
  const pg = (data.data || []).find(p => p.instagram_business_account);
  if (!pg) throw new Error('토큰에 연결된 IG 비즈니스 계정 없음');
  _igUserId = pg.instagram_business_account.id;
  return _igUserId;
}

async function verify(username, env) {
  const u = String(username || '').replace(/^@/, '').trim();
  if (!u) return { ok: false, error: '아이디를 입력하세요.' };
  if (!/^[A-Za-z0-9._]{1,30}$/.test(u)) return { ok: false, error: '아이디 형식이 올바르지 않습니다.' };
  const igUserId = await resolveIgUserId(env);
  const fields = `business_discovery.username(${u}){username,name,followers_count,media_count}`;
  const url = `${IG_API}/${encodeURIComponent(igUserId)}?access_token=${encodeURIComponent(env.IG_TOKEN)}&fields=${encodeURIComponent(fields)}`;
  const resp = await fetch(url, { headers: { 'User-Agent': UA } });
  const data = await resp.json();
  if (!resp.ok || data.error) {
    const msg = (data.error && data.error.message) || `조회 실패 (${resp.status})`;
    // 흔한 사유를 사람이 읽기 쉽게 안내
    let hint = msg;
    if (/cannot be found|does not exist|Invalid user/i.test(msg)) hint = '존재하지 않는 아이디입니다.';
    else if (/not a business|professional/i.test(msg)) hint = '개인 계정입니다. 프로페셔널(비즈니스/크리에이터) 공개 계정만 조회됩니다.';
    else if (/restricted|private/i.test(msg)) hint = '비공개 계정이거나 조회가 제한되어 있습니다.';
    return { ok: false, error: hint, raw: msg };
  }
  const bd = data.business_discovery || {};
  return {
    ok: true,
    username: bd.username || u,
    name: bd.name || '',
    followers: +bd.followers_count || 0,
    media_count: +bd.media_count || 0,
  };
}

export default {
  async fetch(request, env) {
    const origin = request.headers.get('Origin') || '';
    if (request.method === 'OPTIONS') return new Response(null, { headers: corsHeaders(origin) });
    if (request.method !== 'GET') return json({ ok: false, error: 'method_not_allowed' }, 405, origin);
    if (!ALLOWED_ORIGINS.includes(origin)) return json({ ok: false, error: 'forbidden_origin' }, 403, origin);
    if (!env.IG_TOKEN) return json({ ok: false, error: 'IG_TOKEN 미설정 (wrangler secret put IG_TOKEN)' }, 500, origin);
    const u = new URL(request.url).searchParams.get('u') || '';
    try {
      return json(await verify(u, env), 200, origin);
    } catch (e) {
      return json({ ok: false, error: e.message || String(e) }, 200, origin);
    }
  },
};
