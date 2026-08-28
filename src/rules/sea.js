// 航海者たち(公式拡張)。基本ルールに海と船を足す。
//
// - 盤は半径4(61マス)。本島19マス + 2マスの小島5つ + 海32マス
//   本島(半径2)と小島(リング4)のあいだにリング3が丸ごと海の「堀」として入る
// - 船は海に面した辺に建てる。道とは「自分の建物の上でだけ」つながる
// - 開いた航路の先端にある船は、1手番に1隻だけ動かせる
// - 海賊は海のヘックスに居座り、隣の辺への船の建設と移動を止める
// - 金鉱は好きな資源を産む(開拓地1枚・都市2枚)
// - 本島以外の島に初めて開拓地を建てると +2 点

import {
  LAYOUT, BOARD_RADIUS, MAX_BOARD_RADIUS,
  hexKey, hexIdsWithin, boardGeometry, edgeIdOf,
} from './board.js';
import { shuffled } from '../rng.js';

export const SEA_VICTORY_POINTS = 13;
export const SHIP_COST = { wood: 1, sheep: 1 };
export const SHIP_LIMIT = 15;
export const NEW_ISLAND_VP = 2;

// 小島: リング4(盤のいちばん外側)に2マスずつ5つ。
// リング3が丸ごと海なので、本島とは自動的に切り離される。
// 島どうしのあいだにも海を3マスずつ空けてある。
const ISLAND_COORDS = [
  [[4, 0], [4, -1]],
  [[3, -4], [2, -4]],
  [[-2, -2], [-3, -1]],
  [[-4, 2], [-4, 3]],
  [[-1, 4], [0, 4]],
];

// 本島: 半径2まるごと(19マス)。基本の盤と同じ形なので、
// 海岸線も港の置き方も基本モードと同じ感覚になる。
export function seaMainIslandHexes() {
  return hexIdsWithin(BOARD_RADIUS);
}

export function seaIslandHexes() {
  return ISLAND_COORDS.flat().map(([q, r]) => hexKey(q, r));
}

// 本島19マスは基本の盤と同じ地形分布。小島10マスには金鉱2つを混ぜる。
const MAIN_TERRAINS = [
  ...Array(4).fill('forest'),
  ...Array(4).fill('pasture'),
  ...Array(4).fill('field'),
  ...Array(3).fill('hill'),
  ...Array(3).fill('mountain'),
  'desert',
];
const ISLAND_TERRAINS = [
  'gold', 'gold',
  'forest', 'forest', 'pasture', 'pasture', 'field', 'field', 'hill', 'mountain',
];

// 数字は28枚(産出する陸の数)。標準の分布を保ったまま増やしてある。
// 小島は「渡る価値」が要るので、強い目を厚めに割り当てる。
const ISLAND_TOKENS = [4, 5, 5, 6, 8, 9, 9, 10, 10, 11];
const MAIN_TOKENS = [2, 2, 3, 3, 3, 4, 4, 5, 6, 6, 8, 8, 9, 10, 11, 11, 12, 12];

// 港: 本島の海岸線に等間隔で置く。本島は基本の盤と同じ形なので構成も同じ9つ。
const SEA_PORT_POOL = ['3:1', '3:1', '3:1', '3:1', 'wood', 'brick', 'sheep', 'wheat', 'ore'];

export function isSeaHex(board, hid) {
  return board.hexes[hid]?.terrain === 'sea';
}

export function isLandHex(board, hid) {
  const t = board.hexes[hid]?.terrain;
  return t != null && t !== 'sea';
}

// 船を置ける辺 = 海のヘックスに面している辺
export function isShipEdge(board, eid) {
  return (LAYOUT.edges[eid]?.hexes ?? []).some((h) => isSeaHex(board, h));
}

// 道を置ける辺 = 陸のヘックスに面している辺(海岸線は道も船も置ける)
export function isRoadEdge(board, eid) {
  const hexes = LAYOUT.edges[eid]?.hexes ?? [];
  if (!hexes.some((h) => board.hexes[h])) return false;
  // 航海者たち以外は全ヘックスが陸なので、そのまま従来どおり
  return hexes.some((h) => isLandHex(board, h));
}

