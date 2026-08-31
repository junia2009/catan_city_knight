# CLAUDE.md — 開発作業ガイド

このリポジトリで開発するときの手順・検証フロー・慣習。
設計は [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)、ルール仕様は [docs/RULES.md](docs/RULES.md)。

## コマンド

```sh
npm run serve                 # 静的サーバー(http://localhost:8000)
npm test                      # node --test test/(単体+セルフプレイ。ブラウザ不要)
npm run selfplay              # セルフプレイゲート(scripts/selfplay.js 100)
node scripts/selfplay.js 1000 # ゲーム数を指定して回す(モード引数も可)
node scripts/dice-audit.mjs   # 乱数の統計監査(χ²バッテリー)
npm run server                # オンライン対戦サーバー(wrangler dev, :8787)
npm run gen:precache          # sw.js のプリキャッシュ一覧を生成(ファイルを足したら実行)
npm run deploy:server         # Cloudflare へ手動デプロイ(要ログイン。通常は不要 → デプロイの節)
```

ビルド工程はない。ES Modules を直接ブラウザが読む(Three.js は `vendor/` + importmap)。
サーバーだけは wrangler が esbuild でバンドルする(`src/` のルールエンジンをそのまま取り込む)。

**テストは `node_modules` 無しで通ること。** CI は `npm install` をせずに `npm test` を回す。
手元には `three` が入っているので、`import * as THREE from 'three'` したモジュールを
テストから読むと**手元だけ通って CI で落ちる**。計算はレンダリングから切り離して置く
(`src/minigame/ground.js` `motion.js` が例)。`test/no-bare-imports.test.js` が
テストから辿れる import を静的に検査して、これを防いでいる。

## 変更時の検証フロー

1. **ルール変更** → `npm test`。新ルールには必ずテストを足す。
   最重要の不変条件は**保存則**(銀行+全手札 = 資源19×5・商品12×3)と
   セルフプレイ完走(無限ループなし・勝者が規定点以上)。
   **盤面まわり(`rules/board.js`・合法手の列挙順)を触るときは**
   `test/board-regression.test.js` が既存モードの盤面と全展開をハッシュで押さえている。
   落ちたら既存モードを壊している。意図して変えたときだけ GOLDEN を更新する。
2. **UI / 描画変更** → Playwright で E2E(下記レシピ)。スクリーンショットを目視。
3. **見た目の変更**は必ずスクリーンショットをユーザーに見せて確認をとる。
4. **HUD のボタン(`data-act`)やルールを変えたら** `npm test` の `test/demo.test.js` を確認。
   あそびかたデモ(`src/demo/`)の台本が実物の手を出しているので、ここが落ちたら
   デモも一緒に直す(`window.hexDebug.startDemo('setup'|'basic'|'cak')` で再生できる)。

## Playwright E2E レシピ

ヘッドレス Chromium はプリインストール済み。**`playwright install` は実行しない**。

```js
import { chromium } from 'playwright';

const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome', // または /opt/pw-browsers/chromium
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--no-sandbox'],  // WebGL(3D描画)に必須
});
const ctx = await browser.newContext({
  viewport: { width: 390, height: 844 },  // スマホファーストなので縦持ちで確認
  hasTouch: true, isMobile: true,
  serviceWorkers: 'block',                 // SW のキャッシュで古いコードを掴まないように
});
const page = await ctx.newPage();
page.on('pageerror', (e) => console.log('PAGEERROR:', e.message));
await page.goto('http://localhost:8000/index.html?seed=11'); // シード固定で再現可能に
await page.waitForFunction(() => window.hexDebug, null, { timeout: 20000 });
```

### よく使うパターン

- **状態を直接作る**: `hexDebug.getState()` を `structuredClone` して書き換え、
  `hexDebug.setState(s)`。資源を足すときは銀行から引く(保存則を壊さない)。
- **出目の固定**: `s.turnFlags.alchemist = [3, 3]` → ROLL_DICE でその出目になる
  (ゾロ目で暴走、合計7で捨て札などを意図的に起こせる)。
- **セットアップ完走**: `import('./src/ai/cpu-player.js')` して人間の分も
  `chooseAction` で回す(check-dragon.mjs 参照)。
- **3D 上の座標**: `hexDebug.screenPos('vertex'|'edge'|'hex', id)` → `page.touchscreen.tap(x, y)`。
- **昼夜の固定**: `hexDebug.getRenderer().skyPhaseOverride = 0.5` 等(照明・影の確認)。
- **スクリーンショットの注意**: ダイアログや演出は CSS アニメーションの
  0 フレーム目(opacity: 0)を撮りがち。**400〜500ms 待つ**か、
  完了マーカー(例: `.rollfx.land`)を待ってから撮る。

