// 都市と騎士(Phase 2)のルールテスト

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createGame, RESOURCES } from '../src/state.js';
import { dispatch, validateAction } from '../src/actions.js';
import { LAYOUT, TERRAIN_RESOURCE } from '../src/rules/board.js';
import { distributeForRoll } from '../src/rules/dice.js';
import { computePoints, pointsToWin } from '../src/rules/victory.js';
import { handLimit, totalCards } from '../src/rules/build.js';
import { tradeRate } from '../src/rules/trade.js';
import {
  resolveBarbarianAttack, barbarianStrength, razableCities,
} from '../src/rules/cak/barbarians.js';
import { canPlaceKnight, canMoveKnight, canPromoteKnight } from '../src/rules/cak/knights.js';
import { applyImprovement, canBuyImprovement } from '../src/rules/cak/improvements.js';
import { distributeProgressCards } from '../src/rules/cak/progress-cards.js';
import { chooseAction } from '../src/ai/cpu-player.js';
import { legalRoadEdges } from '../src/ai/legal-moves.js';

function newCak(seed = 5) {
  return createGame({ seed, playerCount: 4, humanIndex: -1, mode: 'cak' });
}

function finishSetup(state) {
  while (state.phase === 'setup') {
    const pid = state.awaiting.players[0];
    state = dispatch(state, chooseAction(state, pid));
  }
  return state;
}

test('cak: 初期配置は開拓地1 + 都市1、勝利点は13点', () => {
  let s = finishSetup(newCak());
  for (const p of s.players) {
    const mine = Object.values(s.buildings).filter((b) => b.player === p.id);
    assert.equal(mine.filter((b) => b.type === 'settlement').length, 1);
    assert.equal(mine.filter((b) => b.type === 'city').length, 1);
    assert.equal(computePoints(s, p.id), 3); // 開拓地1 + 都市2
  }
  assert.equal(pointsToWin(s), 13);
});

test('cak: 都市は商品の出る地形で資源1+商品1を産出', () => {
  let s = newCak();
  const hid = s.board.hexIds.find(
    (h) => s.board.hexes[h].terrain === 'forest' && s.board.hexes[h].token,
  );
  assert.ok(hid, '森林ヘックスがある');
  const vid = LAYOUT.hexVertices[hid][0];
  s.buildings[vid] = { player: 0, type: 'city' };
  s.board.robber = s.board.hexIds.find((h) => h !== hid); // 盗賊をどける
  distributeForRoll(s, s.board.hexes[hid].token);
  assert.equal(s.players[0].resources.wood, 1);
  assert.equal(s.players[0].commodities.paper, 1);
});

test('cak: 丘陵の都市は資源2(商品なし)', () => {
  let s = newCak();
  const hid = s.board.hexIds.find(
    (h) => s.board.hexes[h].terrain === 'hill' && s.board.hexes[h].token,
  );
  const vid = LAYOUT.hexVertices[hid][0];
  s.buildings[vid] = { player: 0, type: 'city' };
  s.board.robber = s.board.hexIds.find((h) => h !== hid);
  distributeForRoll(s, s.board.hexes[hid].token);
  assert.equal(s.players[0].resources.brick, 2);
});

test('cak: 蛮族襲来 — 防衛成功で守護者、失敗で都市降格', () => {
  // 防衛成功(単独最大貢献)
  let s = newCak();
  const vids = Object.keys(LAYOUT.vertices);
  s.buildings[vids[0]] = { player: 0, type: 'city' };
  s.buildings[vids[10]] = { player: 1, type: 'city' };
  s.knights[vids[20]] = { player: 0, level: 2, active: true, activatedTurn: -1 };
  assert.equal(barbarianStrength(s), 2);
  resolveBarbarianAttack(s);
  assert.equal(s.players[0].defenderPoints, 1);
  assert.equal(s.buildings[vids[0]].type, 'city'); // 降格なし
  assert.equal(s.knights[vids[20]].active, false); // 襲来後は全騎士不活性

  // 防衛失敗: 最少貢献者(騎士なしの player1)の都市が降格
  let s2 = newCak();
  s2.buildings[vids[0]] = { player: 0, type: 'city' };
  s2.buildings[vids[10]] = { player: 1, type: 'city' };
  s2.knights[vids[20]] = { player: 0, level: 1, active: true, activatedTurn: -1 };
  const need = resolveBarbarianAttack(s2);
  assert.equal(need.raze.length, 0); // 都市1つなら自動降格
  assert.equal(s2.buildings[vids[10]].type, 'settlement');
  assert.equal(s2.buildings[vids[0]].type, 'city'); // 貢献者は守られる
});

