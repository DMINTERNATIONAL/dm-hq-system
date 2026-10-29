/**
 * DM 캘린더 ↔ 구글 캘린더 양방향 연동 (서버).
 *
 * 누가 무엇을 갖나
 *   회사 구글 계정('주인', 경영팀이 연결) — 전체 회사 · 경영팀 · 브랜드 · 새로 만든 캘린더를 이 계정에 하나씩 만들고,
 *       그 캘린더를 볼 수 있는 직원(구글 연결한 사람만)에게 공유한다(ACL — 보기만=reader, 쓰기=writer).
 *       누가 구글에서 고쳐도 이 계정으로 읽어 온다.
 *   직원 본인 구글 계정(원하는 사람만) — 'DM 내 일정' 캘린더를 본인 계정에 만든다(회사 계정 · 경영팀도 못 본다).
 *       공용 캘린더는 본인 캘린더 목록에 넣어 준다(calendarList). 내 일정을 공유받은 사람에게는 본인 계정이 공유한다.
 *
 * 저장 위치
 *   잠긴 경로(서버만) — 캘린더 id 를 직원이 바꿀 수 있으면 남의 진짜 구글 캘린더를 공유받게 꾸밀 수 있다. 그래서 짝 정보도 잠근다.
 *   /authSecrets/__gcal/{폰 | _owner}  { rt 갱신 토큰, email, name, at, atk 접근 토큰, atx 만료, af rt 꼬리(atk 가 이 rt 것인지), bad 끊김 표시 }
 *   /authSecrets/__gcalx/map/{캘린더키} { k 캘린더, gid 구글 캘린더 id, own '_owner'|폰, n 이름, c 색, st 동기화 토큰, pt 마지막으로 읽은 시각,
 *                                        acl{폰:{r 'writer'|'reader', e 이메일}}, sub{폰: 넣어 준 이메일}, echo{구글 일정 id: updated} 우리가 쓴 것 }
 *   /authSecrets/__gcalx/lastAcl       공유를 마지막으로 맞춘 시각
 *   직원이 읽는 곳(앱 화면용)
 *   /calendar/gcal/u/{폰}              { email, name, at, err }   연결 상태
 *   /calendar/gcal/owner               { email, at, by, err }
 *   /calendar/gcal/on/{캘린더키} = 1   연동 중인 캘린더 — 앱은 이 캘린더 일정을 저장할 때 /calendar/gq 에도 적는다
 *   /calendar/gcal/sel/{폰}/{캘린더키} = 0   그 사람이 구글에 안 보이게 끈 캘린더(기본은 전부 켜짐 — 새 캘린더도 자동으로 켜짐)
 *   /calendar/gq/{cal~id} = 시각       앱이 고친 일정(구글로 보낼 것).  _acl = 공유 다시 맞추기(캘린더 멤버를 바꿨을 때)
 *
 * 일정 id
 *   DM 에서 만든 일정 → 구글 id 'dm' + 16진수(DM id)  (구글 id 는 a~v · 0~9 만 쓸 수 있다)
 *   구글에서 만든 일정 → DM id 'G' + 구글 id.  반복 중 하나만 고친 것 'G' + '원래id_20261101T010000Z'
 *
 * 반복 일정
 *   DM 반복(매일 · 매주 · 매월 · 매년, 끝 날짜, 뺀 날)은 그대로 주고받는다. 구글에서 만든 복잡한 반복(격주 · 넷째 목요일 등)은
 *   grr 에 원문을 두고 DM 에서는 첫 일정만 보인다. 구글에서 반복 중 하나만 고치면 DM 에는 원래 반복에서 그 날을 빼고(ex · gmod)
 *   고친 일정을 따로 하나 만든다.
 *
 * 알림 · 참석자는 DM 만 쓴다(구글 일정 알림은 끄고, 참석자는 구글로 보내지 않는다 — 구글이 초대 메일을 보내지 않게).
 *
 * 한 번에 쓰는 외부 요청 수(Cloudflare 무료 50개)를 넘지 않게 S.n 으로 센다. 다 못 한 일은 다음 분에 이어서 한다.
 * DB 쓰기는 끝에 한 번(루트 PATCH, 여러 경로 동시 쓰기)으로 모은다.
 */
import { nextReminder, nthDate, isActive, isHq, isDes, isIntern, isEdu, hasRole, safeKey } from './calendar.js';

const GAPI = 'https://www.googleapis.com/calendar/v3';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const APP = 'https://dminternational.github.io/dm-hq-system/';
const SCOPE_CAL = 'https://www.googleapis.com/auth/calendar';
const COL = { me: '#039BE5', co: '#3F51B5', hq: '#8E24AA', des: ['#D81B60', '#E67C73'], int: ['#0B8043', '#33B679'], acad: ['#F4511E', '#EF6C00'] };
const BUDGET = 34;                 // 1분 작업이 쓰는 외부 요청 상한 — 채팅 · 일정 알림 몫을 남긴다
const ACL_EVERY = 30 * 60 * 1000;  // 직원 직급 · 퇴사 반영을 위해 30분마다 공유를 다시 맞춘다
const DESC = 'DM 캘린더와 자동으로 맞춰지는 캘린더예요. 여기서 만들거나 고쳐도 DM 에 반영돼요.';

const enc = encodeURIComponent;
const te = new TextEncoder();
const clip = (s, n) => { s = String(s == null ? '' : s); return s.length > n ? s.slice(0, n) : s; };
const pad = (n) => (n < 10 ? '0' : '') + n;
const ymd = (d) => d.getUTCFullYear() + '-' + pad(d.getUTCMonth() + 1) + '-' + pad(d.getUTCDate());
const parseD = (s) => { const [y, m, d] = String(s).split('-').map(Number); return new Date(Date.UTC(y, m - 1, d)); };
const addD = (s, n) => { const d = parseD(s); d.setUTCDate(d.getUTCDate() + n); return ymd(d); };
const isDate = (s) => /^\d{4}-\d\d-\d\d$/.test(String(s || ''));
/* 구글 시각(오프셋 포함) → 한국 날짜 · 시각 */
const kst = (iso) => { const d = new Date(Date.parse(iso) + 9 * 3600e3); return { d: ymd(d), t: pad(d.getUTCHours()) + ':' + pad(d.getUTCMinutes()) }; };
const ymdc = (d) => String(d).replace(/-/g, '');
const tail = (rt) => String(rt || '').slice(-12);
const transient = (r) => !r || r.status === 0 || r.status === 429 || r.status >= 500;
const htmlEsc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/* ═══ 권한 — 앱의 calAccess 와 같은 규칙: 'w' 쓰기 · 'r' 보기만 · '' 없음 ═══ */
export function access(k, ph, users, cfg) {
  const u = users[ph];
  if (!isActive(u)) return '';
  const i = k.indexOf('~'), kind = i < 0 ? k : k.slice(0, i), b = i < 0 ? '' : k.slice(i + 1);
  const cf = (cfg || {})[safeKey(k)] || {};
  const mem = (x) => (x === 'w' || x === 'r' ? x : '');
  if (kind === 'me') return k === 'me~' + ph ? 'w' : mem((cf.mem || {})[ph]);
  if (kind === 'x') return cf.by === ph || isHq(u) ? 'w' : mem((cf.mem || {})[ph]);
  if (isHq(u)) return 'w';
  const o = (cf.ov || {})[ph];
  if (o === '-') return '';
  if (o === 'w' || o === 'r') return o;
  if (kind === 'co') return 'r';
  if (u.brand !== b) return '';
  if (kind === 'des') return isDes(u) ? 'w' : hasRole(u, '카운터') ? 'r' : '';
  if (kind === 'int') return isDes(u) ? 'w' : isIntern(u) ? 'r' : '';
  if (kind === 'acad') return isEdu(u) ? 'w' : (isDes(u) || isIntern(u)) ? 'r' : '';
  return '';
}

