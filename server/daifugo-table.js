// 大富豪の卓(基本の島の集まり)。トランスポート非依存。
//
// 円卓を囲んで1回ぶん遊ぶ。受付と時間の器は server/meet-core.js、
// ルールそのものは src/minigame/daifugo.js。ここは両者を繋ぐだけ。
//
// **この卓だけは席ごとに違うものを配る**(perSeat)。手札は隠し情報なので、
// 全員に同じ表を配ると相手の手が丸見えになる。伏せ処理は daifugo.js の
// viewFor に閉じていて、ここはそれを席ごとに呼ぶ。
//
// ほかの集まりと違って、終わりは時間ではなく**決着**で決まる。器は時間で
// 動くので、_step が「決着したら true」を返して早じまいさせている。
// 制限時間のほうは、卓に着いたまま誰も戻ってこない部屋を畳むための保険。

import { MeetCore, RESULT_MS, MIN_PLAYERS } from './meet-core.js';
import { makeRng, rngNext } from '../src/rng.js';
import {
  TITLES, apply, classify, cleanRules, createTable, defaultRules,
  forbiddenFinish, legalPlays, retire, validate, viewFor as tableViewFor,
} from '../src/minigame/daifugo.js';

export { RESULT_MS, MIN_PLAYERS };

// 卓に着いていられる時間の上限(保険)。ふつうは決着で先に終わる
export const TABLE_MS = 30 * 60 * 1000;
// ひとりが考え込んでいてよい時間。過ぎたらサーバーが代わりに打つ
// ── 誰か1人が席を外しただけで、卓の全員が動けなくなるのを防ぐ。
export const AUTO_MS = 45000;

// その回の配りを決める種。部屋の種と「何回目か」から作る
export function dealSeed(base, round) {
  let s = makeRng(base);
  for (let i = 0; i < round; i++) [s] = rngNext(s);
  return makeRng(s);
}

// 席から来る操作の名前 → 卓のアクション
const PLAY_OPS = { play: 'PLAY', pass: 'PASS' };
const PICK_OPS = { exchange: 'EXCHANGE', give: 'GIVE', discard: 'DISCARD' };

export class DaifugoTable extends MeetCore {
  constructor(opts = {}) {
    super({ ms: TABLE_MS, ...opts });
    this.kind = 'daifugo';
    this.base = 1;          // 部屋の種
    this.rules = defaultRules();
    this.hostSeat = -1;     // ルールを選べる人(ゲームマスター)
    this.table = null;      // 進行中の卓(daifugo.js の状態)
    this.titles = null;     // 前の回の称号(カード交換と都落ちに使う)
    this.game = 0;          // 同じ顔ぶれで何回続けたか
    this.actedAt = 0;       // 最後に誰かが打った時刻(放置よけ)
  }

  get perSeat() { return true; }

  // 席の点は卓が持っている。器のほうには何も置かない
  _score() { return {}; }

  setSeed(seed) {
    this.base = makeRng(Number(seed) || 1);
  }

  // ルールを選べる人。**クライアントの言い分ではなく部屋から渡す**
  // (room-do が名簿から取る)。ここを msg から取ると誰でも書き換えられる。
  setHost(seat) {
    this.hostSeat = Number.isInteger(seat) ? seat : -1;
  }

  // ---- 回のはじめと終わり ----

  _onStart(now) {
    const players = [...this.entries].sort((a, b) => a - b);
    // 前の回と同じ顔ぶれのときだけ、称号を持ち越す(カード交換と都落ち)。
    // 誰か入れ替わっていたら仕切り直し ── 居ない人の称号で交換は組めない。
    const same = !!this.titles
      && players.length === Object.keys(this.titles).length
      && players.every((p) => this.titles[p] != null);
    this.game = same ? this.game + 1 : 1;
    this.table = createTable({
      seed: dealSeed(this.base, this.round),
      players,
      rules: this.rules,
      titles: same ? this.titles : null,
      game: this.game,
    });
    this.actedAt = now;
  }

  _onEnd() {
    // 決着した回だけ称号を残す。時間切れで畳んだ回は持ち越さない
    if (this.table?.result) this.titles = { ...this.table.result.titles };
    else this.titles = null;
  }

  // 決着したら時間を待たずに結果へ。放置されていたら代わりに打つ
  _step(now) {
    if (!this.table) return false;
    if (!this.table.result && now - this.actedAt >= AUTO_MS) this.autoPlay(now);
    return !!this.table.result;
  }

  // ---- 席から来る操作 ----

  command(seat, what, msg, now = Date.now()) {
    if (what === 'enter') return this.enter(seat, now);
    if (what === 'leave') return this.leave(seat);
    if (what === 'start') return this.start(seat, now);
    if (what === 'rules') return this.setRules(seat, msg?.rules);
    // 席を立つ。卓が立っている間は leave が効かないので、こちらで抜ける
    // ── 抜けられないと、始まったあと島から出るまで卓に縛られる。
    if (what === 'retire') { this.dropSeat(seat); return { ok: true }; }
    if (PLAY_OPS[what] || what === 'pick') return this.act(seat, what, msg, now);
    return { error: `不明な操作: ${what}` };
  }

  // ルールを入れ替える。**ゲームマスター(ホスト)だけ**、卓が立つ前だけ。
  setRules(seat, rules) {
    if (seat !== this.hostSeat) return { error: 'ルールを決めるのはホストです' };
    if (this.phase === 'running') return { error: '始まってからは変えられません' };
    if (!rules || typeof rules !== 'object') return { error: 'ルールが不正です' };
    this.rules = cleanRules(rules);
    return { ok: true };
  }

