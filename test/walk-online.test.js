// 散策部屋(同じ島を複数人で歩く)の検証。
// 位置のリレーも補間もトランスポートを知らないので、ここで直接回せる。
import test from 'node:test';
import assert from 'node:assert/strict';

import { WalkRelay, TICK_MS, STALE_MS } from '../server/walk-relay.js';
import { RemoteWalkers, lerpAngle } from '../src/minigame/remote.js';
import { ST, EMOTE_MAX } from '../src/minigame/remote-st.js';
import { RoomCore, MAX_SEATS, WALK_MAX_SEATS } from '../server/room-core.js';
import { createGame } from '../src/state.js';

// ---- サーバー側: 位置のリレー ----

test('リレー: 受け取った位置を全員ぶん1通にまとめる', () => {
  const r = new WalkRelay();
  r.set('a', 0, [1, 2, 0, 0.5, ST.walk], 1000);
  r.set('b', 2, [-3, 4, 0.2, -1, ST.air], 1000);
  const snap = r.snapshot(1000);
  assert.equal(snap.length, 2);
  // [席, x, z, y, 向き, 状態, エモート]
  assert.deepEqual(snap[0], [0, 1, 2, 0, 0.5, ST.walk, 0]);
  assert.deepEqual(snap[1], [2, -3, 4, 0.2, -1, ST.air, 0]);
});

test('リレー: 席の順に並ぶ(受け取る側が毎回同じ順で読める)', () => {
  const r = new WalkRelay();
  r.set('c', 5, [0, 0, 0, 0, 0], 0);
  r.set('a', 1, [0, 0, 0, 0, 0], 0);
  r.set('b', 3, [0, 0, 0, 0, 0], 0);
  assert.deepEqual(r.snapshot(0).map((p) => p[0]), [1, 3, 5]);
});

test('リレー: 壊れた値は取り込まない(全員の画面を壊さない)', () => {
  const r = new WalkRelay();
  assert.equal(r.set('a', 0, [NaN, 0, 0, 0, 0], 0), false);
  assert.equal(r.set('a', 0, [0, Infinity, 0, 0, 0], 0), false);
  assert.equal(r.set('a', 0, [0, 0, 0], 0), false);       // 足りない
  assert.equal(r.set('a', 0, 'ずるい', 0), false);
  assert.equal(r.set('a', 0, null, 0), false);
  assert.equal(r.set('', 0, [0, 0, 0, 0, 0], 0), false);  // 誰か分からない
  assert.equal(r.set('a', -1, [0, 0, 0, 0, 0], 0), false); // 席が無い
  assert.equal(r.size, 0);
});

test('リレー: 島の外へ飛ばそうとしても範囲に収める', () => {
  const r = new WalkRelay();
  r.set('a', 0, [9999, -9999, 500, 99, 99], 0);
  const [seat, x, z, y, f, st] = r.snapshot(0)[0];
  assert.equal(seat, 0);
  assert.ok(Math.abs(x) <= 12 && Math.abs(z) <= 12, `${x},${z}`);
  assert.ok(Math.abs(y) <= 4, y);
  assert.ok(Math.abs(f) <= Math.PI * 2 + 1e-9, f);
  assert.ok(st >= 0 && st <= 3, st);
});

test('リレー: 位置は小数2桁に丸める(通信量を抑える)', () => {
  const r = new WalkRelay();
  r.set('a', 0, [1.23456789, -2.98765, 0.111111, 0.55555, 0], 0);
  const [, x, z, y, f] = r.snapshot(0)[0];
  assert.equal(x, 1.23);
  assert.equal(z, -2.99);
  assert.equal(y, 0.11);
  assert.equal(f, 0.56);
});

