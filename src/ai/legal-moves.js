// 合法手列挙(設計書 §7.1)
// validate 系の再利用だけで書く。UI のハイライトにも使う。

import { LAYOUT } from '../rules/board.js';
import { canPlaceCity, canPlaceRoad, canPlaceSettlement } from '../rules/build.js';

export function legalSettlementVertices(state, pid, opts = {}) {
  return Object.keys(LAYOUT.vertices).filter(
    (vid) => canPlaceSettlement(state, pid, vid, opts) === null,
  );
}

export function legalRoadEdges(state, pid, opts = {}) {
  return Object.keys(LAYOUT.edges).filter(
    (eid) => canPlaceRoad(state, pid, eid, opts) === null,
  );
}

export function legalCityVertices(state, pid) {
  return Object.keys(state.buildings).filter(
    (vid) => canPlaceCity(state, pid, vid) === null,
  );
}

export function legalRobberHexes(state) {
  return LAYOUT.hexIds.filter((hid) => hid !== state.board.robber);
}

// 初期配置で選んだ開拓地に接続できる空き辺
export function legalSetupEdges(state, vertexId) {
  return LAYOUT.vertexEdges[vertexId].filter((eid) => !state.roads[eid]);
}
