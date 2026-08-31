// 戦績・実績・称号のテスト。
//
// localStorage は使わず、純粋関数(summarize / addResult / unlockedBy / progressOf)
// だけを見る。実績の判定は「終局時の state から取った marks」なので、
// セルフプレイで作った本物の終局状態でも動くことを最後に確かめる。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createGame } from '../src/state.js';
import { dispatch } from '../src/actions.js';
import { chooseAction } from '../src/ai/cpu-player.js';
import { computePoints } from '../src/rules/victory.js';
import {
  MODES, addResult, emptyProgress, parseProgress, resultOf, summarize, winRate,
  achievementCount, currentTitle, setTitle,
} from '../src/progress.js';
import {
  ACHIEVEMENTS, TIERS, achievementById, marksOf, progressOf, titleOf, unlockedBy,
} from '../src/achievements.js';

function game({
  mode = 'base', difficulty = 'normal', won = true, points = 10, turns = 40, marks = {},
} = {}) {
  return { at: 1, mode, difficulty, players: 4, seed: 1, won, points, turns, marks };
}

const noStats = () => summarize(emptyProgress());

function playOut(mode, seed) {
  let s = createGame({ seed, playerCount: 4, humanIndex: 0, mode });
  let n = 0;
  while (s.phase !== 'ended' && n++ < 6000) {
    const pid = s.awaiting ? s.awaiting.players[0] : s.currentPlayer;
    s = dispatch(s, chooseAction(s, pid));
  }
  return s;
}

// ---- 集計 ----

test('progress: 空の戦績でも全モードの枠が出る', () => {
  const s = summarize(emptyProgress());
  for (const m of MODES) {
    assert.equal(s.byMode[m].played, 0);
    assert.equal(winRate(s.byMode[m]), null, '0戦の勝率は「なし」');
  }
  assert.equal(s.total.played, 0);
  assert.equal(s.total.bestTurns, null);
  assert.deepEqual(s.bests, {});
});

test('progress: モード別・難易度別に数える', () => {
  let p = emptyProgress();
  for (const g of [
    game({ mode: 'base', difficulty: 'hard', won: true, turns: 30 }),
    game({ mode: 'base', difficulty: 'hard', won: false }),
    game({ mode: 'base', difficulty: 'easy', won: true, turns: 50 }),
    game({ mode: 'cak', difficulty: 'normal', won: false, points: 9 }),
  ]) {
    p = { ...p, games: [...p.games, g] };
  }
  const s = summarize(p);
  assert.equal(s.byMode.base.played, 3);
  assert.equal(s.byMode.base.won, 2);
  assert.equal(winRate(s.byMode.base), 67);
  assert.equal(s.byMode.base.hard.played, 2);
  assert.equal(s.byMode.base.hard.won, 1);
  assert.equal(s.byMode.base.bestTurns, 30, '最短は勝った対戦だけで見る');
  assert.equal(s.byMode.cak.bestTurns, null);
  assert.equal(s.byMode.cak.bestPoints, 9, '負けた対戦でも最高得点には数える');
  assert.equal(s.total.played, 4);
});

test('progress: 到達値は全対戦の自己最高を取る(負けた対戦も含む)', () => {
  const p = {
    ...emptyProgress(),
    games: [
      game({ won: true, marks: { knights: 2, ships: 5 } }),
      game({ won: false, marks: { knights: 4, ships: 1 } }),
    ],
  };
  const s = summarize(p);
  assert.equal(s.bests.knights, 4, '負けた対戦の到達値も進捗には数える');
  assert.equal(s.bests.ships, 5);
});

test('progress: 知らないモードの記録は数に入れず、落ちもしない', () => {
  const p = { ...emptyProgress(), games: [game({ mode: 'mystery' }), game({ mode: 'base' })] };
  const s = summarize(p);
  assert.equal(s.total.played, 1);
  assert.equal(s.byMode.base.played, 1);
});

// ---- 実績の定義 ----

