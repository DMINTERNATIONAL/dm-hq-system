/* ═══ 검색 노출 — SNS (틱톡 회사 계정 · 두 개: DAY:MEAN · 바버샵) ═══
   틱톡 공식 API(Login Kit + Display API)로 회사 계정 숫자를 매일 한 번 가져온다. AI 를 쓰지 않는다(무료).
   경영팀이 앱 '검색 노출 → SNS' 탭의 계정 칸마다 '틱톡 연결'을 눌러 그 계정으로 허용하면 된다.
   계정 칸(slot)은 SLOTS 에 고정 — dm(DAY:MEAN) · bb(바버샵). 칸마다 따로 저장한다.
     잠긴 DB  /authSecrets/__tiktok/{slot} = { rt 갱신 토큰, rtx 만료, atk 접근 토큰(24시간), atx 만료, oid open_id, at, by }
     R2       seo/tt/{slot}/latest.json   = { at, user{ name, username, followers, following, likes, videos }, videos[], err }
              seo/tt/{slot}/hist.json     = [{ d, f 팔로워, l 좋아요 합, v 영상 수 }]  하루 한 줄, 최신이 앞, 최대 180
   틱톡 개발자 앱은 Sandbox(심사 없음) — 연결할 틱톡 계정을 개발자 사이트 Target users 에 먼저 넣어야 한다.
   설정: wrangler.toml [vars] TIKTOK_CLIENT_KEY (공개값) + secret TIKTOK_CLIENT_SECRET.
         틱톡 개발자 앱의 Redirect URI = https://dm-contract-api.swavey2803.workers.dev/tt/callback
   샤오홍슈는 공식 API 가 없어 캡처만 쓴다(seo.js 의 /seo/xhs/*). */
import { hqUser } from './aiusage.js';

