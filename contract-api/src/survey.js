/**
 * DM 소통 — 설문 (구글 폼처럼). 서버 쪽.
 *
 *   /surveys/{sid}     { v:2, t, desc, by, bn, at, up, st draft|open|closed, sent, end, anon, tp:{폰:1} 받는 사람, co:{폰:1} 공동 작업자,
 *                        qs:[항목], set:{설정}, th:{c 색, img 머리글 사진}, rel 퀴즈 점수 공개함 }
 *     항목  { id, k, t, d 설명, req, o 선택지, oth '기타', shuf 선택지 섞기, go[선택지별 이동할 섹션 id | '_end'], r 행,
 *             lo hi ll hl 배율, mx 파일 수, val 응답 확인, g1 열마다 하나, pt 배점, img, url, nx 이 섹션 다음 }
 *     종류  질문 short long one many drop file scale rating grid cgrid date time  ·  질문 아님 text img video sec(섹션 시작)
 *     설정  edit 제출 후 수정 · prog 진행률 · shuf 질문 순서 섞기 · msg 확인 메시지 · pub 응답자에게 요약 공개 · notify 새 응답 알림 ·
 *           quiz 퀴즈 · rel now|later · show{miss,ans,pt} · req 새 질문 기본 필수 · nx0 첫 섹션 다음
 *   /surveyAns/{sid}/{폰}          실명 응답 { a:{qid:값}, at, sc:{qid:자동 점수}, man:{qid:직접 준 점수} }
 *   /surveyAns/{sid}/_anon/{rid}   익명 응답 (시각 · 사람 없음)  ·  /surveyAns/{sid}/_who/{폰}=1 응답 여부만
 *   /surveyAns/{sid}/_key/{qid}    퀴즈 정답 { ans, fb:{ok,no} } — /surveys 는 직원이 읽을 수 있어서 정답은 잠긴 곳에 둔다
 *   /surveyTpl/{tid}               양식(정답 빼고)  ·  /surveyAns/_tplkey/{tid} 그 양식의 정답
 * 예전(v1) 설문은 qs 에 id 가 없고 응답이 배열 — norm()/normA() 로 같은 모양으로 바꿔 읽는다.
 */

const MANAGER_GRADES = ['경영팀', '관리자'];
const OWNER_PHONES = ['01042885562', '01082470187'];
const nowMs = () => Date.now();
const clip = (s, n) => { s = String(s == null ? '' : s); return s.length > n ? s.slice(0, n) : s; };
const nameOf = (u) => (u && (u.nick || u.name)) || '';
const isActive = (u) => u && u.status !== '퇴사' && u.status !== '대기';
const isMgr = (ph, u) => OWNER_PHONES.includes(String(ph)) || (u && (MANAGER_GRADES.includes(u.systemGrade) || (!u.systemGrade && u.branch === '본사' && MANAGER_GRADES.includes(u.role))));
const isHq = (ph, u) => OWNER_PHONES.includes(String(ph)) || (u && (u.systemGrade === '경영팀' || u.role === '경영팀' || u.role === '본사경영팀'));
const isEdu = (u) => u && (u.academyRole === '교육자' || u.role === '스탭장');
const id36 = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
const okId = (s) => /^[A-Za-z0-9_-]{1,40}$/.test(String(s || ''));
const KEY_RE = /^[po]\/[A-Za-z0-9_-]+\/[A-Za-z0-9._-]+$/;
const isInt = Number.isInteger;

export const QKINDS = ['short', 'long', 'one', 'many', 'drop', 'file', 'scale', 'rating', 'grid', 'cgrid', 'date', 'time'];
const BLOCKS = ['text', 'img', 'video', 'sec'];
export const isQ = (q) => QKINDS.includes(q.k);

/* 예전 설문 → 지금 모양 */
export function norm(sv) {
  if (!sv || sv.v === 2) return sv;
  const qs = (sv.qs || []).map((q, i) => {
    const n = { id: 'i' + i, k: q.k, t: q.t, req: !!q.req };
    if (q.o) n.o = q.o; if (q.r) n.r = q.r;
    if (q.k === 'score') Object.assign(n, { k: 'scale', lo: 1, hi: 5, ll: '전혀 아니다', hl: '매우 그렇다' });
    if (q.k === 'photo') Object.assign(n, { k: 'file', mx: 1, img: 1 });
    return n;
  });
  return { ...sv, v: 2, qs, set: { edit: !sv.anon } };
}
export function normA(sv, a) {
  if (!Array.isArray(a)) return a || {};
  const o = {};
  (sv.qs || []).forEach((q, i) => { let v = a[i]; if (v == null) return; if ((q.k === 'photo' || q.k === 'file') && typeof v === 'string') v = [{ k: v, n: '사진' }]; o['i' + i] = v; });
  return o;
}

