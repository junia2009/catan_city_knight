// 戦績と実績の画面(設計書 §11)
//
// progress.js の集計を描くだけ。state は読まない。
// 実績が22個あるので、縦に並べると3画面ぶんスクロールすることになる。
// タブで戦績と分け、実績はバッジのグリッドにして1画面に収める
// (詳細は選んだ1つだけ下に出す)。

import {
  ACHIEVEMENTS, MODE_JP, TIERS, TIER_ICON, TIER_JP,
  achievementById, progressOf,
} from '../achievements.js';
import { MODES, achievementCount, fishbookCount, summarize, winRate } from '../progress.js';
import { FISH } from '../minigame/fish.js';

const MODE_ICON = {
  base: '⬡', cak: '🏰', dragon: '🐉', fish: '🐟', sea: '⛵',
};

// 釣り図鑑。まだ釣っていないものは「?」で伏せる ── 何がいるか全部見えていると、
// 港をめぐって探す楽しみが無くなる。等級だけは色で分かるようにしておく。
const TIER_LABEL = {
  junk: 'ガラクタ', common: 'よくいる', rare: '大物', legend: '港のぬし', myth: 'まぼろし',
};

function fishbook(progress) {
  const book = progress.fish ?? {};
  const c = fishbookCount(progress, FISH.length);
  const rows = FISH.map((f) => {
    const got = book[f.id];
    return `<div class="fbook-a t-${f.tier} ${got ? 'got' : 'locked'}">
      <span class="bicon">${got ? f.icon : '❔'}</span>
      <b>${got ? f.name : '???'}</b>
      <small>${got ? `${got.best} cm ・ ${got.n}匹` : TIER_LABEL[f.tier]}</small>
    </div>`;
  }).join('');
  return `<p class="fbook-head">図鑑 <b>${c.got}/${c.total}</b> 種類 ・ ぜんぶで <b>${c.caught}</b> 匹</p>
    <div class="fbook">${rows}</div>
    <p><small>島を歩くモードで、港のそばに立つと釣れます。
    「港のぬし」はその港でしか釣れません。</small></p>`;
}

const dash = '<span class="zero">—</span>';
const num = (v, unit = '') => (v ? `${v}${unit}` : dash);

// ---- 戦績 ----

function statsTable(stats) {
  const rows = MODES.map((mode) => {
    const m = stats.byMode[mode];
    const r = winRate(m);
    return `<tr>
      <td>${MODE_ICON[mode]} ${MODE_JP[mode]}</td>
      <td>${m.played ? `${m.won}/${m.played}` : dash}</td>
      <td>${r == null ? dash : `${r}%`}</td>
      <td>${num(m.bestPoints, '点')}</td>
      <td>${m.bestTurns == null ? dash : `${m.bestTurns}T`}</td>
    </tr>`;
  }).join('');
  const t = stats.total;
  const tr = winRate(t);
  return `<table class="rec-table">
    <thead><tr>
      <th>ルール</th><th>勝/戦</th><th>勝率</th><th>最高点</th><th>最短</th>
    </tr></thead>
    <tbody>${rows}
      <tr class="rec-total">
        <td>合計</td>
        <td>${t.played ? `${t.won}/${t.played}` : dash}</td>
        <td>${tr == null ? dash : `${tr}%`}</td>
        <td>${num(t.bestPoints, '点')}</td>
        <td>${t.bestTurns == null ? dash : `${t.bestTurns}T`}</td>
      </tr>
    </tbody></table>`;
}

// ---- 実績 ----

// 難度ごとの獲得数。「🥇1/4」の並び
function tierSummary(progress) {
  return TIERS.map((tier) => {
    const all = ACHIEVEMENTS.filter((a) => a.tier === tier);
    const got = all.filter((a) => progress.achievements[a.id]).length;
    return `<span class="tchip t-${tier} ${got === all.length ? 'done' : ''}"
      title="${TIER_JP[tier]}">${TIER_ICON[tier]} ${got}/${all.length}</span>`;
  }).join('');
}

