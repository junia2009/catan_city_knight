// 蛮族を射る(都市と騎士の島)。進行の計算と、櫓を建てる場所。
//
// 見た目は要らない ── archery.js も ground.js も THREE を使わないので、
// node だけで最後まで回せる。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createGame } from '../src/state.js';
import {
  makeGround, watchPost, spawnPoint, fishingSpots, POST_RADIUS, POST_OPEN_SEA, SPOT_RADIUS,
} from '../src/minigame/ground.js';
import {
  Raid, LIVES, SHIP_SCORE, FOE_SCORE, ARROW_MIN, ARROW_MAX, ARROW_GRAVITY,
  BOW_Y, reach, shipsInWave, ARCHERY_MODES,
} from '../src/minigame/archery.js';

const game = (mode) => createGame({ seed: 7, playerCount: 4, humanIndex: -1, mode });
// 陸(タイルの上面)に立ち、沖は +Z のほう。海面はそれより下
const SEA = 0.02;
const POST = { x: 0, z: 0, y: 0.26, outX: 0, outZ: 1 };
const raid = (seed) => new Raid(seed, POST, SEA);
// 弓を構える点
const BOW = { x: POST.x, y: POST.y + BOW_Y, z: POST.z };

// dt を細かく刻んで進める(実際の呼ばれ方に合わせる)
function run(r, seconds, each = null) {
  for (let i = 0; i < Math.round(seconds * 60); i++) {
    r.update(1 / 60);
    if (each) each(r, i / 60);
  }
  return r;
}

test('弓: 船は沖から寄せてきて、放っておくと浜に着く', () => {
  const r = raid(1);
  run(r, 2);
  assert.ok(r.ships.length > 0, '船が湧かない');
  const first = r.ships[0];
  assert.ok(first.z > 3, `沖から湧いていない(z ${first.z.toFixed(2)})`);
  run(r, 12);
  assert.ok(r.foes.length > 0, '浜に降りてこない');
});

test('弓: 取り逃がし続けると、櫓に着かれて終わる', () => {
  const r = raid(1);
  assert.equal(r.lives, LIVES);
  run(r, 60);
  assert.equal(r.phase, 'over', '何もしなくても終わらない');
  assert.equal(r.lives, 0);
});

test('弓: 船を射ると沈み、積んでいた蛮族ごと止まる', () => {
  const r = raid(1);
  run(r, 2);
  const s = r.ships[0];
  const before = r.score;
  // 船の真上から落とす(当たる高さに入るように低く撃つ)
  r.shoot(BOW, { x: s.x - BOW.x, y: s.y + 0.2 - BOW.y, z: s.z - BOW.z }, 1);
  run(r, 0.6);
  assert.ok(!r.ships.includes(s), '船が残っている');
  assert.equal(r.score, before + SHIP_SCORE + s.carry * FOE_SCORE);
  assert.equal(r.hits, 1);
  // 沈めた船からは誰も降りてこない
  run(r, 12);
  assert.equal(r.foes.length, 0, '沈めたのに蛮族が降りてきた');
});

test('弓: 浜の蛮族も射て止められる', () => {
  const r = raid(1);
  run(r, 14);
  assert.ok(r.foes.length > 0, '蛮族が降りていない');
  const f = r.foes[0];
  const before = r.score;
  r.shoot(BOW, { x: f.x - BOW.x, y: f.y + 0.15 - BOW.y, z: f.z - BOW.z }, 1);
  run(r, 0.4);
  assert.ok(!r.foes.includes(f), '蛮族が残っている');
  assert.equal(r.score, before + FOE_SCORE);
});

test('弓: 外した矢は当たりに数えない(命中率が出る)', () => {
  const r = raid(1);
  run(r, 2);
  assert.equal(r.accuracy, null, '一本も射っていないのに命中率が出ている');
  r.shoot(BOW, { x: 1, y: 0.2, z: 0 }, 1);  // 岸に沿って空へ
  run(r, 5);
  assert.equal(r.shots, 1);
  assert.equal(r.hits, 0);
  assert.equal(r.accuracy, 0);
});

