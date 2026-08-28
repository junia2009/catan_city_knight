// 効果音の「どの場面でどれを鳴らすか」のテスト。
// 音の合成そのものは Web Audio なのでここでは触らず、対応表だけを見る。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createGame } from '../src/state.js';
import { dispatch } from '../src/actions.js';
import { chooseAction } from '../src/ai/cpu-player.js';
import { SFX_NAMES, sfxForAction, sfxForEnd } from '../src/audio/sfx.js';

const names = (action, prev, next, me = 0) =>
  sfxForAction(action, prev, next, me).map((x) => x.name);

function finishSetup(state) {
  while (state.phase === 'setup') {
    state = dispatch(state, chooseAction(state, state.awaiting.players[0]));
  }
  return state;
}

// 手番プレイヤーを 0 にして、振る直前の状態にする
function readyToRoll(s, resources = null) {
  s = structuredClone(s);
  s.currentPlayer = 0;
  s.awaiting = null;
  s.turnFlags = { rolled: false, playedDev: false };
  if (resources) s.players[0].resources = resources;
  return s;
}

test('効果音: 定義された音だけを返す', () => {
  let s = finishSetup(createGame({ seed: 5, playerCount: 4, humanIndex: -1, mode: 'cak' }));
  // 200手ぶん流して、出てくる音がすべて定義済みか見る
  const seen = new Set();
  for (let i = 0; i < 200 && s.phase !== 'ended'; i++) {
    const pid = s.awaiting ? s.awaiting.players[0] : s.currentPlayer;
    const a = chooseAction(s, pid);
    if (!a) break;
    const prev = s;
    s = dispatch(s, a);
    for (const n of names(a, prev, s)) seen.add(n);
  }
  assert.ok(seen.size > 0, '音が1つも鳴っていない');
  for (const n of seen) {
    assert.ok(SFX_NAMES.includes(n), `未定義の音: ${n}`);
  }
});

test('効果音: ダイスは必ず鳴り、7なら盗賊の音が続く', () => {
  const base = finishSetup(createGame({ seed: 5, playerCount: 4, humanIndex: -1 }));

  const s7 = readyToRoll(base);
  s7.turnFlags.alchemist = [3, 4];
  const after7 = dispatch(s7, { type: 'ROLL_DICE', player: 0 });
  // 7 のあとは盗賊の移動などで自分に返事が回るので、末尾に呼びかけが付くことがある
  assert.deepEqual(
    names({ type: 'ROLL_DICE', player: 0 }, s7, after7).slice(0, 2),
    ['roll', 'robber'],
  );

  // 7 以外で自分の手札が増えたら獲得の音
  const s = readyToRoll(base);
  let got = null;
  for (let a = 1; a <= 6 && !got; a++) {
    for (let b = 1; b <= 6; b++) {
      if (a + b === 7) continue;
      const t = structuredClone(s);
      t.turnFlags.alchemist = [a, b];
      const nx = dispatch(t, { type: 'ROLL_DICE', player: 0 });
      const hand = (p) => Object.values(p.resources).reduce((x, y) => x + y, 0);
      if (hand(nx.players[0]) > hand(t.players[0])) { got = [t, nx]; break; }
    }
  }
  assert.ok(got, '資源が増える出目が見つからない');
  assert.deepEqual(names({ type: 'ROLL_DICE', player: 0 }, got[0], got[1]), ['roll', 'gain']);
});

test('効果音: 蛮族の襲来はダイスの音のあとに鳴る', () => {
  let s = finishSetup(createGame({ seed: 5, playerCount: 4, humanIndex: -1, mode: 'cak' }));
  s = readyToRoll(s);
  // 進軍を「あと1歩」にしておき、イベントダイスで襲来を起こす
  s.barbarians.position = 6;
  const prev = s;
  let next = null;
  for (let i = 0; i < 40; i++) {
    const t = structuredClone(prev);
    t.rng = (t.rng + i * 7919) >>> 0;
    const nx = dispatch(t, { type: 'ROLL_DICE', player: 0 });
    if (nx.barbarians.position < t.barbarians.position) { next = [t, nx]; break; }
  }
  assert.ok(next, '襲来が起きる乱数が見つからない');
  // 都市の降格を選ばされる場合は、末尾に呼びかけが付く
  assert.deepEqual(
    names({ type: 'ROLL_DICE', player: 0 }, next[0], next[1]).slice(0, 2),
    ['roll', 'barbarian'],
  );
});

