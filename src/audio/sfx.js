// 効果音(Web Audio の合成音)。
//
// BGM と同じく音源ファイルは持たない ── オフライン PWA でビルド工程もないので、
// 全部その場で合成する。AudioContext は BGM と共有する(ctx.js)。
//
// 音色は BGM(D ドリア・大聖堂の残響)と喧嘩しないように、
// 音階は D ドリアに寄せ、短く・小さく・残響なしで鳴らす。

import { lsGet, lsSet } from '../storage.js';
import { audioCtx, existingCtx, setKeepAlive } from './ctx.js';

const midiHz = (m) => 440 * 2 ** ((m - 69) / 12);

// D ドリアの音度(BGM の SCALE と同じ並び)
const D = { d: 62, e: 64, f: 65, g: 67, a: 69, b: 71, c: 72, d2: 74, f2: 77, a2: 81 };

export class Sfx {
  constructor() {
    this.enabled = lsGet('sfx') !== 'off';
    this.ctx = null;
    this.bus = null;
    this.noiseBuf = null;
    // 同じ音が一瞬に重なって割れるのを防ぐ(資源分配など複数回呼ばれる場面)
    this.lastAt = new Map();
    setKeepAlive(this.enabled);
  }

  setEnabled(on) {
    this.enabled = on;
    lsSet('sfx', on ? 'on' : 'off');
    setKeepAlive(on);
    if (on) this.play('ui');
  }

  // 初回はユーザー操作(タップ)の中から呼ぶこと(iOS の自動再生制限)
  _ensure() {
    if (this.bus) return true;
    const ctx = audioCtx();
    if (!ctx) return false;
    this.ctx = ctx;
    this.bus = ctx.createGain();
    this.bus.gain.value = 0.9;
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -18;
    comp.ratio.value = 6;
    this.bus.connect(comp);
    comp.connect(ctx.destination);

    // ホワイトノイズ(1秒ぶん使い回す)
    const len = ctx.sampleRate;
    this.noiseBuf = ctx.createBuffer(1, len, ctx.sampleRate);
    const data = this.noiseBuf.getChannelData(0);
    for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
    return true;
  }

  play(name, opts = {}) {
    if (!this.enabled) return;
    const fn = VOICES[name];
    if (!fn) return;
    if (!this._ensure()) return;
    // タブが隠れている間に溜まった音を復帰時に一斉に鳴らさない
    if (typeof document !== 'undefined' && document.hidden) return;
    if (this.ctx.state === 'suspended') this.ctx.resume();

    // 連打の抑制(同じ音は 60ms 以内に重ねない)
    const now = this.ctx.currentTime;
    if (now - (this.lastAt.get(name) ?? -1) < 0.06) return;
    this.lastAt.set(name, now);

    try {
      fn(this, now + 0.01, opts);
    } catch (e) {
      console.warn('SFX failed:', name, e);
    }
  }

  // ---- 素材 ----

