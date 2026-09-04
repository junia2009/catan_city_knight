// 大富豪(基本の島の集まり)。進行の計算だけ。
//
// THREE も DOM も知らない。見た目は table.js、席ごとの伏せ処理と配信は
// server/daifugo-table.js。**この遊びだけは手札という隠し情報を持つ**ので、
// 対戦(src/actions.js)と同じ作りにしてある:
//   validate → clone → apply の一本道、状態は plain object 1つ、
//   乱数は state に持つ種だけ(Math.random は使わない)。
//
// 入れるルールはホストが選ぶ。判定は全て state.rules を見るので、
// RULES の表がそのまま設定画面になる(進歩カードと同じ考え方)。
//
// 札の番号:
//   0〜51 … スート×13 + 強さ(0='3' 〜 12='2')
//   52,53 … ジョーカー
// 番号は通信に乗るので**並びを変えない**(相手が古い版だと別の札に見える)。

import { rngNext } from '../rng.js';

export const RANKS = ['3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A', '2'];
// スートの番号は「番号 → マーク」の対応でしかなく、強弱には関わらない
// (大富豪はスートで強弱を付けない)。しばりとスペ3返しだけが見る。
export const SUITS = ['♠', '♥', '♦', '♣'];
export const JOKER = 13;          // ジョーカーの強さ(数字の上)
export const DECK = 54;

// 数字 → 強さの位置。**8切りの「8」を 5 と書くと誰も読めない**ので、
// 数字を見たいところは必ずこの表を通す。
const R = Object.fromEntries(RANKS.map((label, i) => [label, i]));

export const SPADE3 = 0 * 13 + R['3'];    // ♠3(スペ3返し)
const DIA3 = 2 * 13 + R['3'];             // ♦3(1回戦の親)

export const isJoker = (c) => c >= 52;
export const rankOf = (c) => (isJoker(c) ? JOKER : c % 13);
export const suitOf = (c) => (isJoker(c) ? -1 : Math.floor(c / 13));
export const cardName = (c) => (isJoker(c) ? '🃏' : `${SUITS[suitOf(c)]}${RANKS[rankOf(c)]}`);

// 手札の並び順(弱い順。同じ数字はマーク順)
export const byStrength = (a, b) => rankOf(a) - rankOf(b) || suitOf(a) - suitOf(b);

// ---- 入れるルール ----
//
// `on` は既定値。「これだけ入っていれば大富豪として成立する」ところに置く。
export const RULES = [
  { id: 'kaidan', name: '階段', on: true, desc: '同じマークの連番3枚以上を、ひとまとまりで出せる' },
  { id: 'kiri8', name: '8切り', on: true, desc: '8を含めて出すと場が流れ、続けて自分から出せる' },
  { id: 'kakumei', name: '革命', on: true, desc: '同じ数字4枚(階段なら5枚)で、強さが逆さになる' },
  { id: 'spade3', name: 'スペ3返し', on: true, desc: 'ジョーカー1枚だけの場には ♠3 で返せる' },
  { id: 'koukan', name: 'カード交換', on: true, desc: '2回戦から、大貧民は強い札を大富豪へ渡す(大富豪は好きな札を返す)' },
  { id: 'jback', name: 'Jバック', on: false, desc: 'J を出すと、場が流れるまで強さが逆さになる' },
  { id: 'shibari', name: 'しばり', on: false, desc: '同じマークが続けて出ると、場が流れるまでそのマークしか出せない' },
  { id: 'gotobashi', name: '5飛ばし', on: false, desc: '5を出すと、その枚数だけ次の人を飛ばす' },
  { id: 'reverse9', name: '9リバース', on: false, desc: '9を出すと、順番が逆回りになる' },
  { id: 'watashi7', name: '7渡し', on: false, desc: '7を出すと、その枚数だけ手札を次の人へ渡す' },
  { id: 'sute10', name: '10捨て', on: false, desc: '10を出すと、その枚数だけ手札を捨てられる' },
  { id: 'kinshi', name: '禁止上がり', on: false, desc: '2・ジョーカー・8切り・スペ3で上がると反則負け(いちばん下になる)' },
  { id: 'miyakoochi', name: '都落ち', on: false, desc: '大富豪が1番に上がれなかったら、その場で大貧民になる' },
];

export const RULE_IDS = RULES.map((r) => r.id);

