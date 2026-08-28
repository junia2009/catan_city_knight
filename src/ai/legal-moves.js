// 合法手列挙(設計書 §7.1)
// validate 系の再利用だけで書く。UI のハイライトにも使う。

import { LAYOUT, boardVertexIds, boardEdgeIds } from '../rules/board.js';
import { canPlaceCity, canPlaceRoad, canPlaceSettlement } from '../rules/build.js';
import {
  canPlaceShip, isRoadEdge, isSeaHex, isShipEdge, islandAtVertex,
} from '../rules/sea.js';

export function legalSettlementVertices(state, pid, opts = {}) {
  return boardVertexIds(state.board).filter(
    (vid) => canPlaceSettlement(state, pid, vid, opts) === null,
  );
}

export function legalRoadEdges(state, pid, opts = {}) {
  return boardEdgeIds(state.board).filter(
    (eid) => canPlaceRoad(state, pid, eid, opts) === null,
  );
}

// 初期配置で置ける頂点。航海者たちでは本島(島番号0)だけ。
export function legalSetupVertices(state, pid) {
  const vids = legalSettlementVertices(state, pid, { needRoad: false });
  if (state.mode !== 'sea') return vids;
  return vids.filter((vid) => islandAtVertex(state.board, vid) === 0);
}

export function legalCityVertices(state, pid) {
  return Object.keys(state.buildings).filter(
    (vid) => canPlaceCity(state, pid, vid) === null,
  );
}

// 盗賊を置ける陸ヘックス。航海者たちでは海賊(海のヘックス)も選択肢になる。
export function legalRobberHexes(state) {
  if (state.mode !== 'sea') {
    return state.board.hexIds.filter((hid) => hid !== state.board.robber);
  }
  return state.board.hexIds.filter((hid) =>
    (isSeaHex(state.board, hid) ? hid !== state.board.pirate : hid !== state.board.robber));
}

export function legalShipEdges(state, pid, opts = {}) {
  if (state.mode !== 'sea') return [];
  return boardEdgeIds(state.board).filter((eid) => canPlaceShip(state, pid, eid, opts) === null);
}

// 初期配置で選んだ開拓地に接続できる空き辺。
// LAYOUT は最大半径まであるので、盤に載っている辺だけに絞る必要がある。
// piece: 'road' なら陸に面した辺、'ship' なら海に面した辺(航海者たちのみ)。
export function legalSetupEdges(state, vertexId, piece = 'road') {
  if (piece === 'ship' && state.mode !== 'sea') return [];
  return LAYOUT.vertexEdges[vertexId].filter((eid) => {
    if (state.roads[eid] || state.ships?.[eid]) return false;
    return piece === 'ship' ? isShipEdge(state.board, eid) : isRoadEdge(state.board, eid);
  });
}
