// 漁師たち(公式の小拡張)のテスト

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createGame, RESOURCES } from '../src/state.js';
import { dispatch, validateAction } from '../src/actions.js';
import { chooseAction } from '../src/ai/cpu-player.js';
import { LAYOUT, LAKE_NUMBERS, FISHERY_NUMBERS, coastalEdgesOf } from '../src/rules/board.js';
import { computePoints, pointsToWin } from '../src/rules/victory.js';
import {
  FISH_POOL, FISH_USES, drawFish, fishCount, fishGainForRoll, hasOldShoe, payFish, shoeTargets,
} from '../src/rules/fish.js';

function newFish(seed = 3) {
  return createGame({ seed, playerCount: 4, humanIndex: -1, mode: 'fish' });
}

function finishSetup(state) {
  while (state.phase === 'setup') {
    state = dispatch(state, chooseAction(state, state.awaiting.players[0]));
  }
  return state;
}

// ロール済み・割り込みなしの手番を作る(魚の使用を試すため)
function readyTurn(state, pid = 0) {
  const s = structuredClone(state);
  s.currentPlayer = pid;
  s.awaiting = null;
  s.turnFlags = { rolled: true, playedDev: false };
  return s;
}

test('fish: 砂漠が湖に置き換わり、漁場が6か所できる', () => {
  const s = newFish();
  const lakes = s.board.hexIds.filter((h) => s.board.hexes[h].terrain === 'lake');
  assert.equal(lakes.length, 1);
  assert.equal(s.board.lake, lakes[0]);
  assert.equal(s.board.robber, s.board.lake); // 盗賊の初期位置は湖のまま
  assert.equal(s.board.hexIds.filter((h) => s.board.hexes[h].terrain === 'desert').length, 0);

  assert.equal(s.board.fisheries.length, FISHERY_NUMBERS.length);
  assert.deepEqual(
    s.board.fisheries.map((f) => f.number).sort((a, b) => a - b),
    [...FISHERY_NUMBERS].sort((a, b) => a - b),
  );
  // 漁場は港と重ならない海岸辺
  const portEdges = new Set(s.board.ports.map((p) => p.edgeId));
  for (const f of s.board.fisheries) {
    assert.ok(coastalEdgesOf(s.board).includes(f.edgeId), '漁場が海岸辺にない');
    assert.ok(!portEdges.has(f.edgeId), '漁場が港と重なっている');
  }
});

test('fish: 基本モードでは湖も漁場も魚の山もできない', () => {
  const s = createGame({ seed: 3, playerCount: 4, humanIndex: -1 });
  assert.equal(s.board.lake, undefined);
  assert.equal(s.board.fisheries, undefined);
  assert.equal(s.bank.fishPool, null);
  assert.equal(s.board.hexIds.filter((h) => s.board.hexes[h].terrain === 'lake').length, 0);
});

test('fish: 魚トークンの山は30枚で古い靴は1枚だけ', () => {
  assert.equal(FISH_POOL.length, 30);
  assert.equal(FISH_POOL.filter((t) => t === 'shoe').length, 1);
  const s = newFish();
  assert.equal(s.bank.fishPool.length, 30);
});

test('fish: 開拓地は1枚・都市は2枚、盗賊が湖にいると産まない', () => {
  const s = newFish();
  const lake = s.board.lake;
  const [v1, v2] = LAYOUT.hexVertices[lake];
  s.buildings[v1] = { player: 0, type: 'settlement' };
  s.buildings[v2] = { player: 1, type: 'city' };
  s.board.robber = s.board.hexIds.find((h) => h !== lake);

  const gains = fishGainForRoll(s, LAKE_NUMBERS[0]);
  assert.equal(gains[0], 1);
  assert.equal(gains[1], 2);

  // 出目が湖の数字でなければ産まない
  assert.deepEqual(fishGainForRoll(s, 7), {});
  // 盗賊が湖にいると止まる
  s.board.robber = lake;
  assert.deepEqual(fishGainForRoll(s, LAKE_NUMBERS[0]), {});
});

test('fish: 漁場は接する両端の建物に魚を配る', () => {
  const s = newFish();
  const f = s.board.fisheries[0];
  const [a, b] = LAYOUT.edges[f.edgeId].v;
  s.buildings[a] = { player: 2, type: 'city' };
  s.buildings[b] = { player: 3, type: 'settlement' };
  const gains = fishGainForRoll(s, f.number);
  assert.equal(gains[2], 2);
  assert.equal(gains[3], 1);
});

