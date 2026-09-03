// 棒人間の縮尺(src/minigame/scale.js)。
//
// 縮尺を変えたときに壊れやすいのは「個々の値」ではなく **値どうしの関係**
// ── 片方だけ掛け忘れると、テストは通るのに遊べなくなる。
// ここでは、縮尺をいくつにしても成り立っていなければならない関係を押さえる。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { WALK_SCALE, s } from '../src/minigame/scale.js';
import { WALK_SPEED, JUMP_HEIGHT, WATER_Y, SINK_DEPTH } from '../src/minigame/motion.js';
import { WALKER_RADIUS } from '../src/minigame/obstacles.js';
import {
  SPOT_RADIUS, DESK_RADIUS, DESK_REACH, makeGround, spawnPoint, fishingSpots, spotNear,
} from '../src/minigame/ground.js';
import { createGame } from '../src/state.js';

test('縮尺: 掛け算そのもの', () => {
  assert.ok(WALK_SCALE > 0 && WALK_SCALE <= 1, `縮尺が範囲外: ${WALK_SCALE}`);
  assert.equal(s(1), WALK_SCALE);
  assert.equal(s(0), 0);
  assert.equal(s(-2), -2 * WALK_SCALE);
});

// 受付は島の中心にあり、みんなはその周りの輪に降りる。輪が受付の手の届く
// 範囲に入ると、島に着いた瞬間からパネルが開きっぱなしになる。
// 両方に縮尺が掛かっていれば、この前後関係は縮尺を変えても保たれる。
test('縮尺: 降り立つ輪は受付の手の届く範囲より外', () => {
  const st = createGame({ seed: 11, playerCount: 4, humanIndex: 0, mode: 'fish' });
  const home = spawnPoint(st);
  for (let seat = 0; seat < 8; seat += 1) {
    const p = spawnPoint(st, seat);
    const d = Math.hypot(p.x - home.x, p.y - home.y);
    assert.ok(d > DESK_REACH, `席 ${seat} が受付の中に降りる(${d.toFixed(2)} ≦ ${DESK_REACH})`);
    // 台そのものにめり込まないこと(半径 + 自分の太さ)
    assert.ok(d > DESK_RADIUS + WALKER_RADIUS, `席 ${seat} が台にめり込む`);
  }
});

// 「近づいたら釣れる」範囲は、比で書くと甘い上限になりがち(2倍間違えても
// ぎりぎり通ってしまった)。実際に立ってみて竿が出るかで見る。
test('縮尺: 釣り場は、そこに立てば必ず見つかる', () => {
  const st = createGame({ seed: 11, playerCount: 4, humanIndex: 0, mode: 'fish' });
  const g = makeGround(st);
  const spots = fishingSpots(st);
  assert.ok(spots.length >= 4, `釣り場が少なすぎる: ${spots.length}`);
  for (const sp of spots) {
    assert.ok(g(sp.x, sp.z).ok, `釣り場が陸の上にない: ${sp.edgeId}`);
    assert.ok(spotNear(spots, sp.x, sp.z), `真上に立っても見つからない: ${sp.edgeId}`);
    // ぴたり一点でしか反応しないと、実際には狙って立てない。
    // 自分の体ひとつぶん(半径2つぶん)ずれても届くこと。
    const off = WALKER_RADIUS * 2;
    for (const [dx, dz] of [[off, 0], [-off, 0], [0, off], [0, -off]]) {
      assert.ok(
        spotNear(spots, sp.x + dx, sp.z + dz),
        `体ひとつぶんずれると届かない: ${sp.edgeId}`,
      );
    }
  }
});

