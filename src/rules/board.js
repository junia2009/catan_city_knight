// 盤面の座標系と生成(設計書 §3)
//
// - ヘックス: axial 座標 (q, r)、pointy-top、半径2の六角形配置 = 19ヘックス
// - 頂点ID: 接する最大3ヘックス(盤外の仮想座標を含む)の座標をソート連結
// - 辺ID:   両端の頂点IDをソート連結
// - 隣接テーブルは盤面レイアウトが固定なのでモジュール定数として一度だけ構築する

import { shuffled } from '../rng.js';

export const BOARD_RADIUS = 2;

// pointy-top の6方向 (E, NE, NW, W, SW, SE)
export const DIRS = [
  [1, 0],
  [1, -1],
  [0, -1],
  [-1, 0],
  [-1, 1],
  [0, 1],
];

export const TERRAINS = ['forest', 'pasture', 'field', 'hill', 'mountain', 'desert'];

export const TERRAIN_RESOURCE = {
  forest: 'wood',
  pasture: 'sheep',
  field: 'wheat',
  hill: 'brick',
  mountain: 'ore',
  desert: null,
};

// 出目 → 確率の目安(36分率の分子)。評価関数・トークン描画に使う。
export const PIPS = { 2: 1, 3: 2, 4: 3, 5: 4, 6: 5, 8: 5, 9: 4, 10: 3, 11: 2, 12: 1 };

// 標準の数字トークン18枚(砂漠を除く18ヘックスへ)
const NUMBER_TOKENS = [2, 3, 3, 4, 4, 5, 5, 6, 6, 8, 8, 9, 9, 10, 10, 11, 11, 12];

// 標準の地形分布
const TERRAIN_POOL = [
  ...Array(4).fill('forest'),
  ...Array(4).fill('pasture'),
  ...Array(4).fill('field'),
  ...Array(3).fill('hill'),
  ...Array(3).fill('mountain'),
  'desert',
];

// 港: 3:1 ×4、資源2:1 ×5
const PORT_POOL = ['3:1', '3:1', '3:1', '3:1', 'wood', 'brick', 'sheep', 'wheat', 'ore'];

export function hexKey(q, r) {
  return q + ',' + r;
}

export function parseHexKey(key) {
  const [q, r] = key.split(',').map(Number);
  return [q, r];
}

function cmpCoord(a, b) {
  return a[0] - b[0] || a[1] - b[1];
}

// 頂点ID: 3ヘックス座標をソートして連結(盤外も含む)
export function vertexIdOf(coords) {
  return coords
    .slice()
    .sort(cmpCoord)
    .map((c) => c.join(','))
    .join('|');
}

// 辺ID: 両端頂点IDをソート連結
export function edgeIdOf(v1, v2) {
  return v1 < v2 ? v1 + '&' + v2 : v2 + '&' + v1;
}

// axial → 論理XY(サイズ1、描画層はこれをスケールするだけ)
export function axialToXY(q, r) {
  return [Math.sqrt(3) * (q + r / 2), 1.5 * r];
}

