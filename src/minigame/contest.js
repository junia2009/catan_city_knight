// 釣り大会の順位づけと、結果の読み取り。
//
// 進行そのものはサーバー(server/fishing-contest.js)が持っていて、順位も
// あちらが決めて配る。ここに置いてあるのは、**同じ数え方を両側で使うため** ──
// サーバーが view() を作るときにも、クライアントが「自分は優勝したか」を
// 見るときにも、この1本を通す。
//
// DOM も 3D も使わないので node --test でそのまま押さえられる。実績と称号が
// 付く判定なので、いちばん間違えたくないところ。

// 同着は同じ順位にする(競技順位: 1, 1, 3)。
//
// 並べ替えの決着(合計 → 大物 → 席番号)と、順位そのものは別もの。
// 席番号は「表に並べる順」を決めるためだけのもので、これで順位まで
// 割ってしまうと、まったく同じ釣果でも席が若いほうだけが優勝になる。
export function placeOf(rank) {
  const ahead = (a, b) => b.cm > a.cm || (b.cm === a.cm && b.best > a.best);
  return rank.map((r) => ({ ...r, place: 1 + rank.filter((o) => ahead(r, o)).length }));
}

// view は FishingContest#view() が返すもの。seat は自分の席。
// 戻り値: { entered, won, cm, place }
//   entered … その回に出ていたか(途中から見ていただけなら false)
//   won     … 優勝したか(同率優勝も優勝)
//   cm      … 自分の合計
//   place   … 自分の順位(出ていなければ 0)
export function contestOutcome(view, seat) {
  const rank = view?.rank ?? [];
  // 席が無い(まだ入っていない)なら find は空振りする。null を別に見なくてよい
  const me = placeOf(rank).find((r) => r.seat === seat);
  if (!me) return { entered: false, won: false, cm: 0, place: 0 };
  // ひとりしか残らなかった回と、誰も釣れなかった回は優勝にしない。
  // 相手が抜けた瞬間や、全員ボウズのまま時間切れで称号が付くと、
  // 「勝った」感じがまるでしない。
  const won = rank.length >= 2 && me.cm > 0 && me.place === 1;
  return { entered: true, won, cm: me.cm, place: me.place };
}
