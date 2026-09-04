// 大富豪の卓(server/daifugo-table.js)。
//
// ルールそのものは test/daifugo.test.js が押さえてあるので、ここは
// **卓とサーバーの繋ぎ目**だけを見る:
//   - 手札が席ごとにしか届かない(perSeat)
//   - ルールを決められるのはホストだけ
//   - 決着で結果へ、席を立たれても回が壊れない、放置されたら代わりに打つ

import test from 'node:test';
import assert from 'node:assert/strict';

import { DaifugoTable, AUTO_MS, TABLE_MS, dealSeed, weakestPlay } from '../server/daifugo-table.js';
import { defaultRules, legalPlays, rankOf } from '../src/minigame/daifugo.js';
import { contestOutcome } from '../src/minigame/contest.js';

const at = (t) => t;

// ホスト(席0)と2人で卓を立てたところまで
function seated(seats = [0, 1, 2], t = 0, rules = null) {
  const c = new DaifugoTable();
  c.setSeed(1234);
  c.setHost(0);
  if (rules) c.setRules(0, rules);
  for (const s of seats) c.enter(s, at(t));
  c.start(seats[0], at(t));
  return c;
}

// いま打つ番の席で、通る手を1つ打つ
function step(c, now) {
  const t = c.table;
  const who = t.awaiting ? t.awaiting.player : t.players[t.turn];
  if (t.awaiting) {
    const res = c.command(who, 'pick', { cards: t.hands[who].slice(0, t.awaiting.count) }, now);
    assert.equal(res.error, undefined, `pick が通らない: ${res.error}`);
    return who;
  }
  const list = legalPlays(t, who);
  const res = list.length
    ? c.command(who, 'play', { cards: list[0] }, now)
    : c.command(who, 'pass', {}, now);
  assert.equal(res.error, undefined, `手が通らない: ${res.error}`);
  return who;
}

test('卓: 席がそろうと配られ、卓が立つ', () => {
  const c = seated();
  assert.equal(c.phase, 'running');
  assert.equal(c.table.players.length, 3);
  const all = c.table.players.flatMap((p) => c.table.hands[p]);
  assert.equal(all.length, 54, '配り切っていない');
});

test('卓: 席ごとに違うものを配る(perSeat)', () => {
  const c = seated();
  assert.equal(c.perSeat, true, '席ごとに配る印が立っていない');
  const mine = c.viewFor(0);
  const theirs = c.viewFor(1);
  assert.deepEqual(mine.table.hand, c.table.hands[0]);
  assert.deepEqual(theirs.table.hand, c.table.hands[1]);
  assert.notDeepEqual(mine.table.hand, theirs.table.hand);
});

// 手札が漏れていないことは daifugo.js の viewFor が担うが、卓が
// 素の table をそのまま貼り付けてしまうと台無しになる。そこを見る。
test('卓: 他人の手札は、席ごとの中身にも入らない', () => {
  const c = seated();
  const v = c.viewFor(0);
  const faked = new DaifugoTable();
  Object.assign(faked, c, { table: structuredClone(c.table) });
  faked.table.hands[1] = faked.table.hands[1].map(() => 52);
  faked.table.hands[2] = faked.table.hands[2].map(() => 53);
  assert.deepEqual(faked.viewFor(0), v, '他人の手札を変えると配るものが変わる(漏れている)');
});

test('卓: 配りは部屋の種と回数で決まる。2回目は違う配り', () => {
  assert.equal(dealSeed(99, 1), dealSeed(99, 1), '同じ回で配りが変わる');
  assert.notEqual(dealSeed(99, 1), dealSeed(99, 2), '2回目も同じ配り');
  assert.notEqual(dealSeed(1, 1), dealSeed(2, 1), '部屋が違っても同じ配り');
});

// ---- ルールを決める人 ----

test('ルール: 決められるのはホストだけ', () => {
  const c = new DaifugoTable();
  c.setHost(0);
  assert.equal(c.setRules(1, { kiri8: false }).error, 'ルールを決めるのはホストです');
  assert.equal(c.rules.kiri8, true, 'ホスト以外の指定が通った');
  assert.equal(c.setRules(0, { ...defaultRules(), kiri8: false }).ok, true);
  assert.equal(c.rules.kiri8, false);
});

test('ルール: 卓が立ってからは変えられない', () => {
  const c = seated();
  assert.match(c.setRules(0, { kiri8: false }).error, /始まってからは/);
});

