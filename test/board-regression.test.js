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

const MODES = ['base', 'cak', 'dragon', 'fish', 'sea'];
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
    pirate: board.pirate ?? null,
    islandOf: board.islandOf ? Object.keys(board.islandOf).sort().map((h) => [h, board.islandOf[h]]) : null,
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
    ships: Object.keys(state.ships ?? {}).sort().map((e) => [e, state.ships[e].player]),
    islands: state.players.map((p) => p.islands ?? []),
    bank: RESOURCES.map((r) => state.bank.resources[r]),
    diceCounts: state.diceCounts,
    logLength: state.log.length,
  };
}

// モード/シード -> ハッシュ。盤面を意図的に変えたときだけ更新すること。
// 指紋に船・島・海賊を足したので、航海者たちの追加時に全モードの値を取り直している
// (中身が変わったのは指紋の定義であって、既存モードの挙動ではない)。
const GOLDEN = {
  'base/1': '1ecb22b9fe8523a9',
  'base/2': 'e0ef987ac4198c85',
  'base/3': '5018653d959345dd',
  // cak の3シードは、進歩カードまわりを公式に戻した時点で更新している。
  // どれも「盤面」ではなく「展開」が変わったもの:
  //  - 防衛同点の報酬を本人が選ぶ形にした → PICK_DEFENDER_DECK の手が増える
  //    (cak/1 は5回、cak/2 は9回、cak/3 は0回)
  //  - 手札上限を公式に戻した → 旧実装が「上限で引けず山の底へ」としていた場面で
  //    実際に引くようになった(cak/1 は2回、cak/2 は4回、cak/3 は0回)
  'cak/1': '93cd85ebb37e2e4b',
  'cak/2': '4cbd9d0dbfe63ac5',
  // 鍛冶屋を公式どおり「別々の騎士2体」にした時点で更新(旧実装は同じ騎士を
  // 2回昇格させて Lv1→Lv3 にできていた)。盤面そのものは変わっていない。
  'cak/3': '54eecf6fb44b0f4e',
  'dragon/1': '1de7146080487f00',
  'dragon/2': 'ae6f3f71436fe018',
  'dragon/3': '56089e27b2590d69',
  'fish/1': '97cbdaac4ec2d13e',
  'fish/2': '59719d724828a144',
  'fish/3': '10a1aa4777947e08',
  'sea/1': '65b9d8889b6cc237',
  'sea/2': '697fddeaf0fe764c',
  'sea/3': 'ad1e83cbc71ef907',
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