/* 섹션 나누기 — sec 항목이 새 섹션의 시작. 첫 섹션 id 는 '_0' */
export function sections(sv) {
  const out = [{ id: '_0', nx: (sv.set || {}).nx0 || '', items: [] }];
  for (const q of sv.qs || []) {
    if (q.k === 'sec') out.push({ id: q.id, nx: q.nx || '', items: [] });
    else out[out.length - 1].items.push(q);
  }
  return out;
}
/* 답에 따라 지나가는 섹션 (구글 폼 '답변을 기준으로 섹션 이동') — 앱의 svPath 와 같은 규칙 */
export function path(sv, a) {
  const secs = sections(sv), seen = [];
  let i = 0;
  while (i < secs.length && seen.length < 200) {
    seen.push(i);
    const s = secs[i]; let dest = s.nx || '';
    for (const q of s.items) if ((q.k === 'one' || q.k === 'drop') && Array.isArray(q.go) && isInt(a[q.id]) && q.go[a[q.id]]) dest = q.go[a[q.id]];
    if (dest === '_end') break;
    if (dest) { const j = secs.findIndex((x) => x.id === dest); if (j < 0) i++; else if (seen.includes(j)) break; else i = j; }
    else i++;
  }
  return seen.map((n) => secs[n]);
}

/* 응답 확인(구글 폼 '응답 확인') — 맞지 않으면 안내 문구 */
function checkVal(q, v) {
  const val = q.val; if (!val || v == null || v === '' || (Array.isArray(v) && !v.length)) return '';
  const msg = val.msg || '';
  const a = val.a, b = val.b;
  if (val.t === 'num') {
    const n = Number(String(v).trim()); if (String(v).trim() === '' || Number.isNaN(n)) return msg || '숫자를 입력해 주세요';
    const ok = { gt: n > a, ge: n >= a, lt: n < a, le: n <= a, eq: n === +a, ne: n !== +a, bt: n >= a && n <= b, nb: n < a || n > b, int: isInt(n), num: true }[val.op];
    return ok ? '' : (msg || ({ gt: a + '보다 큰', ge: a + ' 이상인', lt: a + '보다 작은', le: a + ' 이하인', eq: a + '와(과) 같은', ne: a + '이(가) 아닌', bt: a + '~' + b + ' 사이의', nb: a + '~' + b + ' 밖의', int: '정수를' }[val.op] || '') + (val.op === 'int' ? ' ' : ' 숫자를 ') + '입력해 주세요');
  }
  if (val.t === 'txt') {
    const s = String(v);
    const ok = { has: s.includes(a || ''), not: !s.includes(a || ''), email: /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s), url: /^https?:\/\/\S+\.\S+/.test(s) }[val.op];
    return ok ? '' : (msg || '형식에 맞게 입력해 주세요');
  }
  if (val.t === 'len') {
    const L = String(v).length; const ok = val.op === 'max' ? L <= a : L >= a;
    return ok ? '' : (msg || (val.op === 'max' ? `${a}자 이하로 입력해 주세요` : `${a}자 이상 입력해 주세요`));
  }
  if (val.t === 're') {
    let r; try { r = new RegExp(String(a || '')); } catch (e) { return ''; }
    const s = String(v); const ok = { has: r.test(s), not: !r.test(s), match: new RegExp('^(?:' + a + ')$').test(s), nomatch: !new RegExp('^(?:' + a + ')$').test(s) }[val.op];
    return ok ? '' : (msg || '형식에 맞게 입력해 주세요');
  }
  if (val.t === 'cnt' && Array.isArray(v)) {
    const n = v.length; const ok = { ge: n >= a, le: n <= a, eq: n === +a }[val.op];
    return ok ? '' : (msg || { ge: `${a}개 이상 골라 주세요`, le: `${a}개 이하로 골라 주세요`, eq: `${a}개를 골라 주세요` }[val.op]);
  }
  return '';
}
const empty = (q, v) => v == null || v === '' || (Array.isArray(v) && (!v.length || ((q.k === 'grid' || q.k === 'cgrid') && v.every((x) => x == null || (Array.isArray(x) && !x.length)))));

/* 한 질문의 답 다듬기 — 맞지 않는 값은 버린다 */
function clean(q, v) {
  const no = (q.o || []).length;
  switch (q.k) {
    case 'short': return v == null ? null : clip(v, 500).trim() || null;
    case 'long': return v == null ? null : clip(v, 5000).trim() || null;
    case 'one': if (isInt(v) && v >= 0 && v < no) return v; if (q.oth && typeof v === 'string' && v.trim()) return clip(v, 200).trim(); return null;
    case 'drop': return isInt(v) && v >= 0 && v < no ? v : null;
    case 'many': { if (!Array.isArray(v)) return null; const out = [...new Set(v.filter((n) => isInt(n) && n >= 0 && n < no))]; const o = v.find((x) => typeof x === 'string' && x.trim()); if (q.oth && o) out.push(clip(o, 200).trim()); return out.length ? out : null; }
    case 'file': return Array.isArray(v) ? v.filter((f) => f && KEY_RE.test(String(f.k || ''))).slice(0, Math.min(10, q.mx || 1)).map((f) => ({ k: String(f.k), n: clip(f.n || '파일', 120) })) : null;
    case 'scale': return isInt(v) && v >= (q.lo ?? 1) && v <= (q.hi ?? 5) ? v : null;
    case 'rating': return isInt(v) && v >= 1 && v <= (q.hi || 5) ? v : null;
    case 'grid': return Array.isArray(v) ? (q.r || []).map((_, ri) => (isInt(v[ri]) && v[ri] >= 0 && v[ri] < no ? v[ri] : null)) : null;
    case 'cgrid': return Array.isArray(v) ? (q.r || []).map((_, ri) => (Array.isArray(v[ri]) ? [...new Set(v[ri].filter((n) => isInt(n) && n >= 0 && n < no))] : [])) : null;
    case 'date': return /^\d{4}-\d\d-\d\d$/.test(String(v || '')) ? String(v) : null;
    case 'time': return /^\d\d:\d\d$/.test(String(v || '')) ? String(v) : null;
  }
  return null;
}

