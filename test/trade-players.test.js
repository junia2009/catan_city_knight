// プレイヤー間交易のテスト

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createGame, RESOURCES } from '../src/state.js';
import { dispatch, validateAction } from '../src/actions.js';
import { chooseAction, cpuAcceptsTrade, nextGoal } from '../src/ai/cpu-player.js';

function finishSetup(state) {
  while (state.phase === 'setup') {
    const pid = state.awaiting.players[0];
    state = dispatch(state, chooseAction(state, pid));
  }
  return state;
}

function clearHands(s) {
  for (const p of s.players) {
    for (const r of RESOURCES) {
      s.bank.resources[r] += p.resources[r];
      p.resources[r] = 0;
    }
  }
}

test('TRADE_PLAYERS: 双方の手札が交換される', () => {
  let s = finishSetup(createGame({ seed: 5, humanIndex: -1 }));
  s.turnFlags.rolled = true;
  clearHands(s);
  s.players[0].resources.wood = 2;
  s.players[1].resources.wheat = 1;
  s = dispatch(s, {
    type: 'TRADE_PLAYERS', player: 0, partner: 1,
    give: { wood: 2 }, receive: { wheat: 1 },
  });
  assert.equal(s.players[0].resources.wood, 0);
  assert.equal(s.players[0].resources.wheat, 1);
  assert.equal(s.players[1].resources.wood, 2);
  assert.equal(s.players[1].resources.wheat, 0);
});

test('TRADE_PLAYERS: 手札不足・空の提案・自分自身は拒否される', () => {
  let s = finishSetup(createGame({ seed: 5, humanIndex: -1 }));
  s.turnFlags.rolled = true;
  clearHands(s);
  s.players[0].resources.wood = 1;
  assert.match(
    validateAction(s, { type: 'TRADE_PLAYERS', player: 0, partner: 1, give: { wood: 2 }, receive: { wheat: 1 } }),
    /手札が足りません/,
  );
  s.players[0].resources.wood = 2;
  assert.match(
    validateAction(s, { type: 'TRADE_PLAYERS', player: 0, partner: 1, give: { wood: 2 }, receive: { wheat: 1 } }),
    /相手の手札が足りません/,
  );
  assert.match(
    validateAction(s, { type: 'TRADE_PLAYERS', player: 0, partner: 0, give: { wood: 1 }, receive: { wood: 1 } }),
    /交易相手が不正/,
  );
  assert.match(
    validateAction(s, { type: 'TRADE_PLAYERS', player: 0, partner: 1, give: {}, receive: { wheat: 1 } }),
    /両方選んでください/,
  );
});

test('TRADE_PLAYERS: 基本モードでは商品を混ぜられない', () => {
  let s = finishSetup(createGame({ seed: 5, humanIndex: -1, mode: 'base' }));
  s.turnFlags.rolled = true;
  assert.match(
    validateAction(s, { type: 'TRADE_PLAYERS', player: 0, partner: 1, give: { cloth: 1 }, receive: { wood: 1 } }),
    /交易内容が不正/,
  );
});

test('cpuAcceptsTrade: 不足資源がもらえる得な取引は受け、不利な取引は断る', () => {
  let s = finishSetup(createGame({ seed: 5, humanIndex: -1 }));
  clearHands(s);
  const cpu = s.players[1];
  // CPU1 の目標に対して不足している資源を特定
  cpu.resources.wood = 4; // 余剰を持たせる
  const goal = nextGoal(s, 1);
  const missing = Object.keys(goal.cost).find((r) => (cpu.resources[r] ?? 0) < goal.cost[r]);
  assert.ok(missing);

  // 不足資源1 ⇄ 余剰木材1 → 受ける
  assert.equal(cpuAcceptsTrade(s, 1, { [missing]: 1 }, { wood: 1 }), true);
  // 余剰木材をさらに渡される(価値の低い)取引で不足資源を要求 → 断る
  assert.equal(cpuAcceptsTrade(s, 1, { wood: 1 }, { [missing]: 1 }), false);
  // 持っていないものは渡せない
  assert.equal(cpuAcceptsTrade(s, 1, { wood: 1 }, { ore: 5 }), false);
});

test('OFFER_TRADE → RESPOND_TRADE(承諾): 割り込みが立ち、承諾で交換される', () => {
  let s = finishSetup(createGame({ seed: 5, humanIndex: -1 }));
  s.turnFlags.rolled = true;
  clearHands(s);
  s.players[0].resources.wood = 2;
  s.players[1].resources.wheat = 1;
  s = dispatch(s, {
    type: 'OFFER_TRADE', player: 0, partner: 1,
    give: { wood: 1 }, receive: { wheat: 1 },
  });
  assert.equal(s.awaiting?.type, 'tradeOffer');
  assert.deepEqual(s.awaiting.players, [1]);
  assert.equal(s.turnFlags.offeredTrade, true);
  // 応答待ち中は他のアクションは通らない
  assert.match(
    validateAction(s, { type: 'BUILD_ROAD', player: 0, edgeId: 'x' }),
    /応答待ち/,
  );
  s = dispatch(s, { type: 'RESPOND_TRADE', player: 1, accept: true });
  assert.equal(s.awaiting, null);
  assert.equal(s.players[0].resources.wood, 1);
  assert.equal(s.players[0].resources.wheat, 1);
  assert.equal(s.players[1].resources.wood, 1);
  assert.equal(s.players[1].resources.wheat, 0);
  assert.ok(s.log.some((l) => l.startsWith('🤝')));
});

