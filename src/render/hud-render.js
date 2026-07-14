// HUD 描画(設計書 §8.2)
// 手札・ボタン・ダイアログは DOM で作る。クリックは data-act 属性で main.js に委譲。

import { RESOURCES, RES_JP, RES_JP_SHORT, DEV_JP } from '../state.js';
import { COSTS, canAfford, totalResources } from '../rules/build.js';
import { computePoints } from '../rules/victory.js';
import { tradeRate } from '../rules/trade.js';
import { PLAYER_COLORS } from './board-render.js';

const HUMAN = 0;

function el(id) {
  return document.getElementById(id);
}

function resIcons(res) {
  return RESOURCES.filter((r) => res[r] > 0)
    .map((r) => `<span class="res res-${r}">${RES_JP_SHORT[r]}×${res[r]}</span>`)
    .join(' ');
}

function renderPlayers(state) {
  el('players').innerHTML = state.players
    .map((p) => {
      const pts = computePoints(state, p.id, { includeHidden: p.id === HUMAN });
      const active =
        state.awaiting ? state.awaiting.players.includes(p.id) : state.currentPlayer === p.id;
      const badges = [
        state.longestRoad.player === p.id ? '<span class="badge">最長交易路</span>' : '',
        state.largestArmy.player === p.id ? '<span class="badge">最大騎士力</span>' : '',
      ].join('');
      return `
      <div class="player ${active ? 'active' : ''}">
        <span class="chip" style="background:${PLAYER_COLORS[p.id]}"></span>
        <span class="pname">${p.name}</span>
        <span class="ppts">${pts}点</span>
        <span class="pinfo">手札${totalResources(p)} 発展${p.devCards.length} 騎士${p.knightsPlayed}</span>
        ${badges}
      </div>`;
    })
    .join('');
}

function renderDice(state) {
  const d = state.dice;
  el('dice').innerHTML = d
    ? `<span class="die">${d[0]}</span><span class="die">${d[1]}</span><span class="dsum">= ${d[0] + d[1]}</span>`
    : '<span class="dsum">－</span>';
}

