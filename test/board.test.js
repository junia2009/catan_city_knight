import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LAYOUT, generateBoard, TERRAIN_RESOURCE, PIPS } from '../src/rules/board.js';
import { makeRng } from '../src/rng.js';

test('レイアウト: 19ヘックス・54頂点・72辺', () => {
  assert.equal(LAYOUT.hexIds.length, 19);
  assert.equal(Object.keys(LAYOUT.vertices).length, 54);
  assert.equal(Object.keys(LAYOUT.edges).length, 72);
});

test('レイアウト: 海岸辺は30本', () => {
  assert.equal(LAYOUT.coastalEdges.length, 30);
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
  // 内部頂点(3ヘックス共有)の総数チェック: 19*6 = 114 = Σ共有数
  const total = Object.values(LAYOUT.vertexHexes).reduce((s, h) => s + h.length, 0);
  assert.equal(total, 114);
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
    for (const hid of LAYOUT.hexIds) {
      const t = board.hexes[hid].token;
      if (t !== 6 && t !== 8) continue;
      for (const nid of LAYOUT.hexNeighbors[hid]) {
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
  for (const e of edges) assert.ok(LAYOUT.coastalEdges.includes(e));
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
