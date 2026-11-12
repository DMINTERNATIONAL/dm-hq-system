/**
 * 홈페이지(daymean.kr) 고객 회원 — 서버 쪽. (2026-11-12 사용자 결정)
 *
 * 가입 방식은 셋: 이메일+비밀번호 · 카카오 · 구글. 전부 한 회원 목록에 모은다(본사 앱 '홈페이지 회원').
 * 고객 정보라 전부 잠긴 /authSecrets 아래에 둔다 — 직원 토큰으로도 못 읽는다.
 * 본사 앱은 GET /members(경영팀·관리자)로만 본다.
 *
 *   /authSecrets/__mem/u/{mid}    회원 { p email|kakao|google, name, email?, ph?{cc,d,n}, img?, at 가입, last 마지막 로그인, fail?, lockTo? }
 *   /authSecrets/__mem/pw/{mid}   비밀번호 해시 (직원 비밀번호와 같은 PBKDF2). 목록을 읽을 때 같이 딸려 나가지 않게 따로 둔다.
 *   /authSecrets/__mem/ix/{eh}    이메일 → mid. eh = sha256(소문자 이메일) — 이메일의 '.' 은 DB 키에 못 쓴다.
 *   /authSecrets/__mem/pend/{eh}  가입 대기 { name, email, ph, pw(해시), code(해시), exp, tries, lang }  10분
 *   /authSecrets/__mem/rs/{eh}    비밀번호 재설정 대기 { code(해시), exp, tries }  10분
 *   /authSecrets/__mem/rl/{키}    횟수 제한 { t 창 시작, n }
 *
 *   mid = e_{무작위} (이메일) · k_{카카오 회원번호} · g_{구글 sub}
 *
 * 창구는 /site/member/* — 홈페이지 서버(Vercel)만 부른다. 머리글 X-Site-Key 가 비밀 SITE_KEY 와 같아야 한다.
 * 브라우저가 직접 부르지 않으므로 손님 IP 는 홈페이지 서버가 body.ip 로 넘긴다(키를 가진 쪽만 믿는다).
 *
 * 메일은 Resend(https://resend.com) — daymean.kr DNS 가 카페24 라 Cloudflare 메일을 못 쓴다.
 *   비밀 RESEND_API_KEY · 보내는 주소 MAIL_FROM(vars). 키가 없으면 가입·재설정이 'mail' 오류로 멈춘다.
 */

const TTL_CODE = 10 * 60 * 1000;
const MAX_TRIES = 5;          // 코드 하나당 틀릴 수 있는 횟수
const LOCK_FAILS = 10;        // 비밀번호 연속 실패 → 잠깐 잠금
const LOCK_MS = 15 * 60 * 1000;
const HOUR = 3600 * 1000;

const clip = (s, n) => String(s == null ? '' : s).trim().slice(0, n);
const enc = new TextEncoder();
const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
async function sha(s) { return hex(await crypto.subtle.digest('SHA-256', enc.encode(String(s)))); }
const normEmail = (e) => clip(e, 254).toLowerCase();
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const randId = () => {
  const b = crypto.getRandomValues(new Uint8Array(12));
  return 'e_' + [...b].map((x) => x.toString(36).padStart(2, '0')).join('').slice(0, 18);
};
const code6 = () => String(crypto.getRandomValues(new Uint32Array(1))[0] % 1000000).padStart(6, '0');
const LANGS = ['ko', 'en', 'ja', 'zh'];

/* 휴대폰 — 외국 손님도 가입하므로 국가번호를 따로 받는다(사용자 요청).
   { cc 'KR', d '82', n '1012345678' } — n 은 숫자만, 한국식 앞자리 0 은 뗀다(+82 10… 이 맞는 번호). */
function normPhone(p) {
  if (!p || typeof p !== 'object') return null;
  const cc = clip(p.cc, 2).toUpperCase();
  const d = clip(p.d, 4).replace(/\D/g, '');
  let n = clip(p.n, 20).replace(/\D/g, '');
  if (!n) return null;
  if (!/^[A-Z]{2}$/.test(cc) || !/^\d{1,4}$/.test(d)) return 'bad';
  // '+82 10-…' 처럼 국가번호까지 적은 경우
  if (String(p.n).trim().startsWith('+') && n.startsWith(d)) n = n.slice(d.length);
  n = n.replace(/^0+/, '');
  if (n.length < 6 || n.length > 14) return 'bad';
  return { cc, d, n };
}

