// 島を歩く棒人間(ミニゲーム)
//
// 動きは素直な歩行アニメーションだけ。手足を交互に振り、わずかに上下する。
// 一度「ばねで行き過ぎさせてぐらつかせる」実装にしたが、画面が揺れて
// 見づらいだけだったのでやめた ── 揺らすなら、まず滑らかに歩けること。
//
// ここはゲームの state を一切知らない。地面の高さと歩ける範囲だけを
// 外から関数で受け取る(walk-mode.js が盤面から作って渡す)。
//
// 動きの計算そのものは motion.js に置いてある(THREE 抜きでテストするため)。
// このファイルは「その結果をメッシュに反映する」だけ。

import * as THREE from 'three';
import { WalkerMotion, WALK_SPEED } from './motion.js';

export { WALK_SPEED };

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

export class Walker {
  // groundAt(x, z) → { y, ok }。ok が false なら「そこは地面でない」
  // blockAt: 盤の上の物にめり込ませないための関数(obstacles.js)
  constructor(scene, groundAt, color, blockAt = null) {
    this.parts = makeWalker(color);
    scene.add(this.parts.group);
    this.motion = new WalkerMotion(groundAt, blockAt);
    this.phase = 0;       // 歩行サイクル
  }

  // 位置・速度・向きは motion が持つ(walk-mode.js のカメラ追従が読む)
  get pos() { return this.motion.pos; }
  get vel() { return this.motion.vel; }
  get facing() { return this.motion.facing; }
  get falling() { return this.motion.falling; }

  setPosition(x, z) {
    this.motion.setPosition(x, z);
    this.phase = 0;
  }

  // input: { x, y } — 画面基準の入力(-1〜1)。camYaw はカメラの向き(ラジアン)
  update(dt, input, camYaw) {
    const m = this.motion;
    const r = m.update(dt, input, camYaw);

    if (r.falling) {
      // 落下中はぐるぐる回りながら沈む
      this.parts.group.position.set(m.pos.x, m.fallY, m.pos.z);
      this.parts.group.rotation.set(0, m.facing, m.spin);
      return r;
    }

    this.phase += r.speed * Math.min(dt, 0.05) * 5.2;
    this._pose(r.speed, r.groundY);
    return r;
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
