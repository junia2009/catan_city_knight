// setHTML は「変わったときだけ書く」番人。
// これが働かないと、受付のパネルが秒10回作り直されて、iOS の実機では
// ボタンが押せなくなる(touchstart と touchend が別の節点になるため)。
// DOM は要らない ── innerHTML を持つだけの箱で押さえられる。

import test from 'node:test';
import assert from 'node:assert/strict';
import { setHTML } from '../src/render/dom.js';

// 書かれた回数を数える箱。innerHTML への代入だけを見る
function box() {
  const o = { writes: 0, html: '' };
  Object.defineProperty(o, 'innerHTML', {
    configurable: true,
    get() { return o.html; },
    set(v) { o.html = v; o.writes += 1; },
  });
  return o;
}

test('同じ文字列なら書き換えない', () => {
  const el = box();
  assert.equal(setHTML(el, '<b>あ</b>'), true);
  assert.equal(setHTML(el, '<b>あ</b>'), false);
  assert.equal(setHTML(el, '<b>あ</b>'), false);
  assert.equal(el.writes, 1, '中身が同じなら代入は1回だけ');
  assert.equal(el.html, '<b>あ</b>');
});

test('変わったら書く', () => {
  const el = box();
  setHTML(el, 'あ');
  setHTML(el, 'い');
  setHTML(el, 'あ');
  assert.equal(el.writes, 3);
  assert.equal(el.html, 'あ');
});

test('空にするのも1回だけ', () => {
  const el = box();
  setHTML(el, 'あ');
  assert.equal(setHTML(el, ''), true);
  assert.equal(setHTML(el, ''), false);
  assert.equal(el.writes, 2);
});

test('覚えるのは要素ごと', () => {
  const a = box();
  const b = box();
  setHTML(a, 'おなじ');
  assert.equal(setHTML(b, 'おなじ'), true, '別の要素はまだ書かれていない');
  assert.equal(b.writes, 1);
});

test('要素が無くても落ちない', () => {
  assert.equal(setHTML(null, 'あ'), false);
  assert.equal(setHTML(undefined, 'あ'), false);
});

test('読み返しではなく、書いた文字列を覚えている', () => {
  // ブラウザは innerHTML を読み返すと書き方を直して返す。読み返しで
  // 比べていると毎回「変わった」になり、番人として働かない。
  const el = box();
  Object.defineProperty(el, 'innerHTML', {
    configurable: true,
    get() { return `<b class="x">${el.html}</b>`; },   // 読むと別物が返る
    set(v) { el.html = v; el.writes += 1; },
  });
  setHTML(el, 'あ');
  setHTML(el, 'あ');
  assert.equal(el.writes, 1);
});
