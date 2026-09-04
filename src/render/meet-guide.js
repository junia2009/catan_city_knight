// ミニゲーム(散策部屋の集まり)のあそびかた。
//
// 遊びが4つに増えて、受付の一文(meets.js の hint)だけでは何をすれば
// よいのか分からなくなった。**操作は画面のどこにも書いていない** ──
// 「押している間だけ弓を引く」「離すのは損ではない」といった肝心なことは、
// 触って気づくまで気づけない。ここに1か所へ集めて、
//   - 島を歩いている最中 … HUD の ❓(この島のぶんだけ)
//   - タイトルの説明書   … 「🎪 集まり」タブ(全部)
// の両方から同じ文章を出す。
//
// **文章だけを持つ。** state も DOM も見ないので、テストから素で読める。
// 遊びを1つ足したら meets.js と対で GUIDES にも足す
// (test/meet-guide.test.js が「受付はあるのに説明が無い」で落ちる)。
//
// 秒数は**サーバーの定数と同じ数字**を書き写している。ここは server/ を
// 読まない(クライアントがサーバーのコードを取り込む向きは作らない)ので、
// 代わりにテストが両方を突き合わせて、ずれたら落とす。

import { MODE_JP } from '../achievements.js';
import { MEETS } from '../minigame/meets.js';
import { RULES as DFG_RULES } from '../minigame/daifugo.js';

// 分:秒 の言い方。3分・1分30秒 のように、割り切れるところは切る
export function minutes(ms) {
  const t = Math.round(ms / 1000);
  const m = Math.floor(t / 60);
  const s = t % 60;
  if (!m) return `${s}秒`;
  return s ? `${m}分${s}秒` : `${m}分`;
}

// 何人からはじめられるか(server/meet-core.js の MIN_PLAYERS と同じ)
export const MIN_PLAYERS = 2;

export const GUIDES = {
  fishing: {
    ms: 180000,
    goal: '制限時間のあいだに釣った魚の<b>合計の長さ</b>を競います。何匹釣ってもかまいません。',
    steps: [
      ['🎣', 'なげる', '港のそばに立つと 🎣 が出ます。押すと投げます'],
      ['❗', '引く!', '浮きが赤く光ったら押して合わせます。早すぎると逃げられます'],
      ['🎣', 'まく', '<b>押している間だけ巻きます。</b>巻くと糸の張り(上のバー)が上がり、離すと下がります'],
      ['🐟', 'とりこむ', '下のバーが満ちたら釣れます。張りきると糸が切れます'],
    ],
    tips: [
      '<b>手を離すのは損ではありません。</b>取り込みはゆっくり戻るだけなので、張りを見ながら押したり離したりします',
      '魚はときどき暴れて張りを跳ね上げます。そこで指を離せるかの勝負です',
      'ガラクタは 0cm。大物ほど引きが強く、巻き上げに時間がかかります',
    ],
    note: '釣ったものは大会に出ていなくても<b>図鑑(📖)に残ります</b>。港はどの島にもあります。',
  },
  dragonhunt: {
    ms: 90000,
    goal: '竜に捕まらずに逃げます。順位は<b>生き残った時間</b>。最後まで残れば1位です。',
    steps: [
      ['🏃', 'ちらばる', 'はじめの4秒は竜が飛び立ちません。そのあいだに散らばります'],
      ['🐉', 'にげる', '竜はいちばん近い人を追いかけます。捕まったらその回は脱落です'],
      ['⏱', 'にげきる', `${minutes(90000)}逃げきるか、最後のひとりになったら終わりです`],
    ],
    tips: [
      '竜は歩きより<b>少し遅い</b>ので、まっすぐ逃げれば追いつかれません。ただし曲がるのが下手です',
      '<b>木の陰に回りこんで</b>急に向きを変えると振り切れます。竜は飛んでいるので木は素通りします',
      '固まっていると狙われ続けます。近い人が狙われるので、散らばるほど楽になります',
      '画面の 🐉 の矢印が、竜がどちらから来ているかを指しています',
    ],
  },
  raid: {
    ms: 120000,
    goal: '浜の物見の櫓から、沖より寄せる蛮族船を射ます。<b>撃退した点</b>を競います。',
    steps: [
      ['🏹', 'かまえる', '浜の櫓に登ると 🏹 が出ます'],
      ['💪', 'ひきしぼる', '<b>押している間、弓を引き絞ります。</b>離すと放ちます'],
      ['🎯', 'とどかせる', '引き絞るほど遠くへ飛びます。連打では近くにしか届きません'],
    ],
    score: '船を沈めて <b>3点</b>、蛮族ひとりで <b>1点</b>。船を沈めれば<b>積んでいる蛮族ごと</b>止められます。',
    tips: [
      '取り逃がした船は浜に降り、蛮族が櫓へ歩いてきます。<b>3回着かれたら終わり</b>です',
      '沖の船は満まで引かないと届きません。浜まで来た蛮族は弱く引いても当たります',
      '画面の端の三角が、画面の外にいる敵の方向です',
      '波が進むほど船が増えます。序盤にどれだけ沖で沈められるかで点が伸びます',
    ],
  },
  daifugo: {
    autoMs: 45000,
    goal: '円卓を囲んで札を出し合い、<b>手札を先に無くした人が上位</b>。順位で大富豪〜大貧民の称号がつきます。',
    steps: [
      ['🪑', 'エントリー', `受付でエントリーします。${MIN_PLAYERS}人からはじめられます`],
      ['🃏', 'えらぶ', '円卓に着くと画面の下半分が自分の手札です。出す札をタップして選びます'],
      ['👊', 'だす', '場より強ければ「出す」。出せないときは「パス」'],
      ['⏱', 'まかせる', `${minutes(45000)}で手番が切れると、いちばん弱い手が自動で出ます`],
    ],
    rules: [
      '弱い順に <b>3 4 5 6 7 8 9 10 J Q K A 2</b>、いちばん強いのがジョーカー',
      '場と<b>同じ枚数</b>で、より強い札しか出せません(2枚出しには2枚)',
      '同じ数字を複数枚まとめて出せます。その場合は数字の強さで比べます',
      '<b>最後に出した人以外が全員パスすると場が流れ</b>、その人から出しなおします',
    ],
    note: '入れるルールは<b>ゲームマスター(部屋を立てた人)</b>が決めます。受付の「🃏 ルールを決める」から。',
  },
};

