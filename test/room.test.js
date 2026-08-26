// オンライン対戦の部屋ロジック(server/room-core.js)のテスト

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RoomCore, makeRoomCode, normalizeRoomCode, MAX_SEATS } from '../server/room-core.js';
import { chooseAction } from '../src/ai/cpu-player.js';
import { RESOURCES } from '../src/state.js';

function newRoom(seed = 42) {
  return new RoomCore({ code: 'TEST', seed });
}

test('room: 合言葉は紛らわしい文字を含まない4文字', () => {
  for (let i = 0; i < 200; i++) {
    const code = makeRoomCode();
    assert.match(code, /^[A-Z]{4}$/);
    assert.ok(!/[IO]/.test(code), `紛らわしい文字: ${code}`);
  }
  assert.equal(normalizeRoomCode(' ab-cd '), 'ABCD');
  assert.equal(normalizeRoomCode('abcdefg'), 'ABCD');
});

test('room: 席は先着順に割り当てられ、満席なら断られる', () => {
  const room = newRoom();
  for (let i = 0; i < MAX_SEATS; i++) {
    const r = room.join({ clientId: `c${i}`, name: `P${i}` });
    assert.equal(r.seat, i);
  }
  const over = room.join({ clientId: 'c9', name: 'あふれ' });
  assert.equal(over.seat, undefined);
  assert.match(over.error, /満席/);
  // 最初の参加者がホスト
  assert.ok(room.isHost('c0'));
  assert.ok(!room.isHost('c1'));
});

test('room: 同じclientIdなら元の席に戻る(再接続)', () => {
  const room = newRoom();
  room.join({ clientId: 'a', name: 'A' });
  room.join({ clientId: 'b', name: 'B' });
  room.start('a');
  assert.equal(room.phase, 'playing');

  room.disconnect('b');
  assert.equal(room.seats[1].online, false); // 対戦中は席が残る
  const back = room.join({ clientId: 'b', name: 'B' });
  assert.equal(back.seat, 1);
  assert.equal(back.rejoined, true);
  assert.equal(room.seats[1].online, true);
});

test('room: ロビーでの切断は席を空け、ホストは次の人に移る', () => {
  const room = newRoom();
  room.join({ clientId: 'a', name: 'A' });
  room.join({ clientId: 'b', name: 'B' });
  room.disconnect('a');
  assert.equal(room.seats[0], null);
  assert.ok(room.isHost('b'), 'ホストが移譲されていない');
  // 空いた席に新しい人が入れる
  assert.equal(room.join({ clientId: 'c', name: 'C' }).seat, 0);
});

test('room: 設定と開始はホストのみ', () => {
  const room = newRoom();
  room.join({ clientId: 'a', name: 'A' });
  room.join({ clientId: 'b', name: 'B' });

  assert.match(room.setSettings('b', { mode: 'dragon' }).error, /ホスト/);
  assert.equal(room.setSettings('a', { mode: 'dragon' }).ok, true);
  assert.equal(room.settings.mode, 'dragon');
  // 知らない値は黙って無視する(壊れたクライアントに引きずられない)
  room.setSettings('a', { mode: 'まちがい', difficulty: 'ばか' });
  assert.equal(room.settings.mode, 'dragon');
  assert.equal(room.settings.difficulty, 'normal');

  assert.match(room.start('b').error, /ホスト/);
  assert.equal(room.start('a').ok, true);
  assert.equal(room.state.mode, 'dragon');
  assert.match(room.start('a').error, /すでに/);
});

test('room: 人間の席だけ isCPU=false になり、残りはCPUで埋まる', () => {
  const room = newRoom();
  room.join({ clientId: 'a', name: 'あかり' });
  room.join({ clientId: 'b', name: 'ぼくと' });
  room.start('a');
  assert.equal(room.state.players.length, MAX_SEATS);
  assert.deepEqual(room.state.players.map((p) => p.isCPU), [false, false, true, true]);
  assert.equal(room.state.players[0].name, 'あかり');
  assert.equal(room.state.players[1].name, 'ぼくと');
});

test('room: CPUで埋めない場合は参加者の人数で始まる', () => {
  const room = newRoom();
  room.join({ clientId: 'a', name: 'A' });
  room.join({ clientId: 'b', name: 'B' });
  room.join({ clientId: 'c', name: 'C' });
  room.setSettings('a', { cpuFill: false });
  assert.equal(room.start('a').ok, true);
  assert.equal(room.state.players.length, 3);
  assert.ok(room.state.players.every((p) => !p.isCPU));

  // 1人ではCPUなしで始められない
  const solo = newRoom();
  solo.join({ clientId: 'x', name: 'X' });
  solo.setSettings('x', { cpuFill: false });
  assert.match(solo.start('x').error, /以上/);
});

