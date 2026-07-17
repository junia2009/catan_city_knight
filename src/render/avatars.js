// プレイヤーアバター(SVG 直描き。画像アセットなし)
// プレイヤー色の丸枠の中に4人のキャラクターを描く:
//   0=開拓者(赤バンダナ) 1=船長(青の帽子と白ひげ)
//   2=商人(橙のフード) 3=錬金術師(紫のとんがり帽子と丸眼鏡)

import { PLAYER_COLORS } from './board-render.js';

const OUTLINE = '#3a2a20';

// 0: 開拓者 — 赤いバンダナの若者
function pioneer() {
  return `
    <path d="M4.5 27 A16.2 16.2 0 0 0 31.5 27 Q26.5 24.2 18 24.2 Q9.5 24.2 4.5 27 Z" fill="#c93d3d"/>
    <circle cx="18" cy="18" r="8.6" fill="#ffd9b0"/>
    <path d="M9.4 17 a8.6 8.6 0 0 1 17.2 0 q-4.3 -3.2 -8.6 -3.2 t-8.6 3.2 Z" fill="#e04848"/>
    <path d="M26 12.6 l4.6 -1.4 -2.2 3.8 Z" fill="#c93d3d"/>
    <circle cx="15.2" cy="19" r="1.2" fill="${OUTLINE}"/>
    <circle cx="20.8" cy="19" r="1.2" fill="${OUTLINE}"/>
    <path d="M15.8 22.2 q2.2 1.9 4.4 0" stroke="${OUTLINE}" stroke-width="1.1"
      stroke-linecap="round" fill="none"/>`;
}

// 1: 船長 — 金帯の帽子と白いひげ
function captain() {
  return `
    <path d="M4.5 27 A16.2 16.2 0 0 0 31.5 27 Q26.5 24.2 18 24.2 Q9.5 24.2 4.5 27 Z" fill="#2c5aa0"/>
    <circle cx="18" cy="18" r="8.2" fill="#f2c99a"/>
    <path d="M11 19.5 q0 8 7 8 t7 -8 q-3.4 2.6 -7 2.6 t-7 -2.6 Z" fill="#e9e9ec"/>
    <path d="M14 21 q4 2.6 8 0 l0 1.6 q-4 2 -8 0 Z" fill="#f4f4f6"/>
    <circle cx="15" cy="18" r="1.2" fill="${OUTLINE}"/>
    <circle cx="21" cy="18" r="1.2" fill="${OUTLINE}"/>
    <path d="M10.6 13.6 q7.4 -7.4 14.8 0 Z" fill="#24508f"/>
    <rect x="10.2" y="13" width="15.6" height="1.7" rx="0.85" fill="#e8c25a"/>
    <rect x="8.6" y="14.4" width="18.8" height="2.3" rx="1.15" fill="#1c3f77"/>`;
}

// 2: 商人 — フードとコインの耳飾り
function merchant() {
  return `
    <path d="M4.5 27 A16.2 16.2 0 0 0 31.5 27 Q26.5 24.2 18 24.2 Q9.5 24.2 4.5 27 Z" fill="#e2822a"/>
    <circle cx="18" cy="16.6" r="9.4" fill="#f0973c"/>
    <circle cx="18" cy="18" r="7.2" fill="#ffd9b0"/>
    <path d="M12.4 15.6 q5.6 -3.8 11.2 0 q-1.2 -3 -5.6 -3 t-5.6 3 Z" fill="#5a3a26"/>
    <circle cx="10.6" cy="20" r="1.3" fill="#e8c25a"/>
    <circle cx="25.4" cy="20" r="1.3" fill="#e8c25a"/>
    <circle cx="15.4" cy="18.8" r="1.1" fill="${OUTLINE}"/>
    <circle cx="20.6" cy="18.8" r="1.1" fill="${OUTLINE}"/>
    <circle cx="13.8" cy="21" r="1.2" fill="#f6a98e" opacity="0.75"/>
    <circle cx="22.2" cy="21" r="1.2" fill="#f6a98e" opacity="0.75"/>
    <path d="M16.2 21.6 q1.8 1.6 3.6 0" stroke="${OUTLINE}" stroke-width="1"
      stroke-linecap="round" fill="none"/>`;
}

// 3: 錬金術師 — とんがり帽子と丸眼鏡
function alchemist() {
  return `
    <path d="M4.5 27 A16.2 16.2 0 0 0 31.5 27 Q26.5 24.2 18 24.2 Q9.5 24.2 4.5 27 Z" fill="#7a3fc0"/>
    <circle cx="18" cy="18.6" r="7.8" fill="#f7d3ae"/>
    <path d="M12.6 13.4 L20 3 L24 13.4 Z" fill="#8447cf"/>
    <rect x="12.2" y="12.2" width="12.2" height="1.6" rx="0.8" fill="#e8c25a"/>
    <ellipse cx="18" cy="13.9" rx="9.6" ry="2.1" fill="#6d34b3"/>
    <circle cx="21" cy="7.6" r="1" fill="#ffe9a8"/>
    <circle cx="14.8" cy="19.4" r="2.4" fill="none" stroke="${OUTLINE}" stroke-width="1"/>
    <circle cx="21.2" cy="19.4" r="2.4" fill="none" stroke="${OUTLINE}" stroke-width="1"/>
    <path d="M17.2 19.4 h1.6" stroke="${OUTLINE}" stroke-width="1"/>
    <circle cx="14.8" cy="19.6" r="0.95" fill="${OUTLINE}"/>
    <circle cx="21.2" cy="19.6" r="0.95" fill="${OUTLINE}"/>
    <path d="M16.4 23.4 q1.6 1.3 3.2 0" stroke="${OUTLINE}" stroke-width="1"
      stroke-linecap="round" fill="none"/>`;
}

const FACES = [pioneer, captain, merchant, alchemist];
const BG = ['#ffe3da', '#dbe9fb', '#ffeccf', '#ecdff8'];

// pid のアバター(自己完結の inline SVG。サイズは親の .chip が決める)
export function avatarSvg(pid) {
  const i = pid % FACES.length;
  return `<svg class="avatar" viewBox="0 0 36 36" aria-hidden="true">
    <circle cx="18" cy="18" r="16.2" fill="${BG[i]}"/>
    <g>${FACES[i]()}</g>
    <circle cx="18" cy="18" r="17" fill="none" stroke="${PLAYER_COLORS[i]}" stroke-width="2"/>
  </svg>`;
}
