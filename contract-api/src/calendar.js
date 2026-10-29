/**
 * DM 캘린더 — 일정 알림 (서버 쪽).
 *
 * 일정은 앱이 DB 에 바로 쓴다. 서버는 '알림 시각이 된 일정'을 휴대폰으로 보내기만 한다.
 *   /calendar/ev/{cal}/{id}     { t 제목, s 시작일, st 시작시각(HH:mm, 종일이면 ''), e 종료일, et, ad 종일, rr 반복(d|w|m|y), ru 반복 끝,
 *                                 ex:{날짜:1} 반복 중 뺀 날, rem 몇 분 전 알림(없으면 안 보냄), loc, memo, by, bn, at, up }
 *                                 att:{폰: '' 응답 없음 | y 참석 | n 불참 | m 미정} 참석자
 *   /calendar/inv/{폰}/{cal}~{id} = 1   초대받은 일정 목록(그 캘린더를 못 보는 사람도 자기 일정으로 보게)
 *   /calendar/remq/{cal}~{id}   { at 보낼 시각(ms), cal, id }  — 일정마다 다음 알림 하나. 앱이 저장할 때 넣고, 보내면 서버가 다음 반복으로 바꾼다.
 * 캘린더 이름(cal): co 전체 회사 · hq 경영팀 · des~{브랜드} 디자이너 · int~{브랜드} 인턴 · acad~{브랜드} 아카데미 · me~{폰} 개인
 * 받는 사람: 참석자를 정한 일정은 참석자(불참 뺌) + 만든 사람. 아니면 그 캘린더의 '구성원'(경영팀이 모든 브랜드 캘린더를 볼 수는 있어도
 * 알림까지 받지는 않는다). 앱의 calMembers 와 같은 규칙.
 */

const clip = (s, n) => { s = String(s || ''); return s.length > n ? s.slice(0, n) + '…' : s; };
const isActive = (u) => u && u.status !== '퇴사' && u.status !== '대기';
const hasRole = (u, r) => u && (u.role === r || (Array.isArray(u.roles) && u.roles.includes(r)));
const isHq = (u) => u && (u.systemGrade === '경영팀' || u.role === '경영팀' || u.role === '본사경영팀' || u.role === '매니저' || u.brand === 'DM INTERNATIONAL');
const isDes = (u) => hasRole(u, '디자이너') || (u && u.academyRole === '교육자' && !isHq(u));
const isIntern = (u) => hasRole(u, '인턴') || (u && u.academyRole === '인턴');
const isEdu = (u) => u && u.academyRole === '교육자' && !isHq(u);

/* 캘린더 구성원(알림 받는 사람) */
export function calMembers(cal, users) {
  const [kind, arg] = String(cal).split('~');
  const out = [];
  for (const [ph, u] of Object.entries(users || {})) {
    if (!isActive(u)) continue;
    const sameBrand = u.brand === arg;
    const ok = kind === 'co' ? true
      : kind === 'hq' ? isHq(u)
      : kind === 'des' ? sameBrand && isDes(u)
      : kind === 'int' ? sameBrand && (isIntern(u) || isDes(u))
      : kind === 'acad' ? sameBrand && (isIntern(u) || isEdu(u))
      : kind === 'me' ? ph === arg
      : false;
    if (ok) out.push(ph);
  }
  return out;
}

/* ── 날짜 (한국 시간) ── */
const pad = (n) => (n < 10 ? '0' : '') + n;
const ymd = (d) => d.getUTCFullYear() + '-' + pad(d.getUTCMonth() + 1) + '-' + pad(d.getUTCDate());
const parseD = (s) => { const [y, m, d] = String(s).split('-').map(Number); return new Date(Date.UTC(y, m - 1, d)); };
/* n 번째 반복의 시작일. 매월 31일처럼 없는 날은 null(구글 캘린더처럼 건너뜀) */
export function nthDate(s, rr, n) {
  const d = parseD(s);
  if (rr === 'd') d.setUTCDate(d.getUTCDate() + n);
  else if (rr === 'w') d.setUTCDate(d.getUTCDate() + 7 * n);
  else if (rr === 'm' || rr === 'y') {
    const day = d.getUTCDate();
    const t = new Date(Date.UTC(d.getUTCFullYear() + (rr === 'y' ? n : 0), d.getUTCMonth() + (rr === 'm' ? n : 0), 1));
    t.setUTCDate(day);
    if (t.getUTCDate() !== day) return null;
    return ymd(t);
  }
  return ymd(d);
}
/* 그 날 시작 시각(ms). 종일 일정은 오전 9시 기준 */
const startMs = (date, ev) => Date.parse(date + 'T' + (ev.ad || !ev.st ? '09:00' : ev.st) + ':00+09:00');

/* after(ms) 뒤에 오는 첫 알림 { at, date } — 없으면 null */
export function nextReminder(ev, after) {
  if (!ev || ev.rem == null || ev.rem === '' || +ev.rem < 0) return null;
  const rem = +ev.rem * 60000;
  if (!ev.rr) { const at = startMs(ev.s, ev) - rem; return at > after ? { at, date: ev.s } : null; }
  const step = { d: 1, w: 7, m: 31, y: 366 }[ev.rr] || 1;
  /* 지난 반복은 건너뛰고 대충 지금 근처부터 센다 */
  let n = Math.max(0, Math.floor((after - startMs(ev.s, ev)) / (step * 864e5)) - 2);
  for (let i = 0; i < 800; i++, n++) {
    const date = nthDate(ev.s, ev.rr, n);
    if (date === null) continue;
    if (ev.ru && date > ev.ru) return null;
    if (ev.ex && ev.ex[date]) continue;
    const at = startMs(date, ev) - rem;
    if (at > after) return { at, date };
  }
  return null;
}

