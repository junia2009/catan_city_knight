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

## 盤面の形(`src/rules/board.js`)

盤の**幾何**と、**どのヘックスを実際に使うか**を分けている。

- `LAYOUT` … ヘックス・頂点・辺の隣接表。モジュール定数として一度だけ構築する。
  幾何しか持たないので、使いうる最大半径(`MAX_BOARD_RADIUS = 3`、37ヘックス)まで作っておく。
- `board.hexIds` … その対戦で実際に使うヘックスのID列。基本の盤は半径2の19ヘックス。
  **盤の形を変えられるのはここだけ**で、モードごとに違う形の盤を作れる。
- 頂点・辺・海岸辺は `board.hexIds` から導出する(`boardVertexIds` / `boardEdgeIds` /
  `coastalEdgesOf`)。導出結果はヘックスID列をキーにメモ化してあり、**state には持たせない**
  ── オンライン対戦は毎手番 state を配るので、頂点IDの配列を積むと通信量が跳ね上がるため。

`LAYOUT` の並び順は「基本の盤 → その外側」。こうすると頂点IDや辺IDの列が
基本の盤のものと**完全に前方一致**するので、盤を広げても既存モードの同点処理
(先に見つけたものを採る)が一切変わらない。`test/board-regression.test.js` が
モード×シードごとに盤面と対戦の全展開をハッシュで固定しており、
ここを触って既存モードの挙動が変わったら落ちる。

`LAYOUT.vertexHexes` / `LAYOUT.hexNeighbors` には盤外のヘックスも入るので、
盤の中身を引くときは `vertexHexesOf(board, vid)` / `hexNeighborsOf(board, hid)` を使う。

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
| 交易 | `OFFER_TRADE`(全員へ一斉提案) `RESPOND_TRADE` `CHOOSE_TRADE`(応じた中から相手を決める) |
| 基本のみ | `BUY_DEV_CARD` `PLAY_DEV_CARD` |
| 都市と騎士 | `BUILD_KNIGHT` `ACTIVATE_KNIGHT` `PROMOTE_KNIGHT` `MOVE_KNIGHT` `CHASE_ROBBER` `BUILD_WALL` `BUY_IMPROVEMENT` `PLAY_PROGRESS_CARD` `RAZE_CITY` `PICK_AQUEDUCT` |
| ドラゴンの島 | `BUILD_TOWER` |
| 漁師たち | `SPEND_FISH`(魚を使う) `PASS_SHOE`(古い靴を渡す) |
| 航海者たち | `BUILD_SHIP` `MOVE_SHIP` `PICK_GOLD`(金鉱の資源選択) |

### 割り込み(awaiting 状態機械)

手番の通常フローを中断する処理は `state.awaiting = { type, players, context }` で表現する。
`awaiting` が非 null の間は、`players` に含まれるプレイヤーの該当アクションしか通らない。

