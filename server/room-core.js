// 部屋のロジック(トランスポート非依存)
// WebSocket にも Durable Object にも依存しないので node --test で直接検証できる。
// Durable Object(room-do.js)とローカル開発サーバーはこのクラスを包むだけ。
//
// 権威はサーバー側にある: クライアントは「自分の席のアクション」を送るだけで、
// 合法性の判定と乱数は全てここで行い、席ごとに伏せた状態を配る。

import { createGame } from '../src/state.js';
import { dispatch, validateAction } from '../src/actions.js';
import { chooseAction } from '../src/ai/cpu-player.js';
import { totalCards } from '../src/rules/build.js';
import { WALK_SEATS } from '../src/minigame/remote-st.js';
import { cleanSpecies, DEFAULT_SPECIES } from '../src/minigame/species.js';

export const MAX_SEATS = 4;
// 散策部屋(同じ島をみんなで歩く)は対戦の席数に縛られないので多めに取る。
// 増やすほど毎 tick に配る中身が大きくなるので、際限なくは広げないこと。
// 実際の数は画面(案内文・名簿・色)と揃える必要があるので、共有の
// remote-st.js に置いてある。
export const WALK_MAX_SEATS = WALK_SEATS;
export const MIN_PLAYERS = 2;
// 部屋の種類。対戦は権威をサーバーが持つが、散策は「島の種と名簿」だけを配る
export const KINDS = ['game', 'walk'];
// 無操作が続いた部屋を切断するまで。開いたままの部屋は
// サーバーが常駐し続けて無料枠を食うため、放置を自動で畳む。
export const IDLE_DISCONNECT_MS = 60 * 60 * 1000;
// 紛らわしい文字(I/O/0/1)を除いた合言葉用の英字
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
export const CODE_LENGTH = 4;

// 他人のプレイヤー情報から隠し情報を落とす。
// 資源と商品は「枚数だけ公開・内訳は非公開」なので、中身を 0 にして
// 実際の枚数を hiddenCards として渡す(totalCards がこれを見る)。
// hidden: true は「この手札は伏せられている」目印で、クライアント側の
// 先読み判定(相手が出せるか)を通すために使う。最終判定はサーバーが持つ。
function maskPlayer(p, { hand = false, progress = false } = {}) {
  const zero = (obj) => Object.fromEntries(Object.keys(obj).map((k) => [k, 0]));
  const masked = { ...p };
  if (!hand) {
    masked.hidden = true;
    masked.hiddenCards = totalCards(p);
    masked.resources = zero(p.resources);
    if (p.commodities) masked.commodities = zero(p.commodities);
  }
  masked.devCards = p.devCards.map(() => ({ type: 'hidden' }));
  if (!progress) {
    masked.progressCards = p.progressCards.map(() => ({ id: 'hidden', deck: 'hidden' }));
  }
  return masked;
}

