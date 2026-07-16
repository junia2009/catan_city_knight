// ドラゴンの島(独自ルール第3弾)
// 盗賊の代わりにドラゴンが島に棲む。ゾロ目で暴走し、最も豊かなヘックスを
// 炎上させる。見張り塔で襲撃を撃退すると財宝(+1点+資源1枚)を得る。

import { LAYOUT, PIPS, TERRAIN_RESOURCE } from './board.js';
import { rngInt } from '../rng.js';
import { RESOURCES, addLog } from './../state.js';
import { grantResource } from './build.js';

export const TOWER_COST = { wood: 1, brick: 1, ore: 1 };
export const MAX_TOWERS = 2;
export const BURN_TURNS = 8; // 炎上の継続(手番数)

// ドラゴンの巣: 最も出目の良い山ヘックス(なければ砂漠)
export function dragonNestHex(board) {
  let best = null;
  let bestPips = -1;
  for (const hid of LAYOUT.hexIds) {
    const hex = board.hexes[hid];
    if (hex.terrain !== 'mountain' || !hex.token) continue;
    if (PIPS[hex.token] > bestPips) {
      bestPips = PIPS[hex.token];
      best = hid;
    }
  }
  return best ?? LAYOUT.hexIds.find((h) => board.hexes[h].terrain === 'desert');
}

export function isBurning(state, hid) {
  return (state.burned?.[hid] ?? 0) > state.turn;
}

// 見張り塔の建設可否
export function canBuildTower(state, pid, vid) {
  const b = state.buildings[vid];
  if (!b || b.player !== pid) return '自分の開拓地・都市の上に建てます';
  if (state.towers[vid] != null) return 'すでに見張り塔があります';
  const count = Object.values(state.towers).filter((p) => p === pid).length;
  if (count >= MAX_TOWERS) return `見張り塔は${MAX_TOWERS}基までです`;
  return null;
}

// vid のプレイヤーの塔が hid に隣接しているか
function towerProtects(state, pid, hid) {
  return LAYOUT.hexVertices[hid].some(
    (vid) => state.towers[vid] === pid,
  );
}

// 財宝獲得: +1点(computePoints で加算)+ 銀行からランダム資源1枚
export function grantTreasure(state, pid) {
  const p = state.players[pid];
  p.treasures += 1;
  const stocked = RESOURCES.filter((r) => state.bank.resources[r] > 0);
  let bonus = '';
  if (stocked.length) {
    let i;
    [state.rng, i] = rngInt(state.rng, stocked.length);
    grantResource(state, pid, stocked[i], 1);
    bonus = 'と資源1枚';
  }
  addLog(state, `💎 ${p.name}が財宝を獲得!(+1点${bonus})`);
}

// 暴走の襲撃先: 産出価値(pips × 建物重み)が最大の土地ヘックス。
// 炎上中・現在地は除く。候補がなければ null(巣へ帰る)。
export function rampageTarget(state) {
  let best = null;
  let bestValue = 0;
  for (const hid of LAYOUT.hexIds) {
    const hex = state.board.hexes[hid];
    if (!hex.token || !TERRAIN_RESOURCE[hex.terrain]) continue;
    if (hid === state.board.robber || isBurning(state, hid)) continue;
    let weight = 0;
    for (const vid of LAYOUT.hexVertices[hid]) {
      const b = state.buildings[vid];
      if (b) weight += b.type === 'city' ? 2 : 1;
    }
    if (weight === 0) continue;
    const value = PIPS[hex.token] * weight;
    if (value > bestValue) {
      bestValue = value;
      best = hid;
    }
  }
  return best;
}

// ゾロ目の暴走を解決する(資源分配の後に呼ぶ)
export function resolveRampage(state) {
  const target = rampageTarget(state);
  if (target == null) {
    state.board.robber = state.dragon.nestHex;
    addLog(state, '🐉 ドラゴンは獲物を見つけられず、巣へ帰りました');
    return;
  }
  state.board.robber = target; // ドラゴンの現在地 = 封鎖ヘックス
  state.burned[target] = state.turn + BURN_TURNS;
  const num = state.board.hexes[target].token;
  addLog(state, `🐉🔥 ドラゴンが暴走! ${num}のヘックスが炎上(${BURN_TURNS}手番 産出停止)`);

  // 隣接プレイヤー: 見張り塔があれば撃退して財宝、なければ1枚奪われる
  const victims = new Set();
  for (const vid of LAYOUT.hexVertices[target]) {
    const b = state.buildings[vid];
    if (b) victims.add(b.player);
  }
  for (const pid of victims) {
    if (towerProtects(state, pid, target)) {
      addLog(state, `🗼 ${state.players[pid].name}の見張り塔がドラゴンを撃退!`);
      grantTreasure(state, pid);
      continue;
    }
    const t = state.players[pid];
    const pool = [];
    for (const r of RESOURCES) for (let i = 0; i < t.resources[r]; i++) pool.push(r);
    if (!pool.length) continue;
    let idx;
    [state.rng, idx] = rngInt(state.rng, pool.length);
    t.resources[pool[idx]] -= 1;
    state.bank.resources[pool[idx]] += 1; // ドラゴンの財宝の山(銀行)へ
    addLog(state, `🐉 ${t.name}が資源を1枚焼かれました`);
  }
}