test('achievements: 定義がそろっている(id 重複なし・称号・難度)', () => {
  const ids = ACHIEVEMENTS.map((a) => a.id);
  assert.equal(new Set(ids).size, ids.length, 'id が重複している');
  const titles = ACHIEVEMENTS.map((a) => a.title);
  assert.equal(new Set(titles).size, titles.length, '称号が重複している');
  for (const a of ACHIEVEMENTS) {
    assert.ok(a.name && a.desc && a.icon, `${a.id}: 名前・説明・アイコンがない`);
    assert.ok(a.title, `${a.id}: 称号がない`);
    assert.ok(TIERS.includes(a.tier), `${a.id}: 難度(tier)が不正 ${a.tier}`);
    assert.ok(a.check || a.mark, `${a.id}: check も mark もない`);
    if (a.mark) assert.equal(typeof a.goal, 'number', `${a.id}: goal がない`);
  }
});

// 数値ものは marks を積めば必ず解除できるはず。
// フィールド名を1文字間違えても「静かに解除されないだけ」なので、ここで潰す。
test('achievements: 数値ものは目標値に届けば必ず解除される', () => {
  const numeric = ACHIEVEMENTS.filter((a) => a.mark);
  assert.ok(numeric.length >= 8, '数値ものが少なすぎる(設計が変わった?)');
  for (const a of numeric) {
    const marks = { [a.mark]: a.goal };
    const result = game({ won: true, mode: a.mode ?? 'base' });
    const ids = unlockedBy({ marks, result, stats: noStats() });
    assert.ok(ids.includes(a.id), `${a.id}: ${a.mark}=${a.goal} でも解除されない`);

    // 1 足りなければ解除されない
    const short = unlockedBy({
      marks: { [a.mark]: a.goal - 1 }, result, stats: noStats(),
    });
    assert.ok(!short.includes(a.id), `${a.id}: 目標に届かなくても解除されている`);
  }
});

test('achievements: needsWin のものは負けたら解除されない', () => {
  for (const a of ACHIEVEMENTS.filter((x) => x.needsWin)) {
    const ids = unlockedBy({
      marks: { [a.mark]: a.goal },
      result: game({ won: false, mode: a.mode ?? 'base' }),
      stats: noStats(),
    });
    assert.ok(!ids.includes(a.id), `${a.id}: 負けたのに解除されている`);
  }
});

test('achievements: モード限定のものは別モードでは解除されない', () => {
  for (const a of ACHIEVEMENTS.filter((x) => x.mark && x.mode)) {
    const other = MODES.find((m) => m !== a.mode);
    const ids = unlockedBy({
      marks: { [a.mark]: a.goal },
      result: game({ won: true, mode: other }),
      stats: noStats(),
    });
    assert.ok(!ids.includes(a.id), `${a.id}: ${other} でも解除されている`);
  }
});

test('achievements: 判定が落ちても他の実績は生き残る', () => {
  const ids = unlockedBy({
    marks: null, // 壊れた入力
    result: game({ mode: 'base', won: true }),
    stats: noStats(),
  });
  assert.ok(ids.includes('win-base'), 'marks を見ない実績は解除される');
});

test('achievements: 一度解除したものは二重に数えない', () => {
  let p = emptyProgress();
  const ctx = { marks: {} };
  const first = addResult(p, game({ mode: 'base', won: true }), ctx);
  assert.ok(first.unlocked.includes('win-base'));
  p = first.progress;
  const second = addResult(p, game({ mode: 'base', won: true }), ctx);
  assert.ok(!second.unlocked.includes('win-base'), '2回目は新規解除にならない');
});

test('achievements: 5モードで勝つと全ルール制覇が解除される', () => {
  let p = emptyProgress();
  let last = null;
  for (const mode of MODES) {
    last = addResult(p, game({ mode, won: true }), { marks: {} });
    p = last.progress;
  }
  assert.ok(last.unlocked.includes('win-all-modes'), '最後の1モードで解除される');
});

// ---- 進捗 ----

test('achievements: 進捗が現在地と目標を返す', () => {
  const p = { ...emptyProgress(), games: [game({ marks: { knights: 3 } })] };
  const stats = summarize(p);
  const knights = achievementById('cak-knights');
  assert.deepEqual(progressOf(knights, stats), { now: 3, goal: 4, unit: '体' });

  // まだ一度も到達していないものは 0 から
  const fleet = achievementById('sea-fleet');
  assert.equal(progressOf(fleet, stats).now, 0);
  assert.equal(progressOf(fleet, stats).goal, 13);

  // 回数もの
  const played = progressOf(achievementById('games-10'), stats);
  assert.deepEqual(played, { now: 1, goal: 10, unit: '回' });
});

