// HUD 描画(設計書 §8.2)
// 手札・ボタン・ダイアログは DOM で作る。クリックは data-act 属性で main.js に委譲。

import { RESOURCES, RES_JP, DEV_JP } from '../state.js';
import { COSTS, WALL_COST, canAfford, piecesLeft, totalCards, wallsLeft } from '../rules/build.js';
import { computePoints, pointsToWin } from '../rules/victory.js';
import { tradeRate } from '../rules/trade.js';
import { diceDeckLeft } from '../rules/dice.js';
import { KNIGHT_COSTS } from '../rules/cak/knights.js';
import { TOWER_COST } from '../rules/dragon.js';
import { FISH_USES, fishCount, hasOldShoe, shoeTargets } from '../rules/fish.js';
import { SHIP_COST, SHIP_LIMIT, movableShips } from '../rules/sea.js';
import { BARBARIAN_TRACK_LENGTH, knightContribution, barbarianStrength } from '../rules/cak/barbarians.js';
import {
  TRACKS, TRACK_JP, TRACK_COMMODITY, MAX_IMPROVEMENT,
  improvementCost, canBuyImprovement,
} from '../rules/cak/improvements.js';
import { COMMODITIES, COM_JP, PROGRESS_CARDS } from '../rules/cak/progress-cards.js';
import { validateAction, MAX_OFFERS_PER_TURN } from '../actions.js';
import { rulesHtml } from './rules-content.js';
import { PLAYER_COLORS } from './board-render.js';
import { avatarSvg } from './avatars.js';

// 自分の席番号。ローカル戦は常に 0、オンライン対戦ではサーバーが割り当てた席になる。
let HUMAN = 0;

export function setHumanSeat(seat) {
  HUMAN = seat;
}

export const RES_ICON = { wood: '🪵', brick: '🧱', sheep: '🐑', wheat: '🌾', ore: '🪨' };
export const COM_ICON = { cloth: '🧵', coin: '🪙', paper: '📜' };
export const DEV_ICON = { knight: '⚔️', roadBuilding: '🛤️', yearOfPlenty: '🧺', monopoly: '🎩', vp: '⭐' };
const EV_ICON = { ship: '⛵', trade: '🧵', politics: '🪙', science: '📜' };
const PIECE_JP = { road: '道', settlement: '開拓地', city: '都市' };
const PIECE_ICON = { road: '🛤️', settlement: '🏠', city: '🏰' };
const TRACK_ICON = { trade: '🧵', politics: '🪙', science: '📜' };

function el(id) {
  return document.getElementById(id);
}

function renderPlayers(state, ui) {
  const cak = state.mode === 'cak';
  el('players').innerHTML = state.players
    .map((p) => {
      // 古い靴を持っている人だけ必要点数が1点重い(公開情報)
      const goal = pointsToWin(state, p.id);
      const expanded = ui.expandedPlayer === p.id;
      const pts = computePoints(state, p.id, { includeHidden: p.id === HUMAN });
      const active =
        state.awaiting ? state.awaiting.players.includes(p.id) : state.currentPlayer === p.id;
      const metro = cak
        ? Object.values(state.metropolis).filter(
            (v) => v != null && state.buildings[v]?.player === p.id,
          ).length
        : 0;
      const badges = [
        state.longestRoad.player === p.id ? '<span class="badge">🛤 最長交易路</span>' : '',
        !cak && state.largestArmy.player === p.id ? '<span class="badge">⚔ 最大騎士力</span>' : '',
        metro > 0 ? `<span class="badge">🏙 メトロポリス×${metro}</span>` : '',
        cak && p.defenderPoints > 0 ? `<span class="badge">🛡×${p.defenderPoints}</span>` : '',
        p.treasures > 0 ? `<span class="badge">💎×${p.treasures}</span>` : '',
        // 魚トークンは場に公開して置くもの。全員ぶん見えてよい
        fishCount(p) > 0 ? `<span class="badge">🐟×${fishCount(p)}</span>` : '',
        hasOldShoe(p) ? '<span class="badge">👞 古い靴</span>' : '',
        // 航海者たち: 本島以外に入植した島の数(1つ+2点)
        (p.islands ?? []).filter((i) => i !== 0).length > 0
          ? `<span class="badge">🏝×${(p.islands ?? []).filter((i) => i !== 0).length}</span>`
          : '',
      ].join('');
      // 残りコマは全員ぶん公開情報(盤上を数えれば分かる)。
      // 「相手はもう開拓地を建てられない」が読めると駆け引きになる。
      const stock = `<span class="stockrow" title="手元に残っているコマ(道/開拓地/都市)">${
        ['road', 'settlement', 'city']
          .map((t) => {
            const n = piecesLeft(state, p.id, t);
            return `<i class="${n === 0 ? 'out' : ''}">${PIECE_ICON[t]}${n}</i>`;
          })
          .join('')
      }</span>`;
      const info = cak
        ? `<span title="手札">🂠 ${totalCards(p)}</span>
           <span title="進歩カード">📜 ${p.progressCards.length}</span>
           <span title="防衛力">⚔️ ${knightContribution(state, p.id)}</span>
           <span title="都市改良(交易/政治/科学)" class="imp">${TRACKS.map(
             (t) => `${TRACK_ICON[t]}${p.improvements[t]}`,
           ).join(' ')}</span>`
        : `<span title="手札">🂠 ${totalCards(p)}</span>
           <span title="発展カード">📜 ${p.devCards.length}</span>
           <span title="使用済み騎士">⚔️ ${p.knightsPlayed}</span>`;
      return `
      <div class="player ${active ? 'active' : ''} ${expanded ? 'expanded' : ''}"
        style="--pc:${PLAYER_COLORS[p.id]}" data-act="pexpand:${p.id}">
        <div class="prow">
          <span class="chip">${avatarSvg(p.id)}</span>
          <span class="pname">${p.name}</span>
          <span class="ppts">${pts}<small>/${goal}</small></span>
        </div>
        <div class="prow pinfo">${info}${stock}${badges}</div>
      </div>`;
    })
    .join('');
}

// 蛮族トラック(cak)
function renderBarbarians(state) {
  const elB = el('barb');
  if (state.mode !== 'cak') {
    elB.innerHTML = '';
    return;
  }
  const pos = state.barbarians.position;
  const cells = Array.from({ length: BARBARIAN_TRACK_LENGTH }, (_, i) =>
    `<span class="bcell ${i < pos ? 'past' : ''} ${i === pos ? 'here' : ''}">${i === pos ? '⛵' : ''}</span>`,
  ).join('');
  elB.innerHTML = `
    <span class="blabel">蛮族</span>${cells}<span class="bgoal">🏝</span>
    <span class="bdef" title="蛮族の強さ(都市数) vs 防衛力(活性騎士Lv合計)">
      ⚔${barbarianStrength(state)} vs 🛡${state.players.reduce((s, p) => s + knightContribution(state, p.id), 0)}
    </span>`;
}

