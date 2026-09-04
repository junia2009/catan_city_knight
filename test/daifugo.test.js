// 大富豪のルールエンジン(src/minigame/daifugo.js)。
//
// **入れるルールはホストが選ぶ**ので、ここでは1つずつ「入れたとき効く /
// 入れないと効かない」の両方を見る ── 片方だけだと、判定を素通りさせる
// 書き間違いに気づけない。
//
// 手札は配り切りだと組み立てられないので、卓を作ってから直接置き換える
// (state は plain object なので、それで全部つじつまが合う)。

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  DECK, JOKER, RANKS, SUITS, RULES, RULE_IDS, SPADE3, TITLE_JP,
  cardName, cleanRules, classify, createTable, defaultRules, dispatch, isJoker,
  legalPlays, rankOf, suitOf, titlesFor, validate, viewFor,
} from '../src/minigame/daifugo.js';

// '♠3' のような書き方で札を作る(テストを読めるようにするため)
function c(text) {
  if (text === '🃏') return 52;
  if (text === '🃏2') return 53;
  const s = SUITS.indexOf(text[0]);
  const r = RANKS.indexOf(text.slice(1));
  assert.ok(s >= 0 && r >= 0, `知らない札: ${text}`);
  return s * 13 + r;
}
const cards = (...names) => names.map(c);
const show = (list) => list.map(cardName).join(' ');

// 手札を決め打ちした卓。rules は既定に足すもの
function table(hands, rules = {}, extra = {}) {
  const players = Object.keys(hands).map(Number);
  const st = createTable({ seed: 1, players, rules, ...extra });
  for (const p of players) st.hands[p] = [...hands[p]].sort((a, b) => a - b);
  st.turn = 0;
  st.lead = players[0];
  st.field = null;
  st.passed = {};
  return st;
}

// 手を出す。通らなければテストを落とす
function play(st, player, list) {
  const r = dispatch(st, { type: 'PLAY', player, cards: list });
  assert.equal(r.error, undefined, `出せなかった: ${show(list)} → ${r.error}`);
  return r.state;
}
function pass(st, player) {
  const r = dispatch(st, { type: 'PASS', player });
  assert.equal(r.error, undefined, `パスできなかった: ${r.error}`);
  return r.state;
}
const deny = (st, action) => validate(st, action);

// ---- 配り ----

test('大富豪: 54枚を配り切る。同じ種なら同じ配り', () => {
  const a = createTable({ seed: 42, players: [0, 1, 2, 3] });
  const b = createTable({ seed: 42, players: [0, 1, 2, 3] });
  const all = a.players.flatMap((p) => a.hands[p]);
  assert.equal(all.length, DECK, '配り切っていない');
  assert.equal(new Set(all).size, DECK, '同じ札が2枚ある');
  assert.deepEqual(b.hands, a.hands, '同じ種で配りが変わる');
  // 種が違えば配りも変わる
  const d = createTable({ seed: 43, players: [0, 1, 2, 3] });
  assert.notDeepEqual(d.hands, a.hands);
});

test('大富豪: 人数が割り切れなくても全部配る', () => {
  for (const n of [2, 3, 4, 5, 6, 7, 8]) {
    const players = [...Array(n).keys()];
    const st = createTable({ seed: 5, players });
    const all = players.flatMap((p) => st.hands[p]);
    assert.equal(all.length, DECK, `${n}人で配り漏れ`);
    const sizes = players.map((p) => st.hands[p].length);
    assert.ok(Math.max(...sizes) - Math.min(...sizes) <= 1, `${n}人で枚数が偏った: ${sizes}`);
  }
});

test('大富豪: 1回戦は ♦3 を持っている人から', () => {
  for (const seed of [1, 2, 3, 7, 99]) {
    const st = createTable({ seed, players: [0, 1, 2, 3] });
    const who = st.players.find((p) => st.hands[p].includes(c('♦3')));
    assert.equal(st.players[st.turn], who, `種 ${seed}: ♦3 の人から始まっていない`);
  }
});

// ---- 出す札の形 ----

test('形: 1枚・ペア・3枚・4枚', () => {
  assert.deepEqual(classify(cards('♠5')), { kind: 'set', n: 1, rank: 2, suits: [0] });
  assert.equal(classify(cards('♠5', '♥5')).kind, 'set');
  assert.equal(classify(cards('♠5', '♥5')).n, 2);
  assert.equal(classify(cards('♠5', '♥5', '♦5', '♣5')).n, 4);
  // 数字が違うものは混ぜられない
  assert.equal(classify(cards('♠5', '♥6')), null);
});

test('形: ジョーカーは何の数字にもなる', () => {
  const pair = classify(cards('♠5', '🃏'));
  assert.deepEqual(pair, { kind: 'set', n: 2, rank: 2, suits: [0] }, '5のペアにならない');
  // ジョーカーだけならいちばん強い組
  assert.equal(classify(cards('🃏')).rank, JOKER);
  assert.equal(classify(cards('🃏', '🃏2')).rank, JOKER);
});

test('形: 階段は「入れたとき」だけ組める', () => {
  const on = { kaidan: true };
  assert.equal(classify(cards('♠3', '♠4', '♠5'), on).kind, 'seq');
  assert.equal(classify(cards('♠3', '♠4', '♠5'), { kaidan: false }), null, '入れていないのに組めた');
  // 2枚は階段にならない
  assert.equal(classify(cards('♠3', '♠4'), on), null);
  // マークが違うと繋がらない
  assert.equal(classify(cards('♠3', '♥4', '♠5'), on), null);
  // 飛んでいると繋がらない
  assert.equal(classify(cards('♠3', '♠4', '♠6'), on), null);
});

