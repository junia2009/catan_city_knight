// Durable Object: 合言葉ごとに1つ。部屋の権威的な状態を持ち、WebSocket で配信する。
// ゲームのロジックは RoomCore(トランスポート非依存)に閉じているので、
// ここは「接続の管理」と「いつ誰に何を送るか」だけを担当する。

import { RoomCore } from './room-core.js';

// CPU / 切断中の席をサーバーが打つときの間合い(ローカル戦の演出と揃える)
const AUTO_DELAY_MS = 650;
const AUTO_DELAY_SETUP_MS = 450;
// 全員切断のまま放置された部屋を畳むまで
const IDLE_SWEEP_MS = 30 * 60 * 1000;

export class RoomDO {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
    this.room = null;
    this.sockets = new Map(); // WebSocket -> clientId
    this.autoTimer = null;
    this.ready = ctx.blockConcurrencyWhile(async () => {
      const saved = await ctx.storage.get('room');
      if (saved) this.room = RoomCore.fromJSON(saved);
    });
  }

  async fetch(request) {
    await this.ready;
    const url = new URL(request.url);
    const code = url.searchParams.get('code') ?? 'ROOM';

    // 合言葉の確保(新規作成時): まだ誰も使っていなければ true
    if (url.pathname.endsWith('/claim')) {
      if (this.room) return Response.json({ free: false });
      this.room = new RoomCore({ code });
      await this.save();
      // 誰も入らないまま放置された部屋も掃除対象にする(合言葉を空けるため)
      this.ctx.storage.setAlarm(Date.now() + IDLE_SWEEP_MS);
      return Response.json({ free: true, code });
    }

    if (request.headers.get('Upgrade') !== 'websocket') {
      return new Response('WebSocket が必要です', { status: 426 });
    }
    if (!this.room) {
      this.room = new RoomCore({ code });
      await this.save();
      this.ctx.storage.setAlarm(Date.now() + IDLE_SWEEP_MS);
    }

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    server.accept();
    this.wire(server);
    return new Response(null, { status: 101, webSocket: client });
  }

  wire(ws) {
    ws.addEventListener('message', (ev) => {
      let msg;
      try {
        msg = JSON.parse(ev.data);
      } catch {
        return this.send(ws, { t: 'error', msg: '不正なメッセージです' });
      }
      this.onMessage(ws, msg).catch((e) => {
        this.send(ws, { t: 'error', msg: e.message ?? 'サーバーエラー' });
      });
    });
    const bye = () => this.onClose(ws);
    ws.addEventListener('close', bye);
    ws.addEventListener('error', bye);
  }

  async onMessage(ws, msg) {
    const room = this.room;
    const clientId = this.sockets.get(ws);

    if (msg.t === 'hello') {
      const res = room.join({ clientId: msg.clientId, name: msg.name });
      if (res.error) return this.send(ws, { t: 'error', msg: res.error, fatal: true });
      // 同じ人の古い接続は切る(タブの開き直しなど)
      for (const [sock, id] of this.sockets) {
        if (id === msg.clientId && sock !== ws) {
          this.sockets.delete(sock);
          try { sock.close(1000, '別の接続に置き換えました'); } catch { /* 済 */ }
        }
      }
      this.sockets.set(ws, msg.clientId);
      this.send(ws, { t: 'joined', seat: res.seat, code: room.code, you: msg.clientId });
      this.broadcastLobby();
      if (room.phase === 'playing') this.sendState(ws, res.seat, null);
      this.pumpAuto();
      await this.save();
      return;
    }

    if (!clientId) return this.send(ws, { t: 'error', msg: 'まず参加してください' });

    if (msg.t === 'ping') return this.send(ws, { t: 'pong' });

    if (msg.t === 'settings') {
      const res = room.setSettings(clientId, msg.settings);
      if (res.error) return this.send(ws, { t: 'error', msg: res.error });
      this.broadcastLobby();
      return this.save();
    }

    if (msg.t === 'start') {
      const res = room.start(clientId);
      if (res.error) return this.send(ws, { t: 'error', msg: res.error });
      this.broadcastLobby();
      this.broadcastState(null);
      this.pumpAuto();
      return this.save();
    }

    if (msg.t === 'action') {
      const res = room.submitAction(clientId, msg.action);
      if (res.error) {
        this.send(ws, { t: 'error', msg: res.error });
        // 取りこぼしで食い違っている可能性があるので正しい状態を送り直す
        const seat = room.seatOf(clientId);
        if (seat >= 0 && room.phase === 'playing') this.sendState(ws, seat, null);
        return;
      }
      this.broadcastState(res.action);
      this.pumpAuto();
      return this.save();
    }

    return this.send(ws, { t: 'error', msg: `不明なメッセージ: ${msg.t}` });
  }

  onClose(ws) {
    const clientId = this.sockets.get(ws);
    if (!clientId) return;
    this.sockets.delete(ws);
    // 同じ人が別の接続で生きているなら切断扱いにしない
    if ([...this.sockets.values()].includes(clientId)) return;
    this.room.disconnect(clientId);
    this.broadcastLobby();
    this.pumpAuto(); // 切断した席はサーバーが肩代わりして進める
    this.save();
    if (this.room.isDeserted()) {
      this.ctx.storage.setAlarm(Date.now() + IDLE_SWEEP_MS);
    }
  }

  // 誰も戻ってこなかった部屋を片付ける
  async alarm() {
    await this.ready;
    if (this.room && this.room.isDeserted()) {
      await this.ctx.storage.deleteAll();
      this.room = null;
    }
  }

  // ---- 自動進行 ----

  // CPU席・切断中の席がある限り、一定間隔で1手ずつ進めて配信する
  pumpAuto() {
    if (this.autoTimer) return;
    const room = this.room;
    if (room.phase !== 'playing' || room.autoPlayer() == null) return;
    const delay = room.state.phase === 'setup' ? AUTO_DELAY_SETUP_MS : AUTO_DELAY_MS;
    this.autoTimer = setTimeout(() => {
      this.autoTimer = null;
      const res = room.stepAuto();
      if (res?.ok) {
        this.broadcastState(res.action);
        this.save();
      }
      this.pumpAuto();
    }, delay);
  }

  // ---- 送信 ----

  send(ws, obj) {
    try {
      ws.send(JSON.stringify(obj));
    } catch {
      this.sockets.delete(ws);
    }
  }

  broadcastLobby() {
    const info = this.room.lobbyInfo();
    for (const ws of this.sockets.keys()) this.send(ws, { t: 'lobby', ...info });
  }

  sendState(ws, seat, action) {
    this.send(ws, {
      t: 'state',
      v: this.room.version,
      seat,
      state: this.room.viewFor(seat),
      action,
    });
  }

  // 席ごとに伏せ方が違うので、接続ごとに作って送る
  broadcastState(action) {
    for (const [ws, clientId] of this.sockets) {
      const seat = this.room.seatOf(clientId);
      if (seat < 0) continue;
      this.sendState(ws, seat, action);
    }
  }

  save() {
    return this.ctx.storage.put('room', this.room.toJSON());
  }
}