// **掛け忘れ・二重掛けを捕まえる本命。**
//
// 縮尺を変えても「人まわりの値どうしの比」は動かないはず。片方だけ掛け
// 忘れる/二重に掛けると、絶対値の上限や下限では見逃す(実際、比の下限で
// 書いたら 2 倍の間違いをすり抜けた)。比そのものを押さえる。
//
// 設計値を変えたときはここも直す ── そのとき「本当に比を変えたいのか」を
// 一度考えることになるので、それでいい。
test('縮尺: 人まわりの値どうしの比は縮尺で動かない', () => {
  const near = (a, b, name) => assert.ok(
    Math.abs(a - b) < 1e-9, `${name}: 比が ${a} で、設計の ${b} と違う`,
  );
  near(WALK_SPEED / WALKER_RADIUS, 1.9 / 0.10, '歩く速さ ÷ 太さ');
  near(JUMP_HEIGHT / WALKER_RADIUS, 0.5 / 0.10, '跳躍 ÷ 太さ');
  near(SPOT_RADIUS / WALKER_RADIUS, 0.42 / 0.10, '釣り場 ÷ 太さ');
  near(DESK_REACH / WALKER_RADIUS, 0.5 / 0.10, '受付の範囲 ÷ 太さ');
  near(DESK_RADIUS / WALKER_RADIUS, 0.2 / 0.10, '受付の大きさ ÷ 太さ');
  // 受付の範囲は台そのものより広い(でないと、ぶつかって届かない)
  assert.ok(DESK_REACH > DESK_RADIUS + WALKER_RADIUS, '受付にぶつかると届かない');
});

// **歩幅と足の運びが噛み合っているか。**
//
// 1歩で進む距離が足の振れ幅より大きすぎると、足が地面を擦って進む
// ──「歩いていない、滑っている」に見える(実機で報告された)。
// 位相の進みが決め打ちの係数だったころ、×0.5 に縮めたときに脚だけが
// 半分になって、この比が 4.4 → 8.8 倍に悪化していた。
test('縮尺: 1歩で進む距離が、足の振れ幅から離れすぎない', async () => {
  const { FOOT_TRAVEL, STEP_DIST, STEP_SLIP, PHASE_PER_UNIT, LEG_SWING } =
    await import('../src/minigame/pose.js');
  const { HIP_Y, s: sc } = await import('../src/minigame/scale.js');

  // 足の振れ幅は「脚の長さ × 腰の振り」から出ていること
  assert.ok(Math.abs(FOOT_TRAVEL - 2 * sc(HIP_Y) * Math.sin(LEG_SWING)) < 1e-12,
    '足の振れ幅が脚の長さから出ていない');
  assert.ok(Math.abs(STEP_DIST / FOOT_TRAVEL - STEP_SLIP) < 1e-12, '滑り率が設計と違う');
  // 3倍まで。これを超えると、目に見えて足が流れる
  assert.ok(STEP_SLIP <= 3, `1歩が足の振れ幅の ${STEP_SLIP} 倍もある(滑って見える)`);
  // 1倍を下回ると足が地面を掻いて後ろへ蹴りすぎる(進むより速く足が動く)
  assert.ok(STEP_SLIP >= 1, `1歩が足の振れ幅より短い(${STEP_SLIP})`);

  // 位相は距離から引く。1歩(π)ぶん進む距離が STEP_DIST
  assert.ok(Math.abs(PHASE_PER_UNIT * STEP_DIST - Math.PI) < 1e-12,
    '位相の進みが1歩の距離と噛み合っていない');

  // **縮尺を変えても、歩数のテンポは変わらないこと。**
  // 距離あたりの位相は 1/縮尺 で増え、速さは縮尺で減るので、
  // 秒あたりの歩数(速さ × 位相 ÷ π)は縮尺に依らない。
  const steps = (WALK_SPEED * PHASE_PER_UNIT) / Math.PI;
  assert.ok(steps > 2 && steps < 6, `1秒の歩数が極端(${steps.toFixed(2)}歩)`);
});

// 海は盤の寸法。人を縮めても水面と沈む深さは動かない ── 動かすと、
// 盤の高さから落ちてきた勢いだけが縮まずに残って、一瞬で沈み切る。
test('縮尺: 海の寸法は縮尺と無関係', () => {
  assert.equal(WATER_Y, -0.24);
  assert.equal(SINK_DEPTH, -1.9);
});

// 島の広さは盤で決まっていて変えられない。縮尺の意味は
// 「島が相対的にどれだけ広くなるか」なので、そこを数字で押さえる。
test('縮尺: 島の端から端までが歩いて何秒か', () => {
  const st = createGame({ seed: 11, playerCount: 4, humanIndex: 0, mode: 'dragon' });
  const g = makeGround(st);
  // 陸のいちばん端どうし(x 方向に走査して外周を拾う)
  let minX = Infinity;
  let maxX = -Infinity;
  for (let x = -8; x <= 8; x += 0.05) {
    for (let y = -8; y <= 8; y += 0.05) {
      if (!g(x, y).ok) continue;
      minX = Math.min(minX, x);
      maxX = Math.max(maxX, x);
    }
  }
  const cross = (maxX - minX) / WALK_SPEED;
  // 等倍(3.6秒)では鬼ごっこにならないので縮めた。5秒を切ったら縮め足りない
  assert.ok(cross > 5, `島を横断するのが速すぎる(${cross.toFixed(1)}秒)`);
});

