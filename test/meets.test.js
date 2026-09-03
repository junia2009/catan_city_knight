// 島ごとの集まり(src/minigame/meets.js)。
//
// **この表がサーバーとクライアントの唯一の根拠**なので、
// 「受付が立たない島で大会が始められる」食い違いをここで潰す。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MEETS, meetFor, hasMeet } from '../src/minigame/meets.js';
import { MODES } from '../src/progress.js';

test('集まり: 釣り大会は漁師たちの島だけ', () => {
  assert.ok(hasMeet('fish'), '漁師の島に受付が無い');
  for (const mode of MODES.filter((m) => m !== 'fish')) {
    assert.equal(hasMeet(mode), false, `${mode} にも受付が立っている`);
    assert.equal(meetFor(mode), null);
  }
});

test('集まり: 知らない島や壊れた値でも落ちない', () => {
  for (const bad of [null, undefined, '', 'mystery', 0, {}]) {
    assert.equal(hasMeet(bad), false, `${JSON.stringify(bad)} で受付が立った`);
    assert.equal(meetFor(bad), null);
  }
});

test('集まり: 定義がそろっている(島の種類・看板・文言)', () => {
  for (const [mode, m] of Object.entries(MEETS)) {
    assert.ok(MODES.includes(mode), `${mode}: 島の種類として知らないもの`);
    assert.ok(m.id && m.name && m.title && m.hint, `${mode}: 名前や文言が足りない`);
    // 看板は2行。desk.js が [大きい行, 小さい行] で焼き込む
    assert.equal(m.sign.length, 2, `${mode}: 看板が2行でない`);
    for (const line of m.sign) assert.equal(typeof line, 'string');
  }
});
