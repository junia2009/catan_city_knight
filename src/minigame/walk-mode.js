// 「島を歩く」モード。
//
// 対戦用に作った島(Board3D のシーン)にそのまま相乗りする。海も空も木も港も
// すでにあるので、足すのは棒人間・追従カメラ・操作だけ。
// レンダラーと requestAnimationFrame は Board3D のものを使う
// (WebGL コンテキストを2つ持つとモバイルで重すぎるため)。

import * as THREE from 'three';
import {
  makeGround, spawnPoint, fishingSpots, spotNear, hexCenter, nestPoint, nestHexOf,
  watchPost, POST_RADIUS, POST_CLEAR, DESK_RADIUS, DESK_REACH, DESK_CLEAR,
  TABLE_RADIUS, TABLE_CLEAR, tableSeats,
} from './ground.js';
import { Raid, ARCHERY_MODES, BOW_Y, reach as arrowReach } from './archery.js';
import { ArcheryFx } from './archery-fx.js';
import { makeBlocker, clearAround } from './obstacles.js';
import { MAX_DT, SINK_DEPTH, WATER_Y } from './motion.js';
import { Walker, WALK_SPEED } from './walker.js';
import { WaterFx } from './water-fx.js';
import { Fishing, CAST_TIME } from './fishing.js';
import { FishingFx } from './fishing-fx.js';
import { RemoteWalkers } from './remote.js';
import { RemoteView, WALK_COLORS } from './remote-view.js';
import { ST, WALK_SEATS } from './remote-st.js';
import { emoteById } from './emote.js';
import { speciesById, DEFAULT_SPECIES } from './species.js';
import { makeDesk } from './desk.js';
import { meetFor } from './meets.js';
import { makeTable } from './table.js';
import { makeDragon } from '../render3d/board3d.js';
import { WALK_SCALE, s as sc } from './scale.js';

// シーンから外した物の後片付け。持ち物を辿って全部捨てる
function disposeTree(root) {
  root.traverse((o) => {
    o.geometry?.dispose?.();
    if (o.material) {
      (Array.isArray(o.material) ? o.material : [o.material]).forEach((m) => m.dispose?.());
    }
  });
}

// フレームレートに依らない追従係数。
// dt を直に掛けると、低フレームでは 1 を超えて「瞬間移動」になる。
function smooth(rate, dt) {
  return 1 - Math.exp(-rate * dt);
}

// 暗転は沈みきる手前から。早くから暗くすると、せっかくの水中が見えない。
const VEIL_FROM = 0.72; // 沈む深さのこの割合を過ぎたら暗くしはじめる
function sinkVeil(depth) {
  const total = WATER_Y - SINK_DEPTH;
  const k = (depth / total - VEIL_FROM) / (1 - VEIL_FROM);
  return Math.max(0, Math.min(1, k));
}

const TILE_TOP = 0.26;      // board3d.js と同じタイル上面の高さ
const SEA_Y = 0.02;         // board3d.js と同じ水面の高さ

const lerp = (a, b, k) => a + (b - a) * k;

// 巣で眠る竜の翼(makeDragon の肩と手首。左右対称なので y と z は片側ぶん)。
//   x    … 膜面のひねり(-π/2 で水平に広がる)
//   y    … 後退角。畳むときは大きく引いて、翼を頭より後ろへ回す
//          (前に残ると、下から見上げたときに顔が翼で隠れる)
//   z    … 肩の上げ下げ
//   hand … 手首。ここを折らないと、いくら肩を動かしても
//          「広げた翼を傾けた」ようにしか見えない ── 畳んだと分かるのはこの角度
const WING_FOLD = { x: -0.15, y: 1.9, z: 0.25, hand: -2.9 };
const WING_OPEN = { x: -Math.PI * 0.30, y: 0.35, z: 0.31, hand: 0 };

// 眠っている竜の目。**灯が消える**のがいちばん遠くまで届く合図で、
// 翼の形は近づかないと分からない。閉じた瞼は「潰した球 + 体と同じ暗い色」で、
// 光る点が消えて顔に一本の線が残る。
const EYE_SHUT = 0.16;              // 閉じたときの縦の潰し具合
const EYE_DARK = new THREE.Color(0x5e1512); // 眠っている目(竜の暗いほうの体色)
const EYE_LIT = new THREE.Color(0xffcc33);  // 起きている目
const EMBER_SLEEP = 0.10;           // 口元の熾火。眠っていてもわずかに残す
const EMBER_WAKE = 0.9;
// まばたき。起きているときだけ、ときどき。生きている合図はこれがいちばん安い
const BLINK_EVERY = 4200;           // ms
const BLINK_MS = 150;

// 弓を満まで引き絞るのにかかる秒数。短すぎると連打が最適になり、
// 長すぎると「引いている間に着かれる」ばかりになる。
const DRAW_FULL = 0.9;
// 構えたときのカメラの見下ろし角。
//
// はじめ水平(0.06)にしていたが、海が水平線ぎわの細い帯にしか映らず、
// 船がどこにいるのか・どれが近いのかが読めなかった。**斜め上から見下ろす**と
// 海が面として広がって、寄せてくる船が並んで見える。
//   0.06 … 水平。船が水平線に張りつく
//   0.45 … 海が画面の上半分に広がり、船の前後が読める(採用)
//   0.60 … 見下ろしすぎ。船が画面の上端へ逃げ、足元の板ばかり映る
const AIM_PITCH = 0.45;
// 構えている間、カメラを**肩の横へずらす**幅。
// 真後ろから撮ると本人が画面の中心に来て、照準と体が重なって的が見えない。
// 人の寸法なので縮尺を掛ける(小さくなったら、ずらす幅も小さくてよい)。
const AIM_SIDE = sc(0.40);
// 構えている間だけカメラを寄せる割合。
// 見下ろすようにしたぶん寄せを緩める ── 近いまま見下ろすと、足元の板が
// 画面の半分を占めて海が狭くなる。
const AIM_CLOSER = 0.10;
// 構えている間だけ画角を広げる。歩きの 45° だと海がほとんど映らず、
// どこから船が来ているのか分からない。広げすぎると的が小さくなる。
const AIM_FOV = 64;
// 円卓に着いている間のカメラ。
// **少し引いて、上から見下ろす。** 歩きのカメラは本人の背中越しに低く
// 構えているので、そのまま座ると自分の後頭部で卓が埋まる。卓と向かいの人が
// 収まるところまで引き、天板が面として見える角度まで起こす。
const TABLE_CLOSER = -0.6;   // 負で遠ざかる(_placeCamera の closer)
const TABLE_PITCH = 0.62;
// 画面の端に出す「敵はあちら」の三角を、縁からどれだけ内側に置くか(画素)
const MARK_INSET = 26;

// 釣っている間のカメラ。竿は右手(モデルの +X 側)なので、そちらへ回り込むと
// 竿と糸が本人に重ならない。
const FISH_YAW = -0.75;     // 本人の向きからどれだけ横へ回り込むか
const FISH_PITCH = 0.30;    // 見下ろす角度(角度は縮尺と無関係)
const FISH_DIST = sc(1.9);
const FISH_AIM = sc(0.42);  // 本人から浮きのほうへ、どれだけ先を見るか

