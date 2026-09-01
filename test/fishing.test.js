// 釣りミニゲームの検証。THREE は使わないので node --test でそのまま回る。
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  FISH, FISH_BY_ID, PORT_TYPES, tableFor, pickFish, rollSize, sizeRatio,
} from '../src/minigame/fish.js';
import {
  Fishing, CAST_TIME, WAIT_MAX, HOOK_WINDOW, MAX_DT, REEL_GAIN,
} from '../src/minigame/fishing.js';
import { emptyProgress, addCatch, fishbookCount, parseProgress } from '../src/progress.js';
import { createGame } from '../src/state.js';
import {
  makeGround, spawnPoint, fishingSpots, spotNear, SPOT_RADIUS,
} from '../src/minigame/ground.js';

// 決まった手順で dt を刻む。実際のフレームに近い刻みで回す。
// stopAt に挙げた出来事が起きたら、そこで止める(アタリまで進める、など)。
function run(f, seconds, dt, reeling, stopAt = []) {
  const events = [];
  for (let t = 0; t < seconds; t += dt) {
    f.setReeling(typeof reeling === 'function' ? reeling(f) : !!reeling);
    const ev = f.update(dt);
    events.push(...ev);
    if (!f.active) break;
    if (ev.some((e) => stopAt.includes(e))) break;
  }
  return events;
}

// ---- 魚の一覧 ----

test('魚: id が重複していない', () => {
  const ids = FISH.map((f) => f.id);
  assert.equal(new Set(ids).size, ids.length);
});

test('魚: 大きさの範囲と引きの数値が揃っている', () => {
  for (const f of FISH) {
    assert.ok(f.cm[0] > 0 && f.cm[1] > f.cm[0], `${f.id} の大きさ`);
    assert.ok(f.pull > 0 && f.stamina > 0, `${f.id} の引き`);
    assert.ok(f.burst[1] > f.burst[0] && f.burst[0] > 0, `${f.id} の暴れ間隔`);
    assert.ok(f.burstK >= 1, `${f.id} の暴れの強さ`);
    assert.ok(f.w > 0, `${f.id} の出やすさ`);
  }
});

test('魚: ぬしは自分の港にしかいない', () => {
  const legends = FISH.filter((f) => f.tier === 'legend');
  assert.ok(legends.length > 0);
  for (const f of legends) {
    assert.ok(PORT_TYPES.includes(f.at), `${f.id} の港 ${f.at}`);
    for (const p of PORT_TYPES) {
      const here = tableFor(p).some((x) => x.id === f.id);
      assert.equal(here, p === f.at, `${f.id} が ${p} に出るか`);
    }
  }
  // 港の種類ごとに、ぬしはちょうど1匹
  for (const p of PORT_TYPES) {
    const n = tableFor(p).filter((x) => x.tier === 'legend').length;
    assert.equal(n, 1, `${p} のぬしの数`);
  }
});

test('魚: 抽選はその港の表からしか引かない', () => {
  let rng = 12345;
  for (const p of PORT_TYPES) {
    const ids = new Set(tableFor(p).map((f) => f.id));
    for (let i = 0; i < 400; i++) {
      let f;
      [rng, f] = pickFish(rng, p);
      assert.ok(ids.has(f.id), `${p} で ${f.id} が出た`);
    }
  }
});

test('魚: 同じ種でも大きさはばらけ、範囲からは出ない', () => {
  let rng = 777;
  const f = FISH_BY_ID.maguro;
  const seen = new Set();
  for (let i = 0; i < 300; i++) {
    let cm;
    [rng, cm] = rollSize(rng, f);
    assert.ok(cm >= f.cm[0] && cm <= f.cm[1], `${cm} が範囲外`);
    seen.add(cm);
  }
  assert.ok(seen.size > 100, '大きさが同じ値ばかりになっている');
});

test('魚: 大きさの割合は 0〜1 に収まる', () => {
  const f = FISH_BY_ID.aji;
  assert.equal(sizeRatio(f, f.cm[0]), 0);
  assert.equal(sizeRatio(f, f.cm[1]), 1);
  assert.equal(sizeRatio(f, f.cm[0] - 99), 0);
  assert.equal(sizeRatio(f, f.cm[1] + 99), 1);
});

// ---- 進行 ----

test('釣り: 投げると待ちになり、やがてアタリが来る', () => {
  const f = new Fishing(42);
  assert.equal(f.phase, 'idle');
  assert.ok(f.cast());
  assert.equal(f.phase, 'cast');
  run(f, CAST_TIME + 0.05, 1 / 60, false);
  assert.equal(f.phase, 'wait');
  const ev = run(f, WAIT_MAX + 0.2, 1 / 60, false, ['bite']);
  assert.equal(f.phase, 'bite');
  assert.deepEqual(ev, ['bite']);
});

