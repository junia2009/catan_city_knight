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
// ahead(r, o) は「o は r より上か」。決着が付かない者どうしが同率になる。
export function placeBy(rows, ahead) {
  return rows.map((r) => ({ ...r, place: 1 + rows.filter((o) => ahead(r, o)).length }));
}

// 逃げきった人は、捕まった人より必ず上。時間だけで比べると、捕まった
// 直後に回が終わったとき「捕まった人と逃げきった人が同率」になってしまう
// (最後のひとりになった回では必ずそうなる)。
// 同じ側どうしなら、長く生き残ったほうが上 ── 秒でまるめて同着は同率にする。
export const huntAhead = (r, o) => (o.alive && !r.alive)
  || (!!o.alive === !!r.alive && Math.round(o.ms / 1000) > Math.round(r.ms / 1000));

// 釣り大会の順位。合計 → いちばん大きい1匹、で決着が付かなければ同率。
export function placeOf(rank) {
  return placeBy(rank, (r, o) => o.cm > r.cm || (o.cm === r.cm && o.best > r.best));
}

// 蛮族を射る大会の順位。撃退した点 → 凌いだ波。
// 全員が同じ波を迎え撃つ(種はサーバーが配る)ので、点がそのまま腕前になる。
// 同点なら「先の波まで凌いだ」ほうが上 ── 浜を破られずに長く立っていた側。
export const raidAhead = (r, o) => o.score > r.score
  || (o.score === r.score && o.wave > r.wave);

// view は FishingContest#view() が返すもの。seat は自分の席。
// 戻り値: { entered, won, score, place }
//   entered … その回に出ていたか(途中から見ていただけなら false)
//   won     … 優勝したか(同率優勝も優勝)
//   score   … 自分の記録(釣りは合計 cm、竜は生き残った秒)
//   place   … 自分の順位(出ていなければ 0)
export function contestOutcome(view, seat) {
  const rank = view?.rank ?? [];
  // 大富豪だけは順位を数え直さない。**順位は「札を出し切った順」**で、
  // 配られた行の中身(残り枚数)からは作れない ── サーバーが上がった順に
  // 並べて place を入れてくれているので、それをそのまま使う。
  if (view?.kind === 'daifugo') {
    const me = rank.find((r) => r.seat === seat);
    if (!me) return { entered: false, won: false, score: 0, place: 0 };
    // ひとりしか残らなかった回は優勝にしない(ほかの遊びと同じ)
    if (rank.length < 2) return { entered: true, won: false, score: 0, place: me.place };
    return {
      entered: true, won: me.place === 1, score: rank.length - me.place, place: me.place,
    };
  }
  // サーバーが place を入れて配っているが、ここでも数え直す ── 古い版の
  // サーバーが繋がっていても、優勝の判定だけは自前で決められるように。
  const rows = view?.kind === 'dragonhunt'
    ? placeBy(rank, huntAhead)
    : view?.kind === 'raid'
      ? placeBy(rank, raidAhead)
      : placeOf(rank);
  // 席が無い(まだ入っていない)なら find は空振りする。null を別に見なくてよい
  const me = rows.find((r) => r.seat === seat);
  if (!me) return { entered: false, won: false, score: 0, place: 0 };
  // ひとりしか残らなかった回は優勝にしない ── 相手が抜けた瞬間に称号が
  // 付くと、勝った気がまるでしない。
  if (rank.length < 2) return { entered: true, won: false, score: 0, place: me.place };
  if (view?.kind === 'dragonhunt') {
    // 逃げきった人だけが勝ち。全員捕まった回に「いちばん長く粘った人」を
    // 勝ちにすると、逃げきる実績が逃げきらなくても取れてしまう。
    return {
      entered: true, won: !!me.alive, score: Math.round(me.ms / 1000), place: me.place,
    };
  }
  if (view?.kind === 'raid') {
    // 1点も取れなかった回は優勝にしない(釣りと同じ考え方)
    return {
      entered: true, won: me.score > 0 && me.place === 1, score: me.score, place: me.place,
    };
  }
  // 誰も釣れなかった回も優勝にしない
  const won = me.cm > 0 && me.place === 1;
  return { entered: true, won, score: me.cm, place: me.place };
}
