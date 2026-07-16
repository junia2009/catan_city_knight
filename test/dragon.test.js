// ドラゴンの島(独自ルール第3弾)のテスト

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createGame, RESOURCES } from '../src/state.js';
import { dispatch, validateAction } from '../src/actions.js';
import { chooseAction } from '../src/ai/cpu-player.js';
import { LAYOUT, PIPS } from '../src/rules/board.js';
import { pointsToWin, computePoints } from '../src/rules/victory.js';
import {
  dragonNestHex, rampageTarget, resolveRampage, isBurning, canBuildTower, MAX_TOWERS,
} from '../src/rules/dragon.js';
import { distributeForRoll } from '../src/rules/dice.js';

function newDragon(seed = 5) {
  return createGame({ seed, playerCount: 4, humanIndex: -1, mode: 'dragon' });
}

function finishSetup(state) {
  while (state.phase === 'setup') {
    const pid = state.awaiting.players[0];
    state = dispatch(state, chooseAction(state, pid));
  }
  return state;
}

test('dragon: ドラゴンは最も出目の良い山ヘックスの巣から始まる', () => {
  const s = newDragon();
  assert.equal(s.board.robber, s.dragon.nestHex);
  const hex = s.board.hexes[s.dragon.nestHex];
  assert.equal(hex.terrain, 'mountain');
  // 他のどの山よりも pips が大きい(以上)
  for (const hid of LAYOUT.hexIds) {
    const h = s.board.hexes[hid];
    if (h.terrain === 'mountain' && h.token) {
      assert.ok(PIPS[hex.token] >= PIPS[h.token]);
    }
  }
  assert.equal(pointsToWin(s), 12);
});

test('dragon: 暴走は最も稼ぐヘックスを炎上させ、隣接プレイヤーから1枚焼く', () => {
  let s = finishSetup(newDragon());
  s.turnFlags.rolled = true;
  const target = rampageTarget(s);
  assert.ok(target);
  // 対象は建物が隣接する土地ヘックス
  assert.ok(LAYOUT.hexVertices[target].some((v) => s.buildings[v]));

  const victims = new Set();
  for (const vid of LAYOUT.hexVertices[target]) {
    if (s.buildings[vid]) victims.add(s.buildings[vid].player);
  }
  const before = [...victims].map((pid) =>
    RESOURCES.reduce((a, r) => a + s.players[pid].resources[r], 0));

  resolveRampage(s);
  assert.equal(s.board.robber, target);
  assert.ok(isBurning(s, target));
  const after = [...victims].map((pid) =>
    RESOURCES.reduce((a, r) => a + s.players[pid].resources[r], 0));
  for (let i = 0; i < before.length; i++) {
    // 手札があった被害者は1枚失う(0枚なら変化なし)
    assert.ok(after[i] === Math.max(0, before[i] - 1));
  }
  // 保存則
  for (const r of RESOURCES) {
    const total = s.bank.resources[r] + s.players.reduce((a, p) => a + p.resources[r], 0);
    assert.equal(total, 19);
  }
});

test('dragon: 炎上中のヘックスは産出しない', () => {
  let s = finishSetup(newDragon());
  // 建物が隣接するヘックスを1つ選んで炎上させる
  const hid = LAYOUT.hexIds.find(
    (h) => s.board.hexes[h].token && h !== s.board.robber &&
      LAYOUT.hexVertices[h].some((v) => s.buildings[v]),
  );
  const token = s.board.hexes[hid].token;
  const owner = s.buildings[LAYOUT.hexVertices[hid].find((v) => s.buildings[v])].player;

  const roll = (st) => {
    const before = RESOURCES.reduce((a, r) => a + st.players[owner].resources[r], 0);
    distributeForRoll(st, token);
    return RESOURCES.reduce((a, r) => a + st.players[owner].resources[r], 0) - before;
  };
  const normal = roll(structuredClone(s));
  const burnedState = structuredClone(s);
  burnedState.burned[hid] = burnedState.turn + 8;
  const burned = roll(burnedState);
  assert.ok(normal >= 1);
  // 同じ出目の別ヘックスからの産出はあり得るが、炎上分は確実に減る
  assert.ok(burned < normal);
});