test('room: 他人の席の手は出せない・不正な手は拒否される', () => {
  const room = newRoom();
  room.join({ clientId: 'a', name: 'A' });
  room.join({ clientId: 'b', name: 'B' });
  room.start('a');

  // 初期配置は席0から。席1の人が席0の手を出そうとしても通らない。
  const legal = chooseAction(room.state, 0);
  assert.match(room.submitAction('b', legal).error, /他のプレイヤー/);

  // 自分の席でも手番でなければルールエンジンが弾く
  const notMyTurn = room.submitAction('b', { type: 'END_TURN', player: 1 });
  assert.ok(notMyTurn.error, '手番外の手が通ってしまった');

  // 正しい席の正しい手は通り、版が進む
  const before = room.version;
  assert.equal(room.submitAction('a', legal).ok, true);
  assert.equal(room.version, before + 1);

  // 参加していない人は操作できない
  assert.match(room.submitAction('zzz', legal).error, /観戦者/);
});

test('room: viewFor は相手の手札と山札・乱数種を伏せる', () => {
  const room = newRoom();
  room.join({ clientId: 'a', name: 'A' });
  room.join({ clientId: 'b', name: 'B' });
  room.setSettings('a', { mode: 'base' });
  room.start('a');

  // 手札を作る: 席0に発展カード2枚、席1に1枚
  room.state.players[0].devCards = [
    { type: 'knight', boughtTurn: 1 },
    { type: 'vp', boughtTurn: 1 },
  ];
  room.state.players[1].devCards = [{ type: 'monopoly', boughtTurn: 1 }];

  const view0 = room.viewFor(0);
  // 自分の手札は見える
  assert.deepEqual(view0.players[0].devCards.map((c) => c.type), ['knight', 'vp']);
  // 相手の手札は枚数だけ(中身は hidden)
  assert.equal(view0.players[1].devCards.length, 1);
  assert.equal(view0.players[1].devCards[0].type, 'hidden');
  // 山札の中身と乱数種は伏せる(枚数は残す = UIの購入可否判定に使う)
  assert.equal(view0.rng, 0);
  assert.equal(view0.bank.devDeck.length, room.state.bank.devDeck.length);
  assert.ok(view0.bank.devDeck.every((c) => c === null));
  // 元の状態は壊さない
  assert.equal(room.state.players[1].devCards[0].type, 'monopoly');
  assert.notEqual(room.state.rng, 0);

  // 席1から見ると逆になる
  const view1 = room.viewFor(1);
  assert.equal(view1.players[0].devCards[0].type, 'hidden');
  assert.equal(view1.players[1].devCards[0].type, 'monopoly');
});

test('room: 都市と騎士の進歩カードも伏せられる', () => {
  const room = newRoom();
  room.join({ clientId: 'a', name: 'A' });
  room.join({ clientId: 'b', name: 'B' });
  room.setSettings('a', { mode: 'cak' });
  room.start('a');
  room.state.players[1].progressCards = [
    { id: 'merchant', deck: 'trade', boughtTurn: 1 },
    { id: 'spy', deck: 'politics', boughtTurn: 1 },
  ];
  const view0 = room.viewFor(0);
  assert.equal(view0.players[1].progressCards.length, 2);
  assert.ok(view0.players[1].progressCards.every((c) => c.id === 'hidden'));
  for (const track of ['trade', 'politics', 'science']) {
    assert.ok(view0.bank.progressDecks[track].every((c) => c === null));
  }
});

test('room: 決着後は全公開(隠し勝利点を含む最終得点のため)', () => {
  const room = newRoom();
  room.join({ clientId: 'a', name: 'A' });
  room.join({ clientId: 'b', name: 'B' });
  room.setSettings('a', { mode: 'base' });
  room.start('a');
  room.state.players[1].devCards = [{ type: 'vp', boughtTurn: 1 }];
  room.state.phase = 'ended';
  const view0 = room.viewFor(0);
  assert.equal(view0.players[1].devCards[0].type, 'vp');
});

test('room: 切断中の席はサーバーが肩代わりして進める', () => {
  const room = newRoom();
  room.join({ clientId: 'a', name: 'A' });
  room.join({ clientId: 'b', name: 'B' });
  room.start('a');
  // 初期配置は席0(接続中)の番 → 肩代わり対象なし
  assert.equal(room.autoPlayer(), null);

  room.disconnect('a');
  // 切断したので席0はサーバーが打つ
  assert.equal(room.autoPlayer(), 0);
  const before = room.version;
  const stepped = room.stepAuto();
  assert.ok(stepped?.ok, '肩代わりの手が適用されなかった');
  assert.equal(room.version, before + 1);

  // 再接続すると肩代わりは止まる
  room.join({ clientId: 'a', name: 'A' });
  const auto = room.autoPlayer();
  assert.ok(auto == null || room.seats[auto] === null, '接続中の席を肩代わりしている');
});