// 散策部屋: 自分の位置を送る間隔(サーバーの配る間隔と揃える)
const SEND_MS = 100;
// 動きがこれ以下なら送らない。立ち止まっている人は通信ゼロになる
const SEND_MOVE = 0.01;
const SEND_TURN = 0.02;
// またげる高さは脚の長さの話なので縮尺を掛ける ── 掛けないと、小さく
// なったのに今までどおり草も畝もまたげてしまう。
const BLOCK_MIN_HEIGHT = sc(0.15); // これより低い物はまたげる(草・花・畝・砂丘)
// こちらは「タイルより大きいか」を見るので盤の寸法。縮尺は掛けない。
const BLOCK_MAX_RADIUS = 0.5;  // これより大きい物は地形そのもの(タイル・海・桟橋)

// シーンに置かれている物から、ぶつかる物の一覧を作る。
//
// 何が障害物かを名前で列挙すると、飾りを足すたびに漏れる。
// 「タイルより十分高くて、タイルより小さい物」= 立体物、という
// 見たままの規則で拾う(実測して決めた値は上の定数)。
function collectObstacles(b) {
  const list = [];
  const box = new THREE.Box3();
  const size = new THREE.Vector3();
  const center = new THREE.Vector3();

  const scan = (obj) => {
    if (!obj || obj.visible === false) return;
    box.setFromObject(obj);
    if (!Number.isFinite(box.min.x)) return;
    box.getSize(size);
    box.getCenter(center);
    const r = Math.max(size.x, size.z) / 2;
    const h = box.max.y - TILE_TOP;
    if (h < BLOCK_MIN_HEIGHT) return;
    if (r > BLOCK_MAX_RADIUS) return;
    // h も持たせる。跳んで足が越えていれば、その物は当たらなくなる。
    // obj は受付のまわりを片付けるときに隠すのに使う(clearAround)
    list.push({ x: center.x, z: center.z, r, h, obj });
  };

  for (const c of b.staticGroup.children) scan(c);   // 木・山・サボテン・港の看板
  for (const c of b.dynamicGroup.children) scan(c);  // 建物・都市・騎士・船
  scan(b.robber);                                    // 盗賊(またはドラゴン)
  scan(b.merchantMesh);
  return list;
}