const DICE_TOTALS = [2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12];

function diceCountOf(state, n) {
  return state.diceCounts?.[n] ?? 0;
}

function rollTotal(state) {
  return DICE_TOTALS.reduce((s, n) => s + diceCountOf(state, n), 0);
}

// 出目の記録。2〜12 が何回出たかを棒グラフで出す。
function diceLogHtml(state) {
  const rolls = rollTotal(state);
  if (rolls === 0) {
    return `<h3>📊 出目の記録</h3>
      <p>まだダイスを振っていません。振るとここに回数がたまります。</p>
      <div class="row end"><button data-act="dialog-cancel">閉じる</button></div>`;
  }
  const top = Math.max(...DICE_TOTALS.map((n) => diceCountOf(state, n)), 1);
  const bars = DICE_TOTALS.map((n) => {
    const c = diceCountOf(state, n);
    return `<div class="dbar ${n === 7 ? 'seven' : ''}" title="${n}: ${c}回">
      <span class="dbnum">${c}</span>
      <span class="dbcol"><i style="height:${(c / top) * 100}%"></i></span>
      <span class="dblabel">${n}</span>
    </div>`;
  }).join('');
  const seven = diceCountOf(state, 7);
  return `<h3>📊 出目の記録</h3>
    <p>これまで<b>${rolls}回</b>ふりました(7は<b>${seven}回</b>)。</p>
    <div class="dchart">${bars}</div>
    <p><small>${state.diceMode === 'balanced'
      ? '⚖️ バランスダイス: 36通りの山札から引いています'
      : '🎰 純ランダム: 毎回ゼロから2個振っています'}</small></p>
    <div class="row end"><button data-act="dialog-cancel">閉じる</button></div>`;
}

const PIP_LAYOUT = {
  1: [4], 2: [0, 8], 3: [0, 4, 8], 4: [0, 2, 6, 8], 5: [0, 2, 4, 6, 8], 6: [0, 2, 3, 5, 6, 8],
};

function dieHtml(n) {
  const cells = Array.from({ length: 9 }, (_, i) =>
    `<i class="${PIP_LAYOUT[n].includes(i) ? 'on' : ''}"></i>`,
  ).join('');
  return `<span class="die">${cells}</span>`;
}

function renderDice(state) {
  const d = state.dice;
  const left = diceDeckLeft(state);
  const deck = left == null
    ? ''
    : `<span class="ddeck" title="バランスダイス: 36通りの山札から引いています(残り${left}通り)">🂠${left}</span>`;
  // 右端に「山札の残り」と「出目の記録」をまとめる
  const right = `<span class="dright">${deck}<button class="dstats" data-act="dicelog-open"
    title="出目の記録を見る(${rollTotal(state)}回ぶん)">📊</button></span>`;
  const ev = state.mode === 'cak' && state.eventDie && d
    ? `<span class="evdie" title="イベントダイス">${EV_ICON[state.eventDie]}</span>`
    : state.mode === 'cak'
      ? '<span class="evdie empty"></span>'
      : '';
  el('dice').innerHTML = (d
    ? `${dieHtml(d[0])}${dieHtml(d[1])}${ev}<span class="dsum">${d[0] + d[1]}</span>`
    : `<span class="die empty"></span><span class="die empty"></span>${ev}<span class="dsum">–</span>`)
    + right;
}

// 発展カード(基本モード)の説明文
const DEV_DESC = {
  knight: '盗賊を好きなヘックスへ動かし、隣接する相手から資源を1枚奪います。3枚使うと最大騎士力(+2点)。',
  roadBuilding: '道を2本まで無料で建設します。使うと盤面が光るので、建てたい辺をタップして選びます。',
  yearOfPlenty: '銀行から好きな資源を2枚もらいます。',
  monopoly: '資源を1種類選び、全員の手札からその資源を全て奪います。',
  vp: '持っているだけで+1点。使うカードではありません(得点は自動で入ります)。',
};

// 発展カードが「今」使えない理由(使えるなら null)
function devPlayableWhy(state, card) {
  if (card.type === 'vp') return '勝利点カードは使いません(持っているだけで+1点)';
  if (state.phase !== 'main' || state.currentPlayer !== HUMAN || state.awaiting) {
    return '自分の手番に使えます';
  }
  if (card.boughtTurn >= state.turn) return '購入したターンには使えません';
  if (state.turnFlags.playedDev) return 'このターンはすでに発展カードを使いました';
  if (card.type !== 'knight' && !state.turnFlags.rolled) return 'ダイスを振ったあとに使えます';
  return null;
}

// 進歩カードが「今」使えるか(手番・タイミング・獲得ターン)
function progressPlayable(state, card) {
  const def = PROGRESS_CARDS[card.id];
  const isMyTurn =
    state.phase === 'main' && state.currentPlayer === HUMAN && !state.awaiting;
  const timing = def.preRoll ? !state.turnFlags.rolled : state.turnFlags.rolled;
  return isMyTurn && timing && card.boughtTurn < state.turn;
}

function renderHand(state, ui) {
  const p = state.players[HUMAN];
  const cak = state.mode === 'cak';
  const res = RESOURCES.map(
    (r) => `<div class="card card-${r} ${p.resources[r] === 0 ? 'zero' : ''}">
      <div class="icon">${RES_ICON[r]}</div>
      <div class="label">${RES_JP[r]}</div>
      <div class="cnt">${p.resources[r]}</div>
    </div>`,
  ).join('');

  const coms = cak
    ? COMMODITIES.map(
        (c) => `<div class="card card-com ${p.commodities[c] === 0 ? 'zero' : ''}">
        <div class="icon">${COM_ICON[c]}</div>
        <div class="label">${COM_JP[c]}</div>
        <div class="cnt">${p.commodities[c]}</div>
      </div>`,
      ).join('')
    : '';

  let extra = '';
  if (cak) {
    extra = p.progressCards
      .map((c, i) => {
        const def = PROGRESS_CARDS[c.id];
        // 説明を見られるよう常にタップ可(使えないカードは薄く表示)
        const playable = progressPlayable(state, c);
        return `<button class="card dev ${playable ? '' : 'dim'}" data-act="play-prog:${i}"
          title="${def.desc ?? '進歩カード'}">
          <div class="icon">${def.icon}</div>
          <div class="label">${def.name}</div></button>`;
      })
      .join('');
  } else {
    extra = p.devCards
      .map((c, i) => {
        // 進歩カードと同じく、使えないカードもタップできる(理由を説明ダイアログで出す)
        const playable = !devPlayableWhy(state, c);
        return `<button class="card dev ${playable ? '' : 'dim'}" data-act="dev-info:${i}"
          title="${DEV_DESC[c.type]}">
          <div class="icon">${DEV_ICON[c.type]}</div>
          <div class="label">${DEV_JP[c.type]}</div></button>`;
      })
      .join('');
  }
  const handEl = el('hand');
  // main行(資源+商品)は枚数固定なのでモバイルでは均等幅1行に収める。
  // extra行(進歩/発展カード)は枚数可変なので別行。
  handEl.innerHTML =
    `<div class="hrow main">${res}${coms ? `<div class="sep"></div>${coms}` : ''}</div>` +
    (extra ? `<div class="hrow extra">${extra}</div>` : '');
}

