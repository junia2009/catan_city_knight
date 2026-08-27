// あそびかたデモの台本。
//
// 1ビート = 字幕1つ + 任意の操作。実行順は prep → 字幕 → 指でタップ → ui/action。
//   say    : 字幕(文字列 または (state, ui) => 文字列)
//   prep   : 操作の前に盤面を整える(資源を配る・出目を仕込む など)
//   tap    : 指を出す位置 { btn } | { sel } | { vertex } | { edge } | { hex }
//   ui     : タップの結果としての UI 状態(main.js の click ハンドラと同じ形に揃える)
//   action : 実際に dispatch する手
//   hold   : 字幕の表示時間の上乗せ(ms)
//
// 盤面依存の場所(どの辺・どの頂点)は毎回 state から選び直す。
// 座標を台本に焼き込まないので、盤面生成が変わっても壊れない。

import { LAYOUT, TERRAIN_RESOURCE } from '../rules/board.js';
import { validateAction } from '../actions.js';
import { canPlaceSettlement, piecesLeft, totalCards } from '../rules/build.js';
import { tradeRate } from '../rules/trade.js';
import { stealableTargets } from '../rules/robber.js';
import { chooseAction } from '../ai/cpu-player.js';
import {
  legalCityVertices, legalRoadEdges, legalRobberHexes, legalSettlementVertices,
  legalSetupEdges,
} from '../ai/legal-moves.js';
import {
  DEMO_PLAYER as P, bestRollFor, cutToTurn, ensure, forceRoll,
  pickBest, pipsOf, seedDiceLog, stackDevDeck, trimHand, vertexValue,
} from './scenario.js';

// ---- 盤面から「見せ場」を選ぶ ----

// 辺の「伸ばし甲斐」: その先に開拓地を建てられる良い土地があるか
function roadScore(state, eid) {
  let best = -1;
  for (const vid of LAYOUT.edges[eid].v) {
    if (canPlaceSettlement(state, P, vid, { needRoad: false }) !== null) continue;
    best = Math.max(best, vertexValue(state, vid));
  }
  return best;
}

// 先に開拓地を建てられる場所へ伸びる道を選ぶ
const pickRoad = (state) => pickBest(legalRoadEdges(state, P), (eid) => roadScore(state, eid));

// 街道建設カードの2本目(1本目を建てたことにして選び直す)
const pickNextRoad = (state, first) =>
  pickBest(
    legalRoadEdges(state, P, { extraRoads: { [first]: true } }),
    (eid) => roadScore(state, eid),
  );

const pickSettlement = (state) =>
  pickBest(legalSettlementVertices(state, P), (vid) => vertexValue(state, vid));

const pickCity = (state) =>
  pickBest(legalCityVertices(state, P), (vid) => vertexValue(state, vid));

const pickKnightSpot = (state) =>
  pickBest(
    Object.keys(LAYOUT.vertices).filter(
      (vid) => validateAction(state, { type: 'BUILD_KNIGHT', player: P, vertexId: vid }) === null,
    ),
    (vid) => vertexValue(state, vid),
  );

const pickWall = (state) =>
  pickBest(
    Object.keys(state.buildings).filter(
      (vid) => validateAction(state, { type: 'BUILD_WALL', player: P, vertexId: vid }) === null,
    ),
    (vid) => vertexValue(state, vid),
  );

const myKnight = (state) =>
  Object.keys(state.knights).find((vid) => state.knights[vid].player === P) ?? null;

// 自分の土地を避けつつ、奪える相手がいる出目の良いヘックス
function pickRobberHex(state) {
  return pickBest(legalRobberHexes(state), (hid) => {
    const corners = LAYOUT.hexVertices[hid] ?? [];
    if (corners.some((vid) => state.buildings[vid]?.player === P)) return -1;
    const targets = stealableTargets(state, hid, P).length;
    return targets ? 100 * targets + pipsOf(state, hid) : 0;
  });
}

