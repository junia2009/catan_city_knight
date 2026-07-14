import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createGame, RESOURCES } from '../src/state.js';
import { dispatch, validateAction } from '../src/actions.js';
import { LAYOUT, TERRAIN_RESOURCE } from '../src/rules/board.js';
import { distributeForRoll } from '../src/rules/dice.js';
import { longestRoadLength, computePoints, updateLongestRoad } from '../src/rules/victory.js';
import { tradeRate } from '../src/rules/trade.js';
import { canPlaceSettlement, canPlaceRoad, totalResources } from '../src/rules/build.js';
import { chooseAction } from '../src/ai/cpu-player.js';

// セットアップを CPU ロジックで自動完了させる
function finishSetup(state) {
  while (state.phase === 'setup') {
    const pid = state.awaiting.players[0];
    state = dispatch(state, chooseAction(state, pid));
  }
  return state;
}

function give(state, pid, res) {
  for (const [r, n] of Object.entries(res)) {
    state.players[pid].resources[r] += n;
    state.bank.resources[r] -= n;
  }
}

test('初期配置: スネーク順で進み、2巡目に初期資源をもらう', () => {
  let s = createGame({ seed: 5, playerCount: 4, humanIndex: -1 });
  const order = [];
  while (s.phase === 'setup') {
    const pid = s.awaiting.players[0];
    order.push(pid);
    s = dispatch(s, chooseAction(s, pid));
  }
  assert.deepEqual(order, [0, 1, 2, 3, 3, 2, 1, 0]);
  assert.equal(s.phase, 'main');
  assert.equal(s.currentPlayer, 0);
  assert.equal(Object.keys(s.buildings).length, 8);
  assert.equal(Object.keys(s.roads).length, 8);
  // 2軒目の隣接ヘックス数(砂漠を除く)だけ資源を持っている
  for (const p of s.players) {
    assert.ok(totalResources(p) >= 1 && totalResources(p) <= 3, `${p.name}: ${totalResources(p)}`);
  }
});

test('距離ルール: 隣接頂点には建てられない', () => {
  let s = createGame({ seed: 5, humanIndex: -1 });
  const vid = Object.keys(LAYOUT.vertices)[10];
  s.buildings[vid] = { player: 1, type: 'settlement' };
  for (const adj of LAYOUT.vertexAdj[vid]) {
    assert.match(canPlaceSettlement(s, 0, adj, { needRoad: false }), /距離ルール/);
  }
});

test('道: 敵の建物を通しては接続できない', () => {
  let s = createGame({ seed: 5, humanIndex: -1 });
  // 頂点 v に敵(1)の建物、v の辺 e1 に自分(0)の道 → v の別の辺 e2 は不可
  const vid = Object.keys(LAYOUT.vertices).find((v) => LAYOUT.vertexEdges[v].length === 3);
  const [e1, e2] = LAYOUT.vertexEdges[vid];
  s.roads[e1] = { player: 0 };
  assert.equal(canPlaceRoad(s, 0, e2), null); // 空き頂点なら OK
  s.buildings[vid] = { player: 1, type: 'settlement' };
  assert.match(canPlaceRoad(s, 0, e2), /接続していません/);
});

test('資源分配: 開拓地1・都市2、盗賊ヘックスは無効', () => {
  let s = createGame({ seed: 5, humanIndex: -1 });
  const hid = LAYOUT.hexIds.find(
    (h) => s.board.hexes[h].token && h !== s.board.robber,
  );
  const hex = s.board.hexes[hid];
  const res = TERRAIN_RESOURCE[hex.terrain];
  const [v1, v2] = LAYOUT.hexVertices[hid];
  s.buildings[v1] = { player: 0, type: 'settlement' };
  s.buildings[v2] = { player: 1, type: 'city' };

  distributeForRoll(s, hex.token);
  assert.equal(s.players[0].resources[res], 1);
  assert.equal(s.players[1].resources[res], 2);

  // 盗賊を置くと分配なし
  s.board.robber = hid;
  distributeForRoll(s, hex.token);
  assert.equal(s.players[0].resources[res], 1);
  assert.equal(s.players[1].resources[res], 2);
});