  act(seat, what, msg, now) {
    if (this.phase !== 'running' || !this.table) return { error: '卓が立っていません' };
    const action = this.toAction(seat, what, msg);
    if (!action) return { error: 'いま選ぶのは別のものです' };
    const err = validate(this.table, action);
    if (err) return { error: err };
    this.table = apply(structuredClone(this.table), action);
    this.actedAt = now;
    if (this.table.result) this.tick(now);   // 決着したらその場で結果へ
    return { ok: true };
  }

  // 'pick' は待ちの種類から決める。何を選ぶかは卓が知っているので、
  // クライアントに種類を送らせない(食い違うと通らないだけ)。
  toAction(seat, what, msg) {
    const cards = Array.isArray(msg?.cards) ? msg.cards : [];
    if (what === 'pick') {
      const type = PICK_OPS[this.table.awaiting?.type];
      return type ? { type, player: seat, cards } : null;
    }
    const type = PLAY_OPS[what];
    if (type === 'PASS') return { type, player: seat };
    return { type, player: seat, cards };
  }

  // ---- 放置よけ ----

  // 考え込んでいる人の代わりに、いちばん弱い手を打つ。
  // 反則負けになる手だけは避ける(勝手に最下位にされたら理不尽なので)。
  autoPlay(now) {
    const t = this.table;
    const who = t.awaiting ? t.awaiting.player : t.players[t.turn];
    this.actedAt = now;
    if (t.awaiting) {
      const type = PICK_OPS[t.awaiting.type];
      const pick = t.hands[who].slice(0, t.awaiting.count);
      this.table = apply(structuredClone(t), { type, player: who, cards: pick });
      return;
    }
    if (t.field) {
      this.table = apply(structuredClone(t), { type: 'PASS', player: who });
      return;
    }
    const best = weakestPlay(t, who);
    if (!best) return;
    this.table = apply(structuredClone(t), { type: 'PLAY', player: who, cards: best });
  }

  // 席を立った人。卓が立っていれば、その回からは抜けてもらう
  dropSeat(seat) {
    const had = super.dropSeat(seat);
    if (this.table && !this.table.result) {
      this.table = retire(structuredClone(this.table), seat);
      if (this.table.result) this.tick(Date.now());
    }
    return had;
  }

  // ---- 配る中身 ----

  // 順位。決着していれば上がった順、まだなら残り枚数の少ない順。
  rankRows() {
    const t = this.table;
    if (!t) return [];
    if (t.result) {
      const down = new Map(t.demoted.map((d) => [d.player, d.why]));
      return t.result.order.map((seat, i) => ({
        seat, place: i + 1, title: t.result.titles[seat], cards: 0, why: down.get(seat) ?? null,
      }));
    }
    const rank = t.players
      .map((seat) => ({
        seat,
        cards: t.hands[seat].length,
        // 上がった人が上。次に残り枚数の少ない順
        done: t.out.includes(seat) ? t.out.indexOf(seat) : 99,
      }))
      .sort((a, b) => a.done - b.done || a.cards - b.cards || a.seat - b.seat);
    return rank.map((r, i) => ({ ...r, place: i + 1, title: null, why: null }));
  }

  _extraView(now = Date.now()) {
    return {
      rules: { ...this.rules },
      hostSeat: this.hostSeat,
      game: this.game,
      titles: this.titles ? { ...this.titles } : null,
      // 考える時間の残り。0 になるとサーバーが代わりに打つ
      turnRemain: this.table && !this.table.result
        ? Math.max(0, AUTO_MS - (now - this.actedAt))
        : 0,
    };
  }

  // 席ごとの中身。**手札はここでしか渡らない**(daifugo.js の viewFor)
  viewFor(seat, now = Date.now()) {
    return { ...this.view(now), table: this.table ? tableViewFor(this.table, seat) : null };
  }

  toJSON() {
    return {
      ...super.toJSON(),
      base: this.base,
      rules: this.rules,
      table: this.table,
      titles: this.titles,
      game: this.game,
      actedAt: this.actedAt,
    };
  }

  static fromJSON(o) {
    const t = new DaifugoTable({ ms: o?.ms ?? TABLE_MS })._load(o);
    t.base = makeRng(Number(o?.base) || 1);
    t.rules = cleanRules(o?.rules);
    t.table = o?.table ?? null;
    t.titles = cleanTitles(o?.titles);
    t.game = Number(o?.game) || 0;
    t.actedAt = Number(o?.actedAt) || 0;
    return t;
  }
}

// 保存から読み戻す称号。知らない値が入っていたら持ち越さない
// (壊れた称号で交換を組むと、渡す相手が見つからないまま待ちになる)
function cleanTitles(src) {
  if (!src || typeof src !== 'object') return null;
  const out = {};
  for (const [k, v] of Object.entries(src)) {
    if (!TITLES.includes(v)) return null;
    out[k] = v;
  }
  return Object.keys(out).length ? out : null;
}

// いちばん弱い手。反則負けになる手は最後に回す
export function weakestPlay(t, who) {
  const list = legalPlays(t, who);
  if (!list.length) return null;
  const key = (cs) => {
    const play = classify(cs, t.rules);
    const foul = t.hands[who].length === cs.length && forbiddenFinish(t, play, cs) ? 1 : 0;
    return [foul, cs.length, play.rank];
  };
  return list.reduce((best, cs) => {
    const a = key(cs);
    const b = key(best);
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i] < b[i] ? cs : best;
    return best;
  });
}
