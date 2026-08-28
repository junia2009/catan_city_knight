// 起動・ゲームループ・入力モード管理(設計書 §2, §8)
// 人間の入力も CPU も、同じ dispatch(action) を通る。

import { createGame, RESOURCES } from './state.js';
import { dispatch, validateAction } from './actions.js';
import { chooseAction } from './ai/cpu-player.js';
import { stealableTargets } from './rules/robber.js';
import { totalCards } from './rules/build.js';
import {
  legalCityVertices,
  legalRoadEdges,
  legalRobberHexes,
  legalSettlementVertices,
  legalSetupEdges,
  legalSetupVertices,
  legalShipEdges,
} from './ai/legal-moves.js';
import { LAYOUT, boardVertexIds } from './rules/board.js';
import { isSeaHex, movableShips, pirateTargets } from './rules/sea.js';
import { lsSet, lsRemove } from './storage.js';
import { razableCities } from './rules/cak/barbarians.js';
import {
  PROGRESS_CARDS, diplomatMovable, diplomatDestinations,
  deserterKnights, deserterSpots,
} from './rules/cak/progress-cards.js';
import { drawBoard, hexCenterOf, toPixel, PLAYER_COLORS } from './render/board-render.js';
import { avatarSvg } from './render/avatars.js';
import { renderHUD, RES_ICON, COM_ICON, setHumanSeat } from './render/hud-render.js';
import { rulesHtml } from './render/rules-content.js';
import { Bgm } from './audio/bgm.js';
import { Sfx, sfxForAction, sfxForEnd, suspendAudio } from './audio/sfx.js';
import { pickEdge, pickHex, pickVertex } from './input.js';
import {
  NetClient, createRoom, clientId, savedName, saveName, serverBase,
} from './net/client.js';

// 自分の席番号。ローカル戦は常に 0、オンライン対戦ではサーバーが割り当てた席になる。
let HUMAN = 0;
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

// 端末が古い版を掴んだまま(特にPWA)にならないよう、配信中の版と照合する。
// タイトル画面でしか出さないので、対戦中に邪魔をすることはない。
async function checkForUpdate() {
  const tagEl = document.getElementById('build-tag');
  if (!tagEl) return;
  const current = tagEl.textContent.trim();
  if (current.includes('BUILD_ID')) return; // ローカル開発時は版が埋まっていない
  try {
    const res = await fetch(`./index.html?_=${Date.now()}`, { cache: 'no-store' });
    const latest = (await res.text()).match(/id="build-tag">([^<]*)</)?.[1]?.trim();
    if (latest && latest !== current) {
      tagEl.textContent = '🔄 新しい版があります — タップで更新';
      tagEl.dataset.act = 'reload-app';
      tagEl.classList.add('update');
    }
  } catch {
    // オフライン等は黙って諦める(次回起動で再確認される)
  }
}

// タイトル画面の背景に飾る盤面(全員CPUで、進行はしない)。
// state は常に非 null に保つ ── null にすると入力処理が丸ごと止まる。
function showTitleBoard() {
  clearTimeout(cpuTimer);
  state = createGame({
    seed: (Date.now() % 0x7fffffff) || 1,
    playerCount: 4,
    humanIndex: -1,
    mode: 'cak',
  });
  ui = freshUi();
}

// 自分の席が変わったら描画側にも伝える(オンラインで席が 0 以外になる)
function setSeat(seat) {
  HUMAN = seat;
  setHumanSeat(seat);
}

// 設定(⚙️シートから編集。新しいゲーム開始時に反映)
const settings = {
  view: '3d', mode: 'base', cpuCount: 3, seed: '', difficulty: 'normal', bgm: true, sfx: true,
  diceMode: 'random', // 'random'(毎回独立。既定) | 'balanced'(36通りの山札)
};

// 画面フロー: title(タイトル) → select(ルール選択) / online(合言葉・ロビー) → game(ゲーム)
let screen = 'title';

// オンライン対戦の状態(null ならローカル戦)
let net = null;
const online = {
  code: null,
  lobby: null, // サーバーから届く席・ホスト・設定
  status: 'idle', // 'connecting' | 'online' | 'reconnecting' | 'closed'
  error: null,
  busy: false,
};

function isOnline() {
  return net != null;
}

// 自分がこの部屋のホストか
function isHost() {
  return online.lobby?.host === clientId();
}

function setScreen(s) {
  screen = s;
  document.body.dataset.screen = s;
  if (ui) refresh();
}

// ルール選択画面の描画(settings と連動)
function renderSelectPanel() {
  const panel = document.getElementById('select-panel');
  if (!panel || screen !== 'select') return;
  // 選択肢が4つ以上ならタイル状(2列)に畳む
  const seg = (act, options, current) =>
    `<div class="seg ${options.length >= 4 ? 'seg-grid' : ''}">${options
      .map(([v, label]) => `<button class="${current === v ? 'sel' : ''}" data-act="${act}:${v}">${label}</button>`)
      .join('')}</div>`;
  panel.innerHTML = `
    <h3>⬡ ゲーム設定</h3>
    <div class="srow"><span>ルール</span>${seg('set-mode', [['base', '基本'], ['cak', '都市と騎士'], ['dragon', '🐉ドラゴン'], ['fish', '🐟漁師'], ['sea', '⛵航海者']], settings.mode)}</div>
    <div class="srow"><span>CPU</span>${seg('set-cpu', [['2', '2体'], ['3', '3体']], String(settings.cpuCount))}</div>
    <div class="srow"><span>強さ</span>${seg('set-diff', [['easy', '弱い'], ['normal', '普通'], ['hard', '強い']], settings.difficulty)}</div>
    <div class="srow"><span>出目</span>${seg('set-dice', [['random', '純ランダム'], ['balanced', 'バランス']], settings.diceMode)}</div>
    <div class="srow"><span>BGM</span>${seg('set-bgm', [['on', '🔊 オン'], ['off', '🔇 オフ']], settings.bgm ? 'on' : 'off')}</div>
    <div class="srow"><span>効果音</span>${seg('set-sfx', [['on', '🔔 オン'], ['off', '🔕 オフ']], settings.sfx ? 'on' : 'off')}</div>
    <div class="srow"><span>シード</span><input id="seed-input" inputmode="numeric" placeholder="空欄でランダム" value="${settings.seed}"></div>
    <div class="row end">
      <button data-act="goto-rules:setup">❔ 選択肢の説明</button>
      <button data-act="goto-title">← タイトル</button>
      <button class="primary" data-act="start-game">ゲーム開始</button>
    </div>`;
}

// ---- オンライン対戦の画面 ----

const STATUS_JP = {
  idle: '未接続',
  connecting: '接続中…',
  online: '接続済み',
  reconnecting: '再接続中…',
  closed: '切断されました',
};

