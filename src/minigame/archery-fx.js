// 「蛮族を射る」の見た目。進行は archery.js が決めていて、ここは映すだけ。
//
// 盤にある物をそのまま借りる ── 蛮族船と見張り塔は board3d が対戦用に
// 持っているので、作り直さない(見た目が2種類に分かれない)。

import * as THREE from 'three';
import { makeTower, makeBarbarianShip } from '../render3d/board3d.js';

const SHIP_SCALE = 0.42;     // 盤の駒より小ぶりに。等倍だと浜を覆う
const FOE_H = 0.20;          // 蛮族の背丈(盤の寸法)
const ARROW_LEN = 0.13;
// 櫓を立ち位置から岸に沿ってどれだけずらすか(盤の寸法)
const TOWER_SIDE = 0.34;

// 蛮族ひとり。棒人間ほど作り込まない ── 何人も出るし、遠くの浜で見るので、
// 「暗い色の人影が浜を上がってくる」ことのほうが大事。
function makeFoe() {
  const g = new THREE.Group();
  const cloth = new THREE.MeshStandardMaterial({ color: 0x3b2f3a, roughness: 0.9 });
  const skin = new THREE.MeshStandardMaterial({ color: 0xc09a72, roughness: 0.8 });
  const body = new THREE.Mesh(new THREE.CapsuleGeometry(FOE_H * 0.24, FOE_H * 0.5, 3, 6), cloth);
  body.position.y = FOE_H * 0.5;
  body.castShadow = true;
  const head = new THREE.Mesh(new THREE.SphereGeometry(FOE_H * 0.2, 8, 6), skin);
  head.position.y = FOE_H * 0.92;
  // 斧。持たせるだけで「攻めてきている」が伝わる
  const axe = new THREE.Mesh(
    new THREE.BoxGeometry(FOE_H * 0.06, FOE_H * 0.55, FOE_H * 0.06),
    new THREE.MeshStandardMaterial({ color: 0x4a3423, roughness: 0.9 }),
  );
  axe.position.set(FOE_H * 0.26, FOE_H * 0.6, 0);
  axe.rotation.z = -0.35;
  const blade = new THREE.Mesh(
    new THREE.BoxGeometry(FOE_H * 0.18, FOE_H * 0.16, FOE_H * 0.04),
    new THREE.MeshStandardMaterial({ color: 0x9aa4ad, roughness: 0.5, metalness: 0.3 }),
  );
  blade.position.set(FOE_H * 0.36, FOE_H * 0.84, 0);
  g.add(body, head, axe, blade);
  return g;
}

function makeArrow() {
  const g = new THREE.Group();
  const shaft = new THREE.Mesh(
    new THREE.CylinderGeometry(0.004, 0.004, ARROW_LEN, 4),
    new THREE.MeshStandardMaterial({ color: 0x8a6a3a, roughness: 0.7 }),
  );
  shaft.rotation.x = Math.PI / 2;   // 長さの向きを +Z へ
  const head = new THREE.Mesh(
    new THREE.ConeGeometry(0.008, 0.022, 4),
    new THREE.MeshStandardMaterial({ color: 0x9aa4ad, roughness: 0.5, metalness: 0.3 }),
  );
  head.rotation.x = Math.PI / 2;
  head.position.z = ARROW_LEN / 2;
  g.add(shaft, head);
  return g;
}

function dispose(root) {
  root.traverse((o) => {
    o.geometry?.dispose?.();
    if (o.material) (Array.isArray(o.material) ? o.material : [o.material]).forEach((m) => m.dispose?.());
  });
}

export class ArcheryFx {
  // post: { x, z, y, outX, outZ } 櫓の場所。塔はここに建てる
  constructor(scene, post, towerColor = 0xd9d3c4) {
    this.scene = scene;
    this.post = post;
    // 櫓。撃っていないときも立っている ── 「あの浜に何かある」を先に見せる。
    // **立ち位置の真上ではなく、岸に沿って横へずらす。** 真上に建てると、
    // 海のほうを向いたときに櫓が正面をふさいで、撃つ相手が1隻も見えない
    // (港の看板を横へよけるのと同じ理由。ground.js の STAND_SIDE)。
    this.tower = makeTower(towerColor);
    this.tower.position.set(
      post.x + post.outZ * TOWER_SIDE,
      post.y,
      post.z - post.outX * TOWER_SIDE,
    );
    // 海を背にして立つ(旗が陸から見えるように)
    this.tower.rotation.y = Math.atan2(post.outX, post.outZ);
    scene.add(this.tower);

    this.ships = new Map();   // id -> mesh
    this.foes = new Map();
    this.arrows = new Map();
    this.splashes = [];       // 沈んだ跡・倒れた跡(短い演出)
  }

