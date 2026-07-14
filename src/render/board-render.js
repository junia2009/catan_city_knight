// Canvas 盤面描画(設計書 §8)
// ロジックは一切持たない。GameState と UI 状態を受け取って描くだけ。
// 静的レイヤー(海・島・地形・トークン・港)はオフスクリーンにキャッシュし、
// 動的レイヤー(盗賊・道・建物・ハイライト)を毎回上描きする。

import { LAYOUT, PIPS } from '../rules/board.js';

export const PLAYER_COLORS = ['#e04848', '#3d7dd8', '#f0973c', '#9d5fd8'];
export const PLAYER_COLORS_DARK = ['#9c2626', '#22508f', '#b3651a', '#6a3a99'];

const TERRAIN_STYLE = {
  forest:   { top: '#4a8a58', bottom: '#2f6340' },
  pasture:  { top: '#a4cf62', bottom: '#7fb244' },
  field:    { top: '#f0cd58', bottom: '#d9a92f' },
  hill:     { top: '#cd7d4c', bottom: '#a85a32' },
  mountain: { top: '#a3aebc', bottom: '#7d8a9c' },
  desert:   { top: '#ecdcae', bottom: '#d8c088' },
};

// ---- 決定的な擬似乱数(装飾モチーフの配置用、hexId から生成) ----

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

// ---- ビュー変換 ----

export function computeView(width, height) {
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const v of Object.values(LAYOUT.vertices)) {
    minX = Math.min(minX, v.x); maxX = Math.max(maxX, v.x);
    minY = Math.min(minY, v.y); maxY = Math.max(maxY, v.y);
  }
  const margin = 1.35; // 港・海の分
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