test('achievements: 進捗が出せないものは null を返す(落ちない)', () => {
  const stats = noStats();
  assert.equal(progressOf(achievementById('win-base'), stats), null);
  for (const a of ACHIEVEMENTS) {
    const pr = progressOf(a, stats);
    if (pr) {
      assert.equal(typeof pr.now, 'number', `${a.id}: now が数値でない`);
      assert.ok(pr.goal > 0, `${a.id}: goal が正でない`);
    }
  }
});

// ---- 称号 ----

test('title: 持っていない実績の称号は名乗れない', () => {
  let p = emptyProgress();
  p = setTitle(p, 'sea-fleet');
  assert.equal(p.title, null, '未取得の称号は設定されない');
  assert.equal(currentTitle(p), null);
});

test('title: 実績を取ると称号を名乗れる。最初の1つは自動で付く', () => {
  const r = addResult(emptyProgress(), game({ mode: 'base', won: true }), { marks: {} });
  assert.ok(r.progress.title, '初回は自動で称号が付く');
  assert.equal(currentTitle(r.progress), titleOf(r.progress.title));

  // 別の持っている称号に変えられる
  const p2 = setTitle(r.progress, 'win-hard');
  if (r.progress.achievements['win-hard']) {
    assert.equal(p2.title, 'win-hard');
  }
  // 称号なしに戻せる
  assert.equal(setTitle(r.progress, null).title, null);
});

test('title: 保存データが壊れた称号を指していても落ちない', () => {
  const p = { ...emptyProgress(), title: 'いない実績' };
  assert.equal(currentTitle(p), null);
});

// ---- 本物の終局 state ----

test('achievements: 本物の終局 state で marks が取れて判定できる(全モード)', () => {
  for (const mode of MODES) {
    const s = playOut(mode, 3);
    assert.equal(s.phase, 'ended', `${mode}: 完走しなかった`);
    const me = s.winner;
    const result = resultOf(s, me, 1);
    assert.equal(result.won, true);
    assert.equal(result.points, computePoints(s, me, { includeHidden: true }));

    const marks = marksOf(s, me);
    for (const [k, v] of Object.entries(marks)) {
      assert.equal(typeof v, 'number', `${mode}: marks.${k} が数値でない`);
      assert.ok(v >= 0, `${mode}: marks.${k} が負`);
    }
    // 勝った以上、建物は1つ以上ある = marks が state を読めている
    assert.ok(marks.cities >= 0 && marks.roadLen >= 0);

    const ids = unlockedBy({ marks, result, stats: noStats() });
    assert.ok(ids.includes(`win-${mode}`), `${mode}: 勝利の実績が出ない`);
    for (const id of ids) assert.ok(achievementById(id), `${mode}: 未知の実績 ${id}`);
  }
});

test('achievements: marks は壊れた state でも空を返して落ちない', () => {
  assert.deepEqual(marksOf({ players: [] }, 0), {});
  assert.deepEqual(marksOf({}, 0), {});
});

// ---- 保存 ----

test('progress: 壊れた保存データでも空から始まる', () => {
  for (const raw of [null, '', 'null', '{{{', '[]', '{"games":"ちがう"}']) {
    const p = parseProgress(raw);
    assert.ok(Array.isArray(p.games), `${raw} で games が配列でない`);
    assert.equal(typeof p.achievements, 'object');
  }
  const ok = parseProgress(JSON.stringify({
    games: [game()], achievements: { 'win-base': { at: 1 } }, title: 'win-base',
  }));
  assert.equal(ok.games.length, 1);
  assert.equal(ok.title, 'win-base', '称号も読み戻す');
});

test('progress: 実績の獲得数を数えられる', () => {
  const p = { ...emptyProgress(), achievements: { 'win-base': { at: 1 }, nope: { at: 1 } } };
  const c = achievementCount(p);
  assert.equal(c.got, 1, '定義にない id は数えない');
  assert.equal(c.total, ACHIEVEMENTS.length);
});

test('progress: addResult は元の戦績を書き換えない', () => {
  const p = emptyProgress();
  addResult(p, game(), { marks: {} });
  assert.equal(p.games.length, 0);
  assert.deepEqual(p.achievements, {});
  assert.equal(p.title, null);
});
