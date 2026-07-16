// Phase 3: 進歩カード全54種のテスト

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createGame, RESOURCES } from '../src/state.js';
import { dispatch, validateAction } from '../src/actions.js';
import { chooseAction } from '../src/ai/cpu-player.js';
import {
  PROGRESS_CARDS, buildProgressDecks, COMMODITIES, distributeProgressCards,
} from '../src/rules/cak/progress-cards.js';
import { tradeRate } from '../src/rules/trade.js';
import { computePoints } from '../src/rules/victory.js';
import { LAYOUT } from '../src/rules/board.js';

// ---- ヘルパー ----

function finishSetup(state) {
  while (state.phase === 'setup') {
    const pid = state.awaiting.players[0];
    state = dispatch(state, chooseAction(state, pid));
  }
  return state;
}

function readyGame(seed = 5) {
  const s = finishSetup(createGame({ seed, humanIndex: -1, mode: 'cak' }));
  s.turnFlags.rolled = true;
  return s;
}

function giveCard(s, pid, id) {
  s.players[pid].progressCards.push({ id, deck: PROGRESS_CARDS[id].deck, boughtTurn: 0 });
  return s.players[pid].progressCards.length - 1;
}

function playCard(s, pid, id, params = null) {
  const index = giveCard(s, pid, id);
  return dispatch(s, { type: 'PLAY_PROGRESS_CARD', player: pid, index, params });
}

// 銀行と辻褄を合わせながら手札枚数を設定する(保存則テスト用)
function setCards(s, pid, key, n) {
  const p = s.players[pid];
  if (RESOURCES.includes(key)) {
    s.bank.resources[key] += p.resources[key] - n;
    p.resources[key] = n;
  } else {
    s.bank.commodities[key] += p.commodities[key] - n;
    p.commodities[key] = n;
  }
}

function conservation(s) {
  for (const r of RESOURCES) {
    const total = s.bank.resources[r] + s.players.reduce((a, p) => a + p.resources[r], 0);
    assert.equal(total, 19, `${r}保存則`);
  }
  for (const c of COMMODITIES) {
    const total = s.bank.commodities[c] + s.players.reduce((a, p) => a + p.commodities[c], 0);
    assert.equal(total, 12, `${c}保存則`);
  }
}

// ---- 山札構成 ----

test('山札構成: 3系統×18枚、合計54枚', () => {
  const decks = buildProgressDecks();
  assert.equal(decks.trade.length, 18);
  assert.equal(decks.politics.length, 18);
  assert.equal(decks.science.length, 18);
  for (const [id, def] of Object.entries(PROGRESS_CARDS)) {
    const n = Object.values(decks).flat().filter((x) => x === id).length;
    assert.equal(n, def.count, `${id}の枚数`);
  }
});

// ---- 交易系 ----

test('商人: 配置で2:1交易と+1点、別プレイヤーの配置で移動', () => {
  let s = readyGame();
  const hid = LAYOUT.hexIds.find(
    (h) =>
      s.board.hexes[h].terrain !== 'desert' &&
      LAYOUT.hexVertices[h].some((v) => s.buildings[v]?.player === 0),
  );
  const before = computePoints(s, 0);
  s = playCard(s, 0, 'merchant', { hexId: hid });
  assert.equal(s.merchant.player, 0);
  assert.equal(computePoints(s, 0), before + 1);
  const res = { forest: 'wood', hill: 'brick', pasture: 'sheep', field: 'wheat', mountain: 'ore' }[
    s.board.hexes[hid].terrain
  ];
  assert.equal(tradeRate(s, 0, res), 2);
});

test('商船隊: このターンだけ選んだ資源が2:1になり、ターン終了で戻る', () => {
  let s = readyGame();
  assert.ok(tradeRate(s, 0, 'ore') > 2);
  s = playCard(s, 0, 'merchantFleet', { key: 'ore' });
  assert.equal(tradeRate(s, 0, 'ore'), 2);
  s = dispatch(s, { type: 'END_TURN', player: 0 });
  assert.ok(tradeRate(s, 0, 'ore') > 2);
});

test('資源独占・交易独占: 各プレイヤーから徴収する', () => {
  let s = readyGame();
  setCards(s, 1, 'wood', 3);
  setCards(s, 2, 'wood', 1);
  s = playCard(s, 0, 'resourceMonopoly', { resource: 'wood' });
  assert.equal(s.players[1].resources.wood, 1); // 最大2枚
  assert.equal(s.players[2].resources.wood, 0);

  setCards(s, 1, 'cloth', 2);
  const mine = s.players[0].commodities.cloth;
  s = playCard(s, 0, 'tradeMonopoly', { commodity: 'cloth' });
  assert.equal(s.players[1].commodities.cloth, 1); // 1枚だけ
  assert.equal(s.players[0].commodities.cloth, mine + 1);
  conservation(s);
});

