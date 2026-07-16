// Three.js による 3D 盤面描画層(設計書 §8 の描画層を差し替えるもの)
// ルールエンジンには一切依存されない。GameState と UI 状態を受け取って描くだけ。
//
// - 静的レイヤー(海・島・地形・トークン・港)は setGame() で一度だけ構築
// - 動的レイヤー(道・建物・騎士・盗賊・城壁・メトロポリス)は update() で再構築
// - クリック判定は不可視のピッキングメッシュへのレイキャスト

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { LAYOUT, PIPS } from '../rules/board.js';
import { RES_JP_SHORT } from '../state.js';
import { BARBARIAN_TRACK_LENGTH as BARB_TRACK } from '../rules/cak/barbarians.js';

export const PLAYER_COLORS_3D = [0xf04343, 0x3f8ef7, 0xffa02e, 0xb06ef0];
const PLAYER_COLORS_DARK_3D = [0xa32020, 0x2358a8, 0xc06f14, 0x7a42b8];

const TERRAIN_COLORS = {
  forest: 0x3a7a4c,
  pasture: 0x8fbf52,
  field: 0xe3bc45,
  hill: 0xb96a3e,
  mountain: 0x8d99ab,
  desert: 0xe2d2a0,
};

const TILE_TOP = 0.26; // タイル上面の高さ
const SEA_Y = 0.02;

// ---- 決定的乱数(2D版と同じ思想。装飾の配置用)----

