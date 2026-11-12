// DAY:MEAN 룩북/프로필 이미지 업로드 Worker
// 브라우저(관리자 페이지) → 이 Worker → R2 저장 → 공개 URL 반환.
// DB(Realtime DB)에는 이 URL 문자열만 저장하므로 salonInfo 노드가 가벼워진다.

const ALLOWED_ORIGINS = [
  'https://dminternational.github.io', // GitHub Pages (운영)
  'http://localhost:8012',             // 로컬 미리보기
  'http://localhost:8013',
  'http://127.0.0.1:8012',
];
const ALLOWED_TYPES = ['image/jpeg', 'image/png', 'image/webp'];
const MAX_BYTES = 8 * 1024 * 1024; // 8MB (클라이언트에서 이미 압축되어 들어옴)
const MIN_BYTES = 100;

/* 여러 판 파일 이름: {Date.now() 13자리}-{16진 8자리}_t{큰 판 가로}[.w640|.w1000].{webp|jpg} */
const NAME_RE = /^\d{13}-[0-9a-f]{8}_t\d{3,4}(\.w(640|1000))?\.(webp|jpg)$/;

/* HMAC-SHA256(PATH_KEY, 번호) 의 16진 앞 16자리 — contract-api pathHash 와 글자 하나까지 같아야 한다 */
async function pathHash(secret, ph) {
  const k = await crypto.subtle.importKey('raw', new TextEncoder().encode(String(secret)),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', k, new TextEncoder().encode(String(ph))));
  return [...sig].map((b) => b.toString(16).padStart(2, '0')).join('').slice(0, 16);
}

function corsHeaders(origin) {
  const ok = ALLOWED_ORIGINS.includes(origin);
  return {
    'Access-Control-Allow-Origin': ok ? origin : ALLOWED_ORIGINS[0],
    'Access-Control-Allow-Methods': 'POST,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type,X-Ph,X-Name',
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

export default {
  async fetch(request, env) {
    const origin = request.headers.get('Origin') || '';

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders(origin) });
    }
    if (request.method !== 'POST') {
      return json({ error: 'method_not_allowed' }, 405, origin);
    }

    // 1) Origin 허용 목록 (공개 정적 페이지라 토큰은 무의미 → Origin + 타입/용량으로 방어)
    if (!ALLOWED_ORIGINS.includes(origin)) {
      return json({ error: 'forbidden_origin' }, 403, origin);
    }

    // 2) 콘텐츠 타입/크기 검증
    const ct = (request.headers.get('Content-Type') || '').split(';')[0].trim();
    if (!ALLOWED_TYPES.includes(ct)) {
      return json({ error: 'unsupported_type', ct }, 415, origin);
    }
    const buf = await request.arrayBuffer();
    if (buf.byteLength > MAX_BYTES) return json({ error: 'too_large' }, 413, origin);
    if (buf.byteLength < MIN_BYTES) return json({ error: 'empty' }, 400, origin);

    // 4) 저장 키: lookbook/{폴더}/{파일 이름}
    const ph = (request.headers.get('X-Ph') || 'misc').replace(/[^0-9a-zA-Z_-]/g, '').slice(0, 32) || 'misc';
    const ext = ct === 'image/png' ? 'png' : ct === 'image/webp' ? 'webp' : 'jpg';
    /* 폴더에 전화번호를 쓰지 않는다 (11/12) — 사진 주소(r2.dev 공개)가 공식 사이트 HTML 에 그대로 실려
       디자이너 휴대폰 번호(= 로그인 아이디)가 새어 나갔다. 번호 모양이면 PATH_KEY 로 만든 HMAC 앞 16자리로 바꾼다.
       같은 번호는 늘 같은 폴더라 따로 저장할 표가 필요 없고, 폴더 이름만 보고 번호를 알아낼 수는 없다.
       contract-api 의 /admin/migrate-photo-paths 가 예전 사진을 같은 규칙(같은 PATH_KEY)으로 옮긴다 — 두 곳 값이 같아야 한다.
       PATH_KEY 를 아직 안 넣었으면 예전처럼 번호 폴더(배포 순서 안전장치 — 업로드가 멈추는 것보다 낫다). */
    let folder = ph;
    if (/^0\d{8,10}$/.test(ph) && env.PATH_KEY) folder = 'p_' + await pathHash(env.PATH_KEY, ph);
    /* X-Name (선택) — 관리 앱이 한 사진을 큰 판 + 작은 판(.w1000 / .w640) 세 장으로 올릴 때 세 장이 같은 앞부분을 쓰도록
       파일 이름을 직접 정한다. 사이트는 큰 판 이름의 _t{가로} 로 작은 판 주소를 만든다(DB 에는 큰 판 주소만).
       정해 둔 모양 · 확장자가 Content-Type 과 맞을 때만 받는다 — 아무 이름이나 받으면 남의 사진을 덮어쓸 수 있다. */
    const xName = request.headers.get('X-Name');
    let name;
    if (xName !== null && xName !== '') {
      const m = NAME_RE.exec(xName);
      if (!m || (m[3] === 'webp' ? 'image/webp' : 'image/jpeg') !== ct) return json({ error: 'bad_name' }, 400, origin);
      name = xName;
    } else {
      const rand = crypto.randomUUID().slice(0, 8);
      name = `${Date.now()}-${rand}.${ext}`;
    }
    const key = `lookbook/${folder}/${name}`;
    /* 이름을 손님 쪽이 정하므로 이미 있는 파일은 덮어쓰지 않는다 — 사진 주소는 공개라 이름을 알면 남의 사진을 바꿔 끼울 수 있다
       (1년 불변 캐시라 한 번 바뀌면 되돌리기도 어렵다). 같은 크기면 답을 못 받은 앱이 다시 보낸 것으로 보고 같은 주소를 돌려준다. */
    if (xName) {
      const cur = await env.BUCKET.head(key);
      if (cur) {
        if (cur.size !== buf.byteLength) return json({ error: 'exists' }, 409, origin);
        const b0 = (env.PUBLIC_BASE || '').replace(/\/$/, '');
        return json({ url: b0 + '/' + key, key }, 200, origin);
      }
    }

    // 5) R2 저장 (1년 불변 캐시 → CDN/브라우저가 재요청 안 함)
    await env.BUCKET.put(key, buf, {
      httpMetadata: {
        contentType: ct,
        cacheControl: 'public, max-age=31536000, immutable',
      },
    });

    const base = (env.PUBLIC_BASE || '').replace(/\/$/, '');
    return json({ url: base + '/' + key, key }, 200, origin);
  },
};
