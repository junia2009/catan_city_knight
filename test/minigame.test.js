// ミニゲーム「島を歩く」の地面判定。
//
// 盤の幾何を1つ間違えると、海の上を歩けたり島の真ん中に穴が空いたりする。
// 描画を見ただけでは気づきにくいので、ここで数値として押さえる。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createGame } from '../src/state.js';
import { LAYOUT } from '../src/rules/board.js';
import { isLandHex } from '../src/rules/sea.js';
import { makeGround, spawnPoint } from '../src/minigame/ground.js';
import { WalkerMotion, WALK_SPEED, JUMP_HEIGHT, WATER_Y } from '../src/minigame/motion.js';
import { makeBlocker, WALKER_RADIUS } from '../src/minigame/obstacles.js';
import {
  SEAT_R, SPAWN_RING, TABLE_CLEAR, TABLE_RADIUS, TABLE_REACH, tableSeats,
} from '../src/minigame/ground.js';
import {
  walkPose, airPose, tumblePose, sinkPose, fishPose, aimPose, sitPose, emotePose,
  blendPose, poseKeys,
} from '../src/minigame/pose.js';
import { EMOTES, EMOTE_MAX, emoteById, emotesOk } from '../src/minigame/emote.js';

const MODES = ['base', 'cak', 'dragon', 'fish', 'sea'];

function game(mode) {
  return createGame({ seed: 7, playerCount: 4, humanIndex: 0, mode });
}

function hexCenter(hid) {
  let x = 0;
  let y = 0;
  for (const vid of LAYOUT.hexVertices[hid]) {
    x += LAYOUT.vertices[vid].x;
    y += LAYOUT.vertices[vid].y;
  }
  return { x: x / 6, y: y / 6 };
}

test('walk: ヘックスの中心には必ず立てる(島に穴が空いていない)', () => {
  for (const mode of MODES) {
    const s = game(mode);
    const g = makeGround(s);
    for (const hid of s.board.hexIds) {
      if (mode === 'sea' && !isLandHex(s.board, hid)) continue;
      const c = hexCenter(hid);
      const at = g(c.x, c.y);
      assert.ok(at.ok, `${mode}: ${hid} の中心に立てない`);
      assert.equal(at.hexId, hid, `${mode}: ${hid} の中心が別のヘックス扱い`);
    }
  }
});

test('walk: 隣り合うヘックスの境目にも立てる(継ぎ目に落ちない)', () => {
  const s = game('base');
  const g = makeGround(s);
  const ids = s.board.hexIds;
  let checked = 0;
  for (const hid of ids) {
    const a = hexCenter(hid);
    for (const other of ids) {
      if (other === hid) continue;
      const b = hexCenter(other);
      const d = Math.hypot(a.x - b.x, a.y - b.y);
      // 外接円半径が 1.0 なので、隣り合うヘックスの中心間は √3 ≒ 1.732
      if (d > 1.8) continue;
      const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
      assert.ok(g(mid.x, mid.y).ok, `${hid}-${other} の境目に立てない`);
      checked++;
    }
  }
  assert.ok(checked > 20, `隣接の検査が少なすぎる(${checked}組)`);
});

test('walk: 島から十分離れた海の上には立てない', () => {
  for (const mode of MODES) {
    const s = game(mode);
    const g = makeGround(s);
    // 盤のどのヘックス中心からも遠い点は、必ず「歩けない」
    // 盤は最大でも半径4(中心間 1.732 × 4 ≒ 7)なので、20 は確実に外
    const far = [[0, 20], [20, 0], [-20, -20], [0, -20]];
    for (const [x, z] of far) {
      assert.equal(g(x, z).ok, false, `${mode}: (${x},${z}) に立ててしまう`);
    }
  }
});

test('walk: 航海者たちでは海のヘックスに立てない(陸だけ歩ける)', () => {
  const s = game('sea');
  const g = makeGround(s);
  let seaHexes = 0;
  for (const hid of s.board.hexIds) {
    if (isLandHex(s.board, hid)) continue;
    seaHexes++;
    const c = hexCenter(hid);
    assert.equal(g(c.x, c.y).ok, false, `海のヘックス ${hid} に立ててしまう`);
  }
  assert.ok(seaHexes > 10, `海のヘックスが少なすぎる(${seaHexes})`);
});

test('walk: 開始地点は必ず陸の上', () => {
  for (const mode of MODES) {
    const s = game(mode);
    const g = makeGround(s);
    const p = spawnPoint(s);
    assert.ok(g(p.x, p.y).ok, `${mode}: 開始地点が陸でない`);
  }
});

test('walk: 散策部屋の開始地点は席ごとに離れていて、どれも陸の上', () => {
  for (const mode of MODES) {
    const s = game(mode);
    const g = makeGround(s);
    const seen = [];
    for (let seat = 0; seat < 8; seat += 1) {
      const p = spawnPoint(s, seat);
      assert.ok(g(p.x, p.y).ok, `${mode}: 席 ${seat} の開始地点が陸でない`);
      for (const q of seen) {
        const d = Math.hypot(p.x - q.x, p.y - q.y);
        // 「離れている」は棒人間の太さに対しての話。絶対値で書くと、
        // 縮尺(scale.js)を変えたときに中身は正しいのにここだけ落ちる。
        const min = WALKER_RADIUS * 3;
        assert.ok(d > min, `${mode}: 席が近すぎる(${d.toFixed(2)} ≦ ${min.toFixed(2)})`);
      }
      seen.push(p);
    }
  }
});