/* 회사 캘린더 목록 — 앱의 calDefs 와 같다(브랜드 캘린더는 그 브랜드에 디자이너 · 인턴이 있을 때만) */
export function sharedDefs(users, cfg) {
  const brands = {};
  for (const u of Object.values(users || {})) {
    if (!isActive(u) || !u.brand || isHq(u)) continue;
    const f = brands[u.brand] || (brands[u.brand] = {});
    if (isDes(u)) f.des = 1;
    if (isIntern(u)) f.int = 1;
  }
  const out = [{ k: 'co', n: '전체 회사', c: COL.co }, { k: 'hq', n: '경영팀', c: COL.hq }];
  Object.keys(brands).sort().forEach((b, bi) => {
    const f = brands[b], v = bi % 2;
    if (f.des) out.push({ k: 'des~' + b, n: '디자이너 · ' + b, c: COL.des[v] });
    if (f.int) { out.push({ k: 'int~' + b, n: '인턴 · ' + b, c: COL.int[v] }); out.push({ k: 'acad~' + b, n: '아카데미 · ' + b, c: COL.acad[v] }); }
  });
  for (const cf of Object.values(cfg || {})) {
    if (cf && typeof cf.x === 'string' && cf.x.indexOf('x~') === 0 && cf.n) out.push({ k: cf.x, n: clip(cf.n, 60), c: /^#[0-9A-Fa-f]{6}$/.test(cf.c || '') ? cf.c : COL.me });
  }
  return out;
}

/* ═══ 일정 id ═══ */
const hexId = (id) => { let h = 'dm'; for (const ch of String(id)) h += ch.charCodeAt(0).toString(16).padStart(2, '0'); return h; };
export function toGid(id) {
  id = String(id);
  return id[0] === 'G' ? id.slice(1) : hexId(id);
}
/* 구글에서 만든 일정을 다른 캘린더(회사 계정을 바꿔 새로 만든 캘린더)에 다시 넣을 때 —
   원래 id 가 반복 중 하나('원래id_20261101T…Z')라 그대로 못 쓰면 'dm'+16진수(DM id) 로 넣는다 */
const B32 = /^[a-v0-9]{5,1024}$/;
export function toDmId(gid, priv) {
  gid = String(gid);
  if (priv && typeof priv.dmid === 'string' && toGid(priv.dmid) === gid) return priv.dmid;
  const m = /^dm((?:[0-9a-f]{2})+)$/.exec(gid);
  if (m) {
    let s = '';
    for (let i = 0; i < m[1].length; i += 2) s += String.fromCharCode(parseInt(m[1].slice(i, i + 2), 16));
    if (/^[0-9a-z]+$/.test(s) || /^G[A-Za-z0-9_]+$/.test(s)) return s;
  }
  return 'G' + gid;
}

/* ═══ DM → 구글 ═══ */
function recOut(ev, ad) {
  const out = [];
  if (ev.grr && !ev.rr) {
    for (const L of Object.values(ev.grr)) if (typeof L === 'string' && !/^EXDATE/i.test(L)) out.push(L);
  } else if (ev.rr) {
    const f = { d: 'DAILY', w: 'WEEKLY', m: 'MONTHLY', y: 'YEARLY' }[ev.rr];
    if (!f) return [];
    out.push('RRULE:FREQ=' + f + (isDate(ev.ru) ? ';UNTIL=' + ymdc(ev.ru) + (ad ? '' : 'T145959Z') : ''));
  } else return [];
  /* gmod: 구글에서 그 날만 고친 반복 — 구글에는 고친 일정이 따로 있으므로 빼지(EXDATE) 않는다 */
  const gm = ev.gmod || {};
  const ex = Object.keys(ev.ex || {}).filter((d) => isDate(d) && !gm[d]).sort();
  if (ex.length) out.push(ad ? 'EXDATE;VALUE=DATE:' + ex.map(ymdc).join(',')
    : 'EXDATE;TZID=Asia/Seoul:' + ex.map((d) => ymdc(d) + 'T' + String(ev.st).replace(':', '') + '00').join(','));
  return out;
}
/* 고칠 때(PATCH)는 null 로 옛 칸을 지운다. 새로 넣을 때는 null 을 뺀다(stripNull). */
export function toG(ev, cal, id) {
  const ad = !!(ev.ad || !ev.st), s = ev.s, e = isDate(ev.e) && ev.e >= ev.s ? ev.e : ev.s;
  const gOrigin = String(id)[0] === 'G', inst = gOrigin && String(id).indexOf('_') > 0;
  const g = {
    summary: clip(ev.t || '(제목 없음)', 1000), location: ev.loc || '', description: ev.memo || '', status: 'confirmed',
    extendedProperties: { private: { dmid: String(id), dmcal: String(cal) } },
  };
  if (ad) {
    g.start = { date: s, dateTime: null, timeZone: null };
    g.end = { date: addD(e, 1), dateTime: null, timeZone: null };
  } else {
    let et = ev.et || ev.st;
    if (e === s && et < ev.st) et = ev.st;
    g.start = { dateTime: s + 'T' + ev.st + ':00+09:00', timeZone: 'Asia/Seoul', date: null };
    g.end = { dateTime: e + 'T' + et + ':00+09:00', timeZone: 'Asia/Seoul', date: null };
  }
  if (!inst) g.recurrence = recOut(ev, ad);   // 반복 중 하나(인스턴스)에는 반복을 줄 수 없다
  if (!gOrigin) g.reminders = { useDefault: false, overrides: [] };   // 알림은 DM 이 보낸다(두 번 울리지 않게)
  return g;
}
function stripNull(o) {
  if (Array.isArray(o)) return o.map(stripNull);
  if (o && typeof o === 'object') { const r = {}; for (const [k, v] of Object.entries(o)) if (v !== null) r[k] = stripNull(v); return r; }
  return o;
}

/* ═══ 구글 → DM ═══ */
function icalDate(v) {
  const m = /^(\d{4})(\d\d)(\d\d)(?:T(\d\d)(\d\d)(\d\d)(Z)?)?$/.exec(String(v).trim());
  if (!m) return '';
  if (m[7]) return kst(`${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}Z`).d;
  return `${m[1]}-${m[2]}-${m[3]}`;
}
/* 구글 반복 → { rr, ru, ex, grr }. DM 이 그대로 그릴 수 있는 것(매일 · 매주 같은 요일 · 매월 같은 날 · 매년 같은 날)만 rr 로 */
export function recIn(lines, s) {
  const res = { rr: '', ru: '', ex: {}, grr: null };
  if (!Array.isArray(lines) || !lines.length) return res;
  let rule = null, odd = false;
  for (const L of lines) {
    const m = /^([A-Z-]+)([^:]*):(.*)$/i.exec(String(L));
    if (!m) { odd = true; continue; }
    const name = m[1].toUpperCase();
    if (name === 'RRULE') { if (rule !== null) odd = true; rule = m[3]; }
    else if (name === 'EXDATE') { for (const v of m[3].split(',')) { const d = icalDate(v); if (d) res.ex[d] = 1; } }
    else odd = true;
  }
  const keep = () => { res.grr = lines.slice(0, 20).map(String); res.ex = {}; return res; };
  if (rule === null) return keep();
  const p = {};
  for (const kv of rule.split(';')) { const i = kv.indexOf('='); if (i > 0) p[kv.slice(0, i).toUpperCase()] = kv.slice(i + 1); }
  const rr = { DAILY: 'd', WEEKLY: 'w', MONTHLY: 'm', YEARLY: 'y' }[String(p.FREQ || '').toUpperCase()];
  const sd = parseD(s), wd = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'][sd.getUTCDay()];
  if (!rr || odd || (p.INTERVAL && p.INTERVAL !== '1')) return keep();
  for (const k of Object.keys(p)) {
    if (k === 'FREQ' || k === 'UNTIL' || k === 'COUNT' || k === 'INTERVAL' || k === 'WKST') continue;
    if (k === 'BYDAY' && rr === 'w' && String(p.BYDAY).toUpperCase() === wd) continue;
    if (k === 'BYMONTHDAY' && (rr === 'm' || rr === 'y') && +p.BYMONTHDAY === sd.getUTCDate()) continue;
    if (k === 'BYMONTH' && rr === 'y' && +p.BYMONTH === sd.getUTCMonth() + 1) continue;
    return keep();
  }
  res.rr = rr;
  if (p.UNTIL) res.ru = icalDate(p.UNTIL);
  else if (p.COUNT) {   // COUNT 는 뺀 날(EXDATE)도 센다(RFC 5545)
    let got = 0, last = '';
    for (let i = 0; i < 5000 && got < +p.COUNT; i++) { const d = nthDate(s, rr, i); if (d === null) continue; last = d; got++; }
    res.ru = last;
  }
  return res;
}
function plain(h) {
  if (!h) return '';
  return String(h).replace(/<br\s*\/?>/gi, '\n').replace(/<\/(p|div|li)>/gi, '\n').replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&')
    .replace(/\n{3,}/g, '\n\n').trim();
}
/* cur: DM 에 있던 일정(있으면 알림 · 참석자 · 만든 사람은 DM 것을 지킨다). who: { ph, name } 구글에서 만든 사람 */
export function fromG(g, cur, who) {
  const o = {};
  if (g.start && g.start.date) {
    o.ad = 1; o.s = g.start.date; o.st = ''; o.et = '';
    const e = addD((g.end && g.end.date) || g.start.date, -1);
    o.e = e < o.s ? o.s : e;
  } else if (g.start && g.start.dateTime) {
    const a = kst(g.start.dateTime), b = kst((g.end && g.end.dateTime) || g.start.dateTime);
    o.ad = 0; o.s = a.d; o.st = a.t; o.e = b.d < a.d ? a.d : b.d; o.et = b.t;
  } else return null;
  if (!isDate(o.s)) return null;
  o.t = clip(g.summary || '(제목 없음)', 200);
  o.loc = clip(g.location || '', 300);
  o.memo = clip(plain(g.description), 3000);
  const r = recIn(g.recurrence, o.s);
  o.rr = r.rr; o.ru = r.ru;
  if (r.grr) o.grr = r.grr;
  if (o.rr) {
    const gm = cur && cur.gmod && typeof cur.gmod === 'object' ? cur.gmod : null;
    const ex = Object.assign({}, r.ex);
    if (gm) { for (const d of Object.keys(gm)) ex[d] = 1; o.gmod = gm; }
    if (Object.keys(ex).length) o.ex = ex;
  }
  if (cur) { for (const f of ['att', 'rem', 'by', 'bn', 'at']) if (cur[f] !== undefined) o[f] = cur[f]; }
  else { o.by = (who && who.ph) || ''; o.bn = clip((who && who.name) || '구글 캘린더', 40); o.at = Date.parse(g.created) || Date.now(); }
  o.up = Date.parse(g.updated) || Date.now();
  o.ub = '구글 캘린더';
  return o;
}

/* ═══ 상태 묶음 — 한 번의 실행 동안 ═══ */
function mkState(deps, env, budget) {
  const S = {
    n: budget, w: {}, dirty: {}, secDirty: {}, sec: {}, map: {}, q: {}, mail: {}, changed: 0,
    async get(p) { S.n--; return deps.dbGet(env, p); },
    async g(tok, method, path, body) {
      S.n--;
      const h = { Authorization: 'Bearer ' + tok };
      if (body) h['Content-Type'] = 'application/json';
      const r = await fetch(GAPI + path, { method, headers: h, body: body ? JSON.stringify(body) : undefined }).catch(() => null);
      if (!r) return { ok: false, status: 0, j: null };
      const j = r.status === 204 ? null : await r.json().catch(() => null);
      return { ok: r.ok, status: r.status, j };
    },
    mapDel(mk) { delete S.map[mk]; delete S.dirty[mk]; S.w['authSecrets/__gcalx/map/' + mk] = null; S.w['calendar/gcal/on/' + mk] = null; },
  };
  return S;
}
const isBad = (s) => !!(s && s.bad && s.bad === tail(s.rt));
const statusPath = (who) => (who === '_owner' ? 'calendar/gcal/owner' : 'calendar/gcal/u/' + who);

async function refresh(env, rt) {
  const r = await fetch(TOKEN_URL, {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: env.GOOGLE_CLIENT_ID, client_secret: env.GOOGLE_CLIENT_SECRET, refresh_token: rt, grant_type: 'refresh_token' }),
  }).catch(() => null);
  const j = r ? await r.json().catch(() => ({})) : {};
  return { ok: !!(r && r.ok && j.access_token), j };
}
/* 접근 토큰 — 1시간짜리라 받아 둔 걸 쓰고, 끝나 가면 새로 받는다. 구글에서 연결을 끊었으면(invalid_grant) 끊김으로 표시 */
async function gTok(env, S, who) {
  const s = S.sec[who];
  if (!s || !s.rt || isBad(s)) return null;
  if (s.atk && s.af === tail(s.rt) && s.atx > Date.now() + 60000) return s.atk;
  if (S.n < 2) return null;
  S.n--;
  const { ok, j } = await refresh(env, s.rt);
  if (!ok) {
    if (j.error === 'invalid_grant') {
      s.bad = tail(s.rt);
      S.w['authSecrets/__gcal/' + who + '/bad'] = s.bad;
      S.w[statusPath(who) + '/err'] = '구글에서 연결이 끊겼어요. 다시 연결해 주세요';
    }
    return null;
  }
  s.atk = j.access_token; s.atx = Date.now() + (j.expires_in - 60) * 1000; s.af = tail(s.rt);
  S.secDirty[who] = 1;
  return s.atk;
}