| type | 発生元 | 解決アクション |
|---|---|---|
| `setupPlacement` | 初期配置(スネーク順) | `PLACE_INITIAL` |
| `discard` | 7ロール / 破壊工作員(`context.cause` で区別) | `DISCARD` |
| `moveRobber` | 7ロール / 騎士追い払い | `MOVE_ROBBER` |
| `barbarianDefense` | 蛮族侵攻で敗北した都市所有者 | `RAZE_CITY` |
| `tradeOffer` | 交易の一斉提案(提案者以外の全員が待ち) | `RESPOND_TRADE` |
| `tradeChoose` | 一斉提案に2人以上が応じた(提案者が待ち) | `CHOOSE_TRADE` |
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
  board,                   // hexIds・hexes(terrain/token)・robber・ports
                           //  + fisheries/lake(漁師たち)
                           //  + pirate/islandOf(航海者たち)
  buildings, roads,        // vertexId/edgeId -> { player, ... }
  ships,                   // edgeId -> { player, builtTurn }(航海者たち)
  players: [{ resources, devCards, commodities, improvements,
              progressCards, progressVP, defenderPoints, treasures, fish, islands, ... }],
  bank,                    // resources 各19・devDeck・commodities 各12・progressDecks・fishPool
  dice, eventDie,          // eventDie は cak のみ('ship' | 各進歩デッキ)
  diceMode, diceDeck,      // 'random'(毎回独立。既定) | 'balanced'(36通りの山札から引く)
  diceCounts,              // 出目(2〜12)が何回出たか。📊の棒グラフに使う
  turnFlags,               // rolled / playedDev / fleet / offers / alchemist ...
  longestRoad, largestArmy,
  knights, walls, merchant, barbarians, metropolis,   // 都市と騎士
  dragon, towers, burned,                             // ドラゴンの島
  // 漁師たち: 魚は players[].fish(公開)と bank.fishPool のみ。専用のトップレベル状態はない
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
│   ├── board.js      # LAYOUT(hex/vertex/edge の隣接表)・盤の形の導出・盤面生成・PIPS
│   ├── build.js      # 建設コスト・配置判定・手札上限
│   ├── dice.js       # 資源分配(distributeForRoll)
│   ├── robber.js     # 略奪対象・ランダムスチール
│   ├── trade.js      # tradeRate(港・商船隊・商人・商業Lv3)
│   ├── victory.js    # computePoints / pointsToWin / 最長交易路
│   ├── cak/          # barbarians / knights / improvements / progress-cards(54枚)
│   ├── dragon.js     # 暴走・炎上・見張り塔・財宝
│   ├── fish.js       # 漁師たち: 魚トークンの山・獲得・支払い・古い靴
│   └── sea.js        # 航海者たち: マップ生成・船・海賊・金鉱・島の判定
├── ai/
│   ├── cpu-player.js  # chooseAction(全ての判断の入口)
│   ├── evaluator.js   # 盤面評価・evalNoise(難易度)
│   ├── legal-moves.js # 合法手列挙
│   └── progress-ai.js # 進歩カード別スコアラー(SCORERS)
├── render/
│   ├── board-render.js  # 2D Canvas(オフスクリーンキャッシュ)
│   ├── hud-render.js    # DOM HUD・全ダイアログ・ステータス文
│   └── rules-content.js # あそびかた(タブ構成、カード説明は定義から自動生成)
├── demo/
│   ├── scenario.js      # デモ用の盤面づくり(初期配置の消化・資源配布・出目の仕込み)
│   ├── script.js        # あそびかたデモの台本(章とビート)
│   └── driver.js        # 再生エンジン(字幕・指カーソル・一時停止/速度)。ブラウザ専用
├── render3d/board3d.js  # Three.js レンダラー
├── net/client.js        # オンライン対戦のクライアント(WebSocket・再接続)
└── audio/bgm.js         # ジェネレーティブBGM(Web Audio)

server/                  # オンライン対戦サーバー(Cloudflare Workers)
├── room-core.js         # 部屋のロジック(トランスポート非依存 = テスト可能)
├── room-do.js           # Durable Object(WebSocket ↔ RoomCore)
└── index.js             # Worker(合言葉の発行と振り分け)
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
- プレイヤー間交易: 誰であれ `OFFER_TRADE` で**全員に一斉提案**し、返事が揃ってから相手を決める。
  CPU は誰が何を持っているかを見ずに提案し(人間の手札を覗かないため)、
  空振りは「1手番1回・1巡あけ(全員に断られたら2巡)」の自制で抑える。

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
- **海**: カスタム ShaderMaterial。盤のヘックス中心への最短距離で深度グラデーション、
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
- **手番の合図**(`maybeTurnFx`): 手番が移るたびに「誰の番か」を出す。
  他人は上寄せの小さいピル、自分だけ中央に大きく + 色帯。
  一瞬で消えるので、自分の番のあいだは `body.myturn` で
  盤面のフチと自分のプレイヤーチップを光らせ続ける。
  `refresh()` から呼ばれ、**手番の鍵**(setup は配置順、main は `turn`+`currentPlayer`)が
  変わったときだけ出すので、割り込みや再描画では鳴らない ──
  ローカル戦・CPU・オンラインのどれでも同じ経路で動く。

## オンライン対戦(`server/`)

合言葉(英字4文字)を共有した最大4人で遊ぶ。**サーバー権威型**で、
クライアントはルール判定も乱数も持たない。