export class WalkMode {
  // fishSeed: 釣りの乱数。対戦の state.rng は絶対に使わない
  // (回すとオンライン対戦で全員の乱数列がずれる)。
  // seat: 散策部屋での自分の席(1人で歩くときは null)。色分けに使う
  // look: すがた(species.js の番号)
  constructor(board3d, state, fishSeed = Date.now() >>> 0, seat = null, look = DEFAULT_SPECIES) {
    this.b = board3d;
    this.ground = makeGround(state);
    // 港の看板は「盤を上から見たときの目印」の大きさで作られている。
    // 棒人間を縮めたぶんカメラも寄るので、そのままだと隣に立った看板が
    // 画面を埋めて、竿も浮きも見えなくなる。歩いている間だけ小さくする。
    // 障害物を拾う前に縮めるので、ぶつかる大きさも一緒に小さくなる。
    this.clearedObjs = [];   // 受付の広場のために隠した木や岩
    this.signs = [];
    board3d.staticGroup.traverse((o) => {
      if (!o.userData?.portSign) return;
      this.signs.push({ o, scale: o.scale.clone() });
      o.scale.multiplyScalar(WALK_SCALE);
    });
    this.obstacles = collectObstacles(board3d);
    this.seat = seat;

    // 集まりの受付。島の中心(みんなが降り立つところ)に立てる。
    // 島の種類ごとに何が開かれるかが違い、何も無い島には受付も立たない
    // (一覧は minigame/meets.js。サーバーも同じ表で弾く)。
    this.meet = meetFor(state.mode);
    this.deskAt = null;
    this.desk = null;
    // 円卓を囲んで遊ぶ島(大富豪)だけ、受付の台の代わりに卓を据える。
    // 近づくとパネルが開くところは台と同じなので、deskAt はどちらでも使う。
    this.roundTable = this.meet?.id === 'daifugo';
    this.tableSeatAt = null;   // 座っている席の場所(座っている間だけ)
    if (this.meet) {
      // 席ごとの立ち位置は中心から輪の上へずらしてあるので、卓とは重ならない
      const home = spawnPoint(state);
      this.deskAt = { x: home.x, z: home.y };
      // まわりの木や岩を片付けて広場にする。木は盤の寸法で棒人間より大きく、
      // 受付の手の届く範囲をまるごと塞いでしまう(obstacles.js の説明を参照)。
      // 円卓は席を囲むぶん広い場所が要る。
      const clearR = this.roundTable ? TABLE_CLEAR : DESK_CLEAR;
      const { kept, cleared } = clearAround(this.obstacles, this.deskAt, clearR);
      this.obstacles = kept;
      // ぶつからないものが見えていると「すり抜けた」に見えるので、隠す
      this.clearedObjs = cleared.map((o) => ({ o: o.obj, vis: o.obj?.visible }))
        .filter((e) => e.o);
      for (const e of this.clearedObjs) e.o.visible = false;
      const groundY = this.ground(home.x, home.y).y;
      this.desk = this.roundTable
        ? makeTable(board3d.scene, home.x, home.y, groundY, this.meet, WALK_SEATS)
        : makeDesk(board3d.scene, home.x, home.y, groundY, this.meet);
      // 台(卓)にもぶつかるようにする。collectObstacles はシーンを見て
      // 集めるので、あとから足したものは自分で入れる必要がある。
      this.obstacles.push({
        x: home.x, z: home.y, r: this.roundTable ? TABLE_RADIUS : DESK_RADIUS, h: sc(0.62),
      });
    }
    this.atDesk = false;
    this.onDesk = null;      // 受付に入った/出た
    // 「ドラゴンから逃げろ」の竜。居場所を決めるのはサーバー(dragon-hunt.js)で、
    // ここは届いた場所へ滑らかに寄せて描くだけ ── 各自で動かすと、端末ごとに
    // 違う場所に竜がいて「当たった/当たってない」で揉める。
    this.hunt = null;        // { mesh, x, z, a, tx, tz, ta }

    // 巣に棲んでいる竜。**盤の駒として既にそこに立っている**ので、
    // 作らずに借りる(board3d.dragonMesh。ドラゴンの島だけ visible)。
    // 歩いている間だけ「棲んでいる竜」として動かす ── 眠って、呼吸して、
    // 近づけば首をこちらへ向ける。盤の上では今までどおり浮いて羽ばたく。
    const nest = nestPoint(state);
    this.nestAt = nest ? { x: nest.x, z: nest.y } : null;
    this.nestHex = nestHexOf(state);
    this.nestMesh = this.nestAt ? board3d.dragonMesh : null;
    this.atNest = false;
    this.onNest = null;      // 巣のそばに来た/離れた
    // 0 = 眠っている、1 = 起きてこちらを見ている
    this.nestWake = 0;
    // 借り物なので、出るときに返せるよう元の姿勢を覚えておく
    this.nestRest = this.nestMesh ? {
      pos: this.nestMesh.position.clone(),
      rotY: this.nestMesh.rotation.y,
      head: { ...(this.nestMesh.userData.headRest ?? { x: 0, y: 0 }) },
      wingX: (this.nestMesh.userData.wings ?? []).map((w) => w.rotation.x),
      wingY: (this.nestMesh.userData.wings ?? []).map((w) => w.rotation.y),
      wingZ: (this.nestMesh.userData.wings ?? []).map((w) => w.rotation.z),
      handZ: (this.nestMesh.userData.wingHands ?? []).map((h) => h.rotation.z),
      eyes: (this.nestMesh.userData.eyes ?? [])
        .map((e) => ({ y: e.scale.y, color: e.material.color.clone() })),
      ember: this.nestMesh.userData.ember?.material.opacity ?? null,
    } : null;
    // 物見の櫓(蛮族を射る)。開く島だけ建てる ── 建っていない島では
    // postAt が null なので、そもそも近づけない(受付と同じ考え方)。
    this.postAt = null;
    this.archeryFx = null;
    this.raid = null;         // 射っている間だけ Raid が入る
    this.atPost = false;
    this.onPost = null;       // 櫓のそばに来た/離れた
    this.drawT = 0;           // 弓を引き始めてからの秒数
    this.drawing = false;
    this.aimT = 0;
    this.sitT = 0;            // 円卓に着いてからの秒数(座り姿勢のゆらぎ)
    if (ARCHERY_MODES.includes(state.mode)) {
      const p = watchPost(state);
      if (p) {
        this.postAt = { ...p, y: this.ground(p.x, p.z).y };
        // **射場をこしらえる。** 受付の広場と同じ要領で、まわりの木や岩を
        // 片付ける ── 浜のすぐ横に松が立っているだけで海が隠れ、狙いようが
        // なくなる(実際そうなっていた)。的が見えないのは腕前の話ではない。
        const cut = clearAround(this.obstacles, { x: p.x, z: p.z }, POST_CLEAR);
        this.obstacles = cut.kept;
        for (const o of cut.cleared) {
          if (!o.obj) continue;
          this.clearedObjs.push({ o: o.obj, vis: o.obj.visible });
          o.obj.visible = false;
        }
        this.archeryFx = new ArcheryFx(board3d.scene, this.postAt);
        // 櫓にもぶつかる。collectObstacles はシーンを見て集めるので、
        // あとから建てたものは自分で入れる
        // ぶつかるのは櫓の実物の場所(archery-fx が岸に沿ってずらして建てる。
        // ずらす向きと幅は archery-fx.js の TOWER_SIDE と揃えること)
        this.obstacles.push({
          x: p.x - p.outX * 1.05 - p.outZ * 0.45,
          z: p.z - p.outZ * 1.05 + p.outX * 0.45,
          r: 0.10, h: 0.5,
        });
      }
    }
    this.species = speciesById(look);
    this.walker = new Walker(
      board3d.scene,
      this.ground,
      seat == null ? 0x2f6fd0 : WALK_COLORS[seat % WALK_COLORS.length],
      makeBlocker(this.obstacles),
      this.species,
    );

    // 散策部屋では席ごとに立ち位置をずらす(全員が重なって見えないように)
    const s = spawnPoint(state, seat);
    this.walker.setPosition(s.x, s.y);

    // 釣り。港のそばに立つと竿を出せる
    this.spots = fishingSpots(state);
    this.spot = null;        // いま近くにある釣り場
    this.fishing = null;     // 釣っている間だけ Fishing が入る
    this.fishSeed = fishSeed;
    this.fishT = 0;
    this.ffx = new FishingFx(board3d.scene, SEA_Y);
    this.onSpot = null;      // 釣り場に入った/出た
    this.onFishStep = null;  // 毎フレームの状態(HUD 用)
    this.onFishEvent = null; // 'bite' / 'burst' / 'landed' / 'lost'

    this.paused = false;     // 図鑑を開いている間は時間を止める
    this.input = { x: 0, y: 0 };
    this.keys = new Set();
    this.camYaw = 0;
    // 見下ろす角度。**深くすると自分の足元しか見えなくなる。**
    // 0.62 で始めていたが、それだと水平線が画面の上に外れていて、
    // 3タイルより遠いものは何も映らない ── 島に何を置いても見えないので、
    // 「誰も居ない島」に見えていた(巣の竜すら1枚も写っていなかった)。
    // 0.40 だと島と海と、遠くの山に居る竜まで入る。
    // もっと見上げたいときは画面の右半分を上へなぞる(orbit で 0.05 まで)。
    this.camPitch = 0.40;
    this.camDist = sc(2.1);
    this.last = 0;
    this.onRespawn = null;
    this.onJump = null;
    this.onSplash = null;
    this.onSink = null;    // 沈み具合(0〜1)。画面を暗くするのに使う
    // 足音: (地形, 'walk'|'jump'|'land', 揺らぎ -1〜1, 歩く速さ 0〜1)
    this.onStep = null;
    // 足元の地形。state をずっと抱えずに、見るところだけ切り出しておく
    this.terrainAt = (hid) => state.board.hexes[hid]?.terrain ?? null;
    this.fx = new WaterFx(board3d.scene);

    // 散策部屋。1人で歩くときは何も動かない(送らない・描かない)
    this.remote = new RemoteWalkers();
    this.remoteView = new RemoteView(board3d.scene, this.ground);
    this.onPos = null;       // 自分の位置を送る口(main.js が繋ぐ)
    this._sendAt = 0;
    this._sent = null;
    // エモート。出している間だけ { id, key, ms, t } が入る
    this.emote = null;
    this.onEmote = null;     // 出し始め・終わりの知らせ(HUD 用)

    // カメラと操作を借りるので、元の状態を覚えておいて出るときに戻す
    this.saved = {
      pos: board3d.camera.position.clone(),
      target: board3d.controls.target.clone(),
      near: board3d.camera.near,
      fov: board3d.camera.fov,
      controls: board3d.controls.enabled,
      fog: board3d.scene.fog ? board3d.scene.fog.near : null,
      fogFar: board3d.scene.fog ? board3d.scene.fog.far : null,
    };
    board3d.controls.enabled = false;
    board3d.camera.near = 0.02;      // 寄るので手前を切らないように
    board3d.camera.fov = 60;         // 歩きは画角を広めに
    board3d.camera.updateProjectionMatrix();
    if (board3d.scene.fog) {
      // 地面すれすれから見るので、霧は遠くへ逃がす
      board3d.scene.fog.near = 8;
      board3d.scene.fog.far = 90;
    }
    // 水中の霧はここから寄せる(歩いているときの値が基準)
    this.savedFog = { near: 8, far: 90 };

    // カメラは進行方向の後ろから始める
    this.camYaw = this.walker.facing;
    this._placeCamera(0, true);

    this.b.onFrame = (t) => this._frame(t);
  }

  // ---- ドラゴンから逃げろ ----

  // サーバーから届いた竜の居場所。null で仕舞う。
  // 届くのは 10 回/秒なので、そのまま置くとカクつく。目標として持っておいて
  // 毎フレーム寄せる(棒人間の補間と同じ考え方)。
  setDragon(d) {
    if (!d) {
      if (this.hunt) { this.b.scene.remove(this.hunt.mesh); disposeTree(this.hunt.mesh); }
      this.hunt = null;
      return;
    }
    if (!this.hunt) {
      const mesh = makeDragon();
      // 盤の上の竜は駒の大きさ。飛んでいる竜は棒人間と同じ縮尺で見せる
      // ── 等倍だと島の半分を覆ってしまう。
      mesh.scale.setScalar(WALK_SCALE * 0.8);
      this.b.scene.add(mesh);
      this.hunt = { mesh, x: d.x, z: d.z, a: d.a, tx: d.x, tz: d.z, ta: d.a };
    }
    this.hunt.tx = d.x;
    this.hunt.tz = d.z;
    this.hunt.ta = d.a;
  }

