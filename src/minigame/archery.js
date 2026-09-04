// 蛮族を射る(都市と騎士の島)。進行の計算だけ。
//
// THREE も DOM も知らない。見た目は archery-fx.js、操作の受け口は walk-mode.js。
// 釣り(fishing.js)と同じ作りで、**この遊び専用のシード**を持つ ── 対戦の
// state.rng は絶対に回さないこと(オンライン対戦で全員の乱数列がずれる)。
//
// 遊びかた:
//   浜の物見の櫓に立つと弓を構える。沖から蛮族船が寄せてくる。
//   船を沈めれば積んでいる蛮族ごと止められる。取り逃がすと浜に降りて
//   櫓へ歩いてくるので、着かれる前に射る。3回着かれたら終わり。
//
// 高さの扱い:
//   撃つ人は**陸の上**(タイルの上面)、船は**海の上**。0.24 ほど下を撃つ
//   ことになるので、矢は水面まで落ちて当たる ── 崖の上から小舟を狙う形。
//   矢は地面より下へ行ったら消える。
//
// 距離と速さは**盤のタイル**で書く(縮尺は掛けない)。島の広さは盤で
// 決まっていて、船も浜も盤の寸法だから ── 人の寸法(scale.js)とは別。
// 弓を構える高さだけは人の寸法なので縮尺を掛ける。

import { rngNext } from '../rng.js';
import { s as sc } from './scale.js';

// この遊びが開く島。増やすときはここに足す(meets.js と同じ考え方で、
// 「どの島に何があるか」を1か所に置く)。
export const ARCHERY_MODES = ['cak'];

export const LIVES = 3;             // 櫓に着かれてよい回数

const SPAWN_D = 5.4;                // 沖のどれだけ先に湧くか(タイル)
const SPAWN_SIDE = 2.4;             // 左右のばらけ幅(±)
const LAND_D = 1.0;                 // ここまで来たら浜に着く
const CATCH_D = 0.55;               // 櫓にこれだけ寄られたら1回取られる
const SHIP_SPEED = 0.40;            // 船の速さ(タイル/秒)
const SHIP_SPEED_UP = 0.05;         // 波ごとに速くなる分
const FOE_SPEED = 0.52;             // 浜に降りた蛮族の速さ
const SHIP_R = 0.42;                // 当たり判定(横の半径)
const SHIP_H = 0.55;                // 帆までの高さ。これより上は素通り
const FOE_R = 0.17;
const FOE_H = 0.30;
const SHIP_GAP = 1.7;               // 船が湧く間隔(秒)
const WAVE_GAP = 3.0;               // 波と波の間

// 弓を構える高さ(足の裏から)。人の寸法なので縮尺を掛ける。
export const BOW_Y = sc(0.22);

// 矢。引き絞るほど速く飛ぶ(power 0〜1)。
//
// **重力は「どこまで届くか」を決めるために置いている。** 見た目に分かる
// ほど山なりにはしない ── 携帯の画面では上を向けないので、弧を描かせると
// 狙いようがなくなる。構えた高さから落ちきるまでの時間はほぼ一定なので、
// 引き絞った強さがそのまま飛距離になる:
//   弱い(0)  … 約 2.6 タイル。浜に降りた蛮族まで
//   満(1)   … 約 6.4 タイル。沖の船まで届く
// つまり「船を狙うなら引き絞る」。連打すると近くしか届かない。
export const ARROW_MIN = 6.0;       // タイル/秒
export const ARROW_MAX = 15.0;
export const ARROW_GRAVITY = 1.2;   // タイル/秒²
const ARROW_LIFE = 4.0;             // 落ちずに飛び続けたときの保険

export const SHIP_SCORE = 3;        // 船を沈める
export const FOE_SCORE = 1;         // 蛮族を1体

// フレームレートに依らないよう細かく刻む(motion.js と同じ考え方)。
// 1フレームで矢が船を飛び越すと、当たりを取りこぼす。
export const MAX_DT = 0.25;
const MAX_STEP = 1 / 60;

