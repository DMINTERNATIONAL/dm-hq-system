/**
 * 채팅 사진 · 동영상 — 비공개 R2 버킷 dm-chat-media (바인딩 CHAT_MEDIA).
 *
 * 룩북 버킷처럼 공개 주소를 쓰면 주소만 알면 누구나 열 수 있다. 여기 파일은 방 사람만 봐야 하므로
 *   올리기: 로그인 + 방 참여 확인 후 '올리기 허가표'(서명)를 주고, 그 표로만 올린다.
 *   보기:   방 참여 확인 후 6시간짜리 서명 주소를 준다. <img>·<video> 는 머리글을 못 보내서
 *           로그인 토큰 대신 파일마다 서명을 붙인다(토큰이 주소에 남지 않게).
 * 키: p/{방 태그}/… 보통 사진(계속 보관) · o/{방 태그}/… 원본 사진·동영상·파일(90일 뒤 자동 삭제 — 버킷 수명 규칙)
 * 100MB 넘는 동영상은 여러 조각으로 나눠 올린다(Worker 한 번에 받는 한도가 100MB).
 */

const te = new TextEncoder();
const LIMIT = { p: 12 * 1024 * 1024, o: 20 * 1024 * 1024, v: 300 * 1024 * 1024, f: 50 * 1024 * 1024 };
const PART = 50 * 1024 * 1024;
const URL_TTL = 6 * 3600;

