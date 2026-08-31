// 戦績と実績の保存(設計書 §11)
//
// 端末のローカルに閉じる。オフラインでも遊べるアプリなので、サーバーは使わない。
// localStorage を触るのは load/save だけで、集計と判定は全て純粋関数にしてある
// (test/progress.test.js が localStorage なしで検証できるように)。

import { lsGet, lsSet, lsRemove } from './storage.js';
import { computePoints } from './rules/victory.js';
import { ACHIEVEMENTS, unlockedBy } from './achievements.js';

const KEY = 'progress';
export const PROGRESS_VERSION = 1;

export const MODES = ['base', 'cak', 'dragon', 'fish', 'sea'];
export const DIFFICULTIES = ['easy', 'normal', 'hard'];

export function emptyProgress() {
  return { v: PROGRESS_VERSION, games: [], achievements: {} };
}

// 対戦1回ぶんの記録。state をそのまま持つと重いので、要点だけ取り出す。
// (盤面を再現したいときのために seed は残す)
export function resultOf(state, me, now = Date.now()) {
  return {
    at: now,
    mode: state.mode,
    difficulty: state.difficulty ?? 'normal',
    players: state.players.length,
    seed: state.seed ?? null,
    won: state.winner === me,
    points: computePoints(state, me, { includeHidden: true }),
    turns: state.turn,
  };
}

// ---- 集計 ----

// モード×難易度の集計。空でも全ての枠を作るので、表がそのまま描ける。
export function summarize(progress) {
  const byMode = {};
  for (const mode of MODES) {
    byMode[mode] = { played: 0, won: 0, bestPoints: 0, bestTurns: null };
    for (const d of DIFFICULTIES) {
      byMode[mode][d] = { played: 0, won: 0 };
    }
  }
  const total = { played: 0, won: 0, bestPoints: 0, bestTurns: null };
  for (const g of progress.games) {
    const m = byMode[g.mode];
    if (!m) continue; // 知らないモードの記録(将来の版で遊んだ)は数えない
    const d = m[g.difficulty] ?? m.normal;
    m.played++; d.played++; total.played++;
    if (g.won) {
      m.won++; d.won++; total.won++;
      // 最短勝利と最高得点は「勝った対戦」だけで見る
      if (m.bestTurns == null || g.turns < m.bestTurns) m.bestTurns = g.turns;
      if (total.bestTurns == null || g.turns < total.bestTurns) total.bestTurns = g.turns;
    }
    if (g.points > m.bestPoints) m.bestPoints = g.points;
    if (g.points > total.bestPoints) total.bestPoints = g.points;
  }
  return { byMode, total };
}

export function winRate(n) {
  return n.played === 0 ? null : Math.round((n.won / n.played) * 100);
}

// ---- 記録 ----

// 対戦結果を足して、新しく解除された実績の一覧を返す。
// progress は書き換えずに新しいオブジェクトを返す(state と同じ流儀)。
export function addResult(progress, result, ctx) {
  const next = {
    ...progress,
    games: [...progress.games, result],
    achievements: { ...progress.achievements },
  };
  const stats = summarize(next);
  const unlocked = [];
  for (const id of unlockedBy({ ...ctx, result, stats })) {
    if (next.achievements[id]) continue; // すでに持っている
    next.achievements[id] = { at: result.at, mode: result.mode };
    unlocked.push(id);
  }
  return { progress: next, unlocked };
}

export function achievementCount(progress) {
  return {
    got: ACHIEVEMENTS.filter((a) => progress.achievements[a.id]).length,
    total: ACHIEVEMENTS.length,
  };
}

// ---- 保存 ----

// 壊れた値が入っていても遊べなくならないように、読めなければ空から始める。
export function parseProgress(raw) {
  if (!raw) return emptyProgress();
  try {
    const p = JSON.parse(raw);
    if (!p || typeof p !== 'object') return emptyProgress();
    return {
      v: PROGRESS_VERSION,
      games: Array.isArray(p.games) ? p.games.filter((g) => g && typeof g === 'object') : [],
      achievements: p.achievements && typeof p.achievements === 'object' ? p.achievements : {},
    };
  } catch {
    return emptyProgress();
  }
}

export function loadProgress() {
  try {
    return parseProgress(lsGet(KEY));
  } catch {
    return emptyProgress(); // localStorage が使えない環境(プライベートモード等)
  }
}

export function saveProgress(progress) {
  try {
    lsSet(KEY, JSON.stringify(progress));
  } catch {
    // 容量超過などで保存できなくても対戦は続けられる
  }
}

export function clearProgress() {
  try {
    lsRemove(KEY);
  } catch {
    // 消せなくても致命的ではない
  }
}
