// 釣り大会の結果の読み取り。
//
// 進行そのものはサーバー(server/fishing-contest.js)が持っていて、
// ここは届いた view から「自分は出ていたか・優勝したか」を決めるだけ。
//
// main.js に直接書かず切り出してあるのは、**優勝の条件がいちばん間違えたく
// ないところ**だから ── 実績と称号が付く判定なので、DOM も 3D も要らない
// 純粋な関数にして node --test で押さえる。

// view は FishingContest#view() が返すもの。seat は自分の席。
// 戻り値: { entered, won, cm }
//   entered … その回に出ていたか(途中から見ていただけなら false)
//   won     … 優勝したか
//   cm      … 自分の合計
export function contestOutcome(view, seat) {
  const rank = view?.rank ?? [];
  // 席が無い(まだ入っていない)なら find は空振りする。null を別に見なくてよい
  const me = rank.find((r) => r.seat === seat);
  if (!me) return { entered: false, won: false, cm: 0 };
  const top = rank[0];
  // ひとりしか残らなかった回と、誰も釣れなかった回は優勝にしない。
  // 相手が抜けた瞬間や、全員ボウズのまま時間切れで称号が付くと、
  // 「勝った」感じがまるでしない。
  const won = rank.length >= 2 && top.cm > 0 && top.seat === seat;
  return { entered: true, won, cm: me.cm };
}
