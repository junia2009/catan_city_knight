// 「島を歩く」モード。
//
// 対戦用に作った島(Board3D のシーン)にそのまま相乗りする。海も空も木も港も
// すでにあるので、足すのは棒人間・追従カメラ・操作だけ。
// レンダラーと requestAnimationFrame は Board3D のものを使う
// (WebGL コンテキストを2つ持つとモバイルで重すぎるため)。

import * as THREE from 'three';
import { makeGround, spawnPoint } from './ground.js';
import { makeBlocker } from './obstacles.js';
import { MAX_DT, SINK_DEPTH, WATER_Y } from './motion.js';
import { Walker, WALK_SPEED } from './walker.js';
import { WaterFx } from './water-fx.js';

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
const BLOCK_MIN_HEIGHT = 0.15; // これより低い物はまたげる(草・花・畝・砂丘)
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
  constructor(board3d, state) {
    this.b = board3d;
    this.ground = makeGround(state);
    this.obstacles = collectObstacles(board3d);
    this.walker = new Walker(
      board3d.scene, this.ground, 0x2f6fd0, makeBlocker(this.obstacles),
    );

    const s = spawnPoint(state);
    this.walker.setPosition(s.x, s.y);

    this.input = { x: 0, y: 0 };
    this.keys = new Set();
    this.camYaw = 0;
    this.camPitch = 0.42;
    this.camDist = 2.1;
    this.last = 0;
    this.onRespawn = null;
    this.onJump = null;
    this.onSplash = null;
    this.onSink = null;    // 沈み具合(0〜1)。画面を暗くするのに使う
    this.fx = new WaterFx(board3d.scene);

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

  setKey(code, down) {
    if (down) {
      // 押しっぱなしで跳び続けないよう、押した瞬間だけ拾う
      if ((code === 'Space' || code === 'KeyJ') && !this.keys.has(code)) this.jump();
      this.keys.add(code);
    } else {
      this.keys.delete(code);
    }
  }

  jump() { this.walker.motion.jump(); }

  // カメラを回す(画面の右半分のドラッグ / マウスドラッグ)
  orbit(dx, dy) {
    this.camYaw -= dx * 0.006;
    this.camPitch = Math.max(0.05, Math.min(0.9, this.camPitch + dy * 0.004));
  }

  zoom(d) {
    this.camDist = Math.max(1.2, Math.min(5, this.camDist + d));
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
    this.last = t;

    const kb = this._keyInput();
    const inp = (kb.x || kb.y) ? kb : this.input;
    const w = this.walker.pos;
    const r = this.walker.update(dt, inp, this.camYaw);
    if (r?.jumped) this.onJump?.();
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

  _placeCamera(dt, snap) {
    const cam = this.b.camera;
    // 追うのは「足元の位置」。描画上のモデル位置を追うと、
    // アニメーションの上下がそのまま画面の揺れになる。
    const w = this.walker.pos;
    const h = Math.sin(this.camPitch) * this.camDist;
    const flat = Math.cos(this.camPitch) * this.camDist;
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
    const dive = Math.max(0, Math.min(1, -my / 0.6));
    const eye = (0.42 + h) * (1 - dive) + 0.16 * dive;

    const want = new THREE.Vector3(
      w.x - Math.sin(this.camYaw) * flat,
      groundY + lift + eye,
      w.z - Math.cos(this.camYaw) * flat,
    );
    if (snap) cam.position.copy(want);
    else cam.position.lerp(want, smooth(9, dt));
    cam.lookAt(w.x, groundY + lift + 0.36 * (1 - dive) + 0.1 * dive, w.z);
  }

  // いま立っているヘックスの地形(HUD に出す)
  standingOn(state) {
    const g = this.ground(this.walker.pos.x, this.walker.pos.z);
    if (!g.hexId) return null;
    const hex = state.board.hexes[g.hexId];
    return hex ? { hexId: g.hexId, terrain: hex.terrain, token: hex.token ?? null } : null;
  }

  dispose() {
    this.b.onFrame = null;
    this.walker.dispose();
    this.fx.dispose();
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
