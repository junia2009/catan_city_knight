// 海に落ちたときの演出(水しぶき・泡・水中の色)。
//
// 見た目だけの持ち物なので、ここは THREE を使ってよい(テストは walk-mode の
// 呼び出し側ではなく motion.js 側で押さえている)。
// 乱数は Math.random() を使う ── 演出のみで、盤面の再現性には関わらない。

import * as THREE from 'three';

const SEA_Y = 0.02;             // board3d.js と同じ水面の高さ
const FOAM = 0xdff2ff;

// 水中の色。霧をここへ寄せると、一気に「水の中」に見える。
const WATER_FOG = new THREE.Color(0x0b3d5c);
const DEEP_FOG = new THREE.Color(0x03172b);

const rnd = (a, b) => a + Math.random() * (b - a);

export class WaterFx {
  constructor(scene) {
    this.scene = scene;
    this.group = new THREE.Group();
    this.group.renderOrder = 2;
    scene.add(this.group);

    this.rings = [];
    this.drops = [];
    this.bubbles = [];
    this.bubbleT = 0;

    // 使い回すジオメトリ(毎回作ると落ちるたびに増える)
    this.ringGeo = new THREE.RingGeometry(0.55, 0.72, 28);
    this.ringGeo.rotateX(-Math.PI / 2);
    this.dropGeo = new THREE.SphereGeometry(0.026, 7, 6);
    this.bubbleGeo = new THREE.SphereGeometry(0.022, 7, 6);
  }

  // 着水。広がる波紋と、跳ね上がるしぶき。
  splash(x, z) {
    for (let i = 0; i < 3; i++) {
      const mat = new THREE.MeshBasicMaterial({
        color: FOAM, transparent: true, opacity: 0.85, side: THREE.DoubleSide,
        depthWrite: false,
      });
      const m = new THREE.Mesh(this.ringGeo, mat);
      m.position.set(x, SEA_Y + 0.012 + i * 0.002, z);
      m.scale.setScalar(0.12);
      this.group.add(m);
      this.rings.push({ m, mat, t: -i * 0.16, life: 1.5, to: 1.1 + i * 0.5 });
    }

    for (let i = 0; i < 16; i++) {
      const mat = new THREE.MeshBasicMaterial({
        color: FOAM, transparent: true, opacity: 0.95, depthWrite: false,
      });
      const m = new THREE.Mesh(this.dropGeo, mat);
      m.position.set(x, SEA_Y + 0.02, z);
      const a = rnd(0, Math.PI * 2);
      const out = rnd(0.3, 1.1);
      m.scale.setScalar(rnd(0.6, 1.5));
      this.group.add(m);
      this.drops.push({
        m, mat, t: 0, life: rnd(0.7, 1.2),
        v: { x: Math.cos(a) * out, y: rnd(1.1, 2.4), z: Math.sin(a) * out },
      });
    }
  }

  // 沈んでいる間、体から泡が立ちのぼる
  _emitBubbles(dt, x, y, z) {
    this.bubbleT -= dt;
    if (this.bubbleT > 0) return;
    this.bubbleT = rnd(0.05, 0.13);
    const mat = new THREE.MeshBasicMaterial({
      color: 0xcdeaf7, transparent: true, opacity: 0.6, depthWrite: false,
    });
    const m = new THREE.Mesh(this.bubbleGeo, mat);
    m.position.set(x + rnd(-0.09, 0.09), y + rnd(0, 0.2), z + rnd(-0.09, 0.09));
    m.scale.setScalar(rnd(0.5, 1.7));
    this.group.add(m);
    this.bubbles.push({
      m, mat, t: 0, life: rnd(1.6, 3.0),
      rise: rnd(0.35, 0.75), wob: rnd(0, 6.3), amp: rnd(0.02, 0.06),
    });
  }

  // walker が水中にいる間だけ pos を渡す(いなければ null)
  update(dt, waterPos) {
    if (waterPos) this._emitBubbles(dt, waterPos.x, waterPos.y, waterPos.z);

    this.rings = this.rings.filter((r) => {
      r.t += dt;
      if (r.t < 0) { r.mat.opacity = 0; return true; }
      const k = r.t / r.life;
      if (k >= 1) { this._drop(r.m, r.mat); return false; }
      // 最初は速く、あとはゆっくり広がる
      r.m.scale.setScalar(0.12 + r.to * (1 - (1 - k) ** 2));
      r.mat.opacity = 0.85 * (1 - k) ** 1.6;
      return true;
    });

    this.drops = this.drops.filter((d) => {
      d.t += dt;
      if (d.t >= d.life) { this._drop(d.m, d.mat); return false; }
      d.v.y -= 5.2 * dt;
      d.m.position.x += d.v.x * dt;
      d.m.position.y += d.v.y * dt;
      d.m.position.z += d.v.z * dt;
      d.mat.opacity = 0.95 * (1 - d.t / d.life);
      return true;
    });

    this.bubbles = this.bubbles.filter((b) => {
      b.t += dt;
      // 水面まで上がりきったら消える
      if (b.t >= b.life || b.m.position.y > SEA_Y - 0.01) {
        this._drop(b.m, b.mat);
        return false;
      }
      b.m.position.y += b.rise * dt;
      b.m.position.x += Math.sin(b.wob + b.t * 3.1) * b.amp * dt * 6;
      b.m.position.z += Math.cos(b.wob + b.t * 2.6) * b.amp * dt * 6;
      b.mat.opacity = 0.6 * Math.min(1, (1 - b.t / b.life) * 2.5);
      return true;
    });
  }

  _drop(mesh, mat) {
    this.group.remove(mesh);
    mat.dispose();
  }

  // カメラが水面より下にいる度合い(0〜1)を返す。
  // 幅を広く取ると、霧が薄いまま潜った状態が続き、水面の向こうに
  // 空が黒く抜けて見える。短く切って一気に水中へ移す。
  static submersion(camY) {
    return Math.max(0, Math.min(1, (SEA_Y - camY) / 0.18));
  }

  // 霧・背景・水面を「水の中」の見え方へ寄せる。
  // u: 潜り具合(0〜1)、depth: 棒人間の深さ(深いほど暗く)
  static applyUnderwater(scene, seaMesh, u, depth, saved) {
    const fog = scene.fog;
    if (!fog) return;
    if (u <= 0.001) {
      // 元に戻す(_tickSky が毎フレーム書くので、色はそのままでよい)
      fog.near = saved.near;
      fog.far = saved.far;
      if (seaMesh) seaMesh.material.side = THREE.FrontSide;
      return;
    }
    const target = WATER_FOG.clone().lerp(DEEP_FOG, Math.min(1, depth / 1.9));
    fog.color.lerp(target, u);
    scene.background.lerp(target, u);
    // 水中は視界が利かない。近く・濃くして水の重さを出す
    fog.near = saved.near + (0.4 - saved.near) * u;
    fog.far = saved.far + (7.5 - saved.far) * u;
    // 潜ったら水面を裏からも描く(片面のままだと空が透けて見える)
    if (seaMesh) seaMesh.material.side = THREE.DoubleSide;
  }

  dispose() {
    for (const list of [this.rings, this.drops, this.bubbles]) {
      for (const e of list) this._drop(e.m, e.mat);
    }
    this.rings = [];
    this.drops = [];
    this.bubbles = [];
    this.group.removeFromParent();
    this.ringGeo.dispose();
    this.dropGeo.dispose();
    this.bubbleGeo.dispose();
  }
}