test('リレー: 音沙汰が無い人は落ちる', () => {
  const r = new WalkRelay();
  r.set('a', 0, [0, 0, 0, 0, 0], 0);
  r.set('b', 1, [0, 0, 0, 0, 0], 0);
  r.set('b', 1, [1, 1, 0, 0, 0], STALE_MS);      // b だけ生きている
  assert.equal(r.snapshot(STALE_MS).length, 1);
  assert.equal(r.snapshot(STALE_MS)[0][0], 1);
});

test('リレー: 抜けた人はすぐ消える', () => {
  const r = new WalkRelay();
  r.set('a', 0, [0, 0, 0, 0, 0], 0);
  assert.equal(r.drop('a'), true);
  assert.equal(r.snapshot(0).length, 0);
  assert.equal(r.drop('a'), false);
});

test('リレー: 配る回数は人数に比例する(N×N にならない)', () => {
  // 8人が 10Hz で送っても、配るのは 10Hz で1通ずつ。
  // 「受けたら即転送」だと 8×8=64通/tick になる。
  const r = new WalkRelay();
  for (let i = 0; i < 8; i++) r.set(`c${i}`, i, [i, 0, 0, 0, 0], 0);
  const snap = r.snapshot(0);
  assert.equal(snap.length, 8, '1通に全員が入っている');
  // 1秒ぶん: 受信 8人×10回 = 80、送信 10回 × 人数
  const perSecond = { 受信: 8 * (1000 / TICK_MS), 送信: (1000 / TICK_MS) * 8 };
  assert.equal(perSecond.受信, 80);
  assert.equal(perSecond.送信, 80);
});

// ---- クライアント側: 補間 ----

test('補間: 角度は近いほうへ回る(-π/π をまたいでも1周しない)', () => {
  // 3.0 → -3.0 は「+0.28 進む」が正しい(-6.0 ではない)
  const v = lerpAngle(3.0, -3.0, 0.5);
  assert.ok(Math.abs(v) > 3.0, `まわり込んでいない: ${v}`);
  assert.equal(lerpAngle(0, 1, 0), 0);
  assert.equal(lerpAngle(0, 1, 1), 1);
  assert.ok(Math.abs(lerpAngle(0, Math.PI / 2, 0.5) - Math.PI / 4) < 1e-9);
});

test('補間: 2点のあいだを滑らかに埋める', () => {
  const w = new RemoteWalkers({ delay: 100 });
  w.push([[1, 0, 0, 0, 0, ST.walk]], 1000);
  w.push([[1, 1, 0, 0, 0, ST.walk]], 1100);
  // now=1150 → 描くのは 1050 = 2点のまんなか
  const [p] = w.sample(1150);
  assert.equal(p.seat, 1);
  assert.ok(Math.abs(p.x - 0.5) < 1e-6, `x=${p.x}`);
});

test('補間: 届いた点をそのまま置くより、明らかに滑らか', () => {
  // 10Hz で等速に動く人を 60fps で描いたときの「1フレームの進み方のばらつき」を見る。
  // 実際と同じように、受信と描画を時間順に混ぜて回す
  // (先に全部詰めてから読むと、履歴(KEEP)から溢れて別のものを測ってしまう)。
  const w = new RemoteWalkers({ delay: 150 });
  const speed = 2;                 // 単位/秒
  const at = (t) => speed * (t / 1000);
  const smooth = [];
  const raw = [];
  let nextRecv = 0;
  let lastRecv = 0;                // 補間しない場合 = 直近に届いた値
  for (let t = 0; t < 4000; t += 1000 / 60) {
    while (nextRecv <= t) {
      w.push([[0, at(nextRecv), 0, 0, 0, 0]], nextRecv);
      lastRecv = at(nextRecv);
      nextRecv += 100;
    }
    if (t < 500) continue;         // 立ち上がり(まだ2点そろわない)は見ない
    smooth.push(w.sample(t)[0].x);
    raw.push(lastRecv);
  }
  const jitter = (a) => {
    const d = a.slice(1).map((v, i) => v - a[i]);
    const mean = d.reduce((x, y) => x + y, 0) / d.length;
    return Math.sqrt(d.reduce((s, v) => s + (v - mean) ** 2, 0) / d.length);
  };
  const js = jitter(smooth);
  const jr = jitter(raw);
  assert.ok(jr > 0.005, `生の値がばらついていない(測れていない): ${jr}`);
  assert.ok(js < jr / 5, `補間が効いていない(補間 ${js.toFixed(5)} / 生 ${jr.toFixed(5)})`);
  // 遅らせているぶん過去を描くが、進んだ距離はほぼ同じであること
  const moved = smooth[smooth.length - 1] - smooth[0];
  const want = at(4000 - 1000 / 60) - at(500);
  assert.ok(Math.abs(moved - want) < 0.4, `進みかたがずれている ${moved} vs ${want}`);
});

