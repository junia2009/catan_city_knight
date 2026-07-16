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

// イベントダイス: 船×3面 + 交易/政治/科学 各1面(設計書 §9.3)
export function rollEventDie(state) {
  let f;
  [state.rng, f] = rngInt(state.rng, 6);
  return ['ship', 'ship', 'ship', 'trade', 'politics', 'science'][f];
}

// 都市の商品産出(設計書 §9.1): 森=紙、山=コイン、牧草地=布
const TERRAIN_COMMODITY = { forest: 'paper', mountain: 'coin', pasture: 'cloth' };
const COM_JP = { cloth: '布', coin: 'コイン', paper: '紙' };

// 出目 total に対する資源分配。
// 銀行在庫ルール: ある資源の需要が在庫を超える場合、
//  - 需要者が1人ならその人へ在庫分だけ渡す
//  - 複数人なら誰ももらえない
export function distributeForRoll(state, total) {
  const demands = {}; // res -> { pid: count }
  const comDemands = {}; // commodity -> { pid: count }(cak のみ)
  const cak = state.mode === 'cak';

  for (const hid of LAYOUT.hexIds) {
    const hex = state.board.hexes[hid];
    if (hex.token !== total || state.board.robber === hid) continue;
    // ドラゴンの島: 炎上中のヘックスは産出しない
    if ((state.burned?.[hid] ?? 0) > state.turn) continue;
    const res = TERRAIN_RESOURCE[hex.terrain];
    if (!res) continue;
    const commodity = cak ? TERRAIN_COMMODITY[hex.terrain] : null;
    for (const vid of LAYOUT.hexVertices[hid]) {
      const b = state.buildings[vid];
      if (!b) continue;
      // 都市: 基本は資源×2。cak では商品の出る地形は資源1+商品1(設計書 §9.1)
      let n = b.type === 'city' ? 2 : 1;
      if (b.type === 'city' && commodity) {
        n = 1;
        comDemands[commodity] ??= {};
        comDemands[commodity][b.player] = (comDemands[commodity][b.player] ?? 0) + 1;
      }
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

  // 商品の分配(在庫内で個別に付与)
  const comGains = state.players.map(() => ({}));
  for (const [com, d] of Object.entries(comDemands)) {
    for (const [pidStr, n] of Object.entries(d)) {
      const pid = Number(pidStr);
      const give = Math.min(n, state.bank.commodities[com]);
      if (give <= 0) continue;
      state.bank.commodities[com] -= give;
      state.players[pid].commodities[com] += give;
      comGains[pid][com] = give;
    }
  }

  for (const p of state.players) {
    const got = [
      ...Object.entries(gains[p.id]).map(([r, n]) => `${RES_JP[r]}×${n}`),
      ...Object.entries(comGains[p.id]).map(([c, n]) => `${COM_JP[c]}×${n}`),
    ];
    if (got.length) addLog(state, `${p.name}: ${got.join(' ')}`);
  }
  return gains;
}