// 波ごとの船の数。1波目から的が多すぎると、狙う面白さの前に手が回らない。
export function shipsInWave(wave) {
  return 2 + Math.floor(wave / 2);
}

// 引き絞りの強さから、水平に撃ったときの飛距離。テストと調整のため
// (画面に出す「射程の輪」もこれを使う)。
export function reach(power, fromY, seaY = 0) {
  const drop = Math.max(0.02, fromY - seaY);
  const t = Math.sqrt((2 * drop) / ARROW_GRAVITY);
  const k = Math.max(0, Math.min(1, power));
  return (ARROW_MIN + (ARROW_MAX - ARROW_MIN) * k) * t;
}

export class Raid {
  // seed: この遊び専用の乱数
  // post: { x, z, y, outX, outZ } 櫓の位置・高さと、沖へ向かう向き(単位)
  // seaY: 水面の高さ。船はここに浮き、矢はここより下で消える
  constructor(seed, post, seaY = 0) {
    this.rng = seed >>> 0 || 1;
    this.post = post;
    this.seaY = seaY;
    // 岸に沿った向き(沖の向きを 90° 回したもの)。左右のばらけに使う
    this.sideX = post.outZ;
    this.sideZ = -post.outX;
    this.phase = 'running';   // running / over
    this.wave = 1;
    this.score = 0;
    this.lives = LIVES;
    this.shots = 0;           // 放った矢
    this.hits = 0;            // 当たった矢
    this.ships = [];
    this.foes = [];
    this.arrows = [];
    this.left = shipsInWave(1); // この波であと何隻湧くか
    this.next = 0.6;            // 次の船まで
    this._id = 0;
    // 直前に起きたこと(音や演出のため。takeEvents で読んだら消える)
    this.events = [];
  }

  get over() { return this.phase === 'over'; }
  // 当たった割合(まだ射っていなければ null)
  get accuracy() { return this.shots ? this.hits / this.shots : null; }

  _rand() {
    const [s, v] = rngNext(this.rng);
    this.rng = s;
    return v;
  }

  // 沖 d・横 o の点を世界の座標へ
  _at(d, o) {
    const p = this.post;
    return {
      x: p.x + p.outX * d + this.sideX * o,
      z: p.z + p.outZ * d + this.sideZ * o,
    };
  }

  // 櫓から見て「どれだけ沖にいるか」。浜へ着いたかの判定に使う
  _depth(e) {
    const p = this.post;
    return (e.x - p.x) * p.outX + (e.z - p.z) * p.outZ;
  }

  // 弓を引いて放つ。from は矢を出す点、dir は向き(正規化されていなくてよい)
  shoot(from, dir, power = 1) {
    if (this.phase !== 'running') return null;
    const len = Math.hypot(dir.x, dir.y, dir.z) || 1;
    const k = Math.max(0, Math.min(1, power));
    const v = ARROW_MIN + (ARROW_MAX - ARROW_MIN) * k;
    const a = {
      id: ++this._id,
      x: from.x, y: from.y, z: from.z,
      vx: (dir.x / len) * v, vy: (dir.y / len) * v, vz: (dir.z / len) * v,
      life: ARROW_LIFE,
    };
    this.arrows.push(a);
    this.shots++;
    return a;
  }

  update(dt) {
    if (this.phase !== 'running') return this.events;
    let left = Math.min(dt, MAX_DT);
    while (left > 0) {
      const step = Math.min(left, MAX_STEP);
      this._step(step);
      left -= step;
    }
    return this.events;
  }

  // 演出側が読んだら消す(同じ当たりで二度音を鳴らさない)
  takeEvents() {
    const e = this.events;
    this.events = [];
    return e;
  }

  _step(dt) {
    this._spawn(dt);
    this._moveShips(dt);
    this._moveFoes(dt);
    this._moveArrows(dt);
  }