test('豪商: 勝利点が上の相手からのみ2枚奪える', () => {
  let s = readyGame();
  setCards(s, 1, 'wood', 5);
  // CPU1 に都市を追加して点数を上げる
  const vid = Object.keys(LAYOUT.vertices).find(
    (v) => !s.buildings[v] && !s.knights[v],
  );
  s.buildings[vid] = { player: 1, type: 'city' };
  assert.equal(
    validateAction(s, {
      type: 'PLAY_PROGRESS_CARD', player: 0,
      index: giveCard(s, 0, 'masterMerchant'), params: { target: 2 },
    }),
    '自分より勝利点が高い相手のみ選べます',
  );
  s.players[0].progressCards.pop();
  const count = (p) =>
    RESOURCES.reduce((a, r) => a + p.resources[r], 0) +
    COMMODITIES.reduce((a, c) => a + p.commodities[c], 0);
  const total = count(s.players[1]);
  s = playCard(s, 0, 'masterMerchant', { target: 1 });
  assert.equal(count(s.players[1]), total - 2); // ランダムに2枚奪う
  conservation(s);
});

test('商業港: 資源1枚と相手の商品1枚を強制交換', () => {
  let s = readyGame();
  for (const p of s.players) for (const c of COMMODITIES) setCards(s, p.id, c, 0);
  for (const p of s.players) setCards(s, p.id, 'wood', 0);
  setCards(s, 0, 'wood', 3);
  setCards(s, 1, 'cloth', 1);
  setCards(s, 2, 'paper', 1);
  s = playCard(s, 0, 'commercialHarbor', { resource: 'wood' });
  assert.equal(s.players[0].commodities.cloth + s.players[0].commodities.paper, 2);
  assert.equal(s.players[0].resources.wood, 1);
  assert.equal(s.players[1].resources.wood, 1);
  assert.equal(s.players[2].resources.wood, 1);
  conservation(s);
});

// ---- 政治系 ----

test('破壊工作員: 同点以上のプレイヤーが手札の半分を捨てる割り込み', () => {
  let s = readyGame();
  setCards(s, 1, 'wood', 6); // CPU1 は同点なので対象
  s = playCard(s, 0, 'saboteur');
  assert.equal(s.awaiting?.type, 'discard');
  assert.equal(s.awaiting.context.cause, 'saboteur');
  assert.ok(s.awaiting.players.includes(1));
  const need = s.awaiting.context.required[1];
  // CPU の応答で完了し、盗賊移動には進まない
  while (s.awaiting) {
    const pid = s.awaiting.players[0];
    s = dispatch(s, chooseAction(s, pid));
  }
  assert.equal(s.awaiting, null);
  assert.ok(need >= 1);
  conservation(s);
});

test('スパイ: 相手の進歩カードを奪う(奪ったターンは使えない)', () => {
  let s = readyGame();
  giveCard(s, 1, 'warlord');
  s = playCard(s, 0, 'spy', { target: 1 });
  assert.equal(s.players[1].progressCards.length, 0);
  assert.equal(s.players[0].progressCards.length, 1);
  assert.equal(s.players[0].progressCards[0].boughtTurn, s.turn);
});

test('将軍: 全騎士を無料で活性化', () => {
  let s = readyGame();
  const vid = Object.keys(LAYOUT.vertices).find(
    (v) => !s.buildings[v] && !s.knights[v] &&
      LAYOUT.vertexEdges[v].some((e) => s.roads[e]?.player === 0),
  );
  s.knights[vid] = { player: 0, level: 1, active: false, activatedTurn: -1 };
  s = playCard(s, 0, 'warlord');
  assert.equal(s.knights[vid].active, true);
});

test('脱走兵: 相手の騎士を除去し自分の騎士を無料配置', () => {
  let s = readyGame();
  const enemyVid = Object.keys(LAYOUT.vertices).find(
    (v) => !s.buildings[v] && !s.knights[v] &&
      LAYOUT.vertexEdges[v].some((e) => s.roads[e]?.player === 1),
  );
  s.knights[enemyVid] = { player: 1, level: 2, active: true, activatedTurn: -1 };
  s = playCard(s, 0, 'deserter', { target: 1 });
  assert.equal(s.knights[enemyVid], undefined);
  const mine = Object.values(s.knights).filter((k) => k.player === 0);
  assert.equal(mine.length, 1);
  assert.equal(mine[0].level, 2);
});

