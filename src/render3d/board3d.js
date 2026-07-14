// Three.js による 3D 盤面描画層(設計書 §8 の描画層を差し替えるもの)
// ルールエンジンには一切依存されない。GameState と UI 状態を受け取って描くだけ。
//
// - 静的レイヤー(海・島・地形・トークン・港)は setGame() で一度だけ構築
// - 動的レイヤー(道・建物・騎士・盗賊・城壁・メトロポリス)は update() で再構築
// - クリック判定は不可視のピッキングメッシュへのレイキャスト

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { LAYOUT, PIPS, TERRAIN_RESOURCE } from '../rules/board.js';
import { RES_JP_SHORT } from '../state.js';

export const PLAYER_COLORS_3D = [0xe04848, 0x3d7dd8, 0xf0973c, 0x9d5fd8];
const PLAYER_COLORS_DARK_3D = [0x9c2626, 0x22508f, 0xb3651a, 0x6a3a99];

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

function makeTree(rng) {
  const g = new THREE.Group();
  const trunk = new THREE.Mesh(GEO.trunk, mat(0x5d4025));
  trunk.position.y = 0.05;
  g.add(trunk);
  const c1 = new THREE.Mesh(GEO.cone, mat(0x2c6b3c));
  c1.scale.set(0.13, 0.2, 0.13);
  c1.position.y = 0.17;
  const c2 = new THREE.Mesh(GEO.cone, mat(0x1e5230));
  c2.scale.set(0.1, 0.16, 0.1);
  c2.position.y = 0.28;
  g.add(c1, c2);
  g.rotation.y = rng() * Math.PI * 2;
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
    for (const [dx, dz] of ringPositions(rng, 6, 0.4, 0.66)) add(makeTree(rng), dx, dz);
  } else if (terrain === 'pasture') {
    for (const [dx, dz] of ringPositions(rng, 2, 0.42, 0.58)) add(makeSheep(rng), dx, dz);
    for (const [dx, dz] of ringPositions(rng, 5, 0.36, 0.66)) {
      const tuft = new THREE.Mesh(GEO.cone, mat(0x6f9d3d));
      tuft.scale.set(0.035, 0.07, 0.035);
      tuft.position.y = 0.035;
      add(tuft, dx, dz);
    }
  } else if (terrain === 'field') {
    for (const [dx, dz] of ringPositions(rng, 6, 0.38, 0.64)) add(makeWheatBundle(rng), dx, dz);
  } else if (terrain === 'hill') {
    for (const [dx, dz] of ringPositions(rng, 3, 0.42, 0.6)) add(makeBricks(rng), dx, dz);
  } else if (terrain === 'mountain') {
    add(makePeak(rng, 1.1), -0.3, 0.38);
    add(makePeak(rng), 0.36, 0.32);
    add(makePeak(rng, 0.85), 0.05, 0.55);
    add(makePeak(rng, 0.9), -0.15, -0.5);
  } else if (terrain === 'desert') {
    for (const [dx, dz] of ringPositions(rng, 3, 0.35, 0.6)) add(makeDune(), dx, dz);
    add(makeCactus(rng), 0.42, -0.38);
  }
}

// ---- ピース ----

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
      : mat(PLAYER_COLORS_3D[pid]),
  );
  m.scale.set(len * 0.6, 0.075, 0.08);
  m.position.copy(v1).add(v2).multiplyScalar(0.5);
  m.position.y = TILE_TOP + 0.038;
  m.rotation.y = -Math.atan2(dir.z, dir.x);
  m.castShadow = true;
  return m;
}

function makeSettlement(pid) {
  const g = new THREE.Group();
  const body = new THREE.Mesh(GEO.box, mat(PLAYER_COLORS_3D[pid]));
  body.scale.set(0.2, 0.13, 0.16);
  body.position.y = 0.065;
  const roof = new THREE.Mesh(GEO.cone, mat(PLAYER_COLORS_DARK_3D[pid]));
  roof.scale.set(0.15, 0.11, 0.13);
  roof.rotation.y = Math.PI / 4;
  roof.position.y = 0.185;
  g.add(body, roof);
  g.traverse((o) => { o.castShadow = true; });
  return g;
}

function makeCity(pid) {
  const g = new THREE.Group();
  const base = new THREE.Mesh(GEO.box, mat(PLAYER_COLORS_3D[pid]));
  base.scale.set(0.3, 0.13, 0.18);
  base.position.y = 0.065;
  const tower = new THREE.Mesh(GEO.box, mat(PLAYER_COLORS_3D[pid]));
  tower.scale.set(0.13, 0.3, 0.16);
  tower.position.set(-0.085, 0.15, 0);
  const roof = new THREE.Mesh(GEO.cone, mat(PLAYER_COLORS_DARK_3D[pid]));
  roof.scale.set(0.11, 0.1, 0.12);
  roof.rotation.y = Math.PI / 4;
  roof.position.set(-0.085, 0.35, 0);
  const roof2 = new THREE.Mesh(GEO.cone, mat(PLAYER_COLORS_DARK_3D[pid]));
  roof2.scale.set(0.1, 0.08, 0.11);
  roof2.rotation.y = Math.PI / 4;
  roof2.position.set(0.075, 0.17, 0);
  g.add(base, tower, roof, roof2);
  g.traverse((o) => { o.castShadow = true; });
  return g;
}