test('資源分配: 銀行在庫不足で複数人需要なら誰ももらえない', () => {
  let s = createGame({ seed: 5, humanIndex: -1 });
  const hid = LAYOUT.hexIds.find((h) => s.board.hexes[h].token && h !== s.board.robber);
  const hex = s.board.hexes[hid];
  const res = TERRAIN_RESOURCE[hex.terrain];
  const [v1, v2] = LAYOUT.hexVertices[hid];
  s.buildings[v1] = { player: 0, type: 'settlement' };
  s.buildings[v2] = { player: 1, type: 'settlement' };
  s.bank.resources[res] = 1;
  distributeForRoll(s, hex.token);
  assert.equal(s.players[0].resources[res], 0);
  assert.equal(s.players[1].resources[res], 0);

  // 1人だけなら在庫分もらえる
  delete s.buildings[v2];
  s.buildings[v1] = { player: 0, type: 'city' }; // 需要2、在庫1
  distributeForRoll(s, hex.token);
  assert.equal(s.players[0].resources[res], 1);
});

test('捨て札: 8枚以上で半分(切り捨て)を要求される', () => {
  let s = finishSetup(createGame({ seed: 5, humanIndex: -1 }));
  // player1 に 9枚持たせる
  const p1 = s.players[1];
  for (const r of RESOURCES) { s.bank.resources[r] += p1.resources[r]; p1.resources[r] = 0; }
  give(s, 1, { wood: 5, brick: 4 });
  // 7ロール相当の awaiting を直接構築して DISCARD を検証
  s.awaiting = { type: 'discard', players: [1], context: { required: { 1: 4 } } };
  assert.match(
    validateAction(s, { type: 'DISCARD', player: 1, resources: { wood: 3 } }),
    /ちょうど4枚/,
  );
  s = dispatch(s, { type: 'DISCARD', player: 1, resources: { wood: 3, brick: 1 } });
  assert.equal(totalResources(s.players[1]), 5);
  // 全員捨て終わったら盗賊移動待ちへ
  assert.equal(s.awaiting.type, 'moveRobber');
  assert.deepEqual(s.awaiting.players, [s.currentPlayer]);
});

test('盗賊: 移動と略奪、奪える相手がいないときは target なし', () => {
  let s = finishSetup(createGame({ seed: 5, humanIndex: -1 }));
  s.awaiting = { type: 'moveRobber', players: [0], context: {} };
  // 誰の建物もないヘックス(あれば)へ移動 → target 不要
  const emptyHex = LAYOUT.hexIds.find(
    (h) =>
      h !== s.board.robber &&
      LAYOUT.hexVertices[h].every((v) => !s.buildings[v]),
  );
  if (emptyHex) {
    const s2 = dispatch(s, { type: 'MOVE_ROBBER', player: 0, hexId: emptyHex, targetPlayer: null });
    assert.equal(s2.board.robber, emptyHex);
    assert.equal(s2.awaiting, null);
  }
  // 相手の建物があるヘックスへは target 必須
  const targetHex = LAYOUT.hexIds.find(
    (h) =>
      h !== s.board.robber &&
      LAYOUT.hexVertices[h].some(
        (v) => s.buildings[v] && s.buildings[v].player !== 0 &&
          totalResources(s.players[s.buildings[v].player]) > 0,
      ),
  );
  assert.ok(targetHex);
  assert.match(
    validateAction(s, { type: 'MOVE_ROBBER', player: 0, hexId: targetHex, targetPlayer: null }),
    /略奪する相手/,
  );
});

test('建設コストと銀行への支払い', () => {
  let s = finishSetup(createGame({ seed: 5, humanIndex: -1 }));
  s.turnFlags.rolled = true;
  const pid = 0;
  const eid = Object.keys(LAYOUT.edges).find((e) => canPlaceRoad(s, pid, e) === null);
  assert.ok(eid);
  // 資源ゼロでは建てられない
  for (const r of RESOURCES) { s.bank.resources[r] += s.players[pid].resources[r]; s.players[pid].resources[r] = 0; }
  assert.match(validateAction(s, { type: 'BUILD_ROAD', player: pid, edgeId: eid }), /資源が足りません/);
  give(s, pid, { wood: 1, brick: 1 });
  const bankWood = s.bank.resources.wood;
  s = dispatch(s, { type: 'BUILD_ROAD', player: pid, edgeId: eid });
  assert.equal(s.players[pid].resources.wood, 0);
  assert.equal(s.bank.resources.wood, bankWood + 1);
  assert.equal(s.roads[eid].player, pid);
});

test('交易レート: 4:1 / 3:1港 / 2:1専用港', () => {
  let s = createGame({ seed: 5, humanIndex: -1 });
  assert.equal(tradeRate(s, 0, 'wood'), 4);
  const port31 = s.board.ports.find((p) => p.type === '3:1');
  const portWood = s.board.ports.find((p) => p.type === 'wood');
  s.buildings[LAYOUT.edges[port31.edgeId].v[0]] = { player: 0, type: 'settlement' };
  assert.equal(tradeRate(s, 0, 'wood'), 3);
  s.buildings[LAYOUT.edges[portWood.edgeId].v[0]] = { player: 0, type: 'settlement' };
  assert.equal(tradeRate(s, 0, 'wood'), 2);
  assert.equal(tradeRate(s, 0, 'brick'), 3);
});