test('walk: 席を渡さなければ今までどおり中央から', () => {
  const s = game('base');
  const a = spawnPoint(s);
  const b = spawnPoint(s, null);
  assert.deepEqual(a, b);
  // 席ありは必ず中央からずれる(ずらし忘れの検出)
  assert.notDeepEqual(spawnPoint(s, 0), a);
});

// 地面は平らではない ── タイル上面の上に地形の起伏と数字トークンが載っていて、
// 歩く側はその**見えている面**に立つ(terrain.js)。
// 平らな上面に立たせていたころは、盛り上がったところで足が埋まっていた。
test('walk: 立つ高さは、描いてある地面の高さ', async () => {
  const { TILE_TOP, surfaceHeight, tokenRadius, tokenTop } = await import('../src/terrain.js');
  const s = game('base');
  const g = makeGround(s);
  const tk = { r: tokenRadius(s.board), top: tokenTop(s.board) };
  let bumpy = 0;
  for (const hid of s.board.hexIds) {
    const c = hexCenter(hid);
    for (const [dx, dz] of [[0, 0], [0.3, 0], [-0.3, 0.2], [0.15, -0.45], [0.5, 0.5]]) {
      const x = c.x + dx;
      const z = c.y + dz;
      const got = g(x, z);
      if (!got.ok) continue;
      const want = TILE_TOP + surfaceHeight(s.board, got.hexId, x, z, tk);
      assert.ok(Math.abs(got.y - want) < 1e-12,
        `${hid} (${dx},${dz}): 足の高さ ${got.y} と地面 ${want} が違う`);
      if (got.y > TILE_TOP + 0.005) bumpy += 1;
    }
  }
  // 起伏がまったく無いなら、そもそも一致を見る意味がない(平らに戻っている)
  assert.ok(bumpy > 10, `地面がどこも平ら(${bumpy} か所しか盛り上がっていない)`);
});

// 数字トークンは厚み 0.05 の円盤。**その上に立つ。**
// 見ていなかったころは、円盤の真ん中に立つと膝まで潜っていた(実機で報告された)。
test('walk: 数字トークンの上では、円盤の上に立つ', async () => {
  const { TILE_TOP, TOKEN_H } = await import('../src/terrain.js');
  const s = game('base');
  const g = makeGround(s);
  const withToken = s.board.hexIds.filter((h) => s.board.hexes[h].token);
  assert.ok(withToken.length > 5, '数字トークンのあるヘックスが少なすぎる');
  for (const hid of withToken) {
    const c = hexCenter(hid);
    assert.equal(g(c.x, c.y).y, TILE_TOP + TOKEN_H, `${hid}: トークンに潜っている`);
  }
});

// 盤の上の物への当たり判定。すり抜けるとゲームとして目に見えて壊れて見える
// (実際に盗賊を貫通した状態で出してしまった)。
test('walk: 障害物にめり込まない', () => {
  const block = makeBlocker([{ x: 0, z: 0, r: 0.25 }]);
  const need = 0.25 + WALKER_RADIUS;

  // 正面から突っ込む
  const head = block(-1, 0, 0.05, 0);
  assert.equal(head.hit, true, '重なっているのに hit でない');
  assert.ok(Math.hypot(head.x, head.z) >= need - 1e-9, `めり込んでいる(${Math.hypot(head.x, head.z)})`);

  // 触れていなければ動かさない(端から落ちる挙動を邪魔しない)
  const clear = block(-1, 0, -0.9, 0);
  assert.equal(clear.hit, false, '触れていないのに hit');
});

test('walk: 障害物に当たっても横には進める(滑る)', () => {
  const block = makeBlocker([{ x: 0, z: 0, r: 0.25 }]);
  // 斜めに当てる。押し出されても、進みたかった横方向には出ている
  const r = block(-0.5, -0.5, -0.2, -0.2);
  assert.equal(r.hit, true);
  assert.ok(r.x > -0.5 && r.z > -0.5, `横に進めていない (${r.x}, ${r.z})`);
});

test('walk: 障害物に挟まれても、どれにもめり込まない', () => {
  const obs = [
    { x: 0, z: 0, r: 0.2 },
    { x: 0.5, z: 0, r: 0.2 },
    { x: 0.25, z: 0.45, r: 0.2 },
  ];
  const block = makeBlocker(obs);
  // 3つの真ん中(隙間)へ押し込む
  const r = block(0.25, -1, 0.25, 0.15);
  for (const o of obs) {
    const d = Math.hypot(r.x - o.x, r.z - o.z);
    assert.ok(d >= o.r + WALKER_RADIUS - 1e-6, `(${o.x},${o.z}) にめり込んでいる(${d.toFixed(3)})`);
  }
});

// 押し出しは位置を直すだけなので、1フレームの移動量が障害物の直径より
// 大きいとすり抜ける。実際の値がそうなっていないことを数字で押さえる。
test('walk: 1フレームの移動量が、いちばん小さい障害物より小さい', () => {
  const perFrame = WALK_SPEED * 0.05; // 速さ × 刻みの上限
  const smallest = (0.09 + WALKER_RADIUS) * 2; // 実測でいちばん細い木 + 棒人間
  assert.ok(perFrame < smallest, `すり抜けうる(1フレーム ${perFrame} / 直径 ${smallest}`);
});

