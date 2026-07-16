// 起動・ゲームループ・入力モード管理(設計書 §2, §8)
// 人間の入力も CPU も、同じ dispatch(action) を通る。

import { createGame, RESOURCES } from './state.js';
import { dispatch, validateAction } from './actions.js';
import { chooseAction, cpuAcceptsTrade } from './ai/cpu-player.js';
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
import { renderHUD, RES_ICON, COM_ICON } from './render/hud-render.js';
import { rulesHtml } from './render/rules-content.js';
import { pickEdge, pickHex, pickVertex } from './input.js';

const HUMAN = 0;
const canvas = document.getElementById('board');
const ctx = canvas.getContext('2d');
const board3dWrap = document.getElementById('board3d');

let state = null;
let ui = null;
let view = null;
let cpuTimer = null;
let viewMode = '3d'; // '2d' | '3d'
let renderer3d = null;
let renderer3dFailed = false;

// 設定(⚙️シートから編集。新しいゲーム開始時に反映)
const settings = { view: '3d', mode: 'cak', cpuCount: 3, seed: '', difficulty: 'normal' };

// 画面フロー: title(タイトル) → select(ルール選択) → game(ゲーム)
let screen = 'title';

function setScreen(s) {
  screen = s;
  document.body.dataset.screen = s;
  if (ui) refresh();
}

// ルール選択画面の描画(settings と連動)
function renderSelectPanel() {
  const panel = document.getElementById('select-panel');
  if (!panel || screen !== 'select') return;
  const seg = (act, options, current) =>
    `<div class="seg">${options
      .map(([v, label]) => `<button class="${current === v ? 'sel' : ''}" data-act="${act}:${v}">${label}</button>`)
      .join('')}</div>`;
  panel.innerHTML = `
    <h3>⬡ ゲーム設定</h3>
    <div class="srow"><span>ルール</span>${seg('set-mode', [['cak', '都市と騎士'], ['base', '基本']], settings.mode)}</div>
    <div class="srow"><span>CPU</span>${seg('set-cpu', [['2', '2体'], ['3', '3体']], String(settings.cpuCount))}</div>
    <div class="srow"><span>強さ</span>${seg('set-diff', [['easy', '弱い'], ['normal', '普通'], ['hard', '強い']], settings.difficulty)}</div>
    <div class="srow"><span>シード</span><input id="seed-input" inputmode="numeric" placeholder="空欄でランダム" value="${settings.seed}"></div>
    <div class="row end">
      <button data-act="goto-title">← タイトル</button>
      <button class="primary" data-act="start-game">ゲーム開始</button>
    </div>`;
}

// 説明書画面(タイトルから遷移)
let rulesTab = 'basic';
function renderRulesPanel() {
  const panel = document.getElementById('rules-panel');
  if (!panel || screen !== 'rules') return;
  panel.innerHTML = `<h3>📖 あそびかた</h3>${rulesHtml(rulesTab)}
    <div class="row end rules-close"><button class="primary" data-act="rules-back">← タイトルへ</button></div>`;
}

// モバイル判定: レイアウトを body.mobile で切り替える
const mobileQuery = window.matchMedia('(max-width: 820px)');
function updateMobileClass() {
  document.body.classList.toggle('mobile', mobileQuery.matches);
}
mobileQuery.addEventListener('change', () => {
  updateMobileClass();
  if (state) refresh();
});
updateMobileClass();

function isMobile() {
  return document.body.classList.contains('mobile');
}

function freshUi() {
  return {
    mode: 'idle',
    pending: null, // { vertexId } | { edgeId } | { hexId }
    pendingVertex: null, // 初期配置で選んだ開拓地
    pendingEdges: [], // 街道建設カード
    pendingHexes: [], // 発明家(数字トークン交換)
    knightFrom: null, // 騎士の移動元
    progIndex: null, // 使用中の進歩カード
    dialog: null,
    toast: null,
    highlights: {},
    selected: null,
    expandedPlayer: null, // モバイルのプレイヤーチップ展開
  };
}