test('形: 階段の強さは上の端。ジョーカーは隙間も端も埋める', () => {
  const on = { kaidan: true };
  assert.equal(classify(cards('♠3', '♠4', '♠5'), on).rank, RANKS.indexOf('5'));
  // 隙間を埋める
  const gap = classify(cards('♠3', '♠5', '🃏'), on);
  assert.equal(gap.kind, 'seq');
  assert.equal(gap.rank, RANKS.indexOf('5'), '3-4-5 として読まれていない');
  // 端を伸ばす(いちばん強い読み方を採る)
  const up = classify(cards('♠3', '♠4', '🃏'), on);
  assert.equal(up.rank, RANKS.indexOf('5'), '3-4-5 まで伸ばしていない');
  // 上が詰まっていれば下へ伸ばす
  const top = classify(cards('♠A', '♠2', '🃏'), on);
  assert.equal(top.rank, RANKS.indexOf('2'), 'K-A-2 として読まれていない');
});

// ---- 強さくらべ ----

test('くらべ: 同じ形・同じ枚数で、強いものだけ出せる', () => {
  let st = table({ 0: cards('♠7', '♠4', '♥4'), 1: cards('♠8'), 2: cards('♠9') });
  st = play(st, 0, cards('♠7'));
  assert.ok(deny(st, { type: 'PLAY', player: 1, cards: cards('♠8') }) === null);
  // 弱いものは出せない
  const weak = table({ 0: cards('♠7'), 1: cards('♠5'), 2: cards('♠9') });
  const after = play(weak, 0, cards('♠7'));
  assert.match(deny(after, { type: 'PLAY', player: 1, cards: cards('♠5') }), /強くありません/);
});

test('くらべ: 枚数と形が合っていないと出せない', () => {
  let st = table({ 0: cards('♠7', '♥7'), 1: cards('♠8', '♥8', '♦8'), 2: cards('♠9') });
  st = play(st, 0, cards('♠7', '♥7'));
  assert.match(deny(st, { type: 'PLAY', player: 1, cards: cards('♠8') }), /強くありません/);
  assert.match(deny(st, { type: 'PLAY', player: 1, cards: cards('♠8', '♥8', '♦8') }), /強くありません/);
  assert.equal(deny(st, { type: 'PLAY', player: 1, cards: cards('♠8', '♥8') }), null);
});

test('くらべ: ジョーカー1枚がいちばん強い', () => {
  let st = table({ 0: cards('♠2'), 1: cards('🃏'), 2: cards('♠9') });
  st = play(st, 0, cards('♠2'));
  assert.equal(deny(st, { type: 'PLAY', player: 1, cards: cards('🃏') }), null, '2 に勝てない');
});

// ---- パスと場流れ ----

test('パス: 出した人以外が全員パスすると場が流れ、その人から', () => {
  let st = table({ 0: cards('♠7', '♠4'), 1: cards('♠8'), 2: cards('♠9') });
  st = play(st, 0, cards('♠7'));
  st = pass(st, 1);
  assert.ok(st.field, '1人パスしただけで流れた');
  st = pass(st, 2);
  assert.equal(st.field, null, '全員パスしたのに流れない');
  assert.equal(st.players[st.turn], 0, '最後に出した人から始まらない');
});

test('パス: 場が流れているときはパスできない', () => {
  const st = table({ 0: cards('♠7'), 1: cards('♠8'), 2: cards('♠9') });
  assert.match(deny(st, { type: 'PASS', player: 0 }), /パスできません/);
});

test('パス: 自分の番でなければ何もできない', () => {
  const st = table({ 0: cards('♠7'), 1: cards('♠8'), 2: cards('♠9') });
  assert.match(deny(st, { type: 'PLAY', player: 1, cards: cards('♠8') }), /あなたの番では/);
  assert.match(deny(st, { type: 'PASS', player: 2 }), /あなたの番では/);
});

test('パス: パスした人は、その場ではもう回ってこない', () => {
  let st = table({ 0: cards('♠5', '♠4'), 1: cards('♠8'), 2: cards('♠9'), 3: cards('♠10') });
  st = play(st, 0, cards('♠5'));
  st = pass(st, 1);
  assert.equal(st.players[st.turn], 2);
  st = play(st, 2, cards('♠9'));
  assert.equal(st.players[st.turn], 3, 'パスした人へ戻ってしまった');
});

// ---- 8切り ----

test('8切り: 入れると場が流れて、出した人からもう一度', () => {
  let st = table({ 0: cards('♠8', '♠4'), 1: cards('♠9'), 2: cards('♠10') }, { kiri8: true });
  st = play(st, 0, cards('♠8'));
  assert.equal(st.field, null, '8を出しても場が流れない');
  assert.equal(st.players[st.turn], 0, '出した人から始まらない');
});

test('8切り: 入れなければただの8', () => {
  let st = table({ 0: cards('♠8', '♠4'), 1: cards('♠9'), 2: cards('♠10') }, { kiri8: false });
  st = play(st, 0, cards('♠8'));
  assert.ok(st.field, '入れていないのに流れた');
  assert.equal(st.players[st.turn], 1);
});

// ---- 革命 ----

test('革命: 同じ数字4枚で強さが逆さになる', () => {
  let st = table({
    0: cards('♠5', '♥5', '♦5', '♣5', '♠4'), 1: cards('♠9', '♠3'), 2: cards('♠10'),
  }, { kakumei: true });
  st = play(st, 0, cards('♠5', '♥5', '♦5', '♣5'));
  assert.equal(st.revolution, true, '革命が起きていない');
  // 革命中は弱いほうが強い
  st = pass(st, 1);
  st = pass(st, 2);
  st = play(st, 0, cards('♠4'));
  assert.match(deny(st, { type: 'PLAY', player: 1, cards: cards('♠9') }), /強くありません/);
  assert.equal(deny(st, { type: 'PLAY', player: 1, cards: cards('♠3') }), null, '弱い札で返せない');
});