export function defaultRules() {
  const out = {};
  for (const r of RULES) out[r.id] = r.on;
  return out;
}

// 知らない名前や壊れた値が来ても遊べるように、表にあるものだけを真偽で拾う
export function cleanRules(src) {
  const out = defaultRules();
  if (!src || typeof src !== 'object') return out;
  for (const r of RULES) if (r.id in src) out[r.id] = !!src[r.id];
  return out;
}

// ---- 称号 ----

export const TITLES = ['daifugo', 'fugo', 'heimin', 'hinmin', 'daihinmin'];
export const TITLE_JP = {
  daifugo: '大富豪', fugo: '富豪', heimin: '平民', hinmin: '貧民', daihinmin: '大貧民',
};

// 上がった順から称号を決める。人数が少ないと真ん中が無くなる。
//   2人 … 大富豪 / 大貧民
//   3人 … 大富豪 / 平民 / 大貧民
//   4人〜… 大富豪 / 富豪 / 平民… / 貧民 / 大貧民
export function titlesFor(order) {
  const n = order.length;
  const out = {};
  order.forEach((pid, i) => {
    if (i === 0) out[pid] = 'daifugo';
    else if (i === n - 1) out[pid] = 'daihinmin';
    else if (n >= 4 && i === 1) out[pid] = 'fugo';
    else if (n >= 4 && i === n - 2) out[pid] = 'hinmin';
    else out[pid] = 'heimin';
  });
  return out;
}

// 交換で何枚やり取りするか
export function swapCount(title) {
  if (title === 'daifugo' || title === 'daihinmin') return 2;
  if (title === 'fugo' || title === 'hinmin') return 1;
  return 0;
}

// 交換の相手(富む側 ↔ 貧しい側)
const SWAP_PAIR = { daifugo: 'daihinmin', fugo: 'hinmin', daihinmin: 'daifugo', hinmin: 'fugo' };

// ---- 出す札の「形」 ----
//
// 戻り値 { kind, n, rank, suits } または null(出せない組み合わせ)。
//   kind … 'set'(同じ数字。1枚もこれ)/ 'seq'(階段)
//   rank … 強さくらべに使う数字。階段は上の端
//   suits… ジョーカーを除いたマークの並び(しばりが見る)
export function classify(cards, rules = {}) {
  if (!Array.isArray(cards) || cards.length === 0) return null;
  if (cards.some((c) => !Number.isInteger(c) || c < 0 || c >= DECK)) return null;
  if (new Set(cards).size !== cards.length) return null;
  const plain = cards.filter((c) => !isJoker(c));
  const n = cards.length;
  const suits = plain.map(suitOf).sort((a, b) => a - b);

  // 同じ数字(ジョーカーは何にでもなる)。1枚もここに入る
  if (new Set(plain.map(rankOf)).size <= 1) {
    // ジョーカーだけなら、いちばん強い組として扱う
    const rank = plain.length ? rankOf(plain[0]) : JOKER;
    return { kind: 'set', n, rank, suits };
  }

  // 階段。同じマークで、ジョーカーが隙間をちょうど埋められること
  if (!rules.kaidan || n < 3) return null;
  if (new Set(suits).size !== 1) return null;
  const rs = plain.map(rankOf).sort((a, b) => a - b);
  if (new Set(rs).size !== rs.length) return null;
  const lo0 = rs[0];
  const hi0 = rs[rs.length - 1];
  // 幅が n を超えていたら、ジョーカーを何枚足しても連番にならない
  if (hi0 - lo0 > n - 1) return null;
  // ジョーカーは端を伸ばすのにも使えるので、**いちばん上まで伸ばした形**を採る
  // ── 出す側にとっていちばん強い読み方になる。
  const hi = Math.min(12, Math.max(hi0, lo0 + n - 1));
  if (hi - n + 1 > lo0) return null;   // 下の端が手札からはみ出す
  return { kind: 'seq', n, rank: hi, suits };
}

// ---- 強さくらべ ----

// いま強さが逆さかどうか。革命とJバックは重なると打ち消し合う
export function reversed(st) {
  return !!st.revolution !== !!st.jback;
}

// a が b より強いか。**ジョーカーは革命の影響を受けない**(常に最強)
function stronger(a, b, rev) {
  if (a === JOKER || b === JOKER) return a === JOKER && b !== JOKER;
  return rev ? a < b : a > b;
}