function renderOnlinePanel() {
  const panel = document.getElementById('online-panel');
  if (!panel || screen !== 'online') return;
  const err = online.error ? `<div class="net-err">⚠️ ${online.error}</div>` : '';
  // 再描画で入力中の文字が消えないように退避する
  const typed = {
    name: document.getElementById('net-name')?.value,
    code: document.getElementById('net-code')?.value,
    focus: document.activeElement?.id,
  };
  const restore = () => {
    const n = document.getElementById('net-name');
    const c = document.getElementById('net-code');
    if (n && typed.name != null) n.value = typed.name;
    if (c && typed.code != null) c.value = typed.code;
    if (typed.focus) document.getElementById(typed.focus)?.focus();
  };

  // まだ部屋に入っていない: 作る/合言葉で入る
  if (!online.lobby) {
    panel.innerHTML = `
      <h3>🌐 オンライン対戦</h3>
      <div class="net-note">同じ合言葉を共有した友達と、最大4人で対戦できます。<br>
        空いた席はCPUが埋めます。</div>
      <div class="srow"><span>名前</span>
        <input id="net-name" maxlength="12" placeholder="あなたの名前" value="${savedName()}"></div>
      <div class="row end">
        <button class="primary" data-act="net-create" ${online.busy ? 'disabled' : ''}>部屋を作る</button>
      </div>
      <div class="srow"><span>合言葉</span>
        <input id="net-code" maxlength="4" placeholder="ABCD" style="text-transform:uppercase"></div>
      <div class="row end">
        <button data-act="net-join" ${online.busy ? 'disabled' : ''}>この部屋に入る</button>
      </div>
      ${err}
      ${online.error ? `
        <div class="net-note">サーバーの場所が違う場合はここで変更できます</div>
        <div class="srow"><span>サーバー</span>
          <input id="net-server" placeholder="https://....workers.dev" value="${serverBase()}"></div>
        <div class="row end"><button data-act="net-server-save">接続先を保存</button></div>` : ''}
      <div class="row end"><button data-act="goto-title">← タイトル</button></div>`;
    restore();
    return;
  }

  // ロビー: 参加者を待ってホストが開始する
  const lb = online.lobby;
  const seg = (act, options, current, disabled) =>
    `<div class="seg ${options.length >= 4 ? 'seg-grid' : ''}">${options
      .map(([v, label]) => `<button class="${current === v ? 'sel' : ''}" data-act="${act}:${v}" ${disabled ? 'disabled' : ''}>${label}</button>`)
      .join('')}</div>`;
  const seats = lb.seats.map((s) => {
    if (!s.occupied) {
      return `<div class="seat-row empty"><span>席${s.seat + 1}</span>
        <span class="tag">${lb.settings.cpuFill ? 'CPUが入ります' : '空席'}</span></div>`;
    }
    const isMe = s.seat === net?.seat;
    return `<div class="seat-row" style="--pc:${PLAYER_COLORS[s.seat]}">
      <span>${s.name}${isMe ? '(あなた)' : ''}</span>
      ${lb.hostSeat === s.seat ? '<span class="tag host">ホスト</span>' : ''}
      ${s.online ? '' : '<span class="tag off">切断中</span>'}
    </div>`;
  }).join('');

  const host = isHost();
  panel.innerHTML = `
    <h3>🌐 待機中</h3>
    <div class="code-box">
      <div class="code">${lb.code}</div>
      <small>この合言葉を友達に伝えてください</small>
    </div>
    <div class="seat-list">${seats}</div>
    <div class="srow"><span>ルール</span>${seg('net-mode', [['base', '基本'], ['cak', '都市と騎士'], ['dragon', '🐉ドラゴン'], ['fish', '🐟漁師'], ['sea', '⛵航海者']], lb.settings.mode, !host)}</div>
    <div class="srow"><span>空席</span>${seg('net-fill', [['on', 'CPUで埋める'], ['off', '人だけ']], lb.settings.cpuFill ? 'on' : 'off', !host)}</div>
    ${lb.settings.cpuFill ? `<div class="srow"><span>強さ</span>${seg('net-diff', [['easy', '弱い'], ['normal', '普通'], ['hard', '強い']], lb.settings.difficulty, !host)}</div>` : ''}
    <div class="srow"><span>出目</span>${seg('net-dice', [['random', '純ランダム'], ['balanced', 'バランス']], lb.settings.diceMode ?? 'random', !host)}</div>
    <div class="net-status ${online.status}"><span class="dot"></span>${STATUS_JP[online.status] ?? ''}</div>
    ${err}
    <div class="net-note">${host ? '全員そろったら開始してください' : 'ホストが開始するのを待っています…'}</div>
    <div class="row end">
      <button data-act="goto-rules:setup">❔ 選択肢の説明</button>
      <button data-act="net-leave">← 退出</button>
      ${host ? '<button class="primary" data-act="net-start">対戦開始</button>' : ''}
    </div>`;
}

function updateNetBadge() {
  const el = document.getElementById('netbadge');
  if (!el) return;
  el.className = isOnline() ? `show ${online.status}` : '';
  if (isOnline()) {
    const who = state?.players?.[HUMAN]?.name ?? '';
    el.querySelector('.txt').textContent =
      `${online.code} · ${who} · ${STATUS_JP[online.status] ?? ''}`;
  }
}

// サーバーからの状態を反映する。ローカル戦と違い dispatch は一切しない。
function onNetState(msg) {
  const prev = state;
  setSeat(msg.seat);
  const first = !state;
  state = msg.state;
  if (!ui || first) ui = freshUi();
  ui.sentAwaiting = null; // 新しい state が来たので「返信待ち」は解消
  if (screen !== 'game') {
    setScreen('game');
    if (viewMode === '3d' && !renderer3d) ensureRenderer3d().then(() => refresh());
  }
  // 演出はローカル戦と同じフックを、サーバーが適用したアクションから再生する
  if (msg.action && prev) playFx(msg.action, prev, state);
  syncUi();
  refresh();
  updateNetBadge();
}

function onNetLobby(msg) {
  online.lobby = msg;
  online.code = msg.code;
  if (msg.phase === 'lobby' && screen === 'game') setScreen('online');
  renderOnlinePanel();
  updateNetBadge();
}

function startNet(code, name) {
  saveName(name);
  online.code = code;
  online.error = null;
  net = new NetClient({
    onStatus: (s) => {
      online.status = s;
      renderOnlinePanel();
      updateNetBadge();
    },
    onLobby: onNetLobby,
    onState: onNetState,
    onError: (msg, fatal) => {
      online.error = msg;
      if (fatal) {
        // 復帰できない切断(放置による切断など)。理由を見せたまま
        // 合言葉の画面に戻し、すぐ入り直せるようにする。
        leaveNet(false);
        showTitleBoard();
        setScreen('online');
      } else if (screen === 'game') {
        ui.toast = msg;
        ui.sentAwaiting = null; // 手が通らなかったので、割り込みのダイアログを出し直す
        refresh();
      }
      renderOnlinePanel();
    },
  });
  net.connect(code, name);
  setScreen('online');
  renderOnlinePanel();
}

