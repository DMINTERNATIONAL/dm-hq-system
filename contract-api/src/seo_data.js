/* ═══ 검색 노출 — 숫자 모으기 (공식 API만) ═══
   AI 를 쓰지 않는다(무료). 주간 조사 직전과 경영팀 '새로 불러오기' 때 돈다.
   - 네이버 검색광고 API  : 검색어별 월 검색량 + 연관 검색어   (NAVER_AD_KEY · NAVER_AD_SECRET · NAVER_AD_CUSTOMER)
   - 네이버 데이터랩 API  : 시술 검색어 주별 유행               (NAVER_CLIENT_ID · NAVER_CLIENT_SECRET)
   - 네이버 블로그 검색   : 지점 이름 블로그 글 수 · 이번 주 새 글   (같은 키)
   - 네이버 지역 검색     : 검색어별 상위 5곳 (API 기준, 앱 순위와 다를 수 있음) + 우리 매장에서 거리
   - 상위 매장 블로그     : 지역 검색 상위 매장 이름으로 블로그 검색 → 전체 글 · 최근 30일 글 (우리와 비교)
   - 구글 Places API      : 구글 지도 검색 순위 (GOOGLE_PLACES_KEY)
   - 핸드SOS 방문구분     : /storesLite/{지점}/daily 의 visits (신규일반 · 신규소개 · 재방) 주별 합
   네이버 플레이스 앱 순위는 공식 API 가 없어 자동으로 긁지 않는다(봇 차단 · 약관). 경영팀이 앱에서 손으로 기록한다. */

export const SHOPS = ['flagship', 'moment', 'eto'];
export function shopOf(name) {
  const s = String(name || '');
  if (/플래그십/.test(s)) return 'flagship';
  if (/모먼트/.test(s)) return 'moment';
  if (/ETOH|에토/i.test(s)) return 'eto';
  return '';
}
const OURS = /데이민|day\s*:?\s*mean|daymean|etoh|에토/i;
const norm = (k) => String(k || '').replace(/\s+/g, '').toUpperCase();
const strip = (s) => String(s || '').replace(/<[^>]+>/g, '').replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#39;/g, "'").trim();

const BASE_KW = ['합정 미용실', '합정역 미용실', '홍대 미용실', '망원 미용실', '레이어드컷', '다운펌', '남자펌', '볼륨매직', '허쉬컷', '탈색'];
const PLACE_KW = /미용실|헤어샵|헤어 샵|바버|이발/;
export const GOOGLE_Q = ['hair salon Hapjeong', 'Hongdae hair salon', '합정 미용실'];
const CENTER = { latitude: 37.5516, longitude: 126.9186 };   // 양화로12길 16-9

/* 어떤 검색어를 볼지 — 매장 설정의 '노리는 검색어'가 먼저, 모자라면 기본 */
export function kwPlan(cfg) {
  const raw = [];
  for (const b of (cfg && cfg.branches) || []) raw.push(...String(b.keywords || '').split(/[,\n·/]/));
  raw.push(...BASE_KW);
  const seen = new Set(), list = [];
  for (const k of raw) {
    const t = String(k || '').trim().slice(0, 30);
    if (!t || seen.has(norm(t))) continue;
    seen.add(norm(t)); list.push(t);
    if (list.length >= 15) break;
  }
  const local = list.filter((k) => PLACE_KW.test(k)).slice(0, 4);
  const style = list.filter((k) => !PLACE_KW.test(k) && !/합정|홍대|망원|마포|상수|연남/.test(k)).slice(0, 5);
  return { list, local, style };
}
export function blogQuery(name) {
  return String(name || '').replace(/DAY\s*:?\s*MEAN/i, '데이민').replace(/점\s*$/, '').trim();
}