test('walk: 盤の上の物を通り抜けられない(歩き続けても中に入らない)', () => {
  const s = game('base');
  const ground = makeGround(s);
  const start = spawnPoint(s);
  // 進行方向の少し先に障害物を置く
  const o = { x: start.x, z: start.y + 0.5, r: 0.25 };
  const w = new WalkerMotion(ground, makeBlocker([o]));
  w.setPosition(start.x, start.y);

  let closest = Infinity;
  for (let i = 0; i < 120; i++) {
    w.update(1 / 60, { x: 0, y: 1 }, 0);
    closest = Math.min(closest, Math.hypot(w.pos.x - o.x, w.pos.z - o.z));
  }
  assert.ok(closest >= o.r + WALKER_RADIUS - 1e-6, `中に入った(最接近 ${closest.toFixed(3)})`);
  assert.ok(w.pos.z > start.y, '障害物の手前まで進んでいない');
});

// 目標へまっすぐ倒し続ける。たどり着けたら経過秒、駄目なら止まった場所。
// 入力の x は**画面の右** = 世界の -X(motion.js の _step)。ここを取り違えると
// 障害物を避けたのではなく逃げているだけ、という結果になる。
function walkTo(obs, from, to, ground = () => ({ y: 0, ok: true }), seconds = 12) {
  const w = new WalkerMotion(ground, makeBlocker(obs));
  w.setPosition(from.x, from.z);
  const dt = 1 / 60;
  for (let i = 0; i < seconds / dt; i++) {
    const dx = to.x - w.pos.x;
    const dz = to.z - w.pos.z;
    const d = Math.hypot(dx, dz);
    if (d < 0.08) return { ok: true, t: i * dt };
    w.update(dt, { x: -dx / d, y: dz / d }, 0);
  }
  return { ok: false, x: w.pos.x, z: w.pos.z, speed: Math.hypot(w.vel.x, w.vel.z) };
}

// 丸い岩に**正面から**当たると接線の成分が 0 になり、押し出しと打ち消しが
// 釣り合って、スティックを倒し続けても速さ 0 のまま貼りついていた
// (竜の巣の山へ登れないことがあったのはこれ。人は少し首を振れば抜けられるが、
//  「押しているのに動かない」は壊れて見える)。
test('walk: 岩の正面から押しても貼りつかず、回り込んで向こうへ行ける', () => {
  const r = walkTo([{ x: 0, z: 0, r: 0.25, h: 1 }], { x: 0, z: -1.2 }, { x: 0, z: 1.2 });
  assert.ok(r.ok, `岩の正面で嵌まった(${JSON.stringify(r)})`);
});

test('walk: 岩が3つ並んだ谷でも、押し続ければ抜けられる', () => {
  const obs = [
    { x: -0.7, z: 0.35, r: 0.3, h: 1 },
    { x: 0.7, z: 0.35, r: 0.3, h: 1 },
    { x: 0, z: 0.9, r: 0.3, h: 1 },   // 正面をふさぐ1つ
  ];
  const r = walkTo(obs, { x: 0, z: -1.2 }, { x: 0, z: 2.0 });
  assert.ok(r.ok, `谷で嵌まった(${JSON.stringify(r)})`);
});

// 回り込ませるといっても、通れない隙間を通してはいけない。
// 棒人間の直径より狭い所へは、これまでどおり入れないままであること。
test('walk: 体より狭い隙間はすり抜けない', () => {
  const gap = WALKER_RADIUS * 2 * 0.8;  // 体より2割狭い
  const half = 0.25 + gap / 2;
  const obs = [{ x: -half, z: 0, r: 0.25, h: 1 }, { x: half, z: 0, r: 0.25, h: 1 }];
  const r = walkTo(obs, { x: 0, z: -1.2 }, { x: 0, z: 1.2 });
  assert.ok(!r.ok, '体より狭い隙間を通り抜けた');
  assert.ok(r.z < 0, `岩の向こう側へ出ている(z ${r.z})`);
});

// 岩が寄り集まった所へ入り込むと、順に押し出しても押し出しきれず、
// 「まだ物の中」という答えが返っていた ── 出られないまま、毎フレーム
// 中で押し合いになる。1つずつの縁を候補にして、触れない点へ逃がすこと。
// (配置は実際の島から取り出したものではなく、総当たりで見つけた最小の形)
test('walk: 岩が寄り集まった中に入り込んでも、触れない場所へ出してくれる', () => {
  const obs = [
    { x: -0.234, z: -0.072, r: 0.242, h: 1 },
    { x: -0.434, z: 0.425, r: 0.171, h: 1 },
    { x: 0.221, z: 0.154, r: 0.284, h: 1 },
  ];
  const block = makeBlocker(obs);
  const step = 0.016;
  for (let i = 0; i < 16; i++) {
    const a = (i / 16) * Math.PI * 2;
    const r = block(0, 0, Math.sin(a) * step, Math.cos(a) * step, WALKER_RADIUS, 0);
    const inside = obs.find((o) => Math.hypot(r.x - o.x, r.z - o.z) < o.r + WALKER_RADIUS - 1e-6);
    assert.ok(!inside, `物の中に押し出された(向き ${a.toFixed(2)} → ${r.x.toFixed(3)}, ${r.z.toFixed(3)})`);
  }
});

test('walk: 体より広い隙間はこれまでどおり通れる', () => {
  const gap = WALKER_RADIUS * 2 * 1.2;
  const half = 0.25 + gap / 2;
  const obs = [{ x: -half, z: 0, r: 0.25, h: 1 }, { x: half, z: 0, r: 0.25, h: 1 }];
  assert.ok(walkTo(obs, { x: 0, z: -1.2 }, { x: 0, z: 1.2 }).ok, '通れるはずの隙間で嵌まった');
});

