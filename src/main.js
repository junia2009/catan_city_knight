// 起動・ゲームループ・入力モード管理(設計書 §2, §8)
// 人間の入力も CPU も、同じ dispatch(action) を通る。

import { createGame, RESOURCES } from './state.js';
import { dispatch, validateAction } from './actions.js';
import { chooseAction } from './ai/cpu-player.js';
import { stealableTargets } from './rules/robber.js';
import {
  legalCityVertices,
  legalRoadEdges,
  legalRobberHexes,
  legalSettlementVertices,
  legalSetupEdges,
} from './ai/legal-moves.js';
import { drawBoard } from './render/board-render.js';
import { renderHUD } from './render/hud-render.js';
import { pickEdge, pickHex, pickVertex } from './input.js';

const HUMAN = 0;
const canvas = document.getElementById('board');
const ctx = canvas.getContext('2d');

let state = null;
let ui = null;
let view = null;
let cpuTimer = null;

function freshUi() {
  return {
    mode: 'idle',
    pending: null, // { vertexId } | { edgeId } | { hexId }
    pendingVertex: null, // 初期配置で選んだ開拓地
    pendingEdges: [], // 街道建設カード
    dialog: null,
    toast: null,
    highlights: {},
    selected: null,
  };
}

function newGame() {
  const playerCount = Number(document.getElementById('cpu-count').value) + 1;
  const seedInput = document.getElementById('seed').value.trim();
  const seed = seedInput ? Number(seedInput) >>> 0 : (Date.now() % 0x7fffffff) || 1;
  document.getElementById('seed').value = String(seed);
  clearTimeout(cpuTimer);
  state = createGame({ seed, playerCount, humanIndex: HUMAN });
  ui = freshUi();
  refresh();
  scheduleCpu();
}

// ---- UI 状態と GameState の同期 ----

function syncUi() {
  const aw = state.awaiting;
  const forced = ['setup-settlement', 'setup-road', 'move-robber'].includes(ui.mode);

  if (state.phase === 'ended') {
    ui.mode = 'idle';
    ui.pending = null;
    if (ui.dialog?.type !== 'winner') ui.dialog = { type: 'winner' };
    return;
  }

  if (aw?.players.includes(HUMAN)) {
    if (aw.type === 'setupPlacement' && !['setup-settlement', 'setup-road'].includes(ui.mode)) {
      ui.mode = 'setup-settlement';
      ui.pending = null;
      ui.pendingVertex = null;
    }
    if (aw.type === 'moveRobber' && ui.mode !== 'move-robber') {
      ui.mode = 'move-robber';
      ui.pending = null;
    }
    if (aw.type === 'discard' && ui.dialog?.type !== 'discard') {
      ui.dialog = {
        type: 'discard',
        counts: { wood: 0, brick: 0, sheep: 0, wheat: 0, ore: 0 },
      };
    }
  } else {
    if (forced) {
      ui.mode = 'idle';
      ui.pending = null;
      ui.pendingVertex = null;
    }
    if (['discard', 'steal'].includes(ui.dialog?.type)) ui.dialog = null;
  }
}

function computeHighlights() {
  const m = ui.mode;
  if (m === 'setup-settlement') {
    return { vertices: legalSettlementVertices(state, HUMAN, { needRoad: false }) };
  }
  if (m === 'setup-road' && ui.pendingVertex) {
    return { edges: legalSetupEdges(state, ui.pendingVertex) };
  }
  if (m === 'build-road') return { edges: legalRoadEdges(state, HUMAN) };
  if (m === 'build-settlement') return { vertices: legalSettlementVertices(state, HUMAN) };
  if (m === 'build-city') return { vertices: legalCityVertices(state, HUMAN) };
  if (m === 'move-robber') return { hexes: legalRobberHexes(state) };
  if (m === 'play-road-building') {
    const extra = {};
    for (const e of ui.pendingEdges) extra[e] = true;
    return { edges: legalRoadEdges(state, HUMAN, { extraRoads: extra }) };
  }
  return {};
}

function refresh() {
  syncUi();
  ui.highlights = computeHighlights();
  ui.selected = ui.pending ?? (ui.pendingVertex ? { vertexId: ui.pendingVertex } : null);
  resizeCanvas();
  view = drawBoard(ctx, canvas.clientWidth, canvas.clientHeight, state, ui);
  renderHUD(state, ui);
}

