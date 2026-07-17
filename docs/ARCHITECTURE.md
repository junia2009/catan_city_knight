# アーキテクチャ

本作の設計原則・状態機械・モジュール構成・レンダラー・CPU・テスト戦略をまとめる。
ルールの仕様(公式との差分)は [RULES.md](RULES.md)、作業手順は [../CLAUDE.md](../CLAUDE.md) を参照。

## 設計原則

1. **ルールエンジンと描画の完全分離**
   `src/rules/` と `src/actions.js` は DOM / canvas / Three.js に一切依存しない純粋な
   JavaScript。`node --test` だけで全ルールが検証でき、セルフプレイも Node 単体で回る。
2. **単一のシリアライズ可能な GameState**
   ゲームの全情報は 1 つの plain object。`structuredClone` / `JSON.stringify` がそのまま通る
   (Map / Set / クラスインスタンスは使わない)。ID は文字列キーの plain object で引く。
3. **決定性**
   乱数は全て `state.rng`(シード付き mulberry32)経由。同じシード + 同じアクション列は
   必ず同じ結果になる。これがテスト・再現・デバッグの土台。
4. **ビルド工程なし**
   ES Modules を直接ブラウザで読む。Three.js は `vendor/` にベンダリングし importmap で解決。

## アクションパイプライン

全ての状態変更は 1 本道:

```
dispatch(state, action)
  ├─ validateAction(state, action)  … 純粋関数。エラーなら日本語の理由文字列、OKなら null
  ├─ structuredClone(state)         … 元の state は不変
  └─ applyAction(clone, action)     … クローンに適用して返す
```

- `validateAction` は UI のボタン活性判定にもそのまま使う(エンジンと UI で判定が一致)。
- CPU も人間も同じ `dispatch` を通る。CPU は `chooseAction(state, pid)` が action を返すだけ。

### アクション一覧(`src/actions.js`)

| 分類 | アクション |
|---|---|
| 共通 | `PLACE_INITIAL` `ROLL_DICE` `DISCARD` `MOVE_ROBBER` `BUILD_ROAD` `BUILD_SETTLEMENT` `BUILD_CITY` `TRADE_BANK` `END_TURN` |
| 交易 | `TRADE_PLAYERS`(CPU↔CPU 即時) `OFFER_TRADE`(人間へ提案) `RESPOND_TRADE` |
| 基本のみ | `BUY_DEV_CARD` `PLAY_DEV_CARD` |
| 都市と騎士 | `BUILD_KNIGHT` `ACTIVATE_KNIGHT` `PROMOTE_KNIGHT` `MOVE_KNIGHT` `CHASE_ROBBER` `BUILD_WALL` `BUY_IMPROVEMENT` `PLAY_PROGRESS_CARD` `RAZE_CITY` `PICK_AQUEDUCT` |
| ドラゴンの島 | `BUILD_TOWER` |

### 割り込み(awaiting 状態機械)

手番の通常フローを中断する処理は `state.awaiting = { type, players, context }` で表現する。
`awaiting` が非 null の間は、`players` に含まれるプレイヤーの該当アクションしか通らない。

| type | 発生元 | 解決アクション |
|---|---|---|
| `setupPlacement` | 初期配置(スネーク順) | `PLACE_INITIAL` |
| `discard` | 7ロール / 破壊工作員(`context.cause` で区別) | `DISCARD` |
| `moveRobber` | 7ロール / 騎士追い払い | `MOVE_ROBBER` |
| `barbarianDefense` | 蛮族侵攻で敗北した都市所有者 | `RAZE_CITY` |
| `tradeOffer` | CPU→人間の交易提案 | `RESPOND_TRADE` |
| `aqueduct` | 水道橋(科学Lv3)所持者が無産出の出目 | `PICK_AQUEDUCT` |

複数プレイヤー待ち(捨て札など)は `players` 配列から解決済みを取り除き、
空になったら次の状態へ遷移する。

## GameState の主なフィールド(`src/state.js`)

