// Canvas 盤面描画(設計書 §8)
// ロジックは一切持たない。GameState と UI 状態を受け取って描くだけ。

import { LAYOUT, PIPS } from '../rules/board.js';
import { RES_JP_SHORT } from '../state.js';

export const PLAYER_COLORS = ['#e63946', '#3d7dd8', '#f4a261', '#9d4edd'];

const TERRAIN_COLORS = {
  forest: '#2d6a4f',
  pasture: '#7cbf5f',
  field: '#e8c56a',
  hill: '#c1666b',
  mountain: '#8d99ae',
  desert: '#e3d5b3',
};

const TERRAIN_JP = {
  forest: '森林',
  pasture: '牧草地',
  field: '畑',
  hill: '丘陵',
  mountain: '山地',
  desert: '砂漠',
};

// 論理座標(サイズ1)→ ピクセルのビュー変換。リサイズ対応はここで完結。
export function computeView(width, height) {
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const v of Object.values(LAYOUT.vertices)) {
    minX = Math.min(minX, v.x); maxX = Math.max(maxX, v.x);
    minY = Math.min(minY, v.y); maxY = Math.max(maxY, v.y);
  }
  const margin = 1.3; // 港ラベルの分
  const scale = Math.min(
    width / (maxX - minX + margin * 2),
    height / (maxY - minY + margin * 2),
  );
  return {
    scale,
    ox: width / 2 - ((minX + maxX) / 2) * scale,
    oy: height / 2 - ((minY + maxY) / 2) * scale,
  };
}

export function toPixel(view, x, y) {
  return [view.ox + x * view.scale, view.oy + y * view.scale];
}

function hexPath(ctx, view, hid, shrink = 1) {
  const corners = LAYOUT.hexVertices[hid];
  ctx.beginPath();
  corners.forEach((vid, i) => {
    const v = LAYOUT.vertices[vid];
    // shrink: 中心にわずかに寄せて境界線を見せる
    const hexCenter = hexCenterOf(hid);
    const x = hexCenter.x + (v.x - hexCenter.x) * shrink;
    const y = hexCenter.y + (v.y - hexCenter.y) * shrink;
    const [px, py] = toPixel(view, x, y);
    i === 0 ? ctx.moveTo(px, py) : ctx.lineTo(px, py);
  });
  ctx.closePath();
}

const hexCenters = {};
function hexCenterOf(hid) {
  if (!hexCenters[hid]) {
    const corners = LAYOUT.hexVertices[hid];
    let x = 0, y = 0;
    for (const vid of corners) { x += LAYOUT.vertices[vid].x; y += LAYOUT.vertices[vid].y; }
    hexCenters[hid] = { x: x / 6, y: y / 6 };
  }
  return hexCenters[hid];
}

export { hexCenterOf };