function newGame() {
  const seedInput = String(settings.seed ?? '').trim();
  const seed = seedInput ? Number(seedInput) >>> 0 : (Date.now() % 0x7fffffff) || 1;
  settings.seed = String(seed);
  clearTimeout(cpuTimer);
  state = createGame({
    seed,
    playerCount: Number(settings.cpuCount) + 1,
    humanIndex: HUMAN,
    mode: settings.mode,
    difficulty: settings.difficulty,
  });
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
    if (aw.type === 'tradeOffer' && ui.dialog?.type !== 'tradeOffer') {
      ui.dialog = { type: 'tradeOffer' };
    }
  } else {
    if (forced) {
      ui.mode = 'idle';
      ui.pending = null;
      ui.pendingVertex = null;
    }
    if (['discard', 'steal', 'tradeOffer'].includes(ui.dialog?.type)) ui.dialog = null;
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

  // ---- 進歩カード(対象を validate 総当たりでハイライト)----
  const progAct = (params) =>
    ({ type: 'PLAY_PROGRESS_CARD', player: HUMAN, index: ui.progIndex, params });
  if (m === 'prog-hex') {
    return {
      hexes: LAYOUT.hexIds.filter((h) => validateAction(state, progAct({ hexId: h })) === null),
    };
  }
  if (m === 'prog-vertex') {
    return {
      vertices: Object.keys(LAYOUT.vertices).filter(
        (v) => validateAction(state, progAct({ vertexId: v })) === null,
      ),
    };
  }
  if (m === 'prog-edge') {
    return {
      edges: Object.keys(state.roads).filter(
        (e) => validateAction(state, progAct({ edgeId: e })) === null,
      ),
    };
  }
  if (m === 'prog-hex2') {
    if (ui.pendingHexes.length === 0) {
      return {
        hexes: LAYOUT.hexIds.filter((h) => {
          const t = state.board.hexes[h].token;
          return t && ![2, 6, 8, 12].includes(t);
        }),
      };
    }
    return {
      hexes: LAYOUT.hexIds.filter(
        (h) => validateAction(state, progAct({ a: ui.pendingHexes[0], b: h })) === null,
      ),
    };
  }
  if (m === 'prog-roads') {
    const extra = {};
    for (const e of ui.pendingEdges) extra[e] = true;
    return { edges: legalRoadEdges(state, HUMAN, { extraRoads: extra }) };
  }
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
  if (canvas.clientWidth === 0 || canvas.clientHeight === 0) return; // 非表示中は描かない
  resizeCanvas();
  view = drawBoard(ctx, canvas.clientWidth, canvas.clientHeight, state, ui, time);
}

function animLoop(time) {
  renderBoard(time);
  animId = hasPulse() ? requestAnimationFrame(animLoop) : null;
}

// 3D レンダラーは必要になったときに読み込む。
// 読み込み失敗・ハング(8秒)時は 2D にフォールバックして操作不能を防ぐ。
let renderer3dLoading = null;

async function ensureRenderer3d() {
  if (renderer3d || renderer3dFailed) return renderer3d;
  if (renderer3dLoading) return renderer3dLoading;
  renderer3dLoading = (async () => {
    try {
      const mod = await Promise.race([
        import('./render3d/board3d.js'),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error('3D読み込みタイムアウト')), 8000),
        ),
      ]);
      renderer3d = new mod.Board3D(board3dWrap);
      attach3dInput();
    } catch (e) {
      console.error('3D初期化に失敗:', e);
      renderer3dFailed = true;
      viewMode = '2d';
      settings.view = '2d';
    } finally {
      renderer3dLoading = null;
      if (ui) refresh();
    }
    return renderer3d;
  })();
  return renderer3dLoading;
}

function applyViewMode() {
  const want3d = viewMode === '3d' && !renderer3dFailed;
  const is3d = want3d && renderer3d;
  // 3D読み込み待ちの間も2D盤面は出さない(2D→3Dのちらつき防止)
  canvas.style.display = want3d ? 'none' : 'block';
  board3dWrap.style.display = is3d ? 'block' : 'none';
  if (is3d) {
    requestAnimationFrame(() => board3dWrap.classList.add('on')); // フェードイン
    renderer3d.onResize();
  } else {
    board3dWrap.classList.remove('on');
  }
  document.getElementById('view-reset').style.display = is3d ? 'block' : 'none';
}

