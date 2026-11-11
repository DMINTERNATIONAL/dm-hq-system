/* ═══ 검색 노출 주간 조사 (네이버 플레이스 · 구글 비즈니스 프로필) ═══
   매주 일요일 밤 10시(한국)에 1분 크론이 한 번 돌린다. 경영팀이 앱에서 '지금 조사하기'를 누르면 다음 1분 크론이 바로 돌린다.
   릴레이 /ai/seo-weekly (Sonnet 5.5 + 웹 검색)가 기준 · 정책 변화를 찾고 이번 주 할 일과 붙여넣을 글을 쓴다.
   경영팀만 본다. 저장은 R2 (DB 에 두면 staff 토큰으로 누구나 읽혀서):
     seo/cfg.json          = { branches: [{ name, naver, google, keywords }], note, at, by }
     seo/index.json        = [{ id, at, headline, nc, nt, trig }]  최신이 앞, 최대 60개
     seo/r/{id}.json       = { id, at, trig, report, done: { 할일번호: { by, at } } }
     seo/_pending.json     = { at, by }   — '지금 조사하기' 요청
     seo/_running.json     = { at }       — 겹쳐 돌지 않게 (20분 지나면 무시)
     seo/_err.json         = { at, err }  — 마지막 실패
     seo/data_latest.json  = 숫자(seo_data.js collect) — 공식 API · 핸드SOS. AI 안 씀
     seo/stats.json        = [{ id, wk, branch, views, books, at, by }]  — 경영팀이 스마트플레이스 통계에서 옮겨 적는 주간 조회 · 예약 (예약 전환율)
     seo/ranks.json        = [{ id, at, by, q, branch, rank }]  — 경영팀이 휴대폰으로 본 플레이스 순위 (0 = 안 보임)
     seo/shot/{shop}.json  = { at, by, mt, b64 }  — 스마트플레이스 통계 캡처(유입 키워드 등). 주간 조사 때 AI 가 읽는다
     seo/rival/meta.json   = { items: [{ k, at, by, note }] }  — 경쟁 비교 캡처 목록 (최대 8장, 한 달에 한 번)
     seo/rival/img/{k}.json = { mt, b64 }  — 휴대폰 검색 결과 · 상위 매장 첫 화면. 주간 조사 때 AI 가 읽고 비교표를 만든다
       (네이버 검색 페이지는 자동 수집을 막아 두어서(robots.txt) 긁지 않는다 — 사람이 찍은 캡처만 쓴다)
     seo/xhs/meta.json     = { items: [{ k, at, by, note, kind: 'search'|'ours' }] }  — 샤오홍슈 캡처 (검색 결과 · 우리 계정 통계, 최대 8장)
     seo/xhs/img/{k}.json  = { mt, b64 }   (샤오홍슈는 공개 API 가 없어 캡처만 쓴다)
     seo/ttx/meta.json     = { items: [{ k, at, by, note, slot: 'dm'|'bb', ex: { handle, followers, likes, views[] … } }] } — 비교할 틱톡 계정 프로필 캡처.
                             틱톡은 남의 계정 숫자를 주는 API 가 없고 긁어 오는 건 약관 위반이라, 올릴 때 AI 가 사진에서 숫자를 읽어 둔다
   틱톡 회사 계정 숫자는 sns.js 가 공식 API 로 매일 가져온다 — 주간 조사 때 같이 읽는다.
   목표는 '예약 늘리기'. 검색 노출은 수단이다. */
import { hqUser } from './aiusage.js';
import { collect, dataFacts, apisOf, monday, SHOPS } from './seo_data.js';

const DEFAULT_BRANCHES = [
  { name: 'DAY:MEAN 플래그십점', naver: '', google: '', keywords: '' },
  { name: 'DAY:MEAN 모먼트점', naver: '', google: '', keywords: '' },
  { name: 'ETOH 합정점', naver: '', google: '', keywords: '' },
];
const KEY = { cfg: 'seo/cfg.json', idx: 'seo/index.json', pend: 'seo/_pending.json', run: 'seo/_running.json', err: 'seo/_err.json', data: 'seo/data_latest.json', stats: 'seo/stats.json', ranks: 'seo/ranks.json', rival: 'seo/rival/meta.json', xhs: 'seo/xhs/meta.json', ttx: 'seo/ttx/meta.json' };
const RIVAL_MAX = 8, RIVAL_DAYS = 45;
const XHS_KIND = { search: '검색 결과', ours: '우리 계정 통계' };