const hexCenters = {};
export function hexCenterOf(hid) {
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

function hexPath(ctx, view, hid, shrink = 1) {
  const c = hexCenterOf(hid);
  ctx.beginPath();
  LAYOUT.hexVertices[hid].forEach((vid, i) => {
    const v = LAYOUT.vertices[vid];
    const [px, py] = toPixel(view, c.x + (v.x - c.x) * shrink, c.y + (v.y - c.y) * shrink);
    i === 0 ? ctx.moveTo(px, py) : ctx.lineTo(px, py);
  });
  ctx.closePath();
}

// ---- 地形モチーフ(手続き描画) ----

function drawTree(ctx, x, y, s, rng) {
  const lean = (rng() - 0.5) * s * 0.2;
  ctx.fillStyle = '#5d4025';
  ctx.fillRect(x - s * 0.07, y, s * 0.14, s * 0.35);
  const g = ctx.createLinearGradient(x, y - s, x, y);
  g.addColorStop(0, '#2f6b3d');
  g.addColorStop(1, '#1c4a29');
  ctx.fillStyle = g;
  for (let i = 0; i < 2; i++) {
    const w = s * (0.55 - i * 0.14);
    const top = y - s * (0.55 + i * 0.4);
    ctx.beginPath();
    ctx.moveTo(x + lean * i, top);
    ctx.lineTo(x - w, top + s * 0.62);
    ctx.lineTo(x + w, top + s * 0.62);
    ctx.closePath();
    ctx.fill();
  }
}

function drawSheep(ctx, x, y, s) {
  ctx.fillStyle = '#f7f4ea';
  ctx.strokeStyle = 'rgba(0,0,0,0.25)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.ellipse(x, y, s * 0.55, s * 0.38, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();
  ctx.fillStyle = '#4a4038';
  ctx.beginPath();
  ctx.arc(x + s * 0.5, y - s * 0.12, s * 0.2, 0, Math.PI * 2);
  ctx.fill();
  // 脚
  ctx.strokeStyle = '#4a4038';
  ctx.lineWidth = Math.max(1, s * 0.1);
  ctx.beginPath();
  ctx.moveTo(x - s * 0.25, y + s * 0.3); ctx.lineTo(x - s * 0.25, y + s * 0.55);
  ctx.moveTo(x + s * 0.2, y + s * 0.3); ctx.lineTo(x + s * 0.2, y + s * 0.55);
  ctx.stroke();
}

function drawWheat(ctx, x, y, s, rng) {
  ctx.strokeStyle = '#b9871f';
  ctx.lineWidth = Math.max(1, s * 0.08);
  for (let i = -1; i <= 1; i++) {
    const bx = x + i * s * 0.28;
    const sway = (rng() - 0.5) * s * 0.3;
    ctx.beginPath();
    ctx.moveTo(bx, y + s * 0.5);
    ctx.quadraticCurveTo(bx + sway, y, bx + sway, y - s * 0.45);
    ctx.stroke();
    // 穂
    ctx.fillStyle = '#8f6a12';
    for (let j = 0; j < 4; j++) {
      ctx.beginPath();
      ctx.ellipse(bx + sway, y - s * (0.45 - j * 0.13), s * 0.09, s * 0.05, 0.6, 0, Math.PI * 2);
      ctx.fill();
    }
  }
}

function drawBricks(ctx, x, y, s) {
  const bw = s * 0.42, bh = s * 0.2, gap = s * 0.05;
  ctx.strokeStyle = 'rgba(0,0,0,0.2)';
  ctx.lineWidth = 1;
  for (let row = 0; row < 3; row++) {
    const offset = row % 2 ? bw / 2 + gap / 2 : 0;
    for (let col = 0; col < 2; col++) {
      const bx = x - bw - gap / 2 + col * (bw + gap) + offset - (row % 2 ? bw / 2 : 0);
      const by = y - (bh + gap) + row * (bh + gap);
      ctx.fillStyle = row % 2 ? '#8f4526' : '#9c4f2c';
      ctx.beginPath();
      ctx.roundRect(bx, by, bw, bh, s * 0.03);
      ctx.fill();
      ctx.stroke();
      ctx.fillStyle = 'rgba(255,255,255,0.15)';
      ctx.fillRect(bx, by, bw, bh * 0.3);
    }
  }
}

function drawPeak(ctx, x, y, s) {
  const g = ctx.createLinearGradient(x, y - s, x, y);
  g.addColorStop(0, '#8b97a8');
  g.addColorStop(1, '#5f6c80');
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.moveTo(x, y - s);
  ctx.lineTo(x - s * 0.9, y);
  ctx.lineTo(x + s * 0.9, y);
  ctx.closePath();
  ctx.fill();
  // 雪冠
  ctx.fillStyle = '#eef2f6';
  ctx.beginPath();
  ctx.moveTo(x, y - s);
  ctx.lineTo(x - s * 0.28, y - s * 0.62);
  ctx.lineTo(x - s * 0.1, y - s * 0.68);
  ctx.lineTo(x + s * 0.06, y - s * 0.58);
  ctx.lineTo(x + s * 0.24, y - s * 0.66);
  ctx.closePath();
  ctx.fill();
}

function drawDune(ctx, x, y, s) {
  ctx.strokeStyle = 'rgba(150,120,60,0.55)';
  ctx.lineWidth = Math.max(1, s * 0.08);
  ctx.beginPath();
  ctx.moveTo(x - s, y);
  ctx.quadraticCurveTo(x, y - s * 0.5, x + s, y);
  ctx.stroke();
}

function drawCactus(ctx, x, y, s) {
  ctx.strokeStyle = '#4f7a3a';
  ctx.lineCap = 'round';
  ctx.lineWidth = Math.max(2, s * 0.22);
  ctx.beginPath();
  ctx.moveTo(x, y + s * 0.5); ctx.lineTo(x, y - s * 0.5);
  ctx.moveTo(x - s * 0.35, y - s * 0.2); ctx.lineTo(x - s * 0.35, y); ctx.lineTo(x, y);
  ctx.moveTo(x + s * 0.35, y - s * 0.35); ctx.lineTo(x + s * 0.35, y - s * 0.1); ctx.lineTo(x, y - s * 0.1);
  ctx.stroke();
}

// トークン(r≈0.37)を避けたリング帯に配置する
function ringPositions(rng, count, rMin = 0.42, rMax = 0.6) {
  const out = [];
  const step = (Math.PI * 2) / count;
  for (let i = 0; i < count; i++) {
    const a = i * step + rng() * step * 0.6;
    const r = rMin + rng() * (rMax - rMin);
    out.push([Math.cos(a) * r, Math.sin(a) * r]);
  }
  return out;
}

function drawTerrainDecor(ctx, view, hid, terrain) {
  const rng = localRng(hashStr(hid + terrain));
  const c = hexCenterOf(hid);
  const [cx, cy] = toPixel(view, c.x, c.y);
  const u = view.scale;

  if (terrain === 'forest') {
    for (const [dx, dy] of ringPositions(rng, 6, 0.4, 0.62)) {
      drawTree(ctx, cx + dx * u, cy + dy * u, u * 0.22, rng);
    }
  } else if (terrain === 'pasture') {
    ctx.strokeStyle = 'rgba(70,120,40,0.5)';
    ctx.lineWidth = Math.max(1, u * 0.02);
    for (const [dx, dy] of ringPositions(rng, 8, 0.35, 0.62)) {
      const gx = cx + dx * u, gy = cy + dy * u;
      ctx.beginPath();
      for (let k = -1; k <= 1; k++) {
        ctx.moveTo(gx + k * u * 0.03, gy + u * 0.05);
        ctx.lineTo(gx + k * u * 0.045, gy - u * 0.05);
      }
      ctx.stroke();
    }
    const pos = ringPositions(rng, 2, 0.42, 0.55);
    for (const [dx, dy] of pos) drawSheep(ctx, cx + dx * u, cy + dy * u, u * 0.14);
  } else if (terrain === 'field') {
    for (const [dx, dy] of ringPositions(rng, 5, 0.4, 0.6)) {
      drawWheat(ctx, cx + dx * u, cy + dy * u, u * 0.18, rng);
    }
  } else if (terrain === 'hill') {
    for (const [dx, dy] of ringPositions(rng, 3, 0.42, 0.56)) {
      drawBricks(ctx, cx + dx * u, cy + dy * u, u * 0.24);
    }
  } else if (terrain === 'mountain') {
    const pos = [[-0.34, 0.42], [0.38, 0.38], [0.02, 0.56]];
    for (const [dx, dy] of pos) {
      drawPeak(ctx, cx + dx * u, cy + dy * u, u * (0.3 + rng() * 0.1));
    }
  } else if (terrain === 'desert') {
    for (const [dx, dy] of ringPositions(rng, 4, 0.35, 0.58)) {
      drawDune(ctx, cx + dx * u, cy + dy * u, u * 0.2);
    }
    drawCactus(ctx, cx + u * 0.42, cy - u * 0.38, u * 0.16);
  }
}

// ---- 静的レイヤー ----

function drawSea(ctx, width, height, view) {
  const g = ctx.createRadialGradient(
    width / 2, height / 2, view.scale,
    width / 2, height / 2, Math.max(width, height) * 0.75,
  );
  g.addColorStop(0, '#2277ad');
  g.addColorStop(0.55, '#175e8f');
  g.addColorStop(1, '#0c3e63');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, width, height);

  // さざ波
  const rng = localRng(20260714);
  ctx.strokeStyle = 'rgba(255,255,255,0.10)';
  ctx.lineWidth = Math.max(1, view.scale * 0.03);
  ctx.lineCap = 'round';
  for (let i = 0; i < 26; i++) {
    const x = rng() * width;
    const y = rng() * height;
    const w = view.scale * (0.25 + rng() * 0.3);
    ctx.beginPath();
    ctx.arc(x, y, w, Math.PI * 0.15, Math.PI * 0.85);
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(x + w * 0.9, y + w * 0.15, w * 0.6, Math.PI * 0.15, Math.PI * 0.85);
    ctx.stroke();
  }
}

