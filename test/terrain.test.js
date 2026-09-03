// 「立てる面」の高さ(src/terrain.js)。
//
// 描いてあるものと足の位置が食い違うと、足が地面に埋まる(実機で報告された)。
// いま面を持ち上げているのは数字トークンの円盤だけなので、そこを押さえる。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  TILE_TOP, TOKEN_H, TOKEN_R, boardScale, hexCenter, surfaceHeight, tokenRadius,
} from '../src/terrain.js';
import { createGame } from '../src/state.js';

const game = (mode) => createGame({ seed: 11, playerCount: 4, humanIndex: 0, mode });

test('地面: タイル上面の値は board3d と同じ', () => {
  assert.equal(TILE_TOP, 0.26);
});

// 円盤(半径 0.33・厚み 0.05)の上では、その厚みのぶん上に立つ。
// 見ていなかったころは、円盤の真ん中に立つと膝まで潜っていた。
test('トークン: 円盤の上では厚みのぶん高い', () => {
  const st = game('base');
  const hid = st.board.hexIds.find((h) => st.board.hexes[h].token);
  const c = hexCenter(hid);
  const r = tokenRadius(st.board);
  assert.equal(surfaceHeight(st.board, hid, c.x, c.y, r), TOKEN_H, '円盤に潜っている');
  // 縁のすぐ内側では乗っている
  assert.equal(surfaceHeight(st.board, hid, c.x + r - 0.02, c.y, r), TOKEN_H, '縁の内側で潜る');
  // 円盤の外では持ち上がらない
  assert.equal(surfaceHeight(st.board, hid, c.x + r + 0.02, c.y, r), 0, '円盤の外まで持ち上がる');
});

test('トークン: 無いヘックス(砂漠)では持ち上がらない', () => {
  const st = game('base');
  const hid = st.board.hexIds.find((h) => !st.board.hexes[h].token);
  const c = hexCenter(hid);
  assert.equal(surfaceHeight(st.board, hid, c.x, c.y), 0, '砂漠が持ち上がっている');
});

test('トークン: 知らないヘックスでも落ちない', () => {
  const st = game('base');
  assert.equal(surfaceHeight(st.board, 'こんなヘックスはない', 0, 0), 0);
});

// 広い盤ではトークンを大きく描く(board3d.js)。乗れる範囲も一緒に広がること。
// ここがずれると、航海者の島だけ円盤の縁で足が埋まる。
test('トークン: 広い盤では円盤も乗れる範囲も大きくなる', () => {
  const base = game('base');
  const sea = game('sea');
  assert.equal(boardScale(base.board), 1, '基本の盤が基準(1)になっていない');
  assert.ok(boardScale(sea.board) > 1, '航海者の盤が広いと見なされていない');
  assert.equal(tokenRadius(base.board), TOKEN_R);
  assert.ok(tokenRadius(sea.board) > TOKEN_R, '広い盤で円盤が大きくなっていない');
  // 描くほうの上限(1.35倍)を超えない
  assert.ok(tokenRadius(sea.board) <= TOKEN_R * 1.35 + 1e-9, '描いてある円盤より広い');
  // 基本の盤の円盤の外側でも、広い盤なら乗れる位置がある
  const hid = sea.board.hexIds.find((h) => sea.board.hexes[h].token);
  const c = hexCenter(hid);
  const x = c.x + TOKEN_R + 0.02;
  assert.equal(surfaceHeight(sea.board, hid, x, c.y), TOKEN_H, '広い盤で円盤の縁が潜る');
});

test('ヘックスの中心: 6頂点の平均', () => {
  const st = game('base');
  for (const hid of st.board.hexIds.slice(0, 4)) {
    const c = hexCenter(hid);
    assert.ok(Number.isFinite(c.x) && Number.isFinite(c.y), `${hid}: 中心が数でない`);
  }
  // 同じものを返す(参照を毎回作り直さない)
  assert.equal(hexCenter(st.board.hexIds[0]), hexCenter(st.board.hexIds[0]));
});