// バッジのグリッド。取っていないものもアイコンは出す(何を狙えるか見えるように)
function badgeGrid(progress, stats, selected) {
  // 難度の高い順 → 取得済みが先。取りたいものが上に来る並び
  const order = [...ACHIEVEMENTS].sort((a, b) => {
    const got = (x) => (progress.achievements[x.id] ? 0 : 1);
    if (got(a) !== got(b)) return got(a) - got(b);
    return TIERS.indexOf(a.tier) - TIERS.indexOf(b.tier);
  });
  return `<div class="badges">${order.map((a) => {
    const has = !!progress.achievements[a.id];
    const pr = has ? null : progressOf(a, stats);
    // あと少しのものは進捗を出す。0/13 のような「まだ手つかず」は出さない
    const near = pr && pr.now > 0 ? `<small>${pr.now}/${pr.goal}</small>` : '';
    return `<button class="badge-a t-${a.tier} ${has ? 'got' : 'locked'}
      ${selected === a.id ? 'sel' : ''}" data-act="ach-pick:${a.id}" title="${a.name}">
      <span class="bicon">${a.icon}</span>${near}</button>`;
  }).join('')}</div>`;
}

// 選んだ1つの詳細。ここから称号を名乗る
function badgeDetail(progress, stats, selected) {
  const a = achievementById(selected);
  if (!a) {
    return '<p class="ach-hint">バッジをタップすると、条件と称号が出ます。</p>';
  }
  const has = !!progress.achievements[a.id];
  const pr = progressOf(a, stats);
  const bar = pr && !has
    ? `<div class="pbar"><i style="width:${Math.min(100, (pr.now / pr.goal) * 100)}%"></i></div>
       <small class="pnum">${pr.now}/${pr.goal}${pr.unit}</small>`
    : '';
  const wearing = progress.title === a.id;
  const btn = has
    ? (wearing
      ? '<button data-act="title-set:none">称号を外す</button>'
      : `<button class="primary" data-act="title-set:${a.id}">この称号を名乗る</button>`)
    : '<small class="ach-hint">達成すると称号を名乗れます</small>';
  return `<div class="ach-detail t-${a.tier} ${has ? 'got' : ''}">
    <div class="ach-dhead">
      <span class="bicon">${has ? a.icon : '🔒'}</span>
      <span><b>${a.name}</b>
        <small>${TIER_ICON[a.tier]} ${a.mode ? MODE_JP[a.mode] : 'すべてのルール'}</small></span>
    </div>
    <p>${a.desc}</p>
    ${bar}
    <div class="ach-title-row">
      <span class="ttag ${wearing ? 'on' : ''}">称号「${a.title}」</span>
      ${btn}
    </div>
  </div>`;
}

// ---- 画面 ----

export function recordsHtml(progress, { tab = 'stats', selected = null, confirmingClear = false } = {}) {
  const stats = summarize(progress);
  const c = achievementCount(progress);
  const empty = stats.total.played === 0;
  const now = progress.title && progress.achievements[progress.title]
    ? achievementById(progress.title)?.title
    : null;

  const tabs = `<div class="rec-tabs">
    <button class="${tab === 'stats' ? 'sel' : ''}" data-act="rec-tab:stats">📊 戦績</button>
    <button class="${tab === 'ach' ? 'sel' : ''}" data-act="rec-tab:ach">🎖 実績 ${c.got}/${c.total}</button>
    <button class="${tab === 'fish' ? 'sel' : ''}" data-act="rec-tab:fish">🎣 釣り</button>
  </div>`;

  const body = tab === 'fish'
    ? fishbook(progress)
    : tab === 'ach'
    ? `<div class="tiers">${tierSummary(progress)}</div>
       ${badgeGrid(progress, stats, selected)}
       ${badgeDetail(progress, stats, selected)}`
    : `${empty ? '<p>まだ対戦の記録がありません。1戦遊ぶとここに残ります。</p>' : ''}
       ${statsTable(stats)}
       <p><small>記録はこの端末にだけ保存されます(サーバーには送りません)。
       オンライン対戦は数えていません。</small></p>`;

  return `<h3>${now ? `〈${now}〉` : '戦績と実績'}</h3>
    ${tabs}
    ${body}
    ${confirmingClear
      ? `<p class="ach-head">⚠️ 戦績も実績も称号も全て消えます。元には戻せません。</p>
         <div class="row end rules-close">
           <button data-act="records-clear-do">消す</button>
           <button class="primary" data-act="records-clear-cancel">やめる</button>
         </div>`
      : `<div class="row end rules-close">
           <button data-act="records-clear" ${empty ? 'disabled' : ''}>記録を消す</button>
           <button class="primary" data-act="goto-title">← タイトルへ</button>
         </div>`}`;
}