test('walk: 島の端を踏み外すと落ち、直前の足場に戻る', () => {
  const s = game('base');
  const ground = makeGround(s);
  const start = spawnPoint(s);
  const w = new WalkerMotion(ground);
  w.setPosition(start.x, start.y);

  // 一方向に歩き続ければ、いずれ島の端から海へ出る
  let fell = false;
  let back = null;
  for (let i = 0; i < 2000; i++) {
    const r = w.update(1 / 60, { x: 0, y: 1 }, 0);
    if (r.falling) fell = true;
    if (r.respawned) { back = { x: w.pos.x, z: w.pos.z }; break; }
  }

  assert.ok(fell, '端まで歩いても落ちない');
  assert.ok(back, '落ちたまま戻ってこない');
  assert.ok(ground(back.x, back.z).ok, '復帰先が陸でない');
  assert.equal(w.falling, false, '復帰後も落下中のまま');
});

// ---- ジャンプ ----

// 平らな地面で跳ばせて、高さの推移を記録する
function jumpRun(frames = 120, opts = {}) {
  const s = game('base');
  const ground = makeGround(s);
  const start = spawnPoint(s);
  const w = new WalkerMotion(ground, opts.block ?? null);
  w.setPosition(start.x, start.y);
  const ys = [];
  const events = [];
  for (let i = 0; i < frames; i++) {
    if (opts.jumpAt?.includes(i)) w.jump();
    const r = w.update(1 / 60, opts.input ?? { x: 0, y: 0 }, 0);
    ys.push(w.y);
    if (r.jumped) events.push(['jumped', i]);
    if (r.landed) events.push(['landed', i]);
  }
  return { w, ys, events, start };
}

test('walk: ジャンプの高さと滞空時間が狙いどおり', () => {
  const { ys, events } = jumpRun(120, { jumpAt: [0] });
  const apex = Math.max(...ys);
  assert.ok(Math.abs(apex - JUMP_HEIGHT) < 0.03, `頂点がずれている(${apex.toFixed(3)})`);

  const jumped = events.find((e) => e[0] === 'jumped');
  const landed = events.find((e) => e[0] === 'landed');
  assert.ok(jumped && landed, `踏み切り/着地が出ていない(${JSON.stringify(events)})`);
  const air = (landed[1] - jumped[1]) / 60;
  assert.ok(Math.abs(air - 0.8) < 0.06, `滞空時間がずれている(${air.toFixed(2)}秒)`);
});

test('walk: 着地したら高さが 0 に戻る', () => {
  const { w, ys } = jumpRun(120, { jumpAt: [0] });
  assert.equal(w.grounded, true, '着地していない');
  assert.equal(w.y, 0, `着地後に浮いている(${w.y})`);
  assert.ok(ys.every((y) => y <= JUMP_HEIGHT + 0.01), '狙いより高く跳んでいる');
});

test('walk: 空中では二段ジャンプできない', () => {
  // 踏み切った直後に何度も押しても、高さは1回ぶんのまま
  const spam = Array.from({ length: 60 }, (_, i) => i);
  const { ys, events } = jumpRun(120, { jumpAt: spam });
  const apex = Math.max(...ys);
  assert.ok(apex < JUMP_HEIGHT + 0.03, `連打で高く跳べてしまう(${apex.toFixed(3)})`);
  // 1回の跳躍あたり踏み切りは1回(着地後にまた跳ぶのは正しい)
  const jumps = events.filter((e) => e[0] === 'jumped').length;
  const lands = events.filter((e) => e[0] === 'landed').length;
  assert.equal(jumps, lands + (jumps > lands ? 1 : 0), '踏み切りと着地の数が合わない');
  assert.ok(jumps <= 2, `120フレームで跳びすぎ(${jumps}回)`);
});

test('walk: 押しっぱなしでは跳び続けない(押した瞬間だけ)', () => {
  // jump() を1回だけ呼び、あとは呼ばない = 押しっぱなし相当
  const { events } = jumpRun(200, { jumpAt: [0] });
  assert.equal(events.filter((e) => e[0] === 'jumped').length, 1);
});

test('walk: 低い物は跳び越えられ、高い物は跳んでも越えられない', () => {
  const s = game('base');
  const ground = makeGround(s);
  const start = spawnPoint(s);

  // 距離も高さも「跳べる高さ・自分の太さ」に対しての比で書く。
  // 絶対値で書くと、縮尺(scale.js)を変えたときに中身は正しいのに落ちる。
  // 見るのは「**真上を通って**向こう側へ出たか」。単に z が向こうへ行ったかで
  // 見ると、脇へ回り込んだだけ(obstacles.js の SLIDE_ROUND)でも越えたことに
  // なってしまう ── 越えたのなら、物の幅の中を通っているはず。
  const tryPass = (h) => {
    const o = { x: start.x, z: start.y + JUMP_HEIGHT * 1.6, r: WALKER_RADIUS * 2, h };
    const w = new WalkerMotion(ground, makeBlocker([o]));
    w.setPosition(start.x, start.y);
    let over = false;
    for (let i = 0; i < 200; i++) {
      // 障害物の手前で踏み切る
      if (Math.abs(w.pos.z - (o.z - JUMP_HEIGHT * 1.1)) < 0.03 && w.grounded) w.jump();
      w.update(1 / 60, { x: 0, y: 1 }, 0);
      if (w.pos.z > o.z + o.r && Math.abs(w.pos.x - o.x) < o.r) over = true;
    }
    return over;
  };

  assert.equal(tryPass(JUMP_HEIGHT * 0.4), true, '低い物を跳び越えられない');
  assert.equal(tryPass(JUMP_HEIGHT * 2.4), false, '高い物を跳んで通り抜けてしまう');
});

