// 蛮族を射る大会の進行(server/raid-contest.js)。
//
// 受付と時間の器(meet-core.js)は釣り大会のテストで押さえてあるので、
// ここは**この遊び固有の決まりごと**だけを見る:
//   - 全員が同じ波を迎え撃つ(種はサーバーが配る)
//   - 点の申告は減らない・伸びすぎない・力尽きたら凍る
//   - 点も波も同じなら同率

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  RaidContest, RAID_MS, RESULT_MS, MAX_RATE, RATE_GRACE, waveSeed,
} from '../server/raid-contest.js';
import { contestOutcome } from '../src/minigame/contest.js';

const at = (t) => t;

// 2人でエントリーして始めたところまで進める
function started(seed = 12345, t = 0) {
  const c = new RaidContest();
  c.setSeed(seed);
  c.enter(0, at(t));
  c.enter(1, at(t));
  c.start(0, at(t));
  return c;
}

test('射る大会: 波の種を全員へ配る(同じ波を迎え撃つ)', () => {
  const c = started();
  const v = c.view(at(0));
  assert.ok(v.seed > 0, '種が配られていない');
  // 席ごとに view を作り分けてはいない ── 全員が同じ表を見る
  assert.equal(c.view(at(1000)).seed, v.seed, '同じ回で種が変わる');
});

test('射る大会: 始まるまで種は無い', () => {
  const c = new RaidContest();
  c.setSeed(7);
  c.enter(0, at(0));
  assert.equal(c.view(at(0)).seed, 0, '受付の時点で種が出ている');
});

test('射る大会: 回ごとに違う波になる', () => {
  const base = 4242;
  const seeds = [0, 1, 2, 3].map((round) => waveSeed(base, round));
  assert.equal(new Set(seeds).size, seeds.length, '2回目も同じ波になる');
  for (const s of seeds) assert.ok(s > 0, '種が 0(乱数が回らない)');
  // 同じ部屋・同じ回なら、誰が数えても同じ種
  assert.equal(waveSeed(base, 2), seeds[2]);
});

test('射る大会: 部屋の種が違えば波も違う', () => {
  assert.notEqual(waveSeed(1, 1), waveSeed(2, 1));
});

// 同じ部屋で2回続けて開いたときの話。回を数に入れ忘れると、
// 2回目が1回目とそっくり同じ波になって「答えを知っている」勝負になる。
test('射る大会: 同じ部屋で2回目を開くと、別の波になる', () => {
  const c = new RaidContest({ ms: 1000, resultMs: 100 });
  c.setSeed(5);
  c.enter(0, at(0));
  c.enter(1, at(0));
  c.start(0, at(0));
  const first = c.view(at(0)).seed;
  c.tick(at(1000));            // 時間切れ → 結果
  c.tick(at(1100));            // 結果を見せ終わり → 受付(エントリーは残る)
  assert.ok(c.start(0, at(1200)).ok, '2回目が始められない');
  assert.notEqual(c.view(at(1200)).seed, first, '2回目も同じ波になった');
});

test('射る大会: 点は合計で申告する。減らない', () => {
  const c = started();
  c.report(0, { score: 20, wave: 2 }, at(20000));
  assert.equal(c.rankRows()[0].score, 20);
  // 取りこぼしたあとに古い合計が届いても後戻りしない
  c.report(0, { score: 5, wave: 1 }, at(21000));
  const me = c.rankRows().find((r) => r.seat === 0);
  assert.equal(me.score, 20, '古い申告で点が減った');
  assert.equal(me.wave, 2, '波も戻ってしまった');
});

test('射る大会: 経過時間あたりの上限で頭を押さえる', () => {
  const c = started();
  // 1秒後の上限は RATE_GRACE + MAX_RATE
  c.report(0, { score: 9999 }, at(1000));
  assert.equal(c.rankRows()[0].score, RATE_GRACE + MAX_RATE);
  // 時間が経てば同じ申告が通る
  c.report(0, { score: 9999 }, at(60000));
  assert.equal(c.rankRows()[0].score, RATE_GRACE + MAX_RATE * 60);
});

test('射る大会: 力尽きたと申告したら、そこで凍る', () => {
  const c = started();
  c.report(0, { score: 40, over: true }, at(30000));
  c.report(0, { score: 300 }, at(60000));
  assert.equal(c.rankRows()[0].score, 40, '力尽きたあとも点が伸びる');
});

test('射る大会: 壊れた申告は弾く。エントリー外も入らない', () => {
  const c = started();
  for (const bad of [NaN, -5, 'たくさん', null, undefined, Infinity]) {
    assert.ok(c.report(0, { score: bad }, at(30000)).error, `${String(bad)} が通ってしまう`);
  }
  assert.equal(c.rankRows().find((r) => r.seat === 0).score, 0);
  assert.ok(c.report(4, { score: 10 }, at(30000)).error, '出ていない席が点を入れた');
  assert.equal(c.rankRows().length, 2);
});