test('cak: 防衛の功が同点なら、引く進歩カードの山を本人が選ぶ(公式)', () => {
  const vids = Object.keys(LAYOUT.vertices);
  const setup = () => {
    const s = newCak();
    s.buildings[vids[0]] = { player: 0, type: 'city' };
    s.buildings[vids[10]] = { player: 1, type: 'city' };
    // 0 と 1 が同じ貢献度 → 守護者は出ず、両者が山を選んで1枚引く
    s.knights[vids[20]] = { player: 0, level: 1, active: true, activatedTurn: -1 };
    s.knights[vids[30]] = { player: 1, level: 1, active: true, activatedTurn: -1 };
    return s;
  };

  const s = setup();
  const need = resolveBarbarianAttack(s);
  assert.deepEqual(need.deck, [0, 1]);
  assert.deepEqual(need.raze, []);
  assert.equal(s.players[0].defenderPoints, 0, '同点では守護者は出ない');
  assert.equal(s.players[1].defenderPoints, 0);
  // この時点ではまだ引いていない(選択待ち)
  assert.equal(s.players[0].progressCards.length, 0);

  // ROLL_DICE 経由で割り込みが張られ、選んだ山から引けること
  let g = finishSetup(newCak());
  // cak の初期配置で全員1都市 = 蛮族4。防衛4(Lv2×2人)で守り切り、貢献は同点。
  g.knights = {
    [vids[20]]: { player: 0, level: 2, active: true, activatedTurn: -1 },
    [vids[30]]: { player: 1, level: 2, active: true, activatedTurn: -1 },
  };
  g.currentPlayer = 0;
  g.awaiting = null;
  g.turnFlags = { rolled: false, playedDev: false };
  g.barbarians.position = 6;
  let rolled = null;
  for (let i = 0; i < 60 && !rolled; i++) {
    const t = structuredClone(g);
    t.rng = (t.rng + i * 7919) >>> 0;
    const nx = dispatch(t, { type: 'ROLL_DICE', player: 0 });
    if (nx.awaiting?.type === 'defenderDeck') rolled = nx;
  }
  assert.ok(rolled, '襲来が起きる乱数が見つからない');
  assert.deepEqual(rolled.awaiting.players, [0, 1]);

  // 山を指定しないと通らない
  assert.match(
    validateAction(rolled, { type: 'PICK_DEFENDER_DECK', player: 0, track: 'nope' }),
    /系統を選んで/,
  );
  const before = rolled.bank.progressDecks.science.length;
  let after = dispatch(rolled, { type: 'PICK_DEFENDER_DECK', player: 0, track: 'science' });
  assert.equal(after.bank.progressDecks.science.length, before - 1, '科学の山から引いていない');
  assert.deepEqual(after.awaiting.players, [1], 'もう一人の選択待ちが残っていない');

  // 全員が選び終わると山選びの割り込みが解け、保留していた出目の処理へ進む
  // (7 なら捨て札や盗賊移動が続くので、awaiting が null とは限らない)
  after = dispatch(after, { type: 'PICK_DEFENDER_DECK', player: 1, track: 'trade' });
  assert.notEqual(after.awaiting?.type, 'defenderDeck');
  assert.equal(after.turnFlags.rolled, true, '出目の処理が再開していない');
});

test('cak: メトロポリスの都市は降格対象外', () => {
  let s = newCak();
  const vids = Object.keys(LAYOUT.vertices);
  s.buildings[vids[0]] = { player: 0, type: 'city' };
  s.buildings[vids[10]] = { player: 0, type: 'city' };
  s.metropolis.trade = vids[0];
  assert.deepEqual(razableCities(s, 0), [vids[10]]);
});

