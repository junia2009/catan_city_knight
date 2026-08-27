// 勝利点計算・最長交易路・最大騎士力(設計書 §5)

import { LAYOUT } from './board.js';
import { addLog } from '../state.js';
import { SEA_VICTORY_POINTS, NEW_ISLAND_VP } from './sea.js';

export const VICTORY_POINTS_TO_WIN = 10;
export const VICTORY_POINTS_TO_WIN_CAK = 13;
export const VICTORY_POINTS_TO_WIN_DRAGON = 12;

// pid を渡すと、その人に必要な点数を返す。
// 漁師たちの「古い靴」を持っている間だけ 1 点重くなる(公式)。
export function pointsToWin(state, pid = null) {
  let goal = VICTORY_POINTS_TO_WIN;
  if (state.mode === 'cak') goal = VICTORY_POINTS_TO_WIN_CAK;
  else if (state.mode === 'dragon') goal = VICTORY_POINTS_TO_WIN_DRAGON;
  else if (state.mode === 'sea') goal = SEA_VICTORY_POINTS;
  if (pid != null && state.players[pid]?.fish?.includes('shoe')) goal += 1;
  return goal;
}

// pid の最長交易路(辺の本数)。敵の建物がある頂点は通り抜けられない。
// 航海者たちでは道と船を合算するが、両者は「自分の建物の上でだけ」つながる(公式)。
export function longestRoadLength(state, pid) {
  const roadSet = new Set(
    Object.keys(state.roads).filter((eid) => state.roads[eid].player === pid),
  );
  const shipSet = new Set(
    Object.keys(state.ships ?? {}).filter((eid) => state.ships[eid].player === pid),
  );
  if (roadSet.size + shipSet.size === 0) return 0;

  const blocked = (v) => {
    const b = state.buildings[v];
    return b != null && b.player !== pid;
  };
  const isMine = (v) => state.buildings[v]?.player === pid;

  const startVerts = new Set();
  for (const eid of roadSet) for (const v of LAYOUT.edges[eid].v) startVerts.add(v);
  for (const eid of shipSet) for (const v of LAYOUT.edges[eid].v) startVerts.add(v);

  const used = new Set();
  // kind: 直前にたどった辺の種類('road' | 'ship')。null は起点。
  const dfs = (v, kind) => {
    let max = 0;
    for (const eid of LAYOUT.vertexEdges[v]) {
      if (used.has(eid)) continue;
      const next = roadSet.has(eid) ? 'road' : shipSet.has(eid) ? 'ship' : null;
      if (!next) continue;
      // 種類が変わる乗り継ぎは、自分の開拓地・都市の上でしかできない
      if (kind && kind !== next && !isMine(v)) continue;
      used.add(eid);
      const [a, b] = LAYOUT.edges[eid].v;
      const other = a === v ? b : a;
      const len = 1 + (blocked(other) ? 0 : dfs(other, next));
      if (len > max) max = len;
      used.delete(eid);
    }
    return max;
  };

  let best = 0;
  for (const v of startVerts) best = Math.max(best, dfs(v, null));
  return best;
}

// 保持者は「他者に厳密に超えられる」まで維持。5本未満になったら失う。
export function updateLongestRoad(state) {
  const lengths = state.players.map((p) => longestRoadLength(state, p.id));
  const prev = state.longestRoad.player;
  const max = Math.max(...lengths);

  let holder = null;
  if (prev != null && lengths[prev] >= 5 && lengths[prev] >= max) {
    holder = prev;
  } else if (max >= 5) {
    const candidates = state.players.filter((p) => lengths[p.id] === max).map((p) => p.id);
    if (candidates.length === 1) holder = candidates[0];
    else if (prev != null && lengths[prev] >= 5 && candidates.includes(prev)) holder = prev;
    // 同点で前保持者が資格を失っている場合は誰も持たない
  }

  state.longestRoad = { player: holder, length: holder != null ? lengths[holder] : 0 };
  if (holder !== prev && holder != null) {
    addLog(state, `${state.players[holder].name}が最長交易路(${lengths[holder]}本)を獲得!`);
  }
}

export function updateLargestArmy(state) {
  const counts = state.players.map((p) => p.knightsPlayed);
  const prev = state.largestArmy.player;
  const max = Math.max(...counts);

  let holder = prev;
  if (prev == null || counts[prev] < max) {
    if (max >= 3) {
      const candidates = state.players.filter((p) => counts[p.id] === max).map((p) => p.id);
      holder = candidates.length === 1 ? candidates[0] : prev;
    }
  }
  if (holder != null && counts[holder] < 3) holder = null;

  state.largestArmy = { player: holder, count: holder != null ? counts[holder] : 0 };
  if (holder !== prev && holder != null) {
    addLog(state, `${state.players[holder].name}が最大騎士力(${counts[holder]}人)を獲得!`);
  }
}

// 勝利点。includeHidden: 手札の勝利点カードを含める(勝利判定・本人表示用)
export function computePoints(state, pid, { includeHidden = false } = {}) {
  let pts = 0;
  for (const b of Object.values(state.buildings)) {
    if (b.player !== pid) continue;
    pts += b.type === 'city' ? 2 : 1;
  }
  if (state.longestRoad.player === pid) pts += 2;

  if (state.mode === 'cak') {
    // 最大騎士力は廃止。メトロポリス+2、守護者、進歩カード勝利点(公開済み)
    for (const vid of Object.values(state.metropolis)) {
      if (vid != null && state.buildings[vid]?.player === pid) pts += 2;
    }
    const p = state.players[pid];
    pts += p.defenderPoints + p.progressVP;
    if (state.merchant?.player === pid) pts += 1; // 商人の保持者
  } else {
    if (state.largestArmy.player === pid) pts += 2;
    pts += state.players[pid].treasures ?? 0; // ドラゴンの島: 財宝=+1点
    // 航海者たち: 本島(島番号0)以外に開拓地を建てた島ごとに+2点
    const newIslands = (state.players[pid].islands ?? []).filter((i) => i !== 0).length;
    pts += newIslands * NEW_ISLAND_VP;
    if (includeHidden) {
      pts += state.players[pid].devCards.filter((c) => c.type === 'vp').length;
    }
  }
  return pts;
}
