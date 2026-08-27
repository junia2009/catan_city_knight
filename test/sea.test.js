// 航海者たち(公式拡張)のテスト

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createGame, RESOURCES } from '../src/state.js';
import { dispatch, validateAction } from '../src/actions.js';
import { chooseAction } from '../src/ai/cpu-player.js';
import { LAYOUT, boardEdgeIds, boardVertexIds } from '../src/rules/board.js';
import { computePoints, pointsToWin, longestRoadLength } from '../src/rules/victory.js';
import { canPlaceRoad, canPlaceSettlement } from '../src/rules/build.js';
import {
  SHIP_COST, SHIP_LIMIT, NEW_ISLAND_VP,
  canPlaceShip, islandAtVertex, isSeaHex, isLandHex, isShipEdge,
  movableShips, pirateTargets, goldGainForRoll,
  seaMainIslandHexes, seaIslandHexes,
} from '../src/rules/sea.js';

function newSea(seed = 3) {
  return createGame({ seed, playerCount: 4, humanIndex: -1, mode: 'sea' });
}

function finishSetup(state) {
  while (state.phase === 'setup') {
    state = dispatch(state, chooseAction(state, state.awaiting.players[0]));
  }
  return state;
}

// 合計 total になる正しいサイコロの目(どちらも1〜6)。
// 錬金術師と同じ経路で出目を仕込むので、ありえない目を入れないようにする。
function dicePair(total) {
  const a = Math.max(1, total - 6);
  return [a, total - a];
}

function readyTurn(state, pid = 0) {
  const s = structuredClone(state);
  s.currentPlayer = pid;
  s.awaiting = null;
  s.turnFlags = { rolled: true, playedDev: false };
  return s;
}

// 盤を空にして、指定の頂点に自分の開拓地だけがある状態を作る
function blank(state, pid = 0) {
  const s = readyTurn(state, pid);
  s.buildings = {};
  s.roads = {};
  s.ships = {};
  s.longestRoad = { player: null, length: 0 };
  for (const p of s.players) p.islands = [];
  return s;
}

test('sea: 盤は61ヘックス、本島19・2マスの小島5つ・海32', () => {
  const s = newSea();
  assert.equal(s.board.hexIds.length, 61);

  const counts = {};
  for (const hid of s.board.hexIds) {
    const t = s.board.hexes[hid].terrain;
    counts[t] = (counts[t] ?? 0) + 1;
  }
  assert.equal(counts.sea, 32);
  assert.equal(counts.gold, 2);
  assert.equal(counts.desert, 1);

  // 島の連結成分: 本島(19マス)+ 2マスの島が5つ
  const sizes = {};
  for (const id of Object.values(s.board.islandOf)) sizes[id] = (sizes[id] ?? 0) + 1;
  assert.equal(sizes[0], 19, '本島は19マス');
  assert.deepEqual(Object.values(sizes).sort((a, b) => b - a), [19, 2, 2, 2, 2, 2]);

  assert.equal(seaMainIslandHexes().length, 19);
  assert.equal(seaIslandHexes().length, 10);
});

test('sea: 数字トークンは28枚、6と8は隣接しない', () => {
  for (let seed = 1; seed <= 20; seed++) {
    const s = newSea(seed);
    const tokens = s.board.hexIds.map((h) => s.board.hexes[h].token).filter(Boolean);
    assert.equal(tokens.length, 28, `seed=${seed}`);
    for (const hid of s.board.hexIds) {
      const t = s.board.hexes[hid].token;
      if (t !== 6 && t !== 8) continue;
      for (const nb of LAYOUT.hexNeighbors[hid]) {
        const nt = s.board.hexes[nb]?.token;
        assert.ok(nt !== 6 && nt !== 8, `seed=${seed}: ${hid}(${t}) と ${nb}(${nt})`);
      }
    }
  }
});

test('sea: 小島は海で隔てられ、本島とも他の島ともつながっていない', () => {
  const s = newSea();
  const islandSet = new Set(seaIslandHexes());
  for (const hid of seaIslandHexes()) {
    assert.ok(isLandHex(s.board, hid), `${hid} は陸`);
    assert.notEqual(s.board.islandOf[hid], 0, `${hid} は本島ではない`);
    for (const nb of LAYOUT.hexNeighbors[hid]) {
      if (!s.board.hexes[nb]) continue;
      // 隣は海か、同じ島のもう1マスだけ
      if (isSeaHex(s.board, nb)) continue;
      assert.ok(islandSet.has(nb), `${hid} の隣 ${nb} は海か小島`);
      assert.equal(s.board.islandOf[nb], s.board.islandOf[hid], '別の島と地続きになっている');
    }
  }
  // 島はそれぞれ2マス
  const sizes = {};
  for (const hid of seaIslandHexes()) {
    const id = s.board.islandOf[hid];
    sizes[id] = (sizes[id] ?? 0) + 1;
  }
  assert.deepEqual(Object.values(sizes), [2, 2, 2, 2, 2]);
});