function renderControls(state, ui) {
  const p = state.players[HUMAN];
  const myTurn = state.phase === 'main' && state.currentPlayer === HUMAN && !state.awaiting;
  const rolled = state.turnFlags.rolled;
  const cak = state.mode === 'cak';
  const mobile = document.body.classList.contains('mobile');
  const btn = (act, label, enabled, title = '', stock = null) => {
    const badge = stock == null
      ? ''
      : `<span class="stock ${stock === 0 ? 'out' : ''}">${stock}</span>`;
    return `<button data-act="${act}" ${enabled ? '' : 'disabled'} title="${title}">${label}${badge}</button>`;
  };

  // 資源が足りていても、手元のコマが尽きていれば建てられない(公式ルール)。
  // 残数をボタンに出して、コマ切れを事前に読めるようにする。
  const pieceBtn = (act, label, type, cost, costHint) => {
    const n = piecesLeft(state, HUMAN, type);
    const title = n > 0
      ? `${costHint}(残り${n}個)`
      : type === 'settlement'
        ? '開拓地のコマがありません(都市にすると1つ手元に戻ります)'
        : `${PIECE_JP[type]}のコマがありません`;
    return btn(act, label, myTurn && rolled && canAfford(p, cost) && n > 0, title, n);
  };

  const buildBtns = (road, settlement, city) => [
    pieceBtn('mode:road', road, 'road', COSTS.road, '🪵1 🧱1'),
    pieceBtn('mode:settlement', settlement, 'settlement', COSTS.settlement, '🪵1 🧱1 🐑1 🌾1'),
    pieceBtn('mode:city', city, 'city', COSTS.city, '🌾2 🪨3'),
  ];
  const cakBtns = (knight, wall, improve) => [
    btn('mode:knight', knight, myTurn && rolled && canAfford(p, KNIGHT_COSTS.build), '🐑1 🪨1(不活性で配置。各レベル2体まで)'),
    btn('mode:wall', wall, myTurn && rolled && canAfford(p, WALL_COST) && wallsLeft(state, HUMAN) > 0,
      `🧱2(手札上限+2。残り${wallsLeft(state, HUMAN)}枚)`, wallsLeft(state, HUMAN)),
    btn('improve-open', improve, myTurn && rolled, '商品で都市を改良'),
  ];
  const devLeft = state.bank.devDeck.length;
  const devBtn = (label) =>
    btn('buy-dev', label, myTurn && rolled && canAfford(p, COSTS.devCard) && devLeft > 0,
      devLeft > 0 ? `🐑1 🌾1 🪨1(山札の残り${devLeft}枚)` : '発展カードの山札がなくなりました', devLeft);
  const dragonMode = state.mode === 'dragon';
  const towerBtn = (label) =>
    btn('mode:tower', label, myTurn && rolled && canAfford(p, TOWER_COST), '🪵1 🧱1 🪨1(隣接ヘックスの襲撃を撃退して財宝)');
  const seaMode = state.mode === 'sea';
  const shipsLeft = SHIP_LIMIT - Object.values(state.ships ?? {}).filter((x) => x.player === HUMAN).length;
  const shipBtn = (label) =>
    btn('mode:ship', label, myTurn && rolled && canAfford(p, SHIP_COST) && shipsLeft > 0,
      `🪵1 🐑1(海に面した辺。残り${shipsLeft}隻)`, shipsLeft);
  const moveShipBtn = (label) =>
    btn('mode:moveship', label,
      myTurn && rolled && !state.turnFlags.movedShip && movableShips(state, HUMAN).length > 0,
      state.turnFlags.movedShip
        ? 'この手番はもう船を動かしました'
        : '航路の先端にある船を1隻だけ動かせます');
  const fishMode = state.mode === 'fish';
  // 魚は2匹から使える(盗賊を戻すのだけはロール前でも押せる)。
  // 古い靴を持っているときは、渡すために魚0匹でも開ける。
  const canFish = fishCount(p) >= 2 || hasOldShoe(p);
  const fishBtn = (label) =>
    btn('fish-open', label + (hasOldShoe(p) ? '👞' : ''), myTurn && canFish,
      canFish ? '魚トークンを使う(お釣りは出ません)' : '魚が2匹たまると使えます',
      fishCount(p));

  let list;
  if (mobile) {
    // モバイル: 4列×2段のグリッド。ロール/終了は同時に使わないので1ボタンに統合
    const flow = myTurn && rolled
      ? btn('end-turn', '⏭終了', true)
      : btn('roll', '🎲ロール', myTurn && !rolled);
    list = [
      flow,
      ...buildBtns('🛤道', '🏠開拓', '🏰都市'),
      ...(cak ? cakBtns('⚔️騎士', '🧱城壁', '🏙改良')
        : dragonMode ? [devBtn('📜カード'), towerBtn('🗼塔')]
        : fishMode ? [devBtn('📜カード'), fishBtn('🐟魚')]
        : seaMode ? [devBtn('📜カード'), shipBtn('⛵船'), moveShipBtn('🧭移動')]
        : [devBtn('📜カード')]),
      btn('trade-open', '⚖️交易', myTurn && rolled),
    ];
  } else {
    list = [
      btn('roll', '🎲 ロール', myTurn && !rolled),
      ...buildBtns('🛤️ 道', '🏠 開拓地', '🏰 都市'),
      ...(cak ? cakBtns('⚔️ 騎士', '🧱 城壁', '🏙 改良')
        : dragonMode ? [devBtn('📜 カード'), towerBtn('🗼 見張り塔')]
        : fishMode ? [devBtn('📜 カード'), fishBtn('🐟 魚')]
        : seaMode ? [devBtn('📜 カード'), shipBtn('⛵ 船'), moveShipBtn('🧭 船を動かす')]
        : [devBtn('📜 カード')]),
      btn('trade-open', '⚖️ 交易', myTurn && rolled),
      btn('end-turn', '⏭ ターン終了', myTurn && rolled),
    ];
  }

  el('controls').innerHTML = list.join('');
}

