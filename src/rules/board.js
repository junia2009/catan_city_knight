// 盤面の座標系と生成(設計書 §3)
//
// - ヘックス: axial 座標 (q, r)、pointy-top。基本の盤は半径2 = 19ヘックス
// - 頂点ID: 接する最大3ヘックス(盤外の仮想座標を含む)の座標をソート連結
// - 辺ID:   両端の頂点IDをソート連結
// - 隣接テーブル(LAYOUT)は幾何だけなので、使いうる最大半径まで一度だけ構築する。
//   「どのヘックスを実際に使うか」は盤(board.hexIds)が決める ── モードごとに
//   盤の形を変えられるのはこのため。頂点・辺・海岸辺は board.hexIds から導出する。

import { shuffled } from '../rng.js';

export const BOARD_RADIUS = 2;
// レイアウトを作る最大半径。航海者たちが半径4(61マス)まで使う。
export const MAX_BOARD_RADIUS = 4;

// pointy-top の6方向 (E, NE, NW, W, SW, SE)
export const DIRS = [
  [1, 0],
  [1, -1],
  [0, -1],
  [-1, 0],
  [-1, 1],
  [0, 1],
];

// lake は漁師たちだけ(砂漠の置き換え。資源は産まず魚を産む)。
// sea / gold は航海者たちだけ(海は何も産まない、金鉱は好きな資源を産む)。
export const TERRAINS = [
  'forest', 'pasture', 'field', 'hill', 'mountain', 'desert', 'lake', 'sea', 'gold',
];