/* 한국 시각 쪼개기 */
export function kst(ts) {
  const d = new Date(ts + 9 * 3600e3);
  const p = (n) => String(n).padStart(2, '0');
  return { y: d.getUTCFullYear(), mo: d.getUTCMonth() + 1, d: d.getUTCDate(), h: d.getUTCHours(), mi: d.getUTCMinutes(), dow: d.getUTCDay(),
    ymd: `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}`, id: `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}-${p(d.getUTCHours())}${p(d.getUTCMinutes())}` };
}
/* 이번 1분에 돌려야 하나 — 일요일 22:00~22:09 사이 + 오늘 만든 게 없을 때, 또는 요청이 있을 때 */
export function shouldRun(now, idx, pending) {
  if (pending) return 'manual';
  const k = kst(now);
  if (k.dow === 0 && k.h === 22 && k.mi < 10 && !(idx && idx[0] && String(idx[0].id).startsWith(k.ymd))) return 'weekly';
  return '';
}
const urlOk = (v) => { const s = String(v || '').trim(); return /^https?:\/\/[^\s]+$/.test(s) ? s.slice(0, 400) : ''; };

/* 경영팀이 적은 주간 조회 · 예약 → 지점별 최근 8주 (예약 전환율) */
export function statsFacts(stats) {
  const L = [];
  const by = {};
  for (const x of stats || []) (by[x.branch] = by[x.branch] || []).push(x);
  const names = Object.keys(by);
  if (!names.length) return '\n[예약 전환 — 스마트플레이스 통계] 아직 기록 없음. 경영팀에게 매주 조회수 · 예약 신청 수를 앱 "기록" 탭에 적어 달라고 할 일에 넣을 것.';
  L.push('', '[예약 전환 — 경영팀이 스마트플레이스 통계에서 옮겨 적은 주간 숫자. 이번 조사의 가장 중요한 결과 지표]');
  for (const b of names) {
    const arr = by[b].sort((a, c) => (a.wk < c.wk ? 1 : -1)).slice(0, 8);
    L.push(`- ${b}: ` + arr.map((x) => `${x.wk.slice(5)}주 조회 ${x.views} · 예약 ${x.books} · 전환 ${x.views ? (Math.round((x.books / x.views) * 1000) / 10) + '%' : '-'}`).join(' / '));
  }
  return L.join('\n');
}

/* 경쟁 비교 캡처가 있는지 · 언제 올렸는지 — AI 가 '캡처 올릴 때예요'를 할 일에 넣을지 판단 */
export function rivalFacts(meta, now) {
  const items = (meta && meta.items) || [];
  const fresh = items.filter((x) => now - x.at < RIVAL_DAYS * 864e5);
  if (!items.length) return '\n[경쟁 비교 캡처] 아직 없음. 한 달에 한 번 경영팀이 휴대폰으로 "합정 미용실" · "홍대 미용실" 검색 결과와 상위 매장 첫 화면을 캡처해 앱 "기록" 탭에 올리도록 할 일에 넣을 것(rivals 는 공식 API 숫자만으로 채운다).';
  const last = Math.max(...items.map((x) => x.at));
  const old = Math.round((now - last) / 864e5);
  return `\n[경쟁 비교 캡처] ${fresh.length}장(최근 ${RIVAL_DAYS}일 안) · 마지막으로 올린 지 ${old}일.` + (old >= 30 ? ' 30일이 지났으니 새로 찍어 올리자고 할 일에 넣을 것.' : '');
}