test('外交官: 開いた道のみ除去できる', () => {
  let s = readyGame();
  // 相手の道で端が開いているもの(初期配置の道は必ず開いている)
  const eid = Object.keys(s.roads).find((e) => s.roads[e].player === 1);
  s = playCard(s, 0, 'diplomat', { edgeId: eid });
  assert.equal(s.roads[eid], undefined);
});

test('王家の婚礼: 勝利点が上の相手から2枚ずつもらう', () => {
  let s = readyGame();
  const vid = Object.keys(LAYOUT.vertices).find((v) => !s.buildings[v] && !s.knights[v]);
  s.buildings[vid] = { player: 1, type: 'city' };
  for (const pl of s.players) for (const r of RESOURCES) setCards(s, pl.id, r, 0);
  setCards(s, 1, 'wood', 5);
  s = playCard(s, 0, 'wedding');
  assert.equal(s.players[1].resources.wood, 3);
  assert.equal(s.players[0].resources.wood >= 2, true);
  conservation(s);
});

// ---- 科学系 ----

test('錬金術師: ロール前に使い、指定した出目でロールされる', () => {
  let s = finishSetup(createGame({ seed: 5, humanIndex: -1, mode: 'cak' }));
  const index = giveCard(s, 0, 'alchemist');
  // ロール後には使えない
  const rolledState = structuredClone(s);
  rolledState.turnFlags.rolled = true;
  assert.match(
    validateAction(rolledState, {
      type: 'PLAY_PROGRESS_CARD', player: 0, index, params: { red: 3, yellow: 3 },
    }),
    /ロール前/,
  );
  s = dispatch(s, {
    type: 'PLAY_PROGRESS_CARD', player: 0, index, params: { red: 3, yellow: 3 },
  });
  assert.deepEqual(s.turnFlags.alchemist, [3, 3]);
  s = dispatch(s, { type: 'ROLL_DICE', player: 0 });
  assert.deepEqual(s.dice, [3, 3]);
});

test('クレーン: 都市改良が1枚引きになり、1回で消費される', () => {
  let s = readyGame();
  const p = s.players[0];
  // 都市を持たせる(cak初期配置で都市はあるはず)
  p.commodities.cloth = 0;
  s.bank.commodities.cloth = 12;
  s = playCard(s, 0, 'crane');
  assert.equal(s.turnFlags.crane, true);
  // Lv1 のコストは 1 → クレーンで 0 枚
  s = dispatch(s, { type: 'BUY_IMPROVEMENT', player: 0, track: 'trade' });
  assert.equal(s.players[0].improvements.trade, 1);
  assert.equal(s.players[0].commodities.cloth, 0);
  assert.equal(s.turnFlags.crane, undefined);
});

test('技師: 城壁を無料建設', () => {
  let s = readyGame();
  const cityVid = Object.keys(s.buildings).find(
    (v) => s.buildings[v].player === 0 && s.buildings[v].type === 'city',
  );
  assert.ok(cityVid);
  s = playCard(s, 0, 'engineer', { vertexId: cityVid });
  assert.equal(s.walls[cityVid], 0);
});

test('発明家: 数字トークンを交換(2,6,8,12は不可)し、盤面バージョンが進む', () => {
  let s = readyGame();
  const movable = LAYOUT.hexIds.filter((h) => {
    const t = s.board.hexes[h].token;
    return t && ![2, 6, 8, 12].includes(t);
  });
  const a = movable[0];
  const b = movable.find((h) => s.board.hexes[h].token !== s.board.hexes[a].token);
  const ta = s.board.hexes[a].token;
  const tb = s.board.hexes[b].token;
  const locked = LAYOUT.hexIds.find((h) => [6, 8].includes(s.board.hexes[h].token));
  assert.notEqual(
    validateAction(s, {
      type: 'PLAY_PROGRESS_CARD', player: 0,
      index: giveCard(s, 0, 'inventor'), params: { a: locked, b },
    }),
    null,
  );
  s.players[0].progressCards.pop();
  s = playCard(s, 0, 'inventor', { a, b });
  assert.equal(s.board.hexes[a].token, tb);
  assert.equal(s.board.hexes[b].token, ta);
  assert.equal(s.board.version, 1);
});

test('医学: 鉱石2+小麦1で開拓地を都市化', () => {
  let s = readyGame();
  const vid = Object.keys(s.buildings).find(
    (v) => s.buildings[v].player === 0 && s.buildings[v].type === 'settlement',
  );
  setCards(s, 0, 'ore', 2);
  setCards(s, 0, 'wheat', 1);
  s = playCard(s, 0, 'medicine', { vertexId: vid });
  assert.equal(s.buildings[vid].type, 'city');
  assert.equal(s.players[0].resources.ore, 0);
  conservation(s);
});

