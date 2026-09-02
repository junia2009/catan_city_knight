// 足音。音そのものは鳴らせないが、「地面 × 動き」の決めごとは検査できる。
import test from 'node:test';
import assert from 'node:assert/strict';

import { stepSound, GROUND_KINDS, MOTION_KINDS } from '../src/audio/footsteps.js';
import { LAYOUT, TERRAINS } from '../src/rules/board.js';
import { createGame } from '../src/state.js';
import { makeGround } from '../src/minigame/ground.js';
import { SFX_NAMES } from '../src/audio/sfx.js';

test('足音: 歩ける地形は全て音を持っている', () => {
  // 海は歩けないので要らない。それ以外は盤に出る以上、必ず音がいる。
  const walkable = TERRAINS.filter((t) => t !== 'sea');
  for (const t of walkable) {
    assert.ok(GROUND_KINDS.includes(t), `${t} の足音がない`);
  }
});

// ヘックスの中心(ground.js と同じ計算)
function hexCenterOf(state, hid) {
  let x = 0; let z = 0;
  for (const vid of LAYOUT.hexVertices[hid]) {
    x += LAYOUT.vertices[vid].x;
    z += LAYOUT.vertices[vid].y;
  }
  return { x: x / 6, z: z / 6 };
}

test('足音: どのモードで出る地形も、既定に落ちない', () => {
  // 実際に盤を作って、そこに出る地形が表に載っているかを見る
  const seen = new Set();
  for (const mode of ['base', 'cak', 'dragon', 'fish', 'sea']) {
    for (const seed of [1, 7, 42]) {
      const s = createGame({ seed, playerCount: 4, humanIndex: 0, mode });
      const ground = makeGround(s);
      for (const hid of s.board.hexIds) {
        // 歩ける(= makeGround が陸とみなす)ヘックスだけ
        const c = hexCenterOf(s, hid);
        if (!ground(c.x, c.z).ok) continue;
        seen.add(s.board.hexes[hid].terrain);
      }
    }
  }
  assert.ok(seen.size >= 6, `地形が少なすぎる(${[...seen]})`);
  for (const t of seen) assert.ok(GROUND_KINDS.includes(t), `${t} の足音がない`);
});

test('足音: 中身が全て有限の数値', () => {
  for (const t of GROUND_KINDS) {
    for (const m of MOTION_KINDS) {
      const { noise, thud } = stepSound(t, m);
      for (const k of ['freq', 'q', 'dur', 'gain', 'sweep']) {
        assert.ok(Number.isFinite(noise[k]) && noise[k] > 0, `${t}/${m} の noise.${k}`);
      }
      if (thud) {
        for (const k of ['midi', 'gain', 'dur']) {
          assert.ok(Number.isFinite(thud[k]) && thud[k] > 0, `${t}/${m} の thud.${k}`);
        }
      }
    }
  }
});

test('足音: 跳ぶ・着地は歩きより重い(大きく・低く・長い)', () => {
  for (const t of GROUND_KINDS) {
    const walk = stepSound(t, 'walk');
    const jump = stepSound(t, 'jump');
    const land = stepSound(t, 'land');
    assert.ok(jump.noise.gain > walk.noise.gain, `${t}: 踏み切りが歩きより小さい`);
    assert.ok(land.noise.gain > jump.noise.gain, `${t}: 着地が踏み切りより小さい`);
    assert.ok(land.noise.dur > walk.noise.dur, `${t}: 着地が短い`);
    assert.ok(land.noise.freq < walk.noise.freq, `${t}: 着地が低くない`);
    if (walk.thud) {
      assert.ok(land.thud.gain > walk.thud.gain * 2, `${t}: 着地の重さが足りない`);
    }
  }
});

test('足音: 地面ごとに音が違う(同じ音の使い回しがない)', () => {
  const keys = GROUND_KINDS.map((t) => {
    const n = stepSound(t, 'walk').noise;
    return `${n.freq}/${n.q}/${n.dur}`;
  });
  assert.equal(new Set(keys).size, keys.length, '同じ音の地形がある');
});

test('足音: 柔らかい地面は高く長く、硬い地面は低い', () => {
  const w = (t) => stepSound(t, 'walk').noise;
  // 砂と落ち葉は、土や粘土よりずっと高い
  assert.ok(w('desert').freq > w('field').freq * 2, '砂が土より高くない');
  assert.ok(w('forest').freq > w('hill').freq * 2, '落ち葉が丘より高くない');
  // 砂と落ち葉は長く尾を引く
  assert.ok(w('desert').dur > w('mountain').dur, '砂が岩より短い');
  // 体重の音は硬い地面ほど大きい。砂と落ち葉では鳴らさない
  assert.equal(w('desert').thud, undefined);
  assert.equal(stepSound('desert').thud, null);
  assert.equal(stepSound('forest').thud, null);
  assert.ok(stepSound('hill').thud.gain > stepSound('pasture').thud.gain);
});

test('足音: 揺らぎは高さと大きさだけを振る', () => {
  const a = stepSound('field', 'walk', -1);
  const b = stepSound('field', 'walk', 1);
  assert.ok(b.noise.freq > a.noise.freq, '揺らぎで高さが変わらない');
  assert.ok(b.noise.gain > a.noise.gain, '揺らぎで大きさが変わらない');
  assert.equal(a.noise.dur, b.noise.dur, '長さまで変わっている');
  // 行きすぎた値を渡しても壊れない
  for (const v of [-99, 99, NaN]) {
    const s = stepSound('field', 'walk', v);
    assert.ok(Number.isFinite(s.noise.freq) && s.noise.freq > 0, `vary=${v}`);
  }
});

test('足音: 知らない地形・知らない動きでも黙らない', () => {
  const s = stepSound('unknown-terrain', 'unknown-motion');
  assert.ok(s.noise.gain > 0);
  assert.deepEqual(s, stepSound('field', 'walk'));
});

test('足音: 鳴らす口が sfx にある', () => {
  for (const name of ['step', 'splash']) {
    assert.ok(SFX_NAMES.includes(name), `${name} が sfx にない`);
  }
});