function leaveNet(toTitle = true) {
  net?.close();
  net = null;
  online.lobby = null;
  online.code = null;
  online.status = 'idle';
  setSeat(0);
  updateNetBadge();
  if (toTitle) {
    online.error = null;
    // state を null にすると入力処理が全て止まるので、飾り用の盤面に戻す
    showTitleBoard();
    setScreen('title');
  }
  renderOnlinePanel();
}

// BGM(Web Audio 生成)。iOSの自動再生制限のため初回タップで開始する
const bgm = new Bgm();
settings.bgm = bgm.enabled;
function syncBgmButtons() {
  for (const b of document.querySelectorAll('[data-act="bgm-toggle"]')) {
    b.textContent = bgm.enabled ? '🔊 BGM オン' : '🔇 BGM オフ';
  }
}
// 効果音。BGM と AudioContext を共有する(audio/ctx.js)
const sfx = new Sfx();
settings.sfx = sfx.enabled;

document.addEventListener(
  'pointerdown',
  () => bgm.start(),
  { once: true, capture: true },
);
document.addEventListener('visibilitychange', () => {
  if (document.hidden) suspendAudio();
  else if (bgm.enabled && bgm.running) bgm.ctx?.resume();
});

// アクション1つぶんの演出(音と画面)。
//
// 手を出す経路は「自分の操作」「CPU の自動進行」「オンラインでサーバーから届いた手」
// の3つある。どれも同じ演出を出すので、必ずここを通す ──
// 経路ごとに書き写していたせいで、CPU の手番だけ音が鳴らない状態になっていた。
function playFx(action, prev, next, { skipBoardFx = false } = {}) {
  if (!action || !prev || !next) return;
  if (!skipBoardFx) {
    maybeTradeFx(action, prev.awaiting);
    if (action.type === 'ROLL_DICE') {
      showGainFx(prev.players.map((p) => ({ ...p.resources })));
      rollFx();
    }
  }
  const me = HUMAN; // オンラインでも setSeat() で自席になっている
  for (const { name, delay } of sfxForAction(action, prev, next, me)) {
    if (delay) setTimeout(() => sfx.play(name), delay * 1000);
    else sfx.play(name);
  }
  if (prev.phase !== 'ended' && next.phase === 'ended') {
    setTimeout(() => sfx.play(sfxForEnd(next, me)), 600);
  }
}

// ---- あそびかたデモ(自動再生。実装は src/demo/)----
// 台本は実物のルールエンジンを動かすので、CPU の自動進行だけ止めて場を明け渡す。
let demoDriver = null; // DemoDriver(使い回す。イベント登録が増えないように1つだけ作る)
let demoScript = null; // 遅延読み込みした script.js
let demoChapter = null;
let demoRunning = false;
let demoReturn = 'title'; // 終了後に戻る画面

function nextDemoChapter() {
  if (!demoScript || !demoChapter) return null;
  const i = demoScript.DEMO_CHAPTERS.indexOf(demoChapter);
  return demoScript.DEMO_CHAPTERS[i + 1] ?? null;
}

// 盤面要素の画面座標(3D はレイキャスト用の射影、2D は view から逆算)
function boardPos(kind, id) {
  if (viewMode === '3d' && renderer3d) return renderer3d.screenPos(kind, id);
  if (!view) return null;
  const rect = canvas.getBoundingClientRect();
  let xy;
  if (kind === 'vertex') xy = toPixel(view, LAYOUT.vertices[id].x, LAYOUT.vertices[id].y);
  else if (kind === 'edge') xy = toPixel(view, LAYOUT.edges[id].x, LAYOUT.edges[id].y);
  else {
    const c = hexCenterOf(id);
    xy = toPixel(view, c.x, c.y);
  }
  return [rect.left + xy[0], rect.top + xy[1]];
}

const demoHost = {
  getState: () => state,
  getUi: () => ui,
  // 台本の下ごしらえ(資源配布・出目の仕込み)。複製してから書き換える。
  patchState: (fn) => {
    const s = structuredClone(state);
    fn(s);
    state = s;
    refresh();
  },
  setUi: (patch) => {
    if (patch) Object.assign(ui, patch);
    refresh();
  },
  act: (action) => doAction(action),
  boardPos,
  resetView: () => renderer3d?.resetView(),
  nextChapterTitle: () => nextDemoChapter()?.title ?? null,
  exit: (where) => endDemo(where),
};

async function startDemo(chapterId, from = 'title') {
  if (isOnline()) leaveNet(false);
  const [{ DemoDriver }, script, scenario] = await Promise.all([
    import('./demo/driver.js'),
    import('./demo/script.js'),
    import('./demo/scenario.js'),
  ]);
  demoScript = script;
  demoChapter = script.findChapter(chapterId);
  demoReturn = from;
  clearTimeout(cpuTimer);
  demoRunning = true;
  setSeat(0);
  state = scenario.buildDemoState(demoChapter.mode, { finishSetup: !demoChapter.fromSetup });
  ui = freshUi();
  setScreen('game');
  if (viewMode === '3d' && !renderer3dFailed) await ensureRenderer3d();
  refresh();
  demoDriver ??= new DemoDriver(demoHost);
  demoDriver.run(demoChapter);
}

// where: 'back'(戻る) | 'play'(そのルールで対戦を始める) | 'next'(次の章)
function endDemo(where) {
  const next = where === 'next' ? nextDemoChapter() : null;
  demoDriver?.stop();
  demoRunning = false;
  if (next) {
    startDemo(next.id, demoReturn);
    return;
  }
  if (where === 'play') {
    settings.mode = demoChapter.mode;
    setScreen('game');
    newGame();
    return;
  }
  showTitleBoard();
  setScreen(demoReturn === 'rules' ? 'rules' : 'title');
}

// 説明書画面(タイトル・設定画面・ロビーから遷移)
let rulesTab = 'basic';
// 開く前の画面。閉じたらここへ戻す(ロビーから開いても部屋に戻れるように)
let rulesFrom = 'title';
function renderRulesPanel() {
  const panel = document.getElementById('rules-panel');
  if (!panel || screen !== 'rules') return;
  const backLabel = { select: '← 設定へ', online: '← 部屋へ' }[rulesFrom] ?? '← タイトルへ';
  panel.innerHTML = `<h3>📖 あそびかた</h3>${rulesHtml(rulesTab)}
    <div class="row end rules-close"><button class="primary" data-act="rules-back">${backLabel}</button></div>`;
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
    setupPiece: 'road', // 初期配置で開拓地と一緒に置く駒(航海者たちは船も選べる)
    pendingEdges: [], // 街道建設カード
    pendingHexes: [], // 発明家(数字トークン交換)
    pendingVertices: [], // 鍛冶屋(昇格させる騎士)
    sentAwaiting: null, // オンライン: サーバーへ応答を送った割り込み(返信待ち)
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
    diceMode: settings.diceMode,
  });
  ui = freshUi();
  lastTurnKey = null; // 新しい対戦なので、1手目の合図から出し直す
  refresh();
  scheduleCpu();
}

