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
  ACC_MIN_SHOTS, MODES, addContestResult, addRaidRun, addResult, emptyMeet, emptyProgress,
  emptyRaid, noteSeen, parseProgress, resultOf, summarize, winRate, achievementCount,
  currentTitle, setTitle,
} from '../src/progress.js';
import {
  ACHIEVEMENTS, TIERS, achievementById, marksOf, progressOf, titleOf, unlockedBy,
} from '../src/achievements.js';
import { contestOutcome, placeOf } from '../src/minigame/contest.js';

function game({
  mode = 'base', difficulty = 'normal', won = true, points = 10, turns = 40, marks = {},
} = {}) {
  return { at: 1, mode, difficulty, players: 4, seed: 1, won, points, turns, marks };
}

const noStats = () => summarize(emptyProgress());

// 対戦の締め以外に入口を持つ実績の目印(src/achievements.js の OTHER_GATES と同じ)。
// これが付いているものは mark を持っていても「対戦の数値もの」ではない。
const OTHER_GATE_KEYS = ['checkMeet', 'checkSeen', 'checkRaid'];

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
  // 対戦の到達値は空。散策部屋の記録(蛮族を射る)は 0 から始まる
  assert.deepEqual(s.bests,
    { raidScore: 0, raidWave: 0, raidAcc: 0, daifugoPlayed: 0, daifugoBest: 0 });
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
    assert.ok(a.check || a.mark || a.checkMeet || a.checkSeen || a.checkRaid,
      `${a.id}: 解除の判定(check / mark / checkMeet / checkSeen / checkRaid)がない`);
    if (a.mark) assert.equal(typeof a.goal, 'number', `${a.id}: goal がない`);
  }
  // アイコンはバッジの並びで実績を見分ける唯一の手がかり。
  // 5モードの勝利だけは同じ 🏆 でよい(1列に並ぶので取り違えない)。
  const modeWins = MODES.map((m) => `win-${m}`);
  const icons = ACHIEVEMENTS.filter((a) => !modeWins.includes(a.id)).map((a) => a.icon);
  const dup = icons.filter((x, i) => icons.indexOf(x) !== i);
  assert.deepEqual(dup, [], `アイコンが重複している: ${dup.join(' ')}`);
});