function hashStr(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function localRng(seed) {
  let s = seed || 1;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

function ringPositions(rng, count, rMin = 0.42, rMax = 0.62) {
  const out = [];
  const step = (Math.PI * 2) / count;
  for (let i = 0; i < count; i++) {
    const a = i * step + rng() * step * 0.6;
    const r = rMin + rng() * (rMax - rMin);
    out.push([Math.cos(a) * r, Math.sin(a) * r]);
  }
  return out;
}

// ---- 座標: 論理XY(axial→2D)を XZ 平面に置く。Y が上。----

const hexCenters = {};
function hexCenterOf(hid) {
  if (!hexCenters[hid]) {
    let x = 0, y = 0;
    for (const vid of LAYOUT.hexVertices[hid]) {
      x += LAYOUT.vertices[vid].x;
      y += LAYOUT.vertices[vid].y;
    }
    hexCenters[hid] = { x: x / 6, y: y / 6 };
  }
  return hexCenters[hid];
}

function vpos(vid) {
  const v = LAYOUT.vertices[vid];
  return new THREE.Vector3(v.x, TILE_TOP, v.y);
}

// ---- 共有ジオメトリ ----

// 全ヘックスは同一形状なので、コーナーオフセットから1つだけ作る
function hexShape(scale = 1) {
  const hid = LAYOUT.hexIds[0];
  const c = hexCenterOf(hid);
  const shape = new THREE.Shape();
  LAYOUT.hexVertices[hid].forEach((vid, i) => {
    const v = LAYOUT.vertices[vid];
    // ExtrudeGeometry は XY 平面 → rotateX(-90°) で XZ に倒すため y は -z
    const x = (v.x - c.x) * scale;
    const y = -(v.y - c.y) * scale;
    i === 0 ? shape.moveTo(x, y) : shape.lineTo(x, y);
  });
  shape.closePath();
  return shape;
}

function extrudedHex(scale, height, bevel = 0.025) {
  const geo = new THREE.ExtrudeGeometry(hexShape(scale), {
    depth: height,
    bevelEnabled: true,
    bevelThickness: bevel,
    bevelSize: bevel,
    bevelSegments: 1,
  });
  geo.rotateX(-Math.PI / 2);
  return geo;
}

const GEO = {
  tile: extrudedHex(0.965, TILE_TOP - 0.06),
  beach: extrudedHex(1.08, 0.09),
  hexFlat: (() => {
    const g = new THREE.ShapeGeometry(hexShape(0.94));
    g.rotateX(-Math.PI / 2);
    return g;
  })(),
  token: new THREE.CylinderGeometry(0.33, 0.33, 0.05, 24),
  trunk: new THREE.CylinderGeometry(0.02, 0.035, 0.1, 6),
  cone: new THREE.ConeGeometry(1, 1, 7),
  rock: new THREE.ConeGeometry(1, 1, 5),
  box: new THREE.BoxGeometry(1, 1, 1),
  sphere: new THREE.SphereGeometry(1, 10, 8),
  pawnBody: new THREE.ConeGeometry(0.095, 0.2, 10),
  pawnHead: new THREE.SphereGeometry(0.06, 10, 8),
  ring: new THREE.TorusGeometry(0.08, 0.014, 6, 16),
  wall: new THREE.TorusGeometry(0.17, 0.035, 8, 20, Math.PI * 1.7),
  crown: new THREE.CylinderGeometry(0.075, 0.09, 0.07, 8),
  pickVertex: new THREE.SphereGeometry(0.24, 8, 6),
  hlVertex: new THREE.SphereGeometry(0.13, 12, 10),
  pole: new THREE.CylinderGeometry(0.02, 0.02, 0.5, 6),
};

const MAT_CACHE = new Map();
function mat(color, opts = {}) {
  const key = `${color}:${JSON.stringify(opts)}`;
  if (!MAT_CACHE.has(key)) {
    MAT_CACHE.set(key, new THREE.MeshStandardMaterial({
      color, roughness: 0.85, metalness: 0.05, flatShading: true, ...opts,
    }));
  }
  return MAT_CACHE.get(key);
}

// コマ用: 少し発色を強く(視認性優先)
function pieceMat(color) {
  return mat(color, { roughness: 0.55, emissive: color, emissiveIntensity: 0.12 });
}

const PICK_MAT = new THREE.MeshBasicMaterial({
  transparent: true, opacity: 0, depthWrite: false,
});

// ---- テクスチャ(数字トークン・港の看板)----

const texCache = new Map();

function tokenTexture(token) {
  const key = `t${token}`;
  if (texCache.has(key)) return texCache.get(key);
  const cv = document.createElement('canvas');
  cv.width = cv.height = 256;
  const g = cv.getContext('2d');
  g.fillStyle = '#f8f1dd';
  g.fillRect(0, 0, 256, 256);
  const hot = token === 6 || token === 8;
  g.fillStyle = hot ? '#c1121f' : '#3a3226';
  g.font = '800 130px Georgia, serif';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillText(String(token), 128, 108);
  const pips = PIPS[token];
  for (let i = 0; i < pips; i++) {
    g.beginPath();
    g.arc(128 + (i - (pips - 1) / 2) * 30, 196, 10, 0, Math.PI * 2);
    g.fill();
  }
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  texCache.set(key, tex);
  return tex;
}

function portSprite(type) {
  const key = `p${type}`;
  if (!texCache.has(key)) {
    const cv = document.createElement('canvas');
    cv.width = 128; cv.height = 96;
    const g = cv.getContext('2d');
    g.fillStyle = '#b98b4f';
    g.strokeStyle = '#6f4e26';
    g.lineWidth = 6;
    g.beginPath();
    g.roundRect(4, 4, 120, 88, 14);
    g.fill();
    g.stroke();
    g.fillStyle = '#fff6e0';
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    if (type === '3:1') {
      g.font = '800 44px system-ui, sans-serif';
      g.fillText('3:1', 64, 50);
    } else {
      g.font = '800 34px system-ui, sans-serif';
      g.fillText(RES_JP_SHORT[type], 64, 30);
      g.fillText('2:1', 64, 68);
    }
    const tex = new THREE.CanvasTexture(cv);
    tex.colorSpace = THREE.SRGBColorSpace;
    texCache.set(key, tex);
  }
  const m = new THREE.SpriteMaterial({ map: texCache.get(key), depthTest: true });
  const sp = new THREE.Sprite(m);
  sp.scale.set(0.6, 0.45, 1);
  return sp;
}

// ---- 地形の装飾(ローポリ)----

function makeTree(rng, sizeMul = 1) {
  const g = new THREE.Group();
  const trunk = new THREE.Mesh(GEO.trunk, mat(0x5d4025));
  trunk.position.y = 0.05;
  g.add(trunk);
  // 色味とサイズに個体差をつける(2色の樹冠ペアからランダム)
  const palettes = [
    [0x2c6b3c, 0x1e5230],
    [0x37784a, 0x27603a],
    [0x24593a, 0x1a472e],
  ];
  const [top, bottom] = palettes[Math.floor(rng() * palettes.length)];
  const c1 = new THREE.Mesh(GEO.cone, mat(top));
  c1.scale.set(0.13, 0.2, 0.13);
  c1.position.y = 0.17;
  const c2 = new THREE.Mesh(GEO.cone, mat(bottom));
  c2.scale.set(0.1, 0.16, 0.1);
  c2.position.y = 0.28;
  g.add(c1, c2);
  g.rotation.y = rng() * Math.PI * 2;
  g.scale.setScalar((0.85 + rng() * 0.4) * sizeMul);
  g.traverse((o) => { o.castShadow = true; });
  return g;
}

function makeSheep(rng) {
  const g = new THREE.Group();
  const body = new THREE.Mesh(GEO.sphere, mat(0xf5f2e8, { roughness: 1 }));
  body.scale.set(0.075, 0.055, 0.055);
  body.position.y = 0.06;
  const head = new THREE.Mesh(GEO.sphere, mat(0x4a4038));
  head.scale.set(0.03, 0.03, 0.03);
  head.position.set(0.07, 0.075, 0);
  g.add(body, head);
  g.rotation.y = rng() * Math.PI * 2;
  g.traverse((o) => { o.castShadow = true; });
  return g;
}

function makeWheatBundle(rng) {
  const g = new THREE.Group();
  for (let i = 0; i < 3; i++) {
    const stalk = new THREE.Mesh(GEO.cone, mat(0xc79a2a));
    stalk.scale.set(0.03, 0.16, 0.03);
    stalk.position.set((i - 1) * 0.045, 0.08, (rng() - 0.5) * 0.04);
    stalk.rotation.z = (rng() - 0.5) * 0.3;
    stalk.castShadow = true;
    g.add(stalk);
  }
  return g;
}

function makeBricks(rng) {
  const g = new THREE.Group();
  const colors = [0x8f4526, 0x9c4f2c];
  for (let row = 0; row < 2; row++) {
    for (let col = 0; col < 2; col++) {
      const b = new THREE.Mesh(GEO.box, mat(colors[(row + col) % 2]));
      b.scale.set(0.13, 0.05, 0.08);
      b.position.set(
        (col - 0.5) * 0.14 + (row % 2 ? 0.035 : 0),
        0.03 + row * 0.055,
        0,
      );
      b.castShadow = true;
      g.add(b);
    }
  }
  g.rotation.y = rng() * Math.PI;
  return g;
}

function makePeak(rng, big = 1) {
  const g = new THREE.Group();
  const h = (0.3 + rng() * 0.14) * big;
  const r = (0.17 + rng() * 0.05) * big;
  const rock = new THREE.Mesh(GEO.rock, mat(0x7d8798));
  rock.scale.set(r, h, r);
  rock.position.y = h / 2;
  rock.rotation.y = rng() * Math.PI;
  rock.castShadow = true;
  const snow = new THREE.Mesh(GEO.rock, mat(0xeef2f6, { roughness: 0.6 }));
  snow.scale.set(r * 0.4, h * 0.32, r * 0.4);
  snow.position.y = h * 0.84;
  snow.rotation.y = rock.rotation.y;
  g.add(rock, snow);
  return g;
}

function makeCactus(rng) {
  const g = new THREE.Group();
  const m = mat(0x4f7a3a);
  const body = new THREE.Mesh(GEO.box, m);
  body.scale.set(0.045, 0.18, 0.045);
  body.position.y = 0.09;
  const arm = new THREE.Mesh(GEO.box, m);
  arm.scale.set(0.04, 0.09, 0.04);
  arm.position.set(0.055, 0.12, 0);
  g.add(body, arm);
  g.rotation.y = rng() * Math.PI * 2;
  g.traverse((o) => { o.castShadow = true; });
  return g;
}

function makeDune() {
  const d = new THREE.Mesh(GEO.sphere, mat(0xd2bd85));
  d.scale.set(0.18, 0.04, 0.12);
  return d;
}

// ---- 地形の起伏(タイル上面に重ねる低ポリ地表)----
// 中心(数字トークン)と縁(建物・道)は平らなまま、中間リングだけ盛り上げる。
// セクター境界の頂点は座標ハッシュで同じ高さ・同じ色になるため継ぎ目は出ない。
const CAP_PARAMS = {
  forest: { amp: 0.042, freq: 5.2, jitter: 0.10, tint: 0x3f8152 },
  pasture: { amp: 0.03, freq: 4.2, jitter: 0.08, tint: 0x93c258 },
  field: { amp: 0.02, freq: 6.5, jitter: 0.07, tint: 0xe6c04c },
  hill: { amp: 0.06, freq: 4.6, jitter: 0.11, tint: 0xbd7043 },
  mountain: { amp: 0.10, freq: 5.8, jitter: 0.14, tint: 0x93a0b2 },
  desert: { amp: 0.05, freq: 2.6, jitter: 0.06, tint: 0xe6d7a6 },
};

function coordHash(x, z) {
  const s = Math.sin(x * 127.1 + z * 311.7) * 43758.5453;
  return s - Math.floor(s);
}

function makeTerrainCap(hid, terrain) {
  const prm = CAP_PARAMS[terrain];
  if (!prm) return null;
  const c = hexCenterOf(hid);
  const phase = (hashStr(hid) % 628) / 100;
  // 角オフセット(全ヘックス同形なので先頭ヘックスから取る)
  const first = LAYOUT.hexIds[0];
  const fc = hexCenterOf(first);
  const corners = LAYOUT.hexVertices[first].map((vid) => [
    (LAYOUT.vertices[vid].x - fc.x) * 0.955,
    (LAYOUT.vertices[vid].y - fc.y) * 0.955,
  ]);

  const N = 4; // セクター内の分割数
  const positions = [];
  const colors = [];
  const base = new THREE.Color(prm.tint);
  const heightAt = (x, z, t) => {
    // 中心と縁で0、中間で最大のプロファイル
    const profile = Math.pow(Math.sin(Math.PI * Math.min(t, 1)), 1.3);
    const n =
      0.55 + 0.45 * Math.sin(x * prm.freq + phase) * Math.cos(z * (prm.freq * 0.8) - phase);
    const j = coordHash(x + c.x, z + c.y) * 0.5;
    return 0.004 + prm.amp * profile * (n * 0.7 + j * 0.6);
  };
  const pushVert = (x, z, t) => {
    positions.push(x, heightAt(x, z, t), z);
    const shade = 1 + (coordHash(x + c.x + 9.7, z + c.y - 3.1) - 0.5) * 2 * prm.jitter;
    colors.push(base.r * shade, base.g * shade, base.b * shade);
  };
  // 各セクター(中心・角A・角B の三角形)をバリセントリック分割し、非インデックスで積む
  for (let s = 0; s < 6; s++) {
    const A = corners[s];
    const B = corners[(s + 1) % 6];
    const P = (i, j) => [(A[0] * i + B[0] * j) / N, (A[1] * i + B[1] * j) / N, (i + j) / N];
    for (let i = 0; i < N; i++) {
      for (let j = 0; j < N - i; j++) {
        const p0 = P(i, j);
        const p1 = P(i + 1, j);
        const p2 = P(i, j + 1);
        pushVert(p0[0], p0[1], p0[2]);
        pushVert(p2[0], p2[1], p2[2]);
        pushVert(p1[0], p1[1], p1[2]);
        if (i + j < N - 1) {
          const p3 = P(i + 1, j + 1);
          pushVert(p1[0], p1[1], p1[2]);
          pushVert(p2[0], p2[1], p2[2]);
          pushVert(p3[0], p3[1], p3[2]);
        }
      }
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geo.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  geo.computeVertexNormals();
  const mesh = new THREE.Mesh(
    geo,
    new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.95, flatShading: true }),
  );
  mesh.position.set(c.x, TILE_TOP, c.y);
  mesh.receiveShadow = true;
  return mesh;
}

function decorateHex(group, hid, terrain) {
  const rng = localRng(hashStr(hid + terrain));
  const c = hexCenterOf(hid);
  const add = (obj, dx, dz) => {
    obj.position.x += c.x + dx;
    obj.position.z += c.y + dz;
    obj.position.y += TILE_TOP;
    group.add(obj);
  };

  if (terrain === 'forest') {
    // 大小・色違いの木を2重リングで(森の密度)
    for (const [dx, dz] of ringPositions(rng, 6, 0.42, 0.68)) add(makeTree(rng), dx, dz);
    for (const [dx, dz] of ringPositions(rng, 3, 0.24, 0.36)) add(makeTree(rng, 0.75), dx, dz);
  } else if (terrain === 'pasture') {
    for (const [dx, dz] of ringPositions(rng, 2, 0.42, 0.58)) add(makeSheep(rng), dx, dz);
    for (const [dx, dz] of ringPositions(rng, 7, 0.3, 0.68)) {
      const tuft = new THREE.Mesh(GEO.cone, mat(rng() < 0.5 ? 0x6f9d3d : 0x7fae49));
      const s = 0.03 + rng() * 0.015;
      tuft.scale.set(s, s * 2.1, s);
      tuft.position.y = s;
      add(tuft, dx, dz);
    }
    // 白い花
    for (const [dx, dz] of ringPositions(rng, 3, 0.3, 0.6)) {
      const flower = new THREE.Mesh(GEO.sphere, mat(0xf3f0e2, { roughness: 1 }));
      flower.scale.setScalar(0.018);
      flower.position.y = 0.03;
      add(flower, dx, dz);
    }
  } else if (terrain === 'field') {
    // 畝(平行な畑の列)+ 麦束
    const rowRot = rng() * Math.PI;
    for (let i = -1; i <= 1; i++) {
      const furrow = new THREE.Mesh(GEO.box, mat(0xcda437, { roughness: 1 }));
      furrow.scale.set(1.05 - Math.abs(i) * 0.22, 0.02, 0.1);
      furrow.rotation.y = rowRot;
      furrow.position.set(
        Math.sin(rowRot) * i * 0.28, 0.012, Math.cos(rowRot) * i * 0.28,
      );
      add(furrow, 0, 0);
    }
    for (const [dx, dz] of ringPositions(rng, 6, 0.38, 0.64)) add(makeWheatBundle(rng), dx, dz);
  } else if (terrain === 'hill') {
    for (const [dx, dz] of ringPositions(rng, 3, 0.42, 0.6)) add(makeBricks(rng), dx, dz);
    // 粘土の塚
    for (const [dx, dz] of ringPositions(rng, 3, 0.28, 0.55)) {
      const mound = new THREE.Mesh(GEO.sphere, mat(0xa3562e, { roughness: 1 }));
      mound.scale.set(0.12 + rng() * 0.05, 0.05 + rng() * 0.03, 0.1 + rng() * 0.05);
      mound.position.y = 0.02;
      add(mound, dx, dz);
    }
  } else if (terrain === 'mountain') {
    add(makePeak(rng, 1.15), -0.3, 0.38);
    add(makePeak(rng), 0.36, 0.32);
    add(makePeak(rng, 0.85), 0.05, 0.55);
    add(makePeak(rng, 0.9), -0.15, -0.5);
    // 麓の岩くず
    for (const [dx, dz] of ringPositions(rng, 4, 0.5, 0.72)) {
      const rock = new THREE.Mesh(GEO.rock, mat(0x6e7887, { roughness: 1 }));
      const s = 0.04 + rng() * 0.05;
      rock.scale.set(s, s * 1.2, s);
      rock.position.y = s * 0.5;
      rock.rotation.y = rng() * 3;
      add(rock, dx, dz);
    }
  } else if (terrain === 'desert') {
    for (const [dx, dz] of ringPositions(rng, 3, 0.35, 0.6)) add(makeDune(), dx, dz);
    add(makeCactus(rng), 0.42, -0.38);
    add(makeCactus(rng), -0.5, 0.2);
    // 風化した岩
    for (const [dx, dz] of ringPositions(rng, 2, 0.5, 0.7)) {
      const rock = new THREE.Mesh(GEO.rock, mat(0xcbb98a, { roughness: 1 }));
      const s = 0.05 + rng() * 0.04;
      rock.scale.set(s, s * 0.8, s);
      rock.position.y = s * 0.4;
      rock.rotation.y = rng() * 3;
      add(rock, dx, dz);
    }
  }
}

// ---- ピース ----

// 建物の足元に敷くプレイヤー色の台座(視認性のため色面積を増やす)
function basePlate(pid, r = 0.2) {
  const m = new THREE.Mesh(
    new THREE.CylinderGeometry(r, r * 1.1, 0.035, 16),
    pieceMat(PLAYER_COLORS_DARK_3D[pid]),
  );
  m.position.y = 0.018;
  return m;
}

function makeRoad(eid, pid, opacity = 1) {
  const [v1, v2] = LAYOUT.edges[eid].v.map(vpos);
  const dir = v2.clone().sub(v1);
  const len = dir.length();
  const m = new THREE.Mesh(
    GEO.box,
    opacity < 1
      ? new THREE.MeshStandardMaterial({
          color: PLAYER_COLORS_3D[pid], transparent: true, opacity, flatShading: true,
        })
      : pieceMat(PLAYER_COLORS_3D[pid]),
  );
  m.scale.set(len * 0.62, 0.11, 0.11);
  m.position.copy(v1).add(v2).multiplyScalar(0.5);
  m.position.y = TILE_TOP + 0.055;
  m.rotation.y = -Math.atan2(dir.z, dir.x);
  m.castShadow = true;
  return m;
}

function makeSettlement(pid) {
  const g = new THREE.Group();
  g.add(basePlate(pid, 0.2));
  const body = new THREE.Mesh(GEO.box, pieceMat(PLAYER_COLORS_3D[pid]));
  body.scale.set(0.28, 0.19, 0.23);
  body.position.y = 0.125;
  const roof = new THREE.Mesh(GEO.cone, mat(PLAYER_COLORS_DARK_3D[pid], { roughness: 0.55 }));
  roof.scale.set(0.22, 0.16, 0.19);
  roof.rotation.y = Math.PI / 4;
  roof.position.y = 0.3;
  g.add(body, roof);
  g.traverse((o) => { o.castShadow = true; });
  return g;
}

function makeCity(pid) {
  const g = new THREE.Group();
  g.add(basePlate(pid, 0.25));
  const base = new THREE.Mesh(GEO.box, pieceMat(PLAYER_COLORS_3D[pid]));
  base.scale.set(0.42, 0.19, 0.26);
  base.position.y = 0.125;
  const tower = new THREE.Mesh(GEO.box, pieceMat(PLAYER_COLORS_3D[pid]));
  tower.scale.set(0.19, 0.44, 0.23);
  tower.position.set(-0.12, 0.22, 0);
  const roof = new THREE.Mesh(GEO.cone, mat(PLAYER_COLORS_DARK_3D[pid], { roughness: 0.55 }));
  roof.scale.set(0.16, 0.15, 0.17);
  roof.rotation.y = Math.PI / 4;
  roof.position.set(-0.12, 0.51, 0);
  const roof2 = new THREE.Mesh(GEO.cone, mat(PLAYER_COLORS_DARK_3D[pid], { roughness: 0.55 }));
  roof2.scale.set(0.15, 0.11, 0.16);
  roof2.rotation.y = Math.PI / 4;
  roof2.position.set(0.1, 0.27, 0);
  g.add(base, tower, roof, roof2);
  g.traverse((o) => { o.castShadow = true; });
  return g;
}

function makeKnight(k) {
  const g = new THREE.Group();
  g.add(basePlate(k.player, 0.17));
  const color = k.active ? PLAYER_COLORS_3D[k.player] : 0x9aa0a8;
  const bodyMat = k.active ? pieceMat(color) : mat(color);
  const body = new THREE.Mesh(GEO.pawnBody, bodyMat);
  body.scale.setScalar(1.45);
  body.position.y = 0.17;
  const head = new THREE.Mesh(GEO.pawnHead, bodyMat);
  head.scale.setScalar(1.45);
  head.position.y = 0.36;
  g.add(body, head);
  for (let i = 0; i < k.level; i++) {
    const ring = new THREE.Mesh(GEO.ring, mat(0xffffff, { roughness: 0.4 }));
    ring.rotation.x = Math.PI / 2;
    ring.scale.setScalar(1.5 - i * 0.25);
    ring.position.y = 0.09 + i * 0.065;
    g.add(ring);
  }
  g.traverse((o) => { o.castShadow = true; });
  return g;
}

// ---- 環境演出(帆船・飛行機・雲) ----

function makeSailboat(sailColor) {
  const g = new THREE.Group();
  const hullMat = mat(0x8a6238, { roughness: 0.9 });
  const hull = new THREE.Mesh(GEO.box, hullMat);
  hull.scale.set(0.55, 0.13, 0.2);
  hull.position.y = 0.08;
  const prow = new THREE.Mesh(GEO.cone, hullMat);
  prow.scale.set(0.1, 0.2, 0.1);
  prow.rotation.z = -Math.PI / 2;
  prow.position.set(0.37, 0.08, 0);
  const mast = new THREE.Mesh(GEO.pole, mat(0x5a4328));
  mast.position.y = 0.38;
  const sailShape = new THREE.Shape();
  sailShape.moveTo(0, 0);
  sailShape.lineTo(0, 0.46);
  sailShape.quadraticCurveTo(0.3, 0.24, 0.26, 0);
  sailShape.closePath();
  const sail = new THREE.Mesh(
    new THREE.ShapeGeometry(sailShape),
    new THREE.MeshStandardMaterial({
      color: sailColor, roughness: 0.85, side: THREE.DoubleSide, flatShading: true,
    }),
  );
  sail.position.set(0.02, 0.16, 0);
  g.add(hull, prow, mast, sail);
  g.traverse((o) => { o.castShadow = true; });
  return g;
}

function makePlane() {
  const g = new THREE.Group();
  const bodyMat = mat(0xe8e2d2, { roughness: 0.6 });
  const accentMat = mat(0xd9534f, { roughness: 0.6 });
  const body = new THREE.Mesh(new THREE.CylinderGeometry(0.09, 0.055, 0.62, 8), bodyMat);
  body.rotation.z = -Math.PI / 2;
  const nose = new THREE.Mesh(GEO.cone, accentMat);
  nose.scale.set(0.09, 0.12, 0.09);
  nose.rotation.z = -Math.PI / 2;
  nose.position.x = 0.36;
  const wing = new THREE.Mesh(GEO.box, accentMat);
  wing.scale.set(0.16, 0.03, 0.95);
  wing.position.set(0.05, 0.03, 0);
  const tail = new THREE.Mesh(GEO.box, accentMat);
  tail.scale.set(0.1, 0.03, 0.3);
  tail.position.set(-0.28, 0.04, 0);
  const fin = new THREE.Mesh(GEO.box, accentMat);
  fin.scale.set(0.1, 0.16, 0.03);
  fin.position.set(-0.28, 0.12, 0);
  const prop = new THREE.Mesh(GEO.box, mat(0x4a4038));
  prop.scale.set(0.02, 0.3, 0.05);
  prop.position.x = 0.43;
  g.add(body, nose, wing, tail, fin, prop);
  g.userData.prop = prop;
  g.traverse((o) => { o.castShadow = true; });
  return g;
}

function makeCloud(rng) {
  const g = new THREE.Group();
  const m = new THREE.MeshStandardMaterial({
    color: 0xf2f5f8, roughness: 1, flatShading: true,
    transparent: true, opacity: 0.92,
  });
  const n = 3 + Math.floor(rng() * 3);
  for (let i = 0; i < n; i++) {
    const puff = new THREE.Mesh(GEO.sphere, m);
    const s = 0.5 + rng() * 0.7;
    puff.scale.set(s * 1.6, s * 0.55, s);
    puff.position.set((i - (n - 1) / 2) * s * 1.2, (rng() - 0.5) * 0.2, (rng() - 0.5) * 0.6);
    g.add(puff);
  }
  return g;
}

function makeRobber() {
  const g = new THREE.Group();
  // 足元の赤リングで目立たせる
  const ring = new THREE.Mesh(
    new THREE.TorusGeometry(0.24, 0.03, 8, 24),
    new THREE.MeshBasicMaterial({ color: 0xd93030, transparent: true, opacity: 0.85 }),
  );
  ring.rotation.x = Math.PI / 2;
  ring.position.y = 0.03;
  const body = new THREE.Mesh(
    new THREE.CylinderGeometry(0.1, 0.16, 0.36, 10),
    mat(0x24212b, { roughness: 0.5 }),
  );
  body.position.y = 0.18;
  const head = new THREE.Mesh(GEO.pawnHead, mat(0x24212b, { roughness: 0.5 }));
  head.scale.setScalar(1.5);
  head.position.y = 0.42;
  g.add(ring, body, head);
  body.castShadow = true;
  head.castShadow = true;
  return g;
}

// 商人(進歩カード): 持ち主の色のテント
function makeMerchant(colorHex) {
  const g = new THREE.Group();
  const tent = new THREE.Mesh(
    new THREE.ConeGeometry(0.2, 0.3, 6),
    mat(colorHex, { roughness: 0.6 }),
  );
  tent.position.y = 0.15;
  tent.castShadow = true;
  const poleM = new THREE.Mesh(
    new THREE.CylinderGeometry(0.012, 0.012, 0.2, 6),
    mat(0x8a6f4d),
  );
  poleM.position.y = 0.38;
  const flag = new THREE.Mesh(
    new THREE.PlaneGeometry(0.12, 0.07),
    new THREE.MeshBasicMaterial({ color: 0xffd97d, side: THREE.DoubleSide }),
  );
  flag.position.set(0.06, 0.44, 0);
  g.add(tent, poleM, flag);
  return g;
}

// ---- 海(カスタムシェーダー)----
// 浅瀬→深海のグラデーション、流れる波ノイズ、波頭のきらめき、
// 島の海岸線に寄せて返す泡。頂点もわずかにうねらせる。
function makeSea(centersXZ) {
  const uniforms = {
    uTime: { value: 0 },
    uCenters: { value: centersXZ },
    uBg: { value: new THREE.Color(0x0d2740) },
  };
  const material = new THREE.ShaderMaterial({
    uniforms,
    fog: false,
    vertexShader: `
      uniform float uTime;
      varying vec3 vWorld;
      void main() {
        vec3 p = position;
        // ゆったりした大きなうねり(ローカルXY = ワールドXZ)
        p.z += sin(p.x * 0.9 + uTime * 0.9) * 0.028
             + sin(p.y * 1.3 - uTime * 0.7) * 0.022
             + sin((p.x + p.y) * 0.5 + uTime * 0.45) * 0.02;
        vec4 wp = modelMatrix * vec4(p, 1.0);
        vWorld = wp.xyz;
        gl_Position = projectionMatrix * viewMatrix * wp;
      }
    `,
    fragmentShader: `
      uniform float uTime;
      uniform vec2 uCenters[19];
      uniform vec3 uBg;
      varying vec3 vWorld;

      float hash(vec2 p) {
        return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
      }
      float vnoise(vec2 p) {
        vec2 i = floor(p);
        vec2 f = fract(p);
        f = f * f * (3.0 - 2.0 * f);
        return mix(
          mix(hash(i), hash(i + vec2(1.0, 0.0)), f.x),
          mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), f.x),
          f.y);
      }

      void main() {
        vec2 xz = vWorld.xz;
        float r = length(xz);
        if (r > 33.5) discard;

        // 島(最寄りのヘックス中心)までの距離 = 岸からの遠さの近似
        float d = 1e5;
        for (int i = 0; i < 19; i++) {
          d = min(d, distance(xz, uCenters[i]));
        }

        // 流れる2層の波ノイズ
        float n1 = vnoise(xz * 0.85 + vec2(uTime * 0.16, uTime * 0.11));
        float n2 = vnoise(xz * 2.3 + vec2(-uTime * 0.22, uTime * 0.15));
        float n = n1 * 0.62 + n2 * 0.38;

        // 深さの色: 浅瀬ターコイズ → 中間 → 深い紺
        vec3 shallow = vec3(0.15, 0.55, 0.60);
        vec3 midsea  = vec3(0.07, 0.36, 0.53);
        vec3 deep    = vec3(0.02, 0.16, 0.33);
        vec3 col = mix(shallow, midsea, smoothstep(1.05, 2.4, d));
        col = mix(col, deep, smoothstep(2.4, 8.0, d));

        // 波の明暗と、波頭のきらめき(深場ほど静かに)
        float calm = 1.0 - 0.62 * smoothstep(2.2, 7.5, d);
        col += (n - 0.5) * 0.075 * calm;
        float glint = smoothstep(0.8, 0.93, n2) * (0.4 - 0.32 * smoothstep(1.2, 5.0, d));
        col += glint * vec3(0.55, 0.6, 0.6);

        // 岸辺: 浅瀬の透け(砂色を混ぜる)+ 寄せて返す泡
        col = mix(col, vec3(0.55, 0.72, 0.66), smoothstep(1.35, 0.95, d) * 0.35);
        float band = smoothstep(1.42, 1.06, d) * smoothstep(0.9, 1.02, d);
        float lap = 0.5 + 0.5 * sin(uTime * 1.5 - d * 7.0);
        float foamN = vnoise(xz * 6.5 + vec2(uTime * 0.45, -uTime * 0.35));
        float foam = band * smoothstep(0.42, 0.8, foamN * 0.62 + lap * 0.38);
        col = mix(col, vec3(0.93, 0.97, 1.0), foam * 0.85);

        // 外縁は背景色へ溶かす(水平線の空気感)
        col = mix(col, uBg, smoothstep(20.0, 33.0, r));
        gl_FragColor = vec4(col, 1.0);
      }
    `,
  });
  const geo = new THREE.PlaneGeometry(68, 68, 100, 100);
  geo.rotateX(-Math.PI / 2);
  const mesh = new THREE.Mesh(geo, material);
  mesh.position.y = SEA_Y;
  return { mesh, uniforms };
}

// 蛮族トラックのブイ(航路マーカー)。旗の色で進行度を示す
function makeBuoy() {
  const g = new THREE.Group();
  const base = new THREE.Mesh(
    new THREE.CylinderGeometry(0.09, 0.13, 0.11, 8),
    mat(0xe8e2d4, { roughness: 0.7 }),
  );
  base.position.y = 0.05;
  const pole = new THREE.Mesh(
    new THREE.CylinderGeometry(0.015, 0.015, 0.3, 6),
    mat(0x4a4a4a),
  );
  pole.position.y = 0.24;
  const flag = new THREE.Mesh(
    new THREE.PlaneGeometry(0.16, 0.1),
    new THREE.MeshBasicMaterial({ color: 0x9aa4ad, side: THREE.DoubleSide }),
  );
  flag.position.set(0.08, 0.34, 0);
  g.add(base, pole, flag);
  g.userData.flagMat = flag.material;
  g.userData.baseMat = base.material;
  return g;
}

// 船の上に出す「n/7」バッジ(スプライト)
function makeShipBadge() {
  const cv = document.createElement('canvas');
  cv.width = 160;
  cv.height = 80;
  const tex = new THREE.CanvasTexture(cv);
  const sp = new THREE.Sprite(
    new THREE.SpriteMaterial({ map: tex, depthTest: false, transparent: true }),
  );
  sp.scale.set(0.85, 0.42, 1);
  sp.position.y = 1.65;
  sp.userData = { cv, tex };
  return sp;
}

function drawShipBadge(sp, text) {
  const { cv, tex } = sp.userData;
  const g = cv.getContext('2d');
  g.clearRect(0, 0, cv.width, cv.height);
  g.fillStyle = 'rgba(150, 30, 25, 0.92)';
  g.beginPath();
  if (g.roundRect) g.roundRect(8, 8, cv.width - 16, cv.height - 16, 18);
  else g.rect(8, 8, cv.width - 16, cv.height - 16);
  g.fill();
  g.strokeStyle = 'rgba(255,255,255,0.7)';
  g.lineWidth = 4;
  g.stroke();
  g.fillStyle = '#fff';
  g.font = '800 40px sans-serif';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillText(text, cv.width / 2, cv.height / 2 + 2);
  tex.needsUpdate = true;
}

// ドラゴン(ドラゴンの島): 羽ばたく赤竜
function makeDragon() {
  const g = new THREE.Group();
  const bodyMat = mat(0x9c2b22, { roughness: 0.45 });
  const darkMat = mat(0x5e1512, { roughness: 0.55 });
  const boneMat = mat(0xe8d3a4, { roughness: 0.6 });

  // S字の背骨に沿って体節を密に重ねる(尾の先→胸→首)。
  // 間隔 < 半径×係数 になるようにして、数珠ではなく1本の胴に見せる
  const spine = [];
  for (let i = 0; i <= 16; i++) {
    const t = i / 16; // 0=尾の先, 1=首の付け根
    const z = -0.76 + t * 1.05;
    const y = 0.30 + 0.06 * Math.max(0, t - 0.35) / 0.65 + 0.18 * Math.max(0, t - 0.82) / 0.18;
    const x = 0.05 * Math.sin((1 - t) * 2.2) * (1 - t); // 尾を軽くくねらせる
    const r = 0.028 + 0.115 * Math.sin(Math.min(t * 1.25, 1) * Math.PI * 0.62);
    spine.push([x, y, z, r]);
  }
  for (const [x, y, z, r] of spine) {
    const seg = new THREE.Mesh(new THREE.SphereGeometry(r, 10, 8), bodyMat);
    seg.position.set(x, y, z);
    seg.scale.set(1, 0.95, 1.5);
    seg.castShadow = true;
    g.add(seg);
  }
  // 胸当て(明るい腹側)
  const chest = new THREE.Mesh(new THREE.SphereGeometry(0.115, 9, 7), mat(0xd9a05e, { roughness: 0.55 }));
  chest.position.set(0, 0.36, 0.17);
  chest.scale.set(0.85, 0.9, 0.9);
  g.add(chest);

  // 背びれ(胸から尾へ小さくなる棘。1つおきに立てる)
  for (let i = 2; i < spine.length - 1; i += 2) {
    const [x, y, z, r] = spine[i];
    const spike = new THREE.Mesh(new THREE.ConeGeometry(r * 0.3, r * 1.05, 4), darkMat);
    spike.position.set(x, y + r * 0.92, z);
    spike.rotation.x = -0.5; // 後ろへ流す
    g.add(spike);
  }
  // 尾の先の刃(菱形)
  const spade = new THREE.Mesh(new THREE.OctahedronGeometry(0.075), darkMat);
  spade.position.set(spine[0][0], spine[0][1], -0.83);
  spade.scale.set(0.45, 1.1, 1.5);
  g.add(spade);

  // ---- 頭部 ----
  const head = new THREE.Group();
  head.position.set(0, 0.72, 0.42);
  const skull = new THREE.Mesh(new THREE.SphereGeometry(0.085, 9, 7), bodyMat);
  skull.scale.set(1, 0.82, 1.05);
  skull.castShadow = true;
  const snout = new THREE.Mesh(new THREE.BoxGeometry(0.10, 0.05, 0.17), bodyMat);
  snout.position.set(0, -0.015, 0.11);
  const jaw = new THREE.Mesh(new THREE.BoxGeometry(0.085, 0.028, 0.14), darkMat);
  jaw.position.set(0, -0.055, 0.09);
  jaw.rotation.x = 0.18; // わずかに開いた口
  // 角(後方へ反る2本)
  for (const sx of [-1, 1]) {
    const horn = new THREE.Mesh(new THREE.ConeGeometry(0.02, 0.16, 5), boneMat);
    horn.position.set(sx * 0.05, 0.07, -0.05);
    horn.rotation.x = -2.35;
    horn.rotation.z = sx * 0.25;
    head.add(horn);
    // 目(発光)
    const eye = new THREE.Mesh(
      new THREE.SphereGeometry(0.018, 6, 6),
      new THREE.MeshBasicMaterial({ color: 0xffcc33 }),
    );
    eye.position.set(sx * 0.055, 0.015, 0.055);
    head.add(eye);
  }
  // 口元の熾火(かすかな光)
  const ember = new THREE.Mesh(
    new THREE.SphereGeometry(0.016, 6, 6),
    new THREE.MeshBasicMaterial({ color: 0xff6a22, transparent: true, opacity: 0.9 }),
  );
  ember.position.set(0, -0.04, 0.17);
  head.add(skull, snout, jaw, ember);
  head.rotation.x = 0.15; // わずかに下を睨む
  g.add(head);

  // ---- 翼(コウモリ型の膜 + 指骨)----
  const wingShape = new THREE.Shape();
  wingShape.moveTo(0, 0);
  wingShape.quadraticCurveTo(0.10, 0.24, 0.32, 0.30); // 上腕→手首
  wingShape.quadraticCurveTo(0.55, 0.40, 0.82, 0.36); // 第1指の先
  wingShape.quadraticCurveTo(0.60, 0.16, 0.84, 0.04); // 膜の谷 → 第2指の先
  wingShape.quadraticCurveTo(0.55, -0.04, 0.68, -0.20); // 谷 → 第3指の先
  wingShape.quadraticCurveTo(0.38, -0.16, 0.16, -0.10); // 後縁の膜
  wingShape.quadraticCurveTo(0.05, -0.05, 0, 0);
  wingShape.closePath();
  const wingGeo = new THREE.ShapeGeometry(wingShape, 6);
  const wingMat = new THREE.MeshStandardMaterial({
    color: 0x7a1c16, roughness: 0.55, side: THREE.DoubleSide, flatShading: true,
    emissive: 0x1a0300,
  });
  const boneBar = (from, to) => {
    const dir = new THREE.Vector3(to[0] - from[0], to[1] - from[1], 0);
    const len = dir.length();
    const bone = new THREE.Mesh(new THREE.CylinderGeometry(0.012, 0.008, len, 5), darkMat);
    bone.position.set((from[0] + to[0]) / 2, (from[1] + to[1]) / 2, 0.004);
    bone.rotation.z = Math.atan2(dir.y, dir.x) - Math.PI / 2;
    return bone;
  };
  const makeWing = (side) => {
    const w = new THREE.Group();
    const membrane = new THREE.Mesh(wingGeo, wingMat);
    w.add(membrane);
    w.add(boneBar([0, 0], [0.32, 0.30])); // 上腕
    w.add(boneBar([0.32, 0.30], [0.82, 0.36])); // 第1指
    w.add(boneBar([0.32, 0.30], [0.84, 0.04])); // 第2指
    if (side < 0) w.scale.x = -1;
    w.position.set(side * 0.07, 0.52, 0.16);
    // 膜面をほぼ水平に広げ、少し後退角をつける
    w.rotation.order = 'ZXY';
    w.rotation.x = -Math.PI * 0.42;
    w.rotation.y = side * 0.35;
    return w;
  };
  const wingL = makeWing(1);
  const wingR = makeWing(-1);
  g.add(wingL, wingR);
  g.userData.wings = [wingL, wingR];
  g.scale.setScalar(1.7);
  return g;
}

// 見張り塔(ドラゴンの島)
function makeTower(colorHex) {
  const g = new THREE.Group();
  const stone = mat(0xb8bec7, { roughness: 0.85 });
  const body = new THREE.Mesh(new THREE.CylinderGeometry(0.075, 0.095, 0.34, 8), stone);
  body.position.y = 0.17;
  body.castShadow = true;
  const top = new THREE.Mesh(new THREE.CylinderGeometry(0.1, 0.1, 0.06, 8), stone);
  top.position.y = 0.37;
  const flag = new THREE.Mesh(
    new THREE.PlaneGeometry(0.12, 0.07),
    new THREE.MeshBasicMaterial({ color: colorHex, side: THREE.DoubleSide }),
  );
  flag.position.set(0.06, 0.5, 0);
  const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.01, 0.01, 0.16, 5), mat(0x5a4632));
  pole.position.y = 0.46;
  g.add(body, top, pole, flag);
  return g;
}

