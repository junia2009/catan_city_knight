// 銀行/港交易(設計書 §5)

import { LAYOUT, TERRAIN_RESOURCE } from './board.js';

// pid がアクセスできる港の種類一覧
export function playerPorts(state, pid) {
  const types = new Set();
  for (const port of state.board.ports) {
    const edge = LAYOUT.edges[port.edgeId];
    for (const vid of edge.v) {
      if (state.buildings[vid]?.player === pid) types.add(port.type);
    }
  }
  return types;
}

const TRACK_OF_COMMODITY = { cloth: 'trade', coin: 'politics', paper: 'science' };

// give の交換レート。資源: 4:1 / 3:1港 / 2:1専用港。
// 商品(cak): 該当系統の都市改良 Lv3 以上で 2:1、それ以外は 4:1(設計書 §9.4)
export function tradeRate(state, pid, give) {
  // 商船隊(進歩カード): このターンの間、選んだ札を2:1
  if (state.turnFlags?.fleet === give && state.currentPlayer === pid) return 2;
  const track = TRACK_OF_COMMODITY[give];
  if (track) {
    return state.players[pid].improvements[track] >= 3 ? 2 : 4;
  }
  // 商人(進歩カード): 配置ヘックスの資源を2:1
  if (state.merchant?.player === pid) {
    const res = TERRAIN_RESOURCE[state.board.hexes[state.merchant.hexId]?.terrain];
    if (res === give) return 2;
  }
  const ports = playerPorts(state, pid);
  if (ports.has(give)) return 2;
  if (ports.has('3:1')) return 3;
  return 4;
}