// ---- UI 状態と GameState の同期 ----

// 割り込み(awaiting)に紐づくダイアログ。割り込みが変わったら必ず閉じる。
// 閉じ忘れると「捨て札ダイアログのまま盗賊移動になる」ような食い違いが起き、
// ダイアログの描画が state を読めずに例外で落ちて操作不能になる。
const INTERRUPT_DIALOGS = [
  'discard', 'steal', 'tradeOffer', 'tradeChoose', 'aqueduct', 'gold', 'defenderDeck', 'progressLimit', 'weddingGift', 'harborGive',
];
// awaiting の種類ごとに、開いたままでよいダイアログ
const DIALOG_FOR_AWAITING = {
  discard: 'discard',
  tradeOffer: 'tradeOffer',
  tradeChoose: 'tradeChoose',
  aqueduct: 'aqueduct',
  goldChoice: 'gold',
  defenderDeck: 'defenderDeck',
  progressLimit: 'progressLimit',
  weddingGift: 'weddingGift',
  harborGive: 'harborGive',
  moveRobber: 'steal', // 略奪相手の選択(自分で開くのでここでは自動で開かない)
};
// awaiting の種類ごとの盤面入力モード
const MODE_FOR_AWAITING = {
  setupPlacement: 'setup-settlement',
  moveRobber: 'move-robber',
  barbarianDefense: 'raze-city',
  deserterPick: 'desert-pick',
  deserterPlace: 'desert-place',
  knightDisplace: 'knight-displace',
};

function syncUi() {
  const aw = state.awaiting;
  const forced = [
    'setup-settlement', 'setup-road', 'move-robber', 'raze-city',
    'desert-pick', 'desert-place', 'knight-displace',
  ].includes(ui.mode);

  if (state.phase === 'ended') {
    ui.mode = 'idle';
    ui.pending = null;
    if (ui.dialog?.type !== 'winner') ui.dialog = { type: 'winner' };
    return;
  }

  const mine = aw?.players.includes(HUMAN) ? aw : null;
  const keep = mine ? DIALOG_FOR_AWAITING[mine.type] : null;
  // 自分の割り込みかどうかに関わらず、今の割り込みに合わないものは閉じる
  if (INTERRUPT_DIALOGS.includes(ui.dialog?.type) && ui.dialog.type !== keep) ui.dialog = null;

  // オンラインでは応答を送ってからサーバーの state が届くまで間がある。
  // その間は同じ割り込みを見ているので、ダイアログや入力モードを開き直さない
  // (開き直すと二重に手を出せてしまい、捨て札が 0 枚に戻って見える)。
  const replied = mine != null && ui.sentAwaiting === mine;

  if (mine && !replied) {
    const wantMode = MODE_FOR_AWAITING[mine.type];
    if (wantMode === 'setup-settlement' && !['setup-settlement', 'setup-road'].includes(ui.mode)) {
      ui.mode = 'setup-settlement';
      ui.pending = null;
      ui.pendingVertex = null;
      ui.setupPiece = 'road';
    } else if (wantMode && wantMode !== 'setup-settlement' && ui.mode !== wantMode) {
      ui.mode = wantMode;
      ui.pending = null;
    }
    if (keep && keep !== 'steal' && ui.dialog?.type !== keep) {
      ui.dialog = (keep === 'discard' || keep === 'weddingGift')
        ? {
            type: keep,
            // 都市と騎士では商品も捨て札の対象(手札上限に数えるため)
            counts: {
              wood: 0, brick: 0, sheep: 0, wheat: 0, ore: 0,
              cloth: 0, coin: 0, paper: 0,
            },
          }
        : { type: keep };
    }
  } else if (!mine && forced) {
    ui.mode = 'idle';
    ui.pending = null;
    ui.pendingVertex = null;
    ui.setupPiece = 'road';
  }
}

