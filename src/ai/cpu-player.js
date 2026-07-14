// CPU 思考ルーチン(設計書 §7)
// chooseAction(state, pid) は「次の1手」を返す。コントローラが繰り返し呼ぶ。
// awaiting への応答は即時に決定できる。返す前に必ず validate を通す。

import { validateAction } from '../actions.js';
import { LAYOUT } from '../rules/board.js';
import { COSTS, canAfford, countPieces, PIECE_LIMITS, totalResources } from '../rules/build.js';
import { stealableTargets } from '../rules/robber.js';
import { tradeRate } from '../rules/trade.js';
import { RESOURCES } from '../state.js';
import {
  legalCityVertices,
  legalRoadEdges,
  legalRobberHexes,
  legalSettlementVertices,
  legalSetupEdges,
} from './legal-moves.js';
import { missingFor, robberHexValue, vertexValue } from './evaluator.js';

function valid(state, action) {
  return action && validateAction(state, action) === null ? action : null;
}

function best(items, scoreFn) {
  let bestItem = null;
  let bestScore = -Infinity;
  for (const it of items) {
    const s = scoreFn(it);
    if (s > bestScore) {
      bestScore = s;
      bestItem = it;
    }
  }
  return bestItem;
}

// ---- awaiting 応答 ----

function chooseInitialPlacement(state, pid) {
  const vids = legalSettlementVertices(state, pid, { needRoad: false });
  const vid = best(vids, (v) => vertexValue(state, pid, v));
  const edges = legalSetupEdges(state, vid);
  // 道は「先の頂点の価値が高い」方向へ伸ばす
  const eid = best(edges, (e) => {
    const other = LAYOUT.edges[e].v.find((v) => v !== vid);
    return vertexValue(state, pid, other);
  });
  return { type: 'PLACE_INITIAL', player: pid, vertexId: vid, edgeId: eid };
}

function chooseDiscard(state, pid) {
  const p = state.players[pid];
  const need = state.awaiting.context.required[pid];
  const goal = nextGoal(state, pid);
  const keep = { ...(goal?.cost ?? {}) };
  const counts = { ...p.resources };
  const discard = { wood: 0, brick: 0, sheep: 0, wheat: 0, ore: 0 };
  for (let i = 0; i < need; i++) {
    // 目標コストを超えた余剰が最も多い資源から捨てる
    const r = best(RESOURCES.filter((x) => counts[x] > 0), (x) => {
      const surplus = counts[x] - (keep[x] ?? 0);
      return surplus * 10 + counts[x];
    });
    counts[r] -= 1;
    discard[r] += 1;
  }
  return { type: 'DISCARD', player: pid, resources: discard };
}

function chooseRobberMove(state, pid) {
  const hexes = legalRobberHexes(state);
  const hid = best(hexes, (h) => robberHexValue(state, pid, h));
  const targets = stealableTargets(state, hid, pid);
  const target = targets.length
    ? best(targets, (t) => totalResources(state.players[t]))
    : null;
  return { type: 'MOVE_ROBBER', player: pid, hexId: hid, targetPlayer: target };
}

// ---- メインターンの目標決定 ----

// 次に建てたい物を1つ決める(交易・捨て札の基準)
export function nextGoal(state, pid) {
  if (legalCityVertices(state, pid).length > 0 && countPieces(state, pid, 'city') < PIECE_LIMITS.city) {
    return { kind: 'city', cost: COSTS.city };
  }
  if (
    legalSettlementVertices(state, pid).length > 0 &&
    countPieces(state, pid, 'settlement') < PIECE_LIMITS.settlement
  ) {
    return { kind: 'settlement', cost: COSTS.settlement };
  }
  if (countPieces(state, pid, 'road') < PIECE_LIMITS.road && legalRoadEdges(state, pid).length > 0) {
    return { kind: 'road', cost: COSTS.road };
  }
  if (state.bank.devDeck.length > 0) {
    return { kind: 'devCard', cost: COSTS.devCard };
  }
  return null;
}

// 道の先の拡張価値(空き頂点で隣に建物がない = 将来の入植候補)
function roadEdgeValue(state, pid, eid) {
  let v = 0.1;
  for (const vid of LAYOUT.edges[eid].v) {
    if (state.buildings[vid]) continue;
    const blocked = LAYOUT.vertexAdj[vid].some((a) => state.buildings[a]);
    const val = vertexValue(state, pid, vid);
    v = Math.max(v, blocked ? val * 0.2 : val);
  }
  return v;
}

function tryTradeTowardGoal(state, pid, goal) {
  if (!goal) return null;
  const p = state.players[pid];
  const missing = missingFor(p, goal.cost);
  const missingRes = Object.keys(missing);
  if (missingRes.length === 0) return null;
  for (const give of RESOURCES) {
    const rate = tradeRate(state, pid, give);
    const surplus = p.resources[give] - (goal.cost[give] ?? 0);
    if (surplus >= rate) {
      const receive = best(missingRes, (r) => missing[r]);
      const action = { type: 'TRADE_BANK', player: pid, give, receive };
      if (valid(state, action)) return action;
    }
  }
  return null;
}

