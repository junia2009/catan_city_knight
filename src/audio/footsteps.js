// 足音。「地面の性質 × 体の動き」で音を組み立てる。
//
// 音を鳴らすのは sfx.js だが、どんな音にするかの決めごとはここに置く
// (Web Audio を持たない node --test で、表の抜けや強弱の関係を検査できる)。
//
// 足音は2つの重ね合わせでできている:
//   noise … 靴が地面をこする音。帯域と長さで「何を踏んだか」が決まる。
//           高くて長い = 砂や落ち葉、低くて短い = 土、鋭い = 岩。
//   thud  … 体重が乗る鈍い音。硬い地面ほど大きく、柔らかい地面では鳴らさない。

// 地形ごとの素の音。sweep は「終わりの周波数 / 始めの周波数」(1 未満で下がる)。
const GROUND = {
  // 森: 落ち葉を踏むカサッ。高く、長く、体重の音はしない
  forest: { freq: 3600, q: 0.8, dur: 0.10, gain: 0.055, sweep: 0.45, thud: null },
  // 牧草地: 草を擦るサッ
  pasture: { freq: 2100, q: 0.9, dur: 0.075, gain: 0.05, sweep: 0.5, thud: { midi: 33, gain: 0.03 } },
  // 畑: 耕した土のトッ。柔らかいので軽く沈む
  field: { freq: 1100, q: 1.1, dur: 0.06, gain: 0.055, sweep: 0.55, thud: { midi: 31, gain: 0.05 } },
  // 丘: 締まった粘土のドッ
  hill: { freq: 760, q: 1.3, dur: 0.055, gain: 0.06, sweep: 0.6, thud: { midi: 29, gain: 0.07 } },
  // 山: 岩を叩くコツッ。短く鋭い
  mountain: { freq: 2800, q: 2.6, dur: 0.045, gain: 0.06, sweep: 0.65, thud: { midi: 35, gain: 0.055 } },
  // 砂漠: 砂に沈むシュッ。いちばん高く、いちばん長い
  desert: { freq: 5200, q: 0.6, dur: 0.12, gain: 0.045, sweep: 0.35, thud: null },
  // 湖のふち: 水を跳ねるピチャッ
  lake: { freq: 3000, q: 1.2, dur: 0.09, gain: 0.055, sweep: 0.3, thud: { midi: 40, gain: 0.03 } },
  // 金鉱: 硬い鉱脈のキンッ。響きを残す
  gold: { freq: 3400, q: 4, dur: 0.07, gain: 0.055, sweep: 0.8, thud: { midi: 45, gain: 0.04 } },
};

// 知らない地形が来ても黙らないように(モードが増えたときの保険)
const DEFAULT_GROUND = GROUND.field;

// 動きごとの倍率。踏み切りと着地は、歩きより大きく・低く・長く。
// 着地がいちばん重い ── 高さのぶんが体重に乗るので。
const MOTION = {
  walk: { gain: 1, dur: 1, thud: 1, pitch: 1 },
  jump: { gain: 1.3, dur: 1.2, thud: 2.0, pitch: 0.9 },
  land: { gain: 1.75, dur: 1.45, thud: 3.0, pitch: 0.8 },
};

export const GROUND_KINDS = Object.keys(GROUND);
export const MOTION_KINDS = Object.keys(MOTION);

// 地面と動きから、鳴らす音の中身を作る。
// vary は -1〜1 の揺らぎ(同じ音が続くと機械的に聞こえるので、呼ぶ側で振る)。
export function stepSound(terrain, motion = 'walk', vary = 0) {
  const g = GROUND[terrain] ?? DEFAULT_GROUND;
  const m = MOTION[motion] ?? MOTION.walk;
  // NaN が来ても黙らないように(音が消えるより、揺らぎ無しで鳴るほうがよい)
  const k = Number.isFinite(vary) ? Math.max(-1, Math.min(1, vary)) : 0;
  const noise = {
    // 高さを ±12% 振る。歩幅や踏む場所の違いに相当する
    freq: Math.round(g.freq * m.pitch * (1 + k * 0.12)),
    q: g.q,
    dur: +(g.dur * m.dur).toFixed(4),
    gain: +(g.gain * m.gain * (1 + k * 0.15)).toFixed(4),
    sweep: g.sweep,
  };
  const thud = g.thud
    ? {
      midi: Math.round(g.thud.midi * m.pitch),
      gain: +(g.thud.gain * m.thud).toFixed(4),
      dur: +(0.09 * m.dur).toFixed(4),
    }
    : null;
  return { noise, thud };
}