// 資源を産まない地形は null。lake / gold は「資源以外の産出」を別途扱う。
export const TERRAIN_RESOURCE = {
  forest: 'wood',
  pasture: 'sheep',
  field: 'wheat',
  hill: 'brick',
  mountain: 'ore',
  desert: null,
  lake: null,
  sea: null,
  gold: null,
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

// 半径 r 以内のヘックス座標(q昇順 → r昇順)
function coordsWithin(r) {
  const out = [];
  for (let q = -r; q <= r; q++) {
    for (let s = -r; s <= r; s++) {
      if (Math.abs(q + s) <= r) out.push([q, s]);
    }
  }
  return out;
}

// レイアウトは最大半径まで作るが、並び順は「半径2の盤 → その外側」にする。
// こうすると頂点IDや辺IDの列が基本の盤のものと完全に前方一致するので、
// 盤を広げても既存モードの同点処理(先に見つけたものを採る)が変わらない。
function layoutCoords(maxRadius) {
  const inner = coordsWithin(BOARD_RADIUS);
  const seen = new Set(inner.map(([q, r]) => hexKey(q, r)));
  const outer = coordsWithin(maxRadius).filter(([q, r]) => !seen.has(hexKey(q, r)));
  return [...inner, ...outer];
}

function buildLayout(maxRadius) {
  const hexCoords = layoutCoords(maxRadius);
  const hexIds = hexCoords.map(([q, r]) => hexKey(q, r));
  const onBoard = new Set(hexIds);

  const vertices = {}; // vid -> { x, y }
  const hexVertices = {}; // hexId -> vid[6](コーナー順)
  const vertexHexes = {}; // vid -> hexId[](レイアウト内のみ)
  const edges = {}; // eid -> { v: [v1, v2], hexes: hexId[](レイアウト内のみ), x, y }
  const vertexEdges = {}; // vid -> eid[]
  const vertexAdj = {}; // vid -> vid[]
  const hexNeighbors = {}; // hexId -> hexId[](レイアウト内のみ)

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

  return {
    maxRadius,
    hexIds,
    hexCoords,
    vertices,
    hexVertices,
    vertexHexes,
    edges,
    vertexEdges,
    vertexAdj,
    hexNeighbors,
  };
}

// 盤面レイアウト(不変)。どのヘックスを実際に使うかは盤(board)側が決める。
// 航海者たちは半径3まで使うので、レイアウトはそこまで作っておく。
export const LAYOUT = buildLayout(MAX_BOARD_RADIUS);

// 半径 r 以内のヘックスID(レイアウトの並び順のまま)
export function hexIdsWithin(r) {
  const ids = new Set(coordsWithin(r).map(([q, s]) => hexKey(q, s)));
  return LAYOUT.hexIds.filter((hid) => ids.has(hid));
}

// 盤の形から導けるものは state に持たせない(オンライン対戦で毎手番
// 状態を配るので、頂点IDの配列を積むと通信量が跳ね上がる)。
// 盤の形は1ゲームで変わらないため、ヘックスID列をキーにして覚えておく。
const geoCache = new Map();

// 盤に「実際にある」ヘックスから、使う頂点・辺・海岸辺を割り出す。
// 順序はレイアウト構築時と同じ規則(ヘックス順 → コーナー順)にそろえるので、
// 基本の盤なら従来の Object.keys(LAYOUT.vertices) と完全に同じ並びになる。
export function boardGeometry(hexIds) {
  const key = hexIds.join('|');
  const hit = geoCache.get(key);
  if (hit) return hit;
  const onBoard = new Set(hexIds);

  const vertexIds = [];
  const seenV = new Set();
  const edgeIds = [];
  const seenE = new Set();
  for (const hid of hexIds) {
    for (const vid of LAYOUT.hexVertices[hid]) {
      if (seenV.has(vid)) continue;
      seenV.add(vid);
      vertexIds.push(vid);
    }
  }
  for (const hid of hexIds) {
    const corners = LAYOUT.hexVertices[hid];
    for (let i = 0; i < 6; i++) {
      const eid = edgeIdOf(corners[i], corners[(i + 1) % 6]);
      if (seenE.has(eid)) continue;
      seenE.add(eid);
      edgeIds.push(eid);
    }
  }

  // 海岸辺(盤のヘックスが1つだけ接する辺)を中心角順に → 港・漁場の配置候補
  const coastalEdges = edgeIds
    .filter((eid) => LAYOUT.edges[eid].hexes.filter((h) => onBoard.has(h)).length === 1)
    .sort((a, b) => {
      const ea = LAYOUT.edges[a];
      const eb = LAYOUT.edges[b];
      return Math.atan2(ea.y, ea.x) - Math.atan2(eb.y, eb.x);
    });

  const geo = { hexIds, vertexIds, edgeIds, coastalEdges };
  geoCache.set(key, geo);
  return geo;
}

// 盤で使う頂点・辺・海岸辺(board.hexIds から導出。state には持たせない)
export function boardVertexIds(board) {
  return boardGeometry(board.hexIds).vertexIds;
}

export function boardEdgeIds(board) {
  return boardGeometry(board.hexIds).edgeIds;
}

export function coastalEdgesOf(board) {
  return boardGeometry(board.hexIds).coastalEdges;
}

// vid に接する「盤の」ヘックス(レイアウトには盤外のヘックスも含まれるため)
export function vertexHexesOf(board, vid) {
  return LAYOUT.vertexHexes[vid].filter((h) => board.hexes[h]);
}

// hid に隣接する「盤の」ヘックス
export function hexNeighborsOf(board, hid) {
  return LAYOUT.hexNeighbors[hid].filter((h) => board.hexes[h]);
}

function tokensValid(hexes, hexIds) {
  // 6 と 8 が隣接しないこと
  for (const hid of hexIds) {
    const t = hexes[hid].token;
    if (t !== 6 && t !== 8) continue;
    for (const nid of LAYOUT.hexNeighbors[hid]) {
      const nt = hexes[nid]?.token;
      if (nt === 6 || nt === 8) return false;
    }
  }
  return true;
}

// 漁師たち: 湖(元の砂漠)が魚を産む出目と、漁場タイルの数字(公式と同じ)
export const LAKE_NUMBERS = [2, 3, 11, 12];
export const FISHERY_NUMBERS = [4, 5, 6, 8, 9, 10];

// 漁場: 港のない海岸辺へ、等間隔になるように6か所置く。
// 公式は「港でない海岸マスすべて」だが、本作の盤は海岸辺30本・港9本なので
// 数字1つにつき1か所ずつ(計6か所)に絞る。
function placeFisheries(rng, ports, coastalEdges) {
  const used = new Set(ports.map((p) => p.edgeId));
  const free = coastalEdges.filter((eid) => !used.has(eid));
  let numbers;
  [rng, numbers] = shuffled(rng, FISHERY_NUMBERS);
  const fisheries = numbers.map((number, i) => ({
    edgeId: free[Math.floor((i * free.length) / numbers.length)],
    number,
  }));
  return [rng, fisheries];
}

// 盤面生成: [rng, board] を返す
export function generateBoard(rng, { fish = false } = {}) {
  const hexIds = hexIdsWithin(BOARD_RADIUS);
  const coastal = boardGeometry(hexIds).coastalEdges;
  let terrains, tokens;
  let hexes = null;

  for (let attempt = 0; attempt < 2000; attempt++) {
    [rng, terrains] = shuffled(rng, TERRAIN_POOL);
    [rng, tokens] = shuffled(rng, NUMBER_TOKENS);
    const h = {};
    let ti = 0;
    hexIds.forEach((hid, i) => {
      const [q, r] = parseHexKey(hid);
      const terrain = terrains[i];
      h[hid] = { q, r, terrain, token: terrain === 'desert' ? null : tokens[ti++] };
    });
    if (tokensValid(h, hexIds)) {
      hexes = h;
      break;
    }
  }
  if (!hexes) throw new Error('盤面生成に失敗しました');

  const desert = hexIds.find((hid) => hexes[hid].terrain === 'desert');

  // 港: 海岸辺30本から9本を等間隔に選び、シャッフルした種類を割り当てる
  let portTypes;
  [rng, portTypes] = shuffled(rng, PORT_POOL);
  const n = coastal.length;
  const ports = portTypes.map((type, i) => ({
    edgeId: coastal[Math.floor((i * n) / portTypes.length)],
    type,
  }));

  if (!fish) return [rng, { hexIds, hexes, robber: desert, ports }];

  // 漁師たち: 砂漠を湖に置き換える。湖も資源は産まないので盗賊の初期位置はそのまま。
  hexes[desert].terrain = 'lake';
  let fisheries;
  [rng, fisheries] = placeFisheries(rng, ports, coastal);
  return [rng, { hexIds, hexes, robber: desert, ports, fisheries, lake: desert }];
}
