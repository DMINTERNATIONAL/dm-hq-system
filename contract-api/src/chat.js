/**
 * DM 소통 — 채팅 서버 쪽.
 *
 * 쓰기는 전부 여기를 거친다(방 참여 여부 · 공지방 · 내보내기 권한을 서버가 판정). 읽기는 앱이 DB를
 * 실시간으로 직접 본다 — 메시지 하나 볼 때마다 서버를 거치면 느리고 요청 수가 폭증한다.
 *
 * 데이터 (짧은 키 — 200명 × 수만 개 메시지를 생각해 크기를 줄였다)
 *   /chat/rooms/{rid}        { t 종류, n 이름, by 만든 사람, at, m:{폰:1} 참여자, seq 마지막 번호,
 *                              last:{x,by,bn,at,k}, pin:{key,x,bn,at} 방 공지, mute:{폰:1}, auto 자동방 여부 }
 *   /chat/msgs/{rid}/{key}   { s 번호, by, bn 보낸 이름, at, k 종류(t 글 · p 사진 · v 동영상 · sys 안내),
 *                              x 글, md 첨부, rp 인용 답장, th:{c 답장 수, l 마지막}, mn 부른 사람, rx 반응,
 *                              ed 수정 시각, del 삭제 }
 *   /chat/thr/{rid}/{root}/{key}  답장 묶기(스레드) 안의 메시지
 *   /chat/inbox/{폰}/{rid}   { s 방 최신 번호, r 내가 읽은 번호, at, x, bn, t, n 이 사람에게 보일 방 이름, mn 나를 부른 번호 }
 *   /chat/reads/{rid}/{폰}   내가 읽은 번호 — 말풍선 옆 '안 읽은 사람 수' 계산용
 *   /chat/act/{폰}/{id}      내 활동 { k mention · reply · all, rid, key, x, bn, at, done }
 *
 * 방 종류: notice 전체 공지 · hq 경영팀 · br 지점 · dm 1:1 · grp 직접 만든 방 · me 나와의 채팅
 */

const MANAGER_GRADES = ['경영팀', '관리자'];
const OWNER_PHONES = ['01042885562', '01082470187'];
const pad = (n) => String(n).padStart(9, '0');
const nowMs = () => Date.now();
const rid36 = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
const clip = (s, n) => { s = String(s || ''); return s.length > n ? s.slice(0, n) + '…' : s; };
const nameOf = (u) => (u && (u.nick || u.name)) || '';
const isActive = (u) => u && u.status !== '퇴사' && u.status !== '대기';
const isManagerUser = (ph, u) => OWNER_PHONES.includes(String(ph)) ||
  (u && (MANAGER_GRADES.includes(u.systemGrade) || (!u.systemGrade && u.branch === '본사' && MANAGER_GRADES.includes(u.role))));
const isHqUser = (ph, u) => OWNER_PHONES.includes(String(ph)) ||
  (u && (u.systemGrade === '경영팀' || u.role === '경영팀' || u.role === '본사경영팀'));
