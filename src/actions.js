// アクション定義と dispatch(設計書 §5)
//
// dispatch(state, action):
//   1. validateAction(純粋関数、エラー文字列 or null)
//   2. structuredClone した新 state に applyAction
//   3. postHooks(最長交易路・最大騎士力・勝利判定)
// CPU も人間も UI も同じアクションを発行する。

import { LAYOUT, TERRAIN_RESOURCE } from './rules/board.js';
import {
  COSTS,
  canAfford,
  canPlaceCity,
  canPlaceRoad,
  canPlaceSettlement,
  grantResource,
  payCost,
  totalResources,
} from './rules/build.js';
import { rollTwoDice, distributeForRoll } from './rules/dice.js';
import { stealableTargets, applyRobberMove } from './rules/robber.js';
import { tradeRate } from './rules/trade.js';
import {
  computePoints,
  updateLargestArmy,
  updateLongestRoad,
  VICTORY_POINTS_TO_WIN,
} from './rules/victory.js';
import { RESOURCES, RES_JP, DEV_JP, addLog } from './state.js';

function sumRes(obj) {
  return RESOURCES.reduce((s, r) => s + (obj?.[r] ?? 0), 0);
}

// 割り込み(awaiting)中に許可されるアクション種別
const AWAITING_ACTIONS = {
  setupPlacement: 'PLACE_INITIAL',
  discard: 'DISCARD',
  moveRobber: 'MOVE_ROBBER',
};

export function validateAction(state, action) {
  if (state.phase === 'ended') return 'ゲームは終了しています';
  const pid = action.player;
  const p = state.players[pid];
  if (!p) return '不正なプレイヤーです';

  const aw = state.awaiting;
  if (aw) {
    if (AWAITING_ACTIONS[aw.type] !== action.type) return `${aw.type} の応答待ちです`;
    if (!aw.players.includes(pid)) return 'あなたの応答待ちではありません';
  } else {
    if (state.phase !== 'main') return 'メインフェーズではありません';
    if (pid !== state.currentPlayer) return 'あなたの手番ではありません';
  }

  switch (action.type) {
    case 'PLACE_INITIAL': {
      const err = canPlaceSettlement(state, pid, action.vertexId, { needRoad: false });
      if (err) return err;
      const edge = LAYOUT.edges[action.edgeId];
      if (!edge) return '不正な辺です';
      if (state.roads[action.edgeId]) return 'その辺には道があります';
      if (!edge.v.includes(action.vertexId)) return '道は開拓地に隣接させてください';
      return null;
    }

    case 'DISCARD': {
      const need = aw.context.required[pid];
      if (need == null) return '捨て札は不要です';
      if (sumRes(action.resources) !== need) return `ちょうど${need}枚捨ててください`;
      for (const r of RESOURCES) {
        if ((action.resources[r] ?? 0) < 0) return '不正な枚数です';
        if ((action.resources[r] ?? 0) > p.resources[r]) return `${RES_JP[r]}が足りません`;
      }
      return null;
    }

    case 'MOVE_ROBBER': {
      if (!state.board.hexes[action.hexId]) return '不正なヘックスです';
      if (state.board.robber === action.hexId) return '盗賊は別のヘックスへ移動してください';
      const targets = stealableTargets(state, action.hexId, pid);
      if (targets.length > 0) {
        if (action.targetPlayer == null) return '略奪する相手を選んでください';
        if (!targets.includes(action.targetPlayer)) return 'その相手からは奪えません';
      } else if (action.targetPlayer != null) {
        return '奪える相手がいません';
      }
      return null;
    }

    case 'ROLL_DICE':
      if (state.turnFlags.rolled) return 'すでにダイスを振りました';
      return null;

    case 'BUILD_ROAD': {
      if (!state.turnFlags.rolled) return '先にダイスを振ってください';
      if (!canAfford(p, COSTS.road)) return '資源が足りません(木材1・レンガ1)';
      return canPlaceRoad(state, pid, action.edgeId);
    }

    case 'BUILD_SETTLEMENT': {
      if (!state.turnFlags.rolled) return '先にダイスを振ってください';
      if (!canAfford(p, COSTS.settlement)) return '資源が足りません(木材・レンガ・羊毛・小麦 各1)';
      return canPlaceSettlement(state, pid, action.vertexId);
    }

    case 'BUILD_CITY': {
      if (!state.turnFlags.rolled) return '先にダイスを振ってください';
      if (!canAfford(p, COSTS.city)) return '資源が足りません(小麦2・鉱石3)';
      return canPlaceCity(state, pid, action.vertexId);
    }

    case 'BUY_DEV_CARD': {
      if (!state.turnFlags.rolled) return '先にダイスを振ってください';
      if (!canAfford(p, COSTS.devCard)) return '資源が足りません(羊毛・小麦・鉱石 各1)';
      if (state.bank.devDeck.length === 0) return '発展カードの山札がありません';
      return null;
    }

    case 'TRADE_BANK': {
      if (!state.turnFlags.rolled) return '先にダイスを振ってください';
      const { give, receive } = action;
      if (!RESOURCES.includes(give) || !RESOURCES.includes(receive)) return '不正な資源です';
      if (give === receive) return '同じ資源とは交換できません';
      const rate = tradeRate(state, pid, give);
      if (p.resources[give] < rate) return `${RES_JP[give]}が${rate}枚必要です`;
      if (state.bank.resources[receive] < 1) return `銀行に${RES_JP[receive]}がありません`;
      return null;
    }

    case 'PLAY_DEV_CARD': {
      if (state.turnFlags.playedDev) return 'このターンはすでに発展カードを使いました';
      const card = p.devCards.find(
        (c) => c.type === action.card && c.boughtTurn < state.turn,
      );
      if (!card) {
        if (p.devCards.some((c) => c.type === action.card)) {
          return '購入したターンには使えません';
        }
        return 'そのカードを持っていません';
      }
      if (action.card === 'vp') return '勝利点カードは使用できません(自動で得点されます)';
      // 騎士のみロール前でも可
      if (action.card !== 'knight' && !state.turnFlags.rolled) {
        return '先にダイスを振ってください';
      }
      switch (action.card) {
        case 'knight':
          return null;
        case 'roadBuilding': {
          const edges = action.params?.edges ?? [];
          if (edges.length < 1 || edges.length > 2) return '道を1〜2本選んでください';
          const err1 = canPlaceRoad(state, pid, edges[0]);
          if (err1) return err1;
          if (edges.length === 2) {
            return canPlaceRoad(state, pid, edges[1], { extraRoads: { [edges[0]]: true } });
          }
          return null;
        }
        case 'yearOfPlenty': {
          const picks = action.params?.resources ?? [];
          if (picks.length !== 2) return '資源を2つ選んでください';
          const need = {};
          for (const r of picks) {
            if (!RESOURCES.includes(r)) return '不正な資源です';
            need[r] = (need[r] ?? 0) + 1;
          }
          for (const [r, n] of Object.entries(need)) {
            if (state.bank.resources[r] < n) return `銀行に${RES_JP[r]}がありません`;
          }
          return null;
        }
        case 'monopoly':
          if (!RESOURCES.includes(action.params?.resource)) return '資源を選んでください';
          return null;
        default:
          return '不明なカードです';
      }
    }

    case 'END_TURN':
      if (!state.turnFlags.rolled) return '先にダイスを振ってください';
      return null;

    default:
      return `不明なアクション: ${action.type}`;
  }
}

