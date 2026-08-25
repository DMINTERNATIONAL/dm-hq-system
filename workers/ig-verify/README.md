# dm-ig-verify — 인스타그램 아이디 검증 Worker

직원관리에서 IG 아이디 입력 후 **확인** 버튼 → 이 Worker가 Graph API `business_discovery`로
실시간 조회 → **성공(팔로워 수)** 또는 **실패(사유)** 를 즉시 반환한다.
IG 토큰을 브라우저에 노출하지 않기 위한 프록시.

## ⚠️ 조회 조건
`business_discovery`는 **프로페셔널(비즈니스/크리에이터) 공개 계정만** 조회된다.
- 개인(일반) 계정 → 실패
- 비공개 계정 → 실패
- 오타/없는 아이디 → 실패

## 배포
```bash
cd workers/ig-verify
npx wrangler secret put IG_TOKEN     # DM Analytics 시스템사용자 무만료 토큰 (hermes-kpi와 동일)
# (선택) npx wrangler secret put IG_USER_ID   # 미설정 시 토큰에서 자동조회
npx wrangler deploy
```
배포되면 `https://dm-ig-verify.<계정>.workers.dev` 주소가 나온다.
→ index.html의 `IG_VERIFY_URL` 상수를 이 주소로 교체(또는 커스텀 도메인 지정).

## 요청/응답
```
GET https://dm-ig-verify.../?u=day.mean_min
→ { ok:true, username, name, followers, media_count }
→ { ok:false, error:"개인 계정입니다. ...", raw:"<원문>" }
```
CORS: dminternational.github.io + localhost:8012/8013 만 허용.
