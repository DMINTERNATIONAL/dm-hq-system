/**
 * 경영팀 대시보드 숫자 — 서버가 계산해 /dash/hq 에 둔다 (2026-11-13, '경영팀 대시보드도 서버 계산으로').
 *
 * 왜: 경영팀 홈 · 알림 숫자가 열 때마다 발주 전체(/orders 약 430KB) · 식대 전체(/meal 약 370KB)를
 *     미국 데이터베이스에서 받아 앱이 직접 셌다(첫 화면 1~2초 + 데이터 비용). 이제 앱은 이 결과(몇 KB)만 읽는다.
 * 언제 다시 계산하나: 발주 · 식대가 바뀌면 앱이 /dash/dirty/{o|m} 에 시각을 남기고(index.html fbReq),
 *     1분마다 도는 서버가 그걸 보고 바뀐 쪽만 다시 계산한다. 그 밖에 날짜가 바뀌었을 때 · 30분마다 한 번(안전장치).
 *     1분마다 통째로 다시 읽으면 하루 1GB 넘게 읽어 데이터 비용이 커서 이렇게 했다.
 * 계산 규칙은 앱(index.html loadHQDashStats · loadHQAlerts · isOrderDelayed)과 똑같아야 한다 — 바꾸면 두 곳 같이.
 *   날짜는 한국 시간. 앱은 결과가 없거나 오늘 것이 아니거나 40분 넘게 오래됐으면 예전처럼 직접 센다.
 */
const KST = 9 * 3600e3;
export const kstToday = (t = Date.now()) => new Date(t + KST).toISOString().slice(0, 10);
const prevYm = (ym) => { let [y, m] = ym.split('-').map(Number); m -= 1; if (m < 1) { m = 12; y -= 1; } return y + '-' + String(m).padStart(2, '0'); };

/* 앱 orderPendingETAs · isOrderDelayed 그대로 */
function orderPendingETAs(o) {
  if (!o) return [];
  const delivered = o.deliveredSups || {}; const arr = [];
  if (o.deliveryDates) Object.keys(o.deliveryDates).forEach((s) => { if (delivered[s]) return; const d = o.deliveryDates[s]; if (d) arr.push(d); });
  if (!arr.length) { const eta = o.expectedDeliveryDate || o.deliveryDate || ''; if (eta) arr.push(eta); }
  return arr;
}
export function isOrderDelayed(o, todayStr) {
  if (!o) return false;
  if (o.status !== '확정' && o.status !== '확인' && o.status !== '배송중') return false;
  if (o.itemDelay && Object.keys(o.itemDelay).length > 0) return true;
  const arr = orderPendingETAs(o); if (!arr.length) return false;
  arr.sort(); return arr[0] < todayStr;
}

/* 앱 loadHQDashStats 의 발주 집계 그대로(이번 달 · 지난달 · 대기 · 환불요청 · 달별 · 지점별 · 최근 6건) + 지연 건수 */
export function ordersDigest(d, today) {
  const thisMonth = today.slice(0, 7), lastMonth = prevYm(thisMonth);
  const stats = { total: 0, lastTotal: 0, pending: 0, done: 0, lastDone: 0, refund: 0 };
  const mc = {}, mdc = {}, br = {}, all = []; let delay = 0;
  for (const brand of Object.keys(d || {})) for (const branch of Object.keys(d[brand] || {})) {
    const key = brand + ' · ' + branch; br[key] = br[key] || 0;
    for (const id of Object.keys(d[brand][branch] || {})) {
      const o = d[brand][branch][id]; if (!o) continue;
      all.push({ _id: id, _brand: brand, _branch: branch, date: o.date || '', time: o.time || '', status: o.status || '', phone: o.phone || '', orderedBy: o.orderedBy || '', itemCount: o.itemCount || 0 });
      const ym = (o.date || '').slice(0, 7), isCancel = o.status === '거절';
      if (ym && !isCancel) { mc[ym] = (mc[ym] || 0) + 1; if (o.status === '배송완료') mdc[ym] = (mdc[ym] || 0) + 1; }
      if (ym === thisMonth && !isCancel) { stats.total++; br[key]++; if (o.status === '배송완료') stats.done++; }
      if (ym === lastMonth && !isCancel) { stats.lastTotal++; if (o.status === '배송완료') stats.lastDone++; }
      if (o.status === '대기') stats.pending++; else if (o.status === '환불요청') stats.refund++;
      if (isOrderDelayed(o, today)) delay++;
    }
  }
  /* 달별은 최근 12달만(앱 그래프는 9달) */
  let ym = thisMonth; const keep = {}; for (let i = 0; i < 12; i++) { keep[ym] = 1; ym = prevYm(ym); }
  for (const k of Object.keys(mc)) if (!keep[k]) delete mc[k];
  for (const k of Object.keys(mdc)) if (!keep[k]) delete mdc[k];
  all.sort((a, b) => (b.date + b.time).localeCompare(a.date + a.time));
  return { thisMonth, lastMonth, stats, mc, mdc, br, recent: all.slice(0, 6), delay };
}

/* 앱 loadHQAlerts 의 식대 미입력(이번 달, status 가 pending 이거나 없음) · refreshNotif 의 식대 대기(모든 달 pending) 그대로 */
export function mealDigest(meals, today) {
  const ym = today.slice(0, 7); let miss = 0, pend = 0;
  for (const ph of Object.keys(meals || {})) {
    const ms = meals[ph]; if (!ms || typeof ms !== 'object') continue;
    for (const day of Object.keys(ms)) {
      const r = ms[day]; if (!r) continue;
      if (day.slice(0, 7) === ym && (r.status === 'pending' || !r.status)) miss++;
      if (r.status === 'pending') pend++;   // 앱 refreshNotif 식대 확인 대기 숫자(모든 달, status 'pending' 만)
    }
  }
  return { miss, pend };
}

/* 1분마다(cron) — 바뀐 쪽만 다시 계산. force 면 둘 다 */
export async function hqDashTick(env, { dbGet, dbPatch }, force) {
  const now = Date.now(), today = kstToday(now);
  const [cur, dirty] = await Promise.all([dbGet(env, '/dash/hq').catch(() => null), dbGet(env, '/dash/dirty').catch(() => null)]);
  const c = cur || {}, dt = dirty || {};
  const stale = (at, mark) => force || !at || c.today !== today || (mark && mark > at) || now - at > 30 * 60e3;
  const needO = stale(c.oAt, dt.o), needM = stale(c.mAt, dt.m);
  if (!needO && !needM) return null;
  const up = { v: 1, today, at: now };
  if (needO) { const d = await dbGet(env, '/orders').catch(() => null); up.o = ordersDigest(d || {}, today); up.oAt = now; }
  if (needM) { const m = await dbGet(env, '/meal').catch(() => null); up.m = mealDigest(m || {}, today); up.mAt = now; }
  await dbPatch(env, '/dash/hq', up);
  return { o: needO, m: needM };
}