  _spawn(dt) {
    // その波の船を出し切ったら、浜も海も片付いた時点で次の波へ
    if (this.left <= 0) {
      if (this.ships.length || this.foes.length) return;
      this.next -= dt;
      if (this.next > 0) return;
      this.wave++;
      this.left = shipsInWave(this.wave);
      this.next = WAVE_GAP;
      this.events.push({ type: 'wave', wave: this.wave });
      return;
    }
    this.next -= dt;
    if (this.next > 0) return;
    this.next = SHIP_GAP;
    this.left--;
    const o = (this._rand() * 2 - 1) * SPAWN_SIDE;
    const p = this._at(SPAWN_D, o);
    this.ships.push({
      id: ++this._id,
      x: p.x, z: p.z, y: this.seaY, side: o,
      carry: 1 + Math.floor(this._rand() * 3),   // 1〜3人
      speed: SHIP_SPEED + SHIP_SPEED_UP * (this.wave - 1),
    });
    this.events.push({ type: 'ship', id: this._id });
  }

  _moveShips(dt) {
    const p = this.post;
    const keep = [];
    for (const s of this.ships) {
      s.x -= p.outX * s.speed * dt;
      s.z -= p.outZ * s.speed * dt;
      if (this._depth(s) > LAND_D) { keep.push(s); continue; }
      // 浜に着いた。積んでいた蛮族が降りる
      for (let i = 0; i < s.carry; i++) {
        const o = s.side + (i - (s.carry - 1) / 2) * 0.22;
        const q = this._at(LAND_D, o);
        this.foes.push({ id: ++this._id, x: q.x, z: q.z, y: p.y, speed: FOE_SPEED });
      }
      this.events.push({ type: 'land', id: s.id, count: s.carry });
    }
    this.ships = keep;
  }

  _moveFoes(dt) {
    const p = this.post;
    const keep = [];
    for (const f of this.foes) {
      const dx = p.x - f.x;
      const dz = p.z - f.z;
      const d = Math.hypot(dx, dz) || 1;
      f.x += (dx / d) * f.speed * dt;
      f.z += (dz / d) * f.speed * dt;
      if (d > CATCH_D) { keep.push(f); continue; }
      // 櫓に着かれた
      this.lives--;
      this.events.push({ type: 'breach', id: f.id, lives: this.lives });
      if (this.lives <= 0) {
        this.lives = 0;
        this.phase = 'over';
        this.events.push({ type: 'over', score: this.score });
      }
    }
    this.foes = keep;
  }

  _moveArrows(dt) {
    const keep = [];
    for (const a of this.arrows) {
      a.vy -= ARROW_GRAVITY * dt;
      a.x += a.vx * dt;
      a.y += a.vy * dt;
      a.z += a.vz * dt;
      a.life -= dt;
      if (this._hit(a)) { this.hits++; continue; }
      // 水面より下に落ちた・遠すぎた
      if (a.y <= this.seaY || a.life <= 0) continue;
      keep.push(a);
    }
    this.arrows = keep;
  }

  // 矢が何かに当たったか。**船を先に見る** ── 船の上に立っている蛮族を
  // 先に判定すると、船体を狙ったつもりが乗員だけ当たって船が残る。
  _hit(a) {
    for (const [i, s] of this.ships.entries()) {
      if (Math.hypot(a.x - s.x, a.z - s.z) > SHIP_R) continue;
      if (a.y < s.y || a.y > s.y + SHIP_H) continue;   // 帆の上・水面下は素通り
      this.ships.splice(i, 1);
      this.score += SHIP_SCORE + s.carry * FOE_SCORE;
      this.events.push({ type: 'sink', id: s.id, x: s.x, z: s.z, carry: s.carry });
      return true;
    }
    for (const [i, f] of this.foes.entries()) {
      if (Math.hypot(a.x - f.x, a.z - f.z) > FOE_R) continue;
      if (a.y < f.y || a.y > f.y + FOE_H) continue;    // 頭の上は抜ける
      this.foes.splice(i, 1);
      this.score += FOE_SCORE;
      this.events.push({ type: 'down', id: f.id, x: f.x, z: f.z });
      return true;
    }
    return false;
  }

  // 画面に出す用のまとめ
  view() {
    return {
      phase: this.phase,
      wave: this.wave,
      score: this.score,
      lives: this.lives,
      shots: this.shots,
      hits: this.hits,
      ships: this.ships.length,
      foes: this.foes.length,
    };
  }
}