test('釣り: 投げていない間は「あわせる」ても何も起きない', () => {
  const f = new Fishing(1);
  assert.equal(f.hook(), false);
  assert.equal(f.phase, 'idle');
});

test('釣り: 二重に投げられない', () => {
  const f = new Fishing(1);
  assert.ok(f.cast());
  assert.equal(f.cast(), false);
});

test('釣り: 早あわせは逃げられる', () => {
  const f = new Fishing(7);
  f.cast();
  run(f, CAST_TIME + 0.3, 1 / 60, false);
  assert.equal(f.phase, 'wait');
  assert.equal(f.hook(), false);
  assert.equal(f.phase, 'lost');
  assert.equal(f.lost, 'early');
});

test('釣り: アタリを見送ると持っていかれる', () => {
  const f = new Fishing(7);
  f.cast();
  run(f, CAST_TIME + WAIT_MAX + 0.2, 1 / 60, false, ['bite']);
  assert.equal(f.phase, 'bite');
  const ev = run(f, HOOK_WINDOW + 0.2, 1 / 60, false);
  assert.equal(f.phase, 'lost');
  assert.equal(f.lost, 'late');
  assert.deepEqual(ev, ['lost']);
});

// アタリまで進めて、あわせるところまでやる
function toFight(seed, portType = '3:1') {
  const f = new Fishing(seed, portType);
  f.cast();
  run(f, CAST_TIME + WAIT_MAX + 0.2, 1 / 60, false, ['bite']);
  assert.equal(f.phase, 'bite');
  assert.ok(f.hook());
  return f;
}

test('釣り: あわせると魚と大きさが決まる', () => {
  const f = toFight(3);
  assert.equal(f.phase, 'fight');
  assert.ok(f.fish && FISH_BY_ID[f.fish.id]);
  assert.ok(f.cm >= f.fish.cm[0] && f.cm <= f.fish.cm[1]);
  assert.ok(f.progress > 0 && f.progress < 1);
});

// 抽選に頼らず、決めた魚で勝負だけを始める。
// 引きの強さを確かめたいときは、どの魚が来たかで結果が変わっては困る。
function fightWith(id, cm = null) {
  const f = new Fishing(1);
  f.fish = FISH_BY_ID[id];
  f.cm = cm ?? (f.fish.cm[0] + f.fish.cm[1]) / 2;
  f.phase = 'fight';
  f.progress = 0.06;
  f.tension = 0.12;
  f.burstT = f.fish.burst[0];
  return f;
}

// 押しっぱなしで釣れてしまうと、駆け引きが消えて「押すだけ」の遊びになる。
// 切れるまでの時間 = 1/pull、取り込みきる時間 = stamina/REEL_GAIN なので、
// pull × stamina が REEL_GAIN より大きければ必ず先に切れる。
// (ガラクタだけは逆。長ぐつを慎重に引き上げても面白くない)
test('釣り: 大きめの個体は、巻きっぱなしでは必ず切れる', () => {
  for (const f of FISH) {
    // _power() の最大サイズ補正: pull ×1.25 / stamina ×1.15
    const m = (f.pull * 1.25) * (f.stamina * 1.15) / REEL_GAIN;
    if (f.tier === 'junk') assert.ok(m < 1, `${f.name} は切れずに上がるはず (${m.toFixed(2)})`);
    else assert.ok(m > 1.2, `${f.name} は押しっぱなしで上がってしまう (${m.toFixed(2)})`);
  }
});

test('釣り: 巻きっぱなしだと糸が切れる', () => {
  for (const id of ['iwashi', 'saba', 'maguro', 'daiouika']) {
    const f = fightWith(id);
    const ev = run(f, 60, 1 / 60, true);
    assert.equal(f.phase, 'lost', id);
    assert.equal(f.lost, 'snap', id);
    assert.ok(ev.includes('lost'));
  }
});

test('釣り: ガラクタは引き上げるだけで上がる', () => {
  for (const id of ['boot', 'weed', 'bottle']) {
    const f = fightWith(id, FISH_BY_ID[id].cm[1]);   // いちばん大きい個体でも
    run(f, 30, 1 / 60, true);
    assert.equal(f.phase, 'landed', id);
  }
});

test('釣り: どの魚も、張りを見て休げば上げられる', () => {
  const play = (f) => f.tension < 0.7;
  for (const f0 of FISH) {
    const f = fightWith(f0.id, f0.cm[1]);   // いちばん手強い個体で
    run(f, 200, 1 / 60, play);
    assert.equal(f.phase, 'landed', `${f0.name} が上げられない (${f.lost})`);
  }
});

