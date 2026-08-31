// 島を歩く棒人間(ミニゲーム)
//
// 動きは素直な歩行アニメーションだけ。手足を交互に振り、わずかに上下する。
// 一度「ばねで行き過ぎさせてぐらつかせる」実装にしたが、画面が揺れて
// 見づらいだけだったのでやめた ── 揺らすなら、まず滑らかに歩けること。
//
// ここはゲームの state を一切知らない。地面の高さと歩ける範囲だけを
// 外から関数で受け取る(walk-mode.js が盤面から作って渡す)。

import * as THREE from 'three';

export const WALKER_HEIGHT = 0.52; // 足元から頭のてっぺんまで(タイル1枚が約1.0)

const SKIN = 0xffd9a8;
const CLOTH = 0x2f6fd0;

function limbMat(color) {
  return new THREE.MeshStandardMaterial({ color, roughness: 0.75, metalness: 0.02 });
}

// 1本の手足。上下2節で、肩(付け根)から吊り下げる。
function makeLimb(mat, upper, lower, thick) {
  const root = new THREE.Group();
  const upperMesh = new THREE.Mesh(
    new THREE.CapsuleGeometry(thick, upper, 3, 6), mat,
  );
  upperMesh.position.y = -upper / 2;
  upperMesh.castShadow = true;
  root.add(upperMesh);

  const knee = new THREE.Group();
  knee.position.y = -upper;
  const lowerMesh = new THREE.Mesh(
    new THREE.CapsuleGeometry(thick * 0.86, lower, 3, 6), mat,
  );
  lowerMesh.position.y = -lower / 2;
  lowerMesh.castShadow = true;
  knee.add(lowerMesh);
  root.add(knee);

  return { root, knee };
}

export function makeWalker(color = CLOTH) {
  const g = new THREE.Group();
  const skin = limbMat(SKIN);
  const cloth = limbMat(color);

  // 腰。ここを動かすと全身が付いてくる
  const hips = new THREE.Group();
  hips.position.y = 0.26;
  g.add(hips);

  const torso = new THREE.Mesh(new THREE.CapsuleGeometry(0.055, 0.14, 4, 8), cloth);
  torso.position.y = 0.09;
  torso.castShadow = true;
  hips.add(torso);

  const chest = new THREE.Group();
  chest.position.y = 0.17;
  hips.add(chest);

  const head = new THREE.Mesh(new THREE.SphereGeometry(0.062, 12, 10), skin);
  head.position.y = 0.065;
  head.castShadow = true;
  chest.add(head);

  // 目。向いている方向が分かるようにする(+Z が前)
  const eyeGeo = new THREE.SphereGeometry(0.012, 6, 6);
  const eyeMat = new THREE.MeshBasicMaterial({ color: 0x22242a });
  for (const sx of [-1, 1]) {
    const eye = new THREE.Mesh(eyeGeo, eyeMat);
    eye.position.set(sx * 0.024, 0.072, 0.052);
    chest.add(eye);
  }

  const arms = [-1, 1].map((sx) => {
    const limb = makeLimb(skin, 0.11, 0.10, 0.019);
    limb.root.position.set(sx * 0.062, 0.03, 0);
    chest.add(limb.root);
    return limb;
  });

  const legs = [-1, 1].map((sx) => {
    const limb = makeLimb(cloth, 0.13, 0.12, 0.024);
    limb.root.position.set(sx * 0.032, 0, 0);
    hips.add(limb.root);
    return limb;
  });

  return { group: g, hips, chest, head, arms, legs };
}

export const WALK_SPEED = 1.9;   // タイル/秒
const TURN_SPEED = 9;            // 向き変えの速さ
const ACCEL = 9;                 // 加速(小さいほどぬるっと動く)

export class Walker {
  // groundAt(x, z) → { y, ok }。ok が false なら「そこは地面でない」
  constructor(scene, groundAt, color) {
    this.parts = makeWalker(color);
    this.groundAt = groundAt;
    scene.add(this.parts.group);

    this.pos = new THREE.Vector3(0, 0, 0);
    this.vel = new THREE.Vector3(0, 0, 0);
    this.facing = 0;      // ラジアン。+Z を 0 とする
    this.phase = 0;       // 歩行サイクル
    this.fallY = 0;       // 落下中の沈み込み
    this.falling = false;
    this.respawn = new THREE.Vector3(0, 0, 0);

  }

  setPosition(x, z) {
    this.pos.set(x, 0, z);
    this.vel.set(0, 0, 0);
    this.fallY = 0;
    this.falling = false;
    this.respawn.set(x, 0, z);
  }

