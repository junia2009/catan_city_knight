// 釣りの進行(状態機械)。
//
// THREE も DOM も知らない。見た目は fishing-fx.js、操作の受け口は walk-mode.js。
// 乱数は釣り専用のシードを持つ ── 対戦の state.rng は絶対に回さないこと
// (オンライン対戦で全員の乱数列がずれる)。
//
// 遊びかた:
//   投げる → 待つ → アタリ(合図) → あわせる → 巻き上げ
//   巻き上げは「押している間だけ巻く」。巻くと糸の張りが上がり、
//   離すと下がる。張りきると糸が切れ、取り込みきると釣れる。
//   魚はときどき暴れて張りを跳ね上げるので、そこで手を離せるかの勝負になる。
//
// 手を離しても取り込みがゆっくり戻るだけなので、「離す=損」ではない。
// ここを損にすると、ひたすら押しっぱなしが最適になって駆け引きが消える。

import { rngNext } from '../rng.js';
import { pickFish, rollSize, sizeRatio } from './fish.js';

export const CAST_TIME = 0.55;    // 投げてから浮きが落ち着くまで
export const WAIT_MIN = 1.2;      // アタリまでの待ち(秒)
export const WAIT_MAX = 5.5;
// アタリからこの間に「あわせる」。のんびり遊ぶものなので、
// 反射神経の試験にはしない ── 気づいてから指を動かせるだけの余裕を持たせる。
export const HOOK_WINDOW = 1.6;

export const REEL_GAIN = 0.34; // 巻いている間の取り込み(1秒あたり。stamina で割る)
// 休んでいる間に緩む張り(1秒あたり)。
// 張りを一定に保って遊ぶと、巻いていられる割合は RELAX/(pull + RELAX) になる。
// ここが小さいと、引きの強い魚は「ほとんど休んでいる」ことになって勝負が長引く。
export const RELAX = 1.2;
// 休んでいる間に戻される取り込みは、その魚の巻き上げ速度に対する割合。
// 固定値にすると、巻きの遅い大物では「休むと巻いたぶん以上に戻る」ことになり、
// どう遊んでも上げられない魚ができてしまう。
const SLIP_K = 0.3;
const BURST_LEN = 0.5;    // 1回の暴れの長さ
const BURST_SLOW = 0.3;   // 暴れている間、取り込みはこの割合まで落ちる

// フレームレートに依らないよう細かく刻む(motion.js と同じ考え方)。
// 1フレームで張りが 0 から 1 を飛び越すと、切れたことに気づけない。
export const MAX_DT = 0.25;
const MAX_STEP = 1 / 60;

const clamp01 = (v) => Math.max(0, Math.min(1, v));

export class Fishing {
  // seed: 釣り専用の乱数。portType: 立っている港の種類('3:1' や 'wood')
  constructor(seed, portType = '3:1') {
    this.rng = seed >>> 0 || 1;
    this.portType = portType;
    this.phase = 'idle';   // idle / cast / wait / bite / fight / landed / lost
    this.t = 0;            // いまの段階に入ってからの秒数
    this.waitFor = 0;      // アタリまでの待ち時間
    this.tension = 0;      // 糸の張り(0〜1。1で切れる)
    this.progress = 0;     // 取り込み(0〜1。1で釣れる)
    this.fish = null;
    this.cm = 0;
    this.reeling = false;
    this.burstT = 0;       // 次に暴れるまで
    this.burst = 0;        // 暴れている残り時間
    this.lost = null;      // 逃した理由: 'early' | 'late' | 'snap'
  }

  _rand() {
    const [s, v] = rngNext(this.rng);
    this.rng = s;
    return v;
  }

  get active() {
    return this.phase !== 'idle' && this.phase !== 'landed' && this.phase !== 'lost';
  }

  // 竿を振る。待ち時間は投げた時点で決めておく(毎フレーム抽選しない)。
  cast() {
    if (this.phase !== 'idle') return false;
    this.phase = 'cast';
    this.t = 0;
    this.tension = 0;
    this.progress = 0;
    this.lost = null;
    this.waitFor = WAIT_MIN + this._rand() * (WAIT_MAX - WAIT_MIN);
    return true;
  }