  // 竜を1フレーム進める(位置を寄せて、翼を羽ばたかせる)
  _dragonFrame(dt, t) {
    const h = this.hunt;
    if (!h) return;
    const k = smooth(9, dt);
    h.x += (h.tx - h.x) * k;
    h.z += (h.tz - h.z) * k;
    // 向きは近いほうへ回す(π をまたぐとき一周させない)
    let diff = h.ta - h.a;
    while (diff > Math.PI) diff -= Math.PI * 2;
    while (diff < -Math.PI) diff += Math.PI * 2;
    h.a += diff * k;
    const g = this.ground(h.x, h.z);
    // 飛ぶ高さは**地面すれすれ**にする。歩きのカメラは 35°ほど見下ろして
    // いるので、高く飛ばすほど画面の上へ外れる ── 実測では、棒人間の
    // 2.4 倍の高さだと真正面に置いても1枚も写らなかった。
    // それでも3タイル以上離れると画面から出るので、どちらから来ているかは
    // 上のバーの矢印で知らせる(main.js の renderMeetBar)。
    h.mesh.position.set(h.x, (g.ok ? g.y : SEA_Y) + sc(0.12) + Math.sin(t / 620) * sc(0.04), h.z);
    h.mesh.rotation.y = h.a;
    // **両翼は同じ揺れを打つ。** 片方だけ位相をずらすと、羽ばたかずに
    // シーソーのように左右が交互に上下する(実際そうなっていた ──
    // 追いかけてくる竜が、飛ばずに揺れているだけに見えていた)。
    // 左右で違うのは符号だけなので、揺れの値はループの外で1つだけ作る
    // ── ずらしようがないようにしておく。
    const flap = 0.35 + Math.sin(t / 130) * 0.5;
    for (const [i, w] of (h.mesh.userData.wings ?? []).entries()) {
      w.rotation.z = (i === 0 ? 1 : -1) * flap;
    }
  }

  // ---- 巣に棲んでいる竜 ----

  // 眠っている竜を1フレーム進める。
  //
  // board3d の _tickRobber が毎フレーム先に姿勢を書く(浮かせて羽ばたかせる)
  // ので、**その後**に呼ばれるここで上書きする(順番は board3d.js の loop)。
  // 大会が始まって竜が飛んでいる間は、こちらの竜は仕舞う ── 同じ1匹なので、
  // 巣にも空にも居ると2匹になる。
  _nestFrame(dt, t) {
    const m = this.nestMesh;
    if (!m) return;
    if (this.hunt) { m.visible = false; return; }
    m.visible = true;

    const w = this.walker.pos;
    // 「自分の山に人が登ってきたか」。距離で見ると、巣が受付の隣に来る島で
    // 広場に立っているだけで起きたままになる(ground.js の nestHexOf)。
    const onNest = this.ground(w.x, w.z).hexId === this.nestHex;
    // 目を覚ますのはゆっくり、寝直すのはもっとゆっくり。
    // 境目をまたいでも姿勢が跳ねないのは、この鈍さが効いているため。
    this.nestWake += ((onNest ? 1 : 0) - this.nestWake) * smooth(onNest ? 1.6 : 0.5, dt);
    const k = this.nestWake;

    // **居場所は動かさない。** 盤の「暴走」の飛翔アニメーション
    // (board3d の robberAnim)が動き出すと、島を歩いている最中に竜が
    // 横へ流れていってしまう。島に入ったときの場所に留める ──
    // 巣の中心ではなく**盤が置いた場所**に留めること(盤は駒が見やすいように
    // 少し手前へずらして置いている。中心へ寄せると見た目が変わる)。
    m.position.x = this.nestRest.pos.x;
    m.position.z = this.nestRest.pos.z;
    // 息づかい。眠っているときはゆっくり深く、起きると浅く速くなる
    const breath = Math.sin(t / (1800 - k * 900)) * (0.014 - k * 0.006);
    m.position.y = this.ground(m.position.x, m.position.z).y + breath;

    // 翼。眠っている間は畳んでいて、起きると半分ひらく。
    // **z(羽ばたき)も必ず書く。** 盤の _tickRobber は毎フレーム z を
    // 動かしていて、書かずにおくと**寝ている竜が羽ばたき続ける**
    // ── 畳んだ x と合わさって、翼を広げているように見えていた。
    const hands = m.userData.wingHands ?? [];
    // 揺れは左右で共通(_dragonFrame と同じ理由。片方だけずらすと
    // 羽ばたきではなくシーソーになる)。左右の違いは符号だけ。
    const breathe = Math.sin(t / 900);
    const flutter = Math.sin(t / 700);
    for (const [i, wing] of (m.userData.wings ?? []).entries()) {
      const side = i === 0 ? 1 : -1;
      wing.rotation.x = lerp(WING_FOLD.x, WING_OPEN.x + breathe * 0.05, k);
      wing.rotation.y = side * lerp(WING_FOLD.y, WING_OPEN.y, k);
      // 眠っている間は閉じたまま。起きたら、ゆっくりとした呼吸ぶんだけ動く
      wing.rotation.z = side * lerp(WING_FOLD.z, WING_OPEN.z + flutter * 0.06, k);
      // 手首。畳むのはここで、肩だけ動かしても「広げた翼を傾けた」ようにしか
      // 見えない ── 膜ごと折り返して初めて畳んだと分かる
      if (hands[i]) hands[i].rotation.z = lerp(WING_FOLD.hand, WING_OPEN.hand, k);
    }

    // 起きたら体ごとこちらへ向き直る。
    // 首だけ回しても、真下に立たれると顔は見えない ── 登ってきた人からは
    // 腹と尾しか映らず、「見られている」が伝わらなかった。体が回れば顔が来る。
    const toMe = Math.atan2(w.x - m.position.x, w.z - m.position.z);
    if (k > 0.02) {
      let turn = toMe - m.rotation.y;
      while (turn > Math.PI) turn -= Math.PI * 2;
      while (turn < -Math.PI) turn += Math.PI * 2;
      // ゆっくり。大きい生きものが向き直る速さ(飛ぶときの旋回とは別もの)
      m.rotation.y += turn * smooth(0.9 * k, dt);
    }

    // 首。眠っているうちは顎を落として、起きると持ち上げて、
    // 体が回りきるまでの差を首で埋める。
    const head = m.userData.head;
    if (head) {
      const rest = m.userData.headRest ?? { x: 0.15, y: 0 };
      head.rotation.x = 0.85 + (rest.x - 0.85 - 0.2) * k;
      let rel = toMe - m.rotation.y;
      while (rel > Math.PI) rel -= Math.PI * 2;
      while (rel < -Math.PI) rel += Math.PI * 2;
      head.rotation.y = rest.y + Math.max(-1.1, Math.min(1.1, rel)) * k;
    }

    // 目。眠っているうちは瞼を下ろして灯を落とし、起きると点る。
    // 起きているあいだは、ときどきまばたきする。
    const blinkT = t % BLINK_EVERY;
    const blink = blinkT < BLINK_MS ? Math.sin((blinkT / BLINK_MS) * Math.PI) : 0;
    const open = lerp(EYE_SHUT, 1, k) * (1 - blink * k);
    for (const eye of m.userData.eyes ?? []) {
      eye.scale.y = open;
      eye.material.color.copy(EYE_DARK).lerp(EYE_LIT, k * (1 - blink));
    }
    const ember = m.userData.ember;
    // 熾火は呼吸に合わせて息づく(眠っていても消えてはいない)
    if (ember) {
      const puff = 1 + Math.sin(t / (1800 - k * 900)) * 0.35;
      ember.material.opacity = lerp(EMBER_SLEEP, EMBER_WAKE, k) * puff;
    }

    // 巣まで登ったか(入った/出たときだけ知らせる)
    if (onNest !== this.atNest) {
      this.atNest = onNest;
      this.onNest?.(onNest);
    }
  }