  // 単音。type/減衰/音量を変えて打楽器にも旋律にもする。
  tone(midi, t0, dur, { type = 'triangle', gain = 0.16, glide = 0, lp = 0 } = {}) {
    const ctx = this.ctx;
    const osc = ctx.createOscillator();
    osc.type = type;
    const f = midiHz(midi);
    osc.frequency.setValueAtTime(f, t0);
    if (glide) osc.frequency.exponentialRampToValueAtTime(midiHz(midi + glide), t0 + dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(gain, t0 + Math.min(0.012, dur * 0.2));
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    let tail = g;
    if (lp) {
      const filt = ctx.createBiquadFilter();
      filt.type = 'lowpass';
      filt.frequency.value = lp;
      osc.connect(filt);
      filt.connect(g);
    } else {
      osc.connect(g);
    }
    tail.connect(this.bus);
    osc.start(t0);
    osc.stop(t0 + dur + 0.05);
  }

  // ノイズ一発。木を叩く音・水しぶき・紙の音などの素。
  noise(t0, dur, { gain = 0.12, freq = 1800, q = 1, type = 'bandpass', sweep = 0 } = {}) {
    const ctx = this.ctx;
    const src = ctx.createBufferSource();
    src.buffer = this.noiseBuf;
    src.loop = true;
    const filt = ctx.createBiquadFilter();
    filt.type = type;
    filt.frequency.setValueAtTime(freq, t0);
    if (sweep) filt.frequency.exponentialRampToValueAtTime(Math.max(60, freq * sweep), t0 + dur);
    filt.Q.value = q;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(gain, t0 + 0.006);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    src.connect(filt);
    filt.connect(g);
    g.connect(this.bus);
    src.start(t0);
    src.stop(t0 + dur + 0.05);
  }

  // 分散和音(獲得・勝利など「良いこと」の合図)
  arp(midis, t0, { step = 0.075, dur = 0.4, gain = 0.13, type = 'triangle' } = {}) {
    midis.forEach((m, i) => this.tone(m, t0 + i * step, dur, { type, gain, lp: 3200 }));
  }
}

// ---- 音の定義 ----
//
// それぞれ「何の音に聞こえてほしいか」をコメントに書いてある。
// 鳴らす場面は sfxForAction() 側で決める。

const VOICES = {
  // ボタンを押した感触(設定のオン/オフ確認にも使う)
  ui: (s, t) => s.tone(D.a, t, 0.09, { type: 'sine', gain: 0.09 }),

  // ダイス: 木の器の中で転がって止まる
  roll: (s, t) => {
    for (let i = 0; i < 7; i++) {
      const d = t + i * 0.055 + Math.random() * 0.02;
      s.noise(d, 0.05, { gain: 0.1 - i * 0.008, freq: 2600 - i * 220, q: 2.5 });
    }
    s.noise(t + 0.46, 0.12, { gain: 0.13, freq: 700, q: 1.2, sweep: 0.5 });
  },

  // 道・船: 木材を置く鈍い音
  road: (s, t) => {
    s.noise(t, 0.07, { gain: 0.13, freq: 900, q: 1.4, sweep: 0.4 });
    s.tone(D.d - 24, t, 0.13, { type: 'sine', gain: 0.14 });
  },
  ship: (s, t) => {
    s.noise(t, 0.09, { gain: 0.1, freq: 800, q: 1.2, sweep: 0.5 });
    // 水を切る音(高域が抜けていく)
    s.noise(t + 0.05, 0.3, { gain: 0.075, freq: 5200, q: 0.7, sweep: 0.14, type: 'highpass' });
  },

  // 開拓地: 槌で打って建てる
  settlement: (s, t) => {
    s.noise(t, 0.06, { gain: 0.15, freq: 1500, q: 1.6, sweep: 0.3 });
    s.tone(D.d - 12, t + 0.02, 0.2, { type: 'triangle', gain: 0.15, lp: 2000 });
    s.tone(D.a, t + 0.06, 0.3, { type: 'sine', gain: 0.09 });
  },
  // 都市: もっと重く、和音で「格が上がった」感じ
  city: (s, t) => {
    s.noise(t, 0.09, { gain: 0.16, freq: 1100, q: 1.4, sweep: 0.25 });
    s.tone(D.d - 24, t, 0.35, { type: 'sine', gain: 0.17 });
    s.arp([D.d, D.f, D.a], t + 0.05, { step: 0.055, dur: 0.5, gain: 0.1 });
  },

  // 資源が入った: 短い上昇形
  gain: (s, t) => s.arp([D.d, D.f, D.a], t, { step: 0.06, dur: 0.32, gain: 0.11 }),
  // 商品(都市と騎士)はひとつ上の響きで
  commodity: (s, t) => s.arp([D.f, D.a, D.d2], t, { step: 0.06, dur: 0.34, gain: 0.1 }),

  // 交易成立: 握手のような2音
  trade: (s, t) => {
    s.tone(D.a, t, 0.22, { type: 'sine', gain: 0.13 });
    s.tone(D.d2, t + 0.11, 0.32, { type: 'sine', gain: 0.12 });
  },
  // 断られた: 下降する2音
  reject: (s, t) => {
    s.tone(D.f, t, 0.14, { type: 'triangle', gain: 0.1, lp: 1600 });
    s.tone(D.d - 2, t + 0.1, 0.24, { type: 'triangle', gain: 0.1, lp: 1200 });
  },

  // 発展カードを買う/引く: 紙を擦る音
  card: (s, t) => {
    s.noise(t, 0.16, { gain: 0.07, freq: 4200, q: 0.6, sweep: 0.5, type: 'highpass' });
    s.tone(D.a, t + 0.05, 0.16, { type: 'sine', gain: 0.07 });
  },
  // カードを使う: きらめき
  cardPlay: (s, t) => s.arp([D.a, D.d2, D.f2, D.a2], t, { step: 0.05, dur: 0.45, gain: 0.09, type: 'sine' }),

  // 7・盗賊: 低いうねり(不穏)
  robber: (s, t) => {
    s.tone(D.d - 26, t, 0.7, { type: 'sawtooth', gain: 0.1, glide: -3, lp: 320 });
    s.noise(t + 0.05, 0.5, { gain: 0.06, freq: 420, q: 0.8, sweep: 0.4 });
  },
  // 奪われた/捨てた: 短い下降
  steal: (s, t) => s.tone(D.a, t, 0.28, { type: 'triangle', gain: 0.13, glide: -12, lp: 2400 }),

  // 騎士(都市と騎士): 金属の当たる音
  knight: (s, t) => {
    s.noise(t, 0.07, { gain: 0.1, freq: 3400, q: 3 });
    s.tone(D.d2, t, 0.26, { type: 'square', gain: 0.06, lp: 2600 });
  },
  // 蛮族の襲来: 太鼓と低い角笛
  barbarian: (s, t) => {
    for (let i = 0; i < 3; i++) {
      s.noise(t + i * 0.22, 0.16, { gain: 0.16, freq: 160, q: 1.1, type: 'lowpass' });
    }
    s.tone(D.d - 24, t + 0.1, 0.9, { type: 'sawtooth', gain: 0.11, lp: 500 });
    s.tone(D.a - 24, t + 0.1, 0.9, { type: 'sawtooth', gain: 0.08, lp: 500 });
  },
  // ドラゴンの暴走
  dragon: (s, t) => {
    s.tone(D.d - 26, t, 1.0, { type: 'sawtooth', gain: 0.13, glide: 5, lp: 420 });
    s.noise(t, 0.8, { gain: 0.09, freq: 900, q: 0.5, sweep: 0.25 });
  },

  // 自分の手番が来た: 澄んだ鐘
  turn: (s, t) => {
    s.tone(D.d2, t, 0.7, { type: 'sine', gain: 0.12 });
    s.tone(D.a, t, 0.9, { type: 'sine', gain: 0.07 });
  },
  // 自分に返事を求められた(交易の提案・捨て札・盗賊の移動など): 呼びかけの2音
  ask: (s, t) => {
    s.tone(D.a, t, 0.16, { type: 'sine', gain: 0.11 });
    s.tone(D.d2, t + 0.13, 0.3, { type: 'sine', gain: 0.11 });
  },

  // 勝利: ファンファーレ
  win: (s, t) => {
    s.arp([D.d, D.f, D.a, D.d2], t, { step: 0.11, dur: 0.6, gain: 0.15 });
    s.tone(D.d2, t + 0.5, 1.4, { type: 'triangle', gain: 0.14, lp: 3000 });
    s.tone(D.a, t + 0.5, 1.4, { type: 'triangle', gain: 0.1, lp: 3000 });
    s.tone(D.d - 12, t + 0.5, 1.6, { type: 'sine', gain: 0.12 });
  },
  // 敗北(誰かが勝った)
  lose: (s, t) => {
    s.tone(D.a, t, 0.5, { type: 'triangle', gain: 0.1, lp: 1800 });
    s.tone(D.f, t + 0.22, 0.6, { type: 'triangle', gain: 0.1, lp: 1500 });
    s.tone(D.d - 12, t + 0.46, 1.1, { type: 'sine', gain: 0.11 });
  },
};

export const SFX_NAMES = Object.keys(VOICES);

// ---- どの場面でどれを鳴らすか ----
//
// アクション1つにつき最大2音(手ごたえの音 + その結果の音)。
// me は自分の席番号。自分に起きたことだけ鳴らす音がある(獲得・被害)。
// 戻り値は [{ name, delay }] で、delay は秒。

const BUILD_VOICE = {
  BUILD_ROAD: 'road',
  BUILD_SHIP: 'ship',
  MOVE_SHIP: 'ship',
  BUILD_SETTLEMENT: 'settlement',
  BUILD_CITY: 'city',
  BUILD_WALL: 'settlement',
  BUILD_TOWER: 'settlement',
  BUILD_KNIGHT: 'knight',
  ACTIVATE_KNIGHT: 'knight',
  PROMOTE_KNIGHT: 'knight',
  MOVE_KNIGHT: 'knight',
  BUY_DEV_CARD: 'card',
  SPEND_FISH: 'card',
  PLAY_DEV_CARD: 'cardPlay',
  PLAY_PROGRESS_CARD: 'cardPlay',
  BUY_IMPROVEMENT: 'commodity',
  TRADE_BANK: 'trade',
  CHOOSE_TRADE: 'trade',
  DISCARD: 'steal',
  PICK_MERCHANT: 'steal',
  PICK_SPY: 'steal',
  RAZE_CITY: 'barbarian',
  PASS_SHOE: 'ui',
  PICK_GOLD: 'gain',
  PICK_AQUEDUCT: 'gain',
};

const handOf = (p) =>
  Object.values(p.resources).reduce((a, b) => a + b, 0) +
  (p.commodities ? Object.values(p.commodities).reduce((a, b) => a + b, 0) : 0);

export function sfxForAction(action, prev, next, me) {
  if (!action || !prev || !next) return [];
  const out = [];
  const add = (name, delay = 0) => { if (name) out.push({ name, delay }); };

  // 自分に返事が回ってきたら呼びかける。手番中ずっと画面を見ているとは限らないので、
  // 「今あなたが答える番」という割り込みは、その行動そのものの音とは別に鳴らす。
  const asksMe = (s) => me != null && !!s.awaiting?.players?.includes(me);
  const newlyAsked = asksMe(next) && !asksMe(prev);
  // 行動そのものの音を先に鳴らし、呼びかけを少し遅らせて重ならないようにする
  const done = () => {
    if (newlyAsked) out.push({ name: 'ask', delay: out.length ? 0.9 : 0 });
    return out;
  };

  if (action.type === 'ROLL_DICE') {
    add('roll');
    const total = (next.dice?.[0] ?? 0) + (next.dice?.[1] ?? 0);
    // 蛮族の進軍が0に戻った = 襲来が起きた
    const attacked = (prev.barbarians?.position ?? 0) > (next.barbarians?.position ?? 0);
    // ドラゴンの暴走は巣(盗賊コマ)が動くので、それを合図にする
    const rampaged = next.mode === 'dragon' && prev.board.robber !== next.board.robber;
    if (attacked) add('barbarian', 0.7);
    else if (rampaged) add('dragon', 0.7);
    else if (total === 7) add('robber', 0.7);
    else if (me != null && handOf(next.players[me]) > handOf(prev.players[me])) add('gain', 0.7);
    return done();
  }

  if (action.type === 'MOVE_ROBBER') {
    add('robber');
    // 自分が奪われたときだけ被害の音を足す
    if (me != null && handOf(next.players[me]) < handOf(prev.players[me])) add('steal', 0.35);
    return done();
  }

  if (action.type === 'RESPOND_TRADE') {
    // 提案が締め切られたときだけ(まだ返事待ちが残っていれば鳴らさない)
    if (next.awaiting?.type === 'tradeOffer') return done();
    const replies = prev.awaiting?.context?.replies ?? {};
    const anyYes = action.accept || Object.values(replies).some(Boolean);
    add(anyYes ? 'ui' : 'reject');
    return done();
  }

  if (action.type === 'PLACE_INITIAL') {
    add(next.ships?.[action.edgeId] ? 'ship' : 'settlement');
    return done();
  }

  if (action.type === 'END_TURN') {
    // 手番が自分に回ってきた合図(割り込み待ちのときは鳴らさない)
    if (me != null && next.currentPlayer === me && !next.awaiting) add('turn');
    return done();
  }

  add(BUILD_VOICE[action.type]);
  return done();
}

// 決着の音。勝者が自分かどうかで変える。
export function sfxForEnd(state, me) {
  if (state.phase !== 'ended') return null;
  return state.winner === me ? 'win' : 'lose';
}

// タブが隠れたら止める / 戻ったら鳴らせるようにする。
export function suspendAudio() {
  const ctx = existingCtx();
  if (ctx && ctx.state === 'running') ctx.suspend();
}
