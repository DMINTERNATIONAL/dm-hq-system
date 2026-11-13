/**
 * 채용 지원서 (11/12, 같은 날 밤 사용자 요청으로 다시 짬 — 약속 문서 §6-2)
 *
 * 비회원 지원자가 공식 사이트 /recruit/apply 에서 쓰고, 임시 저장하고, 제출한 뒤에도 고친다.
 * 로그인이 없으므로 '비밀 링크'(token, 무작위 32바이트)가 열쇠다. DB 에는 sha256(token) 만 둔다
 * — DB 를 읽을 수 있는 사람(직원 토큰도 /recruitTokens 는 읽힌다)이 지원자 행세로 고칠 수 없게.
 *
 *   POST /public/apply/photo   사이트 서버만(X-Site-Key). 몸통 = 사진 → { ok, photo: 열쇠 }
 *   POST /public/apply/save    { token?, submit, ...칸 } → { ok, token?(새로 만들 때만), status }
 *   POST /public/apply/load    { token } → { ok, app: { ...칸, status, createdAt, updatedAt, submittedAt, edited, photoUrl } }
 *   GET  /recruit/apps         경영팀 · 관리자. 기본은 작성 중(draft) 빼고, ?draft=1 이면 작성 중만
 *   POST /recruit/apps/update  { id, status?, memo? }
 *   POST /recruit/apps/delete  { id }  — 지원자가 지워 달라고 할 때 바로(사진 · 링크까지)
 *
 * 저장: /recruitApps/{id} = 칸 + status · createdAt · updatedAt · submittedAt · edited · source 'site' · tok(sha256, 밖으로 안 냄)
 *       /recruitTokens/{sha256} = id
 * 사진: 지원자 얼굴은 개인정보라 공개 r2.dev 가 아니라 비공개 구글 서울 저장소(gcs.js) recruit/{열쇠} 에 두고,
 *       볼 때만 짧은 서명 주소를 준다. 올렸지만 지원서에 안 붙은 사진은 /authSecrets/__rp 에 적어 두고 하루 뒤 지운다.
 * 파기: 작성 중은 마지막 저장 30일 뒤, 제출된 것은 제출 1년 뒤(개인정보처리방침) — 사진 · 링크도 같이.
 *       경영팀이 목록을 열 때 + 1분 작업이 하루 한 번 돈다(purge).
 * 값은 화면 언어와 상관없이 한국어(사이트가 화면 글자만 번역) — 관리 앱이 이 값으로 거른다.
 */

/* 분야 — 11/12 밤 사용자 결정: 디자이너 · 인턴 · CS팀 · 경영팀. 면허는 디자이너 · 인턴만 묻는다 */
const ROLES = ['디자이너', '인턴', 'CS팀', '경영팀'];
const LICENSE_ROLES = ['디자이너', '인턴'];
const EDU_ST = ['졸업', '재학', '휴학', '중퇴', '졸업 예정'];
const FAMILY_REL = ['아버지', '어머니', '배우자', '형제자매', '자녀', '기타'];
const YM_RE = /^(19|20)\d{2}\.(0[1-9]|1[0-2])$/;   // 2023.03
const LICENSES = ['있음', '없음', '취득 예정'];
const CAREERS = ['신입', '1년 미만', '1~3년', '3~5년', '5년 이상'];
const STARTS = ['바로 가능', '1개월 안', '협의'];
const SNS_T = ['인스타그램', '틱톡', '유튜브', '블로그', '기타'];
const LANGS = ['ko', 'en', 'ja', 'zh'];
const STAFF_STATUSES = ['new', 'reviewing', 'contacted', 'hired', 'rejected'];
const CLOSED = ['hired', 'rejected'];
const DAY = 24 * 3600 * 1000;
const KEEP_MS = 365 * DAY, DRAFT_MS = 30 * DAY, ORPHAN_MS = DAY;
const ID_RE = /^[-A-Za-z0-9_]{1,40}$/;
const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;               // 32바이트 base64url
const PHOTO_RE = /^[A-Za-z0-9_-]{22}\.(jpg|webp)$/;    // 16바이트 base64url + 확장자
const PHOTO_MAX = 5 * 1024 * 1024;
/* 지원자가 보내는 칸 — 이 밖의 칸은 버린다 (branch 는 11/12 밤에 없앰) */
/* addressDetail = 상세 주소만 따로(사이트가 다시 열 때 칸을 나누려고). address 에는 도로명 + 상세 전체가 들어 있음 */
const TEXT = { name: 40, email: 100, address: 200, addressDetail: 60, portfolio: 300, intro: 2000, why: 1500, hope: 1500 };
/* 여러 줄 칸 — { 줄 칸: [최대 글자 | 허용값 | 모양] }, 최대 줄 수.
   가족은 관계 · 이름만 — 가족의 학력 · 직업 · 재산은 채용절차법 제4조의3 이 묻지 못하게 한다 */