function drawIslandBase(ctx, view) {
  // 砂浜(全ヘックスを拡大して下敷きに)
  for (const [color, scale] of [['rgba(0,0,0,0.28)', 1.13], ['#e8d5a0', 1.1], ['#d9bf82', 1.045]]) {
    ctx.fillStyle = color;
    for (const hid of LAYOUT.hexIds) {
      hexPath(ctx, view, hid, scale);
      ctx.fill();
    }
  }
}

function drawHexTile(ctx, view, hid, terrain) {
  const c = hexCenterOf(hid);
  const [cx, cy] = toPixel(view, c.x, c.y);
  const st = TERRAIN_STYLE[terrain];
  const g = ctx.createLinearGradient(cx, cy - view.scale, cx, cy + view.scale);
  g.addColorStop(0, st.top);
  g.addColorStop(1, st.bottom);
  hexPath(ctx, view, hid, 0.985);
  ctx.fillStyle = g;
  ctx.fill();
  ctx.strokeStyle = 'rgba(0,0,0,0.28)';
  ctx.lineWidth = Math.max(1.5, view.scale * 0.03);
  ctx.stroke();
  // 上辺のハイライトで立体感
  hexPath(ctx, view, hid, 0.93);
  ctx.strokeStyle = 'rgba(255,255,255,0.14)';
  ctx.lineWidth = Math.max(1, view.scale * 0.02);
  ctx.stroke();
}

