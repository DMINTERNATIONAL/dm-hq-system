// Hermes KPI 파서 단위테스트 — 스펙 3장 비즈니스 규칙 검증.
// 실행: node test.mjs   (codepage 설치 불필요 — 순수 파서만 검증)
// 합성 리포트 HTML(스펙 컬럼 레이아웃)로 급여/성과 분리·접객 분모·소계버그 회피를 확인한다.

import { parseReportA, parseReportB, computeSnsMetrics, canonMenu, safeKey } from './collect.mjs';

let pass = 0, fail = 0;
function eq(name, got, want) {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}\n      기대: ${w}\n      실제: ${g}`); }
}

// ── 리포트 B 컬럼 순서 (스펙 2-3) ──
const COLS = ['직원명','구분','1차메뉴','2차상세','합계','건수','접객','고객','수량',
  '현금','카드','통장','Pay','기타','정액권사용','회원권사용','외상','포인트사용','1차메뉴건당가','1차메뉴객단가'];
const IDX = Object.fromEntries(COLS.map((c, i) => [c, i]));

function row(obj) {
  const a = new Array(COLS.length).fill('');
  for (const [k, v] of Object.entries(obj)) a[IDX[k]] = String(v);
  return a;
}
function tableHtml(rows) {
  const tr = r => '<tr>' + r.map(c => `<td>${c}</td>`).join('') + '</tr>';
  return '<table>' + rows.map(tr).join('') + '</table>';
}

/* ══ 리포트 B ══ */
console.log('리포트 B — 담당자별 급여/성과 분리');

const rowsB = [
  COLS, // 헤더
  // 김디자이너: 시술 3행 (염색은 전액 정액권결제 → 합계 0, 정액권사용 60,000)
  row({ 직원명: '김디자이너', 구분: '시술', '1차메뉴': '컷', 합계: '100,000', 건수: 2, 정액권사용: 0, 포인트사용: 0 }),
  row({ 구분: '시술', '1차메뉴': '염색', 합계: '0', 건수: 1, 정액권사용: '60,000', 포인트사용: 0 }),
  row({ 구분: '시술', '1차메뉴': '크리닉', 합계: '40,000', 건수: 1, 정액권사용: 0, 포인트사용: '20,000' }),
  row({ 구분: '시술소계', 합계: '140,000', 건수: 4, 접객: 2, 통장: '999,999' }), // 통장=버그값(무시돼야)
  row({ 구분: '점판', '1차메뉴': '브랜드A', '2차상세': '샴푸', 합계: '30,000' }),
  row({ 구분: '점판소계', 합계: '30,000', 통장: '999,999' }),
  row({ 구분: '정액권판매', 합계: '500,000' }),
  row({ 구분: '정액권소계', 합계: '500,000' }),
  row({ 구분: '직원소계', 합계: '670,000', 통장: '999,999' }), // payroll_base는 합계(670k)여야, 통장 아님
  // 이디자이너: 소계만 (직원명 비어있는 소계 그룹핑 확인용)
  row({ 직원명: '이디자이너', 구분: '시술', '1차메뉴': '펌', 합계: '80,000', 건수: 1, 정액권사용: 0, 포인트사용: 0 }),
  row({ 구분: '시술소계', 합계: '80,000', 건수: 1, 접객: 1 }),
  row({ 구분: '직원소계', 합계: '80,000' }),
  // 총합계 (제외돼야 함)
  row({ 구분: '총합계', 합계: '750,000' }),
];

const B = parseReportB(tableHtml(rowsB));
eq('디자이너 2명 (총합계 제외)', B.designers.length, 2);

const kim = B.designers.find(d => d.name === '김디자이너');
eq('payroll_base = 직원소계.합계 (통장 버그값 무시)', kim.payroll_base, 670000);
eq('service_payroll = 시술소계.합계', kim.service_payroll, 140000);
eq('prepaid_used = Σ정액권사용+Σ포인트사용', kim.prepaid_used, 80000);
eq('service_perf = 시술소계합계 + 정액권/포인트 보정', kim.service_perf, 220000);
eq('prepaid_sold = 정액권소계.합계', kim.prepaid_sold, 500000);
eq('guests = 시술소계.접객 (건수 아님)', kim.guests, 2);
eq('service_count = 시술소계.건수', kim.service_count, 4);
eq('avg_ticket = service_perf / 접객', kim.avg_ticket, 110000); // 220,000 / 2
eq('items_per_guest = 시술건수 / 접객', kim.items_per_guest, 2); // 4 / 2
eq('retail_amount = 점판소계.합계', kim.retail_amount, 30000);
eq('retail_items', kim.retail_items, [{ brand: '브랜드A', item: '샴푸', amount: 30000 }]);
eq('menus (service_perf 기준)', kim.menus, { 컷: 100000, 염색: 60000, 크리닉: 60000 });
eq('menu_mix 합=1', +Object.values(kim.menu_mix).reduce((a, b) => a + b, 0).toFixed(2), 1);

const lee = B.designers.find(d => d.name === '이디자이너');
eq('이디자이너 payroll_base', lee.payroll_base, 80000);
eq('이디자이너 avg_ticket (접객1)', lee.avg_ticket, 80000);

/* ══ 리포트 A ══ */
console.log('\n리포트 A — 매장 집계');

const htmlA =
  tableHtml([['합계', '건수', '실매출'], ['700,000', '10', '690,000']]) +
  tableHtml([['구분', '건수', '총액'],
    ['컷', '4', '200,000'], ['펌', '1', '150,000'], ['염색', '2', '180,000'], ['크리닉', '1', '90,000']]);

const A = parseReportA(htmlA);
eq('net_sales = 실매출', A.net_sales, 690000);
eq('total_amount = 합계', A.total_amount, 700000);
eq('service_amount = Σ총액', A.service_amount, 620000);
eq('service_count = Σ건수', A.service_count, 8);
eq('menus', A.menus, { 컷: 200000, 펌: 150000, 염색: 180000, 크리닉: 90000 });
eq('menu_mix 합=1', +Object.values(A.menu_mix).reduce((a, b) => a + b, 0).toFixed(2), 1);

/* ══ 인스타그램 ══ */
console.log('\n인스타그램 — 측정 창 고정 + 참여율');

function iso(daysAgo) {
  const base = Date.parse('2026-08-24T00:00:00+09:00');
  return new Date(base - daysAgo * 86400000).toISOString();
}
const bd = {
  followers_count: 1000, follows_count: 300, media_count: 42,
  media: {
    data: [
      { timestamp: iso(1), like_count: 5, comments_count: 1 },   // 미성숙 (uploads_7d)
      { timestamp: iso(3), like_count: 9, comments_count: 2 },   // 미성숙
      { timestamp: iso(8), like_count: 100, comments_count: 10 },// 성숙
      { timestamp: iso(10), like_count: 50, comments_count: 5 }, // 성숙
      { timestamp: iso(20), like_count: 30, comments_count: 0 }, // 성숙
    ],
  },
};
const sns = computeSnsMetrics(bd, '2026-08-24');
eq('uploads_7d (최근 7일)', sns.uploads_7d, 2);
eq('sample_size (성숙 게시물)', sns.sample_size, 3);
eq('avg_likes', sns.avg_likes, 60);      // (100+50+30)/3
eq('avg_comments', sns.avg_comments, 5); // (10+5+0)/3
eq('engagement_rate %', sns.engagement_rate, 6.5); // (180+15)/3/1000*100
eq('window_days', sns.window_days, 7);

/* ══ Firebase 키 안전 ══ */
console.log('\nFirebase 키 금지문자 치환');
eq('safeKey 금지문자 → ·', safeKey('a/b.c#d$e[f]g'), 'a·b·c·d·e·f·g');
eq('canonMenu 클리닉→크리닉', canonMenu('클리닉(두피)'), '크리닉');

console.log(`\n${fail === 0 ? '✅' : '❌'} ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
