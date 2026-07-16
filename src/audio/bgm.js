// ジェネレーティブBGM(Web Audio)
// 中世ヨーロッパ風: ドリア旋法のゆったりした進行に、
// 大聖堂風の残響 + オルガンのドローン(荘厳)、
// ハープの分散和音 + 笛の旋律(穏やか)を重ねる。
// 音源ファイルは使わない(オフラインPWA・ビルドなしのため全て合成)。

const midiHz = (m) => 440 * 2 ** ((m - 69) / 12);

// D ドリアの和声。notes = パッド音、drone = 低音(オルガン)
const CHORDS = {
  Dm: { notes: [50, 57, 62, 65], drone: 38 },
  C: { notes: [48, 55, 60, 64], drone: 36 },
  G: { notes: [43, 50, 59, 62], drone: 43 },
  Am: { notes: [45, 52, 57, 60], drone: 45 },
  Bb: { notes: [46, 53, 58, 62], drone: 46 },
  F: { notes: [41, 53, 57, 60], drone: 41 },
};
const PROGRESSIONS = [
  ['Dm', 'C', 'Dm', 'Am'],
  ['Dm', 'F', 'C', 'Dm'],
  ['Dm', 'Bb', 'F', 'C'],
  ['Dm', 'Am', 'Bb', 'C'],
  ['Dm', 'C', 'G', 'Dm'],
];
// 旋律用の D ドリア音階(D4〜E5 付近)
const SCALE = [62, 64, 65, 67, 69, 71, 72, 74, 76];

const CHORD_DUR = 5.6; // 1コードの長さ(秒)

export class Bgm {
  constructor() {
    this.ctx = null;
    this.enabled = localStorage.getItem('catan-bgm') !== 'off';
    this.running = false;
    this.timer = null;
    this.nextTime = 0;
    this.queue = [];
    this.lastMelodyNote = 69;
  }

  setEnabled(on) {
    this.enabled = on;
    localStorage.setItem('catan-bgm', on ? 'on' : 'off');
    if (on) this.start();
    else this.stop();
  }

  // 初回はユーザー操作(タップ)から呼ぶこと(iOSの自動再生制限)
  start() {
    if (!this.enabled || this.running) return;
    try {
      this._init();
    } catch (e) {
      console.warn('BGM init failed:', e);
      return;
    }
    this.running = true;
    this.ctx.resume();
    const t = this.ctx.currentTime;
    this.master.gain.cancelScheduledValues(t);
    this.master.gain.setValueAtTime(0.0001, t);
    this.master.gain.exponentialRampToValueAtTime(0.22, t + 2.5);
    this.nextTime = t + 0.15;
    this.timer = setInterval(() => this._pump(), 250);
  }

  stop() {
    if (!this.running) return;
    this.running = false;
    clearInterval(this.timer);
    this.timer = null;
    const t = this.ctx.currentTime;
    this.master.gain.cancelScheduledValues(t);
    this.master.gain.setValueAtTime(this.master.gain.value, t);
    this.master.gain.exponentialRampToValueAtTime(0.0001, t + 0.8);
    setTimeout(() => {
      if (!this.running && this.ctx) this.ctx.suspend();
    }, 1000);
  }

  _init() {
    if (this.ctx) return;
    const AC = window.AudioContext ?? window.webkitAudioContext;
    this.ctx = new AC();

    this.master = this.ctx.createGain();
    this.master.gain.value = 0.0001;
    const comp = this.ctx.createDynamicsCompressor();
    comp.threshold.value = -22;
    comp.ratio.value = 4;
    this.master.connect(comp);
    comp.connect(this.ctx.destination);

    // 大聖堂風の残響: ノイズを指数減衰させたインパルス応答を合成
    const conv = this.ctx.createConvolver();
    conv.buffer = this._makeReverbIR(3.2);
    const wet = this.ctx.createGain();
    wet.gain.value = 0.5;
    conv.connect(wet);
    wet.connect(this.master);

    // 楽器はドライ+リバーブ送りの両方へ
    this.bus = this.ctx.createGain();
    this.bus.gain.value = 1;
    this.bus.connect(this.master);
    this.bus.connect(conv);

    // オルガンのドローン(常時鳴りっぱなし、コードの根音へグライド)
    this.droneOscs = [1, 2, 3].map((mult, i) => {
      const osc = this.ctx.createOscillator();
      osc.type = 'sine';
      osc.frequency.value = midiHz(38) * mult;
      const g = this.ctx.createGain();
      g.gain.value = [0.05, 0.022, 0.008][i];
      osc.connect(g);
      g.connect(this.bus);
      osc.start();
      return osc;
    });

    // 曲の進行状態
    this.progression = PROGRESSIONS[0];
    this.progIndex = 0;
  }