// ♠3 返し(ジョーカー1枚だけの場に ♠3 を出す)か
function isSpade3Return(st, field, play, cards) {
  return !!st.rules.spade3 && !!field && field.n === 1 && field.rank === JOKER
    && play.n === 1 && cards[0] === SPADE3;
}

// 場に出せるか。field が null なら何でも出せる(場が流れている)
export function beatsField(st, play, cards) {
  const f = st.field;
  if (!f) return true;
  if (isSpade3Return(st, f, play, cards)) return true;
  if (f.kind !== play.kind || f.n !== play.n) return false;
  return stronger(play.rank, f.rank, reversed(st));
}

// しばりに合っているか
export function fitsShibari(st, play) {
  if (!st.shibari) return true;
  return sameSuits(st.shibari, play.suits);
}

// この手で場が流れるか(8切り・スペ3返し)。
// **field は「出す前の場」を渡すこと** ── 出したあとの場を渡すと
// スペ3返しが自分自身と比べられて、いつまでも成立しない。
export function clearsField(st, field, play, cards) {
  if (st.rules.kiri8 && cards.some((c) => !isJoker(c) && rankOf(c) === R['8'])) return true;
  return isSpade3Return(st, field, play, cards);
}

// 禁止上がりに触れるか(その手で手札が空になるときだけ見る)。
// 触れていれば**反則負け**の理由を返す(公式どおり、いちばん下へ落とす)。
//
// 一度は「出せない手」にしてみたが、それだと手札の最後の1枚が禁止札の人
// どうしで、場が流れたまま永久にパスし合う盤面ができる。出させて落とす
// ほうが必ず終わるし、公式の扱いでもある。UI は出す前に警告を出すこと。
//
// field は「出す前の場」。8切り・♠3返しの判定に要る。
export function forbiddenFinish(st, play, cards, field = st.field) {
  if (!st.rules.kinshi) return null;
  if (cards.some(isJoker)) return 'ジョーカーで上がると反則';
  if (cards.some((c) => rankOf(c) === R['2'])) return '2 で上がると反則';
  if (clearsField(st, field, play, cards)) {
    return cards.includes(SPADE3) ? '♠3 返しで上がると反則' : '8切りで上がると反則';
  }
  return null;
}

// ---- 卓を作る ----

// players: 席の並び(円卓の順)。titles: 前回の称号(2回戦以降)
export function createTable({ seed = 1, players, rules = {}, titles = null, game = 1 }) {
  const st = {
    seed: seed >>> 0 || 1,
    rng: seed >>> 0 || 1,
    rules: cleanRules(rules),
    players: [...players],
    game,
    hands: {},
    passed: {},
    field: null,
    lastPlayed: [],      // 直前に出した札(7渡しのあと 5飛ばしを数え直すのに要る)
    lead: null,          // 最後に場へ出した人(みんなパスしたらこの人から)
    turn: 0,             // players の添字
    dir: 1,              // 9リバース
    revolution: false,
    jback: false,
    shibari: null,
    out: [],             // 上がった順(下へ落とされた人はここに入れない)
    demoted: [],         // いちばん下へ落とされた人 { player, why, reason }
                         //   why: 'miyakoochi'(都落ち)/ 'foul'(禁止上がりの反則)
    titles: titles ? { ...titles } : null,   // 前回の称号
    swapped: {},         // 交換で「返した」人
    result: null,        // 決着したら { order, titles }
    awaiting: null,      // { type: 'exchange'|'give'|'discard', player, count, to? }
    pendingClear: false, // 8切りだが、先に7渡し/10捨てを選んでもらっている
    phase: 'playing',
    log: [],
  };
  deal(st);
  // 交換のある回は、まず交換から
  if (st.rules.koukan && st.titles && players.length >= 2) {
    st.phase = 'exchange';
    autoGiveUp(st);
    st.awaiting = nextExchange(st);
    if (!st.awaiting) startPlay(st);
  } else {
    startPlay(st);
  }
  return st;
}

function draw(st) {
  const [s, v] = rngNext(st.rng);
  st.rng = s;
  return v;
}

function deal(st) {
  const deck = [];
  for (let i = 0; i < DECK; i++) deck.push(i);
  for (let i = deck.length - 1; i > 0; i--) {
    const j = Math.floor(draw(st) * (i + 1));
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }
  for (const p of st.players) st.hands[p] = [];
  deck.forEach((c, i) => st.hands[st.players[i % st.players.length]].push(c));
  for (const p of st.players) st.hands[p].sort(byStrength);
}

