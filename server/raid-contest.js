// 蛮族を射る大会(都市と騎士の島の集まり)。トランスポート非依存。
//
// 浜の物見の櫓に立って、寄せる蛮族船を射る。制限時間のあいだに撃退した
// 点を競う。受付と時間の進行は server/meet-core.js。ここは中身だけ。
//
// **波はサーバーが配る種で決まる。** 各自の端末が Raid(src/minigame/archery.js)を
// 回すので、種を配らないと人によって船の湧きかたが変わり、「そっちは楽な
// 波だった」で腕前の比べようがなくなる。同じ種なら全員が同じ波を迎え撃つ。
//
// 点そのものはクライアントが申告する ── 矢の当たり判定は各自の端末にしか
// 無いため。釣り大会と同じで、友達どうしで遊ぶ前提の「壊れた値よけ」だけ置く:
//   - 点は減らない(申告のたびに上書きするので、取りこぼしても追いつける)
//   - 経過時間あたりの上限で頭を押さえる(桁違いの数字が並ばない)
//   - 力尽きた(over)と申告したら、そこで凍結する

import { MeetCore, RESULT_MS, MIN_PLAYERS } from './meet-core.js';
import { makeRng, rngNext } from '../src/rng.js';
import { placeBy, raidAhead } from '../src/minigame/contest.js';

export { RESULT_MS, MIN_PLAYERS };

// 2分。1波が捌けるのに 15 秒ほどなので、6〜7波ぶん。
export const RAID_MS = 120000;
// 1秒あたりに伸びてよい点の上限。いちばん美味しい船(船3点+蛮族3人)が 6点で、
// 船は 1.7 秒に1隻しか湧かないので、全部沈めても 4点/秒には届かない。
export const MAX_RATE = 6;
// 始めた直後のぶん。1隻目を沈めた瞬間が上限に引っかからないように。
export const RATE_GRACE = 12;

// その回の波を決める種。部屋の種と「何回目か」から作るので、
// 同じ部屋で2回目を開いても同じ波にならない。
export function waveSeed(base, round) {
  let s = makeRng(base);
  for (let i = 0; i < round; i++) [s] = rngNext(s);
  return makeRng(s);
}

export class RaidContest extends MeetCore {
  constructor(opts = {}) {
    super({ ms: RAID_MS, ...opts });
    this.kind = 'raid';
    this.base = 1;        // 部屋の種(room-do が渡す)
    this.seed = 0;        // その回の波の種。始まるまでは 0
    this.startedAt = 0;   // 上限を測る起点
  }

  _score() { return { score: 0, wave: 1, over: false }; }

  // 島の種。room-do が部屋から渡す(サーバーは盤を持たない)
  setSeed(seed) {
    this.base = makeRng(Number(seed) || 1);
  }

  _onStart(now) {
    this.seed = waveSeed(this.base, this.round);
    this.startedAt = now;
  }

  // ---- 点の申告 ----

  // score は「その回のいまの合計」。増分ではなく合計を送ってもらうので、
  // 1通落ちても次の申告で追いつく(矢が当たるたびに送るので落ちやすい)。
  report(seat, { score, wave, over } = {}, now = Date.now()) {
    // 走っていないときの申告は黙って捨てる。**エラーにしない** ── 端末の
    // Raid とサーバーの締め切りは 1 tick ずれるので、最後の1本が当たった
    // 申告がちょうど時間切れとぶつかる。ゴール直前に赤い札が出るのは邪魔。
    if (this.phase !== 'running' || now >= this.endsAt) return { ok: true, quiet: true };
    const s = this.scores.get(seat);
    if (!s) return { error: 'エントリーしていません' };
    if (s.over) return { ok: true, quiet: true };  // 力尽きたあとは伸びない
    if (typeof score !== 'number' || !Number.isFinite(score) || score < 0) {
      return { error: '点が不正です' };
    }
    const elapsed = Math.max(0, now - this.startedAt) / 1000;
    const cap = RATE_GRACE + Math.floor(elapsed * MAX_RATE);
    // 減らさない。取りこぼした申告のあとに古い合計が届いても後戻りしない
    s.score = Math.max(s.score, Math.min(cap, Math.floor(score)));
    if (typeof wave === 'number' && Number.isFinite(wave) && wave > s.wave) {
      s.wave = Math.floor(wave);
    }
    if (over) s.over = true;
    return { ok: true, quiet: true, score: s.score };
  }

  command(seat, what, msg, now = Date.now()) {
    if (what === 'enter') return this.enter(seat, now);
    if (what === 'leave') return this.leave(seat);
    if (what === 'start') return this.start(seat, now);
    if (what === 'report') return this.report(seat, msg, now);
    return { error: `不明な操作: ${what}` };
  }

  // 並べる順は 点 → 波 → 席番号。席番号は「表に並べる順」を決めるだけで、
  // 順位(place)は raidAhead が別に数える ── 点も波も同じなら同率にする。
  rankRows() {
    const rows = [...this.scores.entries()]
      .map(([seat, s]) => ({ seat, score: s.score, wave: s.wave, over: !!s.over }))
      .sort((a, b) => b.score - a.score || b.wave - a.wave || a.seat - b.seat);
    return placeBy(rows, raidAhead);
  }

  // 種を配る。これが無いと全員ばらばらの波を撃つことになる
  _extraView() {
    return { seed: this.seed };
  }

  toJSON() {
    return { ...super.toJSON(), base: this.base, seed: this.seed, startedAt: this.startedAt };
  }

  static fromJSON(o) {
    const c = new RaidContest({ ms: o?.ms ?? RAID_MS })._load(o);
    c.base = makeRng(Number(o?.base) || 1);
    c.seed = Number(o?.seed) || 0;
    c.startedAt = Number(o?.startedAt) || 0;
    return c;
  }
}
