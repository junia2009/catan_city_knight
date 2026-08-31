// 棒人間の「動き」だけを切り出したもの。
//
// ここは THREE を一切使わない ── ground.js と同じ理由で、
// テストが node で素直に動くようにするため
// (CI は npm install をせずに `npm test` を回すので、
//  three を import した瞬間にテストが落ちる)。
//
// 見た目(メッシュ・歩行アニメーション)は walker.js が持つ。

import { slideVelocity } from './obstacles.js';

export const WALK_SPEED = 1.9;   // タイル/秒
const TURN_SPEED = 9;            // 向き変えの速さ
const ACCEL = 9;                 // 加速(小さいほどぬるっと動く)
const AIR_ACCEL = 3.5;           // 空中での効き(地上より鈍く。跳んだ勢いが残る)
const MAX_STEP = 0.05;           // 1回の計算で進める上限(すり抜け防止)
export const MAX_DT = 0.25;      // これを超えた分は捨てる(タブ復帰で飛ばない)

// 海。タイル上面を 0 とした高さで持つ(board3d の SEA_Y 0.02 − TILE_TOP 0.26)
export const WATER_Y = -0.24;
const WATER_DRAG = 3.2;          // 水の抵抗。落ちてきた勢いがここで殺される
const SINK_SPEED = -0.5;         // 沈んでいく速さ(終端速度)
export const SINK_DEPTH = -1.9;  // ここまで沈んだら岸へ戻す
const WATER_SWAY = 0.9;          // 水中でゆらゆら漂う速さ

// ジャンプ。頂点 0.5 タイル(棒人間の背丈くらい)、滞空 0.8 秒になるよう決めた。
//   h = g t² / 8,  v0 = g t / 2
export const JUMP_HEIGHT = 0.5;
const AIR_TIME = 0.8;
const GRAVITY = (8 * JUMP_HEIGHT) / (AIR_TIME * AIR_TIME);
const JUMP_SPEED = (GRAVITY * AIR_TIME) / 2;

// 踏み外した直後の短い猶予。崖際で跳ぼうとして落ちるのを防ぐ
// (この手のゲームでは定番の救済。無いと目測どおりに跳べない)。
const COYOTE_TIME = 0.12;

export class WalkerMotion {
  // groundAt(x, z) → { y, ok }。ok が false なら「そこは地面でない」
  // blockAt: obstacles.js の makeBlocker() の戻り値(省略可)
  constructor(groundAt, blockAt = null) {
    this.groundAt = groundAt;
    this.blockAt = blockAt;
    this.pos = { x: 0, y: 0, z: 0 };
    this.vel = { x: 0, y: 0, z: 0 };
    this.facing = 0;      // ラジアン。+Z を 0 とする
    this.y = 0;           // タイル上面からの高さ(0 = 立っている)
    this.vy = 0;
    this.spin = 0;        // 海へ落ちている間の回転
    this.inWater = false; // 水面より下にいる
    this.sinkT = 0;       // 着水してからの時間(演出の進み具合に使う)
    this.grounded = true;
    this.coyote = 0;      // 地面を離れてからの猶予の残り
    this.wantJump = false;
    this.respawn = { x: 0, z: 0 };
  }

  setPosition(x, z) {
    this.pos.x = x;
    this.pos.z = z;
    this.vel.x = 0;
    this.vel.z = 0;
    this.y = 0;
    this.vy = 0;
    this.spin = 0;
    this.inWater = false;
    this.sinkT = 0;
    this.grounded = true;
    this.coyote = 0;
    this.wantJump = false;
    this.respawn.x = x;
    this.respawn.z = z;
  }

  // 海に落ちている最中(足場のない空中)。着地でも復帰でもない。
  get falling() { return !this.grounded && !this.overGround(); }

  overGround() { return this.groundAt(this.pos.x, this.pos.z).ok; }

  // ジャンプの入力。押した瞬間に呼ぶ(押しっぱなしで跳び続けない)。
  jump() { this.wantJump = true; }

  // input: { x, y } — 画面基準の入力(-1〜1)。camYaw はカメラの向き(ラジアン)
  // 返り値: { falling, respawned, grounded, y, groundY, speed, landed, jumped }
  //
  // 1回の刻みは MAX_STEP まで。dt がそれより長いときは刻んで回す ──
  // ただ切り詰めると、フレームが出ない端末で全部がスローモーションになる
  // (ジャンプの滞空だけ妙に長い、など)。
  update(dt, input, camYaw) {
    const total = Math.min(Math.max(dt, 0), MAX_DT);
    const n = Math.max(1, Math.ceil(total / MAX_STEP));
    const step = total / n;

    let out = null;
    for (let i = 0; i < n; i++) {
      const r = this._step(step, input, camYaw);
      out = out ? mergeStep(out, r) : r;
      // 復帰したら、その回はそこで打ち切る(戻った直後にまた進めない)
      if (r.respawned) break;
    }
    return out;
  }

