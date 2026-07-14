// シード固定のセルフプレイ検証(設計書 §10)
// CPU 4体で自動対戦し、クラッシュ・無限ループ・整合性を検証する。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createGame, RESOURCES } from '../src/state.js';
import { dispatch } from '../src/actions.js';
import { chooseAction } from '../src/ai/cpu-player.js';
import { computePoints, VICTORY_POINTS_TO_WIN } from '../src/rules/victory.js';

export function runSelfPlay(seed, { playerCount = 4, maxActions = 6000 } = {}) {
  let state = createGame({ seed, playerCount, humanIndex: -1 });
  let actions = 0;
  while (state.phase !== 'ended') {
    if (++actions > maxActions) {
      throw new Error(`seed=${seed}: ${maxActions}アクションを超えました(無限ループの疑い)`);
    }
    const pid = state.awaiting ? state.awaiting.players[0] : state.currentPlayer;
    const action = chooseAction(state, pid);
    if (!action) throw new Error(`seed=${seed}: CPU${pid} がアクションを返しませんでした`);
    state = dispatch(state, action);
  }
  return { state, actions };
}

test('セルフプレイ30ゲーム: 完走・勝利点・資源保存則', () => {
  for (let seed = 1; seed <= 30; seed++) {
    const { state } = runSelfPlay(seed);
    assert.equal(state.phase, 'ended');
    assert.notEqual(state.winner, null);
    const pts = computePoints(state, state.winner, { includeHidden: true });
    assert.ok(pts >= VICTORY_POINTS_TO_WIN, `seed=${seed}: 勝者の点数が${pts}`);

    // 資源保存則: 銀行 + 全プレイヤー = 各19枚
    for (const r of RESOURCES) {
      const total =
        state.bank.resources[r] +
        state.players.reduce((s, p) => s + p.resources[r], 0);
      assert.equal(total, 19, `seed=${seed}: ${r} の総数が ${total}`);
      assert.ok(state.bank.resources[r] >= 0, `seed=${seed}: 銀行の${r}が負`);
      for (const p of state.players) {
        assert.ok(p.resources[r] >= 0, `seed=${seed}: ${p.name}の${r}が負`);
      }
    }

    // 発展カード総数: 山札 + 全手札 = 25
    const devTotal =
      state.bank.devDeck.length +
      state.players.reduce((s, p) => s + p.devCards.length, 0) +
      state.players.reduce((s, p) => s + p.knightsPlayed, 0);
    assert.ok(devTotal <= 25, `seed=${seed}: 発展カードが増殖 (${devTotal})`);
  }
});

test('セルフプレイ: 3人戦も完走する', () => {
  for (let seed = 100; seed < 110; seed++) {
    const { state } = runSelfPlay(seed, { playerCount: 3 });
    assert.equal(state.phase, 'ended');
  }
});

test('セルフプレイ: 同一シードは同一結果(決定性)', () => {
  const a = runSelfPlay(777);
  const b = runSelfPlay(777);
  assert.equal(a.state.winner, b.state.winner);
  assert.equal(a.actions, b.actions);
  assert.deepEqual(a.state.log, b.state.log);
});
