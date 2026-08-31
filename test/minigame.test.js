// ミニゲーム「島を歩く」の地面判定。
//
// 盤の幾何を1つ間違えると、海の上を歩けたり島の真ん中に穴が空いたりする。
// 描画を見ただけでは気づきにくいので、ここで数値として押さえる。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createGame } from '../src/state.js';
import { LAYOUT } from '../src/rules/board.js';
import { isLandHex } from '../src/rules/sea.js';
import { makeGround, spawnPoint } from '../src/minigame/ground.js';
import { WalkerMotion, WALK_SPEED } from '../src/minigame/motion.js';
import { makeBlocker, WALKER_RADIUS } from '../src/minigame/obstacles.js';

const MODES = ['base', 'cak', 'dragon', 'fish', 'sea'];

function game(mode) {
  return createGame({ seed: 7, playerCount: 4, humanIndex: 0, mode });
}

function hexCenter(hid) {
  let x = 0;
  let y = 0;
  for (const vid of LAYOUT.hexVertices[hid]) {
    x += LAYOUT.vertices[vid].x;
    y += LAYOUT.vertices[vid].y;
  }
  return { x: x / 6, y: y / 6 };
}

test('walk: ヘックスの中心には必ず立てる(島に穴が空いていない)', () => {
  for (const mode of MODES) {
    const s = game(mode);
    const g = makeGround(s);
    for (const hid of s.board.hexIds) {
      if (mode === 'sea' && !isLandHex(s.board, hid)) continue;
      const c = hexCenter(hid);
      const at = g(c.x, c.y);
      assert.ok(at.ok, `${mode}: ${hid} の中心に立てない`);
      assert.equal(at.hexId, hid, `${mode}: ${hid} の中心が別のヘックス扱い`);
    }
  }
});

test('walk: 隣り合うヘックスの境目にも立てる(継ぎ目に落ちない)', () => {
  const s = game('base');
  const g = makeGround(s);
  const ids = s.board.hexIds;
  let checked = 0;
  for (const hid of ids) {
    const a = hexCenter(hid);
    for (const other of ids) {
      if (other === hid) continue;
      const b = hexCenter(other);
      const d = Math.hypot(a.x - b.x, a.y - b.y);
      // 外接円半径が 1.0 なので、隣り合うヘックスの中心間は √3 ≒ 1.732
      if (d > 1.8) continue;
      const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
      assert.ok(g(mid.x, mid.y).ok, `${hid}-${other} の境目に立てない`);
      checked++;
    }
  }
  assert.ok(checked > 20, `隣接の検査が少なすぎる(${checked}組)`);
});

test('walk: 島から十分離れた海の上には立てない', () => {
  for (const mode of MODES) {
    const s = game(mode);
    const g = makeGround(s);
    // 盤のどのヘックス中心からも遠い点は、必ず「歩けない」
    // 盤は最大でも半径4(中心間 1.732 × 4 ≒ 7)なので、20 は確実に外
    const far = [[0, 20], [20, 0], [-20, -20], [0, -20]];
    for (const [x, z] of far) {
      assert.equal(g(x, z).ok, false, `${mode}: (${x},${z}) に立ててしまう`);
    }
  }
});

test('walk: 航海者たちでは海のヘックスに立てない(陸だけ歩ける)', () => {
  const s = game('sea');
  const g = makeGround(s);
  let seaHexes = 0;
  for (const hid of s.board.hexIds) {
    if (isLandHex(s.board, hid)) continue;
    seaHexes++;
    const c = hexCenter(hid);
    assert.equal(g(c.x, c.y).ok, false, `海のヘックス ${hid} に立ててしまう`);
  }
  assert.ok(seaHexes > 10, `海のヘックスが少なすぎる(${seaHexes})`);
});

test('walk: 開始地点は必ず陸の上', () => {
  for (const mode of MODES) {
    const s = game(mode);
    const g = makeGround(s);
    const p = spawnPoint(s);
    assert.ok(g(p.x, p.y).ok, `${mode}: 開始地点が陸でない`);
  }
});

test('walk: 立っている地面の高さは一定(タイル上面)', () => {
  const s = game('base');
  const g = makeGround(s);
  const ys = new Set();
  for (const hid of s.board.hexIds) {
    const c = hexCenter(hid);
    ys.add(g(c.x, c.y).y);
  }
  assert.equal(ys.size, 1, `高さが揃っていない: ${[...ys].join(',')}`);
});

// 盤の上の物への当たり判定。すり抜けるとゲームとして目に見えて壊れて見える
// (実際に盗賊を貫通した状態で出してしまった)。
test('walk: 障害物にめり込まない', () => {
  const block = makeBlocker([{ x: 0, z: 0, r: 0.25 }]);
  const need = 0.25 + WALKER_RADIUS;

  // 正面から突っ込む
  const head = block(-1, 0, 0.05, 0);
  assert.equal(head.hit, true, '重なっているのに hit でない');
  assert.ok(Math.hypot(head.x, head.z) >= need - 1e-9, `めり込んでいる(${Math.hypot(head.x, head.z)})`);

  // 触れていなければ動かさない(端から落ちる挙動を邪魔しない)
  const clear = block(-1, 0, -0.9, 0);
  assert.equal(clear.hit, false, '触れていないのに hit');
});

test('walk: 障害物に当たっても横には進める(滑る)', () => {
  const block = makeBlocker([{ x: 0, z: 0, r: 0.25 }]);
  // 斜めに当てる。押し出されても、進みたかった横方向には出ている
  const r = block(-0.5, -0.5, -0.2, -0.2);
  assert.equal(r.hit, true);
  assert.ok(r.x > -0.5 && r.z > -0.5, `横に進めていない (${r.x}, ${r.z})`);
});

