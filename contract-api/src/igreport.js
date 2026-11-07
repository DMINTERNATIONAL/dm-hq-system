/* ═══ 인스타 AI 리포트 ═══
 *
 * 디자이너 · 인턴은 본인 리포트만, 경영팀은 전체 사람 것과 '전체 리포트'를 본다.
 * 그 판정을 서버에서 한다 — 앱의 화면 권한은 curl 로 우회되므로.
 *
 * 리포트는 DB 가 아니라 R2(dm-chat-media, ai/ig/ 아래)에 둔다.
 *   DB 는 staff 토큰이면 어느 경로든 읽히고(잠긴 경로를 새로 만들려면 규칙을 바꿔야 한다),
 *   R2 는 이 Worker 를 거쳐야만 읽힌다. ai/ 는 90일 자동 삭제 규칙(o/)에 안 걸린다.
 *
 * 한 주(월요일 시작, 한국 시각)에 한 번 만든다. 누가 열어 볼 때 만들고(아무도 안 보는 계정에 AI 를 쓰지 않게),
 * 같은 주에는 저장된 것을 보여 준다. 본인은 하루 지나면 다시 만들 수 있고, 경영팀은 언제든.
 *
 * 숫자는 수집기(workers/hermes-kpi)가 매일 쌓은 /storesKpi/{지점}/daily 의 인스타 숫자와
 * /igPosts/{전화번호} 의 최근 게시물(글 포함)에서 뽑는다. 조회수 · 도달 · 저장 수는 우리에게 없다.
 */

const SHOPS = ['flagship', 'moment', 'eto'];
const SHOP_KO = { flagship: '플래그십', moment: '모먼트', eto: '에토' };
const BRANCH_TO_SHOP = { '플래그십점': 'flagship', '모먼트점': 'moment', '합정점': 'eto' };
const HQ_GRADES = ['경영팀', '관리자', '스탭장'];
const DAY = 86400000;

function kstYmd(ms) { return new Date(ms + 9 * 3600000).toISOString().slice(0, 10); }
/* 이번 주 월요일(한국 시각) */
function weekKey(ms) {
  const d = new Date(ms + 9 * 3600000);
  const back = (d.getUTCDay() + 6) % 7;
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - back)).toISOString().slice(0, 10);
}
function prevWeekKey(wk) { return new Date(Date.parse(wk + 'T00:00:00Z') - 7 * DAY).toISOString().slice(0, 10); }
const WD = ['일', '월', '화', '수', '목', '금', '토'];
function whenKo(ts) {
  const t = Date.parse(ts); if (!Number.isFinite(t)) return '';
  const d = new Date(t + 9 * 3600000);
  return `${d.getUTCMonth() + 1}/${d.getUTCDate()}(${WD[d.getUTCDay()]}) ${d.getUTCHours()}시`;
}
const n0 = (v) => (Number.isFinite(+v) ? +v : 0);
const isIntern = (s) => (s && (s.academyRole === '인턴' || s.role === '인턴'));