  // 借りていた竜を盤に返す。姿勢を戻さないと、対戦の画面に
  // 首を垂れて翼を畳んだままの竜が残る(_tickRobber は翼の z しか書かない)。
  _nestRestore() {
    const m = this.nestMesh;
    if (!m || !this.nestRest) return;
    m.visible = true;
    m.position.copy(this.nestRest.pos);
    m.rotation.y = this.nestRest.rotY;
    for (const [i, wing] of (m.userData.wings ?? []).entries()) {
      wing.rotation.x = this.nestRest.wingX[i] ?? wing.rotation.x;
      wing.rotation.y = this.nestRest.wingY[i] ?? wing.rotation.y;
      wing.rotation.z = this.nestRest.wingZ[i] ?? wing.rotation.z;
    }
    // 手首は盤側が触らない ── 戻し忘れると、対戦の画面に翼を畳んだ竜が残る
    for (const [i, hand] of (m.userData.wingHands ?? []).entries()) {
      hand.rotation.z = this.nestRest.handZ[i] ?? hand.rotation.z;
    }
    // 目と熾火も盤側は書き直さない。消したまま返すと、対戦の画面に
    // 目の落ちた竜が座り続ける
    for (const [i, eye] of (m.userData.eyes ?? []).entries()) {
      const rest = this.nestRest.eyes[i];
      if (!rest) continue;
      eye.scale.y = rest.y;
      eye.material.color.copy(rest.color);
    }
    if (m.userData.ember && this.nestRest.ember != null) {
      m.userData.ember.material.opacity = this.nestRest.ember;
    }
    const head = m.userData.head;
    if (head) {
      head.rotation.x = this.nestRest.head.x;
      head.rotation.y = this.nestRest.head.y;
    }
  }

  // ---- 操作 ----

  // すがたを選び直す(歩いている最中でも)。散策部屋では、みんなに知らせるのは
  // main.js の仕事 ── ここは自分の見た目だけを替える。
  setLook(id) {
    this.species = speciesById(id);
    this.walker.setSpecies(this.species);
  }

  setStick(x, y) {
    this.input.x = x;
    this.input.y = y;
  }

  // ---- エモート ----

  // その場でする短い身ぶり。動かすと途中でやめる(歩きながらは出さない)。
  // 釣っている間は出せない ── 竿を持ったまま万歳すると腕が竿ごと回る。
  playEmote(id) {
    if (this.fishing || this.walker.falling) return false;
    const e = emoteById(id);
    if (!e) return false;
    this.emote = { id: e.id, key: e.key, ms: e.ms, t: 0 };
    this.onEmote?.(e);
    return true;
  }

  stopEmote() {
    if (!this.emote) return;
    this.emote = null;
    this.onEmote?.(null);
  }

  // エモートを1フレーム進める。まだ続いているなら true。
  // 動いた・跳んだ・落ちたら取り消す ── 歩きながら固まった姿勢で滑ると怖い。
  _emoteFrame(dt, moving, r) {
    if (!this.emote) return false;
    if (moving || !r?.grounded || r?.falling) { this.stopEmote(); return false; }
    this.emote.t += dt;
    const k = this.emote.t / (this.emote.ms / 1000);
    if (k >= 1) { this.stopEmote(); return false; }
    this.walker.emote(this.emote.key, this.emote.t, k);
    return true;
  }

  setKey(code, down) {
    if (down) {
      // 押しっぱなしで跳び続けないよう、押した瞬間だけ拾う
      if ((code === 'Space' || code === 'KeyJ') && !this.keys.has(code)) this.jump();
      this.keys.add(code);
    } else {
      this.keys.delete(code);
    }
  }

  jump() {
    if (this.paused || this.fishing) return;   // 釣っている間は跳ばない
    this.walker.motion.jump();
  }

  // 図鑑などを開いている間は時間を止める。
  // 止めないと、パネルの裏でアタリが来て、見えないまま逃げられる。
  setPaused(on) {
    this.paused = !!on;
    if (this.paused) {
      this.setStick(0, 0);
      this.keys.clear();
      this.setReeling(false);
    }
  }

  // ---- 釣り ----

  get isFishing() { return this.fishing != null; }

  // 港のそばでだけ始められる。足場に立たせ、沖を向かせてから投げる。
  startFishing() {
    if (this.fishing || !this.spot) return false;
    this.stopEmote();   // 竿を出すので、身ぶりは切り上げる
    const s = this.spot;
    this.walker.setPosition(s.x, s.z);
    this.walker.motion.vel.x = 0;
    this.walker.motion.vel.z = 0;
    this.walker.motion.facing = Math.atan2(s.outX, s.outZ);
    this.walker.setRod(true);
    // 投げるたびに乱数を進める(同じ港で同じ魚が続かないように)
    this.fishSeed = (this.fishSeed * 1103515245 + 12345) >>> 0;
    this.fishing = new Fishing(this.fishSeed, s.type);
    this.fishT = 0;
    this.fishing.cast();
    this.ffx.cast(s.x, s.z, s.outX, s.outZ);
    this.camYaw = this.walker.facing;
    return true;
  }

  // 竿を上げてしまう(結果を見終わったあと、または途中でやめたとき)
  stopFishing() {
    if (!this.fishing) return;
    this.fishing = null;
    this.walker.setRod(false);
    this.ffx.hide();
  }

  // アタリで押す(合わせ)。勝負中は「巻く」の押し始めとしては使わない。
  hookFish() {
    return this.fishing ? this.fishing.hook() : false;
  }

  setReeling(on) {
    this.fishing?.setReeling(on);
  }

  // 逃した/釣り上げたあと、その場でもう一度投げる
  recast() {
    if (!this.fishing || this.fishing.active || !this.spot) return false;
    this.fishSeed = (this.fishSeed * 1103515245 + 12345) >>> 0;
    this.fishing = new Fishing(this.fishSeed, this.spot.type);
    this.fishT = 0;
    this.fishing.cast();
    this.ffx.cast(this.spot.x, this.spot.z, this.spot.outX, this.spot.outZ);
    return true;
  }

  // カメラを回す(画面の右半分のドラッグ / マウスドラッグ)
  orbit(dx, dy) {
    this.camYaw -= dx * 0.006;
    this.camPitch = Math.max(0.05, Math.min(0.9, this.camPitch + dy * 0.004));
  }

  zoom(d) {
    this.camDist = Math.max(sc(1.2), Math.min(sc(5), this.camDist + d));
  }

  _keyInput() {
    const k = this.keys;
    const x = (k.has('KeyD') || k.has('ArrowRight') ? 1 : 0)
      - (k.has('KeyA') || k.has('ArrowLeft') ? 1 : 0);
    const y = (k.has('KeyW') || k.has('ArrowUp') ? 1 : 0)
      - (k.has('KeyS') || k.has('ArrowDown') ? 1 : 0);
    return { x, y };
  }