test('room: 1人+CPU3体で最後まで完走し、保存則が成り立つ', () => {
  const room = newRoom(2024);
  room.join({ clientId: 'me', name: '私' });
  room.setSettings('me', { mode: 'cak' });
  assert.equal(room.start('me').ok, true);

  let guard = 0;
  while (room.state.phase !== 'ended') {
    if (++guard > 20000) throw new Error('無限ループ');
    const auto = room.autoPlayer();
    if (auto != null) {
      assert.ok(room.stepAuto(), 'CPUの手が進まなかった');
      continue;
    }
    // 人間の席は必ず 0(自分の手だけ出せることも同時に確認)
    const pid = room.state.awaiting ? room.state.awaiting.players[0] : room.state.currentPlayer;
    assert.equal(pid, 0);
    const res = room.submitAction('me', chooseAction(room.state, 0));
    assert.ok(res.ok, `人間の手が拒否された: ${res.error}`);
  }
  assert.ok(room.state.winner != null);
  for (const r of RESOURCES) {
    const total = room.state.bank.resources[r]
      + room.state.players.reduce((a, p) => a + p.resources[r], 0);
    assert.equal(total, 19, `${r}の保存則`);
  }
});

test('room: 保存と復元で対戦を継続できる', () => {
  const room = newRoom(7);
  room.join({ clientId: 'a', name: 'A' });
  room.join({ clientId: 'b', name: 'B' });
  room.start('a');
  room.submitAction('a', chooseAction(room.state, 0));

  const revived = RoomCore.fromJSON(JSON.parse(JSON.stringify(room.toJSON())));
  assert.equal(revived.phase, 'playing');
  assert.equal(revived.version, room.version);
  assert.deepEqual(revived.state.buildings, room.state.buildings);
  // 復元直後は全員切断扱い → 再接続で元の席に戻れる
  assert.equal(revived.seats[0].online, false);
  assert.equal(revived.join({ clientId: 'a', name: 'A' }).seat, 0);
});

// --- 放置された部屋の自動切断 ---

test('room: 人の操作だけが「活動」として数えられる', () => {
  const room = newRoom();
  room.join({ clientId: 'a', name: 'A' });
  room.join({ clientId: 'b', name: 'B' });
  room.start('a');

  // 2時間前に最後の操作があったことにする
  const TWO_HOURS = 2 * 60 * 60 * 1000;
  room.lastActivityAt = Date.now() - TWO_HOURS;
  assert.ok(room.isIdle(), '2時間無操作なのに放置と判定されない');

  // CPU の自動進行は「操作」ではない(放置判定を延命させない)
  room.stepAuto();
  assert.ok(room.isIdle(), 'CPUの自動進行で放置判定がリセットされた');

  // 人が手を出したらリセットされる
  const pid = room.state.awaiting ? room.state.awaiting.players[0] : room.state.currentPlayer;
  const who = ['a', 'b'][pid];
  if (who) {
    room.submitAction(who, chooseAction(room.state, pid));
    assert.ok(!room.isIdle(), '人の操作で放置判定が解除されない');
  }
});

test('room: 参加・設定変更・開始も活動として数える', () => {
  const room = newRoom();
  const HOUR = 60 * 60 * 1000;

  room.lastActivityAt = Date.now() - HOUR * 2;
  room.join({ clientId: 'a', name: 'A' });
  assert.ok(!room.isIdle(), '参加が活動として数えられていない');

  room.lastActivityAt = Date.now() - HOUR * 2;
  room.setSettings('a', { mode: 'base' });
  assert.ok(!room.isIdle(), '設定変更が活動として数えられていない');

  room.lastActivityAt = Date.now() - HOUR * 2;
  room.start('a');
  assert.ok(!room.isIdle(), '開始が活動として数えられていない');
});

test('room: 放置の判定時刻は保存・復元される', () => {
  const room = newRoom();
  room.join({ clientId: 'a', name: 'A' });
  room.lastActivityAt = Date.now() - 90 * 60 * 1000;
  const revived = RoomCore.fromJSON(JSON.parse(JSON.stringify(room.toJSON())));
  assert.equal(revived.lastActivityAt, room.lastActivityAt);
  assert.ok(revived.isIdle(), '復元後に放置判定が失われている');
});

test('room: 出目の設定はホストが選べ、バランスダイスの山札は伏せられる', () => {
  const room = newRoom();
  room.join({ clientId: 'c0', name: 'A' });
  room.join({ clientId: 'c1', name: 'B' });
  assert.equal(room.settings.diceMode, 'random'); // 既定は純ランダム
  assert.equal(room.settings.mode, 'base'); // 既定は基本ルール
  assert.ok(room.setSettings('c1', { diceMode: 'balanced' }).error, 'ホスト以外が変えられている');
  assert.ok(!room.setSettings('c0', { diceMode: 'balanced' }).error);
  assert.equal(room.settings.diceMode, 'balanced');
  assert.ok(!room.setSettings('c0', { diceMode: 'ぐちゃぐちゃ' }).error);
  assert.equal(room.settings.diceMode, 'balanced', '不正な値が通っている');

  room.setSettings('c0', { diceMode: 'balanced', cpuFill: false });
  room.start('c0');
  assert.equal(room.state.diceMode, 'balanced');
  // 何回か振って山札を減らしてから、席から見えるのは「残り枚数」だけであることを確かめる
  room.state.diceDeck = [[1, 1], [2, 3], [4, 5]];
  const view = room.viewFor(0);
  assert.equal(view.diceDeck.length, 3, '残り枚数が伝わっていない');
  assert.deepEqual(view.diceDeck, [null, null, null], '未来の出目が漏れている');
  assert.equal(view.rng, 0);
});