// 炎(炎上ヘックス用)。tick でゆらめかせる
function makeFlame() {
  const g = new THREE.Group();
  const core = new THREE.Mesh(
    new THREE.ConeGeometry(0.11, 0.34, 6),
    new THREE.MeshBasicMaterial({ color: 0xff8c28, transparent: true, opacity: 0.92 }),
  );
  core.position.y = 0.17;
  const inner = new THREE.Mesh(
    new THREE.ConeGeometry(0.055, 0.2, 6),
    new THREE.MeshBasicMaterial({ color: 0xffd24a, transparent: true, opacity: 0.95 }),
  );
  inner.position.y = 0.12;
  g.add(core, inner);
  return g;
}

// ---- 3D ダイス ----

function diePipTexture(n, bg = '#f5f2e8', fg = '#22242a') {
  const cv = document.createElement('canvas');
  cv.width = cv.height = 128;
  const g = cv.getContext('2d');
  g.fillStyle = bg;
  g.fillRect(0, 0, 128, 128);
  g.fillStyle = fg;
  const P = { 1: [[64, 64]], 2: [[36, 36], [92, 92]], 3: [[32, 32], [64, 64], [96, 96]],
    4: [[38, 38], [90, 38], [38, 90], [90, 90]],
    5: [[36, 36], [92, 36], [64, 64], [36, 92], [92, 92]],
    6: [[38, 32], [90, 32], [38, 64], [90, 64], [38, 96], [90, 96]] };
  for (const [x, y] of P[n]) {
    g.beginPath();
    g.arc(x, y, 11, 0, Math.PI * 2);
    g.fill();
  }
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

function eventFaceTexture(face) {
  const cv = document.createElement('canvas');
  cv.width = cv.height = 128;
  const g = cv.getContext('2d');
  if (face === 'ship') {
    g.fillStyle = '#3a3540';
    g.fillRect(0, 0, 128, 128);
    // 船体と帆
    g.fillStyle = '#e8e2d2';
    g.beginPath();
    g.moveTo(64, 22); g.lineTo(64, 78); g.lineTo(30, 78); g.closePath();
    g.fill();
    g.beginPath();
    g.moveTo(70, 34); g.lineTo(70, 78); g.lineTo(98, 78); g.closePath();
    g.fill();
    g.fillStyle = '#b6543a';
    g.beginPath();
    g.moveTo(22, 86); g.lineTo(106, 86); g.lineTo(88, 106); g.lineTo(40, 106);
    g.closePath();
    g.fill();
  } else {
    const conf = {
      trade: ['#d8b12c', '交'],
      politics: ['#3f8f5f', '政'],
      science: ['#3f6fd8', '科'],
    }[face];
    g.fillStyle = conf[0];
    g.fillRect(0, 0, 128, 128);
    g.fillStyle = '#fff';
    g.font = '800 72px "Hiragino Sans", "Noto Sans JP", sans-serif';
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillText(conf[1], 64, 68);
  }
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

function dieMaterials(faceTextures) {
  return faceTextures.map(
    (tex) => new THREE.MeshStandardMaterial({ map: tex, roughness: 0.35 }),
  );
}

// 各面を上(+Y)に向けるための基準クォータニオン
const AXIS_UP_QUAT = {
  px: new THREE.Quaternion().setFromEuler(new THREE.Euler(0, 0, Math.PI / 2)),
  nx: new THREE.Quaternion().setFromEuler(new THREE.Euler(0, 0, -Math.PI / 2)),
  py: new THREE.Quaternion(),
  ny: new THREE.Quaternion().setFromEuler(new THREE.Euler(Math.PI, 0, 0)),
  pz: new THREE.Quaternion().setFromEuler(new THREE.Euler(-Math.PI / 2, 0, 0)),
  nz: new THREE.Quaternion().setFromEuler(new THREE.Euler(Math.PI / 2, 0, 0)),
};
// BoxGeometry の面順 [+x, -x, +y, -y, +z, -z] への値の割り当て(1-6標準ダイス)
const VALUE_AXIS = { 3: 'px', 4: 'nx', 1: 'py', 6: 'ny', 2: 'pz', 5: 'nz' };
const EVENT_AXES = { ship: 'py', trade: 'ny', politics: 'pz', science: 'nz' };

const DIE_SIZE = 0.52;
const DIE_GEO = new THREE.BoxGeometry(DIE_SIZE, DIE_SIZE, DIE_SIZE);
let DIE_MATS = null;
function getDieMats() {
  if (!DIE_MATS) {
    const order = [3, 4, 1, 6, 2, 5];
    DIE_MATS = {
      plain: dieMaterials(order.map((n) => diePipTexture(n))),
      red: dieMaterials(order.map((n) => diePipTexture(n, '#c8403c', '#ffffff'))),
      yellow: dieMaterials(order.map((n) => diePipTexture(n, '#e8c34a', '#2a2416'))),
      event: dieMaterials([
        eventFaceTexture('ship'), eventFaceTexture('ship'), eventFaceTexture('ship'),
        eventFaceTexture('trade'), eventFaceTexture('politics'), eventFaceTexture('science'),
      ]),
    };
  }
  return DIE_MATS;
}

function easeOutBack(k) {
  const c1 = 1.70158;
  const c3 = c1 + 1;
  return 1 + c3 * Math.pow(k - 1, 3) + c1 * Math.pow(k - 1, 2);
}

// ---- 蛮族船(+X 方向を進行方向として組む)----

function makeBarbarianShip() {
  const g = new THREE.Group();
  const hullMat = mat(0x4a3423, { roughness: 0.9 });

  const hull = new THREE.Mesh(GEO.box, hullMat);
  hull.scale.set(0.85, 0.2, 0.34);
  hull.position.y = 0.12;
  const prow = new THREE.Mesh(GEO.cone, hullMat);
  prow.scale.set(0.17, 0.3, 0.17);
  prow.rotation.z = -Math.PI / 2;
  prow.position.set(0.56, 0.12, 0);
  const stern = new THREE.Mesh(GEO.cone, hullMat);
  stern.scale.set(0.17, 0.22, 0.17);
  stern.rotation.z = Math.PI / 2;
  stern.position.set(-0.52, 0.12, 0);

  const mast = new THREE.Mesh(GEO.pole, mat(0x3a2a1a));
  mast.scale.set(1.2, 1.7, 1.2);
  mast.position.y = 0.6;

  const sailShape = new THREE.Shape();
  sailShape.moveTo(0, 0);
  sailShape.lineTo(0, 0.62);
  sailShape.quadraticCurveTo(0.42, 0.34, 0.34, 0);
  sailShape.closePath();
  const sail = new THREE.Mesh(
    new THREE.ShapeGeometry(sailShape),
    new THREE.MeshStandardMaterial({
      color: 0xa03030, roughness: 0.8, side: THREE.DoubleSide, flatShading: true,
    }),
  );
  sail.position.set(0.02, 0.32, 0);
  const flag = new THREE.Mesh(
    new THREE.ShapeGeometry(sailShape),
    new THREE.MeshStandardMaterial({
      color: 0x24212b, roughness: 0.8, side: THREE.DoubleSide, flatShading: true,
    }),
  );
  flag.scale.setScalar(0.25);
  flag.position.set(0.02, 1.0, 0);

  g.add(hull, prow, stern, mast, sail, flag);
  g.traverse((o) => { o.castShadow = true; });
  return g;
}

// ---- 本体 ----

export class Board3D {
  constructor(container) {
    this.container = container;
    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.12;
    container.appendChild(this.renderer.domElement);

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x0d2740);
    this.scene.fog = new THREE.Fog(0x0d2740, 26, 52);

    this.camera = new THREE.PerspectiveCamera(45, 1, 0.1, 100);
    this.camera.position.set(0, 8.6, 8.2);

    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.target.set(0, 0, 0); // 回転軸は島の中心
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.08;
    this.controls.minDistance = 5;
    this.controls.maxDistance = 24;
    // 誤操作で真俯瞰や水平近くまで倒れると盤面が分からなくなるため範囲を絞る
    this.controls.minPolarAngle = Math.PI * 0.17;
    this.controls.maxPolarAngle = Math.PI * 0.36;
    this.controls.minAzimuthAngle = -Math.PI / 3;
    this.controls.maxAzimuthAngle = Math.PI / 3;
    this.controls.rotateSpeed = 0.65;
    this.controls.enablePan = false;

    // ライティング
    this.scene.add(new THREE.HemisphereLight(0xcfe3ff, 0x46617a, 1.05));
    const sun = new THREE.DirectionalLight(0xfff2dd, 2.4);
    sun.position.set(7, 12, 5);
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    sun.shadow.camera.left = -8;
    sun.shadow.camera.right = 8;
    sun.shadow.camera.top = 8;
    sun.shadow.camera.bottom = -8;
    sun.shadow.bias = -0.0004;
    this.scene.add(sun);

    this.staticGroup = new THREE.Group();
    this.dynamicGroup = new THREE.Group();
    this.highlightGroup = new THREE.Group();
    this.pickGroup = new THREE.Group();
    this.diceGroup = new THREE.Group();
    this.scene.add(
      this.staticGroup, this.dynamicGroup, this.highlightGroup,
      this.pickGroup, this.diceGroup,
    );

    // 盗賊は永続メッシュ(移動をアニメーションさせるため)。ドラゴンの島では竜に差し替え
    this.robber = makeRobber();
    this.scene.add(this.robber);
    this.dragonMesh = makeDragon();
    this.dragonMesh.visible = false;
    this.scene.add(this.dragonMesh);
    this.robberHex = null;
    this.robberAnim = null;
    this.flameGroup = new THREE.Group();
    this.scene.add(this.flameGroup);
    this.flames = [];
    this.flameKey = '';
    // 火炎ブレス(暴走の到着後に吹く)
    this.pendingBreath = null;
    this.currentBurning = [];
    this.breathLight = new THREE.PointLight(0xff7a20, 0, 7);
    this.scene.add(this.breathLight);

    // 蛮族船(cak): トラックの前進とともに島へ近づく
    this.ship = makeBarbarianShip();
    this.ship.scale.setScalar(1.75);
    this.ship.visible = false;
    this.shipBadge = makeShipBadge();
    this.ship.add(this.shipBadge);
    this.scene.add(this.ship);
    this.shipBase = new THREE.Vector3();
    this.shipAnim = null;
    this.barbPos = null;
    this.attackFxList = [];

    // 蛮族の航路(ブイのトラック)。旗が赤くなった分だけ進んでいる
    this.barbTrack = new THREE.Group();
    this.barbBuoys = [];
    for (let i = 0; i <= BARB_TRACK; i++) {
      const b = makeBuoy();
      const p = this._shipSpot(i);
      b.position.set(p.x, SEA_Y, p.z);
      if (i === BARB_TRACK) b.scale.setScalar(1.4); // 終点(襲来地点)は大きく
      this.barbTrack.add(b);
      this.barbBuoys.push(b);
    }
    this.barbTrack.visible = false;
    this.scene.add(this.barbTrack);

    // 環境演出: 島の周りを巡る帆船・漂う雲・時々横切る飛行機
    this.ambient = new THREE.Group();
    this.scene.add(this.ambient);
    this._initAmbient();

    this.diceAnims = [];
    this.prevPieceKeys = null;
    this.boardYaw = 0; // 盤面構図の方位角(縦持ちでは 90°)
    this.tokenRot = 0; // トークンの数字が構図から正立して見える回転角(実測値)
    this.tokens = []; // 数字トークン(構図に合わせて向きを変える)

    this.raycaster = new THREE.Raycaster();
    this.pulseMats = [];
    this.gameKey = null;
    this.disposed = false;

    this.resizeObserver = new ResizeObserver(() => this.onResize());
    this.resizeObserver.observe(container);
    this.onResize();

    const loop = (t) => {
      if (this.disposed) return;
      this.controls.update();
      const a = 0.35 + 0.25 * Math.sin(t / 260);
      for (const m of this.pulseMats) m.opacity = a;
      this._tickDice(t);
      if (this.seaUniforms) this.seaUniforms.uTime.value = t / 1000;
      this._tickRobber(t);
      this._tickBreath(t);
      this._tickSpawns(t);
      this._tickShip(t);
      this._tickAmbient(t);
      this.renderer.render(this.scene, this.camera);
      requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
  }

  _robberPos(hid) {
    const c = hexCenterOf(hid);
    return new THREE.Vector3(c.x, TILE_TOP, c.y - 0.42);
  }

  // ---- アニメーション ----

  // ロール演出: カメラ手前の海にダイスが転がり落ちる
  rollDice(values, eventFace = null) {
    const mats = getDieMats();
    this.diceGroup.clear();
    this.diceAnims = [];

    const dir = this.camera.position.clone().sub(this.controls.target);
    dir.y = 0;
    if (dir.lengthSq() < 0.01) dir.set(0, 0, 1);
    dir.normalize();
    const side = new THREE.Vector3(-dir.z, 0, dir.x);
    // 島の右手前の海上に着地させる(画面内に収まる位置)
    const center = this.controls.target.clone()
      .addScaledVector(dir, 4.2)
      .addScaledVector(side, 2.6);
    center.y = SEA_Y;

    const dice = values.map((v, i) => ({
      value: v,
      mats: eventFace ? (i === 0 ? mats.red : mats.yellow) : mats.plain,
      axis: VALUE_AXIS[v],
    }));
    if (eventFace) dice.push({ value: eventFace, mats: mats.event, axis: EVENT_AXES[eventFace] });

    const now = performance.now();
    dice.forEach((d, i) => {
      const mesh = new THREE.Mesh(DIE_GEO, d.mats);
      mesh.castShadow = true;
      const land = center.clone().addScaledVector(side, (i - (dice.length - 1) / 2) * 0.9);
      const start = land.clone()
        .addScaledVector(dir, -2.2)
        .addScaledVector(side, (Math.random() - 0.5) * 0.6);
      start.y = SEA_Y + 2.4;
      mesh.position.copy(start);
      const target = new THREE.Quaternion()
        .setFromEuler(new THREE.Euler(0, Math.random() * Math.PI * 2, 0))
        .multiply(AXIS_UP_QUAT[d.axis]);
      this.diceGroup.add(mesh);
      this.diceAnims.push({
        mesh, start, land, target,
        t0: now + i * 90,
        dur: 1150,
        h0: 1.5 + Math.random() * 0.6,
        spin: new THREE.Vector3(
          (Math.random() - 0.5) * 22, (Math.random() - 0.5) * 16, (Math.random() - 0.5) * 22,
        ),
      });
    });
  }

  _tickDice(now) {
    if (!this.diceAnims.length) return;
    let allDone = true;
    for (const d of this.diceAnims) {
      const k = Math.max(0, Math.min((now - d.t0) / d.dur, 1));
      if (k < 1) allDone = false;
      const he = 1 - Math.pow(1 - k, 2);
      d.mesh.position.lerpVectors(d.start, d.land, he);
      const bounce = Math.abs(Math.cos(k * Math.PI * 2.4)) * Math.pow(1 - k, 2) * d.h0;
      d.mesh.position.y = d.land.y + DIE_SIZE / 2 + 0.01 + bounce;
      if (k < 0.7) {
        const damp = (1 - k) * 0.016;
        d.mesh.rotation.x += d.spin.x * damp;
        d.mesh.rotation.y += d.spin.y * damp;
        d.mesh.rotation.z += d.spin.z * damp;
      } else {
        d.mesh.quaternion.slerp(d.target, 0.22);
      }
    }
    if (allDone) {
      for (const d of this.diceAnims) d.mesh.quaternion.copy(d.target);
      this.diceAnims = [];
    }
  }

  // 炎を組み直す(ブレス待ちのヘックスはまだ燃やさない)
  _rebuildFlames(burning) {
    this.flameGroup.clear();
    this.flames = [];
    for (const hid of burning) {
      if (hid === this.pendingBreath?.hexId) continue;
      const c = hexCenterOf(hid);
      for (const [ox, oz] of [[-0.32, 0.15], [0.3, 0.22], [0.02, -0.3]]) {
        const f = makeFlame();
        f.position.set(c.x + ox, TILE_TOP, c.y + oz);
        this.flameGroup.add(f);
        this.flames.push(f);
      }
    }
  }

  _disposeBreath() {
    if (!this.pendingBreath) return;
    for (const pt of this.pendingBreath.particles ?? []) {
      this.scene.remove(pt.mesh);
      pt.mesh.material.dispose();
    }
    this.breathLight.intensity = 0;
    if (this.dragonMesh) this.dragonMesh.rotation.x = 0;
    this.pendingBreath = null;
  }

  // 火炎ブレス: 到着後、口から火の粒を吹き付けて着弾 → 焦げ波紋 → 着火
  _tickBreath(now) {
    const pb = this.pendingBreath;
    if (!pb) return;

    if (pb.phase === 'wait') {
      if (this.robberAnim) return; // まだ飛んでいる
      pb.phase = 'breath';
      pb.t0 = now;
      const mouth = this.dragonMesh.localToWorld(new THREE.Vector3(0, 0.7, 0.62));
      const c = hexCenterOf(pb.hexId);
      pb.ground = new THREE.Vector3(c.x, TILE_TOP + 0.04, c.y);
      this.breathLight.position.set(c.x, TILE_TOP + 0.8, c.y);
      pb.particles = [];
      const colors = [0xffd24a, 0xff8c28, 0xff5a1e];
      for (let i = 0; i < 30; i++) {
        const m = new THREE.Mesh(
          new THREE.SphereGeometry(0.07, 6, 5),
          new THREE.MeshBasicMaterial({
            color: colors[i % 3], transparent: true, opacity: 1, depthWrite: false,
          }),
        );
        m.visible = false;
        this.scene.add(m);
        const to = pb.ground.clone();
        to.x += (Math.random() - 0.5) * 0.95;
        to.z += (Math.random() - 0.5) * 0.85;
        pb.particles.push({
          mesh: m, from: mouth.clone(), to,
          start: pb.t0 + i * 24, dur: 340 + Math.random() * 140,
        });
      }
      return;
    }

    const elapsed = now - pb.t0;
    const total = 30 * 24 + 520;
    // 首をもたげて吹き下ろすポーズ
    this.dragonMesh.rotation.x = 0.32 * Math.sin(Math.min(elapsed / total, 1) * Math.PI);
    // 炎の照り返し
    this.breathLight.intensity = Math.max(0, Math.sin(Math.min(elapsed / total, 1) * Math.PI)) * 2.8;

    for (const pt of pb.particles) {
      const k = (now - pt.start) / pt.dur;
      if (k < 0 || k >= 1) {
        pt.mesh.visible = false;
        continue;
      }
      pt.mesh.visible = true;
      pt.mesh.position.lerpVectors(pt.from, pt.to, k);
      pt.mesh.scale.setScalar(0.6 + k * 2.6); // 口元で小さく、着弾で膨らむ
      pt.mesh.material.opacity = 1 - k * 0.8;
    }
    // 着弾の焦げ波紋
    if (!pb.scorched && elapsed > 380) {
      pb.scorched = true;
      this._spawnAttackFx(pb.ground, { color: 0xff7a20, grow: 3.6, dur: 750, opacity: 0.85 });
    }
    if (elapsed > total) {
      const burning = this.currentBurning;
      this._disposeBreath(); // pendingBreath を消してから組み直す(着火)
      this._rebuildFlames(burning);
    }
  }

  _tickRobber(now) {
    const isDragon = this.dragonMesh.visible;
    const piece = isDragon ? this.dragonMesh : this.robber;
    if (this.robberAnim) {
      const { from, to, t0 } = this.robberAnim;
      const dur = isDragon ? 1100 : 650;
      const k = Math.min((now - t0) / dur, 1);
      const e = k * k * (3 - 2 * k); // smoothstep
      piece.position.lerpVectors(from, to, e);
      piece.position.y = from.y + Math.sin(e * Math.PI) * (isDragon ? 2.4 : 1.3);
      if (isDragon) {
        // 飛ぶ方向を向く
        const dir = to.clone().sub(from);
        if (dir.lengthSq() > 0.01) piece.rotation.y = Math.atan2(dir.x, dir.z);
      }
      if (k >= 1) {
        piece.position.copy(to);
        this.robberAnim = null;
      }
    }
    if (isDragon) {
      // ホバリング + 羽ばたき
      const flying = !!this.robberAnim;
      const flap = Math.sin(now / (flying ? 90 : 260)) * (flying ? 0.9 : 0.35);
      for (const [i, w] of this.dragonMesh.userData.wings.entries()) {
        w.rotation.z = (i === 0 ? 1 : -1) * (0.35 + flap);
      }
      if (!flying) {
        this.dragonMesh.position.y = TILE_TOP + 0.06 + Math.sin(now / 700) * 0.04;
      }
    }
    // 炎のゆらめき
    for (const [i, f] of this.flames.entries()) {
      const k = 1 + 0.22 * Math.sin(now / 120 + i * 1.9);
      f.scale.set(k, 1 / k + 0.15, k);
    }
  }

  _tickSpawns(now) {
    for (const child of this.dynamicGroup.children) {
      const t0 = child.userData.spawnAt;
      if (t0 == null) continue;
      const k = Math.min((now - t0) / 380, 1);
      const s = k >= 1 ? 1 : Math.max(0.05, easeOutBack(k));
      const base = child.userData.baseScale;
      child.scale.set(base.x * s, base.y * s, base.z * s);
      if (k >= 1) delete child.userData.spawnAt;
    }
  }

  _initAmbient() {
    const rng = localRng(20260715);

    // 帆船: 楕円軌道(画面に見える上下/左右の海側に長い)で島を周回
    this.boats = [
      { radius: 6.6, speed: 0.00009, dir: 1, phase: 0.5, sail: 0xf5f2e8 },
      { radius: 7.4, speed: 0.000085, dir: -1, phase: 1.4, sail: 0xe8f0d8 },
      { radius: 8.2, speed: 0.00007, dir: -1, phase: 2.9, sail: 0xdfe9f2 },
      { radius: 9.8, speed: 0.00008, dir: 1, phase: 3.8, sail: 0xf2e3c0 },
      { radius: 11.2, speed: 0.00006, dir: -1, phase: 5.3, sail: 0xf5f2e8 },
    ].map((cfg) => {
      const mesh = makeSailboat(cfg.sail);
      this.ambient.add(mesh);
      return { ...cfg, mesh };
    });

    // 雲: 島の周辺(真上は避ける)をゆっくり周回
    this.clouds = [];
    for (let i = 0; i < 5; i++) {
      const mesh = makeCloud(rng);
      const cfg = {
        mesh,
        radius: 8.5 + rng() * 5,
        y: 4.2 + rng() * 2.2,
        phase: (i / 5) * Math.PI * 2 + rng(),
        speed: 0.000006 + rng() * 0.000006,
      };
      this.ambient.add(mesh);
      this.clouds.push(cfg);
    }

    // 飛行機: 時々空を横切る
    this.plane = makePlane();
    this.plane.visible = false;
    this.ambient.add(this.plane);
    this.planeFlight = null;
    this.planeNextAt = performance.now() + 6000;
  }

  _tickAmbient(now) {
    const EX = 1.35; // 楕円の長軸倍率(構図で見える側の海に長く滞在させる)
    const EZ = 0.78;
    for (const b of this.boats) {
      const a = b.phase + now * b.speed * b.dir;
      b.mesh.position.set(
        Math.cos(a) * b.radius * EX,
        SEA_Y + 0.02 + Math.sin(now / 700 + b.phase) * 0.03,
        Math.sin(a) * b.radius * EZ,
      );
      // 進行方向(楕円の接線)を向く
      const dx = -Math.sin(a) * EX * b.dir;
      const dz = Math.cos(a) * EZ * b.dir;
      b.mesh.rotation.y = -Math.atan2(dz, dx);
      b.mesh.rotation.z = Math.sin(now / 900 + b.phase) * 0.06;
    }

    for (const c of this.clouds) {
      const a = c.phase + now * c.speed;
      c.mesh.position.set(Math.cos(a) * c.radius * 1.3, c.y, Math.sin(a) * c.radius * 0.85);
    }

    if (this.planeFlight) {
      const f = this.planeFlight;
      const k = (now - f.t0) / f.dur;
      if (k >= 1) {
        this.plane.visible = false;
        this.planeFlight = null;
        this.planeNextAt = now + 14000 + Math.random() * 18000;
      } else {
        this.plane.position.lerpVectors(f.from, f.to, k);
        this.plane.position.y = f.y + Math.sin(k * Math.PI) * 0.5;
        this.plane.rotation.z = Math.sin(now / 500) * 0.05;
        this.plane.userData.prop.rotation.x = now / 18; // プロペラ回転
      }
    } else if (now >= this.planeNextAt) {
      const angle = Math.random() * Math.PI * 2;
      const offset = (Math.random() - 0.5) * 7; // 島の真上ばかり通らないように
      const dirV = new THREE.Vector3(Math.cos(angle), 0, Math.sin(angle));
      const side = new THREE.Vector3(-dirV.z, 0, dirV.x);
      const from = side.clone().multiplyScalar(offset).addScaledVector(dirV, -20);
      const to = side.clone().multiplyScalar(offset).addScaledVector(dirV, 20);
      this.planeFlight = { from, to, y: 5.2 + Math.random() * 1.6, t0: now, dur: 13000 };
      this.plane.rotation.y = -Math.atan2(dirV.z, dirV.x);
      this.plane.visible = true;
    }
  }

  // 襲来トラック position(0..7) → 海上の位置。進むほど島に近づく
  // トラック位置 → 海上の座標。構図(boardYaw)の「奥側」の見える海を
  // 横切って島へ近づく弧にする(縦持ちでも横持ちでも画面内に収まる)
  _shipSpot(pos) {
    const t = Math.min(pos / BARB_TRACK, 1);
    const farSide = Math.PI * 1.5 - this.boardYaw; // カメラの反対側(画面の奥)
    const angle = farSide + 0.58 - 0.78 * t;
    const r = 7.1 - 2.2 * t;
    return new THREE.Vector3(Math.cos(angle) * r, SEA_Y, Math.sin(angle) * r);
  }

  // 構図が変わったらブイと船をレイアウトし直す
  _layoutBarbTrack() {
    for (let i = 0; i < this.barbBuoys.length; i++) {
      const p = this._shipSpot(i);
      this.barbBuoys[i].position.set(p.x, SEA_Y, p.z);
    }
    if (this.barbPos != null && !this.shipAnim) {
      this.shipBase.copy(this._shipSpot(this.barbPos));
    }
  }

  _spawnAttackFx(pos, { color = 0xff4030, grow = 5.5, dur = 950, opacity = 0.9 } = {}) {
    const ring = new THREE.Mesh(
      new THREE.RingGeometry(0.45, 0.7, 32),
      new THREE.MeshBasicMaterial({
        color, transparent: true, opacity,
        side: THREE.DoubleSide, depthWrite: false,
      }),
    );
    ring.rotation.x = -Math.PI / 2;
    ring.position.set(pos.x, SEA_Y + 0.06, pos.z);
    this.scene.add(ring);
    this.attackFxList.push({ mesh: ring, t0: performance.now(), grow, dur, opacity });
  }

  // トラック進行度に合わせてブイの旗を塗り、船のバッジを更新する
  _updateBarbTrack(pos) {
    for (let i = 0; i < this.barbBuoys.length; i++) {
      const { flagMat, baseMat } = this.barbBuoys[i].userData;
      const passed = i <= pos && pos > 0;
      flagMat.color.setHex(passed ? 0xd93030 : i === this.barbBuoys.length - 1 ? 0x8a2020 : 0x9aa4ad);
      baseMat.color.setHex(passed ? 0xf0c8b8 : 0xe8e2d4);
    }
    drawShipBadge(this.shipBadge, `⚔ ${pos}/${BARB_TRACK}`);
  }

  _tickShip(now) {
    if (this.ship.visible) {
      if (this.shipAnim) {
        const { fromPos, toPos, t0, dur } = this.shipAnim;
        const k = Math.max(0, Math.min((now - t0) / dur, 1));
        const e = k * k * (3 - 2 * k);
        // トラック上の弧に沿って進む(直線ワープではなく航行して見せる)
        this.shipBase.copy(this._shipSpot(fromPos + (toPos - fromPos) * e));
        if (k >= 1) {
          this.shipAnim = null;
          this._spawnAttackFx(this.shipBase, { color: 0xd7ecff, grow: 2.4, dur: 620, opacity: 0.7 });
        }
      }
      // 波の上下 + 島の方角を向く
      this.ship.position.copy(this.shipBase);
      this.ship.position.y = SEA_Y + 0.03 + Math.sin(now / 620) * 0.035;
      this.ship.rotation.z = Math.sin(now / 900) * 0.05;
      const dx = -this.shipBase.x;
      const dz = -this.shipBase.z;
      this.ship.rotation.y = -Math.atan2(dz, dx);
    }
    if (this.barbTrack.visible) {
      for (let i = 0; i < this.barbBuoys.length; i++) {
        this.barbBuoys[i].position.y = SEA_Y + Math.sin(now / 700 + i * 1.7) * 0.025;
      }
    }
    for (let i = this.attackFxList.length - 1; i >= 0; i--) {
      const fx = this.attackFxList[i];
      const k = (now - fx.t0) / (fx.dur ?? 950);
      if (k >= 1) {
        this.scene.remove(fx.mesh);
        fx.mesh.geometry.dispose();
        fx.mesh.material.dispose();
        this.attackFxList.splice(i, 1);
      } else {
        fx.mesh.scale.setScalar(1 + k * (fx.grow ?? 5.5));
        fx.mesh.material.opacity = (fx.opacity ?? 0.9) * (1 - k);
      }
    }
  }

  onResize() {
    const w = this.container.clientWidth || 1;
    const h = this.container.clientHeight || 1;
    if (w === this._w && h === this._h) return; // リサイズ時のみ(ズームを潰さない)
    this._w = w;
    this._h = h;
    this.renderer.setSize(w, h);
    this._fitCamera(w, h);
  }

  // 既定のカメラ方向(boardYaw = 盤面の見せ方の方位角)
  _defaultDir() {
    return new THREE.Vector3(
      Math.sin(this.boardYaw) * 0.69, 0.72, Math.cos(this.boardYaw) * 0.69,
    ).normalize();
  }

  // アスペクト比に合わせて構図を調整する。
  // カタンの島は横長の六角形なので、縦持ちでは 90° 回した構図にして
  // 長軸を縦に向ける(横長のまま幅に収めると小さく「横向き」に見える)。
  _fitCamera(w, h) {
    const aspect = w / h;
    const portrait = aspect < 0.8;
    this.camera.aspect = aspect;
    this.camera.fov = portrait ? 55 : 45;

    const yaw = portrait ? Math.PI / 2 : 0;
    if (yaw !== this.boardYaw) {
      this.boardYaw = yaw;
      this.tokenRot = portrait ? Math.PI : 0;
      // 構図の切り替え: 既定方位へ移動し、数字トークンも読める向きに回す
      this.camera.position.copy(this.controls.target).addScaledVector(this._defaultDir(), 12);
      for (const t of this.tokens) t.rotation.y = this.tokenRot;
      // 方位角は構図中心 ±60° に制限(「横向き」への迷子を防ぐ)
      this.controls.minAzimuthAngle = yaw - Math.PI / 3;
      this.controls.maxAzimuthAngle = yaw + Math.PI / 3;
      this._layoutBarbTrack(); // 蛮族の航路も構図の奥側へ置き直す
    }

    // 画面横方向に収めるべき半径: 縦構図では島の短軸(≈4.5)、横構図では長軸(≈5.8)
    const Rh = portrait ? 4.6 : 5.8;
    const Rv = portrait ? 5.6 : 5.0;
    const halfV = Math.tan(THREE.MathUtils.degToRad(this.camera.fov / 2));
    const dist = Math.max(Rv / halfV, Rh / (halfV * aspect));
    const dir = this.camera.position.clone().sub(this.controls.target).normalize();
    if (dir.lengthSq() < 0.5) dir.copy(this._defaultDir());
    this.camera.position.copy(this.controls.target).addScaledVector(dir, dist);
    this.controls.maxDistance = Math.max(24, dist * 1.3);
    this.scene.fog.near = dist + 14;
    this.scene.fog.far = dist + 36;
    this.camera.updateProjectionMatrix();
  }

  // ---- 静的レイヤー ----

  setGame(state) {
    // board.version は発明家(数字トークン交換)で進む
    const key = `${state.seed}:${state.mode}:${state.board.version ?? 0}`;
    if (this.gameKey === key) return;
    this.gameKey = key;
    this.staticGroup.clear();
    this.pickGroup.clear();
    this.diceGroup.clear();
    this.tokens = [];
    this.diceAnims = [];
    this.prevPieceKeys = null;
    this.robberHex = null;
    this.robberAnim = null;
    this.barbPos = null;
    this.shipAnim = null;
    if (this.merchantMesh) {
      this.scene.remove(this.merchantMesh);
      this.merchantMesh = null;
    }
    this.merchantKey = null;
    this.flameGroup.clear();
    this.flames = [];
    this.flameKey = '';
    this._disposeBreath();

    // 海(シェーダー): 深さのグラデーション・波・岸辺の泡
    const centersXZ = LAYOUT.hexIds.map((hid) => {
      const c = hexCenterOf(hid);
      return new THREE.Vector2(c.x, c.y);
    });
    const sea = makeSea(centersXZ);
    this.seaUniforms = sea.uniforms;
    this.staticGroup.add(sea.mesh);
    // ShaderMaterial は影を受けないため、透明な影受け面を重ねる
    const shadowCatcher = new THREE.Mesh(
      new THREE.CircleGeometry(34, 48),
      new THREE.ShadowMaterial({ opacity: 0.24 }),
    );
    shadowCatcher.rotation.x = -Math.PI / 2;
    shadowCatcher.position.y = SEA_Y + 0.005;
    shadowCatcher.receiveShadow = true;
    this.staticGroup.add(shadowCatcher);

    // 砂浜 + タイル + 装飾 + トークン
    for (const hid of LAYOUT.hexIds) {
      const c = hexCenterOf(hid);
      const hex = state.board.hexes[hid];

      const beach = new THREE.Mesh(GEO.beach, mat(0xd9bf82, { roughness: 1 }));
      beach.position.set(c.x, 0.02, c.y);
      beach.receiveShadow = true;
      this.staticGroup.add(beach);

      const tile = new THREE.Mesh(GEO.tile, mat(TERRAIN_COLORS[hex.terrain]));
      tile.position.set(c.x, 0.06, c.y);
      tile.receiveShadow = true;
      tile.castShadow = true;
      tile.userData = { kind: 'hex', id: hid };
      this.staticGroup.add(tile);
      // ヘックスの当たり判定はタイル全面(盗賊移動などでどこをタップしても反応する)
      const hexPicker = new THREE.Mesh(GEO.hexFlat, PICK_MAT);
      hexPicker.position.set(c.x, TILE_TOP + 0.02, c.y);
      hexPicker.userData = { kind: 'hex', id: hid };
      this.pickGroup.add(hexPicker);

      const cap = makeTerrainCap(hid, hex.terrain);
      if (cap) this.staticGroup.add(cap);
      decorateHex(this.staticGroup, hid, hex.terrain);

      if (hex.token) {
        const token = new THREE.Mesh(GEO.token, [
          mat(0xe8ddbe),
          new THREE.MeshStandardMaterial({ map: tokenTexture(hex.token), roughness: 0.8 }),
          mat(0xe8ddbe),
        ]);
        token.position.set(c.x, TILE_TOP + 0.025, c.y);
        token.rotation.y = this.tokenRot; // 構図に合わせて数字を読める向きに
        token.castShadow = true;
        this.staticGroup.add(token);
        this.tokens.push(token);
      }
    }

    // 港
    for (const port of state.board.ports) {
      const e = LAYOUT.edges[port.edgeId];
      const len = Math.hypot(e.x, e.y) || 1;
      const sx = e.x + (e.x / len) * 0.6;
      const sz = e.y + (e.y / len) * 0.6;
      const pierMat = mat(0x8a6238);
      for (const vid of e.v) {
        const v = LAYOUT.vertices[vid];
        const from = new THREE.Vector3(v.x, TILE_TOP - 0.05, v.y);
        const to = new THREE.Vector3(sx, SEA_Y + 0.06, sz);
        const dir = to.clone().sub(from);
        const pier = new THREE.Mesh(GEO.box, pierMat);
        pier.scale.set(dir.length(), 0.045, 0.07);
        pier.position.copy(from).add(to).multiplyScalar(0.5);
        pier.rotation.y = -Math.atan2(dir.z, dir.x);
        pier.rotation.z = Math.asin(dir.y / dir.length());
        pier.castShadow = true;
        this.staticGroup.add(pier);
      }
      const pole = new THREE.Mesh(GEO.pole, mat(0x6f4e26));
      pole.position.set(sx, SEA_Y + 0.25, sz);
      pole.castShadow = true;
      this.staticGroup.add(pole);
      const sign = portSprite(port.type);
      sign.position.set(sx, SEA_Y + 0.62, sz);
      this.staticGroup.add(sign);
    }

    // ピッキング用: 頂点・辺
    for (const vid of Object.keys(LAYOUT.vertices)) {
      this.pickGroup.add(this._pickerAt('vertex', vid, vpos(vid), 1));
    }
    for (const [eid, e] of Object.entries(LAYOUT.edges)) {
      const p = this._pickerAt('edge', eid, new THREE.Vector3(e.x, TILE_TOP, e.y), 0.7);
      this.pickGroup.add(p);
    }
  }

  _pickerAt(kind, id, pos, scale) {
    const m = new THREE.Mesh(GEO.pickVertex, PICK_MAT);
    m.position.copy(pos);
    m.scale.setScalar(scale);
    m.userData = { kind, id };
    return m;
  }

  // ---- 動的レイヤー ----

  update(state, ui) {
    this.setGame(state);
    this.dynamicGroup.clear();

    // key を持たせて「新しく置かれたコマ」を検出し、出現ポップさせる
    const addPiece = (key, obj) => {
      obj.userData.key = key;
      obj.userData.baseScale = obj.scale.clone();
      this.dynamicGroup.add(obj);
    };

    for (const [eid, road] of Object.entries(state.roads)) {
      addPiece(`road:${eid}:${road.player}`, makeRoad(eid, road.player));
    }
    for (const eid of ui.pendingEdges ?? []) {
      addPiece(`pending:${eid}`, makeRoad(eid, 0, 0.5));
    }

    for (const vid of Object.keys(state.walls ?? {})) {
      const w = new THREE.Mesh(GEO.wall, mat(0xb7aa93));
      w.rotation.x = Math.PI / 2;
      w.rotation.z = Math.PI * 0.65;
      w.position.copy(vpos(vid));
      w.position.y += 0.03;
      w.scale.setScalar(1.4);
      w.castShadow = true;
      addPiece(`wall:${vid}`, w);
    }

    // 見張り塔(ドラゴンの島): 建物の脇に立てる
    for (const [vid, pid] of Object.entries(state.towers ?? {})) {
      const t = makeTower(PLAYER_COLORS_3D[pid]);
      t.position.copy(vpos(vid));
      t.position.x += 0.2;
      t.position.z -= 0.14;
      addPiece(`tower:${vid}:${pid}`, t);
    }

    for (const [vid, b] of Object.entries(state.buildings)) {
      const piece = b.type === 'city' ? makeCity(b.player) : makeSettlement(b.player);
      piece.position.copy(vpos(vid));
      piece.rotation.y = (hashStr(vid) % 628) / 100;
      addPiece(`bld:${vid}:${b.type}:${b.player}`, piece);
    }

    for (const vid of Object.values(state.metropolis ?? {})) {
      if (vid == null || !state.buildings[vid]) continue;
      const crown = new THREE.Mesh(
        GEO.crown,
        mat(0xffd24a, { metalness: 0.6, roughness: 0.35, emissive: 0x9c7a10, emissiveIntensity: 0.35 }),
      );
      crown.position.copy(vpos(vid));
      crown.position.y += 0.72;
      crown.scale.setScalar(1.3);
      addPiece(`metro:${vid}`, crown);
    }

    for (const [vid, k] of Object.entries(state.knights ?? {})) {
      const piece = makeKnight(k);
      piece.position.copy(vpos(vid));
      addPiece(`knight:${vid}:${k.level}:${k.active}`, piece);
    }

    // 出現ポップ(初回構築時は除く)
    const keys = new Set(this.dynamicGroup.children.map((c) => c.userData.key));
    if (this.prevPieceKeys) {
      const now = performance.now();
      for (const child of this.dynamicGroup.children) {
        if (!this.prevPieceKeys.has(child.userData.key)) {
          child.userData.spawnAt = now;
          child.scale.setScalar(0.05);
        }
      }
    }
    this.prevPieceKeys = keys;

    // 蛮族船: トラック前進で島へ接近、襲来(リセット)で衝撃波を出して引き返す
    if (state.mode === 'cak') {
      this.ship.visible = true;
      this.barbTrack.visible = true;
      const pos = state.barbarians.position;
      if (this.barbPos == null) {
        this.shipBase.copy(this._shipSpot(pos));
        this.barbPos = pos;
        this._updateBarbTrack(pos);
      } else if (pos !== this.barbPos) {
        if (pos < this.barbPos) {
          this._spawnAttackFx(this.shipBase); // 襲来!
          this.shipAnim = { fromPos: this.barbPos, toPos: pos, t0: performance.now() + 500, dur: 2200 };
        } else {
          this.shipAnim = { fromPos: this.barbPos, toPos: pos, t0: performance.now(), dur: 1300 };
        }
        this.barbPos = pos;
        this._updateBarbTrack(pos);
      }
    } else {
      this.ship.visible = false;
      this.barbTrack.visible = false;
    }

    // 商人(進歩カード): 保持者の色のテントをヘックス脇に置く
    const mKey = state.merchant ? `${state.merchant.hexId}:${state.merchant.player}` : null;
    if (this.merchantKey !== mKey) {
      if (this.merchantMesh) {
        this.scene.remove(this.merchantMesh);
        this.merchantMesh = null;
      }
      if (state.merchant) {
        this.merchantMesh = makeMerchant(PLAYER_COLORS_3D[state.merchant.player]);
        const c = hexCenterOf(state.merchant.hexId);
        this.merchantMesh.position.set(c.x + 0.45, TILE_TOP, c.y + 0.3);
        this.scene.add(this.merchantMesh);
      }
      this.merchantKey = mKey;
    }

    // 盗賊/ドラゴン: ヘックスが変わったらジャンプ/飛翔移動
    const isDragon = state.mode === 'dragon';
    this.dragonMesh.visible = isDragon;
    this.robber.visible = !isDragon;
    if (this.robberHex !== state.board.robber) {
      const to = this._robberPos(state.board.robber);
      if (this.robberHex == null) {
        this.robber.position.copy(to);
        this.dragonMesh.position.copy(to);
      } else {
        this.robberAnim = {
          from: this._robberPos(this.robberHex),
          to,
          t0: performance.now(),
        };
      }
      this.robberHex = state.board.robber;
    }

    // 炎上ヘックス(ドラゴンの島): 燃えている集合が変わったら組み直す。
    // ドラゴンの現在地で新たに火がついた場合は「到着 → 火炎ブレス → 着火」の順で見せる
    const burning = Object.keys(state.burned ?? {})
      .filter((h) => state.burned[h] > state.turn)
      .sort();
    this.currentBurning = burning;
    const fkey = burning.join(',');
    if (fkey !== this.flameKey) {
      const prev = new Set(this.flameKey.split(',').filter(Boolean));
      const added = burning.filter((h) => !prev.has(h));
      if (isDragon && added.includes(state.board.robber)) {
        this._disposeBreath();
        this.pendingBreath = { hexId: state.board.robber, phase: 'wait' };
      }
      this.flameKey = fkey;
      this._rebuildFlames(burning);
    }

    this._updateHighlights(state, ui);
  }

  _updateHighlights(state, ui) {
    this.highlightGroup.clear();
    this.pulseMats = [];
    const h = ui.highlights ?? {};

    const pulseMat = (color) => {
      const m = new THREE.MeshBasicMaterial({
        color, transparent: true, opacity: 0.5, depthWrite: false,
      });
      this.pulseMats.push(m);
      return m;
    };
    const solidMat = (color) =>
      new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.75, depthWrite: false });

    for (const vid of h.vertices ?? []) {
      const s = new THREE.Mesh(GEO.hlVertex, pulseMat(0xffe166));
      s.position.copy(vpos(vid));
      s.position.y += 0.08;
      this.highlightGroup.add(s);
    }
    for (const eid of h.edges ?? []) {
      const e = LAYOUT.edges[eid];
      const s = new THREE.Mesh(GEO.hlVertex, pulseMat(0xffe166));
      s.scale.setScalar(0.85);
      s.position.set(e.x, TILE_TOP + 0.07, e.y);
      this.highlightGroup.add(s);
    }
    for (const hid of h.hexes ?? []) {
      const c = hexCenterOf(hid);
      const s = new THREE.Mesh(GEO.hexFlat, pulseMat(0xffe166));
      s.position.set(c.x, TILE_TOP + 0.04, c.y);
      this.highlightGroup.add(s);
    }

    const sel = ui.selected;
    if (sel) {
      if (sel.vertexId) {
        const s = new THREE.Mesh(GEO.hlVertex, solidMat(0x53e08a));
        s.scale.setScalar(1.15);
        s.position.copy(vpos(sel.vertexId));
        s.position.y += 0.08;
        this.highlightGroup.add(s);
      }
      if (sel.edgeId) {
        const e = LAYOUT.edges[sel.edgeId];
        const s = new THREE.Mesh(GEO.hlVertex, solidMat(0x53e08a));
        s.position.set(e.x, TILE_TOP + 0.07, e.y);
        this.highlightGroup.add(s);
      }
      if (sel.hexId) {
        const c = hexCenterOf(sel.hexId);
        const s = new THREE.Mesh(GEO.hexFlat, solidMat(0x53e08a));
        s.material.opacity = 0.3;
        s.position.set(c.x, TILE_TOP + 0.045, c.y);
        this.highlightGroup.add(s);
      }
    }
  }

  // ---- ピッキング ----

  pick(kind, clientX, clientY, candidates) {
    const rect = this.renderer.domElement.getBoundingClientRect();
    const ndc = new THREE.Vector2(
      ((clientX - rect.left) / rect.width) * 2 - 1,
      -((clientY - rect.top) / rect.height) * 2 + 1,
    );
    this.raycaster.setFromCamera(ndc, this.camera);
    const cands = new Set(candidates);
    const hits = this.raycaster.intersectObjects(this.pickGroup.children, false);
    for (const hit of hits) {
      const { kind: k, id } = hit.object.userData;
      if (k === kind && cands.has(id)) return id;
    }
    return null;
  }

  // 視点を初期アングルに戻す
  resetView() {
    this.controls.target.set(0, 0, 0); // 回転軸は島の中心
    this.camera.position.copy(this.controls.target).addScaledVector(this._defaultDir(), 12);
    this._w = this._h = 0; // 距離の再フィットを強制
    this.onResize();
  }

  // 論理要素のスクリーン座標(テスト・チュートリアル表示用)
  screenPos(kind, id) {
    let p;
    if (kind === 'vertex') p = vpos(id);
    else if (kind === 'edge') {
      const e = LAYOUT.edges[id];
      p = new THREE.Vector3(e.x, TILE_TOP, e.y);
    } else {
      const c = hexCenterOf(id);
      p = new THREE.Vector3(c.x, TILE_TOP, c.y);
    }
    const v = p.clone().project(this.camera);
    const r = this.renderer.domElement.getBoundingClientRect();
    return [
      r.left + ((v.x + 1) / 2) * r.width,
      r.top + ((1 - (v.y + 1) / 2) / 1) * r.height,
    ];
  }

  dispose() {
    this.disposed = true;
    this.resizeObserver.disconnect();
    this.controls.dispose();
    this.renderer.dispose();
    this.renderer.domElement.remove();
  }
}