test('walk: 障害物に挟まれても、どれにもめり込まない', () => {
  const obs = [
    { x: 0, z: 0, r: 0.2 },
    { x: 0.5, z: 0, r: 0.2 },
    { x: 0.25, z: 0.45, r: 0.2 },
  ];
  const block = makeBlocker(obs);
  // 3つの真ん中(隙間)へ押し込む
  const r = block(0.25, -1, 0.25, 0.15);
  for (const o of obs) {
    const d = Math.hypot(r.x - o.x, r.z - o.z);
    assert.ok(d >= o.r + WALKER_RADIUS - 1e-6, `(${o.x},${o.z}) にめり込んでいる(${d.toFixed(3)})`);
  }
});

// 押し出しは位置を直すだけなので、1フレームの移動量が障害物の直径より
// 大きいとすり抜ける。実際の値がそうなっていないことを数字で押さえる。
test('walk: 1フレームの移動量が、いちばん小さい障害物より小さい', () => {
  const perFrame = WALK_SPEED * 0.05; // 速さ × 刻みの上限
  const smallest = (0.09 + WALKER_RADIUS) * 2; // 実測でいちばん細い木 + 棒人間
  assert.ok(perFrame < smallest, `すり抜けうる(1フレーム ${perFrame} / 直径 ${smallest}`);
});

test('walk: 盤の上の物を通り抜けられない(歩き続けても中に入らない)', () => {
  const s = game('base');
  const ground = makeGround(s);
  const start = spawnPoint(s);
  // 進行方向の少し先に障害物を置く
  const o = { x: start.x, z: start.y + 0.5, r: 0.25 };
  const w = new WalkerMotion(ground, makeBlocker([o]));
  w.setPosition(start.x, start.y);

  let closest = Infinity;
  for (let i = 0; i < 120; i++) {
    w.update(1 / 60, { x: 0, y: 1 }, 0);
    closest = Math.min(closest, Math.hypot(w.pos.x - o.x, w.pos.z - o.z));
  }
  assert.ok(closest >= o.r + WALKER_RADIUS - 1e-6, `中に入った(最接近 ${closest.toFixed(3)})`);
  assert.ok(w.pos.z > start.y, '障害物の手前まで進んでいない');
});

test('walk: 島の端を踏み外すと落ち、直前の足場に戻る', () => {
  const s = game('base');
  const ground = makeGround(s);
  const start = spawnPoint(s);
  const w = new WalkerMotion(ground);
  w.setPosition(start.x, start.y);

  // 一方向に歩き続ければ、いずれ島の端から海へ出る
  let fell = false;
  let back = null;
  for (let i = 0; i < 2000; i++) {
    const r = w.update(1 / 60, { x: 0, y: 1 }, 0);
    if (r.falling) fell = true;
    if (r.respawned) { back = { x: w.pos.x, z: w.pos.z }; break; }
  }

  assert.ok(fell, '端まで歩いても落ちない');
  assert.ok(back, '落ちたまま戻ってこない');
  assert.ok(ground(back.x, back.z).ok, '復帰先が陸でない');
  assert.equal(w.falling, false, '復帰後も落下中のまま');
});

// 入力の向き。左右が反転していても盤面の判定は全部通るので、
// テストが無いと気づけない(実際に一度反転させたまま出してしまった)。
//
// カメラは walker の後ろ(-Z 側)から +Z を向いて置く。つまり
//   画面奥  = ( sin(camYaw),  cos(camYaw))
//   画面右  = (-cos(camYaw),  sin(camYaw))
// スティックを倒した向きへ、この基準で動くことを確かめる。
test('walk: スティックの向きと移動の向きが一致する(左右が反転しない)', () => {
  const s = game('base');
  const ground = makeGround(s);
  const start = spawnPoint(s);

  const run = (input, camYaw) => {
    const w = new WalkerMotion(ground);
    w.setPosition(start.x, start.y);
    for (let i = 0; i < 30; i++) w.update(1 / 60, input, camYaw);
    const dx = w.pos.x - start.x;
    const dz = w.pos.z - start.y;
    const fwd = { x: Math.sin(camYaw), z: Math.cos(camYaw) };
    const right = { x: -Math.cos(camYaw), z: Math.sin(camYaw) };
    return {
      screenX: dx * right.x + dz * right.z,
      screenDepth: dx * fwd.x + dz * fwd.z,
    };
  };

  // カメラの向きを変えても、スティックの向きと画面上の動きは一致する
  for (const camYaw of [0, Math.PI / 2, Math.PI, -Math.PI / 3]) {
    const label = `camYaw=${camYaw.toFixed(2)}`;
    const right = run({ x: 1, y: 0 }, camYaw);
    assert.ok(right.screenX > 0.05, `${label}: 右に倒したのに画面右へ行かない (${right.screenX.toFixed(3)})`);

    const left = run({ x: -1, y: 0 }, camYaw);
    assert.ok(left.screenX < -0.05, `${label}: 左に倒したのに画面左へ行かない (${left.screenX.toFixed(3)})`);

    const fwd = run({ x: 0, y: 1 }, camYaw);
    assert.ok(fwd.screenDepth > 0.05, `${label}: 前に倒したのに画面奥へ行かない (${fwd.screenDepth.toFixed(3)})`);

    const back = run({ x: 0, y: -1 }, camYaw);
    assert.ok(back.screenDepth < -0.05, `${label}: 後に倒したのに手前へ来ない (${back.screenDepth.toFixed(3)})`);
  }
});