/* ═══ 공유 맞추기 — 있어야 할 캘린더 · 공유 · 목록을 실제 구글과 맞춘다. 다 못 하면 false(다음에 이어서) ═══ */
const R = 2;   // 마지막 DB 쓰기 몫
async function reconcile(env, S, users, cfg, sel) {
  /* sel/{폰}/{캘린더키} = 0 — 그 사람이 구글에 안 보이게 끈 캘린더(연결 화면에서 하나씩). 없으면 켜짐 */
  const off = (ph, mk) => !!(sel && sel[ph] && sel[ph][mk] === 0);
  const conn = {};   // 폰 → 이메일 (연결돼 있고 재직 중)
  for (const [who, s] of Object.entries(S.sec)) {
    if (who !== '_owner' && s && s.rt && s.email && !isBad(s) && isActive(users[who])) conn[who] = String(s.email).toLowerCase();
  }
  const own = S.sec._owner, ownOk = !!(own && own.rt && !isBad(own)), ownMail = ownOk ? String(own.email || '').toLowerCase() : '';
  const want = {};
  if (ownOk) {
    for (const d of sharedDefs(users, cfg)) {
      const mem = {};
      let any = false;
      for (const ph of Object.keys(conn)) {
        const a = access(d.k, ph, users, cfg);
        if (!a || off(ph, safeKey(d.k))) continue;
        any = true;
        if (conn[ph] !== ownMail) mem[ph] = a === 'w' ? 'writer' : 'reader';   // 회사 계정 본인은 이미 주인
      }
      if (any) want[safeKey(d.k)] = { k: d.k, n: 'DM ' + d.n, c: d.c, own: '_owner', mem };
    }
  }
  for (const ph of Object.keys(conn)) {
    const k = 'me~' + ph, mk = safeKey(k), cf = cfg[mk] || {}, mem = {};
    for (const [p2, a] of Object.entries(cf.mem || {})) {
      if (p2 !== ph && conn[p2] && conn[p2] !== conn[ph] && (a === 'w' || a === 'r') && !off(p2, mk)) mem[p2] = a === 'w' ? 'writer' : 'reader';
    }
    /* 본인이 '내 일정'을 껐어도 공유받은 사람이 켜 두었으면 캘린더는 남긴다(본인 목록에서만 숨김은 구글 쪽 일) */
    if (!off(ph, mk) || Object.keys(mem).length) want[mk] = { k, n: 'DM 내 일정', c: COL.me, own: ph, mem };
  }

  /* 1) 필요 없어진 캘린더 — 지운 캘린더 · 퇴사 · 아무도 안 보는 캘린더. 주인 연결이 끊겼으면 그대로 둔다(다시 연결하면 이어서) */
  for (const [mk, m] of Object.entries(S.map)) {
    const w = want[mk];
    if (w && w.own === m.own) continue;
    if (isBad(S.sec[m.own])) continue;
    if (S.n < R + 2) return false;
    const tok = m.gid ? await gTok(env, S, m.own) : null;
    if (tok) {
      const r = await S.g(tok, 'DELETE', `/calendars/${enc(m.gid)}`);
      if (!r.ok && transient(r)) return false;
    }
    S.mapDel(mk);
  }

  /* 2) 새로 만들기 — 만들자마자 동기화 토큰을 받고(빈 캘린더라 가볍다), 지금 있는 DM 일정을 보낼 목록에 넣는다 */
  const now = Date.now(), cut = ymd(new Date(now - 90 * 864e5 + 9 * 3600e3));
  for (const [mk, w] of Object.entries(want)) {
    if (S.map[mk]) continue;
    if (S.n < R + 5) return false;
    const tok = await gTok(env, S, w.own);
    if (!tok) continue;
    const r = await S.g(tok, 'POST', '/calendars', { summary: w.n, timeZone: 'Asia/Seoul', description: DESC });
    if (!r.ok || !r.j || !r.j.id) { if (transient(r)) return false; console.log('gcal create', r.status, JSON.stringify(r.j || {}).slice(0, 200)); continue; }
    const m = { k: w.k, gid: r.j.id, own: w.own, n: w.n, c: w.c, acl: {}, sub: {}, at: now, pt: now };
    const l = await S.g(tok, 'GET', `/calendars/${enc(m.gid)}/events?maxResults=50&showDeleted=true`);
    m.st = (l.j && l.j.nextSyncToken) || '';
    await S.g(tok, 'PATCH', `/users/me/calendarList/${enc(m.gid)}?colorRgbFormat=true`, { backgroundColor: w.c, foregroundColor: '#ffffff', defaultReminders: [] });
    S.map[mk] = m; S.dirty[mk] = 1; S.w['calendar/gcal/on/' + mk] = 1;
    const evs = (await S.get('/calendar/ev/' + enc(w.k)).catch(() => null)) || {};
    for (const [id, ev] of Object.entries(evs)) {
      if (!ev || !ev.s) continue;
      const live = ev.rr || ev.grr ? !ev.ru || ev.ru >= cut : (ev.e || ev.s) >= cut;   // 90일 전에 끝난 일정은 안 보낸다
      if (live) S.w['calendar/gq/' + w.k + '~' + id] = now;
      /* gmod(구글에서 그 날만 고친 반복)는 예전 캘린더 얘기 — 새 캘린더엔 고친 일정이 따로 들어가므로 그 날은 반복에서 뺀다 */
      if (live && ev.gmod) S.w['calendar/ev/' + w.k + '/' + id + '/gmod'] = null;
    }
  }

  /* 3) 이름이 바뀐 캘린더(새로 만든 캘린더 이름 고침) */
  for (const [mk, w] of Object.entries(want)) {
    const m = S.map[mk];
    if (!m || m.n === w.n) continue;
    if (S.n < R + 2) return false;
    const tok = await gTok(env, S, m.own);
    if (!tok) continue;
    const r = await S.g(tok, 'PATCH', `/calendars/${enc(m.gid)}`, { summary: w.n });
    if (r.ok) { m.n = w.n; S.dirty[mk] = 1; } else if (transient(r)) return false;
  }

  /* 4) 공유(ACL) — 빠진 사람 · 이메일 바뀐 사람 빼고, 새 멤버 넣고, 권한 바뀐 사람 고친다. 알림 메일은 안 보낸다 */
  for (const [mk, w] of Object.entries(want)) {
    const m = S.map[mk];
    if (!m) continue;
    m.acl = m.acl || {};
    for (const ph of Object.keys(m.acl)) {
      const a = m.acl[ph];
      if (w.mem[ph] && a.e === conn[ph]) continue;
      if (S.n < R + 2) return false;
      const tok = await gTok(env, S, m.own);
      if (!tok) break;
      const r = await S.g(tok, 'DELETE', `/calendars/${enc(m.gid)}/acl/${enc('user:' + a.e)}`);
      if (!r.ok && transient(r)) return false;
      delete m.acl[ph]; S.dirty[mk] = 1;
    }
    for (const [ph, role] of Object.entries(w.mem)) {
      const a = m.acl[ph];
      if (a && a.r === role && a.e === conn[ph]) continue;
      if (S.n < R + 2) return false;
      const tok = await gTok(env, S, m.own);
      if (!tok) break;
      const r = a ? await S.g(tok, 'PATCH', `/calendars/${enc(m.gid)}/acl/${enc('user:' + a.e)}?sendNotifications=false`, { role })
        : await S.g(tok, 'POST', `/calendars/${enc(m.gid)}/acl?sendNotifications=false`, { role, scope: { type: 'user', value: conn[ph] } });
      if (r.ok) { m.acl[ph] = { r: role, e: conn[ph] }; S.dirty[mk] = 1; }
      else if (transient(r)) return false;
      else console.log('gcal acl', r.status, JSON.stringify(r.j || {}).slice(0, 200));
    }
  }

  /* 5) 직원 본인 캘린더 목록 — 공유받은 캘린더를 넣어 준다(안 넣으면 구글 목록에 안 보인다). 빠진 사람은 목록에서 뺀다 */
  for (const [mk, w] of Object.entries(want)) {
    const m = S.map[mk];
    if (!m) continue;
    m.sub = m.sub || {};
    for (const ph of Object.keys(m.sub)) {
      if (w.mem[ph] && m.acl[ph] && m.sub[ph] === conn[ph]) continue;
      if (conn[ph] && m.sub[ph] === conn[ph]) {
        if (S.n < R + 2) return false;
        const tok = await gTok(env, S, ph);
        if (tok) { const r = await S.g(tok, 'DELETE', `/users/me/calendarList/${enc(m.gid)}`); if (!r.ok && transient(r)) return false; }
      }
      delete m.sub[ph]; S.dirty[mk] = 1;
    }
    for (const ph of Object.keys(w.mem)) {
      if (m.sub[ph] || !m.acl[ph]) continue;
      if (S.n < R + 2) return false;
      const tok = await gTok(env, S, ph);
      if (!tok) continue;
      const r = await S.g(tok, 'POST', '/users/me/calendarList?colorRgbFormat=true', { id: m.gid, backgroundColor: w.c, foregroundColor: '#ffffff', selected: true, defaultReminders: [] });
      if (r.ok || r.status === 409) { m.sub[ph] = conn[ph]; S.dirty[mk] = 1; }
      else if (transient(r)) return false;
      else console.log('gcal sub', r.status, JSON.stringify(r.j || {}).slice(0, 200));
    }
  }
  return true;
}

