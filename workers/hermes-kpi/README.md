# Hermes KPI 수집기 (GitHub Actions)

매일 04:00 KST 자동 실행. 핸드SOS 매출 + 인스타그램 스냅샷을 수집·정규화해
Firebase RTDB(`stores/{shop}/daily/{date}/…`)에 저장한다. 수기 입력은 폴백으로 유지.

> ⚠️ **왜 Cloudflare Worker가 아니라 GitHub Actions인가**
> 핸드SOS는 Cloudflare Worker 발신 요청을 전부 **522(연결 차단)** 시킨다(일반 IP는 정상 200).
> 그래서 매출 수집은 일반 egress IP를 쓰는 GitHub Actions에서 Node로 실행한다.
> 인스타그램(Graph API)은 어디서든 되므로 같은 잡에서 함께 처리한다.

- `collect.mjs` — 수집·파싱·저장 (Node 20+, `node collect.mjs [mode]`)
- `test.mjs` — 파서 단위테스트 30케이스 (`npm test`). 스펙 3장 비즈니스 규칙 검증
- `../../.github/workflows/hermes-kpi.yml` — cron + 수동실행(workflow_dispatch)

## 셋업 (GitHub 웹 화면에서 — 터미널 불필요)

1. GitHub 저장소 → **Settings → Secrets and variables → Actions → New repository secret**
2. 아래 시크릿 등록 (값은 각 이름에 맞는 실제 값):

   | 시크릿 | 값 |
   |---|---|
   | `HANDSOS_COMPANY` | 핸드SOS 회사코드 |
   | `HANDSOS_ID` | 핸드SOS 아이디 |
   | `HANDSOS_PW` | 핸드SOS 비밀번호 |
   | `IG_USER_ID` | 회사 IG 비즈니스 계정 User ID |
   | `IG_TOKEN` | 위 계정 장기 액세스 토큰 |
   | `FIREBASE_URL` | (선택) RTDB URL. 미설정 시 기본값 사용 |

3. **Actions 탭 → Hermes KPI 수집 → Run workflow** 로 수동 실행 가능

## 수동 실행 (Actions 탭 → Run workflow)

- `mode`: `both`(기본) / `sales` / `sns` / `shops`
- `shops`: 3개 지점 `PkCompany` 코드 자동 발견 → 로그에서 확인 후 `collect.mjs`의 `CONFIG.shops`에 채움
- `date`: 특정일(비우면 전일) · `from`+`to`: 소급 수집 · `dry`: 저장 안 하고 결과만

로컬 실행도 동일: `HANDSOS_ID=... node collect.mjs shops`

## 지점 (3개, 본사 아이디 하나로 모두 조회)

| shop 키 | 지점 | PkCompany |
|---|---|---|
| `flagship` | 데이민 플래그십 | `12550630` (이 지점 맞는지 확인) |
| `moment` | 데이민 모먼트 | mode=shops로 확보 |
| `eto` | 에토바버샵 | mode=shops로 확보 |

## 핵심 규칙 (스펙 3장, test.mjs로 고정)

- `payroll_base = 직원소계.합계` — 급여 정산 기준, **보정 금지**
- `service_perf = 시술소계.합계 + Σ시술.정액권사용 + Σ시술.포인트사용` — KPI/객단가
- `avg_ticket = service_perf / 접객` (건수 아님)
- 소계 행의 결제수단 컬럼(통장 등)은 버그 → **사용 안 함**
- 리포트 A/B 총액 차이 >5% → 저장 중단, ≤5%면 저장 + `matched=false` 알림

## 확인/미확인

| 항목 | 상태 |
|---|---|
| 핸드SOS 로그인 폼 | ✅ `companyID`/`userID`/`userPWD`, `setCookieReset.asp`→`loginHide.asp` 평문 (실측) |
| 로그인 호스트 | ✅ 로그인=www.handsos.com, 리포트=www1.handsos.com (실측; env로 전환 가능) |
| 지점 코드 (모먼트·에토) | ⚠️ mode=shops로 확보 |
| GitHub Actions IP 도달성 | ⚠️ 첫 실행으로 확인 (Cloudflare만 차단됨; Azure IP는 대개 정상) |
| IG 앱 심사 / 토큰 | ⚠️ Graph Explorer 선검증 + 토큰 발급 |

> 파싱·급여/성과 분리·저장·검증·IG 산출은 완성·테스트됨. 실제 리포트로 첫 실행 후 재대조 권장.
