// 実績と称号の定義(設計書 §11)
//
// 判定材料は「終局時の state から取った到達値(marks)」と「この対戦の記録」と
// 「累計の戦績」だけ。ゲーム中に別途カウンタを持たせるとルールエンジンに
// 手を入れることになり、既存の挙動(回帰ハッシュ)を揺らすので、そこには触らない。
//
// 実績の書き方は2通り:
//   数値もの   { mark, goal, needsWin? }  … marks[mark] >= goal で解除。進捗も出せる
//   それ以外   { check(ctx) }             … 真偽だけ。進捗は出ない
//
// 数値ものを marks 経由にしているのは、**戦績画面で「3/4」と進捗を出すため**。
// 進捗には過去の最高到達値が要るので、marks を対戦記録に焼き付けて集計する。
//
// tier は「取ったときの手応え」。実測(CPU 同士を各モード30戦)の出現率で決めた。
//   bronze … 普通に遊んでいれば取れる
//   silver … 狙わないと取れない
//   gold   … かなり狙って、かつ噛み合わないと取れない

import { longestRoadLength } from './rules/victory.js';
import { hasOldShoe } from './rules/fish.js';

export const MODE_JP = {
  base: '基本',
  cak: '都市と騎士',
  dragon: 'ドラゴンの島',
  fish: '漁師たち',
  sea: '航海者たち',
};

export const TIERS = ['gold', 'silver', 'bronze'];
export const TIER_JP = { gold: '金', silver: '銀', bronze: '銅' };
export const TIER_ICON = { gold: '🥇', silver: '🥈', bronze: '🥉' };

// ---- 到達値(marks)----
// 終局時の state から、実績の判定と進捗に使う数値だけを取り出す。
// state を読むのはここだけ。以降は marks しか見ない。
export function marksOf(state, me) {
  const mine = (obj, key) => Object.values(obj ?? {}).filter((x) => x[key ?? 'player'] === me);
  const p = state.players?.[me];
  if (!p) return {};
  const metropolis = Object.values(state.metropolis ?? {})
    .filter((vid) => vid != null && state.buildings?.[vid]?.player === me).length;
  return {
    cities: mine(state.buildings).filter((b) => b.type === 'city').length,
    roadLen: safe(() => longestRoadLength(state, me), 0),
    knights: mine(state.knights).length,
    ships: mine(state.ships).length,
    metropolis,
    defender: p.defenderPoints ?? 0,
    maxTrack: Math.max(0, ...Object.values(p.improvements ?? {})),
    treasures: p.treasures ?? 0,
    islands: (p.islands ?? []).filter((i) => i !== 0).length,
    largestArmy: state.largestArmy?.player === me ? 1 : 0,
    oldShoe: safe(() => (hasOldShoe(p) ? 1 : 0), 0),
  };
}

function safe(fn, fallback) {
  try {
    return fn();
  } catch {
    return fallback;
  }
}

// 進捗を出すときの単位(「3/4体」の「体」)
const UNIT = {
  cities: 'つ', roadLen: '', knights: '体', ships: '隻',
  metropolis: 'つ', defender: '回', maxTrack: 'Lv', treasures: 'つ', islands: 'つ',
};

// そのモードで勝った実績(5モードぶん自動で作る)
const modeWins = Object.entries(MODE_JP).map(([mode, jp]) => ({
  id: `win-${mode}`,
  name: `${jp}を制す`,
  desc: `${jp}で勝利する`,
  title: `${jp}の覇者`,
  icon: '🏆',
  tier: 'bronze',
  mode,
  check: ({ result }) => result.won && result.mode === mode,
}));

