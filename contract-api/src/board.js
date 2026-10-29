/**
 * DM 소통 — 게시판 · 설문 · 업무 댓글 (서버 쪽).
 *
 * 게시판
 *   /board/meta/{bid}            { n 이름, w 쓰기 권한(mgr 경영팀·관리자 | edu +교육자 | all 누구나), br 지점(있으면 그 지점+경영팀만), o 순서 }
 *   /board/posts/{bid}/{pid}     { t 제목, x 본문, by, bn, at, ed, must:{due} 필독, pin, md 첨부, cc 댓글 수 }
 *   /board/reads/{bid}/{pid}/{폰}  읽은(확인한) 시각
 *   /board/cmt/{bid}/{pid}/{cid}   { by, bn, at, x, mn }
 * 설문 — survey.js (여기엔 예전 앱이 부르는 /survey/create 만 남김)
 * 업무 댓글 — 발주 · 연차 · 상담 건 아래 대화
 *   /workCmt/{kind}/{id}/{cid}   { by, bn, at, x, mn }   ·  /workCmt/{kind}/{id}/_who/{폰} 참여자
 */

import { makeSurvey } from './survey.js';

const MANAGER_GRADES = ['경영팀', '관리자'];
const OWNER_PHONES = ['01042885562', '01082470187'];
const nowMs = () => Date.now();
const clip = (s, n) => { s = String(s || ''); return s.length > n ? s.slice(0, n) + '…' : s; };
const nameOf = (u) => (u && (u.nick || u.name)) || '';
const isActive = (u) => u && u.status !== '퇴사' && u.status !== '대기';
const isMgr = (ph, u) => OWNER_PHONES.includes(String(ph)) || (u && (MANAGER_GRADES.includes(u.systemGrade) || (!u.systemGrade && u.branch === '본사' && MANAGER_GRADES.includes(u.role))));
const isHq = (ph, u) => OWNER_PHONES.includes(String(ph)) || (u && (u.systemGrade === '경영팀' || u.role === '경영팀' || u.role === '본사경영팀'));
const isEdu = (u) => u && (u.academyRole === '교육자' || u.role === '스탭장');
const id36 = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
const okId = (s) => /^[A-Za-z0-9_-]{1,40}$/.test(String(s || ''));

export const DEFAULT_BOARDS = {
  notice: { n: '공지사항', w: 'mgr', o: 1 },
  edu: { n: '교육 자료', w: 'edu', o: 2 },
  news: { n: '매장 소식', w: 'all', o: 3 },
  free: { n: '자유', w: 'all', o: 9 },
};

