// sw.js のプリキャッシュ一覧を生成する。
//
// ビルド工程がないので、配信するファイルの一覧を手で持つ代わりにここで走査して
// sw.js のマーカー間に書き出す。中身のハッシュをキャッシュ名に混ぜているので、
// どれか1ファイルでも変われば sw.js が変わり、ブラウザが新しい SW を入れ直す
// (= プリキャッシュも取り直される)。
//
//   node scripts/gen-precache.mjs         一覧を書き出す
//   node scripts/gen-precache.mjs --check 書き出さずに、ずれていたら終了コード1
//
// 生成し忘れは test/sw-precache.test.js が落として気づける。

import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const SW_PATH = join(ROOT, 'sw.js');

// 走査するディレクトリと、拾う拡張子
const DIRS = ['src', 'vendor', 'icons'];
const EXTS = ['.html', '.js', '.css', '.png', '.svg', '.webmanifest', '.json'];
// 単体で足すファイル(ルート直下)
const ROOT_FILES = ['index.html', 'manifest.webmanifest'];
// SW 自身はブラウザが別枠で管理するのでキャッシュに入れない
const SKIP = new Set(['sw.js']);

const START = '// >>> precache:generated (scripts/gen-precache.mjs で生成。手で編集しない)';
const END = '// <<< precache:generated';

function walk(dir) {
  const out = [];
  for (const name of readdirSync(dir).sort()) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else out.push(full);
  }
  return out;
}

export function collectFiles() {
  const files = [...ROOT_FILES.map((f) => join(ROOT, f))];
  for (const d of DIRS) files.push(...walk(join(ROOT, d)));
  return files
    .map((f) => relative(ROOT, f).split(sep).join('/'))
    .filter((p) => !SKIP.has(p))
    .filter((p) => EXTS.some((e) => p.endsWith(e)))
    .sort();
}

// 一覧 + 全ファイルの中身から作る短いハッシュ。キャッシュ名に混ぜる。
export function precacheHash(files) {
  const h = createHash('sha256');
  for (const p of files) {
    h.update(p);
    h.update(readFileSync(join(ROOT, p)));
  }
  return h.digest('hex').slice(0, 12);
}

export function renderBlock(files, hash) {
  const list = files.map((p) => `  './${p}',`).join('\n');
  return [
    START,
    `const PRECACHE_VERSION = '${hash}';`,
    'const PRECACHE = [',
    "  './',",
    list,
    '];',
    END,
  ].join('\n');
}

export function currentBlock(sw = readFileSync(SW_PATH, 'utf8')) {
  const a = sw.indexOf(START);
  const b = sw.indexOf(END);
  if (a < 0 || b < 0) throw new Error('sw.js に precache のマーカーがありません');
  return sw.slice(a, b + END.length);
}

export function expectedBlock() {
  const files = collectFiles();
  return renderBlock(files, precacheHash(files));
}

function main() {
  const check = process.argv.includes('--check');
  const sw = readFileSync(SW_PATH, 'utf8');
  const want = expectedBlock();
  if (currentBlock(sw) === want) {
    console.log(`プリキャッシュ一覧は最新です(${collectFiles().length}ファイル)`);
    return;
  }
  if (check) {
    console.error('プリキャッシュ一覧が古いです。node scripts/gen-precache.mjs を実行してください');
    process.exit(1);
  }
  writeFileSync(SW_PATH, sw.replace(currentBlock(sw), want));
  console.log(`プリキャッシュ一覧を更新しました(${collectFiles().length}ファイル)`);
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) main();