test('ルール: 知らない名前や壊れた値は入らない', () => {
  const c = new DaifugoTable();
  c.setHost(0);
  c.setRules(0, { kiri8: false, ないるーる: true });
  assert.equal('ないるーる' in c.rules, false);
  assert.deepEqual(Object.keys(c.rules).sort(), Object.keys(defaultRules()).sort());
  for (const bad of [null, undefined, 'あ', 3]) {
    assert.ok(c.setRules(0, bad).error, `${String(bad)} が通ってしまう`);
  }
});

test('ルール: 選んだものが卓に効く', () => {
  const c = seated([0, 1, 2], 0, { ...defaultRules(), kiri8: false, kaidan: false });
  assert.equal(c.table.rules.kiri8, false, '卓に届いていない');
  assert.equal(c.table.rules.kaidan, false);
});

// ---- 席から来る操作 ----

test('操作: 自分の番でなければ通らない。知らない操作も通らない', () => {
  const c = seated();
  const turn = c.table.players[c.table.turn];
  const other = c.table.players.find((p) => p !== turn);
  const list = legalPlays(c.table, turn);
  assert.match(c.command(other, 'play', { cards: list[0] }, at(1)).error, /あなたの番では/);
  assert.match(c.command(turn, 'おどる', {}, at(1)).error, /不明な操作/);
});

test('操作: 卓が立っていなければ打てない', () => {
  const c = new DaifugoTable();
  c.setHost(0);
  c.enter(0, at(0));
  assert.match(c.command(0, 'pass', {}, at(1)).error, /卓が立っていません/);
});

// 'pick' の中身(渡す/捨てる/交換)は卓が知っている。クライアントに
// 種類を送らせると、食い違ったときに何も通らなくなる。
test('操作: 待ちの種類はサーバーが決める(pick 一本)', () => {
  const c = seated([0, 1, 2], 0, { ...defaultRules(), watashi7: true });
  // 7 を持っている人が出すまで進める
  let now = 1;
  for (let i = 0; i < 300 && !c.table.awaiting && !c.table.result; i++) step(c, at(now++));
  if (!c.table.awaiting) return;   // その配りでは 7 が出なかった
  const who = c.table.awaiting.player;
  const n = c.table.awaiting.count;
  const res = c.command(who, 'pick', { cards: c.table.hands[who].slice(0, n) }, at(now));
  assert.equal(res.error, undefined, `pick が通らない: ${res.error}`);
  assert.equal(c.table.awaiting, null, '待ちが解けていない');
});

// ---- 決着 ----

test('決着: 上がり切ったら、時間を待たずに結果へ', () => {
  const c = seated([0, 1, 2]);
  let now = 1;
  for (let i = 0; i < 4000 && c.phase === 'running'; i++) step(c, at(now++));
  assert.equal(c.phase, 'result', '決着しても結果へ移らない');
  assert.ok(c.table.result, '卓が決着していない');
  const rank = c.view(at(now)).rank;
  assert.deepEqual(rank.map((r) => r.place), [1, 2, 3]);
  assert.equal(rank[0].title, 'daifugo');
  assert.equal(rank.at(-1).title, 'daihinmin');
});

test('決着: 次の回は前の称号を持ち越す(同じ顔ぶれなら)', () => {
  const c = seated([0, 1, 2]);
  let now = 1;
  for (let i = 0; i < 4000 && c.phase === 'running'; i++) step(c, at(now++));
  const first = c.view(at(now)).rank.map((r) => r.seat);
  assert.ok(c.titles, '称号が残っていない');
  // 結果を見せ終わって、同じ顔ぶれでもう一度
  c.tick(at(now + 30000));
  assert.equal(c.phase, 'entry');
  c.start(0, at(now + 30001));
  assert.equal(c.table.game, 2, '2回戦になっていない');
  assert.equal(c.table.titles[first[0]], 'daifugo', '前の大富豪が引き継がれていない');
  // 交換が入るので、大富豪が返す待ちから始まる
  assert.equal(c.table.awaiting?.player, first[0]);
});

// 人数が同じでも、中身が入れ替わっていたら持ち越せない
// ── 居ない人の称号で交換を組むと、渡す相手が見つからないまま待ちになる。
test('決着: 人数が同じでも、顔ぶれが入れ替わったら仕切り直し', () => {
  const c = seated([0, 1, 2]);
  let now = 1;
  for (let i = 0; i < 4000 && c.phase === 'running'; i++) step(c, at(now++));
  c.tick(at(now + 30000));
  c.leave(2);
  c.enter(3, at(now + 30001));      // 2 と 3 が入れ替わる(3人のまま)
  c.start(0, at(now + 30002));
  assert.deepEqual([...c.entries].sort((a, b) => a - b), [0, 1, 3]);
  assert.equal(c.table.titles, null, '居ない人の称号を持ち越している');
  assert.equal(c.table.game, 1);
});