  _frame(t) {
    // フレーム落ちしても飛ばないように上限を切る。歩く側と同じ値を使う
    // (片方だけ刻むと、低フレームで「本人はゆっくり・カメラだけ瞬間移動」
    //  になってガタつく)。長い dt は motion 側が細かく刻んで消化する。
    const dt = this.last ? Math.min(MAX_DT, (t - this.last) / 1000) : 0.016;
    this.last = t;   // 止まっている間も進めておく(再開時に一気に飛ばさない)
    if (this.paused) return;
    // 散策部屋。釣っていても止まっていても、相手は動くし自分も知らせる
    this._netFrame(dt, t);
    // 竜も釣りの最中に止めない ── 竿を出したまま捕まるのが正しい
    this._dragonFrame(dt, t);
    // 巣の竜も同じ。釣っていようが図鑑を開いていようが、島に棲んでいる
    this._nestFrame(dt, t);

    if (this.fishing) {
      this._fishFrame(dt);
      return;
    }
    if (this.raid) {
      this._archeryFrame(dt, t);
      return;
    }
    if (this.tableSeatAt) {
      this._sitFrame(dt, t);
      return;
    }
    // 櫓は撃っていない間も動かす(船は湧かないが、旗と塔はそこにある)

    const kb = this._keyInput();
    const inp = (kb.x || kb.y) ? kb : this.input;
    const w = this.walker.pos;
    // エモート中は入力を捨てる ── 歩き出したらエモートを取り消して、
    // その次のフレームから動く(同じフレームで両方やると1歩ぶん滑る)。
    const moving = !!(inp.x || inp.y);
    const still = this.emote ? { x: 0, y: 0 } : inp;
    const r = this.walker.update(dt, still, this.camYaw);
    // 姿勢だけ上書きする(位置・地面・カメラは update の結果をそのまま使う)
    this._emoteFrame(dt, moving, r);

    // 受付のそばに来たら知らせる(入った/出たときだけ)。
    // 受付の無い島では deskAt が null なので、そもそも近づけない
    const near = !!this.deskAt && r.grounded
      && Math.hypot(w.x - this.deskAt.x, w.z - this.deskAt.z) < DESK_REACH;
    if (near !== this.atDesk) {
      this.atDesk = near;
      this.onDesk?.(near);
    }

    // 櫓のそばに来たら知らせる(入った/出たときだけ)。
    // 建っていない島では postAt が null なので、そもそも近づけない
    const onPost = !!this.postAt && r.grounded
      && Math.hypot(w.x - this.postAt.x, w.z - this.postAt.z) < POST_RADIUS;
    if (onPost !== this.atPost) {
      this.atPost = onPost;
      this.onPost?.(onPost);
    }

    // 港のそばに来たら知らせる(入った/出たときだけ)
    const spot = r.grounded ? spotNear(this.spots, w.x, w.z) : null;
    if (spot !== this.spot) {
      this.spot = spot;
      this.onSpot?.(spot);
    }
    // 足音。「地面 × 動き」で音が変わるので、どこを踏んだかも渡す。
    // 踏み切りと着地は歩数と別に鳴らす(同じ足でも重さが違う)。
    if (r?.jumped) { this._step('jump'); this.onJump?.(); }
    else if (r?.landed && !r.respawned) this._step('land');
    else if (r?.stepped) this._step('walk', r.gait);
    if (r?.splashed) {
      this.fx.splash(w.x, w.z);
      this.onSplash?.();
    }
    if (r?.respawned) this.onRespawn?.();

    // 沈んでいる間だけ泡を出す。画面の暗転は「もうすぐ戻る」ぶんだけ。
    const m = this.walker.motion;
    const inWater = r?.inWater && !r.respawned;
    this.fx.update(dt, inWater ? { x: w.x, y: this.ground(0, 0).y + m.y, z: w.z } : null);
    this.onSink?.(r?.respawned ? 0 : sinkVeil(r?.depth ?? 0));

    // 動いている間は、カメラをゆっくり後ろへ回り込ませる
    const speed = Math.hypot(this.walker.vel.x, this.walker.vel.z);
    if (speed > WALK_SPEED * 0.35) {
      const want = this.walker.facing;
      let d = ((want - this.camYaw + Math.PI) % (Math.PI * 2) + Math.PI * 2) % (Math.PI * 2) - Math.PI;
      this.camYaw += d * smooth(1.6, dt);
    }
    this._placeCamera(dt, false);

    // 霧・背景・水面は _tickSky が毎フレーム書き直すので、その後(= ここ)で
    // 上書きする。カメラが水面より下にある間だけ効く。
    WaterFx.applyUnderwater(
      this.b.scene, this.b.seaMesh,
      WaterFx.submersion(this.b.camera.position.y),
      r?.depth ?? 0, this.savedFog,
    );
  }

  // ---- 円卓に着く ----

  get isSeated() { return !!this.tableSeatAt; }

  // 円卓の i 番目の席へ座る。**位置と向きはみんな同じ式で決める**ので、
  // 各自が自分を座らせるだけで、相手の画面にも同じ場所に座って見える
  // (位置は散策部屋の中継でそのまま流れる)。
  sitAtTable(index, total) {
    if (!this.deskAt || !this.roundTable) return false;
    const spot = tableSeats(this.deskAt, total)[Math.max(0, index) % Math.max(1, total)];
    if (!spot) return false;
    this.walker.setPosition(spot.x, spot.z);
    this.walker.motion.facing = spot.face;
    this.camYaw = spot.face;
    this.tableSeatAt = spot;
    this.sitT = 0;
    this.emote = null;
    this.setStick(0, 0);
    // 見下ろす角度は戻せるように覚えておく(弓と同じ作法)
    this.camPitchSaved = this.camPitch;
    this.camPitch = TABLE_PITCH;
    this._placeCamera(0, true, TABLE_CLOSER);
    return true;
  }

  standUp() {
    if (!this.tableSeatAt) return;
    this.tableSeatAt = null;
    if (this.camPitchSaved != null) {
      this.camPitch = this.camPitchSaved;
      this.camPitchSaved = null;
    }
  }

  // 座っている間のフレーム。歩きの計算はしない(その場に腰かけたまま)
  _sitFrame(dt, t) {
    this.sitT += dt;
    this.walker.sit(this.sitT);
    this._placeCamera(dt, false, TABLE_CLOSER);
  }

  // ---- 蛮族を射る ----

  get isAiming() { return this.raid != null; }

  // 櫓のそばで弓を構える。始めると蛮族船が寄せてくる
  startArchery(seed = Date.now() >>> 0) {
    if (this.raid || !this.postAt || this.fishing) return false;
    this.raid = new Raid(seed, this.postAt, SEA_Y);
    this.aimT = 0;
    this.drawT = 0;
    this.drawing = false;
    this.walker.setBow(true);
    // 海のほうを向いて構える。始めた瞬間に的が画面に入っていないと、
    // 「何が始まったのか」が分からない
    const yaw = Math.atan2(this.postAt.outX, this.postAt.outZ);
    this.walker.motion.facing = yaw;
    this.camYaw = yaw;
    // **水平まで見上げる。** 歩きのカメラは 0.40 ほど見下ろしていて、
    // そのままだと沖の船が画面の上へ外れる ── 撃つ相手が見えない。
    this.camPitch = AIM_PITCH;
    // 画角を広げる。戻せるように元の値を覚えておく
    this.camFov = this.b.camera.fov;
    this.b.camera.fov = AIM_FOV;
    this.b.camera.updateProjectionMatrix();
    return true;
  }

