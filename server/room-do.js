// Durable Object: 合言葉ごとに1つ。部屋の権威的な状態を持ち、WebSocket で配信する。
// ゲームのロジックは RoomCore(トランスポート非依存)に閉じているので、
// ここは「接続の管理」と「いつ誰に何を送るか」だけを担当する。

import { RoomCore, IDLE_DISCONNECT_MS } from './room-core.js';
import { WalkRelay, TICK_MS } from './walk-relay.js';
import { FishingContest } from './fishing-contest.js';
import { DragonHunt } from './dragon-hunt.js';
import { hasMeet, meetFor } from '../src/minigame/meets.js';
import { spawnPoint } from '../src/minigame/ground.js';
import { createGame } from '../src/state.js';

// 島ごとの進行。表(src/minigame/meets.js)の id で引く。
// 表に足したのにここへ書き忘れると、受付は立つのに何も始まらない島ができる
// ── test/meets.test.js がその食い違いを見張っている。
const ENGINES = { fishing: FishingContest, dragonhunt: DragonHunt };

// CPU / 切断中の席をサーバーが打つときの間合い(ローカル戦の演出と揃える)
const AUTO_DELAY_MS = 650;
const AUTO_DELAY_SETUP_MS = 450;
// 全員切断のまま放置された部屋を畳むまで
const IDLE_SWEEP_MS = 30 * 60 * 1000;

// 切断理由に入れる時間の表記(「60分間」より「1時間」の方が伝わる)
function humanDuration(ms) {
  const mins = Math.max(1, Math.round(ms / 60000));
  if (mins < 60) return `${mins}分間`;
  const hours = mins / 60;
  return Number.isInteger(hours) ? `${hours}時間` : `${mins}分間`;
}