function resizeCanvas() {
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth;
  const h = canvas.clientHeight;
  if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
  }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
}

// ---- アクション実行 ----

function doAction(action) {
  ui.toast = null;
  try {
    state = dispatch(state, action);
  } catch (e) {
    ui.toast = e.message;
    refresh();
    return false;
  }
  ui.mode = 'idle';
  ui.pending = null;
  ui.pendingVertex = null;
  ui.pendingEdges = [];
  ui.dialog = null;
  refresh();
  scheduleCpu();
  return true;
}

// ---- CPU 駆動(設計書 §7.5) ----

function actingCpu() {
  if (state.phase === 'ended') return null;
  if (state.awaiting) {
    return state.awaiting.players.find((p) => state.players[p].isCPU) ?? null;
  }
  const cur = state.currentPlayer;
  return state.players[cur].isCPU ? cur : null;
}

function scheduleCpu() {
  clearTimeout(cpuTimer);
  const pid = actingCpu();
  if (pid == null) return;
  const delay = state.awaiting ? 300 : state.phase === 'setup' ? 450 : 550;
  cpuTimer = setTimeout(() => {
    const action = chooseAction(state, pid);
    if (!action) return;
    try {
      state = dispatch(state, action);
    } catch (e) {
      // CPU の手が通らない場合は安全側でターン終了を試みる
      console.error('CPU action failed:', e.message, action);
      try {
        state = dispatch(state, { type: 'END_TURN', player: pid });
      } catch {
        return;
      }
    }
    refresh();
    scheduleCpu();
  }, delay);
}

// ---- 盤面クリック ----

canvas.addEventListener('click', (e) => {
  if (!state || !view) return;
  const rect = canvas.getBoundingClientRect();
  const px = e.clientX - rect.left;
  const py = e.clientY - rect.top;
  const m = ui.mode;
  ui.toast = null;

  if (m === 'setup-settlement') {
    const vid = pickVertex(view, px, py, ui.highlights.vertices ?? []);
    if (vid) {
      ui.pendingVertex = vid;
      ui.mode = 'setup-road';
    }
  } else if (m === 'setup-road') {
    const eid = pickEdge(view, px, py, ui.highlights.edges ?? []);
    if (eid) ui.pending = { edgeId: eid };
  } else if (m === 'build-road') {
    const eid = pickEdge(view, px, py, ui.highlights.edges ?? []);
    if (eid) ui.pending = { edgeId: eid };
  } else if (m === 'build-settlement' || m === 'build-city') {
    const vid = pickVertex(view, px, py, ui.highlights.vertices ?? []);
    if (vid) ui.pending = { vertexId: vid };
  } else if (m === 'move-robber') {
    const hid = pickHex(view, px, py, ui.highlights.hexes ?? []);
    if (hid) {
      const targets = stealableTargets(state, hid, HUMAN);
      if (targets.length > 0) {
        ui.pending = null;
        ui.dialog = { type: 'steal', hexId: hid, targets };
      } else {
        ui.pending = { hexId: hid };
      }
    }
  } else if (m === 'play-road-building') {
    const eid = pickEdge(view, px, py, ui.highlights.edges ?? []);
    if (eid && ui.pendingEdges.length < 2) ui.pendingEdges.push(eid);
  }
  refresh();
});

// ---- 確定/キャンセル ----

function confirmPending() {
  const m = ui.mode;
  if (m === 'setup-road' && ui.pendingVertex && ui.pending?.edgeId) {
    doAction({
      type: 'PLACE_INITIAL',
      player: HUMAN,
      vertexId: ui.pendingVertex,
      edgeId: ui.pending.edgeId,
    });
  } else if (m === 'build-road' && ui.pending?.edgeId) {
    doAction({ type: 'BUILD_ROAD', player: HUMAN, edgeId: ui.pending.edgeId });
  } else if (m === 'build-settlement' && ui.pending?.vertexId) {
    doAction({ type: 'BUILD_SETTLEMENT', player: HUMAN, vertexId: ui.pending.vertexId });
  } else if (m === 'build-city' && ui.pending?.vertexId) {
    doAction({ type: 'BUILD_CITY', player: HUMAN, vertexId: ui.pending.vertexId });
  } else if (m === 'move-robber' && ui.pending?.hexId) {
    doAction({ type: 'MOVE_ROBBER', player: HUMAN, hexId: ui.pending.hexId, targetPlayer: null });
  } else if (m === 'play-road-building' && ui.pendingEdges.length >= 1) {
    doAction({
      type: 'PLAY_DEV_CARD',
      player: HUMAN,
      card: 'roadBuilding',
      params: { edges: [...ui.pendingEdges] },
    });
  }
}