E2E スクリプトはリポジトリに入れず、セッションのスクラッチパッドに `check-*.mjs` として置く。

## オンライン対戦の開発

サーバーの設計は [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md#オンライン対戦-server) を参照。

```sh
npm run server        # 別ターミナルで wrangler dev(:8787)
npm run serve         # 静的サイト(:8000)
# ブラウザで http://localhost:8000/?server=http://127.0.0.1:8787
```

`localhost` では `?server=` なしでも自動でローカルサーバーを見る。
本番の接続先は `src/net/client.js` の `DEFAULT_SERVER`。

- **部屋のロジックは `server/room-core.js` に閉じる**。WebSocket に触るコードを
  混ぜないこと(`node --test test/room.test.js` で直接検証できる価値を失う)。
- **隠し情報を増やしたら `viewFor()` の伏せ処理も更新する**。
  相手の手札を「枚数以外」で描画に使い始めると伏せ処理が破綻するので、
  `render/` 側で `players[other].devCards[i].type` のような読み方をしない。
- ブラウザ2つの E2E は `browser.newContext()` を2つ作り、
  `addInitScript` で `localStorage['hexfrontier.clientId']` を固定すると再接続を再現できる。
  SwiftShader で WebGL を2つ動かすと重いので、待ち時間は長めに取る。
- `window.hexDebug.getNet() / netJoin() / netStart() / netLeave()` が E2E 用のフック。

## オフライン対応(PWA)

CPU 戦のロジックは全てクライアント側にあるので、配信物さえ手元にあれば
完全オフラインで遊べる。`sw.js` が **install 時に全ファイルをプリキャッシュ**して、
初回訪問1回でオフライン化を完結させている。

- 一覧は `scripts/gen-precache.mjs` が `sw.js` のマーカー間に書き出す。
  **`src/` `vendor/` `icons/` にファイルを足したら `npm run gen:precache`**。
  忘れると `test/sw-precache.test.js` が落ちる。
- キャッシュ名には全ファイルの中身のハッシュが入る。1ファイルでも変われば
  `sw.js` が変わってブラウザが SW を入れ直し、プリキャッシュも取り直される。
- 取得方針は従来どおりネットワーク優先。プリキャッシュはオフライン時の
  フォールバック専用なので、「古い版で起動し続ける」ことは起きない。
- オフラインの確認はスクラッチパッドの E2E で
  `ctx.setOffline(true)` + CDP の `Network.setCacheDisabled`(HTTP キャッシュを
  切らないと、SW ではなくブラウザのキャッシュで動いているだけかもしれない)。

## デプロイ

静的サイト(GitHub Pages)とサーバー(Cloudflare)は**別々のワークフローで**デプロイされる。
どちらも `main` への push で自動的に走るので、**手動デプロイは不要**。

- 開発ブランチで作業し、動作確認後に `main` へマージして push。
  - `.github/workflows/pages.yml` → test → GitHub Pages deploy(毎回走る)
  - `.github/workflows/server.yml` → test → Cloudflare Workers deploy →
    疎通確認(`/health`・部屋の作成・CORS・`DEFAULT_SERVER` との一致)。
    `server/**`・`src/**`・`wrangler.toml` が変わったときだけ走る
- ルールエンジン(`src/rules/`, `src/actions.js`)を変更した場合も、
  サーバーが同じコードを取り込んでいるので再デプロイが必要 ──
  これは `src/**` が `server.yml` の paths に入っているので自動で行われる。
- `npm run deploy:server` は手元から緊急でデプロイしたいとき用(要 `wrangler login`)。
  ワークフローが動いているなら使わなくてよい。
- デプロイ確認: GitHub MCP の `actions_list` でワークフロー実行を取得し、
  push した SHA の `"head_sha"` を持つ run の `conclusion` が `success` になるまで確認する
  (完了まで 60〜90 秒程度)。
- **既知の落とし穴**: 2 つの push が近接すると deploy ジョブが
  "in progress deployment" 競合で `failure` になることがある。rerun API は 403 で使えないので、
  **空コミットを push して再トリガー**する(`git commit --allow-empty`)。

## 慣習

- UI 文言・コードコメント・コミットメッセージは**日本語**。
- コミットメッセージには定型トレーラー(Co-Authored-By / Claude-Session)を付ける。
- モデル ID や内部情報をコミット・コード・PR に書かない。
- 乱数は必ず `state.rng` 経由(`rngInt` / `shuffled`)。`Math.random()` はゲームロジック禁止
  (演出のみ可)。
- 新しい進歩カード級の機能は「エンジン定義 + CPU スコアラー + テスト」を 1 セットで。
- `render/` と `render3d/` は state を読むだけ。state を書くのは `actions.js` の apply のみ。
