// オンライン対戦のクライアント(WebSocket)
// サーバー(Cloudflare Workers + Durable Objects)とのやりとりを 1 箇所にまとめる。
// ゲームのルール判定は一切ここでは行わない ── 権威はサーバーにある。

import { lsGet, lsSet } from '../storage.js';

// 接続先。デプロイ後の workers.dev URL をここに書く。
// 開発中は ?server=... で上書きでき、localhost では自動でローカルサーバーを見る。
const DEFAULT_SERVER = 'https://catan-web-server.uriboo-dev.workers.dev';

export function serverBase() {
  const override = new URLSearchParams(location.search).get('server');
  if (override) return override.replace(/\/$/, '');
  const saved = lsGet('server');
  if (saved) return saved.replace(/\/$/, '');
  if (['localhost', '127.0.0.1'].includes(location.hostname)) return 'http://127.0.0.1:8787';
  return DEFAULT_SERVER;
}

// 同じ端末は同じ ID を使い続ける(再接続で元の席に戻るため)
export function clientId() {
  let id = lsGet('clientId');
  if (!id) {
    id = `c-${Math.random().toString(36).slice(2)}-${Date.now().toString(36)}`;
    lsSet('clientId', id);
  }
  return id;
}

export function savedName() {
  return lsGet('name') ?? '';
}

export function saveName(name) {
  lsSet('name', name);
}

// 新しい部屋を作って合言葉をもらう
// kind: 'game'(対戦)/ 'walk'(散策)
export async function createRoom(kind = 'game') {
  const res = await fetch(`${serverBase()}/new?kind=${kind}`, { method: 'POST' });
  const data = await res.json();
  if (!res.ok || data.error) throw new Error(data.error ?? '部屋を作れませんでした');
  return data.code;
}

const PING_MS = 25000;
const RETRY_MS = [500, 1000, 2000, 4000, 8000];

export class NetClient {
  // handlers: { onStatus, onLobby, onState, onWalkers, onError }
  constructor(handlers = {}) {
    this.h = handlers;
    this.ws = null;
    this.code = null;
    this.kind = 'game';
    this.name = '';
    this.seat = null;
    this.closedByUs = false;
    this.retry = 0;
    this.pingTimer = null;
  }

  // kind: 'game'(対戦)/ 'walk'(散策)。まだ無い部屋を作るときにだけ効く
  // look: 散策部屋での「すがた」。名前と同じく、繋いだときに一度だけ送る
  connect(code, name, kind = 'game', look = null) {
    this.code = code;
    this.name = name;
    this.look = look;
    this.kind = kind === 'walk' ? 'walk' : 'game';
    this.closedByUs = false;
    this._open();
  }

  _open() {
    this._status('connecting');
    const base = serverBase().replace(/^http/, 'ws');
    let ws;
    try {
      ws = new WebSocket(`${base}/room?code=${this.code}&kind=${this.kind}`);
    } catch (e) {
      return this._scheduleRetry();
    }
    this.ws = ws;

    ws.addEventListener('open', () => {
      this.retry = 0;
      ws.send(JSON.stringify({
        t: 'hello', clientId: clientId(), name: this.name, look: this.look ?? undefined,
      }));
      clearInterval(this.pingTimer);
      this.pingTimer = setInterval(() => this.send({ t: 'ping' }), PING_MS);
    });

    ws.addEventListener('message', (ev) => {
      let msg;
      try {
        msg = JSON.parse(ev.data);
      } catch {
        return;
      }
      this._onMessage(msg);
    });

    ws.addEventListener('close', () => {
      clearInterval(this.pingTimer);
      if (this.closedByUs) return this._status('closed');
      this._scheduleRetry();
    });

    ws.addEventListener('error', () => {
      // close も続けて飛ぶので、ここでは再接続を仕掛けない
    });
  }

  _onMessage(msg) {
    switch (msg.t) {
      case 'joined':
        this.seat = msg.seat;
        this._status('online');
        break;
      case 'lobby':
        this.h.onLobby?.(msg);
        break;
      case 'walkers':
        this.h.onWalkers?.(msg.people);
        break;
      case 'state':
        if (msg.seat != null) this.seat = msg.seat;
        this.h.onState?.(msg);
        break;
      case 'error':
        this.h.onError?.(msg.msg, !!msg.fatal);
        if (msg.fatal) this.close();
        break;
      case 'pong':
        break;
      default:
        break;
    }
  }

  _scheduleRetry() {
    this._status('reconnecting');
    const wait = RETRY_MS[Math.min(this.retry, RETRY_MS.length - 1)];
    this.retry++;
    clearTimeout(this.retryTimer);
    this.retryTimer = setTimeout(() => {
      if (!this.closedByUs) this._open();
    }, wait);
  }

  _status(s) {
    this.status = s;
    this.h.onStatus?.(s);
  }

  send(obj) {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(obj));
      return true;
    }
    return false;
  }

  setSettings(settings) {
    return this.send({ t: 'settings', settings });
  }

  start() {
    return this.send({ t: 'start' });
  }

  action(action) {
    return this.send({ t: 'action', action });
  }

  // 散策部屋: 自分の位置。届かなくても次が来るので、送れなければ黙って捨てる
  // (取りこぼしを再送すると、古い位置で上書きしてしまう)。
  // すがたを変える。再接続したときも同じ姿で戻れるよう覚えておく
  setLook(look) {
    this.look = look;
    return this.send({ t: 'look', look });
  }

  pos(p) {
    if (this.ws?.readyState !== WebSocket.OPEN) return false;
    try {
      this.ws.send(JSON.stringify({ t: 'pos', p }));
      return true;
    } catch {
      return false;
    }
  }

  close() {
    this.closedByUs = true;
    clearInterval(this.pingTimer);
    clearTimeout(this.retryTimer);
    try {
      this.ws?.close();
    } catch { /* 済 */ }
    this.ws = null;
  }
}
