// 島ごとの「集まり」(散策部屋のミニゲーム)の一覧。
//
// 散策部屋は島の種類(settings.mode = 対戦のルールと同じ5つ)を選んで作る。
// その島に何の受付が立つかを、ここ1か所で決める ── 漁師たちの島なら釣り大会、
// といった具合に、島ごとに遊びが変わる。
//
// **サーバーとクライアントの両方がここを見る。** 島に受付が無いのに大会が
// 始められる、という食い違いを防ぐため、判定はこの表だけを根拠にする
// (server/room-do.js が hasMeet で弾き、walk-mode.js が受付を建てない)。
//
// 増やすときは、ここに1行足したうえで
//   - 進行(サーバー側の状態機械)
//   - 受付の見た目(sign の文字は desk.js が焼き込む)
//   - 実績(src/achievements.js の checkMeet)
// を1セットで用意する。

export const MEETS = {
  fish: {
    id: 'fishing',
    name: 'つり大会',
    // 受付の看板に焼き込む文字(2行)
    sign: ['つり大会', '受付'],
    // 受付のパネルの見出しと、遊び方の一文
    title: '🎣 釣り大会',
    hint: '港で釣って、合計の長さを競います。',
  },
};

// その島に受付があるか。無ければ中心には何も立たない。
export function meetFor(mode) {
  return MEETS[mode] ?? null;
}

export function hasMeet(mode) {
  return !!MEETS[mode];
}