function b64u(bytes) {
  let s = ''; const b = new Uint8Array(bytes);
  for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
async function sign(env, text) {
  const k = await crypto.subtle.importKey('raw', te.encode('media:' + env.SESSION_SECRET), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return b64u(await crypto.subtle.sign('HMAC', k, te.encode(text))).slice(0, 32);
}
async function same(a, b) { if (!a || !b || a.length !== b.length) return false; let d = 0; for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i); return d === 0; }
export async function roomTag(rid) {
  const h = await crypto.subtle.digest('SHA-256', te.encode('room:' + rid));
  return b64u(new Uint8Array(h).slice(0, 9));
}
const extOf = (name, type) => {
  const m = String(name || '').match(/\.([A-Za-z0-9]{1,5})$/);
  if (m) return m[1].toLowerCase();
  if (/jpeg/.test(type)) return 'jpg';
  if (/png/.test(type)) return 'png';
  if (/mp4/.test(type)) return 'mp4';
  if (/quicktime/.test(type)) return 'mov';
  return 'bin';
};

/* 서명 주소 */
export async function signedUrl(env, base, key) {
  const e = Math.floor(Date.now() / 1000) + URL_TTL;
  return `${base}/m/${key}?e=${e}&s=${await sign(env, key + '|' + e)}`;
}

/* 로그인 없이 오는 요청: 서명 주소로 파일 내려받기 (동영상은 Range 로 끊어서) */
export async function serveMedia(request, env, path) {
  const url = new URL(request.url);
  const key = decodeURIComponent(path.slice(3));
  const e = parseInt(url.searchParams.get('e') || '0', 10);
  if (!e || e < Date.now() / 1000) return new Response('주소가 만료됐습니다. 화면을 새로 열어 주세요', { status: 403 });
  if (!(await same(url.searchParams.get('s') || '', await sign(env, key + '|' + e)))) return new Response('잘못된 주소', { status: 403 });
  const obj = await env.CHAT_MEDIA.get(key, { range: request.headers, onlyIf: request.headers });
  if (!obj) return new Response('보관 기간이 지났거나 없는 파일입니다', { status: 404 });
  const h = new Headers();
  obj.writeHttpMetadata(h);
  h.set('etag', obj.httpEtag);
  h.set('Accept-Ranges', 'bytes');
  h.set('Cache-Control', 'private, max-age=21600');
  h.set('Access-Control-Allow-Origin', '*');
  if (!('body' in obj) || !obj.body) return new Response(null, { status: 304, headers: h });
  let status = 200;
  if (obj.range && request.headers.get('range')) {
    const r = obj.range; const off = r.offset || 0; const len = r.length ?? (obj.size - off);
    h.set('Content-Range', `bytes ${off}-${off + len - 1}/${obj.size}`);
    h.set('Content-Length', String(len));
    status = 206;
  }
  return new Response(obj.body, { status, headers: h });
}

export function makeMedia(deps) {
  const { dbGet } = deps;
  /* 채팅방이면 방 참여자, 'board:{게시판}' · 'survey:{설문}' 이면 그걸 볼 수 있는 사람 (board.js) */
  async function mustMember(env, me, rid) {
    if (me.admin) throw new Error('본사 관리자 입구는 쓸 수 없습니다');
    if (/^(board|survey):/.test(rid)) { if (!(await deps.canSeeScope(env, me, rid))) throw new Error('볼 수 없는 자료입니다'); return; }
    const m = await dbGet(env, `/chat/rooms/${rid}/m/${me.ph}`).catch(() => null);
    if (!m) throw new Error('이 방에 참여하고 있지 않습니다');
  }
  async function ticket(env, key, uid) { return sign(env, 'up|' + key + '|' + (uid || '')); }

  return async function route(path, request, env, me, json, origin) {
    if (!path.startsWith('/chat/up/') && path !== '/chat/media-urls') return null;
    try {
      const url = new URL(request.url);
      if (path === '/chat/up/start' && request.method === 'POST') {
        const b = await request.json().catch(() => ({}));
        const rid = String(b.rid || ''); const kind = String(b.kind || '');
        if (!LIMIT[kind]) throw new Error('파일 종류가 올바르지 않습니다');
        const size = Number(b.size) || 0;
        if (size <= 0) throw new Error('빈 파일입니다');
        if (size > LIMIT[kind]) throw new Error(`너무 큽니다 (최대 ${Math.round(LIMIT[kind] / 1048576)}MB)`);
        await mustMember(env, me, rid);
        const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
        const key = `${kind === 'p' ? 'p' : 'o'}/${await roomTag(rid)}/${id}.${extOf(b.name, b.type)}`;
        const type = String(b.type || 'application/octet-stream').slice(0, 80);
        if (size <= 90 * 1024 * 1024) return json({ ok: true, key, mode: 'single', tk: await ticket(env, key, '') }, 200, origin);
        const up = await env.CHAT_MEDIA.createMultipartUpload(key, { httpMetadata: { contentType: type } });
        return json({ ok: true, key, mode: 'multi', uid: up.uploadId, partSize: PART, tk: await ticket(env, key, up.uploadId) }, 200, origin);
      }
      if (path === '/chat/up/put' && request.method === 'PUT') {
        const key = url.searchParams.get('key') || '';
        if (!(await same(url.searchParams.get('tk') || '', await ticket(env, key, '')))) throw new Error('올리기 허가가 올바르지 않습니다');
        const len = Number(request.headers.get('content-length') || 0);
        if (len > 95 * 1024 * 1024) throw new Error('너무 큽니다');
        await env.CHAT_MEDIA.put(key, request.body, { httpMetadata: { contentType: request.headers.get('content-type') || 'application/octet-stream' } });
        return json({ ok: true, key }, 200, origin);
      }
      if (path === '/chat/up/part' && request.method === 'PUT') {
        const key = url.searchParams.get('key') || '', uid = url.searchParams.get('uid') || '';
        const n = parseInt(url.searchParams.get('n') || '0', 10);
        if (!(await same(url.searchParams.get('tk') || '', await ticket(env, key, uid)))) throw new Error('올리기 허가가 올바르지 않습니다');
        if (n < 1 || n > 20) throw new Error('조각 번호가 올바르지 않습니다');
        const part = await env.CHAT_MEDIA.resumeMultipartUpload(key, uid).uploadPart(n, request.body);
        return json({ ok: true, part: { partNumber: part.partNumber, etag: part.etag } }, 200, origin);
      }
      if (path === '/chat/up/done' && request.method === 'POST') {
        const b = await request.json().catch(() => ({}));
        if (!(await same(String(b.tk || ''), await ticket(env, String(b.key || ''), String(b.uid || ''))))) throw new Error('올리기 허가가 올바르지 않습니다');
        await env.CHAT_MEDIA.resumeMultipartUpload(String(b.key), String(b.uid)).complete(b.parts || []);
        return json({ ok: true, key: b.key }, 200, origin);
      }
      if (path === '/chat/media-urls' && request.method === 'POST') {
        const b = await request.json().catch(() => ({}));
        const rid = String(b.rid || '');
        await mustMember(env, me, rid);
        const tag = await roomTag(rid);
        const base = url.origin;
        const out = {};
        for (const k of (b.keys || []).slice(0, 100)) {
          const key = String(k);
          if (key.startsWith(`p/${tag}/`) || key.startsWith(`o/${tag}/`)) out[key] = await signedUrl(env, base, key);
        }
        return json({ ok: true, urls: out, ttl: URL_TTL }, 200, origin);
      }
      return json({ ok: false, error: '없는 기능입니다' }, 404, origin);
    } catch (e) {
      return json({ ok: false, error: e.message || String(e) }, 400, origin);
    }
  };
}
