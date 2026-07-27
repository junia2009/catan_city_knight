// 部屋のロジック(トランスポート非依存)
// WebSocket にも Durable Object にも依存しないので node --test で直接検証できる。
// Durable Object(room-do.js)とローカル開発サーバーはこのクラスを包むだけ。
//
// 権威はサーバー側にある: クライアントは「自分の席のアクション」を送るだけで、
// 合法性の判定と乱数は全てここで行い、席ごとに伏せた状態を配る。

import { createGame } from '../src/state.js';
import { dispatch, validateAction } from '../src/actions.js';
import { chooseAction } from '../src/ai/cpu-player.js';

export const MAX_SEATS = 4;
export const MIN_PLAYERS = 2;
// 紛らわしい文字(I/O/0/1)を除いた合言葉用の英字
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
export const CODE_LENGTH = 4;

export function makeRoomCode(rand = Math.random) {
  let s = '';
  for (let i = 0; i < CODE_LENGTH; i++) {
    s += CODE_ALPHABET[Math.floor(rand() * CODE_ALPHABET.length)];
  }
  return s;
}

export function normalizeRoomCode(code) {
  return String(code ?? '').toUpperCase().replace(/[^A-Z]/g, '').slice(0, CODE_LENGTH);
}

function sanitizeName(name, fallback) {
  const s = String(name ?? '').replace(/\s+/g, ' ').trim().slice(0, 12);
  return s || fallback;
}

export class RoomCore {
  constructor({ code = 'ROOM', seed = null, rand = Math.random } = {}) {
    this.code = code;
    this.rand = rand;
    this.seed = seed ?? Math.floor(rand() * 1e9);
    this.phase = 'lobby'; // 'lobby' | 'playing'
    this.seats = Array(MAX_SEATS).fill(null); // { clientId, name, online } | null(=CPU席)
    this.hostId = null;
    this.settings = { mode: 'cak', difficulty: 'normal', cpuFill: true };
    this.state = null;
    this.version = 0; // 状態を配るたびに増える(クライアントの取りこぼし検出用)
    this.lastAction = null; // 直前に適用されたアクション(演出の再生用)
  }

  // ---- 席 ----

  seatOf(clientId) {
    return this.seats.findIndex((s) => s && s.clientId === clientId);
  }

  occupiedSeats() {
    return this.seats.filter(Boolean).length;
  }

  // 参加(再接続なら元の席に戻る)
  join({ clientId, name }) {
    if (!clientId) return { error: '不正な参加者です' };
    const existing = this.seatOf(clientId);
    if (existing >= 0) {
      this.seats[existing].online = true;
      if (name) this.seats[existing].name = sanitizeName(name, this.seats[existing].name);
      if (this.hostId == null) this.hostId = clientId;
      return { seat: existing, rejoined: true };
    }
    if (this.phase === 'playing') return { error: '対戦がすでに始まっています' };
    const seat = this.seats.findIndex((s) => s === null);
    if (seat < 0) return { error: '部屋が満席です' };
    this.seats[seat] = {
      clientId,
      name: sanitizeName(name, `プレイヤー${seat + 1}`),
      online: true,
    };
    if (this.hostId == null) this.hostId = clientId;
    return { seat, rejoined: false };
  }

  // 切断。対戦中は席を残し(再接続で復帰)、ロビーなら席を空ける。
  disconnect(clientId) {
    const seat = this.seatOf(clientId);
    if (seat < 0) return;
    if (this.phase === 'playing') {
      this.seats[seat].online = false;
    } else {
      this.seats[seat] = null;
    }
    if (this.hostId === clientId) this.hostId = this._nextHost();
  }

  _nextHost() {
    const s = this.seats.find((x) => x && x.online);
    return s ? s.clientId : null;
  }

  isHost(clientId) {
    return this.hostId != null && this.hostId === clientId;
  }

  // 誰も繋がっていない(部屋を畳んでよい)
  isDeserted() {
    return !this.seats.some((s) => s && s.online);
  }

  // ---- 設定と開始(ホストのみ)----

  setSettings(clientId, patch) {
    if (!this.isHost(clientId)) return { error: 'ホストのみ変更できます' };
    if (this.phase !== 'lobby') return { error: '対戦中は変更できません' };
    const next = { ...this.settings };
    if (['base', 'cak', 'dragon'].includes(patch?.mode)) next.mode = patch.mode;
    if (['easy', 'normal', 'hard'].includes(patch?.difficulty)) next.difficulty = patch.difficulty;
    if (typeof patch?.cpuFill === 'boolean') next.cpuFill = patch.cpuFill;
    this.settings = next;
    return { ok: true };
  }

