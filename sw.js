// Service Worker — ネットワーク優先戦略
//
// 方針: オンライン時は常にネットワークから最新を取得し、取得できたものを
// キャッシュへ保存する。キャッシュはオフライン時のフォールバック専用。
// これにより「古いバージョンが表示され続ける」ことは構造的に起きない。
//
// SW 自体の更新も即時反映: skipWaiting + clients.claim。
// (登録側は updateViaCache: 'none' で HTTP キャッシュを介さず sw.js を確認する)

const CACHE = 'catan-net-first-v1';

self.addEventListener('install', () => {
  self.skipWaiting(); // 新しい SW を待機させず即座に有効化
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      // 旧バージョンのキャッシュを掃除
      const keys = await caches.keys();
      await Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)));
      await self.clients.claim(); // 開いているタブも即座に管理下へ
    })(),
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return; // 同一オリジンのみ扱う

  event.respondWith(
    (async () => {
      try {
        // ネットワーク優先: 常に最新を取得
        const fresh = await fetch(req);
        if (fresh.ok) {
          const cache = await caches.open(CACHE);
          cache.put(req, fresh.clone());
        }
        return fresh;
      } catch {
        // オフライン: キャッシュへフォールバック
        const cached = await caches.match(req, { ignoreSearch: req.mode === 'navigate' });
        if (cached) return cached;
        if (req.mode === 'navigate') {
          const index = await caches.match('./index.html');
          if (index) return index;
        }
        return new Response('オフラインです', {
          status: 503,
          headers: { 'Content-Type': 'text/plain; charset=utf-8' },
        });
      }
    })(),
  );
});