export function makeBoard(deps) {
  const { dbGet, dbPut, dbPatch, dbDelete, pushToPhones, eligible } = deps;
  const survey = makeSurvey(deps);

  async function meUser(env, me) {
    if (me.admin) throw new Error('본사 관리자 입구는 쓸 수 없습니다. 본인 계정으로 로그인해 주세요');
    const u = await dbGet(env, '/users/' + encodeURIComponent(String(me.ph)));
    if (!isActive(u)) throw new Error('사용할 수 없는 계정입니다');
    return u;
  }

  /* 게시판 목록 — 처음이면 기본 게시판 + 지점 게시판을 만든다 */
  async function boards(env) {
    let meta = (await dbGet(env, '/board/meta').catch(() => null)) || null;
    const { el } = await eligible(env);
    const want = { ...DEFAULT_BOARDS };
    for (const u of Object.values(el)) if (u.branch && u.branch !== '본사') {
      const bid = 'br_' + String(u.branch).replace(/[^가-힣A-Za-z0-9]/g, '').slice(0, 20);
      want[bid] = { n: u.branch, w: 'all', br: u.branch, o: 5 };
    }
    const up = {};
    for (const [bid, b] of Object.entries(want)) if (!meta || !meta[bid]) up[bid] = b;
    if (Object.keys(up).length) { await dbPatch(env, '/board/meta', up); meta = { ...(meta || {}), ...up }; }
    return meta;
  }
  const canSee = (b, ph, u) => !b.br || isHq(ph, u) || (u && u.branch === b.br);
  const canWrite = (b, ph, u) => canSee(b, ph, u) && (b.w === 'all' || isMgr(ph, u) || (b.w === 'edu' && isEdu(u)));
  async function boardOf(env, bid) { if (!okId(bid)) throw new Error('게시판 정보가 올바르지 않습니다'); const b = await dbGet(env, '/board/meta/' + bid); if (!b) throw new Error('없는 게시판입니다'); return b; }
  async function audience(env, b) {
    const { el } = await eligible(env);
    return Object.keys(el).filter((ph) => canSee(b, ph, el[ph]));
  }

  async function post(env, ctx, me, body) {
    const u = await meUser(env, me); const ph = String(me.ph);
    const bid = String(body.bid || ''); const b = await boardOf(env, bid);
    if (!canWrite(b, ph, u)) throw new Error(b.w === 'mgr' ? '이 게시판은 경영팀 · 관리자만 쓸 수 있습니다' : '이 게시판에 글을 쓸 수 없습니다');
    const t = clip(body.t, 100).trim(), x = clip(body.x, 20000).trim();
    if (!t) throw new Error('제목을 입력해 주세요');
    const keyOk = (v) => /^[po]\/[A-Za-z0-9_-]+\/[A-Za-z0-9._-]+$/.test(String(v || ''));
    const md = Array.isArray(body.md) ? body.md.slice(0, 30).map((m) => { const o = { w: m.w | 0, h: m.h | 0, sz: m.sz | 0 }; for (const k of ['u', 'o', 'v', 'f']) if (keyOk(m[k])) o[k] = String(m[k]); if (m.n) o.n = clip(m.n, 120); if (m.d) o.d = Math.round(+m.d || 0); return o; }).filter((m) => m.u || m.v || m.f) : null;
    const must = body.must && isMgr(ph, u) ? { due: Number(body.must.due) || 0 } : null;
    const pin = !!body.pin && isMgr(ph, u);
    const editing = body.pid && okId(body.pid);
    const pid = editing ? String(body.pid) : 'p' + id36();
    if (editing) {
      const old = await dbGet(env, `/board/posts/${bid}/${pid}`);
      if (!old) throw new Error('글을 찾지 못했습니다');
      if (old.by !== ph && !isMgr(ph, u)) throw new Error('내가 쓴 글만 고칠 수 있습니다');
      await dbPatch(env, `/board/posts/${bid}/${pid}`, { t, x, md, must, pin: pin || null, ed: nowMs() });
      return { pid };
    }
    await dbPut(env, `/board/posts/${bid}/${pid}`, { t, x, by: ph, bn: nameOf(u), at: nowMs(), md, must, pin: pin || null, cc: 0 });
    /* 새 글 알림 — 필독은 모두, 일반 글은 '게시판 알림 끔'이 아닌 사람에게 */
    const muted = (await dbGet(env, '/board/mute/' + bid).catch(() => null)) || {};
    const targets = (await audience(env, b)).filter((p) => p !== ph && (must || !muted[p]));
    if (must) {
      const up = {};
      for (const p of targets) up[`chat/act/${p}/b_${bid}_${pid}`] = { k: 'must', rid: 'board:' + bid, key: pid, x: t, bn: nameOf(u), at: nowMs(), rn: b.n, done: 0 };
      if (Object.keys(up).length) await dbPatch(env, '/', up);
    }
    if (targets.length) {
      const job = pushToPhones(env, targets, { title: (must ? '[필독] ' : '') + b.n, body: nameOf(u) + ': ' + t, url: `./#board/${bid}/${pid}`, tag: 'board-' + bid }, { urgency: must ? 'high' : 'normal' }).catch(() => {});
      if (ctx && ctx.waitUntil) ctx.waitUntil(job); else await job;
    }
    return { pid };
  }

  async function delPost(env, me, body) {
    const u = await meUser(env, me); const ph = String(me.ph);
    const bid = String(body.bid || ''), pid = String(body.pid || '');
    await boardOf(env, bid);
    const old = await dbGet(env, `/board/posts/${bid}/${pid}`);
    if (!old) throw new Error('글을 찾지 못했습니다');
    if (old.by !== ph && !isMgr(ph, u)) throw new Error('내가 쓴 글만 지울 수 있습니다');
    await dbPatch(env, '/', { [`board/posts/${bid}/${pid}`]: null, [`board/cmt/${bid}/${pid}`]: null, [`board/reads/${bid}/${pid}`]: null });
    return {};
  }

  async function readPost(env, me, body) {
    const u = await meUser(env, me);
    const bid = String(body.bid || ''), pid = String(body.pid || '');
    const b = await boardOf(env, bid);
    if (!canSee(b, String(me.ph), u)) throw new Error('볼 수 없는 게시판입니다');
    await dbPatch(env, '/', { [`board/reads/${bid}/${pid}/${me.ph}`]: nowMs(), [`chat/act/${me.ph}/b_${bid}_${pid}/done`]: body.ack ? 1 : null });
    return {};
  }

  /* 게시판 댓글 · 업무 댓글은 같은 모양 — 대상만 다르다 */
  async function comment(env, ctx, me, body) {
    const u = await meUser(env, me); const ph = String(me.ph);
    const x = clip(body.x, 3000).trim();
    if (!x) throw new Error('내용을 입력해 주세요');
    let base, title, url, people, owner;
    if (body.bid) {
      const bid = String(body.bid), pid = String(body.pid || '');
      const b = await boardOf(env, bid);
      if (!canSee(b, ph, u)) throw new Error('볼 수 없는 게시판입니다');
      const p = await dbGet(env, `/board/posts/${bid}/${pid}`);
      if (!p) throw new Error('글을 찾지 못했습니다');
      base = `board/cmt/${bid}/${pid}`; title = b.n + ' · ' + clip(p.t, 30); url = `./#board/${bid}/${pid}`; owner = p.by;
      people = Object.values((await dbGet(env, '/' + base).catch(() => null)) || {}).map((c) => c && c.by).filter(Boolean);
      await dbPut(env, `/board/posts/${bid}/${pid}/cc`, ((p.cc || 0) + 1));
    } else {
      const kind = String(body.kind || ''), wid = String(body.wid || '');
      if (!['order', 'leave', 'consult'].includes(kind) || !okId(wid.replace(/[^A-Za-z0-9_-]/g, '_')) || wid.length > 80) throw new Error('대상이 올바르지 않습니다');
      const sk = wid.replace(/[^A-Za-z0-9_-]/g, '_');
      base = `workCmt/${kind}/${sk}`; title = { order: '발주', leave: '연차 · 휴무', consult: '상담' }[kind] + ' · ' + clip(body.label, 40); url = String(body.url || './#p-dash').slice(0, 120);
      owner = body.owner ? String(body.owner) : '';
      const who = (await dbGet(env, `/${base}/_who`).catch(() => null)) || {};
      people = Object.keys(who);
    }
    const cid = 'c' + id36();
    const { el } = await eligible(env);
    const mn = (Array.isArray(body.mn) ? body.mn : []).map(String).filter((p) => el[p]);
    const up = { [`${base}/${cid}`]: { by: ph, bn: nameOf(u), at: nowMs(), x, mn: mn.length ? Object.fromEntries(mn.map((p) => [p, 1])) : null } };
    if (!body.bid) up[`${base}/_who/${ph}`] = 1;
    const targets = new Set([owner, ...people, ...mn].filter((p) => p && p !== ph && el[p]));
    for (const p of targets) up[`chat/act/${p}/${'w' + id36()}`] = { k: mn.includes(p) ? 'mention' : 'reply', rid: body.bid ? 'board:' + body.bid : 'work:' + body.kind, key: body.bid ? String(body.pid) : String(body.wid), x: clip(x, 80), bn: nameOf(u), at: nowMs(), rn: title, url, done: 0 };
    await dbPatch(env, '/', up);
    if (targets.size) {
      const job = pushToPhones(env, [...targets], { title, body: nameOf(u) + ': ' + clip(x, 100), url, tag: 'cmt-' + base.slice(-30) }, { urgency: 'high' }).catch(() => {});
      if (ctx && ctx.waitUntil) ctx.waitUntil(job); else await job;
    }
    return { cid };
  }

  async function boardMute(env, me, body) {
    await meUser(env, me);
    const bid = String(body.bid || ''); await boardOf(env, bid);
    await dbPut(env, `/board/mute/${bid}/${me.ph}`, body.on ? 1 : null);
    return {};
  }

  /* ── 설문 ── */
  const QK = ['one', 'many', 'score', 'short', 'long', 'date', 'photo', 'grid'];
  async function surveyCreate(env, ctx, me, body) {
    const u = await meUser(env, me); const ph = String(me.ph);
    if (!(isMgr(ph, u) || isEdu(u))) throw new Error('설문은 경영팀 · 관리자 · 교육자만 만들 수 있습니다');
    const t = clip(body.t, 100).trim(); if (!t) throw new Error('제목을 입력해 주세요');
    const qs = (Array.isArray(body.qs) ? body.qs : []).slice(0, 40).map((q) => ({
      k: QK.includes(q.k) ? q.k : 'short', t: clip(q.t, 200).trim(),
      o: Array.isArray(q.o) ? q.o.map((o) => clip(o, 80).trim()).filter(Boolean).slice(0, 20) : null,
      r: Array.isArray(q.r) ? q.r.map((o) => clip(o, 60).trim()).filter(Boolean).slice(0, 15) : null,
      req: !!q.req,
    })).filter((q) => q.t);
    if (!qs.length) throw new Error('질문을 하나 이상 넣어 주세요');
    for (const q of qs) if ((q.k === 'one' || q.k === 'many' || q.k === 'grid') && (!q.o || q.o.length < 2)) throw new Error(`'${q.t}' 에 선택지를 두 개 이상 넣어 주세요`);
    const { el } = await eligible(env);
    const to = body.to || {};
    const tp = {};
    for (const [p, uu] of Object.entries(el)) {
      if (to.all || (to.branches || []).includes(uu.branch) || (to.roles || []).some((r) => uu.role === r || uu.systemGrade === r || (r === '인턴' && uu.academyRole === '인턴')) || (to.phones || []).map(String).includes(p)) tp[p] = 1;
    }
    delete tp[ph];
    if (!Object.keys(tp).length) throw new Error('보낼 사람을 골라 주세요');
    const sid = 's' + id36();
    const end = Number(body.end) || 0;
    const sv = { t, by: ph, bn: nameOf(u), at: nowMs(), end, anon: !!body.anon, tp, qs, st: 'open', desc: clip(body.desc, 1000) };
    const up = { [`surveys/${sid}`]: sv };
    for (const p of Object.keys(tp)) up[`chat/act/${p}/s_${sid}`] = { k: 'survey', rid: 'survey', key: sid, x: t, bn: nameOf(u), at: nowMs(), rn: '설문', done: 0 };
    await dbPatch(env, '/', up);
    if (body.tpl) await dbPut(env, '/surveyTpl/' + id36(), { t, qs, anon: !!body.anon, desc: sv.desc, by: ph, at: nowMs() });
    const job = pushToPhones(env, Object.keys(tp), { title: '[설문] ' + t, body: nameOf(u) + (end ? ' · 마감 ' + new Date(end + 9 * 3600e3).toISOString().slice(5, 16).replace('T', ' ') : ''), url: './#survey/' + sid, tag: 'survey-' + sid }, { urgency: 'high' }).catch(() => {});
    if (ctx && ctx.waitUntil) ctx.waitUntil(job); else await job;
    return { sid };
  }

  /* 미디어 열람 범위 확인용 — board:{bid} 는 그 게시판을 볼 수 있는 사람, survey:{sid} 는 만든 사람 · 경영팀 · 대상자 */
  async function canSeeScope(env, me, scope) {
    const u = await meUser(env, me); const ph = String(me.ph);
    if (scope.startsWith('board:')) { const b = await boardOf(env, scope.slice(6)); return canSee(b, ph, u); }
    if (scope.startsWith('survey:')) return survey.canSee(env, me, scope.slice(7));
    return false;
  }

  const route = async function route(path, request, env, ctx, me, json, origin) {
    if (!path.startsWith('/board/') && !path.startsWith('/survey/') && path !== '/work/comment') return null;
    if (request.method !== 'POST') return json({ ok: false, error: 'POST 만 받습니다' }, 405, origin);
    const body = await request.json().catch(() => ({}));
    try {
      let out;
      switch (path) {
        case '/board/list': await meUser(env, me); out = { boards: await boards(env) }; break;
        case '/board/post': out = await post(env, ctx, me, body); break;
        case '/board/delete': out = await delPost(env, me, body); break;
        case '/board/read': out = await readPost(env, me, body); break;
        case '/board/comment': out = await comment(env, ctx, me, body); break;
        case '/board/mute': out = await boardMute(env, me, body); break;
        case '/work/comment': out = await comment(env, ctx, me, { ...body, bid: null }); break;
        case '/survey/create': out = await surveyCreate(env, ctx, me, body); break;
        default:
          if (survey.R[path]) { out = await survey.R[path](env, ctx, me, body); break; }
          return json({ ok: false, error: '없는 기능입니다' }, 404, origin);
      }
      return json({ ok: true, ...(out || {}) }, 200, origin);
    } catch (e) {
      return json({ ok: false, error: e.message || String(e) }, 400, origin);
    }
  };
  route.canSeeScope = canSeeScope;
  return route;
}