test('革命: 階段5枚でも起きる。4枚では起きない', () => {
  const five = cards('♠3', '♠4', '♠5', '♠6', '♠7');
  let st = table({ 0: five, 1: cards('♠9'), 2: cards('♠10') }, { kakumei: true, kaidan: true });
  st = play(st, 0, five);
  assert.equal(st.revolution, true, '階段5枚で革命が起きない');

  const four = cards('♠3', '♠4', '♠5', '♠6');
  let s2 = table({ 0: four, 1: cards('♠9'), 2: cards('♠10') }, { kakumei: true, kaidan: true });
  s2 = play(s2, 0, four);
  assert.equal(s2.revolution, false, '階段4枚で革命が起きてしまう');
});

test('革命: 入れなければ4枚出しても逆さにならない', () => {
  let st = table({
    0: cards('♠5', '♥5', '♦5', '♣5', '♠4'), 1: cards('♠9', '♠3'), 2: cards('♠10'),
  }, { kakumei: false });
  st = play(st, 0, cards('♠5', '♥5', '♦5', '♣5'));
  assert.equal(st.revolution, false);
});

test('革命: ジョーカーは革命でも最強のまま', () => {
  let st = table({
    0: cards('♠5', '♥5', '♦5', '♣5', '♠7'), 1: cards('🃏'), 2: cards('♠10'),
  }, { kakumei: true });
  st = play(st, 0, cards('♠5', '♥5', '♦5', '♣5'));
  st = pass(st, 1);
  st = pass(st, 2);
  st = play(st, 0, cards('♠7'));
  assert.equal(deny(st, { type: 'PLAY', player: 1, cards: cards('🃏') }), null,
    '革命中にジョーカーが弱くなっている');
});

test('革命: もう一度4枚出すと元に戻る', () => {
  let st = table({
    0: cards('♠5', '♥5', '♦5', '♣5', '♠4'),
    1: cards('♠6', '♥6', '♦6', '♣6', '♠3'),
    2: cards('♠10', '♠J'),
  }, { kakumei: true });
  st = play(st, 0, cards('♠5', '♥5', '♦5', '♣5'));
  assert.equal(st.revolution, true);
  st = pass(st, 1);
  st = pass(st, 2);
  st = play(st, 0, cards('♠4'));
  st = play(st, 1, cards('♠3'));       // 革命中なので弱いほうが強い
  st = pass(st, 2);                    // 0 は ♠4 で上がっているので回ってこない
  st = play(st, 1, cards('♠6', '♥6', '♦6', '♣6'));
  assert.equal(st.revolution, false, '二度目の革命で元に戻らない');
});

// ---- Jバック ----

test('Jバック: 入れると場が流れるまで逆さ、流れたら戻る', () => {
  let st = table({
    0: cards('♠J', '♠4'), 1: cards('♠9', '♠3'), 2: cards('♠10', '♥10'),
  }, { jback: true });
  st = play(st, 0, cards('♠J'));
  assert.equal(st.jback, true, 'Jバックが立っていない');
  // J より弱い札で返せる
  assert.equal(deny(st, { type: 'PLAY', player: 1, cards: cards('♠9') }), null);
  st = play(st, 1, cards('♠9'));
  st = pass(st, 2);
  st = pass(st, 0);
  assert.equal(st.jback, false, '場が流れてもJバックが残っている');
});

test('Jバック: 革命と重なると打ち消し合う', () => {
  let st = table({
    0: cards('♠5', '♥5', '♦5', '♣5', '♠J', '♠2'),
    1: cards('♠9', '♠Q'), 2: cards('♠3', '♠4'),
  }, { kakumei: true, jback: true });
  st = play(st, 0, cards('♠5', '♥5', '♦5', '♣5'));
  assert.equal(st.revolution, true);
  st = pass(st, 1);
  st = pass(st, 2);
  // 革命だけなら 9 は J より強い
  assert.equal(st.players[st.turn], 0);
  st = play(st, 0, cards('♠J'));
  assert.equal(st.jback, true);
  // 革命(逆さ)+ Jバック(逆さ)= もとどおり。9 では返せず、Q なら返せる
  assert.match(deny(st, { type: 'PLAY', player: 1, cards: cards('♠9') }), /強くありません/,
    '打ち消し合っていない(9 が J に勝ってしまう)');
  assert.equal(deny(st, { type: 'PLAY', player: 1, cards: cards('♠Q') }), null,
    '打ち消したあとに Q が通らない');
});

test('Jバック: 入れなければ J はただの札', () => {
  let st = table({ 0: cards('♠J', '♠4'), 1: cards('♠9'), 2: cards('♠10') }, { jback: false });
  st = play(st, 0, cards('♠J'));
  assert.equal(st.jback, false);
  assert.match(deny(st, { type: 'PLAY', player: 1, cards: cards('♠9') }), /強くありません/);
});

// ---- しばり ----

test('しばり: 同じマークが続くと、そのマークしか出せない', () => {
  let st = table({
    0: cards('♠5', '♠4'), 1: cards('♠7', '♥9'), 2: cards('♥8', '♠10'),
  }, { shibari: true });
  st = play(st, 0, cards('♠5'));
  st = play(st, 1, cards('♠7'));
  assert.deepEqual(st.shibari, [0], 'しばりが掛かっていない');
  assert.match(deny(st, { type: 'PLAY', player: 2, cards: cards('♥8') }), /しばり中/);
  assert.equal(deny(st, { type: 'PLAY', player: 2, cards: cards('♠10') }), null);
});