test('cak: 都市改良のコストとメトロポリス獲得/移動', () => {
  let s = finishSetup(newCak());
  const p0 = s.players[0];
  const p1 = s.players[1];

  // Lv1 は布1枚
  p0.commodities.cloth = 0;
  assert.match(canBuyImprovement(s, 0, 'trade'), /商品が1枚必要/);
  p0.commodities.cloth = 10;
  for (let lv = 1; lv <= 4; lv++) applyImprovement(s, 0, 'trade');
  assert.equal(p0.improvements.trade, 4);
  assert.equal(p0.commodities.cloth, 0); // 1+2+3+4 = 10
  // Lv4 で最初のメトロポリス
  assert.ok(s.metropolis.trade != null);
  assert.equal(s.buildings[s.metropolis.trade].player, 0);
  assert.equal(computePoints(s, 0), 3 + 2);

  // Lv5 で追い越されると移動
  p1.commodities.cloth = 15;
  for (let lv = 1; lv <= 5; lv++) applyImprovement(s, 1, 'trade');
  assert.equal(s.buildings[s.metropolis.trade].player, 1);
});

test('cak: 商館(交易Lv3)で全商品が2:1になる(公式ルール)', () => {
  let s = newCak();
  assert.equal(tradeRate(s, 0, 'cloth'), 4);
  // 政治・科学のLv3では商品レートは変わらない
  s.players[0].improvements.politics = 3;
  s.players[0].improvements.science = 3;
  assert.equal(tradeRate(s, 0, 'coin'), 4);
  assert.equal(tradeRate(s, 0, 'paper'), 4);
  // 交易Lv3(商館)で布・コイン・紙すべて2:1
  s.players[0].improvements.trade = 3;
  assert.equal(tradeRate(s, 0, 'cloth'), 2);
  assert.equal(tradeRate(s, 0, 'coin'), 2);
  assert.equal(tradeRate(s, 0, 'paper'), 2);
});

test('cak: 水道橋(科学Lv3)は収入0のとき好きな資源を1枚もらえる', () => {
  let s = finishSetup(newCak());
  s.players[0].improvements.science = 3;
  // player0 が何ももらえない出目を探す(7以外)
  const myTotals = new Set();
  for (const hid of s.board.hexIds) {
    const t = s.board.hexes[hid].token;
    if (t && LAYOUT.hexVertices[hid].some((v) => s.buildings[v]?.player === 0)) {
      myTotals.add(t);
    }
  }
  const total = [2, 3, 4, 5, 6, 8, 9, 10, 11, 12].find((t) => !myTotals.has(t));
  assert.ok(total != null);
  const red = Math.max(1, total - 6);
  s.turnFlags.alchemist = [red, total - red]; // 出目を固定してロール
  s = dispatch(s, { type: 'ROLL_DICE', player: 0 });

  assert.equal(s.awaiting?.type, 'aqueduct');
  assert.ok(s.awaiting.players.includes(0));
  // CPU応答も PICK_AQUEDUCT を返す
  const a = chooseAction(s, s.awaiting.players[0]);
  assert.equal(a.type, 'PICK_AQUEDUCT');

  const wood = s.players[0].resources.wood;
  s = dispatch(s, { type: 'PICK_AQUEDUCT', player: 0, resource: 'wood' });
  assert.equal(s.players[0].resources.wood, wood + 1);
  assert.ok(!s.awaiting || s.awaiting.type !== 'aqueduct' || !s.awaiting.players.includes(0));
});

test('cak: 水道橋は科学Lv3未満や収入ありでは発動しない', () => {
  let s = finishSetup(newCak());
  // 科学Lv3なし → 誰も対象にならない出目でも awaiting は立たない
  const myTotals = new Set();
  for (const hid of s.board.hexIds) {
    const t = s.board.hexes[hid].token;
    if (t && LAYOUT.hexVertices[hid].some((v) => s.buildings[v]?.player === 0)) {
      myTotals.add(t);
    }
  }
  const total = [2, 3, 4, 5, 6, 8, 9, 10, 11, 12].find((t) => !myTotals.has(t));
  const red = Math.max(1, total - 6);
  s.turnFlags.alchemist = [red, total - red];
  s = dispatch(s, { type: 'ROLL_DICE', player: 0 });
  assert.notEqual(s.awaiting?.type, 'aqueduct');
});