  _step(step, input, camYaw) {
    // 入力をカメラ基準からワールド基準へ
    const mag = Math.min(1, Math.hypot(input.x, input.y));
    let wantX = 0;
    let wantZ = 0;
    if (mag > 0.06) {
      // 画面右は -X 方向。カメラは +Z を向いて置いてあるので、
      // 入力の x をそのまま使うと左右が逆になる(符号を反転させる)。
      const dir = Math.atan2(-input.x, input.y) + camYaw;
      wantX = Math.sin(dir) * WALK_SPEED * mag;
      wantZ = Math.cos(dir) * WALK_SPEED * mag;
      this.facing = approachAngle(this.facing, dir, TURN_SPEED * step);
    }

    // 速度を目標へ寄せる(ぬるっと動き出し、ぬるっと止まる)
    const accel = this.grounded ? ACCEL : AIR_ACCEL;
    this.vel.x += (wantX - this.vel.x) * Math.min(1, accel * step);
    this.vel.z += (wantZ - this.vel.z) * Math.min(1, accel * step);

    // ---- 踏み切り ----
    let jumped = false;
    if (this.wantJump && (this.grounded || this.coyote > 0)) {
      this.vy = JUMP_SPEED;
      this.grounded = false;
      this.coyote = 0;
      jumped = true;
    }
    this.wantJump = false;

    // ---- 横の移動 ----
    // 端で止めない。踏み外したら海に落ちる ── そのほうが遊びとして楽しく、
    // すぐ元の場所に戻るので詰まらない。
    let nx = this.pos.x + this.vel.x * step;
    let nz = this.pos.z + this.vel.z * step;

    // 盤の上の物にめり込ませない。足が越えている高さの物はすり抜ける
    // (低い岩や煉瓦は跳び越えられる)。触れていなければ何もしないので、
    // 「端から落ちる」はこれまでどおり動く。
    if (this.blockAt) {
      const r = this.blockAt(this.pos.x, this.pos.z, nx, nz, undefined, this.y);
      if (r.hit) {
        // 押し出された先が海なら、そこへは出さずにその場で止める
        // (物に挟まれて海へ押し出されるのは事故でしかない)
        if (this.groundAt(r.x, r.z).ok) {
          const dx = r.x - nx;
          const dz = r.z - nz;
          const d = Math.hypot(dx, dz);
          if (d > 1e-6) slideVelocity(this.vel, dx / d, dz / d);
          nx = r.x;
          nz = r.z;
        } else {
          nx = this.pos.x;
          nz = this.pos.z;
          this.vel.x = 0;
          this.vel.z = 0;
        }
      }
    }

    this.pos.x = nx;
    this.pos.z = nz;

    // ---- 高さ ----
    const g = this.groundAt(this.pos.x, this.pos.z);
    let landed = false;

    // 足場が無い。歩いて踏み外した場合はここで落ち始める
    if (!g.ok && this.grounded) {
      this.grounded = false;
      this.vy = 0;
    }

    const submerged = !g.ok && this.y <= WATER_Y;
    if (!this.grounded) {
      if (submerged) {
        // 水の中。抵抗で落ちてきた勢いが殺され、ゆっくり沈むだけになる
        const k = Math.min(1, WATER_DRAG * step);
        this.vy += (SINK_SPEED - this.vy) * k;
        this.vel.x -= this.vel.x * k;
        this.vel.z -= this.vel.z * k;
      } else {
        this.vy -= GRAVITY * step;
      }
      this.y += this.vy * step;
    }

    if (!g.ok) {
      const wasInWater = this.inWater;
      this.inWater = this.y <= WATER_Y;
      const splashed = this.inWater && !wasInWater;

      if (this.inWater) {
        this.sinkT += step;
        this.spin += step * WATER_SWAY * 0.35; // 水中はゆっくり漂う
      } else {
        this.spin += step * 3;                 // 空中はぐるぐる回る
      }

      if (this.y < SINK_DEPTH) {
        const { x, z } = this.respawn;
        this.setPosition(x, z);
        return {
          falling: false, respawned: true, grounded: true, landed: true, jumped,
          splashed, inWater: false, sinkT: 0, depth: 0,
          y: 0, groundY: this.groundAt(x, z).y, speed: 0,
        };
      }
      return {
        falling: true, respawned: false, grounded: false, landed: false, jumped,
        splashed, inWater: this.inWater, sinkT: this.sinkT,
        depth: Math.max(0, WATER_Y - this.y),
        y: this.y, groundY: g.y, speed: Math.hypot(this.vel.x, this.vel.z),
      };
    }
    this.inWater = false;
    this.sinkT = 0;

    // 足場の上。降りてきたら着地する
    this.spin = 0;
    if (!this.grounded && this.y <= 0 && this.vy <= 0) {
      this.y = 0;
      this.vy = 0;
      this.grounded = true;
      landed = true;
    }
    if (this.grounded) {
      this.coyote = COYOTE_TIME;
      // 落ちる前の足場を覚えておく(復帰先)
      this.respawn.x = this.pos.x;
      this.respawn.z = this.pos.z;
    } else {
      this.coyote = Math.max(0, this.coyote - step);
    }

    return {
      falling: false, respawned: false, grounded: this.grounded, landed, jumped,
      splashed: false, inWater: false, sinkT: 0, depth: 0,
      y: this.y, groundY: g.y, speed: Math.hypot(this.vel.x, this.vel.z),
    };
  }
}

// 刻んで回した結果をまとめる。
// 起きたこと(踏み切った・着地した・復帰した)は1回でも起きたら起きた扱い、
// 状態(高さ・速さ)は最後の刻みのものを採る。
function mergeStep(a, b) {
  return {
    ...b,
    jumped: a.jumped || b.jumped,
    landed: a.landed || b.landed,
    splashed: a.splashed || b.splashed,
    respawned: a.respawned || b.respawned,
  };
}

// a から b へ、最短回りで最大 max ラジアン近づける
export function approachAngle(a, b, max) {
  let d = ((b - a + Math.PI) % (Math.PI * 2) + Math.PI * 2) % (Math.PI * 2) - Math.PI;
  if (d > max) d = max;
  if (d < -max) d = -max;
  return a + d;
}
