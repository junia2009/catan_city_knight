// 散策部屋で「他の人」を描く。
//
// 位置は remote.js が補間した結果を受け取るだけ。ここは見た目の担当で、
// 物理も入力も持たない ── 相手の体を動かすのは相手の端末の仕事。
//
// 姿勢は自分と同じ pose.js を通す。applyPose(walker.js)を共有しているので、
// 項目を足したときに「相手だけ足が交差する」ようなずれが起きない。

import * as THREE from 'three';
import { makeWalker, walkerHeight, CUTE } from './body.js';
import { applyPose } from './walker.js';
import { walkPose, airPose, tumblePose, fishPose } from './pose.js';
import { WALK_SPEED } from './motion.js';
import { ST } from './remote-st.js';

// 席ごとの色。対戦の4色に、散策部屋のぶんを足して8色。
// 隣り合う席が似た色にならないように並べてある。
export const WALK_COLORS = [
  0xf04343, 0x3f8ef7, 0xffa02e, 0xb06ef0,
  0x36c98d, 0xf25fa8, 0x7ad0e8, 0xd9c34a,
];

const HEIGHT = walkerHeight(CUTE);
const NAME_Y = HEIGHT + 0.13;   // 名札は頭の少し上
// 名札の高さ(ワールド座標)。棒人間の身長の 2 割ほど。
// 一度これを 0.26 にしたら、近づいたとき画面の半分を名札が占めて
// 肝心の相手が見えなくなった ── 名前は添えるもので、主役ではない。
const NAME_H = 0.17;

// 名札。名前は変わらないので、席ごとに1枚だけ作って使い回す。
function makeNameTag(text) {
  const pad = 12;
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');
  const font = 'bold 40px system-ui, sans-serif';
  ctx.font = font;
  const w = Math.ceil(ctx.measureText(text).width) + pad * 2;
  canvas.width = Math.max(64, w);
  canvas.height = 64;
  const c = canvas.getContext('2d');
  c.font = font;
  c.textAlign = 'center';
  c.textBaseline = 'middle';
  // 下地。空にも地面にも溶けないように、暗い角丸を敷く
  c.fillStyle = 'rgba(8, 22, 38, 0.72)';
  c.beginPath();
  c.roundRect(0, 8, canvas.width, 48, 12);
  c.fill();
  c.fillStyle = '#ffffff';
  c.fillText(text, canvas.width / 2, 32);

  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({
    map: tex, transparent: true, depthTest: false,
  }));
  sprite.scale.set((canvas.width / canvas.height) * NAME_H, NAME_H, 1);
  sprite.position.y = NAME_Y;
  sprite.renderOrder = 10;   // 木や山に隠れず、誰がどこにいるか分かるように
  return sprite;
}

export class RemoteView {
  // groundAt(x, z) → { y }。相手の足を地面に合わせるのに使う
  constructor(scene, groundAt) {
    this.scene = scene;
    this.groundAt = groundAt;
    this.people = new Map();   // seat -> { parts, tag, name, phase, spin, t, y }
  }

  _make(seat, name) {
    const parts = makeWalker(WALK_COLORS[seat % WALK_COLORS.length]);
    this.scene.add(parts.group);
    const tag = name ? makeNameTag(name) : null;
    if (tag) parts.group.add(tag);
    const e = { parts, tag, name: name ?? null, phase: 0, spin: 0, t: 0, y: 0 };
    this.people.set(seat, e);
    return e;
  }

  // people: remote.js の sample() が返したもの
  update(dt, people) {
    const seen = new Set();
    for (const p of people) {
      seen.add(p.seat);
      let e = this.people.get(p.seat);
      if (!e) e = this._make(p.seat, p.name);
      // 名前は後から名簿が届くことがある
      if (p.name && p.name !== e.name) {
        if (e.tag) { e.tag.removeFromParent(); disposeTag(e.tag); }
        e.name = p.name;
        e.tag = makeNameTag(p.name);
        e.parts.group.add(e.tag);
      }

      e.t += dt;
      const ground = this.groundAt(p.x, p.z).y;
      const y = ground + p.y;
      // 上下の変化から、跳んでいる勢いを読む(vy は送っていない)
      const vy = dt > 0 ? (y - e.y) / dt : 0;
      e.y = y;

      e.parts.rod.group.visible = p.st === ST.fish;
      let pose;
      if (p.st === ST.fish) {
        pose = fishPose(e.t, p.facing, { phase: 'wait' });
      } else if (p.st === ST.fall) {
        e.spin += dt * 3.4;
        pose = tumblePose(e.spin, p.facing);
      } else if (p.st === ST.air) {
        pose = airPose(vy, p.facing);
      } else {
        e.phase += p.speed * dt * 5.2;
        pose = walkPose(e.phase, Math.min(1, p.speed / WALK_SPEED), p.facing);
      }
      applyPose(e.parts, pose, p.x, y, p.z);
    }

    // 消えた人は片付ける
    for (const [seat, e] of this.people) {
      if (seen.has(seat)) continue;
      this._remove(seat, e);
    }
  }

  _remove(seat, e) {
    e.parts.group.removeFromParent();
    e.parts.group.traverse((o) => {
      o.geometry?.dispose?.();
      if (o.material) {
        (Array.isArray(o.material) ? o.material : [o.material]).forEach((m) => m.dispose?.());
      }
    });
    this.people.delete(seat);
  }

  dispose() {
    for (const [seat, e] of [...this.people]) this._remove(seat, e);
  }
}

function disposeTag(tag) {
  tag.material.map?.dispose();
  tag.material.dispose();
}