```js
{
  seed, mode,              // 'base' | 'cak' | 'dragon'
  difficulty,              // 'easy' | 'normal' | 'hard'(CPU評価ノイズ量)
  rng,                     // mulberry32 の内部状態(数値)
  phase,                   // 'setup' | 'main' | 'ended'
  turn, currentPlayer,
  awaiting,                // 上記の割り込み(null = 通常フロー)
  board,                   // hexes(terrain/token)・robber・ports
  buildings, roads,        // vertexId/edgeId -> { player, ... }
  players: [{ resources, devCards, commodities, improvements,
              progressCards, progressVP, defenderPoints, treasures, ... }],
  bank,                    // resources 各19・devDeck・commodities 各12・progressDecks
  dice, eventDie,          // eventDie は cak のみ('ship' | 各進歩デッキ)
  turnFlags,               // rolled / playedDev / fleet / offeredTrade / alchemist ...
  longestRoad, largestArmy,
  knights, walls, merchant, barbarians, metropolis,   // 都市と騎士
  dragon, towers, burned,                             // ドラゴンの島
  winner, log,
}
```

## モジュール構成

```
src/
├── main.js       # 画面フロー(title/select/rules/game)・入力モード・CPUスケジューラ・演出
├── actions.js    # validate / apply の一本道
├── state.js      # createGame と定数
├── rng.js        # makeRng / rngNext / rngInt / shuffled(mulberry32)
├── input.js      # ポインタ入力の正規化
├── rules/
│   ├── board.js      # 盤面生成・LAYOUT(hex/vertex/edge の隣接表)・PIPS
│   ├── build.js      # 建設コスト・配置判定・手札上限
│   ├── dice.js       # 資源分配(distributeForRoll)
│   ├── robber.js     # 略奪対象・ランダムスチール
│   ├── trade.js      # tradeRate(港・商船隊・商人・商業Lv3)
│   ├── victory.js    # computePoints / pointsToWin / 最長交易路
│   ├── cak/          # barbarians / knights / improvements / progress-cards(54枚)
│   └── dragon.js     # 暴走・炎上・見張り塔・財宝
├── ai/
│   ├── cpu-player.js  # chooseAction(全ての判断の入口)
│   ├── evaluator.js   # 盤面評価・evalNoise(難易度)
│   ├── legal-moves.js # 合法手列挙
│   └── progress-ai.js # 進歩カード別スコアラー(SCORERS)
├── render/
│   ├── board-render.js  # 2D Canvas(オフスクリーンキャッシュ)
│   ├── hud-render.js    # DOM HUD・全ダイアログ・ステータス文
│   └── rules-content.js # あそびかた(タブ構成、カード説明は定義から自動生成)
├── render3d/board3d.js  # Three.js レンダラー
└── audio/bgm.js         # ジェネレーティブBGM(Web Audio)
```

### 進歩カードのプラグイン構造

54枚(25種)は `PROGRESS_CARDS[id]` の宣言的定義に集約:

```js
{ deck, count, name, icon, desc,     // メタ情報(UI・説明書はここから自動生成)
  needsParams,                       // UI がどの入力モードを開くか
  preRoll?, vp?,                     // ロール前使用可(錬金術師)/ 勝利点カード
  validate(state, pid, params),      // エラー文字列 | null
  play(state, pid, params) }         // 効果適用
```

CPU 側も同じ思想で `progress-ai.js` の `SCORERS[id]` に「今使うと何点相当か」を
カード別に実装し、`pickProgressPlay` が難易度別の閾値と比較して使用を決める。
新カードの追加 = 定義 1 つ + スコアラー 1 つ。

## CPU(`src/ai/`)

`chooseAction(state, pid)` の優先順:

1. **awaiting の解決**(初期配置 / 捨て札 / 盗賊 / 都市破壊 / 交易応答 / 水道橋)
2. ロール前: 錬金術師の使用判断(cak)
3. ロール
4. メインフェーズ(貪欲法): 進歩カード使用 → 都市化 → 開拓地 → 騎士(蛮族対応)→
   都市改良 → 見張り塔(dragon)→ 道 → 発展カード → 銀行/プレイヤー間交易 → 手番終了