// 本島の海岸線(陸のヘックスがちょうど1つ接する辺)。港の配置候補。
export function shoreEdgesOf(board, hexIds = null) {
  const ids = hexIds ?? boardGeometry(board.hexIds).edgeIds;
  return ids
    .filter((eid) => LAYOUT.edges[eid].hexes.filter((h) => isLandHex(board, h)).length === 1)
    .sort((a, b) => {
      const ea = LAYOUT.edges[a];
      const eb = LAYOUT.edges[b];
      return Math.atan2(ea.y, ea.x) - Math.atan2(eb.y, eb.x);
    });
}

// 陸ヘックスを連結成分に分けて島番号をふる(0 が本島)
function computeIslands(hexes, hexIds) {
  const land = hexIds.filter((hid) => hexes[hid] && hexes[hid].terrain !== 'sea');
  const islandOf = {};
  let next = 0;
  for (const start of land) {
    if (islandOf[start] != null) continue;
    const id = next++;
    const stack = [start];
    islandOf[start] = id;
    while (stack.length) {
      const hid = stack.pop();
      for (const nb of LAYOUT.hexNeighbors[hid]) {
        if (islandOf[nb] != null) continue;
        if (!hexes[nb] || hexes[nb].terrain === 'sea') continue;
        islandOf[nb] = id;
        stack.push(nb);
      }
    }
  }
  return islandOf;
}

// 頂点が属する島(接する陸ヘックスの島番号。陸に接していなければ null)
export function islandAtVertex(board, vid) {
  for (const hid of LAYOUT.vertexHexes[vid]) {
    const id = board.islandOf?.[hid];
    if (id != null) return id;
  }
  return null;
}

// 海賊がいるヘックスに面した辺(船の建設・移動を止める)
export function pirateBlocks(board, eid) {
  if (board.pirate == null) return false;
  return (LAYOUT.edges[eid]?.hexes ?? []).includes(board.pirate);
}

// 盤面生成: [rng, board]
export function generateSeaBoard(rng) {
  const hexIds = hexIdsWithin(MAX_BOARD_RADIUS);
  const mainIsland = seaMainIslandHexes();
  const islands = seaIslandHexes();
  const mainSet = new Set(mainIsland);
  const islandSet = new Set(islands);

  let hexes = null;
  for (let attempt = 0; attempt < 2000; attempt++) {
    let mainT, mainTok, islT, islTok;
    [rng, mainT] = shuffled(rng, MAIN_TERRAINS);
    [rng, mainTok] = shuffled(rng, MAIN_TOKENS);
    [rng, islT] = shuffled(rng, ISLAND_TERRAINS);
    [rng, islTok] = shuffled(rng, ISLAND_TOKENS);

    const h = {};
    let mi = 0, mt = 0, ii = 0, it = 0;
    for (const hid of hexIds) {
      const [q, r] = hid.split(',').map(Number);
      if (mainSet.has(hid)) {
        const terrain = mainT[mi++];
        h[hid] = { q, r, terrain, token: terrain === 'desert' ? null : mainTok[mt++] };
      } else if (islandSet.has(hid)) {
        h[hid] = { q, r, terrain: islT[ii++], token: islTok[it++] };
      } else {
        h[hid] = { q, r, terrain: 'sea', token: null };
      }
    }
    // 6と8が隣接しない(小島は孤立しているので実質は本島の判定)
    let ok = true;
    for (const hid of hexIds) {
      const t = h[hid].token;
      if (t !== 6 && t !== 8) continue;
      for (const nb of LAYOUT.hexNeighbors[hid]) {
        const nt = h[nb]?.token;
        if (nt === 6 || nt === 8) { ok = false; break; }
      }
      if (!ok) break;
    }
    if (ok) { hexes = h; break; }
  }
  if (!hexes) throw new Error('盤面生成に失敗しました(航海者たち)');

  const islandOf = computeIslands(hexes, hexIds);
  const board = { hexIds, hexes, islandOf };

  // 港は本島の海岸線に等間隔で
  const shore = shoreEdgesOf(board).filter(
    (eid) => LAYOUT.edges[eid].hexes.some((h) => mainSet.has(h)),
  );
  let portTypes;
  [rng, portTypes] = shuffled(rng, SEA_PORT_POOL);
  const n = shore.length;
  board.ports = portTypes.map((type, i) => ({
    edgeId: shore[Math.floor((i * n) / portTypes.length)],
    type,
  }));

  // 盗賊は本島の砂漠、海賊は本島から離れた海(北の外洋)から始める
  board.robber = mainIsland.find((hid) => hexes[hid].terrain === 'desert');
  // 海賊は本島から離れた外洋(盤の北の縁)から始める
  board.pirate = hexIds.find((hid) => hexes[hid].terrain === 'sea' && hexes[hid].r === -4)
    ?? hexIds.find((hid) => hexes[hid].terrain === 'sea');
  return [rng, board];
}