const safeKey = (s) => String(s).replace(/[.#$\[\]\/]/g, '_');

const TAGS = ['발주', '근무', '재고', '교육', '고객', '공지'];
const ackId = (rid, key) => 'a_' + String(rid).replace(/[^A-Za-z0-9_-]/g, '') .slice(0, 40) + '_' + key;
/* 한국 시간 */
const kst = () => new Date(Date.now() + 9 * 3600e3);
const kstDate = () => kst().toISOString().slice(0, 10);
/* 정기 휴무 — 앱의 isRegularDayOff 와 같은 규칙 */
const regularOff = (brand) => { const d = kst().getUTCDay(); return brand === 'DAY:MEAN' ? (d === 1 || d === 2) : brand === 'ETOH' ? d === 1 : false; };

export function makeChat(deps) {
  const { dbGet, dbPut, dbPatch, dbDelete, pushToPhones, accessToken } = deps;

  /* 번호 매기기 — 같은 방에 동시에 두 명이 보내도 번호가 겹치지 않게 조건부 쓰기(ETag)로 올린다 */
  async function nextSeq(env, rid) {
    const t = await accessToken(env);
    const url = `${env.FIREBASE_URL}/chat/rooms/${rid}/seq.json?access_token=${t}`;
    for (let i = 0; i < 8; i++) {
      const g = await fetch(url, { headers: { 'X-Firebase-ETag': 'true' }, cache: 'no-store' });
      const etag = g.headers.get('ETag');
      const cur = (await g.json()) || 0;
      const p = await fetch(url, { method: 'PUT', headers: { 'if-match': etag, 'Content-Type': 'application/json' }, body: JSON.stringify(cur + 1) });
      if (p.ok) return cur + 1;
      if (p.status !== 412) throw new Error('번호 매기기 실패 ' + p.status);
    }
    throw new Error('동시에 보내는 사람이 많아 잠시 후 다시 보내 주세요');
  }

  async function users(env) { return (await dbGet(env, '/users').catch(() => null)) || {}; }

  /* 지금 '급하지 않은 알림'을 받지 않을 사람: @나만 알림 · 밤 무음(22~08시) · 오늘 연차 · 정기 휴무.
     이 사람들도 @부름 · 확인 요청 · 내 글 답장은 받는다. 메시지마다 다 읽으면 느려서 5분 묶어 둔다. */
  let quietCache = { at: 0, set: new Set() };
  async function quietPhones(env) {
    if (Date.now() - quietCache.at < 5 * 60 * 1000) return quietCache.set;
    const set = new Set();
    const prefs = (await dbGet(env, '/chat/prefs').catch(() => null)) || {};
    const h = kst().getUTCHours(); const night = h >= 22 || h < 8;
    for (const [ph, p] of Object.entries(prefs)) if (p && (p.only || (p.quiet && night))) set.add(ph);
    const today = kstDate();
    const lv = (await dbGet(env, '/leave/requests').catch(() => null)) || {};
    for (const r of Object.values(lv)) if (r && r.status === '승인' && r.date === today && r.type !== '반차' && r.userId) set.add(String(r.userId));
    const us = await users(env);
    for (const [ph, u] of Object.entries(us)) if (u && regularOff(u.brand)) set.add(ph);
    quietCache = { at: Date.now(), set };
    return set;
  }

  /* 시험 기간에는 대표 + /config/comm/users 에 있는 사람만 채팅에 들어간다.
     자동방(전체 공지·지점·경영팀)에 전 직원이 들어가 버리면 시험 메시지가 모두에게 알림으로 간다. */
  async function eligible(env) {
    const cfg = (await dbGet(env, '/config/comm').catch(() => null)) || {};
    const us = await users(env);
    const out = {};
    for (const [ph, u] of Object.entries(us)) {
      if (!isActive(u)) continue;
      if (cfg.open !== true && !OWNER_PHONES.includes(ph) && !(cfg.users && cfg.users[ph])) continue;
      out[ph] = u;
    }
    return { us, el: out };
  }

  /* 자동방 인원을 직원 정보에 맞춘다(입사·퇴사·지점 이동). 5분에 한 번만 실제로 돈다. */
  async function syncAuto(env, force) {
    const meta = (await dbGet(env, '/chat/meta').catch(() => null)) || {};
    if (!force && meta.syncedAt && nowMs() - meta.syncedAt < 5 * 60 * 1000) return { skipped: true };
    const { el } = await eligible(env);
    const want = { notice: { t: 'notice', n: '전체 공지', m: {} }, hq: { t: 'hq', n: '경영팀', m: {} } };
    for (const [ph, u] of Object.entries(el)) {
      want.notice.m[ph] = 1;
      if (isHqUser(ph, u)) want.hq.m[ph] = 1;
      if (u.branch && u.branch !== '본사') {
        const rid = 'br_' + safeKey((u.brand || '') + '_' + u.branch);
        want[rid] = want[rid] || { t: 'br', n: (u.brand ? u.brand + ' ' : '') + u.branch, m: {} };
        want[rid].m[ph] = 1;
      }
    }
    /* 경영팀은 모든 지점방에 들어간다 (지점 상황을 같이 봐야 해서) */
    for (const [ph, u] of Object.entries(el)) if (isHqUser(ph, u)) for (const rid of Object.keys(want)) if (want[rid].t === 'br') want[rid].m[ph] = 1;
    const up = {};
    const rooms = (await dbGet(env, '/chat/rooms').catch(() => null)) || {};
    for (const [rid, w] of Object.entries(want)) {
      const cur = rooms[rid];
      if (!cur) { up[`chat/rooms/${rid}`] = { t: w.t, n: w.n, by: 'system', at: nowMs(), m: w.m, seq: 0, auto: 1 }; }
      else {
        up[`chat/rooms/${rid}/m`] = w.m;
        for (const ph of Object.keys(cur.m || {})) if (!w.m[ph]) up[`chat/inbox/${ph}/${rid}`] = null;   // 빠진 사람 목록에서 제거
      }
      for (const ph of Object.keys(w.m)) {
        if (!cur || !(cur.m || {})[ph]) Object.assign(up, inboxSeed(rid, cur || { t: w.t, n: w.n, seq: 0 }, w.n, ph));
      }
    }
    /* 퇴사·시험 제외된 사람은 직접 만든 방에서도 뺀다 (쓴 글은 남는다) */
    for (const [rid, r] of Object.entries(rooms)) {
      if (r.auto || !r.m) continue;
      for (const ph of Object.keys(r.m)) if (!el[ph] && r.t !== 'me') { up[`chat/rooms/${rid}/m/${ph}`] = null; up[`chat/inbox/${ph}/${rid}`] = null; }
    }
    up['chat/meta/syncedAt'] = nowMs();
    await dbPatch(env, '/', up);
    return { rooms: Object.keys(want).length };
  }

  function inboxSeed(rid, room, displayName, ph) {
    const base = `chat/inbox/${ph}/${rid}`;
    const last = room.last || {};
    return {
      [`${base}/t`]: room.t, [`${base}/n`]: displayName, [`${base}/s`]: room.seq || 0,
      [`${base}/r`]: room.seq || 0, [`${base}/at`]: last.at || room.at || nowMs(),
      [`${base}/x`]: last.x || '', [`${base}/bn`]: last.bn || '',
    };
  }

  async function getRoom(env, rid) {
    if (!/^[A-Za-z0-9_\-가-힣:]+$/.test(String(rid || ''))) throw new Error('방 정보가 올바르지 않습니다');
    const r = await dbGet(env, '/chat/rooms/' + encodeURIComponent(rid));
    if (!r) throw new Error('없는 방입니다');
    return r;
  }
  const member = (room, ph) => !!(room.m && room.m[ph]);

  async function meUser(env, me) {
    if (me.admin) throw new Error('본사 관리자 입구는 채팅을 쓸 수 없습니다. 본인 계정으로 로그인해 주세요');
    const u = await dbGet(env, '/users/' + encodeURIComponent(String(me.ph)));
    if (!isActive(u)) throw new Error('사용할 수 없는 계정입니다');
    return u;
  }

  /* 메시지 보내기 — 번호 매기기 → 메시지 · 방 최신 · 참여자 목록을 한 번에 쓰기 → 알림 */
  async function send(env, ctx, me, body) {
    const u = await meUser(env, me);
    const ph = String(me.ph);
    const rid = String(body.rid || '');
    const room = await getRoom(env, rid);
    if (!member(room, ph)) throw new Error('이 방에 참여하고 있지 않습니다');
    if (room.t === 'notice' && !isManagerUser(ph, u)) throw new Error('전체 공지방은 경영팀 · 관리자만 쓸 수 있습니다');
    const k = ['t', 'p', 'v', 'f', 'ack', 'poll'].includes(body.k) ? body.k : 't';
    /* 확인 요청 · 투표는 방 만든 사람 · 경영팀 · 관리자만 (남발되면 아무도 안 누른다) */
    if ((k === 'ack' || k === 'poll') && !(isManagerUser(ph, u) || room.by === ph)) throw new Error('확인 요청 · 투표는 방 만든 사람 · 경영팀 · 관리자만 만들 수 있습니다');
    const x = clip(body.x, 5000).trim();
    /* 첨부: u 화면에 보일 사진(보통 화질 또는 동영상 첫 장면) · o 원본 사진 · v 동영상 · f 파일 — 값은 저장소 키 */
    const keyOk = (v) => /^[po]\/[A-Za-z0-9_-]+\/[A-Za-z0-9._-]+$/.test(String(v || ''));
    const md = Array.isArray(body.md) ? body.md.slice(0, 30).map((m) => {
      const o = { w: m.w | 0, h: m.h | 0, sz: m.sz | 0 };
      for (const k of ['u', 'o', 'v', 'f']) if (keyOk(m[k])) o[k] = String(m[k]);
      if (m.n) o.n = clip(m.n, 120);
      if (m.d) o.d = Math.round(Number(m.d) || 0);
      return o;
    }).filter((m) => m.u || m.v || m.f) : null;
    if (md && !md.length) throw new Error('첨부 파일 정보가 올바르지 않습니다');
    let poll = null;
    if (k === 'poll') {
      const opts = (Array.isArray(body.poll && body.poll.o) ? body.poll.o : []).map((o) => clip(o, 60).trim()).filter(Boolean).slice(0, 10);
      if (opts.length < 2) throw new Error('선택지를 두 개 이상 넣어 주세요');
      poll = { o: opts, mu: !!body.poll.mu, end: Number(body.poll.end) || 0 };
    }
    if (!x && !md) throw new Error('보낼 내용이 없습니다');

    const bn = nameOf(u);
    const at = nowMs();
    const mnAll = body.mn === '*';
    const mn = {};
    if (!mnAll && Array.isArray(body.mn)) for (const p of body.mn) if (room.m[String(p)]) mn[String(p)] = 1;
    const root = body.root ? String(body.root) : '';
    const up = {};
    let key, seq = room.seq || 0;
    const msg = { by: ph, bn, at, k };
    if (x) msg.x = x;
    if (md) msg.md = md;
    if (mnAll) msg.mn = { '*': 1 }; else if (Object.keys(mn).length) msg.mn = mn;
    if (body.rp && body.rp.key) msg.rp = { key: String(body.rp.key), bn: clip(body.rp.bn, 30), x: clip(body.rp.x, 80) };
    if (poll) msg.poll = poll;
    if (k === 'ack') msg.ack = { n: Object.keys(room.m).length - 1 };
    if (body.fw) msg.fw = clip(body.fw, 30);
    if (Array.isArray(body.tg)) { const tg = body.tg.filter((t) => TAGS.includes(t)); if (tg.length) msg.tg = tg; }

    let rootMsg = null;
    if (root) {
      /* 답장 묶기: 방 번호는 올리지 않는다(방 목록이 쌓이지 않게). 원글에 답장 수만 올린다. */
      rootMsg = await dbGet(env, `/chat/msgs/${rid}/${root}`);
      if (!rootMsg) throw new Error('원글을 찾지 못했습니다');
      key = 't' + at.toString(36) + Math.random().toString(36).slice(2, 5);
      up[`chat/thr/${rid}/${root}/${key}`] = msg;
      up[`chat/msgs/${rid}/${root}/th`] = { c: ((rootMsg.th && rootMsg.th.c) || 0) + 1, l: at, by: { ...((rootMsg.th && rootMsg.th.by) || {}), [ph]: 1 } };
    } else {
      seq = await nextSeq(env, rid);
      key = pad(seq);
      msg.s = seq;
      up[`chat/msgs/${rid}/${key}`] = msg;
      const preview = (k === 'ack' ? '[확인 요청] ' : k === 'poll' ? '[투표] ' : '') + (x ? clip(x, 80) : (k === 'p' ? '사진' : k === 'v' ? '동영상' : '파일'));
      up[`chat/rooms/${rid}/last`] = { x: preview, by: ph, bn, at, k };
      for (const p of Object.keys(room.m)) {
        const b = `chat/inbox/${p}/${rid}`;
        up[`${b}/s`] = seq; up[`${b}/at`] = at; up[`${b}/x`] = preview; up[`${b}/bn`] = bn;
        if (p === ph) { up[`${b}/r`] = seq; up[`chat/reads/${rid}/${p}`] = seq; }
        if (p !== ph && (mnAll || mn[p])) up[`${b}/mn`] = seq;
      }
    }

    /* 내 활동: 나를 부른 것 · 내 글(또는 내가 참여한 스레드)에 달린 답 */
    const actFor = new Set();
    const actK = {};
    for (const p of Object.keys(room.m)) if (p !== ph && (mnAll || mn[p])) { actFor.add(p); actK[p] = mnAll ? 'all' : 'mention'; }
    if (rootMsg) {
      const thPeople = new Set([rootMsg.by, ...Object.keys((rootMsg.th && rootMsg.th.by) || {})]);
      for (const p of thPeople) if (p && p !== ph && room.m[p] && !actFor.has(p)) { actFor.add(p); actK[p] = 'reply'; }
    }
    if (k === 'ack') for (const p of Object.keys(room.m)) if (p !== ph) {
      up[`chat/act/${p}/${ackId(rid, key)}`] = { k: 'ack', rid, key, x: clip(x, 80), bn, at, rn: room.t === 'dm' ? bn : room.n, done: 0 };
      actFor.add(p); actK[p] = actK[p] || 'ack';
    }
    for (const p of actFor) {
      if (k === 'ack' && actK[p] === 'ack') continue;
      up[`chat/act/${p}/${rid36()}`] = { k: actK[p], rid, key: root || key, th: root ? key : null, x: clip(x || (k === 'p' ? '사진' : '첨부'), 80), bn, at, rn: room.t === 'dm' ? bn : room.n, done: 0 };
    }
    await dbPatch(env, '/', up);

    /* 알림 — 보낸 사람에게는 안 보낸다. 방 알림을 끈 사람에게는 @부른 경우 · 스레드 답에만 보낸다. */
    const muted = room.mute || {};
    const quietSet = await quietPhones(env);
    const targets = Object.keys(room.m).filter((p) => p !== ph && (root ? actFor.has(p) : (actFor.has(p) || (!muted[p] && !quietSet.has(p)))));
    if (targets.length) {
      const title = room.t === 'dm' ? bn : (room.t === 'me' ? '나와의 채팅' : room.n);
      const text = x ? clip(x, 120) : (k === 'p' ? '사진을 보냈습니다' : k === 'v' ? '동영상을 보냈습니다' : '파일을 보냈습니다');
      const head = k === 'ack' ? '[확인 요청] ' : k === 'poll' ? '[투표] ' : root ? '(답장) ' : '';
      const payload = { title, body: (room.t === 'dm' ? '' : bn + ': ') + head + text, url: './#comm/' + rid, tag: 'chat-' + rid };
      const job = pushToPhones(env, targets, payload, { urgency: actFor.size ? 'high' : 'normal', topic: 'c' + rid.slice(0, 30) }).catch(() => {});
      if (ctx && ctx.waitUntil) ctx.waitUntil(job); else await job;
    }
    return { key, seq, at };
  }

  async function ensureDm(env, me, to) {
    await meUser(env, me);
    const a = String(me.ph), b = String(to || '');
    if (!/^[0-9]{8,12}$/.test(b)) throw new Error('상대 번호가 올바르지 않습니다');
    const { el } = await eligible(env);
    if (a === b) {
      const rid = 'me_' + a;
      const r = await dbGet(env, '/chat/rooms/' + rid).catch(() => null);
      if (!r) await dbPatch(env, '/', { [`chat/rooms/${rid}`]: { t: 'me', n: '나와의 채팅', by: a, at: nowMs(), m: { [a]: 1 }, seq: 0 }, ...inboxSeed(rid, { t: 'me', seq: 0 }, '나와의 채팅', a) });
      return { rid };
    }
    if (!el[b]) throw new Error('지금은 대화할 수 없는 사람입니다');
    const rid = 'dm_' + [a, b].sort().join('_');
    const r = await dbGet(env, '/chat/rooms/' + rid).catch(() => null);
    if (!r) {
      const ua = el[a] || (await dbGet(env, '/users/' + a));
      await dbPatch(env, '/', {
        [`chat/rooms/${rid}`]: { t: 'dm', n: '', by: a, at: nowMs(), m: { [a]: 1, [b]: 1 }, seq: 0 },
        ...inboxSeed(rid, { t: 'dm', seq: 0 }, nameOf(el[b]), a),
        ...inboxSeed(rid, { t: 'dm', seq: 0 }, nameOf(ua), b),
      });
    }
    return { rid };
  }

  async function createGroup(env, me, body) {
    const u = await meUser(env, me);
    const name = clip(body.name, 40).trim();
    if (!name) throw new Error('방 이름을 입력해 주세요');
    const { el } = await eligible(env);
    const m = { [String(me.ph)]: 1 };
    for (const p of (body.members || [])) if (el[String(p)]) m[String(p)] = 1;
    if (Object.keys(m).length < 2) throw new Error('함께할 사람을 한 명 이상 골라 주세요');
    const rid = 'g' + rid36();
    const room = { t: 'grp', n: name, by: String(me.ph), at: nowMs(), m, seq: 0 };
    const up = { [`chat/rooms/${rid}`]: room };
    for (const p of Object.keys(m)) Object.assign(up, inboxSeed(rid, room, name, p));
    await dbPatch(env, '/', up);
    await sysMsg(env, rid, `${nameOf(u)}님이 방을 만들었습니다`);
    return { rid };
  }

  async function sysMsg(env, rid, text) {
    const seq = await nextSeq(env, rid);
    const room = await getRoom(env, rid);
    const at = nowMs();
    const up = { [`chat/msgs/${rid}/${pad(seq)}`]: { s: seq, by: 'system', bn: '', at, k: 'sys', x: text }, [`chat/rooms/${rid}/last`]: { x: text, by: 'system', bn: '', at, k: 'sys' } };
    for (const p of Object.keys(room.m || {})) { const b = `chat/inbox/${p}/${rid}`; up[`${b}/s`] = seq; up[`${b}/at`] = at; up[`${b}/x`] = text; up[`${b}/bn`] = ''; }
    await dbPatch(env, '/', up);
  }

  async function invite(env, me, body) {
    const u = await meUser(env, me);
    const rid = String(body.rid || '');
    const room = await getRoom(env, rid);
    if (!member(room, String(me.ph))) throw new Error('이 방에 참여하고 있지 않습니다');
    if (room.t !== 'grp') throw new Error('직접 만든 방에만 초대할 수 있습니다');
    const { el } = await eligible(env);
    const add = (body.phones || []).map(String).filter((p) => el[p] && !room.m[p]);
    if (!add.length) throw new Error('초대할 사람이 없습니다');
    const up = {};
    for (const p of add) { up[`chat/rooms/${rid}/m/${p}`] = 1; Object.assign(up, inboxSeed(rid, room, room.n, p)); }
    await dbPatch(env, '/', up);
    await sysMsg(env, rid, `${nameOf(u)}님이 ${add.map((p) => nameOf(el[p]) + '님').join(', ')}을 초대했습니다`);
    return { added: add.length };
  }

  async function kick(env, me, body) {
    const u = await meUser(env, me);
    if (!isManagerUser(String(me.ph), u)) throw new Error('내보내기는 경영팀 · 관리자만 할 수 있습니다');
    const rid = String(body.rid || ''), who = String(body.ph || '');
    const room = await getRoom(env, rid);
    if (room.t !== 'grp') throw new Error('자동으로 만들어진 방은 직원 정보에 따라 인원이 정해집니다');
    if (!room.m[who]) throw new Error('이 방에 없는 사람입니다');
    const wu = await dbGet(env, '/users/' + who).catch(() => null);
    await dbPatch(env, '/', { [`chat/rooms/${rid}/m/${who}`]: null, [`chat/inbox/${who}/${rid}`]: null });
    await sysMsg(env, rid, `${nameOf(u)}님이 ${nameOf(wu) || who}님을 내보냈습니다`);
    return {};
  }

  async function leave(env, me, body) {
    const u = await meUser(env, me);
    const rid = String(body.rid || '');
    const room = await getRoom(env, rid);
    if (room.t !== 'grp') throw new Error('이 방은 나갈 수 없습니다');
    await dbPatch(env, '/', { [`chat/rooms/${rid}/m/${me.ph}`]: null, [`chat/inbox/${me.ph}/${rid}`]: null });
    await sysMsg(env, rid, `${nameOf(u)}님이 나갔습니다`);
    return {};
  }

  async function rename(env, me, body) {
    const u = await meUser(env, me);
    const rid = String(body.rid || '');
    const room = await getRoom(env, rid);
    if (room.t !== 'grp') throw new Error('이름을 바꿀 수 없는 방입니다');
    if (room.by !== String(me.ph) && !isManagerUser(String(me.ph), u)) throw new Error('방 만든 사람 · 경영팀 · 관리자만 바꿀 수 있습니다');
    const name = clip(body.name, 40).trim();
    if (!name) throw new Error('방 이름을 입력해 주세요');
    const up = { [`chat/rooms/${rid}/n`]: name };
    for (const p of Object.keys(room.m || {})) up[`chat/inbox/${p}/${rid}/n`] = name;
    await dbPatch(env, '/', up);
    await sysMsg(env, rid, `${nameOf(u)}님이 방 이름을 '${name}'(으)로 바꿨습니다`);
    return {};
  }

  async function mute(env, me, body) {
    await meUser(env, me);
    const rid = String(body.rid || '');
    const room = await getRoom(env, rid);
    if (!member(room, String(me.ph))) throw new Error('이 방에 참여하고 있지 않습니다');
    await dbPatch(env, '/', { [`chat/rooms/${rid}/mute/${me.ph}`]: body.on ? 1 : null, [`chat/inbox/${me.ph}/${rid}/mute`]: body.on ? 1 : null });
    return {};
  }

  async function editOrDelete(env, me, body, del) {
    const u = await meUser(env, me);
    const rid = String(body.rid || ''), key = String(body.key || ''), root = body.root ? String(body.root) : '';
    const room = await getRoom(env, rid);
    if (!member(room, String(me.ph))) throw new Error('이 방에 참여하고 있지 않습니다');
    const path = root ? `/chat/thr/${rid}/${root}/${key}` : `/chat/msgs/${rid}/${key}`;
    const m = await dbGet(env, path);
    if (!m) throw new Error('메시지를 찾지 못했습니다');
    const mine = m.by === String(me.ph);
    if (del === 'hide') {
      if (!isManagerUser(String(me.ph), u)) throw new Error('가리기는 경영팀 · 관리자만 할 수 있습니다');
      await dbPatch(env, path, { x: null, md: null, hid: { by: nameOf(u), at: nowMs() } });
      return {};
    }
    if (!mine) throw new Error('내가 보낸 메시지만 바꿀 수 있습니다');
    if (del) await dbPatch(env, path, { x: null, md: null, del: 1 });
    else {
      const x = clip(body.x, 5000).trim();
      if (!x) throw new Error('내용을 입력해 주세요');
      await dbPatch(env, path, { x, ed: nowMs() });
    }
    return {};
  }

  async function react(env, me, body) {
    await meUser(env, me);
    const rid = String(body.rid || ''), key = String(body.key || ''), root = body.root ? String(body.root) : '';
    const r = ['확인', '좋아요', '감사'].includes(body.r) ? body.r : null;
    if (!r) throw new Error('반응 종류가 올바르지 않습니다');
    const room = await getRoom(env, rid);
    if (!member(room, String(me.ph))) throw new Error('이 방에 참여하고 있지 않습니다');
    const path = (root ? `/chat/thr/${rid}/${root}/${key}` : `/chat/msgs/${rid}/${key}`) + `/rx/${r}/${me.ph}`;
    const cur = await dbGet(env, path).catch(() => null);
    if (cur) await dbDelete(env, path); else await dbPut(env, path, 1);
    return { on: !cur };
  }

  async function pinNotice(env, me, body) {
    const u = await meUser(env, me);
    const rid = String(body.rid || '');
    const room = await getRoom(env, rid);
    if (!member(room, String(me.ph))) throw new Error('이 방에 참여하고 있지 않습니다');
    if (!isManagerUser(String(me.ph), u) && room.by !== String(me.ph)) throw new Error('방 공지는 방 만든 사람 · 경영팀 · 관리자만 올릴 수 있습니다');
    if (!body.key) { await dbPut(env, `/chat/rooms/${rid}/pin`, null); return {}; }
    const m = await dbGet(env, `/chat/msgs/${rid}/${String(body.key)}`);
    if (!m || m.del) throw new Error('메시지를 찾지 못했습니다');
    await dbPut(env, `/chat/rooms/${rid}/pin`, { key: String(body.key), x: clip(m.x || '사진', 200), bn: m.bn, at: nowMs(), by: nameOf(u) });
    return {};
  }

  async function msgOf(env, rid, key) { const m = await dbGet(env, `/chat/msgs/${rid}/${key}`); if (!m) throw new Error('메시지를 찾지 못했습니다'); return m; }

  async function ack(env, me, body) {
    await meUser(env, me);
    const rid = String(body.rid || ''), key = String(body.key || '');
    const room = await getRoom(env, rid);
    if (!member(room, String(me.ph))) throw new Error('이 방에 참여하고 있지 않습니다');
    const m = await msgOf(env, rid, key);
    if (m.k !== 'ack') throw new Error('확인 요청 메시지가 아닙니다');
    await dbPatch(env, '/', { [`chat/msgs/${rid}/${key}/ack/${me.ph}`]: nowMs(), [`chat/act/${me.ph}/${ackId(rid, key)}/done`]: 1 });
    return {};
  }

  async function vote(env, me, body) {
    await meUser(env, me);
    const rid = String(body.rid || ''), key = String(body.key || '');
    const room = await getRoom(env, rid);
    if (!member(room, String(me.ph))) throw new Error('이 방에 참여하고 있지 않습니다');
    const m = await msgOf(env, rid, key);
    if (!m.poll) throw new Error('투표 메시지가 아닙니다');
    if (m.poll.end && nowMs() > m.poll.end) throw new Error('마감된 투표입니다');
    let pick = (Array.isArray(body.i) ? body.i : [body.i]).map((n) => n | 0).filter((n) => n >= 0 && n < m.poll.o.length);
    if (!m.poll.mu) pick = pick.slice(0, 1);
    await dbPut(env, `/chat/msgs/${rid}/${key}/vt/${me.ph}`, pick.length ? pick : null);
    return {};
  }

  /* 확인 안 한 사람에게만 다시 알림 — 보낸 사람 · 경영팀 · 관리자 */
  async function nudge(env, me, body) {
    const u = await meUser(env, me);
    const rid = String(body.rid || ''), key = String(body.key || '');
    const room = await getRoom(env, rid);
    const m = await msgOf(env, rid, key);
    if (m.by !== String(me.ph) && !isManagerUser(String(me.ph), u)) throw new Error('보낸 사람 · 경영팀 · 관리자만 다시 알릴 수 있습니다');
    const done = m.ack || {};
    const rest = Object.keys(room.m || {}).filter((p) => p !== m.by && !done[p]);
    if (!rest.length) return { sent: 0 };
    await pushToPhones(env, rest, { title: room.t === 'dm' ? nameOf(u) : room.n, body: '[확인 요청 다시 알림] ' + clip(m.x, 100), url: './#comm/' + rid, tag: 'ack-' + key }, { urgency: 'high' });
    return { sent: rest.length };
  }

  async function prefs(env, me, body) {
    await meUser(env, me);
    const v = { quiet: body.quiet ? 1 : null, only: body.only ? 1 : null };
    await dbPut(env, `/chat/prefs/${me.ph}`, (v.quiet || v.only) ? v : null);
    quietCache.at = 0;
    return {};
  }

  async function later(env, me, body) {
    await meUser(env, me);
    const rid = String(body.rid || ''), key = String(body.key || '');
    const room = await getRoom(env, rid);
    if (!member(room, String(me.ph))) throw new Error('이 방에 참여하고 있지 않습니다');
    const id = 'l_' + ackId(rid, key).slice(2);
    if (!body.on) { await dbDelete(env, `/chat/act/${me.ph}/${id}`); return {}; }
    const m = await msgOf(env, rid, key);
    await dbPut(env, `/chat/act/${me.ph}/${id}`, { k: 'later', rid, key, x: clip(m.x || '사진', 80), bn: m.bn, at: nowMs(), rn: room.t === 'dm' ? m.bn : room.n, done: 0 });
    return {};
  }

  /* 다시 알림 — 정해 둔 시각에 5분 타이머(scheduled)가 보낸다 */
  async function remind(env, me, body) {
    await meUser(env, me);
    const rid = String(body.rid || ''), key = String(body.key || '');
    const at = Number(body.at) || 0;
    if (at < nowMs() + 60 * 1000 || at > nowMs() + 30 * 86400e3) throw new Error('알림 시각이 올바르지 않습니다');
    const room = await getRoom(env, rid);
    if (!member(room, String(me.ph))) throw new Error('이 방에 참여하고 있지 않습니다');
    const m = await msgOf(env, rid, key);
    const id = at.toString(36).padStart(9, '0') + '_' + rid36();
    await dbPut(env, `/chat/remind/${id}`, { ph: String(me.ph), rid, key, x: clip(m.x || '사진', 80), bn: m.bn, rn: room.t === 'dm' ? m.bn : room.n, at });
    return { id };
  }
  async function runReminders(env) {
    const all = (await dbGet(env, '/chat/remind').catch(() => null)) || {};
    const due = Object.entries(all).filter(([, r]) => r && r.at <= nowMs() + 30 * 1000);
    for (const [id, r] of due) {
      await dbPatch(env, '/', {
        [`chat/remind/${id}`]: null,
        [`chat/act/${r.ph}/r_${id}`]: { k: 'remind', rid: r.rid, key: r.key, x: r.x, bn: r.bn, at: nowMs(), rn: r.rn, done: 0 },
      });
      await pushToPhones(env, [r.ph], { title: '다시 알림 · ' + (r.rn || ''), body: (r.bn ? r.bn + ': ' : '') + r.x, url: './#comm/' + r.rid, tag: 'remind-' + id }, { urgency: 'high' }).catch(() => {});
    }
    return due.length;
  }

  /* 전달 — 다른 방으로 복사. 사진·동영상은 그 방 저장 위치로 파일도 복사한다(방마다 열람 권한이 다르므로). */
  async function forward(env, ctx, me, body) {
    const rid = String(body.rid || ''), key = String(body.key || ''), to = String(body.to || '');
    const room = await getRoom(env, rid);
    if (!member(room, String(me.ph))) throw new Error('이 방에 참여하고 있지 않습니다');
    const m = await msgOf(env, rid, key);
    if (m.del || m.hid) throw new Error('지워진 메시지는 전달할 수 없습니다');
    let md = null;
    if (m.md && m.md.length) {
      const toRoom = await getRoom(env, to);
      if (!member(toRoom, String(me.ph))) throw new Error('보낼 방에 참여하고 있지 않습니다');
      const tag = await deps.roomTag(to);
      md = [];
      for (const it of m.md) {
        const o = { w: it.w, h: it.h, sz: it.sz, n: it.n, d: it.d };
        for (const f of ['u', 'o', 'v', 'f']) if (it[f]) {
          const src = await env.CHAT_MEDIA.get(it[f]);
          if (!src) continue;
          const nk = it[f].replace(/^([po])\/[^/]+\//, `$1/${tag}/`).replace(/(\.[A-Za-z0-9]+)$/, '_f' + Date.now().toString(36) + '$1');
          await env.CHAT_MEDIA.put(nk, src.body, { httpMetadata: src.httpMetadata });
          o[f] = nk;
        }
        if (o.u || o.v || o.f) md.push(o);
      }
      if (!md.length) md = null;
    }
    return send(env, ctx, me, { rid: to, k: m.k === 'v' || m.k === 'p' ? m.k : 't', x: m.x || '', md, fw: m.bn });
  }

  /* 대화 내보내기 — 경영팀만, 단체방만 (1:1 은 내보낼 수 없다) */
  async function exportRoom(env, me, body) {
    const u = await meUser(env, me);
    if (!isHqUser(String(me.ph), u)) throw new Error('대화 내보내기는 경영팀만 할 수 있습니다');
    const rid = String(body.rid || '');
    const room = await getRoom(env, rid);
    if (room.t === 'dm' || room.t === 'me') throw new Error('1:1 대화는 내보낼 수 없습니다');
    const msgs = (await dbGet(env, `/chat/msgs/${rid}`).catch(() => null)) || {};
    const lines = Object.keys(msgs).sort().map((k) => {
      const m = msgs[k]; const d = new Date(m.at + 9 * 3600e3).toISOString().replace('T', ' ').slice(0, 16);
      const body = m.del ? '(삭제된 메시지)' : m.hid ? '(관리자가 가린 메시지)' : (m.x || '') + (m.md ? ` [첨부 ${m.md.length}개]` : '');
      return `${d}\t${m.k === 'sys' ? '안내' : m.bn}\t${String(body).replace(/\n/g, ' / ')}`;
    });
    return { name: room.n || rid, text: '시각\t보낸 사람\t내용\n' + lines.join('\n') };
  }

  /* 안 읽은 것 요약 — 단체방만. 내가 마지막으로 읽은 뒤의 메시지(최대 300개)를 AI 로 몇 줄 정리 */
  async function summary(env, me, body) {
    const u = await meUser(env, me);
    const rid = String(body.rid || '');
    const room = await getRoom(env, rid);
    if (!member(room, String(me.ph))) throw new Error('이 방에 참여하고 있지 않습니다');
    if (room.t === 'dm' || room.t === 'me') throw new Error('1:1 대화는 요약하지 않습니다');
    const r = (await dbGet(env, `/chat/reads/${rid}/${me.ph}`).catch(() => null)) || 0;
    if ((room.seq || 0) <= r) return { lines: [], asks: [], count: 0 };
    const t = await accessToken(env);
    const q = `orderBy=%22%24key%22&startAt=%22${pad(Math.max(r + 1, (room.seq || 0) - 299))}%22`;
    const res = await fetch(`${env.FIREBASE_URL}/chat/msgs/${encodeURIComponent(rid)}.json?${q}&access_token=${t}`);
    const msgs = (await res.json()) || {};
    const list = Object.keys(msgs).sort().map((k) => msgs[k]).filter((m) => m && m.k !== 'sys' && !m.del && !m.hid)
      .map((m) => ({ bn: m.bn, x: (m.k === 'ack' ? '[확인 요청] ' : m.k === 'poll' ? '[투표] ' : '') + (m.x || (m.md ? `(사진·동영상 ${m.md.length}개)` : '')), me: !!(m.mn && (m.mn['*'] || m.mn[me.ph])) }));
    if (!list.length) return { lines: [], asks: [], count: 0 };
    const cfg = await dbGet(env, '/config/naverWorks').catch(() => null);
    if (!cfg || !cfg.url || !cfg.secret) throw new Error('AI 설정이 없어요');
    const relayReq = new Request(String(cfg.url).replace(/\/+$/, '') + '/ai/chat-summary', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ secret: cfg.secret, room: room.n || '', me: nameOf(u), messages: list }),
    });
    const ar = env.AI_RELAY ? await env.AI_RELAY.fetch(relayReq) : await fetch(relayReq);
    const d = await ar.json().catch(() => null);
    if (!d || !d.ok) throw new Error((d && d.error) || '요약하지 못했습니다');
    return { lines: d.lines || [], asks: d.asks || [], count: list.length };
  }

  /* 라우터 — 처리했으면 Response 를, 아니면 null 을 돌려준다 */
  const route = async function route(path, request, env, ctx, me, json, origin) {
    if (!path.startsWith('/chat/')) return null;
    if (request.method !== 'POST') return json({ ok: false, error: 'POST 만 받습니다' }, 405, origin);
    const body = await request.json().catch(() => ({}));
    try {
      let out;
      switch (path) {
        case '/chat/bootstrap': await meUser(env, me); out = await syncAuto(env, !!body.force); break;
        case '/chat/send': out = await send(env, ctx, me, body); break;
        case '/chat/dm': out = await ensureDm(env, me, body.to); break;
        case '/chat/group': out = await createGroup(env, me, body); break;
        case '/chat/invite': out = await invite(env, me, body); break;
        case '/chat/kick': out = await kick(env, me, body); break;
        case '/chat/leave': out = await leave(env, me, body); break;
        case '/chat/rename': out = await rename(env, me, body); break;
        case '/chat/mute': out = await mute(env, me, body); break;
        case '/chat/edit': out = await editOrDelete(env, me, body, false); break;
        case '/chat/delete': out = await editOrDelete(env, me, body, true); break;
        case '/chat/hide': out = await editOrDelete(env, me, body, 'hide'); break;
        case '/chat/react': out = await react(env, me, body); break;
        case '/chat/pin': out = await pinNotice(env, me, body); break;
        case '/chat/ack': out = await ack(env, me, body); break;
        case '/chat/vote': out = await vote(env, me, body); break;
        case '/chat/nudge': out = await nudge(env, me, body); break;
        case '/chat/prefs': out = await prefs(env, me, body); break;
        case '/chat/later': out = await later(env, me, body); break;
        case '/chat/remind': out = await remind(env, me, body); break;
        case '/chat/forward': out = await forward(env, ctx, me, body); break;
        case '/chat/export': out = await exportRoom(env, me, body); break;
        case '/chat/summary': out = await summary(env, me, body); break;
        default: return json({ ok: false, error: '없는 기능입니다' }, 404, origin);
      }
      return json({ ok: true, ...(out || {}) }, 200, origin);
    } catch (e) {
      return json({ ok: false, error: e.message || String(e) }, 400, origin);
    }
  };
  route.runReminders = runReminders;
  return route;
}
