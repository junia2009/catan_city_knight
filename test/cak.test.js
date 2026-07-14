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
  const hid = LAYOUT.hexIds.find(
    (h) => s.board.hexes[h].terrain === 'forest' && s.board.hexes[h].token,
  );
  assert.ok(hid, '森林ヘックスがある');
  const vid = LAYOUT.hexVertices[hid][0];
  s.buildings[vid] = { player: 0, type: 'city' };
  s.board.robber = LAYOUT.hexIds.find((h) => h !== hid); // 盗賊をどける
  distributeForRoll(s, s.board.hexes[hid].token);
  assert.equal(s.players[0].resources.wood, 1);
  assert.equal(s.players[0].commodities.paper, 1);
});

test('cak: 丘陵の都市は資源2(商品なし)', () => {
  let s = newCak();
  const hid = LAYOUT.hexIds.find(
    (h) => s.board.hexes[h].terrain === 'hill' && s.board.hexes[h].token,
  );
  const vid = LAYOUT.hexVertices[hid][0];
  s.buildings[vid] = { player: 0, type: 'city' };
  s.board.robber = LAYOUT.hexIds.find((h) => h !== hid);
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
  const needChoice = resolveBarbarianAttack(s2);
  assert.equal(needChoice.length, 0); // 都市1つなら自動降格
  assert.equal(s2.buildings[vids[10]].type, 'settlement');
  assert.equal(s2.buildings[vids[0]].type, 'city'); // 貢献者は守られる
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

test('cak: 商品2:1交易は該当系統Lv3から', () => {
  let s = newCak();
  assert.equal(tradeRate(s, 0, 'cloth'), 4);
  s.players[0].improvements.trade = 3;
  assert.equal(tradeRate(s, 0, 'cloth'), 2);
  assert.equal(tradeRate(s, 0, 'coin'), 4); // 別系統は変わらず
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