// プレイヤー間交易のデモの中身。渡すもの・もらうものを固定して、
// 字幕と画面のチップが必ず一致するようにする(prep で全員の手札を用意する)。
// 複数が応じる状況を作り、「相手を選ぶ」ところまで見せる。
const PT = { give: 'wood', giveN: 2, receive: 'ore', receiveN: 1 };

// 銀行と2:1〜4:1で交換できるだけの資源を持たせ、その資源と交換先を決める
function bankTradePlan(state) {
  const give = pickBest(['wood', 'brick', 'sheep', 'wheat', 'ore'], (r) => -tradeRate(state, P, r));
  const receive = give === 'ore' ? 'wheat' : 'ore';
  return { give, receive, rate: tradeRate(state, P, give) };
}

// ---- 初期配置(setup)用の選び方 ----

// その頂点で新しく手に入る資源の種類(すでに持っている土地との重なりを避けるため)
function newResourcesAt(state, vid) {
  const mine = new Set();
  for (const [v, b] of Object.entries(state.buildings)) {
    if (b.player !== P) continue;
    for (const hid of LAYOUT.vertexHexes[v] ?? []) {
      const res = TERRAIN_RESOURCE[state.board.hexes[hid].terrain];
      if (res) mine.add(res);
    }
  }
  const gained = new Set();
  for (const hid of LAYOUT.vertexHexes[vid] ?? []) {
    const res = TERRAIN_RESOURCE[state.board.hexes[hid].terrain];
    if (res && !mine.has(res)) gained.add(res);
  }
  return gained.size;
}

// 初期配置の開拓地: 出目の良さ + まだ持っていない資源が取れることを加点
const pickSetupVertex = (state) =>
  pickBest(
    legalSettlementVertices(state, P, { needRoad: false }),
    (vid) => vertexValue(state, vid) + 2 * newResourcesAt(state, vid),
  );

// 初期配置の道: 伸ばした先に良い土地がある向きへ
const pickSetupEdge = (state, vid) =>
  pickBest(legalSetupEdges(state, vid), (eid) => {
    const far = LAYOUT.edges[eid].v.find((v) => v !== vid);
    return far ? vertexValue(state, far) : 0;
  });

// いま置く番のプレイヤー(初期配置は awaiting が順番を持っている)
const setupTurnOf = (state) => state.awaiting?.players[0] ?? null;

// CPU の初期配置を1手進める
const cpuSetupMove = (state) => {
  const pid = setupTurnOf(state);
  return pid == null || pid === P ? null : chooseAction(state, pid);
};

// 7の演出の前に、全員の手札を捨て札ラインの下へ戻す(捨て札ダイアログで話が止まらないように)
function tidyHandsForSeven(state) {
  for (const p of state.players) {
    trimHand(state, p.id, 7);
    if (p.id !== P && totalCards(p) === 0) ensure(state, p.id, { wood: 1 });
  }
}

// ---- 第1章: はじめの配置 ----