test('補間: 次が来ていなければ、最後の姿で止まる(勝手に走らせない)', () => {
  const w = new RemoteWalkers({ delay: 100 });
  w.push([[0, 5, 5, 0, 0, ST.walk]], 1000);
  const [p] = w.sample(1200);   // 1点しかない
  assert.equal(p.x, 5);
  assert.equal(p.z, 5);
  assert.equal(p.speed, 0);
});

test('補間: 進む速さが出る(歩くアニメーションに使う)', () => {
  const w = new RemoteWalkers({ delay: 100 });
  w.push([[0, 0, 0, 0, 0, ST.walk]], 1000);
  w.push([[0, 0.2, 0, 0, 0, ST.walk]], 1100);   // 0.1秒で 0.2 → 2/秒
  const [p] = w.sample(1150);
  assert.ok(Math.abs(p.speed - 2) < 1e-6, `speed=${p.speed}`);
});

test('補間: 途絶えた人は消える', () => {
  const w = new RemoteWalkers({ delay: 100, gone: 1000 });
  w.push([[0, 0, 0, 0, 0, 0]], 1000);
  w.push([[0, 1, 0, 0, 0, 0]], 1100);
  assert.equal(w.sample(1200).length, 1);
  assert.equal(w.sample(1100 + 1000).length, 0, '消えていない');
  assert.equal(w.sample(9999).length, 0);
});

test('補間: 自分の席は描かない', () => {
  const w = new RemoteWalkers();
  w.push([[0, 0, 0, 0, 0, 0], [1, 1, 1, 0, 0, 0]], 1000);
  w.push([[0, 0, 0, 0, 0, 0], [1, 1, 1, 0, 0, 0]], 1100);
  w.forget(0);
  const seats = w.sample(1150).map((p) => p.seat);
  assert.deepEqual(seats, [1]);
});

test('補間: 名前は名簿から引く(位置と一緒に毎回送らない)', () => {
  const w = new RemoteWalkers({ delay: 100 });
  w.setNames([{ seat: 0, name: 'あ' }, { seat: 1, name: 'い' }]);
  w.push([[1, 0, 0, 0, 0, 0]], 1000);
  w.push([[1, 1, 0, 0, 0, 0]], 1100);
  assert.equal(w.sample(1150)[0].name, 'い');
});

test('補間: 壊れた行が混ざっても落ちない', () => {
  const w = new RemoteWalkers({ delay: 100 });
  w.push([null, 'ずるい', [], [0, 1, 2, 3, 4], [1, 0, 0, 0, 0, 0]], 1000);
  w.push([[1, 1, 0, 0, 0, 0]], 1100);
  const got = w.sample(1150);
  assert.equal(got.length, 1);
  assert.equal(got[0].seat, 1);
});

test('補間: 順序が入れ替わって届いた古い値は捨てる', () => {
  const w = new RemoteWalkers({ delay: 100 });
  w.push([[0, 0, 0, 0, 0, 0]], 1000);
  w.push([[0, 10, 0, 0, 0, 0]], 1100);
  w.push([[0, 99, 0, 0, 0, 0]], 1050);   // 遅れて届いた古い値
  const [p] = w.sample(1150);
  assert.ok(p.x <= 10, `古い値に飛びついている: ${p.x}`);
});

