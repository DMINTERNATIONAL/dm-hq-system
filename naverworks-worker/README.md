# DM 시스템 → 네이버 웍스 봇 알림 설정 가이드

DM INTERNATIONAL 시스템에서 발주가 들어올 때마다 네이버 웍스 단톡방에 봇 메시지가 자동으로 전송되도록 설정하는 가이드.

총 **3단계 · 약 20분**.

---

## 📋 사전 준비물

- 네이버 웍스 **관리자 권한** (봇 만들 수 있는 권한)
- Cloudflare 계정 (무료, 가입 1분)
- (선택) Node.js 20+ 설치 (없으면 웹 대시보드로 가능)

---

## STEP 1. 네이버 웍스 봇 만들기

### 1-1. 네이버 웍스 Developer Console 접속

1. https://developers.worksmobile.com 접속
2. 우측 상단 **"콘솔"** 클릭 → 회사 계정으로 로그인

### 1-2. 앱 등록

1. 좌측 **"앱"** → **"+ 앱 추가"** 클릭
2. 앱 이름: `DM 발주 알림`
3. **"등록"** 클릭

### 1-3. 봇 생성 + 권한

1. 등록한 앱 클릭 → 좌측 메뉴 **"Bot"** 탭
2. **"Bot 등록"** 클릭
3. Bot 이름: `DM 발주 봇`
4. 설명: `발주 들어올 때 알림 보내는 봇`
5. **권한 (Scope)**: `bot.message` 체크
6. 등록 → **Bot ID** 메모 (예: `12345678`)

### 1-4. OAuth 2.0 자격 증명 발급

같은 앱에서:

1. 좌측 **"앱 설정"** → **"OAuth Scopes"** 탭
2. 다음 스코프 활성화:
   - `bot`
3. **"Service Account"** 탭으로 이동
4. **"Service Account 발급"** 클릭
5. 발급 후 받은 정보:
   - **Client ID** (메모)
   - **Client Secret** (메모)
   - **Service Account ID** (예: `xxxx.serviceaccount@yourcompany`)
   - **Private Key** (.key 파일 다운로드 → 메모장으로 열어서 내용 메모)

### 1-5. 봇을 알림 받을 채팅방에 초대

1. 네이버 웍스 앱(또는 웹) 열기
2. 알림 받을 단톡방 (또는 새 그룹 만들기)
3. 채팅방 우측 상단 **메뉴** → **"멤버 초대"** → **"봇 추가"**
4. 방금 만든 `DM 발주 봇` 검색 → 추가
5. **Channel ID 얻는 법**: 채팅방 URL 또는 봇 SDK로 확인 (보통 URL `.../channel/12345-xxxxx-yyyy/...` 형태에서 추출)

> **Channel ID 못 찾겠으면**: 봇이 채팅방에 초대된 후 누군가 채팅방에서 `@봇이름` 멘션 → 봇 callback URL로 channelId가 전달됨. 또는 네이버 웍스 고객센터에 문의.

---

## STEP 2. Cloudflare Worker 배포 (릴레이 서버)

### 2-1. Cloudflare 가입

1. https://dash.cloudflare.com/sign-up 가입 (무료)
2. 로그인 후 좌측 **"Workers & Pages"** 클릭

### 2-2. Worker 생성

**방법 A: 웹 대시보드 (가장 쉬움)**

1. **"Create application"** → **"Create Worker"** 클릭
2. 이름: `dm-naverworks-relay`
3. **"Deploy"** 클릭 (기본 hello-world 코드로 일단 배포)
4. **"Edit code"** 클릭
5. 좌측 코드를 **모두 지우고** → 이 폴더의 `worker.js` 내용 전체 복사 → 붙여넣기
6. **"Save and deploy"** 클릭
7. 배포된 URL 메모 (예: `https://dm-naverworks-relay.your-subdomain.workers.dev`)

**방법 B: 커맨드 라인 (Wrangler CLI)**

```bash
npm install -g wrangler
wrangler login
cd naverworks-worker
wrangler deploy
```

### 2-3. 환경 변수 (Secrets) 등록

웹 대시보드에서:

1. 배포한 Worker 클릭 → **"Settings"** 탭 → **"Variables and Secrets"** 클릭
2. **"+ Add variable"** → **"Type: Secret"** 선택
3. 다음 7개를 모두 등록:

| Name | Value |
|------|-------|
| `WEBHOOK_SECRET` | 임의의 긴 문자열 (예: `dm-secret-2026-xyz789`) — 직접 정함 |
| `NW_CLIENT_ID` | (Step 1-4에서 받은) Client ID |
| `NW_CLIENT_SECRET` | (Step 1-4) Client Secret |
| `NW_SERVICE_ACCOUNT` | (Step 1-4) Service Account ID |
| `NW_PRIVATE_KEY` | (Step 1-4) 다운받은 .key 파일 내용 전체 (`-----BEGIN PRIVATE KEY-----`부터 `-----END PRIVATE KEY-----`까지) |
| `NW_BOT_ID` | (Step 1-3) Bot ID |
| `NW_CHANNEL_ID` | (Step 1-5) 알림 받을 채팅방 Channel ID |

각 항목 입력 후 **"Encrypt"** 체크 → **"Save"**

**커맨드 라인으로는**:
```bash
wrangler secret put WEBHOOK_SECRET
# 입력 프롬프트에 값 입력
# 나머지 6개도 동일
```

### 2-4. 동작 확인

브라우저에서 Worker URL 접속:
- `https://dm-naverworks-relay.your-subdomain.workers.dev`
- `{"ok":true,"service":"dm-naverworks-relay"}` 응답이 보이면 OK

---

## STEP 3. DM 시스템에서 연결

### 3-1. 본사 관리자로 로그인

1. DM 시스템 접속 → 본사 관리자 로그인
2. 사이드바 → **"알림 설정"** 메뉴 (Step 4 작업 후 표시됨)

### 3-2. 웹훅 설정

다음 정보 입력:

| 필드 | 값 |
|------|-----|
| **Webhook URL** | Step 2-2에서 받은 Worker URL |
| **Secret** | Step 2-3에서 정한 `WEBHOOK_SECRET` 값 (동일하게) |
| **알림 활성화** | ON |

**"테스트 메시지 보내기"** 버튼 클릭 → 네이버 웍스 단톡방에 `✅ 테스트 메시지` 가 오면 **성공!**

---

## 🎉 완료

이제부터 발주가 들어올 때마다 자동으로 네이버 웍스에 알림이 갑니다:

```
🔔 새 발주가 들어왔어요!

📍 DAY:MEAN 모먼트점
👤 신청자: 종찬
📦 총 5개 항목

• 로레알 인오아 펌제 5L 2개
• 트리트먼트 12개
• 샴푸 5L 1개

📝 메모: 급하게 부탁드립니다
🕐 2026-05-03 14:32

→ 본사 시스템에서 확인하기
```

환불 요청도 동일한 방식으로 별도 알림 전송됨.

---

## 🛠️ 트러블슈팅

### "테스트 메시지 보내기" 클릭했는데 메시지 안 옴

1. **Worker URL 확인** — 브라우저로 직접 접속해서 `{"ok":true...}` 응답 오는지
2. **Secret 일치 확인** — DM 시스템에 입력한 Secret이 Worker의 `WEBHOOK_SECRET` 환경변수와 정확히 같은지
3. **Worker 로그 확인** — Cloudflare 대시보드 → Worker → "Logs" 탭에서 에러 메시지 확인
4. **Naver Works 봇 권한 확인** — 봇이 해당 채팅방에 추가되어 있는지

### "Auth failed" 에러

- `NW_PRIVATE_KEY` 값에 `\n` 같은 escape 문자가 들어갔는지 확인
- PEM 키는 줄바꿈 그대로 입력해야 함 (`-----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----` 형태)
- Service Account ID에 공백이나 오타 없는지 확인

### 알림이 너무 많이 와서 줄이고 싶음

- DM 시스템 → 알림 설정 → **"알림 활성화" OFF**로 일시 정지
- 또는 발주 종류별 (제품/비품) 필터링 — 코드 수정 필요

---

## 💰 비용

- **Cloudflare Workers (무료 플랜)**: 하루 100,000 요청, 월 100만 요청까지 0원
- **DM 시스템 발주량 추정**: 50명 × 하루 평균 2~5건 = **하루 100~250 요청**
- → **무료 플랜으로 충분**

---

## 📞 문의

설정 중 막히면 본사 관리자에게 문의하거나 Cloudflare 또는 Naver Works 고객센터에 연락.
