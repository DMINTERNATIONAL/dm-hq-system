/* ═══ 검색 노출 주간 조사 (네이버 플레이스 · 구글 비즈니스 프로필) ═══
   매주 일요일 밤 10시(한국)에 1분 크론이 한 번 돌린다. 경영팀이 앱에서 '지금 조사하기'를 누르면 다음 1분 크론이 바로 돌린다.
   릴레이 /ai/seo-weekly (Sonnet 5.5 + 웹 검색)가 기준 · 정책 변화를 찾고 이번 주 할 일과 붙여넣을 글을 쓴다.
   경영팀만 본다. 저장은 R2 (DB 에 두면 staff 토큰으로 누구나 읽혀서):
     seo/cfg.json          = { branches: [{ name, naver, google, keywords }], note, at, by }
     seo/index.json        = [{ id, at, headline, nc, nt, trig }]  최신이 앞, 최대 60개
     seo/r/{id}.json       = { id, at, trig, report, done: { 할일번호: { by, at } } }
     seo/_pending.json     = { at, by }   — '지금 조사하기' 요청
     seo/_running.json     = { at }       — 겹쳐 돌지 않게 (20분 지나면 무시)
     seo/_err.json         = { at, err }  — 마지막 실패 */
import { hqUser } from './aiusage.js';

const DEFAULT_BRANCHES = [
  { name: 'DAY:MEAN 플래그십점', naver: '', google: '', keywords: '' },
  { name: 'DAY:MEAN 모먼트점', naver: '', google: '', keywords: '' },
  { name: 'ETOH 합정점', naver: '', google: '', keywords: '' },
];
const KEY = { cfg: 'seo/cfg.json', idx: 'seo/index.json', pend: 'seo/_pending.json', run: 'seo/_running.json', err: 'seo/_err.json' };

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

export function makeSeo(deps) {
  const { dbGet, relayCall, pushToPhones } = deps;
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
      const facts = buildFacts(Date.now(), cfg, list, prev);
      const r = await relayCall(env, '/ai/seo-weekly', { facts }, { nm: by || '자동', x: trig === 'weekly' ? '주간 자동 조사' : '바로 조사' });
      if (!r.body || !r.body.ok || !r.body.report) throw new Error((r.body && r.body.error) || '조사 실패 (' + r.status + ')');
      const now = Date.now(), id = kst(now).id, rep = r.body.report;
      await rPut(env, `seo/r/${id}.json`, { id, at: now, trig, by: by || '', report: rep, done: {} });
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
      return json({ ok: true, items: idx || [], cfg, pending: pend || null, running: running && Date.now() - running.at < 20 * 60000 ? running : null, err: err || null }, 200, origin);
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