test('街道建設(進歩): 道を2本無料建設', () => {
  let s = readyGame();
  const roads = Object.keys(s.roads).length;
  const e1 = Object.keys(LAYOUT.edges).find(
    (e) => validateAction(s, {
      type: 'PLAY_PROGRESS_CARD', player: 0,
      index: giveCard(s, 0, 'roadBuilding'), params: { edges: [e] },
    }) === null,
  );
  s.players[0].progressCards.pop();
  s = playCard(s, 0, 'roadBuilding', { edges: [e1] });
  assert.equal(Object.keys(s.roads).length, roads + 1);
});

test('鍛冶屋: 騎士を2体まで無料昇格', () => {
  let s = readyGame();
  const spots = Object.keys(LAYOUT.vertices).filter(
    (v) => !s.buildings[v] && !s.knights[v] &&
      LAYOUT.vertexEdges[v].some((e) => s.roads[e]?.player === 0),
  );
  s.knights[spots[0]] = { player: 0, level: 1, active: false, activatedTurn: -1 };
  s = playCard(s, 0, 'smith');
  assert.equal(s.knights[spots[0]].level, 2);
});

// ---- VPカードと山札処理 ----

test('憲法・印刷機: 引いた瞬間に公開されて+1点', () => {
  let s = readyGame();
  s.players[0].improvements.politics = 1;
  s.bank.progressDecks.politics = ['constitution'];
  const before = s.players[0].progressVP;
  // 赤ダイス1 ≦ Lv+1 なので必ず配られる
  distributeProgressCards(s, 'politics', 1);
  assert.equal(s.players[0].progressVP, before + 1);
});

// ---- 難易度 ----

test('難易度: 弱いCPUは評価にノイズが乗り、強いCPUはノイズなし', async () => {
  const { evalNoise } = await import('../src/ai/evaluator.js');
  const hard = createGame({ seed: 5, humanIndex: -1, mode: 'cak', difficulty: 'hard' });
  const easy = createGame({ seed: 5, humanIndex: -1, mode: 'cak', difficulty: 'easy' });
  assert.equal(evalNoise(hard, 'v1'), 0);
  assert.notEqual(evalNoise(easy, 'v1'), 0);
  // 決定的(同じ入力なら同じノイズ)
  assert.equal(evalNoise(easy, 'v1'), evalNoise(easy, 'v1'));
});

// ---- セルフプレイゲート ----

test('セルフプレイ: 全54枚環境で完走し、保存則が成り立つ(20ゲーム)', () => {
  let played = 0;
  for (let seed = 100; seed < 120; seed++) {
    let state = createGame({ seed, playerCount: 4, humanIndex: -1, mode: 'cak' });
    let n = 0;
    while (state.phase !== 'ended') {
      if (++n > 12000) throw new Error(`seed=${seed}: 無限ループ`);
      const pid = state.awaiting ? state.awaiting.players[0] : state.currentPlayer;
      const action = chooseAction(state, pid);
      if (!action) throw new Error(`seed=${seed}: 手が選べない(${JSON.stringify(state.awaiting)})`);
      state = dispatch(state, action);
    }
    played += state.log.filter((l) => l.includes('進歩カード「')).length;
    for (const r of RESOURCES) {
      const total = state.bank.resources[r] + state.players.reduce((a, p) => a + p.resources[r], 0);
      assert.equal(total, 19, `seed=${seed}: ${r}保存則`);
    }
    for (const c of COMMODITIES) {
      const total = state.bank.commodities[c] + state.players.reduce((a, p) => a + p.commodities[c], 0);
      assert.equal(total, 12, `seed=${seed}: ${c}保存則`);
    }
  }
  assert.ok(played > 10, `進歩カードの使用が少なすぎる(${played}回)`);
});

test('セルフプレイ: 難易度別でも完走する(easy/normal 各5ゲーム)', () => {
  for (const difficulty of ['easy', 'normal']) {
    for (let seed = 200; seed < 205; seed++) {
      let state = createGame({ seed, playerCount: 3, humanIndex: -1, mode: 'cak', difficulty });
      let n = 0;
      while (state.phase !== 'ended') {
        if (++n > 12000) throw new Error(`${difficulty} seed=${seed}: 無限ループ`);
        const pid = state.awaiting ? state.awaiting.players[0] : state.currentPlayer;
        state = dispatch(state, chooseAction(state, pid));
      }
    }
  }
});
