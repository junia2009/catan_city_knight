// 地面の高さ(src/terrain.js)。
//
// **描くほうと歩くほうが同じ面を指していること**が全て。ここがずれると、
// 見えている地面に足が埋まる(実機で報告された)。
// board3d.js は capVertexHeight で地表メッシュの頂点を置き、歩く側は
// capHeight でその三角形の上を読む ── その2つが噛み合っているかを見る。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  TILE_TOP, CAP_PARAMS, CAP_N, CAP_FLAT, capCorners, capVertexHeight, capHeight,
  surfaceHeight, tokenRadius, tokenTop, boardScale, hexCenter, TOKEN_H, TOKEN_R,
} from '../src/terrain.js';
import { createGame } from '../src/state.js';
import { LAYOUT } from '../src/rules/board.js';

const HEX = LAYOUT.hexIds[3];
const TERRAINS = Object.keys(CAP_PARAMS);
const game = (mode) => createGame({ seed: 11, playerCount: 4, humanIndex: 0, mode });

// メッシュの頂点の上では、読み取った高さは頂点そのものの高さになるはず。
// ここがずれるなら、三角形の当てはめ方が board3d.js の張り方と違っている。
test('地面: メッシュの頂点の上では頂点の高さと一致する', () => {
  const corners = capCorners();
  const c = hexCenter(HEX);
  for (const terrain of TERRAINS) {
    for (let s = 0; s < 6; s++) {
      const A = corners[s];
      const B = corners[(s + 1) % 6];
      for (let i = 0; i <= CAP_N; i++) {
        for (let j = 0; j + i <= CAP_N; j++) {
          const lx = (A[0] * i + B[0] * j) / CAP_N;
          const lz = (A[1] * i + B[1] * j) / CAP_N;
          const want = capVertexHeight(HEX, terrain, lx, lz, (i + j) / CAP_N);
          const got = capHeight(HEX, terrain, c.x + lx, c.y + lz);
          assert.ok(Math.abs(got - want) < 1e-9,
            `${terrain} セクター${s} (${i},${j}): ${got} ≠ ${want}`);
        }
      }
    }
  }
});

// 三角形をまたぐところで高さが飛ぶと、歩いていて足元がガクつく。
test('地面: どこも滑らかにつながっている(段差がない)', () => {
  const c = hexCenter(HEX);
  const step = 0.004;
  for (const terrain of TERRAINS) {
    const amp = CAP_PARAMS[terrain].amp;
    let worst = 0;
    for (let x = -0.9; x <= 0.9; x += step) {
      const a = capHeight(HEX, terrain, c.x + x, c.y + 0.21);
      const b = capHeight(HEX, terrain, c.x + x + step, c.y + 0.21);
      worst = Math.max(worst, Math.abs(a - b));
    }
    assert.ok(worst < amp * 0.1,
      `${terrain}: 段差がある(1歩で ${worst.toFixed(4)} / 起伏 ${amp})`);
  }
});

test('地面: 中心と縁では平ら、途中でいちばん高い', () => {
  const c = hexCenter(HEX);
  for (const terrain of TERRAINS) {
    const amp = CAP_PARAMS[terrain].amp;
    const mid = capHeight(HEX, terrain, c.x + 0.68, c.y);
    assert.ok(capHeight(HEX, terrain, c.x, c.y) < 0.005, `${terrain}: 中心が平らでない`);
    assert.ok(mid > 0.004, `${terrain}: 途中が盛り上がっていない`);
    assert.ok(mid <= 0.004 + amp + 1e-9, `${terrain}: 起伏(${amp})を超えている`);
  }
});

