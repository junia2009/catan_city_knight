// 島を歩く「すがた」の一覧。
//
// THREE を使わない。実際のメッシュは body.js がこの表を読んで組み立てる。
//
// 骨格(頭・胴・腰・腕2本・脚2本)は変えない。pose.js の姿勢が全部そのまま
// 使えるのが大事で、耳やしっぽを足すだけなら歩き・ジャンプ・釣り・エモートを
// 作り直さずに済む。脚の無い生きもの(スライムなど)を入れたくなったら、
// そのときは姿勢から作り直すことになる。
//
// **番号(id)は通信に乗る。既存の番号を入れ替えない** ── 相手が古い版を
// 開いていると、ねこのつもりがドラゴンに見える。足すときは後ろへ。

// 寸法は body.js の CUTE を基準に、必要なところだけ上書きする。
// 脚の長さを変えるときは hipY も同じだけ動かすこと(靴が宙に浮く)。

export const SPECIES = [
  {
    id: 1,
    key: 'human',
    label: 'ひと',
    icon: '🧍',
    // 服に色が付く(今までの棒人間)
    fur: false,
    parts: {},
  },
  {
    id: 2,
    key: 'cat',
    label: 'ねこ',
    icon: '🐱',
    fur: true,
    accent: 0xffd9e2,          // 耳の内側・鼻先
    parts: { ears: 'cat', tail: 'cat', snout: true },
  },
  {
    id: 3,
    key: 'bear',
    label: 'くま',
    icon: '🐻',
    fur: true,
    accent: 0xf3dcc0,
    // ずんぐり。胴を太く、脚を短く(hipY も一緒に下げる)
    props: { bodyR: 0.084, hipY: 0.104, thigh: 0.032, shin: 0.030, armR: 0.034 },
    parts: { ears: 'round', snout: true },
  },
  {
    id: 4,
    key: 'sheep',
    label: 'ひつじ',
    icon: '🐑',
    fur: true,
    accent: 0x2f2f3a,
    face: 0x3a3a44,            // 顔だけ暗くする(もこもこはその人の色)
    props: { headR: 0.098, hipY: 0.106, thigh: 0.032, shin: 0.032 },
    parts: { fluff: true, ears: 'droop' },
    top: 0.03,                 // もこもこのぶん背が高くなる
  },
  {
    id: 5,
    key: 'penguin',
    label: 'ペンギン',
    icon: '🐧',
    fur: true,
    accent: 0xfff4dd,          // お腹
    // 腕はヒレなので短く太く。脚も短い
    props: {
      hipY: 0.100, thigh: 0.030, shin: 0.028,
      upperArm: 0.034, foreArm: 0.028, armR: 0.034, handR: 0.030,
      bodyR: 0.078,
    },
    parts: { beak: true, belly: true },
  },
  {
    id: 6,
    key: 'frog',
    label: 'かえる',
    icon: '🐸',
    fur: true,
    accent: 0xe9f5c8,          // お腹
    props: { headR: 0.100, hipX: 0.058, legR: 0.038 },
    parts: { eyesOnTop: true, belly: true },
  },
  {
    id: 7,
    key: 'dragon',
    label: 'ドラゴン',
    icon: '🐉',
    fur: true,
    accent: 0xffe08a,          // 角・背びれ・翼の膜
    // 少しだけ大きく構える(小さいと「かっこいい」から遠ざかる)
    props: { bodyR: 0.078, headR: 0.102 },
    parts: { horns: true, wings: true, tail: 'dragon', spikes: true, snout: true },
    top: 0.06,                 // 反った角のぶん
  },
  {
    id: 8,
    key: 'fox',
    label: 'きつね',
    icon: '🦊',
    fur: true,
    accent: 0xfff4e2,          // 耳の内側・しっぽの先
    props: { headR: 0.100 },
    parts: { ears: 'fox', tail: 'fox', snout: true },
    top: 0.02,
  },
];

export const SPECIES_MAX = SPECIES.length;
export const DEFAULT_SPECIES = 1;

const BY_ID = new Map(SPECIES.map((s) => [s.id, s]));
const BY_KEY = new Map(SPECIES.map((s) => [s.key, s]));

// 知らない番号は「ひと」に落とす。古い版の相手が新しい番号を送ってきても、
// 姿が消えるより、とりあえず立っているほうがよい。
export function speciesById(id) {
  return BY_ID.get(id) ?? BY_ID.get(DEFAULT_SPECIES);
}

export function speciesByKey(key) {
  return BY_KEY.get(key) ?? null;
}

// 通信に乗せる前に丸める。範囲外・でたらめは既定のすがたに。
export function cleanSpecies(id) {
  const n = Math.round(Number(id));
  return Number.isFinite(n) && BY_ID.has(n) ? n : DEFAULT_SPECIES;
}

// 一覧が壊れていないか(番号の穴・重複・欠けた項目)
export function speciesOk() {
  return SPECIES.every((s, i) => s.id === i + 1 && s.key && s.icon && s.label
    && typeof s.fur === 'boolean' && s.parts && typeof s.parts === 'object');
}
