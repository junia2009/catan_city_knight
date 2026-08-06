// あそびかたデモ(自動再生)の台本を、ブラウザなしで空回しする。
//
// デモは実物のルールエンジンを動かすので、ルールや盤面生成が変わると
// 台本の手が通らなくなる。ここで「全ビートが最後まで実行できること」を
// 保証しておけば、壊れたまま気づかずに配信することがない。

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { RESOURCES } from '../src/state.js';
import { dispatch, validateAction } from '../src/actions.js';
import { COMMODITIES } from '../src/rules/cak/progress-cards.js';
import { DEMO_CHAPTERS, findChapter } from '../src/demo/script.js';
import { buildDemoState, DEMO_PLAYER } from '../src/demo/scenario.js';

function conservation(s, where) {
  for (const r of RESOURCES) {
    const total = s.bank.resources[r] + s.players.reduce((a, p) => a + p.resources[r], 0);
    assert.equal(total, 19, `${where}: ${r}の保存則`);
  }
  if (s.mode !== 'cak') return;
  for (const c of COMMODITIES) {
    const total = s.bank.commodities[c] + s.players.reduce((a, p) => a + p.commodities[c], 0);
    assert.equal(total, 12, `${where}: ${c}の保存則`);
  }
}

// main.js の doAction / refresh と同じ順序でビートを実行する(描画だけ無い)
function dryRun(chapter) {
  let state = buildDemoState(chapter.mode);
  const ui = { mode: 'idle', pending: null, pendingEdges: [], pendingHexes: [], dialog: null };
  let taps = 0;
  let actions = 0;

  chapter.beats.forEach((beat, i) => {
    const where = `${chapter.id}[${i}]`;
    if (beat.prep) beat.prep(state);
    conservation(state, `${where} prep後`);

    const say = typeof beat.say === 'function' ? beat.say(state, ui) : beat.say;
    assert.equal(typeof say, 'string', `${where}: 字幕が文字列でない`);

    if (beat.tap) {
      const target = beat.tap(state, ui);
      const value = target ? Object.values(target)[0] : null;
      assert.ok(value != null, `${where}: タップ先が見つからない`);
      taps++;
    }
    if (beat.ui) Object.assign(ui, beat.ui(state, ui));

    if (beat.action) {
      const action = beat.action(state, ui);
      assert.equal(
        validateAction(state, action), null,
        `${where}: ${action.type} が不正 — ${validateAction(state, action)}`,
      );
      state = dispatch(state, action);
      actions++;
      // 手を出したあとは入力状態を畳む(main.js の resetInputState 相当)
      ui.mode = 'idle';
      ui.pending = null;
      ui.pendingEdges = [];
      ui.pendingHexes = [];
      ui.dialog = null;
    }
    conservation(state, `${where} 実行後`);
  });

  return { state, taps, actions };
}

test('デモ: 章が2つあり、id で引ける', () => {
  assert.equal(DEMO_CHAPTERS.length, 2);
  assert.equal(findChapter('cak').mode, 'cak');
  assert.equal(findChapter('しらない章').id, 'basic'); // 未知の id は先頭にフォールバック
  for (const ch of DEMO_CHAPTERS) {
    assert.ok(ch.beats.length > 10, `${ch.id}: ビートが少なすぎる`);
  }
});

test('デモ 第1章: 全ビートが通り、道・開拓地・都市・交易・盗賊まで見せられる', () => {
  const { state, taps, actions } = dryRun(findChapter('basic'));
  const me = state.players[DEMO_PLAYER];

  assert.ok(taps >= 15, `タップ演出が少ない: ${taps}`);
  assert.ok(actions >= 8, `実際の手が少ない: ${actions}`);
  assert.ok(
    Object.values(state.buildings).some((b) => b.player === DEMO_PLAYER && b.type === 'city'),
    '都市が建っていない',
  );
  assert.ok(me.devCards.length >= 1, '発展カードを買えていない');
  assert.ok(state.log.some((l) => l.includes('盗賊')), '盗賊の演出が出ていない');
});

test('デモ 第2章: 都市改良 → 進歩カード → 騎士 → 蛮族襲来 → 城壁まで通る', () => {
  const { state } = dryRun(findChapter('cak'));
  const me = state.players[DEMO_PLAYER];

  assert.ok(me.improvements.science >= 2, '都市改良が進んでいない');
  assert.ok(me.progressCards.length >= 1, '進歩カードを獲得できていない');
  assert.ok(
    Object.values(state.knights).some((k) => k.player === DEMO_PLAYER),
    '騎士が置かれていない',
  );
  assert.ok(Object.keys(state.walls).length >= 1, '城壁が建っていない');
  assert.ok(state.log.some((l) => l.includes('蛮族襲来')), '蛮族襲来が起きていない');
  // 襲来後は全騎士が不活性に戻る(章の最後で城壁を建てるまでが1手番)
  assert.ok(
    Object.values(state.knights).every((k) => !k.active),
    '襲来後に騎士が不活性へ戻っていない',
  );
});
