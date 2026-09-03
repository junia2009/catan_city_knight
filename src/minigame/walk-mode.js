// 「島を歩く」モード。
//
// 対戦用に作った島(Board3D のシーン)にそのまま相乗りする。海も空も木も港も
// すでにあるので、足すのは棒人間・追従カメラ・操作だけ。
// レンダラーと requestAnimationFrame は Board3D のものを使う
// (WebGL コンテキストを2つ持つとモバイルで重すぎるため)。

import * as THREE from 'three';
import {
  makeGround, spawnPoint, fishingSpots, spotNear, hexCenter,
  DESK_RADIUS, DESK_REACH,
} from './ground.js';
import { makeBlocker } from './obstacles.js';
import { MAX_DT, SINK_DEPTH, WATER_Y } from './motion.js';
import { Walker, WALK_SPEED } from './walker.js';
import { WaterFx } from './water-fx.js';
import { Fishing, CAST_TIME } from './fishing.js';
import { FishingFx } from './fishing-fx.js';
import { RemoteWalkers } from './remote.js';
import { RemoteView, WALK_COLORS } from './remote-view.js';
import { ST } from './remote-st.js';
import { emoteById } from './emote.js';
import { speciesById, DEFAULT_SPECIES } from './species.js';
import { makeDesk } from './desk.js';
import { meetFor } from './meets.js';
import { WALK_SCALE, s as sc } from './scale.js';

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
    // h も持たせる。跳んで足が越えていれば、その物は当たらなくなる
    list.push({ x: center.x, z: center.z, r, h });
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
    if (this.meet) {
      // 席ごとの立ち位置は中心から輪の上へずらしてあるので、台とは重ならない
      const home = spawnPoint(state);
      this.deskAt = { x: home.x, z: home.y };
      this.desk = makeDesk(board3d.scene, home.x, home.y, this.ground(home.x, home.y).y, this.meet);
      // 台にもぶつかるようにする。collectObstacles はシーンを見て集めるので、
      // あとから足したものは自分で入れる必要がある。
      this.obstacles.push({ x: home.x, z: home.y, r: DESK_RADIUS, h: sc(0.62) });
    }
    this.atDesk = false;
    this.onDesk = null;      // 受付に入った/出た
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
    // 距離だけ縮めるとカメラが地面すれすれまで下りて、手前の地形が画面を
    // 埋める(縮尺を下げるほどひどくなる)。見下ろす角度も一緒に起こす。
    this.camPitch = 0.62;
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

  // ---- 操作 ----

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

    if (this.fishing) {
      this._fishFrame(dt);
      return;
    }

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

  _placeCamera(dt, snap, closer = 0) {
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

    const want = new THREE.Vector3(
      w.x - Math.sin(this.camYaw) * flat,
      groundY + lift + eye,
      w.z - Math.cos(this.camYaw) * flat,
    );
    if (snap) cam.position.copy(want);
    else cam.position.lerp(want, smooth(9, dt));
    cam.lookAt(w.x, groundY + lift + sc(0.36) * (1 - dive) + sc(0.1) * dive, w.z);
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
    // 誰も居なければ sample は空を返すので、そのまま呼んでよい
    this.remoteView.update(dt, this.remote.sample());
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
    this.desk?.dispose();
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