```
ブラウザ ──action──▶ Worker ──▶ Durable Object(合言葉ごとに1つ)
   ▲                              │ RoomCore が dispatch() で適用
   └──── 席ごとに伏せた state ─────┘
```

### なぜサーバーでも同じエンジンが動くのか

`src/rules/` と `src/actions.js` は DOM 非依存の純粋関数なので、
Durable Object がそのまま `import` して使える。**ルール実装は 1 つだけ**で、
クライアントとサーバーで 実装の食い違いが起きない。

| ファイル | 役割 |
|---|---|
| `server/room-core.js` | 部屋のロジック(席・ホスト・開始・アクション適用・伏せ処理・肩代わり)。**WebSocket に非依存**なので `node --test` で直接検証できる |
| `server/room-do.js` | Durable Object。WebSocket 接続を RoomCore に繋ぎ、誰に何を送るかを決める |
| `server/index.js` | Worker。`/new` で合言葉を発行し、`/room?code=` を DO へ振り分ける |
| `src/net/client.js` | ブラウザ側。接続・再接続・端末IDの保持 |

### メッセージ

| 向き | 種類 | 内容 |
|---|---|---|
| C→S | `hello` | 端末IDと名前。席の割り当て(再接続なら元の席) |
| C→S | `settings` / `start` | ホストのみ。ルール・空席のCPU補完・開始 |
| C→S | `action` | 自分の席の手。`player` が自席と違えば拒否 |
| C→S | `ping` | 接続維持(25秒ごと) |
| S→C | `joined` / `lobby` | 席番号、参加者一覧、ホスト、設定 |
| S→C | `state` | 版番号 + **その席から見た**状態 + 直前に適用されたアクション(演出の再生用) |
| S→C | `error` | 却下理由。食い違い防止に正しい状態を送り直す |

状態は 11KB 程度しかないので、差分同期はせず**毎手ごとに全状態を配る**。
取りこぼしても次の手で必ず追いつく。

### 隠し情報

`viewFor(seat)` が席ごとに伏せた状態を作る。描画側は相手の手札を枚数でしか
読まないため、中身を差し替えても表示は壊れない。

- 他プレイヤーの `devCards` / `progressCards` → 同じ枚数の `hidden` に置換
- `bank.devDeck` / `progressDecks` → 中身を `null` に(枚数は購入可否の判定に必要)
- `state.rng` → `0`(未来の出目を予測させない)
- `state.diceDeck` → 中身を `null` に(**残り枚数は公開情報**なので長さは保つ)
- **決着後は全公開**(隠し勝利点を含む最終得点を正しく出すため)

### 放置された部屋の自動切断

Durable Object は WebSocket が繋がっている間ずっとメモリに常駐し、その時間が
そのまま無料枠(13,000 GB-s/日)を消費する。開いたまま放置されたタブが
枠を食い潰さないよう、**1時間操作がなければサーバーから切断する**。

- 「操作」に数えるのは**人の意思がある行為だけ**(参加・設定変更・開始・手を出す)。
  接続維持の ping と CPU の自動進行は数えない ── これを数えると放置が永久に延命される
- 切断時は `fatal: true` を付けて通知する。クライアントは自動再接続せず、
  理由を表示して合言葉の画面に戻る(すぐ入り直せる)
- 誰も繋がっていない部屋では CPU の自動進行も止める(無人の対局で常駐しない)
- 上限は `IDLE_DISCONNECT_MS` 環境変数で上書きできる(E2E で短縮するため)

### 切断と再接続

端末IDを localStorage に持ち、同じIDで戻れば元の席に復帰する。
切断中の席はサーバーが CPU として肩代わりして進めるので、
誰かが落ちてもゲームは止まらない。ホストが抜けたら次の接続者がホストになる。
対戦中の部屋には新しい人は入れない。

### 権限の境界

- 席の手は**自分の席のものしか出せない**(`action.player !== seat` は拒否)
- ルール判定は `validateAction` がサーバーで必ず走る(クライアントの検証は往復を減らす早期リターンにすぎない)
- ルール・難易度・開始はホストのみ

## BGM(`audio/bgm.js`)

