// 棒人間の見た目(メッシュの組み立て)。
//
// 寸法は下の PROPS にまとめてある。ここを差し替えれば体型が変わるので、
// 比べながら決められる(walker.js は組み上がった関節だけを触る)。
//
// 関節の構成は pose.js が前提にしている形から変えないこと:
//   group → hips → (torso, chest, legs[].root → knee)
//   chest → (head, eyes, mouth, arms[].root → knee)

import * as THREE from 'three';
import { speciesById, DEFAULT_SPECIES } from './species.js';

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
  // 釣り竿。手のさきから腕の延長方向(-Y)へ伸ばす。
  // 腕を前上がりに構えると、そのまま竿も前上がりになる。
  rod: { len: 0.42, r: 0.0055, grip: 0.05 },
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

// 釣り竿。手のさきから腕の延長(-Y)へ伸ばすので、腕の角度がそのまま竿の角度になる。
// 先端に空の目印を置いてある ── 糸はそこから垂らす(fishing-fx.js)。
function makeRod(r) {
  const g = new THREE.Group();
  const wood = new THREE.MeshStandardMaterial({ color: 0x6b4a2a, roughness: 0.8 });
  const dark = new THREE.MeshStandardMaterial({ color: 0x2b3550, roughness: 0.6 });

  // 竿。先へ行くほど細くする(円錐台)
  const rod = new THREE.Mesh(new THREE.CylinderGeometry(r.r * 0.35, r.r, r.len, 6), wood);
  rod.position.y = -r.len / 2;
  rod.castShadow = true;
  g.add(rod);

  // 握り。手のところだけ太くすると「持っている」ように見える
  const grip = new THREE.Mesh(new THREE.CylinderGeometry(r.r * 2, r.r * 2, r.grip, 6), dark);
  grip.position.y = -r.grip / 2;
  g.add(grip);

  // リール
  const reel = new THREE.Mesh(new THREE.CylinderGeometry(r.r * 3, r.r * 3, r.r * 3, 8), dark);
  reel.rotation.z = Math.PI / 2;
  reel.position.set(r.r * 3, -r.grip - r.r * 3, 0);
  g.add(reel);

  const tip = new THREE.Object3D();
  tip.position.y = -r.len;
  g.add(tip);

  return { group: g, tip };
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

// ---- すがたごとの飾り(species.js の parts を読んで足す)----
//
// どれも「頭」か「腰」に付ける。頭に付けたものは首の動きに、腰に付けたものは
// 体のひねりに付いてくる ── 胴に付けると、うつむいても耳だけ正面を向く。

// 耳。三角(ねこ)・まる(くま)・とがって長い(きつね)・垂れ(ひつじ)
function makeEars(furMat, accMat, kind, p) {
  const g = new THREE.Group();
  const r = p.headR;
  for (const sx of [-1, 1]) {
    const ear = new THREE.Group();
    if (kind === 'round') {
      const outer = new THREE.Mesh(new THREE.SphereGeometry(r * 0.38, 10, 8), furMat);
      const inner = new THREE.Mesh(new THREE.SphereGeometry(r * 0.22, 8, 6), accMat);
      inner.position.z = r * 0.16;
      ear.add(outer, inner);
      ear.position.set(sx * r * 0.72, r * 0.72, 0);
    } else {
      // 円錐。きつねは細長く、ひつじは横へ垂らす
      const len = kind === 'fox' ? r * 0.95 : r * 0.62;
      const wide = kind === 'droop' ? r * 0.30 : r * 0.26;
      const outer = new THREE.Mesh(new THREE.ConeGeometry(wide, len, 7), furMat);
      outer.position.y = len / 2;
      const inner = new THREE.Mesh(new THREE.ConeGeometry(wide * 0.55, len * 0.7, 7), accMat);
      inner.position.set(0, len * 0.42, wide * 0.35);
      ear.add(outer, inner);
      ear.position.set(sx * r * 0.55, r * 0.62, 0);
      ear.rotation.z = sx * (kind === 'droop' ? 1.25 : 0.28);
      if (kind === 'droop') ear.position.y = r * 0.3;
    }
    ear.traverse((o) => { o.castShadow = true; });
    g.add(ear);
  }
  return g;
}

// しっぽ。腰の後ろから。ねこは立てて、きつねは太く、ドラゴンは太く長く垂らす
function makeTail(furMat, accMat, kind, p) {
  const g = new THREE.Group();
  const len = kind === 'fox' ? 0.13 : kind === 'dragon' ? 0.14 : 0.11;
  const thick = kind === 'fox' ? 0.030 : kind === 'dragon' ? 0.026 : 0.017;
  // ドラゴンだけ先細り。同じ太さのカプセルだと、横から見て青い棒になる
  const m = kind === 'dragon'
    ? new THREE.Mesh(new THREE.ConeGeometry(thick, len, 7), furMat)
    : new THREE.Mesh(new THREE.CapsuleGeometry(thick, len, 4, 8), furMat);
  m.position.y = len / 2;
  m.castShadow = true;
  g.add(m);
  if (kind === 'fox') {
    // 先だけ白くする
    const tip = new THREE.Mesh(new THREE.SphereGeometry(thick * 1.05, 10, 8), accMat);
    tip.position.y = len;
    g.add(tip);
  }
  if (kind === 'dragon') {
    // しっぽにも背びれを続ける。胴で終わると尻切れに見える
    for (let i = 0; i < 3; i += 1) {
      const k = 0.9 - i * 0.2;
      const fin = new THREE.Mesh(new THREE.ConeGeometry(thick * 0.75 * k, thick * 2 * k, 5), accMat);
      fin.position.set(0, len * (0.28 + i * 0.2), -thick * (0.62 - i * 0.14));
      fin.rotation.x = -0.7;
      g.add(fin);
    }
    // 先の矢じり
    const tip = new THREE.Mesh(new THREE.ConeGeometry(thick * 1.4, thick * 2.6, 4), accMat);
    tip.position.y = len * 0.98;
    tip.scale.set(1, 1, 0.4);
    g.add(tip);
  }
  // 付け根は胴の外へ出す。中に置くと丸ごと埋まって、後ろから見えない。
  g.position.set(0, p.bodyY * 0.55, -(p.bodyR + thick * 0.5));
  // rotation.x が正だと前(+Z)へ倒れて体に刺さる。後ろへ倒すので負。
  // ねこはほぼ立て、きつねは斜め、ドラゴンは水平に近く伸ばす。
  g.rotation.x = kind === 'dragon' ? -1.05 : kind === 'fox' ? -0.8 : -0.5;
  return g;
}

// くちばし(ペンギン)
function makeBeak(mat, p) {
  const m = new THREE.Mesh(new THREE.ConeGeometry(p.headR * 0.26, p.headR * 0.42, 8), mat);
  m.rotation.x = Math.PI / 2;
  m.position.set(0, -p.headR * 0.12, p.headR * 0.92);
  m.castShadow = true;
  return m;
}

// 鼻先。頭の前へ少しだけ出す(ねこ・くま・きつね・ドラゴン)
// 鼻先。**明るい色で作る** ── 体と同じ色にすると、暗い目が暗い顔に埋もれて
// 表情がまったく読めなかった。顔に明るい面を1つ作るだけで顔らしくなる。
function makeSnout(furMat, accMat, noseMat, p) {
  const g = new THREE.Group();
  const m = new THREE.Mesh(new THREE.SphereGeometry(p.headR * 0.32, 10, 8), accMat);
  m.scale.set(1, 0.8, 0.9);
  m.position.set(0, -p.headR * 0.30, p.headR * 0.80);
  const nose = new THREE.Mesh(new THREE.SphereGeometry(p.headR * 0.10, 8, 6), noseMat);
  nose.position.set(0, -p.headR * 0.24, p.headR * 1.02);
  g.add(m, nose);
  g.traverse((o) => { o.castShadow = true; });
  return g;
}

// もこもこ(ひつじ)。頭のまわりに球をいくつか散らす
function makeFluff(mat, p) {
  const g = new THREE.Group();
  const r = p.headR;
  // 位置は決め打ちの並び。乱数は使わない(対戦の乱数に触れないのはもちろん、
  // 見るたび形が変わると「同じ人」に見えなくなる)
  const spots = [
    [0, 0.72, -0.1], [-0.6, 0.5, -0.1], [0.6, 0.5, -0.1],
    [-0.45, 0.15, -0.6], [0.45, 0.15, -0.6], [0, 0.3, -0.8],
    [-0.75, 0.0, 0.1], [0.75, 0.0, 0.1],
  ];
  for (const [x, y, z] of spots) {
    const m = new THREE.Mesh(new THREE.SphereGeometry(r * 0.42, 10, 8), mat);
    m.position.set(x * r, y * r, z * r);
    m.castShadow = true;
    g.add(m);
  }
  return g;
}

// 角(ドラゴン)。後ろへ長く反らせる。
// 短い円錐を2本立てただけだと、後ろから見て「ねこの耳」と見分けが
// つかなかった ── 角は「長さと後ろへの反り」で角に見える。
function makeHorns(mat, p) {
  const g = new THREE.Group();
  for (const sx of [-1, 1]) {
    // 大きい角。根元から後ろ上へ伸ばし、途中で少し曲げる(2節に分ける)
    const horn = new THREE.Group();
    const lower = new THREE.Mesh(new THREE.ConeGeometry(p.headR * 0.19, p.headR * 0.6, 6), mat);
    lower.position.y = p.headR * 0.3;
    const upper = new THREE.Group();
    upper.position.y = p.headR * 0.55;
    upper.rotation.x = -0.55;                 // 先を後ろへ反らせる
    const tip = new THREE.Mesh(new THREE.ConeGeometry(p.headR * 0.12, p.headR * 0.5, 6), mat);
    tip.position.y = p.headR * 0.25;
    upper.add(tip);
    horn.add(lower, upper);
    horn.position.set(sx * p.headR * 0.5, p.headR * 0.66, -p.headR * 0.2);
    horn.rotation.z = sx * 0.34;
    horn.rotation.x = -0.3;
    g.add(horn);

    // 小さい角(頬の横)。2対にすると一気に「竜」らしくなる
    const small = new THREE.Mesh(new THREE.ConeGeometry(p.headR * 0.1, p.headR * 0.3, 5), mat);
    small.position.set(sx * p.headR * 0.72, p.headR * 0.1, -p.headR * 0.3);
    small.rotation.z = sx * 1.0;
    small.rotation.x = -0.4;
    g.add(small);
  }
  g.traverse((o) => { o.castShadow = true; });
  return g;
}

// 翼(ドラゴン)。背中に畳んだ翼を張る。
// 遊ぶときのカメラは背中側なので、いちばん目に入るのがここ。
function makeWings(furMat, accMat, p) {
  const g = new THREE.Group();
  // 小さいと「肩に付いた飾り」にしか見えない。胴の3倍ほどまで伸ばす。
  const span = p.bodyR * 2.7;
  for (const sx of [-1, 1]) {
    const wing = new THREE.Group();
    // 骨。付け根から斜め後ろ上へ、翼の前ぶちとして伸ばす
    const bone = new THREE.Mesh(
      new THREE.CapsuleGeometry(p.bodyR * 0.08, span * 0.85, 3, 6), furMat,
    );
    bone.position.y = span * 0.42;
    wing.add(bone);
    // 膜。平たい三角を3枚、扇のようにずらして重ねる
    for (let i = 0; i < 3; i += 1) {
      const k = 1 - i * 0.14;
      const m = new THREE.Mesh(new THREE.ConeGeometry(span * 0.34 * k, span * 0.8 * k, 3), accMat);
      m.position.set(sx * span * 0.17, span * 0.44 - i * span * 0.2, 0);
      m.rotation.z = sx * (0.35 + i * 0.28);
      m.scale.set(1, 1, 0.14);   // ぺたんこにして膜にする
      wing.add(m);
    }
    // 背中の上のほう(肩甲骨のあたり)。低いと腰の飾りに見える
    // 膜は平たいので、面が後ろを向くように付ける。横へ捻ると、横から見た
    // ときだけ板が突き出て「旗」に見える(遊ぶカメラは背中側)。
    wing.position.set(sx * p.bodyR * 0.45, 0.014, -p.bodyR * 0.82);
    wing.rotation.set(-0.12, sx * 0.22, sx * 0.4);
    g.add(wing);
  }
  g.traverse((o) => { o.castShadow = true; });
  return g;
}

// 背びれ(ドラゴン)。胴の背中側に三角を並べる
function makeSpikes(mat, p) {
  const g = new THREE.Group();
  for (let i = 0; i < 4; i += 1) {
    // 上ほど大きく。同じ大きさで並べると板を貼ったように見える
    const k = 1 - i * 0.16;
    const m = new THREE.Mesh(new THREE.ConeGeometry(p.bodyR * 0.2 * k, p.bodyR * 0.55 * k, 5), mat);
    m.position.set(0, p.bodyY + (1.1 - i) * p.bodyR * 0.4, -p.bodyR * 0.76);
    m.rotation.x = -0.6;
    m.castShadow = true;
    g.add(m);
  }
  return g;
}

// お腹(ペンギン・かえる)。胴の前に平たい球を貼る
function makeBelly(mat, p) {
  const m = new THREE.Mesh(new THREE.SphereGeometry(p.bodyR * 0.82, 12, 10), mat);
  m.scale.set(1, 1.15, 0.5);
  m.position.set(0, p.bodyY - p.bodyR * 0.08, p.bodyR * 0.62);
  return m;
}

// color はその人の色。species は species.js の1つ(省略すると「ひと」)。
//
// 動物(fur)は体ぜんぶがその人の色になり、ひとだけ服に色が付く。
// こうすると「赤いねこ」「青いねこ」で誰が誰か分かりつつ、種類も分かる。
export function makeWalker(color = CLOTH, species = speciesById(DEFAULT_SPECIES)) {
  const sp = species ?? speciesById(DEFAULT_SPECIES);
  const p = { ...CUTE, ...(sp.props ?? {}) };
  const parts = sp.parts ?? {};

  const g = new THREE.Group();
  const mat = (c) => new THREE.MeshStandardMaterial({ color: c, roughness: 0.75, metalness: 0.02 });
  // 動物は顔も手足も体の色。ひとは肌色のまま
  const skin = mat(sp.fur ? color : SKIN);
  const cloth = mat(color);
  const shoe = mat(sp.fur ? color : SHOE);
  const accent = mat(sp.accent ?? SKIN);

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

  // 顔だけ別の色にできる(ひつじの黒い顔など)。既定は体と同じ
  const faceMat = sp.face != null ? mat(sp.face) : skin;
  const head = new THREE.Mesh(new THREE.SphereGeometry(p.headR, 18, 14), faceMat);
  head.position.y = p.headY;
  head.scale.set(1, 0.96, 0.96);   // 顔の付け位置はこの潰しを割り戻す(下)
  head.castShadow = true;
  chest.add(head);

  // 目と口は「頭に付ける」。胴に付けると、首を振っても顔だけ正面を向いたまま
  // ── 頭は丸いので、顔が付いてこないと首の動きが画面上まったく見えない
  // (実際、しょんぼりで首を振らせても「振っているように見えない」となった)。
  // 位置は頭の中心からの相対にする(頭は chest の headY にいる)。
  // 頭は少し潰してある(scale)。子はその潰しを受けるので、割り戻して
  // 付ける ── そうしないと顔の位置だけ前より内側へ寄る。
  const hs = { y: 0.96, z: 0.96 };
  const eyeGeo = new THREE.SphereGeometry(p.eye.r, 8, 8);
  const eyeMat = new THREE.MeshBasicMaterial({ color: EYE });
  for (const sx of [-1, 1]) {
    if (parts.eyesOnTop) {
      // かえる。頭の上に大きな目を乗せる(白目ごと出っ張らせる)
      const ball = new THREE.Mesh(new THREE.SphereGeometry(p.headR * 0.34, 10, 8), skin);
      ball.position.set(sx * p.headR * 0.44, p.headR * 0.72 / hs.y, p.headR * 0.12 / hs.z);
      ball.castShadow = true;
      const pupil = new THREE.Mesh(new THREE.SphereGeometry(p.eye.r * 1.15, 8, 8), eyeMat);
      pupil.position.z = p.headR * 0.28;
      ball.add(pupil);
      head.add(ball);
      continue;
    }
    const eye = new THREE.Mesh(eyeGeo, eyeMat);
    eye.position.set(sx * p.eye.x, p.eye.y / hs.y, p.eye.z / hs.z);
    eye.scale.set(0.85, 1 / hs.y, 0.7 / hs.z);
    head.add(eye);
  }

  const mouth = makeMouth(eyeMat, { ...p.mouth, y: p.mouth.y / hs.y, z: p.mouth.z / hs.z });
  head.add(mouth.smile, mouth.open);

  const arms = [-1, 1].map((sx) => {
    const limb = makeLimb(skin, p.upperArm, p.foreArm, p.armR, makeHand(skin, p.handR));
    limb.root.position.set(sx * p.shoulder.x, p.shoulder.y, 0);
    chest.add(limb.root);
    return limb;
  });

  // 竿は右手(arms[1])に握らせる。ふだんは隠しておく
  const rod = makeRod(p.rod);
  rod.group.position.y = -(p.upperArm + p.foreArm);
  rod.group.visible = false;
  arms[1].knee.add(rod.group);

  const legs = [-1, 1].map((sx) => {
    const limb = makeLimb(cloth, p.thigh, p.shin, p.legR, makeShoe(shoe, p.shoe));
    limb.root.position.set(sx * p.hipX, 0, 0);
    hips.add(limb.root);
    return limb;
  });

  // ---- すがたの飾り ----
  // 頭に付けたものは首の動きに付いてくる(胴に付けると顔だけ正面を向く)
  if (parts.ears) head.add(makeEars(skin, accent, parts.ears, p));
  if (parts.snout) head.add(makeSnout(skin, accent, mat(EYE), p));
  if (parts.beak) head.add(makeBeak(accent, p));
  if (parts.horns) head.add(makeHorns(accent, p));
  if (parts.fluff) head.add(makeFluff(skin, p));
  // 翼は胴(chest)に付ける。上体をひねると一緒に動く
  if (parts.wings) chest.add(makeWings(skin, accent, p));
  // 腰(体のひねりに付いてくる)
  if (parts.tail) hips.add(makeTail(skin, accent, parts.tail, p));
  if (parts.spikes) hips.add(makeSpikes(accent, p));
  if (parts.belly) hips.add(makeBelly(accent, p));

  return { group: g, hips, chest, head, mouth, arms, legs, rod };
}

// 足元から頭のてっぺんまで。名札の高さとカメラの寄りに使う。
//
// すがたを渡すこと。角やもこもこで背が伸びるので、決め打ちの値を使うと
// のっぽの名札が頭にめり込む。
export function walkerHeight(species = speciesById(DEFAULT_SPECIES)) {
  const sp = species ?? speciesById(DEFAULT_SPECIES);
  const p = { ...CUTE, ...(sp.props ?? {}) };
  return p.hipY + p.chestY + p.headY + p.headR + (sp.top ?? 0);
}