  // input: { x, y } — 画面基準の入力(-1〜1)。camYaw はカメラの向き(ラジアン)
  update(dt, input, camYaw) {
    const step = Math.min(dt, 0.05); // タブ復帰で飛ばない上限

    if (this.falling) return this._fall(step);

    // 入力をカメラ基準からワールド基準へ
    const mag = Math.min(1, Math.hypot(input.x, input.y));
    let wantX = 0;
    let wantZ = 0;
    if (mag > 0.06) {
      const dir = Math.atan2(input.x, input.y) + camYaw;
      wantX = Math.sin(dir) * WALK_SPEED * mag;
      wantZ = Math.cos(dir) * WALK_SPEED * mag;
      this.facing = approachAngle(this.facing, dir, TURN_SPEED * step);
    }

    // 速度を目標へ寄せる(ぬるっと動き出し、ぬるっと止まる)
    this.vel.x += (wantX - this.vel.x) * Math.min(1, ACCEL * step);
    this.vel.z += (wantZ - this.vel.z) * Math.min(1, ACCEL * step);

    // 端で止めない。踏み外したら海に落ちる ── そのほうが遊びとして楽しく、
    // すぐ元の場所に戻るので詰まらない。
    this.pos.x += this.vel.x * step;
    this.pos.z += this.vel.z * step;

    const g = this.groundAt(this.pos.x, this.pos.z);
    if (!g.ok) {
      this.falling = true;
      return this._fall(step);
    }
    // 落ちる前の足場を覚えておく(復帰先)
    this.respawn.set(this.pos.x, 0, this.pos.z);

    const speed = Math.hypot(this.vel.x, this.vel.z);
    this.phase += speed * step * 5.2;
    this._pose(speed, g.y);
    return { falling: false };
  }

  _fall(step) {
    this.fallY -= 2.4 * step + 0.05;
    this.parts.group.position.set(this.pos.x, this.fallY, this.pos.z);
    this.parts.group.rotation.z += step * 3;
    if (this.fallY < -1.6) {
      // 海に落ちたら元の場所へ戻す
      this.parts.group.rotation.set(0, 0, 0);
      this.setPosition(this.respawn.x, this.respawn.z);
      return { falling: false, respawned: true };
    }
    return { falling: true };
  }

  // 歩行アニメーション。手足を交互に振るだけの素直なもの。
  // 体は上下しない ── カメラが追うので、揺らすと画面全体が揺れて見づらい。
  _pose(speed, groundY) {
    const p = this.parts;
    const t = this.phase;
    const gait = Math.min(1, speed / WALK_SPEED);

    p.group.position.set(this.pos.x, groundY, this.pos.z);
    p.group.rotation.set(0, this.facing, 0);

    // 走るほど前傾する(それらしく見せるのはこれだけで足りる)
    p.hips.rotation.x = gait * 0.12;
    p.hips.rotation.z = 0;
    p.chest.rotation.set(0, 0, 0);
    p.head.rotation.set(0, 0, 0);

    // 脚: 交互に振る。膝は振り出しのときだけ曲げる
    p.legs.forEach((leg, i) => {
      const s = i === 0 ? 1 : -1;
      const swing = Math.sin(t) * s;
      leg.root.rotation.x = swing * 0.62 * gait;
      leg.knee.rotation.x = Math.max(0, -swing) * 0.9 * gait;
    });

    // 腕: 脚と逆位相
    p.arms.forEach((arm, i) => {
      const s = i === 0 ? -1 : 1;
      const swing = Math.sin(t) * s;
      arm.root.rotation.x = swing * 0.7 * gait;
      arm.root.rotation.z = (i === 0 ? -1 : 1) * 0.14;
      arm.knee.rotation.x = 0.25 + Math.max(0, swing) * 0.4 * gait;
    });
  }

  dispose() {
    this.parts.group.removeFromParent();
    this.parts.group.traverse((o) => {
      o.geometry?.dispose?.();
      if (o.material) (Array.isArray(o.material) ? o.material : [o.material]).forEach((m) => m.dispose?.());
    });
  }
}

// a から b へ、最短回りで最大 max ラジアン近づける
function approachAngle(a, b, max) {
  let d = ((b - a + Math.PI) % (Math.PI * 2) + Math.PI * 2) % (Math.PI * 2) - Math.PI;
  if (d > max) d = max;
  if (d < -max) d = -max;
  return a + d;
}