// 貧しいほうは選べない ── 強い札から決まった枚数を自動で渡す(公式どおり)
function autoGiveUp(st) {
  for (const p of st.players) {
    const t = st.titles[p];
    if (t !== 'daihinmin' && t !== 'hinmin') continue;
    const to = st.players.find((q) => st.titles[q] === SWAP_PAIR[t]);
    if (to == null) continue;
    const give = [...st.hands[p]].sort((a, b) => rankOf(b) - rankOf(a)).slice(0, swapCount(t));
    move(st, p, to, give);
    st.log.push({ t: 'swap', from: p, to, n: give.length, forced: true });
  }
}

// 富むほうが返す番。まだ返していない人がいれば、その待ちを返す
function nextExchange(st) {
  for (const t of ['daifugo', 'fugo']) {
    const p = st.players.find((q) => st.titles[q] === t);
    if (p == null || st.swapped[p]) continue;
    const to = st.players.find((q) => st.titles[q] === SWAP_PAIR[t]);
    if (to == null) continue;   // 相手が居ないなら返す必要もない
    return { type: 'exchange', player: p, count: swapCount(t), to };
  }
  return null;
}

function move(st, from, to, cards) {
  st.hands[from] = st.hands[from].filter((c) => !cards.includes(c));
  st.hands[to] = [...st.hands[to], ...cards].sort(byStrength);
}

// 最初に出す人。1回戦は ♦3 を持っている人、2回戦からは前回の大貧民
function startPlay(st) {
  st.phase = 'playing';
  st.awaiting = null;
  let first = 0;
  if (st.titles) {
    const last = st.players.findIndex((p) => st.titles[p] === 'daihinmin');
    if (last >= 0) first = last;
  } else {
    const who = st.players.findIndex((p) => st.hands[p].includes(DIA3));
    if (who >= 0) first = who;
  }
  st.turn = first;
  st.lead = st.players[first];
}

// ---- 進行 ----

export function dispatch(st, action) {
  const err = validate(st, action);
  if (err) return { error: err };
  return { state: apply(structuredClone(st), action) };
}

export function validate(st, action) {
  if (!st || st.result) return '決着しています';
  const a = action ?? {};
  if (st.awaiting) {
    if (a.player !== st.awaiting.player) return 'あなたの番ではありません';
    const want = { exchange: 'EXCHANGE', give: 'GIVE', discard: 'DISCARD' }[st.awaiting.type];
    if (a.type !== want) return 'いま選ぶのは別のものです';
    const cards = a.cards ?? [];
    if (cards.length !== st.awaiting.count) return `${st.awaiting.count}枚 選んでください`;
    if (new Set(cards).size !== cards.length) return '同じ札は選べません';
    if (!cards.every((c) => st.hands[a.player]?.includes(c))) return '持っていない札です';
    return null;
  }
  if (a.player !== st.players[st.turn]) return 'あなたの番ではありません';
  if (a.type === 'PASS') {
    return st.field ? null : '場が流れているのでパスできません';
  }
  if (a.type !== 'PLAY') return `不明な操作: ${a.type}`;
  const cards = a.cards ?? [];
  if (!cards.length) return '札を選んでください';
  if (!cards.every((c) => st.hands[a.player]?.includes(c))) return '持っていない札です';
  const play = classify(cards, st.rules);
  if (!play) return 'その組み合わせでは出せません';
  if (!beatsField(st, play, cards)) return '場より強くありません';
  if (!fitsShibari(st, play)) return `しばり中です(${st.shibari.map((s) => SUITS[s]).join('')})`;
  // 禁止上がりはここでは止めない。出せるが反則負けになる(forbiddenFinish)
  return null;
}

export function apply(st, action) {
  if (st.awaiting) return applyChoice(st, action);
  if (action.type === 'PASS') return applyPass(st);
  return applyPlay(st, action);
}