  stopArchery() {
    if (!this.raid) return;
    if (this.camFov != null) {
      this.b.camera.fov = this.camFov;
      this.b.camera.updateProjectionMatrix();
      this.camFov = null;
    }
    this.raid = null;
    this.drawing = false;
    this.drawT = 0;
    this.walker.setBow(false);
    this.archeryFx?.reset();
  }

  // 弓を引く/放つ。押している間 true、離したら false で放つ
  setDrawing(on) {
    if (!this.raid || this.raid.over) return;
    if (on) {
      if (!this.drawing) { this.drawing = true; this.drawT = 0; }
      return;
    }
    if (!this.drawing) return;
    this.drawing = false;
    this._loose();
  }

  // いまの引き絞り(0〜1)。満まで DRAW_FULL 秒
  get draw() {
    return this.drawing ? Math.min(1, this.drawT / DRAW_FULL) : 0;
  }

  // 画面の中心が指している海の上の点。照準はここに合っている。
  // カメラの前向きを水面まで伸ばす ── 上を向いていて水面に当たらないときは、
  // 届く限界の距離を返す(そこへ向けて撃てば、いちばん遠くへ飛ぶ)。
  aimPoint(out = new THREE.Vector3()) {
    const cam = this.b.camera;
    const dir = new THREE.Vector3();
    cam.getWorldDirection(dir);
    const from = cam.position;
    const far = arrowReach(1, this.postAt.y + BOW_Y, SEA_Y);
    if (dir.y < -1e-4) {
      const t = (SEA_Y - from.y) / dir.y;
      if (t > 0 && t < far * 3) return out.copy(from).addScaledVector(dir, t);
    }
    return out.copy(from).addScaledVector(dir, far);
  }

  // 画面の外にいる敵。端に出す三角の位置と向きを返す。
  //
  // 構えたカメラは狭いので、視界の外から寄せてきた船に気づけない
  // ── 「どこに現れているか分からない」の答えがこれ。
  // 戻り値は画面の画素(main.js がそのまま置く)。
  offScreenTargets(limit = 4) {
    const r = this.raid;
    const cam = this.b.camera;
    if (!r) return [];
    const el = this.b.renderer?.domElement;
    const W = el?.clientWidth ?? window.innerWidth;
    const H = el?.clientHeight ?? window.innerHeight;
    const p = new THREE.Vector3();
    const out = [];
    const targets = [
      ...r.foes.map((f) => ({ e: f, kind: 'foe' })),   // 浜の蛮族が先(急ぐ相手)
      ...r.ships.map((e) => ({ e, kind: 'ship' })),
    ];
    for (const { e, kind } of targets) {
      p.set(e.x, e.y + 0.15, e.z).project(cam);
      const behind = p.z > 1;
      const sx = (p.x * 0.5 + 0.5) * W;
      const sy = (-p.y * 0.5 + 0.5) * H;
      // 画面に入っていて手前なら、三角は要らない(本体が見えている)
      if (!behind && sx > 0 && sx < W && sy > 0 && sy < H) continue;
      // 後ろにあるときは投影が反転するので、符号を戻してから縁へ寄せる
      let dx = (behind ? -p.x : p.x);
      let dy = (behind ? p.y : -p.y);
      const len = Math.hypot(dx, dy) || 1;
      dx /= len; dy /= len;
      // 画面の縁との交点。長方形なので、はみ出しの大きいほうで割る
      const k = Math.min(
        (W / 2 - MARK_INSET) / Math.max(1e-6, Math.abs(dx)),
        (H / 2 - MARK_INSET) / Math.max(1e-6, Math.abs(dy)),
      );
      out.push({
        kind,
        x: Math.round(W / 2 + dx * k),
        y: Math.round(H / 2 + dy * k),
        // 三角は上向きに作ってあるので、その向きから回す
        deg: Math.round((Math.atan2(dx, -dy) * 180) / Math.PI),
      });
      if (out.length >= limit) break;
    }
    return out;
  }

  // 矢を出す点(弓を持つ手のあたり)
  bowPoint(out = new THREE.Vector3()) {
    const w = this.walker.pos;
    return out.set(w.x, this.ground(w.x, w.z).y + BOW_Y, w.z);
  }

  _loose() {
    const from = this.bowPoint(new THREE.Vector3());
    const to = this.aimPoint(new THREE.Vector3());
    const power = Math.min(1, this.drawT / DRAW_FULL);
    this.raid.shoot(from, {
      x: to.x - from.x, y: to.y - from.y, z: to.z - from.z,
    }, power);
    this.drawT = 0;
    this.onLoose?.(power);
  }

  // 射っている間のフレーム。歩きの計算はしない(その場に構えたまま)。
  _archeryFrame(dt, t) {
    this.aimT += dt;
    if (this.drawing) this.drawT += dt;
    const r = this.raid;
    const before = r.lives;
    r.update(dt);
    const events = r.takeEvents();
    this.archeryFx?.update(r, t);
    this.archeryFx?.onEvents(events);
    for (const e of events) this.onRaidEvent?.(e);
    if (r.lives !== before) this.onRaidHurt?.(r.lives);
    // 構えた姿勢。引き絞りは弦と矢にも出る
    this.walker.aim(this.aimT, this.draw);
    // カメラは狙う向きへ。肩の横へずらして、体と照準を重ねない
    this._placeCamera(dt, false, AIM_CLOSER, true);
  }

  // 釣っている間のフレーム。歩きの計算はしない(その場に立ったまま)。
  _fishFrame(dt) {
    this.fishT += dt;
    const f = this.fishing;
    for (const e of f.update(dt)) this.onFishEvent?.(e);

    const v = f.view();
    // 釣り終わったら糸を巻き取る(浮きも糸も消す)。
    // 出したままにすると、「もう一度」が出ているのに水に浸かったままに見える。
    if (!f.active) this.ffx.hide();
    // 投げているあいだの進み具合(浮きが飛んでいく)
    const castK = v.phase === 'cast' ? Math.min(1, this.fishT / CAST_TIME) : 1;
    this.walker.fish(this.fishT, {
      phase: v.phase, tension: v.tension, reeling: f.reeling,
      burst: v.burst, cast: castK,
    });
    this.walker.rodTip(this._tip ??= new THREE.Vector3());
    this.ffx.update(dt, v, this._tip, castK);
    this.onFishStep?.(v);

    this._placeFishCamera(dt, v);
  }

  // 釣っている間のカメラ。
  // 真後ろから撮ると、竿も糸も浮きも本人の陰に入って何も見えない。
  // 斜め後ろに回り込み、本人と浮きの中間を見る(横顔で竿の角度が分かる)。
  _placeFishCamera(dt, v) {
    const cam = this.b.camera;
    const w = this.walker.pos;
    const s = this.spot;
    const groundY = this.ground(w.x, w.z).y;
    const yaw = this.walker.facing + FISH_YAW * (s?.side || 1);
    // 引かれるほど寄って、手応えを見せる
    const dist = FISH_DIST * (1 - (v.phase === 'fight' ? v.tension * 0.18 : 0));
    const flat = Math.cos(FISH_PITCH) * dist;

    const want = new THREE.Vector3(
      w.x - Math.sin(yaw) * flat,
      groundY + 0.42 + Math.sin(FISH_PITCH) * dist,
      w.z - Math.cos(yaw) * flat,
    );
    cam.position.lerp(want, smooth(4.5, dt));
    // 見るのは本人と浮きのあいだ。竿の先と水面が同時に入る
    const aim = FISH_AIM * (v.phase === 'cast' ? 0.4 : 1);
    cam.lookAt(
      w.x + (s ? s.outX : 0) * aim,
      groundY + 0.18,
      w.z + (s ? s.outZ : 0) * aim,
    );
  }