// 数値ものは marks を積めば必ず解除できるはず。
// フィールド名を1文字間違えても「静かに解除されないだけ」なので、ここで潰す。
test('achievements: 数値ものは目標値に届けば必ず解除される', () => {
  // 散策部屋のものは mark を「進捗を出すため」だけに持っている。
  // 解除の入口は別(checkRaid など)なので、ここでは見ない
  const numeric = ACHIEVEMENTS.filter((a) => a.mark && !OTHER_GATE_KEYS.some((k) => a[k]));
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

// ---- 釣り大会(散策部屋)----
//
// 解除の入口が対戦とは別(unlockedByMeet)なので、
// 「対戦を1戦終えたら釣り大会の実績が付く」逆も含めて押さえる。

const view = (rank, round = 1) => ({ phase: 'result', round, rank });
const row = (seat, cm, best = cm) => ({ seat, cm, count: 1, best });

test('大会: 1位なら優勝、出ていなければ何も起きない', () => {
  const v = view([row(0, 200), row(1, 120)]);
  const out = { entered: false, won: false, score: 0, place: 0 };
  assert.deepEqual(contestOutcome(v, 0), { entered: true, won: true, score: 200, place: 1 });
  assert.deepEqual(contestOutcome(v, 1), { entered: true, won: false, score: 120, place: 2 });
  assert.deepEqual(contestOutcome(v, 5), out);
  assert.deepEqual(contestOutcome(v, null), out);
  assert.deepEqual(contestOutcome(undefined, 0), out);
});

// 相手が抜けた瞬間や、全員ボウズで時間切れ ── どちらも「勝った」感じがしない
test('大会: ひとりだけの回と、誰も釣れなかった回は優勝にしない', () => {
  assert.equal(contestOutcome(view([row(0, 200)]), 0).won, false, 'ひとりで優勝になった');
  assert.equal(contestOutcome(view([row(0, 0), row(1, 0)]), 0).won, false, 'ボウズで優勝になった');
  // 出てはいるので、回数には数える
  assert.equal(contestOutcome(view([row(0, 200)]), 0).entered, true);
});

// 合計も大物も同じなら、席が若いほうだけを優勝にはしない
test('大会: まったく同じ釣果なら同率優勝(2人とも実績が付く)', () => {
  const v = view([row(0, 200, 120), row(1, 200, 120), row(2, 50)]);
  assert.deepEqual(placeOf(v.rank).map((r) => r.place), [1, 1, 3], '競技順位になっていない');
  for (const s of [0, 1]) {
    const o = contestOutcome(v, s);
    assert.equal(o.won, true, `席${s} が同率優勝にならない`);
    assert.equal(o.place, 1);
  }
  assert.deepEqual(contestOutcome(v, 2), { entered: true, won: false, score: 50, place: 3 });
  // 同率の2人とも実績が取れる
  for (const s of [0, 1]) {
    const { won } = contestOutcome(v, s);
    const { unlocked } = addContestResult(emptyProgress(), { won, score: 200, key: `A#${s}` });
    assert.deepEqual(unlocked, ['meet-win'], `席${s} に実績が付かない`);
  }
});

// ---- 島で見つけたもの(竜の巣)----

test('巣: 登ると実績と称号が付く', () => {
  const { progress: p, unlocked } = noteSeen(emptyProgress(), 'nest', 1234);
  assert.deepEqual(unlocked, ['nest-visit']);
  assert.ok(p.achievements['nest-visit'], '実績が入っていない');
  assert.equal(p.title, 'nest-visit', '初めての実績は自動で名乗る');
  assert.equal(p.seen.nest, 1234, '行ったことが残っていない');
});

test('巣: 2度目は何も起きない(元の progress をそのまま返す)', () => {
  const { progress: p } = noteSeen(emptyProgress(), 'nest', 1234);
  const again = noteSeen(p, 'nest', 9999);
  assert.deepEqual(again.unlocked, []);
  assert.equal(again.progress, p, '同じものを返していない(保存が毎回走る)');
  assert.equal(again.progress.seen.nest, 1234, '行った時刻が上書きされた');
});

test('巣: 行っていなければ付かない', () => {
  const p = emptyProgress();
  assert.equal(p.achievements['nest-visit'], undefined);
  // 別の場所へ行っただけでは付かない
  const { unlocked } = noteSeen(p, 'somewhere-else');
  assert.deepEqual(unlocked, []);
});

// 対戦の締めで散策の実績が付いてしまうと、1戦終えるだけで巣に行ったことになる
test('巣: 対戦の締めでは付かない', () => {
  const r = { mode: 'dragon', won: true, points: 10, difficulty: 'hard', players: 4, turns: 40 };
  assert.equal(unlockedBy({ result: r, marks: {}, stats: summarize(emptyProgress()) })
    .includes('nest-visit'), false);
});

// 古い保存には seen が無い。読めなくても遊べなくならないこと
test('巣: 古い保存・壊れた保存でも読める', () => {
  assert.deepEqual(parseProgress(JSON.stringify({ games: [] })).seen, {});
  assert.deepEqual(parseProgress(JSON.stringify({ seen: 'いいえ' })).seen, {});
  assert.deepEqual(parseProgress(JSON.stringify({ seen: { nest: 5 } })).seen, { nest: 5 });
  // 壊れた値でも「行ったこと」は残す(実績を取り消すほうが害が大きい)
  assert.deepEqual(parseProgress(JSON.stringify({ seen: { nest: 'えっ' } })).seen, { nest: 1 });
  assert.deepEqual(parseProgress(JSON.stringify({ seen: { nest: false } })).seen, {});
});

// 合計が並んでも「いちばん大きい1匹」で決着が付くなら同率ではない
test('大会: 合計が同じでも大物で決まるなら同率にしない', () => {
  const v = view([row(0, 200, 150), row(1, 200, 90)]);
  assert.deepEqual(placeOf(v.rank).map((r) => r.place), [1, 2]);
  assert.equal(contestOutcome(v, 0).won, true);
  assert.equal(contestOutcome(v, 1).won, false, '大物で負けたのに優勝になった');
});

test('大会: 同率は2位でも3位でも同じ数え方(次の順位を飛ばす)', () => {
  const v = view([row(0, 300), row(1, 100), row(2, 100), row(3, 10)]);
  assert.deepEqual(placeOf(v.rank).map((r) => r.place), [1, 2, 2, 4]);
});

test('大会: 優勝すると実績と称号が付く', () => {
  const { progress: p, unlocked } = addContestResult(emptyProgress(), { won: true, score: 200, key: 'AAAA#1' });
  assert.deepEqual(unlocked, ['meet-win']);
  assert.ok(p.achievements['meet-win'], '実績が入っていない');
  assert.equal(p.title, 'meet-win', '初めての実績は自動で名乗る');
  assert.deepEqual(
    { played: p.meets.fishing.played, won: p.meets.fishing.won, bestCm: p.meets.fishing.best },
    { played: 1, won: 1, bestCm: 200 },
  );
});

test('大会: 負けた回は数えるだけで実績は付かない', () => {
  const { progress: p, unlocked } = addContestResult(emptyProgress(), { won: false, score: 90, key: 'AAAA#1' });
  assert.deepEqual(unlocked, []);
  assert.equal(p.achievements['meet-win'], undefined);
  assert.deepEqual(
    { played: p.meets.fishing.played, won: p.meets.fishing.won, bestCm: p.meets.fishing.best },
    { played: 1, won: 0, bestCm: 90 },
  );
});

// 結果は25秒のあいだ毎秒配られる。そのたびに数えたら回数が25倍になる
test('大会: 同じ回は二度数えない(別の回なら数える)', () => {
  let p = addContestResult(emptyProgress(), { won: true, score: 200, key: 'AAAA#1' }).progress;
  p = addContestResult(p, { won: true, score: 200, key: 'AAAA#1' }).progress;
  assert.equal(p.meets.fishing.played, 1, '同じ回を二度数えた');
  p = addContestResult(p, { won: false, score: 300, key: 'AAAA#2' }).progress;
  assert.equal(p.meets.fishing.played, 2);
  assert.equal(p.meets.fishing.best, 300, '自己最高は負けた回も見る');
  // 部屋が変われば回数は1から振り直される。部屋のコードまで見ていないと数え損ねる
  p = addContestResult(p, { won: true, score: 10, key: 'BBBB#1' }).progress;
  assert.equal(p.meets.fishing.played, 3, '別の部屋の1回目を数え損ねた');
  assert.equal(p.meets.fishing.best, 300, '振るわない回で自己最高が下がった');
});

test('大会: 対戦の締めでは釣り大会の実績は解除されない', () => {
  // 5モードぶん勝っても meet-win は付かない(入口が別)
  let p = emptyProgress();
  for (const mode of MODES) {
    p = addResult(p, game({ mode }), { marks: {} }).progress;
  }
  assert.equal(p.achievements['meet-win'], undefined, '対戦の締めで釣り大会の実績が付いた');
  assert.ok(p.achievements['win-all-modes'], '対戦のほうは解除されている');
});

test('大会: addContestResult は元の戦績を書き換えない', () => {
  const p = emptyProgress();
  addContestResult(p, { won: true, score: 200, key: 'AAAA#1' });
  assert.deepEqual(p.meets, {});
  assert.deepEqual(p.achievements, {});
  assert.equal(p.title, null);
});

test('大会: 古い保存(通算なし)や壊れた値でも 0 から始まる', () => {
  assert.deepEqual(parseProgress(JSON.stringify({ games: [] })).meets, {});
  const broken = parseProgress(JSON.stringify({
    meets: { fishing: { played: 'たくさん', won: -3, best: null, last: 7 } },
  }));
  assert.deepEqual(broken.meets.fishing, emptyMeet(), '壊れた値がそのまま入った');
  // 壊れた値の上に足しても NaN にならない
  const after = addContestResult(broken, { won: true, score: 50, key: 'AAAA#1' }).progress;
  assert.equal(after.meets.fishing.played, 1);
  assert.equal(after.meets.fishing.best, 50);
});

// 釣り大会だけだった頃の保存は meet に1つぶんだけ入っている。
// 遊びが増えて遊びごとに分けたので、読むときに釣りの欄へ移す。
test('大会: 昔の保存(meet ひとつ)は釣りの通算として読み戻す', () => {
  const old = parseProgress(JSON.stringify({
    meet: { played: 4, won: 2, bestCm: 310, last: 'ZZZZ#3' },
  }));
  assert.deepEqual(old.meets.fishing, { played: 4, won: 2, best: 310, last: 'ZZZZ#3' });
  assert.equal(old.meets.dragonhunt, undefined, '出ていない遊びの欄まで作った');
});

// 竜のほうは「逃げきった人だけが勝ち」。全員捕まった回の最長生存者を
// 勝ちにすると、逃げきる実績が逃げきらなくても取れてしまう。
test('竜: 逃げきった人だけが勝ち、実績もそちらだけ', () => {
  const hunt = (rows) => ({ kind: 'dragonhunt', phase: 'result', round: 1, rank: rows });
  const v = hunt([
    { seat: 0, ms: 90000, alive: true },
    { seat: 1, ms: 40000, alive: false },
  ]);
  assert.deepEqual(contestOutcome(v, 0), { entered: true, won: true, score: 90, place: 1 });
  assert.deepEqual(contestOutcome(v, 1), { entered: true, won: false, score: 40, place: 2 });

  // 全員捕まった回は、いちばん長く粘った人でも勝ちにしない
  const wiped = hunt([
    { seat: 0, ms: 50000, alive: false },
    { seat: 1, ms: 10000, alive: false },
  ]);
  assert.equal(contestOutcome(wiped, 0).won, false, '全員捕まったのに勝ちになった');
  assert.equal(contestOutcome(wiped, 0).place, 1, '順位は付く');

  // 実績は逃げきった側だけ
  const win = addContestResult(emptyProgress(), {
    kind: 'dragonhunt', won: true, score: 90, key: 'A#1',
  });
  assert.deepEqual(win.unlocked, ['hunt-survive']);
  const lose = addContestResult(emptyProgress(), {
    kind: 'dragonhunt', won: false, score: 50, key: 'A#1',
  });
  assert.deepEqual(lose.unlocked, []);
});

// 遊びごとに別の欄。釣りで優勝しても竜の実績は付かない(逆も)。
test('大会: 遊びごとに通算も実績も分かれている', () => {
  const p = addContestResult(emptyProgress(), {
    kind: 'fishing', won: true, score: 200, key: 'A#1',
  }).progress;
  assert.ok(p.achievements['meet-win']);
  assert.equal(p.achievements['hunt-survive'], undefined, '釣りで竜の実績が付いた');
  assert.equal(p.meets.dragonhunt, undefined);

  const q = addContestResult(p, {
    kind: 'dragonhunt', won: true, score: 90, key: 'A#2',
  }).progress;
  assert.ok(q.achievements['hunt-survive']);
  assert.equal(q.meets.fishing.played, 1, '別の遊びが釣りの通算を消した');
  assert.equal(q.meets.dragonhunt.played, 1);
});

// ---- 蛮族を射る(散策部屋)----
//
// 大会(meets)と違って、ひとりで櫓に立った回も数える。自己最高だけを
// 持ち、実績はそこから解除される。

test('射: 回ごとに自己最高が伸びる', () => {
  let p = emptyProgress();
  p = addRaidRun(p, { score: 40, wave: 3, shots: 30, hits: 12 }).progress;
  p = addRaidRun(p, { score: 20, wave: 5, shots: 10, hits: 9 }).progress;
  assert.equal(p.raid.played, 2);
  assert.equal(p.raid.best, 40, '点の自己最高が伸びていない');
  assert.equal(p.raid.wave, 5, '波の自己最高が伸びていない');
  assert.equal(p.raid.shots, 40, '通算の射数が合わない');
  assert.equal(p.raid.hits, 21);
});

// 命中率は「回ごと」に見る。通算の射数で割ると、下手な回を数多く重ねた人ほど
// 分母が育って、腕が上がっても記録が伸びなくなる。
test('射: 命中率は回ごとに見て、射数が足りない回は数えない', () => {
  // 3射2中(67%)は射数が足りないので記録に残さない
  let p = addRaidRun(emptyProgress(), { score: 5, wave: 1, shots: 3, hits: 2 }).progress;
  assert.equal(p.raid.acc, 0, '数射の回が自己最高になっている');
  // 射数を満たせば残る
  p = addRaidRun(p, { score: 5, wave: 1, shots: ACC_MIN_SHOTS, hits: 15 }).progress;
  assert.equal(p.raid.acc, 75);
  // そのあと下手な回を重ねても、自己最高は下がらない
  p = addRaidRun(p, { score: 5, wave: 1, shots: 100, hits: 10 }).progress;
  assert.equal(p.raid.acc, 75);
});

test('射: 壊れた回でも記録が壊れない', () => {
  const p = addRaidRun(emptyProgress(), {
    score: NaN, wave: -3, shots: 'たくさん', hits: Infinity,
  }).progress;
  assert.deepEqual(p.raid, { ...emptyRaid(), played: 1 });
  // 当たった数が射数を超えることはない(命中率が 100% を超えないように)
  const q = addRaidRun(emptyProgress(), { score: 1, wave: 1, shots: 20, hits: 99 }).progress;
  assert.equal(q.raid.acc, 100);
});

test('射: 目標に届くと実績と称号が付く', () => {
  const wave3 = addRaidRun(emptyProgress(), { score: 10, wave: 3, shots: 5, hits: 3 });
  assert.deepEqual(wave3.unlocked, ['raid-wave-3']);
  assert.equal(wave3.progress.title, 'raid-wave-3', '初めての実績が称号にならない');

  const score = addRaidRun(emptyProgress(), { score: 100, wave: 1, shots: 5, hits: 5 });
  assert.ok(score.unlocked.includes('raid-score-100'));

  const acc = addRaidRun(emptyProgress(), { score: 1, wave: 1, shots: 20, hits: 14 });
  assert.ok(acc.unlocked.includes('raid-accuracy'), '命中7割で解除されない');

  const wave6 = addRaidRun(emptyProgress(), { score: 10, wave: 6, shots: 5, hits: 3 });
  assert.ok(wave6.unlocked.includes('raid-wave-6'));
});

test('射: 1 足りなければ解除されない', () => {
  const near = addRaidRun(emptyProgress(), { score: 99, wave: 2, shots: 20, hits: 13 });
  assert.deepEqual(near.unlocked, [], `届いていないのに解除された: ${near.unlocked}`);
});

test('射: 一度解除したものは二度数えない', () => {
  const first = addRaidRun(emptyProgress(), { score: 10, wave: 3, shots: 5, hits: 3 });
  const again = addRaidRun(first.progress, { score: 10, wave: 4, shots: 5, hits: 3 });
  assert.deepEqual(again.unlocked, []);
  assert.equal(again.progress.raid.played, 2, '回数は増える');
});

// 進捗(「3/6波」)は戦績画面が bests から出す。ここが繋がっていないと、
// 実績の欄がいつまでも 0/6 のままになる。
test('射: 自己最高が実績の進捗に出る', () => {
  const p = addRaidRun(emptyProgress(), { score: 40, wave: 4, shots: 20, hits: 11 }).progress;
  const stats = summarize(p);
  assert.deepEqual(progressOf(achievementById('raid-wave-6'), stats),
    { now: 4, goal: 6, unit: '波' });
  assert.deepEqual(progressOf(achievementById('raid-score-100'), stats),
    { now: 40, goal: 100, unit: '点' });
  assert.deepEqual(progressOf(achievementById('raid-accuracy'), stats),
    { now: 55, goal: 70, unit: '%' });
});

// 散策部屋の実績は mark を「進捗を出すため」だけに持っている。
// 対戦の締めで marks に同じ名前が入っても、そちらでは付かない。
test('射: 対戦の締めでは付かない', () => {
  const result = { mode: 'cak', won: true, points: 13, difficulty: 'hard', players: 4, turns: 40 };
  const ids = unlockedBy({
    result,
    marks: { raidWave: 9, raidScore: 999, raidAcc: 100 },
    stats: noStats(),
  });
  for (const id of ['raid-wave-3', 'raid-wave-6', 'raid-score-100', 'raid-accuracy']) {
    assert.equal(ids.includes(id), false, `${id}: 対戦を終えただけで付いた`);
  }
});

test('射: 大会で優勝すると別の実績が付く', () => {
  const r = addContestResult(emptyProgress(), {
    kind: 'raid', won: true, score: 60, key: 'A#1',
  });
  assert.ok(r.unlocked.includes('raid-meet-win'));
  assert.equal(r.progress.meets.raid.best, 60);
  // ひとりの記録のほうは動かない(入口が別)
  assert.deepEqual(r.progress.raid, emptyRaid());
});

test('射: 古い保存・壊れた保存でも 0 から始まる', () => {
  assert.deepEqual(parseProgress(JSON.stringify({ games: [] })).raid, emptyRaid());
  assert.deepEqual(parseProgress(JSON.stringify({ raid: 'いっぱい' })).raid, emptyRaid());
  const bad = parseProgress(JSON.stringify({
    raid: { played: NaN, best: -1, wave: 2.7, acc: 999, shots: null, hits: 4 },
  })).raid;
  assert.deepEqual(bad, { played: 0, best: 0, wave: 2, acc: 100, shots: 0, hits: 4 });
});

test('射: addRaidRun は元の戦績を書き換えない', () => {
  const p = emptyProgress();
  addRaidRun(p, { score: 100, wave: 6, shots: 20, hits: 20 });
  assert.deepEqual(p.raid, emptyRaid());
  assert.deepEqual(p.achievements, {});
});

// ---- 大富豪(散策部屋)----

test('大富豪: 1番に上がると実績と称号が付く', () => {
  const r = addContestResult(emptyProgress(), {
    kind: 'daifugo', won: true, score: 3, key: 'A#1',
  });
  assert.ok(r.unlocked.includes('daifugo-win'));
  assert.equal(r.progress.meets.daifugo.best, 3);
  // ほかの遊びの実績は付かない
  assert.equal(r.unlocked.includes('meet-win'), false);
});

test('大富豪: 10回遊ぶと常連。それまでは進捗が出る', () => {
  let p = emptyProgress();
  for (let i = 1; i <= 9; i++) {
    p = addContestResult(p, { kind: 'daifugo', won: false, score: 0, key: `A#${i}` }).progress;
  }
  assert.equal(p.achievements['daifugo-regular'], undefined, '9回で常連になっている');
  assert.deepEqual(progressOf(achievementById('daifugo-regular'), summarize(p)),
    { now: 9, goal: 10, unit: '回' });
  const last = addContestResult(p, { kind: 'daifugo', won: false, score: 0, key: 'A#10' });
  assert.ok(last.unlocked.includes('daifugo-regular'), '10回で常連にならない');
});

// 「何人抜いたか」で数えると、5人卓の2位が4人卓の1位より上に残ってしまう。
// 記録は「大富豪になった卓の大きさ」なので、負けた回は 0。
test('大富豪: 大卓を制すのは、4人以上の卓で1番になったときだけ', () => {
  // 3人卓で優勝しても届かない
  let p = addContestResult(emptyProgress(), {
    kind: 'daifugo', won: true, score: 3, key: 'A#1',
  }).progress;
  assert.equal(p.achievements['daifugo-table4'], undefined, '3人卓で大卓の実績が付いた');
  assert.deepEqual(progressOf(achievementById('daifugo-table4'), summarize(p)),
    { now: 3, goal: 4, unit: '人' });
  // 4人卓で優勝すると付く
  const big = addContestResult(p, { kind: 'daifugo', won: true, score: 4, key: 'A#2' });
  assert.ok(big.unlocked.includes('daifugo-table4'));
});

test('大富豪: 対戦の締めでは付かない', () => {
  const result = { mode: 'base', won: true, points: 10, difficulty: 'hard', players: 4, turns: 40 };
  const ids = unlockedBy({
    result, marks: { daifugoPlayed: 99, daifugoBest: 9 }, stats: noStats(),
  });
  for (const id of ['daifugo-win', 'daifugo-regular', 'daifugo-table4']) {
    assert.equal(ids.includes(id), false, `${id}: 対戦を終えただけで付いた`);
  }
});