const LISTS = {
  jobs: { max: 10, cols: { place: 60, role: 40, from: YM_RE, to: YM_RE, now: 'bool' }, need: ['place', 'from'] },
  edu: { max: 5, cols: { school: 60, major: 40, status: EDU_ST, year: /^(19|20)\d{2}$/ }, need: ['school', 'status'] },
  family: { max: 8, cols: { rel: FAMILY_REL, name: 20 }, need: ['rel'] },
};
const ENUM = { role: ROLES, license: LICENSES, career: CAREERS, start: STARTS };
/* birthDate · addressDetail — 2026-11-13 사이트 지원서가 생년월일 드롭다운 · 상세 주소 칸으로 바뀜. birthYear 는 예전 지원서 · 필수 칸이라 그대로 같이 받음 */
const FIELDS = ['role', 'name', 'birthYear', 'birthDate', 'phone', 'email', 'address', 'addressDetail', 'sns', 'portfolio', 'license', 'career', 'jobs', 'edu', 'family', 'start', 'intro', 'why', 'hope', 'photo', 'agree', 'lang'];
/* license 는 분야에 따라(checkSubmit), edu 는 1줄 이상, jobs 는 신입이 아니면 1줄 이상, family 는 선택 */
const REQUIRED = ['role', 'name', 'birthYear', 'phone', 'address', 'career', 'start', 'intro', 'why', 'hope', 'photo', 'agree'];

const b64u = (bytes) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const rand = (n) => b64u(crypto.getRandomValues(new Uint8Array(n)));
const rpKey = (photo) => photo.replace(/\./g, ',');   // DB 키에 . 을 못 쓴다
const TOK_HASH_RE = /^[0-9a-f]{64}$/;

