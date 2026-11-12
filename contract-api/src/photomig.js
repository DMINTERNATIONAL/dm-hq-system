/**
 * 사진 주소에서 전화번호 빼기 (11/12) — POST /admin/migrate-photo-paths  (경영팀 · 관리자만)
 *
 * 왜: 업로드 Worker(img-upload)가 사진을 lookbook/{디자이너 전화번호}/… 에 두었고, 그 r2.dev 공개 주소가
 *     공식 사이트 HTML 에 그대로 실려 번호(= 로그인 아이디)가 새어 나갔다.
 *     새 업로드는 lookbook/p_{HMAC(PATH_KEY, 번호) 16진 앞 16자리}/ 로 간다(img-upload). 이건 예전 사진을 같은 곳으로 옮긴다.
 *
 * 순서 (한 번 부를 때 최대 limit 장 — R2 · DB 요청 수 한도 때문):
 *   1) DB 에서 사진 주소를 찾는다: /salonInfo 전체 · /users/{ph}/photo(직원 사진) · /naesu(내수 송금 캡처)
 *      — 관리 앱(index.html)에서 X-Ph 에 번호를 넣어 올리는 곳이 이 세 군데뿐이다 (seUpPhoto · seUpLook · editStaffPhoto · nsUpload)
 *   2) R2 에서 복사: 큰 판 + 작은 판(.w1000 / .w640, 있으면). 새 이름은 폴더만 바뀌고 파일 이름은 같다
 *   3) DB 글자를 새 주소로 바꾼다 — 복사가 끝난 것만
 *        /salonInfo 는 ETag 로 통째로(그 사이 누가 고쳤으면 다시) — 배열 순번이 바뀌어도 엉뚱한 칸에 쓰지 않게
 *        /users/{ph}/photo · /naesu 캡처는 그 칸만(배열이 바뀌지 않는 기록)
 *   4) DB 를 다시 읽어 예전 주소가 하나도 안 남은 것만 예전 파일을 지운다
 *      (열려 있던 관리 화면이 예전 주소로 다시 저장했으면 지우지 않는다 — 다음 번에 다시 옮긴다)
 *   5) 남은 정리: R2 의 번호 폴더를 훑어, 새 폴더에 복사본이 있고 DB 가 더는 안 쓰는 예전 파일을 지운다
 *      (keepOld 로 남겨 둔 것 · 지우다 실패한 것 · 앞 실행이 중간에 끊긴 것). 복사본이 없는 파일은 손대지 않는다
 *   여러 번 불러도 같다: 이미 옮긴 것은 건너뛰고, 남은 것만 한다. remaining 이 0 이 될 때까지 부르면 된다.
 *
 * 몸통: { dry = true, limit = 20, keepOld = false }
 *   dry      true 면 아무것도 안 바꾸고 몇 개인지 + 예시(번호는 가림)만
 *   keepOld  true 면 예전 파일을 지우지 않는다(다음에 keepOld 없이 부르면 그때 지운다)
 */

