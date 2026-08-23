// DM INTERNATIONAL — Hermes KPI 수집기 (Node / GitHub Actions)
//
// 핸드SOS는 Cloudflare Worker 발신요청을 522로 차단하므로(일반 IP는 정상),
// 매출 수집은 GitHub Actions(일반 egress IP)에서 Node로 실행한다.
// 파싱·급여/성과 분리 로직은 스펙 3장 그대로. RTDB 저장 스키마도 동일.
//
// 실행:  node collect.mjs [mode] [--date=YYYY-MM-DD] [--from= --to=] [--dry]
//   mode = both(기본) | sales | sns | shops
// 필수 env(시크릿): HANDSOS_COMPANY, HANDSOS_ID, HANDSOS_PW, IG_USER_ID, IG_TOKEN
// 선택 env: FIREBASE_URL, HANDSOS_LOGIN_HOST, HANDSOS_HOST
//
// Node 20+ (global fetch, Headers.getSetCookie). codepage로 cp949 디코딩.

import * as cptableMod from 'codepage';
const cptable = cptableMod.default || cptableMod;

/* ═══ 설정 ═══ */
const CONFIG = {
  shops: [
    { shop: 'flagship', code: '12550630', name: '데이민 플래그십' }, // ← 12550630 이 지점 확인
    { shop: 'moment', code: '', name: '데이민 모먼트' },              // [TODO] mode=shops로 코드 확보
    { shop: 'eto', code: '', name: '에토바버샵' },                    // [TODO] mode=shops로 코드 확보
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
  if (opt.from && opt.to) {
    for (const d of dateRange(opt.from, opt.to)) {
      console.log(`[backfill] ${d}`);
      console.log(JSON.stringify(await collectSales(d, dry), null, 2));
    }
    return;
  }
  const date = opt.date || kstDateString(-1);
  const errors = [];
  if (mode === 'sales' || mode === 'both') {
    try { console.log('[sales]', JSON.stringify(await collectSales(date, dry))); }
    catch (e) { errors.push('sales: ' + e.message); await notify('[Hermes] 매출 수집 실패 ' + date + ': ' + e.message); }
  }
  if (mode === 'sns' || mode === 'both') {
    try { console.log('[sns]', JSON.stringify(await collectSns(kstDateString(0), dry))); }
    catch (e) { errors.push('sns: ' + e.message); await notify('[Hermes] SNS 수집 실패: ' + e.message); }
  }
  if (errors.length) { console.error('FAILED:', errors.join(' | ')); process.exit(1); }
}

/* ═══ 매출 수집 ═══ */
async function collectSales(date, dry) {
  const session = await handsosLogin();
  const perShop = [];
  for (const shop of CONFIG.shops) {
    if (!shop.code) { perShop.push({ shop: shop.shop, ok: false, error: 'PkCompany 코드 미설정' }); continue; }
    try { perShop.push(await collectShopSales(session, shop, date, dry)); }
    catch (e) { await notify(`[Hermes] ${shop.name}(${date}) 매출 실패: ${e.message}`); perShop.push({ shop: shop.shop, ok: false, error: e.message }); }
  }
  return { date, shops: perShop };
}

async function collectShopSales(session, shop, date, dry) {
  const htmlA = await fetchReport(session, 'A', shop.code, date);
  const htmlB = await fetchReport(session, 'B', shop.code, date);
  const reportA = parseReportA(htmlA);
  const reportB = parseReportB(htmlB);

  const totalA = reportA.net_sales;
  const totalB = reportB.designers.reduce((s, d) => s + d.payroll_base, 0);
  const diff = totalA > 0 ? Math.abs(totalA - totalB) / totalA : 0;
  if (diff > CONFIG.saleValidateTolerance) {
    await notify(`[Hermes] ${shop.name}(${date}) A/B 총액 ${(diff * 100).toFixed(1)}% 차이 → 저장 중단`);
    return { shop: shop.shop, ok: false, error: `validation aborted: diff ${(diff * 100).toFixed(1)}%`, totalA, totalB };
  }
  const matched = diff < 0.001;
  const validation = { matched, diffPct: +(diff * 100).toFixed(2), totalA, totalB };
  if (!matched) await notify(`[Hermes] ${shop.name}(${date}) A/B 총액 차이 ${validation.diffPct}% (5% 이내, 저장함)`);

  const store = {
    net_sales: reportA.net_sales, total_amount: reportA.total_amount,
    service_amount: reportA.service_amount, service_count: reportA.service_count,
    guests: reportB.designers.reduce((s, d) => s + d.guests, 0),
    menus: reportA.menus, menu_mix: reportA.menu_mix,
  };
  const meta = { collected_at: nowIso(), source: 'handsos', parser_version: PARSER_VERSION, validation };

  if (dry) return { shop: shop.shop, ok: true, dry: true, store, meta, designers: reportB.designers };

  const base = `/stores/${enc(shop.shop)}/daily/${enc(date)}`;
  await rtdbPut(`${base}/store`, store);
  await rtdbPut(`${base}/meta`, meta);
  for (const d of reportB.designers) await rtdbPut(`${base}/designers/${enc(safeKey(d.name))}`, stripName(d));
  return { shop: shop.shop, ok: true, designers: reportB.designers.length, validation };
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
  const resp = await fetch(`${reportHost()}/work/detail/saleStaffList.asp`, { headers: { 'Cookie': session.cookie, 'User-Agent': UA } });
  const html = decodeEucKr(await resp.arrayBuffer());
  const sel = /<select\b[^>]*name=["']?PkCompany["']?[^>]*>([\s\S]*?)<\/select>/i.exec(html);
  const scope = sel ? sel[1] : html;
  const opts = []; const oRe = /<option\b[^>]*value=["']?([^"'>]+)["']?[^>]*>([\s\S]*?)<\/option>/gi; let m;
  while ((m = oRe.exec(scope))) { const code = m[1].trim(), name = cleanCell(m[2]); if (code && name) opts.push({ code, name }); }
  return { host: reportHost(), authed: /<select/i.test(html) || opts.length > 0, count: opts.length, options: opts, snippet: html.slice(0, 200).replace(/\s+/g, ' ') };
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
    ['strDateS', date], ['strDateE', date], ['PkCompany', shopCode], ['strPriceKind', 'REAL'], ['chk_all', 'Y'],
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
    if (_retry) throw new Error(`리포트 ${kind} 응답에 <table> 없음 (세션/조회조건 확인)`);
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
  const tables = parseTables(html);
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
  const tables = parseTables(html);
  let rows = []; for (const t of tables) if (t.length > rows.length) rows = t;
  if (rows.length < 2) return { designers: [] };
  const H = rows[0];
  const I = {
    name: colIndex(H, ['직원명']), gubun: colIndex(H, ['구분']), menu1: colIndex(H, ['1차메뉴']), detail2: colIndex(H, ['2차상세']),
    total: colIndex(H, ['합계']), count: colIndex(H, ['건수']), guests: colIndex(H, ['접객']), qty: colIndex(H, ['수량']),
    prepaidUse: colIndex(H, ['정액권사용']), pointUse: colIndex(H, ['포인트사용']),
  };
  const fx = { name: 0, gubun: 1, menu1: 2, detail2: 3, total: 4, count: 5, guests: 6, qty: 8, prepaidUse: 14, pointUse: 17 };
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
  return { name, payroll_base, service_payroll, service_perf, prepaid_sold, prepaid_used, guests, service_count, avg_ticket, items_per_guest, retail_amount, retail_items, menus: menuAmt, menu_mix };
}

/* ═══ 인스타그램 ═══ */
async function collectSns(date, dry) {
  if (!process.env.IG_USER_ID || !process.env.IG_TOKEN) throw new Error('IG_USER_ID/IG_TOKEN 미설정');
  const out = [];
  for (const shop of CONFIG.shops) {
    const roster = await readRoster(shop.shop);
    const names = Object.keys(roster);
    for (let i = 0; i < names.length; i++) {
      const name = names[i]; const username = roster[name] && roster[name].ig_username;
      if (!username) continue;
      try {
        const metrics = computeSnsMetrics(await igBusinessDiscovery(username), date);
        if (!dry) await rtdbPut(`/stores/${enc(shop.shop)}/daily/${enc(date)}/sns/${enc(safeKey(name))}`, metrics);
        out.push({ shop: shop.shop, name, ok: true, ...metrics });
      } catch (e) { out.push({ shop: shop.shop, name, ok: false, error: e.message }); }
      if (i < names.length - 1) await sleep(CONFIG.igRateGapMs);
    }
  }
  return { date, count: out.length, results: out };
}
async function igBusinessDiscovery(username) {
  const fields = `business_discovery.username(${username}){followers_count,follows_count,media_count,media.limit(25){id,caption,like_count,comments_count,media_type,permalink,timestamp}}`;
  const url = `${IG_API}/${encodeURIComponent(process.env.IG_USER_ID)}?access_token=${encodeURIComponent(process.env.IG_TOKEN)}&fields=${encodeURIComponent(fields)}`;
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
async function readRoster(shop) {
  const resp = await fetch(`${fbUrl()}/stores/${enc(shop)}/staff.json`, { cache: 'no-store' });
  if (!resp.ok) return {};
  return (await resp.json()) || {};
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
  return t.trim();
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