export function isSeaMode(state) {
  return state.mode === 'sea';
}

// 自分の船が接している辺(道と同じ扱いの接続判定に使う)
export function hasOwnShipAt(state, pid, vid, { skipEdge = null, extra = null } = {}) {
  return LAYOUT.vertexEdges[vid].some(
    (eid) => eid !== skipEdge && (state.ships?.[eid]?.player === pid || extra?.[eid]),
  );
}

// 船を置けるか。海の辺 + 「自分の建物か自分の船」に接続 + 海賊がいない。
// 道とは建物の上でしかつながらない(公式ルール)。
// extraRoads: 同じカードで先に置く道(街道建設。同じ辺を二重に使わせない)
export function canPlaceShip(state, pid, edgeId, { extraShips = null, extraRoads = null } = {}) {
  const board = state.board;
  const edge = LAYOUT.edges[edgeId];
  if (!edge) return '不正な辺です';
  if (!edge.hexes.some((h) => board.hexes[h])) return '盤の外です';
  if (!isShipEdge(board, edgeId)) return '船は海に面した辺にだけ置けます';
  if (state.ships?.[edgeId] || extraShips?.[edgeId]) return 'その辺には船があります';
  if (state.roads?.[edgeId] || extraRoads?.[edgeId]) return 'その辺には道があります';
  if (pirateBlocks(board, edgeId)) return '海賊がいる海には置けません';

  const count = Object.values(state.ships ?? {}).filter((s) => s.player === pid).length;
  if (count + (extraShips ? Object.keys(extraShips).length : 0) >= SHIP_LIMIT) {
    return '船のコマがありません';
  }

  for (const v of edge.v) {
    const b = state.buildings[v];
    if (b && b.player === pid) return null; // 自分の建物から出港
    if (b && b.player !== pid) continue; // 敵の建物は通れない
    if (hasOwnShipAt(state, pid, v, { skipEdge: edgeId, extra: extraShips })) return null;
  }
  return '自分の船・建物に接続していません';
}

// 金鉱の産出: その出目で金鉱に接している建物の数(開拓地1・都市2)。
// 盗賊がいる金鉱は止まる(普通の資源と同じ)。
export function goldGainForRoll(state, total) {
  const gains = {};
  for (const hid of state.board.hexIds) {
    const hex = state.board.hexes[hid];
    if (hex.terrain !== 'gold' || hex.token !== total) continue;
    if (state.board.robber === hid) continue;
    for (const vid of LAYOUT.hexVertices[hid]) {
      const b = state.buildings[vid];
      if (!b) continue;
      gains[b.player] = (gains[b.player] ?? 0) + (b.type === 'city' ? 2 : 1);
    }
  }
  return gains;
}

// 海賊を置いたときに略奪できる相手 = そのヘックスに面した辺に船を持つ人
export function pirateTargets(state, hexId, pid) {
  const targets = new Set();
  for (const [eid, ship] of Object.entries(state.ships ?? {})) {
    if (ship.player === pid) continue;
    if (!LAYOUT.edges[eid].hexes.includes(hexId)) continue;
    targets.add(ship.player);
  }
  return [...targets];
}

// 動かせる船 = 開いた航路の先端(片側の頂点に建物も他の自分の船もない)。
// その手番に建てた船は動かせない。
export function movableShips(state, pid) {
  const out = [];
  for (const [eid, ship] of Object.entries(state.ships ?? {})) {
    if (ship.player !== pid) continue;
    if (ship.builtTurn === state.turn) continue;
    if (pirateBlocks(state.board, eid)) continue;
    const open = LAYOUT.edges[eid].v.some(
      (v) => !state.buildings[v] && !hasOwnShipAt(state, pid, v, { skipEdge: eid }),
    );
    if (open) out.push(eid);
  }
  return out;
}
