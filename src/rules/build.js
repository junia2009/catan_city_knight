// 建設可否判定・コスト(設計書 §5)
// すべて純粋関数。エラー理由の文字列 or null(合法)を返す。

import { LAYOUT, vertexHexesOf } from './board.js';
import { isLandHex } from './sea.js';
import { RESOURCES } from '../state.js';

export const COSTS = {
  road: { wood: 1, brick: 1 },
  settlement: { wood: 1, brick: 1, sheep: 1, wheat: 1 },
  city: { wheat: 2, ore: 3 },
  devCard: { sheep: 1, wheat: 1, ore: 1 },
};

export const PIECE_LIMITS = { road: 15, settlement: 5, city: 4 };

export function totalResources(player) {
  return RESOURCES.reduce((s, r) => s + player.resources[r], 0);
}

// 手札総数(資源 + 商品)。7 の捨て札判定に使う。
// オンライン対戦で他人を見ているときは内訳が伏せられている(hiddenCards が実数)。
// 枚数そのものは公開情報なので、ここで足して見え方を揃える。
export function totalCards(player) {
  const com = player.commodities
    ? Object.values(player.commodities).reduce((a, b) => a + b, 0)
    : 0;
  return totalResources(player) + com + (player.hiddenCards ?? 0);
}

// この手札は伏せられているか(オンラインで他人の手札を見ているとき)
export function handHidden(player) {
  return !!player?.hidden;
}

// 手札上限(基本 7、城壁1枚につき +2。設計書 §9.6)
export function handLimit(state, pid) {
  if (state.mode !== 'cak') return 7;
  const walls = Object.values(state.walls).filter((p) => p === pid).length;
  return 7 + walls * 2;
}

export const WALL_LIMIT = 3;
export const WALL_COST = { brick: 2 };

export function wallsLeft(state, pid) {
  return WALL_LIMIT - Object.values(state.walls ?? {}).filter((x) => x === pid).length;
}

export function canBuildWall(state, pid, vid) {
  const b = state.buildings[vid];
  if (!b || b.player !== pid || b.type !== 'city') return '自分の都市の下にのみ建てられます';
  if (state.walls[vid] != null) return 'すでに城壁があります';
  const count = Object.values(state.walls).filter((p) => p === pid).length;
  if (count >= WALL_LIMIT) return '城壁は3枚までです';
  return null;
}

export function canAfford(player, cost) {
  return Object.entries(cost).every(([r, n]) => player.resources[r] >= n);
}

export function payCost(state, pid, cost) {
  const p = state.players[pid];
  for (const [r, n] of Object.entries(cost)) {
    p.resources[r] -= n;
    state.bank.resources[r] += n;
  }
}

// 銀行から資源を渡す(在庫の範囲で)。実際に渡した枚数を返す。
export function grantResource(state, pid, res, n) {
  const give = Math.min(n, state.bank.resources[res]);
  state.bank.resources[res] -= give;
  state.players[pid].resources[res] += give;
  return give;
}

// 手元に残っているコマの数。盤上のコマを数えて引くだけなので、
// 開拓地を都市に置き換えると開拓地のコマが自動で1つ戻る(公式ルールどおり)。
export function piecesLeft(state, pid, type) {
  return PIECE_LIMITS[type] - countPieces(state, pid, type);
}

export function countPieces(state, pid, type) {
  if (type === 'road') {
    return Object.values(state.roads).filter((r) => r.player === pid).length;
  }
  return Object.values(state.buildings).filter((b) => b.player === pid && b.type === type).length;
}

// 開拓地: 空き頂点 + 距離ルール + (通常時)自分の道に接続
export function canPlaceSettlement(state, pid, vertexId, { needRoad = true } = {}) {
  if (!LAYOUT.vertices[vertexId]) return '不正な頂点です';
  // レイアウトには盤外の頂点も含まれるので、盤に接しているかを見る
  if (vertexHexesOf(state.board, vertexId).length === 0) return '盤の外です';
  if (state.buildings[vertexId]) return 'その頂点には建物があります';
  if (state.knights?.[vertexId]) return 'その頂点には騎士がいます';
  for (const adj of LAYOUT.vertexAdj[vertexId]) {
    if (state.buildings[adj]) return '距離ルール: 隣接頂点に建物があります';
  }
  if (countPieces(state, pid, 'settlement') >= PIECE_LIMITS.settlement) {
    return '開拓地のコマがありません';
  }
  if (needRoad) {
    // 航海者たち: 船も接続とみなす(島には船で渡って入植する)
    const connected = LAYOUT.vertexEdges[vertexId].some(
      (eid) => state.roads[eid]?.player === pid || state.ships?.[eid]?.player === pid,
    );
    if (!connected) return '自分の道・船に接続していません';
  }
  return null;
}

// 道: 空き辺 + 自分の建物か道に接続(敵の建物を通しての接続は不可)
// requireVertex: 初期配置用(その頂点に接する辺のみ)
// extraRoads: 街道建設カードの2本目判定用の仮想追加道 { edgeId: true }
export function canPlaceRoad(state, pid, edgeId, { requireVertex = null, extraRoads = null } = {}) {
  const edge = LAYOUT.edges[edgeId];
  if (!edge) return '不正な辺です';
  if (!edge.hexes.some((h) => state.board.hexes[h])) return '盤の外です';
  // 航海者たち: 道は陸に面した辺だけ(海の上は船)
  if (!edge.hexes.some((h) => isLandHex(state.board, h))) return '道は陸に面した辺にだけ置けます';
  if (state.ships?.[edgeId]) return 'その辺には船があります';
  if (state.roads[edgeId] || extraRoads?.[edgeId]) return 'その辺には道があります';
  const extraCount = extraRoads ? Object.keys(extraRoads).length : 0;
  if (countPieces(state, pid, 'road') + extraCount >= PIECE_LIMITS.road) {
    return '道のコマがありません';
  }
  if (requireVertex) {
    if (!edge.v.includes(requireVertex)) return '開拓地に隣接する辺を選んでください';
    return null;
  }
  const ownRoad = (eid) => state.roads[eid]?.player === pid || extraRoads?.[eid];
  for (const v of edge.v) {
    const b = state.buildings[v];
    const k = state.knights?.[v];
    if (b && b.player === pid) return null; // 自分の建物に接続
    if (b && b.player !== pid) continue; // 敵の建物は通れない
    if (k && k.player !== pid) continue; // 敵の騎士も通れない(都市と騎士)
    if (LAYOUT.vertexEdges[v].some((eid) => eid !== edgeId && ownRoad(eid))) return null;
  }
  return '自分の道・建物に接続していません';
}

// 都市: 自分の開拓地の上にのみ
export function canPlaceCity(state, pid, vertexId) {
  const b = state.buildings[vertexId];
  if (!b || b.player !== pid || b.type !== 'settlement') {
    return '自分の開拓地の上にのみ都市を建てられます';
  }
  if (countPieces(state, pid, 'city') >= PIECE_LIMITS.city) return '都市のコマがありません';
  return null;
}