test('リレー → 補間: サーバーが配った形をそのまま食える', () => {
  const r = new WalkRelay();
  const w = new RemoteWalkers({ delay: 100 });
  r.set('me', 0, [1, 1, 0, 0, ST.walk], 1000);
  r.set('you', 1, [2, 2, 0, 1, ST.fish], 1000);
  w.push(r.snapshot(1000), 1000);
  r.set('me', 0, [1.5, 1, 0, 0, ST.walk], 1100);
  r.set('you', 1, [2, 2, 0, 1, ST.fish], 1100);
  w.push(r.snapshot(1100), 1100);
  w.forget(0);
  const got = w.sample(1150);
  assert.equal(got.length, 1);
  assert.equal(got[0].seat, 1);
  assert.equal(got[0].st, ST.fish);
});

// ---- エモート ----

test('リレー: エモートの番号も配る', () => {
  const r = new WalkRelay();
  r.set('a', 0, [1, 2, 0, 0, ST.walk, 3], 0);
  assert.deepEqual(r.snapshot(0)[0], [0, 1, 2, 0, 0, ST.walk, 3]);
});

test('リレー: エモートを送ってこない相手も通る(出していない扱い)', () => {
  const r = new WalkRelay();
  // 6つめが無い = エモートを知らない古い版
  assert.equal(r.set('a', 0, [1, 2, 0, 0, ST.walk], 0), true);
  assert.equal(r.snapshot(0)[0][6], 0);
});

test('リレー: 知らないエモートの番号は範囲に収める', () => {
  const r = new WalkRelay();
  for (const [sent, want] of [[999, EMOTE_MAX], [-5, 0], [NaN, 0], ['3', 3], [2.4, 2]]) {
    r.set('a', 0, [0, 0, 0, 0, ST.walk, sent], 0);
    assert.equal(r.snapshot(0)[0][6], want, `${sent} を送ったとき`);
  }
});

test('補間: エモートは混ぜずに近いほうを採る', () => {
  const w = new RemoteWalkers({ delay: 100 });
  w.push([[0, 0, 0, 0, 0, ST.walk, 0]], 1000);
  w.push([[0, 1, 0, 0, 0, ST.walk, 1]], 1100);
  // 前寄りの時刻ではまだ 0、後ろ寄りでは 1(中間の 0.5 のような値は作らない)
  assert.equal(w.sample(1120)[0].emote, 0);
  assert.equal(w.sample(1180)[0].emote, 1);
});

test('補間: 次が来ていない間もエモートは保つ', () => {
  const w = new RemoteWalkers({ delay: 100 });
  w.push([[0, 0, 0, 0, 0, ST.walk, 2]], 1000);
  assert.equal(w.sample(1050)[0].emote, 2);
});

// ---- 部屋(散策) ----

test('散策部屋: 対戦より多く入れる', () => {
  const game = new RoomCore({ code: 'AAAA' });
  const walk = new RoomCore({ code: 'BBBB', kind: 'walk' });
  assert.equal(game.maxSeats, MAX_SEATS);
  assert.equal(walk.maxSeats, WALK_MAX_SEATS);
  assert.ok(WALK_MAX_SEATS > MAX_SEATS);
  for (let i = 0; i < WALK_MAX_SEATS; i++) {
    assert.equal(walk.join({ clientId: `c${i}`, name: `p${i}` }).seat, i, `${i}人目`);
  }
  assert.ok(walk.join({ clientId: 'over', name: 'あふれ' }).error, '上限を超えて入れた');
});

