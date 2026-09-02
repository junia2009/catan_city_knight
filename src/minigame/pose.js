// 棒人間の姿勢(関節の角度)の計算。
//
// THREE を使わず、数値だけを返す。walker.js がこれをメッシュに流し込む。
//
// **どの姿勢も同じ項目を全部返すのが約束。** 1つでも欠けると、前の姿勢で
// 入れた値がそのまま残り続ける ── 実際、海に落ちたあと足の開き(rootZ)を
// 歩く姿勢が書き戻しておらず、上がってきても足が交差したままになっていた。
// test/minigame.test.js が「全ての姿勢の項目が揃っていること」を見ている。

const JOINT = (x = 0, y = 0, z = 0) => ({ x, y, z });
const LIMB = (rootX = 0, rootZ = 0, knee = 0) => ({ rootX, rootZ, knee });
// 口。0 = にっこり / 1 = 「お」の口(驚き)
const MOUTH = (open = 0) => ({ open });

// 歩き。手足を交互に振るだけの素直なもの。
// 体は上下しない ── カメラが追うので、揺らすと画面全体が揺れて見づらい。
export function walkPose(phase, gait, facing) {
  const t = phase;
  return {
    group: JOINT(0, facing, 0),
    mouth: MOUTH(0),
    // 走るほど前傾する(それらしく見せるのはこれだけで足りる)
    hips: JOINT(gait * 0.12, 0, 0),
    chest: JOINT(0, 0, 0),
    head: JOINT(0, 0, 0),
    // 脚: 交互に振る。膝は振り出しのときだけ曲げる
    legs: [0, 1].map((i) => {
      const s = i === 0 ? 1 : -1;
      const swing = Math.sin(t) * s;
      return LIMB(swing * 0.62 * gait, 0, Math.max(0, -swing) * 0.9 * gait);
    }),
    // 腕: 脚と逆位相
    arms: [0, 1].map((i) => {
      const s = i === 0 ? -1 : 1;
      const swing = Math.sin(t) * s;
      return LIMB(
        swing * 0.7 * gait,
        s * 0.14,
        0.25 + Math.max(0, swing) * 0.4 * gait,
      );
    }),
  };
}

// 空中(ジャンプ)。上りは膝を抱えて縮み、下りは脚を伸ばして着地に備える。
// vy の符号だけで上り下りが分かるので、それを -1〜1 に均して混ぜる。
export function airPose(vy, facing) {
  const up = Math.max(-1, Math.min(1, vy / 2));  // +1 上昇 / -1 落下
  const tuck = Math.max(0, up);
  const drop = Math.max(0, -up);
  return {
    group: JOINT(0, facing, 0),
    mouth: MOUTH(1),   // 跳んでいる間は「お」
    hips: JOINT(tuck * 0.3 - drop * 0.1, 0, 0),
    chest: JOINT(0, 0, 0),
    head: JOINT(0, 0, 0),
    legs: [0, 1].map((i) => {
      const s = i === 0 ? 1 : -1;
      return LIMB(-tuck * 0.85 + drop * 0.25 + s * 0.12, 0, tuck * 1.25 + drop * 0.1);
    }),
    // 腕は上へ。手足は下向きに垂れているので、真上に挙げるには約 180°(π)いる
    // ── ここを浅くすると「前へならえ」になってゾンビみたいに見える。
    // 落ちている間は横へ開く(バランスを取っている風に)。
    arms: [0, 1].map((i) => {
      const s = i === 0 ? -1 : 1;
      return LIMB(
        -2.95 + drop * 0.75,
        // 左右に開かないと、後ろから見たときに2本が重なって1本に見える
        s * (0.38 + drop * 0.5),
        0.2 + tuck * 0.3,
      );
    }),
  };
}