音源ファイルなしの完全合成。D ドリアンのコード進行を先読みスケジューラで生成し、
ドローン+パッド+撥弦+フルートを合成リバーブ(生成した IR で convolution)に通す。
iOS 対策で初回ポインタイベントから開始。ON/OFF は localStorage に保存。

## あそびかたデモ(`src/demo/`)

「文章だと操作感が分からない」を埋めるための**自動再生デモ**。動画ファイルは持たず、
本物のゲームエンジンと本物の HUD をその場で動かして見せる(だから実装と絶対にずれない)。

```
台本(script.js) ── ビートの配列
   ↓ 1ビート = prep → 字幕 → 指でタップ → ui/action
再生エンジン(driver.js) ── host 経由でしか main.js に触らない
   ↓ host.patchState / setUi / act / boardPos
main.js ── 通常の refresh・dispatch・演出がそのまま動く
```

- **章**: `setup`(はじめの配置)→ `basic`(基本の手番)→ `cak`(都市と騎士)。
  タイトルと説明書の各タブから開き、終わりに次の章へ送る。
  `setup` だけは `fromSetup: true` で初期配置の1手目から始め、CPU の配置も台本が1手ずつ進める
  (再生中は CPU の自動進行を止めているため)。
- **盤面依存の場所は台本に焼き込まない**。「どの辺に道を引くか」は毎回 `legalRoadEdges`
  などから選び直すので、盤面生成やルールが変わっても座標がずれない。
- **ルールエンジンには手を入れない**。出目の固定は既存の `turnFlags.alchemist`、
  イベントダイスは目的の面が出るまで `state.rng` を空回しして合わせる。
  発展カードを見せたいときは `stackDevDeck` で山札を**並べ替える**だけ(枚数構成は本物のまま)。
- **資源の配布は必ず銀行から**(`ensure` / `trimHand`)。保存則を壊さない。
- **HUD を変えたら台本も見直す**。台本は実物のボタン(`data-act`)とダイアログを指しているので、
  ボタンの追加・改名や新しいダイアログはそのまま「古い動画」になる。
- 再生中は `demoRunning` で CPU スケジューラを止め、全面シールドで人の入力も遮る。
- `test/demo.test.js` が台本をブラウザ抜きで空回しし、
  **全ビートの手が validate を通ること**と保存則を検証する。

## テスト戦略

| 層 | 手段 |
|---|---|
| ルール単体 | `node --test test/`(145+ テスト)。validate の拒否理由・apply の結果・保存則 |
| 回帰 | `test/board-regression.test.js`。モード×シードごとに盤面と対戦の全展開をハッシュで固定。
盤面まわり(LAYOUT・生成・合法手の列挙順)を触って既存モードが変わったら落ちる |
| 統計 | `test/rng.test.js` + `scripts/dice-audit.mjs`(χ² バッテリー。対の検定は**非重複**ペアで) |
| 結合 | セルフプレイ: CPU のみで数百ゲーム完走・無限ループ検出・資源/商品の保存則・勝者の点数検証 |
| オンライン | `test/room.test.js` で部屋のロジック(席・ホスト・伏せ処理・肩代わり・復元)を検証。
実サーバーは `wrangler dev` + WebSocket / ブラウザ2つで確認 |
| E2E | Playwright(headless Chromium + SwiftShader)。`window.catanDebug` で state を直接操作して
UI フローを検証(手順は [CLAUDE.md](../CLAUDE.md)) |

**保存則**は最重要の不変条件: どの時点でも 銀行+全員の手札 = 資源 19×5・商品 12×3。

## デバッグフック

- `window.catanDebug`: `getState` / `setState`(差し替え+再描画+CPU再開)/ `doAction` /
  `newGameWith(patch)` / `getUi` / `screenPos(kind, id)`(3D→画面座標)/ `getRenderer` /
  `getBgm` / `getViewState` / `startDemo(id)` / `getDemo` / `demoSkip` / `demoStop`
- URL `?seed=123`: シード固定
- `renderer.skyPhaseOverride = 0..1`: 昼夜サイクルの時刻固定(影・照明の目視確認用)
- `turnFlags.alchemist = [a, b]`: 次ロールの出目固定(テストで暴走や7を意図的に起こす)
