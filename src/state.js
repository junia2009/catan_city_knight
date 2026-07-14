// GameState 定義・初期化(設計書 §4)
// 単一のシリアライズ可能なオブジェクト。Map は使わず plain object をIDで引く。

import { makeRng, shuffled } from './rng.js';
import { generateBoard } from './rules/board.js';

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
export function createGame({ seed = 1, playerCount = 4, humanIndex = 0, names = null } = {}) {
  let rng = makeRng(seed);
  let board;
  [rng, board] = generateBoard(rng);

  const players = [];
  for (let i = 0; i < playerCount; i++) {
    players.push({
      id: i,
      name: names?.[i] ?? (i === humanIndex ? 'あなた' : `CPU ${i}`),
      isCPU: i !== humanIndex,
      resources: zeroResources(),
      devCards: [], // { type, boughtTurn }
      knightsPlayed: 0,
    });
  }

  let devDeck;
  [rng, devDeck] = shuffled(rng, DEV_POOL);

  // 初期配置: 1巡目 0..n-1、2巡目 n-1..0(スネーク)
  const queue = [];
  for (let i = 0; i < playerCount; i++) queue.push({ player: i, round: 1 });
  for (let i = playerCount - 1; i >= 0; i--) queue.push({ player: i, round: 2 });

  return {
    seed,
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
    },
    dice: null,
    turnFlags: { rolled: false, playedDev: false },
    longestRoad: { player: null, length: 0 },
    largestArmy: { player: null, count: 0 },
    winner: null,
    log: [],
  };
}

export function addLog(state, msg) {
  state.log.push(msg);
  if (state.log.length > 200) state.log.splice(0, state.log.length - 200);
}
