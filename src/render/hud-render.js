// HUD 描画(設計書 §8.2)
// 手札・ボタン・ダイアログは DOM で作る。クリックは data-act 属性で main.js に委譲。

import { RESOURCES, RES_JP, DEV_JP } from '../state.js';
import { COSTS, WALL_COST, canAfford, totalCards } from '../rules/build.js';
import { computePoints, pointsToWin } from '../rules/victory.js';
import { tradeRate } from '../rules/trade.js';
import { KNIGHT_COSTS } from '../rules/cak/knights.js';
import { BARBARIAN_TRACK_LENGTH, knightContribution, barbarianStrength } from '../rules/cak/barbarians.js';
import {
  TRACKS, TRACK_JP, TRACK_COMMODITY, MAX_IMPROVEMENT,
  improvementCost, canBuyImprovement,
} from '../rules/cak/improvements.js';
import { COMMODITIES, COM_JP, PROGRESS_CARDS } from '../rules/cak/progress-cards.js';
import { PLAYER_COLORS } from './board-render.js';

const HUMAN = 0;

export const RES_ICON = { wood: '🪵', brick: '🧱', sheep: '🐑', wheat: '🌾', ore: '🪨' };
export const COM_ICON = { cloth: '🧵', coin: '🪙', paper: '📜' };
export const DEV_ICON = { knight: '⚔️', roadBuilding: '🛤️', yearOfPlenty: '🧺', monopoly: '🎩', vp: '⭐' };
const EV_ICON = { ship: '⛵', trade: '🧵', politics: '🪙', science: '📜' };
const TRACK_ICON = { trade: '🧵', politics: '🪙', science: '📜' };

function el(id) {
  return document.getElementById(id);
}

