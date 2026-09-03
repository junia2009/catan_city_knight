// 竜の棲む山(src/minigame/ground.js の nestPoint)。
//
// 「島に竜が棲んでいる」を成り立たせているのはこの1本。ここがずれると、
// 画面では山の上に居る竜が、当たり判定では別のところから飛んでくる。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createGame } from '../src/state.js';
import {
  nestPoint, meetHome, spawnPoint, hexCenter, makeGround,
} from '../src/minigame/ground.js';
import { dragonNestHex } from '../src/rules/dragon.js';
import { MODES } from '../src/progress.js';

const game = (mode, seed) => createGame({ seed, playerCount: 4, humanIndex: 0, mode });

test('巣: 竜の島にだけ在る', () => {
  for (const mode of MODES) {
    const p = nestPoint(game(mode, 11));
    if (mode === 'dragon') assert.ok(p, '竜の島に巣が無い');
    else assert.equal(p, null, `${mode} の島に巣がある`);
  }
});

// 場所を決めているのは対戦のルール。散策が別の場所を指し始めたら、
// 盤の上の竜(盗賊の駒)と、歩いて見に行く竜が別の山に居ることになる。
test('巣: 対戦のルールが決めた山と同じところ', () => {
  for (const seed of [1, 7, 11, 42, 99, 2024]) {
    const st = game('dragon', seed);
    const hid = dragonNestHex(st.board);
    const c = hexCenter(hid);
    const p = nestPoint(st);
    assert.equal(p.x, c.x, `種 ${seed}: x がずれた`);
    assert.equal(p.y, c.y, `種 ${seed}: y がずれた`);
    // 盤に置かれている竜(盗賊の位置)とも一致すること
    assert.equal(st.board.robber, hid, `種 ${seed}: 盤の竜が巣に居ない`);
  }
});

// 受付の広場と巣が同じ場所だと、大会が始まった瞬間に竜が全員の真上に居る
// (実際そうなっていた ── 竜は島の中心から湧いていた)。
test('巣: 受付の広場から離れている', () => {
  for (const seed of [1, 7, 11, 42, 99, 2024]) {
    const st = game('dragon', seed);
    const nest = nestPoint(st);
    const home = spawnPoint(st);
    const d = Math.hypot(nest.x - home.x, nest.y - home.y);
    // ヘックス1つぶん(隣の中心までが約1.73)は離れていること
    assert.ok(d > 1.7, `種 ${seed}: 巣が広場に近すぎる(${d.toFixed(2)})`);
  }
});

// 飛び立つところが海の上だと、竜が水面から出てくる。
// 巣は山なので必ず陸だが、ヘックスの中心を取り違えると簡単に外れる。
test('巣: 陸の上にある', () => {
  for (const seed of [1, 7, 11, 42, 99, 2024]) {
    const st = game('dragon', seed);
    const p = nestPoint(st);
    const g = makeGround(st);
    assert.ok(g(p.x, p.y).ok, `種 ${seed}: 巣が陸の上にない`);
  }
});

// サーバー(room-do.js の primeMeet)が竜の出どころを決めるのに通す1本。
// 分岐を Durable Object の中に書くとテストから触れないので、ここへ出してある。
test('巣: 竜は巣から、それ以外は島の中心から現れる', () => {
  const dragon = game('dragon', 11);
  assert.deepEqual(meetHome(dragon), nestPoint(dragon), '竜が巣から来ていない');
  assert.notDeepEqual(meetHome(dragon), spawnPoint(dragon), '竜が広場から湧いている');
  for (const mode of MODES.filter((m) => m !== 'dragon')) {
    const st = game(mode, 11);
    assert.deepEqual(meetHome(st), spawnPoint(st), `${mode} の島で中心に倒れていない`);
  }
});

test('巣: 竜の居ない state でも落ちない', () => {
  assert.equal(nestPoint(null), null);
  assert.equal(nestPoint({}), null);
  assert.equal(nestPoint({ dragon: null }), null);
  assert.equal(nestPoint({ dragon: {} }), null);
});