/* 자동 채점 — 정답이 있는 객관식 · 체크박스 · 드롭다운 · 단답만. 나머지는 직접 점수를 준다 */
export function autoScore(q, v, key) {
  if (!q.pt || !key || key.ans == null || v == null) return null;
  if (q.k === 'one' || q.k === 'drop') return v === key.ans ? q.pt : 0;
  if (q.k === 'many') { const a = (Array.isArray(key.ans) ? key.ans : []).slice().sort(); const b = (Array.isArray(v) ? v.filter(isInt) : []).slice().sort(); return a.length === b.length && a.every((x, i) => x === b[i]) && !v.some((x) => typeof x === 'string') ? q.pt : 0; }
  if (q.k === 'short') { const s = String(v).trim().toLowerCase(); return (Array.isArray(key.ans) ? key.ans : [key.ans]).some((x) => String(x).trim().toLowerCase() === s) ? q.pt : 0; }
  return null;
}
export function total(sv, rec) {
  let got = 0, max = 0, pending = 0;
  for (const q of sv.qs || []) {
    if (!isQ(q) || !q.pt) continue;
    max += q.pt;
    const m = rec.man && rec.man[q.id]; const s = rec.sc && rec.sc[q.id];
    if (m != null) got += +m; else if (s != null) got += +s; else if (!empty(q, (rec.a || {})[q.id])) pending++;
  }
  return { got, max, pending };
}

/* 들어온 설문 정의 다듬기 */
function cleanItem(q, ids) {
  const k = QKINDS.includes(q.k) || BLOCKS.includes(q.k) ? q.k : 'short';
  let id = okId(q.id) ? String(q.id) : 'q' + id36(); while (ids.has(id)) id = 'q' + id36(); ids.add(id);
  const n = { id, k, t: clip(q.t, 300).trim() };
  if (q.d) n.d = clip(q.d, 2000);
  if (k === 'sec') { if (q.nx) n.nx = clip(q.nx, 40); return n; }
  if (k === 'img') { if (KEY_RE.test(String(q.img || ''))) n.img = q.img; return n; }
  if (k === 'video') { n.url = clip(q.url, 300); return n; }
  if (k === 'text') return n;
  n.req = !!q.req;
  if (['one', 'many', 'drop', 'grid', 'cgrid'].includes(k)) n.o = (Array.isArray(q.o) ? q.o : []).map((o) => clip(o, 200).trim()).slice(0, 60);
  if (k === 'grid' || k === 'cgrid') n.r = (Array.isArray(q.r) ? q.r : []).map((o) => clip(o, 120).trim()).slice(0, 30);
  if ((k === 'one' || k === 'many') && q.oth) n.oth = 1;
  if (['one', 'many', 'drop', 'grid', 'cgrid'].includes(k) && q.shuf) n.shuf = 1;
  if ((k === 'one' || k === 'drop') && Array.isArray(q.go) && q.go.some(Boolean)) n.go = n.o.map((_, i) => clip(q.go[i] || '', 40));
  if (k === 'scale') { n.lo = q.lo === 0 ? 0 : 1; n.hi = Math.min(10, Math.max(2, q.hi | 0 || 5)); n.ll = clip(q.ll, 40); n.hl = clip(q.hl, 40); }
  if (k === 'rating') n.hi = Math.min(10, Math.max(3, q.hi | 0 || 5));
  if (k === 'file') { n.mx = [1, 5, 10].includes(q.mx | 0) ? q.mx | 0 : 1; if (q.img) n.img = 1; }
  if (k === 'grid' && q.g1) n.g1 = 1;
  if (q.val && typeof q.val === 'object' && ['num', 'txt', 'len', 're', 'cnt'].includes(q.val.t)) n.val = { t: q.val.t, op: clip(q.val.op, 10), a: q.val.t === 'txt' || q.val.t === 're' ? clip(q.val.a, 200) : +q.val.a || 0, b: +q.val.b || 0, msg: clip(q.val.msg, 120) };
  if (+q.pt > 0) n.pt = Math.min(1000, Math.round(+q.pt));
  return n;
}
function cleanKey(qs, key) {
  const out = {};
  for (const q of qs) {
    const k = key && key[q.id]; if (!k || !isQ(q)) continue;
    const o = {};
    if ((q.k === 'one' || q.k === 'drop') && isInt(k.ans) && k.ans < q.o.length) o.ans = k.ans;
    if (q.k === 'many' && Array.isArray(k.ans)) o.ans = [...new Set(k.ans.filter((n) => isInt(n) && n < q.o.length))];
    if (q.k === 'short' && Array.isArray(k.ans)) o.ans = k.ans.map((s) => clip(s, 200).trim()).filter(Boolean).slice(0, 20);
    if (k.fb && (k.fb.ok || k.fb.no)) o.fb = { ok: clip(k.fb.ok, 500), no: clip(k.fb.no, 500) };
    if (Object.keys(o).length) out[q.id] = o;
  }
  return out;
}
function cleanSet(s) {
  s = s || {};
  const show = s.show || {};
  return {
    edit: !!s.edit, prog: !!s.prog, shuf: !!s.shuf, msg: clip(s.msg, 1000), pub: !!s.pub, notify: !!s.notify,
    quiz: !!s.quiz, rel: s.rel === 'later' ? 'later' : 'now', show: { miss: show.miss !== false, ans: !!show.ans, pt: show.pt !== false },
    req: !!s.req, nx0: clip(s.nx0, 40),
  };
}