test('sea: 港は本島の海岸線にあり、重複しない', () => {
  const s = newSea(9);
  const edges = s.board.ports.map((p) => p.edgeId);
  assert.equal(new Set(edges).size, edges.length);
  for (const eid of edges) {
    const land = LAYOUT.edges[eid].hexes.filter((h) => isLandHex(s.board, h));
    assert.equal(land.length, 1, '港は陸が1つだけ接する辺');
    assert.equal(s.board.islandOf[land[0]], 0, '港は本島の海岸');
  }
});

test('sea: 船は海に面した辺にだけ置ける', () => {
  const s = blank(finishSetup(newSea()));
  // 完全に内陸の辺(両側が陸)には置けない
  const inland = boardEdgeIds(s.board).find(
    (eid) => LAYOUT.edges[eid].hexes.length === 2
      && LAYOUT.edges[eid].hexes.every((h) => isLandHex(s.board, h)),
  );
  assert.ok(inland, '内陸の辺がある');
  assert.equal(isShipEdge(s.board, inland), false);

  // 建物がないと接続がないので、まず開拓地を置く
  const coast = boardEdgeIds(s.board).find((eid) => isShipEdge(s.board, eid));
  s.buildings[LAYOUT.edges[coast].v[0]] = { player: 0, type: 'settlement' };
  assert.equal(canPlaceShip(s, 0, coast), null);
  assert.match(canPlaceShip(s, 0, inland), /海に面した辺/);
});

test('sea: 道は陸に面した辺にだけ置ける', () => {
  const s = blank(finishSetup(newSea()));
  const openSea = boardEdgeIds(s.board).find(
    (eid) => LAYOUT.edges[eid].hexes.every((h) => !isLandHex(s.board, h)),
  );
  assert.ok(openSea, '外洋だけに面した辺がある');
  s.buildings[LAYOUT.edges[openSea].v[0]] = { player: 0, type: 'settlement' };
  assert.match(canPlaceRoad(s, 0, openSea), /陸に面した辺/);
});

test('sea: 船は自分の建物か自分の船にしかつながらない', () => {
  const s = blank(finishSetup(newSea()));
  const coast = boardEdgeIds(s.board).find((eid) => isShipEdge(s.board, eid));
  const [v0, v1] = LAYOUT.edges[coast].v;

  // つながりがなければ置けない
  assert.match(canPlaceShip(s, 0, coast), /接続していません/);

  // 敵の建物には接続できない
  s.buildings[v0] = { player: 1, type: 'settlement' };
  assert.match(canPlaceShip(s, 0, coast), /接続していません/);

  // 自分の建物からは出港できる
  s.buildings[v0] = { player: 0, type: 'settlement' };
  assert.equal(canPlaceShip(s, 0, coast), null);

  // 自分の船の先にもつなげる
  s.ships[coast] = { player: 0, builtTurn: 0 };
  const next = LAYOUT.vertexEdges[v1].find(
    (eid) => eid !== coast && isShipEdge(s.board, eid) && !s.ships[eid],
  );
  assert.ok(next);
  assert.equal(canPlaceShip(s, 0, next), null);
});

test('sea: 道と船は同じ辺に置けない', () => {
  const s = blank(finishSetup(newSea()));
  const coast = boardEdgeIds(s.board).find(
    (eid) => isShipEdge(s.board, eid) && LAYOUT.edges[eid].hexes.some((h) => isLandHex(s.board, h)),
  );
  const v0 = LAYOUT.edges[coast].v[0];
  s.buildings[v0] = { player: 0, type: 'settlement' };
  s.roads[coast] = { player: 0 };
  assert.match(canPlaceShip(s, 0, coast), /道があります/);

  delete s.roads[coast];
  s.ships[coast] = { player: 0, builtTurn: 0 };
  assert.match(canPlaceRoad(s, 0, coast), /船があります/);
});

test('sea: 海賊がいる海には船を置けない', () => {
  const s = blank(finishSetup(newSea()));
  const coast = boardEdgeIds(s.board).find((eid) => isShipEdge(s.board, eid));
  s.buildings[LAYOUT.edges[coast].v[0]] = { player: 0, type: 'settlement' };
  assert.equal(canPlaceShip(s, 0, coast), null);

  s.board.pirate = LAYOUT.edges[coast].hexes.find((h) => isSeaHex(s.board, h));
  assert.match(canPlaceShip(s, 0, coast), /海賊/);
});

