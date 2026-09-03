// 島ごとの集まり(src/minigame/meets.js)。
//
// **この表がサーバーとクライアントの唯一の根拠**なので、
// 「受付が立たない島で大会が始められる」食い違いをここで潰す。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MEETS, meetFor, hasMeet } from '../src/minigame/meets.js';
import { MODES } from '../src/progress.js';

// 島と遊びは1対1。片方の島の受付でもう片方が始まると、看板と中身が食い違う。
test('集まり: 島ごとに開かれるものが決まっている', () => {
  const expected = { fish: 'fishing', dragon: 'dragonhunt' };
  for (const mode of MODES) {
    const want = expected[mode] ?? null;
    if (want) {
      assert.ok(hasMeet(mode), `${mode} の島に受付が無い`);
      assert.equal(meetFor(mode).id, want, `${mode} の中身が違う`);
    } else {
      assert.equal(hasMeet(mode), false, `${mode} にも受付が立っている`);
      assert.equal(meetFor(mode), null);
    }
  }
});

// 表の id と、サーバーの進行(server/*.js)が食い違うと、受付は立つのに
// 何も始まらない島ができる。
test('集まり: 表の id にサーバーの進行がある', async () => {
  const { FishingContest } = await import('../server/fishing-contest.js');
  const { DragonHunt } = await import('../server/dragon-hunt.js');
  const engines = { fishing: FishingContest, dragonhunt: DragonHunt };
  for (const m of Object.values(MEETS)) {
    assert.ok(engines[m.id], `${m.id}: 進行が無い`);
    assert.equal(new engines[m.id]().kind, m.id, `${m.id}: kind が表と違う`);
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
