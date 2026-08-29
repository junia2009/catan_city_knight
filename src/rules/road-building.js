// 街道建設(基本の発展カード / 都市と騎士の進歩カード)
//
// 公式では「道を2本、無料で建設する」。1本で切り上げる選択肢はないので、
// 2本置けるならその場で2本置く。置ける場所やコマが足りないときだけ本数が減る。
// 航海者たちでは「道または船を2つ」なので、辺ごとにどちらを置くかを持つ。
//
// 発展カードと進歩カードで中身は同じなので、判定も適用もここに1本化する。

import { boardEdgeIds } from './board.js';
import { canPlaceRoad } from './build.js';
import { canPlaceShip, isRoadEdge } from './sea.js';
import { updateLongestRoad } from './victory.js';
import { addLog } from '../state.js';

export const ROAD_BUILDING_PIECES = 2;

// 辺に置く駒の種類。明示があればそれ、なければ陸に面していれば道・そうでなければ船。
export function pieceForEdge(state, edgeId, piece = null) {
  if (piece === 'road' || piece === 'ship') return piece;
  return state.mode === 'sea' && !isRoadEdge(state.board, edgeId) ? 'ship' : 'road';
}

// params.edges と params.pieces を [{ edgeId, piece }] に正規化する
export function roadBuildingPlacements(state, params) {
  const edges = params?.edges ?? [];
  const pieces = params?.pieces ?? [];
  return edges.map((edgeId, i) => ({
    edgeId,
    piece: pieceForEdge(state, edgeId, pieces[i] ?? null),
  }));
}

function extrasOf(placed) {
  const extraRoads = {};
  const extraShips = {};
  for (const p of placed) {
    if (p.piece === 'ship') extraShips[p.edgeId] = true;
    else extraRoads[p.edgeId] = true;
  }
  return { extraRoads, extraShips };
}

// すでに placed を置いた前提で、次に置ける候補 [{ edgeId, piece }]
export function roadBuildingSpots(state, pid, placed = []) {
  const opts = extrasOf(placed);
  const out = [];
  for (const eid of boardEdgeIds(state.board)) {
    if (canPlaceRoad(state, pid, eid, opts) === null) out.push({ edgeId: eid, piece: 'road' });
    if (state.mode === 'sea' && canPlaceShip(state, pid, eid, opts) === null) {
      out.push({ edgeId: eid, piece: 'ship' });
    }
  }
  return out;
}

// 実際に置かなければならない数(公式は2。盤とコマの都合で置けない分だけ減る)。
// 1本目の選び方で2本目が消えることはあり得るので、
// 「2本置ける置き方が1つでもあるか」で見る。
export function roadBuildingCount(state, pid) {
  const first = roadBuildingSpots(state, pid);
  if (first.length === 0) return 0;
  for (const spot of first) {
    if (roadBuildingSpots(state, pid, [spot]).length > 0) return ROAD_BUILDING_PIECES;
  }
  return 1;
}

// カードのパラメータ検証。エラー文字列 or null。
export function validateRoadBuilding(state, pid, params) {
  const placed = roadBuildingPlacements(state, params);
  const need = roadBuildingCount(state, pid);
  if (need === 0) return '道も船も置ける場所がありません';
  if (placed.length !== need) {
    return need === ROAD_BUILDING_PIECES
      ? `${shipsAllowed(state) ? '道か船を' : '道を'}2本とも選んでください`
      : `${shipsAllowed(state) ? '道か船を' : '道を'}1本選んでください(2本目を置ける場所がありません)`;
  }
  const done = [];
  for (const p of placed) {
    const opts = extrasOf(done);
    const err = p.piece === 'ship'
      ? (state.mode === 'sea' ? canPlaceShip(state, pid, p.edgeId, opts) : '航海者たちのルールではありません')
      : canPlaceRoad(state, pid, p.edgeId, opts);
    if (err) return err;
    done.push(p);
  }
  return null;
}

function shipsAllowed(state) {
  return state.mode === 'sea';
}

// 適用。検証済みのパラメータを前提にする。
export function applyRoadBuilding(state, pid, params) {
  const placed = roadBuildingPlacements(state, params);
  let roads = 0;
  let ships = 0;
  for (const p of placed) {
    if (p.piece === 'ship') {
      state.ships[p.edgeId] = { player: pid, builtTurn: state.turn };
      ships++;
    } else {
      state.roads[p.edgeId] = { player: pid };
      roads++;
    }
  }
  updateLongestRoad(state);
  const what = [roads ? `道を${roads}本` : '', ships ? `船を${ships}隻` : '']
    .filter(Boolean)
    .join('と');
  addLog(state, `🛤️ ${state.players[pid].name}が${what}無料建設`);
}
