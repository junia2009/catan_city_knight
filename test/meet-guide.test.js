// ミニゲームのあそびかた(src/render/meet-guide.js)。
//
// 文章なので「正しさ」は測れないが、**実装とずれていないこと**は測れる。
// ここで押さえるのは3つ:
//   1. 受付があるのに説明が無い(遊びを足して説明を忘れた)
//   2. 大富豪の入れるルールの説明漏れ(RULES に足して説明を忘れた)
//   3. 制限時間の数字が、サーバーの定数とずれた
// どれも「気づかないまま配信される」たぐいなので、機械に見張らせる。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  GUIDES, MIN_PLAYERS as GUIDE_MIN, guideBodyHtml, meetGuideHtml, meetsGuideHtml, minutes,
} from '../src/render/meet-guide.js';
import { rulesHtml, RULES_TABS } from '../src/render/rules-content.js';
import { MEETS } from '../src/minigame/meets.js';
import { RULES as DFG_RULES } from '../src/minigame/daifugo.js';
import { CONTEST_MS } from '../server/fishing-contest.js';
import { HUNT_MS } from '../server/dragon-hunt.js';
import { RAID_MS } from '../server/raid-contest.js';
import { AUTO_MS } from '../server/daifugo-table.js';
import { MIN_PLAYERS } from '../server/meet-core.js';

// 遊びを1つ足したら、説明も1つ足す。ここが落ちたら書き忘れ。
test('あそびかた: 受付のある遊びには全部そろっている', () => {
  for (const meet of Object.values(MEETS)) {
    const g = GUIDES[meet.id];
    assert.ok(g, `${meet.id} のあそびかたが無い`);
    assert.ok(g.goal?.length > 10, `${meet.id} の目的が書かれていない`);
    assert.ok(g.steps?.length >= 3, `${meet.id} の手順が少なすぎる`);
    // 手順は [絵文字, 見出し, 説明] の3つ組
    for (const s of g.steps) assert.equal(s.length, 3, `${meet.id} の手順の形が違う`);
  }
  // 逆に、受付の無い遊びの説明が残っていないか(消し忘れ)
  const ids = new Set(Object.values(MEETS).map((m) => m.id));
  for (const id of Object.keys(GUIDES)) assert.ok(ids.has(id), `${id} は受付が無いのに説明がある`);
});

// **秒数はサーバーの定数を書き写している。** 片方だけ直すと嘘の説明になる。
test('あそびかた: 制限時間がサーバーと一致する', () => {
  assert.equal(GUIDES.fishing.ms, CONTEST_MS);
  assert.equal(GUIDES.dragonhunt.ms, HUNT_MS);
  assert.equal(GUIDES.raid.ms, RAID_MS);
  // 大富豪は時間で終わらない。代わりに手番の持ち時間を書いている
  assert.equal(GUIDES.daifugo.ms, undefined);
  assert.equal(GUIDES.daifugo.autoMs, AUTO_MS);
  assert.equal(GUIDE_MIN, MIN_PLAYERS);
});

test('あそびかた: 分秒の言い方', () => {
  assert.equal(minutes(45000), '45秒');
  assert.equal(minutes(90000), '1分30秒');
  assert.equal(minutes(120000), '2分');
  assert.equal(minutes(180000), '3分');
});

// 書いた数字が本文に出ているか(定数だけ直して本文が古いまま、を防ぐ)
test('あそびかた: 本文に制限時間と人数が出る', () => {
  assert.match(guideBodyHtml('fishing'), /3分/);
  assert.match(guideBodyHtml('dragonhunt'), /1分30秒/);
  assert.match(guideBodyHtml('raid'), /2分/);
  assert.match(guideBodyHtml('daifugo'), /45秒/);
  assert.match(guideBodyHtml('daifugo'), /決着まで/);
  for (const id of Object.keys(GUIDES)) {
    assert.match(guideBodyHtml(id), new RegExp(`${MIN_PLAYERS}人から`), `${id} に人数が無い`);
  }
});

// 受付の看板と説明の見出しが同じものを指しているか
test('あそびかた: 見出しが受付のものと同じ', () => {
  for (const meet of Object.values(MEETS)) {
    assert.ok(guideBodyHtml(meet.id).includes(meet.title), `${meet.id} の見出しが違う`);
  }
});

// 入れるルールを足したら説明も出る。名前と説明の両方を出していること。
test('あそびかた: 大富豪の入れるルールを全部説明している', () => {
  const html = guideBodyHtml('daifugo');
  for (const r of DFG_RULES) {
    assert.ok(html.includes(r.name), `${r.name} が一覧に無い`);
    assert.ok(html.includes(r.desc), `${r.name} の説明が無い`);
  }
});

// 卓に入っているルールを渡したら、入っているものに印がつく。
// **渡さないときは既定を出す** ── 受付に着く前でも読めるように。
test('あそびかた: 入れるルールの印は卓に合わせて変わる', () => {
  const none = Object.fromEntries(DFG_RULES.map((r) => [r.id, false]));
  const off = guideBodyHtml('daifugo', { rules: none });
  assert.equal(off.includes('入っている'), false, 'なしの卓なのに「入っている」が出る');
  const all = Object.fromEntries(DFG_RULES.map((r) => [r.id, true]));
  const on = guideBodyHtml('daifugo', { rules: all });
  assert.equal(on.includes('>なし<'), false, '全部入りの卓なのに「なし」が出る');
  // 渡さないときは既定(はじめから入っている5つ)を出す
  const plain = guideBodyHtml('daifugo');
  assert.match(plain, /はじめから入っている/);
});

// 島を歩く中から開くぶん。**歩きかたは必ず付ける**(操作は画面に出ていない)
test('あそびかた: 歩いている最中のぶんは、その島の遊びと歩きかた', () => {
  const html = meetGuideHtml('raid');
  assert.ok(html.includes(MEETS.cak.title), 'この島の遊びが出ていない');
  assert.equal(html.includes(MEETS.fish.title), false, '別の島の遊びまで出ている');
  assert.match(html, /島のあるきかた/);
  assert.match(html, /左半分/);
});

// 受付の無い島(航海者たち)でも開ける。空にすると押しても何も起きない画面になる。
test('あそびかた: 受付の無い島でも歩きかたは読める', () => {
  for (const id of [undefined, null, 'sea', 'しらない遊び']) {
    const html = meetGuideHtml(id);
    assert.match(html, /島のあるきかた/, `${id} で歩きかたが消えた`);
    assert.match(html, /受付はありません/);
  }
  assert.equal(guideBodyHtml('しらない遊び'), '');
});

// 説明書のタブ。全部の島のぶんが1枚に並ぶ
test('あそびかた: 説明書の「集まり」タブに全部載る', () => {
  const html = meetsGuideHtml();
  for (const meet of Object.values(MEETS)) {
    assert.ok(html.includes(meet.title), `${meet.id} が説明書に無い`);
  }
  assert.match(html, /島のあるきかた/);
  // タブとして開けること
  assert.ok(RULES_TABS.some(([id]) => id === 'meets'), 'タブが登録されていない');
  const tab = rulesHtml('meets');
  assert.ok(tab.includes(MEETS.base.title), 'タブの中身が集まりになっていない');
  assert.match(tab, /data-act="rules-tab:meets"/);
});
