// 戦績と実績の保存(設計書 §11)
//
// 端末のローカルに閉じる。オフラインでも遊べるアプリなので、サーバーは使わない。
// localStorage を触るのは load/save だけで、集計と判定は全て純粋関数にしてある
// (test/progress.test.js が localStorage なしで検証できるように)。

import { lsGet, lsSet, lsRemove } from './storage.js';
import { computePoints } from './rules/victory.js';
import {
  ACHIEVEMENTS, marksOf, titleOf, unlockedBy, unlockedByMeet, unlockedByRaid, unlockedBySeen,
} from './achievements.js';

const KEY = 'progress';
export const PROGRESS_VERSION = 1;

export const MODES = ['base', 'cak', 'dragon', 'fish', 'sea'];
export const DIFFICULTIES = ['easy', 'normal', 'hard'];

export function emptyProgress() {
  return {
    v: PROGRESS_VERSION,
    games: [],
    achievements: {},
    title: null,
    fish: {},
    meets: {},
    seen: {},
    raid: emptyRaid(),
  };
}

// 集まり1つぶんの通算。best の単位は遊びによる(釣りは cm、竜は秒)。
// last は「最後に数えた回」の目印(addContestResult 参照)。
export const emptyMeet = () => ({ played: 0, won: 0, best: 0, last: null });

// 蛮族を射る(ひとりの記録)の通算。best/wave/acc は自己最高。
export const emptyRaid = () => ({ played: 0, best: 0, wave: 0, acc: 0, shots: 0, hits: 0 });

// 対戦1回ぶんの記録。state をそのまま持つと重いので、要点だけ取り出す。
// (盤面を再現したいときのために seed は残す)
export function resultOf(state, me, now = Date.now()) {
  return {
    at: now,
    mode: state.mode,
    difficulty: state.difficulty ?? 'normal',
    players: state.players.length,
    seed: state.seed ?? null,
    won: state.winner === me,
    points: computePoints(state, me, { includeHidden: true }),
    turns: state.turn,
    // 実績の進捗(「騎士 3/4」)には過去の最高到達値が要るので、
    // その対戦での到達値をここで焼き付けておく。
    marks: marksOf(state, me),
  };
}

// ---- 集計 ----

// モード×難易度の集計。空でも全ての枠を作るので、表がそのまま描ける。
export function summarize(progress) {
  const byMode = {};
  for (const mode of MODES) {
    byMode[mode] = { played: 0, won: 0, bestPoints: 0, bestTurns: null };
    for (const d of DIFFICULTIES) {
      byMode[mode][d] = { played: 0, won: 0 };
    }
  }
  const total = { played: 0, won: 0, bestPoints: 0, bestTurns: null };
  // 到達値の自己最高。実績の進捗表示に使う
  const bests = {};
  for (const g of progress.games) {
    for (const [k, v] of Object.entries(g.marks ?? {})) {
      if (typeof v === 'number' && v > (bests[k] ?? 0)) bests[k] = v;
    }
    const m = byMode[g.mode];
    if (!m) continue; // 知らないモードの記録(将来の版で遊んだ)は数えない
    const d = m[g.difficulty] ?? m.normal;
    m.played++; d.played++; total.played++;
    if (g.won) {
      m.won++; d.won++; total.won++;
      // 最短勝利と最高得点は「勝った対戦」だけで見る
      if (m.bestTurns == null || g.turns < m.bestTurns) m.bestTurns = g.turns;
      if (total.bestTurns == null || g.turns < total.bestTurns) total.bestTurns = g.turns;
    }
    if (g.points > m.bestPoints) m.bestPoints = g.points;
    if (g.points > total.bestPoints) total.bestPoints = g.points;
  }
  // 蛮族を射るの自己最高も同じ棚に置く。戦績画面の進捗(progressOf)は
  // bests しか見ないので、ここに入れておけば「3/6波」が出せる。
  const raid = progress.raid ?? {};
  bests.raidScore = raid.best ?? 0;
  bests.raidWave = raid.wave ?? 0;
  bests.raidAcc = raid.acc ?? 0;
  return { byMode, total, bests };
}

export function winRate(n) {
  return n.played === 0 ? null : Math.round((n.won / n.played) * 100);
}

// ---- 記録 ----

// 対戦結果を足して、新しく解除された実績の一覧を返す。
// progress は書き換えずに新しいオブジェクトを返す(state と同じ流儀)。
export function addResult(progress, result, ctx) {
  const next = {
    ...progress,
    games: [...progress.games, result],
    achievements: { ...progress.achievements },
  };
  const stats = summarize(next);
  const unlocked = [];
  for (const id of unlockedBy({ ...ctx, result, stats })) {
    if (next.achievements[id]) continue; // すでに持っている
    next.achievements[id] = { at: result.at, mode: result.mode };
    unlocked.push(id);
  }
  // 初めて実績を取ったら、その称号を自動で名乗らせる
  // (設定画面まで行かないと何も起きない、という体験を避ける)
  if (next.title == null && unlocked.length) next.title = unlocked[0];
  return { progress: next, unlocked };
}