// フレームが出ない端末でも同じ速さで動くこと。
// 長い dt をただ切り詰めていた頃は、10fps だと全部がスローモーションになり、
// ジャンプの滞空だけ妙に長い、という状態だった。
test('walk: フレームレートが変わっても、跳ぶ高さと進む距離は変わらない', () => {
  const s = game('base');
  const start = spawnPoint(s);

  const run = (fps) => {
    const w = new WalkerMotion(makeGround(s));
    w.setPosition(start.x, start.y);
    const dt = 1 / fps;
    w.jump();
    let apex = 0;
    let landedAt = null;
    // 実時間で 1.5 秒ぶん回す
    for (let t = 0; t < 1.5; t += dt) {
      const r = w.update(dt, { x: 0, y: 1 }, 0);
      apex = Math.max(apex, w.y);
      if (r.landed && landedAt == null) landedAt = t;
    }
    return { apex, landedAt, dist: Math.hypot(w.pos.x - start.x, w.pos.z - start.y) };
  };

  const fast = run(60);
  for (const fps of [30, 15, 8]) {
    const slow = run(fps);
    assert.ok(Math.abs(slow.apex - fast.apex) < 0.04,
      `${fps}fps で跳ぶ高さが違う(${slow.apex.toFixed(3)} / 60fps は ${fast.apex.toFixed(3)})`);
    assert.ok(Math.abs(slow.landedAt - fast.landedAt) < 0.15,
      `${fps}fps で着地の時刻が違う(${slow.landedAt?.toFixed(2)} / ${fast.landedAt?.toFixed(2)})`);
    assert.ok(Math.abs(slow.dist - fast.dist) < 0.2,
      `${fps}fps で進む距離が違う(${slow.dist.toFixed(2)} / ${fast.dist.toFixed(2)})`);
  }
});

test('walk: 崖から跳んでも海の上では跳び直せない', () => {
  const s = game('base');
  const ground = makeGround(s);
  const start = spawnPoint(s);
  const w = new WalkerMotion(ground);
  w.setPosition(start.x, start.y);

  // 端まで歩いて踏み外し、落ちている間ずっと跳ぼうとする
  let sawFall = false;
  let respawned = false;
  for (let i = 0; i < 3000; i++) {
    if (sawFall) w.jump();
    const r = w.update(1 / 60, { x: 0, y: 1 }, 0);
    if (r.falling) sawFall = true;
    if (r.respawned) { respawned = true; break; }
  }
  assert.ok(sawFall, '端から落ちていない');
  assert.ok(respawned, '跳び直して落下から抜け出せてしまった(復帰しない)');
});

// ---- 姿勢 ----

// 姿勢ごとに書く項目が違うと、前の姿勢の値が残って戻らなくなる。
// 実際、海から上がっても足が開いたまま(交差したまま)になっていた:
// 落下・水中の姿勢は足の開き rootZ を書くのに、歩く姿勢が書き戻していなかった。
test('walk: どの姿勢も同じ項目を全部返す(前の姿勢が残らない)', () => {
  const poses = {
    歩き: walkPose(1.2, 0.8, 0.3),
    空中: airPose(1.5, 0.3),
    落下: tumblePose(2.1, 0.3),
    水中: sinkPose(1.4, 0.3, 0.5),
    '釣り(待ち)': fishPose(1.1, 0.3, { phase: 'wait' }),
    '釣り(投げ)': fishPose(0.2, 0.3, { phase: 'cast', cast: 0.5 }),
    '釣り(アタリ)': fishPose(0.4, 0.3, { phase: 'bite' }),
    '釣り(勝負)': fishPose(2.2, 0.3, { phase: 'fight', tension: 0.6, reeling: true, burst: true }),
    '釣り(釣れた)': fishPose(0.7, 0.3, { phase: 'landed' }),
    '釣り(逃げられた)': fishPose(0.7, 0.3, { phase: 'lost' }),
    '釣り(既定)': fishPose(1, 0.3),
    // エモートは出入りで立ち姿と混ぜるので、途中と両端の3点を見る
    ...Object.fromEntries(EMOTES.flatMap((e) => [0.05, 0.5, 0.95].map((k) =>
      [`エモート(${e.label} ${k})`, emotePose(e.key, k * (e.ms / 1000), 0.3, k)]))),
    'エモート(知らない番号)': emotePose('???', 1, 0.3, 0.5),
    '弓を構える': aimPose(1.2, 0.3, 0.6),
    '円卓に座る': sitPose(1.2, 0.3),
  };
  const base = poseKeys(poses['歩き']);
  assert.ok(base.length > 20, `項目が少なすぎる(${base.length})`);
  for (const [name, pose] of Object.entries(poses)) {
    assert.deepEqual(poseKeys(pose), base, `${name} の姿勢だけ項目が違う`);
    // 中身が数値であること(undefined が入ると NaN になって手足が消える)
    for (const k of base) {
      const v = k.split(/[.[\]]+/).filter(Boolean)
        .reduce((o, part) => o[part], pose);
      assert.ok(Number.isFinite(v), `${name} の ${k} が数値でない(${v})`);
    }
  }
});

test('walk: 歩いている間は足を開かない', () => {
  for (const phase of [0, 0.7, 1.9, 3.4]) {
    for (const leg of walkPose(phase, 1, 0).legs) {
      assert.equal(leg.rootZ, 0, `歩きで足が開いている(${leg.rootZ})`);
    }
  }
});