test('決着: 顔ぶれが変わったら仕切り直し(称号は持ち越さない)', () => {
  const c = seated([0, 1, 2]);
  let now = 1;
  for (let i = 0; i < 4000 && c.phase === 'running'; i++) step(c, at(now++));
  c.tick(at(now + 30000));
  c.enter(3, at(now + 30001));      // ひとり増える
  c.start(0, at(now + 30002));
  assert.equal(c.table.titles, null, '居ない人の称号で交換を組もうとしている');
  assert.equal(c.table.game, 1);
});

// ---- 席を立たれたとき ----

test('抜け: 卓の途中で抜けても回は続き、その人はいちばん下', () => {
  const c = seated([0, 1, 2, 3]);
  let now = 1;
  for (let i = 0; i < 5; i++) step(c, at(now++));
  const gone = c.table.players[c.table.turn];
  c.dropSeat(gone);
  assert.equal(c.table.hands[gone].length, 0, '抜けた人の手札が残っている');
  assert.ok(c.table.demoted.some((d) => d.player === gone && d.why === 'left'));
  // 残りで決着まで進む
  for (let i = 0; i < 4000 && c.phase === 'running'; i++) step(c, at(now++));
  assert.equal(c.phase, 'result', '抜けたあと進行が止まった');
  assert.equal(c.table.result.order.at(-1), gone, '抜けた人が最下位になっていない');
});

// 卓が立っている間は leave が効かない(器の決まり)。抜ける手だてが
// 無いと、始まったあと島から出るまで卓に縛られる。
test('抜け: 席を立つ(retire)で、卓の途中でも抜けられる', () => {
  const c = seated([0, 1, 2, 3]);
  let now = 1;
  for (let i = 0; i < 3; i++) step(c, at(now++));
  assert.ok(c.command(1, 'leave', {}, at(now)).error, '開催中に leave が通ってしまう');
  assert.equal(c.command(1, 'retire', {}, at(now)).error, undefined);
  assert.equal(c.table.hands[1].length, 0, '手札が残っている');
  assert.equal(c.entries.has(1), false, 'エントリーに残っている');
  for (let i = 0; i < 4000 && c.phase === 'running'; i++) step(c, at(now++));
  assert.equal(c.phase, 'result', '抜けたあと進行が止まった');
});

test('抜け: ふたり抜けても決着する', () => {
  const c = seated([0, 1, 2, 3]);
  let now = 1;
  for (let i = 0; i < 4; i++) step(c, at(now++));
  c.dropSeat(2);
  c.dropSeat(3);
  for (let i = 0; i < 4000 && c.phase === 'running'; i++) step(c, at(now++));
  assert.equal(c.phase, 'result');
  assert.equal(c.table.result.order.length, 4, '順位に人数ぶん並んでいない');
});

// ---- 放置よけ ----

test('放置: 考え込んだままだと、サーバーが代わりに打つ', () => {
  const c = seated([0, 1, 2]);
  const before = c.table.players[c.table.turn];
  const hand = c.table.hands[before].length;
  // まだ時間内なら動かない
  c.tick(at(AUTO_MS - 1));
  assert.equal(c.table.players[c.table.turn], before, '時間前に代わりに打った');
  c.tick(at(AUTO_MS));
  const moved = c.table.players[c.table.turn] !== before
    || c.table.hands[before].length < hand;
  assert.ok(moved, '時間が過ぎても代わりに打たない');
});

test('放置: 代わりに打つ手は、いちばん弱い手', () => {
  const c = seated([0, 1, 2]);
  const who = c.table.players[c.table.turn];
  const best = weakestPlay(c.table, who);
  assert.ok(best, '出せる手が無い');
  assert.equal(best.length, 1, '場が流れているのに1枚より多く出そうとしている');
  const list = legalPlays(c.table, who);
  const singles = list.filter((cs) => cs.length === 1).map((cs) => rankOf(cs[0]));
  assert.equal(rankOf(best[0]), Math.min(...singles), 'いちばん弱い札を選んでいない');
});