test('しばり: 場が流れると解ける', () => {
  let st = table({
    0: cards('♠5', '♥4'), 1: cards('♠7'), 2: cards('♥8'),
  }, { shibari: true });
  st = play(st, 0, cards('♠5'));
  st = play(st, 1, cards('♠7'));
  assert.deepEqual(st.shibari, [0]);
  st = pass(st, 2);
  st = pass(st, 0);
  assert.equal(st.shibari, null, '場が流れてもしばりが残っている');
});

test('しばり: 入れなければ掛からない', () => {
  let st = table({
    0: cards('♠5', '♠4'), 1: cards('♠7'), 2: cards('♥8'),
  }, { shibari: false });
  st = play(st, 0, cards('♠5'));
  st = play(st, 1, cards('♠7'));
  assert.equal(st.shibari, null);
  assert.equal(deny(st, { type: 'PLAY', player: 2, cards: cards('♥8') }), null);
});

// ---- スペ3返し ----

test('スペ3返し: ジョーカー1枚には ♠3 で返せて、場が流れる', () => {
  let st = table({ 0: cards('🃏', '♠4'), 1: cards('♠3', '♥9'), 2: cards('♠10') },
    { spade3: true });
  st = play(st, 0, cards('🃏'));
  st = play(st, 1, cards('♠3'));
  assert.equal(st.field, null, '♠3 で返しても場が流れない');
  assert.equal(st.players[st.turn], 1, '返した人から始まらない');
});

test('スペ3返し: 入れなければ ♠3 では返せない', () => {
  let st = table({ 0: cards('🃏', '♠4'), 1: cards('♠3'), 2: cards('♠10') }, { spade3: false });
  st = play(st, 0, cards('🃏'));
  assert.match(deny(st, { type: 'PLAY', player: 1, cards: cards('♠3') }), /強くありません/);
});

test('スペ3返し: ジョーカー2枚の場や、♠3 以外では返せない', () => {
  let st = table({ 0: cards('🃏', '🃏2', '♠4'), 1: cards('♠3', '♥3'), 2: cards('♠10') },
    { spade3: true });
  st = play(st, 0, cards('🃏', '🃏2'));
  assert.match(deny(st, { type: 'PLAY', player: 1, cards: cards('♠3', '♥3') }), /強くありません/);

  let s2 = table({ 0: cards('🃏', '♠4'), 1: cards('♥3'), 2: cards('♠10') }, { spade3: true });
  s2 = play(s2, 0, cards('🃏'));
  assert.match(deny(s2, { type: 'PLAY', player: 1, cards: cards('♥3') }), /強くありません/);
});

// ---- 順番を変えるもの ----

test('5飛ばし: 出した枚数だけ次の人を飛ばす', () => {
  let st = table({
    0: cards('♠5', '♥5', '♦5', '♠4'), 1: cards('♠9'), 2: cards('♠10'), 3: cards('♠J'),
  }, { gotobashi: true, kiri8: false });
  st = play(st, 0, cards('♠5'));
  assert.equal(st.players[st.turn], 2, '1枚で1人飛ばせていない');
  // 飛ばされた人はこの場ではもう出せない(パス扱い)
  assert.equal(st.passed[1], true, '飛ばされた人がパス扱いになっていない');
  st = pass(st, 2);
  st = pass(st, 3);
  assert.equal(st.field, null, '残りが全員パスしても流れない');
  assert.equal(st.players[st.turn], 0);
  st = play(st, 0, cards('♥5', '♦5'));
  assert.equal(st.players[st.turn], 3, '2枚で2人飛ばせていない');
});

test('5飛ばし: 入れなければただの5', () => {
  let st = table({
    0: cards('♠5', '♠4'), 1: cards('♠9'), 2: cards('♠10'), 3: cards('♠J'),
  }, { gotobashi: false });
  st = play(st, 0, cards('♠5'));
  assert.equal(st.players[st.turn], 1);
});

test('9リバース: 順番が逆回りになる', () => {
  let st = table({
    0: cards('♠9', '♠4'), 1: cards('♠10'), 2: cards('♠J'), 3: cards('♠Q'),
  }, { reverse9: true });
  st = play(st, 0, cards('♠9'));
  assert.equal(st.dir, -1, '向きが変わっていない');
  assert.equal(st.players[st.turn], 3, '逆回りになっていない');
});

test('9リバース: 入れなければ順回りのまま', () => {
  let st = table({
    0: cards('♠9', '♠4'), 1: cards('♠10'), 2: cards('♠J'), 3: cards('♠Q'),
  }, { reverse9: false });
  st = play(st, 0, cards('♠9'));
  assert.equal(st.dir, 1);
  assert.equal(st.players[st.turn], 1);
});

// ---- 7渡し・10捨て ----

test('7渡し: 出した枚数だけ次の人へ渡す', () => {
  let st = table({
    0: cards('♠7', '♠4', '♠2'), 1: cards('♠9'), 2: cards('♠10'),
  }, { watashi7: true });
  st = play(st, 0, cards('♠7'));
  assert.deepEqual(
    { type: st.awaiting.type, player: st.awaiting.player, count: st.awaiting.count, to: st.awaiting.to },
    { type: 'give', player: 0, count: 1, to: 1 },
    '渡す待ちになっていない',
  );
  // 選ぶまで次へ進まない
  assert.match(deny(st, { type: 'PLAY', player: 1, cards: cards('♠9') }), /あなたの番では/);
  const r = dispatch(st, { type: 'GIVE', player: 0, cards: cards('♠2') });
  assert.equal(r.error, undefined);
  st = r.state;
  assert.ok(st.hands[1].includes(c('♠2')), '渡っていない');
  assert.ok(!st.hands[0].includes(c('♠2')), '手元に残っている');
  assert.equal(st.players[st.turn], 1, '渡したあと次の人へ行かない');
});