function checkVictoryFor(state, pid) {
  if (state.phase !== 'main' || state.winner != null) return;
  const pts = computePoints(state, pid, { includeHidden: true });
  if (pts >= VICTORY_POINTS_TO_WIN) {
    state.phase = 'ended';
    state.winner = pid;
    addLog(state, `🏆 ${state.players[pid].name}が${pts}点で勝利!`);
  }
}

function applyAction(state, action) {
  const pid = action.player;
  const p = state.players[pid];

  switch (action.type) {
    case 'PLACE_INITIAL': {
      const round = state.awaiting.context.round;
      state.buildings[action.vertexId] = { player: pid, type: 'settlement' };
      state.roads[action.edgeId] = { player: pid };
      addLog(state, `${p.name}が初期配置(${round}巡目)を行いました`);

      if (round === 2) {
        // 2軒目の開拓地から初期資源
        for (const hid of LAYOUT.vertexHexes[action.vertexId]) {
          const res = TERRAIN_RESOURCE[state.board.hexes[hid].terrain];
          if (res) grantResource(state, pid, res, 1);
        }
      }

      state.setup.index += 1;
      if (state.setup.index < state.setup.queue.length) {
        const next = state.setup.queue[state.setup.index];
        state.currentPlayer = next.player;
        state.awaiting = {
          type: 'setupPlacement',
          players: [next.player],
          context: { round: next.round },
        };
      } else {
        state.phase = 'main';
        state.turn = 1;
        state.currentPlayer = 0;
        state.awaiting = null;
        state.turnFlags = { rolled: false, playedDev: false };
        addLog(state, `── ゲーム開始! ${state.players[0].name}の手番 ──`);
      }
      break;
    }

    case 'ROLL_DICE': {
      const [a, b] = rollTwoDice(state);
      const total = a + b;
      state.dice = [a, b];
      state.turnFlags.rolled = true;
      addLog(state, `${p.name}のロール: ${a} + ${b} = ${total}`);
      if (total === 7) {
        const required = {};
        for (const pl of state.players) {
          const n = totalResources(pl);
          if (n > 7) required[pl.id] = Math.floor(n / 2);
        }
        const waiting = Object.keys(required).map(Number);
        if (waiting.length > 0) {
          state.awaiting = { type: 'discard', players: waiting, context: { required } };
          addLog(state, `7! ${waiting.map((i) => state.players[i].name).join('・')}は手札の半分を捨てます`);
        } else {
          state.awaiting = { type: 'moveRobber', players: [pid], context: { cause: 'seven' } };
        }
      } else {
        distributeForRoll(state, total);
      }
      break;
    }

    case 'DISCARD': {
      for (const r of RESOURCES) {
        const n = action.resources[r] ?? 0;
        p.resources[r] -= n;
        state.bank.resources[r] += n;
      }
      addLog(state, `${p.name}が${sumRes(action.resources)}枚捨てました`);
      state.awaiting.players = state.awaiting.players.filter((x) => x !== pid);
      if (state.awaiting.players.length === 0) {
        state.awaiting = {
          type: 'moveRobber',
          players: [state.currentPlayer],
          context: { cause: 'seven' },
        };
      }
      break;
    }

    case 'MOVE_ROBBER':
      applyRobberMove(state, pid, action.hexId, action.targetPlayer ?? null);
      state.awaiting = null;
      break;

    case 'BUILD_ROAD':
      payCost(state, pid, COSTS.road);
      state.roads[action.edgeId] = { player: pid };
      addLog(state, `${p.name}が道を建設しました`);
      updateLongestRoad(state);
      break;

    case 'BUILD_SETTLEMENT':
      payCost(state, pid, COSTS.settlement);
      state.buildings[action.vertexId] = { player: pid, type: 'settlement' };
      addLog(state, `${p.name}が開拓地を建設しました`);
      updateLongestRoad(state); // 敵の道を分断する可能性がある
      break;

    case 'BUILD_CITY':
      payCost(state, pid, COSTS.city);
      state.buildings[action.vertexId] = { player: pid, type: 'city' };
      addLog(state, `${p.name}が都市を建設しました`);
      break;

    case 'BUY_DEV_CARD': {
      payCost(state, pid, COSTS.devCard);
      const type = state.bank.devDeck.pop();
      p.devCards.push({ type, boughtTurn: state.turn });
      addLog(state, `${p.name}が発展カードを購入しました(残り${state.bank.devDeck.length}枚)`);
      break;
    }

    case 'PLAY_DEV_CARD': {
      const idx = p.devCards.findIndex(
        (c) => c.type === action.card && c.boughtTurn < state.turn,
      );
      p.devCards.splice(idx, 1);
      state.turnFlags.playedDev = true;
      addLog(state, `${p.name}が「${DEV_JP[action.card]}」を使用`);

      switch (action.card) {
        case 'knight':
          p.knightsPlayed += 1;
          updateLargestArmy(state);
          state.awaiting = { type: 'moveRobber', players: [pid], context: { cause: 'knight' } };
          break;
        case 'roadBuilding':
          for (const eid of action.params.edges) {
            state.roads[eid] = { player: pid };
          }
          updateLongestRoad(state);
          break;
        case 'yearOfPlenty':
          for (const r of action.params.resources) grantResource(state, pid, r, 1);
          break;
        case 'monopoly': {
          const res = action.params.resource;
          let taken = 0;
          for (const other of state.players) {
            if (other.id === pid) continue;
            taken += other.resources[res];
            p.resources[res] += other.resources[res];
            other.resources[res] = 0;
          }
          addLog(state, `${p.name}が${RES_JP[res]}を${taken}枚独占!`);
          break;
        }
      }
      break;
    }

    case 'TRADE_BANK': {
      const rate = tradeRate(state, pid, action.give);
      p.resources[action.give] -= rate;
      state.bank.resources[action.give] += rate;
      state.bank.resources[action.receive] -= 1;
      p.resources[action.receive] += 1;
      addLog(state, `${p.name}が${RES_JP[action.give]}×${rate} → ${RES_JP[action.receive]}×1 を交易`);
      break;
    }

    case 'END_TURN': {
      checkVictoryFor(state, pid);
      if (state.phase === 'ended') break;
      state.currentPlayer = (pid + 1) % state.players.length;
      state.turn += 1;
      state.turnFlags = { rolled: false, playedDev: false };
      state.dice = null;
      addLog(state, `── ${state.players[state.currentPlayer].name}の手番 ──`);
      break;
    }
  }
}

export function dispatch(prev, action) {
  const err = validateAction(prev, action);
  if (err) {
    const e = new Error(err);
    e.action = action;
    throw e;
  }
  const state = structuredClone(prev);
  applyAction(state, action);
  // postHooks: 手番プレイヤーの即時勝利判定(END_TURN 内は個別に処理済み)
  if (action.type !== 'END_TURN' && action.player === state.currentPlayer) {
    checkVictoryFor(state, action.player);
  }
  return state;
}
