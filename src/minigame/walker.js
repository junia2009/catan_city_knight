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
import {
  walkPose, airPose, tumblePose, sinkPose, fishPose, emotePose, PHASE_PER_UNIT,
} from './pose.js';
import { makeWalker } from './body.js';

export { WALK_SPEED };

export { makeWalker };

// 姿勢をメッシュへ流し込む。pose.js が返す項目を「毎回全部」書くので、
// 前の姿勢の値が残らない(海から上がって足が交差したまま、が起きない)。
//
// 自分の体(Walker)と、散策部屋で描く他の人(remote-view.js)の両方が通る。
// 2か所に書くと、片方だけ項目を足したときに静かにずれる。
export function applyPose(parts, pose, x, y, z) {
  parts.group.position.set(x, y, z);
  for (const part of ['group', 'hips', 'chest', 'head']) {
    const a = pose[part];
    parts[part].rotation.set(a.x, a.y, a.z);
  }
  parts.mouth.smile.visible = pose.mouth.open < 0.5;
  parts.mouth.open.visible = pose.mouth.open >= 0.5;
  for (const part of ['legs', 'arms']) {
    pose[part].forEach((limb, i) => {
      parts[part][i].root.rotation.x = limb.rootX;
      parts[part][i].root.rotation.z = limb.rootZ;
      parts[part][i].knee.rotation.x = limb.knee;
    });
  }
}

export class Walker {
  // groundAt(x, z) → { y, ok }。ok が false なら「そこは地面でない」
  // blockAt: 盤の上の物にめり込ませないための関数(obstacles.js)
  // species: species.js の1つ(省略すると「ひと」)
  constructor(scene, groundAt, color, blockAt = null, species = null) {
    this.parts = makeWalker(color, species);
    this.species = species;
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
    // メッシュもその場へ移す。位置を書くのは毎フレームの _apply だけなので、
    // 一度も更新されないまま残ると原点(島の中心)に埋まったままになる。
    this.parts.group.position.set(x, this.motion.groundAt(x, z).y, z);
  }

  // 竿を出す/しまう。出している間は歩かせない(walk-mode.js が入力を止める)
  setRod(on) {
    this.parts.rod.group.visible = !!on;
  }

  // 釣りの姿勢だけを当てる。歩きの update とは排他(釣り中は動かない)。
  // t は経過秒、k は fishing.js の view() から作った { phase, tension, ... }。
  fish(t, k) {
    this.phase = 0;
    const g = this.motion.groundAt(this.pos.x, this.pos.z);
    this._apply(fishPose(t, this.motion.facing, k), g.y);
  }

  // エモートの姿勢を当てる。歩きの update を回したあとに上書きして使う
  // ── 重力や地面の追従は update に任せ、見た目だけ差し替える。
  emote(key, t, k) {
    this.phase = 0;
    const g = this.motion.groundAt(this.pos.x, this.pos.z);
    this._apply(emotePose(key, t, this.motion.facing, k), g.y + this.motion.y);
  }

  // 竿先の世界座標(糸をここから垂らす)
  rodTip(out) {
    return this.parts.rod.tip.getWorldPosition(out);
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

    const was = this.phase;
    // 位相は**進んだ距離**で進める(速さ × 刻み = 距離)。
    // 1歩で進む距離は脚の長さから引いてある(pose.js)ので、
    // 縮尺を変えても足と地面の関係が崩れない。
    this.phase += r.speed * Math.min(dt, MAX_DT) * PHASE_PER_UNIT;
    const gait = Math.min(1, r.speed / WALK_SPEED);
    this._apply(
      r.grounded ? walkPose(this.phase, gait, m.facing) : airPose(m.vy, m.facing),
      y,
    );
    // 足が地面に着いた瞬間。歩行サイクルは半周(π)で片足ぶんなので、
    // π の倍数をまたいだら1歩。音を鳴らす側が動きと合わせられるように返す。
    const stepped = r.grounded && r.speed > 0.05
      && Math.floor(this.phase / Math.PI) !== Math.floor(was / Math.PI);
    return stepped ? { ...r, stepped: true, gait } : r;
  }

  _apply(pose, y) {
    applyPose(this.parts, pose, this.pos.x, y, this.pos.z);
  }

  dispose() {
    this.parts.group.removeFromParent();
    this.parts.group.traverse((o) => {
      o.geometry?.dispose?.();
      if (o.material) (Array.isArray(o.material) ? o.material : [o.material]).forEach((m) => m.dispose?.());
    });
  }
}
