// GameState 定義・初期化(設計書 §4)
// 単一のシリアライズ可能なオブジェクト。Map は使わず plain object をIDで引く。

import { makeRng, shuffled } from './rng.js';
import { generateBoard } from './rules/board.js';
import { buildProgressDecks } from './rules/cak/progress-cards.js';
import { dragonNestHex } from './rules/dragon.js';

export const RESOURCES = ['wood', 'brick', 'sheep', 'wheat', 'ore'];

export const RES_JP = { wood: '木材', brick: 'レンガ', sheep: '羊毛', wheat: '小麦', ore: '鉱石' };
export const RES_JP_SHORT = { wood: '木', brick: '土', sheep: '羊', wheat: '麦', ore: '鉄' };

export const DEV_JP = {
  knight: '騎士',
  roadBuilding: '街道建設',
  yearOfPlenty: '収穫',
  monopoly: '独占',
  vp: '勝利点',
};

const DEV_POOL = [
  ...Array(14).fill('knight'),
  ...Array(5).fill('vp'),
  ...Array(2).fill('roadBuilding'),
  ...Array(2).fill('yearOfPlenty'),
  ...Array(2).fill('monopoly'),
];

export function zeroResources() {
  return { wood: 0, brick: 0, sheep: 0, wheat: 0, ore: 0 };
}

// humanIndex: 人間プレイヤーの位置(-1 なら全員CPU、セルフプレイ用)
// mode: 'base'(基本カタン) | 'cak'(都市と騎士)
export function createGame({
  seed = 1, playerCount = 4, humanIndex = 0, names = null, mode = 'base',
  difficulty = 'hard', // CPU難易度: 'easy' | 'normal' | 'hard'(評価ノイズ量)
} = {}) {
  let rng = makeRng(seed);
  let board;
  [rng, board] = generateBoard(rng);
  // ドラゴンの島: ドラゴン(=盗賊コマ)は巣(最良の山)から始まる
  if (mode === 'dragon') board.robber = dragonNestHex(board);

  const players = [];
  for (let i = 0; i < playerCount; i++) {
    players.push({
      id: i,
      name: names?.[i] ?? (i === humanIndex ? 'あなた' : `CPU ${i}`),
      isCPU: i !== humanIndex,
      resources: zeroResources(),
      devCards: [], // { type, boughtTurn }
      knightsPlayed: 0,
      // --- 都市と騎士(設計書 §9)---
      commodities: { cloth: 0, coin: 0, paper: 0 },
      improvements: { trade: 0, politics: 0, science: 0 },
      progressCards: [], // { id, deck, boughtTurn }
      progressVP: 0,
      defenderPoints: 0,
      // --- ドラゴンの島 ---
      treasures: 0, // 財宝(1個=+1点)
    });
  }

  let devDeck;
  [rng, devDeck] = shuffled(rng, DEV_POOL);

  let progressDecks = null;
  if (mode === 'cak') {
    const decks = buildProgressDecks();
    progressDecks = {};
    for (const t of ['trade', 'politics', 'science']) {
      [rng, progressDecks[t]] = shuffled(rng, decks[t]);
    }
  }

  // 初期配置: 1巡目 0..n-1、2巡目 n-1..0(スネーク)
  const queue = [];
  for (let i = 0; i < playerCount; i++) queue.push({ player: i, round: 1 });
  for (let i = playerCount - 1; i >= 0; i--) queue.push({ player: i, round: 2 });

  return {
    seed,
    mode,
    difficulty,
    rng,
    phase: 'setup', // 'setup' | 'main' | 'ended'
    turn: 0,
    currentPlayer: 0,
    awaiting: { type: 'setupPlacement', players: [0], context: { round: 1 } },
    setup: { queue, index: 0 },
    board,
    buildings: {}, // vertexId -> { player, type: 'settlement' | 'city' }
    roads: {}, // edgeId -> { player }
    players,
    bank: {
      resources: { wood: 19, brick: 19, sheep: 19, wheat: 19, ore: 19 },
      devDeck,
      commodities: { cloth: 12, coin: 12, paper: 12 },
      progressDecks,
    },
    dice: null,
    eventDie: null, // 'ship' | 'trade' | 'politics' | 'science'(cak のみ)
    turnFlags: { rolled: false, playedDev: false },
    longestRoad: { player: null, length: 0 },
    largestArmy: { player: null, count: 0 }, // 都市と騎士では廃止(設計書 §9.1)
    // --- 都市と騎士 ---
    knights: {}, // vertexId -> { player, level, active, activatedTurn }
    merchant: null, // { hexId, player } 商人(進歩カード)。保持者は+1点
    // --- ドラゴンの島 ---
    dragon: mode === 'dragon' ? { nestHex: dragonNestHex(board) } : null,
    towers: {}, // vertexId -> pid(見張り塔)
    burned: {}, // hexId -> この手番まで炎上(産出停止)
    walls: {}, // vertexId(都市) -> player
    barbarians: { position: 0 },
    metropolis: { trade: null, politics: null, science: null }, // vertexId
    winner: null,
    log: [],
  };
}

export function addLog(state, msg) {
  state.log.push(msg);
  if (state.log.length > 200) state.log.splice(0, state.log.length - 200);
}
