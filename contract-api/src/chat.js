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
 *   /chat/inbox/{폰}/{rid}   { s 방 최신 번호, r 내가 읽은 번호, at, x, bn, t, n 이 사람에게 보일 방 이름, mn 나를 부른 번호,
 *                              pin 상단 고정 시각, nm 나만 보는 방 이름, hid 1:1 숨긴 시점 번호(s 가 커지면 다시 보임) }
 *   /chat/sched/{id}         예약 메시지 { ph, rid, x, at 보낼 시각, mn } — 1분 타이머가 보낸다
 *   /chat/notices/{nid}      팝업 공지 { rid, t 제목, x 본문, md:[{u,w,h}] 사진, by, bn, at, end 내린 시각, key 대화에 올린 메시지 }
 *   /chat/nseen/{nid}/{폰}   팝업 닫은 기록 { m ok|day|week, until 다시 띄울 시각(ok 는 0), at }
 *   /chat/reads/{rid}/{폰}   내가 읽은 번호 — 말풍선 옆 '안 읽은 사람 수' 계산용
 *   /chat/act/{폰}/{id}      내 활동 { k mention · reply · all, rid, key, x, bn, at, done }
 *
 * 방 종류: notice 전체 공지 · hq 경영팀 · ops 업무 알림(발주·환불·가발·내수 — 네이버웍스 봇 대신, 경영팀) · br 지점 · dm 1:1 · grp 직접 만든 방 · me 나와의 채팅
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
/* 교육 자동방(11/13 사용자 결정) — 레벨방: 그 레벨 인턴 전원(회사 전체) + 디자이너 전원 + 경영팀 / 팀방: 담당 디자이너(인턴의 mentorId) + 그 디자이너 담당 인턴(경영팀 없음).
   알림: 디자이너 · 경영팀은 레벨방에 '알림 끔'으로 들어간다(처음 들어갈 때만, 각자 바꿀 수 있음). 끔이어도 @나 · 내 담당 인턴 글 · 내 인턴을 부른 글은 알림.
   새로 들어온 사람에게 이전 대화는 안 보인다(inbox j = 들어올 때 방 번호, 앱이 그 이전 메시지를 안 그림). 인턴별 방은 만들지 않는다 */
const LEVELS = ['BASIC', 'BRONZE-1', 'BRONZE-2', 'SILVER-1', 'SILVER-2', 'SILVER-3', 'GOLD-1', 'GOLD-2', 'GOLD-3'];
const isInternU = (u) => !!u && (u.role === '인턴' || u.academyRole === '인턴');
const isDesignerU = (u) => !!u && (u.role === '디자이너' || (Array.isArray(u.roles) && u.roles.includes('디자이너')));
const hasGrade = (g) => (u) => !!u && (u.systemGrade === g || u.role === g || (Array.isArray(u.roles) && u.roles.includes(g)));
/* [방 키, 이름, 해당자, 같이 들어갈 사람(알림 끔으로)] — 사용자 결정 11/13: 카운터 방 없음 · 인턴 전체 · 스탭장 전체에는 관리자 · 디자이너도 */
const obsMD = (u) => hasGrade('관리자')(u) || isDesignerU(u);
const ALL_ROOMS = [['designers', '디자이너', isDesignerU, null], ['interns', '인턴', isInternU, obsMD], ['managers', '관리자', hasGrade('관리자'), null], ['staffleads', '스탭장', hasGrade('스탭장'), obsMD]];
const EDU_T = { lv: 1, tm: 1, all: 1 };   // all: 디자이너 전체 · 인턴 전체 (11/13 추가 요청) — 각 해당자 전원 + 경영팀, 알림은 켠 채로

const TAGS = ['발주', '근무', '재고', '교육', '고객', '공지'];
const ackId = (rid, key) => 'a_' + String(rid).replace(/[^A-Za-z0-9_-]/g, '') .slice(0, 40) + '_' + key;
/* 한국 시간 */
const kst = () => new Date(Date.now() + 9 * 3600e3);
const kstDate = () => kst().toISOString().slice(0, 10);
/* 정기 휴무 — 앱의 isRegularDayOff 와 같은 규칙 */
const regularOff = (brand) => { const d = kst().getUTCDay(); return brand === 'DAY:MEAN' ? (d === 1 || d === 2) : brand === 'ETOH' ? d === 1 : false; };

/* ═══ 링크 미리보기 ═══
   주소의 HTML 앞부분(최대 300KB · 4초)만 읽어 og:title · og:description · og:image 를 뽑는다.
   사내 주소 · IP 주소 · http/https 아닌 것은 열지 않는다(남의 내부망을 대신 열어 주지 않게). */
const URL_RE = /https?:\/\/[^\s<>"']+/;
const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
const decodeEnt = (s) => String(s).replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => e[0] === '#' ? String.fromCodePoint(e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10)) : (ENT[e.toLowerCase()] ?? m));
function safeUrl(u) {
  try {
    const x = new URL(u);
    if (x.protocol !== 'https:' && x.protocol !== 'http:') return null;
    const h = x.hostname.toLowerCase();
    if (!h.includes('.') || /^(localhost|.*\.local|.*\.internal|.*\.lan)$/.test(h) || /^[\d.]+$/.test(h) || h.includes(':')) return null;
    return x;
  } catch (_) { return null; }
}
async function unfurl(u) {
  const x = safeUrl(u.replace(/[),.!?]+$/, ''));
  if (!x) return null;
  const ac = new AbortController(); const timer = setTimeout(() => ac.abort(), 4000);
  try {
    /* 유튜브는 페이지 앞부분에 제목이 안 나와서 공식 oEmbed 로 */
    if (/(^|\.)(youtube\.com|youtu\.be)$/.test(x.hostname)) {
      const o = await fetch('https://www.youtube.com/oembed?format=json&url=' + encodeURIComponent(x.href), { signal: ac.signal });
      if (!o.ok) return null;
      const j = await o.json();
      if (!j || !j.title) return null;
      const lp = { u: x.href.slice(0, 500), t: String(j.title).slice(0, 100), h: 'youtube.com' };
      if (j.author_name) lp.d = String(j.author_name).slice(0, 160);
      if (j.thumbnail_url && String(j.thumbnail_url).startsWith('https://')) lp.i = String(j.thumbnail_url).slice(0, 500);
      return lp;
    }
    const r = await fetch(x.href, { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; DMLinkPreview/1.0)', Accept: 'text/html' }, redirect: 'follow', signal: ac.signal });
    if (!r.ok || !/text\/html/i.test(r.headers.get('content-type') || '') || !r.body) return null;
    const reader = r.body.getReader(); const dec = new TextDecoder(); let html = '', n = 0;
    while (n < 300000) { const { done, value } = await reader.read(); if (done) break; n += value.length; html += dec.decode(value, { stream: true }); if (/<\/head>/i.test(html)) break; }
    try { await reader.cancel(); } catch (_) {}
    const pick = (re) => { const m = html.match(re); return m ? decodeEnt(m[1]).replace(/\s+/g, ' ').trim() : ''; };
    const meta = (p) => pick(new RegExp(`<meta[^>]+(?:property|name)=["']${p}["'][^>]*content=["']([^"']*)["']`, 'i')) || pick(new RegExp(`<meta[^>]+content=["']([^"']*)["'][^>]*(?:property|name)=["']${p}["']`, 'i'));
    const t = meta('og:title') || meta('twitter:title') || pick(/<title[^>]*>([^<]*)<\/title>/i);
    if (!t) return null;
    let img = meta('og:image') || meta('twitter:image');
    if (img) { try { img = new URL(img, r.url || x.href).href; if (!img.startsWith('https://')) img = ''; } catch (_) { img = ''; } }
    const lp = { u: x.href.slice(0, 500), t: t.slice(0, 100), h: x.hostname.replace(/^www\./, '') };
    const d = meta('og:description') || meta('description'); if (d) lp.d = d.slice(0, 160);
    if (img) lp.i = img.slice(0, 500);
    return lp;
  } catch (_) { return null; } finally { clearTimeout(timer); }
}