  // 「あわせる」。アタリの間だけ成功。早すぎると魚が逃げる。
  hook() {
    if (this.phase === 'bite') {
      [this.rng, this.fish] = pickFish(this.rng, this.portType);
      [this.rng, this.cm] = rollSize(this.rng, this.fish);
      this.phase = 'fight';
      this.t = 0;
      this.progress = 0.06;   // 少しだけ寄せた状態から始める
      this.tension = 0.12;
      this.burstT = this._burstGap();
      this.burst = 0;
      return true;
    }
    if (this.phase === 'cast' || this.phase === 'wait') {
      this.phase = 'lost';
      this.lost = 'early';    // 早あわせ
      this.t = 0;
      return false;
    }
    return false;
  }

  setReeling(on) {
    this.reeling = !!on;
  }

  // 釣り終わりを片付けて、次を投げられる状態に戻す
  reset() {
    this.phase = 'idle';
    this.t = 0;
    this.reeling = false;
    this.tension = 0;
    this.progress = 0;
    this.burst = 0;
    return this;
  }

  _burstGap() {
    const [lo, hi] = this.fish ? this.fish.burst : [1.5, 2.5];
    return lo + this._rand() * (hi - lo);
  }

  // 大きいほど強く引く。
  // 取り込みの手間(stamina)は大きさで変えない ── 引きと手間の両方を
  // 大きさで伸ばすと効きが掛け算になり、大物の勝負が何十秒にもなってしまう。
  _power() {
    const k = sizeRatio(this.fish, this.cm);
    return {
      pull: this.fish.pull * (0.85 + 0.35 * k),
      stamina: this.fish.stamina,
      burstK: this.fish.burstK,
    };
  }

  // 戻り値: この呼び出しで起きたこと(['bite'] など)。
  // 画面の演出と音はこれを見て出す(phase を毎フレーム見比べなくてよい)。
  update(dt) {
    const total = Math.min(Math.max(dt, 0), MAX_DT);
    const n = Math.max(1, Math.ceil(total / MAX_STEP));
    const step = total / n;
    const events = [];
    for (let i = 0; i < n; i++) {
      this._step(step, events);
      if (!this.active) break;
    }
    return events;
  }

  _step(dt, events) {
    this.t += dt;
    switch (this.phase) {
      case 'cast':
        if (this.t >= CAST_TIME) { this.phase = 'wait'; this.t = 0; }
        return;
      case 'wait':
        if (this.t >= this.waitFor) {
          this.phase = 'bite';
          this.t = 0;
          events.push('bite');
        }
        return;
      case 'bite':
        // 気づかないまま時間が過ぎたら、そのまま持っていかれる
        if (this.t >= HOOK_WINDOW) {
          this.phase = 'lost';
          this.lost = 'late';
          this.t = 0;
          events.push('lost');
        }
        return;
      case 'fight':
        this._fight(dt, events);
        return;
      default:
    }
  }

  _fight(dt, events) {
    const p = this._power();

    // 暴れの出入り。暴れている間は張りが跳ね上がり、取り込みはほぼ止まる
    if (this.burst > 0) {
      this.burst -= dt;
      if (this.burst <= 0) this.burstT = this._burstGap();
    } else {
      this.burstT -= dt;
      if (this.burstT <= 0) {
        this.burst = BURST_LEN;
        events.push('burst');
      }
    }
    const hard = this.burst > 0;

    const reel = REEL_GAIN / p.stamina;   // この魚の巻き上げ速度
    if (this.reeling) {
      this.tension += p.pull * (hard ? p.burstK : 1) * dt;
      this.progress += reel * (hard ? BURST_SLOW : 1) * dt;
    } else {
      this.tension -= RELAX * dt;
      this.progress -= reel * SLIP_K * dt;
    }
    this.tension = Math.max(0, this.tension);
    this.progress = Math.max(0, this.progress);

    if (this.tension >= 1) {
      this.phase = 'lost';
      this.lost = 'snap';   // 糸が切れた
      this.t = 0;
      this.tension = 1;
      events.push('lost');
      return;
    }
    if (this.progress >= 1) {
      this.phase = 'landed';
      this.t = 0;
      this.progress = 1;
      events.push('landed');
    }
  }

  // 画面に出すぶんだけ取り出す(HUD が Fishing の中身を直に読まないように)
  view() {
    return {
      phase: this.phase,
      tension: clamp01(this.tension),
      progress: clamp01(this.progress),
      burst: this.burst > 0,
      // アタリの残り(1→0)。合図の点滅に使う
      hook: this.phase === 'bite' ? clamp01(1 - this.t / HOOK_WINDOW) : 0,
      fish: this.fish,
      cm: this.cm,
      lost: this.lost,
    };
  }
}