const setupBeats = [
  {
    say: 'ゲームは「初期配置」から始まります。全員が順番に、開拓地1つと道1本ずつを2回に分けて置きます。',
    hold: 900,
  },
  {
    say: '🏠 まずはあなたの番。置ける頂点が光ります ── ほかの建物から2つ以上離す決まりがあるので、光った場所だけが候補です。',
    hold: 2000,
  },
  {
    say: '数字の下の点が多いほど出やすい目(6と8が最大)。土地3つに接していて、資源の種類が散っている角が有利です。',
    tap: (s) => ({ vertex: pickSetupVertex(s) }),
    ui: (s) => ({ pendingVertex: pickSetupVertex(s), mode: 'setup-road' }),
    hold: 1600,
  },
  {
    say: '続けて、その開拓地につながる道を1本。あとで開拓地を増やしたい方向へ伸ばします。',
    tap: (s, ui) => ({ edge: pickSetupEdge(s, ui.pendingVertex) }),
    ui: (s, ui) => ({ pending: { edgeId: pickSetupEdge(s, ui.pendingVertex) } }),
    hold: 1200,
  },
  {
    say: '「✓ 確定」で決定。',
    tap: () => ({ btn: 'confirm' }),
    action: (s, ui) => ({
      type: 'PLACE_INITIAL', player: P,
      vertexId: ui.pendingVertex, edgeId: ui.pending?.edgeId,
    }),
    hold: 900,
  },
  {
    say: '次の人へ。ほかのプレイヤーも同じように置いていきます。',
    action: (s) => cpuSetupMove(s),
    hold: 1000,
  },
  {
    say: '置く順番は 1→2→3 と回り、そこで折り返して 3→2→1。最後の人は2つ続けて置けます。',
    action: (s) => cpuSetupMove(s),
    hold: 1600,
  },
  {
    say: '2巡目に入りました。ここから逆回りです。',
    action: (s) => cpuSetupMove(s),
    hold: 1000,
  },
  {
    say: '空いている良い場所は、どんどん取られていきます。',
    action: (s) => cpuSetupMove(s),
    hold: 1000,
  },
  {
    say: '🏠 最後にもう一度あなたの番。1軒目とは違う資源が取れる場所を選ぶと、序盤が回りやすくなります。',
    hold: 2000,
  },
  {
    say: '同じように、開拓地 → 道 の順に選びます。',
    tap: (s) => ({ vertex: pickSetupVertex(s) }),
    ui: (s) => ({ pendingVertex: pickSetupVertex(s), mode: 'setup-road' }),
    hold: 1000,
  },
  {
    say: '道も、光った辺をタップするだけ。',
    tap: (s, ui) => ({ edge: pickSetupEdge(s, ui.pendingVertex) }),
    ui: (s, ui) => ({ pending: { edgeId: pickSetupEdge(s, ui.pendingVertex) } }),
    hold: 700,
  },
  {
    say: '確定。2巡目に置いた開拓地に接する土地からは、その場で資源がもらえます。',
    tap: () => ({ btn: 'confirm' }),
    action: (s, ui) => ({
      type: 'PLACE_INITIAL', player: P,
      vertexId: ui.pendingVertex, edgeId: ui.pending?.edgeId,
    }),
    hold: 2000,
  },
  {
    say: (s) => {
      const n = totalCards(s.players[P]);
      return `手札に${n}枚入りました。これで準備完了 ── ここからダイスを振る手番が始まります。`;
    },
    hold: 1800,
  },
];

// ---- 第2章: 基本の手番 ----