function drawToken(ctx, view, hid, token, isRobber) {
  const c = hexCenterOf(hid);
  const [px, py] = toPixel(view, c.x, c.y);
  const r = view.scale * 0.32;

  ctx.beginPath();
  ctx.arc(px, py, r, 0, Math.PI * 2);
  ctx.fillStyle = isRobber ? '#555' : '#f5efdf';
  ctx.fill();
  ctx.strokeStyle = 'rgba(0,0,0,0.35)';
  ctx.lineWidth = 1.5;
  ctx.stroke();

  const hot = token === 6 || token === 8;
  ctx.fillStyle = isRobber ? '#ccc' : hot ? '#c1121f' : '#333';
  ctx.font = `bold ${Math.round(view.scale * 0.30)}px system-ui, sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(String(token), px, py - r * 0.15);

  // 確率ピップ
  const pips = PIPS[token];
  const pr = view.scale * 0.028;
  const spread = pr * 3;
  for (let i = 0; i < pips; i++) {
    const x = px + (i - (pips - 1) / 2) * spread;
    ctx.beginPath();
    ctx.arc(x, py + r * 0.45, pr, 0, Math.PI * 2);
    ctx.fill();
  }
}

function drawRobber(ctx, view, hid) {
  const c = hexCenterOf(hid);
  const [px, py] = toPixel(view, c.x, c.y - 0.52);
  const s = view.scale * 0.16;
  ctx.fillStyle = '#222';
  ctx.strokeStyle = '#000';
  ctx.beginPath();
  ctx.ellipse(px, py, s * 0.9, s * 1.2, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.beginPath();
  ctx.arc(px, py - s * 1.3, s * 0.55, 0, Math.PI * 2);
  ctx.fill();
}

function drawPorts(ctx, view, state) {
  for (const port of state.board.ports) {
    const e = LAYOUT.edges[port.edgeId];
    const len = Math.hypot(e.x, e.y) || 1;
    const ox = (e.x / len) * 0.55;
    const oy = (e.y / len) * 0.55;
    const [px, py] = toPixel(view, e.x + ox, e.y + oy);

    // 桟橋(辺の両端から港へ)
    ctx.strokeStyle = 'rgba(240,230,200,0.75)';
    ctx.lineWidth = Math.max(2, view.scale * 0.05);
    for (const vid of e.v) {
      const v = LAYOUT.vertices[vid];
      const [vx, vy] = toPixel(view, v.x, v.y);
      ctx.beginPath();
      ctx.moveTo(vx, vy);
      ctx.lineTo(px, py);
      ctx.stroke();
    }

    const r = view.scale * 0.24;
    ctx.beginPath();
    ctx.arc(px, py, r, 0, Math.PI * 2);
    ctx.fillStyle = '#f5efdf';
    ctx.fill();
    ctx.strokeStyle = 'rgba(0,0,0,0.3)';
    ctx.lineWidth = 1.5;
    ctx.stroke();

    ctx.fillStyle = '#333';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    if (port.type === '3:1') {
      ctx.font = `bold ${Math.round(view.scale * 0.18)}px system-ui, sans-serif`;
      ctx.fillText('3:1', px, py);
    } else {
      ctx.font = `bold ${Math.round(view.scale * 0.15)}px system-ui, sans-serif`;
      ctx.fillText(RES_JP_SHORT[port.type], px, py - r * 0.28);
      ctx.fillText('2:1', px, py + r * 0.36);
    }
  }
}

function drawRoad(ctx, view, eid, color, alpha = 1) {
  const [v1, v2] = LAYOUT.edges[eid].v.map((v) => LAYOUT.vertices[v]);
  // 両端を少し内側に(頂点の建物と重ならないように)
  const t = 0.16;
  const x1 = v1.x + (v2.x - v1.x) * t;
  const y1 = v1.y + (v2.y - v1.y) * t;
  const x2 = v2.x + (v1.x - v2.x) * t;
  const y2 = v2.y + (v1.y - v2.y) * t;
  const [px1, py1] = toPixel(view, x1, y1);
  const [px2, py2] = toPixel(view, x2, y2);
  ctx.globalAlpha = alpha;
  ctx.lineCap = 'round';
  ctx.strokeStyle = '#1b1b1b';
  ctx.lineWidth = view.scale * 0.14;
  ctx.beginPath(); ctx.moveTo(px1, py1); ctx.lineTo(px2, py2); ctx.stroke();
  ctx.strokeStyle = color;
  ctx.lineWidth = view.scale * 0.09;
  ctx.beginPath(); ctx.moveTo(px1, py1); ctx.lineTo(px2, py2); ctx.stroke();
  ctx.globalAlpha = 1;
}

function drawBuilding(ctx, view, vid, color, type) {
  const v = LAYOUT.vertices[vid];
  const [px, py] = toPixel(view, v.x, v.y);
  const s = view.scale * (type === 'city' ? 0.17 : 0.13);
  ctx.fillStyle = color;
  ctx.strokeStyle = '#1b1b1b';
  ctx.lineWidth = Math.max(1.5, view.scale * 0.025);
  ctx.beginPath();
  if (type === 'city') {
    // 都市: 塔つきの大きなシルエット
    ctx.moveTo(px - s, py + s * 0.9);
    ctx.lineTo(px - s, py - s * 0.2);
    ctx.lineTo(px - s * 0.55, py - s * 0.85);
    ctx.lineTo(px - s * 0.1, py - s * 0.2);
    ctx.lineTo(px + s, py - s * 0.2);
    ctx.lineTo(px + s, py + s * 0.9);
  } else {
    // 開拓地: 家
    ctx.moveTo(px - s, py + s);
    ctx.lineTo(px - s, py - s * 0.2);
    ctx.lineTo(px, py - s);
    ctx.lineTo(px + s, py - s * 0.2);
    ctx.lineTo(px + s, py + s);
  }
  ctx.closePath();
  ctx.fill();
  ctx.stroke();
}

function drawHighlights(ctx, view, highlights, selected) {
  const mark = (x, y, r, style) => {
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fillStyle = style.fill;
    ctx.fill();
    ctx.strokeStyle = style.stroke;
    ctx.lineWidth = 2;
    ctx.stroke();
  };
  const hi = { fill: 'rgba(255,235,120,0.45)', stroke: 'rgba(255,220,60,0.95)' };
  const sel = { fill: 'rgba(120,255,160,0.55)', stroke: 'rgba(40,200,90,1)' };

  for (const hid of highlights.hexes ?? []) {
    hexPath(ctx, view, hid, 0.93);
    ctx.fillStyle = 'rgba(255,235,120,0.28)';
    ctx.fill();
    ctx.strokeStyle = hi.stroke;
    ctx.lineWidth = 2.5;
    ctx.stroke();
  }
  for (const eid of highlights.edges ?? []) {
    const e = LAYOUT.edges[eid];
    const [px, py] = toPixel(view, e.x, e.y);
    mark(px, py, view.scale * 0.13, hi);
  }
  for (const vid of highlights.vertices ?? []) {
    const v = LAYOUT.vertices[vid];
    const [px, py] = toPixel(view, v.x, v.y);
    mark(px, py, view.scale * 0.15, hi);
  }
  if (selected) {
    if (selected.vertexId) {
      const v = LAYOUT.vertices[selected.vertexId];
      const [px, py] = toPixel(view, v.x, v.y);
      mark(px, py, view.scale * 0.17, sel);
    }
    if (selected.edgeId) {
      const e = LAYOUT.edges[selected.edgeId];
      const [px, py] = toPixel(view, e.x, e.y);
      mark(px, py, view.scale * 0.15, sel);
    }
    if (selected.hexId) {
      hexPath(ctx, view, selected.hexId, 0.93);
      ctx.strokeStyle = sel.stroke;
      ctx.lineWidth = 3;
      ctx.stroke();
    }
  }
}

// メイン描画。ui: { highlights, selected, pendingEdges }
export function drawBoard(ctx, width, height, state, ui) {
  const view = computeView(width, height);

  // 海
  ctx.fillStyle = '#14507a';
  ctx.fillRect(0, 0, width, height);

  // ヘックス
  for (const hid of LAYOUT.hexIds) {
    const hex = state.board.hexes[hid];
    hexPath(ctx, view, hid, 0.97);
    ctx.fillStyle = TERRAIN_COLORS[hex.terrain];
    ctx.fill();
    ctx.strokeStyle = 'rgba(0,0,0,0.25)';
    ctx.lineWidth = 2;
    ctx.stroke();

    const c = hexCenterOf(hid);
    const [px, py] = toPixel(view, c.x, c.y);
    ctx.fillStyle = 'rgba(0,0,0,0.45)';
    ctx.font = `${Math.round(view.scale * 0.15)}px system-ui, sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(TERRAIN_JP[hex.terrain], px, py - view.scale * 0.55);

    if (hex.token) drawToken(ctx, view, hid, hex.token, state.board.robber === hid);
  }

  drawPorts(ctx, view, state);
  if (state.board.hexes[state.board.robber]) drawRobber(ctx, view, state.board.robber);

  // 道 → 建物の順(建物を上に)
  for (const [eid, road] of Object.entries(state.roads)) {
    drawRoad(ctx, view, eid, PLAYER_COLORS[road.player]);
  }
  for (const eid of ui.pendingEdges ?? []) {
    drawRoad(ctx, view, eid, PLAYER_COLORS[0], 0.55);
  }
  for (const [vid, b] of Object.entries(state.buildings)) {
    drawBuilding(ctx, view, vid, PLAYER_COLORS[b.player], b.type);
  }

  drawHighlights(ctx, view, ui.highlights ?? {}, ui.selected);
  return view;
}
