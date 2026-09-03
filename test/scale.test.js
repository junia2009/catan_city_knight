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