export class RoomDO {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
    this.room = null;
    this.sockets = new Map(); // WebSocket -> clientId
    this.autoTimer = null;
    // 散策部屋の位置。メモリだけに持ち、storage には絶対に書かない
    // (次の瞬間には古くなる値なので、書くと遅くて高いだけ)
    this.walk = new WalkRelay();
    this.walkTimer = null;
    // 島の集まり。進行(締め切り・順位・竜の位置)はサーバーが持つ。
    // 受付の無い島では null。
    this.contest = null;
    // 無操作で切断するまでの時間。テストで短くできるよう環境変数で上書き可能。
    this.idleLimitMs = Number(env?.IDLE_DISCONNECT_MS) || IDLE_DISCONNECT_MS;
    this.ready = ctx.blockConcurrencyWhile(async () => {
      const saved = await ctx.storage.get('room');
      if (saved) this.room = RoomCore.fromJSON(saved);
      const c = await ctx.storage.get('contest');
      // 島に合う進行だけ読み戻す。島を変えたあとの保存が残っていても、
      // 別の遊びの状態を持ち込まない(kind で確かめる)。
      this.contest = this.makeMeet(this.room?.settings?.mode);
      if (c && this.contest && c.kind === this.contest.kind) {
        this.contest = ENGINES[c.kind].fromJSON(c);
        this.primeMeet();
      }
    });
  }

  // 島に合う進行を作る。受付の無い島では null。
  makeMeet(mode) {
    const m = meetFor(mode);
    const Engine = m && ENGINES[m.id];
    // **必ず入れ替える。** 受付の無い島に変えたとき、ここで戻るだけにすると
    // 前の島の大会が走ったまま残って、誰も居ない島の順位が配られ続ける。
    this.contest = null;
    if (!Engine) return null;
    const e = new Engine();
    this.contest = e;
    this.primeMeet();
    return e;
  }

  // 島の形に依るものを進行に渡す。サーバーは盤を持たないので、
  // 必要になったぶんだけここで求める(いまは竜の飛び立つ場所だけ)。
  primeMeet() {
    if (!this.contest?.setHome) return;
    // 島はクライアントと同じ「種 + 島の種類」から作る(main.js の
    // makeWalkIsland と同じ引数でないと、竜が別の島の中心から飛び立つ)。
    const r = this.room;
    if (!r) return;
    const state = createGame({
      seed: r.seed, playerCount: 4, humanIndex: -1, mode: r.settings.mode,
    });
    const home = spawnPoint(state);
    this.contest.setHome(home.x, home.y);
  }

  async fetch(request) {
    await this.ready;
    const url = new URL(request.url);
    const code = url.searchParams.get('code') ?? 'ROOM';
    // 対戦の部屋か、散策の部屋か。作るときにだけ効く(既にある部屋は変えない)
    const kind = url.searchParams.get('kind') === 'walk' ? 'walk' : 'game';

    // 合言葉の確保(新規作成時): まだ誰も使っていなければ true
    if (url.pathname.endsWith('/claim')) {
      if (this.room) return Response.json({ free: false });
      this.room = new RoomCore({ code, kind });
      await this.save();
      // 誰も入らないまま放置された部屋も掃除対象にする(合言葉を空けるため)
      this.ctx.storage.setAlarm(Date.now() + IDLE_SWEEP_MS);
      return Response.json({ free: true, code });
    }

    if (request.headers.get('Upgrade') !== 'websocket') {
      return new Response('WebSocket が必要です', { status: 426 });
    }
    if (!this.room) {
      this.room = new RoomCore({ code, kind });
      await this.save();
      this.ctx.storage.setAlarm(Date.now() + IDLE_SWEEP_MS);
    }

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    server.accept();
    this.wire(server);
    // 見張りの予約は hello(着席)後に行う。この時点ではまだ誰も席にいないため、
    // ここで予約すると「無人の部屋」と見なされて遠い時刻になってしまう。
    return new Response(null, { status: 101, webSocket: client });
  }

  // 次に様子を見る時刻を決める。接続があれば無操作の期限、
  // 誰もいなければ部屋を畳む期限。
  scheduleAlarm() {
    if (!this.room) return;
    const base = this.room.lastActivityAt;
    const at = this.room.isDeserted() ? base + IDLE_SWEEP_MS : base + this.idleLimitMs;
    return this.ctx.storage.setAlarm(at);
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
      const res = room.join({ clientId: msg.clientId, name: msg.name, look: msg.look });
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
      // 大会のいまの様子も渡す。変わったときだけ配っていると、あとから
      // 来た人はいつまでも受付を見られない(実際そうなっていた)。
      if (room.kind === 'walk' && this.contest) {
        this.send(ws, { t: 'contest', contest: this.contest.view() });
      }
      if (room.phase === 'playing') this.sendState(ws, res.seat, null);
      this.pumpAuto();
      this.scheduleAlarm(); // 着席したので、ここから放置を見張る
      await this.save();
      return;
    }

    if (!clientId) return this.send(ws, { t: 'error', msg: 'まず参加してください' });

    if (msg.t === 'ping') return this.send(ws, { t: 'pong' });

    // すがたを変えた。名簿を配り直せば、みんなの画面で体が作り直される
    if (msg.t === 'look') {
      const res = room.setLook(clientId, msg.look);
      if (res.error) return this.send(ws, { t: 'error', msg: res.error });
      this.broadcastLobby();
      return this.save();
    }

    if (msg.t === 'settings') {
      const before = room.settings.mode;
      const res = room.setSettings(clientId, msg.settings);
      if (res.error) return this.send(ws, { t: 'error', msg: res.error });
      // 島を変えると島そのものが別物になる(種も振り直される)し、
      // 開かれるものも変わる。走っている回を残すと、誰も居ない前の島の
      // 順位が配られ続けるので、島に合う進行に作り直す。
      if (room.settings.mode !== before) {
        this.makeMeet(room.settings.mode);
        this.broadcastContest();
        this.saveContest();
      }
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

    // 散策部屋の位置。ここだけは保存もブロードキャストも即時にはしない
    // ── 溜めておいて tick でまとめて配る(N×N 通を避ける)。
    if (msg.t === 'pos') {
      if (room.kind !== 'walk') return;
      const seat = room.seatOf(clientId);
      if (seat < 0) return;
      this.walk.set(clientId, seat, msg.p);
      // 歩いているのは人の操作。放置と見なして切らないように印を付ける
      // (保存はしない。lastActivityAt は見張りが見るだけの値)
      room.touch();
      this.startWalkTick();
      return;
    }

    // 釣り大会。どれも席が要る
    if (msg.t === 'contest') {
      if (room.kind !== 'walk') return;
      // 受付の無い島では何も開かれない。表(src/minigame/meets.js)は
      // クライアントと共有しているので、判定が食い違うことはない。
      if (!this.contest || !hasMeet(room.settings.mode)) {
        return this.send(ws, { t: 'error', msg: 'この島に受付はありません' });
      }
      const seat = room.seatOf(clientId);
      if (seat < 0) return;
      // 中身は進行のほうが知っている。room-do は遊びごとの操作を持たない
      const res = this.contest.command(seat, msg.do, msg);
      if (res.error) return this.send(ws, { t: 'error', msg: res.error });
      room.touch();
      this.broadcastContest();
      this.startWalkTick();   // 大会中は誰も動かなくても時間を進める
      return this.saveContest();
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

  // 散策部屋の配信。溜まった位置を一定間隔で「全員ぶん1通」にして配る。
  // 誰もいなくなったら止める(動いていない部屋でタイマーを回し続けない)。
  startWalkTick() {
    if (this.walkTimer) return;
    let n = 0;
    this.walkTimer = setInterval(() => {
      const people = this.walk.snapshot();
      // 竜は全員の位置を見て動く(dragon-hunt.js)。**進める前に渡す** ──
      // あとで渡すと、竜は常に 1 tick 古い位置を追いかけることになる。
      this.contest?.setPositions?.(people);
      // 時間切れと竜の一歩はここで見る。誰も動いていなくても進む必要がある
      if (this.contest?.tick()) { this.broadcastContest(); this.saveContest(); }
      n += 1;
      // 竜は動き続けるので毎 tick 配る。釣り大会は表が変わらないので、
      // 秒 10 回も配ると通信のほとんどがそれになる ── 毎秒だけにする。
      const busy = this.contest && this.contest.phase !== 'idle';
      if (busy && (this.contest.kind === 'dragonhunt' || n % 10 === 0)) this.broadcastContest();

      if (!people.length) {
        // 開催中は、誰も歩いていなくても止めない
        if (!busy) this.stopWalkTick();
        return;
      }
      // 宛先ごとに作り直さない。自分の席を飛ばすのは受け取った側の仕事
      const line = JSON.stringify({ t: 'walkers', people });
      for (const ws of this.sockets.keys()) {
        try { ws.send(line); } catch { /* 切断済みは close で片付く */ }
      }
    }, TICK_MS);
  }

  broadcastContest() {
    // 受付の無い島に変わったときは **null を配る**。黙っていると、
    // 前の島の大会が走ったままの表がクライアントに残り続ける。
    const line = JSON.stringify({ t: 'contest', contest: this.contest?.view() ?? null });
    for (const ws of this.sockets.keys()) {
      try { ws.send(line); } catch { /* 切断済みは close で片付く */ }
    }
  }

  saveContest() {
    if (!this.contest) return this.ctx.storage.delete('contest');
    return this.ctx.storage.put('contest', this.contest.toJSON());
  }

  stopWalkTick() {
    if (!this.walkTimer) return;
    clearInterval(this.walkTimer);
    this.walkTimer = null;
  }

  onClose(ws) {
    const clientId = this.sockets.get(ws);
    if (!clientId) return;
    this.sockets.delete(ws);
    // 同じ人が別の接続で生きているなら切断扱いにしない
    if ([...this.sockets.values()].includes(clientId)) return;
    this.walk.drop(clientId);
    if (!this.walk.size && (this.contest?.phase ?? 'idle') === 'idle') this.stopWalkTick();
    const seat = this.room.seatOf(clientId);
    if (seat >= 0 && this.contest?.dropSeat(seat)) {
      this.broadcastContest();
      this.saveContest();
    }
    this.room.disconnect(clientId);
    this.broadcastLobby();
    this.pumpAuto(); // 切断した席はサーバーが肩代わりして進める
    this.save();
    this.scheduleAlarm();
  }

  // 放置の見張り。無操作が続いた部屋は切断し、
  // 誰も戻ってこなければ片付ける(サーバーの常駐を止めて無料枠を守る)。
  async alarm() {
    await this.ready;
    if (!this.room) return;

    if (this.room.isDeserted()) {
      if (this.room.idleMs() >= IDLE_SWEEP_MS) {
        await this.ctx.storage.deleteAll();
        this.room = null;
        return;
      }
      return this.scheduleAlarm();
    }

    if (this.room.isIdle(Date.now(), this.idleLimitMs)) {
      this.closeAll(`${humanDuration(this.idleLimitMs)}操作がなかったため切断しました`);
      return this.ctx.storage.setAlarm(Date.now() + IDLE_SWEEP_MS);
    }
    return this.scheduleAlarm();
  }

  // 全員に理由を伝えてから切断する。fatal を立てることで
  // クライアントが自動再接続せず、部屋が復活しないようにする。
  closeAll(reason) {
    clearTimeout(this.autoTimer);
    this.autoTimer = null;
    for (const ws of [...this.sockets.keys()]) {
      this.send(ws, { t: 'error', msg: reason, fatal: true });
      this.sockets.delete(ws);
      try {
        ws.close(1000, reason);
      } catch { /* 済 */ }
    }
    for (const s of this.room.seats) if (s) s.online = false;
    this.save();
  }

  // ---- 自動進行 ----

  // CPU席・切断中の席がある限り、一定間隔で1手ずつ進めて配信する
  pumpAuto() {
    if (this.autoTimer) return;
    const room = this.room;
    if (room.phase !== 'playing' || room.autoPlayer() == null) return;
    // 誰も見ていない部屋で CPU だけが指し続けても無駄に常駐するだけ。
    // 再接続したら pumpAuto が呼ばれて再開する。
    if (room.isDeserted()) return;
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
