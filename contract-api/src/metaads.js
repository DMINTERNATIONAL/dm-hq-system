/**
 * 광고 성과 (메타) — 경영팀 화면 '광고 성과' 가 부른다 (2026-11-13, '만들어줘 보기 편하게').
 *
 * POST /ads/summary { acc: 'daymean'|'etoh', range: 'today'|'7d'|'30d', force }  — 경영팀만
 *   메타(Graph v26)에서 그 광고 계정의 캠페인 · 광고별 숫자를 받아 한 번에 돌려준다.
 *   + 우리 예약 페이지(book.html) 지점 버튼 누름 수(/adClicks, index.js /public/adclick)를 광고 링크의 c= 로 이어 붙인다.
 *   같은 계정 · 기간은 10분 동안 R2 에 담아 둔 것을 준다(메타 호출 한도 · 속도). force 면 새로.
 * 토큰: 시크릿 META_TOKEN (시스템 사용자 'Conversions API System User', 앱 DM Analytics).
 *   ⚠️ 메타 응답의 paging.next 에 토큰이 그대로 들어 있다 — 밖으로 내보내지 않는다(아래 g() 가 지움).
 * 읽기만 한다. 광고 켜기 · 끄기 · 예산은 여기서 안 바꾼다(돈이 나가는 일이라 사용자 승인 후 따로).
 */
import { hqUser } from './aiusage.js';

const V = 'v26.0';
export const AD_ACCS = {
  daymean: { id: '1493386784319174', name: 'DAY:MEAN' },
  etoh: { id: '1879073359434684', name: 'ETOH' },
};
const KST = 9 * 3600e3;
const ymd = (t) => new Date(t + KST).toISOString().slice(0, 10);
const num = (x) => +x || 0;
const act = (r, ...ks) => { let n = 0; for (const a of (r && r.actions) || []) if (ks.includes(a.action_type)) n = Math.max(n, num(a.value)); return n; };

