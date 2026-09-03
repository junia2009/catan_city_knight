// 釣り大会(漁師たちの島の集まり)。トランスポート非依存。
//
// 受付でエントリーして、制限時間のあいだに釣った魚の「合計の長さ」を競う。
// 受付と時間の進行は server/meet-core.js。ここは釣り大会の中身だけ。
//
// ただし**釣果そのものはクライアントが申告する**。魚の抽選と勝負は各自の
// 端末で回っていて(fishing.js)、サーバーは盤面を持っていないため。
// 友達どうしで遊ぶ前提なので、ここは「壊れた値を弾く」までにしてある:
//   - 1匹の長さに上限(いちばん大きい魚より大きい値は切る)
//   - 釣り上げの最短間隔(投げて待って上げるより速くは入らない)
// これで、バグや連打で桁違いの数字が並ぶことは防げる。

import { MeetCore, RESULT_MS, MIN_PLAYERS } from './meet-core.js';
import { placeOf } from '../src/minigame/contest.js';

export { RESULT_MS, MIN_PLAYERS };

// 3分。短いと1匹も釣れずに終わり、長いと中だるみする。
export const CONTEST_MS = 180000;
// 1匹の長さの上限。いちばん大きい魚(ダイオウイカ 700cm)に合わせる
export const MAX_CM = 700;
// 釣り上げの最短間隔。投げる→待つ→上げるで、どんなに速くてもこれはかかる
export const MIN_GAP_MS = 3000;

export class FishingContest extends MeetCore {
  constructor(opts = {}) {
    super({ ms: CONTEST_MS, ...opts });
    this.kind = 'fishing';
  }

  _score() { return { cm: 0, count: 0, best: 0, at: 0 }; }

  // ---- 釣果の申告 ----

  // cm は釣った魚の長さ。ガラクタ(長ぐつ・海そう)は 0 で送ってもらう。
  land(seat, cm, now = Date.now()) {
    if (this.phase !== 'running') return { error: '大会中ではありません' };
    const s = this.scores.get(seat);
    if (!s) return { error: 'エントリーしていません' };
    if (now >= this.endsAt) return { error: '時間切れです' };
    // 速すぎる申告は捨てる(壊れた値・連打よけ)
    if (s.at && now - s.at < MIN_GAP_MS) return { error: '早すぎます' };
    // 数値そのものだけを受ける。Number(null) は 0 になるので、
    // 「ガラクタの 0cm」と「壊れた値」が区別できなくなる。
    if (typeof cm !== 'number' || !Number.isFinite(cm) || cm < 0) {
      return { error: '長さが不正です' };
    }
    const v = Math.min(MAX_CM, Math.round(cm));
    s.cm += v;
    s.count += 1;
    s.best = Math.max(s.best, v);
    s.at = now;
    return { ok: true, cm: v, total: s.cm };
  }

  // 席から来る操作。room-do は中身を知らずにここへ渡す。
  command(seat, what, msg, now = Date.now()) {
    if (what === 'enter') return this.enter(seat, now);
    if (what === 'leave') return this.leave(seat);
    if (what === 'start') return this.start(seat, now);
    if (what === 'land') return this.land(seat, msg?.cm, now);
    return { error: `不明な操作: ${what}` };
  }

  // 並べる順は 合計 → 大物 → 席番号。席番号は「表に並べる順」を決めるだけで、
  // 順位(place)は placeOf が別に数える ── 合計も大物も同じなら同率にする。
  rankRows() {
    const sorted = [...this.scores.entries()]
      .map(([seat, s]) => ({ seat, cm: s.cm, count: s.count, best: s.best }))
      .sort((a, b) => b.cm - a.cm || b.best - a.best || a.seat - b.seat);
    return placeOf(sorted);
  }

  static fromJSON(o) {
    return new FishingContest({ ms: o?.ms ?? CONTEST_MS })._load(o);
  }
}
