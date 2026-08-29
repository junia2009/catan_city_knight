// Service Worker のプリキャッシュ一覧が最新かを見張る。
//
// 一覧は scripts/gen-precache.mjs が sw.js に書き出す。ファイルを足したり
// 中身を変えたりしたあと生成し忘れると、オフラインで新しいコードが
// 手に入らない(あるいは配信物が一覧から漏れる)。ここで落として気づく。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { collectFiles, currentBlock, expectedBlock } from '../scripts/gen-precache.mjs';

const swPath = fileURLToPath(new URL('../sw.js', import.meta.url));

test('sw: プリキャッシュ一覧が生成し直されている', () => {
  assert.equal(
    currentBlock(),
    expectedBlock(),
    'sw.js のプリキャッシュ一覧が古いです。node scripts/gen-precache.mjs を実行してください',
  );
});

test('sw: 対戦に必要なものが一覧に入っている', () => {
  const files = collectFiles();
  // 起動一式とルールエンジン、3D の vendor まで揃っていないとオフラインで遊べない
  for (const must of [
    'index.html',
    'manifest.webmanifest',
    'src/main.js',
    'src/actions.js',
    'src/state.js',
    'src/ai/cpu-player.js',
    'src/rules/board.js',
    'src/rules/road-building.js',
    'src/rules/cak/progress-cards.js',
    'src/render3d/board3d.js',
    'vendor/three.module.min.js',
    'vendor/addons/controls/OrbitControls.js',
  ]) {
    assert.ok(files.includes(must), `${must} がプリキャッシュ一覧にない`);
  }
  // SW 自身はブラウザが別枠で管理するので入れない
  assert.ok(!files.includes('sw.js'), 'sw.js を自分でキャッシュしてはいけない');
});

test('sw: 一覧のファイルは実在し、ルート直下からの相対パスで並ぶ', () => {
  const sw = readFileSync(swPath, 'utf8');
  for (const p of collectFiles()) {
    assert.ok(sw.includes(`'./${p}'`), `${p} が sw.js に書かれていない`);
  }
  // ナビゲーション用に './' 単体も必要(index.html への入口)
  assert.ok(sw.includes("'./',"), "'./' が一覧にない");
});