// 「相手の手札を見て選ぶ」カードで、選ぶ本人にだけ開く範囲。
// 覗ける中身を awaiting.context に入れると全員に配信されてしまうので、
// 誰の何を開くかだけを見て、この席の配信でだけ伏せを外す。
function revealFor(state, seat) {
  const aw = state.awaiting;
  if (!aw || !aw.players.includes(seat)) return null;
  if (aw.type === 'merchantPick') return { target: aw.context.target, hand: true };
  if (aw.type === 'spyPick') return { target: aw.context.target, progress: true };
  return null;
}

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
  // kind: 'game'(対戦)/ 'walk'(散策)。
  // 散策部屋は対戦を始めないので phase はずっと 'lobby' のまま。島は
  // 「種(seed)+ 島の種類(settings.mode)」から各自が同じものを生成するので、
  // サーバーは盤面も状態も一切持たない(配るのは名簿と位置だけ)。
  constructor({ code = 'ROOM', kind = 'game', seed = null, rand = Math.random } = {}) {
    this.code = code;
    this.kind = KINDS.includes(kind) ? kind : 'game';
    this.rand = rand;
    this.seed = seed ?? Math.floor(rand() * 1e9);
    this.maxSeats = this.kind === 'walk' ? WALK_MAX_SEATS : MAX_SEATS;
    this.phase = 'lobby'; // 'lobby' | 'playing'
    this.seats = Array(this.maxSeats).fill(null); // { clientId, name, online } | null(=CPU席)
    this.hostId = null;
    this.settings = { mode: 'base', difficulty: 'normal', cpuFill: true, diceMode: 'random' };
    this.state = null;
    this.version = 0; // 状態を配るたびに増える(クライアントの取りこぼし検出用)
    this.lastAction = null; // 直前に適用されたアクション(演出の再生用)
    // 最後に「人が操作した」時刻。接続維持の ping や CPU の自動進行は含めない
    // ── 放置された部屋を見分けるのが目的なので、人の意思がある操作だけを数える。
    this.lastActivityAt = Date.now();
  }

  // 人の操作があったことを記録する
  touch(now = Date.now()) {
    this.lastActivityAt = now;
  }

  idleMs(now = Date.now()) {
    return now - this.lastActivityAt;
  }

  isIdle(now = Date.now(), limit = IDLE_DISCONNECT_MS) {
    return this.idleMs(now) >= limit;
  }

  // ---- 席 ----

  seatOf(clientId) {
    return this.seats.findIndex((s) => s && s.clientId === clientId);
  }

  occupiedSeats() {
    return this.seats.filter(Boolean).length;
  }

  // 参加(再接続なら元の席に戻る)
  // look: 散策部屋での「すがた」(species.js の番号)。名前と同じく
  // 変わらない値なので、位置とは別に名簿へ乗せる(毎フレーム送らない)。
  join({ clientId, name, look }) {
    if (!clientId) return { error: '不正な参加者です' };
    this.touch();
    const existing = this.seatOf(clientId);
    if (existing >= 0) {
      this.seats[existing].online = true;
      if (name) this.seats[existing].name = sanitizeName(name, this.seats[existing].name);
      if (look != null) this.seats[existing].look = cleanSpecies(look);
      if (this.hostId == null) this.hostId = clientId;
      return { seat: existing, rejoined: true };
    }
    if (this.phase === 'playing') return { error: '対戦がすでに始まっています' };
    const seat = this.seats.findIndex((s) => s === null);
    if (seat < 0) return { error: '部屋が満席です' };
    this.seats[seat] = {
      clientId,
      name: sanitizeName(name, `プレイヤー${seat + 1}`),
      look: look == null ? DEFAULT_SPECIES : cleanSpecies(look),
      online: true,
    };
    if (this.hostId == null) this.hostId = clientId;
    return { seat, rejoined: false };
  }

  // すがたを変える。島に入ったあとでも変えてよい(相手の画面で作り直される)
  setLook(clientId, look) {
    const seat = this.seatOf(clientId);
    if (seat < 0) return { error: '席がありません' };
    this.seats[seat].look = cleanSpecies(look);
    this.touch();
    return { seat, look: this.seats[seat].look };
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
    this.touch();
    if (this.phase !== 'lobby') return { error: '対戦中は変更できません' };
    const next = { ...this.settings };
    // 散策部屋で変えられるのは島の種類だけ。難度も CPU も関係がない
    if (this.kind === 'walk') {
      if (['base', 'cak', 'dragon', 'fish', 'sea'].includes(patch?.mode)) {
        next.mode = patch.mode;
        // 島の種類を変えたら島も別物にする(同じ種のまま形だけ変わると紛らわしい)
        this.seed = Math.floor(this.rand() * 1e9);
      }
      this.settings = next;
      return { ok: true };
    }
    if (['base', 'cak', 'dragon', 'fish', 'sea'].includes(patch?.mode)) next.mode = patch.mode;
    if (['easy', 'normal', 'hard'].includes(patch?.difficulty)) next.difficulty = patch.difficulty;
    if (typeof patch?.cpuFill === 'boolean') next.cpuFill = patch.cpuFill;
    if (['balanced', 'random'].includes(patch?.diceMode)) next.diceMode = patch.diceMode;
    this.settings = next;
    return { ok: true };
  }

  start(clientId) {
    if (this.kind === 'walk') return { error: '散策部屋に開始はありません' };
    if (!this.isHost(clientId)) return { error: 'ホストのみ開始できます' };
    this.touch();
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
      diceMode: this.settings.diceMode,
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
    for (let i = 0; i < this.maxSeats; i++) this.seats[i] = filled[i] ?? null;
  }

  // ---- アクション ----

  // クライアントからの手。自分の席の手しか出せない。
  submitAction(clientId, action) {
    if (this.kind === 'walk') return { error: '散策部屋では手を出せません' };
    if (this.phase !== 'playing') return { error: '対戦が始まっていません' };
    const seat = this.seatOf(clientId);
    if (seat < 0) return { error: '観戦者は操作できません' };
    if (!action || typeof action !== 'object') return { error: '不正なアクションです' };
    if (action.player !== seat) return { error: '他のプレイヤーの手は出せません' };
    this.touch();
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
      kind: this.kind,
      // 散策部屋は、この種と島の種類から各自が同じ島を作る。
      // 盤面そのものを配るより、はるかに軽い。
      seed: this.kind === 'walk' ? this.seed : undefined,
      phase: this.phase,
      host: this.hostId,
      hostSeat: this.seats.findIndex((s) => s && s.clientId === this.hostId),
      settings: { ...this.settings },
      seats: this.seats.map((s, i) => ({
        seat: i,
        name: s ? s.name : null,
        look: s ? (s.look ?? DEFAULT_SPECIES) : DEFAULT_SPECIES,
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
    const reveal = revealFor(full, seat);
    return {
      ...full,
      rng: 0, // 未来の出目を予測させない
      // バランスダイスの山札も中身は伏せる(残り枚数は公開情報なので長さは保つ)
      diceDeck: Array.isArray(full.diceDeck) ? full.diceDeck.map(() => null) : [],
      bank: {
        ...full.bank,
        devDeck: full.bank.devDeck.map(() => null),
        // 魚トークンの山も中身は伏せる(残り枚数は公開。手元の魚は公開情報なので伏せない)
        fishPool: full.bank.fishPool ? full.bank.fishPool.map(() => null) : null,
        progressDecks: full.bank.progressDecks
          ? Object.fromEntries(
              Object.entries(full.bank.progressDecks).map(([k, v]) => [k, v.map(() => null)]),
            )
          : null,
      },
      players: full.players.map((p) => {
        if (p.id === seat) return p;
        if (reveal && reveal.target === p.id) return maskPlayer(p, reveal);
        return maskPlayer(p);
      }),
    };
  }

  // 保存・復元(Durable Object の再起動をまたぐ)
  toJSON() {
    return {
      code: this.code,
      kind: this.kind,
      seed: this.seed,
      phase: this.phase,
      seats: this.seats,
      hostId: this.hostId,
      settings: this.settings,
      state: this.state,
      version: this.version,
      lastActivityAt: this.lastActivityAt,
    };
  }

  static fromJSON(data) {
    const room = new RoomCore({ code: data.code, kind: data.kind, seed: data.seed });
    room.phase = data.phase;
    room.seats = data.seats;
    room.hostId = data.hostId;
    room.settings = data.settings;
    room.state = data.state;
    room.version = data.version ?? 0;
    room.lastActivityAt = data.lastActivityAt ?? Date.now();
    // 復元直後は全員切断扱い(再接続を待つ)
    for (const s of room.seats) if (s) s.online = false;
    return room;
  }
}