export function makeIgReport(deps) {
  const { dbGet, accessToken, relayCall } = deps;

  async function isHq(env, me) {
    if (me && (me.role === 'owner' || me.admin === true)) return true;
    const u = await dbGet(env, '/users/' + encodeURIComponent(String(me.ph))).catch(() => null);
    if (!u || u.status === '퇴사') return false;
    /* 앱 KPI 화면의 '본사 비교' 판정과 같다 — 디자이너 · 인턴 직급이면 등급이 높아도 개인 화면만 */
    if (u.role === '디자이너' || u.role === '인턴' || u.academyRole === '인턴') return false;
    if (u.systemGrade) return HQ_GRADES.indexOf(u.systemGrade) >= 0;
    return u.role === '경영팀' || u.role === '본사경영팀' || u.role === '매니저' || u.brand === 'DM INTERNATIONAL';
  }

  /* /storesKpi/{지점}/daily 를 from 날짜부터만 받는다 (전 기간을 받으면 수 MB) */
  async function kpiDays(env, shop, from) {
    const t = await accessToken(env);
    const q = `orderBy=${encodeURIComponent('"$key"')}&startAt=${encodeURIComponent('"' + from + '"')}`;
    const r = await fetch(`${env.FIREBASE_URL}/storesKpi/${shop}/daily.json?${q}&access_token=${t}`, { cache: 'no-store' });
    if (!r.ok) throw new Error('DB 읽기 실패 ' + r.status);
    return (await r.json()) || {};
  }

  /* 전 지점의 최근 29일 인스타 숫자 → 사람(전화번호)별 { ymd: 숫자 } */
  async function loadAll(env) {
    const from = kstYmd(Date.now() - 29 * DAY);
    const by = {};
    for (const shop of SHOPS) {
      const days = await kpiDays(env, shop, from).catch(() => ({}));
      for (const ymd of Object.keys(days).sort()) {
        const sns = (days[ymd] && days[ymd].sns) || {};
        for (const nm of Object.keys(sns)) {
          const s = sns[nm]; if (!s || typeof s !== 'object') continue;
          const ph = String(s.phone || ''); if (!ph) continue;
          const p = by[ph] || (by[ph] = { ph, name: nm, shop, days: {} });
          p.name = nm; p.shop = shop; p.days[ymd] = s;
        }
      }
    }
    return by;
  }
  /* ymd 이하 가장 가까운 날의 숫자 */
  function at(p, ymd) {
    const ks = Object.keys(p.days).filter((k) => k <= ymd).sort();
    return ks.length ? p.days[ks[ks.length - 1]] : null;
  }
  function latestYmd(p) { const ks = Object.keys(p.days).sort(); return ks[ks.length - 1]; }
  function summary(p) {
    const ly = latestYmd(p); const s = p.days[ly] || {};
    const d7 = at(p, kstYmd(Date.parse(ly + 'T12:00:00Z') - 7 * DAY));
    const d28 = at(p, kstYmd(Date.parse(ly + 'T12:00:00Z') - 28 * DAY));
    const lastPost = Array.isArray(s.recent_posts) && s.recent_posts[0] ? s.recent_posts[0].ts : '';
    return {
      name: p.name, shop: p.shop, intern: isIntern(s), ymd: ly,
      followers: n0(s.followers), f7: d7 && d7 !== s ? n0(s.followers) - n0(d7.followers) : null,
      f28: d28 && d28 !== s ? n0(s.followers) - n0(d28.followers) : null,
      up7: n0(s.uploads_7d), upPrev7: d7 && d7 !== s ? n0(d7.uploads_7d) : null,
      upMonth: n0(s.uploads_thismonth), media: n0(s.media_count),
      likes: n0(s.avg_likes), cmts: n0(s.avg_comments), eng: n0(s.engagement_rate),
      reels: n0(s.reels_count), feed: n0(s.feed_count),
      reelsL: n0(s.reels_avg_likes), feedL: n0(s.feed_avg_likes), lastPost,
    };
  }
  function avgOf(list, k) { const v = list.map((x) => x[k]).filter((x) => x != null); return v.length ? v.reduce((a, b) => a + b, 0) / v.length : 0; }
  const f1 = (v) => (Math.round(v * 10) / 10).toLocaleString('ko-KR');
  const sg = (v) => (v == null ? '모름' : (v > 0 ? '+' : '') + v.toLocaleString('ko-KR'));

  async function personFacts(env, ph, all) {
    const p = all[ph];
    const u = await dbGet(env, '/users/' + encodeURIComponent(ph)).catch(() => null) || {};
    const posts = await dbGet(env, '/igPosts/' + encodeURIComponent(ph)).catch(() => null);
    if (!p && !posts) return null;
    const me = p ? summary(p) : null;
    const peers = Object.values(all).map(summary).filter((x) => me && x.intern === me.intern);
    const role = me ? (me.intern ? '인턴' : '디자이너') : (u.role || '');
    const L = [];
    L.push(`이름: ${(p && p.name) || u.nick || u.name || ''} (${role}, ${SHOP_KO[(p && p.shop) || BRANCH_TO_SHOP[u.branch]] || ''}점)`);
    if (posts && posts.username) L.push(`인스타: @${posts.username}`);
    L.push(`오늘: ${kstYmd(Date.now())}`);
    if (me) {
      L.push('', '[숫자 — 최근 수집일 ' + me.ymd + ']');
      L.push(`팔로워 ${me.followers.toLocaleString('ko-KR')}명 (7일 ${sg(me.f7)}, 28일 ${sg(me.f28)})`);
      L.push(`최근 7일 게시 ${me.up7}개 (그 전 7일 ${me.upPrev7 == null ? '모름' : me.upPrev7 + '개'}) · 이번 달 게시 ${me.upMonth}개 · 전체 게시물 ${me.media}개`);
      L.push(`게시물당 평균 좋아요 ${f1(me.likes)} · 댓글 ${f1(me.cmts)} · 참여율 ${f1(me.eng)}% (참여율 = 평균 좋아요+댓글 ÷ 팔로워)`);
      L.push(`최근 게시물 중 릴스 ${me.reels}개(평균 좋아요 ${f1(me.reelsL)}) · 피드 ${me.feed}개(평균 좋아요 ${f1(me.feedL)})`);
      if (peers.length > 1) {
        L.push('', `[비교 — 회사 전체 ${role} ${peers.length}명 평균]`);
        L.push(`최근 7일 게시 ${f1(avgOf(peers, 'up7'))}개 · 평균 좋아요 ${f1(avgOf(peers, 'likes'))} · 참여율 ${f1(avgOf(peers, 'eng'))}% · 7일 팔로워 ${sg(Math.round(avgOf(peers, 'f7')))}`);
      }
    }
    const list = (posts && Array.isArray(posts.posts)) ? posts.posts : [];
    if (list.length) {
      L.push('', `[최근 게시물 ${list.length}개 — 최신순 (좋아요 수는 오래된 글일수록 많이 쌓여 있음)]`);
      list.forEach((x, i) => {
        L.push(`${i + 1}. ${whenKo(x.ts)} ${x.t} · 좋아요 ${n0(x.l)} · 댓글 ${n0(x.c)}` + (x.cap ? ` · 글: ${String(x.cap).slice(0, 200)}` : ' · 글 없음'));
      });
    } else {
      L.push('', '[게시물 글은 아직 수집 전이라 없음 — 숫자로만 판단]');
    }
    return L.join('\n');
  }

  function teamFacts(all) {
    const rows = Object.values(all).map(summary).filter((x) => x.ymd >= kstYmd(Date.now() - 4 * DAY));
    if (!rows.length) return null;
    const L = [`오늘: ${kstYmd(Date.now())}`, `개인 인스타 계정 ${rows.length}개 (디자이너 ${rows.filter((x) => !x.intern).length} · 인턴 ${rows.filter((x) => x.intern).length})`];
    for (const grp of [false, true]) {
      const g = rows.filter((x) => x.intern === grp).sort((a, b) => b.followers - a.followers);
      if (!g.length) continue;
      L.push('', `[${grp ? '인턴' : '디자이너'} — 평균: 7일 게시 ${f1(avgOf(g, 'up7'))}개 · 평균 좋아요 ${f1(avgOf(g, 'likes'))} · 참여율 ${f1(avgOf(g, 'eng'))}%]`);
      L.push('이름 | 지점 | 팔로워 | 7일 증감 | 최근7일 게시 | 그전7일 게시 | 평균 좋아요 | 평균 댓글 | 참여율 | 릴스/피드 | 마지막 게시');
      g.forEach((x) => L.push([x.name, SHOP_KO[x.shop], x.followers, sg(x.f7), x.up7, x.upPrev7 == null ? '모름' : x.upPrev7, f1(x.likes), f1(x.cmts), f1(x.eng) + '%', `${x.reels}/${x.feed}`, x.lastPost ? whenKo(x.lastPost) : '모름'].join(' | ')));
    }
    return L.join('\n');
  }

  const rKey = (wk, id) => `ai/ig/${wk}/${id}.json`;
  async function rGet(env, key) { const o = await env.CHAT_MEDIA.get(key); return o ? o.json() : null; }
  async function rPut(env, key, v) { await env.CHAT_MEDIA.put(key, JSON.stringify(v), { httpMetadata: { contentType: 'application/json' } }); }
  const making = new Map();   // 같은 리포트를 동시에 두 번 만들지 않게 (같은 Worker 안에서만)

  /* 저장된 것(이번 주 → 없으면 지난주)을 돌려주고, make 면 없을 때 만든다 */
  async function getOrMake(env, id, b, canForce, build) {
    const wk = weekKey(Date.now());
    let cur = await rGet(env, rKey(wk, id)).catch(() => null);
    if (b.make && b.force && cur && !canForce(cur)) return { ok: false, error: '오늘 이미 새로 만들었어요. 내일 다시 만들 수 있어요' };
    const want = b.make && (!cur || b.force);
    if (!want) {
      if (cur) return { ok: true, ...cur, week: wk };
      const old = await rGet(env, rKey(prevWeekKey(wk), id)).catch(() => null);
      return old ? { ok: true, ...old, week: prevWeekKey(wk), old: true } : { ok: true, none: true, week: wk };
    }
    const lock = wk + '/' + id;
    if (making.has(lock)) return making.get(lock);
    const job = (async () => {
      const facts = await build();
      if (!facts) return { ok: false, error: '아직 수집된 인스타 데이터가 없어요' };
      const r = await relayCall(env, '/ai/ig-report', { mode: id === '_team' ? 'team' : 'person', facts });
      if (!r.body || !r.body.ok) return { ok: false, error: (r.body && r.body.error) || 'AI 리포트를 만들지 못했어요' };
      const rec = { report: r.body.report, at: Date.now() };
      await rPut(env, rKey(wk, id), rec);
      return { ok: true, ...rec, week: wk };
    })().finally(() => making.delete(lock));
    making.set(lock, job);
    return job;
  }

  return async function route(path, request, env, ctx, me, json, origin) {
    if (!path.startsWith('/ig/')) return null;
    if (request.method !== 'POST') return json({ ok: false, error: 'POST 만 됩니다' }, 405, origin);
    const b = await request.json().catch(() => ({}));
    const hq = await isHq(env, me);

    /* 한 사람 리포트 — 본인 것, 또는 경영팀이 고른 사람 */
    if (path === '/ig/report') {
      const ph = String(b.ph || me.ph || '');
      if (!/^[0-9]{8,12}$/.test(ph)) return json({ ok: false, error: '대상이 올바르지 않습니다' }, 400, origin);
      if (ph !== String(me.ph) && !hq) return json({ ok: false, error: '본인 리포트만 볼 수 있어요' }, 403, origin);
      const canForce = (cur) => hq || Date.now() - (+cur.at || 0) > DAY;
      const out = await getOrMake(env, ph, b, canForce, async () => personFacts(env, ph, await loadAll(env)));
      return json(out, out.ok ? 200 : 400, origin);
    }

    /* 경영팀 전체 리포트 */
    if (path === '/ig/team') {
      if (!hq) return json({ ok: false, error: '경영팀만 볼 수 있어요' }, 403, origin);
      const out = await getOrMake(env, '_team', b, () => true, async () => teamFacts(await loadAll(env)));
      return json(out, out.ok ? 200 : 400, origin);
    }
    return json({ ok: false, error: '없는 기능입니다' }, 404, origin);
  };
}

/* 시험용 */
export const _t = { weekKey, prevWeekKey, whenKo };