/* ── 메일 ── */
const MAIL = {
  signup: {
    ko: ['[DAY:MEAN] 가입 인증 코드', '아래 코드를 가입 화면에 입력해 주세요. 10분 동안 쓸 수 있어요.', '직접 가입하신 게 아니라면 이 메일은 무시하셔도 돼요.'],
    en: ['[DAY:MEAN] Your sign-up code', 'Enter this code on the sign-up page. It expires in 10 minutes.', "If you didn't try to sign up, you can ignore this email."],
    ja: ['[DAY:MEAN] 会員登録の認証コード', '下のコードを登録画面に入力してください。有効期限は10分です。', 'お心当たりのない場合は、このメールを無視してください。'],
    zh: ['[DAY:MEAN] 注册验证码', '请在注册页面输入以下验证码，10 分钟内有效。', '如果不是您本人操作，请忽略此邮件。'],
  },
  reset: {
    ko: ['[DAY:MEAN] 비밀번호 재설정 코드', '아래 코드를 비밀번호 재설정 화면에 입력해 주세요. 10분 동안 쓸 수 있어요.', '직접 요청하신 게 아니라면 이 메일은 무시하셔도 돼요. 비밀번호는 바뀌지 않아요.'],
    en: ['[DAY:MEAN] Password reset code', 'Enter this code on the password reset page. It expires in 10 minutes.', "If you didn't ask for this, ignore this email — your password won't change."],
    ja: ['[DAY:MEAN] パスワード再設定コード', '下のコードをパスワード再設定画面に入力してください。有効期限は10分です。', 'お心当たりのない場合は無視してください。パスワードは変更されません。'],
    zh: ['[DAY:MEAN] 重置密码验证码', '请在重置密码页面输入以下验证码，10 分钟内有效。', '如果不是您本人操作，请忽略此邮件，密码不会更改。'],
  },
};
function mailHtml(lines, code) {
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  return `<div style="font-family:-apple-system,BlinkMacSystemFont,'Apple SD Gothic Neo',sans-serif;max-width:440px;margin:0 auto;padding:32px 20px;color:#111">
<div style="font-size:15px;font-weight:700;letter-spacing:.02em">DAY:MEAN</div>
<p style="margin:28px 0 14px;font-size:14px;line-height:1.6">${esc(lines[1])}</p>
<div style="font-size:30px;font-weight:700;letter-spacing:.18em;padding:16px 0;border-top:1px solid #111;border-bottom:1px solid #111;text-align:center">${code}</div>
<p style="margin:18px 0 0;font-size:12px;line-height:1.6;color:#6f6f6a">${esc(lines[2])}</p>
</div>`;
}
/* 채용 지원서 링크 메일(recruit.js)도 같은 길로 보낸다 — 보내는 주소 · 키를 한 곳에서만 관리하려고 */
export async function resendMail(env, to, subject, html, text) {
  if (!env.RESEND_API_KEY) throw Object.assign(new Error('메일 설정 없음'), { code: 'mail' });
  const r = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + env.RESEND_API_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: env.MAIL_FROM || 'DAY:MEAN <no-reply@daymean.kr>', to: [to], subject, html, text }),
  });
  if (!r.ok) {
    console.log('resend', r.status, (await r.text()).slice(0, 300));
    throw Object.assign(new Error('메일 발송 실패'), { code: 'mail' });
  }
}