const AUTH = 'https://www.tiktok.com/v2/auth/authorize/';
const API = 'https://open.tiktokapis.com/v2';
const SCOPE = 'user.info.basic,user.info.profile,user.info.stats,video.list';
const USER_F = 'open_id,display_name,username,follower_count,following_count,likes_count,video_count';
const VIDEO_F = 'id,title,video_description,create_time,share_url,cover_image_url,duration,view_count,like_count,comment_count,share_count';
export const SLOTS = [{ id: 'dm', label: 'DAY:MEAN' }, { id: 'bb', label: '바버샵' }];
const slotOf = (id) => SLOTS.find((x) => x.id === id) || null;
const KEY = { latest: (id) => `seo/tt/${id}/latest.json`, hist: (id) => `seo/tt/${id}/hist.json` };
const SEC = (id) => '/authSecrets/__tiktok/' + id;
const AIK = (id) => `seo/tt/${id}/ai.json`;
/* 영상 표지 — 틱톡이 주는 표지 주소는 6시간이면 막혀서 R2 에 한 번 받아 두고 /ttc/{slot}/{영상 id} 로 보여 준다 */
const CVK = (id, vid) => `seo/tt/${id}/cv/${vid}`;
/* 예약 링크 추적 — 틱톡 프로필 링크를 우리 주소로 걸면 예약 페이지로 넘겨 주면서 하루 클릭 수를 센다 (개인정보 안 남김) */
const KX = { link: (id) => `seo/tt/${id}/link.json`, clicks: (id) => `seo/tt/${id}/clicks.json`, visits: 'seo/tt/visits.json' };
/* 틱톡 프로필에 거는 주소 — 회사 GitHub Pages 의 t/{slot}/ 가 이 Worker 의 /go/{slot} 로 바로 넘긴다 */
export const TRACK_URL = (id) => `https://dminternational.github.io/dm-hq-system/t/${id}/`;
const BOT_UA = /bot|crawl|spider|preview|slurp|bytespider|facebookexternalhit|headless|curl|wget|python|okhttp|go-http/i;   /* AI 분석 — { report, at, base(분석한 숫자 시각), by } */
const AI_WEEK_CAP = 30;   /* 한 주(월요일 시작)에 회사 전체 틱톡 AI 분석 상한 — 계정마다 하루 한 번이라 평소엔 14번 이하 */
const te = new TextEncoder();
const S = (v, n) => String(v == null ? '' : v).slice(0, n);
const ymdK = (t) => new Date(t + 9 * 3600e3).toISOString().slice(0, 10);
const htmlEsc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/* AI 에게 줄 틱톡 숫자 글 */
export function ttFacts(latest, hist, now, label) {
  const lb = label || '회사 계정';
  if (!latest || !latest.user) return `\n[틱톡 — ${lb}] 아직 연결 안 됨. 경영팀이 앱 "검색 노출 → SNS" 탭에서 ${lb} 틱톡을 연결하도록 할 일에 넣을 것.`;
  const u = latest.user, L = ['', `[틱톡 — ${lb} @${u.username || u.name}, 공식 API · ${ymdK(latest.at)} 기준]`];
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

/* AI 분석에 줄 글 — 계정 숫자 · 팔로워 흐름 · 영상 하나하나(제목 · 설명 포함) */
const WDK = ['일', '월', '화', '수', '목', '금', '토'];
export function ttAiFacts(label, latest, hist, now) {
  const u = latest.user, V = latest.videos || [];
  const whenK = (t) => { const d = new Date(t * 1000 + 9 * 3600e3); return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}(${WDK[d.getUTCDay()]}) ${d.getUTCHours()}시`; };
  const L = [`오늘: ${ymdK(now)}`, `[틱톡 회사 계정 — ${label} @${u.username || u.name}]`,
    `팔로워 ${u.followers} · 팔로잉 ${u.following} · 받은 좋아요 합 ${u.likes} · 전체 영상 ${u.videos}개 (아래는 최근 ${V.length}개)`];
  const H = (hist || []).slice(0, 30);
  if (H.length > 1) L.push('팔로워 기록(최신이 앞): ' + H.map((h) => `${h.d.slice(5)} ${h.f}`).join(' · '));
  else L.push('팔로워 기록: 오늘 처음 연결해서 아직 흐름이 없음');
  if (V.length) {
    const tot = V.reduce((a, v) => a + v.views, 0), sv = V.map((v) => v.views).sort((a, b) => a - b);
    L.push(`최근 ${V.length}개 영상 조회 합 ${tot} · 평균 ${Math.round(tot / V.length)} · 중간값 ${sv[V.length >> 1]} · 좋아요 합 ${V.reduce((a, v) => a + v.likes, 0)} · 댓글 합 ${V.reduce((a, v) => a + v.comments, 0)} · 공유 합 ${V.reduce((a, v) => a + v.shares, 0)}`);
    L.push('', '영상 목록 (최신순). 길이 0초는 틱톡이 길이를 안 준 것 — 사진(슬라이드) 게시물일 수 있음. 영상을 말할 때는 맨 앞 번호를 [V3] 처럼 붙일 것.', '번호 | 게시 시각(한국) | 길이 | 조회 | 좋아요 | 댓글 | 공유 | 제목 · 설명');
    V.forEach((v, i) => L.push(['V' + (i + 1), whenK(v.t), v.dur + '초', v.views, v.likes, v.comments, v.shares, S(v.title, 500).replace(/\s+/g, ' ')].join(' | ')));
    /* 해시태그별 비교 — 올린 지 3~120일 된 영상끼리 (새 영상은 조회가 덜 쌓였고, 아주 옛날 것은 시기가 다르다) */
    const C = V.filter((v) => { const a = now / 1000 - v.t; return v.t && a >= 3 * 86400 && a < 120 * 86400; });
    const avg = (a) => (a.length ? Math.round(a.reduce((x, v) => x + v.views, 0) / a.length) : 0);
    const T = {};
    for (const v of C) for (const t of ttTags(v.title)) (T[t] = T[t] || []).push(v);
    const rows = Object.keys(T).filter((t) => T[t].length >= 3).map((t) => { const w = T[t], wo = C.filter((v) => w.indexOf(v) < 0); return { t, n: w.length, a: avg(w), o: wo.length ? avg(wo) : null }; }).sort((p, q) => q.n - p.n).slice(0, 25);
    if (rows.length) {
      L.push('', `해시태그별 (올린 지 3~120일 된 영상 ${C.length}개, 3번 이상 쓴 태그) — 태그 | 쓴 영상 수 | 쓴 영상 평균 조회 | 안 쓴 영상 평균 조회`);
      for (const r of rows) L.push(`${r.t} | ${r.n} | ${r.a} | ${r.o == null ? '(모든 영상에 씀 — 비교 불가)' : r.o}`);
    }
  }
  if (!V.length) L.push('올린 영상 없음');
  return L.join('\n');
}
/* AI 가 [V3] 처럼 적은 영상 번호 → 그 영상 (분석한 때의 목록 순서라 따로 남겨 둔다) */
export function vrefOf(report, videos) {
  const V = videos || [], out = {}, txt = JSON.stringify(report || {});
  const groups = txt.match(/\[[^\]]{1,40}\]/g) || [];
  for (const g of groups) for (const m of g.match(/V(\d{1,2})/g) || []) {
    const n = +m.slice(1), v = V[n - 1];
    if (v && !out[m] && Object.keys(out).length < 30) out[m] = { id: v.id, url: v.url || '', t: v.t || 0, title: S(v.title, 80), views: v.views || 0, cv: v.cv ? 1 : 0 };
  }
  return out;
}
/* 캡션에서 해시태그 뽑기 (소문자, 끝 문장부호 뺌, 중복 없이) */
export function ttTags(t) {
  const m = String(t || '').match(/#[^\s#]+/g) || [];
  return m.map((x) => x.toLowerCase().replace(/[.,!?…:;)\]]+$/, '')).filter((x, i, a) => x.length > 1 && a.indexOf(x) === i);
}


/* 주간 조사용 — 예약 링크 클릭 · 사전상담 '틱톡' 방문 */
export function funnelFacts(label, days, link, vis, id) {
  const L = [];
  const sum = (n) => { let c = 0, u = 0; for (let i = 0; i < n; i++) { const d = ymdK(Date.now() - i * 864e5), x = days && days[d]; if (x) { c += x.c; u += x.u; } } return { c, u }; };
  if (link && link.url) { const a = sum(7), b = sum(30); L.push(`- 프로필 예약 링크 클릭: 최근 7일 ${a.u}명(${a.c}번) · 30일 ${b.u}명(${b.c}번)`); }
  else L.push('- 프로필 예약 링크 추적: 아직 안 걸었음 (경영팀이 SNS 탭에서 예약 페이지 주소를 넣고 틱톡 프로필 링크를 바꾸도록 할 일에 넣을 것)');
  if (vis && vis.months) {
    const ms = Object.keys(vis.months).sort().reverse().slice(0, 3);
    const rows = ms.map((m) => { const o = vis.months[m][id]; return o ? `${m} 첫 방문 ${o.first}명 중 '틱톡 보고 옴' ${o.tt}명 (경로 답한 ${o.rt}명 기준 ${o.rt ? Math.round(o.tt / o.rt * 100) : 0}%)` : `${m} 기록 없음`; });
    L.push('- 사전상담 알게 된 경로: ' + rows.join(' · '));
  }
  return L.length ? `\n[틱톡 → 예약 — ${label}]\n` + L.join('\n') : '';
}

export function makeSns(deps) {
  const { dbGet, dbPut, relayCall } = deps;
  const rGet = async (env, key) => { const o = await env.CHAT_MEDIA.get(key); return o ? o.json() : null; };
  const rPut = (env, key, v) => env.CHAT_MEDIA.put(key, JSON.stringify(v), { httpMetadata: { contentType: 'application/json' } });
  const ready = (env) => !!(env.TIKTOK_CLIENT_KEY && env.TIKTOK_CLIENT_SECRET);
  const aiBusy = new Map();   /* 같은 계정 AI 분석을 동시에 두 번 하지 않게 (같은 Worker 안에서만) */
  const weekKeyK = (ms) => { const d = new Date(ms + 9 * 3600e3); const back = (d.getUTCDay() + 6) % 7; return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - back)).toISOString().slice(0, 10); };

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
  async function collect(env, id, fx) {
    const f = fx || fetch;
    let sec = await dbGet(env, SEC(id)).catch(() => null);
    if (!sec || !sec.rt) return null;
    const prev = (await rGet(env, KEY.latest(id)).catch(() => null)) || {};
    try {
      if (!sec.atk || Date.now() > sec.atx) {
        sec = secOf(await token(env, f, { grant_type: 'refresh_token', refresh_token: sec.rt }), sec);
        await dbPut(env, SEC(id), sec);
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
        for (const v of d.videos || []) videos.push({ id: S(v.id, 40), cu: /^https:\/\//.test(v.cover_image_url || '') ? S(v.cover_image_url, 1500) : '', t: +v.create_time || 0, title: S([v.video_description, v.title].map((x) => String(x || '')).sort((p, q) => q.length - p.length)[0], 1500),   /* 캡션 전체 — 해시태그가 끝에 붙어서 자르면 안 된다 */ url: /^https:\/\//.test(v.share_url || '') ? S(v.share_url, 300) : '', dur: +v.duration || 0, views: +v.view_count || 0, likes: +v.like_count || 0, comments: +v.comment_count || 0, shares: +v.share_count || 0 });
        if (!d.has_more || !d.cursor) break;
        cursor = d.cursor;
      }
      const had = {};
      for (const v of prev.videos || []) if (v.cv) had[v.id] = 1;
      for (const v of videos) if (had[v.id]) v.cv = 1;   /* 이미 받아 둔 표지 */
      const now = Date.now(), latest = { at: now, user, videos, err: '' };
      await rPut(env, KEY.latest(id), latest);
      const hist = ((await rGet(env, KEY.hist(id)).catch(() => null)) || []).filter((h) => h.d !== ymdK(now));
      hist.unshift({ d: ymdK(now), f: user.followers, l: user.likes, v: user.videos, vw: videos.reduce((a, x) => a + x.views, 0), n: videos.length });   /* vw: 가져온 영상(최근 60개) 조회 합 — 하루하루 차이 ≈ 새로 본 수 */
      await rPut(env, KEY.hist(id), hist.slice(0, 180));
      return latest;
    } catch (e) {
      const err = S((e && e.message) || e, 200);
      await rPut(env, KEY.latest(id), { ...prev, err, errAt: Date.now() }).catch(() => {});
      return { ...prev, err };
    }
  }

  /* 표지 받아 두기 — 한 번에 n개까지 (1분 크론이 다른 일도 해서 한 번에 많이 부르지 않는다). 최근 12개 · 조회 많은 순 먼저 */
  async function covers(env, id, n) {
    const L = await rGet(env, KEY.latest(id)).catch(() => null);
    if (!L || !Array.isArray(L.videos)) return 0;
    const V = L.videos, top = V.slice(0, 12), rest = V.slice(12).sort((a, b) => b.views - a.views);
    const todo = top.concat(rest).filter((v) => v.cu && !v.cv && /^\d{5,30}$/.test(v.id)).slice(0, n);
    if (!todo.length) return 0;
    let got = 0;
    for (const v of todo) {
      try {
        const r = await fetch(v.cu, { headers: { 'User-Agent': 'Mozilla/5.0' } });
        const ct = r.headers.get('content-type') || '';
        const buf = r.ok && /^image\//.test(ct) ? await r.arrayBuffer() : null;
        if (buf && buf.byteLength > 200 && buf.byteLength < 1500000) { await env.CHAT_MEDIA.put(CVK(id, v.id), buf, { httpMetadata: { contentType: ct.split(';')[0] } }); v.cv = 1; got++; }
        else v.cu = '';   /* 막힌 주소 — 다음에 새로 가져올 때 다시 */
      } catch (_) { v.cu = ''; }
    }
    /* 그사이 새로 가져왔을 수 있어서 다시 읽고 표시만 옮긴다 */
    const cur = await rGet(env, KEY.latest(id)).catch(() => null);
    if (cur && Array.isArray(cur.videos)) {
      const M = {}; for (const v of todo) M[v.id] = v;
      for (const v of cur.videos) { const x = M[v.id]; if (x) { if (x.cv) v.cv = 1; if (!x.cu && !x.cv) v.cu = ''; } }
      await rPut(env, KEY.latest(id), cur);
    }
    return got;
  }
  /* 공개 — 표지 이미지 (우리 회사 틱톡에 이미 공개된 표지) */
  async function cover(env, id, vid) {
    const o = slotOf(id) && /^\d{5,30}$/.test(vid) ? await env.CHAT_MEDIA.get(CVK(id, vid)).catch(() => null) : null;
    if (!o) return new Response('', { status: 404, headers: { 'Cache-Control': 'no-store' } });
    return new Response(o.body, { headers: { 'Content-Type': (o.httpMetadata && o.httpMetadata.contentType) || 'image/jpeg', 'Cache-Control': 'public, max-age=604800' } });
  }

  /* 1분 크론 — 매일 새벽 5시(한국)에 한 번 */
  /* 사전상담 '알게 된 경로' — 첫 방문 손님 중 틱톡 보고 온 사람 (달 · 매장별). 하루 한 번 다시 센다 */
  async function visits(env, force) {
    const cur = await rGet(env, KX.visits).catch(() => null);
    if (!force && cur && Date.now() - cur.at < 20 * 3600e3) return cur;
    const all = (await dbGet(env, '/consults').catch(() => null)) || {};
    const M = {}, since = Date.now() - 400 * 864e5;
    for (const k of Object.keys(all)) {
      const r = all[k];
      if (!r || !r.ts || r.ts < since || r.visitType === 'revisit') continue;
      const br = String(r.branch || '') + ' ' + String(r.source || '');
      const sl = /합정|etoh|에토|barber/i.test(br) ? 'bb' : /플래그십|모먼트|day\s*:?\s*mean|데이민/i.test(br) ? 'dm' : null;
      if (!sl) continue;
      const m = ymdK(r.ts).slice(0, 7);
      M[m] = M[m] || {};
      const o = (M[m][sl] = M[m][sl] || { first: 0, tt: 0, rt: 0 });
      o.first++;
      if (r.route) o.rt++;   /* 경로를 고른 사람 수 — 비율의 분모 */
      if (r.route === '틱톡' || /tiktok|틱톡|抖音/i.test(String(r.routeEtc || ''))) o.tt++;
    }
    const out = { at: Date.now(), months: M };
    await rPut(env, KX.visits, out);
    return out;
  }
  /* 공개 — 틱톡 프로필 링크를 누르면 여기로 와서 예약 페이지로 넘어간다. 셈은 넘긴 뒤에 */
  async function go(request, env, ctx, id) {
    const slot = slotOf(id);
    const L = slot ? await rGet(env, KX.link(slot.id)).catch(() => null) : null;
    if (!L || !L.url) return new Response('<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><p style="font-family:sans-serif;padding:24px">예약 링크를 준비 중이에요. / Booking link coming soon.</p>', { status: 200, headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' } });
    const ua = request.headers.get('user-agent') || '';
    if (request.method === 'GET' && ua && !BOT_UA.test(ua)) ctx.waitUntil(countClick(env, slot.id, request.headers.get('cf-connecting-ip') || '').catch(() => {}));
    return new Response(null, { status: 302, headers: { Location: L.url, 'Cache-Control': 'no-store' } });
  }
  async function countClick(env, id, ip) {
    const d = ymdK(Date.now());
    /* 같은 사람이 하루에 여러 번 눌러도 '사람 수'는 한 번 — IP 는 날짜와 섞어 해시 10자만, 그날만 들고 있다 */
    const h = (await hm(env, 'click|' + d + '|' + ip)).slice(0, 10);
    const C = (await rGet(env, KX.clicks(id)).catch(() => null)) || { days: {}, t: { d: '', h: [] } };
    if (!C.t || C.t.d !== d) C.t = { d, h: [] };
    const day = (C.days[d] = C.days[d] || { c: 0, u: 0 });
    day.c++;
    if (C.t.h.indexOf(h) < 0) { C.t.h.push(h); day.u++; if (C.t.h.length > 3000) C.t.h = C.t.h.slice(-3000); }
    const cut = ymdK(Date.now() - 180 * 864e5);
    for (const k of Object.keys(C.days)) if (k < cut) delete C.days[k];
    await rPut(env, KX.clicks(id), C);
  }
  /* 비교 — 경영팀이 올린 경쟁 계정 캡처(AI 가 읽은 숫자) + 최근 주간 조사가 찾은 업계 평균(출처 있는 것만) */
  async function compareFacts(env, id) {
    const L = [];
    const items = (((await rGet(env, 'seo/ttx/meta.json').catch(() => null)) || {}).items || []).filter((x) => x.slot === id && x.ex && !x.ex.err && Date.now() - x.at < 120 * 864e5);
    for (const x of items) {
      const e = x.ex, v = (e.views || []).slice().sort((a, b) => a - b), md = v.length ? v[v.length >> 1] : null;
      L.push(`- 비교 계정 ${e.handle || x.note || ''}${x.note ? ' (' + x.note + ')' : ''}: 팔로워 ${e.followers ?? '-'} · 받은 좋아요 ${e.likes ?? '-'} · 프로필에 보이는 영상 ${v.length}개 조회 중간값 ${md ?? '-'} (${ymdK(x.at)} 캡처)`);
    }
    const idx = (await rGet(env, 'seo/index.json').catch(() => null)) || [];
    for (const row of idx.slice(0, 4)) {
      const rr = await rGet(env, `seo/r/${row.id}.json`).catch(() => null);
      const bench = rr && rr.report && rr.report.sns && rr.report.sns.bench;
      if (Array.isArray(bench) && bench.length) { for (const b of bench) L.push(`- 업계 평균 ${b.metric}: ${b.value} (${b.basis || '기준 모름'} · 출처 ${b.src}${b.note ? ' · ' + b.note : ''})`); break; }
    }
    return L.length ? '\n\n[비교]\n' + L.join('\n') : '\n\n[비교] 경쟁 계정 캡처 · 업계 평균 아직 없음';
  }
  const clickDays = async (env, id) => (((await rGet(env, KX.clicks(id)).catch(() => null)) || {}).days || {});

  async function tick(env) {
    const k = new Date(Date.now() + 9 * 3600e3);
    if (k.getUTCHours() === 5 && k.getUTCMinutes() >= 10 && k.getUTCMinutes() < 40 && ready(env)) {   /* 표지 — 1분에 한 계정씩 6개 */
      const slot = SLOTS[k.getUTCMinutes() % SLOTS.length];
      const n = await covers(env, slot.id, 6).catch(() => 0);
      return n ? { [slot.id + '_cv']: { n } } : null;
    }
    if (k.getUTCHours() !== 5 || k.getUTCMinutes() > 9 || !ready(env)) return null;
    const out = {};
    for (const { id } of SLOTS) {
      const l = await rGet(env, KEY.latest(id)).catch(() => null);
      if (l && Date.now() - Math.max(l.at || 0, l.errAt || 0) < 20 * 3600e3) continue;
      out[id] = await collect(env, id).catch(() => null);
    }
    await visits(env, true).catch((e) => console.log('tt visits', e && e.message));
    return out;
  }

  /* 주간 조사용 — 오래됐으면(20시간) 새로 가져온다 */
  async function forReport(env) {
    if (!ready(env)) return '';
    let txt = '';
    for (const { id, label } of SLOTS) {
      let l = await rGet(env, KEY.latest(id)).catch(() => null);
      if (!l || Date.now() - (l.at || 0) > 20 * 3600e3) l = (await collect(env, id).catch(() => null)) || l;
      txt += ttFacts(l, await rGet(env, KEY.hist(id)).catch(() => null), Date.now(), label);
      txt += funnelFacts(label, await clickDays(env, id), await rGet(env, KX.link(id)).catch(() => null), (await visits(env).catch(() => null)), id);
    }
    return txt;
  }

  async function callback(request, env, ctx, url) {
    const err = url.searchParams.get('error');
    if (err) return page(false, err === 'access_denied' ? '연결을 취소했어요. 다시 하려면 DM 앱 검색 노출 → SNS 에서 눌러 주세요.' : '틱톡이 연결을 거절했어요 (' + htmlEsc(S(err, 40)) + ')');
    const st = await readState(env, url.searchParams.get('state'));
    if (!st) return page(false, '연결 시간이 지났어요. DM 앱에서 다시 눌러 주세요.');
    const slot = slotOf(st.slot);
    if (!slot) return page(false, '어느 계정 칸인지 몰라요. DM 앱에서 다시 눌러 주세요.');
    const code = url.searchParams.get('code');
    if (!code) return page(false, '틱톡에서 받은 값이 없어요. 다시 시도해 주세요.');
    const u = await dbGet(env, '/users/' + encodeURIComponent(st.ph)).catch(() => null);
    if (!st.owner && !hqUser(u)) return page(false, '경영팀만 연결할 수 있어요.');
    let j;
    try { j = await token(env, null, { code, grant_type: 'authorization_code', redirect_uri: redirectUri(url) }); } catch (e) { return page(false, htmlEsc(e.message) + ' 다시 시도해 주세요.'); }
    const scopes = String(j.scope || '').split(',');
    const miss = ['user.info.stats', 'video.list'].filter((s) => scopes.indexOf(s) < 0);
    if (miss.length) return page(false, '숫자를 볼 권한이 빠졌어요. 다시 연결하면서 모든 항목을 허용해 주세요.');
    /* 같은 틱톡 계정을 두 칸에 넣지 않게 — 틱톡은 이 브라우저에 로그인된 계정으로 바로 허용해 버리기 쉽다 */
    for (const o of SLOTS) {
      if (o.id === slot.id) continue;
      const other = await dbGet(env, SEC(o.id)).catch(() => null);
      if (other && other.oid && j.open_id && other.oid === j.open_id) {
        await fetch(API + '/oauth/revoke/', form({ client_key: env.TIKTOK_CLIENT_KEY, client_secret: env.TIKTOK_CLIENT_SECRET, token: j.access_token })).catch(() => {});
        return page(false, `이 틱톡 계정은 이미 ${o.label} 칸에 연결돼 있어요. 틱톡에서 로그아웃하고 ${slot.label} 계정으로 로그인한 뒤 다시 눌러 주세요.`);
      }
    }
    await dbPut(env, SEC(slot.id), secOf(j, null, String(st.nm || '')));
    /* 어느 틱톡 계정이 들어갔는지 바로 보여 준다 — 브라우저에 로그인된 다른 계정이 들어가는 실수를 그 자리에서 알게 */
    const l = await collect(env, slot.id).catch((e) => { console.log('tt first', e && e.message); return null; });
    if (l && !l.err) await covers(env, slot.id, 12).catch(() => 0);
    const un = l && l.user && (l.user.username || l.user.name);
    if (!un) return page(true, `${slot.label} 틱톡 계정을 연결했어요. 잠시 뒤 DM 앱 검색 노출 → SNS 에서 숫자를 확인하세요.`);
    return page(true, `${slot.label} 칸에 틱톡 <b>@${htmlEsc(S(un, 40))}</b> 계정을 연결했어요.<br><br>다른 계정이 들어갔다면 DM 앱에서 이 칸의 ✕ 를 누르고, 틱톡에서 로그아웃한 뒤 맞는 계정으로 로그인해 다시 연결하세요.`);
  }

  async function stop(env, id) {
    const sec = await dbGet(env, SEC(id)).catch(() => null);
    if (sec && sec.atk && ready(env)) await fetch(API + '/oauth/revoke/', form({ client_key: env.TIKTOK_CLIENT_KEY, client_secret: env.TIKTOK_CLIENT_SECRET, token: sec.atk })).catch(() => {});
    await dbPut(env, SEC(id), null);
    await env.CHAT_MEDIA.delete(KEY.latest(id)).catch(() => {});
    await env.CHAT_MEDIA.delete(AIK(id)).catch(() => {});   /* 다른 계정을 연결하면 예전 분석이 섞이지 않게 */
    try {
      for (let i = 0; i < 5; i++) {   /* 표지도 */
        const ls = await env.CHAT_MEDIA.list({ prefix: `seo/tt/${id}/cv/`, limit: 500 });
        const ks = ((ls && ls.objects) || []).map((o) => o.key);
        if (!ks.length) break;
        await env.CHAT_MEDIA.delete(ks);
        if (!ls.truncated) break;
      }
    } catch (_) {}
  }

  /* 경영팀만 — seo.js 가 경영팀 확인 후 넘긴다 */
  async function route(path, b, env, me, url) {
    if (path === '/seo/sns') {
      const accts = [];
      let note = '';
      for (const { id, label } of SLOTS) {
        let latest = await rGet(env, KEY.latest(id)).catch(() => null);
        const sec = await dbGet(env, SEC(id)).catch(() => null);
        if (b.refresh && (!b.slot || b.slot === id) && sec && sec.rt) {
          if (latest && Date.now() - Math.max(latest.at || 0, latest.errAt || 0) < 10 * 60000) note = '방금 불러왔어요. 10분 뒤에 다시 할 수 있어요';
          else {
            latest = (await collect(env, id)) || latest;
            if (latest && !latest.err && b.slot === id && await covers(env, id, 12).catch(() => 0)) latest = (await rGet(env, KEY.latest(id)).catch(() => null)) || latest;
          }
        }
        if (latest && Array.isArray(latest.videos)) latest = { ...latest, videos: latest.videos.map(({ cu, ...v }) => v) };   /* 표지 원래 주소는 앱에 안 보낸다 */
        accts.push({ id, label, on: !!(sec && sec.rt), by: (sec && sec.by) || '', since: (sec && sec.at) || 0, rtx: (sec && sec.rtx) || 0, latest, ai: await rGet(env, AIK(id)).catch(() => null), link: await rGet(env, KX.link(id)).catch(() => null), track: TRACK_URL(id), clicks: await clickDays(env, id), hist: ((await rGet(env, KEY.hist(id)).catch(() => null)) || []).slice(0, 60) });
      }
      return { ok: true, ready: ready(env), accts, note, visits: await visits(env).catch(() => null) };
    }
    if (path === '/seo/tt/start') {
      if (!ready(env)) return { ok: false, error: '틱톡 개발자 앱 설정이 아직 안 됐어요' };
      if (!slotOf(b.slot)) return { ok: false, error: '연결할 계정 칸을 골라 주세요' };
      const state = await mkState(env, { ph: String(me.ph), nm: S(me.name, 30), slot: b.slot, owner: me.role === 'owner' || me.admin === true, exp: Date.now() + 15 * 60000 });
      const q = new URLSearchParams({ client_key: env.TIKTOK_CLIENT_KEY, response_type: 'code', scope: SCOPE, redirect_uri: redirectUri(url), state, disable_auto_auth: '1' }); /* 예전에 허용한 계정이라도 허용 화면을 꼭 띄워 어느 계정인지 보이게 */
      return { ok: true, url: AUTH + '?' + q };
    }
    /* AI 분석 — 경영팀이 누를 때만. 계정마다 하루(한국 날짜) 한 번, 회사 전체 한 주 AI_WEEK_CAP 번 */
    if (path === '/seo/tt/ai') {
      const slot = slotOf(b.slot);
      if (!slot) return { ok: false, error: '계정 칸을 골라 주세요' };
      const cur = await rGet(env, AIK(slot.id)).catch(() => null);
      if (!b.make) return { ok: true, ai: cur };
      if (!relayCall) return { ok: false, error: 'AI 설정이 없어요' };
      const now = Date.now();
      if (cur && cur.at && ymdK(cur.at) === ymdK(now)) return { ok: false, error: '오늘 이미 분석했어요. 내일 다시 할 수 있어요', ai: cur };
      const latest = await rGet(env, KEY.latest(slot.id)).catch(() => null);
      if (!latest || !latest.user) return { ok: false, error: '아직 가져온 틱톡 숫자가 없어요. 먼저 연결하고 새로 불러오기를 눌러 주세요' };
      if (aiBusy.has(slot.id)) return aiBusy.get(slot.id);
      const job = (async () => {
        const wk = weekKeyK(now), ck = 'seo/tt/_aicount.json';
        const c = (await rGet(env, ck).catch(() => null)) || {};
        const n = c.wk === wk ? +c.n || 0 : 0;
        if (n >= AI_WEEK_CAP) return { ok: false, error: `이번 주 틱톡 AI 분석 한도(${AI_WEEK_CAP}번)를 다 썼어요. 다음 주 월요일에 다시 열려요` };
        await rPut(env, ck, { wk, n: n + 1 });
        let facts = ttAiFacts(slot.label, latest, await rGet(env, KEY.hist(slot.id)).catch(() => null), now);
        facts += funnelFacts(slot.label, await clickDays(env, slot.id), await rGet(env, KX.link(slot.id)).catch(() => null), await visits(env).catch(() => null), slot.id);
        facts += await compareFacts(env, slot.id);
        const r = await relayCall(env, '/ai/tt-report', { facts }, { ph: me.ph, nm: me.name, x: '틱톡 분석 · ' + slot.label });
        if (!r.body || !r.body.ok) return { ok: false, error: (r.body && r.body.error) || 'AI 분석을 하지 못했어요' };
        const rec = { report: r.body.report || {}, at: Date.now(), base: latest.at, by: S(me.name, 30), vref: vrefOf(r.body.report, latest.videos) };
        await rPut(env, AIK(slot.id), rec);
        return { ok: true, ai: rec };
      })().finally(() => aiBusy.delete(slot.id));
      aiBusy.set(slot.id, job);
      return job;
    }
    /* 예약 링크 — 틱톡 프로필 링크가 넘겨 줄 예약 페이지 주소 (비우면 '준비 중' 화면) */
    if (path === '/seo/tt/link') {
      const slot = slotOf(b.slot);
      if (!slot) return { ok: false, error: '계정 칸을 골라 주세요' };
      const u = String(b.url || '').trim();
      if (!u) { await env.CHAT_MEDIA.delete(KX.link(slot.id)).catch(() => {}); return { ok: true, link: null }; }
      if (!/^https:\/\/[^\s"'<>]+$/.test(u) || u.length > 500) return { ok: false, error: 'https:// 로 시작하는 주소를 넣어 주세요' };
      if (/dminternational\.github\.io\/dm-hq-system\/t\/|\/go\/(dm|bb)\b/.test(u)) return { ok: false, error: '추적 링크 말고 실제 예약 페이지 주소를 넣어 주세요' };
      const link = { url: u, at: Date.now(), by: S(me.name, 30) };
      await rPut(env, KX.link(slot.id), link);
      return { ok: true, link };
    }
    if (path === '/seo/tt/stop') { if (!slotOf(b.slot)) return { ok: false, error: '계정 칸을 골라 주세요' }; await stop(env, b.slot); return { ok: true }; }
    return null;
  }

  return { route, callback, tick, collect, forReport, ready, go, visits, cover, covers };
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
