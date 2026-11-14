/**
 * 해외 손님 예약 요청 (2026-11-14, 사용자: '보통 예약 문의는 외국인이 할 거고, 네이버 가입 절차가 너무 복잡해서').
 *
 * 공식 사이트 'Book a visit' 양식(영 · 중 · 일 · 한) → 사이트 서버가 POST /public/booking (X-Site-Key, X-Client-IP)
 *   → 저장 + 손님에게 '요청 받았어요' 메일(손님 언어) + 경영팀 · 그 지점 관리자에게 폰 알림(채팅방이 아니라 앱 '해외 예약' 메뉴로, 사용자 결정)
 * 본사 앱 '해외 예약' 화면(경영팀 · 관리자):
 *   POST /booking/list                       → 요청 목록(최근 것 먼저)
 *   POST /booking/update { id, status?, memo?, conf?, mail? }  — mail:'confirm' 이면 확정 메일, 'decline' 이면 정중한 거절 메일
 *   POST /booking/delete { id }
 * 핸드SOS 자동 등록은 하지 않는다(공식 연결이 없고 예약 겹침 위험) — 직원이 핸드SOS 를 보고 확정하면 손님 연락만 자동.
 *
 * 저장: 잠긴 /authSecrets/__book/{id} (손님 이름 · 연락처 = 개인정보 — 직원 토큰으로 DB 를 직접 읽어도 안 보이게, 서버만)
 * 파기: 마지막으로 바뀐 지 1년 지나면 목록을 열 때 지운다.
 */

const LANGS = ['en', 'zh', 'ja', 'ko'];
const BRANCHES = { flagship: { ko: '플래그십', en: 'Flagship', zh: '旗舰店', ja: 'フラッグシップ' }, moment: { ko: '모먼트', en: 'Moment', zh: 'Moment 店', ja: 'モーメント' }, any: { ko: '아무 곳', en: 'Either branch', zh: '任意门店', ja: 'どちらでも' } };
const STATUSES = ['new', 'contacted', 'confirmed', 'declined', 'canceled'];
const SLOTS = ['any', 'morning', 'afternoon', 'evening'];
const CH = ['wa', 'ig', 'line', 'wechat', 'kakao'];
const KEEP_MS = 365 * 24 * 3600e3;
const BASE = '/authSecrets/__book';
const ID_RE = /^b[a-z0-9]{8,24}$/;
const clip = (s, n) => String(s == null ? '' : s).replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, n);
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const id36 = () => 'b' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

/* ── 손님 메일(손님 언어) ── */
const T = {
  en: { got: 'We received your booking request', hi: (n) => `Hi ${n},`, gotB: 'Thank you for choosing DAY:MEAN. We have received your request and will get back to you within 24 hours to confirm your appointment.', yours: 'Your request', conf: 'Your appointment is confirmed', confB: 'We look forward to seeing you. Here are the details:', dec: 'About your booking request', decB: 'Thank you for your request. Unfortunately we could not find an available time for the dates you chose. Please reply to this email or send another request with different dates — we would love to welcome you.', when: 'Date & time', where: 'Branch', who: 'Designer', what: 'Service', map: 'Directions', note: 'Message from us', foot: 'If you need to change or cancel, simply reply to this email.' },
  zh: { got: '我们已收到您的预约申请', hi: (n) => `${n} 您好，`, gotB: '感谢您选择 DAY:MEAN。我们已收到您的预约申请，将在 24 小时内与您联系确认。', yours: '您的申请', conf: '您的预约已确认', confB: '期待您的光临，预约详情如下：', dec: '关于您的预约申请', decB: '感谢您的申请。很抱歉，您选择的日期暂无空位。请直接回复此邮件或重新提交其他日期，我们非常期待为您服务。', when: '日期和时间', where: '门店', who: '设计师', what: '项目', map: '路线', note: '店铺留言', foot: '如需更改或取消，请直接回复此邮件。' },
  ja: { got: 'ご予約リクエストを受け付けました', hi: (n) => `${n} 様`, gotB: 'DAY:MEAN をお選びいただきありがとうございます。リクエストを受け付けました。24時間以内にご予約確定のご連絡をいたします。', yours: 'ご依頼内容', conf: 'ご予約が確定しました', confB: 'ご来店を心よりお待ちしております。ご予約内容は以下のとおりです。', dec: 'ご予約リクエストについて', decB: 'リクエストありがとうございます。あいにくご希望の日時に空きがございませんでした。このメールにご返信いただくか、別の日程で再度リクエストをお送りください。', when: '日時', where: '店舗', who: 'デザイナー', what: 'メニュー', map: 'アクセス', note: '店舗からのメッセージ', foot: '変更・キャンセルの際は、このメールにご返信ください。' },
  ko: { got: '예약 요청을 받았어요', hi: (n) => `${n} 님, 안녕하세요.`, gotB: 'DAY:MEAN 을 찾아 주셔서 감사합니다. 예약 요청을 받았고, 24시간 안에 확정 연락을 드릴게요.', yours: '요청 내용', conf: '예약이 확정되었어요', confB: '방문을 기다릴게요. 예약 내용은 아래와 같아요.', dec: '예약 요청 관련 안내', decB: '요청해 주셔서 감사합니다. 아쉽게도 고르신 날짜에는 가능한 시간이 없었어요. 이 메일에 답장하시거나 다른 날짜로 다시 요청해 주세요.', when: '날짜 · 시간', where: '지점', who: '디자이너', what: '시술', map: '오시는 길', note: '매장 메시지', foot: '변경 · 취소는 이 메일에 답장해 주세요.' },
};
const SLOT_T = { en: { any: 'any time', morning: 'morning', afternoon: 'afternoon', evening: 'evening' }, zh: { any: '任何时间', morning: '上午', afternoon: '下午', evening: '晚上' }, ja: { any: '何時でも', morning: '午前', afternoon: '午後', evening: '夕方' }, ko: { any: '아무 때', morning: '오전', afternoon: '오후', evening: '저녁' } };
const prefTxt = (p, L) => `${p.d} ${/^\d{2}:\d{2}$/.test(p.t) ? p.t : (SLOT_T[L] || SLOT_T.en)[p.t] || ''}`.trim();