export function makeMembers({ dbGet, dbPut, dbPatch, dbDelete, dbCas, pwHash, pwVerify, sameStr, sendMail }) {
  const B = '/authSecrets/__mem';
  const send = sendMail || resendMail;

  /* 횟수 제한 — 창(window) 안에서 max 번까지. 넘으면 false. DB 가 잠깐 안 되면 막지 않는다(가입을 못 하는 쪽이 더 나쁘다). */
  async function allow(env, key, max, win) {
    const now = Date.now();
    let ok = true;
    await dbCas(env, `${B}/rl/${key}`, (cur) => {
      if (!cur || now - (+cur.t || 0) > win) return { t: now, n: 1 };
      if ((+cur.n || 0) >= max) { ok = false; return undefined; }
      return { t: cur.t, n: (+cur.n || 0) + 1 };
    }).catch(() => {});
    return ok;
  }
  const ipKey = async (ip) => 'i' + (await sha('ip:' + clip(ip, 64))).slice(0, 24);

  async function mailCode(env, kind, lang, email, code) {
    const l = LANGS.includes(lang) ? lang : 'ko';
    const m = MAIL[kind][l];
    await send(env, email, m[0], mailHtml(m, code), `${m[1]}\n\n${code}\n\n${m[2]}`);
  }

  const pub = (mid, u) => ({ mid, p: u.p, name: u.name || '', img: u.img || '', email: u.email || '', ph: u.ph || null, at: u.at || 0 });

  /* 홈페이지 서버가 부르는 창구. 돌려주는 것: { ok:true, ... } 또는 { ok:false, error:'코드' } */
  async function site(request, env, path) {
    if (!env.SITE_KEY || !sameStr(request.headers.get('X-Site-Key') || '', env.SITE_KEY)) return [403, { ok: false, error: 'key' }];
    const b = await request.json().catch(() => ({}));
    const now = Date.now();
    const lang = LANGS.includes(b.lang) ? b.lang : 'ko';

    /* 가입 1단계 — 입력 확인 · 인증 코드 메일 */
    if (path === '/site/member/signup/start') {
      const email = normEmail(b.email), name = clip(b.name, 40), pw = String(b.pw || '');
      if (!EMAIL_RE.test(email)) return [400, { ok: false, error: 'email' }];
      if (!name) return [400, { ok: false, error: 'name' }];
      if (pw.length < 8 || pw.length > 72) return [400, { ok: false, error: 'pw' }];
      const ph = normPhone(b.ph);
      if (ph === 'bad') return [400, { ok: false, error: 'phone' }];
      if (b.agree !== true) return [400, { ok: false, error: 'agree' }];
      const eh = await sha(email);
      if (await dbGet(env, `${B}/ix/${eh}`)) return [409, { ok: false, error: 'exists' }];
      if (!(await allow(env, await ipKey(b.ip), 20, HOUR))) return [429, { ok: false, error: 'rate' }];
      if (!(await allow(env, 's' + eh.slice(0, 24), 5, HOUR))) return [429, { ok: false, error: 'rate' }];
      const code = code6();
      await dbPut(env, `${B}/pend/${eh}`, {
        name, email, ph: ph || null, pw: await pwHash(pw), code: await sha(eh + ':' + code),
        exp: now + TTL_CODE, tries: 0, lang,
      });
      await mailCode(env, 'signup', lang, email, code);
      return [200, { ok: true }];
    }

    /* 가입 2단계 — 코드 확인 → 회원 만들기 */
    if (path === '/site/member/signup/verify') {
      const email = normEmail(b.email), eh = await sha(email), code = clip(b.code, 6);
      const pend = await dbGet(env, `${B}/pend/${eh}`);
      if (!pend || pend.exp < now) return [400, { ok: false, error: 'expired' }];
      if ((+pend.tries || 0) >= MAX_TRIES) return [429, { ok: false, error: 'tries' }];
      if (!sameStr(pend.code, await sha(eh + ':' + code))) {
        await dbPatch(env, `${B}/pend/${eh}`, { tries: (+pend.tries || 0) + 1 });
        return [400, { ok: false, error: 'code' }];
      }
      const mid = randId();
      /* 이메일 하나에 회원 하나 — 두 창에서 동시에 확인해도 하나만 만들어지게 ETag 로 잡는다 */
      const took = await dbCas(env, `${B}/ix/${eh}`, (cur) => (cur ? undefined : mid));
      if (!took) return [409, { ok: false, error: 'exists' }];
      await dbPut(env, `${B}/pw/${mid}`, pend.pw);
      const u = { p: 'email', name: pend.name, email: pend.email, at: now, last: now };
      if (pend.ph) u.ph = pend.ph;
      await dbPut(env, `${B}/u/${mid}`, u);
      await dbDelete(env, `${B}/pend/${eh}`).catch(() => {});
      return [200, { ok: true, member: pub(mid, u) }];
    }

    /* 이메일 로그인 */
    if (path === '/site/member/login') {
      const email = normEmail(b.email), pw = String(b.pw || '');
      if (!email || !pw) return [400, { ok: false, error: 'bad' }];
      if (!(await allow(env, 'l' + (await ipKey(b.ip)).slice(1), 30, HOUR))) return [429, { ok: false, error: 'rate' }];
      const eh = await sha(email);
      const mid = await dbGet(env, `${B}/ix/${eh}`);
      const u = mid ? await dbGet(env, `${B}/u/${mid}`) : null;
      if (!u) return [401, { ok: false, error: 'bad' }];
      if (u.lockTo && u.lockTo > now) return [429, { ok: false, error: 'locked' }];
      const ok = await pwVerify(await dbGet(env, `${B}/pw/${mid}`), pw);
      if (!ok) {
        const fail = (+u.fail || 0) + 1;
        await dbPatch(env, `${B}/u/${mid}`, fail >= LOCK_FAILS ? { fail: 0, lockTo: now + LOCK_MS } : { fail });
        return [401, { ok: false, error: 'bad' }];
      }
      await dbPatch(env, `${B}/u/${mid}`, { last: now, fail: null, lockTo: null });
      return [200, { ok: true, member: pub(mid, u) }];
    }

    /* 비밀번호 찾기 1단계 — 가입된 이메일이면 코드 메일. 가입 여부는 알려주지 않는다(남의 이메일로 회원인지 떠보지 못하게). */
    if (path === '/site/member/reset/start') {
      const email = normEmail(b.email);
      if (!EMAIL_RE.test(email)) return [400, { ok: false, error: 'email' }];
      if (!(await allow(env, await ipKey(b.ip), 20, HOUR))) return [429, { ok: false, error: 'rate' }];
      const eh = await sha(email);
      const mid = await dbGet(env, `${B}/ix/${eh}`);
      if (!mid) return [200, { ok: true }];
      if (!(await allow(env, 's' + eh.slice(0, 24), 5, HOUR))) return [429, { ok: false, error: 'rate' }];
      const code = code6();
      await dbPut(env, `${B}/rs/${eh}`, { code: await sha(eh + ':r:' + code), exp: now + TTL_CODE, tries: 0 });
      await mailCode(env, 'reset', lang, email, code);
      return [200, { ok: true }];
    }

    /* 비밀번호 찾기 2단계 — 코드 + 새 비밀번호 */
    if (path === '/site/member/reset/verify') {
      const email = normEmail(b.email), eh = await sha(email), code = clip(b.code, 6), pw = String(b.pw || '');
      if (pw.length < 8 || pw.length > 72) return [400, { ok: false, error: 'pw' }];
      const rs = await dbGet(env, `${B}/rs/${eh}`);
      if (!rs || rs.exp < now) return [400, { ok: false, error: 'expired' }];
      if ((+rs.tries || 0) >= MAX_TRIES) return [429, { ok: false, error: 'tries' }];
      if (!sameStr(rs.code, await sha(eh + ':r:' + code))) {
        await dbPatch(env, `${B}/rs/${eh}`, { tries: (+rs.tries || 0) + 1 });
        return [400, { ok: false, error: 'code' }];
      }
      const mid = await dbGet(env, `${B}/ix/${eh}`);
      const u = mid ? await dbGet(env, `${B}/u/${mid}`) : null;
      if (!u) return [400, { ok: false, error: 'expired' }];
      await dbPut(env, `${B}/pw/${mid}`, await pwHash(pw));
      await dbPatch(env, `${B}/u/${mid}`, { last: now, fail: null, lockTo: null });
      await dbDelete(env, `${B}/rs/${eh}`).catch(() => {});
      return [200, { ok: true, member: pub(mid, u) }];
    }

    /* 카카오·구글 로그인 때마다 — 처음이면 회원으로 넣고, 아니면 이름·사진·마지막 로그인만 갱신 */
    if (path === '/site/member/oauth') {
      const p = b.p === 'google' ? 'google' : b.p === 'kakao' ? 'kakao' : '';
      const id = clip(b.id, 64);
      if (!p || !/^[A-Za-z0-9_-]{1,64}$/.test(id)) return [400, { ok: false, error: 'bad' }];
      const mid = (p === 'kakao' ? 'k_' : 'g_') + id;
      const cur = await dbGet(env, `${B}/u/${mid}`);
      const patch = { p, name: clip(b.name, 40), img: clip(b.img, 500), last: now };
      if (!cur) patch.at = now;
      await dbPatch(env, `${B}/u/${mid}`, patch);
      return [200, { ok: true, mid, isNew: !cur }];
    }

    /* 내 정보 (마이 페이지) */
    if (path === '/site/member/get') {
      const mid = clip(b.mid, 80);
      if (!/^[ekg]_[A-Za-z0-9_-]+$/.test(mid)) return [400, { ok: false, error: 'bad' }];
      const u = await dbGet(env, `${B}/u/${mid}`);
      if (!u) return [404, { ok: false, error: 'gone' }];
      return [200, { ok: true, member: pub(mid, u) }];
    }

    /* 회원 탈퇴 — 바로 지운다(개인정보처리방침: 탈퇴 즉시 파기) */
    if (path === '/site/member/delete') {
      const mid = clip(b.mid, 80);
      if (!/^[ekg]_[A-Za-z0-9_-]+$/.test(mid)) return [400, { ok: false, error: 'bad' }];
      const u = await dbGet(env, `${B}/u/${mid}`);
      const w = { [`authSecrets/__mem/u/${mid}`]: null, [`authSecrets/__mem/pw/${mid}`]: null };
      if (u && u.email) w[`authSecrets/__mem/ix/${await sha(normEmail(u.email))}`] = null;
      await dbPatch(env, '/', w);
      return [200, { ok: true }];
    }

    return [404, { ok: false, error: 'not found' }];
  }

  /* 본사 앱 '홈페이지 회원' — 경영팀·관리자만(권한은 index.js 가 먼저 본다). 비밀번호 해시는 다른 곳이라 안 딸려 나간다. */
  async function list(env) {
    const all = (await dbGet(env, `${B}/u`)) || {};
    const out = Object.keys(all).map((mid) => {
      const u = all[mid] || {};
      return { mid, p: u.p || '', name: u.name || '', email: u.email || '', ph: u.ph || null, at: u.at || 0, last: u.last || 0 };
    });
    out.sort((a, b) => b.at - a.at);
    return out;
  }

  return { site, list };
}
