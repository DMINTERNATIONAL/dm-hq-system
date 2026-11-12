/* ═══ 운영 비용 기록 (2026-11-12, 네이버웍스 → 앱 전환) ═══
   한 달에 얼마 나오는지 경영팀 'AI · 운영 비용' 화면에서 계속 본다.

   어디서 가져오나
   ① 구글(Firebase) 실제 청구액 — 구글 예산(월 70,000원)이 하루 여러 번 Pub/Sub 로 '이번 달 지금까지 금액'을 밀어 준다.
      → POST /hook/gcp-budget?k=키  (키는 잠긴 /authSecrets/__cost/hookKey, 경영팀 화면에서 연결 주소로 보여 준다)
      금액은 크레딧을 뺀 뒤 값이라 무료 체험 크레딧 기간에는 0 에 가깝다 → ② 사용량으로 '크레딧 빼기 전' 금액을 따로 계산한다.
   ② Firebase 사용량 — 매일 새벽 Cloud Monitoring 에서 다운로드 바이트 · 동시 접속 · 저장 용량을 읽는다.
      (서비스 계정에 '모니터링 뷰어' 권한이 있어야 한다. 없으면 err 에 남기고 화면에 안내)
   ③ Cloudflare 사용량 — 매일 새벽 GraphQL Analytics 로 Workers 요청 · CPU · R2 용량 · 요청 수. 비밀 CF_API_TOKEN(Account Analytics 읽기)
   ④ AI — 이미 /authSecrets/__ai/sum 에 쌓이는 것을 같이 보여 준다.

   저장 (잠긴 경로 — staff 토큰으로는 못 읽음)
     /authSecrets/__cost/gcp/{YYYY-MM}        { cost, budget, cur, at, start, name, thr }  예산 알림 최신값
     /authSecrets/__cost/gcpDay/{YYYY-MM}/{DD} 그날 마지막으로 받은 이번 달 누적 금액
     /authSecrets/__cost/fb/{YYYY-MM-DD}      { dl 다운로드 바이트, conn 최대 동시 접속, st 저장 바이트 }
     /authSecrets/__cost/cf/{YYYY-MM-DD}      { req, cpu(ms), r2s 저장 바이트, r2n 개수, r2a A등급 요청, r2b B등급 요청 }
     /authSecrets/__cost/err                  { fb, cf, at }   마지막 수집 실패 이유
     /authSecrets/__cost/ran                  마지막 수집 날짜(KST)
   요금표는 아래 P (2026-11 공개 가격). 금액은 추정 — 정확한 청구는 각 콘솔이 기준. */

const BASE = '/authSecrets/__cost';
const P = {
  fbDlFreeGB: 10, fbDlUsd: 1, fbStFreeGB: 1, fbStUsd: 5,
  cfBase: 5, cfReqFree: 10e6, cfReqUsdM: 0.3, cfCpuFreeMs: 30e6, cfCpuUsdM: 0.02,
  r2FreeGB: 10, r2Usd: 0.015, r2AFree: 1e6, r2AUsdM: 4.5, r2BFree: 10e6, r2BUsdM: 0.36,
};
const GB = 1024 ** 3;
const kstDate = (t) => new Date((t || Date.now()) + 9 * 3600e3).toISOString().slice(0, 10);
const ymOf = (d) => d.slice(0, 7);
const r2 = (v) => Math.round(v * 100) / 100;
const hqUser = (u) => !!u && u.status !== '퇴사' && (u.systemGrade === '경영팀' || u.role === '경영팀' || u.role === '본사경영팀');
const OWNER_PHONES = ['01042885562', '01082470187'];

export function estimate(ym, fbDays, cfDays) {
  const fb = Object.entries(fbDays || {}).filter(([d]) => d.startsWith(ym)).map(([, v]) => v || {});
  const cf = Object.entries(cfDays || {}).filter(([d]) => d.startsWith(ym)).map(([, v]) => v || {});
  const dlGB = fb.reduce((s, v) => s + (+v.dl || 0), 0) / GB;
  const stGB = Math.max(0, ...fb.map((v) => +v.st || 0)) / GB;
  const conn = Math.max(0, ...fb.map((v) => +v.conn || 0));
  const fbUsd = Math.max(0, dlGB - P.fbDlFreeGB) * P.fbDlUsd + Math.max(0, stGB - P.fbStFreeGB) * P.fbStUsd;
  const req = cf.reduce((s, v) => s + (+v.req || 0), 0);
  const cpu = cf.reduce((s, v) => s + (+v.cpu || 0), 0);
  const r2GB = Math.max(0, ...cf.map((v) => +v.r2s || 0)) / GB;
  const r2a = cf.reduce((s, v) => s + (+v.r2a || 0), 0), r2b = cf.reduce((s, v) => s + (+v.r2b || 0), 0);
  const r2Usd = Math.max(0, r2GB - P.r2FreeGB) * P.r2Usd + Math.max(0, r2a - P.r2AFree) / 1e6 * P.r2AUsdM + Math.max(0, r2b - P.r2BFree) / 1e6 * P.r2BUsdM;
  const cfUsd = P.cfBase + Math.max(0, req - P.cfReqFree) / 1e6 * P.cfReqUsdM + Math.max(0, cpu - P.cfCpuFreeMs) / 1e6 * P.cfCpuUsdM + r2Usd;
  return {
    fb: { days: fb.length, dlGB: r2(dlGB), stGB: Math.round(stGB * 1000) / 1000, conn, usd: r2(fbUsd) },
    cf: { days: cf.length, req, cpu: Math.round(cpu), r2GB: r2(r2GB), r2a, r2b, usd: r2(cfUsd), r2Usd: r2(r2Usd) },
  };
}