// ---- 海に落ちる ----

// 端から歩いて落ち、戻ってくるまでを1回ぶん記録する
function fallRun() {
  const s = game('base');
  const ground = makeGround(s);
  const start = spawnPoint(s);
  const w = new WalkerMotion(ground);
  w.setPosition(start.x, start.y);

  const dt = 1 / 60;
  let t = 0;
  const log = { fallAt: null, splashAt: null, backAt: null, splashes: 0, entryVy: 0 };
  const sinkSpeeds = [];
  for (let i = 0; i < 60 * 40; i++) {
    const r = w.update(dt, { x: 0, y: 1 }, 0);
    t += dt;
    if (r.falling && log.fallAt == null) log.fallAt = t;
    if (r.splashed) { log.splashes++; log.splashAt = t; log.entryVy = w.vy; }
    if (r.inWater && r.sinkT > 0.8) sinkSpeeds.push(Math.abs(w.vy));
    if (r.respawned && log.fallAt != null) { log.backAt = t; break; }
  }
  return { w, log, sinkSpeeds, start };
}

test('walk: 海に落ちると着水し、ゆっくり沈んでから岸へ戻る', () => {
  const { w, log, start } = fallRun();

  assert.ok(log.fallAt != null, '端から落ちない');
  assert.ok(log.splashAt != null, '着水しない');
  assert.equal(log.splashes, 1, `着水の合図が ${log.splashes} 回出ている(1回のはず)`);
  assert.ok(log.backAt != null, '岸へ戻ってこない');

  // 戻り先は陸の上で、状態が綺麗に戻っていること
  assert.equal(w.grounded, true);
  assert.equal(w.inWater, false);
  assert.equal(w.y, 0);
  assert.equal(w.sinkT, 0);
  assert.ok(makeGround(game('base'))(w.pos.x, w.pos.z).ok, '戻り先が陸でない');
  assert.ok(Math.hypot(w.pos.x - start.x, w.pos.z - start.y) < 8, '戻り先が遠すぎる');
});

test('walk: 沈むのは「じっくり」── 落ちるより着水後のほうがずっと長い', () => {
  const { log } = fallRun();
  const air = log.splashAt - log.fallAt;
  const under = log.backAt - log.splashAt;
  assert.ok(under > 2.0, `沈む時間が短すぎる(${under.toFixed(2)}秒)`);
  assert.ok(under < 6.0, `沈む時間が長すぎる(${under.toFixed(2)}秒)`);
  assert.ok(under > air * 3, `落下 ${air.toFixed(2)}秒 に対し水中 ${under.toFixed(2)}秒 では短い`);
});

test('walk: 着水で勢いが殺され、沈む速さは一定に落ち着く', () => {
  const { log, sinkSpeeds } = fallRun();
  assert.ok(log.entryVy < -1, `着水時に落ちる勢いがない(${log.entryVy.toFixed(2)})`);
  assert.ok(sinkSpeeds.length > 30, '水中の記録が足りない');
  const fastest = Math.max(...sinkSpeeds);
  assert.ok(fastest < Math.abs(log.entryVy) * 0.6,
    `水中でも速すぎる(最速 ${fastest.toFixed(2)} / 着水時 ${Math.abs(log.entryVy).toFixed(2)})`);
  // 終端速度に落ち着く = ばらつきが小さい
  const spread = fastest - Math.min(...sinkSpeeds);
  assert.ok(spread < 0.25, `沈む速さが安定しない(幅 ${spread.toFixed(2)})`);
});

test('walk: 水面より上は空中、下は水中として扱われる', () => {
  const s = game('base');
  const ground = makeGround(s);
  const start = spawnPoint(s);
  const w = new WalkerMotion(ground);
  w.setPosition(start.x, start.y);
  for (let i = 0; i < 60 * 40; i++) {
    const r = w.update(1 / 60, { x: 0, y: 1 }, 0);
    if (!r.falling && !r.respawned) continue;
    if (r.respawned) break;
    // 落ちている間、水中かどうかは必ず水面の高さと一致する
    assert.equal(r.inWater, w.y <= WATER_Y,
      `y=${w.y.toFixed(2)} で inWater=${r.inWater}(水面は ${WATER_Y})`);
    if (r.inWater) assert.ok(r.depth >= 0, '深さが負');
  }
});

// 入力の向き。左右が反転していても盤面の判定は全部通るので、
// テストが無いと気づけない(実際に一度反転させたまま出してしまった)。
//
// カメラは walker の後ろ(-Z 側)から +Z を向いて置く。つまり
//   画面奥  = ( sin(camYaw),  cos(camYaw))
//   画面右  = (-cos(camYaw),  sin(camYaw))
// スティックを倒した向きへ、この基準で動くことを確かめる。
test('walk: スティックの向きと移動の向きが一致する(左右が反転しない)', () => {
  const s = game('base');
  const ground = makeGround(s);
  const start = spawnPoint(s);

  const run = (input, camYaw) => {
    const w = new WalkerMotion(ground);
    w.setPosition(start.x, start.y);
    for (let i = 0; i < 30; i++) w.update(1 / 60, input, camYaw);
    const dx = w.pos.x - start.x;
    const dz = w.pos.z - start.y;
    const fwd = { x: Math.sin(camYaw), z: Math.cos(camYaw) };
    const right = { x: -Math.cos(camYaw), z: Math.sin(camYaw) };
    return {
      screenX: dx * right.x + dz * right.z,
      screenDepth: dx * fwd.x + dz * fwd.z,
    };
  };

  // カメラの向きを変えても、スティックの向きと画面上の動きは一致する
  for (const camYaw of [0, Math.PI / 2, Math.PI, -Math.PI / 3]) {
    const label = `camYaw=${camYaw.toFixed(2)}`;
    const right = run({ x: 1, y: 0 }, camYaw);
    assert.ok(right.screenX > 0.05, `${label}: 右に倒したのに画面右へ行かない (${right.screenX.toFixed(3)})`);

    const left = run({ x: -1, y: 0 }, camYaw);
    assert.ok(left.screenX < -0.05, `${label}: 左に倒したのに画面左へ行かない (${left.screenX.toFixed(3)})`);

    const fwd = run({ x: 0, y: 1 }, camYaw);
    assert.ok(fwd.screenDepth > 0.05, `${label}: 前に倒したのに画面奥へ行かない (${fwd.screenDepth.toFixed(3)})`);

    const back = run({ x: 0, y: -1 }, camYaw);
    assert.ok(back.screenDepth < -0.05, `${label}: 後に倒したのに手前へ来ない (${back.screenDepth.toFixed(3)})`);
  }
});