// 海へ落ちていく途中。回りながら手足をじたばたさせる。
export function tumblePose(spin, facing) {
  const t = spin * 2.4;
  return {
    group: JOINT(Math.sin(spin * 1.7) * 0.45, facing, spin),
    mouth: MOUTH(1),   // 落ちている間は「お」
    hips: JOINT(-0.25, 0, 0),
    chest: JOINT(Math.sin(t * 1.3) * 0.2, 0, Math.sin(t) * 0.12),
    head: JOINT(0.2, 0, 0),
    legs: [0, 1].map((i) => {
      const s = i === 0 ? 1 : -1;
      return LIMB(
        Math.sin(t + s * 1.6) * 0.85 - 0.2,
        s * 0.2,
        0.5 + Math.max(0, Math.sin(t * 1.2 + s)) * 0.7,
      );
    }),
    arms: [0, 1].map((i) => {
      const s = i === 0 ? -1 : 1;
      return LIMB(
        -2.2 + Math.sin(t * 1.5 + s * 2.1) * 1.1,
        s * (0.5 + Math.sin(t * 0.9) * 0.2),
        0.4 + Math.max(0, Math.sin(t * 1.4 + s * 2)) * 0.5,
      );
    }),
  };
}

// 水の中。もがくのをやめ、手足が水に押されて上へ流れる。
// ゆっくりした周期だけで動かす ── 速い動きを混ぜると水の重さが消える。
export function sinkPose(t, facing, spin) {
  return {
    group: JOINT(
      0.28 + Math.sin(t * 0.8) * 0.12,
      facing + spin * 1.2,
      Math.sin(t * 0.7) * 0.26,
    ),
    mouth: MOUTH(1),   // 水の中でも口は開いたまま
    hips: JOINT(-0.12 + Math.sin(t * 1.1) * 0.06, 0, 0),
    chest: JOINT(0.12, 0, Math.sin(t * 0.9) * 0.1),
    head: JOINT(-0.18, 0, 0),
    legs: [0, 1].map((i) => {
      const s = i === 0 ? 1 : -1;
      return LIMB(
        -0.35 + Math.sin(t * 0.9 + s) * 0.18,
        s * 0.22,
        0.45 + Math.sin(t * 0.8 + s) * 0.15,
      );
    }),
    arms: [0, 1].map((i) => {
      const s = i === 0 ? -1 : 1;
      return LIMB(
        -2.75 + Math.sin(t * 0.85 + s * 1.2) * 0.22,
        s * (0.55 + Math.sin(t * 0.7) * 0.12),
        0.3 + Math.sin(t * 0.75 + s) * 0.15,
      );
    }),
  };
}

// 釣り。竿は右手(arms[1])に付いていて、腕の角度がそのまま竿の角度になる。
//   腕の rotation.x は 0 で真下、-π/2 で前、-π で真上。
//   竿を前上がり 35° くらいに構えたいので -(π/2 + 0.6) あたりが基準。
//
// k: { phase, tension, reeling, burst, cast } ── fishing.js の view() から作る。
export function fishPose(t, facing, k = {}) {
  const phase = k.phase ?? 'wait';
  const tension = Math.max(0, Math.min(1, k.tension ?? 0));
  const cast = Math.max(0, Math.min(1, k.cast ?? 0));
  const fighting = phase === 'fight';
  const sway = Math.sin(t * 1.3) * 0.02;   // 待っている間のわずかな揺れ

  // 釣り終わり。糸はもう水にない ── 竿を水につけたままの構えで
  // 「もう一度」を出すと、まだ釣っている最中に見える。
  const landed = phase === 'landed';
  const lost = phase === 'lost';
  const done = landed || lost;
  const bob = landed ? Math.sin(t * 6) * 0.05 : 0;   // 釣れた喜びの弾み

  // 投げる動作: いったん後ろへ振りかぶって、勢いよく前へ振り出す
  const back = Math.max(0, 1 - cast / 0.35);
  const fwd = Math.max(0, (cast - 0.35) / 0.65);
  const swing = phase === 'cast' ? back * 0.75 - fwd * 0.5 : 0;

  // アタリの瞬間は竿先がぐっと入る
  const bite = phase === 'bite' ? Math.sin(t * 22) * 0.09 : 0;
  // 暴れている間は竿ごと揺さぶられる
  const shake = k.burst ? Math.sin(t * 34) * 0.07 : 0;
  // 巻いている間は少し踏ん張る
  const hold = fighting ? tension * 0.55 + (k.reeling ? 0.1 : 0) : 0;

  // 竿の角度。釣れたら立てて掲げ、逃げられたら下ろす
  const rodBase = landed ? -2.85 + bob
    : lost ? -1.15
      : -(Math.PI / 2 + 0.6);
  const rodX = rodBase - swing - hold * 0.5 + bite + shake + sway;

  return {
    group: JOINT(0, facing, 0),
    // 大物と格闘している間と、釣れた瞬間は口が開く
    mouth: MOUTH((fighting && tension > 0.55) || landed ? 1 : 0),
    // 引かれるぶんだけ体を反らす。逃げられたら前へうなだれる
    hips: JOINT(
      -hold * 0.5 - (phase === 'cast' ? swing * 0.2 : 0) - bob * 0.6 + (lost ? 0.2 : 0),
      0, 0,
    ),
    chest: JOINT(-hold * 0.25 + shake * 0.3 + (lost ? 0.18 : 0), 0, sway * 2),
    head: JOINT(0.14 + hold * 0.2 + (lost ? 0.4 : 0) - (landed ? 0.3 : 0), 0, 0),
    // 足は少し前後に開いて踏ん張る。引かれるほど深く。
    // 終わったら揃えて立つ(踏ん張ったままだと、まだ格闘中に見える)
    legs: [0, 1].map((i) => {
      const s = i === 0 ? 1 : -1;
      if (done) return LIMB(s * 0.1, s * 0.11, 0);
      return LIMB(s * (0.22 + hold * 0.35), s * 0.13, Math.max(0, s) * (0.2 + hold * 0.5));
    }),
    arms: [0, 1].map((i) => {
      // 右手(1)が竿。左手(0)は下を支え、巻くときはハンドルを回す
      if (i === 1) return LIMB(rodX, 0.22, 0.12 + hold * 0.35);
      // 釣れたら左手を上げて喜び、逃げられたら垂らす
      if (landed) return LIMB(-2.6 + bob * 2, -0.5, 0.35);
      if (lost) return LIMB(-0.2, -0.16, 0.15);
      const crank = k.reeling ? Math.sin(t * 11) * 0.45 : 0;
      return LIMB(-1.45 - hold * 0.3 + crank * 0.35, -0.3, 0.75 + crank);
    }),
  };
}