function applyChoice(st, action) {
  const { type, player, to } = st.awaiting;
  const cards = action.cards;
  if (type === 'exchange') {
    move(st, player, to, cards);
    st.swapped[player] = true;
    st.log.push({ t: 'swap', from: player, to, n: cards.length, forced: false });
    st.awaiting = nextExchange(st);
    if (!st.awaiting) startPlay(st);
    return st;
  }
  if (type === 'give') {
    move(st, player, to, cards);
    st.log.push({ t: 'give', from: player, to, n: cards.length });
  } else {
    st.hands[player] = st.hands[player].filter((c) => !cards.includes(c));
    st.log.push({ t: 'discard', by: player, n: cards.length });
  }
  st.awaiting = null;
  // 渡した・捨てた結果あがることがある(7渡し・10捨てで手札が尽きる)
  if (st.hands[player].length === 0) goOut(st, player);
  if (st.result) return st;
  return afterPlay(st, player, st.lastPlayed ?? []);
}

function applyPass(st) {
  const me = st.players[st.turn];
  st.passed[me] = true;
  st.log.push({ t: 'pass', by: me });
  // **場を流すのは「最後に出した人以外が全員パスした」とき。**
  // 「自分以外」で見ると、最後に出した人が自分の札の上にもう一度出せてしまう。
  const others = activePlayers(st).filter((p) => p !== st.lead);
  if (others.length && others.every((p) => st.passed[p])) {
    clearField(st);
    return st;
  }
  if (!others.length) {
    clearField(st);
    return st;
  }
  advance(st, 1);
  return st;
}

function applyPlay(st, action) {
  const me = action.player;
  const cards = [...action.cards];
  const play = classify(cards, st.rules);
  // **場を書き換える前に**、いまの場から決まるものを先に取る
  const before = st.field;
  const wasShibari = !!before && sameSuits(before.suits, play.suits);
  const cleared = clearsField(st, before, play, cards);

  st.hands[me] = st.hands[me].filter((c) => !cards.includes(c));
  st.field = { cards, kind: play.kind, n: play.n, rank: play.rank, suits: play.suits, by: me };
  st.lead = me;
  st.lastPlayed = cards;
  st.log.push({ t: 'play', by: me, cards });

  // 革命(同じ数字4枚 / 階段5枚以上)
  const isKakumei = (play.kind === 'set' && play.n >= 4) || (play.kind === 'seq' && play.n >= 5);
  if (st.rules.kakumei && isKakumei) {
    st.revolution = !st.revolution;
    st.log.push({ t: 'kakumei', by: me, on: st.revolution });
  }
  // Jバック(場が流れるまで)
  if (st.rules.jback && cards.some((c) => !isJoker(c) && rankOf(c) === R['J'])) {
    st.jback = true;
    st.log.push({ t: 'jback', by: me });
  }
  // しばり(同じマークが続いた)
  if (st.rules.shibari && wasShibari) {
    st.shibari = [...play.suits];
    st.log.push({ t: 'shibari', suits: st.shibari });
  }
  // 9リバース
  if (st.rules.reverse9 && cards.some((c) => !isJoker(c) && rankOf(c) === R['9'])) {
    st.dir = -st.dir;
    st.log.push({ t: 'reverse', by: me });
  }

  if (st.hands[me].length === 0) {
    // 禁止上がりに触れていたら、上がりではなく反則負け
    const foul = forbiddenFinish(st, play, cards, before);
    if (foul) demote(st, me, 'foul', foul);
    else goOut(st, me);
  }
  if (st.result) return st;

  // 7渡し・10捨ては出したあとに選ぶ。上がった人はもう渡すものがない
  const pending = st.hands[me].length ? pendingChoice(st, me, cards) : null;
  if (pending) {
    st.pendingClear = cleared;
    st.awaiting = pending;
    return st;
  }
  if (cleared) {
    st.log.push({ t: 'clear', by: me });
    clearField(st, me);
    return st;
  }
  return afterPlay(st, me, cards);
}

// 7渡し / 10捨ての待ちを作る。両方あるときは 7 が先(数字の順)
function pendingChoice(st, me, cards) {
  const count = (label) => cards.filter((c) => !isJoker(c) && rankOf(c) === R[label]).length;
  if (st.rules.watashi7) {
    const n = Math.min(count('7'), st.hands[me].length);
    if (n > 0) return { type: 'give', player: me, count: n, to: nextActive(st, me) };
  }
  if (st.rules.sute10) {
    const n = Math.min(count('10'), st.hands[me].length);
    if (n > 0) return { type: 'discard', player: me, count: n };
  }
  return null;
}

