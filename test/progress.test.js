// 戦績と実績のテスト。
//
// localStorage は使わず、純粋関数(summarize / addResult / unlockedBy)だけを見る。
// 実績の判定は「終局時の state」から取るので、セルフプレイで作った本物の
// 終局状態でも動くことを最後に確かめる。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createGame } from '../src/state.js';
import { dispatch } from '../src/actions.js';
import { chooseAction } from '../src/ai/cpu-player.js';
import { computePoints } from '../src/rules/victory.js';
import {
  MODES, addResult, emptyProgress, parseProgress, resultOf, summarize, winRate,
  achievementCount,
} from '../src/progress.js';
import { ACHIEVEMENTS, achievementById, unlockedBy } from '../src/achievements.js';
import { LAYOUT } from '../src/rules/board.js';

const LAYOUT_V = LAYOUT.vertices;
const LAYOUT_E = LAYOUT.edges;

function game({ mode = 'base', difficulty = 'normal', won = true, points = 10, turns = 40 } = {}) {
  return { at: 1, mode, difficulty, players: 4, seed: 1, won, points, turns };
}

// 対戦を最後まで回して、本物の終局 state を作る
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
  assert.equal(s.byMode.cak.played, 1);
  assert.equal(s.byMode.cak.won, 0);
  assert.equal(s.byMode.cak.bestTurns, null);
  assert.equal(s.byMode.cak.bestPoints, 9, '負けた対戦でも最高得点には数える');
  assert.equal(s.total.played, 4);
  assert.equal(s.total.won, 2);
});

test('progress: 知らないモードの記録は数に入れず、落ちもしない', () => {
  const p = { ...emptyProgress(), games: [game({ mode: 'mystery' }), game({ mode: 'base' })] };
  const s = summarize(p);
  assert.equal(s.total.played, 1);
  assert.equal(s.byMode.base.played, 1);
});

// ---- 実績 ----

test('achievements: id が重複していない', () => {
  const ids = ACHIEVEMENTS.map((a) => a.id);
  assert.equal(new Set(ids).size, ids.length);
  for (const a of ACHIEVEMENTS) {
    assert.ok(a.name && a.desc && a.icon, `${a.id} に名前・説明・アイコンがない`);
    assert.equal(typeof a.check, 'function');
  }
});

test('achievements: 一度解除したものは二重に数えない', () => {
  let p = emptyProgress();
  const state = createGame({ seed: 1, playerCount: 4, humanIndex: 0, mode: 'base' });
  const ctx = { state, me: 0 };

  const first = addResult(p, game({ mode: 'base', won: true }), ctx);
  assert.ok(first.unlocked.includes('win-base'));
  p = first.progress;

  const second = addResult(p, game({ mode: 'base', won: true }), ctx);
  assert.ok(!second.unlocked.includes('win-base'), '2回目は新規解除にならない');
  assert.equal(Object.keys(second.progress.achievements).length,
    Object.keys(p.achievements).length, '実績の総数は増えない');
});

test('achievements: 5モードで勝つと全ルール制覇が解除される', () => {
  let p = emptyProgress();
  const state = createGame({ seed: 1, playerCount: 4, humanIndex: 0, mode: 'base' });
  let last = null;
  for (const mode of MODES) {
    last = addResult(p, game({ mode, won: true }), { state, me: 0 });
    p = last.progress;
  }
  assert.ok(last.unlocked.includes('win-all-modes'), '最後の1モードで解除される');
  assert.ok(p.achievements['win-all-modes']);
});

test('achievements: 負けた対戦では勝利系が解除されない', () => {
  const state = createGame({ seed: 1, playerCount: 4, humanIndex: 0, mode: 'base' });
  const ids = unlockedBy({
    state, me: 0,
    result: game({ won: false, turns: 10 }),
    stats: summarize(emptyProgress()),
  });
  for (const id of ['win-base', 'win-fast', 'all-cities', 'longest-road']) {
    assert.ok(!ids.includes(id), `${id} が負けたのに解除されている`);
  }
});

test('achievements: 判定が落ちても他の実績は生き残る', () => {
  // state を壊しても unlockedBy は例外を投げない
  const ids = unlockedBy({
    state: { players: [], buildings: {}, mode: 'base' },
    me: 0,
    result: game({ mode: 'base', won: true }),
    stats: summarize(emptyProgress()),
  });
  assert.ok(ids.includes('win-base'), 'state を見ない実績は解除される');
});

test('achievements: 本物の終局 state で判定できる(全モード)', () => {
  for (const mode of MODES) {
    const s = playOut(mode, 3);
    assert.equal(s.phase, 'ended', `${mode}: 完走しなかった`);
    const me = s.winner; // 勝った席を自分とみなす
    const result = resultOf(s, me, 1);
    assert.equal(result.won, true);
    assert.equal(result.mode, mode);
    assert.equal(result.points, computePoints(s, me, { includeHidden: true }));
    const ids = unlockedBy({ state: s, me, result, stats: summarize(emptyProgress()) });
    assert.ok(ids.includes(`win-${mode}`), `${mode}: 勝利の実績が出ない`);
    for (const id of ids) assert.ok(achievementById(id), `${mode}: 未知の実績 ${id}`);
  }
});

