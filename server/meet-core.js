// 散策部屋の「集まり」の進行の器。
//
// 島ごとに何が開かれるかは src/minigame/meets.js の表で決まり、その中身
// (釣り大会・ドラゴンから逃げろ…)がこれを継承する。
//
// **進行はサーバーが持つ。** 締め切りや順位をクライアントに任せると、
// 端末の時計のずれや切断で食い違って「どっちが勝ったか」で揉める。
// ここが決めた view() を全員に配れば、全員が同じ表を見る。
//
// 器が持つのは受付と時間だけ:
//   idle → (誰か入る) entry → (誰かが始める) running → (時間切れ) result → …
// 得点の中身と順位の付け方は、継承したほうが _score / rankRows で決める。

const PHASES = ['idle', 'entry', 'running', 'result'];

// 結果を見せている時間。過ぎたら受付に戻る
export const RESULT_MS = 25000;
// 開始に必要な人数(ひとりでは成立しない)
export const MIN_PLAYERS = 2;

export class MeetCore {
  constructor({ ms, resultMs = RESULT_MS, minPlayers = MIN_PLAYERS } = {}) {
    this.ms = ms;
    this.resultMs = resultMs;
    this.minPlayers = minPlayers;
    this.phase = 'idle';
    this.entries = new Set();          // エントリーした席
    this.scores = new Map();           // seat -> 継承先が決める中身
    this.endsAt = 0;                   // running/result の締め切り
    this.round = 0;                    // 何回目か(画面の作り直しの合図)
  }

  get running() { return this.phase === 'running'; }

  // ---- 受付 ----

  enter(seat, now = Date.now()) {
    if (!(seat >= 0)) return { error: '席がありません' };
    // 結果を見ている最中に入ったら、次の回の受付を始める
    if (this.phase === 'result') this._toEntry();
    if (this.phase === 'running') return { error: 'いま開催中です' };
    this.entries.add(seat);
    this.phase = 'entry';
    return { ok: true };
  }

  leave(seat) {
    if (this.phase === 'running') return { error: '開催中は取り消せません' };
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
    for (const s of this.entries) this.scores.set(s, this._score(now));
    this._onStart?.(now);
    return { ok: true };
  }

  // ---- 時間 ----

  // 時間切れなら結果へ、結果を見せ終わったら受付へ。
  // 何か変わったら true(配り直す合図)。
  tick(now = Date.now()) {
    if (this.phase === 'running') {
      // 継承先が「時間前に終わらせたい」ときは true を返す(最後のひとり等)
      const early = this._step?.(now) === true;
      if (early || now >= this.endsAt) {
        this.phase = 'result';
        // 締め切りを結果の表示時間で上書きするので、**先に**終わった時刻を
        // 継承先へ渡す ── 渡さないと、結果を見せている 25 秒のあいだ
        // 「まだ生きている人」の記録が伸び続けて、順位が動く。
        this._onEnd?.(now);
        this.endsAt = now + this.resultMs;
        return true;
      }
      return false;
    }
    if (this.phase === 'result' && now >= this.endsAt) {
      this.phase = this.entries.size ? 'entry' : 'idle';
      return true;
    }
    return false;
  }

  // 部屋から抜けた人。開催中でも点は残さない(居ない人が優勝すると変)
  dropSeat(seat) {
    // || で繋ぐと短絡して、席は消えても点が残る(実際そうなっていた)
    const inEntries = this.entries.delete(seat);
    const inScores = this.scores.delete(seat);
    if (!inEntries && !inScores) return false;
    if (this.phase === 'entry' && this.entries.size === 0) this.phase = 'idle';
    // 全員抜けたら流れる
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

  // **席ごとに違うものを配る遊び**(手札を伏せる大富豪)だけが、
  // perSeat を立てて viewFor を上書きする。既定は全員に同じものなので、
  // 配る側(room-do)は1通だけ作って全員へ送れる。
  get perSeat() { return false; }

  viewFor(seat, now = Date.now()) {
    return this.view(now);
  }

  // 残り時間は「ミリ秒」で配る。締め切りの時刻を配ると、端末の時計が
  // ずれている人だけ違う残り時間を見ることになる。
  view(now = Date.now()) {
    return {
      kind: this.kind,
      phase: this.phase,
      round: this.round,
      entries: [...this.entries].sort((a, b) => a - b),
      remain: this.endsAt ? Math.max(0, this.endsAt - now) : 0,
      total: this.ms,
      minPlayers: this.minPlayers,
      rank: this.rankRows(now),
      ...(this._extraView?.(now) ?? {}),
    };
  }

  toJSON() {
    return {
      kind: this.kind,
      phase: this.phase,
      round: this.round,
      entries: [...this.entries],
      endsAt: this.endsAt,
      scores: [...this.scores.entries()],
      ms: this.ms,
    };
  }

  // 継承先の static fromJSON から呼ぶ。器のぶんだけ書き戻す。
  _load(o) {
    if (!o) return this;
    this.phase = PHASES.includes(o.phase) ? o.phase : 'idle';
    this.round = Number(o.round) || 0;
    this.entries = new Set(o.entries ?? []);
    this.endsAt = Number(o.endsAt) || 0;
    this.scores = new Map(o.scores ?? []);
    return this;
  }
}