export function makeOpCost(deps) {
  const { dbGet, dbPut, dbPatch, pushToPhones, gToken } = deps;

  async function isHq(env, me) {
    if (me && (me.role === 'owner' || me.admin === true)) return true;
    if (me && OWNER_PHONES.includes(String(me.ph))) return true;
    const u = await dbGet(env, '/users/' + encodeURIComponent(String(me.ph))).catch(() => null);
    return hqUser(u);
  }

  /* ① 구글 예산 알림(Pub/Sub push) 받기 — 늘 204 로 답한다(아니면 구글이 계속 다시 보낸다) */
  async function hook(request, env, url) {
    const key = await dbGet(env, BASE + '/hookKey').catch(() => null);
    const k = url.searchParams.get('k') || '';
    if (!key || k.length !== String(key).length || k !== String(key)) return new Response(null, { status: 204 });
    const body = await request.json().catch(() => null);
    let d = null;
    try { d = JSON.parse(atob(body && body.message && body.message.data || '')); } catch (_) { d = null; }
    if (!d || typeof d.costAmount !== 'number') return new Response(null, { status: 204 });
    /* 기간 시작은 UTC 로 온다(한국 결제면 전날 15:00Z) — 한국 시간으로 바꿔 달을 정한다 */
    const st = Date.parse(d.costIntervalStart || '');
    const ym = ymOf(kstDate(isNaN(st) ? Date.now() : st + 3600e3));
    if (!/^\d{4}-\d{2}$/.test(ym)) return new Response(null, { status: 204 });
    const prev = (await dbGet(env, `${BASE}/gcp/${ym}`).catch(() => null)) || {};
    const rec = { cost: +d.costAmount || 0, budget: +d.budgetAmount || 0, cur: String(d.currencyCode || '').slice(0, 5), at: Date.now(), start: String(d.costIntervalStart || '').slice(0, 30), name: String(d.budgetDisplayName || '').slice(0, 60), thr: Math.max(+prev.thr || 0, +d.alertThresholdExceeded || 0) };
    await dbPatch(env, '/', { [`${BASE.slice(1)}/gcp/${ym}`]: rec, [`${BASE.slice(1)}/gcpDay/${ym}/${kstDate().slice(8)}`]: rec.cost });
    /* 예산 50 · 90 · 100% 를 새로 넘었으면 경영팀 폰으로 한 번 */
    if ((+d.alertThresholdExceeded || 0) > (+prev.thr || 0)) {
      const users = (await dbGet(env, '/users').catch(() => null)) || {};
      const to = Object.keys(users).filter((ph) => hqUser(users[ph]) || OWNER_PHONES.includes(ph));
      const won = (v) => Math.round(v).toLocaleString('ko-KR') + (rec.cur === 'KRW' ? '원' : ' ' + rec.cur);
      if (to.length) await pushToPhones(env, to, { title: `구글(Firebase) 비용이 예산의 ${Math.round(d.alertThresholdExceeded * 100)}%를 넘었어요`, body: `이번 달 지금까지 ${won(rec.cost)} / 예산 ${won(rec.budget)} — AI · 운영 비용 화면에서 볼 수 있어요`, url: './#ai-usage', tag: 'gcp-budget-' + ym }).catch(() => {});
    }
    return new Response(null, { status: 204 });
  }

  /* ② Firebase 사용량 — Cloud Monitoring (하루 단위 합계 · 최대) */
  async function pullFirebase(env, from, to) {
    const sa = JSON.parse(env.FIREBASE_SA);
    const proj = sa.project_id;
    const t = await gToken(env, 'https://www.googleapis.com/auth/monitoring.read');
    const q = async (metric, aligner, reducer) => {
      const p = new URLSearchParams({
        filter: `metric.type="firebasedatabase.googleapis.com/${metric}"`,
        'interval.startTime': from + 'T00:00:00+09:00', 'interval.endTime': to,
        'aggregation.alignmentPeriod': '86400s', 'aggregation.perSeriesAligner': aligner, 'aggregation.crossSeriesReducer': reducer,
      });
      const r = await fetch(`https://monitoring.googleapis.com/v3/projects/${proj}/timeSeries?${p}`, { headers: { Authorization: 'Bearer ' + t } });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error((j.error && j.error.message) || ('모니터링 ' + r.status));
      const out = {};
      for (const s of j.timeSeries || []) for (const pt of s.points || []) {
        const d = kstDate(Date.parse(pt.interval.endTime) - 1000);
        const v = +(pt.value.int64Value ?? pt.value.doubleValue ?? 0);
        out[d] = aligner === 'ALIGN_SUM' ? (out[d] || 0) + v : Math.max(out[d] || 0, v);
      }
      return out;
    };
    const [dl, conn, st] = await Promise.all([
      q('network/sent_bytes_count', 'ALIGN_SUM', 'REDUCE_SUM'),
      q('network/active_connections', 'ALIGN_MAX', 'REDUCE_SUM'),
      q('storage/total_bytes', 'ALIGN_MAX', 'REDUCE_SUM'),
    ]);
    const days = {};
    for (const d of new Set([...Object.keys(dl), ...Object.keys(conn), ...Object.keys(st)])) days[d] = { dl: Math.round(dl[d] || 0), conn: Math.round(conn[d] || 0), st: Math.round(st[d] || 0) };
    return days;
  }

  /* ③ Cloudflare 사용량 — GraphQL Analytics */
  async function pullCloudflare(env, from, to) {
    if (!env.CF_API_TOKEN) throw new Error('CF_API_TOKEN 이 아직 없어요');
    const acct = env.CF_ACCOUNT_ID || '7a9ee76cb16dea27b9f46967c58e219d';
    const run = async (cpuField) => {
      const query = `query($a:String!,$s:Date!,$e:Date!){viewer{accounts(filter:{accountTag:$a}){
        w:workersInvocationsAdaptive(limit:10000,filter:{date_geq:$s,date_leq:$e}){sum{requests${cpuField ? ' cpuTimeUs' : ''}} dimensions{date}}
        s:r2StorageAdaptiveGroups(limit:1000,filter:{date_geq:$s,date_leq:$e}){max{payloadSize metadataSize objectCount} dimensions{date bucketName}}
        o:r2OperationsAdaptiveGroups(limit:10000,filter:{date_geq:$s,date_leq:$e}){sum{requests} dimensions{date actionType}}}}}`;
      const r = await fetch('https://api.cloudflare.com/client/v4/graphql', { method: 'POST', headers: { Authorization: 'Bearer ' + env.CF_API_TOKEN, 'Content-Type': 'application/json' }, body: JSON.stringify({ query, variables: { a: acct, s: from, e: to } }) });
      const j = await r.json().catch(() => ({}));
      if (j.errors && j.errors.length) throw new Error(String(j.errors[0].message || 'GraphQL 오류').slice(0, 200));
      if (!r.ok) throw new Error('Cloudflare ' + r.status);
      return j.data.viewer.accounts[0] || {};
    };
    let a, hasCpu = true;
    try { a = await run(true); } catch (e) { if (!/cpuTime/i.test(e.message)) throw e; hasCpu = false; a = await run(false); }
    const days = {};
    const D = (d) => (days[d] = days[d] || { req: 0, cpu: 0, r2s: 0, r2n: 0, r2a: 0, r2b: 0 });
    for (const x of a.w || []) { const o = D(x.dimensions.date); o.req += +x.sum.requests || 0; if (hasCpu) o.cpu += (+x.sum.cpuTimeUs || 0) / 1000; }
    const perBucket = {};
    for (const x of a.s || []) { const k = x.dimensions.date; (perBucket[k] = perBucket[k] || {})[x.dimensions.bucketName] = x.max; }
    for (const [d, bs] of Object.entries(perBucket)) { const o = D(d); for (const m of Object.values(bs)) { o.r2s += (+m.payloadSize || 0) + (+m.metadataSize || 0); o.r2n += +m.objectCount || 0; } }
    const A = /^(Put|Copy|List|CreateMultipart|UploadPart|CompleteMultipart|PutBucket|LifecycleStorageTierTransition)/;
    const B = /^(Get|Head|UsageSummary)/;
    for (const x of a.o || []) { const o = D(x.dimensions.date); const t = String(x.dimensions.actionType || ''); if (A.test(t)) o.r2a += +x.sum.requests || 0; else if (B.test(t)) o.r2b += +x.sum.requests || 0; }
    for (const o of Object.values(days)) o.cpu = Math.round(o.cpu);
    return days;
  }

  /* 수집 — 최근 3일을 다시 읽어 덮어쓴다(늦게 들어온 숫자 반영). 둘 중 하나가 실패해도 나머지는 남긴다 */
  async function collect(env) {
    const today = kstDate();
    const from = kstDate(Date.now() - 3 * 86400e3);
    const to = new Date().toISOString();
    const up = {}, err = { at: Date.now() };
    try { const d = await pullFirebase(env, from, to); for (const [k, v] of Object.entries(d)) up[`${BASE.slice(1)}/fb/${k}`] = v; err.fb = null; } catch (e) { err.fb = String(e.message || e).slice(0, 300); }
    try { const d = await pullCloudflare(env, from, today); for (const [k, v] of Object.entries(d)) up[`${BASE.slice(1)}/cf/${k}`] = v; err.cf = null; } catch (e) { err.cf = String(e.message || e).slice(0, 300); }
    up[`${BASE.slice(1)}/err`] = err;
    up[`${BASE.slice(1)}/ran`] = today;
    await dbPatch(env, '/', up);
    return err;
  }

  /* 1분 타이머에서 — 매일 새벽 4시 40분(한국) 이후 하루 한 번 */
  async function tick(env) {
    const k = new Date(Date.now() + 9 * 3600e3);
    if (k.getUTCHours() * 60 + k.getUTCMinutes() < 4 * 60 + 40) return null;
    const ran = await dbGet(env, BASE + '/ran').catch(() => null);
    if (ran === kstDate()) return null;
    await dbPut(env, BASE + '/ran', kstDate());
    return collect(env);
  }

  const route = async function route(path, request, env, ctx, me, json, origin, url) {
    if (!path.startsWith('/ops/cost')) return null;
    if (request.method !== 'POST') return json({ ok: false, error: 'POST 만 됩니다' }, 405, origin);
    if (!(await isHq(env, me))) return json({ ok: false, error: '경영팀만 볼 수 있어요' }, 403, origin);
    const b = await request.json().catch(() => ({}));

    if (path === '/ops/cost/month') {
      const ym = /^\d{4}-\d{2}$/.test(String(b.ym || '')) ? String(b.ym) : ymOf(kstDate());
      const [gcp, gcpDay, fb, cf, err, ai, aiCfg, key, ran] = await Promise.all([
        dbGet(env, `${BASE}/gcp/${ym}`), dbGet(env, `${BASE}/gcpDay/${ym}`),
        dbGet(env, `${BASE}/fb`), dbGet(env, `${BASE}/cf`), dbGet(env, `${BASE}/err`),
        dbGet(env, `/authSecrets/__ai/sum/${ym}`), dbGet(env, '/authSecrets/__ai/cfg'), dbGet(env, `${BASE}/hookKey`), dbGet(env, `${BASE}/ran`),
      ].map((p) => p.catch(() => null)));
      const pick = (o) => Object.fromEntries(Object.entries(o || {}).filter(([d]) => d.startsWith(ym)));
      return json({ ok: true, ym, gcp, gcpDay: gcpDay || {}, fb: pick(fb), cf: pick(cf), est: estimate(ym, fb, cf), ai: ai || null, krw: aiCfg && +aiCfg.krw > 0 ? +aiCfg.krw : 1400, err: err || null, hook: !!key, ran: ran || null, hasCf: !!env.CF_API_TOKEN, price: P, now: Date.now() }, 200, origin);
    }
    /* 지금 다시 가져오기 */
    if (path === '/ops/cost/refresh') {
      const err = await collect(env);
      return json({ ok: true, err }, 200, origin);
    }
    /* 구글 예산 → Pub/Sub 연결 주소 (처음이면 키를 만든다) */
    if (path === '/ops/cost/hook') {
      let key = await dbGet(env, BASE + '/hookKey').catch(() => null);
      if (!key || b.reset) {
        const a = new Uint8Array(24); crypto.getRandomValues(a);
        key = Array.from(a, (x) => x.toString(16).padStart(2, '0')).join('');
        await dbPut(env, BASE + '/hookKey', key);
      }
      return json({ ok: true, url: `${url.origin}/hook/gcp-budget?k=${key}` }, 200, origin);
    }
    return json({ ok: false, error: '없는 기능입니다' }, 404, origin);
  };
  route.hook = hook;
  route.tick = tick;
  route.collect = collect;
  return route;
}
