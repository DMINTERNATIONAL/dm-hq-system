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

function corsHeaders(origin) {
  const ok = ALLOWED_ORIGINS.includes(origin);
  return {
    'Access-Control-Allow-Origin': ok ? origin : ALLOWED_ORIGINS[0],
    'Access-Control-Allow-Methods': 'POST,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type,X-Ph',
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

    // 4) 저장 키: lookbook/{디자이너전화}/{시각}-{랜덤}.{확장자}
    const ph = (request.headers.get('X-Ph') || 'misc').replace(/[^0-9a-zA-Z_-]/g, '').slice(0, 32) || 'misc';
    const ext = ct === 'image/png' ? 'png' : ct === 'image/webp' ? 'webp' : 'jpg';
    const rand = crypto.randomUUID().slice(0, 8);
    const key = `lookbook/${ph}/${Date.now()}-${rand}.${ext}`;

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