// ---- エモート ----

// 何もしていない立ち姿。エモートの出入りはここへ戻る。
function standPose(facing) {
  return {
    group: JOINT(0, facing, 0),
    mouth: MOUTH(0),
    hips: JOINT(0, 0, 0),
    chest: JOINT(0, 0, 0),
    head: JOINT(0, 0, 0),
    legs: [0, 1].map((i) => LIMB(0, (i === 0 ? 1 : -1) * 0.1, 0)),
    arms: [0, 1].map((i) => LIMB(0, (i === 0 ? -1 : 1) * 0.16, 0.12)),
  };
}

// 2つの姿勢を混ぜる。k=0 で a、k=1 で b。
// エモートの出入りをこれで滑らかにする ── 立ち姿からいきなり万歳の角度に
// 飛ぶと、1フレームで腕がワープして「バグ」に見える。
// 項目を全部たどるので、pose に項目を足しても直さなくてよい。
export function blendPose(a, b, k) {
  const t = Math.max(0, Math.min(1, k));
  const mix = (x, y) => x + (y - x) * t;
  const joint = (x, y) => JOINT(mix(x.x, y.x), mix(x.y, y.y), mix(x.z, y.z));
  return {
    // 向きは混ぜない(同じ値が入っている。回り込みで暴れるのを避ける)
    group: JOINT(mix(a.group.x, b.group.x), b.group.y, mix(a.group.z, b.group.z)),
    // 口は開いているか閉じているかの2択。混ぜられないので近いほうを採る
    mouth: MOUTH(t < 0.5 ? a.mouth.open : b.mouth.open),
    hips: joint(a.hips, b.hips),
    chest: joint(a.chest, b.chest),
    head: joint(a.head, b.head),
    legs: [0, 1].map((i) => LIMB(
      mix(a.legs[i].rootX, b.legs[i].rootX),
      mix(a.legs[i].rootZ, b.legs[i].rootZ),
      mix(a.legs[i].knee, b.legs[i].knee),
    )),
    arms: [0, 1].map((i) => LIMB(
      mix(a.arms[i].rootX, b.arms[i].rootX),
      mix(a.arms[i].rootZ, b.arms[i].rootZ),
      mix(a.arms[i].knee, b.arms[i].knee),
    )),
  };
}

// 出入りの重み。始めと終わりの RAMP のあいだだけ、立ち姿と混ぜる。
const RAMP = 0.14;
function rampWeight(k) {
  if (k <= 0 || k >= 1) return 0;
  return Math.min(1, Math.min(k, 1 - k) / RAMP);
}

