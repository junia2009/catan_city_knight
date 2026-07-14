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
import { LAYOUT } from './rules/board.js';
import { razableCities } from './rules/cak/barbarians.js';
import { PROGRESS_CARDS } from './rules/cak/progress-cards.js';
import { drawBoard } from './render/board-render.js';
import { renderHUD, RES_ICON } from './render/hud-render.js';
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
    knightFrom: null, // 騎士の移動元
    progIndex: null, // 使用中の進歩カード
    dialog: null,
    toast: null,
    highlights: {},
    selected: null,
  };
}

function newGame() {
  const playerCount = Number(document.getElementById('cpu-count').value) + 1;
  const mode = document.getElementById('mode').value;
  const seedInput = document.getElementById('seed').value.trim();
  const seed = seedInput ? Number(seedInput) >>> 0 : (Date.now() % 0x7fffffff) || 1;
  document.getElementById('seed').value = String(seed);
  clearTimeout(cpuTimer);
  state = createGame({ seed, playerCount, humanIndex: HUMAN, mode });
  ui = freshUi();
  refresh();
  scheduleCpu();
}

// ---- UI 状態と GameState の同期 ----

function syncUi() {
  const aw = state.awaiting;
  const forced = ['setup-settlement', 'setup-road', 'move-robber', 'raze-city'].includes(ui.mode);

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
    if (aw.type === 'barbarianDefense' && ui.mode !== 'raze-city') {
      ui.mode = 'raze-city';
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
  // ---- 都市と騎士 ----
  if (m === 'build-knight') {
    return {
      vertices: Object.keys(LAYOUT.vertices).filter(
        (v) => validateAction(state, { type: 'BUILD_KNIGHT', player: HUMAN, vertexId: v }) === null,
      ),
    };
  }
  if (m === 'build-wall') {
    return {
      vertices: Object.keys(state.buildings).filter(
        (v) => validateAction(state, { type: 'BUILD_WALL', player: HUMAN, vertexId: v }) === null,
      ),
    };
  }
  if (m === 'move-knight' && ui.knightFrom) {
    return {
      vertices: Object.keys(LAYOUT.vertices).filter(
        (v) =>
          validateAction(state, {
            type: 'MOVE_KNIGHT', player: HUMAN,
            fromVertexId: ui.knightFrom, toVertexId: v,
          }) === null,
      ),
    };
  }
  if (m === 'raze-city') return { vertices: razableCities(state, HUMAN) };
  if (m === 'play-bishop') return { hexes: legalRobberHexes(state) };
  return {};
}

// ハイライト表示中はパルスアニメーションのため毎フレーム再描画する
let animId = null;

function hasPulse() {
  const h = ui.highlights;
  return (
    !!(h && (h.vertices?.length || h.edges?.length || h.hexes?.length)) || !!ui.selected
  );
}

function renderBoard(time = performance.now()) {
  resizeCanvas();
  view = drawBoard(ctx, canvas.clientWidth, canvas.clientHeight, state, ui, time);
}

function animLoop(time) {
  renderBoard(time);
  animId = hasPulse() ? requestAnimationFrame(animLoop) : null;
}

function refresh() {
  syncUi();
  ui.highlights = computeHighlights();
  ui.selected = ui.pending ?? (ui.pendingVertex ? { vertexId: ui.pendingVertex } : null);
  renderBoard();
  renderHUD(state, ui);
  if (hasPulse()) {
    if (animId == null) animId = requestAnimationFrame(animLoop);
  } else if (animId != null) {
    cancelAnimationFrame(animId);
    animId = null;
  }
}

// 資源獲得のフローティング表示(ロール後)
function showGainFx(before) {
  const fxEl = document.getElementById('fx');
  let row = 0;
  for (const p of state.players) {
    const gains = RESOURCES.filter((r) => p.resources[r] > before[p.id][r]).map(
      (r) => `${RES_ICON[r]}+${p.resources[r] - before[p.id][r]}`,
    );
    if (!gains.length) continue;
    const div = document.createElement('div');
    div.className = 'gain';
    div.textContent = `${p.name} ${gains.join(' ')}`;
    div.style.left = 'calc(50% - 80px)';
    div.style.top = `${34 + row * 36}px`;
    fxEl.appendChild(div);
    setTimeout(() => div.remove(), 1700);
    row++;
  }
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
  const before =
    action.type === 'ROLL_DICE' ? state.players.map((p) => ({ ...p.resources })) : null;
  try {
    state = dispatch(state, action);
  } catch (e) {
    ui.toast = e.message;
    refresh();
    return false;
  }
  if (before) showGainFx(before);
  ui.mode = 'idle';
  ui.pending = null;
  ui.pendingVertex = null;
  ui.pendingEdges = [];
  ui.knightFrom = null;
  ui.progIndex = null;
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
    const before =
      action.type === 'ROLL_DICE' ? state.players.map((p) => ({ ...p.resources })) : null;
    try {
      state = dispatch(state, action);
      if (before) showGainFx(before);
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
  } else if (['build-knight', 'build-wall', 'move-knight', 'raze-city'].includes(m)) {
    const vid = pickVertex(view, px, py, ui.highlights.vertices ?? []);
    if (vid) ui.pending = { vertexId: vid };
  } else if (m === 'play-bishop') {
    const hid = pickHex(view, px, py, ui.highlights.hexes ?? []);
    if (hid) ui.pending = { hexId: hid };
  } else if (m === 'idle' && state.mode === 'cak') {
    // 自分の騎士をクリック → 行動メニュー
    const myKnights = Object.keys(state.knights).filter(
      (v) => state.knights[v].player === HUMAN,
    );
    const vid = pickVertex(view, px, py, myKnights);
    if (vid && state.currentPlayer === HUMAN && !state.awaiting && state.turnFlags.rolled) {
      ui.dialog = { type: 'knight', vertexId: vid };
    }
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
  } else if (m === 'build-knight' && ui.pending?.vertexId) {
    doAction({ type: 'BUILD_KNIGHT', player: HUMAN, vertexId: ui.pending.vertexId });
  } else if (m === 'build-wall' && ui.pending?.vertexId) {
    doAction({ type: 'BUILD_WALL', player: HUMAN, vertexId: ui.pending.vertexId });
  } else if (m === 'move-knight' && ui.knightFrom && ui.pending?.vertexId) {
    doAction({
      type: 'MOVE_KNIGHT', player: HUMAN,
      fromVertexId: ui.knightFrom, toVertexId: ui.pending.vertexId,
    });
  } else if (m === 'raze-city' && ui.pending?.vertexId) {
    doAction({ type: 'RAZE_CITY', player: HUMAN, vertexId: ui.pending.vertexId });
  } else if (m === 'play-bishop' && ui.pending?.hexId && ui.progIndex != null) {
    doAction({
      type: 'PLAY_PROGRESS_CARD', player: HUMAN,
      index: ui.progIndex, params: { hexId: ui.pending.hexId },
    });
  }
}

function cancelMode() {
  if (ui.mode === 'setup-road') {
    ui.mode = 'setup-settlement';
    ui.pendingVertex = null;
    ui.pending = null;
  } else if ([
    'build-road', 'build-settlement', 'build-city', 'play-road-building',
    'build-knight', 'build-wall', 'move-knight', 'play-bishop',
  ].includes(ui.mode)) {
    ui.mode = 'idle';
    ui.pending = null;
    ui.pendingEdges = [];
    ui.knightFrom = null;
    ui.progIndex = null;
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

    // ---- 都市と騎士 ----

    case 'improve-open': ui.dialog = { type: 'improve' }; refresh(); return;
    case 'improve-buy': {
      const before = { ...ui.dialog };
      if (doAction({ type: 'BUY_IMPROVEMENT', player: HUMAN, track: arg })) {
        ui.dialog = before; // 続けて改良できるようダイアログを保持
        refresh();
      }
      return;
    }

    case 'knight-activate':
      doAction({ type: 'ACTIVATE_KNIGHT', player: HUMAN, vertexId: arg });
      return;
    case 'knight-promote':
      doAction({ type: 'PROMOTE_KNIGHT', player: HUMAN, vertexId: arg });
      return;
    case 'knight-move':
      ui.dialog = null;
      ui.mode = 'move-knight';
      ui.knightFrom = arg;
      ui.pending = null;
      refresh();
      return;
    case 'knight-chase':
      doAction({ type: 'CHASE_ROBBER', player: HUMAN, vertexId: arg });
      return;

    case 'play-prog': {
      const index = Number(arg);
      const card = state.players[HUMAN].progressCards[index];
      if (!card) return;
      const def = PROGRESS_CARDS[card.id];
      if (def.needsParams === 'resources2') {
        ui.dialog = { type: 'prog-harvest', picks: [], index };
        refresh();
      } else if (def.needsParams === 'commodity') {
        ui.dialog = { type: 'prog-commodity', index };
        refresh();
      } else if (def.needsParams === 'hex') {
        ui.mode = 'play-bishop';
        ui.progIndex = index;
        ui.pending = null;
        refresh();
      } else {
        doAction({ type: 'PLAY_PROGRESS_CARD', player: HUMAN, index, params: null });
      }
      return;
    }

    case 'ph':
      ui.dialog.picks.push(arg);
      refresh();
      return;
    case 'ph-confirm':
      doAction({
        type: 'PLAY_PROGRESS_CARD', player: HUMAN,
        index: ui.dialog.index, params: { resources: [...ui.dialog.picks] },
      });
      return;
    case 'pc':
      doAction({
        type: 'PLAY_PROGRESS_CARD', player: HUMAN,
        index: ui.dialog.index, params: { commodity: arg },
      });
      return;
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
