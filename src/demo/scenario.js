// あそびかたデモ(自動再生)の盤面づくりと小道具。
// ここはブラウザに依存しない ── node のテストからも同じ関数で台本を空回しできる。
//
// 注意: この中の関数は state を直接書き換える。ゲーム本編の不変条件
// (state を書くのは actions.js の apply だけ)の例外だが、
//  - 呼び出すのはデモの「下ごしらえ」だけ
//  - 資源のやりとりは必ず銀行と行い保存則を壊さない
// という条件を守っている(test/demo.test.js で検証)。

import { createGame, RESOURCES } from '../state.js';
import { dispatch } from '../actions.js';
import { chooseAction } from '../ai/cpu-player.js';
import { LAYOUT, TERRAIN_RESOURCE } from '../rules/board.js';
import { rngInt } from '../rng.js';
import { COMMODITIES } from '../rules/cak/progress-cards.js';

// 盤面を固定して、字幕と手順が毎回同じ流れになるようにする
export const DEMO_SEED = 20260806;
export const DEMO_PLAYER = 0; // デモで操作して見せる席(=「あなた」)

// 商品を産む地形(distributeForRoll と同じ対応)
const TERRAIN_COMMODITY = { forest: 'paper', mountain: 'coin', pasture: 'cloth' };

// ---- 盤面の下ごしらえ ----

// 初期配置だけ CPU ロジックで済ませ、「あなた」の1手番目から始まる盤面を作る
export function buildDemoState(mode) {
  let state = createGame({
    seed: DEMO_SEED,
    playerCount: 3,
    humanIndex: DEMO_PLAYER,
    mode,
    difficulty: 'hard',
  });
  let guard = 0;
  while (state.phase === 'setup' && guard++ < 64) {
    const pid = state.awaiting.players[0];
    const action = chooseAction(state, pid);
    if (!action) break;
    state = dispatch(state, action);
  }
  state.currentPlayer = DEMO_PLAYER;
  return state;
}

// 次の「あなたの手番」へジャンプする(動画のカット割りに相当)
export function cutToTurn(state, pid = DEMO_PLAYER) {
  state.currentPlayer = pid;
  state.turn += 1;
  state.awaiting = null;
  state.turnFlags = { rolled: false, playedDev: false };
  state.dice = null;
  state.eventDie = null;
}

// ---- 手札の調整(必ず銀行と出し入れする)----

// 不足分だけ銀行から配る。すでに足りていれば何もしない。
export function ensure(state, pid, amounts) {
  const p = state.players[pid];
  for (const [key, n] of Object.entries(amounts)) {
    const isRes = RESOURCES.includes(key);
    const held = isRes ? p.resources[key] : p.commodities[key];
    const stock = isRes ? state.bank.resources[key] : state.bank.commodities[key];
    const give = Math.min(Math.max(0, n - held), stock);
    if (give <= 0) continue;
    if (isRes) {
      state.bank.resources[key] -= give;
      p.resources[key] += give;
    } else {
      state.bank.commodities[key] -= give;
      p.commodities[key] += give;
    }
  }
}

// 手札を max 枚以下に戻す(7の演出で捨て札ダイアログに入らないようにする)
export function trimHand(state, pid, max) {
  const p = state.players[pid];
  const keys = [...COMMODITIES, ...RESOURCES];
  let total = keys.reduce((s, k) => s + cardsOf(p, k), 0);
  for (const key of keys) {
    while (total > max && cardsOf(p, key) > 0) {
      if (RESOURCES.includes(key)) {
        p.resources[key] -= 1;
        state.bank.resources[key] += 1;
      } else {
        p.commodities[key] -= 1;
        state.bank.commodities[key] += 1;
      }
      total -= 1;
    }
  }
}

function cardsOf(player, key) {
  return RESOURCES.includes(key) ? player.resources[key] : player.commodities[key];
}

// ---- 出目の仕込み ----

// 赤黄の目を固定し、必要ならイベントダイスの目も出るまで乱数状態を進める。
// 錬金術師と同じ turnFlags.alchemist を使うので、ルールエンジンには手を入れない。
const EVENT_FACES = ['ship', 'ship', 'ship', 'trade', 'politics', 'science'];

export function forceRoll(state, dice, eventDie = null) {
  state.turnFlags.alchemist = [dice[0], dice[1]];
  if (!eventDie) return true;
  // alchemist 指定時は rollEventDie が最初の乱数を使う。
  // 目的の面が出る乱数状態が見つかるまで空回しする。
  let s = state.rng;
  for (let i = 0; i < 4096; i++) {
    const [next, f] = rngInt(s, 6);
    if (EVENT_FACES[f] === eventDie) {
      state.rng = s;
      return true;
    }
    s = next;
  }
  return false;
}

// pid が最も多く受け取れる出目を探す(7は避ける)。商品は少し重めに数える。
export function bestRollFor(state, pid, { redDie = null } = {}) {
  let bestPair = redDie ? [redDie, 1] : [1, 2];
  let bestScore = -1;
  for (let a = 1; a <= 6; a++) {
    if (redDie && a !== redDie) continue;
    for (let b = 1; b <= 6; b++) {
      const total = a + b;
      if (total === 7) continue;
      const score = yieldOf(state, pid, total);
      if (score > bestScore) {
        bestScore = score;
        bestPair = [a, b];
      }
    }
  }
  return bestPair;
}

function yieldOf(state, pid, total) {
  let score = 0;
  for (const hid of LAYOUT.hexIds) {
    const hex = state.board.hexes[hid];
    if (hex.token !== total || state.board.robber === hid) continue;
    if (!TERRAIN_RESOURCE[hex.terrain]) continue;
    const commodity = state.mode === 'cak' ? TERRAIN_COMMODITY[hex.terrain] : null;
    for (const vid of LAYOUT.hexVertices[hid]) {
      const b = state.buildings[vid];
      if (!b || b.player !== pid) continue;
      score += b.type === 'city' ? (commodity ? 3 : 2) : 1;
    }
  }
  return score;
}

// ---- 盤面の「見栄えのする場所」選び ----

// 数字の出やすさ(6・8が最大)
export function pipsOf(state, hid) {
  const t = state.board.hexes[hid].token;
  return t ? 6 - Math.abs(7 - t) : 0;
}

// その頂点に建てたときのおいしさ
export function vertexValue(state, vid) {
  return (LAYOUT.vertexHexes[vid] ?? []).reduce(
    (s, hid) => s + (TERRAIN_RESOURCE[state.board.hexes[hid].terrain] ? pipsOf(state, hid) : 0),
    0,
  );
}

// score が最大の候補を返す(同点は id 順で決定的に)
export function pickBest(items, score) {
  let best = null;
  let bestScore = -Infinity;
  for (const id of [...items].sort()) {
    const v = score(id);
    if (v > bestScore) {
      bestScore = v;
      best = id;
    }
  }
  return best;
}
