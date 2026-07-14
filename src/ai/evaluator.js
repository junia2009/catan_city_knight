// 盤面評価関数(設計書 §7.2)

import { LAYOUT, PIPS, TERRAIN_RESOURCE } from '../rules/board.js';
import { RESOURCES } from '../state.js';

// わずかな資源希少度の重み(小麦・鉱石を優先)
const RES_WEIGHT = { wood: 1.0, brick: 1.0, sheep: 0.9, wheat: 1.15, ore: 1.1 };

// 頂点に接するヘックスの出目確率合計(pips)
export function pipsOfVertex(state, vid) {
  let sum = 0;
  for (const hid of LAYOUT.vertexHexes[vid]) {
    const hex = state.board.hexes[hid];
    if (hex.token) sum += PIPS[hex.token];
  }
  return sum;
}

// プレイヤーの資源別産出量(pips 単位)
export function playerProduction(state, pid) {
  const prod = { wood: 0, brick: 0, sheep: 0, wheat: 0, ore: 0 };
  for (const [vid, b] of Object.entries(state.buildings)) {
    if (b.player !== pid) continue;
    const mult = b.type === 'city' ? 2 : 1;
    for (const hid of LAYOUT.vertexHexes[vid]) {
      const hex = state.board.hexes[hid];
      const res = TERRAIN_RESOURCE[hex.terrain];
      if (res && hex.token) prod[res] += PIPS[hex.token] * mult;
    }
  }
  return prod;
}

// 頂点の入植価値: 産出期待値 + 多様性ボーナス + 港ボーナス
export function vertexValue(state, pid, vid) {
  const prod = playerProduction(state, pid);
  let value = 0;
  const newRes = new Set();

  for (const hid of LAYOUT.vertexHexes[vid]) {
    const hex = state.board.hexes[hid];
    const res = TERRAIN_RESOURCE[hex.terrain];
    if (!res || !hex.token) continue;
    value += PIPS[hex.token] * RES_WEIGHT[res];
    if (prod[res] === 0) newRes.add(res);
  }
  value += newRes.size * 2; // 資源の多様性

  for (const port of state.board.ports) {
    if (LAYOUT.edges[port.edgeId].v.includes(vid)) {
      value += port.type === '3:1' ? 1.5 : 2;
    }
  }
  return value;
}

// 盗賊の置き先としての価値: 相手の産出を最も阻害する(自分に隣接しない)
export function robberHexValue(state, pid, hid) {
  const hex = state.board.hexes[hid];
  if (!hex.token) return -1; // 砂漠は無意味
  let value = 0;
  for (const vid of LAYOUT.hexVertices[hid]) {
    const b = state.buildings[vid];
    if (!b) continue;
    if (b.player === pid) return -100; // 自分のヘックスは避ける
    value += PIPS[hex.token] * (b.type === 'city' ? 2 : 1);
  }
  return value;
}

// 目標に対する不足資源
export function missingFor(player, cost) {
  const missing = {};
  for (const [r, n] of Object.entries(cost)) {
    const lack = n - player.resources[r];
    if (lack > 0) missing[r] = lack;
  }
  return missing;
}

export function surplusOver(player, cost) {
  const surplus = {};
  for (const r of RESOURCES) {
    const extra = player.resources[r] - (cost[r] ?? 0);
    if (extra > 0) surplus[r] = extra;
  }
  return surplus;
}