/* ═══ DM → 구글: 고친 일정 하나 보내기. true = 끝(목록에서 지움), false = 다음에 다시 ═══ */
async function pushOne(env, S, key) {
  const i = key.lastIndexOf('~');
  if (i <= 0) return true;
  const cal = key.slice(0, i), id = key.slice(i + 1), mk = safeKey(cal), m = S.map[mk];
  if (!m || !m.gid) return true;                 // 연동 안 하는 캘린더
  if (isBad(S.sec[m.own]) || !S.sec[m.own]) return true;
  const tok = await gTok(env, S, m.own);
  if (!tok) return false;
  if (S.n < 3) return false;
  const ev = await S.get('/calendar/ev/' + enc(cal) + '/' + enc(id));
  const gid = toGid(id), alt = id[0] === 'G' && !B32.test(gid) ? hexId(id) : '', base = `/calendars/${enc(m.gid)}/events/`;
  if (!ev || !ev.s) {
    let r = await S.g(tok, 'DELETE', base + enc(gid));
    if (alt && !r.ok && !transient(r) && S.n >= 2) r = await S.g(tok, 'DELETE', base + enc(alt));
    return r.ok || !transient(r);
  }
  const body = toG(ev, cal, id), ins = (nid) => S.g(tok, 'POST', `/calendars/${enc(m.gid)}/events`, Object.assign(stripNull(body), { id: nid }));
  let r = await S.g(tok, 'PATCH', base + enc(gid), body);
  if (r.status === 404) {
    if (S.n < 3) return false;
    if (!alt) r = await ins(gid);
    else {   // 반복 중 하나였던 일정 — 새 캘린더에서는 따로 선 일정으로(toG 가 반복을 이미 뺐다)
      r = await S.g(tok, 'PATCH', base + enc(alt), body);
      if (r.status === 404) r = await ins(alt);
    }
  }
  if (r.ok && r.j && r.j.updated) { (m.echo = m.echo || {})[r.j.id || gid] = r.j.updated; S.dirty[mk] = 1; return true; }
  if (transient(r)) return false;
  console.log('gcal push', key, r.status, JSON.stringify(r.j || {}).slice(0, 300));
  return true;                                   // 구글이 받지 않는 일정 — 버린다(계속 다시 보내지 않게)
}

