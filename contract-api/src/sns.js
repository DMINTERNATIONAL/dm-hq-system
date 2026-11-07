/* ═══ 검색 노출 — SNS (틱톡 회사 계정) ═══
   틱톡 공식 API(Login Kit + Display API)로 회사 계정 숫자를 매일 한 번 가져온다. AI 를 쓰지 않는다(무료).
   경영팀이 앱 '검색 노출 → SNS' 탭에서 한 번 '틱톡 연결'을 눌러 회사 계정으로 허용하면 된다.
     잠긴 DB  /authSecrets/__tiktok = { rt 갱신 토큰, rtx 만료, atk 접근 토큰(24시간), atx 만료, oid open_id, at, by }
     R2       seo/tt/latest.json   = { at, user{ name, username, followers, following, likes, videos }, videos[], err }
              seo/tt/hist.json     = [{ d, f 팔로워, l 좋아요 합, v 영상 수 }]  하루 한 줄, 최신이 앞, 최대 180
   설정: wrangler.toml [vars] TIKTOK_CLIENT_KEY (공개값) + secret TIKTOK_CLIENT_SECRET.
         틱톡 개발자 앱의 Redirect URI = https://dm-contract-api.swavey2803.workers.dev/tt/callback
   샤오홍슈는 공식 API 가 없어 캡처만 쓴다(seo.js 의 /seo/xhs/*). */
import { hqUser } from './aiusage.js';

const AUTH = 'https://www.tiktok.com/v2/auth/authorize/';
const API = 'https://open.tiktokapis.com/v2';
const SCOPE = 'user.info.basic,user.info.profile,user.info.stats,video.list';
const USER_F = 'open_id,display_name,username,follower_count,following_count,likes_count,video_count';
const VIDEO_F = 'id,title,video_description,create_time,share_url,duration,view_count,like_count,comment_count,share_count';
const KEY = { latest: 'seo/tt/latest.json', hist: 'seo/tt/hist.json' };
const te = new TextEncoder();
const S = (v, n) => String(v == null ? '' : v).slice(0, n);
const ymdK = (t) => new Date(t + 9 * 3600e3).toISOString().slice(0, 10);
const htmlEsc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/* AI 에게 줄 틱톡 숫자 글 */
export function ttFacts(latest, hist, now) {
  if (!latest || !latest.user) return '\n[틱톡 — 회사 계정] 아직 연결 안 됨. 경영팀이 앱 "검색 노출 → SNS" 탭에서 틱톡을 연결하도록 할 일에 넣을 것.';
  const u = latest.user, L = ['', `[틱톡 — 회사 계정 @${u.username || u.name}, 공식 API · ${ymdK(latest.at)} 기준]`];
  const ago = (n) => (hist || []).find((h) => h.d <= ymdK(now - n * 864e5));
  const w1 = ago(7), w4 = ago(28);
  L.push(`- 팔로워 ${u.followers}${w1 ? ` (7일 전 ${w1.f})` : ''}${w4 ? ` (4주 전 ${w4.f})` : ''} · 받은 좋아요 합 ${u.likes}${w1 ? ` (7일 전 ${w1.l})` : ''} · 영상 ${u.videos}개`);
  const vs = (latest.videos || []).filter((v) => now - v.t * 1000 < 45 * 864e5);
  if (vs.length) {
    const avg = Math.round(vs.reduce((s, v) => s + v.views, 0) / vs.length);
    L.push(`- 최근 45일 영상 ${vs.length}개 · 평균 조회 ${avg}. 조회 많은 순 (날짜 · 내용 · 조회 · 좋아요 · 댓글 · 공유 · 길이):`);
    for (const v of vs.slice().sort((a, b) => b.views - a.views).slice(0, 10)) L.push(`  · ${ymdK(v.t * 1000).slice(5)} "${S(v.title, 50)}" 조회 ${v.views} · 좋아요 ${v.likes} · 댓글 ${v.comments} · 공유 ${v.shares} · ${v.dur}초`);
  } else L.push('- 최근 45일 동안 올린 영상이 없음');
  if (latest.err) L.push('- 마지막 가져오기 문제: ' + latest.err);
  return L.join('\n');
}

