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
  WALL_COST,
  canAfford,
  canBuildWall,
  canPlaceCity,
  canPlaceRoad,
  canPlaceSettlement,
  grantResource,
  handLimit,
  payCost,
  totalCards,
  totalResources,
} from './rules/build.js';
import { rollTwoDice, rollEventDie, distributeForRoll } from './rules/dice.js';
import { stealableTargets, applyRobberMove } from './rules/robber.js';
import { tradeRate } from './rules/trade.js';
import {
  computePoints,
  pointsToWin,
  updateLargestArmy,
  updateLongestRoad,
} from './rules/victory.js';
import { RESOURCES, RES_JP, DEV_JP, addLog } from './state.js';
import {
  KNIGHT_COSTS,
  applyKnightMove,
  canChaseRobber,
  canMoveKnight,
  canPlaceKnight,
  canPromoteKnight,
} from './rules/cak/knights.js';
import {
  BARBARIAN_TRACK_LENGTH,
  razableCities,
  razeCity,
  resolveBarbarianAttack,
} from './rules/cak/barbarians.js';
import { applyImprovement, canBuyImprovement } from './rules/cak/improvements.js';
import {
  COMMODITIES,
  COM_JP,
  PROGRESS_CARDS,
  distributeProgressCards,
} from './rules/cak/progress-cards.js';

const ALL_CARD_KEYS = [...RESOURCES, ...COMMODITIES];

function sumRes(obj) {
  return ALL_CARD_KEYS.reduce((s, r) => s + (obj?.[r] ?? 0), 0);
}

function cardCount(player, key) {
  return RESOURCES.includes(key) ? player.resources[key] : player.commodities[key];
}

function fmtCards(obj) {
  return Object.entries(obj)
    .map(([r, n]) => `${RES_JP[r] ?? COM_JP[r]}×${n}`)
    .join(' ');
}

// a が give を渡し b から receive を受け取る
function applyPlayerTrade(state, aPid, bPid, give, receive) {
  const a = state.players[aPid];
  const b = state.players[bPid];
  const transfer = (from, to, obj) => {
    for (const [r, n] of Object.entries(obj)) {
      if (RESOURCES.includes(r)) {
        from.resources[r] -= n;
        to.resources[r] += n;
      } else {
        from.commodities[r] -= n;
        to.commodities[r] += n;
      }
    }
  };
  transfer(a, b, give);
  transfer(b, a, receive);
  addLog(state, `🤝 ${a.name} ⇄ ${b.name}: ${fmtCards(give)} ⇄ ${fmtCards(receive)}`);
}

// 割り込み(awaiting)中に許可されるアクション種別
const AWAITING_ACTIONS = {
  setupPlacement: 'PLACE_INITIAL',
  discard: 'DISCARD',
  moveRobber: 'MOVE_ROBBER',
  barbarianDefense: 'RAZE_CITY',
  tradeOffer: 'RESPOND_TRADE',
};

