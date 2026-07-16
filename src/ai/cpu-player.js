// CPU 思考ルーチン(設計書 §7)
// chooseAction(state, pid) は「次の1手」を返す。コントローラが繰り返し呼ぶ。
// awaiting への応答は即時に決定できる。返す前に必ず validate を通す。

import { validateAction } from '../actions.js';
import { LAYOUT } from '../rules/board.js';
import {
  COSTS, WALL_COST, canAfford, countPieces, PIECE_LIMITS, totalResources, totalCards,
} from '../rules/build.js';
import { stealableTargets } from '../rules/robber.js';
import { tradeRate } from '../rules/trade.js';
import { RESOURCES } from '../state.js';
import { KNIGHT_COSTS, canPlaceKnight } from '../rules/cak/knights.js';
import { knightContribution, razableCities } from '../rules/cak/barbarians.js';
import { TRACKS, TRACK_COMMODITY, canBuyImprovement } from '../rules/cak/improvements.js';
import { COMMODITIES, PROGRESS_CARDS } from '../rules/cak/progress-cards.js';
import { pickProgressPlay, pickAlchemist } from './progress-ai.js';
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
  const counts = {};
  for (const r of RESOURCES) counts[r] = p.resources[r];
  for (const c of COMMODITIES) counts[c] = p.commodities[c];
  const discard = {};
  const keys = [...RESOURCES, ...COMMODITIES];
  for (let i = 0; i < need; i++) {
    // 目標コストを超えた余剰が多い資源から。商品は価値が高いので温存する
    const r = best(keys.filter((x) => counts[x] > 0), (x) => {
      const surplus = counts[x] - (keep[x] ?? 0);
      const commodityPenalty = COMMODITIES.includes(x) ? -8 : 0;
      return surplus * 10 + counts[x] + commodityPenalty;
    });
    counts[r] -= 1;
    discard[r] = (discard[r] ?? 0) + 1;
  }
  return { type: 'DISCARD', player: pid, resources: discard };
}

function chooseRobberMove(state, pid) {
  const hexes = legalRobberHexes(state);
  const hid = best(hexes, (h) => robberHexValue(state, pid, h));
  const targets = stealableTargets(state, hid, pid);
  const target = targets.length
    ? best(targets, (t) => totalCards(state.players[t]))
    : null;
  return { type: 'MOVE_ROBBER', player: pid, hexId: hid, targetPlayer: target };
}