const stepRow = ([icon, label, text]) =>
  `<div class="rcard"><span class="ricon">${icon}</span><div><b>${label}</b><p>${text}</p></div></div>`;

const list = (items) => `<ul class="mg-list">${items.map((t) => `<li>${t}</li>`).join('')}</ul>`;

// 大富豪の「入れるルール」の一覧。rules を渡すと、いま入っているものに印がつく
// (受付で見ている人が、この卓が今どう回るのかを読めるように)。
function dfgRulesHtml(rules) {
  const rows = DFG_RULES.map((r) => {
    const on = rules ? !!rules[r.id] : r.on;
    const tag = rules
      ? (on ? '<span class="mg-on">入っている</span>' : '<span class="mg-off">なし</span>')
      : (r.on ? '<span class="mg-on">はじめから入っている</span>' : '');
    return `<div class="rrow mg-rule${on ? ' on' : ''}"><b>${r.name}</b>
      <span class="rcost">${tag}</span></div><p class="mg-desc">${r.desc}</p>`;
  }).join('');
  return `<h4>🃏 入れるルール(13種)</h4>
    <p>${rules ? 'この卓に' : 'ゲームマスターが'}入れるものを選びます。${
      rules ? '' : '5つは<b>はじめから入っています</b>。'}</p>${rows}`;
}

// 集まり1つぶんの説明。id は meets.js の id(fishing / dragonhunt / raid / daifugo)
export function guideBodyHtml(id, { rules = null } = {}) {
  const g = GUIDES[id];
  if (!g) return '';
  const meet = Object.values(MEETS).find((m) => m.id === id);
  const limit = g.ms
    ? `<div class="rrow"><b>制限時間</b><span class="rcost">${minutes(g.ms)}</span></div>`
    : '<div class="rrow"><b>おわり</b><span class="rcost">決着まで(何回戦でも)</span></div>';
  return `<h4>${meet?.title ?? ''}</h4>
    <p>${g.goal}</p>
    ${limit}
    <div class="rrow"><b>人数</b><span class="rcost">${MIN_PLAYERS}人から</span></div>
    <h4>🎮 やりかた</h4>
    ${g.steps.map(stepRow).join('')}
    ${g.rules ? `<h4>🔢 札の決まり</h4>${list(g.rules)}` : ''}
    ${g.score ? `<h4>🏆 点の入りかた</h4><p>${g.score}</p>` : ''}
    ${g.tips ? `<h4>💡 コツ</h4>${list(g.tips)}` : ''}
    ${g.note ? `<p class="mg-note">${g.note}</p>` : ''}
    ${id === 'daifugo' ? dfgRulesHtml(rules) : ''}`;
}

