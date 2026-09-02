// エモート(その場でする短い身ぶり)の一覧。
//
// THREE を使わない。姿勢そのものは pose.js の emotePose が作る。
//
// 番号(id)は通信に乗る。**既存の番号を入れ替えない** ── 相手が古い版を
// 開いていると、手をふったつもりがしょんぼりして見える。足すときは後ろへ。
// 上限は remote-st.js の EMOTE_MAX と揃える(サーバーが範囲を丸めるのに使う)。

import { EMOTE_MAX } from './remote-st.js';

export { EMOTE_MAX };

export const EMOTES = [
  { id: 1, key: 'wave', icon: '👋', label: 'てをふる', ms: 2000 },
  { id: 2, key: 'cheer', icon: '🙌', label: 'バンザイ', ms: 1800 },
  { id: 3, key: 'bow', icon: '🙇', label: 'おじぎ', ms: 1600 },
  { id: 4, key: 'point', icon: '👉', label: 'あっち', ms: 2000 },
  { id: 5, key: 'sad', icon: '😢', label: 'しょんぼり', ms: 2200 },
];

const BY_ID = new Map(EMOTES.map((e) => [e.id, e]));

export function emoteById(id) {
  return BY_ID.get(id) ?? null;
}

// 一覧と上限がずれていないか。番号の穴・重複・はみ出しをここで止める。
export function emotesOk() {
  if (EMOTES.length !== EMOTE_MAX) return false;
  return EMOTES.every((e, i) => e.id === i + 1 && e.key && e.icon && e.label && e.ms > 0);
}
