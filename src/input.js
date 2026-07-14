// クリック → 盤面要素の逆引き(設計書 §8.3)
// 最近傍探索、閾値付き。候補リストの中からのみ選ぶ。

import { LAYOUT } from './rules/board.js';
import { toPixel, hexCenterOf } from './render/board-render.js';

function nearest(items, getXY, px, py, maxDist) {
  let bestId = null;
  let bestD = maxDist;
  for (const id of items) {
    const [x, y] = getXY(id);
    const d = Math.hypot(x - px, y - py);
    if (d < bestD) {
      bestD = d;
      bestId = id;
    }
  }
  return bestId;
}

export function pickVertex(view, px, py, candidates) {
  return nearest(
    candidates,
    (vid) => toPixel(view, LAYOUT.vertices[vid].x, LAYOUT.vertices[vid].y),
    px, py,
    view.scale * 0.45,
  );
}

export function pickEdge(view, px, py, candidates) {
  return nearest(
    candidates,
    (eid) => toPixel(view, LAYOUT.edges[eid].x, LAYOUT.edges[eid].y),
    px, py,
    view.scale * 0.4,
  );
}

export function pickHex(view, px, py, candidates) {
  return nearest(
    candidates,
    (hid) => {
      const c = hexCenterOf(hid);
      return toPixel(view, c.x, c.y);
    },
    px, py,
    view.scale * 0.85,
  );
}
