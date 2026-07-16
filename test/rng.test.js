// 乱数(ダイス)の統計的健全性テスト
// シード固定なので結果は決定的(flaky にならない)。
// 詳細な監査は scripts/dice-audit.mjs を実行する。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeRng, rngInt } from '../src/rng.js';
import { rollTwoDice, rollEventDie } from '../src/rules/dice.js';

function chi2Of(observed, expected) {
  let x = 0;
  for (let i = 0; i < observed.length; i++) {
    x += (observed[i] - expected[i]) ** 2 / expected[i];
  }
  return x;
}

test('rng: 単一ダイス60万回が一様(χ² df=5)', () => {
  const N = 600000;
  let s = makeRng(12345);
  const counts = Array(6).fill(0);
  for (let i = 0; i < N; i++) {
    let v;
    [s, v] = rngInt(s, 6);
    counts[v]++;
  }
  const chi2 = chi2Of(counts, Array(6).fill(N / 6));
  assert.ok(chi2 < 15.09, `χ²=${chi2.toFixed(2)} が臨界値15.09を超過`);
});

test('rng: 2個合計が三角分布に従う(χ² df=10)', () => {
  const N = 200000;
  const state = { rng: makeRng(777) };
  const counts = Array(13).fill(0);
  for (let i = 0; i < N; i++) counts[rollTwoDice(state).reduce((a, b) => a + b)]++;
  const prob = [0, 0, 1, 2, 3, 4, 5, 6, 5, 4, 3, 2, 1].map((w) => w / 36);
  const chi2 = chi2Of(counts.slice(2), prob.slice(2).map((p) => p * N));
  assert.ok(chi2 < 23.21, `χ²=${chi2.toFixed(2)} が臨界値23.21を超過`);
});

test('rng: イベントダイスは船1/2・各色1/6(χ² df=3)', () => {
  const N = 120000;
  const state = { rng: makeRng(2024) };
  const counts = { ship: 0, trade: 0, politics: 0, science: 0 };
  for (let i = 0; i < N; i++) counts[rollEventDie(state)]++;
  const chi2 = chi2Of(
    [counts.ship, counts.trade, counts.politics, counts.science],
    [N / 2, N / 6, N / 6, N / 6],
  );
  assert.ok(chi2 < 11.34, `χ²=${chi2.toFixed(2)} が臨界値11.34を超過`);
});

test('rng: 連続する出目に系列相関がない・ペアが独立', () => {
  const N = 400000;
  let s = makeRng(99);
  const seq = [];
  for (let i = 0; i < N; i++) {
    let v;
    [s, v] = rngInt(s, 6);
    seq.push(v);
  }
  // lag1 の相関
  let cov = 0, va = 0;
  for (let i = 0; i < N - 1; i++) {
    cov += (seq[i] - 2.5) * (seq[i + 1] - 2.5);
    va += (seq[i] - 2.5) ** 2;
  }
  const r = cov / va;
  assert.ok(Math.abs(r) < 3 / Math.sqrt(N), `lag1相関 r=${r.toFixed(5)}`);
  // 非重複ペアの独立性(χ² df=35)
  const cells = Array(36).fill(0);
  for (let i = 0; i + 1 < N; i += 2) cells[seq[i] * 6 + seq[i + 1]]++;
  const chi2 = chi2Of(cells, cells.map(() => N / 2 / 36));
  assert.ok(chi2 < 57.34, `ペアχ²=${chi2.toFixed(2)} が臨界値57.34を超過`);
});

test('rng: 連番シード(Date.now由来を想定)の初回出目が偏らない', () => {
  const M = 120000;
  const base = 1700000000;
  const counts = Array(6).fill(0);
  const firsts = [];
  for (let k = 0; k < M; k++) {
    let v;
    [, v] = rngInt(makeRng(base + k), 6);
    counts[v]++;
    firsts.push(v);
  }
  const chi2 = chi2Of(counts, Array(6).fill(M / 6));
  assert.ok(chi2 < 15.09, `χ²=${chi2.toFixed(2)} が臨界値15.09を超過`);
  // 隣接シードの独立性
  const cells = Array(36).fill(0);
  for (let k = 0; k + 1 < M; k += 2) cells[firsts[k] * 6 + firsts[k + 1]]++;
  const chi2p = chi2Of(cells, cells.map(() => M / 2 / 36));
  assert.ok(chi2p < 57.34, `隣接シードペアχ²=${chi2p.toFixed(2)} が臨界値57.34を超過`);
});

test('rng: rngInt に剰余バイアスがない(理論確認: 浮動小数×n方式)', () => {
  // n=6 で各値の确率はビット精度上ほぼ厳密に 1/6(2^32 通りの一様値を floor)
  // 境界値でのはみ出しがないことを確認
  let s = makeRng(1);
  for (let i = 0; i < 100000; i++) {
    let v;
    [s, v] = rngInt(s, 6);
    assert.ok(v >= 0 && v <= 5 && Number.isInteger(v));
  }
});
