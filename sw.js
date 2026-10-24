// DM INTERNATIONAL - Service Worker
// 앱 화면(index.html)은 기기에 저장된 것으로 바로 띄우고, 새 버전은 뒤에서 받아 둔다(다음에 열 때 적용 · 화면에 안내).
// 그 밖의 같은 사이트 파일은 예전처럼 새 버전 우선(Network First), 끊기면 저장본.

const CACHE_NAME = 'dm-cache-v2';
const APP_KEY = new URL('./index.html', self.registration.scope).href;

self.addEventListener('install', (event) => {
  // 즉시 활성화 (대기 안 함)
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    Promise.all([
      // 옛날 캐시 삭제
      caches.keys().then((keys) =>
        Promise.all(
          keys.filter((k) => k !== CACHE_NAME && k !== 'dm-nav').map((k) => caches.delete(k))
        )
      ),
      // 모든 탭에서 즉시 새 SW 사용
      self.clients.claim()
    ])
  );
});

function isApp(req, url) {
  if (url.origin !== self.location.origin) return false;
  const p = url.pathname, scope = new URL(self.registration.scope).pathname;
  return req.mode === 'navigate' ? (p === scope || p === scope + 'index.html') : p === scope + 'index.html' && req.destination === 'document';
}

// 서버에서 앱 화면을 다시 받아 저장한다. 저장본과 달라졌으면 열린 화면에 알린다.
let checking = null;
function refreshApp() {
  if (checking) return checking;
  checking = (async () => {
    try {
      const cache = await caches.open(CACHE_NAME);
      const old = await cache.match(APP_KEY);
      const res = await fetch(APP_KEY, { cache: 'no-cache' });
      if (!res || res.status !== 200) return null;
      const txt = await res.clone().text();
      const oldTxt = old ? await old.text() : null;
      await cache.put(APP_KEY, res.clone());
      if (oldTxt != null && oldTxt !== txt) {
        const list = await self.clients.matchAll({ type: 'window' });
        list.forEach((c) => c.postMessage({ type: 'app-updated' }));
      }
      return res;
    } catch (_) { return null; } finally { checking = null; }
  })();
  return checking;
}

self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;

  const url = new URL(event.request.url);

  // 앱 화면: 저장본이 있으면 바로, 새 버전 확인은 뒤에서
  if (isApp(event.request, url)) {
    event.respondWith(
      caches.open(CACHE_NAME).then((cache) => cache.match(APP_KEY)).then((hit) => {
        const fresh = refreshApp();
        event.waitUntil(fresh);
        if (hit) return hit;
        return fresh.then((r) => r ? r.clone() : fetch(event.request));
      }).catch(() => fetch(event.request))
    );
    return;
  }

  // 외부 도메인(Firebase 등)은 SW 개입 안 함
  if (url.origin !== self.location.origin) return;

  // Network First 전략: 새 버전 우선, 실패 시 캐시 폴백
  event.respondWith(
    fetch(event.request)
      .then((response) => {
        // 성공하면 캐시에 저장 (오프라인 대비)
        if (response && response.status === 200) {
          const clone = response.clone();
          caches.open(CACHE_NAME).then((cache) => {
            cache.put(event.request, clone).catch(() => {});
          });
        }
        return response;
      })
      .catch(() => {
        // 네트워크 실패 (오프라인) → 캐시에서 폴백
        return caches.match(event.request);
      })
  );
});

// 앱에서 SKIP_WAITING 메시지 받으면 즉시 활성화
self.addEventListener('message', (event) => {
  if (event.data === 'SKIP_WAITING') {
    self.skipWaiting();
  }
  // 앱이 오래 백그라운드에 있다가 다시 보일 때 새 버전 확인
  if (event.data && event.data.type === 'check-app') event.waitUntil(refreshApp());
});

// ── 폰·PC 알림(웹 푸시) ──
// 서버(dm-contract-api)가 보낸 알림을 화면에 띄운다. 아이폰은 받은 푸시를 반드시 화면에 보여줘야
// 하므로(안 보이면 애플이 구독을 끊는다) 내용을 못 읽어도 기본 문구로라도 띄운다.
self.addEventListener('push', (event) => {
  let d = {};
  try { d = event.data ? event.data.json() : {}; } catch (_) { d = { body: event.data ? event.data.text() : '' }; }
  const jobs = [self.registration.showNotification(d.title || 'DM', {
    body: d.body || '새 알림이 있습니다',
    tag: d.tag || undefined,
    renotify: !!d.tag,
    data: { url: d.url || './' },
  })];
  // 앱 아이콘 숫자 배지 (지원하는 기기만)
  if (typeof d.badge === 'number' && self.navigator && 'setAppBadge' in self.navigator) {
    jobs.push((d.badge > 0 ? self.navigator.setAppBadge(d.badge) : self.navigator.clearAppBadge()).catch(() => {}));
  }
  event.waitUntil(Promise.all(jobs));
});

// 알림을 누르면 열려 있는 앱 창으로 가서 해당 화면을 연다. 없으면 새로 연다.
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const target = new URL((event.notification.data && event.notification.data.url) || './', self.registration.scope).href;
  // 아이폰은 앱이 꺼져 있으면 알림 주소 대신 첫 화면으로 열 때가 있다 → 갈 곳을 쪽지로 남겨 두고 앱이 열리면 읽는다(index.html cmPendingNav)
  const note = caches.open('dm-nav').then((c) => c.put('/__nav', new Response(JSON.stringify({ url: target, at: Date.now() }), { headers: { 'Content-Type': 'application/json' } }))).catch(() => {});
  event.waitUntil(note.then(() =>
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
      for (const c of list) {
        if (c.url.indexOf(self.registration.scope) === 0 && 'focus' in c) {
          c.postMessage({ type: 'open', url: target });
          return c.focus();
        }
      }
      return self.clients.openWindow(target);
    })
  ));
});