/* ─── 날짜 ─── */
const ymdOf = (t) => new Date(t + 9 * 3600e3).toISOString().slice(0, 10);
export function monday(ymd) {
  const [y, m, d] = ymd.split('-').map(Number);
  const t = Date.UTC(y, m - 1, d), dow = (new Date(t).getUTCDay() + 6) % 7;
  return new Date(t - dow * 864e5).toISOString().slice(0, 10);
}
/* 핸드SOS 방문구분 → 월요일 시작 주별 합 (최근 n주, 최신이 앞) */
export function weekly(daily, today, n) {
  const W = {};
  for (const [ymd, d] of Object.entries(daily || {})) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(ymd) || ymd > today || !d || !d.visits) continue;
    const v = d.visits, wk = monday(ymd);
    const e = W[wk] || (W[wk] = { wk, days: 0, 신규일반: 0, 신규소개: 0, 재방: 0, 손님: 0, total: 0 });
    e.days++;
    for (const k of ['신규일반', '신규소개', '재방', '손님', 'total']) e[k] += +v[k] || 0;
  }
  const thisWk = monday(today);
  return Object.values(W).sort((a, b) => (a.wk < b.wk ? 1 : -1)).slice(0, n || 8).map((e) => ({ ...e, partial: e.wk === thisWk }));
}

/* ─── 네이버 검색광고 ─── */
async function hmacB64(secret, msg) {
  const k = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const s = await crypto.subtle.sign('HMAC', k, new TextEncoder().encode(msg));
  let bin = ''; for (const b of new Uint8Array(s)) bin += String.fromCharCode(b);
  return btoa(bin);
}
const qc = (v) => (typeof v === 'number' ? { n: v, lt: false } : /</.test(String(v)) ? { n: 5, lt: true } : { n: +v || 0, lt: false });
export async function adVolumes(env, list, fx) {
  const f = fx || fetch;
  const want = new Map(list.map((k) => [norm(k), k]));
  const rows = {}, rel = new Map();
  const keys = [...want.keys()];
  for (let i = 0; i < keys.length; i += 5) {
    const chunk = keys.slice(i, i + 5);
    const ts = String(Date.now());
    const sig = await hmacB64(env.NAVER_AD_SECRET, `${ts}.GET./keywordstool`);
    const r = await f('https://api.searchad.naver.com/keywordstool?hintKeywords=' + encodeURIComponent(chunk.join(',')) + '&showDetail=1', {
      headers: { 'X-Timestamp': ts, 'X-API-KEY': env.NAVER_AD_KEY, 'X-Customer': String(env.NAVER_AD_CUSTOMER), 'X-Signature': sig },
    });
    if (!r.ok) throw new Error('검색광고 API ' + r.status);
    const j = await r.json();
    for (const x of j.keywordList || []) {
      const pc = qc(x.monthlyPcQcCnt), mo = qc(x.monthlyMobileQcCnt), nk = norm(x.relKeyword);
      const row = { k: x.relKeyword, pc: pc.n, mo: mo.n, t: pc.n + mo.n, lt: pc.lt && mo.lt, comp: String(x.compIdx || '') };
      if (want.has(nk)) rows[nk] = { ...row, k: want.get(nk) };
      else if (!rel.has(nk)) rel.set(nk, row);
    }
  }
  return {
    rows: keys.map((k) => rows[k] || { k: want.get(k), pc: 0, mo: 0, t: 0, lt: true, comp: '' }).sort((a, b) => b.t - a.t),
    rel: [...rel.values()].sort((a, b) => b.t - a.t).slice(0, 15),
  };
}