// 出したあとの手番送り
function afterPlay(st, me, cards = []) {
  if (st.pendingClear) {
    st.pendingClear = false;
    st.log.push({ t: 'clear', by: me });
    clearField(st, me);
    return st;
  }
  let step = 1;
  if (st.rules.gotobashi) {
    step += cards.filter((c) => !isJoker(c) && rankOf(c) === R['5']).length;
  }
  advance(st, step);
  return st;
}

function sameSuits(a, b) {
  return a.length === b.length && a.every((s, i) => s === b[i]);
}

// 場を流す。next が居ればその人から、居なければ最後に出した人から
function clearField(st, next = null) {
  st.field = null;
  st.passed = {};
  st.jback = false;
  st.shibari = null;
  if (!activePlayers(st).length) return;
  const who = next ?? st.lead;
  const at = st.players.indexOf(who);
  // 上がってしまった人からは始められないので、その次へ送る
  st.turn = at >= 0 && st.hands[who].length > 0 ? at : indexOfNextActive(st, at);
}

function activePlayers(st) {
  return st.players.filter((p) => st.hands[p].length > 0);
}

function indexOfNextActive(st, from) {
  const n = st.players.length;
  for (let i = 1; i <= n; i++) {
    const at = ((from + i * st.dir) % n + n) % n;
    if (st.hands[st.players[at]].length > 0) return at;
  }
  return from;
}

function nextActive(st, me) {
  return st.players[indexOfNextActive(st, st.players.indexOf(me))];
}

// step 人ぶん進める(5飛ばしで 2 以上になる)。
// 上がった人と、この場でパスした人は飛ばす。
function advance(st, step) {
  const n = st.players.length;
  let at = st.turn;
  let moved = 0;
  for (let i = 1; i <= n * 4 && moved < step; i++) {
    at = ((at + st.dir) % n + n) % n;
    const p = st.players[at];
    if (st.hands[p].length === 0 || st.passed[p]) continue;
    moved++;
    // **5飛ばしで飛ばされた人は「この場ではパスした」ことにする。**
    // 席を素通りするだけにすると、一周して出した本人に手番が戻り、
    // 自分の札の上に自分で出す番ができてしまう(場も流れない)。
    if (moved < step) st.passed[p] = true;
  }
  st.turn = at;
}

function goOut(st, me) {
  st.out.push(me);
  st.log.push({ t: 'out', by: me, place: st.out.length });
  // 都落ち: 前回の大富豪が1番に上がれなかった
  if (st.rules.miyakoochi && st.out.length === 1 && st.titles) {
    const king = st.players.find((p) => st.titles[p] === 'daifugo');
    if (king != null && king !== me && st.hands[king].length > 0) {
      demote(st, king, 'miyakoochi');
    }
  }
  checkFinish(st);
}

// いちばん下へ落とす(都落ち・反則負け)。手札は捨てて、その回から抜ける
function demote(st, me, why, reason = null) {
  st.hands[me] = [];
  st.demoted.push({ player: me, why, reason });
  st.log.push({ t: why, by: me, reason });
  checkFinish(st);
}

function checkFinish(st) {
  if (st.result) return;
  if (activePlayers(st).length <= 1) finish(st);
}

function finish(st) {
  const down = st.demoted.map((d) => d.player);
  const rest = st.players.filter((p) => !st.out.includes(p) && !down.includes(p));
  const order = [...st.out, ...rest, ...down];
  st.result = { order, titles: titlesFor(order) };
  st.phase = 'ended';
  st.awaiting = null;
  st.log.push({ t: 'end', order });
}

// 席を立った人。手札は捨てて、いちばん下へ回す。
//
// **卓の途中で抜けられても回が壊れないようにする。** 抜けた人を残すと
// その人の番で永久に止まるし、消してしまうと順位が人数ぶん揃わない。
export function retire(st, pid) {
  if (!st || st.result) return st;
  if (!st.players.includes(pid)) return st;
  if (st.out.includes(pid) || st.demoted.some((d) => d.player === pid)) return st;
  const wasTurn = st.players[st.turn] === pid;
  const wasAwaited = st.awaiting?.player === pid;
  // 出したあとの 7渡し/10捨てを待っていたなら、そこは飛ばす
  // (選ぶ人がもう居ない)。8切りだけは効かせる。
  if (wasAwaited) st.awaiting = null;
  st.passed[pid] = true;
  demote(st, pid, 'left');
  if (st.result) return st;
  if (st.pendingClear) {
    st.pendingClear = false;
    clearField(st, null);
    return st;
  }
  // 抜けたことで「残り全員パス」になっていれば場を流す
  if (st.field) {
    const others = activePlayers(st).filter((p) => p !== st.lead);
    if (!others.length || others.every((p) => st.passed[p])) {
      clearField(st);
      return st;
    }
  }
  if (wasTurn || wasAwaited) advance(st, 1);
  return st;
}