function chooseRaze(state, pid) {
  const cities = razableCities(state, pid);
  // 最も価値の低い都市を差し出す
  const vid = best(cities, (v) => -vertexValue(state, pid, v));
  return { type: 'RAZE_CITY', player: pid, vertexId: vid };
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
  if (state.mode === 'cak') {
    return { kind: 'knight', cost: KNIGHT_COSTS.build };
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
  const giveKeys = state.mode === 'cak' ? [...RESOURCES, ...COMMODITIES] : RESOURCES;
  for (const give of giveKeys) {
    const rate = tradeRate(state, pid, give);
    const have = RESOURCES.includes(give) ? p.resources[give] : p.commodities[give];
    const surplus = have - (goal.cost[give] ?? 0);
    // 商品は改良に使うので、2:1 レートのときだけ手放す
    if (COMMODITIES.includes(give) && rate > 2) continue;
    if (surplus >= rate) {
      const receive = best(missingRes, (r) => missing[r]);
      const action = { type: 'TRADE_BANK', player: pid, give, receive };
      if (valid(state, action)) return action;
    }
  }
  return null;
}

// ---- プレイヤー間交易 ----

function cardCountOf(player, key) {
  return RESOURCES.includes(key) ? player.resources[key] : player.commodities[key];
}

// pid が「incoming をもらい outgoing を渡す」取引を受けるかどうか。
// 次の目標への不足資源は高く、余剰は安く評価し、明確に得なときだけ受ける。
export function cpuAcceptsTrade(state, pid, incoming, outgoing) {
  const p = state.players[pid];
  for (const [r, n] of Object.entries(outgoing)) {
    if (cardCountOf(p, r) < n) return false;
  }
  const goal = nextGoal(state, pid);
  const missing = goal ? missingFor(p, goal.cost) : {};

  const valueOf = (r, forIncoming) => {
    let v = COMMODITIES.includes(r) ? 1.35 : 1.0;
    if (missing[r]) v += forIncoming ? 1.0 : 1.3; // 不足資源は欲しいし、手放したくない
    const surplus = cardCountOf(p, r) - (goal?.cost?.[r] ?? 0);
    if (!forIncoming && surplus >= 3) v -= 0.3; // 余りは安く出せる
    return v;
  };

  let inValue = 0;
  for (const [r, n] of Object.entries(incoming)) inValue += valueOf(r, true) * n;
  let outValue = 0;
  for (const [r, n] of Object.entries(outgoing)) outValue += valueOf(r, false) * n;

  // 枚数差が大きすぎる取引は数量で損(手札上限・柔軟性)
  const countDiff = Object.values(outgoing).reduce((a, b) => a + b, 0) -
    Object.values(incoming).reduce((a, b) => a + b, 0);
  // 弱いCPUは多少不利な取引にも応じる
  const margin = state.difficulty === 'easy' ? 0.1 : state.difficulty === 'normal' ? 0.35 : 0.5;
  return inValue >= outValue + margin + Math.max(0, countDiff) * 0.3;
}

// CPU が他の CPU に 1:1 交易を持ちかける(不足資源 ⇄ 余剰資源)
function tryTradeWithPlayers(state, pid, goal) {
  if (!goal) return null;
  const p = state.players[pid];
  const missing = missingFor(p, goal.cost);
  const missingRes = Object.keys(missing);
  if (!missingRes.length) return null;

  const surpluses = RESOURCES.filter(
    (r) => p.resources[r] - (goal.cost[r] ?? 0) >= 2 && !missing[r],
  );
  // CPU同士は即時成立、人間には提案(応答待ち割り込み)を送る
  const others = [...state.players].filter((o) => o.id !== pid);
  others.sort((a, b) => Number(b.isCPU) - Number(a.isCPU)); // まずCPUと当たる
  for (const want of missingRes) {
    for (const give of surpluses) {
      for (const other of others) {
        if (cardCountOf(other, want) < 1) continue;
        if (other.isCPU) {
          if (!cpuAcceptsTrade(state, other.id, { [give]: 1 }, { [want]: 1 })) continue;
          const action = {
            type: 'TRADE_PLAYERS', player: pid, partner: other.id,
            give: { [give]: 1 }, receive: { [want]: 1 },
          };
          if (valid(state, action)) return action;
        } else {
          if ((p.offerCooldownTurn ?? 0) > state.turn) continue; // 直近で断られた
          const action = {
            type: 'OFFER_TRADE', player: pid, partner: other.id,
            give: { [give]: 1 }, receive: { [want]: 1 },
          };
          if (valid(state, action)) return action;
        }
      }
    }
  }
  return null;
}

// ---- 基本カタン: 発展カード ----

function tryPlayDevCard(state, pid) {
  if (state.mode === 'cak') return null;
  const p = state.players[pid];
  const playable = (type) =>
    p.devCards.some((c) => c.type === type && c.boughtTurn < state.turn) &&
    !state.turnFlags.playedDev;

  if (playable('knight')) {
    const robberHex = state.board.robber;
    const blocksMe = LAYOUT.hexVertices[robberHex].some(
      (vid) => state.buildings[vid]?.player === pid,
    );
    const armyRace = p.knightsPlayed >= 2 && state.largestArmy.player !== pid;
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
        type: 'PLAY_DEV_CARD', player: pid, card: 'roadBuilding', params: { edges },
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
          type: 'PLAY_DEV_CARD', player: pid, card: 'yearOfPlenty',
          params: { resources: list },
        });
        if (a) return a;
      }
    }
  }

  if (playable('monopoly')) {
    const totals = RESOURCES.map((r) => [
      r,
      state.players.reduce((s, o) => (o.id === pid ? s : s + o.resources[r]), 0),
    ]);
    const [res, n] = best(totals, ([, cnt]) => cnt);
    if (n >= 5) {
      const a = valid(state, {
        type: 'PLAY_DEV_CARD', player: pid, card: 'monopoly', params: { resource: res },
      });
      if (a) return a;
    }
  }
  return null;
}

// ---- 都市と騎士: 防衛・改良・進歩カード ----

function myCityCount(state, pid) {
  return Object.values(state.buildings).filter(
    (b) => b.player === pid && b.type === 'city',
  ).length;
}

