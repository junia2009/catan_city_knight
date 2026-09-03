// 地面の高さ。**描くほうと歩くほうで、同じ1本を使う。**
//
// タイルの上面(TILE_TOP)は平らだが、その上に2つ載っている:
//   - 地形の起伏(CAP_PARAMS の「地表」。board3d.js が張る)
//   - 数字トークンの円盤(厚み 0.05)
// 歩く側がこれを知らずに平らな TILE_TOP に立たせていたので、**足が地面に
// 埋まっていた**(実機で報告された)。
//
// THREE は使わない ── minigame/ground.js から呼ぶため。
// (CI は npm install をせずにテストを回すので、three を import した瞬間に落ちる)

import { LAYOUT, boardVertexIds, boardGeometry, hexIdsWithin } from './rules/board.js';

export const TILE_TOP = 0.26;   // タイル上面(board3d.js と同じ値)

// 地形ごとの起伏。amp が「いちばん盛り上がるところの高さ」。
// 地表を張るときも、そこを歩くときも、この表を見る。
export const CAP_PARAMS = {
  forest: { amp: 0.042, freq: 5.2, jitter: 0.10, tint: 0x3f8152 },
  pasture: { amp: 0.03, freq: 4.2, jitter: 0.08, tint: 0x93c258 },
  field: { amp: 0.02, freq: 6.5, jitter: 0.07, tint: 0xe6c04c },
  hill: { amp: 0.06, freq: 4.6, jitter: 0.11, tint: 0xbd7043 },
  mountain: { amp: 0.10, freq: 5.8, jitter: 0.14, tint: 0x93a0b2 },
  desert: { amp: 0.05, freq: 2.6, jitter: 0.06, tint: 0xe6d7a6 },
  lake: { amp: 0.012, freq: 3.4, jitter: 0.03, tint: 0x49b2d6 }, // さざ波程度
  gold: { amp: 0.035, freq: 5.0, jitter: 0.09, tint: 0xf0cf63 },
};

// 地表メッシュの細かさ(セクター内の分割数)と、ヘックスに対する縮み。
// **board3d.js の張り方と揃っていること。** ずれると、描いてある三角形と
// 高さの計算が食い違って、また足が埋まる。
export const CAP_N = 4;
export const CAP_INSET = 0.955;

// 起伏が始まる位置(中心からの割合)。
// **数字トークンの円盤より外から盛り上げる。** 内側から盛り上げると、
// 起伏が円盤(厚み 0.05)を追い越して、山や丘でトークンが土に埋まる。
export const CAP_FLAT = 0.36;

const hexCenters = {};
export function hexCenter(hid) {
  if (!hexCenters[hid]) {
    let x = 0;
    let y = 0;
    for (const vid of LAYOUT.hexVertices[hid]) {
      x += LAYOUT.vertices[vid].x;
      y += LAYOUT.vertices[vid].y;
    }
    hexCenters[hid] = { x: x / 6, y: y / 6 };
  }
  return hexCenters[hid];
}

