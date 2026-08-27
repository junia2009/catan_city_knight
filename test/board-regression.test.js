// 盤面まわりを改修したときの回帰テスト。
//
// 盤面の生成と対戦の進行はシードで完全に決まるので、モード×シードごとに
// 「盤面」と「対戦の結果」をハッシュにして固定しておく。
// LAYOUT や盤面生成に手を入れたとき、この値が変わったら
// 既存モードの挙動を壊している(= 同じシードで違う盤面・違う展開になっている)。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createGame, RESOURCES } from '../src/state.js';
import { dispatch } from '../src/actions.js';
import { chooseAction } from '../src/ai/cpu-player.js';
import { computePoints } from '../src/rules/victory.js';

const MODES = ['base', 'cak', 'dragon', 'fish'];
const SEEDS = [1, 2, 3];

function sha(obj) {
  return createHash('sha256').update(JSON.stringify(obj)).digest('hex').slice(0, 16);
}

// 盤面の中身だけを、並び順を固定して取り出す(hexId の昇順)。
// 内部表現に何を足しても、この見え方が同じなら盤面は変わっていない。
function boardFingerprint(board) {
  const hexes = Object.keys(board.hexes)
    .sort()
    .map((hid) => {
      const h = board.hexes[hid];
      return [hid, h.terrain, h.token ?? null];
    });
  return {
    hexes,
    robber: board.robber,
    ports: board.ports.map((p) => [p.edgeId, p.type]),
    fisheries: (board.fisheries ?? []).map((f) => [f.edgeId, f.number]),
    lake: board.lake ?? null,
  };
}

// 対戦を最後まで回して、結果の要点を取り出す
function playFingerprint(mode, seed) {
  let state = createGame({ seed, playerCount: 4, humanIndex: -1, mode });
  const board = boardFingerprint(state.board);
  let actions = 0;
  const kinds = {};
  while (state.phase !== 'ended') {
    if (++actions > 6000) throw new Error(`${mode}/${seed}: 6000アクション超過`);
    const pid = state.awaiting ? state.awaiting.players[0] : state.currentPlayer;
    const action = chooseAction(state, pid);
    kinds[action.type] = (kinds[action.type] ?? 0) + 1;
    state = dispatch(state, action);
  }
  return {
    board,
    actions,
    kinds,
    turn: state.turn,
    winner: state.winner,
    points: state.players.map((p) => computePoints(state, p.id, { includeHidden: true })),
    resources: state.players.map((p) => RESOURCES.map((r) => p.resources[r])),
    bank: RESOURCES.map((r) => state.bank.resources[r]),
    diceCounts: state.diceCounts,
    logLength: state.log.length,
  };
}

// モード/シード -> ハッシュ。盤面を意図的に変えたときだけ更新すること。
const GOLDEN = {
  'base/1': '6e816bdc73a03bd3',
  'base/2': '22b688736b31e38e',
  'base/3': 'd448dc72d1b2eb04',
  'cak/1': '4bf4337b271720f4',
  'cak/2': '5a8509abd60025f0',
  'cak/3': 'f0f794e91751db80',
  'dragon/1': 'f52887297fc591f3',
  'dragon/2': '1abec8750665e59c',
  'dragon/3': 'a55cc19e86c05e3c',
  'fish/1': '300093c14fd3c862',
  'fish/2': '574860fc1b46e2e0',
  'fish/3': '08e248925e023cae',
};

test('回帰: 既存モードの盤面と展開がシードから完全に再現される', () => {
  const actual = {};
  for (const mode of MODES) {
    for (const seed of SEEDS) {
      actual[`${mode}/${seed}`] = sha(playFingerprint(mode, seed));
    }
  }
  // GOLDEN が未設定なら、いま出た値を出力して落とす(初回の焼き付け用)
  const missing = Object.entries(GOLDEN).filter(([, v]) => v == null).map(([k]) => k);
  assert.equal(
    missing.length, 0,
    `GOLDEN が未設定です。次の値を貼り付けてください:\n${
      Object.entries(actual).map(([k, v]) => `  '${k}': '${v}',`).join('\n')}`,
  );
  assert.deepEqual(actual, GOLDEN, '同じシードで盤面か展開が変わっています');
});

test('回帰: 同じシードなら2回作っても同じ盤面になる', () => {
  for (const mode of MODES) {
    const a = boardFingerprint(createGame({ seed: 42, playerCount: 4, humanIndex: -1, mode }).board);
    const b = boardFingerprint(createGame({ seed: 42, playerCount: 4, humanIndex: -1, mode }).board);
    assert.deepEqual(a, b, `${mode}: 盤面生成が決定的でない`);
  }
});