export function makeSurvey(deps) {
  const { dbGet, dbPut, dbPatch, pushToPhones, eligible } = deps;

  async function meUser(env, me) {
    if (me.admin) throw new Error('본사 관리자 입구는 쓸 수 없습니다. 본인 계정으로 로그인해 주세요');
    const u = await dbGet(env, '/users/' + encodeURIComponent(String(me.ph)));
    if (!isActive(u)) throw new Error('사용할 수 없는 계정입니다');
    return u;
  }
  async function load(env, sid) {
    if (!okId(sid)) throw new Error('설문 정보가 올바르지 않습니다');
    const raw = await dbGet(env, '/surveys/' + sid);
    if (!raw) throw new Error('없는 설문입니다');
    return { raw, sv: norm(raw) };
  }
  const isEditor = (sv, ph, u) => sv.by === ph || !!(sv.co && sv.co[ph]) || isHq(ph, u);
  const closed = (sv) => sv.st !== 'open' || (sv.end && nowMs() > sv.end);
  const later = (job, ctx) => { if (ctx && ctx.waitUntil) ctx.waitUntil(job); else return job; };

  /* 만들기 · 고치기(자동 저장). sid 가 없으면 초안을 새로 만든다 */
  async function save(env, me, body) {
    const u = await meUser(env, me); const ph = String(me.ph);
    let cur = null, sid = body.sid ? String(body.sid) : '';
    if (sid) { cur = (await load(env, sid)).raw; if (!isEditor(norm(cur), ph, u)) throw new Error('이 설문을 고칠 수 없습니다'); }
    else if (!(isMgr(ph, u) || isEdu(u))) throw new Error('설문은 경영팀 · 관리자 · 교육자만 만들 수 있습니다');
    const d = body.sv || {};
    const ids = new Set();
    const qs = (Array.isArray(d.qs) ? d.qs : []).slice(0, 200).map((q) => cleanItem(q || {}, ids));
    const co = {};
    if (d.co && typeof d.co === 'object' && (!cur || cur.by === ph || isHq(ph, u))) for (const p of Object.keys(d.co).slice(0, 30)) if (/^\d{9,12}$/.test(p) && p !== (cur ? cur.by : ph)) co[p] = 1;
    const th = { c: /^#[0-9A-Fa-f]{6}$/.test(String((d.th || {}).c || '')) ? d.th.c : '', img: KEY_RE.test(String((d.th || {}).img || '')) ? d.th.img : '' };
    const up = {
      v: 2, t: clip(d.t, 120).trim(), desc: clip(d.desc, 3000), qs, set: cleanSet(d.set), th,
      end: Number(d.end) > 0 ? Number(d.end) : 0, up: nowMs(), ub: nameOf(u),
    };
    if (!cur || cur.by === ph || isHq(ph, u)) up.co = Object.keys(co).length ? co : null;
    /* 익명 · 실명은 응답이 들어오기 전에만 바꿀 수 있다 */
    if (!cur || cur.st === 'draft') up.anon = !!d.anon;
    if (!sid) { sid = 's' + id36(); Object.assign(up, { by: ph, bn: nameOf(u), at: nowMs(), st: 'draft' }); await dbPut(env, '/surveys/' + sid, up); }
    else {
      if (cur.v !== 2 && Array.isArray(cur.qs)) { /* 예전 설문을 처음 고치면 응답도 지금 모양으로 옮긴다 */
        const all = (await dbGet(env, '/surveyAns/' + sid).catch(() => null)) || {}; const mv = {};
        for (const [k, r] of Object.entries(all)) if (!k.startsWith('_') && r && Array.isArray(r.a)) mv[`surveyAns/${sid}/${k}/a`] = normA(cur, r.a);
        for (const [k, r] of Object.entries(all._anon || {})) if (r && Array.isArray(r.a)) mv[`surveyAns/${sid}/_anon/${k}/a`] = normA(cur, r.a);
        if (Object.keys(mv).length) await dbPatch(env, '/', mv);
      }
      await dbPatch(env, '/surveys/' + sid, up);
    }
    if (body.key !== undefined) await dbPut(env, `/surveyAns/${sid}/_key`, cleanKey(qs, body.key));
    return { sid, up: up.up };
  }

  /* 편집 화면용 — 설문 + 정답 */
  async function get(env, me, body) {
    const u = await meUser(env, me); const ph = String(me.ph);
    const { sv } = await load(env, String(body.sid || ''));
    if (!isEditor(sv, ph, u)) throw new Error('이 설문을 고칠 수 없습니다');
    const key = (await dbGet(env, `/surveyAns/${body.sid}/_key`).catch(() => null)) || {};
    const n = Object.keys(sv.tp || {}).length;
    return { sv: { ...sv, tp: undefined, n }, tp: Object.keys(sv.tp || {}), key, owner: sv.by === ph || isHq(ph, u) };
  }

  /* 보내기 — 처음이면 설문을 열고, 이미 보낸 설문이면 새로 고른 사람만 더한다 */
  async function send(env, ctx, me, body) {
    const u = await meUser(env, me); const ph = String(me.ph);
    const sid = String(body.sid || ''); const { raw, sv } = await load(env, sid);
    if (!isEditor(sv, ph, u)) throw new Error('이 설문을 보낼 수 없습니다');
    if (!sv.t) throw new Error('제목을 입력해 주세요');
    const qn = (sv.qs || []).filter(isQ);
    if (!qn.length) throw new Error('질문을 하나 이상 넣어 주세요');
    for (const q of qn) {
      if (!q.t) throw new Error('제목 없는 질문이 있어요');
      if (['one', 'many', 'drop', 'grid', 'cgrid'].includes(q.k) && !q.o.filter(Boolean).length) throw new Error(`'${q.t}' 에 선택지를 넣어 주세요`);
      if ((q.k === 'grid' || q.k === 'cgrid') && !(q.r || []).filter(Boolean).length) throw new Error(`'${q.t}' 에 행을 넣어 주세요`);
    }
    const { el } = await eligible(env);
    const add = (Array.isArray(body.to) ? body.to : []).map(String).filter((p) => el[p] && !(raw.tp || {})[p]);
    if (!add.length && raw.st !== 'draft') return { n: 0 };
    if (!add.length) throw new Error('보낼 사람을 골라 주세요');
    const up = {};
    for (const p of add) { up[`surveys/${sid}/tp/${p}`] = 1; up[`chat/act/${p}/s_${sid}`] = { k: 'survey', rid: 'survey', key: sid, x: sv.t, bn: sv.bn, at: nowMs(), rn: '설문', done: 0 }; }
    if (raw.st === 'draft') { up[`surveys/${sid}/st`] = 'open'; up[`surveys/${sid}/sent`] = nowMs(); }
    await dbPatch(env, '/', up);
    const end = sv.end;
    later(pushToPhones(env, add, { title: '[설문] ' + sv.t, body: nameOf(u) + (end ? ' · 마감 ' + new Date(end + 9 * 3600e3).toISOString().slice(5, 16).replace('T', ' ') : ''), url: './#survey/' + sid, tag: 'survey-' + sid }, { urgency: 'high' }).catch(() => {}), ctx);
    return { n: add.length };
  }

  /* 응답하기 — 지나간 섹션의 질문만 받고, 필수 · 응답 확인을 다시 본다. 퀴즈면 자동 채점 */
  async function answer(env, ctx, me, body) {
    const u = await meUser(env, me); const ph = String(me.ph);
    const sid = String(body.sid || ''); const { sv } = await load(env, sid);
    if (!sv.tp || !sv.tp[ph]) throw new Error('이 설문 대상이 아닙니다');
    if (closed(sv)) throw new Error('응답을 받지 않는 설문입니다');
    const set = sv.set || {};
    const a0 = body.a && typeof body.a === 'object' && !Array.isArray(body.a) ? body.a : {};
    const a = {};
    for (const q of sv.qs || []) if (isQ(q)) { const v = clean(q, a0[q.id]); if (v != null) a[q.id] = v; }
    const visit = path(sv, a); const live = new Set(); visit.forEach((s) => s.items.forEach((q) => live.add(q.id)));
    for (const id of Object.keys(a)) if (!live.has(id)) delete a[id];
    for (const s of visit) for (const q of s.items) {
      if (!isQ(q)) continue; const v = a[q.id];
      if (q.req && empty(q, v)) throw new Error(`'${q.t}' 에 답해 주세요`);
      if (q.req && (q.k === 'grid' || q.k === 'cgrid') && v.some((x) => x == null || (Array.isArray(x) && !x.length))) throw new Error(`'${q.t}' 의 모든 행에 답해 주세요`);
      if (q.k === 'grid' && q.g1 && Array.isArray(v)) { const used = v.filter((x) => x != null); if (new Set(used).size !== used.length) throw new Error(`'${q.t}' 는 열마다 하나만 고를 수 있어요`); }
      const m = checkVal(q, v); if (m) throw new Error(`'${q.t}': ${m}`);
    }
    const rec = { a, at: nowMs() };
    if (set.quiz) {
      const key = (await dbGet(env, `/surveyAns/${sid}/_key`).catch(() => null)) || {};
      const sc = {}; for (const q of sv.qs) if (isQ(q)) { const s = autoScore(q, a[q.id], key[q.id]); if (s != null) sc[q.id] = s; }
      rec.sc = sc;
    }
    if (sv.anon) {
      const done = await dbGet(env, `/surveyAns/${sid}/_who/${ph}`).catch(() => null);
      if (done) throw new Error('이미 응답했습니다 (익명 설문은 고칠 수 없습니다)');
      const rid = Array.from(crypto.getRandomValues(new Uint8Array(12)), (b) => b.toString(36).padStart(2, '0')).join('');
      delete rec.at; /* 익명: 시각을 남기지 않는다 — 응답 시각으로 사람을 맞춰 볼 수 없게 */
      await dbPatch(env, '/', { [`surveyAns/${sid}/_anon/${rid}`]: rec, [`surveyAns/${sid}/_who/${ph}`]: 1, [`chat/act/${ph}/s_${sid}/done`]: 1 });
    } else {
      const old = await dbGet(env, `/surveyAns/${sid}/${ph}`).catch(() => null);
      if (old && !set.edit) throw new Error('이미 응답했습니다 (이 설문은 제출 후 고칠 수 없어요)');
      if (old && old.man) rec.man = old.man;
      if (old) { rec.ed = rec.at; rec.at = old.at || rec.at; }
      await dbPatch(env, '/', { [`surveyAns/${sid}/${ph}`]: rec, [`chat/act/${ph}/s_${sid}/done`]: 1 });
    }
    if (set.notify) {
      const to = [sv.by, ...Object.keys(sv.co || {})].filter((p) => p && p !== ph);
      if (to.length) later(pushToPhones(env, to, { title: '[설문 응답] ' + sv.t, body: sv.anon ? '새 응답이 들어왔어요' : nameOf(u) + '님이 응답했어요', url: './#survey/' + sid + '/r', tag: 'svr-' + sid }).catch(() => {}), ctx);
    }
    return { quiz: set.quiz && set.rel === 'now' && !sv.anon ? await myQuiz(env, sv, rec, sid) : null };
  }

  /* 퀴즈 결과(공개된 것만) — 보여 줄 것은 설정의 show 에 따른다 */
  async function myQuiz(env, sv, rec, sid) {
    const set = sv.set || {}; const show = set.show || {};
    const key = (await dbGet(env, `/surveyAns/${sid}/_key`).catch(() => null)) || {};
    const t = total(sv, rec); const per = {};
    for (const q of sv.qs || []) {
      if (!isQ(q) || !q.pt) continue;
      const m = rec.man && rec.man[q.id], s = rec.sc && rec.sc[q.id]; const got = m != null ? +m : s != null ? +s : null;
      const o = {};
      if (show.pt) { o.pt = q.pt; o.got = got; }
      if (show.miss) o.ok = got == null ? null : got >= q.pt;
      if (show.ans && key[q.id] && key[q.id].ans != null) o.ans = key[q.id].ans;
      if (key[q.id] && key[q.id].fb) o.fb = got != null && got >= q.pt ? key[q.id].fb.ok : key[q.id].fb.no;
      per[q.id] = o;
    }
    return { got: t.got, max: t.max, pending: t.pending, per };
  }

  /* 응답자 화면 — 설문(정답 빼고) + 내 응답 */
  async function mine(env, me, body) {
    const u = await meUser(env, me); const ph = String(me.ph);
    const sid = String(body.sid || ''); const { sv } = await load(env, sid);
    const ed = isEditor(sv, ph, u);
    if (!(sv.tp && sv.tp[ph]) && !ed) throw new Error('이 설문 대상이 아닙니다');
    const out = { sv: { ...sv, tp: undefined, co: undefined, n: Object.keys(sv.tp || {}).length }, editor: ed, target: !!(sv.tp && sv.tp[ph]) };
    if (sv.anon) { out.answered = !!(await dbGet(env, `/surveyAns/${sid}/_who/${ph}`).catch(() => null)); return out; }
    const r = await dbGet(env, `/surveyAns/${sid}/${ph}`).catch(() => null);
    out.answered = !!r; out.a = r ? normA(sv, r.a) : null; out.at = r ? r.at : 0;
    if (r && sv.set && sv.set.quiz && (sv.set.rel === 'now' || sv.rel)) out.quiz = await myQuiz(env, sv, { ...r, a: out.a }, sid);
    return out;
  }

  async function rowsOf(env, sid, sv) {
    const all = (await dbGet(env, '/surveyAns/' + sid).catch(() => null)) || {};
    const { us } = await eligible(env);
    let rows, who;
    if (sv.anon) {
      rows = Object.entries(all._anon || {}).map(([id, r]) => ({ id, a: normA(sv, r.a), sc: r.sc || null, man: r.man || null }));
      who = Object.keys(all._who || {});
    } else {
      rows = Object.entries(all).filter(([k]) => !k.startsWith('_')).map(([p, r]) => ({ id: p, ph: p, name: nameOf(us[p]) || p, a: normA(sv, r.a), at: r.at || 0, ed: r.ed || 0, sc: r.sc || null, man: r.man || null }));
      rows.sort((x, y) => x.at - y.at);
      who = rows.map((r) => r.ph);
    }
    return { rows, who, us, key: all._key || {} };
  }

  /* 결과 — 만든 사람 · 공동 작업자 · 경영팀 */
  async function result(env, me, body) {
    const u = await meUser(env, me); const ph = String(me.ph);
    const sid = String(body.sid || ''); const { sv } = await load(env, sid);
    if (!isEditor(sv, ph, u)) throw new Error('결과는 만든 사람 · 공동 작업자 · 경영팀만 볼 수 있습니다');
    const { rows, who, us, key } = await rowsOf(env, sid, sv);
    const pending = Object.keys(sv.tp || {}).filter((p) => !who.includes(p)).map((p) => ({ ph: p, name: nameOf(us[p]) || p }));
    return { sv: { ...sv, tp: undefined, n: Object.keys(sv.tp || {}).length }, rows, answered: who.length, pending, key };
  }

  /* 응답자에게 공개하는 요약 — 이름 · 시각 없이 답만, 섞어서 */
  async function summary(env, me, body) {
    const u = await meUser(env, me); const ph = String(me.ph);
    const sid = String(body.sid || ''); const { sv } = await load(env, sid);
    const ed = isEditor(sv, ph, u);
    if (!ed && !(sv.set && sv.set.pub && sv.tp && sv.tp[ph])) throw new Error('결과 요약을 볼 수 없는 설문입니다');
    const { rows } = await rowsOf(env, sid, sv);
    const out = rows.map((r) => ({ a: r.a }));
    for (let i = out.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [out[i], out[j]] = [out[j], out[i]]; }
    return { sv: { ...sv, tp: undefined, co: undefined }, rows: out };
  }

  async function mustEditor(env, me, sid) {
    const u = await meUser(env, me); const ph = String(me.ph);
    const { raw, sv } = await load(env, sid);
    if (!isEditor(sv, ph, u)) throw new Error('만든 사람 · 공동 작업자 · 경영팀만 할 수 있습니다');
    return { u, ph, raw, sv };
  }

  /* 응답 지우기 — ids 또는 all */
  async function delAns(env, me, body) {
    const sid = String(body.sid || ''); const { sv } = await mustEditor(env, me, sid);
    const up = {};
    if (body.all) {
      if (sv.anon) { up[`surveyAns/${sid}/_anon`] = null; up[`surveyAns/${sid}/_who`] = null; }
      const all = (await dbGet(env, '/surveyAns/' + sid).catch(() => null)) || {};
      for (const k of Object.keys(all)) if (!k.startsWith('_')) up[`surveyAns/${sid}/${k}`] = null;
      for (const p of Object.keys(sv.tp || {})) up[`chat/act/${p}/s_${sid}/done`] = 0;
    } else {
      for (const id of (Array.isArray(body.ids) ? body.ids : []).map(String).slice(0, 500)) {
        if (!okId(id)) continue;
        if (sv.anon) up[`surveyAns/${sid}/_anon/${id}`] = null;
        else { up[`surveyAns/${sid}/${id}`] = null; up[`chat/act/${id}/s_${sid}/done`] = 0; }
      }
    }
    if (Object.keys(up).length) await dbPatch(env, '/', up);
    return { n: Object.keys(up).length };
  }

  /* 설문 지우기 — 만든 사람 · 경영팀만(공동 작업자는 못 지움) */
  async function delSurvey(env, me, body) {
    const u = await meUser(env, me); const ph = String(me.ph);
    const sid = String(body.sid || ''); const { sv } = await load(env, sid);
    if (sv.by !== ph && !isHq(ph, u)) throw new Error('설문은 만든 사람과 경영팀만 지울 수 있습니다');
    const up = { [`surveys/${sid}`]: null, [`surveyAns/${sid}`]: null };
    for (const p of Object.keys(sv.tp || {})) up[`chat/act/${p}/s_${sid}`] = null;
    await dbPatch(env, '/', up);
    return {};
  }

  /* 응답 받기 켜기 · 끄기, 마감 일시 */
  async function state(env, me, body) {
    const sid = String(body.sid || ''); const { raw } = await mustEditor(env, me, sid);
    if (raw.st === 'draft') throw new Error('아직 보내지 않은 설문입니다');
    const up = { st: body.open ? 'open' : 'closed' };
    if (body.end !== undefined) up.end = Number(body.end) > 0 ? Number(body.end) : 0;
    else if (body.open && raw.end && nowMs() > raw.end) up.end = 0; /* 마감이 지난 설문을 다시 열면 마감을 없앤다 */
    await dbPatch(env, '/surveys/' + sid, up);
    return up;
  }

  /* 직접 점수 주기 (개별 응답) */
  async function grade(env, me, body) {
    const sid = String(body.sid || ''); const { sv } = await mustEditor(env, me, sid);
    const id = String(body.id || ''); if (!okId(id)) throw new Error('응답 정보가 올바르지 않습니다');
    const base = sv.anon ? `surveyAns/${sid}/_anon/${id}` : `surveyAns/${sid}/${id}`;
    const r = await dbGet(env, '/' + base); if (!r) throw new Error('응답을 찾지 못했습니다');
    const up = {};
    for (const [qid, v] of Object.entries(body.pts || {})) {
      const q = (sv.qs || []).find((x) => x.id === qid); if (!q || !q.pt) continue;
      up[`${base}/man/${qid}`] = v === null || v === '' ? null : Math.max(0, Math.min(q.pt, Math.round(+v || 0)));
    }
    if (Object.keys(up).length) await dbPatch(env, '/', up);
    return {};
  }

  /* 퀴즈 점수 공개(나중에 공개로 한 설문) — 응답한 사람에게 알림 */
  async function release(env, ctx, me, body) {
    const sid = String(body.sid || ''); const { sv } = await mustEditor(env, me, sid);
    await dbPut(env, `/surveys/${sid}/rel`, 1);
    if (!sv.anon) {
      const all = (await dbGet(env, '/surveyAns/' + sid).catch(() => null)) || {};
      const to = Object.keys(all).filter((k) => !k.startsWith('_'));
      if (to.length) later(pushToPhones(env, to, { title: '[점수 공개] ' + sv.t, body: '퀴즈 점수를 확인해 보세요', url: './#survey/' + sid, tag: 'survey-' + sid }).catch(() => {}), ctx);
      return { n: to.length };
    }
    return { n: 0 };
  }

  async function nudge(env, me, body) {
    const sid = String(body.sid || ''); const { sv } = await mustEditor(env, me, sid);
    const all = (await dbGet(env, '/surveyAns/' + sid).catch(() => null)) || {};
    const done = sv.anon ? (all._who || {}) : all;
    let rest = Object.keys(sv.tp || {}).filter((p) => !done[p]);
    if (Array.isArray(body.to) && body.to.length) rest = rest.filter((p) => body.to.map(String).includes(p));
    if (rest.length) await pushToPhones(env, rest, { title: '[설문 다시 알림] ' + sv.t, body: '아직 응답하지 않으셨어요', url: './#survey/' + sid, tag: 'survey-' + sid }, { urgency: 'high' });
    return { sent: rest.length };
  }

  /* 양식으로 저장 · 사본 만들기 · 양식으로 새 설문 */
  async function saveTpl(env, me, body) {
    const sid = String(body.sid || ''); const { ph, sv } = await mustEditor(env, me, sid);
    const tid = 't' + id36();
    await dbPut(env, '/surveyTpl/' + tid, { v: 2, t: sv.t, desc: sv.desc || '', qs: sv.qs, set: sv.set || {}, th: sv.th || {}, anon: !!sv.anon, by: ph, at: nowMs() });
    const key = await dbGet(env, `/surveyAns/${sid}/_key`).catch(() => null);
    if (key) await dbPut(env, `/surveyAns/_tplkey/${tid}`, key);
    return { tid };
  }
  async function copy(env, me, body) {
    const u = await meUser(env, me); const ph = String(me.ph);
    if (!(isMgr(ph, u) || isEdu(u))) throw new Error('설문은 경영팀 · 관리자 · 교육자만 만들 수 있습니다');
    let src, key = null;
    if (body.tid) {
      if (!okId(body.tid)) throw new Error('양식 정보가 올바르지 않습니다');
      src = norm(await dbGet(env, '/surveyTpl/' + body.tid)); if (!src) throw new Error('없는 양식입니다');
      key = await dbGet(env, `/surveyAns/_tplkey/${body.tid}`).catch(() => null);
    } else {
      const sid = String(body.sid || ''); const r = await mustEditor(env, me, sid); src = r.sv;
      key = await dbGet(env, `/surveyAns/${sid}/_key`).catch(() => null);
    }
    const nsid = 's' + id36();
    await dbPut(env, '/surveys/' + nsid, { v: 2, t: body.tid ? src.t : clip(src.t + ' 사본', 120), desc: src.desc || '', qs: src.qs || [], set: src.set || {}, th: src.th || {}, anon: !!src.anon, by: ph, bn: nameOf(u), at: nowMs(), up: nowMs(), st: 'draft', end: 0 });
    if (key) await dbPut(env, `/surveyAns/${nsid}/_key`, key);
    return { sid: nsid };
  }
  async function delTpl(env, me, body) {
    const u = await meUser(env, me); const ph = String(me.ph);
    if (!okId(body.tid)) throw new Error('양식 정보가 올바르지 않습니다');
    const t = await dbGet(env, '/surveyTpl/' + body.tid); if (!t) return {};
    if (t.by !== ph && !isHq(ph, u)) throw new Error('양식은 만든 사람과 경영팀만 지울 수 있습니다');
    await dbPatch(env, '/', { [`surveyTpl/${body.tid}`]: null, [`surveyAns/_tplkey/${body.tid}`]: null });
    return {};
  }

  /* 미디어 열람 — 만든 사람 · 공동 작업자 · 경영팀 · 받는 사람 */
  async function canSee(env, me, sid) {
    const u = await meUser(env, me); const ph = String(me.ph);
    const sv = await dbGet(env, '/surveys/' + sid).catch(() => null);
    return !!sv && (isEditor(sv, ph, u) || !!(sv.tp && sv.tp[ph]));
  }

  const R = {
    '/survey/save': (env, ctx, me, b) => save(env, me, b),
    '/survey/get': (env, ctx, me, b) => get(env, me, b),
    '/survey/send': (env, ctx, me, b) => send(env, ctx, me, b),
    '/survey/answer': (env, ctx, me, b) => answer(env, ctx, me, b),
    '/survey/mine': (env, ctx, me, b) => mine(env, me, b),
    '/survey/result': (env, ctx, me, b) => result(env, me, b),
    '/survey/summary': (env, ctx, me, b) => summary(env, me, b),
    '/survey/delans': (env, ctx, me, b) => delAns(env, me, b),
    '/survey/delete': (env, ctx, me, b) => delSurvey(env, me, b),
    '/survey/state': (env, ctx, me, b) => state(env, me, b),
    '/survey/close': (env, ctx, me, b) => state(env, me, { ...b, open: false }),
    '/survey/grade': (env, ctx, me, b) => grade(env, me, b),
    '/survey/release': (env, ctx, me, b) => release(env, ctx, me, b),
    '/survey/nudge': (env, ctx, me, b) => nudge(env, me, b),
    '/survey/tpl': (env, ctx, me, b) => saveTpl(env, me, b),
    '/survey/copy': (env, ctx, me, b) => copy(env, me, b),
    '/survey/tpldel': (env, ctx, me, b) => delTpl(env, me, b),
  };
  return { R, canSee };
}
