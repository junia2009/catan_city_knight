// 進歩カード(設計書 §9.5)— Phase 3: 公式構成の全54枚(3系統×18枚)
// カード効果はプラグイン実装: { deck, count, name, icon, desc, needsParams,
//   preRoll?, vp?, validate(state,pid,params), play(state,pid,params) }
// CPU の使用判断は ai/progress-ai.js 側のプラグインが担当する。

import { LAYOUT, TERRAIN_RESOURCE } from '../board.js';
import { rngInt } from '../../rng.js';
import { RESOURCES, RES_JP, addLog } from '../../state.js';
import { grantResource, totalCards, canBuildWall, canPlaceRoad } from '../build.js';
import { updateLongestRoad, computePoints } from '../victory.js';
import { countKnights, canPromoteKnight, displaceKnight, KNIGHT_LIMIT_PER_LEVEL } from './knights.js';
import { TRACKS, MAX_IMPROVEMENT } from './improvements.js';

export const COMMODITIES = ['cloth', 'coin', 'paper'];
export const COM_JP = { cloth: '布', coin: 'コイン', paper: '紙' };

export function grantCommodity(state, pid, com, n = 1) {
  const give = Math.min(n, state.bank.commodities[com]);
  state.bank.commodities[com] -= give;
  state.players[pid].commodities[com] += give;
  return give;
}

function cardKeyCount(player, key) {
  return RESOURCES.includes(key) ? player.resources[key] : player.commodities[key];
}

