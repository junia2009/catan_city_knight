// 戦績と実績の画面(設計書 §11)
//
// progress.js の集計を表にするだけ。state は読まない。

import { ACHIEVEMENTS, MODE_JP } from '../achievements.js';
import { MODES, achievementCount, summarize, winRate } from '../progress.js';

const MODE_ICON = {
  base: '⬡', cak: '🏰', dragon: '🐉', fish: '🐟', sea: '⛵',
};

function rateCell(n) {
  const r = winRate(n);
  return r == null ? '<span class="zero">—</span>' : `${r}%`;
}

function num(v, unit = '') {
  return v ? `${v}${unit}` : '<span class="zero">—</span>';
}

function statsTable(stats) {
  const rows = MODES.map((mode) => {
    const m = stats.byMode[mode];
    return `<tr>
      <td>${MODE_ICON[mode]} ${MODE_JP[mode]}</td>
      <td>${num(m.played)}</td>
      <td>${num(m.won)}</td>
      <td>${rateCell(m)}</td>
      <td>${num(m.bestPoints, '点')}</td>
      <td>${m.bestTurns == null ? '<span class="zero">—</span>' : `${m.bestTurns}T`}</td>
    </tr>`;
  }).join('');
  const t = stats.total;
  return `<table class="rec-table">
    <thead><tr>
      <th>ルール</th><th>対戦</th><th>勝ち</th><th>勝率</th><th>最高点</th><th>最短</th>
    </tr></thead>
    <tbody>${rows}
      <tr class="rec-total">
        <td>合計</td><td>${num(t.played)}</td><td>${num(t.won)}</td><td>${rateCell(t)}</td>
        <td>${num(t.bestPoints, '点')}</td>
        <td>${t.bestTurns == null ? '<span class="zero">—</span>' : `${t.bestTurns}T`}</td>
      </tr>
    </tbody></table>`;
}

function achievementList(progress) {
  // 解除済みを先に、その中では取った順に並べる
  const got = ACHIEVEMENTS.filter((a) => progress.achievements[a.id])
    .sort((a, b) => progress.achievements[a.id].at - progress.achievements[b.id].at);
  const left = ACHIEVEMENTS.filter((a) => !progress.achievements[a.id]);
  const row = (a, locked) => `<div class="ach ${locked ? 'locked' : ''}">
    <span class="aicon">${locked ? '🔒' : a.icon}</span>
    <span><b>${locked ? '???' : a.name}</b><small>${a.desc}</small></span>
  </div>`;
  return [...got.map((a) => row(a, false)), ...left.map((a) => row(a, true))].join('');
}

export function recordsHtml(progress, { confirmingClear = false } = {}) {
  const stats = summarize(progress);
  const c = achievementCount(progress);
  const empty = stats.total.played === 0;
  return `<h3>📊 戦績と実績</h3>
    ${empty ? '<p>まだ対戦の記録がありません。1戦遊ぶとここに残ります。</p>' : ''}
    ${statsTable(stats)}
    <p class="ach-head">🎖 実績 ${c.got} / ${c.total}</p>
    ${achievementList(progress)}
    <p><small>記録はこの端末にだけ保存されます(サーバーには送りません)。
    オンライン対戦は数えていません。</small></p>
    ${confirmingClear
      ? `<p class="ach-head">⚠️ 戦績も実績も全て消えます。元には戻せません。</p>
         <div class="row end rules-close">
           <button data-act="records-clear-do">消す</button>
           <button class="primary" data-act="records-clear-cancel">やめる</button>
         </div>`
      : `<div class="row end rules-close">
           <button data-act="records-clear" ${empty ? 'disabled' : ''}>記録を消す</button>
           <button class="primary" data-act="goto-title">← タイトルへ</button>
         </div>`}`;
}