export function buildFacts(now, cfg, idx, prev) {
  const k = kst(now);
  const L = [`오늘(한국 시각): ${k.ymd} ${'일월화수목금토'[k.dow]}요일`, '', '[우리 매장]'];
  for (const b of (cfg.branches || [])) {
    L.push(`- ${b.name}` + (b.naver ? ` · 네이버 플레이스: ${b.naver}` : ' · 네이버 플레이스 주소: 아직 안 넣음') + (b.google ? ` · 구글 지도: ${b.google}` : ' · 구글 지도 주소: 아직 안 넣음') + (b.keywords ? ` · 노리는 검색어: ${b.keywords}` : ''));
  }
  if (cfg.note) L.push('', '[경영팀 메모 — 우리 강점 · 상황]', String(cfg.note));
  const past = (idx || []).slice(0, 4);
  if (past.length) {
    L.push('', '[지난 리포트 — 여기 있는 변화는 다시 "바뀐 점"으로 쓰지 말 것]');
    for (const x of past) L.push(`- ${x.id.slice(0, 10)}: ${x.headline || ''}` + (x.ct && x.ct.length ? ' / 바뀐 점: ' + x.ct.join(' · ') : ''));
  }
  if (prev && prev.report && (prev.report.todo || []).length) {
    L.push('', `[지난번(${prev.id.slice(0, 10)}) 할 일과 적용 여부]`);
    prev.report.todo.forEach((t, i) => {
      const d = prev.done && prev.done[i];
      L.push(`- ${d ? '✅ 적용함' : '⬜ 아직'} · ${t.branch} · ${t.title}`);
    });
  }
  return L.join('\n');
}

/* 샤오홍슈 캡처 — 없으면 '올리기'를 할 일에 넣게 한다 */
/* 비교할 틱톡 계정 (캡처에서 AI 가 읽은 숫자) */
const TT_ACCT = { dm: 'DAY:MEAN', bb: '바버샵' };
export function ttxFacts(meta, now) {
  const items = ((meta && meta.items) || []).filter((x) => x.ex && !x.ex.err && now - x.at < 120 * 864e5);
  if (!items.length) return '\n[틱톡 비교 계정] 캡처 없음. 경영팀이 비교할 틱톡 계정 프로필 화면을 SNS 탭에 올리도록 할 일에 넣을 것(한 달에 한 번).';
  const L = ['', '[틱톡 비교 계정 — 경영팀이 올린 프로필 캡처를 AI 가 읽은 숫자. 조회는 프로필 격자에 보이는 최근 영상들]'];
  for (const x of items) {
    const e = x.ex, v = (e.views || []).filter((n) => n >= 0), md = v.length ? v.slice().sort((a, b) => a - b)[v.length >> 1] : null;
    L.push(`- ${TT_ACCT[x.slot] || ''} 비교용 · ${e.handle || x.note || '이름 모름'}${x.note ? ' (' + x.note + ')' : ''}: 팔로워 ${e.followers ?? '-'} · 받은 좋아요 ${e.likes ?? '-'} · 보이는 영상 ${v.length}개 조회 중간값 ${md ?? '-'} (${kst(x.at).ymd} 캡처)`);
  }
  return L.join('\n');
}
/* AI 가 읽은 프로필 숫자 정리 */
export function ttxClean(v) {
  const n = (x) => (x == null || x === '' || !Number.isFinite(+x) || +x < 0 ? null : Math.round(+x));
  if (!v || typeof v !== 'object') return { err: '읽지 못했어요' };
  const out = { handle: String(v.handle || '').trim().slice(0, 40), name: String(v.name || '').trim().slice(0, 40), followers: n(v.followers), following: n(v.following), likes: n(v.likes),
    views: (Array.isArray(v.views) ? v.views : []).map(n).filter((x) => x != null).slice(0, 30), note: String(v.note || '').slice(0, 200) };
  if (out.followers == null && out.likes == null && !out.views.length) return { err: '틱톡 프로필 화면이 아닌 것 같아요', note: out.note };
  return out;
}
export function xhsFacts(meta, now) {
  const items = (meta && meta.items) || [];
  const fresh = items.filter((x) => now - x.at < RIVAL_DAYS * 864e5);
  if (!fresh.length) return '\n[샤오홍슈] 최근 ' + RIVAL_DAYS + '일 안 캡처 없음(공개 API 없음). 경영팀이 샤오홍슈 앱에서 "弘大美发" · "合井美发" · "韩国烫发" 검색 결과와 우리 계정 통계(数据中心)를 캡처해 앱 "SNS" 탭에 올리도록 할 일에 넣을 것. sns.xhs 는 일반 경향만 짧게 쓴다.';
  const n = (k) => fresh.filter((x) => x.kind === k).length;
  const old = Math.round((now - Math.max(...fresh.map((x) => x.at))) / 864e5);
  return `\n[샤오홍슈 캡처] 검색 결과 ${n('search')}장 · 우리 계정 통계 ${n('ours')}장 · 마지막으로 올린 지 ${old}일.` + (n('ours') ? '' : ' 우리 계정 통계 캡처가 없으니 올리자고 할 일에 넣을 것.') + (old >= 30 ? ' 30일이 지났으니 새로 찍어 올리자고 할 일에 넣을 것.' : '');
}