- 評価は `evaluator.js` の盤面スコア(生産力・勝利点・多様性)+ 目標(nextGoal)への距離。
- **難易度**は評価値への決定的ノイズで実現: `evalNoise(state, key)` が
  シード・手番・候補キーの FNV 風ハッシュから擬似乱数を作り、
  振幅 0(強い)/ 0.9(普通)/ 3.0(弱い)で加算する。state の rng を消費しないため
  難易度が変わってもゲームの乱数列は同一。
  交易の応諾マージンとカード使用閾値も難易度で変わる。
- プレイヤー間交易: CPU↔CPU は `TRADE_PLAYERS` で即時成立。人間へは `OFFER_TRADE`
  (1手番1回、断られると4手番のクールダウン)。

## レンダラー

`viewMode`('3d' | '2d')で切替。両者とも「state を受けて全体を再描画」する冪等な設計で、
差分管理はキャッシュキーで行う。

### 2D(`render/board-render.js`)

静的な盤面(ヘックス・港・数字)はオフスクリーン canvas に一度だけ描き、
キー `${seed}:${board.version}:${w}x${h}@${dpr}` が変わるまで再利用。
動的要素(建物・コマ・ハイライト)は毎フレーム上書き。

### 3D(`render3d/board3d.js`)

- **staticGroup**: 地形・海・装飾。キー `${seed}:${mode}:${board.version ?? 0}` で再構築。
- **dynamicGroup**: 建物・騎士・塔など。state のキー列を diff して増減分だけ生成/破棄。
- **海**: カスタム ShaderMaterial。19ヘックス中心への最短距離で深度グラデーション、
  value ノイズの波・岸辺の泡・雲影・頂点うねり。影は同一ジオメトリの
  ShadowMaterial(`seaShadowMat`)を重ねて受ける。
- **空**: BackSide の球に地平線→天頂グラデーション+太陽グロー+ハッシュ星空。
  `SKY_CYCLE_SEC = 300` 秒で昼夜サイクル。`SKY_PHASES` のキーフレームを補間し、
  太陽光の位置/強さ・半球光の色(夜は月明かり色)・フォグ・海の色・影の濃さを同期。
- **地形**: ヘックスごとに6セクターを重心細分(N=4)した非インデックス
  BufferGeometry。頂点座標のハッシュで隣接ヘックスと継ぎ目を一致させる(watertight)。
- **演出**: ドラゴンの飛翔→火炎ブレス→着火のチェーン、蛮族船の航路航行、
  3D ダイスの転がり、交易バナー等。演出中も state は既に確定済み
  (描画が後追いするだけで、ロジックは待たない)。

## BGM(`audio/bgm.js`)

音源ファイルなしの完全合成。D ドリアンのコード進行を先読みスケジューラで生成し、
ドローン+パッド+撥弦+フルートを合成リバーブ(生成した IR で convolution)に通す。
iOS 対策で初回ポインタイベントから開始。ON/OFF は localStorage に保存。

## テスト戦略

| 層 | 手段 |
|---|---|
| ルール単体 | `node --test test/`(85+ テスト)。validate の拒否理由・apply の結果・保存則 |
| 統計 | `test/rng.test.js` + `scripts/dice-audit.mjs`(χ² バッテリー。対の検定は**非重複**ペアで) |
| 結合 | セルフプレイ: CPU のみで数百ゲーム完走・無限ループ検出・資源/商品の保存則・勝者の点数検証 |
| E2E | Playwright(headless Chromium + SwiftShader)。`window.catanDebug` で state を直接操作して
UI フローを検証(手順は [CLAUDE.md](../CLAUDE.md)) |

**保存則**は最重要の不変条件: どの時点でも 銀行+全員の手札 = 資源 19×5・商品 12×3。

## デバッグフック

- `window.catanDebug`: `getState` / `setState`(差し替え+再描画+CPU再開)/ `doAction` /
  `newGameWith(patch)` / `getUi` / `screenPos(kind, id)`(3D→画面座標)/ `getRenderer` /
  `getBgm` / `getViewState`
- URL `?seed=123`: シード固定
- `renderer.skyPhaseOverride = 0..1`: 昼夜サイクルの時刻固定(影・照明の目視確認用)
- `turnFlags.alchemist = [a, b]`: 次ロールの出目固定(テストで暴走や7を意図的に起こす)