// 引き絞りが効かないと、狙う面白さが「当てるだけ」になる。
// ここは**遊びの根っこ**: 沖の船は引き絞らないと届かず、近くの蛮族なら
// 素早く放っても届く。重力を消すとどちらも同じになって成立しない。
test('弓: 満に引けば沖の船に届き、浅く引くと届かない', () => {
  // 沖 D に浮かべた船を、水平に狙って撃つ
  const tryAt = (D, power) => {
    const r = raid(1);
    r.left = 0; r.next = 999;
    r.ships = [{ id: 1, x: 0, z: D, y: SEA, side: 0, carry: 1, speed: 0 }];
    r.shoot(BOW, { x: 0, y: 0, z: 1 }, power);   // 水平に放つ
    run(r, 3);
    return r.hits === 1;
  };
  assert.ok(tryAt(5.0, 1), '満に引いても沖の船に届かない');
  assert.ok(!tryAt(5.0, 0), '浅く引いても沖の船に届いてしまう');
  assert.ok(tryAt(2.0, 0), '浅く引くと近くにも届かない');
});

// reach() は画面の「ここまで届く」表示にも使う。実際の飛びと合っていること。
test('弓: reach() と実際の飛距離が合う', () => {
  for (const power of [0, 0.5, 1]) {
    const r = raid(1);
    r.left = 0; r.next = 999;
    const a = r.shoot(BOW, { x: 0, y: 0, z: 1 }, power);
    let last = 0;
    for (let i = 0; i < 600 && r.arrows.length; i++) { r.update(1 / 60); last = a.z; }
    const want = reach(power, BOW.y, SEA);
    assert.ok(Math.abs(last - want) < 0.15,
      `合わない(引き ${power}: 実際 ${last.toFixed(2)} / reach ${want.toFixed(2)})`);
  }
});

// 重力が無いと矢が水平に飛び続け、射程という概念が消える。
test('弓: 水平に放った矢は水面まで落ちて消える', () => {
  const r = raid(1);
  r.left = 0; r.next = 999;
  const a = r.shoot(BOW, { x: 0, y: 0, z: 1 }, 1);
  const t0 = a.y;
  run(r, 0.2);
  assert.ok(a.y < t0, `落ちていない(${t0.toFixed(3)} → ${a.y.toFixed(3)})`);
  // 保険の寿命(4秒)より前に、水面に届いて消えること
  run(r, 1.0);
  assert.equal(r.arrows.length, 0, '水面まで落ちずに飛び続けている');
  assert.ok(ARROW_GRAVITY > 0, '重力が無い');
});

// 波の切れ目。「凌ぎ切った」と「次が始まった」は別の合図で出すこと ──
// ひとつにまとめると、一区切りついたことが画面に出せない。
test('弓: 波を凌ぎ切ると合図が出て、少し間を置いて次の波が始まる', () => {
  const r = raid(1);
  const seen = [];
  for (let i = 0; i < 60 * 40; i++) {
    // 湧いた船は片端から沈めて、こちらは無傷のまま波を越える
    for (const s of r.ships.slice()) {
      r.shoot(BOW, { x: s.x - BOW.x, y: s.y + 0.2 - BOW.y, z: s.z - BOW.z }, 1);
    }
    r.update(1 / 60);
    for (const e of r.takeEvents()) if (e.type === 'cleared' || e.type === 'wave') seen.push(e);
    if (seen.some((e) => e.type === 'wave')) break;
  }
  assert.equal(seen[0]?.type, 'cleared', `凌ぎ切った合図が出ない(${JSON.stringify(seen)})`);
  assert.equal(seen[0].wave, 1);
  assert.equal(seen[1]?.type, 'wave', '次の波の合図が出ない');
  assert.equal(seen[1].wave, 2);
  assert.equal(r.lives, LIVES, '無傷で越えられていない');
});

test('弓: 凌ぎ切っている間は「次の波まで」が読める', () => {
  const r = raid(1);
  for (let i = 0; i < 60 * 40; i++) {
    for (const s of r.ships.slice()) {
      r.shoot(BOW, { x: s.x - BOW.x, y: s.y + 0.2 - BOW.y, z: s.z - BOW.z }, 1);
    }
    r.update(1 / 60);
    if (r.view().cleared) break;
  }
  const v = r.view();
  assert.ok(v.cleared, '凌ぎ切った状態にならない');
  assert.ok(v.untilNext > 0, `次の波までが読めない(${v.untilNext})`);
  // 攻めている間は null(「あと何秒」を出しっぱなしにしない)
  const r2 = raid(1);
  run(r2, 3);
  assert.equal(r2.view().untilNext, null);
});

