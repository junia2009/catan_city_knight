// 都市改良とメトロポリス(設計書 §9.4)

import { addLog } from '../../state.js';

export const TRACKS = ['trade', 'politics', 'science'];
export const TRACK_JP = { trade: '交易', politics: '政治', science: '科学' };
export const TRACK_COMMODITY = { trade: 'cloth', politics: 'coin', science: 'paper' };
export const MAX_IMPROVEMENT = 5;

// 次のレベルのコスト(Lv n へは商品 n 枚)。クレーン使用ターンは1枚引き。
export function improvementCost(level, state = null) {
  return Math.max(0, level - (state?.turnFlags?.crane ? 1 : 0));
}

export function canBuyImprovement(state, pid, track) {
  if (!TRACKS.includes(track)) return '不正な系統です';
  const p = state.players[pid];
  const lv = p.improvements[track];
  if (lv >= MAX_IMPROVEMENT) return 'すでに最高レベルです';
  const hasCity = Object.values(state.buildings).some(
    (b) => b.player === pid && b.type === 'city',
  );
  if (!hasCity) return '都市が必要です';
  const cost = improvementCost(lv + 1, state);
  const com = TRACK_COMMODITY[track];
  if (p.commodities[com] < cost) return `${TRACK_JP[track]}Lv${lv + 1}には商品が${cost}枚必要です`;
  return null;
}

// メトロポリスでない自分の都市
function eligibleMetroCities(state, pid) {
  const metros = new Set(Object.values(state.metropolis).filter(Boolean));
  return Object.entries(state.buildings)
    .filter(([vid, b]) => b.player === pid && b.type === 'city' && !metros.has(vid))
    .map(([vid]) => vid);
}

// 改良購入の適用。メトロポリスの獲得/移動もここで処理する。
export function applyImprovement(state, pid, track) {
  const p = state.players[pid];
  const lv = p.improvements[track] + 1;
  const cost = improvementCost(lv, state);
  if (state.turnFlags?.crane) delete state.turnFlags.crane; // クレーンは1回で消費
  const com = TRACK_COMMODITY[track];
  p.commodities[com] -= cost;
  state.bank.commodities[com] += cost;
  p.improvements[track] = lv;
  addLog(state, `${p.name}が${TRACK_JP[track]}をLv${lv}に改良`);

  // メトロポリス: 最初に Lv4 到達で獲得、Lv5 で追い越されると移動
  const holderVid = state.metropolis[track];
  const holderPid = holderVid != null ? state.buildings[holderVid]?.player : null;
  const shouldClaim =
    (lv >= 4 && holderVid == null) ||
    (lv === 5 && holderPid != null && holderPid !== pid &&
      state.players[holderPid].improvements[track] < 5);

  if (shouldClaim) {
    const cities = eligibleMetroCities(state, pid);
    if (cities.length) {
      if (holderVid != null) {
        addLog(state, `${state.players[holderPid].name}はメトロポリス(${TRACK_JP[track]})を失いました`);
      }
      state.metropolis[track] = cities[0];
      addLog(state, `🏙 ${p.name}がメトロポリス(${TRACK_JP[track]})を獲得! +2点`);
    }
  }
}

export function metropolisCount(state, pid) {
  return Object.values(state.metropolis).filter(
    (vid) => vid != null && state.buildings[vid]?.player === pid,
  ).length;
}
