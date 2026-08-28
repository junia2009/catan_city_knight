// 蛮族襲来(設計書 §9.3)
// イベントダイスの船で襲来トラックが前進し、7マス目で襲来を解決する。

import { addLog } from '../../state.js';

export const BARBARIAN_TRACK_LENGTH = 7;

export function barbarianStrength(state) {
  return Object.values(state.buildings).filter((b) => b.type === 'city').length;
}

export function knightContribution(state, pid) {
  return Object.values(state.knights)
    .filter((k) => k.player === pid && k.active)
    .reduce((s, k) => s + k.level, 0);
}

export function totalDefense(state) {
  return state.players.reduce((s, p) => s + knightContribution(state, p.id), 0);
}

// メトロポリスでない自分の都市(降格対象になり得るもの)
export function razableCities(state, pid) {
  const metros = new Set(Object.values(state.metropolis).filter(Boolean));
  return Object.entries(state.buildings)
    .filter(([vid, b]) => b.player === pid && b.type === 'city' && !metros.has(vid))
    .map(([vid]) => vid);
}

export function razeCity(state, vid) {
  const b = state.buildings[vid];
  b.type = 'settlement';
  if (state.walls[vid] != null) delete state.walls[vid]; // 城壁も除去(設計書 §9.6)
  addLog(state, `${state.players[b.player].name}の都市が開拓地に降格しました`);
}

// 襲来の解決。本人の選択が要る場合は呼び出し側が awaiting を張れるよう、
// { raze, deck } を返す ── raze は降格する都市を選ぶ人、deck は防衛が同点で
// 進歩カードを引く山を選ぶ人(どちらか一方しか出ない)。
export function resolveBarbarianAttack(state) {
  const strength = barbarianStrength(state);
  const contributions = state.players.map((p) => knightContribution(state, p.id));
  const defense = contributions.reduce((a, b) => a + b, 0);
  addLog(state, `⚔️ 蛮族襲来! 蛮族${strength} vs 防衛${defense}`);

  const needRaze = [];
  const needDeck = [];

  if (defense >= strength) {
    // 防衛成功: 最大貢献者に守護者1点(同点なら全員に進歩カード)
    const max = Math.max(...contributions);
    const tops = state.players.filter((p) => contributions[p.id] === max && max > 0);
    if (tops.length === 1) {
      tops[0].defenderPoints += 1;
      addLog(state, `🛡 ${tops[0].name}が「島の守護者」を獲得! +1点`);
    } else if (tops.length > 1) {
      // 同点なら守護者は出ず、各自が「好きな系統の山」から1枚引く(公式)。
      // どの山かは本人が選ぶので、呼び出し側が awaiting を張る。
      needDeck.push(...tops.map((p) => p.id));
      addLog(state, `🛡 防衛の功が並びました。${tops.map((p) => p.name).join('・')}が進歩カードを1枚引きます`);
    } else {
      addLog(state, '都市がなく、蛮族は引き返しました');
    }
  } else {
    // 防衛失敗: 最少貢献者(都市を持つプレイヤーのみ)の都市が降格
    const owners = state.players.filter((p) => razableCities(state, p.id).length > 0);
    if (owners.length) {
      const min = Math.min(...owners.map((p) => contributions[p.id]));
      const losers = owners.filter((p) => contributions[p.id] === min);
      for (const p of losers) {
        const cities = razableCities(state, p.id);
        if (cities.length === 1) {
          razeCity(state, cities[0]);
        } else {
          needRaze.push(p.id); // 複数あれば本人が選ぶ
        }
      }
    }
  }

  // 襲来後: トラックリセット + 全騎士不活性化
  state.barbarians.position = 0;
  for (const k of Object.values(state.knights)) k.active = false;
  addLog(state, '全ての騎士が不活性になりました');

  return { raze: needRaze, deck: needDeck };
}