test('効果音: 建設と手番の合図', () => {
  const s = finishSetup(createGame({ seed: 5, playerCount: 4, humanIndex: -1 }));
  const same = (a) => names(a, s, s);
  assert.deepEqual(same({ type: 'BUILD_ROAD', player: 0 }), ['road']);
  assert.deepEqual(same({ type: 'BUILD_CITY', player: 0 }), ['city']);
  assert.deepEqual(same({ type: 'BUY_DEV_CARD', player: 0 }), ['card']);
  assert.deepEqual(same({ type: 'BUILD_KNIGHT', player: 0 }), ['knight']);

  // END_TURN は自分に手番が回ってきたときだけ鳴らす
  const toMe = { ...s, currentPlayer: 0, awaiting: null };
  const toOther = { ...s, currentPlayer: 1, awaiting: null };
  assert.deepEqual(names({ type: 'END_TURN', player: 3 }, s, toMe), ['turn']);
  assert.deepEqual(names({ type: 'END_TURN', player: 0 }, s, toOther), []);
  // 割り込み待ち(捨て札など)の最中は鳴らさない
  const busy = { ...s, currentPlayer: 0, awaiting: { type: 'discard', players: [1], context: {} } };
  assert.deepEqual(names({ type: 'END_TURN', player: 3 }, s, busy), []);
});

test('効果音: 初期配置は駒に合わせて開拓地/船を鳴らし分ける', () => {
  const s = createGame({ seed: 3, playerCount: 4, humanIndex: -1, mode: 'sea' });
  const eid = 'E';
  const withShip = { ...s, ships: { [eid]: { player: 0 } } };
  assert.deepEqual(names({ type: 'PLACE_INITIAL', player: 0, edgeId: eid }, s, s), ['settlement']);
  assert.deepEqual(names({ type: 'PLACE_INITIAL', player: 0, edgeId: eid }, s, withShip), ['ship']);
});

test('効果音: 交易は全員が断ったときだけ拒否の音', () => {
  const s = finishSetup(createGame({ seed: 5, playerCount: 4, humanIndex: -1 }));
  const offering = {
    ...s,
    awaiting: { type: 'tradeOffer', players: [3], context: { replies: { 1: false, 2: false } } },
  };
  const done = { ...s, awaiting: null };
  // まだ返事待ちが残っているうちは鳴らさない
  const waiting = { ...s, awaiting: { type: 'tradeOffer', players: [2], context: { replies: {} } } };
  assert.deepEqual(names({ type: 'RESPOND_TRADE', player: 1, accept: false }, offering, waiting), []);
  assert.deepEqual(names({ type: 'RESPOND_TRADE', player: 3, accept: false }, offering, done), ['reject']);
  assert.deepEqual(names({ type: 'RESPOND_TRADE', player: 3, accept: true }, offering, done), ['ui']);
});

test('効果音: 自分に返事が回ってきたら呼びかける', () => {
  const s = finishSetup(createGame({ seed: 5, playerCount: 4, humanIndex: -1 }));
  const idle = { ...s, awaiting: null };
  const asksMe = { ...s, awaiting: { type: 'tradeOffer', players: [0, 2], context: {} } };
  const asksOther = { ...s, awaiting: { type: 'tradeOffer', players: [2], context: {} } };

  // 相手の提案が自分に回ってきた → 行動の音のあとに呼びかけ
  const got = sfxForAction({ type: 'OFFER_TRADE', player: 1 }, idle, asksMe, 0);
  assert.deepEqual(got, [{ name: 'ask', delay: 0 }]);
  // 自分以外に回ったときは鳴らさない
  assert.deepEqual(names({ type: 'OFFER_TRADE', player: 1 }, idle, asksOther), []);
  // すでに自分が返事待ちだったなら鳴らし直さない
  assert.deepEqual(names({ type: 'RESPOND_TRADE', player: 2 }, asksMe, asksMe), []);

  // 行動の音がある場合は、そのあとに遅らせて鳴らす(7を出して自分が捨て札)
  const rolled = readyToRoll(s);
  rolled.turnFlags.alchemist = [3, 4];
  for (const p of rolled.players) p.resources = { wood: 3, brick: 3, sheep: 2, wheat: 0, ore: 0 };
  const after = dispatch(rolled, { type: 'ROLL_DICE', player: 0 });
  assert.equal(after.awaiting?.type, 'discard', '捨て札の割り込みが立っていない');
  const seq = sfxForAction({ type: 'ROLL_DICE', player: 0 }, rolled, after, 0);
  assert.deepEqual(seq.map((x) => x.name), ['roll', 'robber', 'ask']);
  assert.ok(seq[2].delay > 0, '呼びかけが行動の音と重なっている');
});

test('効果音: 決着は勝者が自分かどうかで変わる', () => {
  const s = { phase: 'ended', winner: 2 };
  assert.equal(sfxForEnd(s, 2), 'win');
  assert.equal(sfxForEnd(s, 0), 'lose');
  assert.equal(sfxForEnd({ phase: 'main' }, 0), null);
});

test('効果音: 状態が欠けていても落ちない', () => {
  assert.deepEqual(sfxForAction(null, {}, {}, 0), []);
  assert.deepEqual(sfxForAction({ type: 'BUILD_ROAD' }, null, {}, 0), []);
  // 知らないアクションは黙る
  assert.deepEqual(names({ type: 'UNKNOWN_THING', player: 0 }, {}, {}), []);
});
