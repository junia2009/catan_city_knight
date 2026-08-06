// あそびかたデモの再生エンジン(ブラウザ専用)。
//
// 台本(script.js)のビートを順に実行し、
//   ・字幕を出す
//   ・押すべきボタン/盤面の位置に指を動かして「タップ」の演出をする
//   ・実際に ui を動かし、実際に dispatch する
// ことで、本物の画面がそのまま動いているところを見せる。
//
// host 経由でしか main.js に触らない(逆向きの依存を作らない)。
//   getState / getUi / patchState(fn) / setUi(patch) / act(action)
//   boardPos(kind, id) / resetView() / exit(where)

const TICK = 30; // 再生タイマーの刻み(ms)
const SPEEDS = [1, 1.5, 2];

export class DemoDriver {
  constructor(host) {
    this.host = host;
    this.root = document.getElementById('demo');
    this.hand = this.root.querySelector('.demo-hand');
    this.capEl = this.root.querySelector('.demo-cap');
    this.speed = 1;
    this.paused = false;
    this.stopped = false;
    this.timer = null;
    this.beatIndex = 0;
    this.chapter = null;
    this.ticker = null;
    this.runToken = 0; // 二重再生の検出用(連打で run が重なると台本が混ざる)
    this.root.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-demo]');
      if (btn) this.#control(btn.dataset.demo);
    });
    window.addEventListener('resize', () => this.#placeCaption());
  }

  // ---- 再生 ----

  async run(chapter) {
    const token = ++this.runToken; // 前の再生ループはここで無効になる
    this.chapter = chapter;
    this.stopped = false;
    this.paused = false;
    this.beatIndex = 0;
    this.root.hidden = false;
    this.root.querySelector('.demo-chapter').textContent = `▶ ${chapter.title}`;
    this.#endPanel(false);
    this.#syncButtons();
    clearInterval(this.ticker);
    this.ticker = setInterval(() => this.#tick(), TICK);
    this.host.resetView?.();

    for (let i = 0; i < chapter.beats.length; i++) {
      if (!this.#alive(token)) return;
      this.beatIndex = i;
      await this.#playBeat(chapter.beats[i], token);
    }
    if (!this.#alive(token)) return;
    this.#caption('');
    this.#endPanel(true);
  }

  // 次のビートへ(操作パネルの ⏭ と E2E から)
  skip() {
    this.paused = false;
    this.#resolveWait();
    this.#syncButtons();
  }

  stop() {
    this.stopped = true;
    this.paused = false;
    clearInterval(this.ticker);
    this.ticker = null;
    this.#resolveWait();
    this.hand.classList.remove('on', 'tap');
    this.root.hidden = true;
    this.#endPanel(false);
  }

  // まだこの再生ループが有効か(停止されていない・新しい再生に置き換わっていない)
  #alive(token) {
    return !this.stopped && token === this.runToken;
  }

  async #playBeat(beat, token) {
    const { host } = this;
    if (beat.prep) host.patchState(beat.prep);
    if (!this.#alive(token)) return;

    const say = typeof beat.say === 'function' ? beat.say(host.getState(), host.getUi()) : beat.say;
    this.#caption(say ?? '');
    this.#progress();

    if (beat.tap) {
      await this.#pointAt(beat.tap(host.getState(), host.getUi()), token);
      if (!this.#alive(token)) return;
    }
    if (beat.ui) host.setUi(beat.ui(host.getState(), host.getUi()));
    if (beat.action) {
      const action = beat.action(host.getState(), host.getUi());
      // 台本が盤面と噛み合わなかったときは、黙って次のビートへ進む
      // (デモが途中で固まるより、少し飛ばしてでも最後まで流す)
      if (action) host.act(action);
    }
    await this.#wait(this.#readTime(say) + (beat.hold ?? 0));
  }

  // 字幕を読む時間。短い字幕でも最低 1.2 秒は残す。
  #readTime(text) {
    if (!text) return 450;
    return Math.min(5400, Math.max(1200, text.length * 78));
  }

  // ---- 指のタップ演出 ----

  async #pointAt(target, token) {
    const spot = this.#resolve(target);
    if (!spot) return;
    const { x, y, el } = spot;
    this.hand.style.transform = `translate(${Math.round(x)}px, ${Math.round(y)}px)`;
    this.hand.classList.add('on');
    el?.classList.add('demo-target');
    await this.#wait(430);
    if (!this.#alive(token)) return;
    this.hand.classList.add('tap');
    await this.#wait(240);
    this.hand.classList.remove('tap');
    setTimeout(() => el?.classList.remove('demo-target'), 350);
  }

  // タップ先 → 画面座標。見つからなければ null(演出だけ省く)
  #resolve(target) {
    if (!target) return null;
    const sel = target.btn ? `[data-act="${target.btn}"]` : target.sel;
    if (sel) {
      const el = document.querySelector(sel);
      if (!el) return null;
      const r = el.getBoundingClientRect();
      if (r.width === 0) return null;
      return { x: r.left + r.width / 2, y: r.top + r.height / 2, el };
    }
    for (const kind of ['vertex', 'edge', 'hex']) {
      if (target[kind] == null) continue;
      const pos = this.host.boardPos(kind, target[kind]);
      return pos ? { x: pos[0], y: pos[1], el: null } : null;
    }
    return null;
  }

  // ---- 字幕 ----

  #caption(text) {
    const span = this.capEl.querySelector('span');
    if (!text) {
      this.capEl.classList.remove('on');
      return;
    }
    span.textContent = text;
    this.capEl.classList.add('on');
    this.#placeCaption();
  }

  // HUD(下部パネル)やダイアログ(モバイルはボトムシート)に重ならない位置へ字幕を置く。
  // ダイアログはビートの途中で開くので、再生タイマーから毎回測り直す。
  #placeCaption() {
    let top = window.innerHeight;
    for (const el of [
      document.getElementById('bottom'),
      document.querySelector('#dialog-root .dialog'),
    ]) {
      const r = el?.getBoundingClientRect();
      if (r && r.height > 0) top = Math.min(top, r.top);
    }
    const bottom = `${Math.max(12, Math.round(window.innerHeight - top + 10))}px`;
    if (this.capEl.style.bottom !== bottom) this.capEl.style.bottom = bottom;
  }

  #progress() {
    const n = this.chapter?.beats.length ?? 1;
    this.root.querySelector('.demo-prog i').style.width =
      `${Math.round(((this.beatIndex + 1) / n) * 100)}%`;
  }

  // ---- 待ち(一時停止・速度・スキップに対応)----

  #wait(ms) {
    return new Promise((resolve) => {
      this.timer = { remain: ms, resolve };
    });
  }

  #resolveWait() {
    const t = this.timer;
    this.timer = null;
    t?.resolve();
  }

  #tick() {
    if (this.capEl.classList.contains('on')) this.#placeCaption();
    if (!this.timer || this.paused || this.stopped) return;
    this.timer.remain -= TICK * this.speed;
    if (this.timer.remain <= 0) this.#resolveWait();
  }

  // ---- 操作パネル ----

  #control(cmd) {
    if (cmd === 'playpause') {
      this.paused = !this.paused;
      this.#syncButtons();
    } else if (cmd === 'skip') {
      this.skip();
    } else if (cmd === 'speed') {
      this.speed = SPEEDS[(SPEEDS.indexOf(this.speed) + 1) % SPEEDS.length];
      this.#syncButtons();
    } else if (cmd === 'replay') {
      this.#endPanel(false);
      this.run(this.chapter);
    } else if (cmd === 'next-chapter') {
      this.host.exit('next');
    } else if (cmd === 'play') {
      this.host.exit('play');
    } else if (cmd === 'exit') {
      this.host.exit('back');
    }
  }

  #syncButtons() {
    // ⏸(U+23F8)は端末によって豆腐や■になるので、確実に出る記号を使う
    this.root.querySelector('[data-demo="playpause"]').textContent = this.paused ? '▶' : '❚❚';
    this.root.querySelector('[data-demo="speed"]').textContent = `×${this.speed}`;
  }

  #endPanel(show) {
    const panel = this.root.querySelector('.demo-end');
    panel.classList.toggle('on', show);
    if (!show) return;
    const nextTitle = this.host.nextChapterTitle?.();
    panel.innerHTML = `
      <div class="demo-end-card">
        <h3>▶ 「${this.chapter.title}」おしまい</h3>
        <div class="row">
          <button data-demo="replay">🔁 もう一度見る</button>
          ${nextTitle ? `<button data-demo="next-chapter">▶ 次は「${nextTitle}」</button>` : ''}
          <button class="primary" data-demo="play">🎮 自分でプレイ</button>
          <button data-demo="exit">✕ 閉じる</button>
        </div>
      </div>`;
  }
}