// プレイヤー間交易の内容チェック(giver が give を、receiver が receive を差し出せるか)
function validateTradeContents(state, giver, receiver, give, receive) {
  const keys = state.mode === 'cak' ? ALL_CARD_KEYS : RESOURCES;
  const validObj = (obj) =>
    obj != null &&
    Object.entries(obj).every(
      ([k, n]) => keys.includes(k) && Number.isInteger(n) && n > 0,
    );
  if (!validObj(give) || !validObj(receive)) return '交易内容が不正です';
  if (sumRes(give) === 0 || sumRes(receive) === 0) {
    return '渡すものともらうものを両方選んでください';
  }
  for (const [r, n] of Object.entries(give)) {
    if (cardCount(giver, r) < n) return '手札が足りません';
  }
  for (const [r, n] of Object.entries(receive)) {
    if (cardCount(receiver, r) < n) return '相手の手札が足りません';
  }
  return null;
}

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
      for (const r of ALL_CARD_KEYS) {
        const n = action.resources[r] ?? 0;
        if (n < 0) return '不正な枚数です';
        if (n > cardCount(p, r)) return '手札が足りません';
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
      if (state.mode === 'cak') return '都市と騎士では発展カードは使いません';
      if (!state.turnFlags.rolled) return '先にダイスを振ってください';
      if (!canAfford(p, COSTS.devCard)) return '資源が足りません(羊毛・小麦・鉱石 各1)';
      if (state.bank.devDeck.length === 0) return '発展カードの山札がありません';
      return null;
    }

    case 'TRADE_BANK': {
      if (!state.turnFlags.rolled) return '先にダイスを振ってください';
      const { give, receive } = action;
      const valid = (k) =>
        RESOURCES.includes(k) || (state.mode === 'cak' && COMMODITIES.includes(k));
      if (!valid(give) || !valid(receive)) return '不正な資源です';
      if (give === receive) return '同じものとは交換できません';
      const rate = tradeRate(state, pid, give);
      if (cardCount(p, give) < rate) return `${rate}枚必要です`;
      const stock = RESOURCES.includes(receive)
        ? state.bank.resources[receive]
        : state.bank.commodities[receive];
      if (stock < 1) return '銀行に在庫がありません';
      return null;
    }

    case 'TRADE_PLAYERS': {
      if (!state.turnFlags.rolled) return '先にダイスを振ってください';
      const partner = state.players[action.partner];
      if (!partner || action.partner === pid) return '交易相手が不正です';
      return validateTradeContents(state, p, partner, action.give, action.receive);
    }

    case 'OFFER_TRADE': {
      if (!state.turnFlags.rolled) return '先にダイスを振ってください';
      if (state.turnFlags.offeredTrade) return 'このターンはすでに交易を提案しました';
      const partner = state.players[action.partner];
      if (!partner || action.partner === pid) return '交易相手が不正です';
      return validateTradeContents(state, p, partner, action.give, action.receive);
    }

    case 'RESPOND_TRADE': {
      if (aw?.type !== 'tradeOffer') return '交易提案はありません';
      if (!action.accept) return null;
      const { from, give, receive } = aw.context;
      // 受諾時は提案者が give を、応答者(自分)が receive を差し出す
      return validateTradeContents(state, state.players[from], p, give, receive);
    }

    // ---- 都市と騎士(設計書 §9)----

    case 'BUILD_KNIGHT': {
      if (state.mode !== 'cak') return '都市と騎士モードではありません';
      if (!state.turnFlags.rolled) return '先にダイスを振ってください';
      if (!canAfford(p, KNIGHT_COSTS.build)) return '資源が足りません(羊毛1・鉱石1)';
      return canPlaceKnight(state, pid, action.vertexId);
    }

    case 'ACTIVATE_KNIGHT': {
      if (state.mode !== 'cak') return '都市と騎士モードではありません';
      if (!state.turnFlags.rolled) return '先にダイスを振ってください';
      const k = state.knights[action.vertexId];
      if (!k || k.player !== pid) return '自分の騎士ではありません';
      if (k.active) return 'すでに活性です';
      if (!canAfford(p, KNIGHT_COSTS.activate)) return '資源が足りません(小麦1)';
      return null;
    }

    case 'PROMOTE_KNIGHT': {
      if (state.mode !== 'cak') return '都市と騎士モードではありません';
      if (!state.turnFlags.rolled) return '先にダイスを振ってください';
      if (!canAfford(p, KNIGHT_COSTS.promote)) return '資源が足りません(羊毛1・鉱石1)';
      return canPromoteKnight(state, pid, action.vertexId);
    }

    case 'MOVE_KNIGHT': {
      if (state.mode !== 'cak') return '都市と騎士モードではありません';
      if (!state.turnFlags.rolled) return '先にダイスを振ってください';
      return canMoveKnight(state, pid, action.fromVertexId, action.toVertexId);
    }

    case 'CHASE_ROBBER': {
      if (state.mode !== 'cak') return '都市と騎士モードではありません';
      if (!state.turnFlags.rolled) return '先にダイスを振ってください';
      return canChaseRobber(state, pid, action.vertexId);
    }

    case 'BUILD_WALL': {
      if (state.mode !== 'cak') return '都市と騎士モードではありません';
      if (!state.turnFlags.rolled) return '先にダイスを振ってください';
      if (!canAfford(p, WALL_COST)) return '資源が足りません(レンガ2)';
      return canBuildWall(state, pid, action.vertexId);
    }

    case 'BUY_IMPROVEMENT': {
      if (state.mode !== 'cak') return '都市と騎士モードではありません';
      if (!state.turnFlags.rolled) return '先にダイスを振ってください';
      return canBuyImprovement(state, pid, action.track);
    }

    case 'PLAY_PROGRESS_CARD': {
      if (state.mode !== 'cak') return '都市と騎士モードではありません';
      if (!state.turnFlags.rolled) return '先にダイスを振ってください';
      const card = p.progressCards[action.index];
      if (!card) return 'そのカードを持っていません';
      if (card.boughtTurn >= state.turn) return '獲得したターンには使えません';
      const def = PROGRESS_CARDS[card.id];
      if (!def) return '不明なカードです';
      return def.validate(state, pid, action.params);
    }

    case 'RAZE_CITY': {
      if (!razableCities(state, pid).includes(action.vertexId)) {
        return 'その都市は降格対象にできません';
      }
      return null;
    }

    case 'PLAY_DEV_CARD': {
      if (state.mode === 'cak') return '都市と騎士では発展カードは使いません';
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
  if (pts >= pointsToWin(state)) {
    state.phase = 'ended';
    state.winner = pid;
    addLog(state, `🏆 ${state.players[pid].name}が${pts}点で勝利!`);
  }
}