function statusText(state, ui) {
  if (state.phase === 'ended') {
    return `🏆 ${state.players[state.winner].name}の勝利!`;
  }
  if (ui.toast) return `⚠ ${ui.toast}`;
  const aw = state.awaiting;
  if (aw?.players.includes(HUMAN)) {
    if (aw.type === 'setupPlacement') {
      return ui.mode === 'setup-road'
        ? '🛤️ 開拓地に隣接する道の位置を選んでください'
        : `🏠 初期配置(${aw.context.round}巡目): 開拓地の位置を選んでください`;
    }
    if (aw.type === 'discard') return `🂠 手札を${aw.context.required[HUMAN]}枚捨ててください`;
    if (aw.type === 'aqueduct') return '💧 水道橋: もらう資源を選んでください';
    if (aw.type === 'moveRobber') {
      if (state.mode === 'dragon') return '🐉 ドラゴンの移動先ヘックスを選んでください';
      if (state.mode === 'sea') return '🥷 盗賊(陸)か 🏴‍☠️ 海賊(海)の移動先を選んでください';
      return '🥷 盗賊の移動先ヘックスを選んでください';
    }
    if (aw.type === 'goldChoice') return '💰 金鉱: もらう資源を選んでください';
    if (aw.type === 'barbarianDefense') return '⚔️ 降格させる都市を選んでください';
    if (aw.type === 'tradeChoose') return '🤝 交換する相手を選んでください';
  } else if (aw) {
    const waiting = aw.players.map((i) => state.players[i].name).join('・');
    if (aw.type === 'tradeOffer') {
      // 何人が応じたかはこの時点で全員に見えている情報(成立すれば公開される)
      const yes = Object.values(aw.context.replies ?? {}).filter(Boolean).length;
      return `⏳ 交易の返事待ち: ${waiting}(応じた ${yes}人)`;
    }
    return `⏳ ${waiting}の応答待ち...`;
  }
  switch (ui.mode) {
    case 'build-road': return '🛤️ 道を建てる辺を選んでください';
    case 'build-settlement': return '🏠 開拓地を建てる頂点を選んでください';
    case 'build-city': return '🏰 都市に昇格する開拓地を選んでください';
    case 'build-knight': return '⚔️ 騎士を配置する頂点を選んでください(自分の道に接続)';
    case 'build-wall': return '🧱 城壁を建てる都市を選んでください';
    case 'build-tower': return '🗼 見張り塔を建てる自分の建物を選んでください';
    case 'fish-road': return '🐟 魚5匹で建てる道の位置を選んでください';
    case 'build-ship': return '⛵ 船を建てる辺を選んでください(海に面した辺)';
    case 'move-ship': return '🧭 動かす船を選んでください';
    case 'move-ship-to': return '🧭 その船をどこへ動かしますか?';
    case 'move-knight': return '⚔️ 騎士の移動先を選んでください';
    case 'play-road-building':
      return `🛤️ 街道建設: 光っている辺をタップして道を選びます(あと${2 - ui.pendingEdges.length}本)`;
    case 'prog-hex': case 'prog-vertex': case 'prog-edge': case 'prog-hex2': case 'prog-roads': {
      const card = state.players[HUMAN].progressCards[ui.progIndex];
      const def = card ? PROGRESS_CARDS[card.id] : null;
      const label = def ? `${def.icon} ${def.name}` : '進歩カード';
      if (ui.mode === 'prog-hex') return `${label}: 対象のヘックスを選んでください`;
      if (ui.mode === 'prog-vertex') return `${label}: 対象の頂点を選んでください`;
      if (ui.mode === 'prog-edge') return `${label}: 取り除く道を選んでください`;
      if (ui.mode === 'prog-hex2') return `${label}: 交換する数字を選択(${ui.pendingHexes.length}/2)`;
      return `${label}: 光っている辺をタップして道を選びます(あと${2 - ui.pendingEdges.length}本)`;
    }
    default:
      if (state.phase === 'main') {
        return state.currentPlayer === HUMAN
          ? state.turnFlags.rolled ? '✨ あなたの手番です(建設・交易・カード)' : '🎲 ダイスを振ってください'
          : `⏳ ${state.players[state.currentPlayer].name}の手番...`;
      }
      return '';
  }
}

function renderStatus(state, ui) {
  const cancellable = [
    'build-road', 'build-settlement', 'build-city', 'play-road-building',
    'build-knight', 'build-wall', 'move-knight',
    'prog-hex', 'prog-vertex', 'prog-edge', 'prog-hex2', 'prog-roads',
  ].includes(ui.mode) || (ui.mode === 'setup-road');
  const confirmable =
    (ui.pending != null) ||
    (['play-road-building', 'prog-roads'].includes(ui.mode) && ui.pendingEdges.length >= 1) ||
    (ui.mode === 'prog-hex2' && ui.pendingHexes.length === 2);
  el('status').innerHTML = `
    <span class="msg">${statusText(state, ui)}</span>
    ${confirmable ? '<button class="primary" data-act="confirm">✓ 確定</button>' : ''}
    ${cancellable ? '<button data-act="cancel">↩ やり直す</button>' : ''}
  `;
}

function renderLog(state) {
  const logEl = el('log');
  logEl.innerHTML = state.log.slice(-60).map((l) => `<div>${l}</div>`).join('');
  logEl.scrollTop = logEl.scrollHeight;
}

// ---- ダイアログ ----