test('弓: 波が進むと船が増える', () => {
  assert.ok(shipsInWave(3) > shipsInWave(1), '波が進んでも船が増えない');
  assert.ok(shipsInWave(1) >= 2, '1波目が少なすぎる');
});

// 同じシードなら同じ攻め方。「さっきと同じ島で試す」ができなくなる
test('弓: 同じシードなら同じように寄せてくる', () => {
  const play = () => {
    const r = raid(4242);
    run(r, 10);
    return r.ships.map((s) => `${s.x.toFixed(4)},${s.z.toFixed(4)},${s.carry}`).join('|');
  };
  assert.equal(play(), play());
});

test('弓: 別のシードなら別の攻め方', () => {
  const play = (seed) => {
    const r = raid(seed);
    run(r, 10);
    return r.ships.map((s) => s.x.toFixed(4)).join('|');
  };
  assert.notEqual(play(1), play(2));
});

// ---- 櫓を建てる場所 ----

const SEEDS = [7, 11, 42, 99, 512, 2026];

test('弓: 櫓は陸の上で、正面が海', () => {
  for (const mode of ['base', 'cak', 'dragon', 'fish', 'sea']) for (const seed of SEEDS) {
    const s = createGame({ seed, playerCount: 4, humanIndex: -1, mode });
    const p = watchPost(s);
    const tag = `${mode}/${seed}`;
    assert.ok(p, `${tag}: 櫓の場所が決まらない`);
    const ground = makeGround(s);
    assert.ok(ground(p.x, p.z).ok, `${tag}: 櫓が海の上`);
    // 撃つ先が海であること。**船の湧く沖まで、ずっと**海が続いていること
    // (岬の先に建てると、撃つ先に自分の島が入り、船が陸の上に湧く)
    for (let d = 0.25; d <= POST_OPEN_SEA; d += 0.25) {
      assert.ok(!ground(p.x + p.outX * d, p.z + p.outZ * d).ok,
        `${tag}: 櫓の ${d.toFixed(2)} 先が陸(撃つ先に島が入る)`);
    }
    assert.ok(Math.abs(Math.hypot(p.outX, p.outZ) - 1) < 1e-9, `${tag}: 沖の向きが単位ベクトルでない`);
  }
});

// 🎣 と 🏹 が同じ場所で取り合わないこと。辺の名前ではなく**立つ範囲**で見る
// ── 隣の辺に建てても、範囲が重なれば同じことになる。
test('弓: 櫓は釣り場と取り合わない', () => {
  for (const mode of ['base', 'cak', 'dragon', 'fish', 'sea']) {
    const s = createGame({ seed: 7, playerCount: 4, humanIndex: -1, mode });
    const p = watchPost(s);
    const ports = new Set((s.board.ports ?? []).map((q) => q.edgeId));
    assert.ok(!ports.has(p.edgeId), `${mode}: 港の辺に櫓を建てている`);
    for (const f of fishingSpots(s)) {
      const d = Math.hypot(f.x - p.x, f.z - p.z);
      assert.ok(d > POST_RADIUS + SPOT_RADIUS,
        `${mode}: 釣り場と範囲が重なる(${d.toFixed(2)})`);
    }
  }
});

// 受付や湧く場所の真横に建つと、歩いて向かう先にならない。
test('弓: 櫓は降り立つ場所から離れている', () => {
  for (const seed of SEEDS) {
    const s = createGame({ seed, playerCount: 4, humanIndex: -1, mode: 'cak' });
    const p = watchPost(s);
    const home = spawnPoint(s);
    const d = Math.hypot(p.x - home.x, p.z - home.y);
    assert.ok(d > POST_RADIUS * 4, `seed ${seed}: 櫓が近すぎる(${d.toFixed(2)})`);
  }
});

test('弓: 同じ島なら毎回同じ場所に建つ', () => {
  const a = watchPost(game('cak'));
  const b = watchPost(game('cak'));
  assert.deepEqual(a, b);
});

test('弓: 開く島の一覧に都市と騎士が入っている', () => {
  assert.ok(ARCHERY_MODES.includes('cak'));
});