// 出目合計の処理(7 → 捨て札/盗賊、それ以外 → 資源分配)。
// cak ではイベントダイス(蛮族)解決後に呼ばれる。
function processRollTotal(state, pid, total) {
  if (total === 7) {
    const required = {};
    for (const pl of state.players) {
      const n = totalCards(pl);
      const limit = handLimit(state, pl.id);
      if (n > limit) required[pl.id] = Math.floor(n / 2);
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
}

function applyAction(state, action) {
  const pid = action.player;
  const p = state.players[pid];

  switch (action.type) {
    case 'PLACE_INITIAL': {
      const round = state.awaiting.context.round;
      // 都市と騎士: 開拓地×1 + 都市×1(2巡目が都市。設計書 §9.1)
      const type = state.mode === 'cak' && round === 2 ? 'city' : 'settlement';
      state.buildings[action.vertexId] = { player: pid, type };
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

      if (state.mode === 'cak') {
        // 赤+黄+イベントダイス(設計書 §6, §9.3)。onDiceRolled フック相当。
        const ev = rollEventDie(state);
        state.eventDie = ev;
        const EV_JP = { ship: '⛵船', trade: '交易', politics: '政治', science: '科学' };
        addLog(state, `${p.name}のロール: ${a} + ${b} = ${total}(イベント: ${EV_JP[ev]})`);

        if (ev === 'ship') {
          state.barbarians.position += 1;
          addLog(state, `⛵ 蛮族船が前進(${state.barbarians.position}/${BARBARIAN_TRACK_LENGTH})`);
          if (state.barbarians.position >= BARBARIAN_TRACK_LENGTH) {
            const needChoice = resolveBarbarianAttack(state);
            if (needChoice.length > 0) {
              // 降格する都市の選択待ち。出目の処理は選択後に行う。
              state.awaiting = {
                type: 'barbarianDefense',
                players: needChoice,
                context: { pendingTotal: total, roller: pid },
              };
              break;
            }
          }
        } else {
          distributeProgressCards(state, ev, a); // a = 赤ダイス
        }
      } else {
        addLog(state, `${p.name}のロール: ${a} + ${b} = ${total}`);
      }

      processRollTotal(state, pid, total);
      break;
    }

    case 'DISCARD': {
      for (const r of RESOURCES) {
        const n = action.resources[r] ?? 0;
        p.resources[r] -= n;
        state.bank.resources[r] += n;
      }
      for (const c of COMMODITIES) {
        const n = action.resources[c] ?? 0;
        p.commodities[c] -= n;
        state.bank.commodities[c] += n;
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

    case 'RAZE_CITY': {
      razeCity(state, action.vertexId);
      state.awaiting.players = state.awaiting.players.filter((x) => x !== pid);
      if (state.awaiting.players.length === 0) {
        const { pendingTotal, roller } = state.awaiting.context;
        state.awaiting = null;
        processRollTotal(state, roller, pendingTotal);
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
      const move = (key, delta) => {
        if (RESOURCES.includes(key)) {
          p.resources[key] += delta;
          state.bank.resources[key] -= delta;
        } else {
          p.commodities[key] += delta;
          state.bank.commodities[key] -= delta;
        }
      };
      move(action.give, -rate);
      move(action.receive, 1);
      addLog(state, `${p.name}が${rate}:1 交易(${action.give} → ${action.receive})`);
      break;
    }

    case 'TRADE_PLAYERS':
      applyPlayerTrade(state, pid, action.partner, action.give, action.receive);
      break;

    case 'OFFER_TRADE': {
      const partner = state.players[action.partner];
      state.turnFlags.offeredTrade = true;
      state.awaiting = {
        type: 'tradeOffer',
        players: [action.partner],
        context: { from: pid, give: action.give, receive: action.receive },
      };
      addLog(
        state,
        `💬 ${p.name}が${partner.name}に交易を提案: ${fmtCards(action.give)} ⇄ ${fmtCards(action.receive)}`,
      );
      break;
    }

    case 'RESPOND_TRADE': {
      const { from, give, receive } = state.awaiting.context;
      state.awaiting = null;
      if (action.accept) {
        applyPlayerTrade(state, from, pid, give, receive);
      } else {
        // 断られた提案者はしばらく同じ相手に持ちかけない
        state.players[from].offerCooldownTurn = state.turn + 4;
        addLog(state, `🚫 ${p.name}は${state.players[from].name}の提案を断りました`);
      }
      break;
    }

    // ---- 都市と騎士 ----

    case 'BUILD_KNIGHT':
      payCost(state, pid, KNIGHT_COSTS.build);
      state.knights[action.vertexId] = {
        player: pid, level: 1, active: false, activatedTurn: -1,
      };
      addLog(state, `${p.name}が騎士を配置しました(不活性)`);
      break;

    case 'ACTIVATE_KNIGHT': {
      payCost(state, pid, KNIGHT_COSTS.activate);
      const k = state.knights[action.vertexId];
      k.active = true;
      k.activatedTurn = state.turn;
      addLog(state, `${p.name}が騎士を活性化しました`);
      break;
    }

    case 'PROMOTE_KNIGHT': {
      payCost(state, pid, KNIGHT_COSTS.promote);
      const k = state.knights[action.vertexId];
      k.level += 1;
      addLog(state, `${p.name}が騎士をLv${k.level}に昇格させました`);
      break;
    }

    case 'MOVE_KNIGHT':
      applyKnightMove(state, pid, action.fromVertexId, action.toVertexId);
      addLog(state, `${p.name}が騎士を移動しました`);
      break;

    case 'CHASE_ROBBER':
      state.knights[action.vertexId].active = false;
      addLog(state, `${p.name}の騎士が盗賊を追い払います`);
      state.awaiting = { type: 'moveRobber', players: [pid], context: { cause: 'knight' } };
      break;

    case 'BUILD_WALL':
      payCost(state, pid, WALL_COST);
      state.walls[action.vertexId] = pid;
      addLog(state, `${p.name}が城壁を建設しました(手札上限+2)`);
      break;

    case 'BUY_IMPROVEMENT':
      applyImprovement(state, pid, action.track);
      break;

    case 'PLAY_PROGRESS_CARD': {
      const card = p.progressCards.splice(action.index, 1)[0];
      const def = PROGRESS_CARDS[card.id];
      addLog(state, `${p.name}が進歩カード「${def.name}」を使用`);
      def.play(state, pid, action.params);
      state.bank.progressDecks[card.deck].unshift(card.id); // 使用済みは山札の底へ
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
