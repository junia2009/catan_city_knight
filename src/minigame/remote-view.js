// 散策部屋で「他の人」を描く。
//
// 位置は remote.js が補間した結果を受け取るだけ。ここは見た目の担当で、
// 物理も入力も持たない ── 相手の体を動かすのは相手の端末の仕事。
//
// 姿勢は自分と同じ pose.js を通す。applyPose(walker.js)を共有しているので、
// 項目を足したときに「相手だけ足が交差する」ようなずれが起きない。

import * as THREE from 'three';
import { makeWalker, walkerHeight } from './body.js';
import { applyPose } from './walker.js';
import { walkPose, airPose, tumblePose, fishPose, emotePose } from './pose.js';
import { WALK_SPEED } from './motion.js';
import { ST } from './remote-st.js';
import { emoteById } from './emote.js';
import { speciesById, DEFAULT_SPECIES } from './species.js';

// 席ごとの色。対戦の4色に、散策部屋のぶんを足して8色。
// 隣り合う席が似た色にならないように並べてある。
export const WALK_COLORS = [
  0xf04343, 0x3f8ef7, 0xffa02e, 0xb06ef0,
  0x36c98d, 0xf25fa8, 0x7ad0e8, 0xd9c34a,
];

// 名札は頭の少し上。背丈はすがたによって違う(角やもこもこで伸びる)ので、
// 決め打ちにしない ── 固定値だと、背の高い子の名札が頭にめり込む。
const nameY = (sp) => walkerHeight(sp) + 0.13;
// 名札の高さ(ワールド座標)。棒人間の身長の 2 割ほど。
// 一度これを 0.26 にしたら、近づいたとき画面の半分を名札が占めて
// 肝心の相手が見えなくなった ── 名前は添えるもので、主役ではない。
const NAME_H = 0.17;

// 名札。名前は変わらないので、席ごとに1枚だけ作って使い回す。
function makeNameTag(text, y) {
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
  sprite.position.y = y;
  sprite.renderOrder = 10;   // 木や山に隠れず、誰がどこにいるか分かるように
  return sprite;
}

// エモートの吹き出し。遠くにいる相手は体が小さくて身ぶりが読めないので、
// 名札の上に絵文字を1つ浮かべる。
// 名札(0.17)より気持ち大きいくらい。同じ理由で大きくしすぎない ──
// 絵文字は目立つので、名札より一回り大きいだけで十分に読める。
const BUBBLE_H = 0.2;

function makeBubble(icon, y) {
  const canvas = document.createElement('canvas');
  canvas.width = 96;
  canvas.height = 96;
  const c = canvas.getContext('2d');
  c.fillStyle = 'rgba(255, 255, 255, 0.94)';
  c.beginPath();
  c.arc(48, 48, 44, 0, Math.PI * 2);
  c.fill();
  c.font = '52px system-ui, "Apple Color Emoji", "Noto Color Emoji", sans-serif';
  c.textAlign = 'center';
  c.textBaseline = 'middle';
  c.fillText(icon, 48, 52);

  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({
    map: tex, transparent: true, depthTest: false,
  }));
  sprite.scale.set(BUBBLE_H, BUBBLE_H, 1);
  sprite.position.y = y;
  sprite.renderOrder = 11;
  return sprite;
}

export class RemoteView {
  // groundAt(x, z) → { y }。相手の足を地面に合わせるのに使う
  constructor(scene, groundAt) {
    this.scene = scene;
    this.groundAt = groundAt;
    this.people = new Map();   // seat -> { parts, tag, name, sp, phase, spin, t, y }
  }

  _make(seat, name, look) {
    const sp = speciesById(look ?? DEFAULT_SPECIES);
    const parts = makeWalker(WALK_COLORS[seat % WALK_COLORS.length], sp);
    this.scene.add(parts.group);
    const tag = name ? makeNameTag(name, nameY(sp)) : null;
    if (tag) parts.group.add(tag);
    const e = {
      parts, tag, name: name ?? null, sp, look: sp.id,
      phase: 0, spin: 0, t: 0, y: 0,
      emote: 0, emoteT: 0, bubble: null,
    };
    this.people.set(seat, e);
    return e;
  }

  // people: remote.js の sample() が返したもの
  update(dt, people) {
    const seen = new Set();
    for (const p of people) {
      seen.add(p.seat);
      let e = this.people.get(p.seat);
      if (!e) e = this._make(p.seat, p.name, p.look);
      // すがたを変えた/名簿が後から届いた。体ごと作り直す
      // (耳やしっぽは組み立て時に足しているので、後から差し替えられない)
      if (p.look && p.look !== e.look) {
        this._remove(p.seat, e);
        e = this._make(p.seat, p.name ?? e.name, p.look);
      }
      // 名前は後から名簿が届くことがある
      if (p.name && p.name !== e.name) {
        if (e.tag) { e.tag.removeFromParent(); disposeSprite(e.tag); }
        e.name = p.name;
        e.tag = makeNameTag(p.name, nameY(e.sp));
        e.parts.group.add(e.tag);
      }

      e.t += dt;
      const ground = this.groundAt(p.x, p.z).y;
      const y = ground + p.y;
      // 上下の変化から、跳んでいる勢いを読む(vy は送っていない)
      const vy = dt > 0 ? (y - e.y) / dt : 0;
      e.y = y;

      // エモート。番号が変わったら最初から流し直す(同じ身ぶりの2回目も含む)
      const em = p.emote ?? 0;
      if (em !== e.emote) {
        e.emote = em;
        e.emoteT = 0;
        this._setBubble(e, em);
      } else if (em) {
        e.emoteT += dt;
      }
      const emote = em ? emoteById(em) : null;
      // 送り手が終わりを伝える前に自分の時計で終わってしまったら、立ち姿へ戻す
      const emoteK = emote ? e.emoteT / (emote.ms / 1000) : 1;
      if (e.bubble) e.bubble.visible = emoteK < 1;

      e.parts.rod.group.visible = p.st === ST.fish;
      let pose;
      if (emote && emoteK < 1 && p.st === ST.walk) {
        pose = emotePose(emote.key, e.emoteT, p.facing, emoteK);
      } else if (p.st === ST.fish) {
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

  // 吹き出しを掛け替える。0 なら外す。
  _setBubble(e, id) {
    if (e.bubble) {
      e.bubble.removeFromParent();
      disposeSprite(e.bubble);
      e.bubble = null;
    }
    const em = id ? emoteById(id) : null;
    if (!em) return;
    e.bubble = makeBubble(em.icon, nameY(e.sp) + 0.19);
    e.parts.group.add(e.bubble);
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

function disposeSprite(sprite) {
  sprite.material.map?.dispose();
  sprite.material.dispose();
}
