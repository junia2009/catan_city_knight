// シード制御の疑似乱数 (mulberry32 系)。
// 乱数状態は数値1つで GameState に保持し、使用のたびに [新状態, 値] を返す。

export function makeRng(seed) {
  const s = seed >>> 0;
  return s === 0 ? 1 : s;
}

export function rngNext(s) {
  s = (s + 0x6d2b79f5) >>> 0;
  let t = s;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  const v = ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  return [s, v];
}

// 0..n-1 の整数
export function rngInt(s, n) {
  const [s2, v] = rngNext(s);
  return [s2, Math.floor(v * n)];
}

// Fisher-Yates。元配列は変更せず新配列を返す。
export function shuffled(s, arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    let j;
    [s, j] = rngInt(s, i + 1);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return [s, a];
}