function dialogHtml(state, ui) {
  const d = ui.dialog;
  if (!d) return '';
  const p = state.players[HUMAN];

  if (d.type === 'trade') {
    const cak = state.mode === 'cak';
    const keys = cak ? [...RESOURCES, ...COMMODITIES] : RESOURCES;
    const icon = (k) => RES_ICON[k] ?? COM_ICON[k];
    const jp = (k) => RES_JP[k] ?? COM_JP[k];
    const have = (k) => (RES_ICON[k] ? p.resources[k] : p.commodities[k]);

    const tabs = `<div class="seg">
      <button class="${d.tab === 'bank' ? 'sel' : ''}" data-act="trade-tab:bank">🏦 銀行/港</button>
      <button class="${d.tab === 'players' ? 'sel' : ''}" data-act="trade-tab:players">🤝 プレイヤー</button>
    </div>`;

    if (d.tab === 'players') {
      const sum = (obj) => Object.values(obj).reduce((a, b) => a + b, 0);
      // showMax: 自分の手札のときだけ上限を出す。もらう側に数字を出すと
      // 「相手が何枚持っているか」に見えてしまうので出さない。
      const chipRow = (selected, addAct, subAct, maxOf, showMax) => keys.map((r) => {
        const n = selected[r] ?? 0;
        const ok = maxOf(r) > n;
        return `<button class="pick tchip ${n ? 'sel' : ''}" data-act="${addAct}:${r}" ${ok || n ? '' : 'disabled'}>
          <span class="picon">${icon(r)}</span>${jp(r)}
          ${n ? `<span class="tbadge" data-act="${subAct}:${r}">− ${n}</span>` : showMax ? `<small>${maxOf(r)}</small>` : ''}
        </button>`;
      }).join('');
      // 提案は全員へ一斉に送る。誰が応じたかを見てから相手を決める。
      const ready = sum(d.pgive) > 0 && sum(d.precv) > 0;
      const err = ready
        ? validateAction(state, {
            type: 'OFFER_TRADE', player: HUMAN,
            give: { ...d.pgive }, receive: { ...d.precv },
          })
        : '渡すものともらうものを選んでください';
      const left = MAX_OFFERS_PER_TURN - (state.turnFlags.offers ?? 0);
      return `<h3>⚖️ 交易</h3>${tabs}
        <p>渡すもの(タップで追加、バッジで減らす)</p>
        <div class="row">${chipRow(d.pgive, 'ptg-add', 'ptg-sub', (r) => have(r), true)}</div>
        <p>もらうもの</p>
        <div class="row">${chipRow(d.precv, 'ptr-add', 'ptr-sub', () => 6, false)}</div>
        <p><small>全員に同じ内容で持ちかけます。応じた人が複数なら、そのあと相手を選べます。
          相手が持っているかは分かりません。</small></p>
        <div class="row end">
          <button class="primary" data-act="pt-offer" ${err ? 'disabled' : ''} title="${err ?? ''}">
            🤝 全員に提案<span class="stock ${left === 0 ? 'out' : ''}">${left}</span></button>
          <button data-act="dialog-cancel">閉じる</button>
        </div>`;
    }

    const stock = (k) =>
      RES_ICON[k] ? state.bank.resources[k] : state.bank.commodities[k];
    const giveBtns = keys.map((r) => {
      const rate = tradeRate(state, HUMAN, r);
      const ok = have(r) >= rate;
      return `<button class="pick ${d.give === r ? 'sel' : ''}" data-act="trade-give:${r}" ${ok ? '' : 'disabled'}>
        <span class="picon">${icon(r)}</span>${jp(r)}<small>${rate}:1</small></button>`;
    }).join('');
    const recvBtns = keys.map((r) => {
      const ok = stock(r) > 0 && r !== d.give;
      return `<button class="pick ${d.receive === r ? 'sel' : ''}" data-act="trade-receive:${r}" ${ok ? '' : 'disabled'}>
        <span class="picon">${icon(r)}</span>${jp(r)}</button>`;
    }).join('');
    return `<h3>⚖️ 交易</h3>${tabs}
      <p>渡すもの</p><div class="row">${giveBtns}</div>
      <p>もらうもの</p><div class="row">${recvBtns}</div>
      <div class="row end">
        <button class="primary" data-act="trade-confirm" ${d.give && d.receive ? '' : 'disabled'}>交易する</button>
        <button data-act="dialog-cancel">閉じる</button>
      </div>`;
  }

  // 漁師たち: 魚トークンの使い道を選ぶ
  if (d.type === 'fish') {
    const n = fishCount(p);
    const tokens = (p.fish ?? [])
      .map((t) => (t === 'shoe'
        ? '<span class="pick tchip">👞 古い靴</span>'
        : `<span class="pick tchip sel"><span class="picon">🐟</span>${t}匹</span>`))
      .join('');
    const head = `<h3>🐟 魚トークン(${n}匹)</h3><div class="row">${tokens || '<small>まだ持っていません</small>'}</div>`;
    const back = '<div class="row end"><button data-act="fish-back">← 戻る</button></div>';

    if (d.pick === 'steal') {
      const btns = state.players
        .filter((o) => o.id !== HUMAN && totalCards(o) > 0)
        .map((o) => `<button class="pick" data-act="fish-steal:${o.id}" style="--pc:${PLAYER_COLORS[o.id]}">
          <span class="chip">${avatarSvg(o.id)}</span>${o.name}<small>${totalCards(o)}枚</small></button>`)
        .join('');
      return `${head}<p>誰から1枚奪いますか?(魚3匹)</p>
        <div class="row">${btns || '<small>手札を持っている相手がいません</small>'}</div>${back}`;
    }
    if (d.pick === 'resource') {
      const btns = RESOURCES.map(
        (r) => `<button class="pick" data-act="fish-res:${r}" ${state.bank.resources[r] > 0 ? '' : 'disabled'}>
          <span class="picon">${RES_ICON[r]}</span>${RES_JP[r]}</button>`,
      ).join('');
      return `${head}<p>もらう資源を選んでください(魚4匹)</p><div class="row">${btns}</div>${back}`;
    }

    const rolled = state.turnFlags.rolled;
    const others = state.players.some((o) => o.id !== HUMAN && totalCards(o) > 0);
    const bankHasAny = RESOURCES.some((r) => state.bank.resources[r] > 0);
    const reason = (use) => {
      const { cost } = FISH_USES[use];
      if (n < cost) return `魚が${cost}匹必要です`;
      if (use !== 'robber' && !rolled) return '先にダイスを振ってください';
      if (use === 'robber' && state.board.robber === state.board.lake) return '盗賊はすでに湖にいます';
      if (use === 'steal' && !others) return '手札を持っている相手がいません';
      if (use === 'resource' && !bankHasAny) return '銀行に在庫がありません';
      if (use === 'road' && piecesLeft(state, HUMAN, 'road') === 0) return '道のコマがありません';
      if (use === 'dev' && state.bank.devDeck.length === 0) return '発展カードの山札がありません';
      return null;
    };
    const rows = Object.entries(FISH_USES)
      .map(([key, u]) => {
        const err = reason(key);
        return `<div class="drow fishuse">
          <span>🐟×${u.cost} <b>${u.jp}</b><small>${err ?? u.desc}</small></span>
          <button data-act="fish-use:${key}" ${err ? 'disabled' : ''} title="${err ?? ''}">使う</button>
        </div>`;
      })
      .join('');
    // 古い靴: 自分と同点以上の相手にだけ押しつけられる
    let shoe = '';
    if (hasOldShoe(p)) {
      const targets = shoeTargets(state, HUMAN, (id) => computePoints(state, id));
      const btns = targets
        .map((id) => `<button class="pick" data-act="pass-shoe:${id}" style="--pc:${PLAYER_COLORS[id]}">
          <span class="chip">${avatarSvg(id)}</span>${state.players[id].name}
          <small>${computePoints(state, id)}点</small></button>`)
        .join('');
      shoe = `<p>👞 古い靴(勝利に必要な点数+1)</p>
        <div class="row">${btns || '<small>自分と同点以上の相手がいないので、いまは渡せません</small>'}</div>`;
    }
    return `${head}
      <p><small>お釣りは出ません(ちょうど払えないときは超過した分が捨てになります)。</small></p>
      ${rows}${shoe}
      <div class="row end"><button data-act="dialog-cancel">閉じる</button></div>`;
  }

  // 航海者たち: 金鉱でもらう資源を選ぶ
  if (d.type === 'gold') {
    const left = state.awaiting?.context?.left?.[HUMAN] ?? 1;
    const btns = RESOURCES.map(
      (r) => `<button class="pick" data-act="gold:${r}" ${state.bank.resources[r] > 0 ? '' : 'disabled'}>
        <span class="picon">${RES_ICON[r]}</span>${RES_JP[r]}</button>`,
    ).join('');
    return `<h3>💰 金鉱</h3>
      <p>好きな資源をもらえます(あと${left}枚)</p>
      <div class="row">${btns}</div>`;
  }

  if (d.type === 'aqueduct') {
    const btns = RESOURCES.map(
      (r) => `<button class="pick" data-act="aq:${r}" ${state.bank.resources[r] > 0 ? '' : 'disabled'}>
        <span class="picon">${RES_ICON[r]}</span>${RES_JP[r]}</button>`,
    ).join('');
    return `<h3>💧 水道橋(科学Lv3)</h3>
      <p>出目で資源がもらえなかったので、好きな資源を1枚もらえます</p>
      <div class="row">${btns}</div>`;
  }

  if (d.type === 'tradeOffer') {
    const aw = state.awaiting;
    if (aw?.type !== 'tradeOffer') return '';
    const from = state.players[aw.context.from];
    const chips = (obj) =>
      Object.entries(obj)
        .map(
          ([r, n]) => `<span class="pick tchip sel">
            <span class="picon">${RES_ICON[r] ?? COM_ICON[r]}</span>${RES_JP[r] ?? COM_JP[r]}<small>×${n}</small></span>`,
        )
        .join('');
    const short = Object.entries(aw.context.receive).some(
      ([r, n]) => (RES_ICON[r] ? p.resources[r] : p.commodities[r]) < n,
    );
    return `<h3>💬 <span class="chip">${avatarSvg(from.id)}</span> ${from.name}からの交易提案</h3>
      <p>もらえるもの</p><div class="row">${chips(aw.context.give)}</div>
      <p>渡すもの${short ? '(手札が足りません)' : ''}</p><div class="row">${chips(aw.context.receive)}</div>
      <p><small>同じ提案が全員に届いています。応じた人が複数なら、${from.name}が相手を選びます。</small></p>
      <div class="row end">
        <button class="primary" data-act="offer-accept" ${short ? 'disabled' : ''}>🤝 交換する</button>
        <button data-act="offer-decline">断る</button>
      </div>`;
  }

  // 一斉提案に複数が応じたとき、提案者がどの相手と成立させるかを選ぶ
  if (d.type === 'tradeChoose') {
    const aw = state.awaiting;
    if (aw?.type !== 'tradeChoose') return '';
    const chips = (obj) =>
      Object.entries(obj)
        .map(
          ([r, n]) => `<span class="pick tchip sel">
            <span class="picon">${RES_ICON[r] ?? COM_ICON[r]}</span>${RES_JP[r] ?? COM_JP[r]}<small>×${n}</small></span>`,
        )
        .join('');
    const picks = aw.context.accepted
      .map(
        (id) => `<button class="pick" data-act="trade-pick:${id}" style="--pc:${PLAYER_COLORS[id]}">
          <span class="chip">${avatarSvg(id)}</span>${state.players[id].name}
          <small>${totalCards(state.players[id])}枚</small></button>`,
      )
      .join('');
    return `<h3>🤝 誰と交換する?</h3>
      <p>渡すもの</p><div class="row">${chips(aw.context.give)}</div>
      <p>もらうもの</p><div class="row">${chips(aw.context.receive)}</div>
      <p>応じた相手</p><div class="row">${picks}</div>
      <div class="row end"><button data-act="trade-pick:none">やめる</button></div>`;
  }

  if (d.type === 'improve') {
    // 公式ルール: Lv3ごとの特殊能力は系統で異なる
    const TRACK_ABILITY = {
      trade: '商館: 商品すべてを2:1交易',
      politics: '要塞: 騎士をLv3に昇格可',
      science: '水道橋: 収入0のとき資源1枚',
    };
    const rows = TRACKS.map((t) => {
      const lv = p.improvements[t];
      const next = lv + 1;
      const com = TRACK_COMMODITY[t];
      const cost = lv >= MAX_IMPROVEMENT ? null : improvementCost(next, state);
      const err = canBuyImprovement(state, HUMAN, t);
      const cells = Array.from({ length: MAX_IMPROVEMENT }, (_, i) =>
        `<span class="lvcell ${i < lv ? 'on' : ''}"></span>`,
      ).join('');
      const metroVid = state.metropolis[t];
      const metroMark =
        metroVid != null
          ? `<small>🏙 ${state.players[state.buildings[metroVid]?.player]?.name ?? ''}</small>`
          : '';
      return `<div class="drow improve">
        <span>${TRACK_ICON[t]} ${TRACK_JP[t]} <b>Lv${lv}</b> ${cells} ${metroMark}
          <small class="ability ${lv >= 3 ? 'on' : ''}">Lv3 ${TRACK_ABILITY[t]}</small></span>
        ${cost != null
          ? `<button data-act="improve-buy:${t}" ${err ? 'disabled' : ''}
              title="${err ?? ''}">${COM_ICON[com]}×${cost}で改良</button>`
          : '<small>MAX</small>'}
      </div>`;
    }).join('');
    return `<h3>🏙 都市改良</h3>
      <p>各系統で最初にLv4到達でメトロポリス(+2点)。Lv3で系統ごとの特殊能力が解禁</p>
      ${rows}
      <div class="row end"><button data-act="dialog-cancel">閉じる</button></div>`;
  }

  if (d.type === 'knight') {
    const k = state.knights[d.vertexId];
    if (!k) return '';
    const btn = (act, label, title = '') =>
      `<button data-act="${act}:${d.vertexId}" title="${title}">${label}</button>`;
    return `<h3>⚔️ 騎士 Lv${k.level}(${k.active ? '活性' : '不活性'})</h3>
      <div class="row">
        ${!k.active ? btn('knight-activate', '🌾 活性化', '小麦1') : ''}
        ${k.level < 3 ? btn('knight-promote', '⬆ 昇格', '羊毛1・鉱石1。Lv3は政治Lv3が必要') : ''}
        ${k.active ? btn('knight-move', '👣 移動', '道づたいに移動(移動後は不活性)') : ''}
        ${k.active ? btn('knight-chase', '🥷 盗賊を追い払う', '隣接ヘックスの盗賊を移動させる') : ''}
      </div>
      <div class="row end"><button data-act="dialog-cancel">閉じる</button></div>`;
  }

  // 進歩カードのパラメータ選択ダイアログ(カード名は index から引く)
  if (['prog-commodity', 'prog-resource', 'prog-cardkey', 'prog-player', 'prog-dice'].includes(d.type)) {
    const card = p.progressCards[d.index];
    const def = card ? PROGRESS_CARDS[card.id] : null;
    if (!def) return '';
    const head = `<h3>${def.icon} ${def.name}</h3><p>${def.desc}</p>`;
    const cancel = '<button data-act="dialog-cancel">やめる</button>';
    const progValid = (params) =>
      validateAction(state, { type: 'PLAY_PROGRESS_CARD', player: HUMAN, index: d.index, params });

    if (d.type === 'prog-commodity') {
      const btns = COMMODITIES.map(
        (c) => `<button class="pick" data-act="pc:${c}" ${progValid({ commodity: c }) ? 'disabled' : ''}>
          <span class="picon">${COM_ICON[c]}</span>${COM_JP[c]}</button>`,
      ).join('');
      return `${head}<div class="row">${btns}</div><div class="row end">${cancel}</div>`;
    }
    if (d.type === 'prog-resource') {
      const btns = RESOURCES.map(
        (r) => `<button class="pick" data-act="pres:${r}" ${progValid({ resource: r }) ? 'disabled' : ''}>
          <span class="picon">${RES_ICON[r]}</span>${RES_JP[r]}</button>`,
      ).join('');
      return `${head}<div class="row">${btns}</div><div class="row end">${cancel}</div>`;
    }
    if (d.type === 'prog-cardkey') {
      const keys = [...RESOURCES, ...COMMODITIES];
      const btns = keys.map(
        (k) => `<button class="pick" data-act="pkey:${k}" ${progValid({ key: k }) ? 'disabled' : ''}>
          <span class="picon">${RES_ICON[k] ?? COM_ICON[k]}</span>${RES_JP[k] ?? COM_JP[k]}</button>`,
      ).join('');
      return `${head}<div class="row">${btns}</div><div class="row end">${cancel}</div>`;
    }
    if (d.type === 'prog-player') {
      const btns = state.players
        .filter((o) => o.id !== HUMAN)
        .map((o) => {
          const err = progValid({ target: o.id });
          return `<button class="pick" data-act="pplayer:${o.id}" style="--pc:${PLAYER_COLORS[o.id]}"
            ${err ? 'disabled' : ''} title="${err ?? ''}">
            <span class="chip">${avatarSvg(o.id)}</span>${o.name}<small>${totalCards(o)}枚</small></button>`;
        })
        .join('');
      return `${head}<div class="row">${btns}</div><div class="row end">${cancel}</div>`;
    }
    if (d.type === 'prog-dice') {
      const dieRow = (act, sel, cls) => [1, 2, 3, 4, 5, 6]
        .map((n) => `<button class="pick ${cls} ${sel === n ? 'sel' : ''}" data-act="${act}:${n}">${n}</button>`)
        .join('');
      return `${head}
        <p>🔴 赤ダイス(小さいほど進歩カードが出やすい)</p><div class="row">${dieRow('pdice-r', d.red, 'die-red')}</div>
        <p>🟡 黄ダイス</p><div class="row">${dieRow('pdice-y', d.yellow, 'die-yellow')}</div>
        <div class="row end">
          <button class="primary" data-act="pdice-confirm" ${d.red && d.yellow ? '' : 'disabled'}>この出目にする</button>
          ${cancel}
        </div>`;
    }
  }

  if (d.type === 'discard') {
    // 割り込みが切り替わった直後に呼ばれても落ちないように、深い参照は全て安全側で読む
    const need = state.awaiting?.context?.required?.[HUMAN] ?? 0;
    // 都市と騎士では商品も手札上限に数えるため、捨て札の対象にする
    const keys = state.mode === 'cak' ? [...RESOURCES, ...COMMODITIES] : RESOURCES;
    const have = (k) => (RESOURCES.includes(k) ? p.resources[k] : p.commodities[k]);
    const icon = (k) => RES_ICON[k] ?? COM_ICON[k];
    const label = (k) => RES_JP[k] ?? COM_JP[k];
    const sum = keys.reduce((s, k) => s + (d.counts[k] ?? 0), 0);
    const rows = keys.map(
      (r) => `<div class="drow">
        <span>${icon(r)} ${label(r)}(${have(r)})</span>
        <button data-act="discard-minus:${r}" ${(d.counts[r] ?? 0) > 0 ? '' : 'disabled'}>−</button>
        <b>${d.counts[r] ?? 0}</b>
        <button data-act="discard-plus:${r}" ${(d.counts[r] ?? 0) < have(r) && sum < need ? '' : 'disabled'}>+</button>
      </div>`,
    ).join('');
    return `<h3>🂠 捨て札(${sum}/${need}枚)</h3>${rows}
      <div class="row end">
        <button class="primary" data-act="discard-confirm" ${sum === need ? '' : 'disabled'}>捨てる</button>
      </div>`;
  }

  if (d.type === 'steal') {
    const btns = d.targets.map((t) => {
      const tp = state.players[t];
      return `<button class="pick" data-act="steal:${t}" style="--pc:${PLAYER_COLORS[t]}">
        <span class="chip">${avatarSvg(t)}</span>${tp.name}<small>手札${totalCards(tp)}枚</small></button>`;
    }).join('');
    const head = d.pirate ? '🏴‍☠️ 海賊で誰から奪いますか?' : '🥷 誰から奪いますか?';
    return `<h3>${head}</h3><div class="row">${btns}</div>`;
  }

  if (d.type === 'monopoly') {
    const btns = RESOURCES.map(
      (r) => `<button class="pick" data-act="mono:${r}"><span class="picon">${RES_ICON[r]}</span>${RES_JP[r]}</button>`,
    ).join('');
    return `<h3>🎩 独占する資源を選んでください</h3><div class="row">${btns}</div>
      <div class="row end"><button data-act="dialog-cancel">やめる</button></div>`;
  }

  if (d.type === 'yop') {
    const btns = RESOURCES.map((r) => {
      const n = d.picks.filter((x) => x === r).length;
      const ok = d.picks.length < 2 && state.bank.resources[r] > n;
      return `<button class="pick ${n ? 'sel' : ''}" data-act="yop:${r}" ${ok ? '' : 'disabled'}>
        <span class="picon">${RES_ICON[r]}</span>${RES_JP[r]}${n ? `<small>×${n}</small>` : ''}</button>`;
    }).join('');
    return `<h3>🧺 収穫: 資源を2つ選んでください(${d.picks.length}/2)</h3>
      <div class="row">${btns}</div>
      <div class="row end">
        <button class="primary" data-act="yop-confirm" ${d.picks.length === 2 ? '' : 'disabled'}>獲得</button>
        <button data-act="dialog-cancel">やめる</button>
      </div>`;
  }

  if (d.type === 'settings') {
    const s = d.settings;
    const seg = (act, options, current) =>
      `<div class="seg ${options.length >= 4 ? 'seg-grid' : ''}">${options
        .map(([v, label]) => `<button class="${current === v ? 'sel' : ''}" data-act="${act}:${v}">${label}</button>`)
        .join('')}</div>`;
    return `<h3>⚙️ 設定</h3>
      <div class="srow"><span>表示</span>${seg('set-view', [['3d', '3D'], ['2d', '2D']], s.view)}</div>
      <div class="srow"><span>モード</span>${seg('set-mode', [['base', '基本'], ['cak', '都市と騎士'], ['dragon', '🐉ドラゴン'], ['fish', '🐟漁師'], ['sea', '⛵航海者']], s.mode)}</div>
      <div class="srow"><span>CPU</span>${seg('set-cpu', [['2', '2体'], ['3', '3体']], String(s.cpuCount))}</div>
      <div class="srow"><span>BGM</span>${seg('set-bgm', [['on', '🔊 オン'], ['off', '🔇 オフ']], s.bgm ? 'on' : 'off')}</div>
      <div class="srow"><span>シード</span><input id="seed-input" inputmode="numeric" placeholder="空欄でランダム" value="${s.seed}"></div>
      <p>モード・CPU・シードは「新しいゲーム」開始時に反映されます</p>
      <div class="row end">
        <button data-act="rules-open">📖 あそびかた</button>
        <button data-act="goto-title">🏝 ゲームをやめてタイトルへ</button>
        <button class="primary" data-act="new-game">🔄 新しいゲーム</button>
        <button data-act="dialog-cancel">閉じる</button>
      </div>`;
  }

  if (d.type === 'rules') {
    return `<h3>📖 あそびかた</h3>
      ${rulesHtml(d.tab, { demo: false })}
      <div class="row end"><button class="primary" data-act="dialog-cancel">閉じる</button></div>`;
  }

  // 発展カード(基本モード)の説明。使えないときは理由を出す。
  if (d.type === 'dev-info') {
    const card = p.devCards[d.index];
    if (!card) return '';
    const why = devPlayableWhy(state, card);
    return `<h3>${DEV_ICON[card.type]} ${DEV_JP[card.type]}</h3>
      <p>${DEV_DESC[card.type]}</p>
      ${why ? `<p><small>⏳ ${why}</small></p>` : ''}
      <div class="row end">
        <button class="primary" data-act="dev-use:${d.index}" ${why ? 'disabled' : ''}>✨ 使う</button>
        <button data-act="dialog-cancel">閉じる</button>
      </div>`;
  }

  if (d.type === 'prog-info') {
    const card = p.progressCards[d.index];
    if (!card) return '';
    const def = PROGRESS_CARDS[card.id];
    const deckJp = { trade: '🧵 交易', politics: '🪙 政治', science: '📜 科学' };
    const playable = progressPlayable(state, card);
    const why = playable
      ? ''
      : card.boughtTurn >= state.turn
        ? '獲得したターンには使えません'
        : def.preRoll
          ? 'ロールの前にだけ使えます'
          : '自分の手番のロール後に使えます';
    return `<h3>${def.icon} ${def.name}</h3>
      <p><span class="badge">${deckJp[def.deck]}</span>${def.preRoll ? ' <span class="badge">ロール前</span>' : ''}</p>
      <p>${def.desc}</p>
      ${why ? `<p><small>⏳ ${why}</small></p>` : ''}
      <div class="row end">
        <button class="primary" data-act="prog-use:${d.index}" ${playable ? '' : 'disabled'}>✨ 使う</button>
        <button data-act="dialog-cancel">閉じる</button>
      </div>`;
  }

  if (d.type === 'dicelog') return diceLogHtml(state);

  if (d.type === 'log') {
    return `<h3>📜 ログ</h3>
      <div class="logsheet">${state.log.slice(-80).map((l) => `<div>${l}</div>`).join('')}</div>
      <div class="row end"><button data-act="dialog-cancel">閉じる</button></div>`;
  }

  if (d.type === 'winner') {
    const rows = state.players
      .map((pl) => ({ pl, pts: computePoints(state, pl.id, { includeHidden: true }) }))
      .sort((a, b) => b.pts - a.pts)
      .map(({ pl, pts }, i) => `<div class="wrow" style="--pc:${PLAYER_COLORS[pl.id]}">
        <span>${i === 0 ? '🏆' : `${i + 1}位`}</span><span class="chip">${avatarSvg(pl.id)}</span>
        <span class="pname">${pl.name}</span><b>${pts}点</b></div>`)
      .join('');
    return `<h3 class="win-title">🏆 ${state.players[state.winner].name}の勝利!</h3>
      ${rows}
      <div class="row end">
        <button data-act="new-game">もう一度</button>
        <button class="primary" data-act="goto-title">タイトルへ</button>
      </div>`;
  }
  return '';
}