test('放置: 考える時間の残りを配る', () => {
  const c = seated([0, 1, 2], 1000);
  assert.equal(c.view(at(1000)).turnRemain, AUTO_MS);
  assert.equal(c.view(at(1000 + 10000)).turnRemain, AUTO_MS - 10000);
  // 決着したら数えない
  let now = 2000;
  for (let i = 0; i < 4000 && c.phase === 'running'; i++) step(c, at(now++));
  assert.equal(c.view(at(now)).turnRemain, 0);
});

// ---- 保存 ----

test('保存: 読み直しても卓も称号もルールもそのまま', () => {
  const c = seated([0, 1, 2], 0, { ...defaultRules(), kiri8: false, jback: true });
  let now = 1;
  for (let i = 0; i < 6; i++) step(c, at(now++));
  const back = DaifugoTable.fromJSON(JSON.parse(JSON.stringify(c.toJSON())));
  // ホストだけは保存しない。名簿(room-do)から毎回わたるので、
  // 保存に焼き付けると「ホストが変わったのに前の人のまま」になる
  assert.equal(back.hostSeat, -1, 'ホストを保存に焼き付けている');
  back.setHost(0);
  assert.equal(back.phase, 'running');
  assert.deepEqual(back.rules, c.rules);
  assert.deepEqual(back.table, c.table);
  assert.deepEqual(back.viewFor(1, at(now)), c.viewFor(1, at(now)));
  // 読み直したあとも続けられる
  step(back, at(now));
  assert.notDeepEqual(back.table, c.table);
});

test('保存: 壊れた称号は持ち越さない', () => {
  const c = new DaifugoTable();
  for (const bad of [{ 0: 'おうさま' }, 'あ', 5]) {
    const back = DaifugoTable.fromJSON({ ...c.toJSON(), titles: bad });
    assert.equal(back.titles, null, `${JSON.stringify(bad)} を持ち越してしまう`);
  }
  const ok = DaifugoTable.fromJSON({ ...c.toJSON(), titles: { 0: 'daifugo', 1: 'daihinmin' } });
  assert.deepEqual(ok.titles, { 0: 'daifugo', 1: 'daihinmin' });
});

test('卓: 上限の時間は決め打ちしない', () => {
  assert.ok(TABLE_MS > AUTO_MS, '考える時間より卓の上限が短い');
  const short = new DaifugoTable({ ms: 1000 });
  short.setHost(0);
  short.enter(0, at(0));
  short.enter(1, at(0));
  short.start(0, at(0));
  assert.equal(short.tick(at(1000)), true, '上限で畳めない');
  assert.equal(short.phase, 'result');
  assert.equal(short.titles, null, '決着していない回の称号を持ち越した');
});

// ---- 結果の読み取り(実績と称号がここで付く)----

test('結果: 1番に上がった人だけが優勝。順位はサーバーの並びをそのまま使う', () => {
  const c = seated([0, 1, 2]);
  let now = 1;
  for (let i = 0; i < 4000 && c.phase === 'running'; i++) step(c, at(now++));
  const v = c.view(at(now));
  const order = v.rank.map((r) => r.seat);
  assert.equal(contestOutcome(v, order[0]).won, true, '1番の人が優勝になっていない');
  assert.equal(contestOutcome(v, order[0]).place, 1);
  for (const seat of order.slice(1)) {
    assert.equal(contestOutcome(v, seat).won, false, `${seat} が優勝になっている`);
  }
  // 記録は「何人抜いたか」。1番が いちばん大きい
  assert.equal(contestOutcome(v, order[0]).score, 2);
  assert.equal(contestOutcome(v, order.at(-1)).score, 0);
  // 出ていない人は数えない
  assert.equal(contestOutcome(v, 7).entered, false);
});

// 残り枚数から順位を作ろうとすると、上がった人(0枚)と抜けた人(0枚)が
// 同率になる。順位は「札を出し切った順」なので、並びのほうが正しい。
test('結果: 抜けた人がいても、上がった順のまま数える', () => {
  const c = seated([0, 1, 2]);
  let now = 1;
  for (let i = 0; i < 3; i++) step(c, at(now++));
  c.dropSeat(1);
  for (let i = 0; i < 4000 && c.phase === 'running'; i++) step(c, at(now++));
  const v = c.view(at(now));
  assert.equal(v.rank.at(-1).seat, 1, '抜けた人が最下位になっていない');
  assert.equal(contestOutcome(v, 1).won, false, '抜けた人が優勝になっている');
  assert.equal(contestOutcome(v, v.rank[0].seat).won, true);
});
