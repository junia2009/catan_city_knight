// 散策部屋の位置リレー(トランスポート非依存)。
//
// 対戦(room-core.js)と違い、ここに権威は無い。各自が自分の体を動かし、
// サーバーは「いま誰がどこにいるか」を配るだけ。判定をサーバーに寄せても
// 得るものが無いうえ、通信が増えるだけなので持たせない。
//
// **絶対に保存しない。** 位置は次の瞬間には古くなる値で、Durable Object の
// storage に書くと遅くて高いだけになる。落ちたら消えてよい。
//
// 「状態」の意味はクライアントと共有する(src/minigame/remote-st.js)。
//
// 通信量の設計:
//   - 受け取ったものを即転送すると N人 → N×N 通になるので、
//     溜めておいて一定間隔(TICK_MS)で「全員ぶん1通」にして配る。
//   - 中身は数値の配列にする。名前や席は変わらないので毎回送らない。

import { ST_MAX } from '../src/minigame/remote-st.js';

// 配る間隔。短くすると滑らかになるが、そのぶん通信が増える。
export const TICK_MS = 100;
// これだけ音沙汰が無い人は居ないものとして落とす(切断の取りこぼし対策)
export const STALE_MS = 4000;
// 1人ぶんの位置。[x, z, y, 向き, 状態]
export const POS_LENGTH = 5;

// 島の外の値が来ても壊れないように、常識的な範囲に丸める。
// クライアントは信用しない ── 壊れた値が全員に配られると全員の画面が壊れる。
const LIMIT = { x: 12, z: 12, y: 4 };

function clean(p) {
  if (!Array.isArray(p) || p.length < POS_LENGTH) return null;
  const n = (v, lim) => {
    const x = Number(v);
    if (!Number.isFinite(x)) return null;
    return Math.round(Math.max(-lim, Math.min(lim, x)) * 100) / 100;
  };
  const x = n(p[0], LIMIT.x);
  const z = n(p[1], LIMIT.z);
  const y = n(p[2], LIMIT.y);
  const f = n(p[3], Math.PI * 2);
  if (x == null || z == null || y == null || f == null) return null;
  const st = Math.max(0, Math.min(ST_MAX, Math.round(Number(p[4]) || 0)));
  return [x, z, y, f, st];
}

export class WalkRelay {
  constructor() {
    this.people = new Map(); // clientId -> { seat, p, at }
  }

  get size() { return this.people.size; }

  // 位置を受け取る。壊れた値なら何もしない(その人は前の位置のまま)。
  set(clientId, seat, p, now = Date.now()) {
    const pos = clean(p);
    if (!clientId || pos == null || !(seat >= 0)) return false;
    this.people.set(clientId, { seat, p: pos, at: now });
    return true;
  }

  drop(clientId) {
    return this.people.delete(clientId);
  }

  clear() {
    this.people.clear();
  }

  // 古くなった人を落とす。落とした人数を返す。
  sweep(now = Date.now(), stale = STALE_MS) {
    let n = 0;
    for (const [id, e] of this.people) {
      if (now - e.at >= stale) { this.people.delete(id); n++; }
    }
    return n;
  }

  // 配る中身。誰宛でも同じものを1通作って全員へ送る
  // (宛先ごとに自分を抜くと、人数ぶん作り直すことになる。
  //  受け取った側が自分の席を飛ばすほうが安い)。
  snapshot(now = Date.now(), stale = STALE_MS) {
    this.sweep(now, stale);
    const people = [];
    for (const e of this.people.values()) people.push([e.seat, ...e.p]);
    // 席の順に並べる(毎回同じ順で届いたほうが、受け取る側が楽)
    people.sort((a, b) => a[0] - b[0]);
    return people;
  }
}
