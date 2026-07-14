// 盗賊(設計書 §5, §6)

import { LAYOUT } from './board.js';
import { rngInt } from '../rng.js';
import { RESOURCES, addLog } from '../state.js';
import { totalResources } from './build.js';

// そのヘックスに移動したとき、奪える相手プレイヤーの一覧
export function stealableTargets(state, hexId, pid) {
  const targets = new Set();
  for (const vid of LAYOUT.hexVertices[hexId] ?? []) {
    const b = state.buildings[vid];
    if (b && b.player !== pid && totalResources(state.players[b.player]) > 0) {
      targets.add(b.player);
    }
  }
  return [...targets];
}

// 盗賊移動 + 略奪の適用(validate 済み前提)
export function applyRobberMove(state, pid, hexId, targetPlayer) {
  state.board.robber = hexId;
  const p = state.players[pid];
  if (targetPlayer != null) {
    const t = state.players[targetPlayer];
    const pool = [];
    for (const r of RESOURCES) for (let i = 0; i < t.resources[r]; i++) pool.push(r);
    let idx;
    [state.rng, idx] = rngInt(state.rng, pool.length);
    const res = pool[idx];
    t.resources[res] -= 1;
    p.resources[res] += 1;
    addLog(state, `${p.name}が盗賊を移動し、${t.name}から資源を1枚奪いました`);
  } else {
    addLog(state, `${p.name}が盗賊を移動しました`);
  }
}
