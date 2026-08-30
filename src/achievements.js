// 実績の定義(設計書 §11)
//
// 判定は「終局時の state」と「累計の戦績」だけで行う。ゲーム中に別途カウンタを
// 持たせるとルールエンジンに手を入れることになり、既存の挙動(回帰ハッシュ)を
// 揺らすので、そこには触らない。
//
// check(ctx) → true なら解除。ctx は:
//   state   終局時の state
//   me      自分の席番号
//   result  この対戦の記録(mode / difficulty / won / points / turns / players)
//   stats   この対戦を含めた累計(progress.summarize の戻り値)
// 判定は何度呼ばれても同じ答えを返すこと(解除済みかどうかは呼び出し側が見る)。

import { longestRoadLength } from './rules/victory.js';
import { hasOldShoe } from './rules/fish.js';

const MODE_JP = {
  base: '基本',
  cak: '都市と騎士',
  dragon: 'ドラゴンの島',
  fish: '漁師たち',
  sea: '航海者たち',
};

// そのモードで勝った実績(5モードぶん自動で作る)
const modeWins = Object.entries(MODE_JP).map(([mode, jp]) => ({
  id: `win-${mode}`,
  name: `${jp}を制す`,
  desc: `${jp}で勝利する`,
  icon: '🏆',
  mode,
  check: ({ result }) => result.won && result.mode === mode,
}));

function myKnights(state, me) {
  return Object.values(state.knights ?? {}).filter((k) => k.player === me);
}

function myBuildings(state, me, type) {
  return Object.values(state.buildings).filter(
    (b) => b.player === me && (type == null || b.type === type),
  );
}

export const ACHIEVEMENTS = [
  ...modeWins,

  {
    id: 'win-all-modes',
    name: '全ルール制覇',
    desc: '5つのルール全てで勝利する',
    icon: '👑',
    check: ({ stats }) => Object.values(stats.byMode).every((m) => m.won > 0),
  },
  {
    id: 'win-hard',
    name: '強敵を退ける',
    desc: 'CPU の強さ「強い」で勝利する',
    icon: '🔥',
    check: ({ result }) => result.won && result.difficulty === 'hard',
  },
  {
    id: 'win-4p-hard',
    name: '四面楚歌',
    desc: 'CPU3体・強さ「強い」で勝利する',
    icon: '⚔️',
    check: ({ result }) => result.won && result.difficulty === 'hard' && result.players >= 4,
  },
  {
    id: 'win-fast',
    name: '電光石火',
    desc: '50ターン以内に勝利する',
    icon: '⚡',
    check: ({ result }) => result.won && result.turns <= 50,
  },
  {
    id: 'longest-road',
    name: '街道王',
    desc: '長さ10以上の交易路をつないで勝利する',
    icon: '🛤️',
    check: ({ state, me, result }) => result.won && longestRoadLength(state, me) >= 10,
  },
  {
    id: 'all-cities',
    name: '都市国家',
    desc: '都市4つを全て建てて勝利する',
    icon: '🏰',
    check: ({ state, me, result }) => result.won && myBuildings(state, me, 'city').length >= 4,
  },
  {
    id: 'largest-army',
    name: '常勝軍',
    desc: '最大騎士力を持ったまま勝利する(都市と騎士以外)',
    icon: '🎖',
    check: ({ state, me, result }) => result.won && state.largestArmy?.player === me,
  },
  {
    id: 'games-10',
    name: '常連',
    desc: '10回遊ぶ',
    icon: '📘',
    check: ({ stats }) => stats.total.played >= 10,
  },
  {
    id: 'games-50',
    name: '開拓者の鑑',
    desc: '50回遊ぶ',
    icon: '📚',
    check: ({ stats }) => stats.total.played >= 50,
  },

  // ---- 都市と騎士 ----
  {
    id: 'cak-two-metropolis',
    name: '二大都市',
    desc: 'メトロポリスを2つ持って勝利する',
    icon: '🏙',
    mode: 'cak',
    check: ({ state, me, result }) => {
      if (!result.won || state.mode !== 'cak') return false;
      const mine = Object.values(state.metropolis)
        .filter((vid) => vid != null && state.buildings[vid]?.player === me);
      return mine.length >= 2;
    },
  },
  {
    id: 'cak-defender-3',
    name: '島の守護者',
    desc: '蛮族の襲来を3度しのいで最大の功を挙げる',
    icon: '🛡',
    mode: 'cak',
    check: ({ state, me }) => (state.players[me].defenderPoints ?? 0) >= 3,
  },
  {
    id: 'cak-knights',
    name: '騎士団',
    desc: '騎士を4体そろえる',
    icon: '🐴',
    mode: 'cak',
    check: ({ state, me }) => myKnights(state, me).length >= 4,
  },
  {
    id: 'cak-max-track',
    name: '極めし者',
    desc: '都市改良をひとつの系統で Lv5 まで上げる',
    icon: '🔬',
    mode: 'cak',
    check: ({ state, me }) =>
      state.mode === 'cak' && Object.values(state.players[me].improvements).some((lv) => lv >= 5),
  },

  // ---- ドラゴンの島 ----
  {
    id: 'dragon-treasure-3',
    name: '竜の宝',
    desc: '財宝を3つ集める',
    icon: '💎',
    mode: 'dragon',
    check: ({ state, me }) => (state.players[me].treasures ?? 0) >= 3,
  },

  // ---- 漁師たち ----
  {
    id: 'fish-shoe-win',
    name: '泥沼の勝利',
    desc: '古い靴を抱えたまま勝利する',
    icon: '👟',
    mode: 'fish',
    check: ({ state, me, result }) =>
      result.won && state.mode === 'fish' && hasOldShoe(state.players[me]),
  },

  // ---- 航海者たち ----
  {
    id: 'sea-islands',
    name: '島から島へ',
    desc: '小島3つに入植する',
    icon: '🏝',
    mode: 'sea',
    check: ({ state, me }) =>
      (state.players[me].islands ?? []).filter((i) => i !== 0).length >= 3,
  },
  {
    id: 'sea-fleet',
    name: '大船団',
    desc: '船を13隻ならべる',
    icon: '⛵',
    mode: 'sea',
    check: ({ state, me }) =>
      Object.values(state.ships ?? {}).filter((s) => s.player === me).length >= 13,
  },
];

// 判定が例外で落ちても対戦の締めを止めないようにする
// (実績は「おまけ」なので、盤面の状態が想定外でも黙って見送る)
export function unlockedBy(ctx) {
  const out = [];
  for (const a of ACHIEVEMENTS) {
    try {
      if (a.check(ctx)) out.push(a.id);
    } catch {
      // この実績だけ見送る
    }
  }
  return out;
}

export function achievementById(id) {
  return ACHIEVEMENTS.find((a) => a.id === id) ?? null;
}

export { MODE_JP };
