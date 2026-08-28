// BGM と効果音で AudioContext を共有する。
//
// iOS は同時に持てる AudioContext の数がとても少ないので、音を鳴らすものが
// 増えても1つで済ませる。生成はユーザー操作の中から(自動再生制限)。

let ctx = null;
// 「BGM を止めても context は落とさないでほしい」人がいるか(= 効果音がオン)
let keepAlive = false;

export function audioCtx() {
  if (ctx) return ctx;
  const AC = window.AudioContext ?? window.webkitAudioContext;
  if (!AC) return null;
  try {
    ctx = new AC();
  } catch (e) {
    console.warn('AudioContext init failed:', e);
    return null;
  }
  return ctx;
}

// 既に作ってあれば返すだけ(まだなら作らない)。停止処理などで使う。
export function existingCtx() {
  return ctx;
}

export function setKeepAlive(on) {
  keepAlive = on;
}

export function wantsKeepAlive() {
  return keepAlive;
}