/* ═══ 구글 → DM: 캘린더 하나에서 바뀐 것 읽어 오기 ═══ */
async function poll(env, S, mk) {
  const m = S.map[mk];
  const tok = await gTok(env, S, m.own);
  if (!tok) return;
  let items = [], pageToken = '', next = '', st = m.st || '', resets = 0;
  for (;;) {
    if (S.n < 4) return;                         // 다 못 읽었으면 동기화 토큰을 옮기지 않는다(다음에 처음부터)
    const q = new URLSearchParams({ maxResults: '250', showDeleted: 'true' });
    if (st) q.set('syncToken', st);
    if (pageToken) q.set('pageToken', pageToken);
    const r = await S.g(tok, 'GET', `/calendars/${enc(m.gid)}/events?` + q);
    if (r.status === 410 && resets++ < 1) { st = ''; items = []; pageToken = ''; continue; }   // 토큰 만료 — 처음부터
    if (r.status === 404) { S.mapDel(mk); S.w['calendar/gq/_acl'] = Date.now(); return; }      // 구글에서 캘린더를 지웠다 — 다시 만든다
    if (!r.ok || !r.j) return;
    items = items.concat(r.j.items || []);
    if (r.j.nextPageToken) { pageToken = r.j.nextPageToken; continue; }
    next = r.j.nextSyncToken || '';
    break;
  }
  const echo = m.echo || {}, ch = [];
  for (const g of items) {
    if (!g || !g.id || !/^[A-Za-z0-9_]+$/.test(g.id)) continue;
    if (echo[g.id] !== undefined) { const mine = echo[g.id] === g.updated; delete echo[g.id]; if (mine) continue; }   // 우리가 보낸 것
    ch.push(g);
  }
  if (ch.length) {
    const cal = m.k;
    const evs = (await S.get('/calendar/ev/' + enc(cal))) || {};
    const touched = {};
    const curOf = (id) => (id in touched ? touched[id] : evs[id] || null);
    for (const g of ch) {
      const priv = g.extendedProperties && g.extendedProperties.private;
      const id = toDmId(g.id, priv);
      if (S.q[cal + '~' + id]) continue;         // DM 에서 고친 게 아직 안 나갔다 — DM 것이 이긴다
      const cur = curOf(id);
      /* 반복 중 하나만 고치거나 지운 것 */
      let pg = g.recurringEventId || '', od = '';
      if (g.originalStartTime) od = g.originalStartTime.date || (g.originalStartTime.dateTime ? kst(g.originalStartTime.dateTime).d : '');
      if (!pg && g.status === 'cancelled') {     // 지운 인스턴스는 id 만 올 때가 있다: 원래id_20261101(T010000Z)
        const mm = /^([A-Za-z0-9]+)_(\d{8}(?:T\d{6}Z)?)$/.exec(g.id);
        if (mm) { pg = mm[1]; od = icalDate(mm[2]); }
      }
      if (pg) {
        const pid = toDmId(pg, null), parent = curOf(pid);
        if (parent && od && !S.q[cal + '~' + pid]) {
          const p2 = Object.assign({}, parent);
          p2.ex = Object.assign({}, parent.ex || {}, { [od]: 1 });
          const gm = Object.assign({}, parent.gmod || {});
          if (g.status === 'cancelled') delete gm[od]; else gm[od] = 1;
          if (Object.keys(gm).length) p2.gmod = gm; else delete p2.gmod;
          touched[pid] = p2;
        }
        if (g.status === 'cancelled') { if (cur) touched[id] = null; continue; }
        const o = fromG(g, cur, S.mail[String((g.creator || {}).email || '').toLowerCase()] || { name: (g.creator || {}).displayName || (g.creator || {}).email });
        if (o) { o.rr = ''; o.ru = ''; delete o.ex; delete o.gmod; delete o.grr; touched[id] = o; }
        continue;
      }
      if (g.status === 'cancelled') { if (cur) touched[id] = null; continue; }
      const o = fromG(g, cur, S.mail[String((g.creator || {}).email || '').toLowerCase()] || { name: (g.creator || {}).displayName || (g.creator || {}).email });
      if (o) touched[id] = o;
    }
    for (const [id, ev] of Object.entries(touched)) {
      const rk = cal + '~' + id;
      S.w['calendar/ev/' + cal + '/' + id] = ev;
      const nx = ev ? nextReminder(ev, Date.now() + 30000) : null;
      S.w['calendar/remq/' + rk] = nx ? { at: nx.at, cal, id } : null;
      if (!ev) { const old = evs[id]; for (const ph of Object.keys((old && old.att) || {})) S.w['calendar/inv/' + ph + '/' + rk] = null; }
      S.changed++;
    }
  }
  m.echo = echo;
  if (next) m.st = next;
  m.pt = Date.now();
  S.dirty[mk] = 1;
}