export function makeRecruit(deps) {
  const { dbGet, dbPatch, dbPush, dbCas, rlHit, ipKey, ipOf, sameStr, noTag, sha256hex, canManageStaff, botPost, gcs, sendMail } = deps;

  const siteOk = (request, env) => !!(env.SITE_KEY && sameStr(request.headers.get('X-Site-Key') || '', env.SITE_KEY));
  const clientIp = (request) => String(request.headers.get('X-Client-IP') || '').slice(0, 64);
  /* 사이트가 X-Client-IP 를 안 보내면 사이트 서버 IP 하나로 잡히므로 한도를 넉넉히(6배) */
  const rate = async (request, env, tag, max) => {
    const cip = clientIp(request);
    return rlHit(env, tag + await ipKey(cip || ipOf(request)), cip ? max : max * 6, 10 * 60 * 1000);
  };
  const photoPath = (photo) => 'recruit/' + photo;
  const delPhoto = async (env, photo) => {
    if (!photo || !PHOTO_RE.test(photo) || !env.GCS_BUCKET) return;
    await gcs.del(env, photoPath(photo)).catch((e) => console.log('recruit photo del', e && e.message));
  };
  const photoUrl = async (env, photo, sec) => (photo && PHOTO_RE.test(photo) && env.GCS_BUCKET ? gcs.sign(env, photoPath(photo), sec).catch(() => '') : '');

  /* ── 칸 다듬기 ──
     b 에 있는 칸만 본다(없는 칸은 그대로 둠). 빈 값은 null = 지움. 허용값 · 모양이 틀리면 { err: 칸 }.
     임시 저장도 허용값(분야 · 면허 …)과 글자 모양(연락처 글자 · 링크 http(s))은 본다 — 관리 화면이 링크로 그리는 칸이라서. */
  function pickFields(b) {
    const out = {};
    for (const k of FIELDS) {
      if (!(k in b)) continue;
      const v = b[k];
      if (v === null || v === undefined || v === '') { out[k] = null; continue; }
      if (k in ENUM) { if (typeof v !== 'string' || ENUM[k].indexOf(v) < 0) return { err: k }; out[k] = v; continue; }
      if (k in TEXT) {
        if (typeof v !== 'string') return { err: k };
        const s = noTag(v).trim().slice(0, TEXT[k]);
        /* javascript: 같은 주소가 들어가면 관리 화면에서 누르는 순간 스크립트가 돈다 */
        if (k === 'portfolio' && s && !/^https?:\/\/[^\s"'`]+$/i.test(s)) return { err: k };
        out[k] = s || null;
        continue;
      }
      if (k === 'birthDate') {
        if (typeof v !== 'string' || !/^(19|20)\d{2}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/.test(v.trim())) return { err: 'birthYear' };
        out[k] = v.trim();
        continue;
      }
      if (k === 'birthYear') {
        const s = typeof v === 'number' ? String(v) : typeof v === 'string' ? v.trim() : null;
        if (s === null || !/^\d{1,4}$/.test(s)) return { err: k };
        out[k] = s;
        continue;
      }
      if (k === 'phone') {
        if (typeof v !== 'string' || !/^[0-9+\- ]{0,30}$/.test(v.trim())) return { err: k };
        out[k] = v.trim() || null;
        continue;
      }
      if (k === 'sns') {
        if (!Array.isArray(v)) return { err: k };
        const list = [];
        for (const it of v) {
          if (!it || typeof it !== 'object' || SNS_T.indexOf(it.t) < 0) return { err: k };
          const sv = typeof it.v === 'string' ? noTag(it.v).trim().slice(0, 100) : '';
          if (sv) list.push({ t: it.t, v: sv });
        }
        if (list.length > 5) return { err: k };
        out[k] = list.length ? list : null;
        continue;
      }
      if (k in LISTS) {
        const L = LISTS[k];
        if (!Array.isArray(v) || v.length > L.max) return { err: k };
        const list = [];
        for (const it of v) {
          if (!it || typeof it !== 'object') return { err: k };
          const row = {};
          for (const c in L.cols) {
            const rule = L.cols[c], x = it[c];
            if (rule === 'bool') { if (x === true) row[c] = true; continue; }
            if (x === undefined || x === null || x === '') continue;
            if (typeof x !== 'string') return { err: k };
            if (typeof rule === 'number') { const t = noTag(x).trim().slice(0, rule); if (t) row[c] = t; continue; }
            if (Array.isArray(rule)) { if (rule.indexOf(x) < 0) return { err: k }; row[c] = x; continue; }
            if (!rule.test(x.trim())) return { err: k };
            row[c] = x.trim();
          }
          if (!Object.keys(row).length) continue;           // 빈 줄은 버림
          if (L.need.some((c) => !row[c])) return { err: k }; // 반쯤 쓴 줄은 고쳐 달라고
          list.push(row);
        }
        out[k] = list.length ? list : null;
        continue;
      }
      if (k === 'photo') { if (typeof v !== 'string' || !PHOTO_RE.test(v)) return { err: k }; out[k] = v; continue; }
      if (k === 'agree') { if (typeof v !== 'boolean') return { err: k }; out[k] = v; continue; }
      if (k === 'lang') { if (LANGS.indexOf(v) < 0) return { err: k }; out[k] = v; continue; }
    }
    return { out };
  }

  /* 제출 때 — 합친 결과(지금 값 + 바꿀 값)로 필수 칸 · 모양을 본다. 틀린 칸 이름 또는 '' */
  function checkSubmit(r) {
    for (const k of REQUIRED) if (r[k] === undefined || r[k] === null || r[k] === '') return k;
    if (r.agree !== true) return 'agree';
    if (LICENSE_ROLES.indexOf(r.role) >= 0 && !r.license) return 'license';
    if (!Array.isArray(r.edu) || !r.edu.length) return 'edu';
    if (r.career !== '신입' && (!Array.isArray(r.jobs) || !r.jobs.length)) return 'jobs';
    const thisYear = new Date(Date.now() + 9 * 3600e3).getUTCFullYear();
    if (!/^\d{4}$/.test(r.birthYear) || +r.birthYear < 1900 || +r.birthYear > thisYear) return 'birthYear';
    if (String(r.phone).replace(/\D/g, '').length < 7) return 'phone';   // 숫자가 7개는 있어야 연락이 된다(해외 번호도 넉넉히)
    if (r.email && !/^[^\s@"'`]+@[^\s@"'`]+\.[^\s@"'`]+$/.test(r.email)) return 'email';
    return '';
  }

  /* 링크 메일 — 회원 메일과 같은 Resend 길(members.js resendMail). 실패해도 저장은 된 것이다 */
  async function mailLink(env, to, token) {
    const link = String(env.SITE_URL || '').replace(/\/+$/, '') + '/recruit/apply?k=' + token;
    const msg = '이 링크로 이어 쓰거나 고칠 수 있어요. 다른 사람에게 보내지 마세요.';
    const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
    const html = `<div style="font-family:-apple-system,BlinkMacSystemFont,'Apple SD Gothic Neo',sans-serif;max-width:440px;margin:0 auto;padding:32px 20px;color:#111">
<div style="font-size:15px;font-weight:700;letter-spacing:.02em">DAY:MEAN</div>
<p style="margin:28px 0 14px;font-size:14px;line-height:1.6">${esc(msg)}</p>
<p style="margin:0;font-size:14px;line-height:1.6;word-break:break-all"><a href="${esc(link)}" style="color:#111">${esc(link)}</a></p>
</div>`;
    await sendMail(env, to, 'DAY:MEAN 채용 지원서 링크', html, msg + '\n\n' + link).catch((e) => console.log('recruit mail', e && e.message));
  }

  /* ── 사진 올리기 ── */
  async function photo(request, env) {
    if (!siteOk(request, env)) return [403, { ok: false, error: 'key' }];
    if (!env.GCS_BUCKET) return [503, { ok: false, error: 'storage' }];
    const ct = (request.headers.get('Content-Type') || '').split(';')[0].trim();
    const ext = ct === 'image/jpeg' ? 'jpg' : ct === 'image/webp' ? 'webp' : '';
    if (!ext) return [415, { ok: false, error: 'type' }];
    if (!(await rate(request, env, 'rph_', 10))) return [429, { ok: false, error: 'rate' }];
    const buf = await request.arrayBuffer();
    if (buf.byteLength > PHOTO_MAX) return [413, { ok: false, error: 'size' }];
    if (buf.byteLength < 100) return [400, { ok: false, error: 'empty' }];
    /* 머리 바이트가 정말 그 형식인지 — 이름만 사진인 파일을 막는다 */
    const h = new Uint8Array(buf, 0, 12);
    const isJpg = h[0] === 0xff && h[1] === 0xd8 && h[2] === 0xff;
    const isWebp = String.fromCharCode(...h.slice(0, 4)) === 'RIFF' && String.fromCharCode(...h.slice(8, 12)) === 'WEBP';
    if ((ext === 'jpg' && !isJpg) || (ext === 'webp' && !isWebp)) return [415, { ok: false, error: 'type' }];
    const key = rand(16) + '.' + ext;
    await gcs.upload(env, photoPath(key), buf, ct);
    /* 지원서에 붙기 전까지는 '떠도는 사진' — 하루 안에 안 붙으면 purge 가 지운다 */
    await dbPatch(env, '/authSecrets/__rp', { [rpKey(key)]: Date.now() });
    return [200, { ok: true, photo: key }];
  }

  /* ── 임시 저장 · 제출 · 고치기 ── */
  async function save(request, env, ctx) {
    if (!siteOk(request, env)) return [403, { ok: false, error: 'key' }];
    const b = await request.json().catch(() => null);
    if (!b || typeof b !== 'object' || Array.isArray(b)) return [400, { ok: false, error: 'body' }];
    if (!(await rate(request, env, 'ras_', 20))) return [429, { ok: false, error: 'rate' }];
    const submit = b.submit === true;
    const p = pickFields(b);
    if (p.err) return [400, { ok: false, error: p.err }];
    const ch = p.out;

    let token = '', hash = '', id = '', cur = null;
    if (b.token !== undefined && b.token !== null && b.token !== '') {
      if (typeof b.token !== 'string' || !TOKEN_RE.test(b.token)) return [404, { ok: false, error: 'notfound' }];
      hash = await sha256hex(b.token);
      id = await dbGet(env, '/recruitTokens/' + hash);
      cur = typeof id === 'string' && ID_RE.test(id) ? await dbGet(env, '/recruitApps/' + id) : null;
      if (!cur) return [404, { ok: false, error: 'notfound' }];
      if (CLOSED.indexOf(cur.status) >= 0) return [409, { ok: false, error: 'closed' }];
      token = b.token;
    }
    /* 사진 열쇠는 이 창구가 준 것(떠도는 사진 목록에 있는 것)이거나 지금 붙어 있는 것만 — 아무 글자나 붙이지 못하게 */
    if (ch.photo && !(cur && cur.photo === ch.photo)) {
      const up = await dbGet(env, '/authSecrets/__rp/' + rpKey(ch.photo)).catch(() => null);
      if (!up) return [400, { ok: false, error: 'photo' }];
    }
    const merged = { ...(cur || {}), ...ch };
    for (const k of Object.keys(merged)) if (merged[k] === null) delete merged[k];
    /* 이미 제출한 것은 '임시 저장'으로도 필수 칸을 비울 수 없다 — 경영팀이 보는 접수 건이 반쯤 빈 채가 되지 않게 */
    const wasSubmitted = !!(cur && cur.status && cur.status !== 'draft');
    if (submit || wasSubmitted) { const bad = checkSubmit(merged); if (bad) return [400, { ok: false, error: bad }]; }
    const now = Date.now();
    const oldPhoto = cur && cur.photo && cur.photo !== merged.photo ? cur.photo : '';
    let status, firstSubmit = false, newToken = false;

    if (!cur) {
      token = rand(32); hash = await sha256hex(token); newToken = true;
      id = now.toString(36) + rand(6);
      status = submit ? 'new' : 'draft';
      firstSubmit = submit;
      const rec = { ...merged, lang: merged.lang || 'ko', status, createdAt: now, updatedAt: now, source: 'site', tok: hash };
      if (submit) rec.submittedAt = now;
      /* 지원서 · 링크 · 떠도는 사진 정리를 한 번에(하나만 들어가는 일이 없게) */
      const up = { ['recruitApps/' + id]: rec, ['recruitTokens/' + hash]: id };
      if (rec.photo) up['authSecrets/__rp/' + rpKey(rec.photo)] = null;
      await dbPatch(env, '/', up);
    } else {
      const up = {};
      for (const [k, v] of Object.entries(ch)) up['recruitApps/' + id + '/' + k] = v;
      up['recruitApps/' + id + '/updatedAt'] = now;
      if (ch.photo) up['authSecrets/__rp/' + rpKey(ch.photo)] = null;
      if (wasSubmitted) {
        /* 같은 내용으로 다시 누른 것은 '수정함'으로 치지 않는다 — 경영팀 카드에 괜히 표시가 붙지 않게 */
        const same = (k) => JSON.stringify(ch[k] === null ? undefined : ch[k]) === JSON.stringify(cur[k]);
        if (Object.keys(ch).some((k) => !same(k))) up['recruitApps/' + id + '/edited'] = true;
        else delete up['recruitApps/' + id + '/updatedAt'];
        status = cur.status;
      }
      else if (submit) {
        /* 처음 제출 — draft → new 를 ETag 로 잡는다. 두 번 눌러 동시에 와도 알림 · 메일은 한 번 */
        firstSubmit = await dbCas(env, '/recruitApps/' + id + '/status', (s) => (s === 'draft' ? 'new' : undefined)).catch(() => false);
        if (firstSubmit) up['recruitApps/' + id + '/submittedAt'] = now;
        status = 'new';
      } else status = 'draft';
      await dbPatch(env, '/', up);
    }
    if (oldPhoto) await delPhoto(env, oldPhoto);

    if (firstSubmit) {
      /* 경영팀 '업무 알림' 방(+ 푸시)에 한 줄. 연락처는 넣지 않는다 — 알림 미리보기는 잠금 화면에도 뜬다 */
      const note = '🧑‍💼 새 채용 지원 · ' + merged.role + ' · ' + merged.name + '\n\n→ 본사 시스템 \'채용 지원서\'에서 확인해주세요';
      await botPost(env, ctx, note).catch((e) => console.log('apply notify', e && e.message));
    }
    /* 링크 메일 — 링크를 처음 만들 때, 또는 처음 제출할 때(한 번에 만들고 제출하면 한 통) */
    if (merged.email && (newToken || firstSubmit)) await mailLink(env, merged.email, token);
    const res = { ok: true, status };
    if (newToken) res.token = token;
    return [200, res];
  }

  /* 지원자에게 돌려줄 칸 — 경영팀 메모 · 내부 칸(tok · staffAt …)은 뺀다 */
  const PUBLIC_EXTRA = ['status', 'createdAt', 'updatedAt', 'submittedAt', 'edited'];
  async function load(request, env) {
    if (!siteOk(request, env)) return [403, { ok: false, error: 'key' }];
    const b = await request.json().catch(() => ({}));
    const t = b && typeof b.token === 'string' ? b.token : '';
    if (!TOKEN_RE.test(t)) return [404, { ok: false, error: 'notfound' }];
    const id = await dbGet(env, '/recruitTokens/' + await sha256hex(t));
    const a = typeof id === 'string' && ID_RE.test(id) ? await dbGet(env, '/recruitApps/' + id) : null;
    if (!a) return [404, { ok: false, error: 'notfound' }];
    const app = {};
    for (const k of [...FIELDS, ...PUBLIC_EXTRA]) if (a[k] !== undefined) app[k] = a[k];
    app.photoUrl = await photoUrl(env, a.photo, 600);
    return [200, { ok: true, app }];
  }

  /* ── 파기 ── 작성 중 30일 · 제출 1년 · 떠도는 사진 하루. 한 번에 사진 20장까지(요청 하나의 외부 요청 한도 50) */
  async function purge(env) {
    const [all, rp] = await Promise.all([dbGet(env, '/recruitApps'), dbGet(env, '/authSecrets/__rp').catch(() => null)]);
    const now = Date.now(), up = {}, photos = [];
    let n = 0;
    for (const [id, a] of Object.entries(all || {})) {
      if (!a || typeof a !== 'object') continue;
      const old = a.status === 'draft'
        ? now - (+a.updatedAt || +a.createdAt || now) > DRAFT_MS
        : now - (+a.submittedAt || +a.createdAt || now) > KEEP_MS;
      if (!old) continue;
      if (photos.length >= 20) break;
      up['recruitApps/' + id] = null;
      if (typeof a.tok === 'string' && TOK_HASH_RE.test(a.tok)) up['recruitTokens/' + a.tok] = null;
      if (a.photo) photos.push(a.photo);
      n++;
    }
    for (const [k, at] of Object.entries(rp || {})) {
      if (photos.length >= 20) break;
      if (now - (+at || 0) <= ORPHAN_MS) continue;
      up['authSecrets/__rp/' + k] = null;
      photos.push(k.replace(/,/g, '.'));
    }
    /* DB 를 먼저 지우고 사진을 지운다 — 사진만 먼저 사라지면 남은 지원서가 깨진 사진을 가리킨다 */
    if (Object.keys(up).length) await dbPatch(env, '/', up);
    for (const ph of photos) await delPhoto(env, ph);
    return { apps: n, photos: photos.length };
  }

  /* ── 직원 창구 — 경영팀 · 관리자만. 아니면 null(다음 창구로) ── */
  async function route(path, request, env, me, json, origin, url) {
    if (path !== '/recruit/apps' && !path.startsWith('/recruit/apps/')) return null;
    if (!(await canManageStaff(env, me))) return json({ ok: false, error: '권한이 없습니다' }, 403, origin);

    if (path === '/recruit/apps' && request.method === 'GET') {
      /* 1년 · 30일 지난 것은 여는 김에 지운다(하루 한 번 도는 작업이 놓쳐도 보관 기한이 지켜지게) */
      const purged = await purge(env).catch((e) => { console.log('recruit purge', e && e.message); return null; });
      const all = (await dbGet(env, '/recruitApps')) || {};
      const wantDraft = url.searchParams.get('draft') === '1';
      const apps = [];
      let drafts = 0;
      for (const [id, a] of Object.entries(all)) {
        if (!a || typeof a !== 'object') continue;
        const isDraft = a.status === 'draft';
        if (isDraft) drafts++;
        if (isDraft !== wantDraft) continue;
        const { tok, ...rest } = a;
        apps.push({ id, ...rest, memo: typeof a.memo === 'string' ? a.memo : '' });
      }
      apps.sort((x, y) => (+(y.submittedAt || y.createdAt) || 0) - (+(x.submittedAt || x.createdAt) || 0));
      /* 사진은 볼 때만 — 1시간짜리 서명 주소 */
      await Promise.all(apps.map(async (a) => { a.photoUrl = await photoUrl(env, a.photo, 3600); }));
      return json({ ok: true, apps, drafts, purged }, 200, origin);
    }

    if (request.method !== 'POST') return json({ ok: false, error: '없는 기능입니다' }, 404, origin);
    const b = await request.json().catch(() => ({}));
    const id = typeof (b && b.id) === 'string' ? b.id : '';
    if (!ID_RE.test(id)) return json({ ok: false, error: 'id 가 올바르지 않습니다' }, 400, origin);

    if (path === '/recruit/apps/update') {
      const up = {};
      if (b.status !== undefined) {
        if (STAFF_STATUSES.indexOf(b.status) < 0) return json({ ok: false, error: '상태 값이 올바르지 않습니다' }, 400, origin);
        up.status = b.status;
      }
      if (b.memo !== undefined) {
        if (typeof b.memo !== 'string') return json({ ok: false, error: '메모 형식이 올바르지 않습니다' }, 400, origin);
        up.memo = noTag(b.memo).slice(0, 1000);
      }
      if (!Object.keys(up).length) return json({ ok: false, error: '바꿀 내용이 없습니다' }, 400, origin);
      /* PATCH 는 없는 경로도 만들어 버리므로 있는지 먼저 본다(지운 지원서가 메모만 남은 채 되살아나지 않게) */
      const cur = await dbGet(env, '/recruitApps/' + id + '/createdAt');
      if (cur === null) return json({ ok: false, error: '지원서를 찾을 수 없습니다' }, 404, origin);
      /* updatedAt 은 '지원자가 고친 날'(edited 표시)이라 경영팀 손길은 따로 적는다 */
      up.staffAt = Date.now();
      up.staffBy = me.name || String(me.ph || '');
      await dbPatch(env, '/recruitApps/' + id, up);
      return json({ ok: true }, 200, origin);
    }

    if (path === '/recruit/apps/delete') {
      const a = await dbGet(env, '/recruitApps/' + id);
      if (!a) return json({ ok: true }, 200, origin);
      const up = { ['recruitApps/' + id]: null };
      if (typeof a.tok === 'string' && TOK_HASH_RE.test(a.tok)) up['recruitTokens/' + a.tok] = null;
      await dbPatch(env, '/', up);
      await delPhoto(env, a.photo);
      /* 누가 지웠는지만 남긴다 — 지원자 이름 · 연락처는 감사 로그에도 남기지 않는다(파기 요청이므로) */
      await dbPush(env, '/auditLogs', { at: Date.now(), by: String(me.ph || 'admin'), byName: me.name || '', action: 'recruit.delete', target: id }).catch(() => {});
      return json({ ok: true }, 200, origin);
    }

    return json({ ok: false, error: '없는 기능입니다' }, 404, origin);
  }

  /* 사이트 공개 창구 묶음 — [상태, 몸통] 또는 null */
  async function site(path, request, env, ctx) {
    if (path === '/public/apply/photo') return photo(request, env);
    if (path === '/public/apply/save') return save(request, env, ctx);
    if (path === '/public/apply/load') return load(request, env);
    return null;
  }

  return { site, route, purge };
}
