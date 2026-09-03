// ドラゴンから逃げろ(ドラゴンの島の集まり)。トランスポート非依存。
//
// 島の中心から竜が飛び立ち、いちばん近い人を追いかける。捕まったら脱落。
// 制限時間を逃げ切るか、最後のひとりになったら終わり。順位は**生き残った
// 時間**で決める ── 最後まで残った人が1位、同時に捕まったら同率。
//
// **竜を動かすのも、捕まえるのもサーバー。**
// 散策部屋の位置リレー(walk-relay.js)は本来ただの中継で権威を持たないが、
// 鬼ごっこだけは別 ── 竜の位置を各自が計算すると、端末ごとに違う場所に
// 竜がいて「当たった/当たってない」で揉める。全員ぶんの位置は 10回/秒で
// ここに届いているので、竜も判定もここで回して view() で配る。
//
// 竜は**飛んでいる**ので、地形も木も無視してまっすぐ向かう。おかげで
// サーバーは島の形を知らなくてよい(歩ける範囲の判定を持ち込まずに済む)。

import { MeetCore, RESULT_MS, MIN_PLAYERS } from './meet-core.js';
import { WALK_SPEED } from '../src/minigame/motion.js';
import { s as sc } from '../src/minigame/scale.js';
import { placeBy, huntAhead } from '../src/minigame/contest.js';

export { RESULT_MS, MIN_PLAYERS };

// 逃げ切る時間。島の端から端までが 7.3 秒なので、90 秒で十数回ぶん。
export const HUNT_MS = 90000;
// 竜が飛び立つまでの猶予。始めた瞬間に真ん中で捕まると理不尽なので、
// 散らばる時間を与える。
export const GRACE_MS = 4000;
// 竜の速さ。歩きより**遅く**する ── 直線では追いつけないが、こちらは
// 木をよけて曲がるぶん詰められる、という追われ方にしたい。
export const DRAGON_SPEED = WALK_SPEED * 0.82;
// 竜が向きを変える速さ(ラジアン/秒)。曲がりきれないから振り切れる。
const TURN_RATE = 2.2;
// この距離まで詰められたら捕まる。棒人間の太さに合わせる(scale.js)
export const CATCH_R = sc(0.22);
// 狙いを変えるのをためらう距離。目標がころころ変わると、竜が2人の
// 真ん中で震えて誰にも追いつかない。
const SWITCH_MARGIN = sc(0.5);

export class DragonHunt extends MeetCore {
  constructor(opts = {}) {
    super({ ms: HUNT_MS, ...opts });
    this.kind = 'dragonhunt';
    // 竜。x/z は島の座標、a は向き(ラジアン)
    this.dragon = { x: 0, z: 0, a: 0 };
    this.target = null;   // いま狙っている席
    this.at = 0;          // 前に動かした時刻(dt を出すのに使う)
    this.home = { x: 0, z: 0 };  // 飛び立つところ(島の中心)
    this.endedAt = 0;     // 回が終わった時刻。生き残りの記録をここで止める
    this.pos = new Map(); // seat -> { x, z } 最後に届いた位置
  }

  _score(now) { return { caughtAt: 0, startedAt: now }; }

  // 島の中心。room-do が盤から求めて渡す(サーバーは島の形を持たない)
  setHome(x, z) {
    this.home = { x: Number(x) || 0, z: Number(z) || 0 };
  }

  // 位置リレーから毎 tick もらう。[[seat, x, z, ...], ...]
  setPositions(people) {
    this.pos = new Map();
    for (const p of people ?? []) {
      if (!Array.isArray(p) || p.length < 3) continue;
      const [seat, x, z] = p;
      if (!(seat >= 0) || !Number.isFinite(x) || !Number.isFinite(z)) continue;
      this.pos.set(seat, { x, z });
    }
  }

  _onStart(now) {
    this.dragon = { x: this.home.x, z: this.home.z, a: 0 };
    this.target = null;
    this.at = now;
    this.endedAt = 0;
  }

  _onEnd(now) { this.endedAt = now; }

  // まだ捕まっていない席
  aliveSeats() {
    return [...this.scores.entries()].filter(([, s]) => !s.caughtAt).map(([seat]) => seat);
  }