// 腕の rootX は 0 で真下、-π/2 で前、-π で真上(pose.js 全体の約束)。
function rawEmotePose(key, t, facing) {
  const base = standPose(facing);
  switch (key) {
    // 手をふる。右手(arms[1])を挙げて左右に振る
    case 'wave': {
      const swing = Math.sin(t * 7.5);
      return {
        ...base,
        head: JOINT(-0.06, 0, swing * 0.07),
        chest: JOINT(0, 0, swing * 0.05),
        arms: [
          LIMB(0.05, -0.18, 0.1),
          LIMB(-2.55, 0.5 + swing * 0.45, 0.25),
        ],
      };
    }
    // バンザイ。両手を挙げて、膝でその場を弾む
    case 'cheer': {
      const bounce = Math.max(0, Math.sin(t * 6.5));
      return {
        ...base,
        mouth: MOUTH(1),
        hips: JOINT(-0.1 - bounce * 0.05, 0, 0),
        head: JOINT(-0.22, 0, 0),
        legs: [0, 1].map((i) => LIMB(bounce * 0.12, (i === 0 ? 1 : -1) * 0.12, bounce * 0.3)),
        arms: [0, 1].map((i) => LIMB(-2.95, (i === 0 ? -1 : 1) * (0.34 + bounce * 0.1), 0.15)),
      };
    }
    // おじぎ。腰から折って、いったん止めてから戻す
    case 'bow': {
      // t は秒。0.45 秒かけて下げ、0.35 秒止め、残りで戻す
      const down = Math.min(1, t / 0.45);
      const up = Math.max(0, (t - 0.8) / 0.5);
      const bend = Math.max(0, down - up);
      return {
        ...base,
        hips: JOINT(bend * 1.0, 0, 0),
        chest: JOINT(bend * 0.18, 0, 0),
        head: JOINT(bend * 0.3, 0, 0),
        arms: [0, 1].map((i) => LIMB(bend * 0.3, (i === 0 ? -1 : 1) * 0.1, 0.08)),
      };
    }
    // 指さす。右手を前へ伸ばして、2度ほど押し出す
    case 'point': {
      const push = Math.max(0, Math.sin(t * 4.6)) * 0.14;
      return {
        ...base,
        chest: JOINT(0, 0.12, 0),
        head: JOINT(-0.04, 0.16, 0),
        arms: [
          LIMB(0.08, -0.18, 0.1),
          LIMB(-1.62 - push, 0.1, Math.max(0, 0.18 - push * 2)),
        ],
      };
    }
    // しょんぼり。うなだれて、腕を力なく垂らす
    case 'sad': {
      const sway = Math.sin(t * 1.5);
      return {
        ...base,
        hips: JOINT(0.34, 0, sway * 0.03),
        chest: JOINT(0.24, 0, sway * 0.05),
        head: JOINT(0.52, sway * 0.12, 0),
        legs: [0, 1].map((i) => LIMB(0, (i === 0 ? 1 : -1) * 0.06, 0.06)),
        arms: [0, 1].map((i) => LIMB(
          0.2 + sway * 0.04, (i === 0 ? -1 : 1) * 0.08, 0.2,
        )),
      };
    }
    default:
      return base;
  }
}

// エモートの姿勢。t は始めてからの秒数、k は 0〜1 の進み具合。
// 知らない key なら立ち姿(古い版の相手が新しい番号を送ってきたとき)。
export function emotePose(key, t, facing, k = 0.5) {
  const base = standPose(facing);
  return blendPose(base, rawEmotePose(key, t, facing), rampWeight(k));
}

// テストから使う: 姿勢が持つ項目の一覧(順序を揃えて比較できるように)。
// 中身を決め打ちせず、そのまま辿る ── 項目を増やしたときに
// ここを直し忘れて検査から漏れる、を防ぐため。
export function poseKeys(pose) {
  const keys = [];
  const walk = (obj, prefix) => {
    for (const k of Object.keys(obj).sort()) {
      const v = obj[k];
      if (Array.isArray(v)) v.forEach((e, i) => walk(e, `${prefix}${k}[${i}].`));
      else if (v && typeof v === 'object') walk(v, `${prefix}${k}.`);
      else keys.push(prefix + k);
    }
  };
  walk(pose, '');
  return keys;
}
