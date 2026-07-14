// 銀行/港交易(設計書 §5)

import { LAYOUT } from './board.js';

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

// give 資源の交換レート(4:1 / 3:1港 / 2:1専用港)
export function tradeRate(state, pid, give) {
  const ports = playerPorts(state, pid);
  if (ports.has(give)) return 2;
  if (ports.has('3:1')) return 3;
  return 4;
}
