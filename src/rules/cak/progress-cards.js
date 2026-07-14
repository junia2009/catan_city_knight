// 進歩カード(設計書 §9.5)
// カード効果はプラグイン実装。Phase 2 は効果が単純なカードで山札を構成し、
// 盤面干渉系・対人干渉系の完全実装は Phase 3 で拡充する。

import { LAYOUT, TERRAIN_RESOURCE } from '../board.js';
import { rngInt } from '../../rng.js';
import { RESOURCES, RES_JP, addLog } from '../../state.js';
import { grantResource } from '../build.js';

export const COMMODITIES = ['cloth', 'coin', 'paper'];
export const COM_JP = { cloth: '布', coin: 'コイン', paper: '紙' };

export function grantCommodity(state, pid, com, n = 1) {
  const give = Math.min(n, state.bank.commodities[com]);
  state.bank.commodities[com] -= give;
  state.players[pid].commodities[com] += give;
  return give;
}

// 地形に隣接する自分の建物から資源を2枚ずつ得る(灌漑・鉱山)
function harvestTerrain(state, pid, terrain) {
  const res = TERRAIN_RESOURCE[terrain];
  let hexes = 0;
  for (const hid of LAYOUT.hexIds) {
    if (state.board.hexes[hid].terrain !== terrain) continue;
    const mine = LAYOUT.hexVertices[hid].some(
      (vid) => state.buildings[vid]?.player === pid,
    );
    if (mine) hexes++;
  }
  const got = grantResource(state, pid, res, hexes * 2);
  addLog(state, `${state.players[pid].name}が${RES_JP[res]}を${got}枚獲得`);
}

// カード定義: { deck, name, icon, needsParams, validate(state,pid,params), play(state,pid,params) }
export const PROGRESS_CARDS = {
  harvest: {
    deck: 'trade',
    name: '収穫祭',
    icon: '🧺',
    needsParams: 'resources2',
    validate(state, pid, params) {
      const picks = params?.resources ?? [];
      if (picks.length !== 2) return '資源を2つ選んでください';
      if (!picks.every((r) => RESOURCES.includes(r))) return '不正な資源です';
      return null;
    },
    play(state, pid, params) {
      for (const r of params.resources) grantResource(state, pid, r, 1);
    },
  },

  commodityCache: {
    deck: 'trade',
    name: '商品倉庫',
    icon: '📦',
    needsParams: 'commodity',
    validate(state, pid, params) {
      if (!COMMODITIES.includes(params?.commodity)) return '商品を選んでください';
      return null;
    },
    play(state, pid, params) {
      grantCommodity(state, pid, params.commodity, 1);
      addLog(state, `${state.players[pid].name}が${COM_JP[params.commodity]}を1枚獲得`);
    },
  },

  bishop: {
    deck: 'politics',
    name: '司教',
    icon: '⛪',
    needsParams: 'hex',
    validate(state, pid, params) {
      if (!state.board.hexes[params?.hexId]) return '不正なヘックスです';
      if (state.board.robber === params.hexId) return '盗賊は別のヘックスへ';
      return null;
    },
    play(state, pid, params) {
      state.board.robber = params.hexId;
      // 隣接する全プレイヤーから1枚ずつ奪う
      const victims = new Set();
      for (const vid of LAYOUT.hexVertices[params.hexId]) {
        const b = state.buildings[vid];
        if (b && b.player !== pid) victims.add(b.player);
      }
      for (const v of victims) {
        const t = state.players[v];
        const pool = [];
        for (const r of RESOURCES) for (let i = 0; i < t.resources[r]; i++) pool.push(['r', r]);
        for (const c of COMMODITIES) for (let i = 0; i < t.commodities[c]; i++) pool.push(['c', c]);
        if (!pool.length) continue;
        let idx;
        [state.rng, idx] = rngInt(state.rng, pool.length);
        const [kind, key] = pool[idx];
        if (kind === 'r') { t.resources[key]--; state.players[pid].resources[key]++; }
        else { t.commodities[key]--; state.players[pid].commodities[key]++; }
        addLog(state, `${state.players[pid].name}が${t.name}から1枚奪いました`);
      }
    },
  },

  irrigation: {
    deck: 'science',
    name: '灌漑',
    icon: '💧',
    needsParams: null,
    validate: () => null,
    play(state, pid) { harvestTerrain(state, pid, 'field'); },
  },

  mining: {
    deck: 'science',
    name: '鉱山',
    icon: '⛏️',
    needsParams: null,
    validate: () => null,
    play(state, pid) { harvestTerrain(state, pid, 'mountain'); },
  },

  // 勝利点カード(公開即得点)。play されることはない。
  vp: { deck: null, name: '勝利点', icon: '⭐', needsParams: null, validate: () => '公開済みです', play() {} },
};

// Phase 2 の簡易山札構成(各18枚)。Phase 3 でカード種を拡充する。
export function buildProgressDecks() {
  return {
    trade: [
      ...Array(10).fill('harvest'),
      ...Array(6).fill('commodityCache'),
      ...Array(2).fill('vp'),
    ],
    politics: [
      ...Array(8).fill('bishop'),
      ...Array(6).fill('harvest'),
      ...Array(4).fill('vp'),
    ],
    science: [
      ...Array(5).fill('irrigation'),
      ...Array(5).fill('mining'),
      ...Array(4).fill('commodityCache'),
      ...Array(4).fill('vp'),
    ],
  };
}

export const PROGRESS_HAND_LIMIT = 4;

// イベントダイスの色 + 赤ダイス目 ≦ 系統Lv+1 で進歩カード獲得(設計書 §9.4)
export function distributeProgressCards(state, track, redDie) {
  for (const p of state.players) {
    const lv = p.improvements[track];
    if (lv <= 0 || redDie > lv + 1) continue;
    const deck = state.bank.progressDecks[track];
    if (!deck.length) continue;
    const cardId = deck.pop();
    if (cardId === 'vp') {
      p.progressVP += 1;
      addLog(state, `${p.name}が進歩カード(勝利点)を公開! +1点`);
    } else if (p.progressCards.length >= PROGRESS_HAND_LIMIT) {
      deck.unshift(cardId); // 手札上限超過は山札の底へ(Phase 3 で選択捨てに拡張)
      addLog(state, `${p.name}は進歩カードの手札が上限のため獲得できず`);
    } else {
      p.progressCards.push({ id: cardId, deck: track, boughtTurn: state.turn });
      addLog(state, `${p.name}が進歩カードを1枚獲得(${track === 'trade' ? '交易' : track === 'politics' ? '政治' : '科学'})`);
    }
  }
}