  // 進行(archery.js の Raid)を1フレームぶん映す
  update(raid, t) {
    this._sync(raid.ships, this.ships, () => {
      const m = makeBarbarianShip();
      m.scale.setScalar(SHIP_SCALE);
      return m;
    }, (m, s) => {
      m.position.set(s.x, s.y, s.z);
      // 進む向き(岸のほう)を向く。船首が +X なので 90° ずらす
      m.rotation.y = Math.atan2(-this.post.outX, -this.post.outZ) + Math.PI / 2;
      m.position.y = s.y + Math.sin(t / 620 + s.id) * 0.012;
      m.rotation.z = Math.sin(t / 900 + s.id) * 0.05;
    });

    this._sync(raid.foes, this.foes, makeFoe, (m, f) => {
      m.position.set(f.x, f.y, f.z);
      m.rotation.y = Math.atan2(this.post.x - f.x, this.post.z - f.z);
      // 歩いているように上下させる(脚は作っていないので、跳ねで代える)
      m.position.y = f.y + Math.abs(Math.sin(t / 150 + f.id)) * 0.012;
    });

    this._sync(raid.arrows, this.arrows, makeArrow, (m, a) => {
      m.position.set(a.x, a.y, a.z);
      // 飛んでいる向きを向く。落ちるにつれて先が下を向く
      m.rotation.y = Math.atan2(a.vx, a.vz);
      m.rotation.x = -Math.atan2(a.vy, Math.hypot(a.vx, a.vz));
    });

    this._tickSplash(t);
  }

  // 当たった/降りたの合図(archery.js の events)
  onEvents(events) {
    for (const e of events) {
      if (e.type === 'sink') this._splash(e.x, this.post.y - 0.24, e.z, 0.30, 0x9fd4e8);
      if (e.type === 'down') this._splash(e.x, this.post.y, e.z, 0.14, 0xb84a3a);
    }
  }

  _splash(x, y, z, r, color) {
    const m = new THREE.Mesh(
      new THREE.SphereGeometry(r, 8, 6),
      new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.7 }),
    );
    m.position.set(x, y, z);
    m.scale.setScalar(0.3);
    this.scene.add(m);
    this.splashes.push({ m, t: 0 });
  }

  _tickSplash(t) {
    const keep = [];
    for (const s of this.splashes) {
      s.t += 1 / 60;
      const k = s.t / 0.45;
      if (k >= 1) { s.m.removeFromParent(); dispose(s.m); continue; }
      s.m.scale.setScalar(0.3 + k * 1.1);
      s.m.material.opacity = 0.7 * (1 - k);
      keep.push(s);
    }
    this.splashes = keep;
  }

  // 進行の配列と、置いてあるメッシュを突き合わせる。
  // 増えたら作り、減ったら捨てる ── 毎フレーム作り直すと、船が瞬く。
  _sync(list, map, make, place) {
    const alive = new Set();
    for (const item of list) {
      alive.add(item.id);
      let m = map.get(item.id);
      if (!m) { m = make(item); this.scene.add(m); map.set(item.id, m); }
      place(m, item);
    }
    for (const [id, m] of map) {
      if (alive.has(id)) continue;
      m.removeFromParent();
      dispose(m);
      map.delete(id);
    }
  }

  // 撃つのをやめた。櫓は残して、船と蛮族と矢だけ片付ける
  reset() {
    for (const map of [this.ships, this.foes, this.arrows]) {
      for (const m of map.values()) { m.removeFromParent(); dispose(m); }
      map.clear();
    }
    for (const s of this.splashes) { s.m.removeFromParent(); dispose(s.m); }
    this.splashes = [];
  }

  dispose() {
    this.tower.removeFromParent();
    dispose(this.tower);
    for (const map of [this.ships, this.foes, this.arrows]) {
      for (const m of map.values()) { m.removeFromParent(); dispose(m); }
      map.clear();
    }
    for (const s of this.splashes) { s.m.removeFromParent(); dispose(s.m); }
    this.splashes = [];
  }
}