function renderPlayers(state, ui) {
  const cak = state.mode === 'cak';
  const goal = pointsToWin(state);
  el('players').innerHTML = state.players
    .map((p) => {
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
      ].join('');
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
          <span class="chip"></span>
          <span class="pname">${p.name}</span>
          <span class="ppts">${pts}<small>/${goal}</small></span>
        </div>
        <div class="prow pinfo">${info}${badges}</div>
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
  const ev = state.mode === 'cak' && state.eventDie && d
    ? `<span class="evdie" title="イベントダイス">${EV_ICON[state.eventDie]}</span>`
    : state.mode === 'cak'
      ? '<span class="evdie empty"></span>'
      : '';
  el('dice').innerHTML = d
    ? `${dieHtml(d[0])}${dieHtml(d[1])}${ev}<span class="dsum">${d[0] + d[1]}</span>`
    : `<span class="die empty"></span><span class="die empty"></span>${ev}<span class="dsum">–</span>`;
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

  const isMyTurn =
    state.phase === 'main' && state.currentPlayer === HUMAN && !state.awaiting;

  let extra = '';
  if (cak) {
    extra = p.progressCards
      .map((c, i) => {
        const def = PROGRESS_CARDS[c.id];
        const playable = isMyTurn && state.turnFlags.rolled && c.boughtTurn < state.turn;
        return `<button class="card dev ${playable ? '' : 'dim'}" data-act="play-prog:${i}"
          ${playable ? '' : 'disabled'} title="進歩カード">
          <div class="icon">${def.icon}</div>
          <div class="label">${def.name}</div></button>`;
      })
      .join('');
  } else {
    extra = p.devCards
      .map((c) => {
        const playable =
          isMyTurn &&
          !state.turnFlags.playedDev &&
          c.type !== 'vp' &&
          c.boughtTurn < state.turn &&
          (c.type === 'knight' || state.turnFlags.rolled);
        return `<button class="card dev ${playable ? '' : 'dim'}" data-act="play-dev:${c.type}"
          ${playable ? '' : 'disabled'}>
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
  const btn = (act, label, enabled, title = '') =>
    `<button data-act="${act}" ${enabled ? '' : 'disabled'} title="${title}">${label}</button>`;

  const buildBtns = (road, settlement, city) => [
    btn('mode:road', road, myTurn && rolled && canAfford(p, COSTS.road), '🪵1 🧱1'),
    btn('mode:settlement', settlement, myTurn && rolled && canAfford(p, COSTS.settlement), '🪵1 🧱1 🐑1 🌾1'),
    btn('mode:city', city, myTurn && rolled && canAfford(p, COSTS.city), '🌾2 🪨3'),
  ];
  const cakBtns = (knight, wall, improve) => [
    btn('mode:knight', knight, myTurn && rolled && canAfford(p, KNIGHT_COSTS.build), '🐑1 🪨1(不活性で配置)'),
    btn('mode:wall', wall, myTurn && rolled && canAfford(p, WALL_COST), '🧱2(手札上限+2)'),
    btn('improve-open', improve, myTurn && rolled, '商品で都市を改良'),
  ];
  const devBtn = (label) =>
    btn('buy-dev', label, myTurn && rolled && canAfford(p, COSTS.devCard) && state.bank.devDeck.length > 0, '🐑1 🌾1 🪨1');

  let list;
  if (mobile) {
    // モバイル: 4列×2段のグリッド。ロール/終了は同時に使わないので1ボタンに統合
    const flow = myTurn && rolled
      ? btn('end-turn', '⏭終了', true)
      : btn('roll', '🎲ロール', myTurn && !rolled);
    list = [
      flow,
      ...buildBtns('🛤道', '🏠開拓', '🏰都市'),
      ...(cak ? cakBtns('⚔️騎士', '🧱城壁', '🏙改良') : [devBtn('📜カード')]),
      btn('trade-open', '⚖️交易', myTurn && rolled),
    ];
  } else {
    list = [
      btn('roll', '🎲 ロール', myTurn && !rolled),
      ...buildBtns('🛤️ 道', '🏠 開拓地', '🏰 都市'),
      ...(cak ? cakBtns('⚔️ 騎士', '🧱 城壁', '🏙 改良') : [devBtn('📜 カード')]),
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
    if (aw.type === 'moveRobber') return '🥷 盗賊の移動先ヘックスを選んでください';
    if (aw.type === 'barbarianDefense') return '⚔️ 降格させる都市を選んでください';
  } else if (aw) {
    return `⏳ ${aw.players.map((i) => state.players[i].name).join('・')}の応答待ち...`;
  }
  switch (ui.mode) {
    case 'build-road': return '🛤️ 道を建てる辺を選んでください';
    case 'build-settlement': return '🏠 開拓地を建てる頂点を選んでください';
    case 'build-city': return '🏰 都市に昇格する開拓地を選んでください';
    case 'build-knight': return '⚔️ 騎士を配置する頂点を選んでください(自分の道に接続)';
    case 'build-wall': return '🧱 城壁を建てる都市を選んでください';
    case 'move-knight': return '⚔️ 騎士の移動先を選んでください';
    case 'play-bishop': return '⛪ 司教: 盗賊の移動先ヘックスを選んでください';
    case 'play-road-building': return `🛤️ 街道建設: 道をあと${2 - ui.pendingEdges.length}本選べます`;
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
    'build-knight', 'build-wall', 'move-knight', 'play-bishop',
  ].includes(ui.mode) || (ui.mode === 'setup-road');
  const confirmable =
    (ui.pending != null) ||
    (ui.mode === 'play-road-building' && ui.pendingEdges.length >= 1);
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
      const chipRow = (selected, addAct, subAct, maxOf) => keys.map((r) => {
        const n = selected[r] ?? 0;
        const ok = maxOf(r) > n;
        return `<button class="pick tchip ${n ? 'sel' : ''}" data-act="${addAct}:${r}" ${ok || n ? '' : 'disabled'}>
          <span class="picon">${icon(r)}</span>${jp(r)}
          ${n ? `<span class="tbadge" data-act="${subAct}:${r}">− ${n}</span>` : `<small>${maxOf(r)}</small>`}
        </button>`;
      }).join('');
      return `<h3>⚖️ 交易</h3>${tabs}
        <p>渡すもの(タップで追加、バッジで減らす)</p>
        <div class="row">${chipRow(d.pgive, 'ptg-add', 'ptg-sub', (r) => have(r))}</div>
        <p>もらうもの</p>
        <div class="row">${chipRow(d.precv, 'ptr-add', 'ptr-sub', () => 6)}</div>
        <p>提案すると、得だと判断したCPUが応じます</p>
        <div class="row end">
          <button class="primary" data-act="pt-propose"
            ${sum(d.pgive) > 0 && sum(d.precv) > 0 ? '' : 'disabled'}>提案する</button>
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
    return `<h3>💬 ${from.name}からの交易提案</h3>
      <p>もらえるもの</p><div class="row">${chips(aw.context.give)}</div>
      <p>渡すもの${short ? '(手札が足りません)' : ''}</p><div class="row">${chips(aw.context.receive)}</div>
      <div class="row end">
        <button class="primary" data-act="offer-accept" ${short ? 'disabled' : ''}>🤝 交換する</button>
        <button data-act="offer-decline">断る</button>
      </div>`;
  }

  if (d.type === 'improve') {
    const rows = TRACKS.map((t) => {
      const lv = p.improvements[t];
      const next = lv + 1;
      const com = TRACK_COMMODITY[t];
      const cost = lv >= MAX_IMPROVEMENT ? null : improvementCost(next);
      const err = canBuyImprovement(state, HUMAN, t);
      const cells = Array.from({ length: MAX_IMPROVEMENT }, (_, i) =>
        `<span class="lvcell ${i < lv ? 'on' : ''}"></span>`,
      ).join('');
      const metroVid = state.metropolis[t];
      const metroMark =
        metroVid != null
          ? `<small>🏙 ${state.players[state.buildings[metroVid]?.player]?.name ?? ''}</small>`
          : '';
      return `<div class="drow">
        <span>${TRACK_ICON[t]} ${TRACK_JP[t]} <b>Lv${lv}</b> ${cells} ${metroMark}</span>
        ${cost != null
          ? `<button data-act="improve-buy:${t}" ${err ? 'disabled' : ''}
              title="${err ?? ''}">${COM_ICON[com]}×${cost}で改良</button>`
          : '<small>MAX</small>'}
      </div>`;
    }).join('');
    return `<h3>🏙 都市改良</h3>
      <p>Lv3で商品の2:1交易解禁、各系統で最初にLv4到達でメトロポリス(+2点)</p>
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

  if (d.type === 'prog-harvest') {
    const btns = RESOURCES.map((r) => {
      const n = d.picks.filter((x) => x === r).length;
      const ok = d.picks.length < 2 && state.bank.resources[r] > n;
      return `<button class="pick ${n ? 'sel' : ''}" data-act="ph:${r}" ${ok ? '' : 'disabled'}>
        <span class="picon">${RES_ICON[r]}</span>${RES_JP[r]}${n ? `<small>×${n}</small>` : ''}</button>`;
    }).join('');
    return `<h3>🧺 収穫祭: 資源を2つ選んでください(${d.picks.length}/2)</h3>
      <div class="row">${btns}</div>
      <div class="row end">
        <button class="primary" data-act="ph-confirm" ${d.picks.length === 2 ? '' : 'disabled'}>獲得</button>
        <button data-act="dialog-cancel">やめる</button>
      </div>`;
  }

  if (d.type === 'prog-commodity') {
    const btns = COMMODITIES.map(
      (c) => `<button class="pick" data-act="pc:${c}" ${state.bank.commodities[c] > 0 ? '' : 'disabled'}>
        <span class="picon">${COM_ICON[c]}</span>${COM_JP[c]}</button>`,
    ).join('');
    return `<h3>📦 商品倉庫: 商品を1つ選んでください</h3>
      <div class="row">${btns}</div>
      <div class="row end"><button data-act="dialog-cancel">やめる</button></div>`;
  }

  if (d.type === 'discard') {
    const need = state.awaiting?.context.required[HUMAN] ?? 0;
    const sum = RESOURCES.reduce((s, r) => s + d.counts[r], 0);
    const rows = RESOURCES.map(
      (r) => `<div class="drow">
        <span>${RES_ICON[r]} ${RES_JP[r]}(${p.resources[r]})</span>
        <button data-act="discard-minus:${r}" ${d.counts[r] > 0 ? '' : 'disabled'}>−</button>
        <b>${d.counts[r]}</b>
        <button data-act="discard-plus:${r}" ${d.counts[r] < p.resources[r] && sum < need ? '' : 'disabled'}>+</button>
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
        <span class="chip"></span>${tp.name}<small>手札${totalCards(tp)}枚</small></button>`;
    }).join('');
    return `<h3>🥷 誰から奪いますか?</h3><div class="row">${btns}</div>`;
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
      `<div class="seg">${options
        .map(([v, label]) => `<button class="${current === v ? 'sel' : ''}" data-act="${act}:${v}">${label}</button>`)
        .join('')}</div>`;
    return `<h3>⚙️ 設定</h3>
      <div class="srow"><span>表示</span>${seg('set-view', [['3d', '3D'], ['2d', '2D']], s.view)}</div>
      <div class="srow"><span>モード</span>${seg('set-mode', [['cak', '都市と騎士'], ['base', '基本']], s.mode)}</div>
      <div class="srow"><span>CPU</span>${seg('set-cpu', [['2', '2体'], ['3', '3体']], String(s.cpuCount))}</div>
      <div class="srow"><span>シード</span><input id="seed-input" inputmode="numeric" placeholder="空欄でランダム" value="${s.seed}"></div>
      <p>モード・CPU・シードは「新しいゲーム」開始時に反映されます</p>
      <div class="row end">
        <button data-act="goto-title">🏝 ゲームをやめてタイトルへ</button>
        <button class="primary" data-act="new-game">🔄 新しいゲーム</button>
        <button data-act="dialog-cancel">閉じる</button>
      </div>`;
  }

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
        <span>${i === 0 ? '🏆' : `${i + 1}位`}</span><span class="chip"></span>
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

function renderDialog(state, ui) {
  const root = el('dialog-root');
  const html = dialogHtml(state, ui);
  root.innerHTML = html ? `<div class="overlay"><div class="dialog">${html}</div></div>` : '';
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
