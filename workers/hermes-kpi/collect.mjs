// DM INTERNATIONAL — Hermes KPI 수집기 (Node / GitHub Actions)
//
// 핸드SOS는 Cloudflare Worker 발신요청을 522로 차단하므로(일반 IP는 정상),
// 매출 수집은 GitHub Actions(일반 egress IP)에서 Node로 실행한다.
// 파싱·급여/성과 분리 로직은 스펙 3장 그대로. RTDB 저장 스키마도 동일.
//
// 실행:  node collect.mjs [mode] [--date=YYYY-MM-DD] [--from= --to=] [--dry]
//   mode = both(기본) | sales | sns | shops
// 필수 env(시크릿): HANDSOS_COMPANY, HANDSOS_ID, HANDSOS_PW, IG_TOKEN (IG_USER_ID는 토큰에서 자동조회, 선택)
// 선택 env: FIREBASE_URL, HANDSOS_LOGIN_HOST, HANDSOS_HOST
//
// Node 20+ (global fetch, Headers.getSetCookie). codepage로 cp949 디코딩.

import * as cptableMod from 'codepage';
const cptable = cptableMod.default || cptableMod;

/* ═══ 설정 ═══ */
const CONFIG = {
  // 본사HQ 계정(데이민 사무실-본사HQ)은 전 지점 접근 가능. code=지점선택 드롭다운(select[name=PkCompany]) 값.
  // 지점별로 PkCompany를 지정해 리포트 B를 각각 조회한다. (사무실 12550652는 디자이너 없어 제외)
  shops: [
    { shop: 'flagship', code: '12550648', name: '데이민 플래그십' }, // branch '플래그십점'
    { shop: 'moment', code: '12550630', name: '데이민 모먼트' },     // branch '모먼트점'
    { shop: 'eto', code: '12558317', name: '에토바버샵' },           // branch '합정점'
  ],
  // 공식 인스타 계정 (브랜드별 1개). business_discovery로 디자이너와 동일 수집.
  officialAccounts: [
    { key: 'daymean', brand: 'DAY:MEAN', shops: ['flagship', 'moment'], username: 'day.mean_official', label: '데이민 공식' },
    { key: 'etoh', brand: 'ETOH', shops: ['eto'], username: 'etohbarber', label: '에토바버샵 공식' },
  ],
  saleValidateTolerance: 0.05,
  igRateGapMs: 400,
  igMaturedDays: 7,
  igMaturedMax: 10,
};
const PARSER_VERSION = '1.0.0';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';
const FB_DEFAULT = 'https://dm-orders-4792a-default-rtdb.firebaseio.com';
const IG_API = 'https://graph.facebook.com/v21.0';

const loginHost = () => process.env.HANDSOS_LOGIN_HOST || 'https://www.handsos.com';
const reportHost = () => process.env.HANDSOS_HOST || 'https://www1.handsos.com';
const fbUrl = () => process.env.FIREBASE_URL || FB_DEFAULT;
// 매출 재수집 나이(일): 수정·환불 반영 위해 어제(1)+2일+7일+30일 뒤 재조회. env로 재정의 가능(콤마).
const refreshOffsets = () => (process.env.HANDSOS_REFRESH_OFFSETS || '1,2,7,30').split(',').map(s => parseInt(s.trim(), 10)).filter(n => Number.isFinite(n) && n >= 0);

