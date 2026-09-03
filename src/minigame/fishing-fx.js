// 釣りの見た目。糸・浮き・波紋と、釣れたものを掲げるところ。
//
// 進行そのものは fishing.js(THREE を知らない)。ここはその view() を
// 受け取って描くだけで、ゲームの判断はしない。

import * as THREE from 'three';
import { WALK_SCALE, s as sc } from './scale.js';

const LINE_COLOR = 0xdfefff;
const FLOAT_TOP = 0xe8503a;
const FLOAT_BOT = 0xf5f2ea;

// 糸のたるみ。張っていないほど大きく垂れる。
// 竿と糸は釣り人の道具なので、寸法も投げる距離も縮尺を掛ける(scale.js)。
const SAG = sc(0.22);
// 投げる距離。浮きが岸からどれだけ沖に落ちるか
const CAST_DIST = sc(1.1);
const SEG = 12;   // 糸の分割数(たるみを曲線で見せるため)

export class FishingFx {
  // seaY: 水面の高さ。浮きはここに浮く
  constructor(scene, seaY) {
    this.scene = scene;
    this.seaY = seaY;
    this.t = 0;

    // 浮き。上が赤、下が白の見慣れた形
    this.float = new THREE.Group();
    const top = new THREE.Mesh(
      new THREE.SphereGeometry(0.035, 10, 8, 0, Math.PI * 2, 0, Math.PI / 2),
      new THREE.MeshStandardMaterial({ color: FLOAT_TOP, roughness: 0.6 }),
    );
    const bot = new THREE.Mesh(
      new THREE.SphereGeometry(0.035, 10, 8, 0, Math.PI * 2, Math.PI / 2, Math.PI / 2),
      new THREE.MeshStandardMaterial({ color: FLOAT_BOT, roughness: 0.6 }),
    );
    const stick = new THREE.Mesh(
      new THREE.CylinderGeometry(0.004, 0.004, 0.06, 5),
      new THREE.MeshStandardMaterial({ color: FLOAT_TOP }),
    );
    stick.position.y = 0.055;
    this.float.add(top, bot, stick);
    this.float.scale.setScalar(WALK_SCALE);
    this.float.visible = false;
    scene.add(this.float);

    // 糸。毎フレーム頂点を書き換える
    const pts = new Float32Array((SEG + 1) * 3);
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pts, 3));
    this.line = new THREE.Line(geo, new THREE.LineBasicMaterial({
      color: LINE_COLOR, transparent: true, opacity: 0.75,
    }));
    this.line.frustumCulled = false;   // 頂点を直接書くので自動判定に任せない
    this.line.visible = false;
    scene.add(this.line);

    // 浮きのまわりの波紋
    this.ring = new THREE.Mesh(
      new THREE.RingGeometry(0.05, 0.075, 20),
      new THREE.MeshBasicMaterial({
        color: 0xdff2ff, transparent: true, opacity: 0, side: THREE.DoubleSide,
      }),
    );
    this.ring.rotation.x = -Math.PI / 2;
    this.ring.scale.setScalar(WALK_SCALE);
    this.ring.visible = false;
    scene.add(this.ring);
    this.ringT = 0;

    this._tip = new THREE.Vector3();
    this._a = new THREE.Vector3();
  }

  // 浮きを落とす場所を決める(岸から沖へ向かって投げる)
  cast(x, z, dirX, dirZ, dist = CAST_DIST) {
    this.float.position.set(x + dirX * dist, this.seaY, z + dirZ * dist);
    this.float.visible = true;
    this.line.visible = true;
    this.ringT = 0;
  }

  hide() {
    this.float.visible = false;
    this.line.visible = false;
    this.ring.visible = false;
  }

  // v: fishing.js の view()。tip: 竿先の世界座標。
  // castK は投げている途中の進み具合(0〜1)で、そのあいだ浮きが飛んでいく。
  update(dt, v, tip, castK = 1) {
    this.t += dt;
    if (!this.float.visible) return;

    const f = this.float.position;
    // 浮きの上下。待っている間はゆっくり、アタリでは激しく沈む
    let bob = Math.sin(this.t * 2.1) * sc(0.012);
    if (v.phase === 'bite') bob = sc(-0.045 - Math.abs(Math.sin(this.t * 16)) * 0.05);
    else if (v.phase === 'fight') {
      // 張っているほど浮きが水に引き込まれる
      bob = sc(-0.02 - v.tension * 0.06 + Math.sin(this.t * (v.burst ? 22 : 7)) * 0.02);
    }
    f.y = this.seaY + bob;

    // 取り込むにつれて浮きが手元へ寄ってくる
    if (v.phase === 'fight') {
      this._a.copy(tip);
      this._a.y = f.y;
      f.lerp(this._a, Math.min(1, dt * 1.6 * v.progress));
    }

    // 波紋。アタリと暴れのときだけ出す
    const wake = v.phase === 'bite' || (v.phase === 'fight' && v.burst);
    if (wake) this.ringT = Math.min(1, this.ringT + dt * 2.4);
    else this.ringT = Math.max(0, this.ringT - dt * 2.2);
    this.ring.visible = this.ringT > 0.01;
    if (this.ring.visible) {
      this.ring.position.set(f.x, this.seaY + sc(0.006), f.z);
      this.ring.scale.setScalar(1 + this.ringT * 1.8);
      this.ring.material.opacity = this.ringT * 0.5;
    }

    this._drawLine(tip, f, v, castK);
  }

  // 糸を張り具合に応じて垂らす。張っているほどまっすぐになる。
  _drawLine(tip, end, v, castK) {
    const pos = this.line.geometry.attributes.position;
    // 投げている途中は、糸の先が飛んでいく途中まで
    const k = Math.max(0.05, Math.min(1, castK));
    const sag = SAG * (1 - (v.phase === 'fight' ? v.tension : 0.15)) * k;
    for (let i = 0; i <= SEG; i++) {
      const s = i / SEG;
      const x = tip.x + (end.x - tip.x) * s * k;
      const z = tip.z + (end.z - tip.z) * s * k;
      // 放物線でたるませる(両端は 0、まんなかがいちばん下がる)
      const y = tip.y + (end.y - tip.y) * s * k - Math.sin(s * Math.PI) * sag;
      pos.setXYZ(i, x, y, z);
    }
    pos.needsUpdate = true;
  }

  dispose() {
    for (const o of [this.float, this.line, this.ring]) {
      o.removeFromParent();
      o.traverse?.((c) => {
        c.geometry?.dispose?.();
        if (c.material) {
          (Array.isArray(c.material) ? c.material : [c.material]).forEach((m) => m.dispose?.());
        }
      });
      o.geometry?.dispose?.();
      o.material?.dispose?.();
    }
  }
}