// ---- 保存 ----

test('progress: 壊れた保存データでも空から始まる', () => {
  for (const raw of [null, '', 'null', '{{{', '[]', '{"games":"ちがう"}']) {
    const p = parseProgress(raw);
    assert.ok(Array.isArray(p.games), `${raw} で games が配列でない`);
    assert.equal(typeof p.achievements, 'object');
  }
  // 正しい形はそのまま読める
  const ok = parseProgress(JSON.stringify({ games: [game()], achievements: { 'win-base': { at: 1 } } }));
  assert.equal(ok.games.length, 1);
  assert.ok(ok.achievements['win-base']);
});

test('progress: 実績の獲得数を数えられる', () => {
  const p = { ...emptyProgress(), achievements: { 'win-base': { at: 1 }, 'nonexistent': { at: 1 } } };
  const c = achievementCount(p);
  assert.equal(c.got, 1, '定義にない id は数えない');
  assert.equal(c.total, ACHIEVEMENTS.length);
});

test('progress: addResult は元の戦績を書き換えない', () => {
  const p = emptyProgress();
  const state = createGame({ seed: 1, playerCount: 4, humanIndex: 0, mode: 'base' });
  addResult(p, game(), { state, me: 0 });
  assert.equal(p.games.length, 0);
  assert.deepEqual(p.achievements, {});
});

// 実績はフィールド名を1文字間違えても「静かに解除されない」だけで気づけない。
// 条件を満たす state をこちらで組み立てて、確かに true になることを確かめる。
function baseState(mode = 'base') {
  return createGame({ seed: 1, playerCount: 4, humanIndex: 0, mode });
}

test('achievements: 盤面から判定するものが、条件を満たせば確かに解除される', () => {
  const stats = summarize(emptyProgress());
  const fire = (id, state, result = game({ won: true })) =>
    assert.ok(
      unlockedBy({ state, me: 0, result, stats }).includes(id),
      `${id} が条件を満たしても解除されない(参照しているフィールド名を確認)`,
    );

  // 都市国家: 都市4つ
  {
    const s = baseState();
    const vids = Object.keys(s.board.hexes).length ? Object.keys(LAYOUT_V).slice(0, 4) : [];
    for (const v of vids) s.buildings[v] = { player: 0, type: 'city' };
    fire('all-cities', s);
  }
  // 常勝軍: 最大騎士力
  {
    const s = baseState();
    s.largestArmy = { player: 0, count: 3 };
    fire('largest-army', s);
  }
  // 竜の宝: 財宝3
  {
    const s = baseState('dragon');
    s.players[0].treasures = 3;
    fire('dragon-treasure-3', s, game({ mode: 'dragon' }));
  }
  // 泥沼の勝利: 古い靴を持ったまま勝つ
  {
    const s = baseState('fish');
    s.players[0].fish = ['shoe'];
    fire('fish-shoe-win', s, game({ mode: 'fish', won: true }));
  }
  // 島から島へ / 大船団
  {
    const s = baseState('sea');
    s.players[0].islands = [0, 1, 2, 3];
    fire('sea-islands', s, game({ mode: 'sea' }));
  }
  {
    const s = baseState('sea');
    const edges = Object.keys(LAYOUT_E).slice(0, 13);
    for (const e of edges) s.ships[e] = { player: 0, builtTurn: 1 };
    fire('sea-fleet', s, game({ mode: 'sea' }));
  }
  // 騎士団 / 島の守護者 / 極めし者 / 二大都市
  {
    const s = baseState('cak');
    const vids = Object.keys(LAYOUT_V).slice(0, 4);
    for (const v of vids) s.knights[v] = { player: 0, level: 1, active: true, activatedTurn: 0 };
    fire('cak-knights', s, game({ mode: 'cak' }));
  }
  {
    const s = baseState('cak');
    s.players[0].defenderPoints = 3;
    fire('cak-defender-3', s, game({ mode: 'cak' }));
  }
  {
    const s = baseState('cak');
    s.players[0].improvements.trade = 5;
    fire('cak-max-track', s, game({ mode: 'cak' }));
  }
  {
    const s = baseState('cak');
    const [a, b] = Object.keys(LAYOUT_V).slice(0, 2);
    s.buildings[a] = { player: 0, type: 'city' };
    s.buildings[b] = { player: 0, type: 'city' };
    s.metropolis = { trade: a, politics: b, science: null };
    fire('cak-two-metropolis', s, game({ mode: 'cak', won: true }));
  }
});