export const ACHIEVEMENTS = [
  ...modeWins,

  {
    id: 'win-all-modes',
    name: '全ルール制覇',
    desc: '5つのルール全てで勝利する',
    title: '大開拓者',
    icon: '👑', tier: 'gold',
    check: ({ stats }) => Object.values(stats.byMode).every((m) => m.won > 0),
    // 「5モード中いくつ勝ったか」を進捗として出す
    progress: ({ stats }) => ({
      now: Object.values(stats.byMode).filter((m) => m.won > 0).length, goal: 5, unit: 'ルール',
    }),
  },
  {
    id: 'win-hard',
    name: '強敵を退ける',
    desc: 'CPU の強さ「強い」で勝利する',
    title: '猛者',
    icon: '🔥', tier: 'bronze',
    check: ({ result }) => result.won && result.difficulty === 'hard',
  },
  {
    id: 'win-4p-hard',
    name: '四面楚歌',
    desc: 'CPU3体・強さ「強い」で勝利する',
    title: '孤高',
    icon: '⚔️', tier: 'silver',
    check: ({ result }) => result.won && result.difficulty === 'hard' && result.players >= 4,
  },
  {
    id: 'win-fast',
    name: '電光石火',
    desc: '50ターン以内に勝利する',
    title: '疾風',
    icon: '⚡', tier: 'silver',
    check: ({ result }) => result.won && result.turns <= 50,
  },
  {
    id: 'longest-road',
    name: '街道王',
    desc: '長さ10以上の交易路をつないで勝利する',
    title: '街道王',
    icon: '🛤️', tier: 'silver',
    mark: 'roadLen', goal: 10, needsWin: true,
  },
  {
    id: 'all-cities',
    name: '都市国家',
    desc: '都市4つを全て建てて勝利する',
    title: '都市の主',
    icon: '🏰', tier: 'bronze',
    mark: 'cities', goal: 4, needsWin: true,
  },
  {
    id: 'largest-army',
    name: '常勝軍',
    desc: '最大騎士力を持ったまま勝利する(都市と騎士以外)',
    title: '将軍',
    icon: '🎖', tier: 'silver',
    check: ({ marks, result }) => result.won && marks.largestArmy === 1,
  },
  {
    id: 'games-10',
    name: '常連',
    desc: '10回遊ぶ',
    title: '常連',
    icon: '📘', tier: 'bronze',
    check: ({ stats }) => stats.total.played >= 10,
    progress: ({ stats }) => ({ now: stats.total.played, goal: 10, unit: '回' }),
  },
  {
    id: 'games-50',
    name: '開拓者の鑑',
    desc: '50回遊ぶ',
    title: '生涯開拓者',
    icon: '📚', tier: 'silver',
    check: ({ stats }) => stats.total.played >= 50,
    progress: ({ stats }) => ({ now: stats.total.played, goal: 50, unit: '回' }),
  },

  // ---- 都市と騎士 ----
  {
    id: 'cak-two-metropolis',
    name: '二大都市',
    desc: 'メトロポリスを2つ持って勝利する',
    title: '大都市の主',
    icon: '🏙', tier: 'silver', mode: 'cak',
    mark: 'metropolis', goal: 2, needsWin: true,
  },
  {
    id: 'cak-defender',
    name: '島の守護者',
    desc: '蛮族の襲来を3度しのいで最大の功を挙げる',
    title: '守護者',
    icon: '🛡', tier: 'silver', mode: 'cak',
    mark: 'defender', goal: 3,
  },
  {
    id: 'cak-knights',
    name: '騎士団',
    desc: '騎士を4体そろえる',
    title: '騎士団長',
    icon: '🐴', tier: 'gold', mode: 'cak',
    mark: 'knights', goal: 4,
  },
  {
    id: 'cak-max-track',
    name: '極めし者',
    desc: '都市改良をひとつの系統で Lv5 まで上げる',
    title: '賢者',
    icon: '🔬', tier: 'silver', mode: 'cak',
    mark: 'maxTrack', goal: 5,
  },

  // ---- ドラゴンの島 ----
  {
    id: 'dragon-treasure',
    name: '竜の宝',
    desc: '財宝を3つ集める',
    title: '宝物庫',
    icon: '💎', tier: 'bronze', mode: 'dragon',
    mark: 'treasures', goal: 3,
  },

  // ---- 漁師たち ----
  {
    id: 'fish-shoe-win',
    name: '泥沼の勝利',
    desc: '古い靴を抱えたまま勝利する',
    title: '泥中の蓮',
    icon: '👟', tier: 'silver', mode: 'fish',
    check: ({ marks, result }) => result.won && result.mode === 'fish' && marks.oldShoe === 1,
  },

  // ---- 航海者たち ----
  {
    id: 'sea-islands',
    name: '島から島へ',
    desc: '小島3つに入植する',
    title: '島の王',
    icon: '🏝', tier: 'gold', mode: 'sea',
    mark: 'islands', goal: 3,
  },
  {
    id: 'sea-fleet',
    name: '大船団',
    desc: '船を13隻ならべる',
    title: '提督',
    icon: '⛵', tier: 'gold', mode: 'sea',
    mark: 'ships', goal: 13,
  },

  // ---- 散策部屋(釣り大会)----
  //
  // 対戦の実績と違って、解除の合図は終局ではなく大会の結果発表。判定材料も
  // marks ではないので、checkMeet を持たせて別の入口(unlockedByMeet)で見る。
  // ここに check も mark も書かないので、対戦の締めでは passes() が false に
  // なって外れる ── 対戦を1戦終えたら釣り大会の実績が付いた、を防ぐ。
  {
    id: 'meet-win',
    name: '大会を制す',
    desc: '散策部屋の釣り大会で優勝する',
    title: '釣り名人',
    icon: '🎣', tier: 'silver', scope: '散策部屋',
    checkMeet: ({ meets }) => (meets.fishing?.won ?? 0) > 0,
  },
  {
    id: 'hunt-survive',
    name: '竜をかわす',
    desc: '「ドラゴンから逃げろ」で最後まで逃げきる',
    title: '韋駄天',
    icon: '🐉', tier: 'silver', scope: '散策部屋',
    checkMeet: ({ meets }) => (meets.dragonhunt?.won ?? 0) > 0,
  },

  // ---- 散策部屋(島で見つけたもの)----
  //
  // 勝ち負けではなく「そこへ行った」で付く。大会の結果とも別の入口なので
  // checkSeen を持たせて unlockedBySeen で見る(checkMeet と同じ考え方)。
  {
    id: 'nest-visit',
    name: '竜の巣',
    desc: '眠っている竜のそばまで登る',
    title: '竜の見張り',
    icon: '🏔', tier: 'bronze', scope: '散策部屋',
    checkSeen: ({ seen }) => !!seen.nest,
  },
];

