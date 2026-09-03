// 島の「歩ける地面」の判定。
//
// THREE を使わない純粋な計算にしてあるので、node --test で検証できる
// (盤の幾何を1つ間違えると、海の上を歩けたり島の真ん中に穴が空いたりする)。

import { LAYOUT } from '../rules/board.js';
import { isLandHex } from '../rules/sea.js';
import { s as sc } from './scale.js';

const TILE_TOP = 0.26; // board3d.js と同じタイル上面の高さ

// ---- 盤の幾何(board3d.js と同じ計算。歩ける範囲の判定に使う)----

// ヘックスの中心。歩ける範囲の判定にも、外から場所を指すのにも使う
export function hexCenter(hid) {
  let x = 0;
  let y = 0;
  for (const vid of LAYOUT.hexVertices[hid]) {
    x += LAYOUT.vertices[vid].x;
    y += LAYOUT.vertices[vid].y;
  }
  return { x: x / 6, y: y / 6 };
}

// 六角形の内接円半径と、辺の法線3本。点がヘックスの中かを厳密に見るのに使う。
function hexMetrics() {
  const hid = LAYOUT.hexIds[0];
  const c = hexCenter(hid);
  const v0 = LAYOUT.vertices[LAYOUT.hexVertices[hid][0]];
  const R = Math.hypot(v0.x - c.x, v0.y - c.y);      // 外接円
  const inR = R * Math.cos(Math.PI / 6);             // 内接円
  const th0 = Math.atan2(v0.y - c.y, v0.x - c.x);
  // 辺の法線は頂点から30°ずらして60°おき。3本見れば足りる(対辺は符号違い)
  const normals = [0, 1, 2].map((k) => {
    const a = th0 + Math.PI / 6 + (k * Math.PI) / 3;
    return { x: Math.cos(a), y: Math.sin(a) };
  });
  return { R, inR, normals };
}

// 歩ける(=陸の)ヘックス。海に踏み出すと落ちる。
function landHexes(state) {
  const land = [];
  for (const hid of state.board.hexIds) {
    if (state.mode === 'sea' && !isLandHex(state.board, hid)) continue;
    land.push({ hid, c: hexCenter(hid) });
  }
  return land;
}

// 歩ける地面の判定を、その対戦の盤から作る。
// 戻り値: (x, z) => { y, ok }
export function makeGround(state) {
  const { R, inR, normals } = hexMetrics();
  const land = landHexes(state);
  const inside = (p, c) => {
    const dx = p.x - c.x;
    const dy = p.y - c.y;
    if (dx * dx + dy * dy > R * R) return false; // 外接円で早く落とす
    return normals.every((n) => Math.abs(dx * n.x + dy * n.y) <= inR + 1e-6);
  };
  return (x, z) => {
    const p = { x, y: z };
    for (const t of land) {
      if (inside(p, t.c)) return { y: TILE_TOP, ok: true, hexId: t.hid };
    }
    return { y: TILE_TOP, ok: false, hexId: null };
  };
}

// ---- 島の中心の受付 ----
//
// 見た目は desk.js(THREE を使う)だが、**寸法はここに置く**。
// 降り立つ輪との前後関係がこのファイルの中で完結して、テストからも読める
// (desk.js を import すると three が要るので、CI のテストから触れない)。
export const DESK_RADIUS = sc(0.2);  // ぶつかる大きさ
// この距離まで近づいたらエントリーできる
export const DESK_REACH = sc(0.5);
// 受付のまわりを片付ける広さ(木も岩も無い広場にする)。
// **降り立つ輪(0.62)より広く**取ること ── 輪の上に木が残っていると、
// そこに降りた人が最初から木に埋まる。
export const DESK_CLEAR = sc(0.95);

// 席ごとに散らす輪の半径。人まわりの長さなので縮尺を掛ける(scale.js)。
// **受付の手の届く範囲(DESK_REACH)より外に出すこと** ── でないと、
// 島に降りた瞬間から受付のパネルが開きっぱなしになる。
// 両方に同じ縮尺が掛かるので、この前後関係は縮尺を変えても保たれる。
const SPAWN_RING = sc(0.62);
// 散策部屋の席数。輪を何等分するか。
const SPAWN_SEATS = 8;

// 島のどこから歩き始めるか(陸のヘックスの中心で、いちばん中央寄り)。
//
// seat を渡すと、その席のぶんだけ輪の上にずらす。散策部屋では全員が
// 同じ一点に立つと、名札だけが重なって「誰も居ないのに名前がある」ように
// 見えるので、入った時点で少し離しておく。
// ずらした先が海なら中心のまま(小さい島で輪がはみ出すことがある)。
export function spawnPoint(state, seat = null) {
  let best = null;
  for (const { c } of landHexes(state)) {
    const d = Math.hypot(c.x, c.y);
    if (!best || d < best.d) best = { d, c };
  }
  const c = best ? best.c : { x: 0, y: 0 };
  if (seat == null) return c;
  const a = (seat % SPAWN_SEATS) * ((Math.PI * 2) / SPAWN_SEATS);
  const p = { x: c.x + Math.cos(a) * SPAWN_RING, y: c.y + Math.sin(a) * SPAWN_RING };
  return makeGround(state)(p.x, p.y).ok ? p : c;
}

