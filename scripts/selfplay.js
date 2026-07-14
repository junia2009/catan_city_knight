// セルフプレイ一括実行: node scripts/selfplay.js [ゲーム数]
// Phase 1 完了ゲート用(設計書 §10): クラッシュ・無限ループ・整合性の検証と統計。

import { createGame, RESOURCES } from '../src/state.js';
import { dispatch } from '../src/actions.js';
import { chooseAction } from '../src/ai/cpu-player.js';
import { computePoints } from '../src/rules/victory.js';

const games = Number(process.argv[2] ?? 200);
const wins = [0, 0, 0, 0];
let totalTurns = 0;
let totalActions = 0;
let failures = 0;

const t0 = Date.now();
for (let seed = 1; seed <= games; seed++) {
  try {
    let state = createGame({ seed, playerCount: 4, humanIndex: -1 });
    let actions = 0;
    while (state.phase !== 'ended') {
      if (++actions > 6000) throw new Error('6000アクション超過');
      const pid = state.awaiting ? state.awaiting.players[0] : state.currentPlayer;
      state = dispatch(state, chooseAction(state, pid));
    }
    for (const r of RESOURCES) {
      const total = state.bank.resources[r] + state.players.reduce((s, p) => s + p.resources[r], 0);
      if (total !== 19) throw new Error(`資源保存則違反: ${r}=${total}`);
    }
    wins[state.winner]++;
    totalTurns += state.turn;
    totalActions += actions;
    if (seed % 100 === 0) console.log(`... ${seed}/${games}`);
  } catch (e) {
    failures++;
    console.error(`seed=${seed}: ${e.message}`);
  }
}
const elapsed = ((Date.now() - t0) / 1000).toFixed(1);

console.log('─'.repeat(40));
console.log(`ゲーム数: ${games}(${elapsed}秒) 失敗: ${failures}`);
console.log(`勝率: ${wins.map((w, i) => `P${i}=${((w / games) * 100).toFixed(1)}%`).join(' ')}`);
console.log(`平均ターン数: ${(totalTurns / games).toFixed(1)} 平均アクション数: ${(totalActions / games).toFixed(1)}`);
process.exit(failures > 0 ? 1 : 0);