function cancelMode() {
  if (ui.mode === 'setup-road') {
    ui.mode = 'setup-settlement';
    ui.pendingVertex = null;
    ui.pending = null;
  } else if (['build-road', 'build-settlement', 'build-city', 'play-road-building'].includes(ui.mode)) {
    ui.mode = 'idle';
    ui.pending = null;
    ui.pendingEdges = [];
  }
  refresh();
}

// ---- HUD クリック(data-act 委譲) ----

document.addEventListener('click', (e) => {
  const target = e.target.closest('[data-act]');
  if (!target || target.disabled || !state) return;
  const [act, arg] = target.dataset.act.split(':');
  ui.toast = null;

  switch (act) {
    case 'new-game': newGame(); return;
    case 'roll': doAction({ type: 'ROLL_DICE', player: HUMAN }); return;
    case 'end-turn': doAction({ type: 'END_TURN', player: HUMAN }); return;
    case 'buy-dev': doAction({ type: 'BUY_DEV_CARD', player: HUMAN }); return;
    case 'confirm': confirmPending(); return;
    case 'cancel': cancelMode(); return;

    case 'mode': {
      ui.mode = `build-${arg}`;
      ui.pending = null;
      refresh();
      return;
    }

    case 'play-dev': {
      if (arg === 'knight') {
        doAction({ type: 'PLAY_DEV_CARD', player: HUMAN, card: 'knight' });
      } else if (arg === 'roadBuilding') {
        const err = validateAction(state, {
          type: 'PLAY_DEV_CARD', player: HUMAN, card: 'roadBuilding',
          params: { edges: [legalRoadEdges(state, HUMAN)[0]].filter(Boolean) },
        });
        if (err) { ui.toast = err; refresh(); return; }
        ui.mode = 'play-road-building';
        ui.pendingEdges = [];
        refresh();
      } else if (arg === 'yearOfPlenty') {
        ui.dialog = { type: 'yop', picks: [] };
        refresh();
      } else if (arg === 'monopoly') {
        ui.dialog = { type: 'monopoly' };
        refresh();
      }
      return;
    }

    case 'trade-open': ui.dialog = { type: 'trade', give: null, receive: null }; refresh(); return;
    case 'trade-give': ui.dialog.give = arg; if (ui.dialog.receive === arg) ui.dialog.receive = null; refresh(); return;
    case 'trade-receive': ui.dialog.receive = arg; refresh(); return;
    case 'trade-confirm':
      doAction({ type: 'TRADE_BANK', player: HUMAN, give: ui.dialog.give, receive: ui.dialog.receive });
      return;

    case 'discard-plus': ui.dialog.counts[arg]++; refresh(); return;
    case 'discard-minus': ui.dialog.counts[arg]--; refresh(); return;
    case 'discard-confirm':
      doAction({ type: 'DISCARD', player: HUMAN, resources: { ...ui.dialog.counts } });
      return;

    case 'steal':
      doAction({
        type: 'MOVE_ROBBER', player: HUMAN,
        hexId: ui.dialog.hexId, targetPlayer: Number(arg),
      });
      return;

    case 'mono':
      doAction({ type: 'PLAY_DEV_CARD', player: HUMAN, card: 'monopoly', params: { resource: arg } });
      return;

    case 'yop':
      ui.dialog.picks.push(arg);
      refresh();
      return;
    case 'yop-confirm':
      doAction({
        type: 'PLAY_DEV_CARD', player: HUMAN, card: 'yearOfPlenty',
        params: { resources: [...ui.dialog.picks] },
      });
      return;

    case 'dialog-cancel': ui.dialog = null; refresh(); return;
  }
});

window.addEventListener('resize', () => state && refresh());

// デバッグ・テスト用フック(シード制御と合わせて再現検証に使う)
window.catanDebug = {
  getState: () => state,
  setState: (s) => { state = s; refresh(); scheduleCpu(); },
  doAction,
};

newGame();
