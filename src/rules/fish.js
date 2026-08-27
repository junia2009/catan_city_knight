// 漁師たち(公式の小拡張)。基本ルールに魚トークンを足す。
//
// - 湖(元の砂漠)は 2/3/11/12、漁場タイルは 4/5/6/8/9/10 で魚を産む
// - 隣接する開拓地は1枚、都市は2枚の魚トークンを引く
// - 魚は手札上限に数えない(場に公開して置くもの)
// - 使うときは「お釣りが出ない」= 支払いに使った分は多くても戻ってこない
// - 「古い靴」を持っている間は、勝ちに必要な点数が1点増える

import { LAYOUT, LAKE_NUMBERS } from './board.js';
import { shuffled } from '../rng.js';

// 魚トークンの山。公式は30枚だが内訳は手元の資料で確定できなかったため、
// 1匹を厚めにした配分をここで決めている(遊んで調整できるようにまとめてある)。
export const FISH_POOL = [
  ...Array(12).fill(1),
  ...Array(10).fill(2),
  ...Array(7).fill(3),
  'shoe',
];

// 使い道と必要な魚の数(公式)
export const FISH_USES = {
  robber: { cost: 2, jp: '盗賊を湖へ戻す', desc: '盗賊を盤上から取り除き、湖(元の砂漠)へ戻します。' },
  steal: { cost: 3, jp: '資源を1枚奪う', desc: '好きな相手から資源をランダムに1枚奪います。' },
  resource: { cost: 4, jp: '好きな資源を1枚', desc: '銀行から好きな資源を1枚もらいます。' },
  road: { cost: 5, jp: '道を1本無料で建設', desc: '資源を払わずに道を1本建てます。' },
  dev: { cost: 7, jp: '発展カードを1枚', desc: '資源を払わずに発展カードを1枚引きます。' },
};

export function isFishMode(state) {
  return state.mode === 'fish';
}

// 手元の魚の数(古い靴は0匹として数える)
export function fishCount(player) {
  return (player.fish ?? []).reduce((s, t) => s + (t === 'shoe' ? 0 : t), 0);
}

export function hasOldShoe(player) {
  return (player.fish ?? []).includes('shoe');
}

// その出目で魚が出る場所(湖 + 漁場)から、プレイヤーごとの獲得枚数を数える。
// 開拓地1枚・都市2枚。盗賊のいるヘックスは資源と同じく止まる。
export function fishGainForRoll(state, total) {
  const gains = {};
  const add = (vid, n) => {
    const b = state.buildings[vid];
    if (!b) return;
    gains[b.player] = (gains[b.player] ?? 0) + n * (b.type === 'city' ? 2 : 1);
  };

  const lake = state.board.lake;
  if (lake && LAKE_NUMBERS.includes(total) && state.board.robber !== lake) {
    for (const vid of LAYOUT.hexVertices[lake] ?? []) add(vid, 1);
  }
  for (const f of state.board.fisheries ?? []) {
    if (f.number !== total) continue;
    for (const vid of LAYOUT.edges[f.edgeId].v) add(vid, 1);
  }
  return gains;
}

// 山札から n 枚引く。山が尽きたら切り直す(使った魚は戻ってくるものなので)。
// 古い靴は1枚しかないので、誰かが持っている間は山にあっても引かない(飛ばす)。
export function drawFish(state, pid, n) {
  const p = state.players[pid];
  p.fish = p.fish ?? [];
  const drawn = [];
  const shoeTaken = () => state.players.some((o) => hasOldShoe(o));

  for (let i = 0; i < n; i++) {
    let pool = state.bank.fishPool;
    // 引ける札が残っていなければ切り直す(靴が出払っていれば靴抜きで)
    if (!pool?.length || (shoeTaken() && pool.every((t) => t === 'shoe'))) {
      const taken = shoeTaken();
      [state.rng, pool] = shuffled(state.rng, FISH_POOL.filter((t) => t !== 'shoe' || !taken));
      state.bank.fishPool = pool;
    }
    // 山の上(末尾)から、引ける札を1枚取る
    let idx = pool.length - 1;
    while (idx >= 0 && pool[idx] === 'shoe' && shoeTaken()) idx--;
    const [t] = pool.splice(idx, 1);
    p.fish.push(t);
    drawn.push(t);
  }
  return drawn;
}

// cost ぶんの魚を払う。お釣りは出ないので、無駄がいちばん少なくなる払い方をする。
// 大きい札から「はみ出さないもの」を選び、どれもはみ出すなら最小の札で払う(超過分は捨て)。
export function payFish(player, cost) {
  const tokens = (player.fish ?? []).filter((t) => t !== 'shoe').sort((a, b) => b - a);
  const shoe = (player.fish ?? []).filter((t) => t === 'shoe');
  if (tokens.reduce((s, t) => s + t, 0) < cost) return false;

  let rest = cost;
  while (rest > 0) {
    let i = tokens.findIndex((t) => t <= rest);
    if (i === -1) i = tokens.length - 1; // 降順なので末尾が最小
    rest -= tokens[i];
    tokens.splice(i, 1);
  }
  player.fish = [...tokens, ...shoe];
  return true;
}

// 古い靴を渡せる相手(自分と同点以上)
export function shoeTargets(state, pid, pointsOf) {
  const mine = pointsOf(pid);
  return state.players.filter((o) => o.id !== pid && pointsOf(o.id) >= mine).map((o) => o.id);
}