// ---- エモート ----

// 番号は通信に乗る。並べ替えたり間に挿したりすると、相手が古い版を開いている
// あいだ「手をふったつもりがしょんぼりする」。番号と中身の対応を固定する。
test('emote: 番号と中身の対応が変わっていない', () => {
  assert.ok(emotesOk(), '一覧と EMOTE_MAX がずれている');
  assert.deepEqual(
    EMOTES.map((e) => `${e.id}:${e.key}`),
    ['1:wave', '2:cheer', '3:bow', '4:point', '5:sad'],
  );
  assert.equal(EMOTES.length, EMOTE_MAX);
  for (const e of EMOTES) assert.equal(emoteById(e.id), e);
  // 範囲外・でたらめは null(壊れた値が届いても姿勢を作らない)
  for (const bad of [0, -1, EMOTE_MAX + 1, null, undefined, '1']) {
    assert.equal(emoteById(bad), null, `${bad} で中身が返ってきた`);
  }
});

test('emote: blendPose は端で元の姿勢そのもの', () => {
  // 向きを変えて呼ぶ。同じ向き同士だと group.y の扱いを見落とす
  const a = walkPose(1.2, 0.8, 0.3);
  const b = fishPose(1.1, -2.0, { phase: 'fight', tension: 0.6 });
  // 向き(group.y)だけは混ぜない約束なので、比較から外して見る
  const noFacing = (p) => ({ ...p, group: { ...p.group, y: null } });
  assert.deepEqual(noFacing(blendPose(a, b, 0)), noFacing(a), 'k=0 で a に戻らない');
  assert.deepEqual(noFacing(blendPose(a, b, 1)), noFacing(b), 'k=1 で b にならない');
  // 範囲外は端で止める(NaN や行き過ぎた角度を作らない)
  assert.deepEqual(noFacing(blendPose(a, b, -5)), noFacing(a));
  assert.deepEqual(noFacing(blendPose(a, b, 9)), noFacing(b));
  // 向きは常に b のものを通す(-π..π をまたぐ回り込みで暴れさせない)
  for (const k of [0, 0.5, 1]) assert.equal(blendPose(a, b, k).group.y, b.group.y);
  // 途中はどちらとも違い、あいだにある
  const mid = blendPose(a, b, 0.5);
  const x = (p) => p.arms[1].rootX;
  assert.ok(x(mid) > Math.min(x(a), x(b)) && x(mid) < Math.max(x(a), x(b)),
    'あいだの値になっていない');
});

// 立ち姿から急に万歳の角度へ飛ぶと、1フレームで腕がワープして見える。
test('emote: 始めと終わりは立ち姿に近く、途中はしっかり動いている', () => {
  // 立ち姿は「進み具合 0」で得られる(混ぜる重みが 0 になる)
  const stand = emotePose('wave', 0, 0.3, 0);
  for (const e of EMOTES) {
    const at = (k) => emotePose(e.key, k * (e.ms / 1000), 0.3, k);
    const far = (p) => Math.max(...[0, 1].flatMap((i) => [
      Math.abs(p.arms[i].rootX - stand.arms[i].rootX),
      Math.abs(p.legs[i].rootX - stand.legs[i].rootX),
    ]).concat([Math.abs(p.hips.x - stand.hips.x), Math.abs(p.head.x - stand.head.x)]));

    assert.ok(far(at(0.01)) < 0.25, `${e.label}: 出はじめで飛んでいる(${far(at(0.01)).toFixed(2)})`);
    assert.ok(far(at(0.99)) < 0.25, `${e.label}: 終わりで飛んでいる(${far(at(0.99)).toFixed(2)})`);
    // 途中のどこかで、はっきり分かるだけ動いていること
    const peak = Math.max(...[0.3, 0.45, 0.6].map((k) => far(at(k))));
    assert.ok(peak > 0.45, `${e.label}: 途中でも動いていない(${peak.toFixed(2)})`);
  }
});

test('emote: 向きはそのまま通る(混ぜて回り込まない)', () => {
  for (const facing of [0, 2.5, -2.5, Math.PI]) {
    for (const k of [0, 0.05, 0.5, 1]) {
      assert.equal(emotePose('cheer', 1, facing, k).group.y, facing,
        `k=${k} で向きが変わった`);
    }
  }
});