const basicBeats = [
  {
    say: 'あなたの手番でできることを、実際の画面で一通り見ていきます。',
    hold: 500,
  },
  {
    say: '🎲 手番はダイスから。2個の合計の数字が書かれた土地に接している建物が、資源を生みます。',
    prep: (s) => forceRoll(s, bestRollFor(s, P)),
    tap: () => ({ btn: 'roll' }),
    action: () => ({ type: 'ROLL_DICE', player: P }),
    hold: 1600,
  },
  {
    say: '開拓地は1枚、都市なら2枚。もらった資源は下の手札に増えます。',
    hold: 600,
  },
  {
    say: '🛤 道は 🪵1 🧱1。まず「道」ボタンを押します。',
    prep: (s) => ensure(s, P, { wood: 1, brick: 1 }),
    tap: () => ({ btn: 'mode:road' }),
    ui: () => ({ mode: 'build-road' }),
    hold: 900,
  },
  {
    say: '建てられる場所が光ります。そのひとつをタップ。',
    tap: (s) => ({ edge: pickRoad(s) }),
    ui: (s) => ({ pending: { edgeId: pickRoad(s) } }),
    hold: 700,
  },
  {
    say: '「✓ 確定」で建設。置き直したいときは「↩ やり直す」。',
    tap: () => ({ btn: 'confirm' }),
    action: (s, ui) => ({ type: 'BUILD_ROAD', player: P, edgeId: ui.pending?.edgeId }),
    hold: 900,
  },
  {
    say: '🏠 開拓地は 🪵1 🧱1 🐑1 🌾1。自分の道の先で、ほかの建物から2つ以上離れた頂点に建てられます。',
    prep: (s) => ensure(s, P, { wood: 1, brick: 1, sheep: 1, wheat: 1 }),
    tap: () => ({ btn: 'mode:settlement' }),
    ui: () => ({ mode: 'build-settlement' }),
    hold: 1200,
  },
  {
    say: '条件を満たす頂点だけが光るので、迷いません。',
    tap: (s) => ({ vertex: pickSettlement(s) }),
    ui: (s) => ({ pending: { vertexId: pickSettlement(s) } }),
    hold: 500,
  },
  {
    say: '開拓地は1点。ここも資源を生むようになります。',
    tap: () => ({ btn: 'confirm' }),
    action: (s, ui) => ({ type: 'BUILD_SETTLEMENT', player: P, vertexId: ui.pending?.vertexId }),
    hold: 900,
  },
  {
    say: '🏰 都市は 🌾2 🪨3 で開拓地を昇格させます。産出が2倍になり、点も1→2点に。',
    prep: (s) => ensure(s, P, { wheat: 2, ore: 3 }),
    tap: () => ({ btn: 'mode:city' }),
    ui: () => ({ mode: 'build-city' }),
    hold: 1200,
  },
  {
    say: '昇格させる自分の開拓地を選んで、確定。',
    tap: (s) => ({ vertex: pickCity(s) }),
    ui: (s) => ({ pending: { vertexId: pickCity(s) } }),
    hold: 500,
  },
  {
    say: '都市になると、この土地から資源が2枚ずつ入るようになります。',
    tap: () => ({ btn: 'confirm' }),
    action: (s, ui) => ({ type: 'BUILD_CITY', player: P, vertexId: ui.pending?.vertexId }),
    hold: 700,
  },
  {
    say: (s) => `📦 コマは1人ぶんしかありません(道15本・開拓地5軒・都市4つ)。ボタンの右上の数字が残りで、いまは 道${
      piecesLeft(s, P, 'road')}・開拓地${piecesLeft(s, P, 'settlement')}・都市${
      piecesLeft(s, P, 'city')} ── 資源があってもコマが尽きたら建てられません。`,
    tap: () => ({ btn: 'mode:settlement' }),
    hold: 2000,
  },
  {
    say: '開拓地を都市に昇格させると、開拓地のコマが1つ手元に戻ります。どこを都市にするかは、コマのやりくりでもあります。',
    hold: 1600,
  },
  {
    say: '⚖️ 資源が偏ったら交易。「交易」から銀行と交換できます。',
    prep: (s) => {
      const { give, rate } = bankTradePlan(s);
      ensure(s, P, { [give]: rate });
    },
    tap: () => ({ btn: 'trade-open' }),
    ui: () => ({ dialog: { type: 'trade', tab: 'bank', give: null, receive: null, pgive: {}, precv: {} } }),
    hold: 900,
  },
  {
    say: (s) => `渡すものを選びます。基本は4:1、港を持っていると3:1や2:1になります(いまは${bankTradePlan(s).rate}:1)。`,
    tap: (s) => ({ sel: `[data-act="trade-give:${bankTradePlan(s).give}"]` }),
    ui: (s, ui) => ({ dialog: { ...ui.dialog, give: bankTradePlan(s).give } }),
    hold: 1000,
  },
  {
    say: 'もらうものを選んで「交易する」。',
    tap: (s) => ({ sel: `[data-act="trade-receive:${bankTradePlan(s).receive}"]` }),
    ui: (s, ui) => ({ dialog: { ...ui.dialog, receive: bankTradePlan(s).receive } }),
    hold: 500,
  },
  {
    say: '銀行との交換はこれで完了です。',
    tap: () => ({ sel: '[data-act="trade-confirm"]' }),
    action: (s, ui) => ({
      type: 'TRADE_BANK', player: P, give: ui.dialog?.give, receive: ui.dialog?.receive,
    }),
    hold: 900,
  },
  {
    say: '🤝 相手と直接やりとりもできます。もう一度「交易」を開いて、「プレイヤー」タブへ。',
    prep: (s) => {
      ensure(s, P, { [PT.give]: PT.giveN });
      // 全員に持たせて、2人とも応じる(=相手を選ぶ)状況を作る
      for (const o of s.players) {
        if (o.id !== P) ensure(s, o.id, { [PT.receive]: PT.receiveN });
      }
    },
    tap: () => ({ btn: 'trade-open' }),
    ui: () => ({ dialog: { type: 'trade', tab: 'bank', give: null, receive: null, pgive: {}, precv: {} } }),
    hold: 900,
  },
  {
    say: 'タブを切り替えると、渡すもの・もらうものを枚数で組み立てられます。',
    tap: () => ({ sel: '[data-act="trade-tab:players"]' }),
    ui: (s, ui) => ({ dialog: { ...ui.dialog, tab: 'players' } }),
    hold: 1200,
  },
  {
    say: `渡すものをタップして追加。ここでは🪵木材を${PT.giveN}枚。`,
    tap: () => ({ sel: `[data-act="ptg-add:${PT.give}"]` }),
    ui: (s, ui) => ({ dialog: { ...ui.dialog, pgive: { [PT.give]: PT.giveN } } }),
    hold: 1100,
  },
  {
    say: `もらうものも同じように。🪨鉱石を${PT.receiveN}枚もらう提案にします。`,
    tap: () => ({ sel: `[data-act="ptr-add:${PT.receive}"]` }),
    ui: (s, ui) => ({ dialog: { ...ui.dialog, precv: { [PT.receive]: PT.receiveN } } }),
    hold: 1100,
  },
  {
    say: '「🤝 全員に提案」で、同じ内容を一度に全員へ持ちかけます(1手番3回まで)。',
    tap: () => ({ sel: '[data-act="pt-offer"]' }),
    action: () => ({
      type: 'OFFER_TRADE', player: P,
      give: { [PT.give]: PT.giveN }, receive: { [PT.receive]: PT.receiveN },
    }),
    hold: 1800,
  },
  {
    say: '相手それぞれの手元に「🤝 交換する / 断る」が出ます。返事が揃うまで待ちます。',
    action: (s) => ({ type: 'RESPOND_TRADE', player: s.awaiting.players[0], accept: true }),
    hold: 1400,
  },
  {
    say: '2人とも応じてくれました。',
    action: (s) => ({ type: 'RESPOND_TRADE', player: s.awaiting.players[0], accept: true }),
    hold: 1200,
  },
  {
    say: '複数が応じたときは、どの相手と成立させるかを自分で選べます。',
    tap: (s) => ({ sel: `[data-act="trade-pick:${s.awaiting.context.accepted[0]}"]` }),
    action: (s) => ({
      type: 'CHOOSE_TRADE', player: P, partner: s.awaiting.context.accepted[0],
    }),
    hold: 1800,
  },
  {
    say: '📜 発展カードは 🐑1 🌾1 🪨1。騎士・街道建設・収穫・独占・勝利点が入っています。',
    prep: (s) => {
      ensure(s, P, { sheep: 1, wheat: 1, ore: 1 });
      stackDevDeck(s, 'roadBuilding'); // 次の章で使うカードを引かせる
    },
    tap: () => ({ btn: 'buy-dev' }),
    action: () => ({ type: 'BUY_DEV_CARD', player: P }),
    hold: 1500,
  },
  {
    say: '引いたのは「街道建設」。カードは買ったターンには使えないので、次の手番までお預けです。',
    hold: 1200,
  },
  {
    say: 'やることが済んだら「⏭ 終了」で次の人へ。',
    tap: () => ({ btn: 'end-turn' }),
    action: () => ({ type: 'END_TURN', player: P }),
    hold: 700,
  },
  {
    say: '── ほかの人の手番を飛ばして、次のあなたの手番へ ──',
    prep: (s) => {
      cutToTurn(s);
      tidyHandsForSeven(s);
      forceRoll(s, [3, 4]);
    },
    hold: 500,
  },
  {
    say: '🎲 合計が「7」のときだけ特別。誰も資源をもらえず、手札が8枚以上の人は半分を捨てます。',
    tap: () => ({ btn: 'roll' }),
    action: () => ({ type: 'ROLL_DICE', player: P }),
    hold: 1800,
  },
  {
    say: '🥷 そして手番の人が盗賊を動かします。移動先のヘックスをタップ。',
    tap: (s) => ({ hex: pickRobberHex(s) }),
    ui: (s) => {
      const hexId = pickRobberHex(s);
      const targets = stealableTargets(s, hexId, P);
      return targets.length
        ? { pending: null, dialog: { type: 'steal', hexId, targets } }
        : { pending: { hexId } };
    },
    hold: 1200,
  },
  {
    say: '置いたヘックスに接している相手から、資源を1枚いただきます。盗賊のいる土地は資源を生みません。',
    tap: (s, ui) => (ui.dialog?.type === 'steal'
      ? { sel: `[data-act="steal:${ui.dialog.targets[0]}"]` }
      : { btn: 'confirm' }),
    action: (s, ui) => (ui.dialog?.type === 'steal'
      ? {
          type: 'MOVE_ROBBER', player: P,
          hexId: ui.dialog.hexId, targetPlayer: ui.dialog.targets[0],
        }
      : { type: 'MOVE_ROBBER', player: P, hexId: ui.pending?.hexId, targetPlayer: null }),
    hold: 1500,
  },
  {
    say: '📜 発展カードは手札のカードをタップ。効果と「✨ 使う」が出ます。',
    tap: () => ({ sel: '[data-act="dev-info:0"]' }),
    ui: () => ({ dialog: { type: 'dev-info', index: 0 } }),
    hold: 1600,
  },
  {
    say: '「街道建設」は道を2本ぶん無料で建てられるカード。使うと、建てられる辺が光ります。',
    tap: () => ({ sel: '[data-act="dev-use:0"]' }),
    ui: () => ({ dialog: null, mode: 'play-road-building', pendingEdges: [], pending: null }),
    hold: 1400,
  },
  {
    say: 'どこへ伸ばすかは自分で選べます。まず1本目。',
    tap: (s) => ({ edge: pickRoad(s) }),
    ui: (s) => ({ pendingEdges: [pickRoad(s)] }),
    hold: 900,
  },
  {
    say: '続けて2本目。1本目の先へつなげることもできます。',
    tap: (s, ui) => ({ edge: pickNextRoad(s, ui.pendingEdges[0]) }),
    ui: (s, ui) => ({
      pendingEdges: [...ui.pendingEdges, pickNextRoad(s, ui.pendingEdges[0])],
    }),
    hold: 1000,
  },
  {
    say: '「✓ 確定」でまとめて建設。資源は使いません。',
    tap: () => ({ btn: 'confirm' }),
    action: (s, ui) => ({
      type: 'PLAY_DEV_CARD', player: P, card: 'roadBuilding',
      params: { edges: [...ui.pendingEdges] },
    }),
    hold: 1400,
  },
  {
    say: '📊 ダイスの横の記録ボタンで、2〜12がそれぞれ何回出たかを見られます。',
    prep: (s) => seedDiceLog(s),
    tap: () => ({ btn: 'dicelog-open' }),
    ui: () => ({ dialog: { type: 'dicelog' } }),
    hold: 1400,
  },
  {
    say: '6と8が出やすく、2と12は出にくい ── 実際の偏りを見ながら次の一手を考えられます。',
    tap: () => ({ sel: '[data-act="dialog-cancel"]' }),
    ui: () => ({ dialog: null }),
    hold: 1600,
  },
  {
    say: '🛤 つながった自分の道が5本以上で最長なら「最長交易路 +2点」。騎士カード3枚で「最大騎士力 +2点」。',
    hold: 1000,
  },
  {
    say: '🏆 これを繰り返して先に10点(都市と騎士は13点)取れば勝ち。あとは実際に触ってみてください!',
    hold: 1200,
  },
];