function makeKnight(k) {
  const g = new THREE.Group();
  const color = k.active ? PLAYER_COLORS_3D[k.player] : 0x8a8f96;
  const body = new THREE.Mesh(GEO.pawnBody, mat(color));
  body.position.y = 0.1;
  const head = new THREE.Mesh(GEO.pawnHead, mat(color));
  head.position.y = 0.23;
  g.add(body, head);
  for (let i = 0; i < k.level; i++) {
    const ring = new THREE.Mesh(GEO.ring, mat(0xf5f2e8, { roughness: 0.5 }));
    ring.rotation.x = Math.PI / 2;
    ring.position.y = 0.055 + i * 0.045;
    ring.scale.setScalar(1 - i * 0.18);
    g.add(ring);
  }
  g.traverse((o) => { o.castShadow = true; });
  return g;
}

function makeRobber() {
  const g = new THREE.Group();
  const body = new THREE.Mesh(
    new THREE.CylinderGeometry(0.07, 0.11, 0.24, 10),
    mat(0x2b2830),
  );
  body.position.y = 0.12;
  const head = new THREE.Mesh(GEO.pawnHead, mat(0x2b2830));
  head.position.y = 0.27;
  g.add(body, head);
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
    this.controls.target.set(0, 0, 0.4);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.08;
    this.controls.minDistance = 5;
    this.controls.maxDistance = 24;
    this.controls.minPolarAngle = Math.PI * 0.08;
    this.controls.maxPolarAngle = Math.PI * 0.44;
    this.controls.enablePan = false;

    // ライティング
    this.scene.add(new THREE.HemisphereLight(0xcfe3ff, 0x3a5068, 0.85));
    const sun = new THREE.DirectionalLight(0xfff2dd, 2.2);
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
    this.scene.add(this.staticGroup, this.dynamicGroup, this.highlightGroup, this.pickGroup);

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
      this.renderer.render(this.scene, this.camera);
      requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
  }

  onResize() {
    const w = this.container.clientWidth || 1;
    const h = this.container.clientHeight || 1;
    this.renderer.setSize(w, h);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  // ---- 静的レイヤー ----

  setGame(state) {
    const key = `${state.seed}:${state.mode}`;
    if (this.gameKey === key) return;
    this.gameKey = key;
    this.staticGroup.clear();
    this.pickGroup.clear();

    // 海
    const sea = new THREE.Mesh(
      new THREE.CircleGeometry(34, 48),
      new THREE.MeshStandardMaterial({ color: 0x1a628f, roughness: 0.35, metalness: 0.2 }),
    );
    sea.rotation.x = -Math.PI / 2;
    sea.position.y = SEA_Y;
    sea.receiveShadow = true;
    this.staticGroup.add(sea);

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
      this.pickGroup.add(this._pickerAt('hex', hid, new THREE.Vector3(c.x, TILE_TOP, c.y), 0.75));

      decorateHex(this.staticGroup, hid, hex.terrain);

      if (hex.token) {
        const token = new THREE.Mesh(GEO.token, [
          mat(0xe8ddbe),
          new THREE.MeshStandardMaterial({ map: tokenTexture(hex.token), roughness: 0.8 }),
          mat(0xe8ddbe),
        ]);
        token.position.set(c.x, TILE_TOP + 0.025, c.y);
        token.castShadow = true;
        this.staticGroup.add(token);
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

    for (const [eid, road] of Object.entries(state.roads)) {
      this.dynamicGroup.add(makeRoad(eid, road.player));
    }
    for (const eid of ui.pendingEdges ?? []) {
      this.dynamicGroup.add(makeRoad(eid, 0, 0.5));
    }

    for (const vid of Object.keys(state.walls ?? {})) {
      const w = new THREE.Mesh(GEO.wall, mat(0xb7aa93));
      w.rotation.x = Math.PI / 2;
      w.rotation.z = Math.PI * 0.65;
      w.position.copy(vpos(vid));
      w.position.y += 0.03;
      w.castShadow = true;
      this.dynamicGroup.add(w);
    }

    for (const [vid, b] of Object.entries(state.buildings)) {
      const piece = b.type === 'city' ? makeCity(b.player) : makeSettlement(b.player);
      piece.position.copy(vpos(vid));
      piece.rotation.y = (hashStr(vid) % 628) / 100;
      this.dynamicGroup.add(piece);
    }

    for (const vid of Object.values(state.metropolis ?? {})) {
      if (vid == null || !state.buildings[vid]) continue;
      const crown = new THREE.Mesh(
        GEO.crown,
        mat(0xffd24a, { metalness: 0.6, roughness: 0.35, emissive: 0x9c7a10, emissiveIntensity: 0.35 }),
      );
      crown.position.copy(vpos(vid));
      crown.position.y += 0.52;
      this.dynamicGroup.add(crown);
    }

    for (const [vid, k] of Object.entries(state.knights ?? {})) {
      const piece = makeKnight(k);
      piece.position.copy(vpos(vid));
      this.dynamicGroup.add(piece);
    }

    const robber = makeRobber();
    const rc = hexCenterOf(state.board.robber);
    robber.position.set(rc.x, TILE_TOP, rc.y - 0.42);
    this.dynamicGroup.add(robber);

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

  dispose() {
    this.disposed = true;
    this.resizeObserver.disconnect();
    this.controls.dispose();
    this.renderer.dispose();
    this.renderer.domElement.remove();
  }
}