/* ─── 네이버 오픈 API (데이터랩 · 블로그 · 지역) ─── */
const openH = (env) => ({ 'X-Naver-Client-Id': env.NAVER_CLIENT_ID, 'X-Naver-Client-Secret': env.NAVER_CLIENT_SECRET });
export async function trend(env, style, now, fx) {
  if (!style.length) return { rows: [] };
  const f = fx || fetch;
  const end = ymdOf(now - 864e5), start = ymdOf(now - 7 * 26 * 864e5);
  const r = await f('https://openapi.naver.com/v1/datalab/search', {
    method: 'POST', headers: { ...openH(env), 'Content-Type': 'application/json' },
    body: JSON.stringify({ startDate: start, endDate: end, timeUnit: 'week', keywordGroups: style.slice(0, 5).map((k) => ({ groupName: k, keywords: [k] })) }),
  });
  if (!r.ok) throw new Error('데이터랩 API ' + r.status);
  const j = await r.json();
  const rows = (j.results || []).map((g) => {
    const pts = (g.data || []).map((p) => +p.ratio || 0);
    const avg = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0);
    const last4 = avg(pts.slice(-4)), prev4 = avg(pts.slice(-8, -4));
    return { k: g.title, last4: Math.round(last4 * 10) / 10, prev4: Math.round(prev4 * 10) / 10, chg: prev4 ? Math.round((last4 / prev4 - 1) * 100) : null, pts: pts.slice(-12).map((x) => Math.round(x * 10) / 10) };
  });
  return { rows, from: start, to: end };
}
export async function blogs(env, branches, now, fx) {
  const f = fx || fetch, wkAgo = ymdOf(now - 7 * 864e5).replace(/-/g, ''), moAgo = ymdOf(now - 30 * 864e5).replace(/-/g, '');
  const out = [];
  for (const b of branches) {
    const q = blogQuery(b.name);
    if (!q) continue;
    const r = await f('https://openapi.naver.com/v1/search/blog.json?display=30&sort=date&query=' + encodeURIComponent(q), { headers: openH(env) });
    if (!r.ok) throw new Error('블로그 검색 API ' + r.status);
    const j = await r.json();
    const items = j.items || [];
    const fresh = items.filter((x) => String(x.postdate || '') >= wkAgo);
    const m30 = items.filter((x) => String(x.postdate || '') >= moAgo).length;
    out.push({ branch: b.name, q, total: +j.total || 0, week: fresh.length, m30, m30plus: m30 >= items.length && items.length >= 30, recent: items.slice(0, 5).map((x) => ({ t: strip(x.title).slice(0, 80), by: strip(x.bloggername).slice(0, 30), d: String(x.postdate || '') })) });
  }
  return out;
}
export async function localTop(env, qs, fx) {
  const f = fx || fetch, out = [];
  for (const q of qs) {
    const r = await f('https://openapi.naver.com/v1/search/local.json?display=5&sort=random&query=' + encodeURIComponent(q), { headers: openH(env) });
    if (!r.ok) throw new Error('지역 검색 API ' + r.status);
    const j = await r.json();
    out.push({ q, items: (j.items || []).map((x) => { const n = strip(x.title).slice(0, 40); return { n, cat: strip(x.category).slice(0, 30), ours: OURS.test(n), m: distM(x.mapx, x.mapy), addr: strip(x.roadAddress || x.address).slice(0, 60) }; }) });
  }
  return out;
}
/* 지역 검색 mapx · mapy = 경도 · 위도 × 10^7 (2023년부터). 우리 매장에서 직선 거리(m) */
export function distM(mx, my) {
  const lon = +mx / 1e7, lat = +my / 1e7;
  if (!(lat > 33 && lat < 39 && lon > 124 && lon < 132)) return null;
  const R = 6371000, rad = Math.PI / 180, dLat = (lat - CENTER.latitude) * rad, dLon = (lon - CENTER.longitude) * rad;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(CENTER.latitude * rad) * Math.cos(lat * rad) * Math.sin(dLon / 2) ** 2;
  return Math.round(2 * R * Math.asin(Math.sqrt(a)));
}
/* 지역 검색 상위 매장(우리 빼고) 이름으로 블로그 검색 — 매장 이름이 흔하면 다른 글도 섞이니 '대략'이다 */
export async function rivals(env, local, now, fx) {
  const f = fx || fetch, moAgo = ymdOf(now - 30 * 864e5).replace(/-/g, '');
  const M = new Map();
  for (const x of local || []) (x.items || []).forEach((it, i) => {
    if (it.ours || !it.n) return;
    const k = norm(it.n);
    const e = M.get(k) || { n: it.n, m: it.m, addr: it.addr, at: [] };
    e.at.push({ q: x.q, r: i + 1 });
    M.set(k, e);
  });
  const list = [...M.values()].sort((a, b) => b.at.length - a.at.length || Math.min(...a.at.map((t) => t.r)) - Math.min(...b.at.map((t) => t.r))).slice(0, 12);
  for (const e of list) {
    const r = await f('https://openapi.naver.com/v1/search/blog.json?display=30&sort=date&query=' + encodeURIComponent(e.n), { headers: openH(env) });
    if (!r.ok) throw new Error('블로그 검색 API ' + r.status);
    const j = await r.json(), items = j.items || [];
    e.total = +j.total || 0;
    e.m30 = items.filter((x) => String(x.postdate || '') >= moAgo).length;
    e.m30plus = e.m30 >= items.length && items.length >= 30;
    e.last = String((items[0] && items[0].postdate) || '');
  }
  return list;
}