export function makeChat(deps) {
  const { dbGet, dbPut, dbPatch, dbDelete, pushToPhones, accessToken, signedUrl } = deps;

  /* 번호 매기기 — 같은 방에 동시에 두 명이 보내도 번호가 겹치지 않게 조건부 쓰기(ETag)로 올린다 */
  /* 방 번호 읽기(ETag 포함) — 보내기에서는 계정 · 방 확인과 동시에 미리 읽어 DB 왕복 하나를 줄인다 */
  async function seqRead(env, rid) {
    const t = await accessToken(env);
    const url = `${env.FIREBASE_URL}/chat/rooms/${rid}/seq.json?access_token=${t}`;
    const g = await fetch(url, { headers: { 'X-Firebase-ETag': 'true' }, cache: 'no-store' });
    return { url, etag: g.headers.get('ETag'), cur: (await g.json()) || 0 };
  }
  async function nextSeq(env, rid, pre) {
    for (let i = 0; i < 8; i++) {
      const r = i === 0 && pre ? await pre : await seqRead(env, rid);
      const url = r.url, etag = r.etag, cur = r.cur;
      const p = await fetch(url, { method: 'PUT', headers: { 'if-match': etag, 'Content-Type': 'application/json' }, body: JSON.stringify(cur + 1) });
      if (p.ok) return cur + 1;
      if (p.status !== 412) throw new Error('번호 매기기 실패 ' + p.status);
    }
    throw new Error('동시에 보내는 사람이 많아 잠시 후 다시 보내 주세요');
  }

  async function users(env) { return (await dbGet(env, '/users').catch(() => null)) || {}; }
  let _usC = null, _usAt = 0;
  async function usersCached(env) { if (!_usC || nowMs() - _usAt > 300000) { _usC = await users(env); _usAt = nowMs(); } return _usC; }

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
    const want = { notice: { t: 'notice', n: '전체 공지', m: {} }, hq: { t: 'hq', n: '본사경영팀', m: {} }, ops: { t: 'ops', n: '업무 알림', m: {} } };
    for (const [ph, u] of Object.entries(el)) {
      want.notice.m[ph] = 1;
      if (isHqUser(ph, u)) { want.hq.m[ph] = 1; want.ops.m[ph] = 1; }
      if (u.branch && u.branch !== '본사') {
        const rid = 'br_' + safeKey((u.brand || '') + '_' + u.branch);
        want[rid] = want[rid] || { t: 'br', n: (u.brand ? u.brand + ' ' : '') + u.branch, m: {} };
        want[rid].m[ph] = 1;
      }
    }
    /* 교육 자동방 — /config/comm/autoRooms {lv:false} 처럼 끄면 그 종류는 안 만든다(이미 있던 방은 인원만 비운다) */
    const ar = (await dbGet(env, '/config/comm/autoRooms').catch(() => null)) || {};
    if (ar.lv !== false) {
      for (const [ph, u] of Object.entries(el)) {
        if (!isInternU(u)) continue;
        const L = LEVELS.includes(u.level) ? u.level : 'BASIC';
        const rid = 'lv_' + safeKey(L);
        want[rid] = want[rid] || { t: 'lv', n: L, m: {}, mute: {}, ord: LEVELS.indexOf(L) };   // 이름은 레벨만(11/13 사용자: '인턴' 빼기)
        want[rid].m[ph] = 1;
      }
      for (const w of Object.values(want)) if (w.t === 'lv') for (const [ph, u] of Object.entries(el)) if (isDesignerU(u) || isHqUser(ph, u)) { w.m[ph] = 1; if (!isInternU(u)) w.mute[ph] = 1; }
    }
    if (ar.all !== false) {
      /* 등급별 전체방(11/13) — 디자이너 · 인턴 · 관리자 · 스탭장 · 카운터 전체. 해당자 전원 + 경영팀, 해당자가 한 명도 없으면 안 만든다(있던 방은 비움) */
      for (const [key, label, is, also] of ALL_ROOMS) {
        if (ar['all_' + key] === false) continue;
        const w = { t: 'all', n: label + ' 전체', m: {}, mute: {} };
        for (const [ph, u] of Object.entries(el)) if (is(u)) w.m[ph] = 1;
        if (!Object.keys(w.m).length) continue;
        if (also) for (const [ph, u] of Object.entries(el)) if (!w.m[ph] && also(u)) { w.m[ph] = 1; w.mute[ph] = 1; }
        for (const [ph, u] of Object.entries(el)) if (isHqUser(ph, u)) w.m[ph] = 1;
        want['all_' + key] = w;
      }
    }
    if (ar.tm !== false) {
      for (const [ph, u] of Object.entries(el)) {
        if (!isInternU(u) || !u.mentorId || !el[u.mentorId]) continue;
        const mp = String(u.mentorId), mu = el[mp];
        const rid = 'tm_' + safeKey(mp);
        want[rid] = want[rid] || { t: 'tm', n: nameOf(mu) + (mu.position ? ' ' + mu.position + '님' : '') + ' 팀', m: { [mp]: 1 }, mute: {} };
        want[rid].m[ph] = 1;
      }
      /* 팀방엔 경영팀을 넣지 않는다(사용자 결정 11/13) — 담당 디자이너 + 담당 인턴만. 이미 들어가 있던 경영팀은 다음 맞추기에서 빠진다 */
    }
    /* 경영팀은 모든 지점방에 들어간다 (지점 상황을 같이 봐야 해서) */
    for (const [ph, u] of Object.entries(el)) if (isHqUser(ph, u)) for (const rid of Object.keys(want)) if (want[rid].t === 'br') want[rid].m[ph] = 1;
    const up = {};
    const rooms = (await dbGet(env, '/chat/rooms').catch(() => null)) || {};
    for (const [rid, w] of Object.entries(want)) {
      const cur = rooms[rid];
      if (!cur) { up[`chat/rooms/${rid}`] = { t: w.t, n: w.n, by: 'system', at: nowMs(), m: w.m, seq: 0, auto: 1, ...(w.mute && Object.keys(w.mute).length ? { mute: w.mute } : {}) }; }
      else {
        up[`chat/rooms/${rid}/m`] = w.m;
        for (const ph of Object.keys(cur.m || {})) if (!w.m[ph]) up[`chat/inbox/${ph}/${rid}`] = null;   // 빠진 사람 목록에서 제거
        /* 자동방 이름이 바뀌면(레벨 · 디자이너 이름 · '경영팀'→'본사경영팀' 11/13) 모두의 목록 이름도 */
        if ((EDU_T[w.t] || w.t === 'hq') && cur.n !== w.n) { up[`chat/rooms/${rid}/n`] = w.n; for (const ph of Object.keys(w.m)) if ((cur.m || {})[ph]) up[`chat/inbox/${ph}/${rid}/n`] = w.n; }
      }
      for (const ph of Object.keys(w.m)) {
        if (!cur || !(cur.m || {})[ph]) {
          Object.assign(up, inboxSeed(rid, cur || { t: w.t, n: w.n, seq: 0 }, w.n, ph));
          if (EDU_T[w.t]) {
            up[`chat/inbox/${ph}/${rid}/j`] = (cur && cur.seq) || 0;   // 이 번호까지의 대화는 안 보인다
            if (w.mute && w.mute[ph]) { up[`chat/inbox/${ph}/${rid}/mute`] = 1; if (cur) up[`chat/rooms/${rid}/mute/${ph}`] = 1; }
          }
        }
      }
    }
    /* 인턴이 없어진 레벨방 · 팀방(또는 끈 종류)은 인원을 비운다 — 방과 글은 남고, 다시 생기면 그때 들어온 사람은 이전 대화가 안 보인다 */
    for (const [rid, r] of Object.entries(rooms)) {
      if (!r.auto || !EDU_T[r.t] || want[rid] || !r.m) continue;
      up[`chat/rooms/${rid}/m`] = null;
      for (const ph of Object.keys(r.m)) up[`chat/inbox/${ph}/${rid}`] = null;
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

  /* 경영팀 설정 › 자동 단톡방 (11/13) — 종류별 켜기 · 끄기 + 지금 있는 자동방 목록. /config/comm/autoRooms 는 서버만 쓴다 */
  const AUTO_KEYS = ['lv', 'tm', ...ALL_ROOMS.map((r) => 'all_' + r[0])];
  async function autoConfig(env, me, body) {
    const u = await meUser(env, me);
    if (!isHqUser(String(me.ph), u)) throw new Error('경영팀만 바꿀 수 있어요');
    let ar = (await dbGet(env, '/config/comm/autoRooms').catch(() => null)) || {};
    if (body && body.set && typeof body.set === 'object') {
      for (const k of AUTO_KEYS) if (k in body.set) ar[k] = !!body.set[k];
      await dbPut(env, '/config/comm/autoRooms', ar);
      await syncAuto(env, true);
    }
    const rooms = (await dbGet(env, '/chat/rooms').catch(() => null)) || {};
    const list = Object.entries(rooms).filter(([, r]) => r && r.auto && EDU_T[r.t]).map(([rid, r]) => ({ rid, t: r.t, n: r.n, m: Object.keys(r.m || {}).length, s: r.seq || 0 }))
      .sort((a, b) => (a.t === b.t ? 0 : a.t === 'all' ? -1 : b.t === 'all' ? 1 : a.t === 'lv' ? -1 : 1) || (LEVELS.indexOf(a.n.replace(' 인턴', '')) - LEVELS.indexOf(b.n.replace(' 인턴', ''))) || a.n.localeCompare(b.n));
    const cfg = (await dbGet(env, '/config/comm').catch(() => null)) || {};
    const opts = {}; for (const k of AUTO_KEYS) opts[k] = ar[k] !== false && !(k.startsWith('all_') && ar.all === false);
    return { opts, labels: Object.fromEntries(ALL_ROOMS.map((r) => ['all_' + r[0], r[1] + ' 전체'])), rooms: list, open: cfg.open === true, trial: OWNER_PHONES.length + Object.keys(cfg.users || {}).length };
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
    const ph = String(me.ph);
    const rid = String(body.rid || '');
    /* 계정 · 방 조회를 동시에 (DB 왕복 하나 줄이기) */
    const seqPre = body.root ? null : seqRead(env, rid).catch(() => null);
    const [u, room] = await Promise.all([meUser(env, me), getRoom(env, rid)]);
    if (!member(room, ph)) throw new Error('이 방에 참여하고 있지 않습니다');
    if (room.t === 'notice' && !isManagerUser(ph, u)) throw new Error('전체 공지방은 경영팀 · 관리자만 쓸 수 있습니다');
    const k = ['t', 'p', 'v', 'f', 'ack', 'poll'].includes(body.k) ? body.k : 't';
    /* 확인 요청 · 투표는 방 만든 사람 · 경영팀 · 관리자만 (남발되면 아무도 안 누른다) */
    if ((k === 'ack' || k === 'poll') && !(isManagerUser(ph, u) || room.by === ph)) throw new Error('확인 요청 · 투표는 방 만든 사람 · 경영팀 · 관리자만 만들 수 있습니다');
    const x = clip(body.x, 5000).trim();
    /* 첨부: u 화면에 보일 사진(보통 화질 또는 동영상 첫 장면) · t 말풍선용 작은 사진 · o 원본 사진 · v 동영상 · f 파일 — 값은 저장소 키 */
    const keyOk = (v) => /^(g\/)?[po]\/[A-Za-z0-9_-]+\/[A-Za-z0-9._-]+$/.test(String(v || ''));
    const md = Array.isArray(body.md) ? body.md.slice(0, 30).map((m) => {
      const o = { w: m.w | 0, h: m.h | 0, sz: m.sz | 0 };
      for (const k of ['u', 't', 'o', 'v', 'f']) if (keyOk(m[k])) o[k] = String(m[k]);
      if (m.n) o.n = clip(m.n, 120);
      if (m.d) o.d = Math.round(Number(m.d) || 0);
      return o;
    }).filter((m) => m.u || m.v || m.f) : null;
    if (md && !md.length) throw new Error('첨부 파일 정보가 올바르지 않습니다');
    /* 서울 저장소 사진은 말풍선용 주소(7일)를 메시지에 같이 넣는다 — 받는 사람 앱이 서버(미국 경유 1~2초)에 다시 묻지 않고 바로 받는다(11/12) */
    if (md && env.GCS_BUCKET) {
      const d0 = new Date(); d0.setUTCHours(0, 0, 0, 0);
      await Promise.all(md.map(async (m) => { const k = m.t || m.u; if (k && k.startsWith('g/')) { m.tu = await signedUrl(env, '', k); m.te = d0.getTime() + 7 * 864e5 - 3600e3; } }));
    }
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
      seq = await nextSeq(env, rid, seqPre && seqPre.then((r) => r || seqRead(env, rid)));
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

    /* 사진 · 동영상 · 파일 목록(모아 보기) — 방 전체 메시지를 받지 않고 이것만 읽는다 */
    if (md) up[`chat/media/${rid}/${key}`] = root ? { at, by: ph, bn, md, r: root } : { at, by: ph, bn, md };

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
    if (!root) { const fx = fixLatest(env, rid, room, seq).catch(() => {}); if (ctx && ctx.waitUntil) ctx.waitUntil(fx); else await fx; }

    /* 알림 — 보낸 사람에게는 안 보낸다. 방 알림을 끈 사람에게는 @부른 경우 · 스레드 답에만 보낸다. */
    const muted = room.mute || {};
    /* 알림은 응답을 돌려준 뒤에 계산 · 발송한다 — 보내는 사람이 기다리지 않게.
       채팅은 전부 '급함(high)'으로 보낸다(11/8) — '보통'이면 아이폰이 잠금·절전 중에 모아 뒀다가 늦게 띄운다(카톡처럼 바로 오게) */
    const pushJob = (async () => {
    const quietSet = await quietPhones(env);
    /* 레벨방 · 인턴 전체: 알림 끈 디자이너도 내 담당 인턴이 쓴 글 · 내 인턴을 부른 글은 받는다 */
    const mentors = new Set();
    if (room.t === 'lv' || rid === 'all_interns') {
      if (u && u.mentorId) mentors.add(String(u.mentorId));
      const mns = Object.keys(mn);
      if (mns.length) { const us = await usersCached(env); for (const q of mns) { const qu = us[q]; if (qu && qu.mentorId) mentors.add(String(qu.mentorId)); } }
    }
    const targets = Object.keys(room.m).filter((p) => p !== ph && (root ? actFor.has(p) : (actFor.has(p) || (!muted[p] && !quietSet.has(p)) || (mentors.has(p) && !quietSet.has(p)))));
    if (targets.length) {
      const title = room.t === 'dm' ? bn : (room.t === 'me' ? '나와의 채팅' : room.n);
      const text = x ? clip(x, 120) : (k === 'p' ? '사진을 보냈습니다' : k === 'v' ? '동영상을 보냈습니다' : '파일을 보냈습니다');
      const head = k === 'ack' ? '[확인 요청] ' : k === 'poll' ? '[투표] ' : root ? '(답장) ' : '';
      const payload = { title, body: (room.t === 'dm' ? '' : bn + ': ') + head + text, url: './#comm/' + rid, tag: 'chat-' + rid };
      await pushToPhones(env, targets, payload, { urgency: 'high', topic: 'c' + rid.slice(0, 30), chat: true }).catch(() => {});
    }
    })().catch(() => {});
    if (ctx && ctx.waitUntil) ctx.waitUntil(pushJob); else await pushJob;
    /* 링크 미리보기 — 글에 주소가 있으면 그 페이지의 제목 · 설명 · 대표 사진을 뒤에서 받아 메시지에 붙인다 */
    const link = !md && k === 't' && x ? (x.match(URL_RE) || [])[0] : null;
    if (link) {
      const lpJob = unfurl(link).then((lp) => lp ? dbPut(env, `${root ? `/chat/thr/${rid}/${root}/${key}` : `/chat/msgs/${rid}/${key}`}/lp`, lp) : null).catch(() => {});
      if (ctx && ctx.waitUntil) ctx.waitUntil(lpJob); else await lpJob;
    }
    return { key, seq, at };
  }

  /* 내 목록에서만 — 상단 고정 · 나만 보는 방 이름 · 1:1 숨기기(카톡 '나가기'처럼 목록에서 지우고, 새 메시지가 오면 다시 보임) */
  async function roomPrefs(env, me, body) {
    await meUser(env, me);
    const rid = String(body.rid || ''), ph = String(me.ph);
    const room = await getRoom(env, rid);
    if (!member(room, ph)) throw new Error('이 방에 참여하고 있지 않습니다');
    const b = `chat/inbox/${ph}/${rid}`, up = {};
    if ('pin' in body) up[`${b}/pin`] = body.pin ? nowMs() : null;
    if ('nm' in body) up[`${b}/nm`] = clip(body.nm, 30).trim() || null;
    if ('hide' in body) {
      if (body.hide && room.t !== 'dm' && room.t !== 'me') throw new Error('1:1 대화만 목록에서 지울 수 있어요');
      up[`${b}/hid`] = body.hide ? (room.seq || 0) : null;
      if (body.hide) up[`${b}/pin`] = null;
    }
    if (!Object.keys(up).length) throw new Error('바꿀 내용이 없습니다');
    await dbPatch(env, '/', up);
    return {};
  }

  /* 예약 전송 — 정한 시각에 1분 타이머(scheduled)가 보낸 사람 이름으로 보낸다. 보낼 때 방 참여 · 권한을 다시 확인한다 */
  async function schedCreate(env, me, body) {
    const u = await meUser(env, me);
    const rid = String(body.rid || ''), ph = String(me.ph);
    const room = await getRoom(env, rid);
    if (!member(room, ph)) throw new Error('이 방에 참여하고 있지 않습니다');
    if (room.t === 'notice' && !isManagerUser(ph, u)) throw new Error('전체 공지방은 경영팀 · 관리자만 쓸 수 있습니다');
    const x = clip(body.x, 5000).trim();
    if (!x) throw new Error('보낼 내용을 입력해 주세요');
    const at = Math.round(Number(body.at) || 0);
    if (at < nowMs() + 50 * 1000) throw new Error('지금보다 1분 이상 뒤로 정해 주세요');
    if (at > nowMs() + 30 * 86400e3) throw new Error('30일 안으로만 예약할 수 있어요');
    const all = (await dbGet(env, '/chat/sched').catch(() => null)) || {};
    if (Object.values(all).filter((v) => v && v.ph === ph).length >= 20) throw new Error('예약은 한 사람당 20개까지예요');
    const mn = body.mn === '*' ? '*' : (Array.isArray(body.mn) ? body.mn.slice(0, 50).map(String) : []);
    const id = rid36();
    await dbPut(env, `/chat/sched/${id}`, { ph, rid, x, at, mn, made: nowMs() });
    return { id };
  }
  async function schedList(env, me, body) {
    const all = (await dbGet(env, '/chat/sched').catch(() => null)) || {};
    const rid = String(body.rid || ''), ph = String(me.ph);
    const items = Object.entries(all).filter(([, v]) => v && v.ph === ph && (!rid || v.rid === rid))
      .map(([id, v]) => ({ id, rid: v.rid, x: v.x, at: v.at })).sort((a, b) => a.at - b.at);
    return { items };
  }
  async function schedCancel(env, me, body) {
    const id = String(body.id || '');
    if (!/^[a-z0-9]{6,20}$/.test(id)) throw new Error('예약 정보가 올바르지 않습니다');
    const v = await dbGet(env, `/chat/sched/${id}`).catch(() => null);
    if (!v || v.ph !== String(me.ph)) throw new Error('이미 보냈거나 없는 예약이에요');
    await dbDelete(env, `/chat/sched/${id}`);
    return {};
  }
  async function runScheduled(env, ctx) {
    const all = (await dbGet(env, '/chat/sched').catch(() => null)) || {};
    const due = Object.entries(all).filter(([, v]) => v && v.at <= nowMs() + 20 * 1000);
    for (const [id, v] of due) {
      await dbDelete(env, `/chat/sched/${id}`);          // 먼저 지운다 — 타이머가 겹쳐도 두 번 보내지 않게
      try { await send(env, ctx, { ph: v.ph }, { rid: v.rid, k: 't', x: v.x, mn: v.mn }); }
      catch (e) { await pushToPhones(env, [v.ph], { title: '예약 메시지를 보내지 못했어요', body: clip(e.message, 100), url: './#comm/' + v.rid, tag: 'sched-' + id }).catch(() => {}); }
    }
    return due.length;
  }

  /* ═══ 팝업 공지 ═══
     게시판은 직접 들어가야 봐서 놓치는 일이 많아, 방에 공지를 올리면 그 방 사람 모두에게 앱을 열 때 팝업으로 먼저 띄운다.
     '확인했습니다'(팝업 · 공지 보기 · 대화 속 카드)를 눌러야 확인(ok)으로 기록되고 이후 안 띄운다. 확인한 사람은 메시지 nk:{폰:1} 에도 남겨
     카드에 '확인 N / M'을 실시간으로 보인다(확인 요청과 같은 방식). day · week 는 받아만 둠.
     쓰기: 경영팀 · 관리자 · 스탭장 · 디자이너(교육자 포함). 전체 공지방은 지금처럼 경영팀 · 관리자만. */
  const canPostNotice = (ph, u) => isManagerUser(ph, u) || isHqUser(ph, u) ||
    (u && (['디자이너', '스탭장'].includes(u.role) || u.academyRole === '교육자' || (Array.isArray(u.roles) && u.roles.some((r) => r === '디자이너' || r === '스탭장'))));
  async function noticeCreate(env, ctx, me, body) {
    const u = await meUser(env, me);
    const ph = String(me.ph), rid = String(body.rid || '');
    const room = await getRoom(env, rid);
    if (!member(room, ph)) throw new Error('이 방에 참여하고 있지 않습니다');
    if (!canPostNotice(ph, u)) throw new Error('공지는 디자이너 · 스탭장 · 경영팀만 올릴 수 있어요');
    if (room.t === 'notice' && !isManagerUser(ph, u)) throw new Error('전체 공지방은 경영팀 · 관리자만 쓸 수 있습니다');
    const t = clip(body.t, 60).trim(), x = clip(body.x, 3000).trim();
    if (!t) throw new Error('제목을 입력해 주세요');
    const keyOk = (v) => /^(g\/)?p\/[A-Za-z0-9_-]+\/[A-Za-z0-9._-]+$/.test(String(v || ''));
    const md = (Array.isArray(body.md) ? body.md : []).slice(0, 5).filter((m) => m && keyOk(m.u)).map((m) => ({ u: String(m.u), w: m.w | 0, h: m.h | 0 }));
    const tag = await deps.roomTag(rid);
    if (md.some((m) => !m.u.startsWith(`p/${tag}/`) && !m.u.startsWith(`g/p/${tag}/`))) throw new Error('사진 정보가 올바르지 않습니다');
    const nid = 'n' + rid36();
    const sent = await send(env, ctx, me, { rid, k: 't', x: `[공지] ${t}${x ? '\n' + clip(x, 300) : ''}` });
    const doc = { rid, t, x, by: ph, bn: nameOf(u), at: nowMs(), key: sent.key };
    if (md.length) doc.md = md;
    await dbPatch(env, '/', {
      [`chat/notices/${nid}`]: doc,
      [`chat/msgs/${rid}/${sent.key}/nt`]: nid,
      [`chat/rooms/${rid}/pin`]: { key: sent.key, x: '[공지] ' + t, bn: nameOf(u), at: nowMs(), by: nameOf(u), nt: nid },
    });
    return { nid, key: sent.key };
  }
  async function noticeSigned(env, base, n) {
    const out = { ...n };
    if (n.md) out.md = await Promise.all(n.md.map(async (m) => ({ ...m, url: await signedUrl(env, base, m.u) })));
    return out;
  }
  /* 지금 나에게 띄울 공지 — 내가 들어가 있는 방 · 아직 안 내린 것 · 내가 쓴 것 아님 · 확인 안 했고 '안 보기' 기간도 아님 */
  async function noticePending(env, me, base) {
    await meUser(env, me);
    const ph = String(me.ph);
    const [all, inbox] = await Promise.all([dbGet(env, '/chat/notices').catch(() => null), dbGet(env, '/chat/inbox/' + ph).catch(() => null)]);
    const live = Object.entries(all || {}).filter(([, n]) => n && !n.end && n.by !== ph && inbox && inbox[n.rid] && n.at > nowMs() - 60 * 86400e3);
    const out = [];
    for (const [nid, n] of live) {
      const seen = await dbGet(env, `/chat/nseen/${nid}/${ph}`).catch(() => null);
      if (seen && (seen.m === 'ok' || (seen.until || 0) > nowMs())) continue;
      out.push({ nid, ...(await noticeSigned(env, base, n)) });
    }
    out.sort((a, b) => a.at - b.at);
    return { items: out.slice(0, 10) };
  }
  async function noticeGet(env, me, body, base) {
    await meUser(env, me);
    const nid = String(body.nid || '');
    if (!/^n[a-z0-9]{6,20}$/.test(nid)) throw new Error('공지 정보가 올바르지 않습니다');
    const n = await dbGet(env, `/chat/notices/${nid}`);
    if (!n) throw new Error('없는 공지예요');
    const room = await getRoom(env, n.rid);
    if (!member(room, String(me.ph))) throw new Error('이 방에 참여하고 있지 않습니다');
    const seen = await dbGet(env, `/chat/nseen/${nid}/${me.ph}`).catch(() => null);
    return { item: { nid, ...(await noticeSigned(env, base, n)), mine: seen ? seen.m : null } };
  }
  async function noticeSeen(env, me, body) {
    await meUser(env, me);
    const nid = String(body.nid || ''), m = String(body.m || '');
    if (!/^n[a-z0-9]{6,20}$/.test(nid) || !['ok', 'day', 'week'].includes(m)) throw new Error('잘못된 요청입니다');
    const n = await dbGet(env, `/chat/notices/${nid}`);
    if (!n) throw new Error('없는 공지예요');
    /* 오늘 하루 = 한국 시간 내일 0시까지 · 일주일 = 7일 뒤 */
    const k = kst(); const tomorrow = Date.UTC(k.getUTCFullYear(), k.getUTCMonth(), k.getUTCDate() + 1) - 9 * 3600e3;
    const until = m === 'ok' ? 0 : m === 'day' ? tomorrow : nowMs() + 7 * 86400e3;
    const up = { [`chat/nseen/${nid}/${me.ph}`]: { m, until, at: nowMs() } };
    if (m === 'ok' && n.key) up[`chat/msgs/${n.rid}/${n.key}/nk/${me.ph}`] = 1;
    await dbPatch(env, '/', up);
    return {};
  }
  async function noticeEnd(env, me, body) {
    const u = await meUser(env, me);
    const nid = String(body.nid || '');
    const n = await dbGet(env, `/chat/notices/${nid}`);
    if (!n) throw new Error('없는 공지예요');
    if (n.by !== String(me.ph) && !isManagerUser(String(me.ph), u)) throw new Error('올린 사람 · 경영팀 · 관리자만 내릴 수 있어요');
    const up = { [`chat/notices/${nid}/end`]: nowMs() };
    const room = await getRoom(env, n.rid).catch(() => null);
    if (room && room.pin && room.pin.nt === nid) up[`chat/rooms/${n.rid}/pin`] = null;
    await dbPatch(env, '/', up);
    return {};
  }
  /* 아직 확인 안 한 사람에게 다시 알림 — 올린 사람 · 경영팀 · 관리자 */
  async function noticeNudge(env, me, body) {
    const u = await meUser(env, me);
    const nid = String(body.nid || '');
    const n = await dbGet(env, `/chat/notices/${nid}`);
    if (!n) throw new Error('없는 공지예요');
    if (n.by !== String(me.ph) && !isManagerUser(String(me.ph), u)) throw new Error('올린 사람 · 경영팀 · 관리자만 다시 알릴 수 있어요');
    const room = await getRoom(env, n.rid);
    const seen = (await dbGet(env, `/chat/nseen/${nid}`).catch(() => null)) || {};
    const left = Object.keys(room.m || {}).filter((p) => p !== n.by && !(seen[p] && seen[p].m === 'ok'));
    if (left.length) await pushToPhones(env, left, { title: '[공지 확인 요청] ' + (room.t === 'dm' ? '' : room.n || ''), body: n.t, url: './#comm/' + n.rid, tag: 'notice-' + nid }, { urgency: 'high' }).catch(() => {});
    return { sent: left.length };
  }
  async function noticeReaders(env, me, body) {
    const u = await meUser(env, me);
    const nid = String(body.nid || '');
    const n = await dbGet(env, `/chat/notices/${nid}`);
    if (!n) throw new Error('없는 공지예요');
    const room = await getRoom(env, n.rid);
    if (!member(room, String(me.ph))) throw new Error('이 방에 참여하고 있지 않습니다');
    const seen = (await dbGet(env, `/chat/nseen/${nid}`).catch(() => null)) || {};
    const ok = [], later = [], none = [];
    for (const p of Object.keys(room.m || {})) { if (p === n.by) continue; const s = seen[p]; (s && s.m === 'ok' ? ok : s ? later : none).push(p); }
    return { ok, later, none, end: n.end || 0 };
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

  /* 업무 알림 방에 봇 글 올리기 — 발주 · 환불 · 가발 공동구매 · 내수 알림(예전엔 네이버웍스 봇).
     보내는 사람은 'bot'. 방이 아직 없으면(처음) 자동방 맞추기를 한 번 돌려 만든다. 알림은 일반 채팅과 같은 규칙(방 알림 끈 사람 · 휴무자 빼고) */
  async function botPost(env, ctx, text) {
    const rid = 'ops';
    const x = clip(text, 3000).trim();
    if (!x) return { skipped: true };
    let room = await dbGet(env, '/chat/rooms/ops').catch(() => null);
    if (!room) { await syncAuto(env, true); room = await dbGet(env, '/chat/rooms/ops').catch(() => null); }
    if (!room || !room.m || !Object.keys(room.m).length) return { skipped: true };
    const seq = await nextSeq(env, rid);
    const at = nowMs(), key = pad(seq), bn = '업무 알림';
    const preview = clip(x.split('\n')[0], 80);
    const up = { [`chat/msgs/${rid}/${key}`]: { s: seq, by: 'bot', bn, at, k: 't', x }, [`chat/rooms/${rid}/last`]: { x: preview, by: 'bot', bn, at, k: 't' } };
    for (const p of Object.keys(room.m)) { const b = `chat/inbox/${p}/${rid}`; up[`${b}/s`] = seq; up[`${b}/at`] = at; up[`${b}/x`] = preview; up[`${b}/bn`] = bn; }
    await dbPatch(env, '/', up);
    await fixLatest(env, rid, room, seq).catch(() => {});
    const muted = room.mute || {};
    const job = (async () => {
      const quietSet = await quietPhones(env);
      const targets = Object.keys(room.m).filter((p) => !muted[p] && !quietSet.has(p));
      if (targets.length) await pushToPhones(env, targets, { title: '업무 알림', body: clip(x.replace(/\n+/g, ' · '), 140), url: './#comm/' + rid, tag: 'chat-' + rid }, { urgency: 'high', topic: 'c' + rid, chat: true }).catch(() => {});
    })().catch(() => {});
    if (ctx && ctx.waitUntil) ctx.waitUntil(job); else await job;
    return { key };
  }

  async function sysMsg(env, rid, text) {
    const seq = await nextSeq(env, rid);
    const room = await getRoom(env, rid);
    const at = nowMs();
    const up = { [`chat/msgs/${rid}/${pad(seq)}`]: { s: seq, by: 'system', bn: '', at, k: 'sys', x: text }, [`chat/rooms/${rid}/last`]: { x: text, by: 'system', bn: '', at, k: 'sys' } };
    for (const p of Object.keys(room.m || {})) { const b = `chat/inbox/${p}/${rid}`; up[`${b}/s`] = seq; up[`${b}/at`] = at; up[`${b}/x`] = text; up[`${b}/bn`] = ''; }
    await dbPatch(env, '/', up);
    await fixLatest(env, rid, room, seq).catch(() => {});
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
      if (m.md) await dbPatch(env, '/', { [`chat/media/${rid}/${key}`]: null });
      if (!root) await fixPreview(env, rid, room, m, '가려진 메시지입니다');
      return {};
    }
    /* 11/13 사용자 결정: 고치기 · 모두에게서 삭제(회수)는 내 메시지, 보낸 지 5분 안에만.
       경영팀은 회수를 언제든 · 다른 사람 메시지도(고치기는 경영팀도 내 것 5분 안만) */
    const old = nowMs() - (m.at || 0) > 5 * 60e3;
    if (del) {
      if (!isHqUser(String(me.ph), u)) {
        if (!mine) throw new Error('내가 보낸 메시지만 지울 수 있습니다');
        if (old) throw new Error('보낸 지 5분이 지나서 모두에게서 삭제할 수 없어요 (내 화면에서만 지우기는 돼요)');
      }
    } else {
      if (!mine) throw new Error('내가 보낸 메시지만 고칠 수 있습니다');
      if (old) throw new Error('보낸 지 5분이 지나서 고칠 수 없어요');
    }
    if (del) {
      await dbPatch(env, path, { x: null, md: null, del: 1 });
      if (m.md) await dbPatch(env, '/', { [`chat/media/${rid}/${key}`]: null });
      if (!root) await fixPreview(env, rid, room, m, '삭제된 메시지입니다');
    } else {
      const x = clip(body.x, 5000).trim();
      if (!x) throw new Error('내용을 입력해 주세요');
      await dbPatch(env, path, { x, ed: nowMs(), lp: null });
      if (!root) await fixPreview(env, rid, room, m, clip(x, 80));
    }
    return {};
  }

  /* 목록 미리보기 순서 바로잡기(11/13, '읽기 전 미리보기에 최근 글이 안 뜰 때가 있다').
     같은 방에 거의 동시에 온 두 메시지는 번호(seq)는 차례대로 받지만 저장(dbPatch)은 누가 먼저 끝날지 모른다.
     먼저 보낸 글의 저장이 늦게 끝나면 모두의 목록(inbox) 미리보기 · 마지막 번호(s)가 바로 전 글로 덮였다.
     → 저장한 뒤 그 방의 진짜 마지막 메시지를 한 번 읽어, 내 글보다 최근 글이 이미 있으면 목록을 그 글로 다시 맞춘다.
        (최근 글의 저장이 아직이면 그 저장이 나중에 끝나며 스스로 맞춘다) */
  const previewOf = (m) => m.del ? '삭제된 메시지입니다' : (m.k === 'ack' ? '[확인 요청] ' : m.k === 'poll' ? '[투표] ' : '') + (m.x ? clip(m.x, 80) : (m.k === 'p' ? '사진' : m.k === 'v' ? '동영상' : m.k === 'f' ? '파일' : ''));
  async function fixLatest(env, rid, room, seq) {
    const t = await accessToken(env);
    const r = await fetch(`${env.FIREBASE_URL}/chat/msgs/${rid}.json?orderBy=%22%24key%22&limitToLast=1&access_token=${t}`);
    if (!r.ok) return;
    const d = (await r.json()) || {};
    const k = Object.keys(d)[0], m = k && d[k];
    if (!m || !m.s || m.s <= seq) return;
    const x = previewOf(m), up = { [`chat/rooms/${rid}/last`]: { x, by: m.by || '', bn: m.bn || '', at: m.at || nowMs(), k: m.k || 't' } };
    for (const p of Object.keys(room.m || {})) { const b = `chat/inbox/${p}/${rid}`; up[`${b}/s`] = m.s; up[`${b}/at`] = m.at || nowMs(); up[`${b}/x`] = x; up[`${b}/bn`] = m.bn || ''; }
    await dbPatch(env, '/', up);
  }

  /* 방 목록 미리보기: 지우거나 가리거나 고친 메시지가 그 방의 마지막 메시지면 모두의 목록 문구도 바꾼다
     (예전엔 메시지만 지워지고 목록에는 지운 글이 그대로 보였다 — 10/25 사용자 신고) */
  async function fixPreview(env, rid, room, m, text) {
    if (!m || !m.s || (room.seq || 0) !== m.s) return;
    const up = { [`chat/rooms/${rid}/last/x`]: text };
    for (const p of Object.keys(room.m || {})) up[`chat/inbox/${p}/${rid}/x`] = text;
    await dbPatch(env, '/', up);
  }

  /* 한 번만: 이미 지워졌거나 가려진 마지막 메시지가 목록에 그대로 보이는 방을 고친다(경영팀 · 관리자) */
  async function fixAllPreviews(env, me) {
    const u = await meUser(env, me);
    if (!isManagerUser(String(me.ph), u)) throw new Error('경영팀 · 관리자만 할 수 있습니다');
    const rooms = (await dbGet(env, '/chat/rooms').catch(() => null)) || {};
    let fixed = 0;
    for (const [rid, room] of Object.entries(rooms)) {
      if (!room || !room.seq) continue;
      const m = await dbGet(env, `/chat/msgs/${rid}/${pad(room.seq)}`).catch(() => null);
      if (m && (m.del || m.hid)) { await fixPreview(env, rid, room, m, m.del ? '삭제된 메시지입니다' : '가려진 메시지입니다'); fixed++; }
    }
    return { rooms: Object.keys(rooms).length, fixed };
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
    /* hide: 알림에 내용을 보이지 않음(카톡 '메시지 미리보기 끄기') — pushToPhones 가 이 사람에게는 'DM · 새 메시지가 있어요'로 보낸다 */
    const v = { quiet: body.quiet ? 1 : null, only: body.only ? 1 : null, hide: body.hide ? 1 : null };
    await dbPut(env, `/chat/prefs/${me.ph}`, (v.quiet || v.only || v.hide) ? v : null);
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

  /* 전달 — 다른 방(여러 방 한 번에, 최대 20)으로 복사. 사진·동영상은 그 방 저장 위치로 파일도 복사한다(방마다 열람 권한이 다르므로).
     only: 메시지 안 몇 번째 사진만(사진 보기 화면에서 한 장 전달) — 이때는 글은 빼고 사진만. root: 스레드 답장 안의 사진 */
  async function forward(env, ctx, me, body) {
    const rid = String(body.rid || ''), key = String(body.key || ''), root = body.root ? String(body.root) : '';
    const tos = [...new Set((Array.isArray(body.to) ? body.to : [body.to]).map((t) => String(t || '')).filter(Boolean))].slice(0, 20);
    if (!tos.length) throw new Error('보낼 방을 골라 주세요');
    const room = await getRoom(env, rid);
    if (!member(room, String(me.ph))) throw new Error('이 방에 참여하고 있지 않습니다');
    const m = root ? await dbGet(env, `/chat/thr/${rid}/${root}/${key}`) : await msgOf(env, rid, key);
    if (!m) throw new Error('메시지를 찾지 못했습니다');
    if (m.del || m.hid) throw new Error('지워진 메시지는 전달할 수 없습니다');
    const only = Array.isArray(body.only) ? body.only.map((i) => i | 0) : null;
    const srcMd = (m.md || []).filter((it, i) => it && (!only || only.includes(i)));
    if (only && !srcMd.length) throw new Error('전달할 사진을 찾지 못했습니다');
    const x = only ? '' : (m.x || '');
    let ok = 0; const fail = [];
    for (const to of tos) {
      try {
        let md = null;
        if (srcMd.length) {
          const toRoom = await getRoom(env, to);
          if (!member(toRoom, String(me.ph))) throw new Error('보낼 방에 참여하고 있지 않습니다');
          const tag = await deps.roomTag(to);
          md = [];
          for (const it of srcMd) {
            const o = { w: it.w, h: it.h, sz: it.sz, n: it.n, d: it.d };
            for (const f of ['u', 't', 'o', 'v', 'f']) if (it[f]) {
              /* 구글 서울 저장소 사진은 버킷 안에서 복사 (gcs.js) */
              if (it[f].startsWith('g/')) {
                const nk = it[f].replace(/^g\/([po])\/[^/]+\//, `g/$1/${tag}/`).replace(/(\.[A-Za-z0-9]+)$/, '_f' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5) + '$1');
                if (await deps.gcsCopy(env, it[f], nk)) o[f] = nk;
                continue;
              }
              const src = await env.CHAT_MEDIA.get(it[f]);
              if (!src) continue;
              const nk = it[f].replace(/^([po])\/[^/]+\//, `$1/${tag}/`).replace(/(\.[A-Za-z0-9]+)$/, '_f' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5) + '$1');
              /* R2 에 넣을 때는 길이를 알아야 해서 크기를 붙여 흘려 보낸다(큰 동영상도 메모리에 다 올리지 않음) */
              await env.CHAT_MEDIA.put(nk, src.body.pipeThrough(new FixedLengthStream(src.size)), { httpMetadata: src.httpMetadata });
              o[f] = nk;
            }
            if (o.u || o.v || o.f) md.push(o);
          }
          if (!md.length) throw new Error('보관 기간(90일)이 지난 파일이라 전달할 수 없습니다');
        }
        const k = md ? (md.some((it) => it.v) ? 'v' : md.some((it) => it.f) ? 'f' : 'p') : 't';
        await send(env, ctx, me, { rid: to, k, x, md, fw: m.bn });
        ok++;
      } catch (e) { fail.push({ to, error: e.message || String(e) }); }
    }
    if (!ok) throw new Error(fail[0] ? fail[0].error : '전달하지 못했습니다');
    return { n: ok, fail };
  }

  /* 모아 보기 — 방의 사진 · 동영상 · 파일 목록. /chat/media/{방} 에 쌓아 두고(보낼 때마다 send 가 추가, 지우면 뺌),
     이 기능 전에 보낸 것은 처음 열 때 한 번만 메시지에서 뽑아 채운다(_b 표시). */
  async function gallery(env, me, body) {
    const rid = String(body.rid || '');
    const room = await getRoom(env, rid);
    if (!member(room, String(me.ph))) throw new Error('이 방에 참여하고 있지 않습니다');
    let idx = (await dbGet(env, `/chat/media/${rid}`)) || {};
    if (!idx._b) {
      const [msgs, thr] = await Promise.all([dbGet(env, `/chat/msgs/${rid}`), dbGet(env, `/chat/thr/${rid}`)]);
      const up = { [`chat/media/${rid}/_b`]: 1 };
      const add = (k, m, r) => { if (m && m.md && m.md.length && !m.del && !m.hid && !idx[k]) { const e = r ? { at: m.at, by: m.by, bn: m.bn, md: m.md, r } : { at: m.at, by: m.by, bn: m.bn, md: m.md }; up[`chat/media/${rid}/${k}`] = e; idx[k] = e; } };
      for (const [k, m] of Object.entries(msgs || {})) add(k, m, '');
      for (const [r, list] of Object.entries(thr || {})) for (const [k, m] of Object.entries(list || {})) add(k, m, r);
      await dbPatch(env, '/', up);
    }
    const items = Object.entries(idx).filter(([k, v]) => k !== '_b' && v && v.md).map(([k, v]) => ({ k, ...v })).sort((a, b) => (b.at || 0) - (a.at || 0));
    return { items };
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
    const d = (await deps.relayCall(env, '/ai/chat-summary', { room: room.n || '', me: nameOf(u), messages: list }, { ph: me.ph, nm: nameOf(u), x: (room.n || '단체방') + ' · ' + list.length + '개' })).body;
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
        case '/chat/auto-config': out = await autoConfig(env, me, body); break;
        case '/chat/send': out = await send(env, ctx, me, body); break;
        case '/chat/dm': out = await ensureDm(env, me, body.to); break;
        case '/chat/group': out = await createGroup(env, me, body); break;
        case '/chat/invite': out = await invite(env, me, body); break;
        case '/chat/kick': out = await kick(env, me, body); break;
        case '/chat/leave': out = await leave(env, me, body); break;
        case '/chat/rename': out = await rename(env, me, body); break;
        case '/chat/mute': out = await mute(env, me, body); break;
        case '/chat/roomprefs': out = await roomPrefs(env, me, body); break;
        case '/chat/sched': out = await schedCreate(env, me, body); break;
        case '/chat/sched/list': out = await schedList(env, me, body); break;
        case '/chat/sched/cancel': out = await schedCancel(env, me, body); break;
        case '/chat/notice/create': out = await noticeCreate(env, ctx, me, body); break;
        case '/chat/notice/pending': out = await noticePending(env, me, new URL(request.url).origin); break;
        case '/chat/notice/get': out = await noticeGet(env, me, body, new URL(request.url).origin); break;
        case '/chat/notice/seen': out = await noticeSeen(env, me, body); break;
        case '/chat/notice/end': out = await noticeEnd(env, me, body); break;
        case '/chat/notice/readers': out = await noticeReaders(env, me, body); break;
        case '/chat/notice/nudge': out = await noticeNudge(env, me, body); break;
        case '/chat/edit': out = await editOrDelete(env, me, body, false); break;
        case '/chat/delete': out = await editOrDelete(env, me, body, true); break;
        case '/chat/hide': out = await editOrDelete(env, me, body, 'hide'); break;
        case '/chat/fix-previews': out = await fixAllPreviews(env, me); break;
        case '/chat/react': out = await react(env, me, body); break;
        case '/chat/pin': out = await pinNotice(env, me, body); break;
        case '/chat/ack': out = await ack(env, me, body); break;
        case '/chat/vote': out = await vote(env, me, body); break;
        case '/chat/nudge': out = await nudge(env, me, body); break;
        case '/chat/prefs': out = await prefs(env, me, body); break;
        case '/chat/later': out = await later(env, me, body); break;
        case '/chat/remind': out = await remind(env, me, body); break;
        case '/chat/forward': out = await forward(env, ctx, me, body); break;
        case '/chat/gallery': out = await gallery(env, me, body); break;
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
  route.runScheduled = runScheduled;
  route.eligible = eligible;
  route.botPost = botPost;
  return route;
}