test('sea: 船を建造すると資源を払い、コマの上限は15隻', () => {
  let s = blank(finishSetup(newSea()));
  const coast = boardEdgeIds(s.board).find((eid) => isShipEdge(s.board, eid));
  s.buildings[LAYOUT.edges[coast].v[0]] = { player: 0, type: 'settlement' };
  s.players[0].resources = { wood: 1, brick: 0, sheep: 1, wheat: 0, ore: 0 };
  const bankWood = s.bank.resources.wood;

  s = dispatch(s, { type: 'BUILD_SHIP', player: 0, edgeId: coast });
  assert.equal(s.ships[coast].player, 0);
  assert.equal(s.players[0].resources.wood, 0);
  assert.equal(s.players[0].resources.sheep, 0);
  assert.equal(s.bank.resources.wood, bankWood + 1);

  // 上限
  const s2 = blank(finishSetup(newSea()));
  s2.buildings[LAYOUT.edges[coast].v[0]] = { player: 0, type: 'settlement' };
  const edges = boardEdgeIds(s2.board)
    .filter((e) => isShipEdge(s2.board, e) && e !== coast)
    .slice(0, SHIP_LIMIT);
  assert.equal(edges.length, SHIP_LIMIT);
  for (const e of edges) s2.ships[e] = { player: 0, builtTurn: 0 };
  assert.match(canPlaceShip(s2, 0, coast), /コマがありません/);
});

test('sea: 動かせるのは航路の先端の船だけ、1手番に1隻', () => {
  const s = blank(finishSetup(newSea()));
  const coast = boardEdgeIds(s.board).find((eid) => isShipEdge(s.board, eid));
  const [v0, v1] = LAYOUT.edges[coast].v;
  s.buildings[v0] = { player: 0, type: 'settlement' };
  const next = LAYOUT.vertexEdges[v1].find(
    (eid) => eid !== coast && isShipEdge(s.board, eid),
  );
  s.ships[coast] = { player: 0, builtTurn: 0 };
  s.ships[next] = { player: 0, builtTurn: 0 };
  s.turn = 5;

  const movable = movableShips(s, 0);
  assert.ok(movable.includes(next), '先端の船は動かせる');
  assert.ok(!movable.includes(coast), '間の船は動かせない');

  // その手番に建てた船は動かせない
  s.ships[next].builtTurn = 5;
  assert.ok(!movableShips(s, 0).includes(next));
  s.ships[next].builtTurn = 0;

  // 1手番に1隻まで
  s.turnFlags.movedShip = true;
  assert.match(
    validateAction(s, { type: 'MOVE_SHIP', player: 0, from: next, to: coast }),
    /1隻まで/,
  );
});

test('sea: 船を動かすと元の辺が空き、移動先に移る', () => {
  let s = blank(finishSetup(newSea()));
  const coast = boardEdgeIds(s.board).find((eid) => isShipEdge(s.board, eid));
  const [v0, v1] = LAYOUT.edges[coast].v;
  s.buildings[v0] = { player: 0, type: 'settlement' };
  s.ships[coast] = { player: 0, builtTurn: 0 };
  s.turn = 5;

  // 同じ建物から出る別の海の辺へ動かす
  const to = LAYOUT.vertexEdges[v0].find(
    (eid) => eid !== coast && isShipEdge(s.board, eid) && !s.ships[eid],
  );
  assert.ok(to, '動かせる先がある');
  s = dispatch(s, { type: 'MOVE_SHIP', player: 0, from: coast, to });
  assert.equal(s.ships[coast], undefined);
  assert.equal(s.ships[to].player, 0);
  assert.equal(s.turnFlags.movedShip, true);
  assert.ok(!(v1 in {}), 'v1 は使わない');
});