// 受付は島の中心に立つが、**木や岩は盤の寸法で棒人間ほど縮まない**。
// 縮尺を下げると、受付の縁から手の届く距離までの隙間が木で埋まって、
// 誰も受付にたどり着けなくなる ── 実際そうなっていた(2人目がエントリー
// できない、として報告された)。受付のまわりは片付けて広場にする。
test('縮尺: 受付のまわりは片付ける(木で塞がれない広さ)', async () => {
  const { clearAround, WALKER_RADIUS: wr } = await import('../src/minigame/obstacles.js');
  const { DESK_CLEAR, DESK_REACH, DESK_RADIUS } = await import('../src/minigame/ground.js');

  // 広場は「寄れる隙間」をまるごと含むこと。含まないと、隙間に木が残る。
  assert.ok(DESK_CLEAR > DESK_REACH + wr, '広場が手の届く範囲より狭い');
  // 降り立つ輪(席ごとの立ち位置)も広場の中にあること
  const st = createGame({ seed: 11, playerCount: 4, humanIndex: 0, mode: 'dragon' });
  const home = spawnPoint(st);
  for (let seat = 0; seat < 8; seat += 1) {
    const p = spawnPoint(st, seat);
    const d = Math.hypot(p.x - home.x, p.y - home.y);
    assert.ok(d + wr < DESK_CLEAR, `席 ${seat} の立ち位置が広場の外(${d.toFixed(2)})`);
  }

  // 実際に塞いでいた並び(本番の実測値)で、片付けられることを見る
  const at = { x: 0, z: 0 };
  const trees = [
    { x: 0.28, z: 0, r: 0.15, h: 0.32 },
    { x: 0, z: 0.29, r: 0.09, h: 0.24 },
    { x: -0.36, z: 0, r: 0.13, h: 0.29 },
    { x: 1.4, z: 0, r: 0.15, h: 0.35 },   // 遠いので残る
  ];
  const { kept, cleared } = clearAround(trees, at, DESK_CLEAR);
  assert.equal(cleared.length, 3, '受付を塞いでいた木が残った');
  assert.equal(kept.length, 1, '遠くの木まで片付けた');
  // 残った物が、寄れる隙間に食い込んでいないこと
  for (const o of kept) {
    const gap = Math.hypot(o.x - at.x, o.z - at.z) - o.r - wr;
    assert.ok(gap > DESK_REACH, `残した物が受付の手前を塞ぐ(${gap.toFixed(2)})`);
  }

  // 広場のすぐ外に立った**太い**木。中心は広場の外(0.52 > DESK_CLEAR)でも
  // 枝は 0.34 まで届く ── 中心の距離で切ると残ってしまい、受付の手前で
  // 行き止まりになる(本番でそうなっていた実測値)。
  const fat = [{ x: -0.133, z: -0.501, r: 0.175, h: 0.32 }];
  assert.ok(Math.hypot(fat[0].x, fat[0].z) > DESK_CLEAR, '前提: 中心は広場の外');
  assert.equal(clearAround(fat, at, DESK_CLEAR).kept.length, 0,
    '広場にはみ出した木が残った');

  // どんな並びでも「残った物は寄れる隙間に届かない」こと。
  // 個別の並びだけで押さえていると、次の抜け道を見逃す。
  let rs = 1;
  const rnd = () => ((rs = (rs * 1103515245 + 12345) % 2147483648) / 2147483648);
  const many = Array.from({ length: 400 }, () => ({
    x: (rnd() - 0.5) * 3, z: (rnd() - 0.5) * 3, r: 0.05 + rnd() * 0.2, h: 0.3,
  }));
  for (const o of clearAround(many, at, DESK_CLEAR).kept) {
    const gap = Math.hypot(o.x - at.x, o.z - at.z) - o.r - wr;
    assert.ok(gap > DESK_REACH,
      `残した物が受付の手前を塞ぐ(隙間 ${gap.toFixed(2)} / r ${o.r.toFixed(2)})`);
  }
});