function buildLayout(radius) {
  const hexCoords = [];
  for (let q = -radius; q <= radius; q++) {
    for (let r = -radius; r <= radius; r++) {
      if (Math.abs(q + r) <= radius) hexCoords.push([q, r]);
    }
  }
  const hexIds = hexCoords.map(([q, r]) => hexKey(q, r));
  const onBoard = new Set(hexIds);

  const vertices = {}; // vid -> { x, y }
  const hexVertices = {}; // hexId -> vid[6](コーナー順)
  const vertexHexes = {}; // vid -> hexId[](盤内のみ)
  const edges = {}; // eid -> { v: [v1, v2], hexes: hexId[](盤内のみ), x, y }
  const vertexEdges = {}; // vid -> eid[]
  const vertexAdj = {}; // vid -> vid[]
  const hexNeighbors = {}; // hexId -> hexId[](盤内のみ)

  for (const [q, r] of hexCoords) {
    const hid = hexKey(q, r);
    hexNeighbors[hid] = [];
    for (const [dq, dr] of DIRS) {
      const nk = hexKey(q + dq, r + dr);
      if (onBoard.has(nk)) hexNeighbors[hid].push(nk);
    }

    const corners = [];
    for (let i = 0; i < 6; i++) {
      const a = [q + DIRS[i][0], r + DIRS[i][1]];
      const b = [q + DIRS[(i + 1) % 6][0], r + DIRS[(i + 1) % 6][1]];
      const vid = vertexIdOf([[q, r], a, b]);
      corners.push(vid);
      if (!vertices[vid]) {
        const pts = [[q, r], a, b].map(([qq, rr]) => axialToXY(qq, rr));
        vertices[vid] = {
          x: (pts[0][0] + pts[1][0] + pts[2][0]) / 3,
          y: (pts[0][1] + pts[1][1] + pts[2][1]) / 3,
        };
        vertexHexes[vid] = [];
        vertexEdges[vid] = [];
        vertexAdj[vid] = [];
      }
      if (!vertexHexes[vid].includes(hid)) vertexHexes[vid].push(hid);
    }
    hexVertices[hid] = corners;

    for (let i = 0; i < 6; i++) {
      const v1 = corners[i];
      const v2 = corners[(i + 1) % 6];
      const eid = edgeIdOf(v1, v2);
      if (!edges[eid]) edges[eid] = { v: [v1, v2], hexes: [] };
      if (!edges[eid].hexes.includes(hid)) edges[eid].hexes.push(hid);
    }
  }

  for (const [eid, e] of Object.entries(edges)) {
    const [v1, v2] = e.v;
    vertexEdges[v1].push(eid);
    vertexEdges[v2].push(eid);
    vertexAdj[v1].push(v2);
    vertexAdj[v2].push(v1);
    e.x = (vertices[v1].x + vertices[v2].x) / 2;
    e.y = (vertices[v1].y + vertices[v2].y) / 2;
  }

  // 海岸辺(盤内ヘックスが1つだけの辺)を中心角順に並べる → 港の配置候補
  const coastalEdges = Object.keys(edges)
    .filter((eid) => edges[eid].hexes.length === 1)
    .sort((a, b) => {
      const ea = edges[a];
      const eb = edges[b];
      return Math.atan2(ea.y, ea.x) - Math.atan2(eb.y, eb.x);
    });

  return {
    radius,
    hexIds,
    hexCoords,
    vertices,
    hexVertices,
    vertexHexes,
    edges,
    vertexEdges,
    vertexAdj,
    hexNeighbors,
    coastalEdges,
  };
}

// 盤面レイアウト(不変)。地形・トークンだけが GameState 側で変わる。
export const LAYOUT = buildLayout(BOARD_RADIUS);

function tokensValid(hexes) {
  // 6 と 8 が隣接しないこと
  for (const hid of LAYOUT.hexIds) {
    const t = hexes[hid].token;
    if (t !== 6 && t !== 8) continue;
    for (const nid of LAYOUT.hexNeighbors[hid]) {
      const nt = hexes[nid].token;
      if (nt === 6 || nt === 8) return false;
    }
  }
  return true;
}

// 盤面生成: [rng, board] を返す
export function generateBoard(rng) {
  let terrains, tokens;
  let hexes = null;

  for (let attempt = 0; attempt < 2000; attempt++) {
    [rng, terrains] = shuffled(rng, TERRAIN_POOL);
    [rng, tokens] = shuffled(rng, NUMBER_TOKENS);
    const h = {};
    let ti = 0;
    LAYOUT.hexIds.forEach((hid, i) => {
      const [q, r] = LAYOUT.hexCoords[i];
      const terrain = terrains[i];
      h[hid] = { q, r, terrain, token: terrain === 'desert' ? null : tokens[ti++] };
    });
    if (tokensValid(h)) {
      hexes = h;
      break;
    }
  }
  if (!hexes) throw new Error('盤面生成に失敗しました');

  const desert = LAYOUT.hexIds.find((hid) => hexes[hid].terrain === 'desert');

  // 港: 海岸辺30本から9本を等間隔に選び、シャッフルした種類を割り当てる
  let portTypes;
  [rng, portTypes] = shuffled(rng, PORT_POOL);
  const n = LAYOUT.coastalEdges.length;
  const ports = portTypes.map((type, i) => ({
    edgeId: LAYOUT.coastalEdges[Math.floor((i * n) / portTypes.length)],
    type,
  }));

  return [rng, { hexes, robber: desert, ports }];
}