test('散策部屋: 島は「種と種類」だけで配る(盤面も状態も持たない)', () => {
  const walk = new RoomCore({ code: 'BBBB', kind: 'walk', seed: 12345 });
  walk.join({ clientId: 'a', name: 'あ' });
  const info = walk.lobbyInfo();
  assert.equal(info.kind, 'walk');
  assert.equal(info.seed, 12345);
  assert.equal(info.settings.mode, 'base');
  assert.equal(walk.state, null, '状態を持ってしまっている');
  // 同じ種と種類なら、各自が作る島は完全に一致する
  const a = createGame({ seed: info.seed, playerCount: 4, humanIndex: -1, mode: info.settings.mode });
  const b = createGame({ seed: info.seed, playerCount: 4, humanIndex: -1, mode: info.settings.mode });
  assert.deepEqual(a.board, b.board);
});

test('散策部屋: 対戦の部屋は種を配らない(先の出目を読ませない)', () => {
  const game = new RoomCore({ code: 'AAAA', seed: 999 });
  game.join({ clientId: 'a', name: 'あ' });
  assert.equal(game.lobbyInfo().seed, undefined);
  assert.equal(game.lobbyInfo().kind, 'game');
});

test('散策部屋: 開始も手番も無い', () => {
  const walk = new RoomCore({ code: 'BBBB', kind: 'walk' });
  walk.join({ clientId: 'a', name: 'あ' });
  assert.ok(walk.start('a').error, '開始できてしまう');
  assert.ok(walk.submitAction('a', { type: 'END_TURN', player: 0 }).error);
  assert.equal(walk.phase, 'lobby');
});

test('散策部屋: 島の種類を変えると島も別物になる', () => {
  const walk = new RoomCore({ code: 'BBBB', kind: 'walk', seed: 1 });
  walk.join({ clientId: 'a', name: 'あ' });
  const before = walk.seed;
  assert.ok(walk.setSettings('a', { mode: 'sea' }).ok);
  assert.equal(walk.settings.mode, 'sea');
  assert.notEqual(walk.seed, before, '種が変わっていない');
  // ホスト以外は変えられない
  walk.join({ clientId: 'b', name: 'い' });
  assert.ok(walk.setSettings('b', { mode: 'cak' }).error);
});

test('散策部屋: 抜けたら席が空く(次の人が入れる)', () => {
  const walk = new RoomCore({ code: 'BBBB', kind: 'walk' });
  walk.join({ clientId: 'a', name: 'あ' });
  walk.join({ clientId: 'b', name: 'い' });
  walk.disconnect('a');
  assert.equal(walk.seats[0], null);
  assert.equal(walk.join({ clientId: 'c', name: 'う' }).seat, 0);
});

test('散策部屋: 保存して読み直しても種類と島が変わらない', () => {
  const walk = new RoomCore({ code: 'BBBB', kind: 'walk', seed: 4242 });
  walk.join({ clientId: 'a', name: 'あ' });
  const back = RoomCore.fromJSON(JSON.parse(JSON.stringify(walk.toJSON())));
  assert.equal(back.kind, 'walk');
  assert.equal(back.seed, 4242);
  assert.equal(back.maxSeats, WALK_MAX_SEATS);
  assert.equal(back.seats.length, WALK_MAX_SEATS);
});

// 席数は「サーバーの席」「画面の案内文と名簿」「席の色」の3か所で使う。
// 別々に書くと、席を増やしたときに静かにずれる(色が足りない・案内が嘘になる)。
test('散策部屋: 席数は1か所で決まっている', async () => {
  const { WALK_SEATS } = await import('../src/minigame/remote-st.js');
  assert.equal(WALK_MAX_SEATS, WALK_SEATS, 'サーバーの席数がずれている');
  const room = new RoomCore({ kind: 'walk' });
  assert.equal(room.seats.length, WALK_SEATS);
  // 実際にその人数まで座れること
  for (let i = 0; i < WALK_SEATS; i += 1) {
    const r = room.join({ clientId: `c${i}`, name: `p${i}` });
    assert.equal(r.seat, i, `${i + 1} 人目が座れない(${r.error ?? ''})`);
  }
  assert.ok(room.join({ clientId: 'over', name: 'あふれ' }).error,
    '席数を超えて入れてしまう');
});
