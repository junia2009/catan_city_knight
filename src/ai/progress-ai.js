// 進歩カードの CPU 使用判断(設計書 §7.4)
// カードごとの評価関数プラグイン: SCORERS[id](state, pid) → { score, params } | null
// score が閾値以上のカードのうち最高スコアのものを使う。

import { LAYOUT, PIPS, TERRAIN_RESOURCE } from '../rules/board.js';
import { RESOURCES } from '../state.js';
import { totalCards, canBuildWall } from '../rules/build.js';
import { tradeRate } from '../rules/trade.js';
import { computePoints } from '../rules/victory.js';
import { canPromoteKnight } from '../rules/cak/knights.js';
import {
  TRACKS, TRACK_COMMODITY, MAX_IMPROVEMENT, canBuyImprovement, improvementCost,
} from '../rules/cak/improvements.js';
import { COMMODITIES, PROGRESS_CARDS } from '../rules/cak/progress-cards.js';
import { validateAction } from '../actions.js';
import {
  playerProduction, robberHexValue, vertexValue, missingFor, surplusOver,
} from './evaluator.js';
import { legalRobberHexes, legalRoadEdges } from './legal-moves.js';
import { nextGoal } from './cpu-player.js';

function othersOf(state, pid) {
  return state.players.filter((o) => o.id !== pid);
}

// 自分の建物が隣接する土地ヘックス一覧
function myLandHexes(state, pid) {
  return LAYOUT.hexIds.filter((hid) => {
    if (!TERRAIN_RESOURCE[state.board.hexes[hid].terrain]) return false;
    return LAYOUT.hexVertices[hid].some((v) => state.buildings[v]?.player === pid);
  });
}

// そのヘックスに置く自分の建物数(都市は2)
function myWeightOn(state, pid, hid) {
  let w = 0;
  for (const vid of LAYOUT.hexVertices[hid]) {
    const b = state.buildings[vid];
    if (b?.player === pid) w += b.type === 'city' ? 2 : 1;
  }
  return w;
}