// 島ごとに、**ひとりでも触れるもの**。
//
// 港の釣りはどの島にもあるので別枠。櫓(蛮族を射る)は都市と騎士だけ、
// 巣の竜はドラゴンの島だけ ── どちらも進行が手元にあるので、ひとりでも動く。
// **集まり(大会)はここに入れない。** サーバーが要るので、混ぜて並べると
// 「基本の島を選べば大富豪がひとりで遊べる」と読めてしまう。
// **集まりと同じ名前で書かない。** 都市と騎士の島は、櫓に立てばひとりでも
// 撃てる ── 集まりのほうは「順位を競う」だけの違いなので、同じ言葉で並べると
// 「ひとりでは撃てない」とも「ひとりで大会ができる」とも読めてしまう。
const SOLO = {
  cak: ['🏹 浜の物見の櫓で弓を構える(ひとりでも撃てる)'],
  dragon: ['🐉 山の上の巣で眠る竜に会う'],
};
const SOLO_ANY = '🎣 港で釣り(釣ったものは図鑑に残る)';

export function islandSolo(mode) {
  return [SOLO_ANY, ...(SOLO[mode] ?? [])];
}

// 島を選ぶところに出す一言。**ひとりでできることと、人が要ることを分ける。**
export function islandNoteHtml(mode) {
  const meet = MEETS[mode];
  return `<div class="mg-solo">
    ${islandSolo(mode).map((t) => `<div>${t}</div>`).join('')}
    <div class="mg-dim">${meet
      ? `🎪 中心に<b>${meet.name}</b>の受付。順位を競う集まりは、オンラインで人が集まったときだけ開けます`
      : '🎪 この島に受付はありません'}</div></div>`;
}

// 島の歩きかた。どの島でも同じなので、集まりの説明とは別に置く
export function walkGuideHtml() {
  return `<h4>🚶 島のあるきかた</h4>
    ${stepRow(['👆', 'うごく', '画面の<b>左半分</b>をなぞると歩きます'])}
    ${stepRow(['👀', 'みまわす', '画面の<b>右半分</b>をなぞると視点が回ります'])}
    ${stepRow(['⤒', 'とぶ', '右下の ⤒ でジャンプ。段差を越えられます'])}
    <p class="mg-note">上の帯から 🧍 すがた ・ 😀 エモート ・ 📖 釣り図鑑 ・ ✕ もどる。
    ここは対戦の盤の上なので、<b>同じ部屋の人とは同じ島を歩いています</b>。</p>`;
}

// 島を歩いている最中に開くぶん。この島の集まりだけを出す
export function meetGuideHtml(id, opts = {}) {
  const body = guideBodyHtml(id, opts);
  return body
    ? `${body}<hr class="mg-hr">${walkGuideHtml()}`
    : `<h4>🎪 この島に受付はありません</h4>
       <p>集まりが開けるのは基本・都市と騎士・ドラゴン・漁師たちの島です。
       港はどの島にもあるので、歩いて釣ることはできます。</p>
       ${walkGuideHtml()}`;
}

// 説明書の「🎪 集まり」タブ。全部の島のぶんを並べる
export function meetsGuideHtml() {
  // 並びは MEETS のまま。上の一覧と下の説明が同じ順で並ぶ
  const order = Object.values(MEETS).map((m) => m.id);
  const where = Object.entries(MEETS)
    .map(([mode, m]) => `<div class="rrow"><b>${MODE_JP[mode] ?? mode}</b><span class="rcost">${m.title}</span></div>`)
    .join('');
  return `<p>オンラインで部屋を立てて<b>「島を歩く」</b>と、選んだ島を全員で歩けます。
    島の中心には受付が立っていて、そこから<b>みんなで遊ぶ集まり</b>を開けます。</p>
    ${where}
    <p class="mg-note">遊びは島ごとに違います。集まりに出なくても、島は自由に歩けます。</p>
    ${walkGuideHtml()}
    ${order.map((id) => `<hr class="mg-hr">${guideBodyHtml(id)}`).join('')}`;
}