  // 竜を1歩進めて、捕まえたかを見る。
  // 戻り値 true で「時間前に終わり」(最後のひとりになった)。
  _step(now) {
    const dt = Math.min(0.5, Math.max(0, (now - this.at) / 1000));
    this.at = now;
    const alive = this.aliveSeats();
    // ひとり以下になったら終わり。0人は全員同時に捕まった回
    if (alive.length <= 1) return true;
    // 猶予のあいだは中心で羽ばたいて待つ
    if (now < this.endsAt - this.ms + GRACE_MS) return false;

    // 狙いを決める。いまの相手より SWITCH_MARGIN ぶん近い人がいたら乗り換える
    // ── 毎回いちばん近い人にすると、等距離の2人の間で震えて誰も捕まえない。
    const d2 = (seat) => {
      const p = this.pos.get(seat);
      if (!p) return Infinity;
      return Math.hypot(p.x - this.dragon.x, p.z - this.dragon.z);
    };
    const cur = this.target != null && alive.includes(this.target) ? d2(this.target) : Infinity;
    let best = this.target != null && alive.includes(this.target) ? this.target : null;
    for (const seat of alive) {
      if (d2(seat) < cur - SWITCH_MARGIN || best == null) {
        if (d2(seat) < (best == null ? Infinity : d2(best))) best = seat;
      }
    }
    this.target = best;
    const aim = this.target != null ? this.pos.get(this.target) : null;
    if (!aim) return false;   // 位置がまだ届いていない

    // 向きは少しずつしか変えられない。だから曲がって振り切れる。
    const want = Math.atan2(aim.x - this.dragon.x, aim.z - this.dragon.z);
    let diff = want - this.dragon.a;
    while (diff > Math.PI) diff -= Math.PI * 2;
    while (diff < -Math.PI) diff += Math.PI * 2;
    const turn = Math.max(-TURN_RATE * dt, Math.min(TURN_RATE * dt, diff));
    this.dragon.a += turn;
    this.dragon.x += Math.sin(this.dragon.a) * DRAGON_SPEED * dt;
    this.dragon.z += Math.cos(this.dragon.a) * DRAGON_SPEED * dt;

    // 捕まえる。狙っていない人でも、通り道に居れば捕まる
    for (const seat of alive) {
      const p = this.pos.get(seat);
      if (!p) continue;
      if (Math.hypot(p.x - this.dragon.x, p.z - this.dragon.z) <= CATCH_R) {
        this.scores.get(seat).caughtAt = now;
        if (this.target === seat) this.target = null;
      }
    }
    // ここで終了は見ない。ひとりになったかは次の tick の頭で見る
    // (100ms 後。見分けの付かない差なので、判定を2か所に置かない)
    return false;
  }

  command(seat, what, msg, now = Date.now()) {
    if (what === 'enter') return this.enter(seat, now);
    if (what === 'leave') return this.leave(seat);
    if (what === 'start') return this.start(seat, now);
    // 竜のほうは申告するものが無い(サーバーが全部見ている)
    return { error: `不明な操作: ${what}` };
  }

  // 生き残った時間。まだ逃げているなら「いまの時点まで」。
  aliveMs(seat, now) {
    const s = this.scores.get(seat);
    if (!s) return 0;
    // 捕まった人はその時刻、逃げきった人は回が終わった時刻で止める。
    // 止めないと、結果を見せているあいだ記録が伸びて順位が動く。
    const end = s.caughtAt || this.endedAt || Math.min(now, this.endsAt);
    return Math.max(0, end - s.startedAt);
  }

  rankRows(now = Date.now()) {
    const rows = [...this.scores.keys()]
      .map((seat) => ({
        seat,
        ms: this.aliveMs(seat, now),
        alive: !this.scores.get(seat).caughtAt,
      }))
      // 並べる順。逃げきり → 長く生き残った順 → 席の順
      .sort((a, b) => (b.alive ? 1 : 0) - (a.alive ? 1 : 0) || b.ms - a.ms || a.seat - b.seat);
    // 順位の付け方はクライアントと同じものを使う(src/minigame/contest.js)
    return placeBy(rows, huntAhead);
  }

  _extraView() {
    return { dragon: { ...this.dragon }, target: this.target };
  }

  static fromJSON(o) {
    const h = new DragonHunt({ ms: o?.ms ?? HUNT_MS })._load(o);
    if (o?.dragon) h.dragon = { ...o.dragon };
    if (o?.home) h.home = { ...o.home };
    // 狙いも書き戻す。落とすと、読み直した直後だけ竜が狙いを付け直して
    // 不自然に向きを変える(view にも出るので全員に見える)。
    h.target = o?.target ?? null;
    h.at = Number(o?.at) || 0;
    h.endedAt = Number(o?.endedAt) || 0;
    return h;
  }

  toJSON() {
    return {
      ...super.toJSON(),
      dragon: this.dragon, home: this.home, target: this.target, at: this.at,
      endedAt: this.endedAt,
    };
  }
}