function computeHighlights() {
  const m = ui.mode;
  if (m === 'setup-settlement') {
    return { vertices: legalSetupVertices(state, HUMAN) };
  }
  if (m === 'setup-road' && ui.pendingVertex) {
    return { edges: legalSetupEdges(state, ui.pendingVertex, ui.setupPiece) };
  }
  if (m === 'build-road' || m === 'fish-road') return { edges: legalRoadEdges(state, HUMAN) };
  if (m === 'build-ship') return { edges: legalShipEdges(state, HUMAN) };
  if (m === 'move-ship') return { edges: movableShips(state, HUMAN) };
  if (m === 'move-ship-to' && ui.shipFrom) {
    // 動かす船をいったん外した状態で置ける辺
    const without = { ...state, ships: { ...state.ships } };
    delete without.ships[ui.shipFrom];
    return { edges: legalShipEdges(without, HUMAN).filter((e) => e !== ui.shipFrom) };
  }
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
      vertices: boardVertexIds(state.board).filter(
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
      vertices: boardVertexIds(state.board).filter(
        (v) =>
          validateAction(state, {
            type: 'MOVE_KNIGHT', player: HUMAN,
            fromVertexId: ui.knightFrom, toVertexId: v,
          }) === null,
      ),
    };
  }
  if (m === 'raze-city') return { vertices: razableCities(state, HUMAN) };
  if (m === 'build-tower') {
    return {
      vertices: Object.keys(state.buildings).filter(
        (v) => validateAction(state, { type: 'BUILD_TOWER', player: HUMAN, vertexId: v }) === null,
      ),
    };
  }

  // ---- 進歩カード(対象を validate 総当たりでハイライト)----
  const progAct = (params) =>
    ({ type: 'PLAY_PROGRESS_CARD', player: HUMAN, index: ui.progIndex, params });
  if (m === 'prog-hex') {
    return {
      hexes: state.board.hexIds.filter((h) => validateAction(state, progAct({ hexId: h })) === null),
    };
  }
  if (m === 'prog-vertex') {
    return {
      vertices: boardVertexIds(state.board).filter(
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
        hexes: state.board.hexIds.filter((h) => {
          const t = state.board.hexes[h].token;
          return t && ![2, 6, 8, 12].includes(t);
        }),
      };
    }
    return {
      hexes: state.board.hexIds.filter(
        (h) => validateAction(state, progAct({ a: ui.pendingHexes[0], b: h })) === null,
      ),
    };
  }
  if (m === 'knight-displace') return { vertices: state.awaiting?.context?.spots ?? [] };
  if (m === 'desert-pick') return { vertices: deserterKnights(state, HUMAN) };
  if (m === 'desert-place') return { vertices: deserterSpots(state, HUMAN) };
  if (m === 'prog-moveroad') {
    // 1本目は自分の開いた道、2本目はその道を外した状態で置ける辺
    return {
      edges: ui.pendingEdges.length === 0
        ? diplomatMovable(state, HUMAN)
        : diplomatDestinations(state, HUMAN, ui.pendingEdges[0]),
    };
  }
  if (m === 'prog-knights') {
    // 選択済みのぶんを当てはめてから、まだ昇格できる騎士を出す
    return {
      vertices: Object.keys(state.knights).filter(
        (v) => !ui.pendingVertices.includes(v)
          && validateAction(state, progAct({ vertices: [...ui.pendingVertices, v] })) === null,
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
  renderOnlinePanel();
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
  maybeTurnFx();
}

// ---- 手番の合図 ----
//
// 「気づいたら自分の番だった」を無くすための演出。
// 手番が移るたびに、誰の番かを画面の真ん中に大きく出す。

// いま手を打つ人。初期配置は awaiting が順番を持っているのでそちらを見る。
function onTheClock(s) {
  if (!s || (s.phase !== 'main' && s.phase !== 'setup')) return null;
  if (s.phase === 'setup') return s.awaiting?.players[0] ?? null;
  return s.currentPlayer;
}

// 「同じ手番」を表す鍵。割り込み(捨て札・盗賊)では変わらないので連打しない。
function turnKey(s) {
  const pid = onTheClock(s);
  if (pid == null) return null;
  return s.phase === 'setup' ? `setup:${s.setup.index}` : `main:${s.turn}:${pid}`;
}

let lastTurnKey = null;

function maybeTurnFx() {
  // あそびかた画面などへ寄り道しているあいだは光らせない。
  // 鍵は覚えたままにして、戻ってきただけで同じ手番を告げ直さないようにする。
  if (screen !== 'game') {
    document.body.classList.remove('myturn');
    return;
  }
  const key = turnKey(state);
  if (key == null) { // 決着後・対戦前
    lastTurnKey = null;
    document.body.classList.remove('myturn');
    return;
  }
  const pid = onTheClock(state);
  document.body.classList.toggle('myturn', pid === HUMAN);
  if (key === lastTurnKey) return;
  lastTurnKey = key;
  // デモ再生中は出さない(台本の字幕が進行を説明しているので、被ると読みにくい)
  if (demoRunning) return;
  showTurnFx(pid);
}

function showTurnFx(pid) {
  const p = state.players[pid];
  if (!p) return;
  const fxEl = document.getElementById('fx');
  fxEl.querySelector('.turnfx')?.remove(); // 早送り気味に進んだときは前の合図を捨てる
  const mine = pid === HUMAN;
  const div = document.createElement('div');
  div.className = `turnfx ${mine ? 'me' : ''}`;
  div.style.setProperty('--pc', PLAYER_COLORS[pid]);
  div.innerHTML = `
    <span class="turnfx-band"></span>
    <span class="turnfx-card">
      <span class="chip">${avatarSvg(pid)}</span>
      <span class="turnfx-text">
        <b>${mine ? 'あなたの番' : `${p.name}の番`}</b>
        <small>${state.phase === 'setup' ? '初期配置' : `${state.turn + 1}ターン目`}</small>
      </span>
    </span>`;
  fxEl.appendChild(div);
  const life = mine ? 2000 : 1100;
  setTimeout(() => div.classList.add('out'), life);
  setTimeout(() => div.remove(), life + 420);
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

const tradeItems = (obj) =>
  Object.entries(obj)
    .map(([r, n]) => `${RES_ICON[r] ?? COM_ICON[r]}×${n}`)
    .join(' ');

function tradeBanner(cls, html, life = 2100) {
  const fxEl = document.getElementById('fx');
  const div = document.createElement('div');
  div.className = cls;
  div.innerHTML = html;
  fxEl.appendChild(div);
  setTimeout(() => div.classList.add('out'), life);
  setTimeout(() => div.remove(), life + 500);
}

// 交易成立の目立つバナー(誰が何を渡し何を得たか)
function showTradeFx(aName, bName, give, receive) {
  tradeBanner('tradefx', `
    <div class="tf-title">🤝 交易成立!</div>
    <div class="tf-line"><b>${aName}</b><span class="tf-items">${tradeItems(give)}</span><span class="tf-arrow">➜</span><b>${bName}</b></div>
    <div class="tf-line"><b>${aName}</b><span class="tf-arrow">⬅</span><span class="tf-items">${tradeItems(receive)}</span><b>${bName}</b></div>`);
}

// 不成立のバナー。提案しっぱなしで結果が分からないままにしない。
function showTradeDenyFx(line, give, receive) {
  tradeBanner('tradefx deny', `
    <div class="tf-title">🚫 交易は不成立</div>
    <div class="tf-line">${line}</div>
    <div class="tf-line"><span class="tf-items">${tradeItems(give)}</span><span class="tf-arrow">⇄</span><span class="tf-items">${tradeItems(receive)}</span></div>`);
}

// 一斉提案の決着でバナーを出す(人間・CPU どちらの取引でも、成立・不成立とも)。
// 返事が全員ぶん揃った最後の RESPOND_TRADE か、複数応諾後の CHOOSE_TRADE が決着点。
function maybeTradeFx(action, prevAwaiting) {
  if (action.type === 'RESPOND_TRADE' && prevAwaiting?.type === 'tradeOffer') {
    if (prevAwaiting.players.length > 1) return; // まだ返事待ちの人が残っている
    const { from, give, receive, replies } = prevAwaiting.context;
    const accepted = Object.entries({ ...replies, [action.player]: !!action.accept })
      .filter(([, yes]) => yes)
      .map(([id]) => Number(id));
    if (accepted.length === 0) {
      showTradeDenyFx('誰も応じませんでした', give, receive);
    } else if (accepted.length === 1) {
      showTradeFx(state.players[from].name, state.players[accepted[0]].name, give, receive);
    }
    // 2人以上応じたときは相手を選ぶダイアログが開くので、まだバナーは出さない
    return;
  }
  if (action.type === 'CHOOSE_TRADE' && prevAwaiting?.type === 'tradeChoose') {
    const { from, give, receive } = prevAwaiting.context;
    if (action.partner == null) {
      showTradeDenyFx(`<b>${state.players[from].name}</b>が取りやめました`, give, receive);
    } else {
      showTradeFx(state.players[from].name, state.players[action.partner].name, give, receive);
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

// 発展カード(基本モード)の使用開始: 盤面から選ぶものは選択モードへ
function startDevPlay(type) {
  if (type === 'knight') {
    doAction({ type: 'PLAY_DEV_CARD', player: HUMAN, card: 'knight' });
    return;
  }
  if (type === 'roadBuilding') {
    // 建てられる辺があるかだけ先に確かめる(なければ理由を出して札を減らさない)
    const err = validateAction(state, {
      type: 'PLAY_DEV_CARD', player: HUMAN, card: 'roadBuilding',
      params: { edges: [legalRoadEdges(state, HUMAN)[0]].filter(Boolean) },
    });
    if (err) {
      ui.toast = err;
      refresh();
      return;
    }
    ui.mode = 'play-road-building';
    ui.pendingEdges = [];
    refresh();
    return;
  }
  if (type === 'yearOfPlenty') ui.dialog = { type: 'yop', picks: [] };
  else if (type === 'monopoly') ui.dialog = { type: 'monopoly' };
  refresh();
}

// 進歩カードの使用開始: パラメータ種別に応じて盤面選択モードかダイアログへ
function startProgressPlay(index) {
  const card = state.players[HUMAN].progressCards[index];
  if (!card) return;
  const def = PROGRESS_CARDS[card.id];
  const boardMode = {
    hex: 'prog-hex', vertex: 'prog-vertex', edge: 'prog-edge',
    hex2: 'prog-hex2', edges: 'prog-roads', knights: 'prog-knights',
  }[def.needsParams];
  if (boardMode) {
    ui.dialog = null;
    ui.mode = boardMode;
    ui.progIndex = index;
    ui.pending = null;
    ui.pendingHexes = [];
    ui.pendingEdges = [];
    ui.pendingVertices = [];
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
  } else if (def.needsParams === 'diplomat') {
    ui.dialog = { type: 'diplomat', index };
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

  // オンライン対戦ではサーバーが権威。手を送り、返ってきた状態で描画する。
  if (isOnline()) {
    const err = validateAction(state, action); // 手元でも弾いて無駄な往復を減らす
    if (err) {
      ui.toast = err;
      refresh();
      return false;
    }
    if (!net.action(action)) {
      ui.toast = '接続が切れています。再接続を待っています…';
      refresh();
      return false;
    }
    // 割り込みへの応答を送ったことを覚えておく。返信が届くまで手元の state は
    // まだ同じ割り込みを指しているので、目印がないとダイアログを開き直してしまう。
    ui.sentAwaiting = state.awaiting;
    // 入力状態だけ畳んで、盤面の更新はサーバーからの state を待つ
    resetInputState();
    refresh();
    return true;
  }

  const prevState = state;
  try {
    state = dispatch(state, action);
  } catch (e) {
    ui.toast = e.message;
    refresh();
    return false;
  }
  playFx(action, prevState, state);
  resetInputState();
  refresh();
  scheduleCpu();
  return true;
}

// 手を出した後に入力途中の状態を畳む
function resetInputState() {
  ui.mode = 'idle';
  ui.pending = null;
  ui.pendingVertex = null;
  ui.pendingEdges = [];
  ui.pendingHexes = [];
  ui.pendingVertices = [];
  ui.knightFrom = null;
  ui.progIndex = null;
  ui.dialog = null;
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
  if (isOnline()) return; // オンラインでは CPU もサーバーが動かす
  if (screen !== 'game') return; // タイトル背景の盤面ではCPUを動かさない
  if (demoRunning) return; // あそびかたデモ中は台本だけが盤面を動かす
  const pid = actingCpu();
  if (pid == null) return;
  const delay = state.awaiting ? 300 : state.phase === 'setup' ? 450 : 550;
  cpuTimer = setTimeout(() => {
    const action = chooseAction(state, pid);
    if (!action) return;
    const prevState = state;
    try {
      state = dispatch(state, action);
      playFx(action, prevState, state);
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
  } else if (m === 'setup-road' || m === 'build-road' || m === 'fish-road' || m === 'build-ship') {
    const eid = pick('edge', ui.highlights.edges ?? []);
    if (eid) ui.pending = { edgeId: eid };
  } else if (m === 'move-ship') {
    const eid = pick('edge', ui.highlights.edges ?? []);
    if (eid) {
      ui.shipFrom = eid;
      ui.mode = 'move-ship-to';
      ui.pending = null;
    }
  } else if (m === 'move-ship-to') {
    const eid = pick('edge', ui.highlights.edges ?? []);
    if (eid) ui.pending = { edgeId: eid };
  } else if (m === 'build-settlement' || m === 'build-city') {
    const vid = pick('vertex', ui.highlights.vertices ?? []);
    if (vid) ui.pending = { vertexId: vid };
  } else if (m === 'move-robber') {
    const hid = pick('hex', ui.highlights.hexes ?? []);
    if (hid) {
      // 航海者たち: 海のヘックスなら海賊。奪える相手は「その海に船を出している人」
      const targets = isSeaHex(state.board, hid)
        ? pirateTargets(state, hid, HUMAN).filter((t) => totalCards(state.players[t]) > 0)
        : stealableTargets(state, hid, HUMAN);
      if (targets.length > 0) {
        ui.pending = null;
        ui.dialog = { type: 'steal', hexId: hid, targets, pirate: isSeaHex(state.board, hid) };
      } else {
        ui.pending = { hexId: hid };
      }
    }
  } else if (m === 'play-road-building') {
    const eid = pick('edge', ui.highlights.edges ?? []);
    if (eid && ui.pendingEdges.length < 2) ui.pendingEdges.push(eid);
  } else if ([
    'build-knight', 'build-wall', 'build-tower', 'move-knight', 'raze-city',
    'desert-pick', 'desert-place', 'knight-displace',
  ].includes(m)) {
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
  } else if (m === 'prog-moveroad') {
    const eid = pick('edge', ui.highlights.edges ?? []);
    if (eid && ui.pendingEdges.length < 2) ui.pendingEdges.push(eid);
  } else if (m === 'prog-knights') {
    const vid = pick('vertex', ui.highlights.vertices ?? []);
    if (vid && ui.pendingVertices.length < 2) ui.pendingVertices.push(vid);
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
      piece: ui.setupPiece,
    });
  } else if (m === 'build-road' && ui.pending?.edgeId) {
    doAction({ type: 'BUILD_ROAD', player: HUMAN, edgeId: ui.pending.edgeId });
  } else if (m === 'build-ship' && ui.pending?.edgeId) {
    doAction({ type: 'BUILD_SHIP', player: HUMAN, edgeId: ui.pending.edgeId });
  } else if (m === 'move-ship-to' && ui.shipFrom && ui.pending?.edgeId) {
    doAction({ type: 'MOVE_SHIP', player: HUMAN, from: ui.shipFrom, to: ui.pending.edgeId });
  } else if (m === 'fish-road' && ui.pending?.edgeId) {
    doAction({
      type: 'SPEND_FISH', player: HUMAN, use: 'road',
      params: { edgeId: ui.pending.edgeId },
    });
  } else if (m === 'build-settlement' && ui.pending?.vertexId) {
    doAction({ type: 'BUILD_SETTLEMENT', player: HUMAN, vertexId: ui.pending.vertexId });
  } else if (m === 'build-city' && ui.pending?.vertexId) {
    doAction({ type: 'BUILD_CITY', player: HUMAN, vertexId: ui.pending.vertexId });
  } else if (m === 'knight-displace' && ui.pending?.vertexId) {
    doAction({ type: 'PLACE_DISPLACED_KNIGHT', player: HUMAN, vertexId: ui.pending.vertexId });
  } else if (m === 'desert-pick' && ui.pending?.vertexId) {
    doAction({ type: 'PICK_DESERTER', player: HUMAN, vertexId: ui.pending.vertexId });
  } else if (m === 'desert-place' && ui.pending?.vertexId) {
    doAction({ type: 'PLACE_DESERTER', player: HUMAN, vertexId: ui.pending.vertexId });
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
  } else if (m === 'build-tower' && ui.pending?.vertexId) {
    doAction({ type: 'BUILD_TOWER', player: HUMAN, vertexId: ui.pending.vertexId });
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
  } else if (m === 'prog-moveroad' && ui.pendingEdges.length === 2 && ui.progIndex != null) {
    doAction({
      type: 'PLAY_PROGRESS_CARD', player: HUMAN,
      index: ui.progIndex, params: { edgeId: ui.pendingEdges[0], to: ui.pendingEdges[1] },
    });
  } else if (m === 'prog-knights' && ui.pendingVertices.length >= 1 && ui.progIndex != null) {
    doAction({
      type: 'PLAY_PROGRESS_CARD', player: HUMAN,
      index: ui.progIndex, params: { vertices: [...ui.pendingVertices] },
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
    ui.setupPiece = 'road';
  } else if ([
    'build-road', 'fish-road', 'build-ship', 'move-ship', 'move-ship-to',
    'build-settlement', 'build-city', 'play-road-building',
    'build-knight', 'build-wall', 'build-tower', 'move-knight',
    'prog-hex', 'prog-vertex', 'prog-edge', 'prog-hex2', 'prog-roads', 'prog-knights', 'prog-moveroad',
  ].includes(ui.mode)) {
    ui.mode = 'idle';
    ui.pending = null;
    ui.pendingEdges = [];
    ui.pendingHexes = [];
    ui.pendingVertices = [];
    ui.knightFrom = null;
    ui.shipFrom = null;
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
    case 'new-game':
      // オンラインでは勝手に盤面を作り直せない(サーバーが権威)
      if (isOnline()) leaveNet(true);
      else newGame();
      return;

    // ---- 画面フロー ----
    case 'goto-select': setScreen('select'); return;
    case 'goto-title':
      if (isOnline()) leaveNet(true);
      else setScreen('title');
      return;
    case 'goto-rules':
      if (screen !== 'rules') rulesFrom = screen;
      if (arg) rulesTab = arg;
      setScreen('rules');
      return;
    case 'demo': startDemo(arg, screen === 'rules' ? 'rules' : 'title'); return;
    case 'reload-app': location.reload(); return;

    // ---- オンライン対戦 ----
    case 'goto-online':
      online.error = null;
      setScreen('online');
      renderOnlinePanel();
      return;
    case 'net-create': {
      const name = document.getElementById('net-name')?.value.trim() || 'プレイヤー';
      online.busy = true;
      online.error = null;
      renderOnlinePanel();
      createRoom()
        .then((code) => {
          online.busy = false;
          startNet(code, name);
        })
        .catch((e) => {
          online.busy = false;
          // fetch の失敗はブラウザ既定の英語メッセージなので言い換える
          const why = /fetch|network|load failed/i.test(e.message)
            ? 'サーバーに接続できませんでした'
            : e.message;
          online.error = `${why}(接続先: ${serverBase()})`;
          renderOnlinePanel();
        });
      return;
    }
    case 'net-join': {
      const name = document.getElementById('net-name')?.value.trim() || 'プレイヤー';
      const code = (document.getElementById('net-code')?.value ?? '')
        .toUpperCase().replace(/[^A-Z]/g, '');
      if (code.length !== 4) {
        online.error = '合言葉は英字4文字です';
        renderOnlinePanel();
        return;
      }
      online.busy = false;
      startNet(code, name);
      return;
    }
    case 'net-server-save': {
      const url = document.getElementById('net-server')?.value.trim() ?? '';
      if (url) lsSet('server', url.replace(/\/$/, ''));
      else lsRemove('server');
      // ?server= の一時指定より保存を優先させる(明示的な操作なので上書きしてよい)
      const u = new URL(location.href);
      if (u.searchParams.has('server')) {
        u.searchParams.delete('server');
        history.replaceState(null, '', u);
      }
      online.error = null;
      ui.toast = `接続先を ${serverBase()} にしました`;
      renderOnlinePanel();
      refresh();
      return;
    }
    case 'net-mode': net?.setSettings({ mode: arg }); return;
    case 'net-diff': net?.setSettings({ difficulty: arg }); return;
    case 'net-dice': net?.setSettings({ diceMode: arg }); return;
    case 'net-fill': net?.setSettings({ cpuFill: arg === 'on' }); return;
    case 'net-start': net?.start(); return;
    case 'net-leave': leaveNet(true); return;
    case 'bgm-toggle':
      bgm.setEnabled(!bgm.enabled);
      settings.bgm = bgm.enabled;
      syncBgmButtons();
      refresh();
      return;
    case 'set-bgm':
      bgm.setEnabled(arg === 'on');
      settings.bgm = bgm.enabled;
      syncBgmButtons();
      refresh();
      return;
    case 'set-sfx':
      sfx.setEnabled(arg === 'on'); // オンにしたときは確認用に1音鳴る
      settings.sfx = sfx.enabled;
      refresh();
      return;
    case 'rules-back': setScreen(rulesFrom === 'rules' ? 'title' : rulesFrom); return;
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
    case 'set-dice': settings.diceMode = arg; refresh(); return;

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
      // 船の移動だけは build- を付けない専用モード
      ui.mode = arg === 'moveship' ? 'move-ship' : `build-${arg}`;
      ui.pending = null;
      ui.shipFrom = null;
      refresh();
      return;
    }

    // 初期配置: 開拓地と一緒に置く駒(道 or 船)の切り替え
    case 'setup-piece': {
      ui.setupPiece = arg === 'ship' ? 'ship' : 'road';
      ui.pending = null; // 選び直しになるので候補もいったん外す
      refresh();
      return;
    }

    // 手札の発展カードをタップ → まず説明ダイアログ(そこから「使う」)。
    // 使えないカードもタップできるようにして、理由が伝わるようにする。
    case 'dev-info': {
      const index = Number(arg);
      if (!state.players[HUMAN].devCards[index]) return;
      ui.dialog = { type: 'dev-info', index };
      refresh();
      return;
    }

    case 'dev-use': {
      const card = state.players[HUMAN].devCards[Number(arg)];
      if (!card) return;
      ui.dialog = null;
      startDevPlay(card.type);
      return;
    }

    case 'play-dev': startDevPlay(arg); return;

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
    // 全員に一斉提案する。CPU も人間も同じ「提案 → 応答 → 相手決定」の流れなので、
    // オンライン対戦でも相手のプレイヤーに交易を持ちかけられる。
    case 'pt-offer': {
      const { pgive, precv } = ui.dialog;
      doAction({
        type: 'OFFER_TRADE', player: HUMAN,
        give: { ...pgive }, receive: { ...precv },
      });
      return;
    }
    // 応じた相手の中から成立させる1人を選ぶ('none' で全部やめる)
    case 'trade-pick':
      doAction({
        type: 'CHOOSE_TRADE', player: HUMAN,
        partner: arg === 'none' ? null : Number(arg),
      });
      return;
    case 'aq':
      doAction({ type: 'PICK_AQUEDUCT', player: HUMAN, resource: arg });
      return;
    case 'gold':
      doAction({ type: 'PICK_GOLD', player: HUMAN, resource: arg });
      return;
    case 'ddeck':
      doAction({ type: 'PICK_DEFENDER_DECK', player: HUMAN, track: arg });
      return;
    case 'diplo': {
      const index = ui.dialog?.index;
      ui.dialog = null;
      ui.progIndex = index;
      ui.pending = null;
      ui.pendingEdges = [];
      ui.mode = arg === 'move' ? 'prog-moveroad' : 'prog-edge';
      refresh();
      return;
    }
    case 'pdisc':
      doAction({ type: 'DISCARD_PROGRESS', player: HUMAN, index: Number(arg) });
      return;

    // ---- 漁師たち ----
    case 'fish-open':
      ui.dialog = { type: 'fish', pick: null };
      refresh();
      return;
    case 'fish-back':
      ui.dialog.pick = null;
      refresh();
      return;
    case 'fish-use':
      if (arg === 'steal' || arg === 'resource') {
        ui.dialog.pick = arg;
        refresh();
      } else if (arg === 'road') {
        // 道は盤面から辺を選ぶのでダイアログを閉じる
        ui.dialog = null;
        ui.mode = 'fish-road';
        ui.pending = null;
        refresh();
      } else {
        doAction({ type: 'SPEND_FISH', player: HUMAN, use: arg });
      }
      return;
    case 'fish-steal':
      doAction({ type: 'SPEND_FISH', player: HUMAN, use: 'steal', params: { target: Number(arg) } });
      return;
    case 'fish-res':
      doAction({ type: 'SPEND_FISH', player: HUMAN, use: 'resource', params: { resource: arg } });
      return;
    case 'pass-shoe':
      doAction({ type: 'PASS_SHOE', player: HUMAN, target: Number(arg) });
      return;

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

    case 'harbor':
      doAction({ type: 'GIVE_HARBOR', player: HUMAN, commodity: arg });
      return;

    case 'wed-plus': ui.dialog.counts[arg]++; refresh(); return;
    case 'wed-minus': ui.dialog.counts[arg]--; refresh(); return;
    case 'wed-confirm':
      doAction({ type: 'GIVE_WEDDING', player: HUMAN, cards: { ...ui.dialog.counts } });
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

    case 'dicelog-open': ui.dialog = { type: 'dicelog' }; refresh(); return;

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
window.hexDebug = {
  getState: () => state,
  setState: (s) => { state = s; refresh(); scheduleCpu(); },
  doAction,
  newGameWith: (patch) => { Object.assign(settings, patch); setScreen('game'); newGame(); },
  getUi: () => ui,
  screenPos: (kind, id) => (renderer3d ? renderer3d.screenPos(kind, id) : null),
  getRenderer: () => renderer3d,
  getBgm: () => bgm,
  getViewState: () => ({ viewMode, has3d: !!renderer3d, failed: renderer3dFailed, screen }),
  // オンライン対戦(E2E用)
  getNet: () => ({
    connected: isOnline(),
    seat: net?.seat ?? null,
    status: online.status,
    code: online.code,
    lobby: online.lobby,
    isHost: isHost(),
  }),
  // あそびかたデモ(E2E用)
  startDemo: (id) => startDemo(id),
  getDemo: () => ({
    running: demoRunning,
    chapter: demoChapter?.id ?? null,
    beat: demoDriver?.beatIndex ?? -1,
    total: demoChapter?.beats.length ?? 0,
    caption: document.querySelector('#demo .demo-cap span')?.textContent ?? '',
  }),
  demoSkip: () => demoDriver?.skip(),
  demoStop: () => endDemo('back'),
  netJoin: (code, name) => startNet(code, name),
  netStart: () => net?.start(),
  netLeave: () => leaveNet(true),
};

// PWA: Service Worker 登録。
// updateViaCache: 'none' で sw.js の更新確認は常にネットワークへ。
// SW はネットワーク優先なので、オンライン時は必ず最新バージョンが表示される。
if ('serviceWorker' in navigator) {
  // 初回インストールか、更新かを見分けるために先に控えておく
  const hadController = !!navigator.serviceWorker.controller;
  let reloading = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    // 新しい SW が主導権を取った = コードが入れ替わった。
    // 読み込み済みの JS は古いままなので、一度だけ読み直す。
    if (!hadController || reloading) return; // 初回インストール時は不要
    reloading = true;
    location.reload();
  });

  navigator.serviceWorker
    .register('./sw.js', { updateViaCache: 'none' })
    .then((reg) => {
      reg.update();
      setInterval(() => reg.update(), 30 * 60 * 1000); // 長時間開きっぱなし対策
      // ホーム画面アプリは前面に戻っただけで再読込されないので、そこでも確認する
      document.addEventListener('visibilitychange', () => {
        if (!document.hidden) reg.update();
      });
    })
    .catch((e) => console.warn('SW登録失敗:', e));
}

// 起動: タイトル画面。背景用にCPUなしの盤面を1つ生成して飾る
document.body.dataset.screen = screen;
showTitleBoard();
syncBgmButtons();
refresh();
if (viewMode === '3d') ensureRenderer3d().then(() => state && refresh());

// 起動時と、アプリを前面に戻したときに版を確認する(PWAは再読込されにくいため)
checkForUpdate();
document.addEventListener('visibilitychange', () => {
  if (!document.hidden && screen === 'title') checkForUpdate();
});