test('fish: ロールで魚が配られる', () => {
  let s = finishSetup(newFish());
  const lake = s.board.lake;
  s = structuredClone(s);
  s.board.robber = s.board.hexIds.find((h) => h !== lake);
  s.currentPlayer = 0;
  s.awaiting = null;
  s.turnFlags = { rolled: false, playedDev: false };
  // 湖に隣接する開拓地を1つ用意して、湖の出目を狙って振る
  const vid = LAYOUT.hexVertices[lake].find((v) => !s.buildings[v]);
  s.buildings[vid] = { player: 0, type: 'settlement' };
  const total = LAKE_NUMBERS.find((n) => n <= 6 || n >= 8);
  // どちらも1〜6になる組にする(錬金術師と同じ検証を通る形)
  s.turnFlags.alchemist = [Math.max(1, total - 6), total - Math.max(1, total - 6)];

  const after = dispatch(s, { type: 'ROLL_DICE', player: 0 });
  assert.equal(after.players[0].fish.length, 1);
  assert.equal(after.bank.fishPool.length, 29);
});

test('fish: payFish は無駄が最小になるように払い、お釣りは出ない', () => {
  const p = { fish: [3, 1, 2] };
  assert.equal(payFish(p, 4), true); // 3 + 1 = 4(ちょうど払える)
  assert.deepEqual(p.fish, [2]);

  const q = { fish: [3, 'shoe'] };
  assert.equal(payFish(q, 2), true); // 3匹しかないので1匹ぶんは捨てる
  assert.deepEqual(q.fish, ['shoe']); // 古い靴は支払いに使われない

  const r = { fish: [1, 1] };
  assert.equal(payFish(r, 5), false);
  assert.deepEqual(r.fish, [1, 1], '払えないときは減らさない');
});

test('fish: fishCount は古い靴を0匹として数える', () => {
  assert.equal(fishCount({ fish: [1, 2, 'shoe', 3] }), 6);
  assert.equal(fishCount({ fish: [] }), 0);
  assert.equal(fishCount({}), 0);
});

test('fish: 2匹で盗賊を湖へ戻す', () => {
  let s = readyTurn(finishSetup(newFish()));
  s.board.robber = s.board.hexIds.find((h) => h !== s.board.lake);
  s.players[0].fish = [2, 2];
  s = dispatch(s, { type: 'SPEND_FISH', player: 0, use: 'robber' });
  assert.equal(s.board.robber, s.board.lake);
  assert.equal(fishCount(s.players[0]), 2);
  // すでに湖にいるなら使えない
  assert.match(
    validateAction(s, { type: 'SPEND_FISH', player: 0, use: 'robber' }),
    /すでに湖/,
  );
});

test('fish: 盗賊を戻すのはロール前でも使える(他の使い道は不可)', () => {
  const s = readyTurn(finishSetup(newFish()));
  s.turnFlags.rolled = false;
  s.board.robber = s.board.hexIds.find((h) => h !== s.board.lake);
  s.players[0].fish = [3, 3, 3];
  assert.equal(validateAction(s, { type: 'SPEND_FISH', player: 0, use: 'robber' }), null);
  assert.match(
    validateAction(s, { type: 'SPEND_FISH', player: 0, use: 'steal', params: { target: 1 } }),
    /ダイスを振って/,
  );
});

test('fish: 3匹で資源を1枚奪う', () => {
  let s = readyTurn(finishSetup(newFish()));
  s.players[0].fish = [3];
  for (const p of s.players) p.resources = { wood: 0, brick: 0, sheep: 0, wheat: 0, ore: 0 };
  s.players[1].resources.wheat = 2;
  s = dispatch(s, { type: 'SPEND_FISH', player: 0, use: 'steal', params: { target: 1 } });
  assert.equal(s.players[0].resources.wheat, 1);
  assert.equal(s.players[1].resources.wheat, 1);
  assert.equal(fishCount(s.players[0]), 0);
});

test('fish: 手札のない相手からは奪えない', () => {
  const s = readyTurn(finishSetup(newFish()));
  s.players[0].fish = [3];
  for (const p of s.players) p.resources = { wood: 0, brick: 0, sheep: 0, wheat: 0, ore: 0 };
  assert.match(
    validateAction(s, { type: 'SPEND_FISH', player: 0, use: 'steal', params: { target: 1 } }),
    /手札を持っていません/,
  );
});