/* ═══ 엔트리 ═══ */
async function main() {
  const args = process.argv.slice(2);
  const mode = args.find(a => !a.startsWith('--')) || 'both';
  const opt = Object.fromEntries(args.filter(a => a.startsWith('--')).map(a => {
    const [k, v] = a.replace(/^--/, '').split('='); return [k, v ?? true];
  }));
  const dry = !!opt.dry;

  if (mode === 'shops') {
    console.log(JSON.stringify(await discoverShops(), null, 2));
    return;
  }
  if (mode === 'ig') { // IG 연결 단독 테스트: 토큰만 있으면 IG_USER_ID 자동발견 후 business_discovery 조회
    if (!process.env.IG_TOKEN) throw new Error('IG_TOKEN 미설정 (IG_TOKEN=... 붙여서 실행)');
    // IG_USER_ID 자동발견 (me/accounts → 페이지의 instagram_business_account.id)
    if (!process.env.IG_USER_ID || opt.whoami) {
      const url = `${IG_API}/me/accounts?fields=name,instagram_business_account{id,username,followers_count}&access_token=${encodeURIComponent(process.env.IG_TOKEN)}`;
      const data = await (await fetch(url, { headers: { 'User-Agent': UA } })).json();
      if (data.error) throw new Error('토큰으로 페이지 조회 실패: ' + data.error.message);
      const pages = (data.data || []).filter(p => p.instagram_business_account);
      console.log('[발견된 IG 비즈니스 계정]');
      pages.forEach(p => console.log(`  · ${p.name} → @${p.instagram_business_account.username} (id=${p.instagram_business_account.id}, 팔로워 ${p.instagram_business_account.followers_count})`));
      if (opt.whoami) return;
      if (!pages.length) throw new Error('연결된 IG 비즈니스 계정을 못 찾음 (페이지-IG 연결/권한 확인)');
      process.env.IG_USER_ID = pages[0].instagram_business_account.id;
      console.log(`[자동선택] IG_USER_ID=${process.env.IG_USER_ID} (@${pages[0].instagram_business_account.username})\n`);
    }
    const users = (opt.user ? [opt.user] : ['day.mean_min', 'day.mean_dawn', 'etohbarber']).map(u => String(u).replace(/^@/, '').trim());
    const out = [];
    for (const u of users) {
      try {
        const bd = await igBusinessDiscovery(u);
        const m = computeSnsMetrics(bd, kstDateString(0));
        out.push({ user: u, ok: true, followers: m.followers, media_count: m.media_count, uploads_7d: m.uploads_7d, avg_likes: m.avg_likes, avg_comments: m.avg_comments, engagement_rate: m.engagement_rate, sample_size: m.sample_size });
      } catch (e) { out.push({ user: u, ok: false, error: e.message }); }
      await sleep(CONFIG.igRateGapMs);
    }
    console.log(JSON.stringify({ ig_user_id: process.env.IG_USER_ID, results: out }, null, 2));
    return;
  }
  if (mode === 'dump') { // 전점 담당자별 리포트 원본 구조 확인 (지점/디자이너 컬럼 파악용)
    const session = await handsosLogin();
    const d = opt.date || kstDateString(-1);
    const code = opt.code || '12550630';
    const html = await fetchReport(session, 'B', code, d);
    const tables = gridTables(html).sort((a, b) => b.length - a.length);
    const big = tables[0] || [];
    console.log(JSON.stringify({ date: d, code, tableCount: tables.length, rows: big.length, header: big[0], sample: big.slice(1, 24) }, null, 2));
    return;
  }
  if (mode === 'home') { // 로그인 후 실제 대시보드를 긁어 매장전환 컨트롤/지점코드 발굴
    console.log(JSON.stringify(await discoverBranchSwitcher(), null, 2));
    return;
  }
  if (mode === 'page') { // 임의 페이지 덤프: 지점 코드/셀렉트/테이블 추출. --path=/work/detail/company/company_main.asp
    const session = await handsosLogin();
    const path = opt.path || '/work/detail/company/company_main.asp';
    const r = await fetch(reportHost() + path, { headers: { 'Cookie': session.cookie, 'User-Agent': UA } });
    const html = decodeEucKr(await r.arrayBuffer());
    const selects = [...html.matchAll(/<select\b([^>]*)>([\s\S]*?)<\/select>/gi)].map(sm => {
      const name = (/name\s*=\s*["']?([^"'\s>]+)/i.exec(sm[1]) || [])[1] || '(noname)';
      const options = [...sm[2].matchAll(/<option\b[^>]*value\s*=\s*["']?([^"'>]*)["']?[^>]*>([\s\S]*?)<\/option>/gi)].map(m => ({ code: m[1].trim(), name: cleanCell(m[2]) }));
      return { name, options };
    });
    const codePairs = [...html.matchAll(/(\d{7,9})[^>]{0,60}?(데이민[^<>"']{0,12}|에토[^<>"']{0,10}|[가-힣]{2,10}(?:점|바버샵|사무실))/g)].map(m => ({ code: m[1], near: cleanCell(m[2]) }));
    const codePairs2 = [...html.matchAll(/(데이민[^<>"']{0,12}|에토[^<>"']{0,10}|[가-힣]{2,10}(?:점|바버샵|사무실))[^<]{0,60}?(\d{7,9})/g)].map(m => ({ near: cleanCell(m[1]), code: m[2] }));
    const tables = gridTables(html).filter(t => t.length <= 60).slice(0, 6);
    console.log(JSON.stringify({ path, status: r.status, hasTable: /<table/i.test(html), selects, codePairs, codePairs2, tables }, null, 2));
    return;
  }
  if (opt.from && opt.to) {
    for (const d of dateRange(opt.from, opt.to)) {
      console.log(`[backfill] ${d}`);
      console.log(JSON.stringify(await collectSales(d, dry), null, 2));
    }
    return;
  }
  const errors = [];
  if (mode === 'sales' || mode === 'both') {
    // 매출은 사후 수정·환불 반영을 위해 여러 나이(D-1,D-2,D-7,D-30)로 재수집(멱등 덮어쓰기).
    // --date 지정 시엔 그 한 날짜만.
    const dates = opt.date ? [opt.date] : refreshOffsets().map(n => kstDateString(-n));
    for (const date of dates) {
      try { console.log('[sales]', date, JSON.stringify(await collectSales(date, dry))); }
      catch (e) { errors.push('sales ' + date + ': ' + e.message); await notify('[Hermes] 매출 수집 실패 ' + date + ': ' + e.message); }
    }
  }
  if (mode === 'sns' || mode === 'both') {
    try { console.log('[sns]', JSON.stringify(await collectSns(kstDateString(0), dry))); }
    catch (e) { errors.push('sns: ' + e.message); await notify('[Hermes] SNS 수집 실패: ' + e.message); }
    try { console.log('[official]', JSON.stringify(await collectOfficialSns(kstDateString(0), dry))); }
    catch (e) { errors.push('official: ' + e.message); await notify('[Hermes] 공식SNS 수집 실패: ' + e.message); }
  }
  if (errors.length) { console.error('FAILED:', errors.join(' | ')); process.exit(1); }
}

/* ═══ 매출 수집 ═══ */
// 본사HQ 계정으로 지점별 PkCompany(code)를 지정해 리포트 B를 각각 조회한다.
// (Report A는 <table> 미제공이라 매장집계는 Report B에서 storeFromDesigners()로 도출.)
async function collectSales(date, dry) {
  const session = await handsosLogin();
  const branchMap = await buildBranchMap();   // 검증용: 닉/실명 → shop
  const perShop = [];
  for (const shop of CONFIG.shops) {
    if (!shop.code) { perShop.push({ shop: shop.shop, ok: false, error: 'PkCompany 코드 미설정' }); continue; }
    try { perShop.push(await collectShopSales(session, shop, date, dry, branchMap)); }
    catch (e) {
      if (e && e.emptyReport) { console.log(`[skip] ${shop.shop} ${date}: 무매출/휴무`); perShop.push({ shop: shop.shop, ok: true, closed: true, designers: 0 }); continue; }
      await notify(`[Hermes] ${shop.name}(${date}) 매출 실패: ${e.message}`); perShop.push({ shop: shop.shop, ok: false, error: e.message });
    }
  }
  return { date, shops: perShop };
}

async function collectShopSales(session, shop, date, dry, branchMap) {
  const reportB = parseReportB(await fetchReport(session, 'B', shop.code, date));
  const store = storeFromDesigners(reportB.designers);
  // 검증: 반환된 디자이너가 실제 이 지점 소속인지(닉/실명→shop) 확인 — 코드 오지정/stale 감지 (non-blocking)
  const mismatched = [];
  for (const d of reportB.designers) { const r = resolveShop(d.name, branchMap); if (r.matched && r.shop !== shop.shop) mismatched.push(`${d.name}→${r.shop}`); }
  if (mismatched.length) await notify(`[Hermes] ${shop.name}(${date}) 지점 불일치 ${mismatched.length}명: ${mismatched.join(', ')} — code/branch 확인`);
  const validation = { source: 'reportB(derived)', code: shop.code, designers: reportB.designers.length, branch_mismatch: mismatched };
  const meta = { collected_at: nowIso(), source: 'handsos', parser_version: PARSER_VERSION, validation };

  if (dry) return { shop: shop.shop, ok: true, dry: true, code: shop.code, designers: reportB.designers.length, net_sales: store.net_sales, names: reportB.designers.map(d => d.name), branch_mismatch: mismatched };

  const base = `/stores/${enc(shop.shop)}/daily/${enc(date)}`;
  // 재수집 시 이전 실매출과 비교 → 바뀌면 수정 이력(revisions) 기록 (환불·정정 반영 추적)
  const prevStore = await fbGET(`${base}/store.json`);
  const prevMeta = await fbGET(`${base}/meta.json`);
  meta.first_collected_at = (prevMeta && prevMeta.first_collected_at) || meta.collected_at;
  let revised = false;
  if (prevStore && (+prevStore.net_sales || 0) !== store.net_sales) {
    const rev = { at: meta.collected_at, prev_net: +prevStore.net_sales || 0, net: store.net_sales };
    meta.revisions = ((prevMeta && prevMeta.revisions) || []).concat(rev).slice(-10);
    meta.revised_at = rev.at; revised = true;
  } else if (prevMeta && prevMeta.revisions) {
    meta.revisions = prevMeta.revisions; if (prevMeta.revised_at) meta.revised_at = prevMeta.revised_at;
  }
  await rtdbPut(`${base}/store`, store);
  await rtdbPut(`${base}/meta`, meta);
  for (const d of reportB.designers) await rtdbPut(`${base}/designers/${enc(safeKey(d.name))}`, stripName(d));
  return { shop: shop.shop, ok: true, designers: reportB.designers.length, net_sales: store.net_sales, branch_mismatch: mismatched, revised };
}

// users.json → 지점 매핑 룩업(검증용). 핸드SOS 직원명=닉네임 → nick 우선, 실명 폴백. 전 직원(퇴사 포함).
async function buildBranchMap() {
  const users = await fbGET('/users.json') || {};
  const map = new Map();
  const rows = Object.values(users).map(u => u || {});
  for (const u of rows) { const shop = BRANCH_TO_SHOP[u.branch]; if (shop && u.nick) map.set(normName(u.nick), shop); }      // nick 우선
  for (const u of rows) { const shop = BRANCH_TO_SHOP[u.branch]; if (shop && u.name) { const k = normName(u.name); if (!map.has(k)) map.set(k, shop); } }
  return map;
}
function normName(s) { return String(s || '').replace(/^@/, '').replace(/\s+/g, '').trim(); }
function resolveShop(reportName, map) {
  const shop = map.get(normName(reportName));
  return shop ? { shop, matched: true } : { shop: 'flagship', matched: false };
}

/* ═══ 핸드SOS 로그인 (www) ═══ */
async function handsosLogin() {
  if (!process.env.HANDSOS_COMPANY || !process.env.HANDSOS_ID || !process.env.HANDSOS_PW) throw new Error('HANDSOS_COMPANY/ID/PW 미설정');
  const H = loginHost();
  const jar = {};
  const r0 = await fetch(`${H}/Login/setCookieReset.asp?a=1`, { headers: { 'User-Agent': UA }, redirect: 'manual' }).catch(() => null);
  if (r0) mergeCookies(jar, getSetCookies(r0));

  const form = new URLSearchParams();
  form.set('companyID', process.env.HANDSOS_COMPANY);
  form.set('userID', process.env.HANDSOS_ID);
  form.set('userPWD', process.env.HANDSOS_PW);
  form.set('strOS', 'Windows'); form.set('strBrowser', 'Chrome');

  let resp = await fetch(`${H}/login/loginHide.asp`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': UA, 'Cookie': serializeCookies(jar), 'Referer': `${H}/login/login.asp?p=pc` },
    body: form.toString(), redirect: 'manual',
  });
  mergeCookies(jar, getSetCookies(resp));
  let loc = resp.headers.get('location');
  for (let i = 0; i < 2 && loc; i++) {
    const next = loc.startsWith('http') ? loc : new URL(loc, H).toString();
    resp = await fetch(next, { headers: { 'User-Agent': UA, 'Cookie': serializeCookies(jar) }, redirect: 'manual' });
    mergeCookies(jar, getSetCookies(resp));
    loc = resp.headers.get('location');
  }
  if (Object.keys(jar).length === 0) throw new Error('로그인 실패: 쿠키 없음 (자격증명/HANDSOS_LOGIN_HOST 확인)');
  return { cookie: serializeCookies(jar) };
}

async function discoverShops() {
  const session = await handsosLogin();
  // 지점 셀렉트가 어느 페이지/이름인지 몰라서 여러 페이지의 모든 <select>를 덤프해 후보를 고른다.
  const pages = ['/work/detail/saleStaffList.asp', '/work/detail/saleGubun.asp', '/work/main.asp', '/default.asp'];
  const all = [];
  for (const path of pages) {
    let html = '';
    try { html = decodeEucKr(await (await fetch(reportHost() + path, { headers: { 'Cookie': session.cookie, 'User-Agent': UA } })).arrayBuffer()); }
    catch (e) { continue; }
    const selRe = /<select\b([^>]*)>([\s\S]*?)<\/select>/gi; let sm;
    while ((sm = selRe.exec(html))) {
      const nameM = /name\s*=\s*["']?([^"'\s>]+)/i.exec(sm[1]);
      const name = nameM ? nameM[1] : '(noname)';
      const opts = []; const oRe = /<option\b[^>]*value\s*=\s*["']?([^"'>]*)["']?[^>]*>([\s\S]*?)<\/option>/gi; let m;
      while ((m = oRe.exec(sm[2]))) { const nm = cleanCell(m[2]); if (nm) opts.push({ code: m[1].trim(), name: nm }); }
      all.push({ page: path, name, count: opts.length, options: opts });
    }
  }
  // 지점 후보: 옵션명에 지점/브랜드 단어 또는 6자리+ 숫자코드 포함
  const branchCandidates = all.filter(s => s.options.some(o => /점|지점|데이민|플래그|모먼트|합정|에토/.test(o.name) || /^\d{6,}$/.test(o.code)));
  // 로그인 성공 시 리포트 페이지(default.asp 외)에서 셀렉트가 잡힘. default.asp만 나오면 미로그인.
  const authed = all.some(s => s.page !== '/default.asp');
  // 매장/사업장 전환 후보: default.asp의 shop_addr 등 옵션 많은 셀렉트 전체 덤프 (지점코드 발굴용)
  const switcherCandidates = all.filter(s => /shop_addr|Company|nGubun|shop/i.test(s.name) && s.count >= 2)
    .map(s => ({ page: s.page, name: s.name, count: s.count, options: s.options }));
  return { host: reportHost(), authed, selectNames: all.map(s => s.page + ':' + s.name + '(' + s.count + ')'), branchCandidates, switcherCandidates };
}

// 로그인 후 실제 화면에서 매장 전환 컨트롤/지점 코드 발굴 (지점 전환 방식 파악용)
async function discoverBranchSwitcher() {
  const session = await handsosLogin();
  const H = reportHost();
  const pages = ['/work/main.asp', '/work/index.asp', '/main.asp', '/index.asp', '/work/default.asp', '/work/detail/saleStaffList.asp'];
  const KW = /데이민|플래그|모먼트|에토|합정|지점|매장|전점|현점|shopChange|changeShop|setShop|fn_?[Ss]hop|selectShop|PkCompany|pkCompany/;
  const out = [];
  for (const path of pages) {
    let html = '', status = 0;
    try { const r = await fetch(H + path, { headers: { 'Cookie': session.cookie, 'User-Agent': UA } }); status = r.status; html = decodeEucKr(await r.arrayBuffer()); }
    catch (e) { out.push({ path, error: e.message }); continue; }
    const frames = [...html.matchAll(/<(?:i?frame)\b[^>]*\bsrc\s*=\s*["']?([^"'>\s]+)/gi)].map(m => m[1]);
    const links = [...html.matchAll(/<a\b[^>]*(?:href|onclick)\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi)]
      .map(m => ({ h: m[1], t: cleanCell(m[2]) })).filter(x => KW.test(x.h) || KW.test(x.t)).slice(0, 30);
    const onclicks = [...html.matchAll(/onclick\s*=\s*["']([^"']*(?:[Ss]hop|매장|지점|Company)[^"']*)["']/gi)].map(m => m[1]).slice(0, 30);
    const selects = [...html.matchAll(/<select\b([^>]*)>/gi)].map(m => (/name\s*=\s*["']?([^"'\s>]+)/i.exec(m[1]) || [])[1]).filter(Boolean);
    const pkVals = [...new Set([...html.matchAll(/[Pp]kCompany["'\s:=]+["']?(\d{5,})/g)].map(m => m[1]))];
    const kwText = [...html.matchAll(/>([^<>]{0,40}(?:데이민|플래그|모먼트|에토|합정|매장 ?전환|지점 ?변경)[^<>]{0,40})</g)].map(m => cleanCell(m[1])).filter(Boolean).slice(0, 20);
    const aspEndpoints = [...new Set([...html.matchAll(/["'(\/]([\w\/]*\w+\.asp)\b/gi)].map(m => m[1]))].filter(u => /shop|branch|company|store|지점|매장|list|select|com/i.test(u)).slice(0, 40);
    const scriptSrcs = [...html.matchAll(/<script\b[^>]*\bsrc\s*=\s*["']?([^"'>\s]+)/gi)].map(m => m[1]).slice(0, 40);
    // 지점 관련 JS 라인 (엔드포인트/코드 힌트)
    const jsHints = [...html.matchAll(/[^\n\r]{0,80}(?:지점|매장|shop|branch|PkCompany|pkCompany)[^\n\r]{0,80}/gi)].map(m => m[0].replace(/\s+/g, ' ').trim()).filter(s => /\.asp|PkCompany|function|url|ajax|option|value/i.test(s)).slice(0, 25);
    out.push({ path, status, hasTable: /<table/i.test(html), frames, links, onclicks, selects, pkCompanyValues: pkVals, aspEndpoints, scriptSrcs, kwText, jsHints });
  }
  return { host: H, pages: out };
}

/* ═══ 리포트 다운로드 ═══ */
function buildReportAParams(shopCode, date) {
  const w = ` and (  A.strSaleID in ( 'S','G','C','A','M','I','T','U' )  )  and A.strDate >= '${date}'  and A.strDate <= '${date}'`;
  return encodePairs([
    ['isExcel', '1'], ['strDateS', date], ['strDateE', date], ['PkCompany', shopCode],
    ['strPriceKind', 'REAL'], ['chk_all', 'Y'],
    ['strSaleID', 'S'], ['strSaleID', 'G'], ['strSaleID', 'C'], ['strSaleID', 'A'], ['strSaleID', 'M'], ['strSaleID', 'I'], ['strSaleID', 'T'], ['strSaleID', 'U'],
    ['where_SQL', w],
    ['strPopup', ''], ['page', ''], ['pkCustomer', ''], ['reportGB', ''], ['strCompanyNameTmp', ''], ['staffStatus', ''], ['pkStaff', ''],
  ]);
}
function buildReportBParams(shopCode, date) {
  const w = ` and (  A.strSaleID in ( 'S','G','C','A','M' )  )  and A.strDate >= '${date}'  and A.strDate <= '${date}'`;
  return encodePairs([
    ['strDateS', date], ['strDateE', date], ['PkCompany', shopCode], ['nSrhGroup', '1'], ['strPriceKind', 'REAL'], ['chk_all', 'Y'],
    ['strSaleID', 'S'], ['strSaleID', 'G'], ['strSaleID', 'C'], ['strSaleID', 'A'], ['strSaleID', 'M'],
    ['where_SQL', w], ['Const_nSaleSearchYn', '1'], ['Const_nSaleSearchDay', '0'],
    ['strSalePart', ''], ['pkMenuFst', ''], ['pkMenu', ''], ['pkGoodsSupply', ''], ['pkGoods', ''], ['nCashKind', ''],
    ['nCashPriceYn', ''], ['nCardPriceYn', ''], ['nBankPriceYn', ''], ['nAdvancePriceYn', ''], ['nMisuPriceYn', ''], ['nUsePointYn', ''],
    ['strSaleID_Detail', ''], ['strPopup', ''], ['page', ''], ['pkCustomer', ''], ['reportGB', ''], ['strCompanyNameTmp', ''], ['staffStatus', ''], ['pkStaff', ''],
  ]);
}
async function fetchReport(session, kind, shopCode, date, _retry) {
  const path = kind === 'A' ? '/work/detail/saleGubun.asp' : '/work/detail/saleStaffList_excel.asp';
  const headers = { 'Content-Type': 'application/x-www-form-urlencoded', 'Cookie': session.cookie, 'User-Agent': UA };
  if (kind === 'B') headers['Referer'] = `${reportHost()}/work/detail/saleStaffList.asp`;
  const body = kind === 'A' ? buildReportAParams(shopCode, date) : buildReportBParams(shopCode, date);
  const resp = await fetch(reportHost() + path, { method: 'POST', headers, body });
  const html = decodeEucKr(await resp.arrayBuffer());
  if (!/<table/i.test(html.slice(0, 4000))) {
    // 재로그인 후에도 table이 없으면 세션 문제가 아니라 그날 매출 자체가 없음(휴무/무매출)으로 판단.
    if (_retry) { const err = new Error(`빈 리포트(무매출/휴무 추정): ${kind} 응답에 <table> 없음`); err.emptyReport = true; throw err; }
    const fresh = await handsosLogin(); session.cookie = fresh.cookie;
    return fetchReport(session, kind, shopCode, date, true);
  }
  return html;
}

/* ═══ 파서 (스펙 3장) ═══ */
function decodeEucKr(buf) {
  const u8 = new Uint8Array(buf);
  try { return cptable.utils.decode(949, u8); }
  catch (e) { try { return new TextDecoder('euc-kr').decode(u8); } catch (_) { return new TextDecoder().decode(u8); } }
}
export function parseTables(html) {
  const tables = []; const tRe = /<table\b[^>]*>([\s\S]*?)<\/table>/gi; let tm;
  while ((tm = tRe.exec(html))) {
    const rows = []; const rRe = /<tr\b[^>]*>([\s\S]*?)<\/tr>/gi; let rm;
    while ((rm = rRe.exec(tm[1]))) {
      const cells = []; const cRe = /<t[dh]\b[^>]*>([\s\S]*?)<\/t[dh]>/gi; let cm;
      while ((cm = cRe.exec(rm[1]))) cells.push(cleanCell(cm[1]));
      if (cells.length) rows.push(cells);
    }
    if (rows.length) tables.push(rows);
  }
  return tables;
}
// rowspan/colspan을 펼쳐 모든 논리행이 전체 컬럼을 갖도록 재구성 (핸드SOS 리포트는 병합셀 사용)
export function parseGrid(tableHtml) {
  const trs = []; const rRe = /<tr\b[^>]*>([\s\S]*?)<\/tr>/gi; let rm;
  while ((rm = rRe.exec(tableHtml))) trs.push(rm[1]);
  const grid = []; const carry = {}; // colIndex -> {v, left}
  for (const tr of trs) {
    const cells = []; const cRe = /<t[dh]\b([^>]*)>([\s\S]*?)<\/t[dh]>/gi; let cm;
    while ((cm = cRe.exec(tr))) {
      const rs = /rowspan\s*=\s*["']?(\d+)/i.exec(cm[1]);
      const cs = /colspan\s*=\s*["']?(\d+)/i.exec(cm[1]);
      cells.push({ v: cleanCell(cm[2]), rs: rs ? +rs[1] : 1, cs: cs ? +cs[1] : 1 });
    }
    const carryCols = Object.keys(carry).filter(k => carry[k].left > 0).map(Number);
    if (!cells.length && !carryCols.length) continue;
    const maxCarry = carryCols.length ? Math.max(...carryCols) : -1;
    const row = []; let col = 0, i = 0;
    while (i < cells.length || col <= maxCarry) {
      if (carry[col] && carry[col].left > 0) { row[col] = carry[col].v; carry[col].left--; col++; continue; }
      if (i < cells.length) { const c = cells[i++]; for (let k = 0; k < c.cs; k++) { row[col] = c.v; if (c.rs > 1) carry[col] = { v: c.v, left: c.rs - 1 }; col++; } continue; }
      break;
    }
    grid.push(row);
  }
  return grid;
}
export function gridTables(html) {
  const tables = []; const tRe = /<table\b[^>]*>([\s\S]*?)<\/table>/gi; let tm;
  while ((tm = tRe.exec(html))) { const g = parseGrid(tm[1]); if (g.length) tables.push(g); }
  return tables;
}
export function cleanCell(s) {
  return s.replace(/<[^>]+>/g, '').replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&').replace(/&lt;/gi, '<').replace(/&gt;/gi, '>').replace(/\s+/g, ' ').trim();
}
export function num(s) {
  if (s == null) return 0;
  const t = String(s).replace(/[^0-9.\-]/g, '');
  if (t === '' || t === '-' || t === '.') return 0;
  const n = parseFloat(t); return Number.isFinite(n) ? Math.round(n) : 0;
}
export function parseReportA(html) {
  const tables = gridTables(html);
  let net_sales = 0, total_amount = 0, pay_count = 0; const menus = {};
  for (const rows of tables) {
    const header = (rows[0] || []).join(' ');
    if (/실매출/.test(header) && /건수/.test(header)) {
      const hi = colIndex(rows[0], ['합계']), ci = colIndex(rows[0], ['건수']), ni = colIndex(rows[0], ['실매출']);
      const dr = rows[1] || [];
      total_amount = num(dr[hi >= 0 ? hi : 0]); pay_count = num(dr[ci >= 0 ? ci : 1]); net_sales = num(dr[ni >= 0 ? ni : 2]);
    } else if (/구분/.test(header) && /총액/.test(header)) {
      const gi = colIndex(rows[0], ['구분']), ci = colIndex(rows[0], ['건수']), ti = colIndex(rows[0], ['총액']);
      for (let r = 1; r < rows.length; r++) {
        const g = rows[r][gi >= 0 ? gi : 0];
        if (/^(컷|펌|염색|크리닉)/.test(g)) menus[canonMenu(g)] = { amount: num(rows[r][ti >= 0 ? ti : 2]), count: num(rows[r][ci >= 0 ? ci : 1]) };
      }
    }
  }
  const service_amount = Object.values(menus).reduce((s, m) => s + m.amount, 0);
  const service_count = Object.values(menus).reduce((s, m) => s + m.count, 0);
  const menu_mix = {}; for (const k of Object.keys(menus)) menu_mix[k] = service_amount > 0 ? +(menus[k].amount / service_amount).toFixed(4) : 0;
  const menusFlat = {}; for (const k of Object.keys(menus)) menusFlat[k] = menus[k].amount;
  return { net_sales, total_amount, pay_count, service_amount, service_count, menus: menusFlat, menu_mix };
}
export function parseReportB(html) {
  const tables = gridTables(html);
  let rows = []; for (const t of tables) if (t.length > rows.length) rows = t;
  if (rows.length < 2) return { designers: [] };
  const H = rows[0];
  const I = {
    name: colIndex(H, ['직원명']), gubun: colIndex(H, ['구분']), menu1: colIndex(H, ['1차메뉴']), detail2: colIndex(H, ['2차상세']),
    total: colIndex(H, ['합계']), count: colIndex(H, ['건수']), guests: colIndex(H, ['접객']), qty: colIndex(H, ['수량']),
    cash: colIndex(H, ['현금']), card: colIndex(H, ['카드']), bank: colIndex(H, ['통장']), pay: colIndex(H, ['Pay']), etc: colIndex(H, ['기타']),
    prepaidUse: colIndex(H, ['정액권사용']), pointUse: colIndex(H, ['포인트사용']),
  };
  const fx = { name: 0, gubun: 1, menu1: 2, detail2: 3, total: 4, count: 5, guests: 6, qty: 8, cash: 9, card: 10, bank: 11, pay: 12, etc: 13, prepaidUse: 14, pointUse: 17 };
  for (const k of Object.keys(I)) if (I[k] < 0) I[k] = fx[k];
  const groups = new Map(); let cur = null;
  for (let r = 1; r < rows.length; r++) {
    const row = rows[r]; const g = (row[I.gubun] || '').trim();
    if (/총합계/.test(g)) { cur = null; continue; }
    const nm = (row[I.name] || '').trim(); if (nm) cur = nm;
    if (!cur) continue;
    if (!groups.has(cur)) groups.set(cur, []);
    groups.get(cur).push({ g, row });
  }
  const designers = []; for (const [name, list] of groups) designers.push(buildDesigner(name, list, I));
  return { designers };
}
function buildDesigner(name, list, I) {
  const val = (row, i) => num(row[i]);
  const findSub = (label) => list.find(x => x.g === label);
  const serviceRows = list.filter(x => x.g === '시술');
  const retailRows = list.filter(x => x.g === '점판');
  const svcSub = findSub('시술소계'), retSub = findSub('점판소계'), staffSub = findSub('직원소계'), prepaidSub = findSub('정액권소계');
  const payroll_base = staffSub ? val(staffSub.row, I.total) : 0;
  const service_payroll = svcSub ? val(svcSub.row, I.total) : 0;
  const retail_amount = retSub ? val(retSub.row, I.total) : 0;
  const prepaid_sold = prepaidSub ? val(prepaidSub.row, I.total) : 0;
  let prepaidUsed = 0, pointUsed = 0;
  for (const s of serviceRows) { prepaidUsed += val(s.row, I.prepaidUse); pointUsed += val(s.row, I.pointUse); }
  const prepaid_used = prepaidUsed + pointUsed;
  const service_perf = service_payroll + prepaid_used;
  const guests = svcSub ? val(svcSub.row, I.guests) : 0;
  const service_count = svcSub ? val(svcSub.row, I.count) : 0;
  const avg_ticket = guests > 0 ? Math.round(service_perf / guests) : 0;
  const items_per_guest = guests > 0 ? +(service_count / guests).toFixed(2) : 0;
  const retail_items = retailRows.map(s => ({ brand: (s.row[I.menu1] || '').trim(), item: (s.row[I.detail2] || '').trim(), amount: val(s.row, I.total) })).filter(x => x.amount || x.brand || x.item);
  const menuAmt = {};
  for (const s of serviceRows) { const key = canonMenu((s.row[I.menu1] || '').trim()); if (!key) continue; menuAmt[key] = (menuAmt[key] || 0) + val(s.row, I.total) + val(s.row, I.prepaidUse) + val(s.row, I.pointUse); }
  const menuTotal = Object.values(menuAmt).reduce((a, b) => a + b, 0);
  const menu_mix = {}; for (const k of Object.keys(menuAmt)) menu_mix[k] = menuTotal > 0 ? +(menuAmt[k] / menuTotal).toFixed(4) : 0;
  // 결제수단: 명세(시술+점판) 행에서만 합산 (소계행 결제컬럼은 버그, 스펙 3-4)
  const pay = { '현금': 0, '카드': 0, '통장': 0, 'Pay': 0, '기타': 0 };
  for (const s of serviceRows.concat(retailRows)) {
    pay['현금'] += val(s.row, I.cash); pay['카드'] += val(s.row, I.card); pay['통장'] += val(s.row, I.bank);
    pay['Pay'] += val(s.row, I.pay); pay['기타'] += val(s.row, I.etc);
  }
  return { name, payroll_base, service_payroll, service_perf, prepaid_sold, prepaid_used, guests, service_count, avg_ticket, items_per_guest, retail_amount, retail_items, menus: menuAmt, menu_mix, pay };
}
// Report B 디자이너들 → 매장 집계 도출 (Report A 없을 때)
function storeFromDesigners(designers) {
  const menus = {}, pays = { '현금': 0, '카드': 0, '통장': 0, 'Pay': 0, '기타': 0 };
  let net = 0, svc = 0, cnt = 0, guests = 0, retail = 0;
  for (const d of designers) {
    net += d.payroll_base; svc += d.service_payroll; cnt += d.service_count; guests += d.guests; retail += d.retail_amount;
    for (const k of Object.keys(d.menus || {})) menus[k] = (menus[k] || 0) + d.menus[k];
    for (const k of Object.keys(d.pay || {})) pays[k] = (pays[k] || 0) + d.pay[k];
  }
  const mt = Object.values(menus).reduce((a, b) => a + b, 0);
  const menu_mix = {}; for (const k of Object.keys(menus)) menu_mix[k] = mt > 0 ? +(menus[k] / mt).toFixed(4) : 0;
  return { net_sales: net, total_amount: net, service_amount: svc, service_count: cnt, guests, retail_amount: retail, menus, menu_mix, pays, derived_from: 'reportB' };
}

/* ═══ 인스타그램 ═══ */
// 지점(한글) → shop 키. 인스타 대상은 앱 직원관리(/users)의 재직 디자이너에서 읽는다.
const BRANCH_TO_SHOP = { '플래그십점': 'flagship', '모먼트점': 'moment', '합정점': 'eto' };
async function collectSns(date, dry) {
  if (!process.env.IG_TOKEN) throw new Error('IG_TOKEN 미설정');
  await resolveIgUserId(); // IG_USER_ID 자동 확정 (없으면 토큰으로 조회)
  const users = await fbGET('/users.json') || {};
  // 재직(퇴사 자동 제외) + 디자이너/교육자 + ig_username 있는 사람만
  const active = Object.keys(users).map(ph => ({ ph, u: users[ph] || {} }))
    .filter(x => x.u && (x.u.status || '재직') === '재직'
      && (x.u.role === '디자이너' || x.u.academyRole === '교육자')
      && x.u.ig_username);
  const out = [];
  for (let i = 0; i < active.length; i++) {
    const u = active[i].u;
    const shop = BRANCH_TO_SHOP[u.branch] || 'flagship';
    const name = u.nick || u.name || active[i].ph;
    const username = String(u.ig_username).replace(/^@/, '').trim();
    if (!username) continue;
    try {
      const metrics = computeSnsMetrics(await igBusinessDiscovery(username), date);
      metrics.ig_username = username;
      if (!dry) await rtdbPut(`/stores/${enc(shop)}/daily/${enc(date)}/sns/${enc(safeKey(name))}`, metrics);
      out.push({ shop, name, username, ok: true, ...metrics });
    } catch (e) { out.push({ shop, name, username, ok: false, error: e.message }); }
    if (i < active.length - 1) await sleep(CONFIG.igRateGapMs);
  }
  return { date, count: out.length, results: out };
}
// 공식 인스타 계정 수집 (브랜드별 1개). /official/{key}/daily/{date} 저장.
async function collectOfficialSns(date, dry) {
  if (!process.env.IG_TOKEN) throw new Error('IG_TOKEN 미설정');
  await resolveIgUserId();
  const out = [];
  const accs = CONFIG.officialAccounts || [];
  for (let i = 0; i < accs.length; i++) {
    const acc = accs[i];
    const username = String(acc.username).replace(/^@/, '').trim();
    try {
      const m = computeSnsMetrics(await igBusinessDiscovery(username), date);
      m.ig_username = username; m.label = acc.label; m.brand = acc.brand;
      if (!dry) await rtdbPut(`/official/${enc(acc.key)}/daily/${enc(date)}`, m);
      out.push({ key: acc.key, username, ok: true, ...m });
    } catch (e) { out.push({ key: acc.key, username, ok: false, error: e.message }); }
    if (i < accs.length - 1) await sleep(CONFIG.igRateGapMs);
  }
  return { date, count: out.length, results: out };
}
// IG_USER_ID를 env에서 쓰되, 없으면 토큰으로 자동 조회(캐시). → 시크릿은 IG_TOKEN 하나면 됨.
let _igUserId = null;
async function resolveIgUserId() {
  if (process.env.IG_USER_ID) return process.env.IG_USER_ID;
  if (_igUserId) return _igUserId;
  const url = `${IG_API}/me/accounts?fields=instagram_business_account{id,username}&access_token=${encodeURIComponent(process.env.IG_TOKEN)}`;
  const data = await (await fetch(url, { headers: { 'User-Agent': UA } })).json();
  if (data.error) throw new Error('IG_USER_ID 자동조회 실패: ' + data.error.message);
  const pg = (data.data || []).find(p => p.instagram_business_account);
  if (!pg) throw new Error('토큰에 연결된 IG 비즈니스 계정 없음 (페이지-IG 연결/권한 확인)');
  _igUserId = pg.instagram_business_account.id;
  return _igUserId;
}
async function igBusinessDiscovery(username) {
  const fields = `business_discovery.username(${username}){followers_count,follows_count,media_count,media.limit(25){id,caption,like_count,comments_count,media_type,permalink,timestamp}}`;
  const url = `${IG_API}/${encodeURIComponent(await resolveIgUserId())}?access_token=${encodeURIComponent(process.env.IG_TOKEN)}&fields=${encodeURIComponent(fields)}`;
  const resp = await fetch(url, { headers: { 'User-Agent': UA } });
  const data = await resp.json();
  if (!resp.ok || data.error) throw new Error((data.error && data.error.message) || `IG ${resp.status}`);
  return data.business_discovery;
}
export function computeSnsMetrics(bd, date) {
  const followers = num(bd.followers_count), following = num(bd.follows_count), media_count = num(bd.media_count);
  const media = (bd.media && bd.media.data) || [];
  const nowMs = Date.parse(date + 'T00:00:00+09:00'); const dayMs = 86400000; const winMs = CONFIG.igMaturedDays * dayMs;
  let uploads_7d = 0; const matured = [];
  for (const m of media) {
    const ts = Date.parse(m.timestamp); if (!Number.isFinite(ts)) continue;
    if (nowMs - ts < winMs) uploads_7d++; else matured.push({ ts, like: num(m.like_count), cmt: num(m.comments_count) });
  }
  matured.sort((a, b) => b.ts - a.ts);
  const sample = matured.slice(0, CONFIG.igMaturedMax); const n = sample.length;
  const sumLikes = sample.reduce((s, x) => s + x.like, 0), sumCmts = sample.reduce((s, x) => s + x.cmt, 0);
  return {
    followers, following, media_count, uploads_7d,
    avg_likes: n ? +(sumLikes / n).toFixed(1) : 0, avg_comments: n ? +(sumCmts / n).toFixed(1) : 0,
    engagement_rate: (n && followers) ? +(((sumLikes + sumCmts) / n / followers) * 100).toFixed(3) : 0,
    sample_size: n, window_days: CONFIG.igMaturedDays, collected_at: nowIso(),
  };
}

/* ═══ RTDB ═══ */
async function rtdbPut(path, value) {
  const resp = await fetch(`${fbUrl()}${path}.json`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(value) });
  if (!resp.ok) throw new Error(`RTDB PUT ${path} → ${resp.status}`);
}
async function fbGET(path) {
  const resp = await fetch(`${fbUrl()}${path}`, { cache: 'no-store' });
  if (!resp.ok) return null;
  return await resp.json();
}

/* ═══ 헬퍼 ═══ */
function json(x) { return JSON.stringify(x); }
function enc(s) { return encodeURIComponent(s); }
export function safeKey(s) { return String(s).replace(/[/.#$\[\]]/g, '·').trim(); }
function stripName(d) { const { name, ...rest } = d; return rest; }
function encodePairs(pairs) { return pairs.map(([k, v]) => encodeURIComponent(k) + '=' + encodeURIComponent(v)).join('&'); }
export function colIndex(header, names) {
  if (!header) return -1;
  for (let i = 0; i < header.length; i++) {
    const h = (header[i] || '').replace(/\s+/g, '');
    for (const nm of names) if (h === nm.replace(/\s+/g, '') || h.includes(nm)) return i;
  }
  return -1;
}
export function canonMenu(s) {
  const t = String(s || '');
  if (/컷/.test(t)) return '컷'; if (/펌/.test(t)) return '펌'; if (/염색/.test(t)) return '염색'; if (/크리닉|클리닉/.test(t)) return '크리닉';
  return safeKey(t.trim()); // 비표준 메뉴명이 Firebase 금지문자(/.#$[])를 포함하면 키로 못 씀 → 치환
}
function getSetCookies(resp) { if (resp.headers.getSetCookie) return resp.headers.getSetCookie(); const one = resp.headers.get('set-cookie'); return one ? [one] : []; }
function mergeCookies(jar, arr) {
  for (const sc of arr) { const first = sc.split(';')[0]; const eq = first.indexOf('='); if (eq > 0) { const nm = first.slice(0, eq).trim(), v = first.slice(eq + 1).trim(); if (v && v.toLowerCase() !== 'deleted') jar[nm] = v; } }
  return jar;
}
function serializeCookies(jar) { return Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; '); }
function kstDateString(offsetDays) { const d = new Date(Date.now() + 9 * 3600000 + (offsetDays || 0) * 86400000); return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`; }
function pad(n) { return String(n).padStart(2, '0'); }
function nowIso() { return new Date().toISOString(); }
function dateRange(from, to) {
  const out = []; let t = Date.parse(from + 'T00:00:00Z'); const end = Date.parse(to + 'T00:00:00Z');
  while (t <= end) { const d = new Date(t); out.push(`${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`); t += 86400000; }
  return out;
}
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
async function notify(text) {
  try {
    if (!process.env.ALERT_WEBHOOK_URL) { console.log('[notify]', text); return; }
    await fetch(process.env.ALERT_WEBHOOK_URL, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: json({ secret: process.env.ALERT_SECRET || '', text }) });
  } catch (e) { console.log('[notify failed]', text, e.message); }
}

// main 가드: test.mjs가 import할 때는 실행 안 됨
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(e => { console.error('FATAL', e); process.exit(1); });
}
