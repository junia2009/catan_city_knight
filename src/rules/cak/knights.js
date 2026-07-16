// 騎士システム(設計書 §9.2)
// 騎士は頂点占有物(1頂点1オブジェクト)。buildings と同じ座標系に載る。

import { LAYOUT } from '../board.js';
import { addLog } from '../../state.js';

export const KNIGHT_COSTS = {
  build: { sheep: 1, ore: 1 },
  activate: { wheat: 1 },
  promote: { sheep: 1, ore: 1 },
};

// レベルごとのコマ数上限(公式: 各レベル2体)
export const KNIGHT_LIMIT_PER_LEVEL = 2;

export function knightAt(state, vid) {
  return state.knights[vid] ?? null;
}

export function vertexOccupied(state, vid) {
  return !!state.buildings[vid] || !!state.knights[vid];
}

export function countKnights(state, pid, level = null) {
  return Object.values(state.knights).filter(
    (k) => k.player === pid && (level == null || k.level === level),
  ).length;
}

// 建設: 空き頂点 + 自分の道に接続
export function canPlaceKnight(state, pid, vid) {
  if (!LAYOUT.vertices[vid]) return '不正な頂点です';
  if (vertexOccupied(state, vid)) return 'その頂点は占有されています';
  if (countKnights(state, pid, 1) >= KNIGHT_LIMIT_PER_LEVEL) return 'Lv1騎士のコマがありません';
  const connected = LAYOUT.vertexEdges[vid].some((eid) => state.roads[eid]?.player === pid);
  if (!connected) return '自分の道に接続していません';
  return null;
}

export function canPromoteKnight(state, pid, vid) {
  const k = state.knights[vid];
  if (!k || k.player !== pid) return '自分の騎士ではありません';
  if (k.level >= 3) return 'すでに最高位です';
  if (k.level === 2 && state.players[pid].improvements.politics < 3) {
    return 'Lv3(要塞騎士)には政治Lv3が必要です';
  }
  if (countKnights(state, pid, k.level + 1) >= KNIGHT_LIMIT_PER_LEVEL) {
    return `Lv${k.level + 1}騎士のコマがありません`;
  }
  return null;
}

// この騎士がこのターン行動できるか(活性 + 活性化したターンは不可)
export function knightCanAct(state, vid, pid) {
  const k = state.knights[vid];
  if (!k || k.player !== pid) return '自分の騎士ではありません';
  if (!k.active) return '騎士が不活性です';
  if (k.activatedTurn === state.turn) return '活性化したターンには行動できません';
  return null;
}

// 自分の道ネットワーク上で from から到達できる頂点(敵の占有物は通過不可)
export function reachableVertices(state, pid, from) {
  const visited = new Set([from]);
  const queue = [from];
  const result = [];
  while (queue.length) {
    const v = queue.shift();
    for (const eid of LAYOUT.vertexEdges[v]) {
      if (state.roads[eid]?.player !== pid) continue;
      const [a, b] = LAYOUT.edges[eid].v;
      const next = a === v ? b : a;
      if (visited.has(next)) continue;
      visited.add(next);
      const bld = state.buildings[next];
      const kn = state.knights[next];
      const enemy = (bld && bld.player !== pid) || (kn && kn.player !== pid);
      if (!bld && !kn) result.push(next);
      if (kn && kn.player !== pid) result.push(next); // 追い出し候補(レベル判定は呼び出し側)
      if (!enemy) queue.push(next); // 敵の占有物は通過できない
    }
  }
  return result;
}

export function canMoveKnight(state, pid, from, to) {
  const actErr = knightCanAct(state, from, pid);
  if (actErr) return actErr;
  const dests = reachableVertices(state, pid, from);
  if (!dests.includes(to)) return 'その頂点へは移動できません';
  const target = state.knights[to];
  if (target) {
    if (target.player === pid) return '自分の騎士がいます';
    if (target.level >= state.knights[from].level) return '同レベル以上の騎士は追い出せません';
  }
  if (state.buildings[to]) return '建物がある頂点へは移動できません';
  return null;
}

// 追い出された騎士の再配置(自分の道網で到達できる空き頂点、なければ除去)
export function displaceKnight(state, vid) {
  const k = state.knights[vid];
  const spots = reachableVertices(state, k.player, vid).filter(
    (v) => !state.buildings[v] && !state.knights[v],
  );
  delete state.knights[vid];
  if (spots.length) {
    state.knights[spots[0]] = { ...k, active: false };
    addLog(state, `${state.players[k.player].name}の騎士が追い出され、移動しました`);
  } else {
    addLog(state, `${state.players[k.player].name}の騎士が盤面から除去されました`);
  }
}

// 移動の適用(追い出し込み)。移動した騎士は不活性化する。
export function applyKnightMove(state, pid, from, to) {
  const k = state.knights[from];
  if (state.knights[to]) displaceKnight(state, to);
  delete state.knights[from];
  state.knights[to] = { ...k, active: false };
}

// 盗賊追い払いが可能か(騎士が盗賊ヘックスに隣接)
export function canChaseRobber(state, pid, vid) {
  const actErr = knightCanAct(state, vid, pid);
  if (actErr) return actErr;
  const touching = LAYOUT.hexVertices[state.board.robber]?.includes(vid);
  if (!touching) return '騎士が盗賊のヘックスに隣接していません';
  return null;
}
