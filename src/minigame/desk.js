// 島の中心に立つ「釣り大会の受付」。
//
// ここへ寄るとエントリーできる。目印なので、遠くからでも見えるように
// 旗を高く上げてある ── 島は木や山で見通しが悪く、低い台だけだと
// 「どこにあるか分からない」になる。
//
// 進行そのものは持たない(サーバーの server/fishing-contest.js)。
// ここは見た目と「近いかどうか」だけ。

import * as THREE from 'three';

// 台の大きさ。棒人間(身長 0.45 ほど)の腰くらいに来る高さ
const TOP_Y = 0.19;
const HALF = 0.17;      // 台の横幅の半分
const DEPTH = 0.10;
export const DESK_RADIUS = 0.2;   // ぶつかる大きさ
// この距離まで近づいたらエントリーできる。
// 降り立つ輪(0.62)より内側にしてある ── 同じにすると、島に着いた瞬間から
// パネルが開いていて、自分から寄った感じがしない。
// 台にはぶつかるので、実際に立てるのは 0.36 あたりから。
export const DESK_REACH = 0.5;

// 看板の文字。canvas に描いて板に貼る(フォントを積まずに済む)。
// BoxGeometry の UV は面ごとに「外から見て正しい向き」に張られているので、
// 表裏どちらの面に貼っても鏡文字にはならない(自前で反転すると逆に鏡になる)。
function makeSignFace() {
  const canvas = document.createElement('canvas');
  canvas.width = 256;
  canvas.height = 128;
  const c = canvas.getContext('2d');
  c.fillStyle = '#f0dcb4';
  c.fillRect(0, 0, 256, 128);
  c.fillStyle = '#5a3a1c';
  c.font = 'bold 46px system-ui, sans-serif';
  c.textAlign = 'center';
  c.textBaseline = 'middle';
  c.fillText('つり大会', 128, 52);
  c.font = 'bold 26px system-ui, sans-serif';
  c.fillText('受付', 128, 96);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  return new THREE.MeshStandardMaterial({ map: tex, roughness: 0.9 });
}

export function makeDesk(scene, x, z, groundY) {
  const g = new THREE.Group();
  g.position.set(x, groundY, z);

  const wood = new THREE.MeshStandardMaterial({ color: 0x8a5a32, roughness: 0.85 });
  const dark = new THREE.MeshStandardMaterial({ color: 0x4a3a24, roughness: 0.8 });
  const cloth = new THREE.MeshStandardMaterial({ color: 0xe25c3c, roughness: 0.7 });
  const board = new THREE.MeshStandardMaterial({ color: 0xf0dcb4, roughness: 0.9 });

  // 天板
  const top = new THREE.Mesh(new THREE.BoxGeometry(HALF * 2, 0.035, DEPTH), wood);
  top.position.y = TOP_Y;
  top.castShadow = true;
  g.add(top);

  // 脚。4本だと細かいので、両端に板を1枚ずつ
  for (const sx of [-1, 1]) {
    const leg = new THREE.Mesh(new THREE.BoxGeometry(0.03, TOP_Y, DEPTH * 0.8), wood);
    leg.position.set(sx * (HALF - 0.03), TOP_Y / 2, 0);
    leg.castShadow = true;
    g.add(leg);
  }

  // 前掛け(赤い布)。台があることが遠目にも分かる
  const skirt = new THREE.Mesh(new THREE.BoxGeometry(HALF * 2, TOP_Y * 0.7, 0.012), cloth);
  skirt.position.set(0, TOP_Y * 0.42, DEPTH / 2);
  g.add(skirt);

  // 柱と看板
  const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.012, 0.012, 0.42, 6), wood);
  pole.position.set(-HALF + 0.02, 0.21, -DEPTH * 0.3);
  pole.castShadow = true;
  g.add(pole);

  // 看板。無地の板だと「ただの台」に見えるので、文字を焼き込む。
  // 受付は島の真ん中に立っていて、どちらから来るか分からない。表裏の
  // 両面に貼って、反対側から来た人にも「何の台か」が読めるようにする。
  const faces = [board, board, board, board, makeSignFace(), makeSignFace()];
  const sign = new THREE.Mesh(new THREE.BoxGeometry(0.24, 0.12, 0.015), faces);
  sign.position.set(-HALF + 0.12, 0.40, -DEPTH * 0.3);
  sign.castShadow = true;
  g.add(sign);

  // 旗。いちばん高いところに置いて、遠くからの目印にする
  const flag = new THREE.Mesh(new THREE.ConeGeometry(0.05, 0.11, 3), cloth);
  flag.rotation.z = -Math.PI / 2;
  flag.position.set(-HALF + 0.06, 0.60, -DEPTH * 0.3);
  g.add(flag);
  const mast = new THREE.Mesh(new THREE.CylinderGeometry(0.008, 0.008, 0.22, 5), dark);
  mast.position.set(-HALF + 0.02, 0.55, -DEPTH * 0.3);
  g.add(mast);

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
