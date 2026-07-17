# CLAUDE.md — 開発作業ガイド

このリポジトリで開発するときの手順・検証フロー・慣習。
設計は [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)、ルール仕様は [docs/RULES.md](docs/RULES.md)。

## コマンド

```sh
npm run serve                 # ローカルサーバー(http://localhost:8000)
npm test                      # node --test test/(単体+セルフプレイ。ブラウザ不要)
npm run selfplay              # セルフプレイゲート(scripts/selfplay.js 100)
node scripts/selfplay.js 1000 # ゲーム数を指定して回す(モード引数も可)
node scripts/dice-audit.mjs   # 乱数の統計監査(χ²バッテリー)
```

ビルド工程はない。ES Modules を直接ブラウザが読む(Three.js は `vendor/` + importmap)。

## 変更時の検証フロー

1. **ルール変更** → `npm test`。新ルールには必ずテストを足す。
   最重要の不変条件は**保存則**(銀行+全手札 = 資源19×5・商品12×3)と
   セルフプレイ完走(無限ループなし・勝者が規定点以上)。
2. **UI / 描画変更** → Playwright で E2E(下記レシピ)。スクリーンショットを目視。
3. **見た目の変更**は必ずスクリーンショットをユーザーに見せて確認をとる。

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
await page.waitForFunction(() => window.catanDebug, null, { timeout: 20000 });
```

### よく使うパターン

- **状態を直接作る**: `catanDebug.getState()` を `structuredClone` して書き換え、
  `catanDebug.setState(s)`。資源を足すときは銀行から引く(保存則を壊さない)。
- **出目の固定**: `s.turnFlags.alchemist = [3, 3]` → ROLL_DICE でその出目になる
  (ゾロ目で暴走、合計7で捨て札などを意図的に起こせる)。
- **セットアップ完走**: `import('./src/ai/cpu-player.js')` して人間の分も
  `chooseAction` で回す(check-dragon.mjs 参照)。
- **3D 上の座標**: `catanDebug.screenPos('vertex'|'edge'|'hex', id)` → `page.touchscreen.tap(x, y)`。
- **昼夜の固定**: `catanDebug.getRenderer().skyPhaseOverride = 0.5` 等(照明・影の確認)。
- **スクリーンショットの注意**: ダイアログや演出は CSS アニメーションの
  0 フレーム目(opacity: 0)を撮りがち。**400〜500ms 待つ**か、
  完了マーカー(例: `.rollfx.land`)を待ってから撮る。

E2E スクリプトはリポジトリに入れず、セッションのスクラッチパッドに `check-*.mjs` として置く。

## デプロイ

- 開発ブランチで作業し、動作確認後に `main` へマージして push
  (`main` push で `.github/workflows/pages.yml` が test → GitHub Pages deploy)。
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
