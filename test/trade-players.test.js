// プレイヤー間交易(一斉提案)のテスト
//
// 流れ: OFFER_TRADE(全員へ)→ 各自 RESPOND_TRADE → 返事が揃って決着。
// 応じたのが1人ならその場で成立、2人以上なら提案者が CHOOSE_TRADE で選ぶ。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createGame, RESOURCES } from '../src/state.js';
import { dispatch, validateAction, MAX_OFFERS_PER_TURN } from '../src/actions.js';
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

// 提案を出して、指定した席だけ承諾・残りは拒否させる
function offerAndReply(s, from, give, receive, acceptors) {
  s = dispatch(s, { type: 'OFFER_TRADE', player: from, give, receive });
  for (const pid of [...s.awaiting.players]) {
    s = dispatch(s, { type: 'RESPOND_TRADE', player: pid, accept: acceptors.includes(pid) });
  }
  return s;
}

test('OFFER_TRADE: 自分以外の全員に割り込みが立つ', () => {
  let s = finishSetup(createGame({ seed: 5, humanIndex: -1 }));
  s.turnFlags.rolled = true;
  clearHands(s);
  s.players[0].resources.wood = 2;

  s = dispatch(s, {
    type: 'OFFER_TRADE', player: 0, give: { wood: 1 }, receive: { wheat: 1 },
  });
  assert.equal(s.awaiting.type, 'tradeOffer');
  assert.deepEqual(s.awaiting.players, [1, 2, 3]);
  assert.equal(s.turnFlags.offers, 1);
  assert.ok(s.log.some((l) => l.includes('全員に交易を提案')));
  // 応答待ちの間は他のアクションが通らない
  assert.match(validateAction(s, { type: 'BUILD_ROAD', player: 0, edgeId: 'x' }), /応答待ち/);
});

test('1人だけ応じたらその場で成立する', () => {
  let s = finishSetup(createGame({ seed: 5, humanIndex: -1 }));
  s.turnFlags.rolled = true;
  clearHands(s);
  s.players[0].resources.wood = 2;
  s.players[2].resources.wheat = 1;

  s = offerAndReply(s, 0, { wood: 1 }, { wheat: 1 }, [2]);
  assert.equal(s.awaiting, null);
  assert.equal(s.players[0].resources.wood, 1);
  assert.equal(s.players[0].resources.wheat, 1);
  assert.equal(s.players[2].resources.wood, 1);
  assert.equal(s.players[2].resources.wheat, 0);
  assert.ok(s.log.some((l) => l.startsWith('🤝')));
});

test('複数が応じたら提案者が相手を選ぶ', () => {
  let s = finishSetup(createGame({ seed: 5, humanIndex: -1 }));
  s.turnFlags.rolled = true;
  clearHands(s);
  s.players[0].resources.wood = 2;
  s.players[1].resources.wheat = 1;
  s.players[3].resources.wheat = 1;

  s = offerAndReply(s, 0, { wood: 1 }, { wheat: 1 }, [1, 3]);
  assert.equal(s.awaiting.type, 'tradeChoose');
  assert.deepEqual(s.awaiting.players, [0]);
  assert.deepEqual(s.awaiting.context.accepted, [1, 3]);
  // まだ誰とも交換していない
  assert.equal(s.players[0].resources.wheat, 0);
  // 応じていない相手は選べない
  assert.match(validateAction(s, { type: 'CHOOSE_TRADE', player: 0, partner: 2 }), /応じていません/);

  s = dispatch(s, { type: 'CHOOSE_TRADE', player: 0, partner: 3 });
  assert.equal(s.awaiting, null);
  assert.equal(s.players[3].resources.wood, 1);
  assert.equal(s.players[1].resources.wheat, 1, '選ばれなかった相手の手札は動かない');
});

test('CHOOSE_TRADE: partner なしで全部取りやめられる', () => {
  let s = finishSetup(createGame({ seed: 5, humanIndex: -1 }));
  s.turnFlags.rolled = true;
  clearHands(s);
  s.players[0].resources.wood = 2;
  s.players[1].resources.wheat = 1;
  s.players[2].resources.wheat = 1;

  s = offerAndReply(s, 0, { wood: 1 }, { wheat: 1 }, [1, 2]);
  s = dispatch(s, { type: 'CHOOSE_TRADE', player: 0, partner: null });
  assert.equal(s.awaiting, null);
  assert.equal(s.players[0].resources.wood, 2, '手札が動いていない');
  assert.ok(s.log.some((l) => l.includes('取りやめ')));
});

test('誰も応じなければ不成立になり、提案者に待機がかかる', () => {
  let s = finishSetup(createGame({ seed: 5, humanIndex: -1 }));
  s.turnFlags.rolled = true;
  clearHands(s);
  s.players[0].resources.wood = 2;

  s = offerAndReply(s, 0, { wood: 1 }, { wheat: 1 }, []);
  assert.equal(s.awaiting, null);
  assert.equal(s.players[0].resources.wood, 2);
  assert.ok(s.players[0].offerCooldown > s.turn, '再提案の待機が設定されていない');
  assert.ok(s.log.some((l) => l.includes('誰も応じませんでした')));
});

