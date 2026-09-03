// 釣り大会(散策部屋のミニゲーム)。トランスポート非依存。
//
// 島の中心の受付でエントリーして、制限時間のあいだに釣った魚の
// 「合計の長さ」を競う。
//
// **進行はサーバーが持つ。** 締め切りや順位をクライアントに任せると、
// 端末の時計のずれや切断で食い違って「どっちが勝ったか」で揉める。
// ここが決めた view() を全員に配れば、全員が同じ表を見る。
//
// ただし**釣果そのものはクライアントが申告する**。魚の抽選と勝負は各自の
// 端末で回っていて(fishing.js)、サーバーは盤面を持っていないため。
// 友達どうしで遊ぶ前提なので、ここは「壊れた値を弾く」までにしてある:
//   - 1匹の長さに上限(いちばん大きい魚より大きい値は切る)
//   - 釣り上げの最短間隔(投げて待って上げるより速くは入らない)
// これで、バグや連打で桁違いの数字が並ぶことは防げる。

// 順位づけはクライアントと同じものを使う(src/minigame/contest.js)。
// 別々に数えると、表に出る「2位」と実績の判定がずれる。
import { placeOf } from '../src/minigame/contest.js';

// 3分。短いと1匹も釣れずに終わり、長いと中だるみする。
export const CONTEST_MS = 180000;
// 結果を見せている時間。過ぎたら受付に戻る
export const RESULT_MS = 25000;
// 開始に必要な人数(ひとりで大会は成立しない)
export const MIN_PLAYERS = 2;
// 1匹の長さの上限。いちばん大きい魚(ダイオウイカ 700cm)に合わせる
export const MAX_CM = 700;
// 釣り上げの最短間隔。投げる→待つ→上げるで、どんなに速くてもこれはかかる
export const MIN_GAP_MS = 3000;

const PHASES = ['idle', 'entry', 'running', 'result'];

export class FishingContest {
  constructor({ ms = CONTEST_MS, resultMs = RESULT_MS, minPlayers = MIN_PLAYERS } = {}) {
    this.ms = ms;
    this.resultMs = resultMs;
    this.minPlayers = minPlayers;
    this.phase = 'idle';
    this.entries = new Set();          // エントリーした席
    this.scores = new Map();           // seat -> { cm, count, best, at }
    this.endsAt = 0;                   // running/result の締め切り
    this.round = 0;                    // 何回目の大会か(画面の作り直しの合図)
  }

  get running() { return this.phase === 'running'; }

  // ---- 受付 ----

  enter(seat, now = Date.now()) {
    if (!(seat >= 0)) return { error: '席がありません' };
    // 結果を見ている最中に入ったら、次の回の受付を始める
    if (this.phase === 'result') this._toEntry();
    if (this.phase === 'running') return { error: 'いま大会中です' };
    this.entries.add(seat);
    this.phase = 'entry';
    return { ok: true };
  }

  leave(seat) {
    if (this.phase === 'running') return { error: '大会中は取り消せません' };
    this.entries.delete(seat);
    if (this.entries.size === 0 && this.phase === 'entry') this.phase = 'idle';
    return { ok: true };
  }

  // エントリーした人なら誰でも始められる(ホストを待たない)
  start(seat, now = Date.now()) {
    if (this.phase !== 'entry') return { error: 'いま始められません' };
    if (!this.entries.has(seat)) return { error: 'エントリーしていません' };
    if (this.entries.size < this.minPlayers) {
      return { error: `${this.minPlayers}人からです` };
    }
    this.phase = 'running';
    this.round += 1;
    this.endsAt = now + this.ms;
    this.scores = new Map();
    for (const s of this.entries) this.scores.set(s, { cm: 0, count: 0, best: 0, at: 0 });
    return { ok: true };
  }

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

  // ---- 時間 ----

  // 時間切れなら結果へ、結果を見せ終わったら受付へ。
  // 何か変わったら true(配り直す合図)。
  tick(now = Date.now()) {
    if (this.phase === 'running' && now >= this.endsAt) {
      this.phase = 'result';
      this.endsAt = now + this.resultMs;
      return true;
    }
    if (this.phase === 'result' && now >= this.endsAt) {
      this.phase = this.entries.size ? 'entry' : 'idle';
      return true;
    }
    return false;
  }

  // 部屋から抜けた人。大会中でも点は残さない(居ない人が優勝すると変)
  dropSeat(seat) {
    // || で繋ぐと短絡して、席は消えても点が残る(実際そうなっていた)
    const inEntries = this.entries.delete(seat);
    const inScores = this.scores.delete(seat);
    if (!inEntries && !inScores) return false;
    if (this.phase === 'entry' && this.entries.size === 0) this.phase = 'idle';
    // 全員抜けたら大会は流れる
    if (this.phase === 'running' && this.scores.size === 0) {
      this.phase = 'idle';
      this.endsAt = 0;
    }
    return true;
  }

  _toEntry() {
    this.phase = 'entry';
    this.entries = new Set();
    this.scores = new Map();
    this.endsAt = 0;
  }

  // ---- 配る中身 ----

  // 残り時間は「ミリ秒」で配る。締め切りの時刻を配ると、端末の時計が
  // ずれている人だけ違う残り時間を見ることになる。
  view(now = Date.now()) {
    // 並べる順は 合計 → 大物 → 席番号。席番号は「表に並べる順」を決めるだけで、
    // 順位(place)は placeOf が別に数える ── 合計も大物も同じなら同率にする。
    const sorted = [...this.scores.entries()]
      .map(([seat, s]) => ({ seat, cm: s.cm, count: s.count, best: s.best }))
      .sort((a, b) => b.cm - a.cm || b.best - a.best || a.seat - b.seat);
    const rank = placeOf(sorted);
    return {
      phase: this.phase,
      round: this.round,
      entries: [...this.entries].sort((a, b) => a - b),
      remain: this.endsAt ? Math.max(0, this.endsAt - now) : 0,
      total: this.ms,
      minPlayers: this.minPlayers,
      rank,
    };
  }

  toJSON() {
    return {
      phase: this.phase,
      round: this.round,
      entries: [...this.entries],
      endsAt: this.endsAt,
      scores: [...this.scores.entries()],
      ms: this.ms,
    };
  }

  static fromJSON(o) {
    const c = new FishingContest({ ms: o?.ms ?? CONTEST_MS });
    if (!o) return c;
    c.phase = PHASES.includes(o.phase) ? o.phase : 'idle';
    c.round = Number(o.round) || 0;
    c.entries = new Set(o.entries ?? []);
    c.endsAt = Number(o.endsAt) || 0;
    c.scores = new Map(o.scores ?? []);
    return c;
  }
}
