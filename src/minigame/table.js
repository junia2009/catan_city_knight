// 円卓(大富豪の島)。みんなで囲んで座るための家具。
//
// 受付の台(desk.js)の代わりに島の中心へ据える。**台と同じ扱い**にして
// あるので、近づけば受付のパネルが開くし、ぶつかりもする ── walk-mode は
// 「受付が台か円卓か」だけを見分ければよい。
//
// 寸法は素のまま書いて、いちばん外の入れ物に縮尺を1回だけ掛ける
// (desk.js と同じ。ぶつかる大きさと席の並びは ground.js)。
//
// **手札は置かない。場に出ている札だけを天板へ並べる。**
// 手札まで卓の上で読ませようとすると、カメラを寄せるしかなくなり、誰が
// 座っているのか分からなくなる ── 読ませるのは画面下の HUD の仕事。
// 卓の上の札は「いま何が出ているか」が遠目に分かればよいので、小さくてよい。

import * as THREE from 'three';
import { WALK_SCALE, HIP_Y } from './scale.js';
import { TABLE_RADIUS, SEAT_R, tableSeats } from './ground.js';
import { makeSignFace } from './desk.js';
import { RANKS, SUITS, isJoker, rankOf, suitOf } from './daifugo.js';

// 素の寸法(縮尺を掛ける前)
const R = TABLE_RADIUS / WALK_SCALE;      // 天板の半径
const RING = SEAT_R / WALK_SCALE;         // 腰かけの輪
const TOP_Y = 0.17;                       // 天板の高さ
const STOOL_Y = HIP_Y;                    // 腰かけの座面 = 棒人間の腰の高さ
const STOOL_R = 0.055;
// 天板に置く札。並べる幅は天板に収まるまで詰める
const CARD_W = 0.13;
const CARD_H = 0.18;
const CARD_GAP = 0.095;

// 札の絵を canvas に描いて板に貼る(フォントも画像も積まずに済む。
// desk.js の看板と同じやり方)。同じ札は作り直さないので溜めておく。
const faceCache = new Map();
function cardFace(c) {
  if (faceCache.has(c)) return faceCache.get(c);
  const canvas = document.createElement('canvas');
  canvas.width = 96;
  canvas.height = 136;
  const g = canvas.getContext('2d');
  g.fillStyle = isJoker(c) ? '#2b3b52' : '#fdfaf3';
  g.fillRect(0, 0, 96, 136);
  g.strokeStyle = isJoker(c) ? '#4a5f7d' : '#d8cdb8';
  g.lineWidth = 5;
  g.strokeRect(2.5, 2.5, 91, 131);
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  if (isJoker(c)) {
    g.fillStyle = '#ffd97d';
    g.font = 'bold 54px system-ui, sans-serif';
    g.fillText('JK', 48, 68);
  } else {
    const suit = suitOf(c);
    g.fillStyle = suit === 1 || suit === 2 ? '#c0392b' : '#1d2733';
    g.font = 'bold 52px system-ui, sans-serif';
    g.fillText(RANKS[rankOf(c)], 48, 50);
    g.font = 'bold 40px system-ui, sans-serif';
    g.fillText(SUITS[suit], 48, 98);
  }
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  faceCache.set(c, tex);
  return tex;
}

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

  // 表裏の両面に文字を焼き込む(どちらから来ても読める)
  const faces = [board, board, board, board, makeSignFace(meet.sign), makeSignFace(meet.sign)];
  const sign = new THREE.Mesh(new THREE.BoxGeometry(0.26, 0.13, 0.015), faces);
  sign.position.set(0, SIGN_Y, 0);
  sign.castShadow = true;

  const mast = new THREE.Mesh(new THREE.CylinderGeometry(0.008, 0.008, 0.20, 5), dark);
  mast.position.set(0, SIGN_Y + 0.17, 0);
  const flag = new THREE.Mesh(new THREE.ConeGeometry(0.05, 0.11, 3), cloth);
  flag.rotation.z = -Math.PI / 2;
  flag.position.set(0.04, SIGN_Y + 0.23, 0);

  // 場に出ている札を置くところ。
  //   外(fieldGroup) … 読む向きを合わせるために Y で回す
  //   内(fieldFlat)  … 板を寝かせて、札の上を +Z へ向ける
  const fieldGroup = new THREE.Group();
  fieldGroup.position.y = TOP_Y + 0.022;
  g.add(fieldGroup);
  const fieldFlat = new THREE.Group();
  fieldFlat.rotation.set(-Math.PI / 2, 0, Math.PI);
  // **見ている人のほうへ寄せる。** 天板のまん中に置くと、看板の柱が
  // ちょうど札の上を通って読めなくなる(柱は誰の邪魔にもならない位置に
  // 立てるため、まん中から動かせない)。手前に寄れば読みやすくもなる。
  fieldFlat.position.z = -R * 0.25;
  fieldGroup.add(fieldFlat);
  const cardGeo = new THREE.PlaneGeometry(CARD_W, CARD_H);

  // 柱・看板・旗はひとまとまりにする。一人称で座ると目の前に立つので、
  // 座っている間だけ隠せるようにしておく(遠くからの目印としては要る)。
  const signPost = new THREE.Group();
  signPost.add(pole, sign, mast, flag);
  g.add(signPost);

  scene.add(g);
  return {
    group: g,
    // 看板を出す/隠す。**隠すのは座っている本人の画面だけ** ──
    // 一人称の目の高さでは、卓のまん中から伸びる柱がまともに視界を塞ぐ。
    // 相手の画面では出たままなので、世界から消えるわけではない。
    setSignVisible(on) { signPost.visible = !!on; },
    // 場の札を並べ直す。cards は daifugo.js の番号(空なら片付ける)。
    // seatAngle は見る人の席の角度 ── **札の上をその人と反対側へ向ける**ので、
    // どこに座っていても自分から見て正しい向きで読める。
    setField(cards = [], seatAngle = Math.PI) {
      fieldGroup.rotation.y = seatAngle + Math.PI;
      for (const gone of [...fieldFlat.children]) {
        fieldFlat.remove(gone);
        gone.material?.dispose?.();
      }
      const n = cards.length;
      if (!n) return;
      // 天板からはみ出さないように、枚数が増えたら重ねて詰める
      const gap = Math.min(CARD_GAP, (R * 1.5) / n);
      cards.forEach((c, i) => {
        const m = new THREE.Mesh(cardGeo, new THREE.MeshBasicMaterial({ map: cardFace(c) }));
        m.position.set((i - (n - 1) / 2) * gap, 0, 0);
        fieldFlat.add(m);
      });
    },
    dispose() {
      cardGeo.dispose();
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