// from の手札からランダムに n 枚を to に移す(資源+商品)。移った内訳を返す。
function stealRandomCards(state, fromPid, toPid, n) {
  const from = state.players[fromPid];
  const to = state.players[toPid];
  const taken = [];
  for (let i = 0; i < n; i++) {
    const pool = [];
    for (const r of RESOURCES) for (let k = 0; k < from.resources[r]; k++) pool.push(['r', r]);
    for (const c of COMMODITIES) for (let k = 0; k < from.commodities[c]; k++) pool.push(['c', c]);
    if (!pool.length) break;
    let idx;
    [state.rng, idx] = rngInt(state.rng, pool.length);
    const [kind, key] = pool[idx];
    if (kind === 'r') { from.resources[key]--; to.resources[key]++; }
    else { from.commodities[key]--; to.commodities[key]++; }
    taken.push(key);
  }
  return taken;
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

// 「開いた道」= 少なくとも一端が持ち主の道・建物に繋がっていない道
function isOpenRoad(state, eid) {
  const road = state.roads[eid];
  if (!road) return false;
  const owner = road.player;
  return LAYOUT.edges[eid].v.some((vid) => {
    if (state.buildings[vid]?.player === owner) return false;
    if (state.knights[vid]?.player === owner) return false;
    return !LAYOUT.vertexEdges[vid].some(
      (e) => e !== eid && state.roads[e]?.player === owner,
    );
  });
}

// 自分より勝利点が高い(または以上の)プレイヤー一覧
function playersAbove(state, pid, { orEqual = false } = {}) {
  const mine = computePoints(state, pid);
  return state.players.filter((o) => {
    if (o.id === pid) return false;
    const pts = computePoints(state, o.id);
    return orEqual ? pts >= mine : pts > mine;
  });
}

export const PROGRESS_CARDS = {
  // ================= 交易(黄)18枚 =================

  merchant: {
    deck: 'trade', count: 6,
    name: '商人', icon: '🧑‍💼',
    desc: '自分の建物に隣接するヘックスに商人を配置。その資源を2:1で交易でき、保持中は+1点',
    needsParams: 'hex',
    validate(state, pid, params) {
      const hex = state.board.hexes[params?.hexId];
      if (!hex) return '不正なヘックスです';
      if (!TERRAIN_RESOURCE[hex.terrain]) return '資源の出るヘックスを選んでください';
      const mine = LAYOUT.hexVertices[params.hexId].some(
        (vid) => state.buildings[vid]?.player === pid,
      );
      if (!mine) return '自分の建物が隣接するヘックスを選んでください';
      return null;
    },
    play(state, pid, params) {
      state.merchant = { hexId: params.hexId, player: pid };
      const res = TERRAIN_RESOURCE[state.board.hexes[params.hexId].terrain];
      addLog(state, `🧑‍💼 ${state.players[pid].name}が商人を配置(${RES_JP[res]}2:1+1点)`);
    },
  },

  merchantFleet: {
    deck: 'trade', count: 2,
    name: '商船隊', icon: '⛴️',
    desc: 'このターンの間、選んだ資源/商品を2:1で銀行と交易できる',
    needsParams: 'cardKey',
    validate(state, pid, params) {
      const k = params?.key;
      if (!RESOURCES.includes(k) && !COMMODITIES.includes(k)) return '資源か商品を選んでください';
      return null;
    },
    play(state, pid, params) {
      state.turnFlags.fleet = params.key;
      const jp = RES_JP[params.key] ?? COM_JP[params.key];
      addLog(state, `⛴️ ${state.players[pid].name}はこのターン${jp}を2:1で交易可能`);
    },
  },

  resourceMonopoly: {
    deck: 'trade', count: 4,
    name: '資源独占', icon: '🎩',
    desc: '資源を1種指定し、各プレイヤーから最大2枚ずつもらう',
    needsParams: 'resource',
    validate(state, pid, params) {
      if (!RESOURCES.includes(params?.resource)) return '資源を選んでください';
      return null;
    },
    play(state, pid, params) {
      const r = params.resource;
      let taken = 0;
      for (const o of state.players) {
        if (o.id === pid) continue;
        const n = Math.min(2, o.resources[r]);
        o.resources[r] -= n;
        state.players[pid].resources[r] += n;
        taken += n;
      }
      addLog(state, `🎩 ${state.players[pid].name}が${RES_JP[r]}を${taken}枚徴収`);
    },
  },

  tradeMonopoly: {
    deck: 'trade', count: 2,
    name: '交易独占', icon: '💰',
    desc: '商品を1種指定し、各プレイヤーから1枚ずつもらう',
    needsParams: 'commodity',
    validate(state, pid, params) {
      if (!COMMODITIES.includes(params?.commodity)) return '商品を選んでください';
      return null;
    },
    play(state, pid, params) {
      const c = params.commodity;
      let taken = 0;
      for (const o of state.players) {
        if (o.id === pid) continue;
        const n = Math.min(1, o.commodities[c]);
        o.commodities[c] -= n;
        state.players[pid].commodities[c] += n;
        taken += n;
      }
      addLog(state, `💰 ${state.players[pid].name}が${COM_JP[c]}を${taken}枚徴収`);
    },
  },

  masterMerchant: {
    deck: 'trade', count: 2,
    name: '豪商', icon: '👑',
    desc: '自分より勝利点が高い相手から2枚奪う',
    needsParams: 'player',
    validate(state, pid, params) {
      const t = state.players[params?.target];
      if (!t || t.id === pid) return '相手を選んでください';
      if (computePoints(state, t.id) <= computePoints(state, pid)) {
        return '自分より勝利点が高い相手のみ選べます';
      }
      if (totalCards(t) === 0) return '相手に手札がありません';
      return null;
    },
    play(state, pid, params) {
      const got = stealRandomCards(state, params.target, pid, 2);
      addLog(
        state,
        `👑 ${state.players[pid].name}が${state.players[params.target].name}から${got.length}枚奪いました`,
      );
    },
  },

  commercialHarbor: {
    deck: 'trade', count: 2,
    name: '商業港', icon: '⚓',
    desc: '商品を持つ各プレイヤーと「自分の資源1枚 ⇄ 相手の商品1枚」を強制交換',
    needsParams: 'resource',
    validate(state, pid, params) {
      const r = params?.resource;
      if (!RESOURCES.includes(r)) return '渡す資源を選んでください';
      if (state.players[pid].resources[r] < 1) return 'その資源を持っていません';
      if (!state.players.some((o) => o.id !== pid && COMMODITIES.some((c) => o.commodities[c] > 0))) {
        return '商品を持つ相手がいません';
      }
      return null;
    },
    play(state, pid, params) {
      const p = state.players[pid];
      const r = params.resource;
      let swaps = 0;
      for (const o of state.players) {
        if (o.id === pid || p.resources[r] < 1) continue;
        const pool = [];
        for (const c of COMMODITIES) for (let k = 0; k < o.commodities[c]; k++) pool.push(c);
        if (!pool.length) continue;
        let idx;
        [state.rng, idx] = rngInt(state.rng, pool.length);
        const c = pool[idx];
        o.commodities[c]--; p.commodities[c]++;
        p.resources[r]--; o.resources[r]++;
        swaps++;
      }
      addLog(state, `⚓ ${state.players[pid].name}が商業港で${swaps}人と交換(${RES_JP[r]}⇄商品)`);
    },
  },

  // ================= 政治(青)18枚 =================

  bishop: {
    deck: 'politics', count: 2,
    name: '司教', icon: '⛪',
    desc: '盗賊を移動し、隣接する全プレイヤーから1枚ずつ奪う',
    needsParams: 'hex',
    validate(state, pid, params) {
      if (!state.board.hexes[params?.hexId]) return '不正なヘックスです';
      if (state.board.robber === params.hexId) return '盗賊は別のヘックスへ';
      return null;
    },
    play(state, pid, params) {
      state.board.robber = params.hexId;
      const victims = new Set();
      for (const vid of LAYOUT.hexVertices[params.hexId]) {
        const b = state.buildings[vid];
        if (b && b.player !== pid) victims.add(b.player);
      }
      for (const v of victims) {
        const got = stealRandomCards(state, v, pid, 1);
        if (got.length) {
          addLog(state, `⛪ ${state.players[pid].name}が${state.players[v].name}から1枚奪いました`);
        }
      }
    },
  },

  constitution: {
    deck: 'politics', count: 1,
    name: '憲法', icon: '📜', vp: true,
    desc: '勝利点+1(公開即得点)',
    needsParams: null,
    validate: () => '公開済みです',
    play() {},
  },

  deserter: {
    deck: 'politics', count: 2,
    name: '脱走兵', icon: '🏳️',
    desc: '相手の騎士1体を除去し、同レベルの騎士を自分の道網に無料配置',
    needsParams: 'player',
    validate(state, pid, params) {
      const t = state.players[params?.target];
      if (!t || t.id === pid) return '相手を選んでください';
      if (!Object.values(state.knights).some((k) => k.player === t.id)) {
        return '相手に騎士がいません';
      }
      return null;
    },
    play(state, pid, params) {
      // 相手は自分の最弱騎士を差し出す(不活性・低レベル優先)
      const entries = Object.entries(state.knights).filter(([, k]) => k.player === params.target);
      entries.sort(([, a], [, b]) => (a.level - b.level) || (a.active - b.active));
      const [vid, k] = entries[0];
      delete state.knights[vid];
      addLog(state, `🏳️ ${state.players[params.target].name}の騎士(Lv${k.level})が脱走!`);

      // コマ在庫の許すレベルで、自分の道網の空き頂点に配置
      let level = k.level;
      while (level >= 1 && countKnights(state, pid, level) >= KNIGHT_LIMIT_PER_LEVEL) level--;
      if (level < 1) return;
      const spot = Object.keys(LAYOUT.vertices).find(
        (v) =>
          !state.buildings[v] && !state.knights[v] &&
          LAYOUT.vertexEdges[v].some((e) => state.roads[e]?.player === pid),
      );
      if (!spot) return;
      state.knights[spot] = { player: pid, level, active: false, activatedTurn: -1 };
      addLog(state, `${state.players[pid].name}が騎士(Lv${level})を無料配置`);
    },
  },

  diplomat: {
    deck: 'politics', count: 2,
    name: '外交官', icon: '🎖️',
    desc: '両端が繋がっていない「開いた道」を1本取り除く',
    needsParams: 'edge',
    validate(state, pid, params) {
      if (!state.roads[params?.edgeId]) return '道を選んでください';
      if (!isOpenRoad(state, params.edgeId)) return '開いた道(端が繋がっていない道)のみ対象です';
      return null;
    },
    play(state, pid, params) {
      const owner = state.roads[params.edgeId].player;
      delete state.roads[params.edgeId];
      updateLongestRoad(state);
      addLog(state, `🎖️ ${state.players[pid].name}が${state.players[owner].name}の道を撤去`);
    },
  },

  intrigue: {
    deck: 'politics', count: 2,
    name: '陰謀', icon: '🗡️',
    desc: '自分の道に隣接する相手の騎士を追い出す',
    needsParams: 'vertex',
    validate(state, pid, params) {
      const k = state.knights[params?.vertexId];
      if (!k || k.player === pid) return '相手の騎士を選んでください';
      const touching = LAYOUT.vertexEdges[params.vertexId].some(
        (e) => state.roads[e]?.player === pid,
      );
      if (!touching) return '自分の道に隣接する騎士のみ対象です';
      return null;
    },
    play(state, pid, params) {
      addLog(state, `🗡️ ${state.players[pid].name}の陰謀!`);
      displaceKnight(state, params.vertexId);
    },
  },

  saboteur: {
    deck: 'politics', count: 2,
    name: '破壊工作員', icon: '🧨',
    desc: '自分と同点以上の各プレイヤーは手札の半分を捨てる',
    needsParams: null,
    validate(state, pid) {
      const targets = playersAbove(state, pid, { orEqual: true })
        .filter((o) => totalCards(o) >= 2);
      if (!targets.length) return '対象となる相手がいません';
      return null;
    },
    play(state, pid) {
      const required = {};
      for (const o of playersAbove(state, pid, { orEqual: true })) {
        const n = totalCards(o);
        if (n >= 2) required[o.id] = Math.floor(n / 2);
      }
      state.awaiting = {
        type: 'discard',
        players: Object.keys(required).map(Number),
        context: { required, cause: 'saboteur' },
      };
      addLog(state, `🧨 ${state.players[pid].name}の破壊工作! 対象は手札の半分を捨てる`);
    },
  },

  spy: {
    deck: 'politics', count: 3,
    name: 'スパイ', icon: '🕵️',
    desc: '相手の進歩カードを1枚奪う',
    needsParams: 'player',
    validate(state, pid, params) {
      const t = state.players[params?.target];
      if (!t || t.id === pid) return '相手を選んでください';
      if (t.progressCards.length === 0) return '相手は進歩カードを持っていません';
      return null;
    },
    play(state, pid, params) {
      const t = state.players[params.target];
      let idx;
      [state.rng, idx] = rngInt(state.rng, t.progressCards.length);
      const card = t.progressCards.splice(idx, 1)[0];
      state.players[pid].progressCards.push({ ...card, boughtTurn: state.turn });
      addLog(
        state,
        `🕵️ ${state.players[pid].name}が${t.name}から進歩カード「${PROGRESS_CARDS[card.id].name}」を奪取!`,
      );
    },
  },

  warlord: {
    deck: 'politics', count: 2,
    name: '将軍', icon: '🎖',
    desc: '自分の騎士全員を無料で活性化する',
    needsParams: null,
    validate(state, pid) {
      const any = Object.values(state.knights).some((k) => k.player === pid && !k.active);
      if (!any) return '不活性の騎士がいません';
      return null;
    },
    play(state, pid) {
      let n = 0;
      for (const k of Object.values(state.knights)) {
        if (k.player === pid && !k.active) {
          k.active = true;
          k.activatedTurn = state.turn;
          n++;
        }
      }
      addLog(state, `🎖 ${state.players[pid].name}が騎士${n}体を無料で活性化!`);
    },
  },

  wedding: {
    deck: 'politics', count: 2,
    name: '王家の婚礼', icon: '💒',
    desc: '自分より勝利点が高い各プレイヤーから2枚ずつもらう(相手が選ぶ)',
    needsParams: null,
    validate(state, pid) {
      const targets = playersAbove(state, pid).filter((o) => totalCards(o) > 0);
      if (!targets.length) return '対象となる相手がいません';
      return null;
    },
    play(state, pid) {
      const p = state.players[pid];
      for (const o of playersAbove(state, pid)) {
        // 相手は最も余っている札から渡す(商品より資源を優先して手放す)
        let given = 0;
        while (given < 2) {
          let bestKey = null;
          let bestN = 0;
          for (const r of RESOURCES) {
            if (o.resources[r] > bestN) { bestN = o.resources[r]; bestKey = r; }
          }
          if (!bestKey) {
            for (const c of COMMODITIES) {
              if (o.commodities[c] > bestN) { bestN = o.commodities[c]; bestKey = c; }
            }
          }
          if (!bestKey) break;
          if (RESOURCES.includes(bestKey)) { o.resources[bestKey]--; p.resources[bestKey]++; }
          else { o.commodities[bestKey]--; p.commodities[bestKey]++; }
          given++;
        }
        if (given) addLog(state, `💒 ${o.name}が${p.name}に${given}枚贈りました`);
      }
    },
  },

  // ================= 科学(緑)18枚 =================

  alchemist: {
    deck: 'science', count: 2,
    name: '錬金術師', icon: '⚗️',
    desc: 'ロール前に使用。赤・黄ダイスの出目を自分で決める(イベントダイスは振る)',
    needsParams: 'dice',
    preRoll: true,
    validate(state, pid, params) {
      const ok = (n) => Number.isInteger(n) && n >= 1 && n <= 6;
      if (!ok(params?.red) || !ok(params?.yellow)) return '出目を2つ選んでください';
      return null;
    },
    play(state, pid, params) {
      state.turnFlags.alchemist = [params.red, params.yellow];
      addLog(state, `⚗️ ${state.players[pid].name}が錬金術で出目を操作(${params.red}+${params.yellow})`);
    },
  },

  crane: {
    deck: 'science', count: 2,
    name: 'クレーン', icon: '🏗️',
    desc: 'このターンの都市改良が商品1枚安くなる',
    needsParams: null,
    validate(state, pid) {
      const p = state.players[pid];
      if (!TRACKS.some((t) => p.improvements[t] < MAX_IMPROVEMENT)) return '改良できる系統がありません';
      return null;
    },
    play(state, pid) {
      state.turnFlags.crane = true;
      addLog(state, `🏗️ ${state.players[pid].name}は次の都市改良が商品1枚引き`);
    },
  },

  engineer: {
    deck: 'science', count: 1,
    name: '技師', icon: '👷',
    desc: '城壁1枚を無料で建設する',
    needsParams: 'vertex',
    validate(state, pid, params) {
      return canBuildWall(state, pid, params?.vertexId);
    },
    play(state, pid, params) {
      state.walls[params.vertexId] = pid;
      addLog(state, `👷 ${state.players[pid].name}が城壁を無料建設(手札上限+2)`);
    },
  },

  inventor: {
    deck: 'science', count: 2,
    name: '発明家', icon: '💡',
    desc: '数字トークンを2つ入れ替える(2・6・8・12は不可)',
    needsParams: 'hex2',
    validate(state, pid, params) {
      const a = state.board.hexes[params?.a];
      const b = state.board.hexes[params?.b];
      if (!a?.token || !b?.token) return '数字のあるヘックスを2つ選んでください';
      if (params.a === params.b || a.token === b.token) return '異なる数字の2ヘックスを選んでください';
      if ([2, 6, 8, 12].includes(a.token) || [2, 6, 8, 12].includes(b.token)) {
        return '2・6・8・12のトークンは動かせません';
      }
      return null;
    },
    play(state, pid, params) {
      const ha = state.board.hexes[params.a];
      const hb = state.board.hexes[params.b];
      [ha.token, hb.token] = [hb.token, ha.token];
      state.board.version = (state.board.version ?? 0) + 1;
      addLog(state, `💡 ${state.players[pid].name}が数字トークンを交換(${hb.token}⇄${ha.token})`);
    },
  },

  irrigation: {
    deck: 'science', count: 2,
    name: '灌漑', icon: '💧',
    desc: '自分の建物が隣接する畑1つにつき小麦2枚を得る',
    needsParams: null,
    validate: () => null,
    play(state, pid) { harvestTerrain(state, pid, 'field'); },
  },

  medicine: {
    deck: 'science', count: 2,
    name: '医学', icon: '⚕️',
    desc: '鉱石2+小麦1で開拓地を都市に改良できる',
    needsParams: 'vertex',
    validate(state, pid, params) {
      const p = state.players[pid];
      if (p.resources.ore < 2 || p.resources.wheat < 1) return '鉱石2・小麦1が必要です';
      const b = state.buildings[params?.vertexId];
      if (!b || b.player !== pid || b.type !== 'settlement') return '自分の開拓地を選んでください';
      return null;
    },
    play(state, pid, params) {
      const p = state.players[pid];
      p.resources.ore -= 2; state.bank.resources.ore += 2;
      p.resources.wheat -= 1; state.bank.resources.wheat += 1;
      state.buildings[params.vertexId] = { player: pid, type: 'city' };
      addLog(state, `⚕️ ${p.name}が医学の力で都市を建設(割引)`);
    },
  },

  mining: {
    deck: 'science', count: 2,
    name: '鉱山', icon: '⛏️',
    desc: '自分の建物が隣接する山1つにつき鉱石2枚を得る',
    needsParams: null,
    validate: () => null,
    play(state, pid) { harvestTerrain(state, pid, 'mountain'); },
  },

  printer: {
    deck: 'science', count: 1,
    name: '印刷機', icon: '🖨️', vp: true,
    desc: '勝利点+1(公開即得点)',
    needsParams: null,
    validate: () => '公開済みです',
    play() {},
  },

  roadBuilding: {
    deck: 'science', count: 2,
    name: '街道建設', icon: '🛤️',
    desc: '道を2本まで無料で建設する',
    needsParams: 'edges',
    validate(state, pid, params) {
      const edges = params?.edges ?? [];
      if (edges.length < 1 || edges.length > 2) return '道を1〜2本選んでください';
      const err1 = canPlaceRoad(state, pid, edges[0]);
      if (err1) return err1;
      if (edges.length === 2) {
        return canPlaceRoad(state, pid, edges[1], { extraRoads: { [edges[0]]: true } });
      }
      return null;
    },
    play(state, pid, params) {
      for (const eid of params.edges) state.roads[eid] = { player: pid };
      updateLongestRoad(state);
      addLog(state, `🛤️ ${state.players[pid].name}が道を${params.edges.length}本無料建設`);
    },
  },

  smith: {
    deck: 'science', count: 2,
    name: '鍛冶屋', icon: '⚒️',
    desc: '騎士を2体まで無料で昇格させる(自動選択)',
    needsParams: null,
    validate(state, pid) {
      const any = Object.keys(state.knights).some(
        (vid) => canPromoteKnight(state, pid, vid) === null,
      );
      if (!any) return '昇格できる騎士がいません';
      return null;
    },
    play(state, pid) {
      let done = 0;
      for (let i = 0; i < 2; i++) {
        // 高レベル優先で昇格(蛮族防衛への寄与が大きい)
        const vids = Object.keys(state.knights)
          .filter((vid) => canPromoteKnight(state, pid, vid) === null)
          .sort((a, b) => state.knights[b].level - state.knights[a].level);
        if (!vids.length) break;
        state.knights[vids[0]].level += 1;
        done++;
      }
      addLog(state, `⚒️ ${state.players[pid].name}が騎士${done}体を無料昇格!`);
    },
  },
};

// 公式構成: 各系統18枚(count の合計)
export function buildProgressDecks() {
  const decks = { trade: [], politics: [], science: [] };
  for (const [id, def] of Object.entries(PROGRESS_CARDS)) {
    for (let i = 0; i < def.count; i++) decks[def.deck].push(id);
  }
  return decks;
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
    if (PROGRESS_CARDS[cardId].vp) {
      p.progressVP += 1;
      addLog(state, `${p.name}が進歩カード「${PROGRESS_CARDS[cardId].name}」を公開! +1点`);
    } else if (p.progressCards.length >= PROGRESS_HAND_LIMIT) {
      deck.unshift(cardId); // 手札上限超過は山札の底へ
      addLog(state, `${p.name}は進歩カードの手札が上限のため獲得できず`);
    } else {
      p.progressCards.push({ id: cardId, deck: track, boughtTurn: state.turn });
      addLog(state, `${p.name}が進歩カードを1枚獲得(${track === 'trade' ? '交易' : track === 'politics' ? '政治' : '科学'})`);
    }
  }
}