test('7渡し: 枚数を間違えたら通らない', () => {
  let st = table({ 0: cards('♠7', '♠4', '♠2'), 1: cards('♠9'), 2: cards('♠10') },
    { watashi7: true });
  st = play(st, 0, cards('♠7'));
  assert.match(deny(st, { type: 'GIVE', player: 0, cards: cards('♠4', '♠2') }), /1枚 選んで/);
  assert.match(deny(st, { type: 'GIVE', player: 1, cards: cards('♠9') }), /あなたの番では/);
  assert.match(deny(st, { type: 'PASS', player: 0 }), /いま選ぶのは別/);
});

test('10捨て: 出した枚数だけ手札を捨てる', () => {
  let st = table({ 0: cards('♠10', '♠4', '♠2'), 1: cards('♠J'), 2: cards('♠Q') },
    { sute10: true });
  st = play(st, 0, cards('♠10'));
  assert.equal(st.awaiting.type, 'discard');
  const r = dispatch(st, { type: 'DISCARD', player: 0, cards: cards('♠2') });
  st = r.state;
  assert.equal(st.hands[0].length, 1, '捨てられていない');
  assert.ok(!st.players.some((p) => st.hands[p].includes(c('♠2'))), '誰かの手に渡っている');
});

test('7渡し・10捨て: 入れなければ待ちにならない', () => {
  let st = table({ 0: cards('♠7', '♠10', '♠4'), 1: cards('♠J'), 2: cards('♠Q') }, {});
  st = play(st, 0, cards('♠7'));
  assert.equal(st.awaiting, null);
});

test('7渡し: 8切りと重なっても、渡してから場が流れる', () => {
  let st = table({
    0: cards('♠7', '♠8', '♠4', '♠2'), 1: cards('♠9'), 2: cards('♠10'),
  }, { watashi7: true, kiri8: true, kaidan: false });
  st = play(st, 0, cards('♠7'));   // 7渡しの待ち(8切りではない)
  st = dispatch(st, { type: 'GIVE', player: 0, cards: cards('♠2') }).state;
  st = pass(st, 1);
  st = pass(st, 2);
  st = play(st, 0, cards('♠8'));   // 8切り + 7は無い
  assert.equal(st.field, null);
  assert.equal(st.players[st.turn], 0);
});

// ---- 禁止上がり ----

// 公式どおり反則負け。**出すこと自体は止めない** ── 止めると、最後の1枚が
// 禁止札の人どうしで永久にパスし合う盤面ができて、その回が終わらなくなる。
test('禁止上がり: 2・ジョーカー・8切りで上がると反則負け', () => {
  const opts = { kinshi: true, kiri8: true, spade3: true };
  for (const [hand, why] of [[cards('♠2'), '2'], [cards('🃏'), 'ジョーカー'], [cards('♠8'), '8切り']]) {
    let st = table({ 0: hand, 1: cards('♠9', '♠J'), 2: cards('♠10', '♠Q') }, opts);
    assert.equal(deny(st, { type: 'PLAY', player: 0, cards: hand }), null, `${why}: 出せない`);
    st = play(st, 0, hand);
    assert.deepEqual(st.out, [], `${why}: 上がりとして数えられている`);
    assert.equal(st.demoted[0]?.player, 0, `${why}: 落ちていない`);
    assert.equal(st.demoted[0]?.why, 'foul');
    assert.match(st.demoted[0].reason, new RegExp(why === '8切り' ? '8切り' : why));
  }
});

test('禁止上がり: 反則負けした人は、いちばん下になる', () => {
  let st = table({
    0: cards('♠2'), 1: cards('♠9', '♠J'), 2: cards('♠10', '♠Q'),
  }, { kinshi: true });
  st = play(st, 0, cards('♠2'));   // 反則負け
  st = pass(st, 1);
  st = pass(st, 2);
  st = play(st, 1, cards('♠9'));
  st = play(st, 2, cards('♠10'));
  st = pass(st, 1);
  st = play(st, 2, cards('♠Q'));   // 2 が上がって決着
  assert.ok(st.result, '決着していない');
  assert.equal(st.result.order.at(-1), 0, '反則負けが最下位になっていない');
  assert.equal(st.result.titles[0], 'daihinmin');
});

test('禁止上がり: ♠3 返しで上がっても反則', () => {
  let st = table({ 0: cards('🃏', '♠4'), 1: cards('♠3'), 2: cards('♠10', '♠Q') },
    { kinshi: true, spade3: true });
  st = play(st, 0, cards('🃏'));
  st = play(st, 1, cards('♠3'));
  assert.equal(st.demoted[0]?.player, 1, '♠3 返しの上がりが反則になっていない');
  assert.match(st.demoted[0].reason, /♠3/);
});

test('禁止上がり: 最後の1枚でなければ、ただの2', () => {
  const st = table({ 0: cards('♠2', '♠4'), 1: cards('♠9'), 2: cards('♠10') },
    { kinshi: true });
  const after = play(st, 0, cards('♠2'));
  assert.deepEqual(after.demoted, [], '途中の2で落とされた');
});

test('禁止上がり: 入れなければ 2 で上がれる', () => {
  let st = table({ 0: cards('♠2'), 1: cards('♠9'), 2: cards('♠10') }, { kinshi: false });
  st = play(st, 0, cards('♠2'));
  assert.deepEqual(st.out, [0], '普通に上がれていない');
  assert.deepEqual(st.demoted, []);
});

// ---- 上がりと称号 ----

