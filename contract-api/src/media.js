/**
 * 채팅 사진 · 동영상 — 비공개 R2 버킷 dm-chat-media (바인딩 CHAT_MEDIA).
 *
 * 룩북 버킷처럼 공개 주소를 쓰면 주소만 알면 누구나 열 수 있다. 여기 파일은 방 사람만 봐야 하므로
 *   올리기: 로그인 + 방 참여 확인 후 '올리기 허가표'(서명)를 주고, 그 표로만 올린다.
 *   보기:   방 참여 확인 후 2~3일짜리 서명 주소를 준다(하루 단위로 같은 주소). <img>·<video> 는 머리글을 못 보내서
 *           로그인 토큰 대신 파일마다 서명을 붙인다(토큰이 주소에 남지 않게).
 * 키: p/{방 태그}/… 보통 사진(계속 보관) · o/{방 태그}/… 원본 사진·동영상·파일(90일 뒤 자동 삭제 — 버킷 수명 규칙)
 * 10MB 넘는 파일은 10MB 조각으로 나눠 올린다 — 조각이 작으면 끊겨도 그 조각만 다시 보내면 되고(폰 · 해외 회선),
 * 진행률도 촘촘해진다. 조각은 마지막만 빼고 크기가 같아야 한다(R2 규칙). Worker 한 번에 받는 한도는 100MB.
 */

import { gcsGetUrl, gcsPutUrl, gcsResumable, hasKey } from './gcs.js';

const te = new TextEncoder();
const LIMIT = { p: 12 * 1024 * 1024, o: 20 * 1024 * 1024, v: 300 * 1024 * 1024, f: 50 * 1024 * 1024 };
const PART = 10 * 1024 * 1024;
const MAX_PARTS = Math.ceil(LIMIT.v / PART) + 1;
const URL_TTL = 2 * 86400; /* 최소 남은 시간(앱이 이만큼 믿고 쓴다). 실제로는 2~3일 */

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

/* 받기 주소 — g/ 로 시작하면 구글 서울 저장소(gcs.js), 아니면 R2 */
export async function mediaUrl(env, base, key) {
  if (key.startsWith('g/') && env.GCS_BUCKET) return gcsGetUrl(env, key);
  return signedUrl(env, base, key);
}
/* 서명 주소 */
export async function signedUrl(env, base, key) {
  /* 만료 시각을 하루 단위로 맞춘다 — 하루 동안 같은 주소라 기기에 저장된 사진을 그대로 다시 쓴다(11/12 1시간 → 하루, '사진이 너무 느림').
     한국 → Cloudflare 가 미국(LAX)을 거쳐 한 번 묻는 데 1~2초라, 다시 받지 않는 게 가장 빠르다 */
  const e = Math.ceil((Date.now() / 1000 + URL_TTL) / 86400) * 86400;
  return `${base}/m/${key}?e=${e}&s=${await sign(env, key + '|' + e)}`;
}

