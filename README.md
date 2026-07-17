# catan-web — 3Dで遊ぶカタン(都市と騎士 + オリジナル拡張)

Vanilla JavaScript + Three.js で作った、ブラウザで動くカタン。
プレイヤー1人 vs CPU 2〜3体。ビルド工程なし・依存はベンダリング済みの Three.js のみ。

**▶ 遊ぶ:** https://junia2009.github.io/catan_city_knight/ (スマホ推奨・PWA対応)

## 遊べるルール(3種類)

| モード | 勝利点 | 概要 |
|---|---|---|
| 基本 | 10点 | 標準カタン(発展カード・港・最長交易路・最大騎士力) |
| 都市と騎士 | 13点 | 商品・騎士・蛮族・都市改良・**進歩カード全54枚** |
| 🐉 ドラゴンの島 | 12点 | **本作オリジナル**。ゾロ目でドラゴンが暴走し、見張り塔で撃退して財宝を集める |

ルールの詳細と公式からの簡略化は [docs/RULES.md](docs/RULES.md)、
アプリ内でも「📖 あそびかた」からいつでも読める。

## 特徴

- **3D盤面**(Three.js): シェーダー製の海(浅瀬・波・岸辺の泡)と空(昼夜サイクル・
  太陽・星空)、起伏のある地形、羽ばたくドラゴン、蛮族船の航路、転がるダイス。
  2D表示にも切替可(こちらもダイス演出付き)
- **スマホファーストUI**: 縦持ち全画面、ボトムシート、2段階タップ操作、
  セーフエリア対応。PWAとしてホーム画面に追加可能
  (Service Worker はネットワーク優先 = 常に最新版)
- **プレイヤー間交易**: 自分から提案でき、CPUからも提案が届く。
  CPUは損得を評価して応じる
- **CPU難易度3段階**(弱い/普通/強い): 評価関数への決定的ノイズで実現
- **中世風BGM**: Web Audio による完全合成のジェネレーティブ音楽(音源ファイルなし)
- **決定性**: 全ての乱数はシード制御。同じシードは同じゲーム
  (URLに `?seed=123` でも指定可)

## ローカルで動かす

ES Modules を使っているため、ローカルサーバー経由で開く:

```sh
npm run serve   # または python3 -m http.server 8000
# → http://localhost:8000/ を開く
```

## 開発

```sh
npm test                     # 単体テスト + セルフプレイ検証(Node のみ、ブラウザ不要)
npm run selfplay             # CPU 4体の自動対戦ゲート(node scripts/selfplay.js 1000 等)
node scripts/dice-audit.mjs  # ダイス乱数の統計監査(χ²検定バッテリー)
```

- 設計の全体像・状態機械・AI・レンダラー構成は [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)
- 作業手順・検証フロー・デバッグフックは [CLAUDE.md](CLAUDE.md)
- `main` に push すると GitHub Actions がテストを通してから GitHub Pages にデプロイする
  (`.github/workflows/pages.yml`)

## プロジェクト構成

```
index.html              # 単一ページ(CSS込み)。importmap で three をベンダー読込
sw.js                   # Service Worker(ネットワーク優先)
src/
├── main.js             # 起動・画面フロー・入力モード・CPU駆動・演出
├── state.js            # GameState 定義(JSON化可能な単一オブジェクト)
├── actions.js          # 全アクションの validate / apply(dispatch の一本道)
├── rng.js              # シード制御の疑似乱数(mulberry32系)
├── rules/              # ルールエンジン(純粋関数、canvas 非依存)
│   ├── board.js  build.js  dice.js  robber.js  trade.js  victory.js
│   ├── cak/            # 都市と騎士(騎士・蛮族・都市改良・進歩カード54枚)
│   └── dragon.js       # ドラゴンの島(暴走・炎上・見張り塔・財宝)
├── ai/                 # CPU(合法手列挙・評価関数・思考・カード別プラグイン)
├── render/             # 2D Canvas 描画 + DOM HUD + あそびかた
├── render3d/board3d.js # Three.js レンダラー(海・空・地形・コマ・演出)
└── audio/bgm.js        # ジェネレーティブBGM(Web Audio)
test/                   # node --test(85テスト: ルール・統計・セルフプレイ)
scripts/                # セルフプレイゲート・乱数監査
vendor/                 # Three.js(MIT)
```

## 開発の歩み

| フェーズ | 内容 | 検証 |
|---|---|---|
| Phase 1 | 基本カタン + 貪欲法CPU | セルフプレイ1000ゲーム |
| Phase 2 | 都市と騎士の盤面要素(商品・騎士・蛮族・都市改良) | セルフプレイ300ゲーム |
| Phase 3 | 進歩カード全54枚 + カード別CPU判断 + 難易度 | セルフプレイ300ゲーム |
| 独自拡張 | 🐉 ドラゴンの島 / プレイヤー間交易 / BGM / 海・空・島の描画強化 | 各機能ごとにE2E+セルフプレイ |

## スコープ外

オンライン対戦 / 「航海者」等の他公式拡張 / クラウド同期