test('釣り: 一番の大物でも、勝負が長くなりすぎない', () => {
  const play = (f) => f.tension < 0.7;
  for (const f0 of FISH) {
    const f = fightWith(f0.id, f0.cm[1]);
    let t = 0;
    for (; t < 200 && f.active; t += 1 / 60) {
      f.setReeling(play(f));
      f.update(1 / 60);
    }
    assert.equal(f.phase, 'landed', f0.name);
    const limit = f0.tier === 'myth' ? 60 : 45;
    assert.ok(t < limit, `${f0.name} に ${t.toFixed(1)} 秒かかる`);
  }
});

test('釣り: 張りを見て休めば釣り上げられる', () => {
  // 張りが 0.7 を超えたら手を離す、という素直な遊びかた
  const play = (f) => f.tension < 0.7;
  for (const seed of [1, 2, 3, 4, 5, 6, 7, 8]) {
    const f = toFight(seed);
    const ev = run(f, 90, 1 / 60, play);
    assert.equal(f.phase, 'landed', `seed ${seed}: ${f.fish.name} ${f.lost ?? ''}`);
    assert.ok(ev.includes('landed'));
    assert.equal(f.progress, 1);
  }
});

test('釣り: 手を離しっぱなしでは釣れない(取り込みが戻る)', () => {
  const f = fightWith('saba');
  run(f, 20, 1 / 60, false);
  assert.equal(f.phase, 'fight');
  assert.equal(f.progress, 0);
  assert.equal(f.tension, 0);
});

test('釣り: 魚は暴れる(張りが跳ね上がる合図が出る)', () => {
  const f = fightWith('maguro');
  const ev = run(f, 30, 1 / 60, (x) => x.tension < 0.7);
  assert.ok(ev.includes('burst'), '暴れが一度も起きていない');
});

test('釣り: 暴れている間は張りの上がりが速い', () => {
  const calm = fightWith('maguro');
  const wild = fightWith('maguro');
  calm.burstT = 99;          // 暴れさせない
  wild.burstT = 0.001;       // すぐ暴れさせる
  calm.setReeling(true);
  wild.setReeling(true);
  calm.update(0.3);
  wild.update(0.3);
  assert.ok(wild.tension > calm.tension * 1.5, `${wild.tension} vs ${calm.tension}`);
});

test('釣り: フレームレートが違っても結果が変わらない', () => {
  // 同じ遊びかたを 60fps と 12fps で回して、同じところへ着く。
  // dt をそのまま使うと、粗い刻みでは張りが 1 を飛び越して切れてしまう。
  const play = (x) => x.tension < 0.7;
  for (const seed of [11, 12, 13]) {
    const a = toFight(seed);
    const b = toFight(seed);
    run(a, 90, 1 / 60, play);
    run(b, 90, 1 / 12, play);
    assert.equal(b.phase, a.phase, `seed ${seed}`);
    assert.equal(b.fish.id, a.fish.id);
  }
});

test('釣り: 長い dt を渡しても飛ばない(タブ復帰)', () => {
  const f = fightWith('maguro');
  f.setReeling(true);
  f.update(10);   // 10秒ぶんを一気に
  // MAX_DT を超えるぶんは捨てるので、1回では切れきらない
  assert.ok(f.tension <= 1);
  const t = f.tension;
  assert.ok(t > 0 && t <= MAX_DT * 1.5, `張り ${t}`);
});

test('釣り: 大物ほど引きが強い', () => {
  const small = new Fishing(1);
  const big = new Fishing(1);
  for (const f of [small, big]) {
    f.fish = FISH_BY_ID.buri;
    f.phase = 'fight';
    f.burstT = 99;   // 暴れは挟ませない
  }
  small.cm = small.fish.cm[0];
  big.cm = big.fish.cm[1];
  small.setReeling(true);
  big.setReeling(true);
  small.update(0.2);
  big.update(0.2);
  assert.ok(big.tension > small.tension, `${big.tension} > ${small.tension}`);
  // 巻き上げの速さは大きさで変えない。引きと手間の両方を伸ばすと効きが
  // 掛け算になり、大物の勝負が何十秒にもなってしまう(長さは stamina だけで決める)。
  assert.equal(big.progress, small.progress);
});

test('釣り: reset で次を投げられる', () => {
  const f = fightWith('maguro');
  run(f, 60, 1 / 60, true);
  assert.equal(f.phase, 'lost');
  f.reset();
  assert.equal(f.phase, 'idle');
  assert.ok(f.cast());
});