function mailHtml(L, title, lines, rows, after) {
  const t = T[L] || T.en;
  return `<div style="font-family:-apple-system,BlinkMacSystemFont,'Apple SD Gothic Neo','PingFang SC','Hiragino Sans',sans-serif;max-width:520px;margin:0 auto;color:#111;line-height:1.6">
<div style="font-weight:800;letter-spacing:.02em;font-size:18px;margin:8px 0 18px">DAY:MEAN</div>
<h2 style="font-size:19px;margin:0 0 12px">${esc(title)}</h2>${lines.map((l) => `<p style="margin:0 0 10px">${esc(l)}</p>`).join('')}
${rows.length ? `<table style="width:100%;border-collapse:collapse;margin:14px 0;font-size:14px">${rows.map(([k, v]) => `<tr><td style="padding:8px 0;border-top:1px solid #eee;color:#666;width:34%;vertical-align:top">${esc(k)}</td><td style="padding:8px 0;border-top:1px solid #eee">${v}</td></tr>`).join('')}</table>` : ''}
${after || ''}<p style="font-size:12.5px;color:#888;margin-top:22px">${esc(t.foot)}</p></div>`;
}

export function makeBooking(deps) {
  const { dbGet, dbPatch, dbPut, rlHit, ipKey, ipOf, sameStr, canManageStaff, sendMail, pushToPhones } = deps;
  const siteOk = (request, env) => !!(env.SITE_KEY && sameStr(request.headers.get('X-Site-Key') || '', env.SITE_KEY));
  const rate = async (request, env, tag, max) => {
    const cip = String(request.headers.get('X-Client-IP') || '').slice(0, 64);
    return rlHit(env, tag + await ipKey(cip || ipOf(request)), cip ? max : max * 6, 60 * 60 * 1000);
  };

  function clean(b) {
    const name = clip(b.name, 60);
    const email = clip(b.email, 120).toLowerCase();
    if (!name) throw new Error('name');
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) throw new Error('email');
    if (b.consent !== true) throw new Error('consent');
    if (!['여성', '남성'].includes(b.gender)) throw new Error('gender');   // 성별 필수(11/14 사용자)
    const lang = LANGS.includes(b.lang) ? b.lang : 'en';
    const branch = BRANCHES[b.branch] ? b.branch : 'any';
    const ch = {};
    for (const k of CH) { const v = clip(b.ch && b.ch[k], 60); if (v) ch[k] = v; }
    const today = new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10);
    const prefs = (Array.isArray(b.prefs) ? b.prefs : []).slice(0, 3).map((p) => ({ d: clip(p && p.d, 10), t: clip(p && p.t, 9) }))
      .filter((p) => /^\d{4}-\d{2}-\d{2}$/.test(p.d) && p.d >= today && (SLOTS.includes(p.t) || /^\d{2}:\d{2}$/.test(p.t)));
    if (!prefs.length) throw new Error('prefs');
    return { name, email, phone: clip(b.phone, 30), ch, lang, branch, designer: clip(b.designer, 40), service: clip(Array.isArray(b.services) ? b.services.map((x) => clip(x, 40)).filter(Boolean).slice(0, 20).join(', ') : b.service, 400), prefs, note: clip(b.note, 1000), len: clip(b.len, 20), gender: ['여성', '남성'].includes(b.gender) ? b.gender : '', svcL: clip(b.servicesLabel, 400) };   // svcL: 손님 언어로 쓴 시술 이름(메일용) — service 는 직원용 한국어   // gender: 성별(11/14 사용자 '머리 길이 대신 성별') · len 은 예전 값 호환   // len: 머리 길이(가격표 기장 — 숏컷/남자 · 목선 · 쇄골선 · 가슴 윗선 …)   // service: 메뉴 여러 개(11/14 '우리 메뉴 다 보여주자') — services 배열 또는 service 글자
  }

  /* 알림 받을 사람: 경영팀 전원 + (지점을 골랐으면) 그 지점 관리자, 아무 곳이면 DAY:MEAN 관리자 전원 */
  async function staffFor(env, branch) {
    const us = (await dbGet(env, '/users').catch(() => null)) || {};
    const brKo = { flagship: '플래그십', moment: '모먼트' }[branch];
    const out = [];
    for (const [ph, u] of Object.entries(us)) {
      if (!u || u.status === '퇴사') continue;
      const g = u.systemGrade || '';
      const hq = g === '경영팀' || u.role === '경영팀' || u.role === '본사경영팀';
      const mgr = g === '관리자' || u.role === '관리자' || (Array.isArray(u.roles) && u.roles.includes('관리자'));
      if (hq) out.push(ph);
      else if (mgr && u.brand === 'DAY:MEAN' && (!brKo || String(u.branch || '').includes(brKo))) out.push(ph);
    }
    return out;
  }

  async function mapOf(env, branch) {
    const brs = (await dbGet(env, '/salonInfo/store/branches').catch(() => null)) || [];
    const key = { flagship: /플래그십|flagship/i, moment: /모먼트|moment/i }[branch];
    if (!key) return '';
    for (const b of Object.values(brs)) if (b && key.test(String(b.name || '')) && /^https:\/\//.test(String(b.mapUrl || ''))) return String(b.mapUrl);
    return '';
  }

  async function site(path, request, env, ctx) {
    if (path !== '/public/booking' || request.method !== 'POST') return null;
    if (!siteOk(request, env)) return [403, { ok: false, error: 'site' }];
    if (!(await rate(request, env, 'bk_', 5))) return [429, { ok: false, error: 'rate' }];
    const b = await request.json().catch(() => ({}));
    if (b.hp) return [200, { ok: true }];   // 숨은 칸을 채운 로봇 — 저장하지 않고 '됐다'고만
    let r; try { r = clean(b); } catch (e) { return [400, { ok: false, error: e.message }]; }
    const id = id36(), now = Date.now();
    await dbPut(env, `${BASE}/${id}`, { ...r, status: 'new', at: now, up: now });
    const L = r.lang, t = T[L] || T.en;
    const rows = [[t.where, esc(BRANCHES[r.branch][L] || BRANCHES[r.branch].en)], [t.when, r.prefs.map((p) => esc(prefTxt(p, L))).join('<br>')]];
    if (r.designer) rows.push([t.who, esc(r.designer)]);
    if (r.svcL || r.service) rows.push([t.what, esc(r.svcL || r.service)]);
    const jobs = [
      sendMail(env, r.email, `DAY:MEAN — ${t.got}`, mailHtml(L, t.got, [t.hi(r.name), t.gotB], rows), `${t.hi(r.name)}\n${t.gotB}`).catch((e) => console.log('booking mail', e && e.message)),
      staffFor(env, r.branch).then((to) => to.length && pushToPhones(env, to, { title: '[해외 예약] 새 요청', body: `${r.name} · ${BRANCHES[r.branch].ko} · ${prefTxt(r.prefs[0], 'ko')}${r.prefs.length > 1 ? ` 외 ${r.prefs.length - 1}` : ''}`, url: './#booking', tag: 'book-' + id }, { urgency: 'high' })).catch((e) => console.log('booking push', e && e.message)),
    ];
    if (ctx && ctx.waitUntil) ctx.waitUntil(Promise.all(jobs)); else await Promise.all(jobs);
    return [200, { ok: true, id }];
  }

  async function route(path, request, env, me, json, origin) {
    if (!path.startsWith('/booking/')) return null;
    if (request.method !== 'POST') return json({ ok: false, error: 'POST 만 받습니다' }, 405, origin);
    if (!(await canManageStaff(env, me))) return json({ ok: false, error: '경영팀 · 관리자만 볼 수 있어요' }, 403, origin);
    const b = await request.json().catch(() => ({}));
    try {
      if (path === '/booking/list') {
        const all = (await dbGet(env, BASE).catch(() => null)) || {};
        const old = Object.entries(all).filter(([, v]) => v && Date.now() - (v.up || v.at || 0) > KEEP_MS).map(([k]) => k);
        if (old.length) await dbPatch(env, '/', Object.fromEntries(old.map((k) => [`${BASE.slice(1)}/${k}`, null])));
        const items = Object.entries(all).filter(([k, v]) => v && !old.includes(k)).map(([id, v]) => ({ id, ...v })).sort((x, y) => (y.at || 0) - (x.at || 0));
        return json({ ok: true, items }, 200, origin);
      }
      const id = String(b.id || '');
      if (!ID_RE.test(id)) throw new Error('요청 정보가 올바르지 않습니다');
      const cur = await dbGet(env, `${BASE}/${id}`);
      if (!cur) throw new Error('없는 요청이에요');
      if (path === '/booking/delete') { await dbPut(env, `${BASE}/${id}`, null); return json({ ok: true }, 200, origin); }
      if (path !== '/booking/update') return json({ ok: false, error: '없는 기능입니다' }, 404, origin);
      const u = await dbGet(env, '/users/' + encodeURIComponent(String(me.ph))).catch(() => null);
      const who = (u && (u.nick || u.name)) || '경영팀';
      const up = { up: Date.now() };
      if (b.status != null) { if (!STATUSES.includes(b.status)) throw new Error('상태가 올바르지 않습니다'); up.status = b.status; }
      if (b.memo != null) up.memo = clip(b.memo, 1000);
      if (b.conf) {
        const c = b.conf;
        if (!/^\d{4}-\d{2}-\d{2}$/.test(String(c.d || '')) || !/^\d{2}:\d{2}$/.test(String(c.t || ''))) throw new Error('확정 날짜 · 시간을 넣어 주세요');
        up.conf = { d: c.d, t: c.t, branch: BRANCHES[c.branch] && c.branch !== 'any' ? c.branch : (cur.branch !== 'any' ? cur.branch : 'flagship'), designer: clip(c.designer, 40), msg: clip(c.msg, 500), by: who };
      }
      const L = cur.lang || 'en', t = T[L] || T.en;
      if (b.mail === 'confirm') {
        const c = up.conf || cur.conf;
        if (!c) throw new Error('확정 날짜 · 시간을 먼저 정해 주세요');
        const map = await mapOf(env, c.branch);
        const rows = [[t.when, esc(`${c.d} ${c.t}`)], [t.where, esc('DAY:MEAN ' + (BRANCHES[c.branch][L] || BRANCHES[c.branch].en))]];
        if (c.designer) rows.push([t.who, esc(c.designer)]);
        if (cur.svcL || cur.service) rows.push([t.what, esc(cur.svcL || cur.service)]);
        if (map) rows.push([t.map, `<a href="${esc(map)}" style="color:#111">${esc(map)}</a>`]);
        if (c.msg) rows.push([t.note, esc(c.msg)]);
        await sendMail(env, cur.email, `DAY:MEAN — ${t.conf}`, mailHtml(L, t.conf, [t.hi(cur.name), t.confB], rows), `${t.hi(cur.name)}\n${t.confB}\n${c.d} ${c.t}`);
        up.status = 'confirmed'; up.mailed = { k: 'confirm', at: Date.now(), by: who };
      } else if (b.mail === 'decline') {
        const msg = clip(b.msg, 500);
        await sendMail(env, cur.email, `DAY:MEAN — ${t.dec}`, mailHtml(L, t.dec, [t.hi(cur.name), t.decB].concat(msg ? [msg] : []), []), `${t.hi(cur.name)}\n${t.decB}${msg ? '\n' + msg : ''}`);
        up.status = 'declined'; up.mailed = { k: 'decline', at: Date.now(), by: who };
      }
      await dbPatch(env, `${BASE}/${id}`, up);
      return json({ ok: true, item: { id, ...cur, ...up } }, 200, origin);
    } catch (e) {
      return json({ ok: false, error: String(e.message || e) }, 400, origin);
    }
  }

  return { site, route };
}