const SCORERS = {
  merchant(state, pid) {
    // 保持で+1点なのでほぼ常に使う。自分の産出が多い資源のヘックスに置く
    const prod = playerProduction(state, pid);
    let bestHex = null;
    let bestW = -1;
    for (const hid of myLandHexes(state, pid)) {
      const res = TERRAIN_RESOURCE[state.board.hexes[hid].terrain];
      const w = prod[res] + myWeightOn(state, pid, hid);
      if (w > bestW) { bestW = w; bestHex = hid; }
    }
    if (!bestHex) return null;
    if (state.merchant?.player === pid) return null; // すでに保持中なら温存
    return { score: 6, params: { hexId: bestHex } };
  },

  merchantFleet(state, pid) {
    // 余剰2枚以上をレート3以上でしか交換できないときに使い、その場で得をする
    const goal = nextGoal(state, pid);
    if (!goal) return null;
    const surplus = surplusOver(state.players[pid], goal.cost);
    for (const [r, n] of Object.entries(surplus)) {
      if (n >= 2 && tradeRate(state, pid, r) > 2) {
        return { score: 2, params: { key: r } };
      }
    }
    return null;
  },

  resourceMonopoly(state, pid) {
    const goal = nextGoal(state, pid);
    const missing = goal ? missingFor(state.players[pid], goal.cost) : {};
    let best = null;
    for (const r of RESOURCES) {
      const take = othersOf(state, pid).reduce((a, o) => a + Math.min(2, o.resources[r]), 0);
      const score = take * (missing[r] ? 1.6 : 1.0);
      if (!best || score > best.score) best = { score, params: { resource: r } };
    }
    return best && best.score >= 2 ? best : null;
  },

  tradeMonopoly(state, pid) {
    let best = null;
    for (const c of COMMODITIES) {
      const take = othersOf(state, pid).filter((o) => o.commodities[c] > 0).length;
      const wantTrack = TRACKS.find((t) => TRACK_COMMODITY[t] === c);
      const useful = state.players[pid].improvements[wantTrack] < MAX_IMPROVEMENT ? 1.3 : 1.0;
      const score = take * 1.2 * useful;
      if (!best || score > best.score) best = { score, params: { commodity: c } };
    }
    return best && best.score >= 2 ? best : null;
  },

  masterMerchant(state, pid) {
    const mine = computePoints(state, pid);
    const targets = othersOf(state, pid).filter(
      (o) => computePoints(state, o.id) > mine && totalCards(o) > 0,
    );
    if (!targets.length) return null;
    const t = targets.reduce((a, b) => (totalCards(a) >= totalCards(b) ? a : b));
    return { score: 2 + Math.min(2, totalCards(t)), params: { target: t.id } };
  },

  commercialHarbor(state, pid) {
    const holders = othersOf(state, pid).filter(
      (o) => COMMODITIES.some((c) => o.commodities[c] > 0),
    ).length;
    if (!holders) return null;
    const goal = nextGoal(state, pid);
    const surplus = surplusOver(state.players[pid], goal?.cost ?? {});
    const r = Object.keys(surplus).sort((a, b) => surplus[b] - surplus[a])[0];
    if (!r || surplus[r] < holders) return null; // 渡す分が足りないなら温存
    return { score: holders * 1.3, params: { resource: r } };
  },

  bishop(state, pid) {
    const hexes = legalRobberHexes(state);
    let best = null;
    for (const h of hexes) {
      const v = robberHexValue(state, pid, h);
      if (!best || v > best.v) best = { v, h };
    }
    if (!best || best.v <= 0) return null;
    return { score: 1.5 + best.v * 0.3, params: { hexId: best.h } };
  },

  deserter(state, pid) {
    const targets = othersOf(state, pid).filter((o) =>
      Object.values(state.knights).some((k) => k.player === o.id),
    );
    if (!targets.length) return null;
    // 騎士戦力が最大の相手から奪う
    const strength = (o) =>
      Object.values(state.knights)
        .filter((k) => k.player === o.id)
        .reduce((a, k) => a + k.level, 0);
    const t = targets.reduce((a, b) => (strength(a) >= strength(b) ? a : b));
    return { score: 3, params: { target: t.id } };
  },

  diplomat(state, pid) {
    // 敵の開いた道のみ対象(自分の道は消さない)。交易路首位を優先
    let best = null;
    for (const [eid, road] of Object.entries(state.roads)) {
      if (road.player === pid) continue;
      const a = { type: 'PLAY_PROGRESS_CARD', player: pid, index: 0, params: { edgeId: eid } };
      if (PROGRESS_CARDS.diplomat.validate(state, pid, a.params)) continue;
      const isLeader = state.longestRoad.player === road.player;
      const score = isLeader ? 3 : 1.2;
      if (!best || score > best.score) best = { score, params: { edgeId: eid } };
    }
    return best;
  },

  intrigue(state, pid) {
    for (const [vid, k] of Object.entries(state.knights)) {
      if (k.player === pid) continue;
      if (!LAYOUT.vertexEdges[vid].some((e) => state.roads[e]?.player === pid)) continue;
      return { score: 1.5 + k.level, params: { vertexId: vid } };
    }
    return null;
  },

  saboteur(state, pid) {
    const mine = computePoints(state, pid);
    let damage = 0;
    for (const o of othersOf(state, pid)) {
      if (computePoints(state, o.id) >= mine && totalCards(o) >= 2) {
        damage += Math.floor(totalCards(o) / 2);
      }
    }
    if (damage < 3) return null;
    return { score: damage * 0.8, params: null };
  },

  spy(state, pid) {
    const targets = othersOf(state, pid).filter((o) => o.progressCards.length > 0);
    if (!targets.length) return null;
    const t = targets.reduce((a, b) => (a.progressCards.length >= b.progressCards.length ? a : b));
    return { score: 2, params: { target: t.id } };
  },

  warlord(state, pid) {
    const inactive = Object.values(state.knights).filter(
      (k) => k.player === pid && !k.active,
    ).length;
    if (!inactive) return null;
    const urgent = state.barbarians.position >= 5;
    if (inactive < 2 && !urgent) return null; // 1体だけなら小麦1で足りる
    return { score: inactive * 1.2 + (urgent ? 2 : 0), params: null };
  },

  wedding(state, pid) {
    const mine = computePoints(state, pid);
    const gain = othersOf(state, pid)
      .filter((o) => computePoints(state, o.id) > mine)
      .reduce((a, o) => a + Math.min(2, totalCards(o)), 0);
    if (gain < 2) return null;
    return { score: gain, params: null };
  },

  alchemist(state, pid) {
    // 自分の産出が最大の出目を選ぶ。赤は進歩カード獲得のため小さく
    let bestTotal = null;
    let bestGain = 0;
    for (let total = 2; total <= 12; total++) {
      if (total === 7) continue;
      let gain = 0;
      for (const hid of LAYOUT.hexIds) {
        const hex = state.board.hexes[hid];
        if (hex.token !== total || state.board.robber === hid) continue;
        gain += myWeightOn(state, pid, hid);
      }
      if (gain > bestGain) { bestGain = gain; bestTotal = total; }
    }
    if (!bestTotal || bestGain < 2) return null;
    const red = Math.max(1, bestTotal - 6);
    return { score: 2 + bestGain * 0.5, params: { red, yellow: bestTotal - red } };
  },

  crane(state, pid) {
    const p = state.players[pid];
    for (const t of TRACKS) {
      const lv = p.improvements[t];
      if (lv >= MAX_IMPROVEMENT) continue;
      if (canBuyImprovement(state, pid, t) === null) continue; // クレーンなしでも買える
      const com = TRACK_COMMODITY[t];
      // クレーンを使えばちょうど買える(1枚足りない)状況でのみ使う
      if (p.commodities[com] === improvementCost(lv + 1) - 1) {
        const hasCity = Object.values(state.buildings).some(
          (b) => b.player === pid && b.type === 'city',
        );
        if (hasCity) return { score: 3, params: null };
      }
    }
    return null;
  },

  engineer(state, pid) {
    const vid = Object.keys(state.buildings).find(
      (v) => canBuildWall(state, pid, v) === null,
    );
    if (!vid) return null;
    return { score: 2, params: { vertexId: vid } };
  },

  inventor(state, pid) {
    // 自分の建物が多いヘックスに強い数字を持ってくる入れ替えを探す
    const movable = LAYOUT.hexIds.filter((hid) => {
      const t = state.board.hexes[hid].token;
      return t && ![2, 6, 8, 12].includes(t);
    });
    let best = null;
    for (const a of movable) {
      for (const b of movable) {
        if (a >= b) continue;
        const ta = state.board.hexes[a].token;
        const tb = state.board.hexes[b].token;
        if (ta === tb) continue;
        const wa = myWeightOn(state, pid, a);
        const wb = myWeightOn(state, pid, b);
        const gain = (PIPS[tb] - PIPS[ta]) * wa + (PIPS[ta] - PIPS[tb]) * wb;
        if (!best || gain > best.gain) best = { gain, params: { a, b } };
      }
    }
    if (!best || best.gain < 2) return null;
    return { score: 1 + best.gain * 0.7, params: best.params };
  },

  irrigation(state, pid) {
    const n = myLandHexes(state, pid).filter(
      (h) => state.board.hexes[h].terrain === 'field',
    ).length;
    return n ? { score: n * 1.5, params: null } : null;
  },

  medicine(state, pid) {
    const p = state.players[pid];
    if (p.resources.ore < 2 || p.resources.wheat < 1) return null;
    const vids = Object.entries(state.buildings)
      .filter(([, b]) => b.player === pid && b.type === 'settlement')
      .map(([vid]) => vid);
    if (!vids.length) return null;
    const vid = vids.reduce((a, b) => (vertexValue(state, pid, a) >= vertexValue(state, pid, b) ? a : b));
    return { score: 6, params: { vertexId: vid } };
  },

  mining(state, pid) {
    const n = myLandHexes(state, pid).filter(
      (h) => state.board.hexes[h].terrain === 'mountain',
    ).length;
    return n ? { score: n * 1.5, params: null } : null;
  },

  roadBuilding(state, pid) {
    const first = legalRoadEdges(state, pid);
    if (!first.length) return null;
    const e1 = first[0];
    const second = legalRoadEdges(state, pid, { extraRoads: { [e1]: true } }).filter((e) => e !== e1);
    const edges = second.length ? [e1, second[0]] : [e1];
    return { score: 2.2, params: { edges } };
  },

  smith(state, pid) {
    const n = Object.keys(state.knights).filter(
      (vid) => canPromoteKnight(state, pid, vid) === null,
    ).length;
    if (!n) return null;
    return { score: n * 2, params: null };
  },
};

