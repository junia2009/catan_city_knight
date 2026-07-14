// ダイス・資源分配(設計書 §5, §6)

import { LAYOUT, TERRAIN_RESOURCE } from './board.js';
import { rngInt } from '../rng.js';
import { RESOURCES, RES_JP, addLog } from '../state.js';

export function rollTwoDice(state) {
  let a, b;
  [state.rng, a] = rngInt(state.rng, 6);
  [state.rng, b] = rngInt(state.rng, 6);
  return [a + 1, b + 1];
}

// 出目 total に対する資源分配。
// 銀行在庫ルール: ある資源の需要が在庫を超える場合、
//  - 需要者が1人ならその人へ在庫分だけ渡す
//  - 複数人なら誰ももらえない
export function distributeForRoll(state, total) {
  const demands = {}; // res -> { pid: count }
  for (const hid of LAYOUT.hexIds) {
    const hex = state.board.hexes[hid];
    if (hex.token !== total || state.board.robber === hid) continue;
    const res = TERRAIN_RESOURCE[hex.terrain];
    if (!res) continue;
    for (const vid of LAYOUT.hexVertices[hid]) {
      const b = state.buildings[vid];
      if (!b) continue;
      const n = b.type === 'city' ? 2 : 1;
      demands[res] ??= {};
      demands[res][b.player] = (demands[res][b.player] ?? 0) + n;
    }
  }

  const gains = state.players.map(() => ({}));
  for (const res of RESOURCES) {
    const d = demands[res];
    if (!d) continue;
    const pids = Object.keys(d).map(Number);
    const totalDemand = pids.reduce((s, pid) => s + d[pid], 0);
    const supply = state.bank.resources[res];
    if (totalDemand <= supply) {
      for (const pid of pids) {
        state.bank.resources[res] -= d[pid];
        state.players[pid].resources[res] += d[pid];
        gains[pid][res] = d[pid];
      }
    } else if (pids.length === 1 && supply > 0) {
      const pid = pids[0];
      state.bank.resources[res] -= supply;
      state.players[pid].resources[res] += supply;
      gains[pid][res] = supply;
    } else if (pids.length >= 1) {
      addLog(state, `${RES_JP[res]}の在庫不足のため分配なし`);
    }
  }

  for (const p of state.players) {
    const got = Object.entries(gains[p.id]);
    if (got.length) {
      addLog(state, `${p.name}: ${got.map(([r, n]) => `${RES_JP[r]}×${n}`).join(' ')}`);
    }
  }
  return gains;
}
