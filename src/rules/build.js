// 建設可否判定・コスト(設計書 §5)
// すべて純粋関数。エラー理由の文字列 or null(合法)を返す。

import { LAYOUT } from './board.js';
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

export function countPieces(state, pid, type) {
  if (type === 'road') {
    return Object.values(state.roads).filter((r) => r.player === pid).length;
  }
  return Object.values(state.buildings).filter((b) => b.player === pid && b.type === type).length;
}

// 開拓地: 空き頂点 + 距離ルール + (通常時)自分の道に接続
export function canPlaceSettlement(state, pid, vertexId, { needRoad = true } = {}) {
  if (!LAYOUT.vertices[vertexId]) return '不正な頂点です';
  if (state.buildings[vertexId]) return 'その頂点には建物があります';
  for (const adj of LAYOUT.vertexAdj[vertexId]) {
    if (state.buildings[adj]) return '距離ルール: 隣接頂点に建物があります';
  }
  if (countPieces(state, pid, 'settlement') >= PIECE_LIMITS.settlement) {
    return '開拓地のコマがありません';
  }
  if (needRoad) {
    const connected = LAYOUT.vertexEdges[vertexId].some(
      (eid) => state.roads[eid]?.player === pid,
    );
    if (!connected) return '自分の道に接続していません';
  }
  return null;
}

// 道: 空き辺 + 自分の建物か道に接続(敵の建物を通しての接続は不可)
// requireVertex: 初期配置用(その頂点に接する辺のみ)
// extraRoads: 街道建設カードの2本目判定用の仮想追加道 { edgeId: true }
export function canPlaceRoad(state, pid, edgeId, { requireVertex = null, extraRoads = null } = {}) {
  const edge = LAYOUT.edges[edgeId];
  if (!edge) return '不正な辺です';
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
    if (b && b.player === pid) return null; // 自分の建物に接続
    if (b && b.player !== pid) continue; // 敵の建物は通れない
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