export function makeSeo(deps) {
  const { dbGet, relayCall, pushToPhones, sns } = deps;
  const rGet = async (env, key) => { const o = await env.CHAT_MEDIA.get(key); return o ? o.json() : null; };
  const rPut = (env, key, v) => env.CHAT_MEDIA.put(key, JSON.stringify(v), { httpMetadata: { contentType: 'application/json' } });
  const rDel = (env, key) => env.CHAT_MEDIA.delete(key);

  async function isHq(env, me) {
    if (me && (me.role === 'owner' || me.admin === true)) return true;
    const u = await dbGet(env, '/users/' + encodeURIComponent(String(me.ph))).catch(() => null);
    return hqUser(u);
  }
  async function getCfg(env) {
    const c = (await rGet(env, KEY.cfg).catch(() => null)) || {};
    return { branches: Array.isArray(c.branches) && c.branches.length ? c.branches : DEFAULT_BRANCHES, note: c.note || '', at: c.at || 0, by: c.by || '' };
  }
  async function hqPhones(env) {
    const users = (await dbGet(env, '/users').catch(() => null)) || {};
    return Object.keys(users).filter((ph) => hqUser(users[ph]));
  }

  /* 실제 조사 — trig: 'weekly' | 'manual', by: 누른 사람 이름 */
  async function run(env, trig, by) {
    const lock = await rGet(env, KEY.run).catch(() => null);
    if (lock && Date.now() - lock.at < 20 * 60000) return { skip: 'running' };
    await rPut(env, KEY.run, { at: Date.now(), trig });
    await rDel(env, KEY.pend).catch(() => {});
    try {
      const [cfg, idx] = await Promise.all([getCfg(env), rGet(env, KEY.idx).catch(() => null)]);
      const list = Array.isArray(idx) ? idx : [];
      const prev = list[0] ? await rGet(env, `seo/r/${list[0].id}.json`).catch(() => null) : null;
      /* 숫자 먼저 (무료) — 실패해도 조사는 한다 */
      const [data, stats, ranks, shots, rmeta, xmeta, ttTxt, ttxMeta] = await Promise.all([
        collect(env, cfg, dbGet).catch(() => null),
        rGet(env, KEY.stats).catch(() => null),
        rGet(env, KEY.ranks).catch(() => null),
        Promise.all(SHOPS.map((sh) => rGet(env, `seo/shot/${sh}.json`).catch(() => null))),
        rGet(env, KEY.rival).catch(() => null),
        rGet(env, KEY.xhs).catch(() => null),
        sns ? sns.forReport(env).catch(() => '') : '',
        rGet(env, KEY.ttx).catch(() => null),
      ]);
      if (data) await rPut(env, KEY.data, data).catch(() => {});
      const prevData = prev && prev.data ? prev.data : null;
      const facts = buildFacts(Date.now(), cfg, list, prev) + statsFacts(stats) + dataFacts(data, prevData, ranks || []) + rivalFacts(rmeta, Date.now()) + (ttTxt || '') + ttxFacts(ttxMeta, Date.now()) + xhsFacts(xmeta, Date.now());
      /* 스마트플레이스 통계 캡처 — 45일 안에 올린 것만 AI 에게 보여 준다 */
      const LBL = { flagship: '플래그십점', moment: '모먼트점', eto: 'ETOH 합정점' };
      const images = shots.map((x, i) => (x && x.b64 && Date.now() - x.at < 45 * 864e5 ? { kind: 'stats', label: `${LBL[SHOPS[i]]} 스마트플레이스 통계 캡처 (${kst(x.at).ymd} 올림)`, mt: x.mt, b64: x.b64 } : null)).filter(Boolean);
      /* 경쟁 비교 캡처 — 45일 안, 최대 8장 (올린 순서대로) */
      const rFresh = ((rmeta && rmeta.items) || []).filter((x) => Date.now() - x.at < RIVAL_DAYS * 864e5).sort((a, b) => a.at - b.at).slice(0, RIVAL_MAX);
      for (const [n, x] of rFresh.entries()) {
        const img = await rGet(env, `seo/rival/img/${x.k}.json`).catch(() => null);
        if (img && img.b64) images.push({ kind: 'rival', label: `경쟁 비교 캡처 ${n + 1}${x.note ? ' — ' + x.note : ''} (${kst(x.at).ymd} 올림)`, mt: img.mt, b64: img.b64 });
      }
      /* 샤오홍슈 캡처 — 45일 안, 최대 8장 */
      const xFresh = ((xmeta && xmeta.items) || []).filter((x) => Date.now() - x.at < RIVAL_DAYS * 864e5).sort((a, b) => a.at - b.at).slice(0, RIVAL_MAX);
      for (const [n, x] of xFresh.entries()) {
        const img = await rGet(env, `seo/xhs/img/${x.k}.json`).catch(() => null);
        if (img && img.b64) images.push({ kind: 'xhs', label: `샤오홍슈 ${XHS_KIND[x.kind] || '캡처'} ${n + 1}${x.note ? ' — ' + x.note : ''} (${kst(x.at).ymd} 올림)`, mt: img.mt, b64: img.b64 });
      }
      const r = await relayCall(env, '/ai/seo-weekly', { facts, images }, { nm: by || '자동', x: trig === 'weekly' ? '주간 자동 조사' : '바로 조사' });
      if (!r.body || !r.body.ok || !r.body.report) throw new Error((r.body && r.body.error) || '조사 실패 (' + r.status + ')');
      const now = Date.now(), id = kst(now).id, rep = r.body.report;
      await rPut(env, `seo/r/${id}.json`, { id, at: now, trig, by: by || '', report: rep, done: {}, data: data || null });
      const row = { id, at: now, headline: rep.headline, nc: (rep.changes || []).length, nt: (rep.todo || []).length, ct: (rep.changes || []).map((c) => c.title).slice(0, 6), trig };
      await rPut(env, KEY.idx, [row, ...list.filter((x) => x.id !== id)].slice(0, 60));
      await rDel(env, KEY.err).catch(() => {});
      const to = await hqPhones(env);
      if (to.length) await pushToPhones(env, to, {
        title: trig === 'weekly' ? '이번 주 검색 노출 리포트가 나왔어요' : '검색 노출 조사가 끝났어요',
        body: (rep.headline || '') + (row.nt ? ` · 이번 주 할 일 ${row.nt}개` : ''), url: './#seo', tag: 'seo-' + id,
      }).catch(() => {});
      return { ok: true, id };
    } catch (e) {
      await rPut(env, KEY.err, { at: Date.now(), err: String((e && e.message) || e).slice(0, 300), trig }).catch(() => {});
      return { ok: false, err: String((e && e.message) || e) };
    } finally {
      await rDel(env, KEY.run).catch(() => {});
    }
  }

  /* 1분 크론에서 부른다 — 대부분은 R2 두 번 읽고 끝 */
  async function tick(env) {
    const k = kst(Date.now());
    const pending = await rGet(env, KEY.pend).catch(() => null);
    const weeklyWindow = k.dow === 0 && k.h === 22 && k.mi < 10;
    if (!pending && !weeklyWindow) return null;
    const idx = weeklyWindow ? await rGet(env, KEY.idx).catch(() => null) : null;
    const why = shouldRun(Date.now(), idx, pending);
    if (!why) return null;
    return run(env, why, pending ? pending.by : '');
  }

  const route = async function route(path, request, env, ctx, me, json, origin) {
    if (!path.startsWith('/seo/')) return null;
    if (request.method !== 'POST') return json({ ok: false, error: 'POST 만 됩니다' }, 405, origin);
    if (!(await isHq(env, me))) return json({ ok: false, error: '경영팀만 볼 수 있어요' }, 403, origin);
    const b = await request.json().catch(() => ({}));

    if (path === '/seo/list') {
      const [idx, cfg, pend, running, err] = await Promise.all([rGet(env, KEY.idx), getCfg(env), rGet(env, KEY.pend), rGet(env, KEY.run), rGet(env, KEY.err)].map((p) => p.catch(() => null)));
      return json({ ok: true, items: idx || [], cfg, pending: pend || null, running: running && Date.now() - running.at < 20 * 60000 ? running : null, err: err || null, apis: apisOf(env) }, 200, origin);
    }
    /* 숫자 · 기록 — AI 안 씀. refresh 면 10분에 한 번까지 새로 모은다 */
    if (path === '/seo/numbers') {
      let [data, stats, ranks] = await Promise.all([rGet(env, KEY.data), rGet(env, KEY.stats), rGet(env, KEY.ranks)].map((p) => p.catch(() => null)));
      let note = '';
      if (b.refresh) {
        if (data && Date.now() - data.at < 10 * 60000) note = '방금 불러왔어요. 10분 뒤에 다시 할 수 있어요';
        else { data = await collect(env, await getCfg(env), dbGet); await rPut(env, KEY.data, data); }
      }
      const shots = {};
      for (const sh of SHOPS) {   /* 사진은 크니까 머리(메타)만 */
        const h = await env.CHAT_MEDIA.head(`seo/shot/${sh}.json`).catch(() => null);
        if (h) shots[sh] = { at: +((h.customMetadata && h.customMetadata.at) || 0), by: decodeURIComponent((h.customMetadata && h.customMetadata.by) || '') };
      }
      const rival = ((await rGet(env, KEY.rival).catch(() => null)) || {}).items || [];
      return json({ ok: true, data: data || null, stats: stats || [], ranks: ranks || [], shots, rival, apis: apisOf(env), note }, 200, origin);
    }
    if (path === '/seo/stat') {   /* 주간 조회 · 예약 — 같은 주 · 지점은 덮어쓴다 */
      const cfg = await getCfg(env);
      const branch = String(b.branch || '').trim(), wk = /^\d{4}-\d{2}-\d{2}$/.test(String(b.wk || '')) ? monday(String(b.wk)) : '';
      const views = Math.floor(+b.views), books = Math.floor(+b.books);
      if (!cfg.branches.some((x) => x.name === branch) || !wk) return json({ ok: false, error: '지점과 주를 골라 주세요' }, 400, origin);
      if (!(views >= 0 && views < 1e7 && books >= 0 && books < 1e6)) return json({ ok: false, error: '숫자를 확인해 주세요' }, 400, origin);
      const list = ((await rGet(env, KEY.stats).catch(() => null)) || []).filter((x) => !(x.wk === wk && x.branch === branch));
      list.unshift({ id: wk + '|' + branch, wk, branch, views, books, at: Date.now(), by: String(me.name || '').slice(0, 30) });
      list.sort((x, y) => (x.wk < y.wk ? 1 : -1));
      await rPut(env, KEY.stats, list.slice(0, 400));
      return json({ ok: true, stats: list.slice(0, 400) }, 200, origin);
    }
    if (path === '/seo/rank') {   /* 휴대폰으로 본 플레이스 순위 */
      const cfg = await getCfg(env);
      const q = String(b.q || '').trim().slice(0, 30), branch = String(b.branch || '').trim(), rank = Math.floor(+b.rank || 0);
      if (!q || !cfg.branches.some((x) => x.name === branch)) return json({ ok: false, error: '검색어와 지점을 넣어 주세요' }, 400, origin);
      if (!(rank >= 0 && rank <= 300)) return json({ ok: false, error: '순위를 확인해 주세요' }, 400, origin);
      const list = (await rGet(env, KEY.ranks).catch(() => null)) || [];
      list.unshift({ id: Date.now().toString(36), at: Date.now(), by: String(me.name || '').slice(0, 30), q, branch, rank });
      await rPut(env, KEY.ranks, list.slice(0, 300));
      return json({ ok: true, ranks: list.slice(0, 300) }, 200, origin);
    }
    if (path === '/seo/rank/del' || path === '/seo/stat/del') {
      const key = path === '/seo/rank/del' ? KEY.ranks : KEY.stats;
      const list = ((await rGet(env, key).catch(() => null)) || []).filter((x) => x.id !== String(b.id || ''));
      await rPut(env, key, list);
      return json({ ok: true, [path === '/seo/rank/del' ? 'ranks' : 'stats']: list }, 200, origin);
    }
    if (path === '/seo/shot' || path === '/seo/shot/get' || path === '/seo/shot/del') {   /* 스마트플레이스 통계 캡처 */
      const sh = String(b.shop || '');
      if (SHOPS.indexOf(sh) < 0) return json({ ok: false, error: '지점을 골라 주세요' }, 400, origin);
      const key = `seo/shot/${sh}.json`;
      if (path === '/seo/shot/get') { const x = await rGet(env, key).catch(() => null); return x ? json({ ok: true, mt: x.mt, b64: x.b64, at: x.at }, 200, origin) : json({ ok: false, error: '캡처가 없어요' }, 404, origin); }
      if (path === '/seo/shot/del') { await rDel(env, key).catch(() => {}); return json({ ok: true }, 200, origin); }
      const mt = String(b.mt || ''), b64 = String(b.b64 || '');
      if (!/^image\/(jpeg|png|webp)$/.test(mt) || !/^[A-Za-z0-9+/=]+$/.test(b64)) return json({ ok: false, error: '사진만 올릴 수 있어요' }, 400, origin);
      if (b64.length > 2400000) return json({ ok: false, error: '사진이 너무 커요' }, 413, origin);
      const at = Date.now(), nm = String(me.name || '').slice(0, 30);
      await env.CHAT_MEDIA.put(key, JSON.stringify({ at, by: nm, mt, b64 }), { httpMetadata: { contentType: 'application/json' }, customMetadata: { at: String(at), by: encodeURIComponent(nm) } });
      return json({ ok: true, at }, 200, origin);
    }
    /* 틱톡 회사 계정 (sns.js) + 샤오홍슈 캡처 목록 */
    if (sns && (path === '/seo/sns' || path.startsWith('/seo/tt/'))) {
      const r = await sns.route(path, b, env, me, new URL(request.url));
      if (!r) return json({ ok: false, error: '없는 기능입니다' }, 404, origin);
      if (path === '/seo/sns') {
        r.xhs = ((await rGet(env, KEY.xhs).catch(() => null)) || {}).items || [];
        r.ttx = ((await rGet(env, KEY.ttx).catch(() => null)) || {}).items || [];
        /* 업계 평균 — 가장 최근 주간 조사가 웹에서 찾은 것 (출처 있는 것만) */
        const idx = (await rGet(env, KEY.idx).catch(() => null)) || [];
        for (const row of idx.slice(0, 4)) {
          const rr = await rGet(env, `seo/r/${row.id}.json`).catch(() => null);
          const bench = rr && rr.report && rr.report.sns && rr.report.sns.bench;
          if (Array.isArray(bench) && bench.length) { r.bench = { at: rr.at, items: bench }; break; }
        }
      }
      return json(r, r.ok ? 200 : 400, origin);
    }
    const cap = path.match(/^\/seo\/(rival|xhs|ttx)\/[a-z]+$/);
    if (cap) {   /* 캡처 여러 장 — rival: 경쟁 비교 · xhs: 샤오홍슈 */
      const C = cap[1], dir = `seo/${C}/img/`, mkey = KEY[C], base = `/seo/${C}/`;
      const meta = (await rGet(env, mkey).catch(() => null)) || { items: [] };
      const items = Array.isArray(meta.items) ? meta.items : [];
      const k = String(b.k || '');
      const okK = /^[a-z0-9]{6,16}$/.test(k) && items.some((x) => x.k === k);
      if (path === base + 'add') {
        const mt = String(b.mt || ''), b64 = String(b.b64 || '');
        if (!/^image\/(jpeg|png|webp)$/.test(mt) || !/^[A-Za-z0-9+/=]+$/.test(b64)) return json({ ok: false, error: '사진만 올릴 수 있어요' }, 400, origin);
        if (b64.length > 2400000) return json({ ok: false, error: '사진이 너무 커요' }, 413, origin);
        if (items.length >= RIVAL_MAX) return json({ ok: false, error: `${RIVAL_MAX}장까지예요. 지난 캡처를 지우고 올려 주세요` }, 400, origin);
        const nk = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
        const row = { k: nk, at: Date.now(), by: String(me.name || '').slice(0, 30), note: String(b.note || '').trim().slice(0, 40) };
        if (C === 'xhs') row.kind = b.kind === 'ours' ? 'ours' : 'search';
        if (C === 'ttx') {
          row.slot = b.slot === 'bb' ? 'bb' : 'dm';
          /* 올릴 때 바로 숫자를 읽어 둔다 — 비교표가 일요일 조사를 기다리지 않게 */
          try {
            const r = await relayCall(env, '/ai/tt-cap', { mt, b64 }, { ph: me.ph, nm: me.name, x: '틱톡 비교 캡처 읽기' });
            row.ex = r.body && r.body.ok ? ttxClean(r.body.data) : { err: (r.body && r.body.error) || '읽지 못했어요' };
          } catch (e) { row.ex = { err: '읽지 못했어요' }; }
        }
        await rPut(env, dir + nk + '.json', { mt, b64 });
        items.push(row);
        await rPut(env, mkey, { items });
        return json({ ok: true, items }, 200, origin);
      }
      if (path === base + 'get') {
        if (!okK) return json({ ok: false, error: '캡처가 없어요' }, 404, origin);
        const x = await rGet(env, dir + k + '.json').catch(() => null);
        return x ? json({ ok: true, mt: x.mt, b64: x.b64 }, 200, origin) : json({ ok: false, error: '캡처가 없어요' }, 404, origin);
      }
      if (path === base + 'del') {
        if (!okK) return json({ ok: false, error: '캡처가 없어요' }, 404, origin);
        await rDel(env, dir + k + '.json').catch(() => {});
        const next = items.filter((x) => x.k !== k);
        await rPut(env, mkey, { items: next });
        return json({ ok: true, items: next }, 200, origin);
      }
      if (path === base + 'clear') {
        for (const x of items) await rDel(env, dir + x.k + '.json').catch(() => {});
        await rPut(env, mkey, { items: [] });
        return json({ ok: true, items: [] }, 200, origin);
      }
      return json({ ok: false, error: '없는 기능입니다' }, 404, origin);
    }
    if (path === '/seo/get') {
      const id = String(b.id || '');
      if (!/^\d{4}-\d{2}-\d{2}-\d{4}$/.test(id)) return json({ ok: false, error: '잘못된 리포트' }, 400, origin);
      const r = await rGet(env, `seo/r/${id}.json`).catch(() => null);
      return r ? json({ ok: true, r }, 200, origin) : json({ ok: false, error: '리포트가 없어요' }, 404, origin);
    }
    if (path === '/seo/cfg') {
      const br = (Array.isArray(b.branches) ? b.branches : []).slice(0, 10).map((x) => ({
        name: String((x && x.name) || '').trim().slice(0, 40), naver: urlOk(x && x.naver), google: urlOk(x && x.google), keywords: String((x && x.keywords) || '').trim().slice(0, 200),
      })).filter((x) => x.name);
      if (!br.length) return json({ ok: false, error: '매장을 하나 이상 넣어 주세요' }, 400, origin);
      const next = { branches: br, note: String(b.note || '').trim().slice(0, 1500), at: Date.now(), by: String(me.name || '').slice(0, 30) };
      await rPut(env, KEY.cfg, next);
      return json({ ok: true, cfg: next }, 200, origin);
    }
    if (path === '/seo/run') {
      const [running, pend, idx] = await Promise.all([rGet(env, KEY.run), rGet(env, KEY.pend), rGet(env, KEY.idx)].map((p) => p.catch(() => null)));
      if (running && Date.now() - running.at < 20 * 60000) return json({ ok: true, already: 'running' }, 200, origin);
      if (pend) return json({ ok: true, already: 'pending' }, 200, origin);
      /* 비용 — 조사 한 번 약 ₩500~1,500. 연달아 누르지 않게 1시간에 한 번 */
      if (idx && idx[0] && Date.now() - idx[0].at < 60 * 60000) return json({ ok: false, error: '방금 조사했어요. 1시간 뒤에 다시 할 수 있어요' }, 429, origin);
      await rPut(env, KEY.pend, { at: Date.now(), by: String(me.name || '').slice(0, 30) });
      return json({ ok: true }, 200, origin);
    }
    if (path === '/seo/done') {
      const id = String(b.id || ''), i = Math.floor(+b.i);
      if (!/^\d{4}-\d{2}-\d{2}-\d{4}$/.test(id) || !(i >= 0 && i < 10)) return json({ ok: false, error: '잘못된 요청' }, 400, origin);
      const key = `seo/r/${id}.json`;
      const r = await rGet(env, key).catch(() => null);
      if (!r || !r.report || !(r.report.todo || [])[i]) return json({ ok: false, error: '할 일이 없어요' }, 404, origin);
      r.done = r.done || {};
      if (b.on) r.done[i] = { by: String(me.name || '').slice(0, 30), at: Date.now() }; else delete r.done[i];
      await rPut(env, key, r);
      return json({ ok: true, done: r.done }, 200, origin);
    }
    return json({ ok: false, error: '없는 기능입니다' }, 404, origin);
  };
  route.tick = tick;
  route.run = run;
  return route;
}
