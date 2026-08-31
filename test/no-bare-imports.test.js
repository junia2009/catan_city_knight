// テストから辿れるコードは、node_modules 無しで動かなければならない。
//
// CI は `npm install` をせずに `npm test` を回す(ビルド工程が無いので
// 実行時の依存が無いのが前提)。手元には three や wrangler が入っているため、
// うっかり `import * as THREE from 'three'` したモジュールをテストから
// 読んでしまっても手元では通り、CI でだけ落ちる ── 実際に一度やった。
//
// ここで import を静的に辿って、外部パッケージに触れていないことを押さえる。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');

// 静的 import・re-export・文字列リテラルの動的 import を拾う。
// 変数を渡す動的 import は拾えないが、このリポジトリでは使っていない。
const SPEC = /(?:^|[\s;])(?:import|export)\s[^'"]*?from\s*['"]([^'"]+)['"]|import\s*\(\s*['"]([^'"]+)['"]\s*\)|(?:^|[\s;])import\s*['"]([^'"]+)['"]/g;

function importsOf(file) {
  const src = readFileSync(file, 'utf8');
  const out = [];
  for (const m of src.matchAll(SPEC)) out.push(m[1] ?? m[2] ?? m[3]);
  return out;
}

test('テストから辿れるモジュールは外部パッケージを import しない', () => {
  const entries = readdirSync(HERE)
    .filter((f) => f.endsWith('.test.js'))
    .map((f) => resolve(HERE, f));

  const seen = new Set(entries);
  const queue = [...entries];
  const bad = [];

  while (queue.length) {
    const file = queue.pop();
    for (const spec of importsOf(file)) {
      if (spec.startsWith('node:')) continue;
      if (!spec.startsWith('.') && !spec.startsWith('/')) {
        bad.push(`${relative(ROOT, file)} → '${spec}'`);
        continue;
      }
      const next = resolve(dirname(file), spec);
      if (seen.has(next)) continue;
      seen.add(next);
      queue.push(next);
    }
  }

  assert.deepEqual(bad, [], `node_modules が無いと落ちる import:\n  ${bad.join('\n  ')}`);
  // 辿れていること自体も確かめる(正規表現が壊れて空回りしていないか)
  assert.ok(seen.size > 40, `辿ったファイルが少なすぎる(${seen.size}件)`);
});