export function hashStr(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

export function coordHash(x, z) {
  const s = Math.sin(x * 127.1 + z * 311.7) * 43758.5453;
  return s - Math.floor(s);
}

// ヘックスの角(中心からの相対)。全ヘックス同形なので先頭から取る。
let cornersCache = null;
export function capCorners() {
  if (!cornersCache) {
    const first = LAYOUT.hexIds[0];
    const fc = hexCenter(first);
    cornersCache = LAYOUT.hexVertices[first].map((vid) => [
      (LAYOUT.vertices[vid].x - fc.x) * CAP_INSET,
      (LAYOUT.vertices[vid].y - fc.y) * CAP_INSET,
    ]);
  }
  return cornersCache;
}

// 地表メッシュの「頂点1つぶんの高さ」。
// x, z はヘックス中心からの相対、t は中心(0)から角(1)へ向かう位置。
// board3d.js はこれを格子点で呼んでメッシュを張り、歩く側は下の capHeight が
// 同じ三角形の上を線形に読む。
export function capVertexHeight(hid, terrain, x, z, t) {
  const prm = CAP_PARAMS[terrain];
  if (!prm) return 0;
  const c = hexCenter(hid);
  const phase = (hashStr(hid) % 628) / 100;
  // 中心寄り(トークンの下)と縁で0、その間で最大になる形
  const u = Math.max(0, Math.min(1, (t - CAP_FLAT) / (1 - CAP_FLAT)));
  const profile = Math.pow(Math.sin(Math.PI * u), 1.3);
  const n = 0.55 + 0.45 * Math.sin(x * prm.freq + phase) * Math.cos(z * (prm.freq * 0.8) - phase);
  const j = coordHash(x + c.x, z + c.y) * 0.5;
  return 0.004 + prm.amp * profile * (n * 0.7 + j * 0.6);
}

// そのヘックスの (x, z) における地表の高さ(タイル上面からの高さ)。
//
// **メッシュと同じ三角形の上を読む。** 起伏の式をそのまま評価すると、
// 平らな三角形で描かれている面と最大で amp の3割ほどずれる ── 山
// (amp 0.10)では足の太さぶん埋まる。頂点3つの高さを重みで混ぜる。
export function capHeight(hid, terrain, worldX, worldZ) {
  if (!CAP_PARAMS[terrain]) return 0;
  const c = hexCenter(hid);
  const lx = worldX - c.x;
  const lz = worldZ - c.y;
  const corners = capCorners();

  for (let s = 0; s < 6; s++) {
    const A = corners[s];
    const B = corners[(s + 1) % 6];
    const det = A[0] * B[1] - A[1] * B[0];
    if (Math.abs(det) < 1e-12) continue;
    // (lx, lz) = A*u + B*v を解く。u,v >= 0 かつ u+v <= 1 ならこのセクター
    const u = (lx * B[1] - lz * B[0]) / det;
    const v = (A[0] * lz - A[1] * lx) / det;
    const e = 1e-9;
    if (u < -e || v < -e || u + v > 1 + e) continue;

    const N = CAP_N;
    const I = Math.min(N, Math.max(0, u * N));
    const J = Math.min(N, Math.max(0, v * N));
    let i = Math.min(N - 1, Math.floor(I));
    let j = Math.min(N - 1, Math.floor(J));
    // 外周の三角形からはみ出さないように寄せる
    if (i + j > N - 1) {
      const over = i + j - (N - 1);
      if (i >= over) i -= over;
      else { j -= over - i; i = 0; }
    }
    const fi = I - i;
    const fj = J - j;
    const h = (a, b) => {
      const x = (A[0] * a + B[0] * b) / N;
      const z = (A[1] * a + B[1] * b) / N;
      return capVertexHeight(hid, terrain, x, z, (a + b) / N);
    };
    if (fi + fj <= 1) {
      // 下側の三角形: (i,j) (i,j+1) (i+1,j)
      return h(i, j) * (1 - fi - fj) + h(i, j + 1) * fj + h(i + 1, j) * fi;
    }
    // 上側の三角形: (i+1,j) (i,j+1) (i+1,j+1)
    return h(i + 1, j) * (1 - fj) + h(i, j + 1) * (1 - fi) + h(i + 1, j + 1) * (fi + fj - 1);
  }
  // 地表メッシュの外(タイルの縁の 4.5%)。縁の高さに合わせる
  return 0.004;
}

// ---- 数字トークン ----
//
// ヘックスの真ん中に置いてある円盤。**厚みのぶん、上に立つ**。
// 寸法は board3d.js の GEO.token(半径 0.33・厚み 0.05)と揃えること。
export const TOKEN_R = 0.33;
export const TOKEN_H = 0.05;

// 基準は「基本の盤(半径2)」の広がり。board3d.js のカメラの基準と同じもの。
const BASE_EXTENT = (() => {
  let x = 0;
  let y = 0;
  for (const vid of boardGeometry(hexIdsWithin(2)).vertexIds) {
    const v = LAYOUT.vertices[vid];
    x = Math.max(x, Math.abs(v.x));
    y = Math.max(y, Math.abs(v.y));
  }
  return { x, y };
})();

// 盤の広がり(基本の盤を 1 とする倍率)。カメラの引き具合と、トークンの
// 大きさに使う。広い盤では円盤を大きく描くので、**乗れる範囲も一緒に広がる**。
export function boardScale(board) {
  let maxX = 0;
  let maxY = 0;
  for (const vid of boardVertexIds(board)) {
    const v = LAYOUT.vertices[vid];
    maxX = Math.max(maxX, Math.abs(v.x));
    maxY = Math.max(maxY, Math.abs(v.y));
  }
  return Math.max(maxX / BASE_EXTENT.x, maxY / BASE_EXTENT.y, 1);
}

// 円盤の描画倍率(board3d.js の token.scale.setScalar)。上限 1.35。
function tokenDrawScale(board) {
  const k = boardScale(board);
  return k > 1 ? Math.min(1.35, k) : 1;
}

export function tokenRadius(board) {
  return TOKEN_R * tokenDrawScale(board);
}

// 円盤の上面(タイル上面から)。
// **拡大すると厚みも一緒に増える。** 円盤は中心を TILE_TOP + 厚み/2 に
// 置いてあり、そこを動かさずに倍率を掛けるので、上面は
// 厚み/2 + 厚み/2 × 倍率 になる ── 等倍なら 0.05、1.35 倍なら 0.059。
// 半径だけ広げて厚みを据え置くと、航海者の島だけ 9mm 足が埋まる(実測)。
export function tokenTop(board) {
  return TOKEN_H / 2 + (TOKEN_H / 2) * tokenDrawScale(board);
}

// タイル上面から測った「立てる高さ」。地表の起伏と、数字トークンの上面の高いほう。
// token は { r, top }(呼ぶ側が毎フレーム測り直さないように渡せる)。
export function surfaceHeight(board, hid, x, z, token = null) {
  const hex = board.hexes[hid];
  if (!hex) return 0;
  const cap = capHeight(hid, hex.terrain, x, z);
  if (!hex.token) return cap;
  const c = hexCenter(hid);
  const r = token?.r ?? tokenRadius(board);
  const top = token?.top ?? tokenTop(board);
  const on = Math.hypot(x - c.x, z - c.y) <= r;
  return on ? Math.max(cap, top) : cap;
}