test('dragon: 見張り塔は自分の建物の上に2基まで、撃退で財宝+1点', () => {
  let s = finishSetup(newDragon());
  s.turnFlags.rolled = true;
  s.currentPlayer = 0;
  const myVids = Object.keys(s.buildings).filter((v) => s.buildings[v].player === 0);
  assert.equal(canBuildTower(s, 0, myVids[0]), null);
  // 他人の建物には建てられない
  const otherVid = Object.keys(s.buildings).find((v) => s.buildings[v].player !== 0);
  assert.notEqual(canBuildTower(s, 0, otherVid), null);

  // 資源を与えて建設アクション
  s.players[0].resources.wood += 1; s.bank.resources.wood -= 1;
  s.players[0].resources.brick += 1; s.bank.resources.brick -= 1;
  s.players[0].resources.ore += 1; s.bank.resources.ore -= 1;
  s = dispatch(s, { type: 'BUILD_TOWER', player: 0, vertexId: myVids[0] });
  assert.equal(s.towers[myVids[0]], 0);

  // 塔の隣接ヘックスを暴走の対象にすると財宝を得る(略奪されない)
  const protectedHex = LAYOUT.vertexHexes[myVids[0]].find(
    (h) => s.board.hexes[h].token && h !== s.board.robber && !isBurning(s, h),
  );
  if (protectedHex) {
    // rampageTarget が protectedHex を選ぶよう、他の建物を無視して直接検証する
    const s2 = structuredClone(s);
    // 対象ヘックスの重みを最大化: 他ヘックスの建物を除去
    for (const vid of Object.keys(s2.buildings)) {
      if (!LAYOUT.vertexHexes[vid].includes(protectedHex)) delete s2.buildings[vid];
    }
    const before = computePoints(s2, 0);
    const t0 = s2.players[0].treasures;
    resolveRampage(s2);
    if (s2.board.robber === protectedHex) {
      assert.equal(s2.players[0].treasures, t0 + 1);
      assert.equal(computePoints(s2, 0), before + 1); // 財宝=+1点
    }
  }

  // 上限2基
  s.players[0].resources.wood += 4; s.bank.resources.wood -= 4;
  s.players[0].resources.brick += 4; s.bank.resources.brick -= 4;
  s.players[0].resources.ore += 4; s.bank.resources.ore -= 4;
  if (myVids[1]) {
    s = dispatch(s, { type: 'BUILD_TOWER', player: 0, vertexId: myVids[1] });
    // 3基目は不可(建物が足りない場合はスキップ)
    const third = Object.keys(s.buildings).find(
      (v) => s.buildings[v].player === 0 && s.towers[v] == null,
    );
    if (third) {
      assert.match(
        validateAction(s, { type: 'BUILD_TOWER', player: 0, vertexId: third }),
        new RegExp(`${MAX_TOWERS}基まで`),
      );
    }
  }
});

test('dragon: ゾロ目のロールで暴走が起きる(錬金術なしの直接検証)', () => {
  let s = finishSetup(newDragon());
  // 出目を固定するために turnFlags.alchemist を利用(cak専用だがロール適用は共通)
  s.turnFlags.alchemist = [4, 4];
  const burnsBefore = Object.keys(s.burned).length;
  s = dispatch(s, { type: 'ROLL_DICE', player: s.currentPlayer });
  assert.ok(
    Object.keys(s.burned).length > burnsBefore ||
      s.log.some((l) => l.includes('巣へ帰りました')),
  );
});

test('dragon: セルフプレイ30ゲーム完走・保存則・財宝が勝敗に寄与', () => {
  let treasures = 0;
  for (let seed = 700; seed < 730; seed++) {
    let state = newDragon(seed);
    let n = 0;
    while (state.phase !== 'ended') {
      if (++n > 15000) throw new Error(`seed=${seed}: 無限ループ`);
      const pid = state.awaiting ? state.awaiting.players[0] : state.currentPlayer;
      state = dispatch(state, chooseAction(state, pid));
    }
    treasures += state.players.reduce((a, p) => a + p.treasures, 0);
    const winPts = computePoints(state, state.winner, { includeHidden: true });
    assert.ok(winPts >= 12, `seed=${seed}: 勝者が12点未満(${winPts})`);
    for (const r of RESOURCES) {
      const total = state.bank.resources[r] + state.players.reduce((a, p) => a + p.resources[r], 0);
      assert.equal(total, 19, `seed=${seed}: ${r}保存則`);
    }
  }
  assert.ok(treasures > 0, '30ゲームで財宝が一度も獲得されなかった');
});