function refresh() {
  syncUi();
  if (screen !== 'game') {
    // タイトル/選択画面中はダイアログ・入力モードを持ち込まない
    ui.dialog = null;
    ui.mode = 'idle';
    ui.pending = null;
    ui.highlights = {};
  }
  renderSelectPanel();
  renderRulesPanel();
  // タイトル画面の読み込み状態表示
  const note = document.getElementById('load-note');
  if (note) {
    if (viewMode === '3d' && !renderer3d && !renderer3dFailed) {
      note.textContent = '島を読み込んでいます…';
      note.classList.add('pulse');
    } else if (renderer3dFailed) {
      note.textContent = '3Dを読み込めなかったため2D表示で動作します(設定で再試行できます)';
      note.classList.remove('pulse');
    } else {
      note.textContent = '';
      note.classList.remove('pulse');
    }
  }
  ui.highlights = screen === 'game' ? computeHighlights() : {};
  ui.selected = ui.pending ?? (ui.pendingVertex ? { vertexId: ui.pendingVertex } : null);
  applyViewMode();
  if (viewMode === '3d' && renderer3d) {
    if (animId != null) {
      cancelAnimationFrame(animId);
      animId = null;
    }
    renderer3d.update(state, ui);
  } else {
    renderBoard();
    if (hasPulse()) {
      if (animId == null) animId = requestAnimationFrame(animLoop);
    } else if (animId != null) {
      cancelAnimationFrame(animId);
      animId = null;
    }
  }
  renderHUD(state, ui);
}

// 資源獲得のフローティング表示(ロール後)
function showGainFx(before) {
  const fxEl = document.getElementById('fx');
  const topBase = isMobile() ? Math.round(window.innerHeight * 0.24) : 34;
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
    div.style.top = `${topBase + row * 34}px`;
    fxEl.appendChild(div);
    setTimeout(() => div.remove(), 1700);
    row++;
  }
}

// 2D表示時のダイスロール演出(3Dは物理ダイスがあるのでDOM版は2D専用)
const PIP_FX = {
  1: [4], 2: [0, 8], 3: [0, 4, 8], 4: [0, 2, 6, 8], 5: [0, 2, 4, 6, 8], 6: [0, 2, 3, 5, 6, 8],
};
const EV_FX = { ship: '⛵', trade: '🧵', politics: '🪙', science: '📜' };

function showDiceRollFx(dice, eventDie) {
  const fxEl = document.getElementById('fx');
  fxEl.querySelector('.rollfx')?.remove(); // 連続ロールは前の演出を破棄
  const wrap = document.createElement('div');
  wrap.className = 'rollfx';
  const pips = (n) =>
    Array.from({ length: 9 }, (_, i) => `<i class="${PIP_FX[n].includes(i) ? 'on' : ''}"></i>`).join('');
  const cak = state.mode === 'cak';
  wrap.innerHTML = `
    <span class="rdie ${cak ? 'rdie-red' : ''}">${pips(dice[0])}</span>
    <span class="rdie ${cak ? 'rdie-yellow' : ''}">${pips(dice[1])}</span>
    ${eventDie ? `<span class="rdie rdie-ev">${EV_FX[eventDie]}</span>` : ''}`;
  fxEl.appendChild(wrap);

  // 転がっている間はランダムな目をパラパラ切り替え、着地で本当の目を見せる
  const dies = wrap.querySelectorAll('.rdie:not(.rdie-ev)');
  const evEl = wrap.querySelector('.rdie-ev');
  const shuffle = setInterval(() => {
    for (const d of dies) d.innerHTML = pips(1 + Math.floor(Math.random() * 6));
    if (evEl) evEl.textContent = Object.values(EV_FX)[Math.floor(Math.random() * 4)];
  }, 90);
  setTimeout(() => {
    clearInterval(shuffle);
    dies[0].innerHTML = pips(dice[0]);
    dies[1].innerHTML = pips(dice[1]);
    if (evEl) evEl.textContent = EV_FX[eventDie];
    wrap.classList.add('land');
  }, 620);
  setTimeout(() => wrap.classList.add('out'), 1750);
  setTimeout(() => wrap.remove(), 2100);
}

// ロール後の演出: 3Dは物理ダイス、2DはDOMダイス
function rollFx() {
  if (!state.dice) return;
  if (viewMode === '3d' && renderer3d) {
    renderer3d.rollDice(state.dice, state.mode === 'cak' ? state.eventDie : null);
  } else {
    showDiceRollFx(state.dice, state.mode === 'cak' ? state.eventDie : null);
  }
}

