// 棒人間の見た目(メッシュの組み立て)。
//
// 寸法は下の PROPS にまとめてある。ここを差し替えれば体型が変わるので、
// 比べながら決められる(walker.js は組み上がった関節だけを触る)。
//
// 関節の構成は pose.js が前提にしている形から変えないこと:
//   group → hips → (torso, chest, legs[].root → knee)
//   chest → (head, eyes, mouth, arms[].root → knee)

import * as THREE from 'three';

const SKIN = 0xffd9a8;
const CLOTH = 0x2f6fd0;
const SHOE = 0x2b3550;
const EYE = 0x22242a;

// ずんぐりデフォルメ。頭が大きく首がなく、手はミトン、靴は大きめ。
// 「足元から頭のてっぺんまで」がタイル1枚(1.0)の半分くらいになるよう組む。
// 高さの積み上げ: hipY + chestY + headY + headR = 足元から頭のてっぺん。
// 胴が脚より下まで垂れると脚が隠れて寸詰まりに見えるので、
// 胴の下端(bodyY − bodyLen/2 − bodyR)が膝(−thigh)より上に来るようにする。
export const CUTE = {
  // 脚の長さを変えるときは hipY も同じだけ動かすこと。
  // 足首は hipY − thigh − shin なので、脚だけ縮めると靴が宙に浮く。
  hipY: 0.118,         // 腰の高さ(脚の付け根)
  bodyR: 0.072,        // 胴の太さ
  bodyLen: 0.04,       // 胴の直線部(短くして豆のような形に)
  bodyY: 0.062,        // 胴の中心(腰から)
  chestY: 0.115,       // 首の位置(腰から)
  headR: 0.105,        // 頭。全身の 4 割ほどを頭にすると幼く見える
  // 頭を下げすぎると肩ごと胴を飲み込んで、頭に脚が生えたように見える。
  // 頭の下端が胴の上端より少し下、くらいで止める(首は作らない)。
  headY: 0.110,        // 頭の中心(首から)
  eye: { r: 0.019, x: 0.040, y: 0.012, z: 0.093 },
  mouth: { r: 0.024, tube: 0.006, y: -0.030, z: 0.096 },
  // 肩は胴の外へ出す(bodyR + armR より内側だと腕が胴に埋まる)
  shoulder: { x: 0.093, y: 0.015 },
  // 腕は脚(thigh + shin)と同じくらいの長さに揃える。
  // 脚だけ詰めると腕が長く見えて、手が靴のそばまで垂れる。
  armR: 0.031, upperArm: 0.043, foreArm: 0.035, handR: 0.037,
  hipX: 0.050,         // 脚の間隔。近すぎると2本が1本に見える
  legR: 0.036, thigh: 0.038, shin: 0.035,
  shoe: { r: 0.038, len: 0.042, lift: -0.004, ahead: 0.022 },
};

// 手足1本。上下2節で、付け根から吊り下げる。
// end は手先/足先に付ける物(無くてもよい)。
function makeLimb(mat, upper, lower, thick, end) {
  const root = new THREE.Group();
  const upperMesh = new THREE.Mesh(new THREE.CapsuleGeometry(thick, upper, 4, 8), mat);
  upperMesh.position.y = -upper / 2;
  upperMesh.castShadow = true;
  root.add(upperMesh);

  const knee = new THREE.Group();
  knee.position.y = -upper;
  const lowerMesh = new THREE.Mesh(
    new THREE.CapsuleGeometry(thick * 0.92, lower, 4, 8), mat,
  );
  lowerMesh.position.y = -lower / 2;
  lowerMesh.castShadow = true;
  knee.add(lowerMesh);
  if (end) {
    end.position.y -= lower;
    knee.add(end);
  }
  root.add(knee);

  return { root, knee };
}