// 数値ものの判定は共通(check を書かなくてよい)
function passes(a, ctx) {
  if (a.check) return !!a.check(ctx);
  if (a.mark == null) return false;
  if (a.needsWin && !ctx.result.won) return false;
  if (a.mode && ctx.result.mode !== a.mode) return false;
  return (ctx.marks?.[a.mark] ?? 0) >= a.goal;
}

// 判定が例外で落ちても対戦の締めを止めない(実績はおまけなので黙って見送る)
export function unlockedBy(ctx) {
  const out = [];
  for (const a of ACHIEVEMENTS) {
    try {
      if (passes(a, ctx)) out.push(a.id);
    } catch {
      // この実績だけ見送る
    }
  }
  return out;
}

// 釣り大会のほうの判定。対戦の締めとは別の入口にしてある(上のコメント参照)。
// ctx は { meet } ── 大会の累計( played / won / bestCm )。
export function unlockedByMeet(ctx) {
  const out = [];
  for (const a of ACHIEVEMENTS) {
    if (!a.checkMeet) continue;
    try {
      if (a.checkMeet(ctx)) out.push(a.id);
    } catch {
      // この実績だけ見送る
    }
  }
  return out;
}

// 島で見つけたもののほう。ctx は { seen } ── 行った場所の一覧。
export function unlockedBySeen(ctx) {
  const out = [];
  for (const a of ACHIEVEMENTS) {
    if (!a.checkSeen) continue;
    try {
      if (a.checkSeen(ctx)) out.push(a.id);
    } catch {
      // この実績だけ見送る
    }
  }
  return out;
}

// 実績の「どこで取るものか」。モードに紐づかないものは scope に書く。
export function scopeOf(a) {
  if (a.scope) return a.scope;
  return a.mode ? MODE_JP[a.mode] : 'すべてのルール';
}

// 戦績画面で出す進捗。{ now, goal, unit } | null
// 数値ものは「これまでの最高到達値」、それ以外は progress() を持つものだけ。
export function progressOf(a, stats) {
  try {
    if (a.progress) return { unit: '', ...a.progress({ stats }) };
    if (a.mark == null) return null;
    return { now: stats.bests?.[a.mark] ?? 0, goal: a.goal, unit: UNIT[a.mark] ?? '' };
  } catch {
    return null;
  }
}

export function achievementById(id) {
  return ACHIEVEMENTS.find((a) => a.id === id) ?? null;
}

export function achievementsByTier(tier) {
  return ACHIEVEMENTS.filter((a) => a.tier === tier);
}

// 称号は実績と1対1。持っている実績の称号だけ名乗れる。
export function titleOf(id) {
  return achievementById(id)?.title ?? null;
}