function renderHand(state) {
  const p = state.players[HUMAN];
  const res = RESOURCES.map(
    (r) => `<div class="card card-${r}"><div>${RES_JP[r]}</div><div class="cnt">${p.resources[r]}</div></div>`,
  ).join('');

  const isMyTurn =
    state.phase === 'main' && state.currentPlayer === HUMAN && !state.awaiting;
  const devs = p.devCards
    .map((c, i) => {
      const playable =
        isMyTurn &&
        !state.turnFlags.playedDev &&
        c.type !== 'vp' &&
        c.boughtTurn < state.turn &&
        (c.type === 'knight' || state.turnFlags.rolled);
      return `<button class="card dev ${playable ? '' : 'dim'}" data-act="play-dev:${c.type}"
        ${playable ? '' : 'disabled'} title="${c.type === 'vp' ? '公開時に自動加点' : ''}">
        <div>${DEV_JP[c.type]}</div></button>`;
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
    btn('mode:road', '道', myTurn && rolled && canAfford(p, COSTS.road), '木1 土1'),
    btn('mode:settlement', '開拓地', myTurn && rolled && canAfford(p, COSTS.settlement), '木1 土1 羊1 麦1'),
    btn('mode:city', '都市', myTurn && rolled && canAfford(p, COSTS.city), '麦2 鉄3'),
    btn('buy-dev', 'カード購入', myTurn && rolled && canAfford(p, COSTS.devCard) && state.bank.devDeck.length > 0, '羊1 麦1 鉄1'),
    btn('trade-open', '交易', myTurn && rolled),
    btn('end-turn', 'ターン終了', myTurn && rolled),
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
        ? '開拓地に隣接する道の位置を選んでください'
        : `初期配置(${aw.context.round}巡目): 開拓地の位置を選んでください`;
    }
    if (aw.type === 'discard') return `手札を${aw.context.required[HUMAN]}枚捨ててください`;
    if (aw.type === 'moveRobber') return '盗賊の移動先ヘックスを選んでください';
  } else if (aw) {
    return `${aw.players.map((i) => state.players[i].name).join('・')}の応答待ち...`;
  }
  switch (ui.mode) {
    case 'build-road': return '道を建てる辺を選んでください';
    case 'build-settlement': return '開拓地を建てる頂点を選んでください';
    case 'build-city': return '都市に昇格する開拓地を選んでください';
    case 'play-road-building': return `街道建設: 道を${2 - ui.pendingEdges.length}本選んでください`;
    default:
      if (state.phase === 'main') {
        return state.currentPlayer === HUMAN
          ? state.turnFlags.rolled ? 'あなたの手番です(建設・交易・カード)' : 'ダイスを振ってください'
          : `${state.players[state.currentPlayer].name}の手番...`;
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
    ${confirmable ? '<button class="primary" data-act="confirm">確定</button>' : ''}
    ${cancellable ? '<button data-act="cancel">やり直す</button>' : ''}
    ${state.phase === 'ended' ? '<button class="primary" data-act="new-game">新しいゲーム</button>' : ''}
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
        ${RES_JP[r]}<small>${rate}:1</small></button>`;
    }).join('');
    const recvBtns = RESOURCES.map((r) => {
      const ok = state.bank.resources[r] > 0 && r !== d.give;
      return `<button class="pick ${d.receive === r ? 'sel' : ''}" data-act="trade-receive:${r}" ${ok ? '' : 'disabled'}>
        ${RES_JP[r]}</button>`;
    }).join('');
    return `<h3>銀行/港と交易</h3>
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
        <span>${RES_JP[r]}(${p.resources[r]})</span>
        <button data-act="discard-minus:${r}" ${d.counts[r] > 0 ? '' : 'disabled'}>−</button>
        <b>${d.counts[r]}</b>
        <button data-act="discard-plus:${r}" ${d.counts[r] < p.resources[r] && sum < need ? '' : 'disabled'}>+</button>
      </div>`,
    ).join('');
    return `<h3>捨て札(${sum}/${need}枚)</h3>${rows}
      <div class="row end">
        <button class="primary" data-act="discard-confirm" ${sum === need ? '' : 'disabled'}>捨てる</button>
      </div>`;
  }

  if (d.type === 'steal') {
    const btns = d.targets.map((t) => {
      const tp = state.players[t];
      return `<button class="pick" data-act="steal:${t}">
        <span class="chip" style="background:${PLAYER_COLORS[t]}"></span>
        ${tp.name}<small>手札${totalResources(tp)}枚</small></button>`;
    }).join('');
    return `<h3>誰から奪いますか?</h3><div class="row">${btns}</div>`;
  }

  if (d.type === 'monopoly') {
    const btns = RESOURCES.map(
      (r) => `<button class="pick" data-act="mono:${r}">${RES_JP[r]}</button>`,
    ).join('');
    return `<h3>独占する資源を選んでください</h3><div class="row">${btns}</div>
      <div class="row end"><button data-act="dialog-cancel">やめる</button></div>`;
  }

  if (d.type === 'yop') {
    const btns = RESOURCES.map((r) => {
      const n = d.picks.filter((x) => x === r).length;
      const ok = d.picks.length < 2 && state.bank.resources[r] > n;
      return `<button class="pick ${n ? 'sel' : ''}" data-act="yop:${r}" ${ok ? '' : 'disabled'}>
        ${RES_JP[r]}${n ? `<small>×${n}</small>` : ''}</button>`;
    }).join('');
    return `<h3>収穫: 資源を2つ選んでください(${d.picks.length}/2)</h3>
      <div class="row">${btns}</div>
      <div class="row end">
        <button class="primary" data-act="yop-confirm" ${d.picks.length === 2 ? '' : 'disabled'}>獲得</button>
        <button data-act="dialog-cancel">やめる</button>
      </div>`;
  }

  if (d.type === 'winner') {
    return `<h3>🏆 ${state.players[state.winner].name}の勝利!</h3>
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
