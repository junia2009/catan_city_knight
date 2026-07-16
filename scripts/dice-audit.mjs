// ダイス乱数の統計監査。実装(src/rng.js / src/rules/dice.js)をそのまま検定する。
// 実行: node scripts/dice-audit.mjs

import { makeRng, rngInt } from '../src/rng.js';
import { rollTwoDice, rollEventDie } from '../src/rules/dice.js';
import { createGame } from '../src/state.js';
import { dispatch } from '../src/actions.js';
import { chooseAction } from '../src/ai/cpu-player.js';

// 自由度ごとのχ²臨界値(p=0.01)。これ未満なら「偏りの証拠なし」
const CHI2_CRIT = { 3: 11.34, 5: 15.09, 10: 23.21, 25: 44.31, 35: 57.34 };

let failures = 0;
function report(name, chi2, df, extra = '') {
  const crit = CHI2_CRIT[df];
  const ok = chi2 < crit;
  if (!ok) failures++;
  console.log(`${ok ? '✅' : '❌'} ${name}: χ²=${chi2.toFixed(2)} (df=${df}, p=0.01臨界値=${crit}) ${extra}`);
}
function chi2Of(observed, expected) {
  let x = 0;
  for (let i = 0; i < observed.length; i++) {
    x += (observed[i] - expected[i]) ** 2 / expected[i];
  }
  return x;
}

// ---- 1. 単一ダイスの一様性(1ストリームから60万回)----
{
  const N = 600000;
  let s = makeRng(12345);
  const counts = Array(6).fill(0);
  for (let i = 0; i < N; i++) {
    let v;
    [s, v] = rngInt(s, 6);
    counts[v]++;
  }
  report('単一ダイスの一様性(60万回)', chi2Of(counts, Array(6).fill(N / 6)), 5,
    `出現率=${counts.map((c) => (c / N * 6).toFixed(3)).join(',')}`);
}

// ---- 2. 2個の合計分布(rollTwoDice を20万回)----
{
  const N = 200000;
  const state = { rng: makeRng(777) };
  const counts = Array(13).fill(0);
  for (let i = 0; i < N; i++) counts[rollTwoDice(state).reduce((a, b) => a + b)]++;
  const prob = [0, 0, 1, 2, 3, 4, 5, 6, 5, 4, 3, 2, 1].map((w) => w / 36);
  report('2個合計の三角分布(20万回)',
    chi2Of(counts.slice(2), prob.slice(2).map((p) => p * N)), 10,
    `7の率=${(counts[7] / N).toFixed(4)}(理論値0.1667)`);
}

// ---- 3. イベントダイス(船3面+色3面)----
{
  const N = 120000;
  const state = { rng: makeRng(2024) };
  const counts = { ship: 0, trade: 0, politics: 0, science: 0 };
  for (let i = 0; i < N; i++) counts[rollEventDie(state)]++;
  report('イベントダイス(12万回)',
    chi2Of(
      [counts.ship, counts.trade, counts.politics, counts.science],
      [N / 2, N / 6, N / 6, N / 6],
    ), 3,
    `船=${(counts.ship / N).toFixed(3)}(理論値0.500)`);
}

// ---- 4. 系列相関(連続する出目の独立性)----
{
  const N = 600000;
  let s = makeRng(99);
  const seq = [];
  for (let i = 0; i < N; i++) {
    let v;
    [s, v] = rngInt(s, 6);
    seq.push(v);
  }
  const mean = 2.5;
  let cov = 0, va = 0;
  for (let i = 0; i < N - 1; i++) {
    cov += (seq[i] - mean) * (seq[i + 1] - mean);
    va += (seq[i] - mean) ** 2;
  }
  const r = cov / va;
  const bound = 3 / Math.sqrt(N); // ≈0.0039
  const ok = Math.abs(r) < bound;
  if (!ok) failures++;
  console.log(`${ok ? '✅' : '❌'} 系列相関(lag1): r=${r.toFixed(5)}(許容 |r|<${bound.toFixed(4)})`);

  // ペアの独立性。重なり合う窓は独立標本にならないので「重ならないペア」で検定する
  const cells = Array(36).fill(0);
  for (let i = 0; i + 1 < N; i += 2) cells[seq[i] * 6 + seq[i + 1]]++;
  const pairs = Math.floor(N / 2);
  report('出目ペアの独立性(非重複・6×6)', chi2Of(cells, cells.map(() => pairs / 36)), 35);
}

// ---- 5. 連番シード間の独立性(Date.now()由来のシードを想定)----
{
  // ゲームのシードは Date.now() % 0x7fffffff なので「近いシード」が使われる。
  // 各シードの最初の出目が偏らないこと・隣接シードと相関しないことを確認。
  const M = 120000;
  const base = 1700000000;
  const firsts = [];
  const counts = Array(6).fill(0);
  for (let k = 0; k < M; k++) {
    let v;
    [, v] = rngInt(makeRng(base + k), 6);
    firsts.push(v);
    counts[v]++;
  }
  report('連番シードの初回出目の一様性(12万シード)', chi2Of(counts, Array(6).fill(M / 6)), 5);

  // 隣接シード(seed k と k+1)の初回出目が独立か(非重複ペアで検定)
  const cells = Array(36).fill(0);
  for (let k = 0; k + 1 < M; k += 2) cells[firsts[k] * 6 + firsts[k + 1]]++;
  const pairs = Math.floor(M / 2);
  report('隣接シード間の独立性(非重複・6×6)', chi2Of(cells, cells.map(() => pairs / 36)), 35);
}

// ---- 6. 実ゲーム内の出目分布(セルフプレイ60ゲームのログ)----
{
  const counts = Array(13).fill(0);
  let rolls = 0;
  for (let seed = 3000; seed < 3060; seed++) {
    let state = createGame({ seed, playerCount: 4, humanIndex: -1, mode: 'cak' });
    let n = 0;
    while (state.phase !== 'ended' && ++n < 15000) {
      const pid = state.awaiting ? state.awaiting.players[0] : state.currentPlayer;
      state = dispatch(state, chooseAction(state, pid));
    }
    for (const l of state.log) {
      const m = l.match(/のロール: (\d) \+ (\d) =/);
      if (m) {
        counts[Number(m[1]) + Number(m[2])]++;
        rolls++;
      }
    }
  }
  const prob = [0, 0, 1, 2, 3, 4, 5, 6, 5, 4, 3, 2, 1].map((w) => w / 36);
  report(`実ゲーム内の合計分布(60ゲーム・${rolls}ロール)`,
    chi2Of(counts.slice(2), prob.slice(2).map((p) => p * rolls)), 10,
    `7の率=${(counts[7] / rolls).toFixed(4)}`);
}

console.log(failures === 0 ? '\n監査結果: 全テスト合格 🎲' : `\n監査結果: ${failures}件の異常`);
process.exit(failures === 0 ? 0 : 1);