/* ─── 구글 지도 (Places API Text Search) ─── */
export async function gmapRank(env, qs, fx) {
  const f = fx || fetch, out = [];
  for (const q of qs) {
    const r = await f('https://places.googleapis.com/v1/places:searchText', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Goog-Api-Key': env.GOOGLE_PLACES_KEY, 'X-Goog-FieldMask': 'places.id,places.displayName,places.rating,places.userRatingCount' },
      body: JSON.stringify({ textQuery: q, languageCode: /[가-힣]/.test(q) ? 'ko' : 'en', regionCode: 'KR', pageSize: 20, locationBias: { circle: { center: CENTER, radius: 1500 } } }),
    });
    if (!r.ok) throw new Error('구글 Places API ' + r.status);
    const j = await r.json();
    const list = (j.places || []).map((p, i) => ({ r: i + 1, n: String((p.displayName && p.displayName.text) || '').slice(0, 50), rt: p.rating || null, c: p.userRatingCount || 0 }));
    list.forEach((x) => { x.ours = OURS.test(x.n); });
    const mine = list.filter((x) => x.ours);
    out.push({ q, total: list.length, ours: mine.map((x) => ({ r: x.r, n: x.n, rt: x.rt, c: x.c })), top: list.slice(0, 5) });
  }
  return out;
}

export function apisOf(env) {
  return { ad: !!(env.NAVER_AD_KEY && env.NAVER_AD_SECRET && env.NAVER_AD_CUSTOMER), open: !!(env.NAVER_CLIENT_ID && env.NAVER_CLIENT_SECRET), places: !!env.GOOGLE_PLACES_KEY };
}

/* 전부 모으기 — 하나가 실패해도 나머지는 남긴다 */
export async function collect(env, cfg, dbGet, now, fx) {
  const t = now || Date.now(), today = ymdOf(t), apis = apisOf(env), plan = kwPlan(cfg), err = [];
  const branches = (cfg.branches || []).filter((b) => b && b.name);
  const take = async (label, on, fn) => { if (!on) return null; try { return await fn(); } catch (e) { err.push(label + ': ' + String((e && e.message) || e).slice(0, 120)); return null; } };
  let rv = null;
  const [vol, tr, blog, local, gmap, visits] = await Promise.all([
    take('검색량', apis.ad, () => adVolumes(env, plan.list, fx)),
    take('유행', apis.open, () => trend(env, plan.style, t, fx)),
    take('블로그', apis.open, () => blogs(env, branches, t, fx)),
    take('지역 검색', apis.open, async () => { const l = await localTop(env, plan.local, fx); rv = await take('상위 매장 블로그', true, () => rivals(env, l, t, fx)); return l; }),
    take('구글 지도', apis.places, () => gmapRank(env, GOOGLE_Q, fx)),
    take('신규 손님', true, async () => {
      const out = [];
      for (const b of branches) {
        const shop = shopOf(b.name);
        if (!shop) continue;
        const daily = await dbGet(env, `/storesLite/${shop}/daily`).catch(() => null);
        out.push({ branch: b.name, shop, weeks: weekly(daily, today, 8) });
      }
      return out;
    }),
  ]);
  return { at: t, today, apis, kw: plan, vol, trend: tr, blog, local, rivals: rv, gmap, visits, err };
}

