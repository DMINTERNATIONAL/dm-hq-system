/* ═══ AI 사용량 · 비용 기록 ═══
   앱에서 AI 를 부를 때마다(상담 메모 다듬기 · 손님 제품 추천 · 내수 캡처 판독 · 채팅 요약 · 인스타 리포트)
   릴레이가 돌려준 토큰 수로 금액을 계산해 남긴다. 금액은 Anthropic 공개 가격표로 계산한 '추정'이다 —
   정확한 청구 금액은 Anthropic 콘솔이 기준이다.

   저장 위치(잠긴 경로라 staff 토큰으로는 못 읽는다):
     /authSecrets/__ai/usage/{YYYY-MM}/{pushId} = { at, f, m, in, out, cr, cw, ws?, usd, ph?, nm?, x?, tp?, unk? }
     /authSecrets/__ai/sum/{YYYY-MM}           = { usd, n, in, out, f: { 기능: { usd, n } }, al?: { b, lv } }
     /authSecrets/__ai/cfg                     = { budgetKrw, krw, hist: { YYYY-MM: 예산 }, at, by }
   예산은 비워 둘 수 있다(알림 없음). 넣으면 그 달 80% · 100% 를 넘을 때 경영팀 휴대폰으로 한 번씩 알림만 보낸다.
   AI 를 막지는 않는다. */

/* USD / 100만 토큰 — [입력, 출력, 캐시 읽기, 캐시 쓰기(5분)] (2026-11 기준 공개 가격) */
const PRICES = [
  [/opus-5-5/, [4, 20, 0.2, 5]],
  [/sonnet-5-5/, [2, 10, 0.2, 2.5]],
  [/haiku-5-5/, [0.1, 0.5, 0.01, 0.125]],
  [/haiku-4-5/, [1, 5, 0.1, 1.25]],
];
const WORST = [4, 20, 0.2, 5];
export const WEB_SEARCH_USD = 0.01;   // 웹 검색 한 번   // 가격표에 없는 모델은 가장 비싼 값으로 잡고 표시한다(적게 보이는 것보다 낫다)

export const FEATURES = {
  '/ai/polish': 'polish', '/ai/recommend': 'reco', '/ai/naesu-verify': 'naesu',
  '/ai/chat-summary': 'chatsum', '/ai/ig-report': 'igreport', '/ai/seo-weekly': 'seo',
};

export function priceOf(model) {
  const m = String(model || '');
  for (const [re, p] of PRICES) if (re.test(m)) return { p, unk: false };
  return { p: WORST, unk: true };
}
export function costUsd(model, ai) {
  const { p, unk } = priceOf(model);
  /* 웹 검색(서버 도구)은 토큰과 따로 1,000번에 $10 */
  const v = ((+ai.in || 0) * p[0] + (+ai.out || 0) * p[1] + (+ai.cr || 0) * p[2] + (+ai.cw || 0) * p[3]) / 1e6 + (+ai.ws || 0) * WEB_SEARCH_USD;
  return { usd: Math.round(v * 1e6) / 1e6, unk };
}
/* 한국 시각 기준 'YYYY-MM' */
export function monthKey(ts) {
  const d = new Date(ts + 9 * 3600e3);
  return d.getUTCFullYear() + '-' + String(d.getUTCMonth() + 1).padStart(2, '0');
}
/* 그 달에 적용할 예산 — 그 달에 정한 값, 없으면 그 전 달 중 가장 최근 값 */
export function budgetFor(cfg, ym) {
  const h = (cfg && cfg.hist) || {};
  const ks = Object.keys(h).filter((k) => k <= ym).sort();
  if (!ks.length) return null;
  const v = h[ks[ks.length - 1]];
  return v == null || v === '' || !(+v > 0) ? null : +v;
}
const HQ_GRADES = ['경영팀', '관리자', '스탭장'];
/* 인스타 리포트 · KPI 화면의 '본사' 판정과 같다 */
export function hqUser(u) {
  if (!u || u.status === '퇴사') return false;
  if (u.role === '디자이너' || u.role === '인턴' || u.academyRole === '인턴') return false;
  if (u.systemGrade) return HQ_GRADES.indexOf(u.systemGrade) >= 0;
  return u.role === '경영팀' || u.role === '본사경영팀' || u.role === '매니저' || u.brand === 'DM INTERNATIONAL';
}

