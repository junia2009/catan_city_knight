// CPU 思考ルーチン(設計書 §7)
// chooseAction(state, pid) は「次の1手」を返す。コントローラが繰り返し呼ぶ。
// awaiting への応答は即時に決定できる。返す前に必ず validate を通す。

import { validateAction } from '../actions.js';
import { LAYOUT, boardVertexIds } from '../rules/board.js';
import {
  COSTS, WALL_COST, canAfford, countPieces, PIECE_LIMITS, totalResources, totalCards,
} from '../rules/build.js';
import { stealableTargets } from '../rules/robber.js';
import { fishCount, hasOldShoe, shoeTargets } from '../rules/fish.js';
import {
  SHIP_COST, SHIP_LIMIT, islandAtVertex, isSeaHex, movableShips, pirateTargets,
} from '../rules/sea.js';
import { tradeRate } from '../rules/trade.js';
import { computePoints } from '../rules/victory.js';
import { RESOURCES } from '../state.js';
import { KNIGHT_COSTS, canPlaceKnight } from '../rules/cak/knights.js';
import { TOWER_COST } from '../rules/dragon.js';
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
  legalSetupVertices,
  legalShipEdges,
} from './legal-moves.js';
import { missingFor, pipsOfVertex, robberHexValue, vertexValue } from './evaluator.js';

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
  const vids = legalSetupVertices(state, pid);
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
  // 航海者たち: 海のヘックスを選ぶと海賊が動く。船を持つ相手から奪えるなら価値がある。
  const valueOf = (h) => {
    if (state.mode === 'sea' && isSeaHex(state.board, h)) {
      const targets = pirateTargets(state, h, pid).filter((t) => totalCards(state.players[t]) > 0);
      if (targets.length === 0) return -1;
      return 2 + Math.max(...targets.map((t) => totalCards(state.players[t]))) * 0.3;
    }
    return robberHexValue(state, pid, h);
  };
  const hid = best(hexes, valueOf);
  const sea = state.mode === 'sea' && isSeaHex(state.board, hid);
  const targets = sea
    ? pirateTargets(state, hid, pid).filter((t) => totalCards(state.players[t]) > 0)
    : stealableTargets(state, hid, pid);
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
  // 航海者たち: 新しい島へ渡る船は開拓地+2点につながるので、道より優先する。
  // ただし行き先(まだ入植していない島)がある間だけ。
  if (state.mode === 'sea' && hasIslandTarget(state, pid)) {
    return { kind: 'ship', cost: SHIP_COST };
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

// ---- 航海者たち ----

// まだ自分が入植していない島の頂点から幅優先で距離を測る。
// 「あと何本で島に届くか」が分かるので、船を伸ばす向きを決められる。
function distanceToNewIslands(state, pid) {
  const board = state.board;
  const mine = new Set(state.players[pid].islands ?? []);
  const dist = {};
  const queue = [];
  for (const vid of boardVertexIds(board)) {
    const island = islandAtVertex(board, vid);
    if (island == null || island === 0 || mine.has(island)) continue;
    if (state.buildings[vid]) continue;
    dist[vid] = 0;
    queue.push(vid);
  }
  for (let i = 0; i < queue.length; i++) {
    const v = queue[i];
    for (const eid of LAYOUT.vertexEdges[v]) {
      const e = LAYOUT.edges[eid];
      if (!e.hexes.some((h) => board.hexes[h])) continue;
      const other = e.v[0] === v ? e.v[1] : e.v[0];
      if (dist[other] != null) continue;
      dist[other] = dist[v] + 1;
      queue.push(other);
    }
  }
  return dist;
}

// まだ入植していない島に、空いている頂点が残っているか
function hasIslandTarget(state, pid) {
  const mine = new Set(state.players[pid].islands ?? []);
  return boardVertexIds(state.board).some((vid) => {
    const island = islandAtVertex(state.board, vid);
    return island != null && island !== 0 && !mine.has(island) && !state.buildings[vid];
  });
}

// 島へ近づく船を1隻建てる。行き先がなければ null。
function tryBuildShip(state, pid) {
  if (state.mode !== 'sea') return null;
  const p = state.players[pid];
  if (!canAfford(p, SHIP_COST)) return null;
  const dist = distanceToNewIslands(state, pid);
  const edges = legalShipEdges(state, pid);
  if (edges.length === 0) return null;

  // その辺を引いたとき、両端のうち島に近いほうの距離。小さいほど良い。
  const reach = (eid) => {
    const [a, b] = LAYOUT.edges[eid].v;
    const da = dist[a] ?? 99;
    const db = dist[b] ?? 99;
    return Math.min(da, db);
  };
  const eid = best(edges, (e) => -reach(e));
  if (!eid || reach(eid) >= 99) return null;
  return valid(state, { type: 'BUILD_SHIP', player: pid, edgeId: eid });
}

// ---- 漁師たち: 魚トークン ----

// 盗賊が自分の産地に居座っているか
function robberHurtsMe(state, pid) {
  const hex = state.board.robber;
  if (hex == null || hex === state.board.lake) return false;
  return (LAYOUT.hexVertices[hex] ?? []).some((v) => state.buildings[v]?.player === pid);
}

// 魚の使い道を決める。お釣りが出ないので、払える中でいちばん高い使い道から試す。
function trySpendFish(state, pid, goal) {
  if (state.mode !== 'fish') return null;
  const p = state.players[pid];
  const n = fishCount(p);
  if (n < 2) return null;

  // 2匹: 盗賊が自分の産地にいるなら真っ先に追い払う(ロール前にも使える)
  if (robberHurtsMe(state, pid)) {
    const a = valid(state, { type: 'SPEND_FISH', player: pid, use: 'robber' });
    if (a) return a;
  }
  if (!state.turnFlags.rolled) return null;

  // 7匹: 発展カード
  if (n >= 7) {
    const a = valid(state, { type: 'SPEND_FISH', player: pid, use: 'dev' });
    if (a) return a;
  }
  // 5匹: 道を1本無料で
  if (n >= 5) {
    const eid = best(legalRoadEdges(state, pid), (e) => roadEdgeValue(state, pid, e));
    if (eid && roadEdgeValue(state, pid, eid) > 1) {
      const a = valid(state, {
        type: 'SPEND_FISH', player: pid, use: 'road', params: { edgeId: eid },
      });
      if (a) return a;
    }
  }
  // 4匹: 目標に足りない資源を1枚
  if (n >= 4 && goal) {
    const r = Object.keys(missingFor(p, goal.cost)).find((x) => state.bank.resources[x] > 0);
    if (r) {
      const a = valid(state, {
        type: 'SPEND_FISH', player: pid, use: 'resource', params: { resource: r },
      });
      if (a) return a;
    }
  }
  // 3匹: 手札の厚い相手から1枚(薄い相手に使うと割に合わない)
  if (n >= 3) {
    const rich = state.players.filter((o) => o.id !== pid && totalCards(o) >= 3).map((o) => o.id);
    const target = best(rich, (id) => computePoints(state, id) + totalCards(state.players[id]) / 20);
    if (target != null) {
      const a = valid(state, {
        type: 'SPEND_FISH', player: pid, use: 'steal', params: { target },
      });
      if (a) return a;
    }
  }
  return null;
}

// 古い靴は持っているだけ損なので、渡せる相手(自分と同点以上)がいれば渡す。
function tryPassShoe(state, pid) {
  if (state.mode !== 'fish' || !hasOldShoe(state.players[pid])) return null;
  const targets = shoeTargets(state, pid, (id) => computePoints(state, id));
  const target = best(targets, (id) => computePoints(state, id));
  if (target == null) return null;
  return valid(state, { type: 'PASS_SHOE', player: pid, target });
}

// CPU が全員に 1:1 交易を持ちかける(不足資源 ⇄ 余剰資源)。
// 誰が持っているかは見ずに提案し、応じた人の中から後で選ぶ。
// 人間から見て提案が連打にならないよう、CPU は1手番に1回だけ持ちかける。
function tryTradeWithPlayers(state, pid, goal) {
  if (!goal) return null;
  const p = state.players[pid];
  if ((state.turnFlags.offers ?? 0) > 0) return null; // この手番はもう提案した
  if ((p.offerCooldown ?? 0) > state.turn) return null; // 直前の提案が全員に断られた
  const missing = missingFor(p, goal.cost);
  const missingRes = Object.keys(missing);
  if (!missingRes.length) return null;

  const surpluses = RESOURCES.filter(
    (r) => p.resources[r] - (goal.cost[r] ?? 0) >= 2 && !missing[r],
  );
  // 誰が何を持っているかは見ない(人間の手札を覗かないため)。
  // 空振りは1手番1回の制限とクールダウンで抑える。
  for (const want of missingRes) {
    for (const give of surpluses) {
      const action = {
        type: 'OFFER_TRADE', player: pid,
        give: { [give]: 1 }, receive: { [want]: 1 },
      };
      if (valid(state, action)) return action;
    }
  }
  return null;
}

// 複数が応じたときに、CPU がどの相手と成立させるか。
// 内容は全員同じなので、盤面で最も遅れている(勝利点が低い)相手を選び、
// 同点なら手札の少ない相手 → 席順で決定的に決める。
function pickTradePartner(state, pid, accepted) {
  return [...accepted].sort((a, b) => {
    const pa = computePoints(state, a, { includeHidden: true });
    const pb = computePoints(state, b, { includeHidden: true });
    if (pa !== pb) return pa - pb;
    const ca = totalCards(state.players[a]);
    const cb = totalCards(state.players[b]);
    if (ca !== cb) return ca - cb;
    return a - b;
  })[0];
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
    const spots = boardVertexIds(state.board).filter(
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
    if (aw.type === 'goldChoice') {
      // 目標に足りない資源を優先、なければ在庫のあるものを
      const goal = nextGoal(state, pid);
      const missing = goal ? Object.keys(missingFor(state.players[pid], goal.cost)) : [];
      const pick = [...missing, ...RESOURCES].find((r) => state.bank.resources[r] > 0);
      return { type: 'PICK_GOLD', player: pid, resource: pick };
    }
    if (aw.type === 'aqueduct') {
      // 目標に足りない資源を優先、なければ在庫のあるものを選ぶ
      const goal = nextGoal(state, pid);
      const missing = goal ? Object.keys(missingFor(state.players[pid], goal.cost)) : [];
      const pick = [...missing, ...RESOURCES].find(
        (r) => state.bank.resources[r] > 0,
      );
      return { type: 'PICK_AQUEDUCT', player: pid, resource: pick };
    }
    if (aw.type === 'tradeOffer') {
      const { give, receive } = aw.context;
      const accept = cpuAcceptsTrade(state, pid, give, receive);
      return (
        valid(state, { type: 'RESPOND_TRADE', player: pid, accept }) ??
        { type: 'RESPOND_TRADE', player: pid, accept: false }
      );
    }
    if (aw.type === 'tradeChoose') {
      const partner = pickTradePartner(state, pid, aw.context.accepted);
      return (
        valid(state, { type: 'CHOOSE_TRADE', player: pid, partner }) ??
        { type: 'CHOOSE_TRADE', player: pid, partner: null }
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
    // 漁師たち: 盗賊が自分の産地にいるならロール前に魚でどかす
    const fish = trySpendFish(state, pid, null);
    if (fish) return fish;
    return tryPlayDevCard(state, pid) ?? { type: 'ROLL_DICE', player: pid };
  }

  // 0'. 漁師たち: 古い靴は渡せるうちに渡す(勝利条件が1点重いままだと詰む)
  const shoe = tryPassShoe(state, pid);
  if (shoe) return shoe;

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

  // 3''. 航海者たち: 島へ向かって船を伸ばす(新しい島は開拓地+2点)
  const ship = tryBuildShip(state, pid);
  if (ship) return ship;

  // 3''. ドラゴンの島: 産出の高い自分の建物に見張り塔(撃退で財宝+1点)
  if (state.mode === 'dragon' && canAfford(p, TOWER_COST)) {
    const vids = Object.keys(state.buildings).filter(
      (v) => validateAction(state, { type: 'BUILD_TOWER', player: pid, vertexId: v }) === null,
    );
    const vid = best(vids, (v) => pipsOfVertex(state, v));
    if (vid && pipsOfVertex(state, vid) >= 7) {
      return { type: 'BUILD_TOWER', player: pid, vertexId: vid };
    }
  }

  // 3'''. 漁師たち: 魚トークンを使う
  const fish = trySpendFish(state, pid, nextGoal(state, pid));
  if (fish) return fish;

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
