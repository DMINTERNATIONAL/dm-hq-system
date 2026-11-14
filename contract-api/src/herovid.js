/**
 * 공식 홈페이지 홈 영상 (2026-11-14, 사용자 '홈 영상도 백엔드에서 교체할 수 있어야 돼. 최대 5개').
 *
 * 올리기: PUT /hero/up?k=v|p  (관리 앱 '히어로 사진 › 공식 홈페이지 메인' — 대표 · 관리자만)
 *   k=v 영상(mp4, 60MB 까지, 다시 인코딩하지 않음) · k=p 첫 장면 사진(jpg, 3MB 까지, 관리 앱이 영상에서 뽑아 올림)
 *   LOOKBOOK 버킷 hero/{v|p}_{id}.{mp4|jpg} 에 넣고 { url } 을 준다 → 관리 앱이 /salonInfo/heroes.site.videos[{u,p}] 로 저장
 * 내려보내기: GET /public/hero/{key}  (로그인 없이 — 사이트 홈이 바로 쓴다)
 *   r2.dev 공개 주소는 초당 약 25KB 로 막혀 27MB 영상이 사실상 안 나온다(사이트 실측) → 워커가 Range 로 끊어 보낸다.
 *   한 번 올린 파일은 바뀌지 않으므로(새로 올리면 새 이름) 1년 캐시 · immutable.
 */

const KEY_RE = /^hero\/[vp]_[a-z0-9]{8,32}\.(mp4|jpg)$/;
const LIMIT = { v: 60 * 1024 * 1024, p: 3 * 1024 * 1024 };
const id36 = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

export async function heroServe(request, env, key) {
  const head = { 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'public, max-age=31536000, immutable', 'Accept-Ranges': 'bytes' };
  if (!KEY_RE.test(key) || !env.LOOKBOOK) return new Response('not found', { status: 404, headers: head });
  const obj = await env.LOOKBOOK.get(key, { range: request.headers, onlyIf: request.headers });
  if (!obj) return new Response('not found', { status: 404, headers: head });
  const h = new Headers(head);
  obj.writeHttpMetadata(h);
  h.set('ETag', obj.httpEtag);
  if (!obj.body) return new Response(null, { status: 304, headers: h });   // If-None-Match 맞음
  const size = obj.size;
  if (request.headers.has('range') && obj.range) {
    const r = obj.range;
    const start = r.offset != null ? r.offset : (r.suffix != null ? Math.max(0, size - r.suffix) : 0);
    const len = r.length != null ? r.length : (r.suffix != null ? Math.min(r.suffix, size) : size - start);
    h.set('Content-Range', `bytes ${start}-${start + len - 1}/${size}`);
    h.set('Content-Length', String(len));
    return new Response(obj.body, { status: 206, headers: h });
  }
  h.set('Content-Length', String(size));
  return new Response(obj.body, { status: 200, headers: h });
}

export function makeHeroVid() {
  return async function route(path, request, env, ctx, me, json, origin) {
    if (path !== '/hero/up') return null;
    if (request.method !== 'PUT') return json({ ok: false, error: 'PUT 만 받습니다' }, 405, origin);
    if (!me || (me.role !== 'owner' && me.role !== 'manager')) return json({ ok: false, error: '홈 영상은 대표 · 관리자만 바꿀 수 있어요' }, 403, origin);
    if (!env.LOOKBOOK) return json({ ok: false, error: '저장소 연결이 없습니다' }, 503, origin);
    const url = new URL(request.url);
    const k = url.searchParams.get('k') === 'p' ? 'p' : 'v';
    const type = String(request.headers.get('content-type') || '').toLowerCase();
    if (k === 'v' && type !== 'video/mp4') return json({ ok: false, error: 'mp4 영상만 올릴 수 있어요 (H.264 권장)' }, 400, origin);
    if (k === 'p' && type !== 'image/jpeg') return json({ ok: false, error: '첫 장면 사진이 올바르지 않아요' }, 400, origin);
    const len = Number(request.headers.get('content-length') || 0);
    if (!len) return json({ ok: false, error: '파일 크기를 알 수 없어요' }, 400, origin);
    if (len > LIMIT[k]) return json({ ok: false, error: k === 'v' ? '영상은 60MB 까지예요' : '사진이 너무 커요' }, 413, origin);
    const key = `hero/${k}_${id36()}.${k === 'v' ? 'mp4' : 'jpg'}`;
    await env.LOOKBOOK.put(key, request.body, { httpMetadata: { contentType: type, cacheControl: 'public, max-age=31536000, immutable' } });
    return json({ ok: true, key, url: `${url.origin}/public/hero/${key}` }, 200, origin);
  };
}