// 端末の Raid とサーバーの締め切りは 1 tick ずれる。最後の1本が当たった
// 申告が時間切れとぶつかったとき、赤い札を出すのは邪魔なだけ。
test('射る大会: 走っていないときの申告は、黙って捨てる(エラーにしない)', () => {
  const c = new RaidContest({ ms: 1000, resultMs: 500 });
  c.setSeed(1);
  c.enter(0, at(0));
  c.enter(1, at(0));
  c.start(0, at(0));
  c.report(0, { score: 10 }, at(500));
  c.tick(at(1000));
  assert.equal(c.phase, 'result');
  const res = c.report(0, { score: 99 }, at(1001));
  assert.equal(res.error, undefined, '時間切れの申告がエラーになった');
  assert.equal(c.rankRows().find((r) => r.seat === 0).score, 10, '時間切れ後の点が入った');
});

// 点の申告は秒に何度も来る。配り直しも保存もしない合図(room-do.js が見る)
test('射る大会: 点の申告は quiet(配り直さない合図)', () => {
  const c = started();
  assert.equal(c.report(0, { score: 10 }, at(30000)).quiet, true);
  assert.equal(c.command(0, 'enter', {}, at(30000)).quiet, undefined, '受付まで黙らせている');
});

test('射る大会: 点 → 波 の順に並び、決着が付かなければ同率', () => {
  const c = new RaidContest();
  c.setSeed(1);
  for (const s of [0, 1, 2]) c.enter(s, at(0));
  c.start(0, at(0));
  c.report(0, { score: 30, wave: 3 }, at(30000));
  c.report(1, { score: 30, wave: 3 }, at(30000));
  c.report(2, { score: 30, wave: 5 }, at(30000));
  const rank = c.rankRows();
  assert.deepEqual(rank.map((r) => [r.seat, r.place]), [[2, 1], [0, 2], [1, 2]],
    '同点で波が多いほうが上にならない/同率にならない');
});

test('射る大会: 点が同じでも波で決着が付く', () => {
  const c = started();
  c.report(0, { score: 30, wave: 2 }, at(30000));
  c.report(1, { score: 30, wave: 4 }, at(30000));
  const rank = c.rankRows();
  assert.equal(rank[0].seat, 1);
  assert.deepEqual(rank.map((r) => r.place), [1, 2]);
});

test('射る大会: 優勝の判定はクライアントと同じ数え方で出る', () => {
  const c = started();
  c.report(0, { score: 30 }, at(30000));
  c.report(1, { score: 10 }, at(30000));
  const v = c.view(at(30000));
  assert.deepEqual(contestOutcome(v, 0), { entered: true, won: true, score: 30, place: 1 });
  assert.deepEqual(contestOutcome(v, 1), { entered: true, won: false, score: 10, place: 2 });
  // 見ていただけの人は数えない
  assert.equal(contestOutcome(v, 9).entered, false);
});

test('射る大会: 1点も取れなかった回は優勝にしない', () => {
  const c = started();
  const v = c.view(at(30000));
  assert.equal(contestOutcome(v, 0).won, false, '0点でも優勝になっている');
});

test('射る大会: 保存して読み直しても、種も点も変わらない', () => {
  // 始めた時刻を大きく取る。上限の起点を落とすと「経過 100 秒」と
  // 数えてしまい、読み直した直後だけ大きな点が通る
  const c = started(999, 100000);
  c.report(0, { score: 12, wave: 3 }, at(100000));
  const back = RaidContest.fromJSON(JSON.parse(JSON.stringify(c.toJSON())));
  assert.equal(back.phase, 'running');
  assert.equal(back.view(at(101000)).seed, c.view(at(101000)).seed, '読み直したら別の波になった');
  assert.deepEqual(back.rankRows(), c.rankRows());
  // 上限の起点も残っている。1秒後の上限は RATE_GRACE + MAX_RATE のまま
  back.report(0, { score: 9999 }, at(101000));
  assert.equal(back.rankRows().find((r) => r.seat === 0).score, RATE_GRACE + MAX_RATE,
    '読み直したら上限が緩んだ(起点が残っていない)');
  // 読み直したあとも時間切れが効く
  assert.equal(back.tick(at(100000 + RAID_MS)), true);
  assert.equal(back.phase, 'result');
});

// 部屋の種は「次の回の波」を決めるのに要る。読み戻し忘れると、
// サーバーが眠って起きたあとの回だけ別の島の波になる。
test('射る大会: 読み直しても、次の回の波は同じ', () => {
  // 結果の表示時間は既定のまま(保存に入らないので、読み直した側は
  // 既定に戻る ── ここで縮めると読み直した側だけ受付に戻れない)
  const next = (c) => {
    c.tick(at(1000));                 // 時間切れ → 結果
    c.tick(at(1000 + RESULT_MS));     // → 受付
    c.start(0, at(1000 + RESULT_MS));
    return c.view(at(1000 + RESULT_MS)).seed;
  };
  const c = new RaidContest({ ms: 1000 });
  c.setSeed(31337);
  c.enter(0, at(0));
  c.enter(1, at(0));
  c.start(0, at(0));
  const back = RaidContest.fromJSON(JSON.parse(JSON.stringify(c.toJSON())));
  assert.equal(next(back), next(c), '読み直したら次の回だけ別の波になった');
});

test('射る大会: 部屋から抜けた人は順位から消える', () => {
  const c = started();
  c.report(0, { score: 50 }, at(30000));
  c.dropSeat(0);
  assert.equal(c.rankRows().length, 1, '抜けた人が順位に残っている');
});
