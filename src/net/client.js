// オンライン対戦のクライアント(WebSocket)
// サーバー(Cloudflare Workers + Durable Objects)とのやりとりを 1 箇所にまとめる。
// ゲームのルール判定は一切ここでは行わない ── 権威はサーバーにある。

// 接続先。デプロイ後の workers.dev URL をここに書く。
// 開発中は ?server=... で上書きでき、localhost では自動でローカルサーバーを見る。
const DEFAULT_SERVER = 'https://catan-web-server.uriboo-dev.workers.dev';

export function serverBase() {
  const override = new URLSearchParams(location.search).get('server');
  if (override) return override.replace(/\/$/, '');
  const saved = localStorage.getItem('catan.server');
  if (saved) return saved.replace(/\/$/, '');
  if (['localhost', '127.0.0.1'].includes(location.hostname)) return 'http://127.0.0.1:8787';
  return DEFAULT_SERVER;
}

// 同じ端末は同じ ID を使い続ける(再接続で元の席に戻るため)
export function clientId() {
  let id = localStorage.getItem('catan.clientId');
  if (!id) {
    id = `c-${Math.random().toString(36).slice(2)}-${Date.now().toString(36)}`;
    localStorage.setItem('catan.clientId', id);
  }
  return id;
}

export function savedName() {
  return localStorage.getItem('catan.name') ?? '';
}

export function saveName(name) {
  localStorage.setItem('catan.name', name);
}

// 新しい部屋を作って合言葉をもらう
export async function createRoom() {
  const res = await fetch(`${serverBase()}/new`, { method: 'POST' });
  const data = await res.json();
  if (!res.ok || data.error) throw new Error(data.error ?? '部屋を作れませんでした');
  return data.code;
}

const PING_MS = 25000;
const RETRY_MS = [500, 1000, 2000, 4000, 8000];

export class NetClient {
  // handlers: { onStatus, onLobby, onState, onError }
  constructor(handlers = {}) {
    this.h = handlers;
    this.ws = null;
    this.code = null;
    this.name = '';
    this.seat = null;
    this.closedByUs = false;
    this.retry = 0;
    this.pingTimer = null;
  }

  connect(code, name) {
    this.code = code;
    this.name = name;
    this.closedByUs = false;
    this._open();
  }

  _open() {
    this._status('connecting');
    const base = serverBase().replace(/^http/, 'ws');
    let ws;
    try {
      ws = new WebSocket(`${base}/room?code=${this.code}`);
    } catch (e) {
      return this._scheduleRetry();
    }
    this.ws = ws;

    ws.addEventListener('open', () => {
      this.retry = 0;
      ws.send(JSON.stringify({ t: 'hello', clientId: clientId(), name: this.name }));
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