// 蛮族が近いときの防衛行動(活性化 > 建設 > 昇格)
function tryDefense(state, pid) {
  const cities = myCityCount(state, pid);
  if (cities === 0) return null; // 都市がなければ降格リスクなし
  const urgency = state.barbarians.position;
  const myContribution = knightContribution(state, pid);
  const wanted = Math.min(cities + 1, 3); // 貢献目標

  if (urgency >= 3 && myContribution < wanted) {
    // 1. 不活性騎士の活性化
    const inactive = Object.entries(state.knights).find(
      ([, k]) => k.player === pid && !k.active,
    );
    if (inactive) {
      const a = valid(state, { type: 'ACTIVATE_KNIGHT', player: pid, vertexId: inactive[0] });
      if (a) return a;
    }
  }

  // 2. 騎士の建設(都市を持ったら早めに1体は構える)
  const myKnights = Object.values(state.knights).filter((k) => k.player === pid).length;
  if (myKnights < Math.min(cities, 2) && canAfford(state.players[pid], KNIGHT_COSTS.build)) {
    const spots = Object.keys(LAYOUT.vertices).filter(
      (v) => canPlaceKnight(state, pid, v) === null,
    );
    const vid = best(spots, (v) => vertexValue(state, pid, v) * 0.1 + 1);
    const a = vid && valid(state, { type: 'BUILD_KNIGHT', player: pid, vertexId: vid });
    if (a) return a;
  }

  // 3. 昇格(防衛が足りず余裕があるとき)
  if (urgency >= 4 && myContribution < wanted) {
    const promotable = Object.keys(state.knights).find(
      (v) =>
        state.knights[v].player === pid &&
        valid(state, { type: 'PROMOTE_KNIGHT', player: pid, vertexId: v }),
    );
    if (promotable) {
      return { type: 'PROMOTE_KNIGHT', player: pid, vertexId: promotable };
    }
  }
  return null;
}

function tryImprovement(state, pid) {
  const p = state.players[pid];
  const order = [...TRACKS].sort(
    (a, b) => p.commodities[TRACK_COMMODITY[b]] - p.commodities[TRACK_COMMODITY[a]],
  );
  for (const track of order) {
    if (canBuyImprovement(state, pid, track) === null) {
      return { type: 'BUY_IMPROVEMENT', player: pid, track };
    }
  }
  return null;
}

// カード別の評価プラグイン(ai/progress-ai.js)に委譲
function tryPlayProgressCard(state, pid) {
  return pickProgressPlay(state, pid);
}

function tryChaseRobber(state, pid) {
  const robberHex = state.board.robber;
  const blocksMe = LAYOUT.hexVertices[robberHex]?.some(
    (vid) => state.buildings[vid]?.player === pid,
  );
  if (!blocksMe) return null;
  for (const [vid, k] of Object.entries(state.knights)) {
    if (k.player !== pid) continue;
    const a = valid(state, { type: 'CHASE_ROBBER', player: pid, vertexId: vid });
    if (a) return a;
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
    if (aw.type === 'barbarianDefense') return chooseRaze(state, pid);
    if (aw.type === 'tradeOffer') {
      const { give, receive } = aw.context;
      const accept = cpuAcceptsTrade(state, pid, give, receive);
      return (
        valid(state, { type: 'RESPOND_TRADE', player: pid, accept }) ??
        { type: 'RESPOND_TRADE', player: pid, accept: false }
      );
    }
    return null;
  }

  if (state.phase !== 'main' || state.currentPlayer !== pid) return null;
  const p = state.players[pid];
  const cak = state.mode === 'cak';

  if (!state.turnFlags.rolled) {
    if (cak) {
      const alch = pickAlchemist(state, pid);
      if (alch) return alch;
    }
    return tryPlayDevCard(state, pid) ?? { type: 'ROLL_DICE', player: pid };
  }

  // 0. cak: 蛮族への防衛(降格は都市2点の損失なので最優先)
  if (cak) {
    const d = tryDefense(state, pid);
    if (d) return d;
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

  // 3. cak: 都市改良(商品が貯まったら)・進歩カード・盗賊追い払い
  if (cak) {
    const imp = tryImprovement(state, pid);
    if (imp) return imp;
    const pc = tryPlayProgressCard(state, pid);
    if (pc) return pc;
    const chase = tryChaseRobber(state, pid);
    if (chase) return chase;
  }

  // 3'. 基本: 発展カード使用
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

  // 5. 目標に向けた銀行/港交易 → だめなら他のCPUへ1:1交易を提案
  const goal = nextGoal(state, pid);
  const trade = tryTradeTowardGoal(state, pid, goal);
  if (trade) return trade;
  const ptrade = tryTradeWithPlayers(state, pid, goal);
  if (ptrade) return ptrade;

  // 6. cak: 城壁(レンガ余剰時)/ 基本: 発展カード購入
  if (cak) {
    if (p.resources.brick >= 4 && canAfford(p, WALL_COST)) {
      const cityVid = Object.keys(state.buildings).find(
        (v) => valid(state, { type: 'BUILD_WALL', player: pid, vertexId: v }),
      );
      if (cityVid) return { type: 'BUILD_WALL', player: pid, vertexId: cityVid };
    }
  } else if (canAfford(p, COSTS.devCard) && state.bank.devDeck.length > 0) {
    const wantSettlement = goal?.kind === 'settlement' || goal?.kind === 'city';
    if (!wantSettlement || totalResources(p) > 8) {
      const a = valid(state, { type: 'BUY_DEV_CARD', player: pid });
      if (a) return a;
    }
  }

  return { type: 'END_TURN', player: pid };
}