// ---- 竜の棲む山 ----

// ドラゴンの島で、竜が棲んでいるヘックスの中心。
//
// 場所を決めているのは対戦のルール(rules/dragon.js の dragonNestHex ──
// いちばん出目のいい山)。散策でもそこに竜が居るし、大会が始まればそこから
// 飛び立つ。**受付(島の中心)とは別**で、こちらは「島の住人の居場所」。
//
// サーバーもクライアントもこの1本を通すこと ── 別々に求めると、
// 画面では山に居る竜が、当たり判定では広場から飛んでくることになる。
// 竜の居ない島では null。
export function nestPoint(state) {
  const hid = state?.dragon?.nestHex;
  if (hid == null) return null;
  const c = hexCenter(hid);
  return { x: c.x, y: c.y };
}

// 大会の「主」がどこから現れるか(いまは竜だけ)。
// 住んでいる場所があればそこ、無ければ島の中心。サーバーの primeMeet が
// ここを通す ── 分岐を Durable Object の中に置くとテストから触れない。
export function meetHome(state) {
  return nestPoint(state) ?? spawnPoint(state);
}

// ---- 釣り場(港)----

// 縁のちょうど上に立たせると、わずかな行き過ぎで海に落ちる。少しだけ陸側に置く。
// 「行き過ぎ」は歩幅の話なので縮尺を掛ける。
const STAND_BACK = sc(0.14);
// 港の看板は辺の中点の沖側に立っている。中点に立つと看板が正面をふさいで
// 浮きも糸も見えないので、岸に沿って横へずらして「桟橋のわき」に立たせる。
// よけたい相手の看板も、島を歩く間は一緒に小さくしてある(walk-mode.js)ので、
// このずれ幅も縮尺を掛ける ── 掛けないと、桟橋から離れて立ちすぎて、
// 釣りのカメラに浮きが入らなくなる(実際そうなっていた)。
const STAND_SIDE = sc(0.42);
// この距離まで近づくと釣れる。港の看板が目印になるので広くしすぎない。
// 「どこまで近づいたか」は人の側の話なので縮尺を掛ける ── 掛けないと、
// 小さくなったぶんだけ範囲が相対的に広がって、狙わずとも竿が出てしまう。
export const SPOT_RADIUS = sc(0.42);

// 港の桟橋ぎわの「釣り場」。盤の港(海岸の辺)から作る。
// 戻り値の out* は沖へ向かう向き ── 立つ向きと、浮きを落とす先に使う。
export function fishingSpots(state) {
  const land = new Map(landHexes(state).map((t) => [t.hid, t.c]));
  const ground = makeGround(state);
  const walkable = (x, z) => ground(x, z).ok;
  const spots = [];
  for (const port of state.board.ports ?? []) {
    const e = LAYOUT.edges[port.edgeId];
    if (!e) continue;
    // 辺の両隣のうち陸のほう。そこから辺の中点へ向かう向きが「沖」。
    // 盤の中心からの向きで代用すると、島が複数ある航海者たちで破綻する。
    const c = e.hexes.map((hid) => land.get(hid)).find(Boolean);
    if (!c) continue;
    const dx = e.x - c.x;
    const dz = e.y - c.y;
    const len = Math.hypot(dx, dz) || 1;
    const outX = dx / len;
    const outZ = dz / len;
    // 岸に沿った向き(沖の向きを 90° 回したもの)
    const sideX = outZ;
    const sideZ = -outX;
    const base = {
      x: c.x + outX * (len - STAND_BACK),
      z: c.y + outZ * (len - STAND_BACK),
    };
    // 左右どちらへずらすかは、ずらした先の正面がちゃんと海になるほうを採る
    // (辺の端では、斜め隣のヘックスが陸のことがある)
    let stand = { ...base, side: 0 };
    for (const s of [1, -1]) {
      const q = {
        x: base.x + sideX * STAND_SIDE * s,
        z: base.z + sideZ * STAND_SIDE * s,
      };
      if (walkable(q.x, q.z) && !walkable(q.x + outX * 0.4, q.z + outZ * 0.4)) {
        stand = { ...q, side: s };
        break;
      }
    }
    // side は「桟橋のどちら側に立ったか」。カメラは同じ側から撮る
    // (反対側から撮ると、看板が本人と浮きのあいだに入る)。
    spots.push({ edgeId: port.edgeId, type: port.type, ...stand, outX, outZ });
  }
  return spots;
}

// いま立っている場所からいちばん近い釣り場(範囲外なら null)
export function spotNear(spots, x, z, r = SPOT_RADIUS) {
  let best = null;
  for (const s of spots) {
    const d = Math.hypot(s.x - x, s.z - z);
    if (d <= r && (!best || d < best.d)) best = { d, spot: s };
  }
  return best ? best.spot : null;
}