// 「しょんぼり」と「おじぎ」が同じに見える、という指摘から。
// どちらも腰から折っていたのが原因だった。
test('emote: しょんぼりとおじぎは別物(腰の折りかたで見分く)', () => {
  const bow = emoteById(3);
  const sad = emoteById(5);
  const deepest = (e, ch) => Math.max(...Array.from({ length: 21 }, (_, i) => {
    const k = i / 20;
    return emotePose(e.key, k * (e.ms / 1000), 0, k)[ch].x;
  }));
  // おじぎは腰から折る。しょんぼりは腰をほぼ曲げず、背中を丸める
  assert.ok(deepest(bow, 'hips') > 0.7, `おじぎが浅い(${deepest(bow, 'hips').toFixed(2)})`);
  assert.ok(deepest(sad, 'hips') < 0.2, `しょんぼりが腰から折れている(${deepest(sad, 'hips').toFixed(2)})`);
  assert.ok(deepest(sad, 'chest') > deepest(bow, 'chest') * 1.5,
    'しょんぼりのほうが背中を丸めていない');
});

test('emote: しょんぼりは首を左右に振る(おじぎは振らない)', () => {
  const yOf = (e, n) => Array.from({ length: n }, (_, i) => {
    const k = (i + 0.5) / n;
    return emotePose(e.key, k * (e.ms / 1000), 0, k).head.y;
  });
  const sad = yOf(emoteById(5), 60);
  assert.ok(Math.max(...sad) > 0.15 && Math.min(...sad) < -0.15,
    `左右に振れていない(${Math.min(...sad).toFixed(2)}〜${Math.max(...sad).toFixed(2)})`);
  // 向きが変わる回数。1往復はしていること(振っている、と分かる速さか)
  const turns = sad.slice(1).filter((v, i) => Math.sign(v) !== Math.sign(sad[i])).length;
  assert.ok(turns >= 2, `振りが遅すぎる(向きが変わった回数 ${turns})`);

  const bow = yOf(emoteById(3), 40);
  assert.ok(Math.max(...bow.map(Math.abs)) < 1e-9, 'おじぎで首が振れている');
});

// 頭は丸い球で、しかも回転の軸の上に載っている。首をひねっても、後ろから
// 見ると輪郭が1ピクセルも動かない ── 実際「全然振っているように見えない」
// と言われた。体ごとひねり、上体を左右に倒すことで初めて見える。
test('emote: しょんぼりは体ごとひねり、上体を左右に倒す(後ろからも見える)', () => {
  const e = emoteById(5);
  const at = (k) => emotePose(e.key, k * (e.ms / 1000), 1.0, k);
  const ys = [];
  const zs = [];
  for (let i = 0; i < 60; i += 1) {
    const p = at((i + 0.5) / 60);
    ys.push(p.group.y - 1.0);   // facing からのずれ
    zs.push(p.chest.z);
  }
  assert.ok(Math.max(...ys) > 0.1 && Math.min(...ys) < -0.1,
    `体をひねっていない(${Math.min(...ys).toFixed(2)}〜${Math.max(...ys).toFixed(2)})`);
  assert.ok(Math.max(...zs) > 0.25 && Math.min(...zs) < -0.25,
    `上体を倒していない(${Math.min(...zs).toFixed(2)}〜${Math.max(...zs).toFixed(2)})`);
  // 倒れるのは上体だけ。腰まで倒すと足が地面から浮いて見える
  const hips = Array.from({ length: 60 }, (_, i) => Math.abs(at((i + 0.5) / 60).hips.z));
  assert.ok(Math.max(...hips) < 0.12, `腰まで倒れている(${Math.max(...hips).toFixed(2)})`);
});

// 円卓の寸法。**腰かけの輪 < 卓に届く距離 < 降り立つ輪** の順でないと、
// 席を立った人が卓から離れた扱いになるか、島に降りた瞬間からパネルが開く。
test('円卓: 届く距離は、腰かけの輪より外・降り立つ輪より内', () => {
  assert.ok(SEAT_R < TABLE_REACH, `腰かけ(${SEAT_R})が届く距離(${TABLE_REACH})より外`);
  assert.ok(TABLE_REACH < SPAWN_RING, `届く距離(${TABLE_REACH})が降り立つ輪(${SPAWN_RING})より外`);
  // 卓そのものにぶつかったまま席に立てること
  assert.ok(TABLE_RADIUS + WALKER_RADIUS < SEAT_R,
    `卓(${TABLE_RADIUS})にぶつかって席(${SEAT_R})に立てない`);
  // 片付ける広さは、席の輪をまるごと含むこと
  assert.ok(TABLE_CLEAR > SEAT_R, '席の輪の上に木が残る');
});

test('円卓: 席は輪の上に等間隔で、みんな卓のほうを向く', () => {
  for (const n of [2, 3, 4, 8]) {
    const spots = tableSeats({ x: 1, z: -2 }, n);
    assert.equal(spots.length, n);
    for (const p of spots) {
      assert.ok(Math.abs(Math.hypot(p.x - 1, p.z + 2) - SEAT_R) < 1e-9, '輪の上にない');
      // 向いた先へ少し進むと、卓の中心に近づく(輪の半径より小さく踏み出す)
      const step = SEAT_R * 0.1;
      const ahead = { x: p.x + Math.sin(p.face) * step, z: p.z + Math.cos(p.face) * step };
      assert.ok(Math.hypot(ahead.x - 1, ahead.z + 2) < Math.hypot(p.x - 1, p.z + 2) - step / 2,
        '卓のほうを向いていない');
    }
    // 席0は手前(-z)
    assert.ok(Math.abs(spots[0].x - 1) < 1e-9 && spots[0].z < -2, '席0が手前にない');
  }
});