test('最長交易路: 直線・分岐・敵建物による分断', () => {
  let s = createGame({ seed: 5, humanIndex: -1 });
  // 中央ヘックスの外周をなぞる5本の道
  const hid = '0,0';
  const corners = LAYOUT.hexVertices[hid];
  const edges = [];
  for (let i = 0; i < 5; i++) {
    const eid = LAYOUT.vertexEdges[corners[i]].find((e) =>
      LAYOUT.edges[e].v.includes(corners[(i + 1) % 6]),
    );
    edges.push(eid);
  }
  for (const e of edges) s.roads[e] = { player: 0 };
  assert.equal(longestRoadLength(s, 0), 5);

  // 分岐を足しても最長は変わらないか伸びる
  const branch = LAYOUT.vertexEdges[corners[2]].find((e) => !s.roads[e]);
  s.roads[branch] = { player: 0 };
  assert.ok(longestRoadLength(s, 0) >= 5);

  // 中間頂点に敵の建物 → 分断される
  s.buildings[corners[2]] = { player: 1, type: 'settlement' };
  assert.ok(longestRoadLength(s, 0) < 5);

  // 更新ロジック: 5本以上で保持者になる
  delete s.buildings[corners[2]];
  updateLongestRoad(s);
  assert.equal(s.longestRoad.player, 0);
  assert.ok(s.longestRoad.length >= 5);
});

test('勝利点: 開拓地1・都市2・ボーナス2', () => {
  let s = createGame({ seed: 5, humanIndex: -1 });
  const vids = Object.keys(LAYOUT.vertices);
  s.buildings[vids[0]] = { player: 0, type: 'settlement' };
  s.buildings[vids[5]] = { player: 0, type: 'city' };
  assert.equal(computePoints(s, 0), 3);
  s.longestRoad = { player: 0, length: 5 };
  s.largestArmy = { player: 0, count: 3 };
  assert.equal(computePoints(s, 0), 7);
  s.players[0].devCards.push({ type: 'vp', boughtTurn: 1 });
  assert.equal(computePoints(s, 0), 7);
  assert.equal(computePoints(s, 0, { includeHidden: true }), 8);
});

test('発展カード: 購入ターンには使えない/1ターン1枚', () => {
  let s = finishSetup(createGame({ seed: 5, humanIndex: -1 }));
  s.turnFlags.rolled = true;
  s.players[0].devCards.push({ type: 'knight', boughtTurn: s.turn });
  assert.match(
    validateAction(s, { type: 'PLAY_DEV_CARD', player: 0, card: 'knight' }),
    /購入したターン/,
  );
  s.players[0].devCards[s.players[0].devCards.length - 1].boughtTurn = s.turn - 1;
  s = dispatch(s, { type: 'PLAY_DEV_CARD', player: 0, card: 'knight' });
  assert.equal(s.awaiting.type, 'moveRobber');
  assert.equal(s.players[0].knightsPlayed, 1);
});

test('独占: 全員から指定資源を回収する', () => {
  let s = finishSetup(createGame({ seed: 5, humanIndex: -1 }));
  s.turnFlags.rolled = true;
  for (const p of s.players) for (const r of RESOURCES) { s.bank.resources[r] += p.resources[r]; p.resources[r] = 0; }
  give(s, 1, { wheat: 3 });
  give(s, 2, { wheat: 2 });
  s.players[0].devCards.push({ type: 'monopoly', boughtTurn: 0 });
  s = dispatch(s, {
    type: 'PLAY_DEV_CARD', player: 0, card: 'monopoly', params: { resource: 'wheat' },
  });
  assert.equal(s.players[0].resources.wheat, 5);
  assert.equal(s.players[1].resources.wheat, 0);
  assert.equal(s.players[2].resources.wheat, 0);
});

test('awaiting 中は通常アクションが拒否される', () => {
  let s = finishSetup(createGame({ seed: 5, humanIndex: -1 }));
  s.awaiting = { type: 'discard', players: [1], context: { required: { 1: 4 } } };
  assert.ok(validateAction(s, { type: 'ROLL_DICE', player: 0 }));
  assert.ok(validateAction(s, { type: 'END_TURN', player: 0 }));
});