const PH_RE = /^0\d{8,10}$/;
/* 사진 주소 안의 번호 폴더 — /lookbook/{번호}/{파일 이름} */
const URL_RE = /(https?:\/\/[^\s"'<>\/]+)\/lookbook\/(0\d{8,10})\/([A-Za-z0-9._-]+)/g;
const TIER_RE = /^(.*_t\d{3,4})\.(webp|jpg)$/;
const MAX_LIMIT = 60;
/* R2 바인딩 호출은 요청 하나에 1000번까지(Cloudflare 한도). 남은 정리는 이만큼 쓰고 나면 다음 실행으로 넘긴다 */
const R2_BUDGET = 800;
const mainOf = (file) => file.replace(/\.w(?:640|1000)\.(webp|jpg)$/, '.$1');

export async function pathHash(secret, ph) {
  const k = await crypto.subtle.importKey('raw', new TextEncoder().encode(String(secret)),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', k, new TextEncoder().encode(String(ph))));
  return [...sig].map((b) => b.toString(16).padStart(2, '0')).join('').slice(0, 16);
}

/* 번호 가리기 — 010****5678 */
const mask = (s) => String(s).replace(/0\d{8,10}/g, (m) => m.slice(0, 3) + '****' + m.slice(-4));

/* 큰 판 이름이면 작은 판 두 장 이름도 (없을 수도 있다 — 복사할 때 있는지 본다) */
function tierNames(file) {
  const m = TIER_RE.exec(file);
  return m ? [file, m[1] + '.w1000.' + m[2], m[1] + '.w640.' + m[2]] : [file];
}

/* 값 안의 글자를 모두 돌며 사진 주소를 찾는다. hits = [{ path: 'a/b/0/u', value }] */
function walk(v, path, hits, depth) {
  if (depth > 12) return;
  if (typeof v === 'string') {
    URL_RE.lastIndex = 0;
    if (URL_RE.test(v)) hits.push({ path, value: v });
    return;
  }
  if (!v || typeof v !== 'object') return;
  for (const [k, x] of Object.entries(v)) walk(x, path + '/' + k, hits, depth + 1);
}

/* 같은 모양 그대로 글자만 바꾼 복사본. 바꾼 칸 수를 n.c 에 센다 */
function rewrite(v, fix, n, depth) {
  if (typeof v === 'string') { const w = fix(v); if (w !== v) n.c++; return w; }
  if (!v || typeof v !== 'object' || depth > 12) return v;
  if (Array.isArray(v)) return v.map((x) => rewrite(x, fix, n, depth + 1));
  const o = {};
  for (const [k, x] of Object.entries(v)) o[k] = rewrite(x, fix, n, depth + 1);
  return o;
}

export function makePhotoMig({ dbGet, dbPatch, casPut }) {
  /* DB 세 곳을 읽어 사진 주소 칸을 모은다 */
  async function scan(env) {
    const [sal, users, naesu] = await Promise.all([
      dbGet(env, '/salonInfo'), dbGet(env, '/users'), dbGet(env, '/naesu'),
    ]);
    const hits = [];
    walk(sal || {}, 'salonInfo', hits, 0);
    /* /users 는 사진 칸만 본다 — 다른 칸(주소 · 메모 등)을 잘못 건드리지 않게 */
    for (const [ph, u] of Object.entries(users || {})) {
      if (u && typeof u.photo === 'string') walk(u.photo, 'users/' + ph + '/photo', hits, 0);
    }
    walk(naesu || {}, 'naesu', hits, 0);
    return { sal, hits };
  }

  return async function migrate(request, env, json, origin) {
    const b = await request.json().catch(() => ({}));
    const dry = !(b && b.dry === false);
    const keepOld = !!(b && b.keepOld === true);
    const limit = Math.min(Math.max(parseInt(b && b.limit, 10) || 20, 1), MAX_LIMIT);
    if (!env.PATH_KEY) return json({ ok: false, error: 'PATH_KEY 가 설정되지 않았습니다 (img-upload 와 같은 값)' }, 503, origin);
    if (!env.LOOKBOOK) return json({ ok: false, error: '사진 저장소(LOOKBOOK) 연결이 없습니다' }, 503, origin);
    const base = String(env.LOOKBOOK_BASE || '').replace(/\/+$/, '');

    const { hits } = await scan(env);
    /* 번호 폴더 → 새 폴더. 우리 저장소 주소(LOOKBOOK_BASE)가 아닌 것은 건드리지 않는다 */
    const hcache = {};
    const folderOf = async (ph) => (hcache[ph] || (hcache[ph] = 'p_' + await pathHash(env.PATH_KEY, ph)));
    const groups = new Map();   // 예전 키(큰 판) → { ph, file, nk }
    let foreign = 0;
    for (const h of hits) {
      URL_RE.lastIndex = 0;
      let m;
      while ((m = URL_RE.exec(h.value))) {
        if (base && m[1] !== base) { foreign++; continue; }
        const ok = 'lookbook/' + m[2] + '/' + m[3];
        if (!groups.has(ok)) groups.set(ok, { ph: m[2], file: m[3], nk: 'lookbook/' + await folderOf(m[2]) + '/' + m[3] });
      }
    }
    const byRoot = {};
    for (const h of hits) { const r = h.path.split('/')[0]; byRoot[r] = (byRoot[r] || 0) + 1; }
    const summary = {
      fields: hits.length, byRoot, photos: groups.size,
      phones: new Set([...groups.values()].map((g) => g.ph)).size, foreignHost: foreign,
    };

    if (dry) {
      const sample = [];
      for (const h of hits.slice(0, 10)) {
        URL_RE.lastIndex = 0;
        const m = URL_RE.exec(h.value);
        const g = m && groups.get('lookbook/' + m[2] + '/' + m[3]);
        sample.push({ path: mask(h.path), from: mask(h.value), to: g ? h.value.replace(m[0], m[1] + '/' + g.nk) : null });
      }
      return json({ ok: true, dry: true, ...summary, willMoveThisRun: Math.min(limit, groups.size), sample }, 200, origin);
    }

    /* 2) 복사 — 이번에는 limit 장까지. 예전 파일이 없으면 새 쪽에 이미 있는지 본다(앞선 실행이 옮기고 지운 경우) */
    const done = new Map();   // 예전 큰 판 키 → 새 큰 판 키 (DB 를 바꿔도 되는 것)
    const oldKeys = {};       // 예전 큰 판 키 → 지울 예전 파일 키들
    let copied = 0, missing = 0, ops = 0;
    const errors = [];
    for (const [ok, g] of [...groups.entries()].slice(0, limit)) {
      const dir = ok.slice(0, ok.length - g.file.length), ndir = g.nk.slice(0, g.nk.length - g.file.length);
      const olds = [];
      let mainOk = false;
      try {
        for (const [i, f] of tierNames(g.file).entries()) {
          const o = await env.LOOKBOOK.get(dir + f);
          ops++;
          if (o) {
            await env.LOOKBOOK.put(ndir + f, await o.arrayBuffer(), { httpMetadata: o.httpMetadata, customMetadata: o.customMetadata });
            olds.push(dir + f);
            copied++; ops++;
            if (i === 0) mainOk = true;
          } else if (i === 0) {
            mainOk = !!(await env.LOOKBOOK.head(ndir + f));
            ops++;
            /* 예전 · 새 쪽 어디에도 없으면 원래 깨진 주소다 — 그래도 번호는 빼야 하므로 주소는 바꾼다(사진은 어차피 안 보인다) */
            if (!mainOk) { missing++; mainOk = true; }
          }
        }
      } catch (e) { errors.push(mask(ok) + ': ' + String((e && e.message) || e).slice(0, 80)); continue; }
      if (mainOk) { done.set(ok, g.nk); oldKeys[ok] = olds; }
    }

    /* 3) DB 바꾸기 — 복사가 끝난 주소만. 한 칸에 주소가 여럿이면 전부 끝났을 때만 */
    const fix = (s) => {
      URL_RE.lastIndex = 0;
      let all = true;
      const out = s.replace(URL_RE, (m0, host, ph, file) => {
        if (base && host !== base) return m0;
        const nk = done.get('lookbook/' + ph + '/' + file);
        if (!nk) { all = false; return m0; }
        return host + '/' + nk;
      });
      return all ? out : s;
    };
    let rewritten = 0;
    if (done.size) {
      /* /salonInfo — ETag 로 통째로. 412(그 사이 누가 저장)면 새로 읽어 다시. 세 번 다 실패하면 이번엔 DB 를 못 바꾼 것 */
      let salOk = false;
      for (let i = 0; i < 3 && !salOk; i++) {
        const n = { c: 0 };
        const r = await casPut(env, '/salonInfo', (cur) => {
          if (!cur) return undefined;
          const next = rewrite(cur, fix, n, 0);
          return n.c ? next : undefined;
        });
        if (r === 'nochange') salOk = true;
        else if (r === 'ok') { salOk = true; rewritten += n.c; }
      }
      if (!salOk) return json({ ok: false, error: '매장 정보가 저장 중이라 바꾸지 못했어요. 잠시 뒤 다시 실행해 주세요 (복사한 사진은 그대로 둡니다)', copied }, 409, origin);
      /* /users/{ph}/photo · /naesu — 그 칸만 */
      const up = {};
      for (const h of hits) {
        if (h.path.startsWith('salonInfo/')) continue;
        const w = fix(h.value);
        if (w !== h.value) up[h.path] = w;
      }
      if (Object.keys(up).length) { await dbPatch(env, '/', up); rewritten += Object.keys(up).length; }
    }

    /* 4) 다시 읽어 예전 주소가 남았는지 본다 — 남은 사진의 예전 파일은 지우지 않는다 */
    const after = await scan(env);
    const still = new Set();
    for (const h of after.hits) {
      URL_RE.lastIndex = 0;
      let m;
      while ((m = URL_RE.exec(h.value))) if (!base || m[1] === base) still.add('lookbook/' + m[2] + '/' + m[3]);
    }
    let deleted = 0, kept = 0;
    if (!keepOld) {
      for (const ok of done.keys()) {
        if (still.has(ok)) { kept++; continue; }
        for (const k of oldKeys[ok] || []) {
          try { await env.LOOKBOOK.delete(k); deleted++; ops++; } catch (e) { errors.push(mask(k) + ': 삭제 실패'); }
        }
      }
      /* 5) 남은 정리 — 번호 폴더(lookbook/0…/)의 파일 중 새 폴더에 같은 이름이 있고 DB 가 안 쓰는 것만 */
      try {
        const top = await env.LOOKBOOK.list({ prefix: 'lookbook/', delimiter: '/' });
        ops++;
        const dirs = (top.delimitedPrefixes || []).filter((d) => PH_RE.test(d.slice(9, -1)));
        outer: for (const d of dirs) {
          const ph = d.slice(9, -1), nd = 'lookbook/' + await folderOf(ph) + '/';
          let cursor;
          do {
            if (ops > R2_BUDGET) break outer;
            const pg = await env.LOOKBOOK.list({ prefix: d, cursor });
            ops++;
            for (const o of pg.objects || []) {
              if (ops > R2_BUDGET) break outer;
              const file = o.key.slice(d.length);
              if (still.has(d + mainOf(file))) continue;
              const copy = await env.LOOKBOOK.head(nd + file);
              ops++;
              if (!copy) continue;
              await env.LOOKBOOK.delete(o.key);
              ops++; deleted++;
            }
            cursor = pg.truncated ? pg.cursor : undefined;
          } while (cursor);
        }
      } catch (e) { errors.push('남은 정리: ' + String((e && e.message) || e).slice(0, 80)); }
    }
    /* 남은 수 = 다시 읽은 DB 에 아직 번호 주소로 남은 사진. 0 이 될 때까지 다시 부른다 */
    let remaining = 0;
    for (const k of still) if (!done.has(k)) remaining++;
    remaining += kept;
    return json({ ok: errors.length === 0, dry: false, ...summary, copied, missing, rewritten, deleted, keptBecauseStillUsed: kept, remaining, budgetHit: ops > R2_BUDGET, errors: errors.slice(0, 20) }, 200, origin);
  };
}