test('fish: 4匹で好きな資源、5匹で道、7匹で発展カード', () => {
  let s = readyTurn(finishSetup(newFish()));
  s.players[0].fish = [2, 2];
  const wood = s.players[0].resources.wood;
  s = dispatch(s, { type: 'SPEND_FISH', player: 0, use: 'resource', params: { resource: 'wood' } });
  assert.equal(s.players[0].resources.wood, wood + 1);

  s.players[0].fish = [3, 2];
  const eid = Object.keys(LAYOUT.edges).find(
    (e) => validateAction(s, {
      type: 'SPEND_FISH', player: 0, use: 'road', params: { edgeId: e },
    }) === null,
  );
  assert.ok(eid, '無料で建てられる辺がある');
  const roads = Object.keys(s.roads).length;
  s = dispatch(s, { type: 'SPEND_FISH', player: 0, use: 'road', params: { edgeId: eid } });
  assert.equal(Object.keys(s.roads).length, roads + 1);
  assert.equal(s.roads[eid].player, 0);

  s.players[0].fish = [3, 3, 3];
  const dev = s.players[0].devCards.length;
  const deck = s.bank.devDeck.length;
  s = dispatch(s, { type: 'SPEND_FISH', player: 0, use: 'dev' });
  assert.equal(s.players[0].devCards.length, dev + 1);
  assert.equal(s.bank.devDeck.length, deck - 1);
  assert.equal(fishCount(s.players[0]), 0); // 3匹札3枚で9匹ぶん払う。お釣りは出ない
});

test('fish: 魚が足りなければ使えない', () => {
  const s = readyTurn(finishSetup(newFish()));
  s.players[0].fish = [2, 2];
  assert.match(
    validateAction(s, { type: 'SPEND_FISH', player: 0, use: 'dev' }),
    new RegExp(`${FISH_USES.dev.cost}匹必要`),
  );
});

test('fish: 漁師たち以外のモードでは魚を使えない', () => {
  const s = readyTurn(finishSetup(createGame({ seed: 3, playerCount: 4, humanIndex: -1 })));
  s.players[0].fish = [3, 3, 3];
  assert.match(
    validateAction(s, { type: 'SPEND_FISH', player: 0, use: 'dev' }),
    /漁師たち/,
  );
});

test('fish: 古い靴を持っている間は勝利に必要な点数が1点増える', () => {
  const s = newFish();
  assert.equal(pointsToWin(s, 0), 10);
  s.players[0].fish = ['shoe'];
  assert.equal(pointsToWin(s, 0), 11);
  assert.equal(pointsToWin(s, 1), 10);
  assert.equal(pointsToWin(s), 10); // pid なしは素の目標点
});

test('fish: 古い靴は自分と同点以上の相手にだけ渡せる', () => {
  let s = readyTurn(finishSetup(newFish()));
  s.players[0].fish = ['shoe'];
  // 0 と 1 は同点、2 を1点上、3 を1点下にする
  s.buildings = {};
  const verts = Object.keys(LAYOUT.vertices);
  s.buildings[verts[0]] = { player: 0, type: 'settlement' };
  s.buildings[verts[10]] = { player: 1, type: 'settlement' };
  s.buildings[verts[20]] = { player: 2, type: 'city' };
  s.longestRoad = { player: null, length: 0 };

  const pts = (id) => computePoints(s, id);
  assert.deepEqual(shoeTargets(s, 0, pts).sort(), [1, 2]);
  assert.match(validateAction(s, { type: 'PASS_SHOE', player: 0, target: 3 }), /同点以上/);

  s = dispatch(s, { type: 'PASS_SHOE', player: 0, target: 1 });
  assert.equal(hasOldShoe(s.players[0]), false);
  assert.equal(hasOldShoe(s.players[1]), true);
  assert.match(validateAction(s, { type: 'PASS_SHOE', player: 0, target: 1 }), /持っていません/);
});

