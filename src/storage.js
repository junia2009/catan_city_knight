// localStorage の読み書き。キーの接頭辞を1か所にまとめる。
//
// 以前は 'catan.*' / 'catan-bgm' というキーだった。改名でプレイヤーの
// 保存名・接続先・端末IDが消えないよう、旧キーが残っていれば初回の読み取りで
// 新キーへ引き継ぐ(引き継いだあとは新キーだけを見る)。

const PREFIX = 'hexfrontier';

// name -> 旧キー(接頭辞の付け方が揃っていなかったので個別に持つ)
const LEGACY_KEYS = {
  server: 'catan.server',
  clientId: 'catan.clientId',
  name: 'catan.name',
  bgm: 'catan-bgm',
};

function keyOf(name) {
  return `${PREFIX}.${name}`;
}

export function lsGet(name) {
  const key = keyOf(name);
  const v = localStorage.getItem(key);
  if (v != null) return v;
  const legacy = LEGACY_KEYS[name];
  if (!legacy) return null;
  const old = localStorage.getItem(legacy);
  if (old != null) localStorage.setItem(key, old); // 一度だけ引き継ぐ
  return old;
}

export function lsSet(name, value) {
  localStorage.setItem(keyOf(name), value);
}

export function lsRemove(name) {
  localStorage.removeItem(keyOf(name));
  const legacy = LEGACY_KEYS[name];
  if (legacy) localStorage.removeItem(legacy); // 旧キーが復活しないように消す
}
