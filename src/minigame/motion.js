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
const MAX_STEP = 0.05;           // タブ復帰で飛ばない上限
const FALL_LIMIT = -1.6;         // ここまで沈んだら海に落ちた扱い

export class WalkerMotion {
  // groundAt(x, z) → { y, ok }。ok が false なら「そこは地面でない」
  // blockAt: obstacles.js の makeBlocker() の戻り値(省略可)
  constructor(groundAt, blockAt = null) {
    this.groundAt = groundAt;
    this.blockAt = blockAt;
    this.pos = { x: 0, y: 0, z: 0 };
    this.vel = { x: 0, y: 0, z: 0 };
    this.facing = 0;      // ラジアン。+Z を 0 とする
    this.fallY = 0;       // 落下中の沈み込み
    this.spin = 0;        // 落下中の回転
    this.falling = false;
    this.respawn = { x: 0, z: 0 };
  }

  setPosition(x, z) {
    this.pos.x = x;
    this.pos.z = z;
    this.vel.x = 0;
    this.vel.z = 0;
    this.fallY = 0;
    this.spin = 0;
    this.falling = false;
    this.respawn.x = x;
    this.respawn.z = z;
  }

  // input: { x, y } — 画面基準の入力(-1〜1)。camYaw はカメラの向き(ラジアン)
  // 返り値: { falling, respawned, groundY, speed }
  update(dt, input, camYaw) {
    const step = Math.min(dt, MAX_STEP);
    if (this.falling) return this._fall(step);

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
    this.vel.x += (wantX - this.vel.x) * Math.min(1, ACCEL * step);
    this.vel.z += (wantZ - this.vel.z) * Math.min(1, ACCEL * step);

    // 端で止めない。踏み外したら海に落ちる ── そのほうが遊びとして楽しく、
    // すぐ元の場所に戻るので詰まらない。
    let nx = this.pos.x + this.vel.x * step;
    let nz = this.pos.z + this.vel.z * step;

    // 盤の上の物にめり込ませない。触れていなければ何もしないので、
    // 「端から落ちる」はこれまでどおり動く。
    if (this.blockAt) {
      const r = this.blockAt(this.pos.x, this.pos.z, nx, nz);
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

    const g = this.groundAt(this.pos.x, this.pos.z);
    if (!g.ok) {
      this.falling = true;
      return this._fall(step);
    }
    // 落ちる前の足場を覚えておく(復帰先)
    this.respawn.x = this.pos.x;
    this.respawn.z = this.pos.z;

    return {
      falling: false,
      respawned: false,
      groundY: g.y,
      speed: Math.hypot(this.vel.x, this.vel.z),
    };
  }

  _fall(step) {
    this.fallY -= 2.4 * step + 0.05;
    this.spin += step * 3;
    if (this.fallY < FALL_LIMIT) {
      // 海に落ちたら元の場所へ戻す
      const { x, z } = this.respawn;
      this.setPosition(x, z);
      return {
        falling: false,
        respawned: true,
        groundY: this.groundAt(x, z).y,
        speed: 0,
      };
    }
    return { falling: true, respawned: false, groundY: 0, speed: 0 };
  }
}

// a から b へ、最短回りで最大 max ラジアン近づける
export function approachAngle(a, b, max) {
  let d = ((b - a + Math.PI) % (Math.PI * 2) + Math.PI * 2) % (Math.PI * 2) - Math.PI;
  if (d > max) d = max;
  if (d < -max) d = -max;
  return a + d;
}