/* 모은 DB 쓰기를 한 번에 */
async function flush(deps, env, S) {
  for (const mk of Object.keys(S.dirty)) {
    const m = S.map[mk];
    if (!m) continue;
    const ks = Object.keys(m.echo || {});
    if (ks.length > 150) for (const k of ks.slice(0, ks.length - 150)) delete m.echo[k];
    S.w['authSecrets/__gcalx/map/' + mk] = m;
  }
  /* 연결 비밀은 통째로 덮지 않는다 — 그 사이 다시 연결했으면 새 갱신 토큰을 옛것으로 덮게 된다. af 로 어느 토큰 것인지 표시 */
  for (const who of Object.keys(S.secDirty)) {
    const s = S.sec[who];
    if (!s) continue;
    S.w['authSecrets/__gcal/' + who + '/atk'] = s.atk;
    S.w['authSecrets/__gcal/' + who + '/atx'] = s.atx;
    S.w['authSecrets/__gcal/' + who + '/af'] = s.af;
  }
  if (!Object.keys(S.w).length) return;
  await deps.dbPatch(env, '/', S.w);
}

export function makeGcal(deps) {
  const { dbGet, dbPut, dbPatch, dbDelete, dbCas } = deps;

  async function takeLock(env, S) {
    S.n -= 2;
    const now = Date.now();
    const ok = await dbCas(env, '/authSecrets/__gcalx/lock', (cur) => (cur && now - (+cur.t || 0) < 90000 ? undefined : { t: now })).catch(() => false);
    if (ok) S.w['authSecrets/__gcalx/lock'] = null;
    return ok;
  }

  /* 1분마다(cron) · 앱이 캘린더를 열 때(pull). opts: { budget, acl 공유 맞추기 강제, noAcl, maxPoll, minAge } */
  async function runSync(env, opts = {}) {
    if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET) return { changed: 0 };
    const S = mkState(deps, env, opts.budget || BUDGET);
    const [g, sec, q] = await Promise.all([S.get('/authSecrets/__gcalx'), S.get('/authSecrets/__gcal'), S.get('/calendar/gq')]);
    S.sec = sec || {}; S.map = (g && g.map) || {}; S.q = q || {};
    if (!Object.keys(S.sec).length) {          // 아무도 연결 안 함 — 쌓인 목록만 비운다
      if (q) await dbDelete(env, '/calendar/gq').catch(() => {});
      return { changed: 0 };
    }
    for (const [who, s] of Object.entries(S.sec)) if (who !== '_owner' && s && s.email) S.mail[String(s.email).toLowerCase()] = { ph: who, name: s.name || '' };
    const now = Date.now();
    try {
      /* 공유 맞추기는 한 번에 하나만 — 둘이 동시에 돌면 같은 캘린더를 구글에 두 개 만든다.
         잠금은 '아무도 안 바꿨을 때만 쓰기'로 잡아서 동시에 와도 하나만 된다. 90초 지나면 풀린 걸로 본다 */
      const lk = g && g.lock;
      if (!opts.noAcl && (S.q._acl || opts.acl || !g || !g.lastAcl || now - g.lastAcl > ACL_EVERY) && !(lk && now - (+lk.t || 0) < 90000) && await takeLock(env, S)) {
        /* 처음에 읽은 목록은 잠금 전 것 — 그 사이 앞 사람이 만든 캘린더를 모르고 또 만들지 않게 새로 읽는다 */
        const [users, cfg, sel, map] = await Promise.all([S.get('/users'), S.get('/calendar/cfg'), S.get('/calendar/gcal/sel'), S.get('/authSecrets/__gcalx/map')]);
        S.map = map || {};
        const done = await reconcile(env, S, users || {}, cfg || {}, sel || {});
        if (done) {
          S.w['authSecrets/__gcalx/lastAcl'] = now;
          if (S.q._acl && +S.q._acl <= now && !('calendar/gq/_acl' in S.w)) S.w['calendar/gq/_acl'] = null;
        }
      }
      const keys = Object.keys(S.q).filter((k) => k !== '_acl').sort((a, b) => (+S.q[a] || 0) - (+S.q[b] || 0));
      for (const key of keys) {
        if (S.n < 5) break;
        let done = await pushOne(env, S, key).catch((e) => { console.log('gcal push', e && e.message); return false; });
        if (!done && now - (+S.q[key] || 0) > 864e5) done = true;   // 하루 넘게 못 보낸 건 버린다
        if (done && !(('calendar/gq/' + key) in S.w)) S.w['calendar/gq/' + key] = null;
      }
      const order = Object.keys(S.map).filter((mk) => S.map[mk] && S.map[mk].gid).sort((a, b) => (S.map[a].pt || 0) - (S.map[b].pt || 0));
      let polled = 0;
      for (const mk of order) {
        if (S.n < 6 || polled >= (opts.maxPoll || 4)) break;
        if (now - (S.map[mk].pt || 0) < (opts.minAge || 60000)) continue;
        polled++;
        await poll(env, S, mk).catch((e) => console.log('gcal poll', mk, e && e.message));
      }
    } finally {
      await flush(deps, env, S);
    }
    return { changed: S.changed };
  }

  /* ── 연결 시작 · 끝(OAuth). state 는 세션 토큰과 다른 서명(gcal|)이라 서로 바꿔 쓸 수 없다 ── */
  async function hm(env, s) {
    const k = await crypto.subtle.importKey('raw', te.encode(env.SESSION_SECRET), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    const sig = new Uint8Array(await crypto.subtle.sign('HMAC', k, te.encode('gcal|' + s)));
    let b = ''; for (const x of sig) b += String.fromCharCode(x);
    return btoa(b).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
  }
  async function mkState2(env, payload) {
    const body = btoa(JSON.stringify(payload)).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
    return body + '.' + await hm(env, body);
  }
  async function readState(env, st) {
    const [body, sig] = String(st || '').split('.');
    if (!body || !sig || sig !== await hm(env, body)) return null;
    let p;
    try { p = JSON.parse(atob(body.replace(/-/g, '+').replace(/_/g, '/'))); } catch (_) { return null; }
    return p && p.exp > Date.now() ? p : null;
  }
  const redirectUri = (url) => url.origin + '/gcal/callback';

  async function startUrl(env, url, me, kind) {
    if (!env.GOOGLE_CLIENT_ID) throw new Error('구글 연동 설정이 아직 안 됐어요');
    if (kind === 'owner') {
      const u = await dbGet(env, '/users/' + enc(me.ph));
      if (!isHq(u) || !isActive(u)) throw new Error('회사 구글 계정은 경영팀만 연결할 수 있어요');
    }
    const state = await mkState2(env, { ph: String(me.ph), kind, exp: Date.now() + 15 * 60 * 1000 });
    const q = new URLSearchParams({
      client_id: env.GOOGLE_CLIENT_ID, redirect_uri: redirectUri(url), response_type: 'code',
      scope: 'openid email ' + SCOPE_CAL, access_type: 'offline', prompt: 'consent select_account', include_granted_scopes: 'true', state,
    });
    return 'https://accounts.google.com/o/oauth2/v2/auth?' + q;
  }

  /* 회사 계정의 공용 캘린더를 지운다(주인을 바꾸거나 끊을 때) — 일정은 DM 에 그대로 있다 */
  async function dropShared(env, old) {
    const map = (await dbGet(env, '/authSecrets/__gcalx/map').catch(() => null)) || {};
    const { ok, j } = old && old.rt ? await refresh(env, old.rt) : { ok: false, j: {} };
    const w = {};
    for (const [mk, m] of Object.entries(map)) {
      if (!m || m.own !== '_owner') continue;
      if (ok && m.gid) await fetch(GAPI + '/calendars/' + enc(m.gid), { method: 'DELETE', headers: { Authorization: 'Bearer ' + j.access_token } }).catch(() => {});
      w['authSecrets/__gcalx/map/' + mk] = null; w['calendar/gcal/on/' + mk] = null;
    }
    if (Object.keys(w).length) await dbPatch(env, '/', w);
  }
  async function dropMine(env, ph, old) {
    const mk = safeKey('me~' + ph), m = await dbGet(env, '/authSecrets/__gcalx/map/' + enc(mk)).catch(() => null);
    if (m && m.gid && old && old.rt) {
      const { ok, j } = await refresh(env, old.rt);
      if (ok) await fetch(GAPI + '/calendars/' + enc(m.gid), { method: 'DELETE', headers: { Authorization: 'Bearer ' + j.access_token } }).catch(() => {});
    }
    await dbPatch(env, '/', { ['authSecrets/__gcalx/map/' + mk]: null, ['calendar/gcal/on/' + mk]: null });
  }
  const revoke = (rt) => fetch('https://oauth2.googleapis.com/revoke?token=' + enc(rt), { method: 'POST' }).catch(() => {});

  async function callback(request, env, ctx, url) {
    const err = url.searchParams.get('error');
    if (err) return page(false, err === 'access_denied' ? '연결을 취소했어요. 다시 하려면 DM 앱에서 \'구글 캘린더 연결\'을 눌러 주세요.' : '구글이 연결을 거절했어요 (' + err + ')');
    const st = await readState(env, url.searchParams.get('state'));
    if (!st) return page(false, '연결 시간이 지났어요. DM 앱에서 다시 눌러 주세요.');
    const code = url.searchParams.get('code');
    if (!code) return page(false, '구글에서 받은 값이 없어요. 다시 시도해 주세요.');
    const r = await fetch(TOKEN_URL, {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ code, client_id: env.GOOGLE_CLIENT_ID, client_secret: env.GOOGLE_CLIENT_SECRET, redirect_uri: redirectUri(url), grant_type: 'authorization_code' }),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || !j.access_token) return page(false, '구글 인증을 마치지 못했어요 (' + (j.error || r.status) + '). 다시 시도해 주세요.');
    if (String(j.scope || '').split(' ').indexOf(SCOPE_CAL) < 0) return page(false, '캘린더 권한이 빠졌어요. 다시 연결하면서 \'Google 캘린더\' 항목을 꼭 체크해 주세요.');
    if (!j.refresh_token) return page(false, '구글이 오래 쓸 수 있는 연결 키를 주지 않았어요. 다시 시도해 주세요.');
    let email = '';
    try { email = String(JSON.parse(atob(String(j.id_token).split('.')[1].replace(/-/g, '+').replace(/_/g, '/'))).email || '').toLowerCase(); } catch (_) {}
    if (!email) return page(false, '구글 계정 이메일을 알 수 없어요. 다시 시도해 주세요.');
    const u = await dbGet(env, '/users/' + enc(st.ph)).catch(() => null);
    if (!isActive(u)) return page(false, '연결할 수 없는 계정이에요.');
    const now = Date.now(), sec = { rt: j.refresh_token, email, name: clip(u.nick || u.name || '', 40), at: now, atk: j.access_token, atx: now + ((j.expires_in || 3600) - 60) * 1000, af: tail(j.refresh_token) };
    if (st.kind === 'owner') {
      if (!isHq(u)) return page(false, '회사 구글 계정은 경영팀만 연결할 수 있어요.');
      const old = await dbGet(env, '/authSecrets/__gcal/_owner').catch(() => null);
      if (old && old.rt && String(old.email || '').toLowerCase() !== email) { await dropShared(env, old); revoke(old.rt); }
      await dbPut(env, '/authSecrets/__gcal/_owner', sec);
      await dbPut(env, '/calendar/gcal/owner', { email, at: now, by: String(st.ph) });
    } else {
      const old = await dbGet(env, '/authSecrets/__gcal/' + enc(st.ph)).catch(() => null);
      if (old && old.rt && String(old.email || '').toLowerCase() !== email) { await dropMine(env, st.ph, old); revoke(old.rt); }
      await dbPut(env, '/authSecrets/__gcal/' + enc(st.ph), sec);
      await dbPut(env, '/calendar/gcal/u/' + enc(st.ph), { email, name: u.nick || u.name || '', at: now });
    }
    await dbPut(env, '/calendar/gq/_acl', now);
    /* 바로 한 번 맞춘다 — 몇 초 안에 구글에 캘린더가 생긴다 */
    ctx.waitUntil(runSync(env, { budget: 30, acl: true }).catch((e) => console.log('gcal first', e && e.message)));
    return page(true, (st.kind === 'owner' ? '회사 계정 ' : '') + htmlEsc(email) + ' 에 DM 캘린더를 만들고 있어요. 1~2분 뒤 구글 캘린더에서 확인해 보세요.');
  }

  async function stop(env, me, kind) {
    if (kind === 'owner') {
      const u = await dbGet(env, '/users/' + enc(me.ph));
      if (!isHq(u)) throw new Error('경영팀만 할 수 있어요');
      const old = await dbGet(env, '/authSecrets/__gcal/_owner').catch(() => null);
      if (old) { await dropShared(env, old); if (old.rt) revoke(old.rt); }
      await dbPatch(env, '/', { 'authSecrets/__gcal/_owner': null, 'calendar/gcal/owner': null, 'calendar/gq/_acl': Date.now() });
      return;
    }
    const ph = String(me.ph), old = await dbGet(env, '/authSecrets/__gcal/' + enc(ph)).catch(() => null);
    if (old) { await dropMine(env, ph, old); if (old.rt) revoke(old.rt); }
    await dbPatch(env, '/', { ['authSecrets/__gcal/' + ph]: null, ['calendar/gcal/u/' + ph]: null, 'calendar/gq/_acl': Date.now() });
  }

  let lastPull = 0;
  const route = async function route(path, request, env, ctx, me, json, origin) {
    if (!path.startsWith('/gcal/')) return null;
    if (request.method !== 'POST') return json({ ok: false, error: 'POST 만 받습니다' }, 405, origin);
    if (me.admin) return json({ ok: false, error: '본인 계정으로 로그인해 주세요' }, 403, origin);
    const body = await request.json().catch(() => ({}));
    try {
      const url = new URL(request.url);
      if (path === '/gcal/start') {
        const kind = body.kind === 'owner' ? 'owner' : 'me';
        return json({ ok: true, url: await startUrl(env, url, me, kind) }, 200, origin);
      }
      if (path === '/gcal/stop') { await stop(env, me, body.kind === 'owner' ? 'owner' : 'me'); return json({ ok: true }, 200, origin); }
      /* 캘린더 하나 켜고 끄기 — 내 구글에 보일지. 바로 한 번 맞춘다 */
      if (path === '/gcal/sel') {
        const k = String(body.k || '');
        if (!k || k.length > 120 || k === 'hol') throw new Error('잘못된 캘린더예요');
        const mk = safeKey(k);
        await dbPatch(env, '/', { ['calendar/gcal/sel/' + me.ph + '/' + mk]: body.on ? null : 0, 'calendar/gq/_acl': Date.now() });
        ctx.waitUntil(runSync(env, { budget: 30, acl: true }).catch((e) => console.log('gcal sel', e && e.message)));
        return json({ ok: true }, 200, origin);
      }
      /* 앱이 캘린더를 열 때 — 구글에서 바뀐 걸 바로 가져온다(여럿이 한꺼번에 열어도 15초에 한 번) */
      if (path === '/gcal/pull') {
        if (Date.now() - lastPull < 15000) return json({ ok: true, changed: 0 }, 200, origin);
        lastPull = Date.now();
        const r = await runSync(env, { budget: 30, noAcl: true, maxPoll: 6, minAge: 20000 });
        return json({ ok: true, changed: r.changed }, 200, origin);
      }
      return json({ ok: false, error: '없는 주소입니다' }, 404, origin);
    } catch (e) { return json({ ok: false, error: e.message }, 400, origin); }
  };
  route.callback = callback;
  route.runSync = runSync;
  return route;
}

