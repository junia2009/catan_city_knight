// 釣れるものの一覧。
//
// THREE を使わない純粋なデータと抽選だけ(node --test で検証できるように)。
//
// 「引きの強さ」は fishing.js が使う。数字の意味はそちらのコメントを見ること。
//   pull    張りの上がりやすさ(巻いている間、1秒あたり)
//   stamina 取り込みにかかる手間。いちばん大きい個体を上手に上げたときの
//           勝負の長さ(秒)から逆算してある(scratchpad の tune-fish.mjs)
//   burst   暴れる間隔(秒)の範囲。短いほど休む隙がない
//   burstK  暴れている間、張りが何倍になるか
//
// 港の種類ごとに「ぬし」を1匹だけ置いてある。港をめぐって釣る動機になるので、
// ここを増やすときも「どの港にいるか」を必ず決めること。

import { rngNext } from '../rng.js';

// tier: junk(ガラクタ)/ common / rare / legend(港のぬし)/ myth
export const FISH = [
  // ---- ガラクタ。釣れるとがっかりするが、図鑑には載る ----
  { id: 'boot', name: '長ぐつ', icon: '👢', tier: 'junk', w: 6, cm: [24, 30], pull: 0.3, stamina: 0.43, burst: [3, 5], burstK: 1.2 },
  { id: 'weed', name: '海そう', icon: '🌿', tier: 'junk', w: 8, cm: [30, 90], pull: 0.26, stamina: 0.46, burst: [3, 5], burstK: 1.1 },
  { id: 'bottle', name: '空きびん', icon: '🍾', tier: 'junk', w: 5, cm: [20, 28], pull: 0.28, stamina: 0.39, burst: [3, 5], burstK: 1.2 },

  // ---- どこの港でも釣れる ----
  { id: 'iwashi', name: 'イワシ', icon: '🐟', tier: 'common', w: 22, cm: [9, 18], pull: 0.42, stamina: 1.07, burst: [1.6, 2.6], burstK: 1.5 },
  { id: 'aji', name: 'アジ', icon: '🐟', tier: 'common', w: 20, cm: [14, 30], pull: 0.48, stamina: 1.25, burst: [1.4, 2.4], burstK: 1.6 },
  { id: 'saba', name: 'サバ', icon: '🐟', tier: 'common', w: 16, cm: [25, 45], pull: 0.55, stamina: 1.48, burst: [1.2, 2.2], burstK: 1.8 },
  { id: 'kasago', name: 'カサゴ', icon: '🐡', tier: 'common', w: 14, cm: [15, 32], pull: 0.52, stamina: 1.4, burst: [1.8, 3], burstK: 2 },
  { id: 'fugu', name: 'フグ', icon: '🐡', tier: 'common', w: 10, cm: [18, 40], pull: 0.5, stamina: 1.49, burst: [1.5, 2.5], burstK: 1.7 },
  { id: 'karei', name: 'カレイ', icon: '🐠', tier: 'common', w: 10, cm: [22, 50], pull: 0.58, stamina: 1.65, burst: [2, 3.2], burstK: 1.6 },
  { id: 'tako', name: 'タコ', icon: '🐙', tier: 'common', w: 8, cm: [30, 70], pull: 0.6, stamina: 1.76, burst: [1.6, 2.4], burstK: 1.9 },

  // ---- たまに来る大物 ----
  { id: 'tai', name: 'マダイ', icon: '🐠', tier: 'rare', w: 7, cm: [35, 75], pull: 0.68, stamina: 1.88, burst: [1.2, 2], burstK: 2.1 },
  { id: 'buri', name: 'ブリ', icon: '🐟', tier: 'rare', w: 6, cm: [60, 105], pull: 0.76, stamina: 2.01, burst: [1.1, 1.9], burstK: 2.2 },
  { id: 'maguro', name: 'マグロ', icon: '🐟', tier: 'rare', w: 4, cm: [90, 190], pull: 0.86, stamina: 1.91, burst: [1, 1.7], burstK: 2.4 },
  { id: 'kajiki', name: 'カジキ', icon: '🗡', tier: 'rare', w: 2, cm: [150, 320], pull: 0.95, stamina: 1.86, burst: [0.9, 1.5], burstK: 2.6 },

  // ---- 港のぬし。その港でしか出ない ----
  { id: 'manbou', name: 'マンボウ', icon: '🌝', tier: 'legend', at: '3:1', w: 4, cm: [120, 280], pull: 0.72, stamina: 2.62, burst: [1.4, 2.2], burstK: 2 },
  { id: 'matsukasa', name: 'マツカサウオ', icon: '🪵', tier: 'legend', at: 'wood', w: 4, cm: [12, 22], pull: 0.8, stamina: 1.68, burst: [0.8, 1.4], burstK: 2.7 },
  { id: 'akaei', name: 'アカエイ', icon: '🧱', tier: 'legend', at: 'brick', w: 4, cm: [80, 200], pull: 0.84, stamina: 2.17, burst: [1.2, 2], burstK: 2.3 },
  { id: 'mendako', name: 'メンダコ', icon: '🐑', tier: 'legend', at: 'sheep', w: 4, cm: [10, 20], pull: 0.62, stamina: 2.31, burst: [1.6, 2.6], burstK: 1.8 },
  { id: 'kinmedai', name: 'キンメダイ', icon: '🌾', tier: 'legend', at: 'wheat', w: 4, cm: [30, 60], pull: 0.78, stamina: 2.04, burst: [1.1, 1.8], burstK: 2.4 },
  { id: 'ginzame', name: 'ギンザメ', icon: '⛏', tier: 'legend', at: 'ore', w: 4, cm: [60, 140], pull: 0.88, stamina: 2, burst: [1, 1.6], burstK: 2.5 },

  // ---- ぜんぶの港にいる、めったに来ないやつ ----
  { id: 'daiouika', name: 'ダイオウイカ', icon: '🦑', tier: 'myth', w: 0.6, cm: [280, 700], pull: 1.05, stamina: 2.19, burst: [0.8, 1.3], burstK: 2.8 },
];