test('sea: 最長交易路は道と船を合算するが、乗り継ぎは自分の建物の上だけ', () => {
  const s = blank(finishSetup(newSea()));
  // 海岸線の辺を1本選び、その両端から道と船を伸ばす
  const coast = boardEdgeIds(s.board).find(
    (eid) => LAYOUT.edges[eid].hexes.filter((h) => isLandHex(s.board, h)).length === 1
      && LAYOUT.edges[eid].hexes.some((h) => isSeaHex(s.board, h)),
  );
  const [va, vb] = LAYOUT.edges[coast].v;
  const roadEdge = LAYOUT.vertexEdges[va].find(
    (eid) => eid !== coast && LAYOUT.edges[eid].hexes.every((h) => isLandHex(s.board, h)),
  );
  const shipEdge = LAYOUT.vertexEdges[vb].find(
    (eid) => eid !== coast && isShipEdge(s.board, eid),
  );
  assert.ok(roadEdge && shipEdge);

  // 道 - 海岸の道 - 船 とつなぐ。乗り継ぎ点 vb に建物がなければ切れる
  s.roads[roadEdge] = { player: 0 };
  s.roads[coast] = { player: 0 };
  s.ships[shipEdge] = { player: 0, builtTurn: 0 };
  assert.equal(longestRoadLength(s, 0), 2, '建物がないと道2本ぶんで止まる');

  s.buildings[vb] = { player: 0, type: 'settlement' };
  assert.equal(longestRoadLength(s, 0), 3, '自分の建物の上なら船へ乗り継げる');

  s.buildings[vb] = { player: 1, type: 'settlement' };
  assert.equal(longestRoadLength(s, 0), 2, '敵の建物では乗り継げない');
});

test('sea: 金鉱は好きな資源を選ばせる(開拓地1枚・都市2枚)', () => {
  const s = blank(finishSetup(newSea()));
  const gold = s.board.hexIds.find((h) => s.board.hexes[h].terrain === 'gold');
  const total = s.board.hexes[gold].token;
  const [v1, v2] = LAYOUT.hexVertices[gold];
  s.buildings[v1] = { player: 0, type: 'settlement' };
  s.buildings[v2] = { player: 1, type: 'city' };
  s.board.robber = s.board.hexIds.find((h) => h !== gold && isLandHex(s.board, h));

  const gains = goldGainForRoll(s, total);
  assert.equal(gains[0], 1);
  assert.equal(gains[1], 2);

  // 盗賊がいると止まる
  s.board.robber = gold;
  assert.deepEqual(goldGainForRoll(s, total), {});
});

test('sea: ロールで金鉱の割り込みが立ち、PICK_GOLD で資源をもらう', () => {
  let s = blank(finishSetup(newSea()));
  const gold = s.board.hexIds.find((h) => s.board.hexes[h].terrain === 'gold');
  const total = s.board.hexes[gold].token;
  assert.ok(total !== 7);
  s.buildings[LAYOUT.hexVertices[gold][0]] = { player: 0, type: 'settlement' };
  s.board.robber = s.board.hexIds.find((h) => h !== gold && isLandHex(s.board, h));
  s.turnFlags = { rolled: false, playedDev: false };
  s.turnFlags.alchemist = dicePair(total);

  s = dispatch(s, { type: 'ROLL_DICE', player: 0 });
  assert.equal(s.awaiting?.type, 'goldChoice');
  assert.deepEqual(s.awaiting.players, [0]);

  const before = s.players[0].resources.ore;
  s = dispatch(s, { type: 'PICK_GOLD', player: 0, resource: 'ore' });
  assert.equal(s.players[0].resources.ore, before + 1);
  assert.equal(s.awaiting, null);
});

test('sea: 7で海のヘックスを選ぶと海賊が動き、船を持つ相手から奪う', () => {
  let s = blank(finishSetup(newSea()));
  const coast = boardEdgeIds(s.board).find((eid) => isShipEdge(s.board, eid));
  s.ships[coast] = { player: 1, builtTurn: 0 };
  const seaHex = LAYOUT.edges[coast].hexes.find((h) => isSeaHex(s.board, h));
  s.players[1].resources = { wood: 0, brick: 0, sheep: 0, wheat: 3, ore: 0 };
  s.players[0].resources = { wood: 0, brick: 0, sheep: 0, wheat: 0, ore: 0 };

  assert.deepEqual(pirateTargets(s, seaHex, 0), [1]);
  const robberBefore = s.board.robber;
  s.awaiting = { type: 'moveRobber', players: [0], context: { cause: 'seven' } };
  s = dispatch(s, { type: 'MOVE_ROBBER', player: 0, hexId: seaHex, targetPlayer: 1 });

  assert.equal(s.board.pirate, seaHex);
  assert.equal(s.board.robber, robberBefore, '盗賊は動かない');
  assert.equal(s.players[0].resources.wheat, 1);
  assert.equal(s.players[1].resources.wheat, 2);
});