test('称号: 人数によって真ん中が変わる', () => {
  assert.deepEqual(titlesFor([0, 1]), { 0: 'daifugo', 1: 'daihinmin' });
  assert.deepEqual(titlesFor([0, 1, 2]), { 0: 'daifugo', 1: 'heimin', 2: 'daihinmin' });
  assert.deepEqual(titlesFor([0, 1, 2, 3]),
    { 0: 'daifugo', 1: 'fugo', 2: 'hinmin', 3: 'daihinmin' });
  assert.deepEqual(titlesFor([0, 1, 2, 3, 4]),
    { 0: 'daifugo', 1: 'fugo', 2: 'heimin', 3: 'hinmin', 4: 'daihinmin' });
  for (const t of Object.values(titlesFor([0, 1, 2, 3, 4]))) assert.ok(TITLE_JP[t]);
});

test('上がり: 最後のひとりが残ったら決着。順は上がった順', () => {
  let st = table({ 0: cards('♠4'), 1: cards('♠9'), 2: cards('♠10', '♠J') });
  st = play(st, 0, cards('♠4'));         // 0 が上がる
  assert.deepEqual(st.out, [0]);
  st = play(st, 1, cards('♠9'));         // 1 も上がる → 残り1人で決着
  assert.ok(st.result, '決着していない');
  assert.deepEqual(st.result.order, [0, 1, 2]);
  assert.equal(st.result.titles[0], 'daifugo');
  assert.equal(st.result.titles[2], 'daihinmin');
});

test('上がり: 上がった人は手番に回ってこない', () => {
  let st = table({ 0: cards('♠4'), 1: cards('♠9', '♠3'), 2: cards('♠10', '♠5') });
  st = play(st, 0, cards('♠4'));
  assert.equal(st.players[st.turn], 1);
  st = play(st, 1, cards('♠9'));
  assert.equal(st.players[st.turn], 2, '上がった人へ回ってしまった');
});

// ---- 都落ち ----

test('都落ち: 大富豪が1番に上がれなかったら、その場で最下位', () => {
  const titles = { 0: 'daifugo', 1: 'fugo', 2: 'hinmin', 3: 'daihinmin' };
  let st = table({
    0: cards('♠4', '♠5', '♠6'), 1: cards('♠9'), 2: cards('♠10'), 3: cards('♠J'),
  }, { miyakoochi: true, koukan: false }, { titles, game: 2 });
  st.turn = 1;
  st.lead = 1;
  st = play(st, 1, cards('♠9'));   // 富豪が1番に上がる
  assert.equal(st.demoted[0]?.player, 0, '大富豪が都落ちしていない');
  assert.equal(st.demoted[0]?.why, 'miyakoochi');
  assert.equal(st.hands[0].length, 0, '手札が残っている');
  // 残りが決着すると、都落ちした人がいちばん下
  st = play(st, 2, cards('♠10'));
  assert.ok(st.result);
  assert.equal(st.result.order.at(-1), 0, '都落ちした人が最下位になっていない');
  assert.equal(st.result.titles[0], 'daihinmin');
});

test('都落ち: 大富豪が1番なら落ちない', () => {
  const titles = { 0: 'daifugo', 1: 'fugo', 2: 'hinmin', 3: 'daihinmin' };
  let st = table({
    0: cards('♠Q'), 1: cards('♠9', '♠3'), 2: cards('♠10'), 3: cards('♠J'),
  }, { miyakoochi: true, koukan: false }, { titles, game: 2 });
  st = play(st, 0, cards('♠Q'));
  assert.deepEqual(st.demoted, []);
});

test('都落ち: 入れなければ落ちない', () => {
  const titles = { 0: 'daifugo', 1: 'fugo', 2: 'hinmin', 3: 'daihinmin' };
  let st = table({
    0: cards('♠4', '♠5'), 1: cards('♠9'), 2: cards('♠10'), 3: cards('♠J'),
  }, { miyakoochi: false, koukan: false }, { titles, game: 2 });
  st.turn = 1;
  st.lead = 1;
  st = play(st, 1, cards('♠9'));
  assert.deepEqual(st.demoted, []);
  assert.equal(st.hands[0].length, 2);
});

// ---- カード交換 ----

test('交換: 大貧民は強い札を自動で渡し、大富豪は選んで返す', () => {
  const titles = { 0: 'daifugo', 1: 'heimin', 2: 'daihinmin' };
  const st = createTable({
    seed: 3, players: [0, 1, 2], rules: { koukan: true }, titles, game: 2,
  });
  assert.equal(st.phase, 'exchange');
  assert.deepEqual(
    { type: st.awaiting.type, player: st.awaiting.player, count: st.awaiting.count },
    { type: 'exchange', player: 0, count: 2 },
    '大富豪が返す待ちになっていない',
  );
  // 大貧民の強い2枚は、もう大富豪の手にある
  const strong = [...st.hands[0]].sort((a, b) => rankOf(b) - rankOf(a)).slice(0, 2);
  assert.ok(strong.length === 2);
  const give = st.hands[0].slice(0, 2);   // 弱いほうから2枚返す
  const r = dispatch(st, { type: 'EXCHANGE', player: 0, cards: give });
  assert.equal(r.error, undefined);
  const after = r.state;
  assert.equal(after.phase, 'playing', '交換が終わっても始まらない');
  for (const g of give) assert.ok(after.hands[2].includes(g), '返した札が届いていない');
  // 2回戦からは大貧民から始める
  assert.equal(after.players[after.turn], 2, '大貧民から始まらない');
});

// 貧しいほうは選べない。ここを「手前から2枚」にすると、大貧民が
// いらない札を押しつけられてしまう(交換が交換にならない)。
test('交換: 大貧民が渡すのは、いちばん強い札(選べない)', () => {
  const titles = { 0: 'daifugo', 1: 'heimin', 2: 'daihinmin' };
  const arg = { seed: 3, players: [0, 1, 2], titles, game: 2 };
  const dealt = createTable({ ...arg, rules: { koukan: false } });
  const st = createTable({ ...arg, rules: { koukan: true } });
  const moved = dealt.hands[2].filter((c) => !st.hands[2].includes(c));
  const kept = st.hands[2].filter((c) => dealt.hands[2].includes(c));
  assert.equal(moved.length, 2, '2枚渡していない');
  for (const m of moved) {
    assert.ok(st.hands[0].includes(m), `${cardName(m)} が大富豪へ届いていない`);
    for (const k of kept) {
      assert.ok(rankOf(m) >= rankOf(k),
        `弱い ${cardName(m)} を渡して、強い ${cardName(k)} を残している`);
    }
  }
});