export const FISH_BY_ID = Object.fromEntries(FISH.map((f) => [f.id, f]));

// 港の種類は 3:1 と資源5種。ぬしはこのどれか1つにしか付かない。
export const PORT_TYPES = ['3:1', 'wood', 'brick', 'sheep', 'wheat', 'ore'];

// その港で釣れるものだけを返す(ぬしは自分の港でだけ混ざる)
export function tableFor(portType) {
  return FISH.filter((f) => f.at == null || f.at === portType);
}

// 重み付き抽選。rng は数値1つ(rng.js)で、[新しい rng, 選ばれたもの] を返す。
export function pickFish(rng, portType) {
  const table = tableFor(portType);
  const total = table.reduce((s, f) => s + f.w, 0);
  let v;
  [rng, v] = rngNext(rng);
  let acc = v * total;
  for (const f of table) {
    acc -= f.w;
    if (acc < 0) return [rng, f];
  }
  return [rng, table[table.length - 1]];
}

// 大きさ。小さいほうがよく出るように、乱数を3乗して下へ寄せる
// (毎回まんなかの大きさが出ると、記録更新の楽しみが無くなる)。
export function rollSize(rng, fish) {
  let v;
  [rng, v] = rngNext(rng);
  const k = v * v * v;
  const cm = fish.cm[0] + (fish.cm[1] - fish.cm[0]) * k;
  return [rng, Math.round(cm * 10) / 10];
}

// 0(その魚の最小)〜1(最大)。引きの強さと表示に使う。
export function sizeRatio(fish, cm) {
  const [lo, hi] = fish.cm;
  if (hi <= lo) return 0;
  return Math.max(0, Math.min(1, (cm - lo) / (hi - lo)));
}