// 手札から最良の進歩カードプレイを選ぶ(ロール後用)。
// preRoll カード(錬金術師)は含めない。
export function pickProgressPlay(state, pid, { threshold = null } = {}) {
  // 弱いCPUはカードの使いどころを逃しがち(高い閾値)
  if (threshold == null) {
    threshold = state.difficulty === 'easy' ? 2.5 : state.difficulty === 'normal' ? 1.3 : 1;
  }
  const p = state.players[pid];
  let best = null;
  for (let i = 0; i < p.progressCards.length; i++) {
    const card = p.progressCards[i];
    if (card.boughtTurn >= state.turn) continue;
    const def = PROGRESS_CARDS[card.id];
    if (def.preRoll) continue;
    const scorer = SCORERS[card.id];
    if (!scorer) continue;
    const r = scorer(state, pid);
    if (!r || r.score < threshold) continue;
    const action = { type: 'PLAY_PROGRESS_CARD', player: pid, index: i, params: r.params };
    if (validateAction(state, action) !== null) continue;
    if (!best || r.score > best.score) best = { score: r.score, action };
  }
  return best?.action ?? null;
}

// ロール前の錬金術師使用判断
export function pickAlchemist(state, pid) {
  const p = state.players[pid];
  const i = p.progressCards.findIndex(
    (c) => c.id === 'alchemist' && c.boughtTurn < state.turn,
  );
  if (i < 0) return null;
  const r = SCORERS.alchemist(state, pid);
  if (!r) return null;
  const action = { type: 'PLAY_PROGRESS_CARD', player: pid, index: i, params: r.params };
  return validateAction(state, action) === null ? action : null;
}
