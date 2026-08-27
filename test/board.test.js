import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  LAYOUT, MAX_BOARD_RADIUS, generateBoard, hexIdsWithin, boardGeometry,
  boardVertexIds, boardEdgeIds, coastalEdgesOf, TERRAIN_RESOURCE, PIPS,
} from '../src/rules/board.js';
import { makeRng } from '../src/rng.js';

test('基本の盤: 19ヘックス・54頂点・72辺・海岸辺30本', () => {
  const [, board] = generateBoard(makeRng(1));
  assert.equal(board.hexIds.length, 19);
  assert.equal(boardVertexIds(board).length, 54);
  assert.equal(boardEdgeIds(board).length, 72);
  assert.equal(coastalEdgesOf(board).length, 30);
});

test('レイアウト: 航海者たち用に半径4(61ヘックス)まで用意されている', () => {
  assert.equal(LAYOUT.maxRadius, MAX_BOARD_RADIUS);
  assert.equal(LAYOUT.hexIds.length, 61);
  assert.equal(hexIdsWithin(2).length, 19);
  assert.equal(hexIdsWithin(3).length, 37);
  assert.equal(hexIdsWithin(4).length, 61);
});

// 盤を広げても既存モードの同点処理が変わらないための不変条件。
// レイアウトの並びは「基本の盤 → その外側」なので、基本の盤のIDは前方一致する。
test('レイアウト: 基本の盤のID列がレイアウトの先頭に並ぶ', () => {
  const inner = hexIdsWithin(2);
  assert.deepEqual(LAYOUT.hexIds.slice(0, 19), inner);

  const geo = boardGeometry(inner);
  assert.deepEqual(Object.keys(LAYOUT.vertices).slice(0, 54), geo.vertexIds);
  assert.deepEqual(Object.keys(LAYOUT.edges).slice(0, 72), geo.edgeIds);
});

test('盤の頂点・辺は必ず盤のヘックスに接している', () => {
  const geo = boardGeometry(hexIdsWithin(2));
  const onBoard = new Set(geo.hexIds);
  for (const vid of geo.vertexIds) {
    assert.ok(LAYOUT.vertexHexes[vid].some((h) => onBoard.has(h)), vid);
  }
  for (const eid of geo.edgeIds) {
    assert.ok(LAYOUT.edges[eid].hexes.some((h) => onBoard.has(h)), eid);
  }
  // 海岸辺 = 盤のヘックスがちょうど1つ接する辺
  for (const eid of geo.coastalEdges) {
    assert.equal(LAYOUT.edges[eid].hexes.filter((h) => onBoard.has(h)).length, 1);
  }
});

test('各ヘックスは頂点6・辺の共有は最大2ヘックス', () => {
  for (const hid of LAYOUT.hexIds) {
    assert.equal(new Set(LAYOUT.hexVertices[hid]).size, 6);
  }
  for (const e of Object.values(LAYOUT.edges)) {
    assert.ok(e.hexes.length >= 1 && e.hexes.length <= 2);
  }
});

test('頂点の隣接数は2〜3、接続辺数と一致', () => {
  for (const vid of Object.keys(LAYOUT.vertices)) {
    const adj = LAYOUT.vertexAdj[vid];
    assert.ok(adj.length >= 2 && adj.length <= 3, `${vid}: ${adj.length}`);
    assert.equal(adj.length, LAYOUT.vertexEdges[vid].length);
    assert.equal(new Set(adj).size, adj.length);
  }
});

test('頂点は最大3ヘックスに共有される', () => {
  for (const vid of Object.keys(LAYOUT.vertices)) {
    const hexes = LAYOUT.vertexHexes[vid];
    assert.ok(hexes.length >= 1 && hexes.length <= 3);
  }
  // 共有数の合計 = ヘックス数×6(基本の盤なら 19*6 = 114)
  const geo = boardGeometry(hexIdsWithin(2));
  const onBoard = new Set(geo.hexIds);
  const total = geo.vertexIds.reduce(
    (s, vid) => s + LAYOUT.vertexHexes[vid].filter((h) => onBoard.has(h)).length, 0,
  );
  assert.equal(total, 19 * 6);
  assert.equal(LAYOUT.hexIds.length * 6, 61 * 6);
});

test('盤面生成: 地形・トークン分布が標準どおり', () => {
  const [, board] = generateBoard(makeRng(42));
  const terrainCount = {};
  const tokenCount = {};
  for (const hex of Object.values(board.hexes)) {
    terrainCount[hex.terrain] = (terrainCount[hex.terrain] ?? 0) + 1;
    if (hex.token) tokenCount[hex.token] = (tokenCount[hex.token] ?? 0) + 1;
  }
  assert.deepEqual(terrainCount, {
    forest: 4, pasture: 4, field: 4, hill: 3, mountain: 3, desert: 1,
  });
  assert.deepEqual(tokenCount, { 2: 1, 3: 2, 4: 2, 5: 2, 6: 2, 8: 2, 9: 2, 10: 2, 11: 2, 12: 1 });
  assert.equal(board.hexes[board.robber].terrain, 'desert');
  assert.equal(board.hexes[board.robber].token, null);
});

test('盤面生成: 6と8は隣接しない(複数シード)', () => {
  for (let seed = 1; seed <= 30; seed++) {
    const [, board] = generateBoard(makeRng(seed));
    for (const hid of board.hexIds) {
      const t = board.hexes[hid].token;
      if (t !== 6 && t !== 8) continue;
      for (const nid of LAYOUT.hexNeighbors[hid].filter((h) => board.hexes[h])) {
        const nt = board.hexes[nid].token;
        assert.ok(nt !== 6 && nt !== 8, `seed=${seed}: ${hid}(${t}) と ${nid}(${nt}) が隣接`);
      }
    }
  }
});

test('盤面生成: 港は9つ、すべて海岸辺で重複なし', () => {
  const [, board] = generateBoard(makeRng(7));
  assert.equal(board.ports.length, 9);
  const edges = board.ports.map((p) => p.edgeId);
  assert.equal(new Set(edges).size, 9);
  for (const e of edges) assert.ok(coastalEdgesOf(board).includes(e));
  const types = board.ports.map((p) => p.type).sort();
  assert.deepEqual(types, ['3:1', '3:1', '3:1', '3:1', 'brick', 'ore', 'sheep', 'wheat', 'wood'].sort());
});

test('シード固定で盤面は再現可能', () => {
  const [, b1] = generateBoard(makeRng(123));
  const [, b2] = generateBoard(makeRng(123));
  assert.deepEqual(b1, b2);
});

test('PIPS と資源対応の整合', () => {
  assert.equal(PIPS[6], 5);
  assert.equal(PIPS[8], 5);
  assert.equal(PIPS[2], 1);
  assert.equal(TERRAIN_RESOURCE.forest, 'wood');
  assert.equal(TERRAIN_RESOURCE.desert, null);
});