// **数字トークンの下は平らのままにする。**
// 中心から盛り上げると、山(起伏 0.10)では地面が円盤(厚み 0.05)を
// 追い越して、トークンが土に埋まる。
test('地面: 数字トークンの下は平ら(円盤が埋まらない)', () => {
  const st = game('base');
  const r = tokenRadius(st.board);
  assert.ok(CAP_FLAT > r * 1.02, `起伏の始まりが円盤の内側(${CAP_FLAT} ≦ ${r})`);
  const c = hexCenter(HEX);
  for (const terrain of TERRAINS) {
    // 円盤の縁のすぐ内側まで、起伏は厚みより低いこと
    for (const rr of [0, 0.15, r - 0.01]) {
      const h = capHeight(HEX, terrain, c.x + rr, c.y);
      assert.ok(h < TOKEN_H, `${terrain}: 半径 ${rr} で地面が円盤を超える(${h.toFixed(3)})`);
    }
  }
});

test('地面: 起伏の表に無い地形は 0(海・氷など)', () => {
  const c = hexCenter(HEX);
  assert.equal(capHeight(HEX, 'sea', c.x + 0.4, c.y), 0);
  assert.equal(capHeight(HEX, undefined, c.x + 0.4, c.y), 0);
});

// ---- 数字トークン ----

test('トークン: 円盤の上では厚みのぶん高い', () => {
  const st = game('base');
  const hid = st.board.hexIds.find((h) => st.board.hexes[h].token);
  const c = hexCenter(hid);
  const r = tokenRadius(st.board);
  const terrain = st.board.hexes[hid].terrain;
  assert.equal(surfaceHeight(st.board, hid, c.x, c.y), TOKEN_H, '円盤に潜っている');
  // 円盤の外では、円盤ぶんの持ち上げが効かない(地表そのものになる)
  const ox = c.x + r + 0.02;
  assert.equal(surfaceHeight(st.board, hid, ox, c.y), capHeight(hid, terrain, ox, c.y),
    '円盤の外まで持ち上がっている');
});

test('トークン: 無いヘックス(砂漠)では円盤ぶん持ち上がらない', () => {
  const st = game('base');
  const hid = st.board.hexIds.find((h) => !st.board.hexes[h].token);
  const c = hexCenter(hid);
  const terrain = st.board.hexes[hid].terrain;
  assert.equal(surfaceHeight(st.board, hid, c.x, c.y),
    capHeight(hid, terrain, c.x, c.y), '砂漠が円盤ぶん持ち上がっている');
});

test('トークン: 知らないヘックスでも落ちない', () => {
  const st = game('base');
  assert.equal(surfaceHeight(st.board, 'こんなヘックスはない', 0, 0), 0);
});

// 広い盤ではトークンを大きく描く(board3d.js)。乗れる範囲も一緒に広がること。
test('トークン: 広い盤では円盤も乗れる範囲も大きくなる', () => {
  const base = game('base');
  const sea = game('sea');
  assert.equal(boardScale(base.board), 1, '基本の盤が基準(1)になっていない');
  assert.ok(boardScale(sea.board) > 1, '航海者の盤が広いと見なされていない');
  assert.equal(tokenRadius(base.board), TOKEN_R);
  assert.ok(tokenRadius(sea.board) > TOKEN_R, '広い盤で円盤が大きくなっていない');
  assert.ok(tokenRadius(sea.board) <= TOKEN_R * 1.35 + 1e-9, '描いてある円盤より広い');
  // **厚みも一緒に増える。** 半径だけ広げて厚みを据え置くと、
  // 航海者の島だけ 9mm 足が埋まる(レイを落として実測した)。
  assert.equal(tokenTop(base.board), TOKEN_H, '等倍の上面が厚みと違う');
  assert.ok(tokenTop(sea.board) > TOKEN_H, '広い盤で円盤が厚くなっていない');
  assert.ok(Math.abs(tokenTop(sea.board) - (TOKEN_H / 2) * (1 + 1.35)) < 1e-9,
    `広い盤の上面が描画と合わない(${tokenTop(sea.board)})`);
  // 広い盤では、円盤の上に立つ高さもそのぶん高い
  const hid = sea.board.hexIds.find((h) => sea.board.hexes[h].token);
  const c = hexCenter(hid);
  assert.equal(surfaceHeight(sea.board, hid, c.x, c.y), tokenTop(sea.board));
});

test('地面: タイル上面の値は board3d と同じ', () => {
  assert.equal(TILE_TOP, 0.26);
});