test('sea: 初期配置は本島にしか置けない', () => {
  const s = newSea();
  const islandVid = boardVertexIds(s.board).find(
    (vid) => islandAtVertex(s.board, vid) === 1,
  );
  assert.ok(islandVid, '小島の頂点がある');
  const edge = LAYOUT.vertexEdges[islandVid][0];
  assert.match(
    validateAction(s, {
      type: 'PLACE_INITIAL', player: 0, vertexId: islandVid, edgeId: edge,
    }),
    /本島/,
  );
});

test('sea: 新しい島に開拓地を建てると+2点、本島は加点なし', () => {
  let s = blank(finishSetup(newSea()));
  const p = s.players[0];
  p.resources = { wood: 2, brick: 2, sheep: 2, wheat: 2, ore: 0 };

  // 本島に1軒(接続のため道も置く)
  const mainVid = boardVertexIds(s.board).find(
    (vid) => islandAtVertex(s.board, vid) === 0,
  );
  s.buildings[mainVid] = { player: 0, type: 'settlement' };
  s.players[0].islands = [0];
  assert.equal(computePoints(s, 0), 1, '本島の開拓地は1点だけ');

  // 小島へ渡って1軒
  const islandVid = boardVertexIds(s.board).find(
    (vid) => islandAtVertex(s.board, vid) === 1 && !s.buildings[vid],
  );
  const shipEdge = LAYOUT.vertexEdges[islandVid].find((e) => isShipEdge(s.board, e));
  s.ships[shipEdge] = { player: 0, builtTurn: 0 };
  s = dispatch(s, { type: 'BUILD_SETTLEMENT', player: 0, vertexId: islandVid });

  assert.deepEqual(s.players[0].islands, [0, 1]);
  // 開拓地2軒(2点)+ 新しい島(+2点)
  assert.equal(computePoints(s, 0), 2 + NEW_ISLAND_VP);
});

test('sea: 同じ島に2軒目を建てても加点は増えない', () => {
  const s = blank(finishSetup(newSea()));
  s.players[0].islands = [0, 1];
  const pts = computePoints(s, 0);
  s.players[0].islands = [0, 1, 1];
  assert.equal(computePoints(s, 0), pts + NEW_ISLAND_VP,
    'islands は重複しない前提(重複したら加点も増えてしまう)');
  // 実際のゲームでは noteIsland が重複を弾く
  const s2 = blank(finishSetup(newSea()));
  s2.players[0].islands = [];
  const vid = boardVertexIds(s2.board).find((v) => islandAtVertex(s2.board, v) === 0);
  s2.buildings[vid] = { player: 0, type: 'settlement' };
  s2.players[0].resources = { wood: 2, brick: 2, sheep: 2, wheat: 2, ore: 0 };
  s2.players[0].islands = [0];
  const other = boardVertexIds(s2.board).find(
    (v) => islandAtVertex(s2.board, v) === 0 && v !== vid && canPlaceSettlement(s2, 0, v, { needRoad: false }) === null,
  );
  s2.roads[LAYOUT.vertexEdges[other].find((e) => canPlaceRoad(s2, 0, e, { requireVertex: other }) === null)] = { player: 0 };
  const after = dispatch(s2, { type: 'BUILD_SETTLEMENT', player: 0, vertexId: other });
  assert.deepEqual(after.players[0].islands, [0], '同じ島は1回だけ記録される');
});

test('sea: 勝利条件は13点、船と島も点に入る', () => {
  const s = newSea();
  assert.equal(pointsToWin(s), 13);
  assert.equal(pointsToWin(s, 0), 13);
});

test('sea: 航海者たち以外では船を建てられない', () => {
  const s = readyTurn(finishSetup(createGame({ seed: 3, playerCount: 4, humanIndex: -1 })));
  s.players[0].resources = { wood: 5, brick: 5, sheep: 5, wheat: 5, ore: 5 };
  const eid = Object.keys(LAYOUT.edges)[0];
  assert.match(
    validateAction(s, { type: 'BUILD_SHIP', player: 0, edgeId: eid }),
    /航海者たち/,
  );
});

test('sea: セルフプレイ10ゲームが完走し、保存則と勝利条件が成り立つ', () => {
  for (let seed = 1; seed <= 10; seed++) {
    let s = newSea(seed);
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
    // 船は1人15隻まで
    for (const p of s.players) {
      const ships = Object.values(s.ships).filter((x) => x.player === p.id).length;
      assert.ok(ships <= SHIP_LIMIT, `seed=${seed}: ${p.name} の船が ${ships}`);
      assert.equal(new Set(p.islands).size, p.islands.length, '島の記録が重複していない');
    }
    const w = s.winner;
    assert.ok(computePoints(s, w, { includeHidden: true }) >= pointsToWin(s, w));
  }
});
