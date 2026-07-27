// Worker 本体: 合言葉から部屋(Durable Object)へ振り分けるだけの薄い層。
// 対戦の状態と進行は Durable Object 側(room-do.js)が持つ。

import { makeRoomCode, normalizeRoomCode, CODE_LENGTH } from './room-core.js';

export { RoomDO } from './room-do.js';

// 静的サイトは GitHub Pages、サーバーは workers.dev と別オリジンになるため
const ALLOWED_ORIGINS = [
  'https://junia2009.github.io',
  'http://localhost:8000',
  'http://localhost:8123',
  'http://127.0.0.1:8000',
];

function corsHeaders(request) {
  const origin = request.headers.get('Origin') ?? '';
  const allow = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  return {
    'Access-Control-Allow-Origin': allow,
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
  };
}

function json(request, body, status = 200) {
  return Response.json(body, { status, headers: corsHeaders(request) });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders(request) });
    }

    if (url.pathname === '/health') {
      return json(request, { ok: true });
    }

    // 新しい部屋を作る: 空いている合言葉を見つけて返す
    if (url.pathname === '/new') {
      for (let attempt = 0; attempt < 6; attempt++) {
        const code = makeRoomCode();
        const stub = env.ROOMS.get(env.ROOMS.idFromName(code));
        const res = await stub.fetch(`https://room/claim?code=${code}`);
        const { free } = await res.json();
        if (free) return json(request, { code });
      }
      return json(request, { error: '部屋を作れませんでした。もう一度お試しください' }, 503);
    }

    // 部屋への接続(WebSocket)
    if (url.pathname === '/room') {
      const code = normalizeRoomCode(url.searchParams.get('code'));
      if (code.length !== CODE_LENGTH) {
        return json(request, { error: '合言葉は英字4文字です' }, 400);
      }
      const stub = env.ROOMS.get(env.ROOMS.idFromName(code));
      return stub.fetch(`https://room/ws?code=${code}`, request);
    }

    return json(request, { error: 'not found' }, 404);
  },
};