// 交易成立の目立つバナー(誰が何を渡し何を得たか)
function showTradeFx(aName, bName, give, receive) {
  const fxEl = document.getElementById('fx');
  const items = (obj) =>
    Object.entries(obj)
      .map(([r, n]) => `${RES_ICON[r] ?? COM_ICON[r]}×${n}`)
      .join(' ');
  const div = document.createElement('div');
  div.className = 'tradefx';
  div.innerHTML = `
    <div class="tf-title">🤝 交易成立!</div>
    <div class="tf-line"><b>${aName}</b><span class="tf-items">${items(give)}</span><span class="tf-arrow">➜</span><b>${bName}</b></div>
    <div class="tf-line"><b>${aName}</b><span class="tf-arrow">⬅</span><span class="tf-items">${items(receive)}</span><b>${bName}</b></div>`;
  fxEl.appendChild(div);
  setTimeout(() => div.classList.add('out'), 2100);
  setTimeout(() => div.remove(), 2600);
}

// 成立した交易アクションならバナーを出す(人間・CPUどちらの取引でも)
function maybeTradeFx(action, prevAwaiting) {
  if (action.type === 'TRADE_PLAYERS') {
    showTradeFx(
      state.players[action.player].name, state.players[action.partner].name,
      action.give, action.receive,
    );
  } else if (action.type === 'RESPOND_TRADE' && action.accept) {
    const ctx = prevAwaiting?.type === 'tradeOffer' ? prevAwaiting.context : null;
    if (ctx) {
      showTradeFx(
        state.players[ctx.from].name, state.players[action.player].name,
        ctx.give, ctx.receive,
      );
    }
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

// 進歩カードの使用開始: パラメータ種別に応じて盤面選択モードかダイアログへ
function startProgressPlay(index) {
  const card = state.players[HUMAN].progressCards[index];
  if (!card) return;
  const def = PROGRESS_CARDS[card.id];
  const boardMode = {
    hex: 'prog-hex', vertex: 'prog-vertex', edge: 'prog-edge',
    hex2: 'prog-hex2', edges: 'prog-roads',
  }[def.needsParams];
  if (boardMode) {
    ui.dialog = null;
    ui.mode = boardMode;
    ui.progIndex = index;
    ui.pending = null;
    ui.pendingHexes = [];
    ui.pendingEdges = [];
    refresh();
  } else if (def.needsParams === 'commodity') {
    ui.dialog = { type: 'prog-commodity', index };
    refresh();
  } else if (def.needsParams === 'resource') {
    ui.dialog = { type: 'prog-resource', index };
    refresh();
  } else if (def.needsParams === 'cardKey') {
    ui.dialog = { type: 'prog-cardkey', index };
    refresh();
  } else if (def.needsParams === 'player') {
    ui.dialog = { type: 'prog-player', index };
    refresh();
  } else if (def.needsParams === 'dice') {
    ui.dialog = { type: 'prog-dice', index, red: null, yellow: null };
    refresh();
  } else {
    doAction({ type: 'PLAY_PROGRESS_CARD', player: HUMAN, index, params: null });
  }
}

// ---- アクション実行 ----

function doAction(action) {
  ui.toast = null;
  const before =
    action.type === 'ROLL_DICE' ? state.players.map((p) => ({ ...p.resources })) : null;
  const prevAwaiting = state.awaiting;
  try {
    state = dispatch(state, action);
  } catch (e) {
    ui.toast = e.message;
    refresh();
    return false;
  }
  maybeTradeFx(action, prevAwaiting);
  if (before) {
    showGainFx(before);
    rollFx();
  }
  ui.mode = 'idle';
  ui.pending = null;
  ui.pendingVertex = null;
  ui.pendingEdges = [];
  ui.pendingHexes = [];
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
  if (screen !== 'game') return; // タイトル背景の盤面ではCPUを動かさない
  const pid = actingCpu();
  if (pid == null) return;
  const delay = state.awaiting ? 300 : state.phase === 'setup' ? 450 : 550;
  cpuTimer = setTimeout(() => {
    const action = chooseAction(state, pid);
    if (!action) return;
    const before =
      action.type === 'ROLL_DICE' ? state.players.map((p) => ({ ...p.resources })) : null;
    const prevAwaiting = state.awaiting;
    try {
      state = dispatch(state, action);
      maybeTradeFx(action, prevAwaiting);
      if (before) {
        showGainFx(before);
        rollFx();
      }
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

// 盤面クリックの共通処理。pick(kind, candidates) → id | null
// (2D は最近傍探索、3D はレイキャストで実装が差し替わる)
function boardClick(pick) {
  if (!state) return;
  const m = ui.mode;
  ui.toast = null;

  if (m === 'setup-settlement') {
    const vid = pick('vertex', ui.highlights.vertices ?? []);
    if (vid) {
      ui.pendingVertex = vid;
      ui.mode = 'setup-road';
    }
  } else if (m === 'setup-road' || m === 'build-road') {
    const eid = pick('edge', ui.highlights.edges ?? []);
    if (eid) ui.pending = { edgeId: eid };
  } else if (m === 'build-settlement' || m === 'build-city') {
    const vid = pick('vertex', ui.highlights.vertices ?? []);
    if (vid) ui.pending = { vertexId: vid };
  } else if (m === 'move-robber') {
    const hid = pick('hex', ui.highlights.hexes ?? []);
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
    const eid = pick('edge', ui.highlights.edges ?? []);
    if (eid && ui.pendingEdges.length < 2) ui.pendingEdges.push(eid);
  } else if (['build-knight', 'build-wall', 'move-knight', 'raze-city'].includes(m)) {
    const vid = pick('vertex', ui.highlights.vertices ?? []);
    if (vid) ui.pending = { vertexId: vid };
  } else if (m === 'prog-hex') {
    const hid = pick('hex', ui.highlights.hexes ?? []);
    if (hid) ui.pending = { hexId: hid };
  } else if (m === 'prog-vertex') {
    const vid = pick('vertex', ui.highlights.vertices ?? []);
    if (vid) ui.pending = { vertexId: vid };
  } else if (m === 'prog-edge') {
    const eid = pick('edge', ui.highlights.edges ?? []);
    if (eid) ui.pending = { edgeId: eid };
  } else if (m === 'prog-hex2') {
    const hid = pick('hex', ui.highlights.hexes ?? []);
    if (hid && ui.pendingHexes.length < 2 && !ui.pendingHexes.includes(hid)) {
      ui.pendingHexes.push(hid);
    }
  } else if (m === 'prog-roads') {
    const eid = pick('edge', ui.highlights.edges ?? []);
    if (eid && ui.pendingEdges.length < 2) ui.pendingEdges.push(eid);
  } else if (m === 'idle' && state.mode === 'cak') {
    // 自分の騎士をクリック → 行動メニュー
    const myKnights = Object.keys(state.knights).filter(
      (v) => state.knights[v].player === HUMAN,
    );
    const vid = pick('vertex', myKnights);
    if (vid && state.currentPlayer === HUMAN && !state.awaiting && state.turnFlags.rolled) {
      ui.dialog = { type: 'knight', vertexId: vid };
    }
  }
  refresh();
}

canvas.addEventListener('click', (e) => {
  if (!view) return;
  const rect = canvas.getBoundingClientRect();
  const px = e.clientX - rect.left;
  const py = e.clientY - rect.top;
  boardClick((kind, cands) => {
    if (kind === 'vertex') return pickVertex(view, px, py, cands);
    if (kind === 'edge') return pickEdge(view, px, py, cands);
    return pickHex(view, px, py, cands);
  });
});

// 3D: OrbitControls のドラッグとクリックを区別する
function attach3dInput() {
  const el = renderer3d.renderer.domElement;
  let downX = 0, downY = 0;
  el.addEventListener('pointerdown', (e) => {
    downX = e.clientX;
    downY = e.clientY;
  });
  el.addEventListener('click', (e) => {
    if (Math.hypot(e.clientX - downX, e.clientY - downY) > 6) return; // ドラッグは無視
    boardClick((kind, cands) => renderer3d.pick(kind, e.clientX, e.clientY, cands));
  });
}

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
  } else if (m === 'prog-hex' && ui.pending?.hexId && ui.progIndex != null) {
    doAction({
      type: 'PLAY_PROGRESS_CARD', player: HUMAN,
      index: ui.progIndex, params: { hexId: ui.pending.hexId },
    });
  } else if (m === 'prog-vertex' && ui.pending?.vertexId && ui.progIndex != null) {
    doAction({
      type: 'PLAY_PROGRESS_CARD', player: HUMAN,
      index: ui.progIndex, params: { vertexId: ui.pending.vertexId },
    });
  } else if (m === 'prog-edge' && ui.pending?.edgeId && ui.progIndex != null) {
    doAction({
      type: 'PLAY_PROGRESS_CARD', player: HUMAN,
      index: ui.progIndex, params: { edgeId: ui.pending.edgeId },
    });
  } else if (m === 'prog-hex2' && ui.pendingHexes.length === 2 && ui.progIndex != null) {
    doAction({
      type: 'PLAY_PROGRESS_CARD', player: HUMAN,
      index: ui.progIndex, params: { a: ui.pendingHexes[0], b: ui.pendingHexes[1] },
    });
  } else if (m === 'prog-roads' && ui.pendingEdges.length >= 1 && ui.progIndex != null) {
    doAction({
      type: 'PLAY_PROGRESS_CARD', player: HUMAN,
      index: ui.progIndex, params: { edges: [...ui.pendingEdges] },
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
    'build-knight', 'build-wall', 'move-knight',
    'prog-hex', 'prog-vertex', 'prog-edge', 'prog-hex2', 'prog-roads',
  ].includes(ui.mode)) {
    ui.mode = 'idle';
    ui.pending = null;
    ui.pendingEdges = [];
    ui.pendingHexes = [];
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

    // ---- 画面フロー ----
    case 'goto-select': setScreen('select'); return;
    case 'goto-title': setScreen('title'); return;
    case 'goto-rules': setScreen('rules'); return;
    case 'rules-back': setScreen('title'); return;
    case 'rules-tab':
      if (ui?.dialog?.type === 'rules') ui.dialog.tab = arg;
      else rulesTab = arg;
      refresh();
      return;
    case 'rules-open':
      ui.dialog = { type: 'rules', tab: 'basic' };
      refresh();
      return;
    case 'start-game':
      setScreen('game');
      newGame();
      return;

    case 'settings-open':
      ui.dialog = { type: 'settings', settings };
      refresh();
      return;
    case 'log-open':
      ui.dialog = { type: 'log' };
      refresh();
      return;
    case 'set-view': {
      settings.view = arg;
      viewMode = arg;
      if (arg === '3d') {
        renderer3dFailed = false; // 手動で選び直したら再挑戦できる
        ensureRenderer3d().then(() => refresh());
      }
      refresh();
      return;
    }
    case 'set-mode': settings.mode = arg; refresh(); return;
    case 'set-cpu': settings.cpuCount = Number(arg); refresh(); return;
    case 'set-diff': settings.difficulty = arg; refresh(); return;

    case 'pexpand':
      ui.expandedPlayer = ui.expandedPlayer === Number(arg) ? null : Number(arg);
      refresh();
      return;
    case 'view-reset':
      renderer3d?.resetView();
      return;

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

    case 'trade-open':
      ui.dialog = { type: 'trade', tab: 'bank', give: null, receive: null, pgive: {}, precv: {} };
      refresh();
      return;
    case 'trade-tab': ui.dialog.tab = arg; refresh(); return;

    case 'ptg-add':
      ui.dialog.pgive[arg] = (ui.dialog.pgive[arg] ?? 0) + 1;
      refresh();
      return;
    case 'ptg-sub':
      if (--ui.dialog.pgive[arg] <= 0) delete ui.dialog.pgive[arg];
      refresh();
      return;
    case 'ptr-add':
      ui.dialog.precv[arg] = (ui.dialog.precv[arg] ?? 0) + 1;
      refresh();
      return;
    case 'ptr-sub':
      if (--ui.dialog.precv[arg] <= 0) delete ui.dialog.precv[arg];
      refresh();
      return;
    case 'pt-propose': {
      const { pgive, precv } = ui.dialog;
      for (const pl of state.players) {
        if (!pl.isCPU) continue;
        const action = {
          type: 'TRADE_PLAYERS', player: HUMAN, partner: pl.id,
          give: { ...pgive }, receive: { ...precv },
        };
        if (validateAction(state, action) === null &&
            cpuAcceptsTrade(state, pl.id, pgive, precv)) {
          doAction(action);
          return;
        }
      }
      ui.toast = '誰も交易に応じませんでした';
      refresh();
      return;
    }
    case 'offer-accept':
      doAction({ type: 'RESPOND_TRADE', player: HUMAN, accept: true });
      return;
    case 'offer-decline':
      doAction({ type: 'RESPOND_TRADE', player: HUMAN, accept: false });
      return;

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

    // 手札の進歩カードをタップ → まず説明ダイアログ(そこから「使う」)
    case 'play-prog': {
      const index = Number(arg);
      if (!state.players[HUMAN].progressCards[index]) return;
      ui.dialog = { type: 'prog-info', index };
      refresh();
      return;
    }

    case 'prog-use':
      startProgressPlay(Number(arg));
      return;

    case 'pc':
      doAction({
        type: 'PLAY_PROGRESS_CARD', player: HUMAN,
        index: ui.dialog.index, params: { commodity: arg },
      });
      return;
    case 'pres':
      doAction({
        type: 'PLAY_PROGRESS_CARD', player: HUMAN,
        index: ui.dialog.index, params: { resource: arg },
      });
      return;
    case 'pkey':
      doAction({
        type: 'PLAY_PROGRESS_CARD', player: HUMAN,
        index: ui.dialog.index, params: { key: arg },
      });
      return;
    case 'pplayer':
      doAction({
        type: 'PLAY_PROGRESS_CARD', player: HUMAN,
        index: ui.dialog.index, params: { target: Number(arg) },
      });
      return;
    case 'pdice-r': ui.dialog.red = Number(arg); refresh(); return;
    case 'pdice-y': ui.dialog.yellow = Number(arg); refresh(); return;
    case 'pdice-confirm':
      doAction({
        type: 'PLAY_PROGRESS_CARD', player: HUMAN,
        index: ui.dialog.index, params: { red: ui.dialog.red, yellow: ui.dialog.yellow },
      });
      return;
  }
});

window.addEventListener('resize', () => state && refresh());

// iOS は user-scalable=no を無視してページのピンチズームを許可するため明示的に抑止する
// (盤面の2本指ピンチは OrbitControls のカメラズームとしてのみ機能させる)
for (const ev of ['gesturestart', 'gesturechange', 'gestureend']) {
  document.addEventListener(ev, (e) => e.preventDefault(), { passive: false });
}
document.addEventListener(
  'touchmove',
  (e) => {
    if (e.scale !== undefined && e.scale !== 1) e.preventDefault();
  },
  { passive: false },
);

// 設定シートのシード入力(再描画されても値を保持する)
document.addEventListener('input', (e) => {
  if (e.target.id === 'seed-input') settings.seed = e.target.value;
});

// デバッグ・テスト用フック(シード制御と合わせて再現検証に使う)
window.catanDebug = {
  getState: () => state,
  setState: (s) => { state = s; refresh(); scheduleCpu(); },
  doAction,
  newGameWith: (patch) => { Object.assign(settings, patch); setScreen('game'); newGame(); },
  getUi: () => ui,
  screenPos: (kind, id) => (renderer3d ? renderer3d.screenPos(kind, id) : null),
  getRenderer: () => renderer3d,
  getViewState: () => ({ viewMode, has3d: !!renderer3d, failed: renderer3dFailed, screen }),
};

// PWA: Service Worker 登録。
// updateViaCache: 'none' で sw.js の更新確認は常にネットワークへ。
// SW はネットワーク優先なので、オンライン時は必ず最新バージョンが表示される。
if ('serviceWorker' in navigator) {
  navigator.serviceWorker
    .register('./sw.js', { updateViaCache: 'none' })
    .then((reg) => {
      reg.update();
      setInterval(() => reg.update(), 60 * 60 * 1000); // 長時間開きっぱなし対策
    })
    .catch((e) => console.warn('SW登録失敗:', e));
}

// 起動: タイトル画面。背景用にCPUなしの盤面を1つ生成して飾る
document.body.dataset.screen = screen;
state = createGame({
  seed: (Date.now() % 0x7fffffff) || 1,
  playerCount: 4,
  humanIndex: -1,
  mode: 'cak',
});
ui = freshUi();
refresh();
if (viewMode === '3d') ensureRenderer3d().then(() => state && refresh());