function drawToken(ctx, view, hid, token) {
  const c = hexCenterOf(hid);
  const [px, py] = toPixel(view, c.x, c.y);
  const r = view.scale * 0.3;

  ctx.save();
  ctx.shadowColor = 'rgba(0,0,0,0.4)';
  ctx.shadowBlur = view.scale * 0.08;
  ctx.shadowOffsetY = view.scale * 0.04;
  ctx.beginPath();
  ctx.arc(px, py, r, 0, Math.PI * 2);
  ctx.fillStyle = '#f8f1dd';
  ctx.fill();
  ctx.restore();

  ctx.beginPath();
  ctx.arc(px, py, r, 0, Math.PI * 2);
  ctx.strokeStyle = '#c6b283';
  ctx.lineWidth = Math.max(1.5, view.scale * 0.035);
  ctx.stroke();

  const hot = token === 6 || token === 8;
  ctx.fillStyle = hot ? '#c1121f' : '#3a3226';
  ctx.font = `700 ${Math.round(view.scale * 0.3)}px Georgia, 'Times New Roman', serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(String(token), px, py - r * 0.16);

  const pips = PIPS[token];
  const pr = view.scale * 0.026;
  for (let i = 0; i < pips; i++) {
    ctx.beginPath();
    ctx.arc(px + (i - (pips - 1) / 2) * pr * 3.1, py + r * 0.46, pr, 0, Math.PI * 2);
    ctx.fill();
  }
}

const PORT_EMOJI = { wood: '🪵', brick: '🧱', sheep: '🐑', wheat: '🌾', ore: '🪨' };

function drawPorts(ctx, view, state) {
  for (const port of state.board.ports) {
    const e = LAYOUT.edges[port.edgeId];
    const len = Math.hypot(e.x, e.y) || 1;
    const px0 = e.x + (e.x / len) * 0.55;
    const py0 = e.y + (e.y / len) * 0.55;
    const [px, py] = toPixel(view, px0, py0);

    // 桟橋
    ctx.strokeStyle = '#8a6238';
    ctx.lineWidth = Math.max(3, view.scale * 0.07);
    ctx.lineCap = 'round';
    for (const vid of e.v) {
      const v = LAYOUT.vertices[vid];
      const [vx, vy] = toPixel(view, v.x, v.y);
      ctx.beginPath();
      ctx.moveTo(vx, vy);
      ctx.lineTo(px, py);
      ctx.stroke();
    }

    const r = view.scale * 0.235;
    ctx.save();
    ctx.shadowColor = 'rgba(0,0,0,0.45)';
    ctx.shadowBlur = view.scale * 0.06;
    ctx.shadowOffsetY = view.scale * 0.03;
    ctx.beginPath();
    ctx.arc(px, py, r, 0, Math.PI * 2);
    ctx.fillStyle = '#b98b4f';
    ctx.fill();
    ctx.restore();
    ctx.beginPath();
    ctx.arc(px, py, r, 0, Math.PI * 2);
    ctx.strokeStyle = '#6f4e26';
    ctx.lineWidth = Math.max(1.5, view.scale * 0.03);
    ctx.stroke();

    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    if (port.type === '3:1') {
      ctx.fillStyle = '#fff6e0';
      ctx.font = `800 ${Math.round(view.scale * 0.17)}px system-ui, sans-serif`;
      ctx.fillText('3:1', px, py);
    } else {
      ctx.font = `${Math.round(view.scale * 0.2)}px system-ui, sans-serif`;
      ctx.fillText(PORT_EMOJI[port.type], px, py - r * 0.22);
      ctx.fillStyle = '#fff6e0';
      ctx.font = `800 ${Math.round(view.scale * 0.12)}px system-ui, sans-serif`;
      ctx.fillText('2:1', px, py + r * 0.5);
    }
  }
}

// 静的レイヤーのキャッシュ
let staticCache = { key: null, canvas: null };

function getStaticLayer(state, width, height, dpr) {
  const key = `${state.seed}:${width}x${height}@${dpr}`;
  if (staticCache.key === key) return staticCache.canvas;

  const off = document.createElement('canvas');
  off.width = Math.round(width * dpr);
  off.height = Math.round(height * dpr);
  const ctx = off.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  const view = computeView(width, height);

  drawSea(ctx, width, height, view);
  drawIslandBase(ctx, view);
  for (const hid of LAYOUT.hexIds) {
    drawHexTile(ctx, view, hid, state.board.hexes[hid].terrain);
  }
  for (const hid of LAYOUT.hexIds) {
    drawTerrainDecor(ctx, view, hid, state.board.hexes[hid].terrain);
    const hex = state.board.hexes[hid];
    if (hex.token) drawToken(ctx, view, hid, hex.token);
  }
  drawPorts(ctx, view, state);

  // 周辺ビネット
  const vg = ctx.createRadialGradient(
    width / 2, height / 2, Math.min(width, height) * 0.4,
    width / 2, height / 2, Math.max(width, height) * 0.8,
  );
  vg.addColorStop(0, 'rgba(0,10,25,0)');
  vg.addColorStop(1, 'rgba(0,10,25,0.4)');
  ctx.fillStyle = vg;
  ctx.fillRect(0, 0, width, height);

  staticCache = { key, canvas: off };
  return off;
}

// ---- 動的レイヤー ----

function drawRobber(ctx, view, hid) {
  const c = hexCenterOf(hid);
  const [px, py] = toPixel(view, c.x, c.y - 0.02);
  const s = view.scale * 0.17;

  ctx.save();
  ctx.fillStyle = 'rgba(0,0,0,0.35)';
  ctx.beginPath();
  ctx.ellipse(px, py + s * 1.15, s * 1.1, s * 0.4, 0, 0, Math.PI * 2);
  ctx.fill();

  const g = ctx.createLinearGradient(px - s, py - s * 2, px + s, py + s);
  g.addColorStop(0, '#4d4a55');
  g.addColorStop(1, '#211f26');
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.moveTo(px - s * 0.95, py + s * 1.1);
  ctx.quadraticCurveTo(px - s * 1.05, py - s * 0.5, px - s * 0.45, py - s * 0.85);
  ctx.arc(px, py - s * 1.35, s * 0.62, Math.PI * 0.95, Math.PI * 2.05);
  ctx.quadraticCurveTo(px + s * 1.05, py - s * 0.5, px + s * 0.95, py + s * 1.1);
  ctx.closePath();
  ctx.fill();
  ctx.strokeStyle = 'rgba(0,0,0,0.5)';
  ctx.lineWidth = 1.5;
  ctx.stroke();
  ctx.restore();
}

function drawRoad(ctx, view, eid, pid, alpha = 1) {
  const [v1, v2] = LAYOUT.edges[eid].v.map((v) => LAYOUT.vertices[v]);
  const t = 0.16;
  const [px1, py1] = toPixel(view, v1.x + (v2.x - v1.x) * t, v1.y + (v2.y - v1.y) * t);
  const [px2, py2] = toPixel(view, v2.x + (v1.x - v2.x) * t, v2.y + (v1.y - v2.y) * t);
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.lineCap = 'round';
  ctx.shadowColor = 'rgba(0,0,0,0.4)';
  ctx.shadowBlur = view.scale * 0.05;
  ctx.shadowOffsetY = view.scale * 0.03;
  ctx.strokeStyle = PLAYER_COLORS_DARK[pid];
  ctx.lineWidth = view.scale * 0.13;
  ctx.beginPath(); ctx.moveTo(px1, py1); ctx.lineTo(px2, py2); ctx.stroke();
  ctx.shadowColor = 'transparent';
  ctx.strokeStyle = PLAYER_COLORS[pid];
  ctx.lineWidth = view.scale * 0.08;
  ctx.beginPath(); ctx.moveTo(px1, py1); ctx.lineTo(px2, py2); ctx.stroke();
  ctx.restore();
}

function drawBuilding(ctx, view, vid, pid, type) {
  const v = LAYOUT.vertices[vid];
  const [px, py] = toPixel(view, v.x, v.y);
  const s = view.scale * (type === 'city' ? 0.18 : 0.14);

  ctx.save();
  ctx.shadowColor = 'rgba(0,0,0,0.45)';
  ctx.shadowBlur = view.scale * 0.07;
  ctx.shadowOffsetY = view.scale * 0.035;
  ctx.lineJoin = 'round';
  ctx.lineWidth = Math.max(1.5, view.scale * 0.03);
  ctx.strokeStyle = PLAYER_COLORS_DARK[pid];

  const wall = ctx.createLinearGradient(px, py - s, px, py + s);
  wall.addColorStop(0, PLAYER_COLORS[pid]);
  wall.addColorStop(1, PLAYER_COLORS_DARK[pid]);
  ctx.fillStyle = wall;

  ctx.beginPath();
  if (type === 'city') {
    // 都市: 塔 + 本体
    ctx.moveTo(px - s, py + s * 0.95);
    ctx.lineTo(px - s, py - s * 0.55);
    ctx.lineTo(px - s * 0.62, py - s * 1.05);
    ctx.lineTo(px - s * 0.24, py - s * 0.55);
    ctx.lineTo(px - s * 0.24, py - s * 0.1);
    ctx.lineTo(px + s, py - s * 0.1);
    ctx.lineTo(px + s, py + s * 0.95);
  } else {
    // 開拓地: 家
    ctx.moveTo(px - s, py + s * 0.9);
    ctx.lineTo(px - s, py - s * 0.15);
    ctx.lineTo(px, py - s);
    ctx.lineTo(px + s, py - s * 0.15);
    ctx.lineTo(px + s, py + s * 0.9);
  }
  ctx.closePath();
  ctx.fill();
  ctx.stroke();

  // 白ふち(視認性)
  ctx.shadowColor = 'transparent';
  ctx.strokeStyle = 'rgba(255,255,255,0.65)';
  ctx.lineWidth = Math.max(1, view.scale * 0.014);
  ctx.stroke();
  ctx.restore();
}

function pulse(time) {
  return 0.55 + 0.35 * Math.sin(time / 260);
}

function drawHighlights(ctx, view, highlights, selected, time) {
  const a = pulse(time);
  const mark = (x, y, r, sel) => {
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fillStyle = sel ? 'rgba(110,255,160,0.6)' : `rgba(255,225,110,${a * 0.5})`;
    ctx.fill();
    ctx.strokeStyle = sel ? '#3fd97a' : `rgba(255,214,64,${a})`;
    ctx.lineWidth = Math.max(2, view.scale * 0.035);
    ctx.stroke();
  };

  for (const hid of highlights.hexes ?? []) {
    hexPath(ctx, view, hid, 0.92);
    ctx.fillStyle = `rgba(255,225,110,${a * 0.22})`;
    ctx.fill();
    ctx.strokeStyle = `rgba(255,214,64,${a})`;
    ctx.lineWidth = Math.max(2, view.scale * 0.04);
    ctx.stroke();
  }
  for (const eid of highlights.edges ?? []) {
    const e = LAYOUT.edges[eid];
    const [px, py] = toPixel(view, e.x, e.y);
    mark(px, py, view.scale * 0.12, false);
  }
  for (const vid of highlights.vertices ?? []) {
    const v = LAYOUT.vertices[vid];
    const [px, py] = toPixel(view, v.x, v.y);
    mark(px, py, view.scale * 0.14, false);
  }
  if (selected) {
    if (selected.vertexId) {
      const v = LAYOUT.vertices[selected.vertexId];
      const [px, py] = toPixel(view, v.x, v.y);
      mark(px, py, view.scale * 0.16, true);
    }
    if (selected.edgeId) {
      const e = LAYOUT.edges[selected.edgeId];
      const [px, py] = toPixel(view, e.x, e.y);
      mark(px, py, view.scale * 0.14, true);
    }
    if (selected.hexId) {
      hexPath(ctx, view, selected.hexId, 0.92);
      ctx.strokeStyle = '#3fd97a';
      ctx.lineWidth = Math.max(2.5, view.scale * 0.05);
      ctx.stroke();
    }
  }
}

// メイン描画。time はパルスアニメーション用(ms)。
export function drawBoard(ctx, width, height, state, ui, time = 0) {
  const dpr = window.devicePixelRatio || 1;
  const view = computeView(width, height);

  const staticLayer = getStaticLayer(state, width, height, dpr);
  ctx.drawImage(staticLayer, 0, 0, width, height);

  drawRobber(ctx, view, state.board.robber);

  for (const [eid, road] of Object.entries(state.roads)) {
    drawRoad(ctx, view, eid, road.player);
  }
  for (const eid of ui.pendingEdges ?? []) {
    drawRoad(ctx, view, eid, 0, 0.55);
  }
  for (const [vid, b] of Object.entries(state.buildings)) {
    drawBuilding(ctx, view, vid, b.player, b.type);
  }

  drawHighlights(ctx, view, ui.highlights ?? {}, ui.selected, time);
  return view;
}
