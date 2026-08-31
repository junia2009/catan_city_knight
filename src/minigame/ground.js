// 島の「歩ける地面」の判定。
//
// THREE を使わない純粋な計算にしてあるので、node --test で検証できる
// (盤の幾何を1つ間違えると、海の上を歩けたり島の真ん中に穴が空いたりする)。

import { LAYOUT } from '../rules/board.js';
import { isLandHex } from '../rules/sea.js';

const TILE_TOP = 0.26; // board3d.js と同じタイル上面の高さ

// ---- 盤の幾何(board3d.js と同じ計算。歩ける範囲の判定に使う)----

function hexCenter(hid) {
  let x = 0;
  let y = 0;
  for (const vid of LAYOUT.hexVertices[hid]) {
    x += LAYOUT.vertices[vid].x;
    y += LAYOUT.vertices[vid].y;
  }
  return { x: x / 6, y: y / 6 };
}

// 六角形の内接円半径と、辺の法線3本。点がヘックスの中かを厳密に見るのに使う。
function hexMetrics() {
  const hid = LAYOUT.hexIds[0];
  const c = hexCenter(hid);
  const v0 = LAYOUT.vertices[LAYOUT.hexVertices[hid][0]];
  const R = Math.hypot(v0.x - c.x, v0.y - c.y);      // 外接円
  const inR = R * Math.cos(Math.PI / 6);             // 内接円
  const th0 = Math.atan2(v0.y - c.y, v0.x - c.x);
  // 辺の法線は頂点から30°ずらして60°おき。3本見れば足りる(対辺は符号違い)
  const normals = [0, 1, 2].map((k) => {
    const a = th0 + Math.PI / 6 + (k * Math.PI) / 3;
    return { x: Math.cos(a), y: Math.sin(a) };
  });
  return { R, inR, normals };
}

// 歩ける地面の判定を、その対戦の盤から作る。
// 戻り値: (x, z) => { y, ok }
export function makeGround(state) {
  const { R, inR, normals } = hexMetrics();
  // 陸のヘックスだけを歩ける。海に踏み出すと落ちる。
  const land = [];
  for (const hid of state.board.hexIds) {
    if (state.mode === 'sea' && !isLandHex(state.board, hid)) continue;
    land.push({ hid, c: hexCenter(hid) });
  }
  const inside = (p, c) => {
    const dx = p.x - c.x;
    const dy = p.y - c.y;
    if (dx * dx + dy * dy > R * R) return false; // 外接円で早く落とす
    return normals.every((n) => Math.abs(dx * n.x + dy * n.y) <= inR + 1e-6);
  };
  return (x, z) => {
    const p = { x, y: z };
    for (const t of land) {
      if (inside(p, t.c)) return { y: TILE_TOP, ok: true, hexId: t.hid };
    }
    return { y: TILE_TOP, ok: false, hexId: null };
  };
}

// 島のどこから歩き始めるか(陸のヘックスの中心で、いちばん中央寄り)
export function spawnPoint(state) {
  let best = null;
  for (const hid of state.board.hexIds) {
    if (state.mode === 'sea' && !isLandHex(state.board, hid)) continue;
    const c = hexCenter(hid);
    const d = Math.hypot(c.x, c.y);
    if (!best || d < best.d) best = { d, c };
  }
  return best ? best.c : { x: 0, y: 0 };
}