// ---- 出せる手 ----

// 空でない部分集合(1つの数字は多くても4枚なので数え上げてよい)
function subsets(arr) {
  const out = [];
  for (let mask = 1; mask < (1 << arr.length); mask++) {
    const pick = [];
    for (let i = 0; i < arr.length; i++) if (mask & (1 << i)) pick.push(arr[i]);
    out.push(pick);
  }
  return out;
}

// k 枚の組み合わせ
function combos(arr, k) {
  if (k === 0) return [[]];
  return subsets(arr).filter((s) => s.length === k);
}

// いま出せる手を全部並べる。UI の「出せる札」と、先の CPU のために使う。
// 手札は多くても18枚なので、数え上げても十分速い。
export function legalPlays(st, pid) {
  if (!st || st.result || st.awaiting) return [];
  if (st.players[st.turn] !== pid) return [];
  const hand = st.hands[pid] ?? [];
  const jokers = hand.filter(isJoker);
  const out = [];
  const tryAdd = (cards) => {
    if (!cards.length) return;
    const play = classify(cards, st.rules);
    if (!play) return;
    if (!beatsField(st, play, cards) || !fitsShibari(st, play)) return;
    out.push(cards);
  };

  // 同じ数字(ジョーカーを混ぜてもよい)。**どちらのジョーカーでも出せる**ので
  // 組み合わせを全部並べる ── 片方しか並べないと、もう1枚が UI で死んで見える。
  const byRank = new Map();
  for (const c of hand) {
    if (isJoker(c)) continue;
    if (!byRank.has(rankOf(c))) byRank.set(rankOf(c), []);
    byRank.get(rankOf(c)).push(c);
  }
  const jokerPicks = [[], ...subsets(jokers)];
  for (const group of byRank.values()) {
    for (const pick of subsets(group)) {
      for (const js of jokerPicks) tryAdd([...pick, ...js]);
    }
  }
  for (const js of subsets(jokers)) tryAdd(js);   // ジョーカーだけの組

  // 階段
  if (st.rules.kaidan) {
    for (let s = 0; s < 4; s++) {
      const have = new Set(hand.filter((c) => suitOf(c) === s).map(rankOf));
      for (let lo = 0; lo <= 12; lo++) {
        for (let n = 3; lo + n - 1 <= 12; n++) {
          const want = [];
          let need = 0;
          for (let r = lo; r < lo + n; r++) {
            if (have.has(r)) want.push(s * 13 + r);
            else need++;
          }
          if (need > jokers.length) break;
          for (const js of combos(jokers, need)) tryAdd([...want, ...js]);
        }
      }
    }
  }
  return out;
}

// その席から見た卓。**他人の手札は枚数だけ**にする。
// 通信に乗るのはこれだけなので、ここが伏せ処理の全て。
export function viewFor(st, pid) {
  if (!st) return null;
  const counts = {};
  for (const p of st.players) counts[p] = st.hands[p].length;
  return {
    game: st.game,
    rules: { ...st.rules },
    players: [...st.players],
    counts,
    hand: [...(st.hands[pid] ?? [])],
    field: st.field ? { ...st.field, cards: [...st.field.cards], suits: [...st.field.suits] } : null,
    turn: st.players[st.turn] ?? null,
    passed: { ...st.passed },
    dir: st.dir,
    revolution: st.revolution,
    jback: st.jback,
    reversed: reversed(st),
    shibari: st.shibari ? [...st.shibari] : null,
    out: [...st.out],
    demoted: st.demoted.map((d) => ({ ...d })),
    titles: st.titles ? { ...st.titles } : null,
    phase: st.phase,
    // 待ちは「誰が何枚選ぶか」だけ配る。選ぶ中身は本人の手札にしかない
    awaiting: st.awaiting ? { ...st.awaiting } : null,
    result: st.result
      ? { order: [...st.result.order], titles: { ...st.result.titles } }
      : null,
    log: st.log.slice(-12),
  };
}