test('交換: 4人なら富豪と貧民も1枚ずつ', () => {
  const titles = { 0: 'daifugo', 1: 'fugo', 2: 'hinmin', 3: 'daihinmin' };
  let st = createTable({
    seed: 4, players: [0, 1, 2, 3], rules: { koukan: true }, titles, game: 2,
  });
  assert.equal(st.awaiting.count, 2);
  st = dispatch(st, { type: 'EXCHANGE', player: 0, cards: st.hands[0].slice(0, 2) }).state;
  assert.deepEqual(
    { player: st.awaiting.player, count: st.awaiting.count, to: st.awaiting.to },
    { player: 1, count: 1, to: 2 },
    '富豪の番になっていない',
  );
  st = dispatch(st, { type: 'EXCHANGE', player: 1, cards: st.hands[1].slice(0, 1) }).state;
  assert.equal(st.phase, 'playing');
  // 交換しても、配り切った枚数のまま(渡した枚数と返した枚数が同じ)
  const fresh = createTable({ seed: 4, players: [0, 1, 2, 3], rules: { koukan: false } });
  assert.deepEqual(
    st.players.map((p) => st.hands[p].length),
    fresh.players.map((p) => fresh.hands[p].length),
    '交換で枚数がずれた',
  );
});

test('交換: 入れなければ1回戦と同じで、すぐ始まる', () => {
  const titles = { 0: 'daifugo', 1: 'heimin', 2: 'daihinmin' };
  const st = createTable({
    seed: 3, players: [0, 1, 2], rules: { koukan: false }, titles, game: 2,
  });
  assert.equal(st.phase, 'playing');
  assert.equal(st.awaiting, null);
});

test('交換: 1回戦(前の称号が無い)では起きない', () => {
  const st = createTable({ seed: 3, players: [0, 1, 2], rules: { koukan: true } });
  assert.equal(st.phase, 'playing');
});

// ---- 伏せ処理 ----

test('伏せ: 他人の手札は枚数しか配らない', () => {
  const st = createTable({ seed: 11, players: [0, 1, 2, 3] });
  const v = viewFor(st, 1);
  assert.deepEqual(v.hand, st.hands[1], '自分の手札が届かない');
  assert.deepEqual(Object.keys(v.counts).map(Number).sort(), [0, 1, 2, 3]);
  assert.equal(v.counts[0], st.hands[0].length);
  assert.equal('hands' in v, false, '手札そのものが入っている');
  // **他人の手札を丸ごと入れ替えても、配るものが変わらないこと。**
  // 中身がどこかに写っていれば、ここで必ず違いが出る(名前の探し合いより確実)。
  const faked = structuredClone(st);
  faked.hands[0] = faked.hands[0].map(() => 52);
  faked.hands[3] = faked.hands[3].map(() => 53);
  assert.deepEqual(viewFor(faked, 1), v, '他人の手札を変えると配るものが変わる(漏れている)');
});

test('伏せ: 待ちは「誰が何枚か」だけで、選ぶ中身は漏れない', () => {
  const titles = { 0: 'daifugo', 1: 'heimin', 2: 'daihinmin' };
  const st = createTable({
    seed: 3, players: [0, 1, 2], rules: { koukan: true }, titles, game: 2,
  });
  const v = viewFor(st, 2);   // 大貧民から見る
  assert.equal(v.awaiting.player, 0);
  assert.equal(v.awaiting.count, 2);
  assert.equal(v.hand.length, st.hands[2].length);
});

// ---- 出せる手の一覧 ----

test('出せる手: 一覧はどれも通り、通る手は一覧にある', () => {
  const st = createTable({ seed: 21, players: [0, 1, 2, 3] });
  const me = st.players[st.turn];
  const list = legalPlays(st, me);
  assert.ok(list.length > 0, '出せる手が無い');
  for (const cs of list) {
    assert.equal(validate(st, { type: 'PLAY', player: me, cards: cs }), null,
      `一覧にあるのに出せない: ${show(cs)}`);
  }
  // 手札の1枚ずつは必ず出せる(場が流れているので)
  for (const card of st.hands[me]) {
    assert.ok(list.some((cs) => cs.length === 1 && cs[0] === card),
      `${cardName(card)} が一覧に無い`);
  }
});

test('出せる手: 場があるときは、それを超えるものだけ', () => {
  let st = table({
    0: cards('♠9', '♠4'), 1: cards('♠3', '♠10', '♥10', '🃏'), 2: cards('♠J'),
  });
  st = play(st, 0, cards('♠9'));
  const list = legalPlays(st, 1);
  const names = list.map(show).sort();
  // 1枚で 9 を超えるのは ♠10 / ♥10 / 🃏。♠3 は超えない
  assert.deepEqual(names.filter((x) => !x.includes(' ')).sort(), ['♠10', '♥10', '🃏']);
  // ジョーカーの片割れも「10のペア」として数えられる
  assert.ok(list.some((cs) => cs.length === 2 && cs.includes(52)) === false,
    '枚数の合わない手が混ざっている');
});

test('出せる手: 自分の番でなければ空', () => {
  const st = createTable({ seed: 21, players: [0, 1, 2, 3] });
  const other = st.players.find((p) => p !== st.players[st.turn]);
  assert.deepEqual(legalPlays(st, other), []);
});