function page(ok, msg) {
  const html = `<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>DM 캘린더 · 구글 연결</title><style>
:root{--bg:#F8FAFC;--card:#fff;--t:#0F172A;--t2:#475569;--line:#E2E8F0;--ok:#16A34A;--no:#DC2626;--btn:#0F172A;--btnt:#fff}
@media(prefers-color-scheme:dark){:root{--bg:#0B1220;--card:#111827;--t:#F1F5F9;--t2:#94A3B8;--line:#1F2937;--ok:#4ADE80;--no:#F87171;--btn:#F1F5F9;--btnt:#0F172A}}
body{margin:0;background:var(--bg);color:var(--t);font-family:-apple-system,BlinkMacSystemFont,'Apple SD Gothic Neo','Noto Sans KR',sans-serif;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:24px 16px;box-sizing:border-box}
.c{background:var(--card);border:1px solid var(--line);border-radius:20px;padding:32px 24px;max-width:400px;width:100%;text-align:center}
.i{width:56px;height:56px;border-radius:50%;margin:0 auto 16px;display:flex;align-items:center;justify-content:center;font-size:28px;font-weight:800;color:#fff;background:var(--${ok ? 'ok' : 'no'})}
h1{font-size:19px;margin:0 0 10px}p{font-size:14.5px;line-height:1.6;color:var(--t2);margin:0 0 22px;word-break:keep-all}
a,button{display:block;width:100%;height:48px;border-radius:12px;font-size:15px;font-weight:700;font-family:inherit;cursor:pointer;box-sizing:border-box}
a{background:var(--btn);color:var(--btnt);text-decoration:none;line-height:48px}button{margin-top:8px;background:none;border:1px solid var(--line);color:var(--t)}
</style></head><body><div class="c"><div class="i">${ok ? '✓' : '!'}</div><h1>${ok ? '구글 캘린더를 연결했어요' : '연결하지 못했어요'}</h1><p>${ok ? msg : htmlEsc(msg)}</p>
<a href="${APP}#cal">DM 앱으로 돌아가기</a><button onclick="window.close()">이 창 닫기</button></div></body></html>`;
  return new Response(html, { status: ok ? 200 : 400, headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' } });
}
