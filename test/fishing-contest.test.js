// 釣り大会の進行(server/fishing-contest.js)。
//
// 「どっちが勝ったか」で揉めないための決まりごとを、ここで押さえる。

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  FishingContest, CONTEST_MS, MIN_PLAYERS, MAX_CM, MIN_GAP_MS,
} from '../server/fishing-contest.js';

// 時刻を自分で進められるようにして、待たずに検証する
const at = (t) => t;

test('大会: エントリーして2人そろうと始められる', () => {
  const c = new FishingContest();
  assert.equal(c.phase, 'idle');
  c.enter(0, at(0));
  assert.equal(c.phase, 'entry');
  // ひとりでは始まらない
  assert.ok(c.start(0, at(100)).error, 'ひとりで始まってしまう');
  assert.equal(c.phase, 'entry');

  c.enter(1, at(200));
  assert.ok(c.start(0, at(300)).ok);
  assert.equal(c.phase, 'running');
  assert.equal(c.view(at(300)).remain, CONTEST_MS);
});

test('大会: エントリーしていない人は始められない', () => {
  const c = new FishingContest();
  c.enter(0, at(0));
  c.enter(1, at(0));
  assert.ok(c.start(5, at(0)).error, '関係ない席が始められてしまう');
  assert.equal(c.phase, 'entry');
});

test('大会: 取り消せる。全員抜けたら受付も閉じる', () => {
  const c = new FishingContest();
  c.enter(0, at(0));
  c.enter(1, at(0));
  c.leave(1);
  assert.deepEqual(c.view(at(0)).entries, [0]);
  c.leave(0);
  assert.equal(c.phase, 'idle');
});

test('大会: 始まったら取り消せない・あとから入れない', () => {
  const c = new FishingContest();
  c.enter(0, at(0));
  c.enter(1, at(0));
  c.start(0, at(0));
  assert.ok(c.leave(0).error, '大会中に抜けられてしまう');
  assert.ok(c.enter(7, at(1000)).error, '大会中に入れてしまう');
  assert.deepEqual(c.view(at(0)).entries, [0, 1]);
});

test('大会: 釣果は合計され、大物ほど上に並ぶ', () => {
  const c = new FishingContest();
  c.enter(0, at(0));
  c.enter(1, at(0));
  c.start(0, at(0));
  c.land(0, 30, at(1000));
  c.land(0, 50, at(1000 + MIN_GAP_MS));
  c.land(1, 100, at(1000));
  const rank = c.view(at(9000)).rank;
  assert.deepEqual(rank.map((r) => [r.seat, r.cm, r.count]), [[1, 100, 1], [0, 80, 2]]);
  assert.equal(rank[0].best, 100);
});

test('大会: 合計が同じなら、大物を釣ったほうが上', () => {
  const c = new FishingContest();
  c.enter(0, at(0));
  c.enter(1, at(0));
  c.start(0, at(0));
  // どちらも合計 100cm。0番は 50+50、1番は 100 一発
  c.land(0, 50, at(1000));
  c.land(0, 50, at(1000 + MIN_GAP_MS));
  c.land(1, 100, at(1000));
  const rank = c.view(at(9000)).rank;
  assert.equal(rank[0].seat, 1, '大物のほうが上にならない');
});

test('大会: 壊れた申告は弾く(上限・間隔・でたらめ)', () => {
  const c = new FishingContest();
  c.enter(0, at(0));
  c.enter(1, at(0));
  c.start(0, at(0));

  // 上限で切る
  c.land(0, 99999, at(1000));
  assert.equal(c.view(at(0)).rank.find((r) => r.seat === 0).cm, MAX_CM);

  // 速すぎる連打は入らない
  assert.ok(c.land(0, 100, at(1000 + MIN_GAP_MS - 1)).error, '連打が通ってしまう');
  assert.ok(c.land(0, 100, at(1000 + MIN_GAP_MS)).ok, '間隔を空けても入らない');

  // でたらめ
  for (const bad of [NaN, -5, 'おおきい', null, undefined, Infinity]) {
    assert.ok(c.land(1, bad, at(50000)).error, `${String(bad)} が通ってしまう`);
  }
  assert.equal(c.view(at(0)).rank.find((r) => r.seat === 1).cm, 0);
});

