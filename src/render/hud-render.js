// HUD 描画(設計書 §8.2)
// 手札・ボタン・ダイアログは DOM で作る。クリックは data-act 属性で main.js に委譲。

import { RESOURCES, RES_JP, DEV_JP } from '../state.js';
import { COSTS, canAfford, totalResources } from '../rules/build.js';
import { computePoints, VICTORY_POINTS_TO_WIN } from '../rules/victory.js';
import { tradeRate } from '../rules/trade.js';
import { PLAYER_COLORS } from './board-render.js';

const HUMAN = 0;

export const RES_ICON = { wood: '🪵', brick: '🧱', sheep: '🐑', wheat: '🌾', ore: '🪨' };
export const DEV_ICON = { knight: '⚔️', roadBuilding: '🛤️', yearOfPlenty: '🧺', monopoly: '🎩', vp: '⭐' };

function el(id) {
  return document.getElementById(id);
}

function renderPlayers(state) {
  el('players').innerHTML = state.players
    .map((p) => {
      const pts = computePoints(state, p.id, { includeHidden: p.id === HUMAN });
      const active =
        state.awaiting ? state.awaiting.players.includes(p.id) : state.currentPlayer === p.id;
      const badges = [
        state.longestRoad.player === p.id ? '<span class="badge">🛤 最長交易路</span>' : '',
        state.largestArmy.player === p.id ? '<span class="badge">⚔ 最大騎士力</span>' : '',
      ].join('');
      return `
      <div class="player ${active ? 'active' : ''}" style="--pc:${PLAYER_COLORS[p.id]}">
        <div class="prow">
          <span class="chip"></span>
          <span class="pname">${p.name}</span>
          <span class="ppts">${pts}<small>/${VICTORY_POINTS_TO_WIN}</small></span>
        </div>
        <div class="prow pinfo">
          <span title="手札">🂠 ${totalResources(p)}</span>
          <span title="発展カード">📜 ${p.devCards.length}</span>
          <span title="使用済み騎士">⚔️ ${p.knightsPlayed}</span>
          ${badges}
        </div>
      </div>`;
    })
    .join('');
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
  el('dice').innerHTML = d
    ? `${dieHtml(d[0])}${dieHtml(d[1])}<span class="dsum">${d[0] + d[1]}</span>`
    : `<span class="die empty"></span><span class="die empty"></span><span class="dsum">–</span>`;
}

function renderHand(state) {
  const p = state.players[HUMAN];
  const res = RESOURCES.map(
    (r) => `<div class="card card-${r} ${p.resources[r] === 0 ? 'zero' : ''}">
      <div class="icon">${RES_ICON[r]}</div>
      <div class="label">${RES_JP[r]}</div>
      <div class="cnt">${p.resources[r]}</div>
    </div>`,
  ).join('');

  const isMyTurn =
    state.phase === 'main' && state.currentPlayer === HUMAN && !state.awaiting;
  const devs = p.devCards
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
  el('hand').innerHTML = res + (devs ? `<div class="sep"></div>${devs}` : '');
}

function renderControls(state, ui) {
  const p = state.players[HUMAN];
  const myTurn = state.phase === 'main' && state.currentPlayer === HUMAN && !state.awaiting;
  const rolled = state.turnFlags.rolled;
  const btn = (act, label, enabled, title = '') =>
    `<button data-act="${act}" ${enabled ? '' : 'disabled'} title="${title}">${label}</button>`;

  el('controls').innerHTML = [
    btn('roll', '🎲 ロール', myTurn && !rolled),
    btn('mode:road', '🛤️ 道', myTurn && rolled && canAfford(p, COSTS.road), '🪵1 🧱1'),
    btn('mode:settlement', '🏠 開拓地', myTurn && rolled && canAfford(p, COSTS.settlement), '🪵1 🧱1 🐑1 🌾1'),
    btn('mode:city', '🏰 都市', myTurn && rolled && canAfford(p, COSTS.city), '🌾2 🪨3'),
    btn('buy-dev', '📜 カード', myTurn && rolled && canAfford(p, COSTS.devCard) && state.bank.devDeck.length > 0, '🐑1 🌾1 🪨1'),
    btn('trade-open', '⚖️ 交易', myTurn && rolled),
    btn('end-turn', '⏭ ターン終了', myTurn && rolled),
  ].join('');
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
  } else if (aw) {
    return `⏳ ${aw.players.map((i) => state.players[i].name).join('・')}の応答待ち...`;
  }
  switch (ui.mode) {
    case 'build-road': return '🛤️ 道を建てる辺を選んでください';
    case 'build-settlement': return '🏠 開拓地を建てる頂点を選んでください';
    case 'build-city': return '🏰 都市に昇格する開拓地を選んでください';
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
  const cancellable = ['build-road', 'build-settlement', 'build-city', 'play-road-building'].includes(ui.mode)
    || (ui.mode === 'setup-road');
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
    const giveBtns = RESOURCES.map((r) => {
      const rate = tradeRate(state, HUMAN, r);
      const ok = p.resources[r] >= rate;
      return `<button class="pick ${d.give === r ? 'sel' : ''}" data-act="trade-give:${r}" ${ok ? '' : 'disabled'}>
        <span class="picon">${RES_ICON[r]}</span>${RES_JP[r]}<small>${rate}:1</small></button>`;
    }).join('');
    const recvBtns = RESOURCES.map((r) => {
      const ok = state.bank.resources[r] > 0 && r !== d.give;
      return `<button class="pick ${d.receive === r ? 'sel' : ''}" data-act="trade-receive:${r}" ${ok ? '' : 'disabled'}>
        <span class="picon">${RES_ICON[r]}</span>${RES_JP[r]}</button>`;
    }).join('');
    return `<h3>⚖️ 銀行/港と交易</h3>
      <p>渡す資源</p><div class="row">${giveBtns}</div>
      <p>もらう資源</p><div class="row">${recvBtns}</div>
      <div class="row end">
        <button class="primary" data-act="trade-confirm" ${d.give && d.receive ? '' : 'disabled'}>交易する</button>
        <button data-act="dialog-cancel">閉じる</button>
      </div>`;
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
        <span class="chip"></span>${tp.name}<small>手札${totalResources(tp)}枚</small></button>`;
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
      <div class="row end"><button class="primary" data-act="new-game">新しいゲーム</button></div>`;
  }
  return '';
}

function renderDialog(state, ui) {
  const root = el('dialog-root');
  const html = dialogHtml(state, ui);
  root.innerHTML = html ? `<div class="overlay"><div class="dialog">${html}</div></div>` : '';
}

export function renderHUD(state, ui) {
  renderPlayers(state);
  renderDice(state);
  renderHand(state);
  renderControls(state, ui);
  renderStatus(state, ui);
  renderLog(state);
  renderDialog(state, ui);
}