export function makeMetaAds(deps) {
  const { dbGet } = deps;
  const rGet = async (env, key) => { const o = await env.CHAT_MEDIA.get(key); return o ? o.json() : null; };
  const rPut = (env, key, v) => env.CHAT_MEDIA.put(key, JSON.stringify(v), { httpMetadata: { contentType: 'application/json' } });

  async function isHq(env, me) {
    if (me && (me.role === 'owner' || me.admin === true)) return true;
    const u = await dbGet(env, '/users/' + encodeURIComponent(String(me.ph))).catch(() => null);
    return hqUser(u);
  }

  async function g(env, path, params = {}) {
    const u = new URL(`https://graph.facebook.com/${V}/${path}`);
    for (const [k, x] of Object.entries(params)) u.searchParams.set(k, typeof x === 'string' ? x : JSON.stringify(x));
    u.searchParams.set('access_token', env.META_TOKEN);
    const j = await (await fetch(u)).json().catch(() => ({}));
    if (j && j.paging) delete j.paging;   // next 링크에 토큰이 있다
    if (j && j.error) throw new Error((j.error.error_user_msg || j.error.message || '메타 오류').slice(0, 200));
    return j;
  }

  function rangeOf(range, now) {
    const until = ymd(now);
    const back = range === 'today' ? 0 : range === '30d' ? 29 : 6;
    return { since: ymd(now - back * 86400e3), until };
  }

  async function build(env, acc, range) {
    const A = AD_ACCS[acc]; const now = Date.now(); const tr = rangeOf(range, now);
    const act_ = 'act_' + A.id;
    const F = 'spend,impressions,reach,frequency,inline_link_clicks,actions';
    const last14 = { since: ymd(now - 13 * 86400e3), until: ymd(now) };
    const [camps, cIns, aIns, days, ads, clicks] = await Promise.all([
      g(env, act_ + '/campaigns', { fields: 'id,name,status,effective_status,objective,daily_budget,lifetime_budget,stop_time', limit: 100 }),
      g(env, act_ + '/insights', { level: 'campaign', time_range: tr, fields: 'campaign_id,' + F, limit: 200 }),
      g(env, act_ + '/insights', { level: 'ad', time_range: tr, fields: 'ad_id,' + F, limit: 500 }),
      g(env, act_ + '/insights', { time_range: last14, time_increment: 1, fields: 'spend,inline_link_clicks,actions', limit: 30 }),
      g(env, act_ + '/ads', { fields: 'id,name,status,effective_status,campaign_id,adset{name,daily_budget,effective_status},creative{object_story_spec}', limit: 300 }),
      dbGet(env, '/adClicks').catch(() => null),
    ]);
    /* 예약 페이지 버튼 누름 — 기간 안 날짜만, c 별 · 지점별 */
    const btn = {};
    for (const [d, byC] of Object.entries(clicks || {})) {
      if (d < tr.since || d > tr.until) continue;
      for (const [c, byB] of Object.entries(byC || {})) { const o = (btn[c] = btn[c] || { flagship: 0, moment: 0, kakao: 0 }); for (const b of Object.keys(o)) o[b] += num(byB && byB[b]); }
    }
    const row = (r) => ({ spend: num(r && r.spend), imp: num(r && r.impressions), reach: num(r && r.reach), freq: num(r && r.frequency), clicks: num(r && r.inline_link_clicks),
      lpv: act(r, 'landing_page_view', 'omni_landing_page_view'), lead: act(r, 'lead', 'offsite_conversion.fb_pixel_lead'), msg: act(r, 'onsite_conversion.messaging_conversation_started_7d') });
    const cMap = {}; for (const r of cIns.data || []) cMap[r.campaign_id] = row(r);
    const aMap = {}; for (const r of aIns.data || []) aMap[r.ad_id] = row(r);
    const cOf = (ad) => { try { const l = ad.creative.object_story_spec.link_data.link; return new URL(l).searchParams.get('c') || ''; } catch (e) { return ''; } };
    const adsBy = {};
    for (const ad of ads.data || []) {
      const m = aMap[ad.id]; const live = ad.effective_status === 'ACTIVE' || /PROCESS|REVIEW|ISSUES|DISAPPROVED/.test(ad.effective_status || '');
      if (!m && !live) continue;
      const c = cOf(ad); const b = (c && btn[c]) || null;
      (adsBy[ad.campaign_id] = adsBy[ad.campaign_id] || []).push({ id: ad.id, name: ad.name, set: (ad.adset && ad.adset.name) || '', eff: ad.effective_status, c,
        ...(m || row(null)), btn: b ? b.flagship + b.moment : 0, btnB: b, kakao: b ? b.kakao : 0 });
    }
    const out = [];
    for (const c of camps.data || []) {
      const m = cMap[c.id]; const live = c.effective_status === 'ACTIVE';
      if (!m && !live) continue;
      const list = (adsBy[c.id] || []).sort((x, y) => y.spend - x.spend);
      let budget = 0; const seen = {};
      for (const a of ads.data || []) if (a.campaign_id === c.id && a.adset && a.adset.effective_status === 'ACTIVE' && !seen[a.adset.name]) { seen[a.adset.name] = 1; budget += num(a.adset.daily_budget); }
      /* 실제로 나가는 중 = 캠페인이 켜져 있고 광고 하나라도 게재 · 검토 중. 캠페인만 켜지고 광고가 다 꺼져 있으면 돈이 안 나간다 */
      const on = live && list.some((a) => a.eff === 'ACTIVE' || /PROCESS|REVIEW/.test(a.eff || ''));
      out.push({ id: c.id, name: c.name, eff: c.effective_status, on, obj: c.objective, budget: num(c.daily_budget) || budget, stop: c.stop_time || '',
        ...(m || row(null)), btn: list.reduce((n, a) => n + a.btn, 0), kakao: list.reduce((n, a) => n + a.kakao, 0), ads: list });
    }
    out.sort((x, y) => (y.on - x.on) || y.spend - x.spend);
    const tot = out.reduce((t, c) => { for (const k of ['spend', 'imp', 'reach', 'clicks', 'lpv', 'lead', 'btn', 'kakao']) t[k] += c[k]; return t; }, { spend: 0, imp: 0, reach: 0, clicks: 0, lpv: 0, lead: 0, btn: 0, kakao: 0 });
    tot.flagship = 0; tot.moment = 0; for (const c of out) for (const a of c.ads) if (a.btnB) { tot.flagship += a.btnB.flagship; tot.moment += a.btnB.moment; }
    tot.dailyBudget = out.filter((c) => c.on).reduce((n, c) => n + c.budget, 0);
    /* 알아 둘 것 — 화면 맨 위 노란 카드 */
    const alerts = [];
    for (const c of out) {
      if (c.on && c.clicks >= 100 && c.lpv / c.clicks < 0.3 && c.obj === 'OUTCOME_TRAFFIC')
        alerts.push({ lv: 'warn', t: `'${c.name}' 클릭 ${c.clicks}번 중 페이지 도착 ${Math.round(c.lpv / c.clicks * 100)}%`, d: '링크가 인스타 프로필 · 링크트리로 가면 도착이 거의 안 잡혀요. 예약 페이지로 바꾸면 측정과 성과가 같이 좋아져요.' });
      for (const a of c.ads) {
        if (/DISAPPROVED/.test(a.eff)) alerts.push({ lv: 'bad', t: `광고 거절: ${a.name}`, d: '메타 검토에서 거절됐어요. 광고 관리자에서 사유를 확인해야 해요.' });
        else if (/ISSUES/.test(a.eff)) alerts.push({ lv: 'warn', t: `광고에 문제: ${a.name}`, d: '게재가 막혀 있어요. 광고 관리자에서 확인이 필요해요.' });
        if (a.freq >= 3.5 && a.imp >= 1000) alerts.push({ lv: 'warn', t: `'${a.name}' 같은 사람에게 평균 ${a.freq.toFixed(1)}번`, d: '피로도가 쌓이면 클릭이 떨어져요. 소재 교체를 생각할 때예요.' });
      }
    }
    return { ok: true, acc, name: A.name, range: tr, at: now,
      tot, camps: out, alerts,
      days: (days.data || []).map((r) => ({ d: r.date_start, spend: num(r.spend), clicks: num(r.inline_link_clicks), lpv: act(r, 'landing_page_view', 'omni_landing_page_view') })) };
  }

  return async function route(path, request, env, ctx, me, json, origin) {
    if (path !== '/ads/summary' || request.method !== 'POST') return null;
    if (!(await isHq(env, me))) return json({ ok: false, error: '경영팀만 볼 수 있어요' }, 403, origin);
    if (!env.META_TOKEN) return json({ ok: false, error: '메타 연결이 아직 안 됐어요' }, 503, origin);
    const b = await request.json().catch(() => ({}));
    const acc = AD_ACCS[b.acc] ? b.acc : 'daymean';
    const range = ['today', '7d', '30d'].includes(b.range) ? b.range : '7d';
    const key = `ads/cache/${acc}_${range}.json`;
    if (!b.force) { const c = await rGet(env, key).catch(() => null); if (c && Date.now() - c.at < 10 * 60e3) return json({ ...c, cached: true }, 200, origin); }
    try {
      const r = await build(env, acc, range);
      ctx.waitUntil(rPut(env, key, r).catch(() => {}));
      return json(r, 200, origin);
    } catch (e) {
      const c = await rGet(env, key).catch(() => null);
      if (c) return json({ ...c, cached: true, stale: true, warn: String(e.message || e) }, 200, origin);
      return json({ ok: false, error: String(e.message || e) }, 502, origin);
    }
  };
}
