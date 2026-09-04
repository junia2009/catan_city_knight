// Service Worker — ネットワーク優先 + install 時のプリキャッシュ
//
// 方針: オンライン時は常にネットワークから最新を取得し、取得できたものを
// キャッシュへ保存する。キャッシュはオフライン時のフォールバック専用。
// これにより「古いバージョンが表示され続ける」ことは構造的に起きない。
//
// プリキャッシュ: CPU 戦のロジックは全てクライアント側にあるので、配信物さえ
// 手元にあれば完全オフラインで遊べる。ところが SW が制御を握るのは
// 起動用モジュールが読み終わったあとなので、放っておくと初回訪問では
// ほとんど何もキャッシュに入らない(オフラインで動くのはブラウザの HTTP
// キャッシュ頼みで、容量が逼迫すれば捨てられる)。そこで install 時に
// まとめて取り込み、一度の訪問だけでオフライン化を完結させる。
//
// SW 自体の更新も即時反映: skipWaiting + clients.claim。
// (登録側は updateViaCache: 'none' で HTTP キャッシュを介さず sw.js を確認する)

// >>> precache:generated (scripts/gen-precache.mjs で生成。手で編集しない)
const PRECACHE_VERSION = 'a0e3b6996292';
const PRECACHE = [
  './',
  './icons/apple-touch-icon.png',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './index.html',
  './manifest.webmanifest',
  './src/achievements.js',
  './src/actions.js',
  './src/ai/cpu-player.js',
  './src/ai/evaluator.js',
  './src/ai/legal-moves.js',
  './src/ai/progress-ai.js',
  './src/audio/bgm.js',
  './src/audio/ctx.js',
  './src/audio/footsteps.js',
  './src/audio/sfx.js',
  './src/demo/driver.js',
  './src/demo/scenario.js',
  './src/demo/script.js',
  './src/input.js',
  './src/main.js',
  './src/minigame/archery-fx.js',
  './src/minigame/archery.js',
  './src/minigame/body.js',
  './src/minigame/contest.js',
  './src/minigame/daifugo.js',
  './src/minigame/desk.js',
  './src/minigame/emote.js',
  './src/minigame/fish.js',
  './src/minigame/fishing-fx.js',
  './src/minigame/fishing.js',
  './src/minigame/ground.js',
  './src/minigame/meets.js',
  './src/minigame/motion.js',
  './src/minigame/obstacles.js',
  './src/minigame/pose.js',
  './src/minigame/remote-st.js',
  './src/minigame/remote-view.js',
  './src/minigame/remote.js',
  './src/minigame/scale.js',
  './src/minigame/species.js',
  './src/minigame/table.js',
  './src/minigame/walk-mode.js',
  './src/minigame/walker.js',
  './src/minigame/water-fx.js',
  './src/net/client.js',
  './src/progress.js',
  './src/render/avatars.js',
  './src/render/board-render.js',
  './src/render/dom.js',
  './src/render/hud-render.js',
  './src/render/records.js',
  './src/render/rules-content.js',
  './src/render3d/board3d.js',
  './src/rng.js',
  './src/rules/board.js',
  './src/rules/build.js',
  './src/rules/cak/barbarians.js',
  './src/rules/cak/improvements.js',
  './src/rules/cak/knights.js',
  './src/rules/cak/progress-cards.js',
  './src/rules/dice.js',
  './src/rules/dragon.js',
  './src/rules/fish.js',
  './src/rules/road-building.js',
  './src/rules/robber.js',
  './src/rules/sea.js',
  './src/rules/trade.js',
  './src/rules/victory.js',
  './src/state.js',
  './src/storage.js',
  './src/terrain.js',
  './vendor/addons/controls/OrbitControls.js',
  './vendor/three.core.min.js',
  './vendor/three.module.min.js',
];
// <<< precache:generated

// 中身が1ファイルでも変われば PRECACHE_VERSION が変わり、
// 新しいキャッシュに入れ直したうえで古いものを捨てる。
const CACHE = `hexfrontier-${PRECACHE_VERSION}`;

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE);
      // 1つでも失敗すると addAll は全部やめてしまうので、1件ずつ入れる。
      // 取りこぼしても致命的ではない(次のオンライン時に fetch 経由で入る)。
      await Promise.all(
        PRECACHE.map(async (url) => {
          try {
            const res = await fetch(new Request(url, { cache: 'reload' }));
            if (res.ok) await cache.put(url, res);
          } catch {
            // ネットワークが不安定なだけなので、この1件は諦める
          }
        }),
      );
      await self.skipWaiting(); // 新しい SW を待機させず即座に有効化
    })(),
  );
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