  _placeCamera(dt, snap, closer = 0, aim = false) {
    const cam = this.b.camera;
    // 追うのは「足元の位置」。描画上のモデル位置を追うと、
    // アニメーションの上下がそのまま画面の揺れになる。
    const w = this.walker.pos;
    // 釣っている間は少し寄る(closer > 0)。手応えが伝わるように
    const dist = this.camDist * (1 - closer * 0.35);
    const h = Math.sin(this.camPitch) * dist;
    const flat = Math.cos(this.camPitch) * dist;
    const groundY = this.ground(w.x, w.z).y;
    // ジャンプには半分だけ付いていく。1:1 で追うと画面全体が跳ねて酔うし、
    // 全く追わないと跳んだ本人が画面から出ていく。
    // 立っているときは y = 0 なので、歩いている間の揺れはこれまでどおり無い。
    //
    // 逆に、海へ落ちるとき(y < 0)は丸ごと付いていく。カメラも一緒に潜って、
    // 沈んでいくところを水の中から見せたいため。
    const my = this.walker.motion.y;
    // 水中はカメラをわざと沈み遅れさせる。同じ速さで下ろすと本人が画面に
    // 貼りついたままで、沈んでいる感じが出ない(水面だけが遠ざかる)。
    const lift = my > 0 ? my * 0.5
      : (my > WATER_Y ? my : WATER_Y + (my - WATER_Y) * 0.72);

    // 沈むにつれてカメラを本人の高さまで下ろす。見下ろしたままだと
    // カメラが水面より下に来るのが最後の一瞬だけになり、水中が見えない。
    const dive = Math.max(0, Math.min(1, -my / 0.6));  // 沈む深さは盤の寸法
    const eye = (sc(0.42) + h) * (1 - dive) + sc(0.16) * dive;

    // 弓を構えている間は肩の横へずらす。**見る先も同じだけずらす**ので、
    // 視線の向きは変わらず、本人だけが画面の端へどく ── ずらすのを
    // カメラの位置だけにすると、体が中心に残ったまま斜めから見るだけになる。
    const sx = aim ? Math.cos(this.camYaw) * AIM_SIDE : 0;
    const sz = aim ? -Math.sin(this.camYaw) * AIM_SIDE : 0;
    const want = new THREE.Vector3(
      w.x + sx - Math.sin(this.camYaw) * flat,
      groundY + lift + eye,
      w.z + sz - Math.cos(this.camYaw) * flat,
    );
    if (snap) cam.position.copy(want);
    else cam.position.lerp(want, smooth(9, dt));
    cam.lookAt(
      w.x + sx,
      groundY + lift + sc(0.36) * (1 - dive) + sc(0.1) * dive,
      w.z + sz,
    );
  }

  // いま立っているヘックスの地形(HUD に出す)
  // 足音を1つ鳴らす。地面の種類はここで見て、音そのものは外に任せる。
  // gait は歩く速さ(0〜1)。ゆっくり歩けば小さい音になる。
  _step(motion, gait = 1) {
    if (!this.onStep) return;
    const g = this.ground(this.walker.pos.x, this.walker.pos.z);
    const terrain = g.hexId ? this.terrainAt?.(g.hexId) : null;
    // 同じ音が続くと機械的に聞こえるので、1歩ごとに少し振る。
    // 演出だけの乱数なので Math.random でよい(対戦の乱数には触れない)。
    this.onStep(terrain, motion, Math.random() * 2 - 1, gait);
  }

  // ヘックスの中心(E2E で「このタイルの上に立たせる」のに使う)
  hexCenter(hid) {
    const c = hexCenter(hid);
    return c ? { x: c.x, z: c.y } : null;
  }

  standingOn(state) {
    const g = this.ground(this.walker.pos.x, this.walker.pos.z);
    if (!g.hexId) return null;
    const hex = state.board.hexes[g.hexId];
    return hex ? { hexId: g.hexId, terrain: hex.terrain, token: hex.token ?? null } : null;
  }

  // 相手を動かし、自分の位置を送る。1人で歩いているときは何もしない。
  _netFrame(dt, t) {
    if (this.seat != null) {
      const p = this._posPacket(t);
      if (p) this.onPos(p);
    }
    // 弓を構えている間は相手を描かない。**同じ櫓に全員が立つ**ので、
    // そのままだと相手の体と名札が射線の真ん中を塞ぐ。船はひとりずつ
    // 別に湧いていて(同じ波を各自が迎え撃つ)、相手の居場所は狙いに
    // 関係しないので、消しても失うものがない。
    // 誰も居なければ sample は空を返すので、そのまま呼んでよい
    this.remoteView.update(dt, this.raid ? [] : this.remote.sample());
  }

  // ---- 散策部屋 ----

  // サーバーから届いた「全員ぶん」。自分の席は描かない
  putWalkers(people) {
    this.remote.push(people);
    if (this.seat != null) this.remote.forget(this.seat);
  }

  setWalkerNames(seats) {
    this.remote.setNames(seats);
  }

  // いまの自分を送る中身。変わっていなければ null(立ち止まりは送らない)
  _posPacket(now) {
    if (!this.onPos || this.seat == null) return null;
    if (now - this._sendAt < SEND_MS) return null;
    const w = this.walker;
    const m = w.motion;
    const st = this.fishing ? ST.fish
      : m.falling ? ST.fall
        : m.grounded ? ST.walk : ST.air;
    const p = [w.pos.x, w.pos.z, m.y, w.facing, st, this.emote ? this.emote.id : 0];
    const last = this._sent;
    const still = last
      && Math.abs(p[0] - last[0]) < SEND_MOVE
      && Math.abs(p[1] - last[1]) < SEND_MOVE
      && Math.abs(p[2] - last[2]) < SEND_MOVE
      && Math.abs(p[3] - last[3]) < SEND_TURN
      && p[4] === last[4]
      // エモートの出し始め・終わりは、立ち止まっていても必ず送る
      && p[5] === last[5];
    this._sendAt = now;
    if (still) return null;
    this._sent = p;
    return p;
  }

  dispose() {
    this.b.onFrame = null;
    for (const { o, scale } of this.signs) o.scale.copy(scale);  // 港の看板を戻す
    for (const { o, vis } of this.clearedObjs) o.visible = vis;  // 片付けた木を戻す
    this._nestRestore();                                         // 巣の竜を盤に返す
    this.setDragon(null);
    this.desk?.dispose();
    this.archeryFx?.dispose();
    this.walker.dispose();
    this.remoteView.dispose();
    this.fx.dispose();
    this.ffx.dispose();
    if (this.b.seaMesh) this.b.seaMesh.material.side = THREE.FrontSide;
    const cam = this.b.camera;
    cam.position.copy(this.saved.pos);
    cam.near = this.saved.near;
    cam.fov = this.saved.fov;
    cam.updateProjectionMatrix();
    this.b.controls.target.copy(this.saved.target);
    this.b.controls.enabled = this.saved.controls;
    if (this.b.scene.fog && this.saved.fog != null) {
      this.b.scene.fog.near = this.saved.fog;
      this.b.scene.fog.far = this.saved.fogFar;
    }
    this.b.controls.update();
  }
}