  start(clientId) {
    if (!this.isHost(clientId)) return { error: 'ホストのみ開始できます' };
    if (this.phase !== 'lobby') return { error: 'すでに始まっています' };
    const humans = this.occupiedSeats();
    if (humans < 1) return { error: '参加者がいません' };
    // CPU で埋めない場合は席を詰めて人数を決める
    const playerCount = this.settings.cpuFill ? MAX_SEATS : humans;
    if (playerCount < MIN_PLAYERS) {
      return { error: `${MIN_PLAYERS}人以上で開始できます(CPUを入れると1人でも可)` };
    }
    if (!this.settings.cpuFill) this._compactSeats();

    const names = [];
    for (let i = 0; i < playerCount; i++) {
      names.push(this.seats[i] ? this.seats[i].name : `CPU ${i}`);
    }
    // humanIndex: -1 で全員CPUとして作り、着席している席だけ人間に変える
    this.state = createGame({
      seed: this.seed,
      playerCount,
      humanIndex: -1,
      names,
      mode: this.settings.mode,
      difficulty: this.settings.difficulty,
    });
    for (let i = 0; i < playerCount; i++) {
      this.state.players[i].isCPU = !this.seats[i];
    }
    // 使わない席は空ける
    for (let i = playerCount; i < MAX_SEATS; i++) this.seats[i] = null;
    this.phase = 'playing';
    this.version++;
    this.lastAction = null;
    return { ok: true };
  }

  _compactSeats() {
    const filled = this.seats.filter(Boolean);
    for (let i = 0; i < MAX_SEATS; i++) this.seats[i] = filled[i] ?? null;
  }

  // ---- アクション ----

  // クライアントからの手。自分の席の手しか出せない。
  submitAction(clientId, action) {
    if (this.phase !== 'playing') return { error: '対戦が始まっていません' };
    const seat = this.seatOf(clientId);
    if (seat < 0) return { error: '観戦者は操作できません' };
    if (!action || typeof action !== 'object') return { error: '不正なアクションです' };
    if (action.player !== seat) return { error: '他のプレイヤーの手は出せません' };
    return this._apply(action);
  }

  _apply(action) {
    const err = validateAction(this.state, action);
    if (err) return { error: err };
    try {
      this.state = dispatch(this.state, action);
    } catch (e) {
      return { error: e.message };
    }
    this.version++;
    this.lastAction = action;
    return { ok: true, action };
  }

  // ---- 自動進行(CPU席 + 切断中の席)----

  // サーバーが代わりに打つべきプレイヤー(いなければ null)
  autoPlayer() {
    if (this.phase !== 'playing' || this.state.phase === 'ended') return null;
    const isAuto = (pid) => !this.seats[pid] || !this.seats[pid].online;
    if (this.state.awaiting) {
      return this.state.awaiting.players.find(isAuto) ?? null;
    }
    const cur = this.state.currentPlayer;
    return isAuto(cur) ? cur : null;
  }

  // 自動プレイを1手進める。進めたら { ok, action }、対象がいなければ null。
  stepAuto() {
    const pid = this.autoPlayer();
    if (pid == null) return null;
    const action = chooseAction(this.state, pid);
    if (!action) return null;
    const res = this._apply(action);
    if (res.error) {
      // 打てない手が返った場合は手番終了で復帰を試みる(ローカル戦と同じ安全弁)
      const fallback = this._apply({ type: 'END_TURN', player: pid });
      return fallback.error ? null : fallback;
    }
    return res;
  }

  // ---- 配信用の見え方 ----

  lobbyInfo() {
    return {
      code: this.code,
      phase: this.phase,
      host: this.hostId,
      hostSeat: this.seats.findIndex((s) => s && s.clientId === this.hostId),
      settings: { ...this.settings },
      seats: this.seats.map((s, i) => ({
        seat: i,
        name: s ? s.name : null,
        online: s ? s.online : false,
        occupied: !!s,
      })),
    };
  }

  // seat から見た状態。他人の手札と山札・乱数種は伏せる。
  // 決着後は全公開(隠し勝利点を含む最終得点を正しく出すため)。
  viewFor(seat) {
    if (!this.state) return null;
    const full = this.state;
    if (full.phase === 'ended') return full;
    const hiddenList = (arr, filler) => arr.map(() => ({ ...filler }));
    return {
      ...full,
      rng: 0, // 未来の出目を予測させない
      bank: {
        ...full.bank,
        devDeck: full.bank.devDeck.map(() => null),
        progressDecks: full.bank.progressDecks
          ? Object.fromEntries(
              Object.entries(full.bank.progressDecks).map(([k, v]) => [k, v.map(() => null)]),
            )
          : null,
      },
      players: full.players.map((p) =>
        p.id === seat
          ? p
          : {
              ...p,
              devCards: hiddenList(p.devCards, { type: 'hidden' }),
              progressCards: hiddenList(p.progressCards, { id: 'hidden', deck: 'hidden' }),
            },
      ),
    };
  }

  // 保存・復元(Durable Object の再起動をまたぐ)
  toJSON() {
    return {
      code: this.code,
      seed: this.seed,
      phase: this.phase,
      seats: this.seats,
      hostId: this.hostId,
      settings: this.settings,
      state: this.state,
      version: this.version,
    };
  }

  static fromJSON(data) {
    const room = new RoomCore({ code: data.code, seed: data.seed });
    room.phase = data.phase;
    room.seats = data.seats;
    room.hostId = data.hostId;
    room.settings = data.settings;
    room.state = data.state;
    room.version = data.version ?? 0;
    // 復元直後は全員切断扱い(再接続を待つ)
    for (const s of room.seats) if (s) s.online = false;
    return room;
  }
}
