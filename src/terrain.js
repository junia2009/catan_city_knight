// 「立てる面」の高さ。**描いてあるものと、歩く足の位置を合わせる**ための1本。
//
// タイルの上面(TILE_TOP)は平らだが、その上に数字トークンの円盤が載っている。
// 歩く側がそれを知らずに TILE_TOP に立たせていたので、**円盤の上では
// 膝まで潜っていた**(実機で「足が埋まる」と報告された)。
//
// THREE は使わない ── minigame/ground.js から呼ぶため。
// (CI は npm install をせずにテストを回すので、three を import した瞬間に落ちる)
//
// 【判明していること】タイルにはもう1枚「地形の起伏」(board3d.js の
// makeTerrainCap)が載っているが、面がすべて下を向いていて**画面には出ていない**
// ── 真っ赤に塗って撮っても盤の色が変わらないことを確かめた。見えないものに
// 立たせると宙に浮くので、ここでは数えない。起伏を出すなら、まず面の向きを
// 直すところから(見た目が変わる話なので別件)。

import { LAYOUT, boardVertexIds, boardGeometry, hexIdsWithin } from './rules/board.js';

export const TILE_TOP = 0.26;   // タイル上面(board3d.js と同じ値)

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

// 盤の広がり(基本の盤を 1 とする倍率)。board3d.js のカメラの引き具合と、
// トークンの大きさに使う。広い盤では円盤を大きく描くので、
// **乗れる範囲も一緒に広がる** ── だから歩く側もこの値が要る。
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

export function tokenRadius(board) {
  const k = boardScale(board);
  return TOKEN_R * (k > 1 ? Math.min(1.35, k) : 1);
}

// タイル上面から測った「立てる高さ」。いまは数字トークンの厚みだけ。
export function surfaceHeight(board, hid, x, z, tokenR = null) {
  const hex = board.hexes[hid];
  if (!hex?.token) return 0;
  const c = hexCenter(hid);
  const r = tokenR ?? tokenRadius(board);
  return Math.hypot(x - c.x, z - c.y) <= r ? TOKEN_H : 0;
}