test('釣り: view は画面に必要なものを 0〜1 で返す', () => {
  const f = toFight(3);
  f.setReeling(true);
  f.update(0.3);
  const v = f.view();
  assert.equal(v.phase, 'fight');
  for (const k of ['tension', 'progress', 'hook']) {
    assert.ok(v[k] >= 0 && v[k] <= 1, `${k} = ${v[k]}`);
  }
  assert.equal(v.fish.id, f.fish.id);
});

// ---- 図鑑 ----

test('図鑑: 初めての魚と自己記録が分かる', () => {
  let p = emptyProgress();
  let r = addCatch(p, 'aji', 20, 100);
  assert.ok(r.isNew && r.isRecord);
  p = r.progress;
  assert.deepEqual(p.fish.aji, { n: 1, best: 20, at: 100 });

  r = addCatch(p, 'aji', 15, 200);   // 小さいので記録は伸びない
  assert.ok(!r.isNew && !r.isRecord);
  p = r.progress;
  assert.deepEqual(p.fish.aji, { n: 2, best: 20, at: 100 });

  r = addCatch(p, 'aji', 28, 300);
  assert.ok(!r.isNew && r.isRecord);
  assert.deepEqual(r.progress.fish.aji, { n: 3, best: 28, at: 300 });
});

test('図鑑: 元の progress を書き換えない', () => {
  const p = emptyProgress();
  addCatch(p, 'aji', 20);
  assert.deepEqual(p.fish, {});
});

test('図鑑: 種類数と総匹数を数える', () => {
  let p = emptyProgress();
  for (const [id, cm] of [['aji', 20], ['aji', 22], ['saba', 30]]) {
    p = addCatch(p, id, cm).progress;
  }
  assert.deepEqual(fishbookCount(p, FISH.length), { got: 2, total: FISH.length, caught: 3 });
});

test('図鑑: 釣り図鑑が無い古い保存でも読める', () => {
  const old = JSON.stringify({ v: 1, games: [], achievements: {}, title: null });
  const p = parseProgress(old);
  assert.deepEqual(p.fish, {});
  assert.ok(addCatch(p, 'aji', 20).isNew);
});

// ---- 釣り場(港)----

test('釣り場: どのモードでも、港の数だけ釣り場ができる', () => {
  for (const mode of ['base', 'cak', 'dragon', 'fish', 'sea']) {
    const s = createGame({ seed: 7, playerCount: 4, humanIndex: 0, mode });
    const spots = fishingSpots(s);
    assert.equal(spots.length, s.board.ports.length, mode);
    for (const p of spots) assert.ok(PORT_TYPES.includes(p.type), `${mode}: ${p.type}`);
  }
});

test('釣り場: 立つ場所は陸の上で、向いた先は海', () => {
  for (const mode of ['base', 'cak', 'dragon', 'fish', 'sea']) {
    const s = createGame({ seed: 3, playerCount: 4, humanIndex: 0, mode });
    const ground = makeGround(s);
    for (const p of fishingSpots(s)) {
      assert.ok(ground(p.x, p.z).ok, `${mode} の ${p.edgeId} に立てない`);
      // 沖へ半歩出たら、そこはもう歩けない(= 海)
      const ahead = ground(p.x + p.outX * 0.35, p.z + p.outZ * 0.35);
      assert.equal(ahead.ok, false, `${mode} の ${p.edgeId} の先が陸`);
      // 向きは長さ1
      assert.ok(Math.abs(Math.hypot(p.outX, p.outZ) - 1) < 1e-9);
    }
  }
});

test('釣り場: 近づいたときだけ見つかる', () => {
  const s = createGame({ seed: 5, playerCount: 4, humanIndex: 0, mode: 'base' });
  const spots = fishingSpots(s);
  const p = spots[0];
  assert.equal(spotNear(spots, p.x, p.z), p);
  assert.equal(spotNear(spots, p.x, p.z, SPOT_RADIUS), p);
  // 範囲のすぐ外に出れば外れる(他の港に近づいてしまわない向きを選ぶ)
  const away = [[1, 0], [-1, 0], [0, 1], [0, -1]]
    .map(([dx, dz]) => ({
      x: p.x + dx * SPOT_RADIUS * 1.2, z: p.z + dz * SPOT_RADIUS * 1.2,
    }))
    .find((q) => spots.every((s) => Math.hypot(s.x - q.x, s.z - q.z) > SPOT_RADIUS));
  assert.ok(away, '範囲外の点が見つからない');
  assert.equal(spotNear(spots, away.x, away.z), null);
});

test('釣り場: 島の真ん中では釣れない', () => {
  const s = createGame({ seed: 5, playerCount: 4, humanIndex: 0, mode: 'base' });
  const spots = fishingSpots(s);
  const home = spawnPoint(s);
  assert.equal(spotNear(spots, home.x, home.y), null);
});