test('cak: 騎士の建設・昇格・移動の判定', () => {
  let s = finishSetup(newCak());
  // player0 の道に接続する空き頂点を探す
  const roadEdge = Object.keys(s.roads).find((e) => s.roads[e].player === 0);
  const vid = LAYOUT.edges[roadEdge].v.find((v) => !s.buildings[v] && !s.knights[v]);
  assert.ok(vid);
  assert.equal(canPlaceKnight(s, 0, vid), null);
  s.knights[vid] = { player: 0, level: 1, active: true, activatedTurn: -1 };

  // 距離ルールとは無関係だが、開拓地は騎士のいる頂点に置けない
  assert.match(validateAction({ ...s, turnFlags: { rolled: true, playedDev: false } },
    { type: 'BUILD_SETTLEMENT', player: 1, vertexId: vid }) ?? '', /./);

  // Lv2→3 は政治Lv3が必要
  s.knights[vid].level = 2;
  assert.match(canPromoteKnight(s, 0, vid), /政治Lv3/);
  s.players[0].improvements.politics = 3;
  assert.equal(canPromoteKnight(s, 0, vid), null);

  // 移動: 自分の道網の到達頂点のみ
  const other = LAYOUT.edges[roadEdge].v.find((v) => v !== vid);
  if (!s.buildings[other] && !s.knights[other]) {
    assert.equal(canMoveKnight(s, 0, vid, other), null);
  }
  // 活性化したターンは行動不可
  s.knights[vid].activatedTurn = s.turn;
  assert.match(canMoveKnight(s, 0, vid, other) ?? '', /./);
});

test('cak: 城壁で手札上限が+2、捨て札は商品も対象', () => {
  let s = finishSetup(newCak());
  assert.equal(handLimit(s, 0), 7);
  const cityVid = Object.keys(s.buildings).find(
    (v) => s.buildings[v].player === 0 && s.buildings[v].type === 'city',
  );
  s.walls[cityVid] = 0;
  assert.equal(handLimit(s, 0), 9);

  // 商品込みの捨て札
  const p = s.players[0];
  for (const r of RESOURCES) { s.bank.resources[r] += p.resources[r]; p.resources[r] = 0; }
  p.resources.wood = 6;
  p.commodities.paper = 6;
  assert.equal(totalCards(p), 12);
  s.awaiting = { type: 'discard', players: [0], context: { required: { 0: 6 } } };
  assert.equal(
    validateAction(s, { type: 'DISCARD', player: 0, resources: { wood: 3, paper: 3 } }),
    null,
  );
  s = dispatch(s, { type: 'DISCARD', player: 0, resources: { wood: 3, paper: 3 } });
  assert.equal(s.players[0].commodities.paper, 3);
});

test('cak: 進歩カードは赤ダイス ≦ Lv+1 で獲得', () => {
  let s = newCak();
  s.players[0].improvements.science = 2; // 赤3以下で獲得
  s.players[1].improvements.science = 0; // 獲得なし
  distributeProgressCards(s, 'science', 3);
  const got0 = s.players[0].progressCards.length + s.players[0].progressVP;
  assert.equal(got0, 1);
  assert.equal(s.players[1].progressCards.length + s.players[1].progressVP, 0);
  distributeProgressCards(s, 'science', 4); // 赤4 > 2+1
  assert.equal(s.players[0].progressCards.length + s.players[0].progressVP, got0);
});

test('cak: 発展カードは購入も使用も不可', () => {
  let s = finishSetup(newCak());
  s.turnFlags.rolled = true;
  assert.match(validateAction(s, { type: 'BUY_DEV_CARD', player: s.currentPlayer }), /都市と騎士/);
});

test('cak: セルフプレイ15ゲーム完走 + 保存則', () => {
  for (let seed = 1; seed <= 15; seed++) {
    let state = createGame({ seed, playerCount: 4, humanIndex: -1, mode: 'cak' });
    let actions = 0;
    while (state.phase !== 'ended') {
      if (++actions > 9000) {
        throw new Error(`seed=${seed}: 9000アクション超過(ログ末尾: ${state.log.slice(-5).join(' / ')})`);
      }
      const pid = state.awaiting ? state.awaiting.players[0] : state.currentPlayer;
      const action = chooseAction(state, pid);
      if (!action) throw new Error(`seed=${seed}: CPU${pid} が手を返さない(awaiting=${state.awaiting?.type})`);
      state = dispatch(state, action);
    }
    const pts = computePoints(state, state.winner, { includeHidden: true });
    assert.ok(pts >= 13, `seed=${seed}: 勝者${pts}点`);
    for (const r of RESOURCES) {
      const total = state.bank.resources[r] + state.players.reduce((s2, p) => s2 + p.resources[r], 0);
      assert.equal(total, 19, `seed=${seed}: ${r}=${total}`);
    }
    for (const c of ['cloth', 'coin', 'paper']) {
      const total = state.bank.commodities[c] + state.players.reduce((s2, p) => s2 + p.commodities[c], 0);
      assert.equal(total, 12, `seed=${seed}: ${c}=${total}`);
    }
  }
});