function tryPlayDevCard(state, pid) {
  const p = state.players[pid];
  const playable = (type) =>
    p.devCards.some((c) => c.type === type && c.boughtTurn < state.turn) &&
    !state.turnFlags.playedDev;

  // 騎士: 盗賊が自分の産出ヘックスにいるなら追い払う(ロール前でも可)
  if (playable('knight')) {
    const robberHex = state.board.robber;
    const blocksMe = LAYOUT.hexVertices[robberHex].some(
      (vid) => state.buildings[vid]?.player === pid,
    );
    const armyRace =
      p.knightsPlayed >= 2 && state.largestArmy.player !== pid;
    if (blocksMe || armyRace) {
      return valid(state, { type: 'PLAY_DEV_CARD', player: pid, card: 'knight' });
    }
  }
  if (!state.turnFlags.rolled) return null;

  if (playable('roadBuilding')) {
    const e1 = best(legalRoadEdges(state, pid), (e) => roadEdgeValue(state, pid, e));
    if (e1) {
      const e2 = best(
        legalRoadEdges(state, pid, { extraRoads: { [e1]: true } }).filter((e) => e !== e1),
        (e) => roadEdgeValue(state, pid, e),
      );
      const edges = e2 ? [e1, e2] : [e1];
      const a = valid(state, {
        type: 'PLAY_DEV_CARD',
        player: pid,
        card: 'roadBuilding',
        params: { edges },
      });
      if (a) return a;
    }
  }

  if (playable('yearOfPlenty')) {
    const goal = nextGoal(state, pid);
    if (goal) {
      const missing = missingFor(state.players[pid], goal.cost);
      const list = [];
      for (const [r, n] of Object.entries(missing)) {
        for (let i = 0; i < n && list.length < 2; i++) list.push(r);
      }
      if (list.length === 2) {
        const a = valid(state, {
          type: 'PLAY_DEV_CARD',
          player: pid,
          card: 'yearOfPlenty',
          params: { resources: list },
        });
        if (a) return a;
      }
    }
  }

  if (playable('monopoly')) {
    // 他プレイヤーの持ち枚数が最大の資源。5枚以上見込めるときだけ使う
    const totals = RESOURCES.map((r) => [
      r,
      state.players.reduce((s, o) => (o.id === pid ? s : s + o.resources[r]), 0),
    ]);
    const [res, n] = best(totals, ([, cnt]) => cnt);
    if (n >= 5) {
      const a = valid(state, {
        type: 'PLAY_DEV_CARD',
        player: pid,
        card: 'monopoly',
        params: { resource: res },
      });
      if (a) return a;
    }
  }
  return null;
}

// ---- 本体 ----

export function chooseAction(state, pid) {
  if (state.phase === 'ended') return null;

  const aw = state.awaiting;
  if (aw) {
    if (!aw.players.includes(pid)) return null;
    if (aw.type === 'setupPlacement') return chooseInitialPlacement(state, pid);
    if (aw.type === 'discard') return chooseDiscard(state, pid);
    if (aw.type === 'moveRobber') return chooseRobberMove(state, pid);
    return null;
  }

  if (state.phase !== 'main' || state.currentPlayer !== pid) return null;
  const p = state.players[pid];

  if (!state.turnFlags.rolled) {
    return tryPlayDevCard(state, pid) ?? { type: 'ROLL_DICE', player: pid };
  }

  // 1. 都市(最良の開拓地を昇格)
  if (canAfford(p, COSTS.city)) {
    const vids = legalCityVertices(state, pid);
    const vid = best(vids, (v) => vertexValue(state, pid, v));
    const a = valid(state, { type: 'BUILD_CITY', player: pid, vertexId: vid });
    if (a) return a;
  }

  // 2. 開拓地
  if (canAfford(p, COSTS.settlement)) {
    const vids = legalSettlementVertices(state, pid);
    const vid = best(vids, (v) => vertexValue(state, pid, v));
    const a = valid(state, { type: 'BUILD_SETTLEMENT', player: pid, vertexId: vid });
    if (a) return a;
  }

  // 3. 発展カード使用
  const dev = tryPlayDevCard(state, pid);
  if (dev) return dev;

  // 4. 入植先がないなら道で拡張(資源を貯めすぎない範囲で)
  const hasSpot = legalSettlementVertices(state, pid).length > 0;
  if (canAfford(p, COSTS.road) && (!hasSpot || totalResources(p) > 7)) {
    const edges = legalRoadEdges(state, pid);
    const eid = best(edges, (e) => roadEdgeValue(state, pid, e));
    if (eid && roadEdgeValue(state, pid, eid) > 1) {
      const a = valid(state, { type: 'BUILD_ROAD', player: pid, edgeId: eid });
      if (a) return a;
    }
  }

  // 5. 目標に向けた銀行/港交易
  const goal = nextGoal(state, pid);
  const trade = tryTradeTowardGoal(state, pid, goal);
  if (trade) return trade;

  // 6. 発展カード購入(余裕があるとき)
  if (canAfford(p, COSTS.devCard) && state.bank.devDeck.length > 0) {
    const wantSettlement = goal?.kind === 'settlement' || goal?.kind === 'city';
    if (!wantSettlement || totalResources(p) > 8) {
      const a = valid(state, { type: 'BUY_DEV_CARD', player: pid });
      if (a) return a;
    }
  }

  return { type: 'END_TURN', player: pid };
}