export function makeAiUsage(deps) {
  const { dbGet, dbPut, dbCas, dbPush, pushToPhones } = deps;
  const BASE = '/authSecrets/__ai';

  async function isHq(env, me) {
    if (me && (me.role === 'owner' || me.admin === true)) return true;
    const u = await dbGet(env, '/users/' + encodeURIComponent(String(me.ph))).catch(() => null);
    return hqUser(u);
  }

  /* 한 번 쓴 것을 남긴다. who = { ph, nm, x, tp } (모두 선택). 실패해도 AI 답에는 영향 없다. */
  async function log(env, path, ai, who) {
    const f = FEATURES[path] || String(path || '').replace(/^\/ai\//, '').slice(0, 20) || 'etc';
    const { usd, unk } = costUsd(ai.m, ai);
    const now = Date.now();
    const ym = monthKey(now);
    const rec = { at: now, f, m: String(ai.m || '').slice(0, 60), in: +ai.in || 0, out: +ai.out || 0, cr: +ai.cr || 0, cw: +ai.cw || 0, usd };
    if (unk) rec.unk = 1;
    if (+ai.ws > 0) rec.ws = +ai.ws;
    if (who) {
      if (who.ph) rec.ph = String(who.ph).slice(0, 15);
      if (who.nm) rec.nm = String(who.nm).slice(0, 30);
      if (who.x) rec.x = String(who.x).slice(0, 60);
      if (who.tp) {
        rec.tp = String(who.tp).slice(0, 15);
        /* 경영팀이 다른 직원 리포트를 만든 경우 — 대상 이름을 붙여 둔다(화면에서 직원 목록을 따로 안 읽게) */
        const tn = await dbGet(env, '/users/' + encodeURIComponent(rec.tp) + '/name').catch(() => null);
        if (tn) rec.x = ((rec.x || '') + ' · ' + String(tn)).slice(0, 60);
      }
    }
    await dbPush(env, `${BASE}/usage/${ym}`, rec);

    const cfg = (await dbGet(env, BASE + '/cfg').catch(() => null)) || {};
    const budget = budgetFor(cfg, ym);
    const rate = +cfg.krw > 0 ? +cfg.krw : 1400;
    let crossed = 0, after = null;
    for (let i = 0; i < 4; i++) {
      const ok = await dbCas(env, `${BASE}/sum/${ym}`, (cur) => {
        const s = cur && typeof cur === 'object' ? cur : {};
        const n = { usd: (+s.usd || 0) + usd, n: (+s.n || 0) + 1, in: (+s.in || 0) + rec.in, out: (+s.out || 0) + rec.out, f: { ...(s.f || {}) } };
        n.usd = Math.round(n.usd * 1e6) / 1e6;
        const g = n.f[f] || {};
        n.f[f] = { usd: Math.round(((+g.usd || 0) + usd) * 1e6) / 1e6, n: (+g.n || 0) + 1 };
        /* 예산 알림 — 예산을 바꾸면(b 가 달라지면) 다시 0 부터 */
        const prev = s.al && s.al.b === budget ? +s.al.lv || 0 : 0;
        crossed = 0;
        if (budget) {
          const ratio = (n.usd * rate) / budget;
          const lv = ratio >= 1 ? 1 : ratio >= 0.8 ? 0.8 : 0;
          if (lv > prev) crossed = lv;
          n.al = { b: budget, lv: Math.max(lv, prev) };
        }
        after = n;
        return n;
      }).catch(() => false);
      if (ok) break;
      crossed = 0;
    }
    if (crossed && after) await alertHq(env, ym, crossed, after.usd * rate, budget).catch(() => {});
    return rec;
  }

  async function alertHq(env, ym, lv, krw, budget) {
    const users = (await dbGet(env, '/users').catch(() => null)) || {};
    const to = Object.keys(users).filter((ph) => hqUser(users[ph]));
    if (!to.length) return;
    const won = (v) => '₩' + Math.round(v).toLocaleString('ko-KR');
    const m = +ym.slice(5);
    await pushToPhones(env, to, {
      title: lv >= 1 ? 'AI 비용이 이번 달 예산을 넘었어요' : 'AI 비용이 이번 달 예산의 80%를 넘었어요',
      body: `${m}월 지금까지 약 ${won(krw)} / 예산 ${won(budget)} — AI 사용량 화면에서 자세히 볼 수 있어요`,
      url: './#ai-usage', tag: 'ai-budget-' + ym,
    });
  }

  /* 라우터 — 경영팀만. 처리했으면 Response, 아니면 null */
  const route = async function route(path, request, env, ctx, me, json, origin) {
    if (!path.startsWith('/ai/usage')) return null;
    if (request.method !== 'POST') return json({ ok: false, error: 'POST 만 됩니다' }, 405, origin);
    if (!(await isHq(env, me))) return json({ ok: false, error: '경영팀만 볼 수 있어요' }, 403, origin);
    const b = await request.json().catch(() => ({}));
    const cfgNow = async () => {
      const c = (await dbGet(env, BASE + '/cfg').catch(() => null)) || {};
      return { budgetKrw: c.budgetKrw == null ? null : +c.budgetKrw, krw: +c.krw > 0 ? +c.krw : 1400, hist: c.hist || {}, at: c.at || 0, by: c.by || '' };
    };

    /* 한 달 — 기록 전부 + 합계 + 설정 */
    if (path === '/ai/usage/month') {
      const ym = /^\d{4}-\d{2}$/.test(String(b.ym || '')) ? String(b.ym) : monthKey(Date.now());
      const [raw, sum, cfg] = await Promise.all([
        dbGet(env, `${BASE}/usage/${ym}`).catch(() => null),
        dbGet(env, `${BASE}/sum/${ym}`).catch(() => null),
        cfgNow(),
      ]);
      const recs = Object.values(raw || {}).filter((r) => r && r.at).sort((a, z) => z.at - a.at);
      return json({ ok: true, ym, recs, sum: sum || null, cfg, budget: budgetFor(cfg, ym), now: Date.now() }, 200, origin);
    }

    /* 달별 합계 (추이 리포트) */
    if (path === '/ai/usage/months') {
      const [all, cfg] = await Promise.all([dbGet(env, `${BASE}/sum`).catch(() => null), cfgNow()]);
      const months = Object.keys(all || {}).sort().map((ym) => ({ ym, ...all[ym], budget: budgetFor(cfg, ym) }));
      return json({ ok: true, months, cfg }, 200, origin);
    }

    /* 예산 · 환율 저장 — 예산은 비워도 된다. 이번 달부터 적용(지난달 기록은 그대로) */
    if (path === '/ai/usage/cfg') {
      const cur = await cfgNow();
      const bud = b.budgetKrw === null || b.budgetKrw === '' || b.budgetKrw === undefined ? null : Math.round(+b.budgetKrw);
      if (bud !== null && !(bud > 0 && bud < 1e9)) return json({ ok: false, error: '예산은 1원 이상 숫자로 넣어 주세요 (비워 두면 알림 없음)' }, 400, origin);
      const krw = b.krw === undefined || b.krw === '' ? cur.krw : Math.round(+b.krw);
      if (!(krw >= 500 && krw <= 5000)) return json({ ok: false, error: '환율은 500~5000 사이로 넣어 주세요' }, 400, origin);
      const hist = { ...cur.hist, [monthKey(Date.now())]: bud === null ? 0 : bud };
      const next = { budgetKrw: bud, krw, hist, at: Date.now(), by: String(me.name || '').slice(0, 30) };
      await dbPut(env, BASE + '/cfg', next);
      return json({ ok: true, cfg: next }, 200, origin);
    }
    return json({ ok: false, error: '없는 기능입니다' }, 404, origin);
  };
  route.log = log;
  return route;
}