// ---- 釣り図鑑 ----
//
// ミニゲームの記録。対戦の戦績とは別枠だが、保存先は同じ(端末のローカル1か所)。
// 魚そのものの定義は minigame/fish.js にあり、ここは「何を何匹・自己最大」だけを持つ。

// 1匹ぶんを足す。progress は書き換えず、新しいものと「初めて/自己記録」を返す。
export function addCatch(progress, fishId, cm, now = Date.now()) {
  const prev = progress.fish?.[fishId] ?? null;
  const isNew = !prev;
  const isRecord = !prev || cm > prev.best;
  const next = {
    ...progress,
    fish: {
      ...(progress.fish ?? {}),
      [fishId]: {
        n: (prev?.n ?? 0) + 1,
        best: isRecord ? cm : prev.best,
        at: isRecord ? now : prev.at,
      },
    },
  };
  return { progress: next, isNew, isRecord };
}

// ---- 釣り大会 ----
//
// 散策部屋のミニゲーム。進行はサーバーが持っていて(server/fishing-contest.js)、
// ここに残すのは「この端末の人が何回出て何回勝ったか」だけ。
//
// key は「部屋のコード + 何回目の大会か」。結果は25秒のあいだ毎秒配られるし、
// その最中に再読み込みすると同じ回がもう一度届く。同じ key は数えない。
export function addContestResult(
  progress, { kind = 'fishing', won, score = 0, key = null, at = Date.now() },
) {
  const prev = progress.meets?.[kind] ?? emptyMeet();
  if (key != null && prev.last === key) return { progress, unlocked: [] };
  const meet = {
    played: prev.played + 1,
    won: prev.won + (won ? 1 : 0),
    best: Math.max(prev.best ?? 0, score),
    last: key,
  };
  const meets = { ...(progress.meets ?? {}), [kind]: meet };
  const next = { ...progress, meets, achievements: { ...progress.achievements } };
  const unlocked = [];
  for (const id of unlockedByMeet({ kind, meet, meets })) {
    if (next.achievements[id]) continue; // すでに持っている
    next.achievements[id] = { at, mode: null };
    unlocked.push(id);
  }
  // 対戦のほうと同じで、初めて取ったらその称号を自動で名乗らせる
  if (next.title == null && unlocked.length) next.title = unlocked[0];
  return { progress: next, unlocked };
}

// ---- 蛮族を射る(ひとりの記録)----
//
// 大会(meets)と違って、ひとりで櫓に立った回も数える。大会に出た回も
// ここに足す ── 同じ弓の腕前の記録なので、別々に持つと「自己最高」が
// 2つできてどちらを出すか決められなくなる。
//
// 命中率だけは回ごとに見る。合計の射数で割ると、下手な回を数多く重ねた
// 人ほど分母が育って、7割に届かなくなる(腕が上がっても記録が伸びない)。

// 命中率を記録に残す最低の射数。3射して2本当たった回が自己最高として
// 残ると、狙いの精度の記録として意味をなさない。
export const ACC_MIN_SHOTS = 20;

export function addRaidRun(progress, { score = 0, wave = 1, shots = 0, hits = 0 } = {}, at = Date.now()) {
  const prev = progress.raid ?? emptyRaid();
  const n = (v) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.floor(v) : 0);
  const s = n(shots);
  const h = Math.min(s, n(hits));
  const acc = s >= ACC_MIN_SHOTS ? Math.round((h / s) * 100) : 0;
  const raid = {
    played: prev.played + 1,
    best: Math.max(prev.best, n(score)),
    wave: Math.max(prev.wave, n(wave)),
    acc: Math.max(prev.acc, acc),
    shots: prev.shots + s,
    hits: prev.hits + h,
  };
  const next = { ...progress, raid, achievements: { ...progress.achievements } };
  const unlocked = [];
  for (const id of unlockedByRaid({ raid })) {
    if (next.achievements[id]) continue; // すでに持っている
    next.achievements[id] = { at, mode: null };
    unlocked.push(id);
  }
  // 対戦・大会と同じで、初めて取ったらその称号を自動で名乗らせる
  if (next.title == null && unlocked.length) next.title = unlocked[0];
  return { progress: next, unlocked };
}

// ---- 島で見つけたもの ----
//
// 勝ち負けではなく「そこへ行った」で付くもの(いまは竜の巣だけ)。
// 大会の通算とは別枠 ── あちらは回ごとに数えるが、こちらは一度きり。
export function noteSeen(progress, id, at = Date.now()) {
  if (progress.seen?.[id]) return { progress, unlocked: [] };  // もう行っている
  const seen = { ...(progress.seen ?? {}), [id]: at };
  const next = { ...progress, seen, achievements: { ...progress.achievements } };
  const unlocked = [];
  for (const a of unlockedBySeen({ seen })) {
    if (next.achievements[a]) continue;
    next.achievements[a] = { at, mode: null };
    unlocked.push(a);
  }
  // 対戦・大会と同じで、初めて取ったらその称号を自動で名乗らせる
  if (next.title == null && unlocked.length) next.title = unlocked[0];
  return { progress: next, unlocked };
}

