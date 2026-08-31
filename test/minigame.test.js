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

// 入力の向き。左右が反転していても盤面の判定は全部通るので、
// テストが無いと気づけない(実際に一度反転させたまま出してしまった)。
//
// カメラは walker の後ろ(-Z 側)から +Z を向いて置く。つまり
//   画面奥  = ( sin(camYaw),  cos(camYaw))
//   画面右  = (-cos(camYaw),  sin(camYaw))
// スティックを倒した向きへ、この基準で動くことを確かめる。
test('walk: スティックの向きと移動の向きが一致する(左右が反転しない)', async () => {
  const { Walker } = await import('../src/minigame/walker.js');
  const s = game('base');
  const ground = makeGround(s);
  const start = spawnPoint(s);

  // THREE を使わずに済むよう、Walker が必要とする最小限の scene を渡す
  const scene = { add() {} };

  const run = (input, camYaw) => {
    const w = new Walker(scene, ground, 0);
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