// 口。ふだんはにっこり、驚いたら「お」の口。
// 2つ作って切り替える(小さく映るので、形が変わったほうが分かりやすい)。
function makeMouth(mat, m) {
  const smile = new THREE.Mesh(
    new THREE.TorusGeometry(m.r, m.tube, 5, 12, Math.PI), mat,
  );
  smile.rotation.z = Math.PI;   // 半円の口角を上げる
  const open = new THREE.Mesh(new THREE.SphereGeometry(m.r * 0.62, 10, 8), mat);
  open.scale.set(0.85, 1, 0.5);
  for (const o of [smile, open]) o.position.set(0, m.y, m.z);
  open.visible = false;
  return { smile, open };
}

// ミトンの手。指は作らない ── 小さく映るので、丸いほうが可愛く見える。
function makeHand(mat, r) {
  const m = new THREE.Mesh(new THREE.SphereGeometry(r, 10, 8), mat);
  m.scale.set(1, 0.9, 0.95);
  m.castShadow = true;
  return m;
}

// 大きめの靴。横倒しのカプセルで、つま先が前(+Z)へ出る。
function makeShoe(mat, s) {
  const g = new THREE.Group();
  const m = new THREE.Mesh(new THREE.CapsuleGeometry(s.r, s.len, 4, 10), mat);
  m.rotation.x = Math.PI / 2;   // 縦のカプセルを寝かせる
  m.scale.set(1, 1, 0.78);      // 少し平たく
  m.position.set(0, s.lift, s.ahead);
  m.castShadow = true;
  g.add(m);
  return g;
}

export function makeWalker(color = CLOTH, p = CUTE) {
  const g = new THREE.Group();
  const mat = (c) => new THREE.MeshStandardMaterial({ color: c, roughness: 0.75, metalness: 0.02 });
  const skin = mat(SKIN);
  const cloth = mat(color);
  const shoe = mat(SHOE);

  // 腰。ここを動かすと全身が付いてくる
  const hips = new THREE.Group();
  hips.position.y = p.hipY;
  g.add(hips);

  // 胴。下がすぼまった卵形にすると、ずんぐりして見える
  const torso = new THREE.Mesh(new THREE.CapsuleGeometry(p.bodyR, p.bodyLen, 5, 12), cloth);
  torso.position.y = p.bodyY;
  torso.scale.set(1, 1, 0.88);
  torso.castShadow = true;
  hips.add(torso);

  // 首は作らない。頭を胴に載せる
  const chest = new THREE.Group();
  chest.position.y = p.chestY;
  hips.add(chest);

  const head = new THREE.Mesh(new THREE.SphereGeometry(p.headR, 18, 14), skin);
  head.position.y = p.headY;
  head.scale.set(1, 0.96, 0.96);
  head.castShadow = true;
  chest.add(head);

  // 目。向いている方向が分かるようにする(+Z が前)
  const eyeGeo = new THREE.SphereGeometry(p.eye.r, 8, 8);
  const eyeMat = new THREE.MeshBasicMaterial({ color: EYE });
  for (const sx of [-1, 1]) {
    const eye = new THREE.Mesh(eyeGeo, eyeMat);
    eye.position.set(sx * p.eye.x, p.headY + p.eye.y, p.eye.z);
    eye.scale.set(0.85, 1, 0.7);
    chest.add(eye);
  }

  const mouth = makeMouth(eyeMat, { ...p.mouth, y: p.headY + p.mouth.y });
  chest.add(mouth.smile, mouth.open);

  const arms = [-1, 1].map((sx) => {
    const limb = makeLimb(skin, p.upperArm, p.foreArm, p.armR, makeHand(skin, p.handR));
    limb.root.position.set(sx * p.shoulder.x, p.shoulder.y, 0);
    chest.add(limb.root);
    return limb;
  });

  const legs = [-1, 1].map((sx) => {
    const limb = makeLimb(cloth, p.thigh, p.shin, p.legR, makeShoe(shoe, p.shoe));
    limb.root.position.set(sx * p.hipX, 0, 0);
    hips.add(limb.root);
    return limb;
  });

  return { group: g, hips, chest, head, mouth, arms, legs };
}

// 足元から頭のてっぺんまで。カメラの寄りや当たり判定の目安に使う。
export function walkerHeight(p = CUTE) {
  return p.hipY + p.chestY + p.headY + p.headR;
}