// 図鑑の埋まり具合。total は魚の総数(呼ぶ側が fish.js から渡す)。
export function fishbookCount(progress, total) {
  const book = progress.fish ?? {};
  const got = Object.keys(book).length;
  return { got, total, caught: Object.values(book).reduce((s, e) => s + (e.n ?? 0), 0) };
}

// 名乗る称号を選ぶ。持っていない実績の称号は名乗れない(null で「称号なし」)。
export function setTitle(progress, id) {
  if (id != null && !progress.achievements[id]) return progress;
  return { ...progress, title: id };
}

// いま名乗っている称号の文字列。持っていない実績を指していたら null。
export function currentTitle(progress) {
  const id = progress.title;
  if (!id || !progress.achievements[id]) return null;
  return titleOf(id);
}

export function achievementCount(progress) {
  return {
    got: ACHIEVEMENTS.filter((a) => progress.achievements[a.id]).length,
    total: ACHIEVEMENTS.length,
  };
}

// ---- 保存 ----

// 壊れた値が入っていても遊べなくならないように、読めなければ空から始める。
export function parseProgress(raw) {
  if (!raw) return emptyProgress();
  try {
    const p = JSON.parse(raw);
    if (!p || typeof p !== 'object') return emptyProgress();
    return {
      v: PROGRESS_VERSION,
      games: Array.isArray(p.games) ? p.games.filter((g) => g && typeof g === 'object') : [],
      achievements: p.achievements && typeof p.achievements === 'object' ? p.achievements : {},
      title: typeof p.title === 'string' ? p.title : null,
      // 釣り図鑑は後から足した。古い保存には無いので、無ければ空で始める
      fish: p.fish && typeof p.fish === 'object' ? p.fish : {},
      meets: sanitizeMeets(p),
      // 島で見つけたもの。あとから足したので、無ければ空で始める
      seen: sanitizeSeen(p?.seen),
      // 蛮族を射るの記録。これもあとから足した
      raid: sanitizeRaid(p?.raid),
    };
  } catch {
    return emptyProgress();
  }
}

// 行った場所。値は「いつ行ったか」なので、数でないものは落とす
// (壊れた値でも「行ったこと」は残す ── 実績を取り消すほうが害が大きい)。
function sanitizeSeen(src) {
  if (!src || typeof src !== 'object') return {};
  const out = {};
  for (const [id, at] of Object.entries(src)) {
    if (!at) continue;
    out[id] = typeof at === 'number' && Number.isFinite(at) && at > 0 ? at : 1;
  }
  return out;
}

// 蛮族を射るの通算。数でないものは 0 に倒す(sanitizeMeet と同じ理由 ──
// NaN のまま足すと、以後ずっと NaN が保存に焼き付く)。
function sanitizeRaid(m) {
  const n = (v) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.floor(v) : 0);
  if (!m || typeof m !== 'object') return emptyRaid();
  return {
    played: n(m.played), best: n(m.best), wave: n(m.wave),
    // 命中率は割合なので 100 で頭を打つ
    acc: Math.min(100, n(m.acc)),
    shots: n(m.shots), hits: n(m.hits),
  };
}

// 集まりの通算。もとは釣り大会1つぶんだけを meet に持っていたので、
// 古い保存があれば釣りの欄へ移す(遊びが増えたので遊びごとに分けた)。
function sanitizeMeets(p) {
  const out = {};
  const src = (p?.meets && typeof p.meets === 'object') ? p.meets : {};
  for (const [kind, m] of Object.entries(src)) out[kind] = sanitizeMeet(m);
  if (!out.fishing && p?.meet) {
    const old = sanitizeMeet(p.meet);
    // 旧い版は cm でしか持っていない
    old.best = sanitizeMeet({ best: p.meet.bestCm }).best;
    if (old.played) out.fishing = old;
  }
  return out;
}

// 数でないものが入っていたら 0 に倒す
// (壊れた値のまま足すと NaN が保存に焼き付いて、以後ずっと NaN になる)。
function sanitizeMeet(m) {
  const n = (v) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.floor(v) : 0);
  if (!m || typeof m !== 'object') return emptyMeet();
  return {
    played: n(m.played),
    won: n(m.won),
    best: n(m.best),
    last: typeof m.last === 'string' ? m.last : null,
  };
}

export function loadProgress() {
  try {
    return parseProgress(lsGet(KEY));
  } catch {
    return emptyProgress(); // localStorage が使えない環境(プライベートモード等)
  }
}

export function saveProgress(progress) {
  try {
    lsSet(KEY, JSON.stringify(progress));
  } catch {
    // 容量超過などで保存できなくても対戦は続けられる
  }
}

export function clearProgress() {
  try {
    lsRemove(KEY);
  } catch {
    // 消せなくても致命的ではない
  }
}
