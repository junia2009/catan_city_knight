// 「島を歩く」モード。
//
// 対戦用に作った島(Board3D のシーン)にそのまま相乗りする。海も空も木も港も
// すでにあるので、足すのは棒人間・追従カメラ・操作だけ。
// レンダラーと requestAnimationFrame は Board3D のものを使う
// (WebGL コンテキストを2つ持つとモバイルで重すぎるため)。

import * as THREE from 'three';
import { makeGround, spawnPoint } from './ground.js';
import { Walker, WALK_SPEED } from './walker.js';

export class WalkMode {
  constructor(board3d, state) {
    this.b = board3d;
    this.ground = makeGround(state);
    this.walker = new Walker(board3d.scene, this.ground, 0x2f6fd0);

    const s = spawnPoint(state);
    this.walker.setPosition(s.x, s.y);

    this.input = { x: 0, y: 0 };
    this.keys = new Set();
    this.camYaw = 0;
    this.camPitch = 0.42;
    this.camDist = 2.1;
    this.last = 0;
    this.onRespawn = null;

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
    if (down) this.keys.add(code);
    else this.keys.delete(code);
  }

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
    const dt = this.last ? Math.min(0.1, (t - this.last) / 1000) : 0.016;
    this.last = t;

    const kb = this._keyInput();
    const inp = (kb.x || kb.y) ? kb : this.input;
    const r = this.walker.update(dt, inp, this.camYaw);
    if (r?.respawned) this.onRespawn?.();

    // 動いている間は、カメラをゆっくり後ろへ回り込ませる
    const speed = Math.hypot(this.walker.vel.x, this.walker.vel.z);
    if (speed > WALK_SPEED * 0.35) {
      const want = this.walker.facing;
      let d = ((want - this.camYaw + Math.PI) % (Math.PI * 2) + Math.PI * 2) % (Math.PI * 2) - Math.PI;
      this.camYaw += d * Math.min(1, dt * 1.6);
    }
    this._placeCamera(dt, false);
  }

  _placeCamera(dt, snap) {
    const cam = this.b.camera;
    const w = this.walker.parts.group.position;
    const h = Math.sin(this.camPitch) * this.camDist;
    const flat = Math.cos(this.camPitch) * this.camDist;
    const want = new THREE.Vector3(
      w.x - Math.sin(this.camYaw) * flat,
      w.y + 0.42 + h,
      w.z - Math.cos(this.camYaw) * flat,
    );
    if (snap) cam.position.copy(want);
    else cam.position.lerp(want, Math.min(1, dt * 9));
    cam.lookAt(w.x, w.y + 0.36, w.z);
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
