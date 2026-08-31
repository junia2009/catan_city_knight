// 島を歩く人(ミニゲーム)
//
// 動きは素直な歩行アニメーションだけ。手足を交互に振り、わずかに上下する。
// 一度「ばねで行き過ぎさせてぐらつかせる」実装にしたが、画面が揺れて
// 見づらいだけだったのでやめた ── 揺らすなら、まず滑らかに歩けること。
//
// 見た目(メッシュの組み立てと寸法)は body.js。
//
// ここはゲームの state を一切知らない。地面の高さと歩ける範囲だけを
// 外から関数で受け取る(walk-mode.js が盤面から作って渡す)。
//
// 動きの計算そのものは motion.js に置いてある(THREE 抜きでテストするため)。
// このファイルは「その結果をメッシュに反映する」だけ。

import * as THREE from 'three';
import { WalkerMotion, WALK_SPEED, MAX_DT } from './motion.js';
import { walkPose, airPose, tumblePose, sinkPose } from './pose.js';
import { makeWalker, walkerHeight, CUTE } from './body.js';

export { WALK_SPEED };

export { makeWalker };

// 足元から頭のてっぺんまで(タイル1枚が約1.0)
export const WALKER_HEIGHT = walkerHeight(CUTE);

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
    const y = r.groundY + m.y;

    if (r.falling) {
      this._apply(
        r.inWater ? sinkPose(r.sinkT, m.facing, m.spin) : tumblePose(m.spin, m.facing),
        y,
      );
      return r;
    }

    this.phase += r.speed * Math.min(dt, MAX_DT) * 5.2;
    const gait = Math.min(1, r.speed / WALK_SPEED);
    this._apply(
      r.grounded ? walkPose(this.phase, gait, m.facing) : airPose(m.vy, m.facing),
      y,
    );
    return r;
  }

  // 姿勢をメッシュへ流し込む。pose.js が返す項目を「毎回全部」書くので、
  // 前の姿勢の値が残らない(海から上がって足が交差したまま、が起きない)。
  _apply(pose, y) {
    const p = this.parts;
    p.group.position.set(this.pos.x, y, this.pos.z);
    for (const part of ['group', 'hips', 'chest', 'head']) {
      const a = pose[part];
      p[part].rotation.set(a.x, a.y, a.z);
    }
    p.mouth.smile.visible = pose.mouth.open < 0.5;
    p.mouth.open.visible = pose.mouth.open >= 0.5;
    for (const part of ['legs', 'arms']) {
      pose[part].forEach((limb, i) => {
        p[part][i].root.rotation.x = limb.rootX;
        p[part][i].root.rotation.z = limb.rootZ;
        p[part][i].knee.rotation.x = limb.knee;
      });
    }
  }

  dispose() {
    this.parts.group.removeFromParent();
    this.parts.group.traverse((o) => {
      o.geometry?.dispose?.();
      if (o.material) (Array.isArray(o.material) ? o.material : [o.material]).forEach((m) => m.dispose?.());
    });
  }
}