test('大会: エントリーしていない人の釣果は数えない', () => {
  const c = new FishingContest();
  c.enter(0, at(0));
  c.enter(1, at(0));
  c.start(0, at(0));
  assert.ok(c.land(4, 100, at(1000)).error);
  assert.equal(c.view(at(0)).rank.length, 2);
});

test('大会: 時間切れで結果へ、そのあと受付へ戻る', () => {
  const c = new FishingContest({ ms: 1000, resultMs: 500 });
  c.enter(0, at(0));
  c.enter(1, at(0));
  c.start(0, at(0));

  assert.equal(c.tick(at(999)), false, '時間前に終わってしまう');
  assert.equal(c.phase, 'running');
  assert.equal(c.tick(at(1000)), true);
  assert.equal(c.phase, 'result');
  // 時間切れのあとの釣果は入らない
  assert.ok(c.land(0, 100, at(1001)).error);

  assert.equal(c.tick(at(1499)), false);
  assert.equal(c.tick(at(1500)), true);
  assert.equal(c.phase, 'entry', 'エントリーは残っているので受付に戻る');
});

test('大会: 残り時間はミリ秒で配る(端末の時計に依らない)', () => {
  const c = new FishingContest({ ms: 10000 });
  c.enter(0, at(0));
  c.enter(1, at(0));
  c.start(0, at(5000));
  assert.equal(c.view(at(5000)).remain, 10000);
  assert.equal(c.view(at(9000)).remain, 6000);
  assert.equal(c.view(at(99999)).remain, 0, '残りが負にならない');
  // 締め切りの時刻そのものは配らない
  assert.equal(c.view(at(5000)).endsAt, undefined);
});

test('大会: 部屋から抜けた人は消える。全員抜けたら流れる', () => {
  const c = new FishingContest();
  c.enter(0, at(0));
  c.enter(1, at(0));
  c.start(0, at(0));
  c.land(0, 100, at(1000));
  c.dropSeat(0);
  assert.equal(c.view(at(0)).rank.length, 1, '抜けた人が順位に残っている');
  c.dropSeat(1);
  assert.equal(c.phase, 'idle', '全員抜けても大会が続いている');
});

test('大会: 結果を見ている最中に受付すると、次の回が始まる', () => {
  const c = new FishingContest({ ms: 1000, resultMs: 5000 });
  c.enter(0, at(0));
  c.enter(1, at(0));
  c.start(0, at(0));
  c.land(0, 100, at(500));
  c.tick(at(1000));
  assert.equal(c.phase, 'result');

  c.enter(0, at(2000));
  assert.equal(c.phase, 'entry');
  assert.deepEqual(c.view(at(2000)).entries, [0], '前の回のエントリーが残っている');
  assert.equal(c.view(at(2000)).rank.length, 0, '前の回の点が残っている');
});

test('大会: 保存して読み直しても進行が変わらない', () => {
  const c = new FishingContest();
  c.enter(0, at(0));
  c.enter(1, at(0));
  c.start(0, at(1000));
  c.land(0, 120, at(2000));
  const back = FishingContest.fromJSON(JSON.parse(JSON.stringify(c.toJSON())));
  assert.equal(back.phase, 'running');
  assert.deepEqual(back.view(at(2000)).rank, c.view(at(2000)).rank);
  assert.equal(back.view(at(2000)).remain, c.view(at(2000)).remain);
  // 読み直したあとも時間切れが効く
  assert.equal(back.tick(at(1000 + CONTEST_MS)), true);
  assert.equal(back.phase, 'result');
});

test('大会: 人数の下限は決め打ちしない', () => {
  assert.equal(MIN_PLAYERS, 2);
  const solo = new FishingContest({ minPlayers: 1 });
  solo.enter(0, at(0));
  assert.ok(solo.start(0, at(0)).ok, '下限を変えても効かない');
});
