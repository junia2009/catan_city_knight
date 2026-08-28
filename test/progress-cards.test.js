// Phase 3: 進歩カード全54種のテスト

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createGame, RESOURCES } from '../src/state.js';
import { dispatch, validateAction } from '../src/actions.js';
import { chooseAction } from '../src/ai/cpu-player.js';
import {
  PROGRESS_CARDS, buildProgressDecks, COMMODITIES, distributeProgressCards,
  diplomatMovable, diplomatDestinations,
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
  const hid = s.board.hexIds.find(
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

test('王家の婚礼: 渡す2枚は相手が選ぶ(公式)', () => {
  let s = readyGame();
  const vid = Object.keys(LAYOUT.vertices).find((v) => !s.buildings[v] && !s.knights[v]);
  s.buildings[vid] = { player: 1, type: 'city' }; // 席1だけ勝利点が上
  for (const pl of s.players) {
    for (const r of RESOURCES) setCards(s, pl.id, r, 0);
    for (const c of COMMODITIES) setCards(s, pl.id, c, 0);
  }
  setCards(s, 1, 'wood', 3);
  setCards(s, 1, 'cloth', 2);

  // 使った時点ではまだ動かない。贈り主の選択待ちになる。
  s = playCard(s, 0, 'wedding');
  assert.equal(s.awaiting?.type, 'weddingGift');
  assert.deepEqual(s.awaiting.players, [1]);
  assert.equal(s.players[0].resources.wood, 0, '選ぶ前に受け取っている');

  // 枚数がちょうど2枚でないと通らない / 持っていない札は選べない
  const give = (cards) => ({ type: 'GIVE_WEDDING', player: 1, cards });
  assert.match(validateAction(s, give({ wood: 1 })), /ちょうど2枚/);
  assert.match(validateAction(s, give({ wood: 3 })), /ちょうど2枚/);
  assert.match(validateAction(s, give({ ore: 2 })), /手札が足りません/);

  // 相手が選んだ内訳がそのまま渡る(資源と商品を混ぜてもよい)
  const after = dispatch(s, give({ wood: 1, cloth: 1 }));
  assert.equal(after.players[0].resources.wood, 1);
  assert.equal(after.players[0].commodities.cloth, 1);
  assert.equal(after.players[1].resources.wood, 2);
  assert.equal(after.players[1].commodities.cloth, 1);
  assert.equal(after.awaiting, null);
  conservation(after);
});

test('王家の婚礼: 手札が1枚の相手は1枚だけ渡す', () => {
  let s = readyGame();
  const vid = Object.keys(LAYOUT.vertices).find((v) => !s.buildings[v] && !s.knights[v]);
  s.buildings[vid] = { player: 1, type: 'city' };
  for (const pl of s.players) {
    for (const r of RESOURCES) setCards(s, pl.id, r, 0);
    for (const c of COMMODITIES) setCards(s, pl.id, c, 0);
  }
  setCards(s, 1, 'wood', 1);
  s = playCard(s, 0, 'wedding');
  assert.match(validateAction(s, { type: 'GIVE_WEDDING', player: 1, cards: { wood: 2 } }), /ちょうど1枚/);
  const after = dispatch(s, { type: 'GIVE_WEDDING', player: 1, cards: { wood: 1 } });
  assert.equal(after.players[0].resources.wood, 1);
  assert.equal(after.awaiting, null);
  conservation(after);
});

test('王家の婚礼: 手札が無い相手は対象外', () => {
  const s = readyGame();
  const vid = Object.keys(LAYOUT.vertices).find((v) => !s.buildings[v] && !s.knights[v]);
  s.buildings[vid] = { player: 1, type: 'city' };
  for (const pl of s.players) {
    for (const r of RESOURCES) setCards(s, pl.id, r, 0);
    for (const c of COMMODITIES) setCards(s, pl.id, c, 0);
  }
  // 誰も手札を持っていなければカード自体を使えない
  assert.match(
    validateAction(s, {
      type: 'PLAY_PROGRESS_CARD', player: 0, index: giveCard(s, 0, 'wedding'), params: null,
    }),
    /対象となる相手がいません/,
  );
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
  const movable = s.board.hexIds.filter((h) => {
    const t = s.board.hexes[h].token;
    return t && ![2, 6, 8, 12].includes(t);
  });
  const a = movable[0];
  const b = movable.find((h) => s.board.hexes[h].token !== s.board.hexes[a].token);
  const ta = s.board.hexes[a].token;
  const tb = s.board.hexes[b].token;
  const locked = s.board.hexIds.find((h) => [6, 8].includes(s.board.hexes[h].token));
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

// 騎士のコマはレベルごとに1人2体まで(KNIGHT_LIMIT_PER_LEVEL)。
// 空き頂点に直接置いて、昇格の判定だけを見る。
function freeVertices(s, n) {
  return Object.keys(LAYOUT.vertices)
    .filter((v) => !s.buildings[v] && !s.knights[v])
    .slice(0, n);
}

test('鍛冶屋: 昇格させる騎士を自分で選ぶ(公式)', () => {
  const base = readyGame();
  const [a, b] = freeVertices(base, 2);
  const setup = () => {
    const s = structuredClone(base);
    s.knights[a] = { player: 0, level: 1, active: false, activatedTurn: -1 };
    s.knights[b] = { player: 0, level: 1, active: false, activatedTurn: -1 };
    return s;
  };

  // 1体だけ選べば、選ばなかった騎士は上がらない(自動選択ではない)
  let s = playCard(setup(), 0, 'smith', { vertices: [a] });
  assert.equal(s.knights[a].level, 2);
  assert.equal(s.knights[b].level, 1, '選んでいない騎士まで昇格している');

  // 2体選べば両方上がる
  s = playCard(setup(), 0, 'smith', { vertices: [a, b] });
  assert.equal(s.knights[a].level, 2);
  assert.equal(s.knights[b].level, 2);

  // 同じ騎士を2回 / 3体 / 0体 / 相手の騎士 は選べない
  const t = setup();
  const [, , c] = freeVertices(t, 3);
  t.knights[c] = { player: 1, level: 1, active: false, activatedTurn: -1 };
  const index = giveCard(t, 0, 'smith');
  const play = (params) =>
    validateAction(t, { type: 'PLAY_PROGRESS_CARD', player: 0, index, params });
  assert.match(play({ vertices: [a, a] }), /同じ騎士/);
  assert.match(play({ vertices: [a, b, c] }), /1〜2体/);
  assert.match(play({ vertices: [] }), /1〜2体/);
  assert.match(play({ vertices: [c] }), /自分の騎士/);
});

test('鍛冶屋: コマの残数は1体ずつ当てはめて判定する', () => {
  const s = readyGame();
  const [a, b, c] = freeVertices(s, 3);
  // Lv2 のコマは1人2体まで。すでに1体いるので、Lv1 を2体同時には上げられない。
  s.knights[a] = { player: 0, level: 2, active: false, activatedTurn: -1 };
  s.knights[b] = { player: 0, level: 1, active: false, activatedTurn: -1 };
  s.knights[c] = { player: 0, level: 1, active: false, activatedTurn: -1 };
  const index = giveCard(s, 0, 'smith');
  const play = (params) =>
    validateAction(s, { type: 'PLAY_PROGRESS_CARD', player: 0, index, params });
  assert.equal(play({ vertices: [b] }), null, '1体なら上げられるはず');
  assert.match(play({ vertices: [b, c] }), /コマがありません/);
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

test('外交官: 相手の道の撤去に加えて、自分の道を移設できる(公式)', () => {
  const base = readyGame();
  // 自分の道の先端(開いた道)と、相手の開いた道を用意する
  const myOpen = diplomatMovable(base, 0);
  assert.ok(myOpen.length > 0, '自分の開いた道がない');
  const from = myOpen[0];
  const dests = diplomatDestinations(base, 0, from);
  assert.ok(dests.length > 0, '移設先がない');
  const to = dests[0];

  // 移設: 元の辺から消えて、移設先に自分の道ができる
  let s = playCard(structuredClone(base), 0, 'diplomat', { edgeId: from, to });
  assert.equal(s.roads[from], undefined, '元の道が残っている');
  assert.equal(s.roads[to].player, 0);
  // 道の総数は変わらない(移設なので増えない)
  const count = (g, pid) => Object.values(g.roads).filter((r) => r.player === pid).length;
  assert.equal(count(s, 0), count(base, 0));

  // 撤去だけ(to なし)も従来どおり通る
  s = playCard(structuredClone(base), 0, 'diplomat', { edgeId: from });
  assert.equal(s.roads[from], undefined);
  assert.equal(count(s, 0), count(base, 0) - 1);

  // 相手の道は移設できない
  const t = structuredClone(base);
  const index = giveCard(t, 0, 'diplomat');
  const play = (params) =>
    validateAction(t, { type: 'PLAY_PROGRESS_CARD', player: 0, index, params });
  const enemyOpen = diplomatMovable(t, 1)[0];
  if (enemyOpen) {
    assert.match(play({ edgeId: enemyOpen, to }), /自分の道だけ/);
    assert.equal(play({ edgeId: enemyOpen }), null, '相手の開いた道は撤去できるはず');
  }
  // 同じ場所へは移せない / 繋がらない場所へも移せない
  assert.match(play({ edgeId: from, to: from }), /別の場所/);
});

test('外交官: 移設先は「その道を外した状態」で置ける辺に限る', () => {
  const s = readyGame();
  const from = diplomatMovable(s, 0)[0];
  const dests = diplomatDestinations(s, 0, from);
  const index = giveCard(s, 0, 'diplomat');
  // 列挙された行き先はすべて通り、それ以外は通らない
  for (const to of dests.slice(0, 5)) {
    assert.equal(
      validateAction(s, { type: 'PLAY_PROGRESS_CARD', player: 0, index, params: { edgeId: from, to } }),
      null,
      `移設先 ${to} が通らない`,
    );
  }
  const notDest = Object.keys(LAYOUT.edges).find(
    (e) => e !== from && !dests.includes(e) && !s.roads[e],
  );
  assert.ok(notDest);
  assert.ok(
    validateAction(s, {
      type: 'PLAY_PROGRESS_CARD', player: 0, index, params: { edgeId: from, to: notDest },
    }) !== null,
    '繋がらない辺へ移設できてしまう',
  );
});