const whenText = (ev, date) => {
  const [, m, d] = date.split('-').map(Number);
  const wd = '일월화수목금토'[parseD(date).getUTCDay()];
  return m + '월 ' + d + '일(' + wd + ')' + (ev.ad || !ev.st ? ' 종일' : ' ' + ev.st + (ev.et && ev.e === ev.s ? '~' + ev.et : ''));
};

/* 알림 받는 사람 */
export function audience(cal, ev, users) {
  const att = ev && ev.att && typeof ev.att === 'object' ? Object.keys(ev.att) : [];
  if (!att.length) return calMembers(cal, users);
  return [...new Set(att.filter((ph) => ev.att[ph] !== 'n').concat(ev.by ? [String(ev.by)] : []))].filter((ph) => isActive(users[ph]));
}

export function makeCalendar(deps) {
  const { dbGet, dbPut, dbDelete, pushToPhones } = deps;

  /* 1분마다: 알림 시각이 된 일정을 보내고, 반복 일정은 다음 알림을 넣는다 */
  async function runReminders(env) {
    const q = (await dbGet(env, '/calendar/remq').catch(() => null)) || {};
    const now = Date.now();
    const due = Object.entries(q).filter(([, v]) => v && +v.at <= now + 20 * 1000);
    if (!due.length) return 0;
    const users = (await dbGet(env, '/users').catch(() => null)) || {};
    for (const [key, v] of due) {
      await dbDelete(env, '/calendar/remq/' + key);          // 먼저 지운다 — 타이머가 겹쳐도 두 번 보내지 않게
      const ev = await dbGet(env, '/calendar/ev/' + v.cal + '/' + v.id).catch(() => null);
      if (!ev) continue;
      /* 알림 시각이 바뀐 일정(앱이 다시 넣은 것)과 엇갈렸으면 이번 것은 버린다 */
      const cur = nextReminder(ev, +v.at - 60 * 1000);
      if (!cur || Math.abs(cur.at - +v.at) > 60 * 1000) continue;
      if (now - +v.at < 30 * 60 * 1000) {                    // 서버가 오래 멈췄다 깨면 30분 넘게 지난 알림은 보내지 않는다
        const to = audience(v.cal, ev, users);
        await pushToPhones(env, to, {
          title: '일정 · ' + clip(ev.t, 40),
          body: whenText(ev, cur.date) + (ev.loc ? ' · ' + clip(ev.loc, 30) : ''),
          url: './#cal/' + cur.date,
          tag: 'cal-' + v.id,
        }).catch(() => {});
      }
      const nx = nextReminder(ev, +v.at + 1000);
      if (nx) await dbPut(env, '/calendar/remq/' + key, { at: nx.at, cal: v.cal, id: v.id });
    }
    return due.length;
  }

  /* 초대 알림 — 앱이 일정을 저장한 뒤 새로 넣은 참석자에게 보낸다. 일정에 실제로 들어 있는 참석자에게만. */
  async function invite(env, me, body) {
    const cal = String(body.cal || ''), id = String(body.id || '');
    if (!/^[A-Za-z0-9_-]+$/.test(id) || !cal || /[.#$\[\]\/]/.test(cal)) throw new Error('잘못된 요청입니다');
    const ev = await dbGet(env, '/calendar/ev/' + encodeURIComponent(cal) + '/' + id);
    if (!ev) throw new Error('일정이 없습니다');
    const att = ev.att || {};
    const to = (Array.isArray(body.to) ? body.to : []).map(String).filter((ph) => ph in att && ph !== String(me.ph)).slice(0, 300);
    if (!to.length) return { sent: 0 };
    const who = clip(me.name || '', 12);
    await pushToPhones(env, to, {
      title: '일정 초대 · ' + clip(ev.t, 40),
      body: whenText(ev, ev.s) + (who ? ' · ' + who + '님이 초대' : ''),
      url: './#cal/' + ev.s + '/' + encodeURIComponent(cal) + '/' + id,
      tag: 'calinv-' + id,
    }).catch(() => {});
    return { sent: to.length };
  }

  const route = async function route(path, request, env, ctx, me, json, origin) {
    if (!path.startsWith('/cal/')) return null;
    if (request.method !== 'POST') return json({ ok: false, error: 'POST 만 받습니다' }, 405, origin);
    if (me.admin) return json({ ok: false, error: '본인 계정으로 로그인해 주세요' }, 403, origin);
    const body = await request.json().catch(() => ({}));
    try {
      if (path === '/cal/invite') return json({ ok: true, ...(await invite(env, me, body)) }, 200, origin);
      return json({ ok: false, error: '없는 주소입니다' }, 404, origin);
    } catch (e) { return json({ ok: false, error: e.message }, 400, origin); }
  };
  route.runReminders = runReminders;
  return route;
}