  _makeReverbIR(seconds) {
    const rate = this.ctx.sampleRate;
    const len = Math.floor(rate * seconds);
    const buf = this.ctx.createBuffer(2, len, rate);
    for (let ch = 0; ch < 2; ch++) {
      const data = buf.getChannelData(ch);
      for (let i = 0; i < len; i++) {
        data[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 2.6);
      }
    }
    return buf;
  }

  // スケジューラ: 先読みしながらコード単位でイベントを積む
  _pump() {
    if (!this.running) return;
    while (this.nextTime < this.ctx.currentTime + 2.0) {
      const name = this.progression[this.progIndex];
      this._scheduleChord(CHORDS[name], this.nextTime, this.progIndex);
      this.progIndex++;
      if (this.progIndex >= this.progression.length) {
        this.progIndex = 0;
        this.progression =
          PROGRESSIONS[Math.floor(Math.random() * PROGRESSIONS.length)];
      }
      this.nextTime += CHORD_DUR;
    }
  }

  _scheduleChord(chord, t0, beatIndex) {
    // ドローンを根音へゆっくりグライド
    for (let i = 0; i < this.droneOscs.length; i++) {
      this.droneOscs[i].frequency.setTargetAtTime(
        midiHz(chord.drone) * (i + 1), t0, 1.2,
      );
    }

    // 弦楽パッド(ゆっくり立ち上がる持続和音)
    for (const m of chord.notes) this._pad(m, t0, CHORD_DUR + 1.6);

    // ハープの分散和音(低→高、ときどき休符)
    const tones = [...chord.notes.slice(1), chord.notes[1] + 12, chord.notes[2] + 12];
    const step = 0.44;
    for (let i = 0; i < 10; i++) {
      if (Math.random() < 0.3) continue;
      const note = tones[i % tones.length] + (Math.random() < 0.12 ? 12 : 0);
      this._pluck(note, t0 + 0.3 + i * step);
    }

    // 笛の旋律(2コードに1回くらい、順次進行の短いフレーズ)
    if (beatIndex % 2 === 0 && Math.random() < 0.75) {
      let note = this._nearestScale(this.lastMelodyNote);
      let t = t0 + 0.6 + Math.random() * 0.8;
      const phraseLen = 2 + Math.floor(Math.random() * 3);
      for (let i = 0; i < phraseLen && t < t0 + CHORD_DUR - 1; i++) {
        const dur = 0.9 + Math.random() * 1.1;
        this._flute(note, t, dur);
        t += dur + 0.12;
        const stepDir = Math.random() < 0.5 ? -1 : 1;
        const idx = SCALE.indexOf(note);
        note = SCALE[Math.max(0, Math.min(SCALE.length - 1, idx + stepDir * (1 + (Math.random() < 0.2 ? 1 : 0))))];
      }
      this.lastMelodyNote = note;
    }
  }

  _nearestScale(m) {
    return SCALE.reduce((a, b) => (Math.abs(b - m) < Math.abs(a - m) ? b : a));
  }

  _pad(midi, t0, dur) {
    const freq = midiHz(midi);
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(0.045, t0 + 2.4);
    g.gain.setValueAtTime(0.045, t0 + dur - 2.2);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    const lp = this.ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = Math.min(freq * 4, 1400);
    lp.connect(g);
    g.connect(this.bus);
    for (const [type, det, vol] of [['triangle', -4, 1], ['sawtooth', 4, 0.22]]) {
      const osc = this.ctx.createOscillator();
      osc.type = type;
      osc.frequency.value = freq;
      osc.detune.value = det;
      const og = this.ctx.createGain();
      og.gain.value = vol;
      osc.connect(og);
      og.connect(lp);
      osc.start(t0);
      osc.stop(t0 + dur + 0.1);
    }
  }

  _pluck(midi, t0) {
    const osc = this.ctx.createOscillator();
    osc.type = 'triangle';
    osc.frequency.value = midiHz(midi);
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(0.075, t0 + 0.012);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + 1.3);
    const lp = this.ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 2400;
    osc.connect(lp);
    lp.connect(g);
    g.connect(this.bus);
    osc.start(t0);
    osc.stop(t0 + 1.5);
  }

  _flute(midi, t0, dur) {
    const osc = this.ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.value = midiHz(midi);
    // ビブラート(ゆっくり深くなる)
    const lfo = this.ctx.createOscillator();
    lfo.frequency.value = 5;
    const lfoGain = this.ctx.createGain();
    lfoGain.gain.setValueAtTime(0, t0);
    lfoGain.gain.linearRampToValueAtTime(4, t0 + dur * 0.7);
    lfo.connect(lfoGain);
    lfoGain.connect(osc.detune);
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(0.055, t0 + 0.28);
    g.gain.setValueAtTime(0.055, t0 + dur - 0.4);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    osc.connect(g);
    g.connect(this.bus);
    osc.start(t0);
    osc.stop(t0 + dur + 0.1);
    lfo.start(t0);
    lfo.stop(t0 + dur + 0.1);
  }
}
