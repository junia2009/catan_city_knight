// ルール説明書(タイトル画面・設定シートから開く)
// 進歩カードの一覧は PROGRESS_CARDS から自動生成するので実装と常に一致する。

import { PROGRESS_CARDS } from '../rules/cak/progress-cards.js';

export const RULES_TABS = [
  ['basic', '基本ルール'],
  ['cak', '都市と騎士'],
  ['cards', '進歩カード'],
];

const costRow = (icon, name, cost) =>
  `<div class="rrow"><span class="ricon">${icon}</span><b>${name}</b><span class="rcost">${cost}</span></div>`;

function basicHtml() {
  return `
  <h4>🏆 ゲームの目的</h4>
  <p>島に開拓地や都市を築いて<b>勝利点</b>を集めます。基本ルールは<b>10点</b>、都市と騎士は<b>13点</b>で勝利です。</p>

  <h4>🎲 手番の流れ</h4>
  <ol>
    <li><b>ダイスを振る</b> — 出目の数字ヘックスに隣接する建物が資源を得ます(開拓地1枚・都市2枚)</li>
    <li><b>建設・交易・カード</b> — 好きな順で何度でも</li>
    <li><b>ターン終了</b></li>
  </ol>

  <h4>🏗 建設コスト</h4>
  ${costRow('🛤', '道', '🪵1 🧱1')}
  ${costRow('🏠', '開拓地', '🪵1 🧱1 🐑1 🌾1(既存の建物から2辺以上離す・自分の道に接続)')}
  ${costRow('🏰', '都市', '🌾2 🪨3(自分の開拓地を昇格。+2点・資源2倍)')}
  ${costRow('📜', '発展カード', '🐑1 🌾1 🪨1(基本ルールのみ)')}

  <h4>⚖️ 交易</h4>
  <p>銀行とは<b>4:1</b>で交換できます。<b>3:1港</b>・<b>2:1専用港</b>に開拓地があるとレートが上がります。
  「プレイヤー」タブから<b>CPUとの交渉</b>もできます — 得だと判断したCPUが応じ、CPUから提案が届くこともあります。</p>

  <h4>🥷 盗賊と「7」</h4>
  <p>7が出ると資源は誰にも入らず、<b>手札8枚以上のプレイヤーは半分を捨てます</b>。
  手番プレイヤーは盗賊を移動し、隣接する相手から1枚奪います。盗賊のいるヘックスは資源が出ません。</p>

  <h4>📜 発展カード(基本ルール)</h4>
  <p>⚔️騎士(盗賊を移動・3枚で最大騎士力+2点) / 🛤️街道建設 / 🧺収穫 / 🎩独占 / ⭐勝利点。買ったターンには使えません。</p>

  <h4>🛤 最長交易路</h4>
  <p>途切れない自分の道が<b>5本以上</b>で最長のプレイヤーに<b>+2点</b>。</p>`;
}

function cakHtml() {
  return `
  <h4>🏙 基本ルールとの違い</h4>
  <div class="rrow"><b>勝利点</b><span class="rcost">13点(基本は10点)</span></div>
  <div class="rrow"><b>初期配置</b><span class="rcost">開拓地×1 + 都市×1</span></div>
  <div class="rrow"><b>都市の産出</b><span class="rcost">資源1 + 商品1(森=📜紙・山=🪙コイン・牧草=🧵布)</span></div>
  <div class="rrow"><b>発展カード</b><span class="rcost">廃止 → 進歩カードに置き換え</span></div>

  <h4>🎲 3つのダイス</h4>
  <p>赤+黄の合計で資源分配。<b>イベントダイス</b>が加わります:</p>
  <p>⛵<b>船</b> … 蛮族船が1マス前進 / 🧵🪙📜<b>色</b> … その系統の都市改良Lvが高いと進歩カード獲得
  (<b>赤ダイスの目 ≦ 自分のLv+1</b> で1枚)</p>

  <h4>⚔️ 蛮族の襲来</h4>
  <p>船の目で蛮族船が島へ近づき、<b>7マス目で襲来</b>。
  <b>蛮族の強さ(全員の都市数)vs 防衛力(活性騎士のLv合計)</b>で判定します。</p>
  <p>🛡 <b>防衛成功</b> → 最大貢献者に守護者+1点(同点なら全員に進歩カード)<br>
  💥 <b>防衛失敗</b> → 最少貢献者の都市が開拓地に降格。襲来後は全騎士が不活性に戻ります。</p>

  <h4>🐴 騎士</h4>
  ${costRow('⚔️', '建設', '🐑1 🪨1(不活性で配置)')}
  ${costRow('🌾', '活性化', '🌾1(活性化したターンは行動不可)')}
  ${costRow('⬆', '昇格', '🐑1 🪨1(Lv3は政治Lv3が必要)')}
  <p>活性騎士は「移動」「格下の敵騎士の追い出し」「隣接ヘックスの盗賊追い払い」ができます。</p>

  <h4>🏙 都市改良とメトロポリス</h4>
  <p>3系統(🧵交易・🪙政治・📜科学)を商品で改良。<b>Lv n には商品 n 枚</b>。
  Lv3でその商品の2:1交易解禁、各系統で最初にLv4到達で<b>メトロポリス+2点</b>(Lv5で追い越されると移動)。</p>

  <h4>🧱 城壁</h4>
  <p>🧱2で都市の下に建設(最大3枚)。7のときの手札上限が<b>7→+2/枚</b>。都市が降格すると城壁も失います。</p>

  <h4>🃏 進歩カード</h4>
  <p>手札上限4枚。勝利点カード(憲法・印刷機)は引いた瞬間に公開されて+1点。
  獲得したターンには使えません。カードの効果は「進歩カード」タブへ。</p>`;
}

function cardsHtml() {
  const deckJp = { trade: '🧵 交易(黄)', politics: '🪙 政治(青)', science: '📜 科学(緑)' };
  const sections = ['trade', 'politics', 'science'].map((deck) => {
    const rows = Object.values(PROGRESS_CARDS)
      .filter((def) => def.deck === deck)
      .map(
        (def) => `<div class="rcard">
          <span class="ricon">${def.icon}</span>
          <div><b>${def.name}</b><small>×${def.count}${def.vp ? '・勝利点' : ''}${def.preRoll ? '・ロール前に使用' : ''}</small>
          <p>${def.desc}</p></div>
        </div>`,
      )
      .join('');
    return `<h4>${deckJp[deck]} 18枚</h4>${rows}`;
  });
  return `
  <p>イベントダイスで系統の色が出て、<b>赤ダイスの目 ≦ その系統の都市改良Lv+1</b> のとき1枚獲得します。
  手札のカードをタップすると説明と「使う」ボタンが出ます。</p>
  ${sections.join('')}`;
}

// タブ付きの説明書本体。tabAct のボタンで data-act="rules-tab:<id>" を発行する
export function rulesHtml(tab = 'basic') {
  const tabs = `<div class="seg rules-tabs">${RULES_TABS.map(
    ([id, label]) =>
      `<button class="${tab === id ? 'sel' : ''}" data-act="rules-tab:${id}">${label}</button>`,
  ).join('')}</div>`;
  const body = tab === 'cak' ? cakHtml() : tab === 'cards' ? cardsHtml() : basicHtml();
  return `${tabs}<div class="rules-body">${body}</div>`;
}
