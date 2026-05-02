// DM INTERNATIONAL - Service Worker
// 항상 최신 버전 받기 (Network First)

const CACHE_NAME = 'dm-cache-v1';

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
          keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k))
        )
      ),
      // 모든 탭에서 즉시 새 SW 사용
      self.clients.claim()
    ])
  );
});

self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;

  const url = new URL(event.request.url);

  // 외부 도메인(Firebase, Lucide CDN 등)은 SW 개입 안 함
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
});