// ---- 第3章: 都市と騎士 ----

const cakBeats = [
  {
    say: '「都市と騎士」は、基本ルールに “3つ目のダイス・商品・騎士” が加わった上級ルールです。',
    hold: 800,
  },
  {
    say: '🎲 赤・黄に加えて「イベントダイス」を振ります。初期配置も開拓地1・都市1から始まります。',
    prep: (s) => forceRoll(s, bestRollFor(s, P), 'trade'),
    tap: () => ({ btn: 'roll' }),
    action: () => ({ type: 'ROLL_DICE', player: P }),
    hold: 1800,
  },
  {
    say: '🧵🪙📜 の色の面は「その系統の都市改良が進んでいれば進歩カードがもらえる」合図。⛵船なら蛮族船が前進します。',
    hold: 1000,
  },
  {
    say: '都市は資源に加えて「商品」を産みます(森=📜紙・山=🪙コイン・牧草地=🧵布)。',
    prep: (s) => ensure(s, P, { paper: 3 }),
    hold: 800,
  },
  {
    say: '🏙 商品の使い道が都市改良です。「改良」を開きます。',
    tap: () => ({ btn: 'improve-open' }),
    ui: () => ({ dialog: { type: 'improve' } }),
    hold: 900,
  },
  {
    say: 'Lv n に上げるには商品 n 枚。まず 📜科学 をLv1へ。',
    tap: () => ({ sel: '[data-act="improve-buy:science"]' }),
    action: () => ({ type: 'BUY_IMPROVEMENT', player: P, track: 'science' }),
    hold: 900,
  },
  {
    say: '続けてLv2へ。Lv3で系統ごとの特殊能力(科学なら「水道橋」)、最初にLv4へ届いた人がメトロポリス +2点です。',
    tap: () => ({ sel: '[data-act="improve-buy:science"]' }),
    action: () => ({ type: 'BUY_IMPROVEMENT', player: P, track: 'science' }),
    hold: 1800,
  },
  {
    say: '── 次のあなたの手番へ ──',
    tap: () => ({ sel: '[data-act="dialog-cancel"]' }),
    prep: (s) => {
      cutToTurn(s);
      forceRoll(s, bestRollFor(s, P, { redDie: 1 }), 'science');
    },
    ui: () => ({ dialog: null }),
    hold: 500,
  },
  {
    say: '📜科学の面が出て、赤ダイスの目が「科学Lv+1」以下 ── 進歩カードを1枚もらえます。',
    tap: () => ({ btn: 'roll' }),
    action: () => ({ type: 'ROLL_DICE', player: P }),
    hold: 2000,
  },
  {
    say: '手札に増えた進歩カードをタップすると、効果と「使う」ボタンが出ます。',
    tap: () => ({ sel: '[data-act="play-prog:0"]' }),
    ui: () => ({ dialog: { type: 'prog-info', index: 0 } }),
    hold: 1600,
  },
  {
    say: '進歩カードは獲得したターンには使えません。持てるのは4枚まで。',
    tap: () => ({ sel: '[data-act="dialog-cancel"]' }),
    ui: () => ({ dialog: null }),
    hold: 700,
  },
  {
    say: '⚔️ 騎士は 🐑1 🪨1。自分の道につながる空き頂点に置きます。',
    prep: (s) => ensure(s, P, { sheep: 1, ore: 1 }),
    tap: () => ({ btn: 'mode:knight' }),
    ui: () => ({ mode: 'build-knight' }),
    hold: 1000,
  },
  {
    say: '置ける頂点が光ります。選んで確定。',
    tap: (s) => ({ vertex: pickKnightSpot(s) }),
    ui: (s) => ({ pending: { vertexId: pickKnightSpot(s) } }),
    hold: 500,
  },
  {
    say: '置いたばかりの騎士は「不活性」── まだ働きません。',
    prep: (s) => ensure(s, P, { wheat: 1 }),
    tap: () => ({ btn: 'confirm' }),
    action: (s, ui) => ({ type: 'BUILD_KNIGHT', player: P, vertexId: ui.pending?.vertexId }),
    hold: 1400,
  },
  {
    say: '盤上の自分の騎士をタップすると、行動メニューが開きます。',
    tap: (s) => ({ vertex: myKnight(s) }),
    ui: (s) => ({ dialog: { type: 'knight', vertexId: myKnight(s) } }),
    hold: 1200,
  },
  {
    say: '🌾1 で活性化。活性騎士のレベル合計が、そのまま蛮族への防衛力になります。',
    tap: (s) => ({ sel: `[data-act="knight-activate:${myKnight(s)}"]` }),
    action: (s) => ({ type: 'ACTIVATE_KNIGHT', player: P, vertexId: myKnight(s) }),
    hold: 1600,
  },
  {
    say: '活性騎士は「移動」「格下の敵騎士の追い出し」「隣の盗賊を追い払う」もできます。',
    hold: 900,
  },
  {
    say: '⛵ 蛮族船は船の目が出るたびに1マス前進。上のトラックがもう7マス目の手前です。',
    prep: (s) => {
      cutToTurn(s);
      s.barbarians.position = 6;
      forceRoll(s, bestRollFor(s, P), 'ship');
    },
    hold: 1600,
  },
  {
    say: '⚔️ 襲来! 蛮族の強さ = 盤上の都市の数、防衛力 = 全員の活性騎士のレベル合計です。',
    tap: () => ({ btn: 'roll' }),
    action: () => ({ type: 'ROLL_DICE', player: P }),
    hold: 2200,
  },
  {
    say: (s) => {
      const line = [...s.log].reverse().find((l) => l.includes('蛮族襲来'));
      const m = line?.match(/蛮族(\d+) vs 防衛(\d+)/);
      if (m && Number(m[2]) >= Number(m[1])) {
        return '🛡 防衛成功! 最も貢献した人が「カタンの守護者」+1点。同点なら全員に進歩カードです。';
      }
      return '💥 防衛失敗 ── 貢献が最も少なかった人の都市が開拓地に降格します。騎士を出していたあなたは無事でした。';
    },
    hold: 2400,
  },
  {
    say: '襲来のあとは全員の騎士が不活性に戻ります。守りは毎回立て直しです。',
    hold: 1000,
  },
  {
    say: '🧱 城壁は 🧱2。7が出たときの手札上限が1枚につき +2(7→9)。ボタンの数字のとおり、1人3枚までです。',
    prep: (s) => ensure(s, P, { brick: 2 }),
    tap: () => ({ btn: 'mode:wall' }),
    ui: () => ({ mode: 'build-wall' }),
    hold: 1400,
  },
  {
    say: '守りたい都市を選んで確定。',
    tap: (s) => ({ vertex: pickWall(s) }),
    ui: (s) => ({ pending: { vertexId: pickWall(s) } }),
    hold: 500,
  },
  {
    say: '城壁は都市が降格すると一緒に失われます。',
    tap: () => ({ btn: 'confirm' }),
    action: (s, ui) => ({ type: 'BUILD_WALL', player: P, vertexId: ui.pending?.vertexId }),
    hold: 700,
  },
  {
    say: '🏆 勝利は13点。都市改良・メトロポリス・守護者と、点の取り方はぐっと増えます。遊んでみてください!',
    hold: 1400,
  },
];

export const DEMO_CHAPTERS = [
  {
    id: 'setup',
    mode: 'base',
    title: 'はじめの配置',
    lead: '開拓地と道を置いてゲームが始まる',
    // 初期配置そのものを見せる章なので、盤面は setup の1手目から始める
    fromSetup: true,
    beats: setupBeats,
  },
  {
    id: 'basic',
    mode: 'base',
    title: '基本の手番',
    lead: 'ダイス → 建設 → 交易 → ターン終了',
    beats: basicBeats,
  },
  {
    id: 'cak',
    mode: 'cak',
    title: '都市と騎士',
    lead: '商品・都市改良・騎士・蛮族の襲来',
    beats: cakBeats,
  },
];

export function findChapter(id) {
  return DEMO_CHAPTERS.find((c) => c.id === id) ?? DEMO_CHAPTERS[0];
}
