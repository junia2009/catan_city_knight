// 盤の上に置かれた物(木・山・サボテン・盗賊・建物・港の看板…)の当たり判定。
//
// 形はどれも「上から見ればだいたい丸」なので、円で近似して押し出す。
// ここも THREE を使わない ── 障害物は {x, z, r} の素の配列で受け取り、
// 実際に何が置いてあるかを拾うのは walk-mode.js の仕事。

import { s as sc } from './scale.js';

export const WALKER_RADIUS = sc(0.10); // 棒人間の太さ(肩幅ぶん。scale.js)

// ある点のまわりを片付ける。{ kept, cleared } を返す。
//
// 受付のまわりに使う。**木や岩は盤の寸法で、棒人間を縮めても縮まない**ので、
// 中心に受付を建てると、寄れる隙間(受付の縁〜手の届く距離)が木で埋まって
// 誰も受付にたどり着けなくなる ── 実際そうなっていた。
// 受付は「木を片付けた広場」に立っている、という扱いにする。
export function clearAround(obstacles, at, r) {
  const kept = [];
  const cleared = [];
  for (const o of obstacles) {
    (Math.hypot(o.x - at.x, o.z - at.z) <= r ? cleared : kept).push(o);
  }
  return { kept, cleared };
}

// 押し出しの繰り返し回数。木が2本並んだ隙間などで、
// 1回の押し出しが別の物にめり込むことがあるので数回ならす。
const PASSES = 3;

// 障害物の一覧から「めり込みを直す関数」を作る。
// 一覧の各要素は { x, z, r, h }。h は「タイル上面からの高さ」(省略可)。
//
// resolve(fromX, fromZ, toX, toZ, selfR, feetY) → { x, z, hit }
//   hit が false なら、行き先はどこにも触れていない(そのまま進んでよい)。
//   feetY は足の高さ。それより低い物は跳び越えたことにして無視する。
//
// 位置を押し出すだけなので、1フレームの移動量が障害物の直径より
// 大きいとすり抜ける。歩く速さは 1.9 タイル/秒・刻みは最大 0.05 秒なので
// 1フレーム 0.095 タイル、いちばん小さい障害物でも直径 0.38 タイルあり、
// この使い方では起こらない(test/minigame.test.js で押さえている)。
export function makeBlocker(list) {
  const obs = list.filter((o) => o.r > 0);
  if (obs.length === 0) return () => ({ hit: false });

  return (fromX, fromZ, toX, toZ, selfR = WALKER_RADIUS, feetY = 0) => {
    // 足より低い物は跳び越えている最中なので、当たらない
    const here = feetY > 0 ? obs.filter((o) => (o.h ?? Infinity) > feetY) : obs;
    if (here.length === 0) return { x: toX, z: toZ, hit: false };

    let x = toX;
    let z = toZ;
    let hit = false;

    for (let pass = 0; pass < PASSES; pass++) {
      let moved = false;
      for (const o of here) {
        const need = o.r + selfR;
        let dx = x - o.x;
        let dz = z - o.z;
        let d = Math.hypot(dx, dz);
        if (d >= need) continue;
        if (d < 1e-6) {
          // 中心にぴったり重なったら、来た方向へ戻す(向きが決まらないため)
          dx = fromX - o.x;
          dz = fromZ - o.z;
          d = Math.hypot(dx, dz);
          if (d < 1e-6) { dx = 1; dz = 0; d = 1; }
        }
        x = o.x + (dx / d) * need;
        z = o.z + (dz / d) * need;
        hit = true;
        moved = true;
      }
      if (!moved) break;
    }

    if (!hit) return { x, z, hit: false };

    // 押し出しきれない場所がある ── 木が2本近すぎて、間に立てる余地が
    // どこにも無い場合など。そこへは入れず、来た場所に留める。
    if (overlaps(here, x, z, selfR)) {
      if (!overlaps(here, fromX, fromZ, selfR)) return { x: fromX, z: fromZ, hit: true };
      // 元の場所も重なっている(湧いた位置が物の中など)。
      // 留まると永久に抜けられないので、押し出した先へ進める。
    }
    return { x, z, hit: true };
  };
}

function overlaps(obs, x, z, selfR) {
  for (const o of obs) {
    const need = o.r + selfR;
    if ((x - o.x) ** 2 + (z - o.z) ** 2 < need * need - 1e-9) return true;
  }
  return false;
}

// ぶつかった面に沿って滑らせる(壁に向かう成分だけ speed を殺す)。
// これをやらないと、木に向かって歩き続けたときに velocity だけが
// 溜まっていき、離れた瞬間に飛び出す。
export function slideVelocity(vel, nx, nz) {
  const into = vel.x * nx + vel.z * nz;
  if (into >= 0) return;
  vel.x -= nx * into;
  vel.z -= nz * into;
}