test('fish: 古い靴を持っていると規定点に届いても勝てない', () => {
  let s = readyTurn(finishSetup(newFish()));
  s.buildings = {};
  const verts = Object.keys(LAYOUT.vertices);
  // 都市5つで10点
  for (let i = 0; i < 5; i++) s.buildings[verts[i * 4]] = { player: 0, type: 'city' };
  s.longestRoad = { player: null, length: 0 };
  s.players[0].fish = ['shoe'];
  s.players[0].devCards = [];
  assert.equal(computePoints(s, 0, { includeHidden: true }), 10);

  s = dispatch(s, { type: 'END_TURN', player: 0 });
  assert.equal(s.winner, null, '靴を持っている間は10点でも勝てない');

  // 同点の相手に押しつければ勝てる
  s = readyTurn(s, 0);
  s.buildings[verts[40]] = { player: 1, type: 'city' };
  s.buildings[verts[44]] = { player: 1, type: 'city' };
  s.buildings[verts[48]] = { player: 1, type: 'city' };
  s.buildings[verts[52]] = { player: 1, type: 'city' };
  s.buildings[verts[56]] = { player: 1, type: 'city' };
  s = dispatch(s, { type: 'PASS_SHOE', player: 0, target: 1 });
  assert.equal(s.winner, 0);
});

test('fish: 古い靴は同時に1枚しか場に出ない', () => {
  let s = finishSetup(newFish());
  s = structuredClone(s);
  s.players[1].fish = ['shoe'];
  // 山札の一番上を靴にしても、すでに誰かが持っていれば引かれない
  s.bank.fishPool = ['shoe', 1, 2];
  s.board.robber = s.board.hexIds.find((h) => h !== s.board.lake);
  s.currentPlayer = 0;
  s.awaiting = null;
  s.turnFlags = { rolled: false, playedDev: false };
  const vid = LAYOUT.hexVertices[s.board.lake].find((v) => !s.buildings[v]);
  s.buildings[vid] = { player: 0, type: 'settlement' };
  s.turnFlags.alchemist = [Math.max(1, LAKE_NUMBERS[0] - 6), LAKE_NUMBERS[0] - Math.max(1, LAKE_NUMBERS[0] - 6)];

  const after = dispatch(s, { type: 'ROLL_DICE', player: 0 });
  assert.equal(hasOldShoe(after.players[0]), false);
  assert.equal(after.players[0].fish.length, 1);
  assert.equal(after.players.filter((p) => hasOldShoe(p)).length, 1);
});

test('fish: 山札が古い靴だけになっても引ける(切り直す)', () => {
  const s = newFish();
  s.players[1].fish = ['shoe'];
  s.bank.fishPool = ['shoe']; // 誰かが持っている靴しか残っていない状態
  const drawn = drawFish(s, 0, 3);
  assert.equal(drawn.length, 3);
  assert.ok(drawn.every((t) => t !== 'shoe'), '靴は引かれない');
  assert.ok(s.bank.fishPool.length > 0, '切り直されている');
  assert.equal(s.players.filter((p) => hasOldShoe(p)).length, 1);
});

test('fish: 山札を引き切っても切り直して配り続けられる', () => {
  const s = newFish();
  const drawn = drawFish(s, 0, 40); // 山は30枚
  assert.equal(drawn.length, 40);
  assert.ok(drawn.filter((t) => t === 'shoe').length <= 1, '靴は1枚まで');
});

test('fish: セルフプレイ10ゲームが完走し、保存則と勝利条件が成り立つ', () => {
  for (let seed = 1; seed <= 10; seed++) {
    let s = createGame({ seed, playerCount: 4, humanIndex: -1, mode: 'fish' });
    let n = 0;
    while (s.phase !== 'ended') {
      assert.ok(++n < 6000, `seed=${seed}: 無限ループの疑い`);
      const pid = s.awaiting ? s.awaiting.players[0] : s.currentPlayer;
      const action = chooseAction(s, pid);
      assert.ok(action, `seed=${seed}: CPU${pid} が手を返さなかった`);
      s = dispatch(s, action);
    }
    for (const r of RESOURCES) {
      const total = s.bank.resources[r] + s.players.reduce((a, p) => a + p.resources[r], 0);
      assert.equal(total, 19, `seed=${seed}: ${r} の総数が ${total}`);
    }
    // 古い靴は増殖しない
    assert.ok(s.players.filter((p) => hasOldShoe(p)).length <= 1);
    const w = s.winner;
    assert.ok(computePoints(s, w, { includeHidden: true }) >= pointsToWin(s, w));
  }
});