// ---- 進歩カードの手札上限(公式) ----

// 指定枚数の進歩カードを持たせる(山札から取り除いて辻褄を合わせる)
function giveProgress(s, pid, n) {
  s.players[pid].progressCards = [];
  for (let i = 0; i < n; i++) {
    const id = s.bank.progressDecks.politics.pop();
    s.players[pid].progressCards.push({ id, deck: 'politics', boughtTurn: -1 });
  }
  return s;
}

test('cak: 進歩カードは4枚まで。自分の手番だけ5枚持てる(公式)', () => {
  let s = finishSetup(newCak());
  s.currentPlayer = 0;
  s.awaiting = null;
  s.turnFlags = { rolled: true, playedDev: false };

  // 手番中は5枚まで持てる ── 5枚にしても捨て札の割り込みは立たない
  s = giveProgress(s, 0, 5);
  s.players[0].resources.wood = 2;
  s.players[0].resources.brick = 2;
  let t = dispatch(s, { type: 'BUILD_ROAD', player: 0, edgeId: legalRoadEdges(s, 0)[0] });
  assert.equal(t.awaiting?.type ?? null, null, '手番中の5枚で捨て札を求められている');

  // ただしそのままターンは終えられない
  t = dispatch(s, { type: 'END_TURN', player: 0 });
  assert.equal(t.awaiting?.type, 'progressLimit');
  assert.deepEqual(t.awaiting.players, [0]);
  assert.equal(t.currentPlayer, 0, '捨てる前に手番が進んでいる');

  // 1枚捨てるとターンが進む
  const after = dispatch(t, { type: 'DISCARD_PROGRESS', player: 0, index: 0 });
  assert.equal(after.players[0].progressCards.length, 4);
  assert.equal(after.awaiting?.type ?? null, null);
  assert.equal(after.currentPlayer, 1, 'ターンが進んでいない');
  // 捨てたカードは山札の底に戻る
  assert.equal(after.bank.progressDecks.politics[0], t.players[0].progressCards[0].id);
});

test('cak: 手番でない人が5枚目を得たら即座に捨てる(公式)', () => {
  let s = finishSetup(newCak());
  s.currentPlayer = 0;
  s.awaiting = null;
  s.turnFlags = { rolled: true, playedDev: false };
  s = giveProgress(s, 1, 4); // 手番でない席1が上限ちょうど
  s.players[0].resources.wood = 2;
  s.players[0].resources.brick = 2;

  // スパイで席1から奪うと席0が5枚になる…のではなく、ここは配布で増やす。
  // イベントダイスの配布は席1にも配られるので、政治Lvを上げて確実に引かせる。
  s.players[1].improvements.politics = 3;
  for (const p of s.players) if (p.id !== 1) p.improvements.politics = 0;
  distributeProgressCards(s, 'politics', 1);
  assert.equal(s.players[1].progressCards.length, 5, '上限でも引けていない');

  // dispatch を通すと割り込みが立つ(手番外なので猶予なし)
  const t = dispatch(
    { ...s, awaiting: null },
    { type: 'BUILD_ROAD', player: 0, edgeId: legalRoadEdges(s, 0)[0] },
  );
  assert.equal(t.awaiting?.type, 'progressLimit');
  assert.deepEqual(t.awaiting.players, [1]);

  const after = dispatch(t, { type: 'DISCARD_PROGRESS', player: 1, index: 2 });
  assert.equal(after.players[1].progressCards.length, 4);
  assert.equal(after.awaiting?.type ?? null, null);
});

test('cak: 上限の割り込みは基本モードでは立たない', () => {
  const s = finishSetup(createGame({ seed: 5, playerCount: 4, humanIndex: -1 }));
  const t = { ...s, currentPlayer: 0, awaiting: null, turnFlags: { rolled: true, playedDev: false } };
  // 基本モードに progressCards は無いので、何をしても progressLimit は立たない
  const after = dispatch(t, { type: 'END_TURN', player: 0 });
  assert.equal(after.awaiting?.type ?? null, null);
});