/* AI 에게 줄 숫자 글 — 지난번 숫자와 비교 */
export function dataFacts(d, prev, ranks) {
  if (!d) return '';
  const L = ['', '[숫자 — 공식 API · 우리 매출 시스템에서 직접 모은 것. 이 숫자만 근거로 쓰고 지어내지 말 것]'];
  const pv = (arr, key, k) => ((arr || []).find((x) => x[key] === k) || null);
  if (d.visits && d.visits.length) {
    L.push('· 신규 손님(핸드SOS 방문구분, 주별 · 월요일 시작). 신규일반 = 소개 없이 온 새 손님(검색 · SNS 등으로 찾아온 손님에 가까움):');
    for (const v of d.visits) L.push(`  - ${v.branch}: ` + v.weeks.slice(0, 6).map((w) => `${w.wk.slice(5)}${w.partial ? '(진행 중)' : ''} 신규일반 ${w.신규일반} · 신규소개 ${w.신규소개} · 재방 ${w.재방}`).join(' / '));
  }
  if (d.vol && d.vol.rows) {
    L.push('· 네이버 월 검색량(검색광고 API, 모바일+PC):');
    L.push('  ' + d.vol.rows.map((r) => { const p = prev && prev.vol ? pv(prev.vol.rows, 'k', r.k) : null; return `${r.k} ${r.lt ? '10 미만' : r.t.toLocaleString('en-US')}${p && !r.lt ? ` (지난번 ${p.t.toLocaleString('en-US')})` : ''}${r.comp ? ' 경쟁 ' + r.comp : ''}`; }).join(' · '));
    if (d.vol.rel && d.vol.rel.length) L.push('  연관 검색어 상위: ' + d.vol.rel.slice(0, 12).map((r) => `${r.k} ${r.t.toLocaleString('en-US')}`).join(' · '));
  }
  if (d.trend && d.trend.rows && d.trend.rows.length) L.push('· 시술 검색 유행(데이터랩, 최근 4주 평균 vs 그 전 4주): ' + d.trend.rows.map((r) => `${r.k} ${r.chg == null ? '-' : (r.chg > 0 ? '+' : '') + r.chg + '%'}`).join(' · '));
  const m30 = (o) => (o.m30 == null ? '' : ` · 최근 30일 ${o.m30}${o.m30plus ? '+' : ''}`);
  if (d.blog && d.blog.length) L.push('· 네이버 블로그 글(지점 이름 검색): ' + d.blog.map((b) => { const p = prev && prev.blog ? pv(prev.blog, 'branch', b.branch) : null; return `${b.branch} 전체 ${b.total}${p ? ` (지난번 ${p.total})` : ''} · 최근 7일 새 글 ${b.week}${m30(b)}`; }).join(' / '));
  if (d.local && d.local.length) L.push('· 네이버 지역검색 API 상위 5곳(플레이스 앱 순위와 다를 수 있음, 괄호는 우리 매장에서 직선 거리): ' + d.local.map((x) => `"${x.q}" → ` + (x.items.map((i, n) => `${n + 1}.${i.n}${i.ours ? '(우리)' : i.m != null ? `(${i.m}m)` : ''}`).join(' ') || '없음')).join(' / '));
  if (d.rivals && d.rivals.length) L.push('· 상위 매장 블로그 글(매장 이름으로 블로그 검색, 이름이 흔하면 다른 글이 섞여 대략적): ' + d.rivals.map((e) => `${e.n} 전체 ${e.total}${m30(e)}`).join(' · ') + ' — 우리 지점 숫자와 비교할 것');
  if (d.gmap && d.gmap.length) L.push('· 구글 지도 검색 순위(Places API, 매장 근처 기준 20위까지): ' + d.gmap.map((x) => `"${x.q}" → ` + (x.ours.length ? x.ours.map((o) => `${o.n} ${o.r}위(별점 ${o.rt || '-'}, 리뷰 ${o.c})`).join(', ') : '20위 안에 우리 없음')).join(' / '));
  const off = [];
  if (!d.apis.ad) off.push('검색량');
  if (!d.apis.open) off.push('유행 · 블로그 · 지역 검색');
  if (!d.apis.places) off.push('구글 지도 순위');
  if (off.length) L.push('· 아직 연결 안 된 숫자: ' + off.join(', ') + ' — 이 부분은 숫자 없이 판단한다고 밝힐 것');
  if (d.err && d.err.length) L.push('· 이번에 못 모은 숫자: ' + d.err.join(' / '));
  if (ranks && ranks.length) {
    const G = {};
    for (const x of ranks) { const k = x.q + ' · ' + x.branch; (G[k] = G[k] || []).push(x); }
    L.push('· 경영팀이 휴대폰으로 확인한 네이버 플레이스 순위(광고 제외, 최신이 앞):');
    for (const [k, arr] of Object.entries(G).slice(0, 12)) L.push(`  - ${k}: ` + arr.slice(0, 5).map((x) => `${ymdOf(x.at).slice(5)} ${x.rank ? x.rank + '위' : '안 보임'}`).join(' ← '));
  }
  return L.join('\n');
}
