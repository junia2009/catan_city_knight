// 他の人の位置を、届いた飛び飛びの値から滑らかに復元する。
//
// THREE を使わない計算だけ(node --test で検証できるように)。
// 描くのは walk-mode.js。
//
// なぜ補間がいるか:
//   位置は 10 回/秒しか届かない。届いた値をそのまま置くと、60fps の画面では
//   6フレームに1回だけ飛ぶ ── カクカクした紙芝居になる。
//
// やりかた(よくある「エンティティ補間」):
//   届いた値をすぐ使わず、DELAY だけ past に遅らせて描く。こうすると
//   「次の値」がすでに手元にあるので、2点のあいだを滑らかに繋げる。
//   遅れるぶん相手の姿は少し過去だが、カクつくより気にならない。

import { ST } from './remote-st.js';

export { ST };

// どれだけ遅らせて描くか。届く間隔(100ms)より少し長くしておかないと、
// 次の値が間に合わず「補間するものが無い」瞬間ができる。
export const DELAY_MS = 160;
// これだけ更新が無い人は消す(サーバー側の掃除より少し長く待つ)
export const GONE_MS = 5000;
// 補間に使う履歴。少なすぎると途切れ、多すぎても使わない
const KEEP = 8;

const lerp = (a, b, k) => a + (b - a) * k;

// 角度は -π..π を回り込むので、近いほうへ回して混ぜる
export function lerpAngle(a, b, k) {
  let d = (b - a) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  if (d < -Math.PI) d += Math.PI * 2;
  return a + d * k;
}

export class RemoteWalkers {
  // delay: 遅らせる量(ms)。ネットが不安定なら伸ばす
  constructor({ delay = DELAY_MS, gone = GONE_MS } = {}) {
    this.delay = delay;
    this.goneMs = gone;
    this.seats = new Map(); // seat -> { name, look, buf: [{t, x, z, y, f, st, em}] }
  }

  // 名簿(名前とすがた)。位置と違って変わらない値なので、
  // 位置とは別に、届いたときだけ持つ(毎回送るには重い)
  setNames(seats) {
    this.names = new Map();
    this.looks = new Map();
    for (const s of seats ?? []) {
      if (!s) continue;
      if (s.name) this.names.set(s.seat, s.name);
      if (s.look) this.looks.set(s.seat, s.look);
    }
    for (const [seat, e] of this.seats) {
      e.name = this.names.get(seat) ?? e.name;
      e.look = this.looks.get(seat) ?? e.look;
    }
  }

  // サーバーから届いたひとかたまり。
  // people は [[seat, x, z, y, facing, st, emote], ...](emote は無ければ 0)
  push(people, now = Date.now()) {
    for (const row of people ?? []) {
      if (!Array.isArray(row) || row.length < 6) continue;
      const [seat, x, z, y, f, st] = row;
      const em = row[6] ?? 0;
      if (!(seat >= 0)) continue;
      let e = this.seats.get(seat);
      if (!e) {
        e = {
          name: this.names?.get(seat) ?? null,
          look: this.looks?.get(seat) ?? null,
          buf: [],
        };
        this.seats.set(seat, e);
      }
      // 同じ時刻の重複や、順序が入れ替わった古い値は捨てる
      const last = e.buf[e.buf.length - 1];
      if (last && now <= last.t) continue;
      e.buf.push({ t: now, x, z, y, f, st, em });
      if (e.buf.length > KEEP) e.buf.shift();
    }
  }

  // 自分の席は描かない(サーバーは全員ぶんを1通で配るので、ここで外す)
  forget(seat) {
    this.seats.delete(seat);
  }

  clear() {
    this.seats.clear();
  }

  // いま描くべき姿。遅らせた時刻を挟む2点を補間する。
  // 戻り値: [{ seat, name, look, x, z, y, facing, st, emote, speed }]
  sample(now = Date.now()) {
    const at = now - this.delay;
    const out = [];
    for (const [seat, e] of this.seats) {
      const b = e.buf;
      if (!b.length) continue;
      // 更新が途絶えた人は消す
      if (now - b[b.length - 1].t >= this.goneMs) { this.seats.delete(seat); continue; }

      let a = b[0];
      let c = null;
      for (let i = 1; i < b.length; i++) {
        if (b[i].t >= at) { a = b[i - 1]; c = b[i]; break; }
        a = b[i];
      }
      if (!c) {
        // まだ次が来ていない。最後の姿で止める(勝手に進めると行き過ぎる)
        out.push({
          seat, name: e.name, look: e.look, x: a.x, z: a.z, y: a.y, facing: a.f,
          st: a.st, emote: a.em, speed: 0,
        });
        continue;
      }
      const span = c.t - a.t;
      const k = span > 0 ? Math.max(0, Math.min(1, (at - a.t) / span)) : 1;
      const x = lerp(a.x, c.x, k);
      const z = lerp(a.z, c.z, k);
      // その2点から進む速さを出す。歩くアニメーションの速さに使う
      const speed = span > 0 ? Math.hypot(c.x - a.x, c.z - a.z) / (span / 1000) : 0;
      out.push({
        seat,
        name: e.name,
        look: e.look,
        x,
        z,
        y: lerp(a.y, c.y, k),
        facing: lerpAngle(a.f, c.f, k),
        // 状態は混ぜられないので、近いほうを採る
        st: k < 0.5 ? a.st : c.st,
        emote: k < 0.5 ? a.em : c.em,
        speed,
      });
    }
    return out;
  }
}