test('OFFER_TRADE → RESPOND_TRADE(拒否): 交換されず、同ターンの再提案も不可', () => {
  let s = finishSetup(createGame({ seed: 5, humanIndex: -1 }));
  s.turnFlags.rolled = true;
  clearHands(s);
  s.players[0].resources.wood = 2;
  s.players[1].resources.wheat = 1;
  s = dispatch(s, {
    type: 'OFFER_TRADE', player: 0, partner: 1,
    give: { wood: 1 }, receive: { wheat: 1 },
  });
  s = dispatch(s, { type: 'RESPOND_TRADE', player: 1, accept: false });
  assert.equal(s.awaiting, null);
  assert.equal(s.players[0].resources.wood, 2);
  assert.equal(s.players[1].resources.wheat, 1);
  assert.ok(s.players[0].offerCooldownTurn > s.turn);
  assert.match(
    validateAction(s, {
      type: 'OFFER_TRADE', player: 0, partner: 1,
      give: { wood: 1 }, receive: { wheat: 1 },
    }),
    /すでに交易を提案しました/,
  );
  // 割り込みがないときの RESPOND_TRADE は不正
  assert.notEqual(validateAction(s, { type: 'RESPOND_TRADE', player: 0, accept: true }), null);
});

test('chooseAction: 提案を受けたCPUは損得で応答し、CPUは人間にも提案する', () => {
  let s = finishSetup(createGame({ seed: 5, humanIndex: 0 }));
  s.turnFlags.rolled = true;
  clearHands(s);

  // CPU 1 が手番。木材2の余剰があり、目標の不足資源を人間だけが持っている
  s.currentPlayer = 1;
  s.players[1].resources.wood = 2;
  const goal = nextGoal(s, 1);
  const missing = Object.keys(goal.cost).find(
    (r) => r !== 'wood' && (s.players[1].resources[r] ?? 0) < goal.cost[r],
  );
  assert.ok(missing);
  s.players[0].resources[missing] = 1;

  const offer = chooseAction(s, 1);
  assert.equal(offer.type, 'OFFER_TRADE');
  assert.equal(offer.partner, 0);
  assert.deepEqual(offer.receive, { [missing]: 1 });
  s = dispatch(s, offer);

  // 提案を受けた側がCPUなら chooseAction が応答を返す
  const resp = chooseAction(s, 0);
  assert.equal(resp.type, 'RESPOND_TRADE');
});

test('セルフプレイ: CPU同士の交易が発生しつつ完走する', () => {
  let traded = 0;
  for (let seed = 20; seed < 30; seed++) {
    let state = createGame({ seed, playerCount: 4, humanIndex: -1, mode: 'cak' });
    let n = 0;
    while (state.phase !== 'ended') {
      if (++n > 9000) throw new Error(`seed=${seed}: 無限ループ`);
      const pid = state.awaiting ? state.awaiting.players[0] : state.currentPlayer;
      state = dispatch(state, chooseAction(state, pid));
    }
    traded += state.log.filter((l) => l.startsWith('🤝')).length;
    for (const r of RESOURCES) {
      const total = state.bank.resources[r] + state.players.reduce((a, p) => a + p.resources[r], 0);
      assert.equal(total, 19, `seed=${seed}: ${r}保存則`);
    }
  }
  assert.ok(traded > 0, `10ゲームで交易が一度も発生しなかった`);
});

test('セルフプレイ(人間枠あり): 提案割り込みを挟んでも完走し保存則が成り立つ', () => {
  let offers = 0;
  for (let seed = 40; seed < 46; seed++) {
    let state = createGame({ seed, playerCount: 3, humanIndex: 0, mode: 'cak' });
    let n = 0;
    while (state.phase !== 'ended') {
      if (++n > 9000) throw new Error(`seed=${seed}: 無限ループ`);
      const pid = state.awaiting ? state.awaiting.players[0] : state.currentPlayer;
      state = dispatch(state, chooseAction(state, pid));
    }
    offers += state.log.filter((l) => l.startsWith('💬')).length;
    for (const r of RESOURCES) {
      const total = state.bank.resources[r] + state.players.reduce((a, p) => a + p.resources[r], 0);
      assert.equal(total, 19, `seed=${seed}: ${r}保存則`);
    }
  }
  assert.ok(offers > 0, '6ゲームで人間への交易提案が一度も発生しなかった');
});