/* 로그인 없이 오는 요청: 서명 주소로 파일 내려받기 (동영상은 Range 로 끊어서) */
export async function serveMedia(request, env, path) {
  const url = new URL(request.url);
  const key = decodeURIComponent(path.slice(3));
  const e = parseInt(url.searchParams.get('e') || '0', 10);
  const ac = { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'text/plain; charset=utf-8' };
  if (!e || e < Date.now() / 1000) return new Response('주소가 만료됐습니다. 화면을 새로 열어 주세요', { status: 403, headers: ac });
  if (!(await same(url.searchParams.get('s') || '', await sign(env, key + '|' + e)))) return new Response('잘못된 주소', { status: 403, headers: ac });
  const obj = await env.CHAT_MEDIA.get(key, { range: request.headers, onlyIf: request.headers });
  if (!obj) return new Response('보관 기간이 지났거나 없는 파일입니다', { status: 404, headers: ac });
  const h = new Headers();
  obj.writeHttpMetadata(h);
  h.set('etag', obj.httpEtag);
  h.set('Accept-Ranges', 'bytes');
  h.set('Cache-Control', 'private, max-age=604800, immutable');
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
  /* 서울로 옮긴 예전 사진 목록(gcs.js gcsMigrate) — 2분씩 기억 */
  let _has = null, _hasAt = 0;
  async function movedTo(env, key) {
    if (!env.GCS_BUCKET || !/^[po]\//.test(key)) return null;
    if (!_has || Date.now() - _hasAt > 120000) { _has = (await dbGet(env, '/authSecrets/__gcs/has').catch(() => null)) || {}; _hasAt = Date.now(); }
    let o = _has; for (const seg of hasKey(key).split('/')) { o = o && o[seg]; if (!o) return null; }
    return 'g/' + key;
  }
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
        const type = String(b.type || 'application/octet-stream').slice(0, 80);
        /* 사진(보통 · 작은 · 원본)은 구글 서울 저장소로 앱이 바로 올린다 — 새 앱(b.g)만. 동영상 · 파일은 R2 */
        if ((kind === 'p' || kind === 'o') && b.g && env.GCS_BUCKET && /^image\//.test(type)) {
          const gkey = `g/${kind}/${await roomTag(rid)}/${id}.${extOf(b.name, b.type)}`;
          const put = await gcsPutUrl(env, gkey, type, LIMIT[kind]);
          return json({ ok: true, key: gkey, mode: 'gcs', url: put.url, h: put.h }, 200, origin);
        }
        /* 동영상 · 파일도 서울로(11/12) — 10MB 이하는 서명 PUT 한 번, 넘으면 이어 올리기 세션(8MB 조각). 키는 g/o/ (90일 보관) */
        if ((kind === 'v' || kind === 'f') && b.g && env.GCS_BUCKET && deps.gToken) {
          const gkey = `g/o/${await roomTag(rid)}/${id}.${extOf(b.name, b.type)}`;
          if (size <= PART) { const put = await gcsPutUrl(env, gkey, type, LIMIT[kind]); return json({ ok: true, key: gkey, mode: 'gcs', url: put.url, h: put.h }, 200, origin); }
          const sess = await gcsResumable(env, deps.gToken, gkey, type, size, request.headers.get('origin') || '');
          return json({ ok: true, key: gkey, mode: 'gcsr', url: sess, chunk: 8 * 1024 * 1024, type }, 200, origin);
        }
        const key = `${kind === 'p' ? 'p' : 'o'}/${await roomTag(rid)}/${id}.${extOf(b.name, b.type)}`;
        if (size <= PART) return json({ ok: true, key, mode: 'single', tk: await ticket(env, key, '') }, 200, origin);
        const up = await env.CHAT_MEDIA.createMultipartUpload(key, { httpMetadata: { contentType: type } });
        return json({ ok: true, key, mode: 'multi', uid: up.uploadId, partSize: PART, tk: await ticket(env, key, up.uploadId) }, 200, origin);
      }
      /* 사진 올리기 허가를 한꺼번에 미리(11/12) — 사진 고르는 창이 열릴 때 받아 두면 '보내기' 누르자마자 서울로 올라간다(미국 경유 왕복 한 번 줄임).
         서울 저장소 사진만(보통 · 작은 사진 image/jpeg, 원본은 그 파일 종류). 15분 유효, 안 쓰면 그냥 버려진다(파일은 안 생김) */
      if (path === '/chat/up/batch' && request.method === 'POST') {
        const b = await request.json().catch(() => ({}));
        const rid = String(b.rid || '');
        if (!env.GCS_BUCKET) return json({ ok: true, sts: [] }, 200, origin);
        await mustMember(env, me, rid);
        const tag = await roomTag(rid);
        const items = (Array.isArray(b.items) ? b.items : []).slice(0, 100);
        const sts = await Promise.all(items.map(async (it) => {
          const kind = it && it.kind === 'o' ? 'o' : 'p';
          const type = String((it && it.type) || 'image/jpeg').slice(0, 80);
          if (!/^image\//.test(type)) return null;
          const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
          const gkey = `g/${kind}/${tag}/${id}.${extOf(it && it.name, type)}`;
          const put = await gcsPutUrl(env, gkey, type, LIMIT[kind]);
          return { key: gkey, mode: 'gcs', url: put.url, h: put.h, kind, type };
        }));
        return json({ ok: true, sts }, 200, origin);
      }
      if (path === '/chat/up/put' && request.method === 'PUT') {
        const key = url.searchParams.get('key') || '';
        if (!(await same(url.searchParams.get('tk') || '', await ticket(env, key, '')))) throw new Error('올리기 허가가 올바르지 않습니다');
        const len = Number(request.headers.get('content-length') || 0);
        if (len > PART + 1024 * 1024) throw new Error('너무 큽니다');
        await env.CHAT_MEDIA.put(key, request.body, { httpMetadata: { contentType: request.headers.get('content-type') || 'application/octet-stream' } });
        return json({ ok: true, key }, 200, origin);
      }
      if (path === '/chat/up/part' && request.method === 'PUT') {
        const key = url.searchParams.get('key') || '', uid = url.searchParams.get('uid') || '';
        const n = parseInt(url.searchParams.get('n') || '0', 10);
        if (!(await same(url.searchParams.get('tk') || '', await ticket(env, key, uid)))) throw new Error('올리기 허가가 올바르지 않습니다');
        if (n < 1 || n > MAX_PARTS) throw new Error('조각 번호가 올바르지 않습니다');
        const plen = Number(request.headers.get('content-length') || 0);
        if (!plen || plen > PART + 1024 * 1024) throw new Error('조각 크기가 올바르지 않습니다');   // 조각 크기를 안 봐서 크기 제한보다 큰 파일이 올라갈 수 있었다(11/14 점검)
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
        const mine = (key) => key.startsWith(`p/${tag}/`) || key.startsWith(`o/${tag}/`) || key.startsWith(`g/p/${tag}/`) || key.startsWith(`g/o/${tag}/`);
        const ks = (b.keys || []).slice(0, 100).map(String).filter(mine);
        await Promise.all(ks.map(async (key) => { const g = await movedTo(env, key); out[key] = g ? await gcsGetUrl(env, g) : await mediaUrl(env, base, key); }));
        return json({ ok: true, urls: out, ttl: URL_TTL }, 200, origin);
      }
      return json({ ok: false, error: '없는 기능입니다' }, 404, origin);
    } catch (e) {
      return json({ ok: false, error: e.message || String(e) }, 400, origin);
    }
  };
}
