// 円卓(大富豪の島)。みんなで囲んで座るための家具。
//
// 受付の台(desk.js)の代わりに島の中心へ据える。**台と同じ扱い**にして
// あるので、近づけば受付のパネルが開くし、ぶつかりもする ── walk-mode は
// 「受付が台か円卓か」だけを見分ければよい。
//
// 寸法は素のまま書いて、いちばん外の入れ物に縮尺を1回だけ掛ける
// (desk.js と同じ。ぶつかる大きさと席の並びは ground.js)。
//
// 札そのものはここには置かない。手札も場も画面の HUD で見せる ──
// 携帯の画面で卓の上の札を読ませるには、カメラを卓に寄せるしかなく、
// そうすると誰が座っているのか分からなくなる。

import * as THREE from 'three';
import { WALK_SCALE, HIP_Y } from './scale.js';
import { TABLE_RADIUS, SEAT_R, tableSeats } from './ground.js';
import { makeSignFace } from './desk.js';

// 素の寸法(縮尺を掛ける前)
const R = TABLE_RADIUS / WALK_SCALE;      // 天板の半径
const RING = SEAT_R / WALK_SCALE;         // 腰かけの輪
const TOP_Y = 0.17;                       // 天板の高さ
const STOOL_Y = HIP_Y;                    // 腰かけの座面 = 棒人間の腰の高さ
const STOOL_R = 0.055;

export function makeTable(scene, x, z, groundY, meet, seats = 6) {
  const g = new THREE.Group();
  g.position.set(x, groundY, z);
  g.scale.setScalar(WALK_SCALE);

  const wood = new THREE.MeshStandardMaterial({ color: 0x8a5a32, roughness: 0.85 });
  const dark = new THREE.MeshStandardMaterial({ color: 0x4a3a24, roughness: 0.8 });
  const cloth = new THREE.MeshStandardMaterial({ color: 0x2f6d4f, roughness: 0.9 });
  const board = new THREE.MeshStandardMaterial({ color: 0xf0dcb4, roughness: 0.9 });

  // 天板。緑の布を張った丸卓(札を置く卓に見えるように)
  const top = new THREE.Mesh(new THREE.CylinderGeometry(R, R, 0.028, 24), wood);
  top.position.y = TOP_Y;
  top.castShadow = true;
  top.receiveShadow = true;
  g.add(top);
  const felt = new THREE.Mesh(new THREE.CylinderGeometry(R * 0.88, R * 0.88, 0.006, 24), cloth);
  felt.position.y = TOP_Y + 0.017;
  g.add(felt);

  // 一本脚と台座。四本脚だと座る足とぶつかって見える
  const stem = new THREE.Mesh(new THREE.CylinderGeometry(0.045, 0.055, TOP_Y, 10), wood);
  stem.position.y = TOP_Y / 2;
  stem.castShadow = true;
  g.add(stem);
  const foot = new THREE.Mesh(new THREE.CylinderGeometry(0.13, 0.15, 0.022, 12), dark);
  foot.position.y = 0.011;
  g.add(foot);

  // 腰かけ。席の数だけ輪の上に並べる(ground.js の tableSeats と同じ並び)
  for (const spot of tableSeats({ x: 0, z: 0 }, seats)) {
    // tableSeats は世界の寸法で返す。この入れ物は縮尺前なので割り戻す
    const sx = spot.x / WALK_SCALE;
    const sz = spot.z / WALK_SCALE;
    const seat = new THREE.Mesh(
      new THREE.CylinderGeometry(STOOL_R, STOOL_R * 0.9, 0.018, 10), wood,
    );
    seat.position.set(sx, STOOL_Y, sz);
    seat.castShadow = true;
    g.add(seat);
    const leg = new THREE.Mesh(new THREE.CylinderGeometry(0.014, 0.02, STOOL_Y, 6), dark);
    leg.position.set(sx, STOOL_Y / 2, sz);
    g.add(leg);
  }

  // 柱・看板・旗。卓は低いので、遠くからは何も見えない ── 目印が要る。
  //
  // **卓のまん中から上へ伸ばす。** 席の輪の外に立てると、その席に座った人の
  // 真後ろに柱が来て、カメラと本人の間を塞ぐ(実際そうなっていた)。席は
  // 輪を埋めているので「空いている方角」は無い。真ん中なら誰の邪魔にもならず、
  // 看板は座った人の頭より高いので、向かいの顔も隠さない。
  // 看板は**座った人の頭よりずっと上**へ。低いと、向かいに座っている人の
  // 体にちょうど重なって顔が読めなくなる(卓を挟んで正面に来るため)。
  const SIGN_Y = TOP_Y + 0.62;
  const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.011, 0.013, SIGN_Y - TOP_Y, 6), wood);
  pole.position.set(0, TOP_Y + (SIGN_Y - TOP_Y) / 2, 0);
  pole.castShadow = true;
  g.add(pole);

  // 表裏の両面に文字を焼き込む(どちらから来ても読める)
  const faces = [board, board, board, board, makeSignFace(meet.sign), makeSignFace(meet.sign)];
  const sign = new THREE.Mesh(new THREE.BoxGeometry(0.26, 0.13, 0.015), faces);
  sign.position.set(0, SIGN_Y, 0);
  sign.castShadow = true;
  g.add(sign);

  const mast = new THREE.Mesh(new THREE.CylinderGeometry(0.008, 0.008, 0.20, 5), dark);
  mast.position.set(0, SIGN_Y + 0.17, 0);
  g.add(mast);
  const flag = new THREE.Mesh(new THREE.ConeGeometry(0.05, 0.11, 3), cloth);
  flag.rotation.z = -Math.PI / 2;
  flag.position.set(0.04, SIGN_Y + 0.23, 0);
  g.add(flag);

  scene.add(g);
  return {
    group: g,
    dispose() {
      g.removeFromParent();
      g.traverse((o) => {
        o.geometry?.dispose?.();
        if (o.material) {
          (Array.isArray(o.material) ? o.material : [o.material]).forEach((m) => m.dispose?.());
        }
      });
    },
  };
}
