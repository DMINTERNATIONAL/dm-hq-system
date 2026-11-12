/**
 * 채팅 사진 — 구글 클라우드 서울 저장소(GCS 버킷 env.GCS_BUCKET, asia-northeast3) (11/12).
 *
 * 왜: 한국에서 Cloudflare(*.workers.dev) 로 가는 요청은 미국 LAX 를 거쳐 한 번에 1~2.6초 걸렸다.
 *     구글 저장소는 서울에서 바로 받아 0.1초 안팎. 사진은 앱이 서울 저장소에 직접 올리고 직접 받는다.
 * 버킷은 비공개(공개 접근 막기). 서비스 계정(FIREBASE_SA)으로 서명한 주소로만 올리고 받는다 — 서명은 여기서 계산만 하고 구글에 묻지 않는다.
 *   받기: 하루 단위로 같은 주소(그날 0시 UTC 서명, 7일 유효) — 기기에 저장된 사진을 그대로 다시 쓴다.
 *   올리기: 15분짜리 PUT 주소. 크기 한도(x-goog-content-length-range)와 저장 머리글(Cache-Control)을 서명에 넣어 바꿀 수 없게.
 * 키: g/p/{방 태그}/… 보통 · 작은 사진 · 동영상 첫 장면 / g/o/{방 태그}/… 원본 사진(90일 뒤 자동 삭제 — 버킷 수명 규칙, setup 이 넣음)
 * 동영상 · 파일은 그대로 R2(media.js).
 */
const te = new TextEncoder();
const HOST = 'storage.googleapis.com';
const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
const enc = (s) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());
export const CACHE_HDR = 'private, max-age=604800, immutable';

let _sa = null, _saRaw = null;
async function saKey(env) {
  if (_sa && _saRaw === env.FIREBASE_SA) return _sa;
  const sa = JSON.parse(env.FIREBASE_SA);
  const body = sa.private_key.replace(/-----BEGIN[^-]+-----|-----END[^-]+-----/g, '').replace(/\s+/g, '');
  const bin = atob(body); const der = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) der[i] = bin.charCodeAt(i);
  const k = await crypto.subtle.importKey('pkcs8', der.buffer, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign']);
  _sa = { k, email: sa.client_email }; _saRaw = env.FIREBASE_SA;
  return _sa;
}

/* V4 서명 주소 (GOOG4-RSA-SHA256). headers 는 받는 쪽(앱)이 똑같이 보내야 하는 머리글 */
export async function gcsSign(env, method, key, { expires = 900, at = new Date(), headers = {} } = {}) {
  const { k, email } = await saKey(env);
  const dt = at.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  const scope = `${dt.slice(0, 8)}/auto/storage/goog4_request`;
  const hs = { host: HOST };
  for (const [n, v] of Object.entries(headers)) hs[n.toLowerCase()] = String(v).trim();
  const names = Object.keys(hs).sort();
  const signedHeaders = names.join(';');
  const q = { 'X-Goog-Algorithm': 'GOOG4-RSA-SHA256', 'X-Goog-Credential': `${email}/${scope}`, 'X-Goog-Date': dt, 'X-Goog-Expires': String(expires), 'X-Goog-SignedHeaders': signedHeaders };
  const qs = Object.keys(q).sort().map((n) => `${enc(n)}=${enc(q[n])}`).join('&');
  const path = `/${env.GCS_BUCKET}/${key.split('/').map(enc).join('/')}`;
  const canon = [method, path, qs, names.map((n) => `${n}:${hs[n]}\n`).join(''), signedHeaders, 'UNSIGNED-PAYLOAD'].join('\n');
  const sts = ['GOOG4-RSA-SHA256', dt, scope, hex(await crypto.subtle.digest('SHA-256', te.encode(canon)))].join('\n');
  const sig = hex(await crypto.subtle.sign('RSASSA-PKCS1-v1_5', k, te.encode(sts)));
  return `https://${HOST}${path}?${qs}&X-Goog-Signature=${sig}`;
}

/* 받기 주소 — 그날(UTC) 0시에 서명한 7일짜리라 하루 동안 주소가 같다 */
export function gcsGetUrl(env, key) {
  const d = new Date(); d.setUTCHours(0, 0, 0, 0);
  return gcsSign(env, 'GET', key, { expires: 604800, at: d });
}

/* 올리기 주소 */
export async function gcsPutUrl(env, key, type, max) {
  const headers = { 'Content-Type': type, 'Cache-Control': CACHE_HDR, 'x-goog-content-length-range': `0,${max}` };
  return { url: await gcsSign(env, 'PUT', key, { expires: 900, headers }), h: headers };
}

/* 버킷 안 복사 (전달할 때) */
export async function gcsCopy(env, gToken, src, dst) {
  const t = await gToken(env, 'https://www.googleapis.com/auth/devstorage.read_write');
  const b = enc(env.GCS_BUCKET);
  const r = await fetch(`https://storage.googleapis.com/storage/v1/b/${b}/o/${enc(src)}/copyTo/b/${b}/o/${enc(dst)}?fields=name`, { method: 'POST', headers: { Authorization: 'Bearer ' + t, 'Content-Type': 'application/json' }, body: '{}' });
  if (r.status === 404) return false;
  if (!r.ok) throw new Error('사진 복사 실패 ' + r.status);
  return true;
}

/* 버킷 설정(앱에서 바로 올리고 받게 CORS · 원본 90일 삭제) — 한 번만. 매일 확인해 다르면 다시 맞춘다 */
const WANT = {
  cors: [{ origin: ['*'], method: ['GET', 'HEAD', 'PUT'], responseHeader: ['Content-Type', 'Content-Length', 'Content-Range', 'Cache-Control', 'ETag', 'x-goog-content-length-range'], maxAgeSeconds: 3600 }],
  lifecycle: { rule: [{ action: { type: 'Delete' }, condition: { age: 90, matchesPrefix: ['g/o/'] } }] },
};
export async function gcsSetup(env, gToken) {
  if (!env.GCS_BUCKET) return { ok: false, error: 'GCS_BUCKET 없음' };
  const t = await gToken(env, 'https://www.googleapis.com/auth/devstorage.full_control');
  const u = `https://storage.googleapis.com/storage/v1/b/${enc(env.GCS_BUCKET)}`;
  const cur = await fetch(u + '?fields=cors,lifecycle,location', { headers: { Authorization: 'Bearer ' + t } });
  if (!cur.ok) return { ok: false, error: '버킷 읽기 실패 ' + cur.status + ' ' + (await cur.text()).slice(0, 200) };
  const c = await cur.json();
  if (JSON.stringify(c.cors || null) === JSON.stringify(WANT.cors) && JSON.stringify((c.lifecycle || {}).rule || null) === JSON.stringify(WANT.lifecycle.rule)) return { ok: true, same: true, location: c.location };
  const r = await fetch(u + '?fields=cors,lifecycle', { method: 'PATCH', headers: { Authorization: 'Bearer ' + t, 'Content-Type': 'application/json' }, body: JSON.stringify(WANT) });
  if (!r.ok) return { ok: false, error: '버킷 설정 실패 ' + r.status + ' ' + (await r.text()).slice(0, 200) };
  return { ok: true, set: true, location: c.location };
}