test('提案は相手の手札に関係なく出せ、承諾だけが弾かれる', () => {
  let s = finishSetup(createGame({ seed: 5, humanIndex: -1 }));
  s.turnFlags.rolled = true;
  clearHands(s);
  s.players[0].resources.wood = 2; // 誰も小麦を持っていない
  const offer = { type: 'OFFER_TRADE', player: 0, give: { wood: 1 }, receive: { wheat: 1 } };

  assert.equal(validateAction(s, offer), null);
  s = dispatch(s, offer);
  // 出せない相手は承諾できない。理由は応答者から見た向きで返る
  assert.match(validateAction(s, { type: 'RESPOND_TRADE', player: 1, accept: true }), /^手札が足りません/);
  // 断ることはいつでもできる
  assert.equal(validateAction(s, { type: 'RESPOND_TRADE', player: 1, accept: false }), null);
});

test('提案の内容チェック: 自分の手札不足・空の提案・商品混在は弾かれる', () => {
  let s = finishSetup(createGame({ seed: 5, humanIndex: -1 }));
  s.turnFlags.rolled = true;
  clearHands(s);
  s.players[0].resources.wood = 1;
  assert.match(
    validateAction(s, { type: 'OFFER_TRADE', player: 0, give: { wood: 2 }, receive: { wheat: 1 } }),
    /手札が足りません/,
  );
  assert.match(
    validateAction(s, { type: 'OFFER_TRADE', player: 0, give: {}, receive: { wheat: 1 } }),
    /両方選んでください/,
  );
  // 基本モードでは商品を混ぜられない
  assert.match(
    validateAction(s, { type: 'OFFER_TRADE', player: 0, give: { cloth: 1 }, receive: { wood: 1 } }),
    /交易内容が不正/,
  );
});

test(`提案は1手番に${MAX_OFFERS_PER_TURN}回まで`, () => {
  let s = finishSetup(createGame({ seed: 5, humanIndex: -1 }));
  s.turnFlags.rolled = true;
  clearHands(s);
  s.players[0].resources.wood = 9;
  const offer = { type: 'OFFER_TRADE', player: 0, give: { wood: 1 }, receive: { wheat: 1 } };

  for (let i = 0; i < MAX_OFFERS_PER_TURN; i++) {
    assert.equal(validateAction(s, offer), null, `${i + 1}回目が通らない`);
    s = offerAndReply(s, 0, { wood: 1 }, { wheat: 1 }, []);
    s.players[0].offerCooldown = 0; // 待機はこのテストの対象外
  }
  assert.match(validateAction(s, offer), /1手番3回まで/);
  // 手番が変われば回数はリセットされる
  s.turnFlags = { rolled: true, playedDev: false };
  assert.equal(validateAction(s, offer), null);
});

test('cpuAcceptsTrade: 不足資源がもらえる得な取引は受け、不利な取引は断る', () => {
  const s = finishSetup(createGame({ seed: 7, humanIndex: -1 }));
  clearHands(s);
  const pid = 1;
  const goal = nextGoal(s, pid);
  const need = Object.keys(goal.cost)[0];
  const spare = RESOURCES.find((r) => r !== need);
  s.players[pid].resources[spare] = 4;

  assert.equal(cpuAcceptsTrade(s, pid, { [need]: 2 }, { [spare]: 1 }), true);
  assert.equal(cpuAcceptsTrade(s, pid, { [spare]: 1 }, { [need]: 1 }), false);
  // 出せないものは受けない
  assert.equal(cpuAcceptsTrade(s, pid, { [need]: 5 }, { [spare]: 9 }), false);
});

test('chooseAction: CPU は全員に提案し、受け手も応答を返す', () => {
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
  assert.equal(offer.partner, undefined, '一斉提案なので相手は指定しない');
  assert.deepEqual(offer.receive, { [missing]: 1 });
  s = dispatch(s, offer);
  assert.deepEqual(s.awaiting.players, [0, 2, 3]);

  // 提案を受けた側がCPUなら chooseAction が応答を返す
  assert.equal(chooseAction(s, 2).type, 'RESPOND_TRADE');
  // 提案した手番中は2回目を出さない(人間へのポップアップ連打を防ぐ)
  s = dispatch(s, { type: 'RESPOND_TRADE', player: 0, accept: false });
  s = dispatch(s, { type: 'RESPOND_TRADE', player: 2, accept: false });
  s = dispatch(s, { type: 'RESPOND_TRADE', player: 3, accept: false });
  assert.notEqual(chooseAction(s, 1)?.type, 'OFFER_TRADE');
});

test('chooseAction: 複数が応じたら CPU は選んで成立させる', () => {
  let s = finishSetup(createGame({ seed: 5, humanIndex: -1 }));
  s.turnFlags.rolled = true;
  clearHands(s);
  s.players[0].resources.wood = 2;
  s.players[1].resources.wheat = 1;
  s.players[2].resources.wheat = 1;

  s = offerAndReply(s, 0, { wood: 1 }, { wheat: 1 }, [1, 2]);
  assert.equal(s.awaiting.type, 'tradeChoose');
  const pick = chooseAction(s, 0);
  assert.equal(pick.type, 'CHOOSE_TRADE');
  assert.ok([1, 2].includes(pick.partner));
  s = dispatch(s, pick);
  assert.equal(s.awaiting, null);
  assert.ok(s.log.some((l) => l.startsWith('🤝')));
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
  assert.ok(offers > 0, '6ゲームで交易提案が一度も発生しなかった');
});