// 直前に流し込んだダイアログの HTML。中身が同じなら DOM を作り直さない。
// 作り直すと開きっぱなしのダイアログでも表示アニメーションが鳴り直してしまい、
// 「ポップアップが何度も出てくる」ように見える ── 交易の一斉提案や捨て札のように
// 自分が答える前に他の人の応答で再描画が走る場面で起きる。
let lastDialogHtml = null;

function renderDialog(state, ui) {
  const root = el('dialog-root');
  let html;
  try {
    html = dialogHtml(state, ui);
  } catch (e) {
    // ダイアログの中身が state と食い違っても、画面を覆ったまま固まらせない。
    // (オンラインではサーバーの state で割り込みが入れ替わることがある)
    console.error('ダイアログ描画に失敗:', e);
    ui.dialog = null;
    html = '';
  }
  const wrapped = html ? `<div class="overlay"><div class="dialog">${html}</div></div>` : '';
  if (wrapped === lastDialogHtml) return;
  lastDialogHtml = wrapped;
  root.innerHTML = wrapped;
}

export function renderHUD(state, ui) {
  renderPlayers(state, ui);
  renderBarbarians(state);
  renderDice(state);
  renderHand(state, ui);
  renderControls(state, ui);
  renderStatus(state, ui);
  renderLog(state);
  renderDialog(state, ui);
}