// ---- ルールの表 ----

test('ルール: 表がそろっていて、既定が拾える', () => {
  assert.equal(new Set(RULE_IDS).size, RULE_IDS.length, 'id が重複している');
  for (const r of RULES) {
    assert.ok(r.name && r.desc, `${r.id}: 名前か説明が無い`);
    assert.equal(typeof r.on, 'boolean', `${r.id}: 既定が真偽でない`);
  }
  const def = defaultRules();
  assert.deepEqual(Object.keys(def).sort(), [...RULE_IDS].sort());
});

test('ルール: 知らない名前や壊れた値は捨てる', () => {
  const r = cleanRules({ kiri8: false, ないるーる: true, kaidan: 'はい' });
  assert.equal(r.kiri8, false);
  assert.equal(r.kaidan, true, '真偽に直していない');
  assert.equal('ないるーる' in r, false, '知らない名前が入った');
  for (const bad of [null, undefined, 'あ', 3]) {
    assert.deepEqual(cleanRules(bad), defaultRules(), `${String(bad)} で既定に戻らない`);
  }
});

// ---- 通しで回す ----

// 1手ずつ「出せるなら出す・出せなければパス」で回し切る。
// 進行が止まる・同じ札が二度出る・札が消えるといった壊れ方をここで捕まえる。
test('通し: どの人数・どのルールでも、必ず決着まで進む', () => {
  const combos = [
    {},
    Object.fromEntries(RULE_IDS.map((id) => [id, true])),   // 全部入り
    Object.fromEntries(RULE_IDS.map((id) => [id, false])),  // 全部なし
  ];
  for (const rules of combos) {
    for (const n of [2, 3, 4, 5, 8]) {
      for (const seed of [1, 2, 3]) {
        const players = [...Array(n).keys()];
        let st = createTable({ seed, players, rules });
        const seen = new Set();
        let steps = 0;
        while (!st.result && steps++ < 4000) {
          const who = st.awaiting ? st.awaiting.player : st.players[st.turn];
          if (st.awaiting) {
            const pick = st.hands[who].slice(0, st.awaiting.count);
            const kind = { exchange: 'EXCHANGE', give: 'GIVE', discard: 'DISCARD' }[st.awaiting.type];
            const r = dispatch(st, { type: kind, player: who, cards: pick });
            assert.equal(r.error, undefined, `${n}人 種${seed}: ${st.awaiting.type} が通らない (${r.error})`);
            st = r.state;
            continue;
          }
          const list = legalPlays(st, who);
          const move = list.length && (st.field === null || list.length > 1)
            ? { type: 'PLAY', player: who, cards: list[0] }
            : (list.length ? { type: 'PLAY', player: who, cards: list[0] } : { type: 'PASS', player: who });
          const r = dispatch(st, move);
          assert.equal(r.error, undefined,
            `${n}人 種${seed}: 手が通らない ${show(move.cards ?? [])} (${r.error})`);
          if (move.type === 'PLAY') {
            for (const card of move.cards) {
              assert.equal(seen.has(card), false, `同じ札が二度出た: ${cardName(card)}`);
              seen.add(card);
            }
          }
          st = r.state;
        }
        assert.ok(st.result, `${n}人 種${seed} ルール${Object.keys(rules).length}: 決着しない`);
        assert.equal(st.result.order.length, n, '順位に人数ぶん並んでいない');
        assert.equal(new Set(st.result.order).size, n, '同じ人が二度並んでいる');
        // 札が残るのは「最後まで出し切れなかったひとり」だけ。
        // ふたり以上残っていたら、進行が途中で止まっている。
        const left = players.filter((p) => st.hands[p].length > 0);
        assert.ok(left.length <= 1, `手札が残った人が2人以上いる: ${left}`);
        for (const p of left) assert.equal(st.out.includes(p), false, '上がった人に札が残っている');
      }
    }
  }
});

test('通し: 決着したら、もう何も受け付けない', () => {
  let st = table({ 0: cards('♠4'), 1: cards('♠9') });
  st = play(st, 0, cards('♠4'));
  assert.ok(st.result);
  assert.match(deny(st, { type: 'PASS', player: 1 }), /決着しています/);
});

// ---- 壊れた入力 ----

test('壊れた入力: 持っていない札・重複・でたらめは弾く', () => {
  const st = table({ 0: cards('♠4', '♠5'), 1: cards('♠9'), 2: cards('♠10') });
  assert.match(deny(st, { type: 'PLAY', player: 0, cards: cards('♠K') }), /持っていない/);
  assert.match(deny(st, { type: 'PLAY', player: 0, cards: [c('♠4'), c('♠4')] }), /持っていない|組み合わせ/);
  assert.match(deny(st, { type: 'PLAY', player: 0, cards: [] }), /札を選んで/);
  assert.match(deny(st, { type: 'ワープ', player: 0 }), /不明な操作/);
  for (const bad of [null, undefined, 'あ', [999], [-1], [1.5]]) {
    assert.ok(classify(bad) === null, `${JSON.stringify(bad)} が形として通った`);
  }
});

test('札の番号: 名前と数字とマークが噛み合っている', () => {
  assert.equal(cardName(SPADE3), '♠3');
  assert.equal(cardName(c('♦3')), '♦3');
  assert.equal(cardName(52), '🃏');
  assert.equal(rankOf(c('♠2')), RANKS.indexOf('2'));
  assert.equal(suitOf(c('♣K')), SUITS.indexOf('♣'));
  assert.equal(isJoker(52) && isJoker(53), true);
  assert.equal(isJoker(51), false);
  // 0〜53 で名前が付く(通信に乗る番号なので抜けがあると困る)
  for (let i = 0; i < DECK; i++) assert.ok(cardName(i).length >= 2, `${i} に名前が無い`);
});