export function makeSns(deps) {
  const { dbGet, dbPut } = deps;
  const rGet = async (env, key) => { const o = await env.CHAT_MEDIA.get(key); return o ? o.json() : null; };
  const rPut = (env, key, v) => env.CHAT_MEDIA.put(key, JSON.stringify(v), { httpMetadata: { contentType: 'application/json' } });
  const ready = (env) => !!(env.TIKTOK_CLIENT_KEY && env.TIKTOK_CLIENT_SECRET);

  /* state 서명 — 세션 · 구글 연결과 다른 접두어(tt|)라 서로 바꿔 쓸 수 없다 */
  async function hm(env, s) {
    const k = await crypto.subtle.importKey('raw', te.encode(env.SESSION_SECRET), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    const sig = new Uint8Array(await crypto.subtle.sign('HMAC', k, te.encode('tt|' + s)));
    let b = ''; for (const x of sig) b += String.fromCharCode(x);
    return btoa(b).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
  }
  /* 이름이 한글이라 UTF-8 로 바꿔서 base64 */
  const b64u = (str) => { let b = ''; for (const x of te.encode(str)) b += String.fromCharCode(x); return btoa(b).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_'); };
  const unb64u = (s) => new TextDecoder().decode(Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0)));
  async function mkState(env, p) {
    const body = b64u(JSON.stringify(p));
    return body + '.' + await hm(env, body);
  }
  async function readState(env, st) {
    const [body, sig] = String(st || '').split('.');
    if (!body || !sig || sig !== await hm(env, body)) return null;
    try { const p = JSON.parse(unb64u(body)); return p && p.exp > Date.now() ? p : null; } catch (_) { return null; }
  }
  const redirectUri = (url) => url.origin + '/tt/callback';
  const form = (o) => ({ method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(o) });

  async function token(env, fx, o) {
    const r = await (fx || fetch)(API + '/oauth/token/', form({ client_key: env.TIKTOK_CLIENT_KEY, client_secret: env.TIKTOK_CLIENT_SECRET, ...o }));
    const j = await r.json().catch(() => ({}));
    if (!r.ok || !j.access_token) throw new Error('틱톡 인증 실패 (' + S(j.error || j.error_description || r.status, 60) + ')');
    return j;
  }
  const secOf = (j, prev, by) => {
    const now = Date.now();
    return { rt: j.refresh_token || (prev && prev.rt) || '', rtx: now + (+j.refresh_expires_in || 365 * 86400) * 1000, atk: j.access_token, atx: now + ((+j.expires_in || 86400) - 120) * 1000, oid: j.open_id || (prev && prev.oid) || '', at: (prev && prev.at) || now, by: by || (prev && prev.by) || '' };
  };

  /* 회사 계정 숫자 가져오기 — 접근 토큰이 만료됐으면 갱신 토큰으로 새로 받는다 */
  async function collect(env, fx) {
    const f = fx || fetch;
    let sec = await dbGet(env, '/authSecrets/__tiktok').catch(() => null);
    if (!sec || !sec.rt) return null;
    const prev = (await rGet(env, KEY.latest).catch(() => null)) || {};
    try {
      if (!sec.atk || Date.now() > sec.atx) {
        sec = secOf(await token(env, f, { grant_type: 'refresh_token', refresh_token: sec.rt }), sec);
        await dbPut(env, '/authSecrets/__tiktok', sec);
      }
      const H = { Authorization: 'Bearer ' + sec.atk };
      const ur = await f(API + '/user/info/?fields=' + USER_F, { headers: H });
      const uj = await ur.json().catch(() => ({}));
      if (!ur.ok || (uj.error && uj.error.code && uj.error.code !== 'ok')) throw new Error('틱톡 계정 정보 (' + S((uj.error && uj.error.code) || ur.status, 60) + ')');
      const x = (uj.data && uj.data.user) || {};
      const user = { name: S(x.display_name, 60), username: S(x.username, 60), followers: +x.follower_count || 0, following: +x.following_count || 0, likes: +x.likes_count || 0, videos: +x.video_count || 0 };
      const videos = [];
      let cursor = 0;
      for (let p = 0; p < 3; p++) {   /* 최근 60개까지 */
        const vr = await f(API + '/video/list/?fields=' + VIDEO_F, { method: 'POST', headers: { ...H, 'Content-Type': 'application/json' }, body: JSON.stringify(p ? { max_count: 20, cursor } : { max_count: 20 }) });
        const vj = await vr.json().catch(() => ({}));
        if (!vr.ok || (vj.error && vj.error.code && vj.error.code !== 'ok')) throw new Error('틱톡 영상 목록 (' + S((vj.error && vj.error.code) || vr.status, 60) + ')');
        const d = vj.data || {};
        for (const v of d.videos || []) videos.push({ id: S(v.id, 40), t: +v.create_time || 0, title: S(v.title || v.video_description, 120), url: /^https:\/\//.test(v.share_url || '') ? S(v.share_url, 300) : '', dur: +v.duration || 0, views: +v.view_count || 0, likes: +v.like_count || 0, comments: +v.comment_count || 0, shares: +v.share_count || 0 });
        if (!d.has_more || !d.cursor) break;
        cursor = d.cursor;
      }
      const now = Date.now(), latest = { at: now, user, videos, err: '' };
      await rPut(env, KEY.latest, latest);
      const hist = ((await rGet(env, KEY.hist).catch(() => null)) || []).filter((h) => h.d !== ymdK(now));
      hist.unshift({ d: ymdK(now), f: user.followers, l: user.likes, v: user.videos });
      await rPut(env, KEY.hist, hist.slice(0, 180));
      return latest;
    } catch (e) {
      const err = S((e && e.message) || e, 200);
      await rPut(env, KEY.latest, { ...prev, err, errAt: Date.now() }).catch(() => {});
      return { ...prev, err };
    }
  }

  /* 1분 크론 — 매일 새벽 5시(한국)에 한 번 */
  async function tick(env) {
    const k = new Date(Date.now() + 9 * 3600e3);
    if (k.getUTCHours() !== 5 || k.getUTCMinutes() > 9 || !ready(env)) return null;
    const l = await rGet(env, KEY.latest).catch(() => null);
    if (l && Date.now() - Math.max(l.at || 0, l.errAt || 0) < 20 * 3600e3) return null;
    return collect(env);
  }

  /* 주간 조사용 — 오래됐으면(20시간) 새로 가져온다 */
  async function forReport(env) {
    if (!ready(env)) return '';
    let l = await rGet(env, KEY.latest).catch(() => null);
    if (!l || Date.now() - (l.at || 0) > 20 * 3600e3) l = (await collect(env).catch(() => null)) || l;
    return ttFacts(l, await rGet(env, KEY.hist).catch(() => null), Date.now());
  }

  async function callback(request, env, ctx, url) {
    const err = url.searchParams.get('error');
    if (err) return page(false, err === 'access_denied' ? '연결을 취소했어요. 다시 하려면 DM 앱 검색 노출 → SNS 에서 눌러 주세요.' : '틱톡이 연결을 거절했어요 (' + htmlEsc(S(err, 40)) + ')');
    const st = await readState(env, url.searchParams.get('state'));
    if (!st) return page(false, '연결 시간이 지났어요. DM 앱에서 다시 눌러 주세요.');
    const code = url.searchParams.get('code');
    if (!code) return page(false, '틱톡에서 받은 값이 없어요. 다시 시도해 주세요.');
    const u = await dbGet(env, '/users/' + encodeURIComponent(st.ph)).catch(() => null);
    if (!st.owner && !hqUser(u)) return page(false, '경영팀만 연결할 수 있어요.');
    let j;
    try { j = await token(env, null, { code, grant_type: 'authorization_code', redirect_uri: redirectUri(url) }); } catch (e) { return page(false, htmlEsc(e.message) + ' 다시 시도해 주세요.'); }
    const scopes = String(j.scope || '').split(',');
    const miss = ['user.info.stats', 'video.list'].filter((s) => scopes.indexOf(s) < 0);
    if (miss.length) return page(false, '숫자를 볼 권한이 빠졌어요. 다시 연결하면서 모든 항목을 허용해 주세요.');
    await dbPut(env, '/authSecrets/__tiktok', secOf(j, null, String(st.nm || '')));
    ctx.waitUntil(collect(env).catch((e) => console.log('tt first', e && e.message)));
    return page(true, '틱톡 회사 계정을 연결했어요. 잠시 뒤 DM 앱 검색 노출 → SNS 에서 숫자를 확인하세요.');
  }

  async function stop(env) {
    const sec = await dbGet(env, '/authSecrets/__tiktok').catch(() => null);
    if (sec && sec.atk && ready(env)) await fetch(API + '/oauth/revoke/', form({ client_key: env.TIKTOK_CLIENT_KEY, client_secret: env.TIKTOK_CLIENT_SECRET, token: sec.atk })).catch(() => {});
    await dbPut(env, '/authSecrets/__tiktok', null);
    await env.CHAT_MEDIA.delete(KEY.latest).catch(() => {});
  }

  /* 경영팀만 — seo.js 가 경영팀 확인 후 넘긴다 */
  async function route(path, b, env, me, url) {
    if (path === '/seo/sns') {
      let latest = await rGet(env, KEY.latest).catch(() => null), note = '';
      if (b.refresh) {
        if (latest && Date.now() - Math.max(latest.at || 0, latest.errAt || 0) < 10 * 60000) note = '방금 불러왔어요. 10분 뒤에 다시 할 수 있어요';
        else latest = (await collect(env)) || latest;
      }
      const sec = await dbGet(env, '/authSecrets/__tiktok').catch(() => null);
      return { ok: true, ready: ready(env), on: !!(sec && sec.rt), by: (sec && sec.by) || '', since: (sec && sec.at) || 0, rtx: (sec && sec.rtx) || 0, latest, hist: ((await rGet(env, KEY.hist).catch(() => null)) || []).slice(0, 60), note };
    }
    if (path === '/seo/tt/start') {
      if (!ready(env)) return { ok: false, error: '틱톡 개발자 앱 설정이 아직 안 됐어요' };
      const state = await mkState(env, { ph: String(me.ph), nm: S(me.name, 30), owner: me.role === 'owner' || me.admin === true, exp: Date.now() + 15 * 60000 });
      const q = new URLSearchParams({ client_key: env.TIKTOK_CLIENT_KEY, response_type: 'code', scope: SCOPE, redirect_uri: redirectUri(url), state });
      return { ok: true, url: AUTH + '?' + q };
    }
    if (path === '/seo/tt/stop') { await stop(env); return { ok: true }; }
    return null;
  }

  return { route, callback, tick, collect, forReport, ready };
}

function page(ok, msg) {
  const html = `<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>DM · 틱톡 연결</title><style>
:root{--bg:#F8FAFC;--card:#fff;--t:#0F172A;--t2:#475569;--line:#E2E8F0;--ok:#16A34A;--no:#DC2626;--btn:#0F172A;--btnt:#fff}
@media(prefers-color-scheme:dark){:root{--bg:#0B1220;--card:#111827;--t:#F1F5F9;--t2:#94A3B8;--line:#1F2937;--ok:#4ADE80;--no:#F87171;--btn:#F1F5F9;--btnt:#0F172A}}
body{margin:0;background:var(--bg);color:var(--t);font-family:-apple-system,BlinkMacSystemFont,'Apple SD Gothic Neo','Noto Sans KR',sans-serif;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:24px 16px;box-sizing:border-box}
.c{background:var(--card);border:1px solid var(--line);border-radius:20px;padding:32px 24px;max-width:400px;width:100%;text-align:center}
.i{font-size:40px;color:${ok ? 'var(--ok)' : 'var(--no)'}}h1{font-size:19px;margin:12px 0 8px}p{font-size:14.5px;line-height:1.6;color:var(--t2);margin:0 0 22px}
a{display:inline-block;background:var(--btn);color:var(--btnt);text-decoration:none;font-weight:700;padding:12px 22px;border-radius:12px;font-size:15px}
</style></head><body><div class="c"><div class="i">${ok ? '✓' : '!'}</div><h1>${ok ? '연결했어요' : '연결하지 못했어요'}</h1><p>${msg}</p><a href="https://dminternational.github.io/dm-hq-system/#seo">DM 앱으로 돌아가기</a></div></body></html>`;
  return new Response(html, { status: ok ? 200 : 400, headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' } });
}
