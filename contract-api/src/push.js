/**
 * 웹 푸시 — 앱을 닫아 둬도 폰·PC로 알림을 보낸다 (RFC 8291 aes128gcm + RFC 8292 VAPID).
 *
 * 라이브러리 없이 WebCrypto 로만 만든 이유: Worker 에서 node 전용 web-push 패키지는 못 쓰고,
 * 필요한 건 "암호화 한 번 + 서명 한 번" 이라 직접 쓰는 편이 짧다.
 *
 * 비밀값
 *   VAPID_PUBLIC        (vars)    앱이 구독할 때 쓰는 공개키, base64url 65바이트
 *   VAPID_PRIVATE_JWK   (secret)  같은 키쌍의 개인키 JWK
 * 구독 정보는 /pushSubs/{전화번호}/{id} = { endpoint, keys:{p256dh,auth}, device, at }.
 */

const te = new TextEncoder();

export function b64u(bytes) {
  let s = '';
  const b = new Uint8Array(bytes);
  for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
export function unb64u(s) {
  s = String(s).replace(/-/g, '+').replace(/_/g, '/');
  while (s.length % 4) s += '=';
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
function concat(...parts) {
  const len = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(len);
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}
async function hmac(key, data) {
  const k = await crypto.subtle.importKey('raw', key, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return new Uint8Array(await crypto.subtle.sign('HMAC', k, data));
}

/* 구독 하나에 보낼 본문을 암호화한다. 결과는 그대로 POST body. */
export async function encryptPayload(p256dhB64, authB64, plaintext) {
  const uaPublic = unb64u(p256dhB64);
  const authSecret = unb64u(authB64);
  if (uaPublic.length !== 65 || authSecret.length !== 16) throw new Error('구독 키 형식이 올바르지 않음');

  const as = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const asPublic = new Uint8Array(await crypto.subtle.exportKey('raw', as.publicKey));
  const uaKey = await crypto.subtle.importKey('raw', uaPublic, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const ecdh = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: uaKey }, as.privateKey, 256));

  const prkKey = await hmac(authSecret, ecdh);
  const keyInfo = concat(te.encode('WebPush: info\0'), uaPublic, asPublic, new Uint8Array([1]));
  const ikm = await hmac(prkKey, keyInfo);

  const salt = crypto.getRandomValues(new Uint8Array(16));
  const prk = await hmac(salt, ikm);
  const cek = (await hmac(prk, te.encode('Content-Encoding: aes128gcm\0\x01'))).slice(0, 16);
  const nonce = (await hmac(prk, te.encode('Content-Encoding: nonce\0\x01'))).slice(0, 12);

  const body = concat(te.encode(plaintext), new Uint8Array([2])); // 마지막 레코드 표시
  const aes = await crypto.subtle.importKey('raw', cek, { name: 'AES-GCM' }, false, ['encrypt']);
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, aes, body));

  const rs = new Uint8Array(4);
  new DataView(rs.buffer).setUint32(0, 4096);
  return concat(salt, rs, new Uint8Array([asPublic.length]), asPublic, ct);
}

/* 푸시 서비스(애플·구글·모질라)에 "보낸 쪽이 우리"임을 증명하는 서명. 같은 서비스로는 12시간 재사용. */
const jwtCache = new Map();
export async function vapidAuth(env, endpoint) {
  const aud = new URL(endpoint).origin;
  const now = Math.floor(Date.now() / 1000);
  const hit = jwtCache.get(aud);
  if (hit && hit.exp - now > 3600) return hit.header;
  const jwk = JSON.parse(env.VAPID_PRIVATE_JWK);
  const key = await crypto.subtle.importKey('jwk', jwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  const exp = now + 12 * 3600;
  const head = b64u(te.encode(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  /* sub 는 푸시 서비스가 문제가 생겼을 때 연락할 곳. 개인 메일 대신 앱 주소를 쓴다. */
  const body = b64u(te.encode(JSON.stringify({ aud, exp, sub: 'https://dminternational.github.io/dm-hq-system/' })));
  const sig = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, te.encode(head + '.' + body));
  const header = `vapid t=${head}.${body}.${b64u(sig)}, k=${env.VAPID_PUBLIC}`;
  jwtCache.set(aud, { exp, header });
  return header;
}

/* 구독 하나로 보낸다. 반환: { ok, status, gone } — gone 이면 폰에서 구독이 없어진 것이라 지워야 한다. */
export async function sendOne(env, sub, payload, opts = {}) {
  const body = await encryptPayload(sub.keys.p256dh, sub.keys.auth, JSON.stringify(payload));
  const headers = {
    'Content-Encoding': 'aes128gcm',
    'Content-Type': 'application/octet-stream',
    TTL: String(opts.ttl ?? 24 * 3600),
    Urgency: opts.urgency || 'normal',
    Authorization: await vapidAuth(env, sub.endpoint),
  };
  /* 같은 topic 은 폰에 도착하기 전이면 마지막 것만 남는다(밀린 알림이 한꺼번에 쏟아지지 않게). */
  if (opts.topic) headers.Topic = String(opts.topic).replace(/[^A-Za-z0-9_-]/g, '').slice(0, 32);
  const r = await fetch(sub.endpoint, { method: 'POST', headers, body });
  return { ok: r.ok, status: r.status, gone: r.status === 404 || r.status === 410 };
}

export async function subId(endpoint) {
  const h = await crypto.subtle.digest('SHA-256', te.encode(endpoint));
  return b64u(new Uint8Array(h).slice(0, 15));
}
