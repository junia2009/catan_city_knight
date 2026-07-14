// 勝利点計算・最長交易路・最大騎士力(設計書 §5)

import { LAYOUT } from './board.js';
import { addLog } from '../state.js';

export const VICTORY_POINTS_TO_WIN = 10;

// pid の最長交易路(辺の本数)。敵の建物がある頂点は通り抜けられない。
export function longestRoadLength(state, pid) {
  const ownSet = new Set(
    Object.keys(state.roads).filter((eid) => state.roads[eid].player === pid),
  );
  if (ownSet.size === 0) return 0;

  const blocked = (v) => {
    const b = state.buildings[v];
    return b != null && b.player !== pid;
  };

  const startVerts = new Set();
  for (const eid of ownSet) for (const v of LAYOUT.edges[eid].v) startVerts.add(v);

  const used = new Set();
  const dfs = (v) => {
    let max = 0;
    for (const eid of LAYOUT.vertexEdges[v]) {
      if (!ownSet.has(eid) || used.has(eid)) continue;
      used.add(eid);
      const [a, b] = LAYOUT.edges[eid].v;
      const other = a === v ? b : a;
      const len = 1 + (blocked(other) ? 0 : dfs(other));
      if (len > max) max = len;
      used.delete(eid);
    }
    return max;
  };

  let best = 0;
  for (const v of startVerts) best = Math.max(best, dfs(v));
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
  if (state.largestArmy.player === pid) pts += 2;
  if (includeHidden) {
    pts += state.players[pid].devCards.filter((c) => c.type === 'vp').length;
  }
  return pts;
}
