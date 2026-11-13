// LiveWebMixer audio-thread processors. Everything here runs on the browser's real-time audio thread.
const lin = d => Math.pow(10, d / 20);
const coef = ms => Math.exp(-1 / (Math.max(0.01, ms) * 0.001 * sampleRate));

// Plays every track of the song from one clock, so tracks can never drift apart.
// Audio is held as 16-bit samples (half the memory of the browser's own buffers).
class Transport extends AudioWorkletProcessor {
  constructor() {
    super();
    this.tr = []; this.pos = 0; this.len = 0; this.playing = false; this.g = 0; this.loop = null; this.since = 0;
    this.port.onmessage = e => {
      const m = e.data;
      if (m.t === 'load') { this.tr[m.i] = m.ch.map(b => new Int16Array(b)); this.len = Math.max(this.len, this.tr[m.i][0].length); }
      else if (m.t === 'play') { if (this.pos >= this.len) this.pos = 0; this.playing = true; }
      else if (m.t === 'pause') this.playing = false;
      else if (m.t === 'seek') { this.pos = Math.max(0, Math.min(this.len, Math.round(m.pos))); this.report(); }
      else if (m.t === 'loop') this.loop = m.loop && m.loop.b > m.loop.a + 480 ? m.loop : null;
    };
  }
  report(ended) { this.port.postMessage({ pos: this.pos, playing: this.playing, ended: !!ended }); }
  process(_, outputs) {
    const n = outputs[0][0].length;
    const g0 = this.g, g1 = this.playing ? 1 : 0;
    if (g0 === 0 && g1 === 0) return true;
    const step = (g1 - g0) / n, loop = this.loop, start = this.pos, K = 1 / 32768;
    let end = start;
    for (let o = 0; o < outputs.length; o++) {
      const src = this.tr[o], out = outputs[o];
      if (!src) continue;
      for (let c = 0; c < out.length; c++) {
        const s = src[Math.min(c, src.length - 1)], d = out[c], L = s.length;
        let p = start, g = g0;
        for (let i = 0; i < n; i++) {
          d[i] = p < L ? s[p] * K * g : 0;
          g += step; p++;
          if (loop && p >= loop.b) p = loop.a;
        }
      }
    }
    for (let i = 0; i < n; i++) { end++; if (loop && end >= loop.b) end = loop.a; }
    this.pos = end; this.g = g1;
    let ended = false;
    if (this.playing && this.pos >= this.len) { this.playing = false; this.g = 0; this.pos = this.len; ended = true; }
    this.since += n;
    if (ended || this.since >= 2048 || g1 !== g0) { this.since = 0; this.report(ended); }
    return true;
  }
}
registerProcessor('transport', Transport);

// Shared base: parameters arrive as messages, gain reduction is reported back for the meters.
class Dyn extends AudioWorkletProcessor {
  constructor() {
    super();
    this.p = {}; this.gr = 0; this.since = 0; this.last = -1;
    this.port.onmessage = e => { Object.assign(this.p, e.data); this.update(); };
  }
  update() {}
  meter(gr, n) {
    if (gr > this.gr) this.gr = gr;
    this.since += n;
    if (this.since >= 1536) {
      if (Math.abs(this.gr - this.last) > 0.05) { this.port.postMessage(this.gr); this.last = this.gr; }
      this.since = 0; this.gr = 0;
    }
  }
}

class Comp extends Dyn {
  constructor() { super(); this.env = 0; this.p = { thr: -20, ratio: 3, att: 10, rel: 150, knee: 6, makeup: 0 }; this.update(); }
  update() { this.a = coef(this.p.att); this.r = coef(this.p.rel); this.mk = lin(this.p.makeup); this.slope = 1 - 1 / Math.max(1, this.p.ratio); }
  process(inputs, outputs) {
    const inp = inputs[0], out = outputs[0];
    if (!inp.length) { this.meter(0, 128); return true; }
    const n = inp[0].length, x0 = inp[0], x1 = inp[1], { thr, knee } = this.p, slope = this.slope;
    let env = this.env, max = 0;
    for (let i = 0; i < n; i++) {
      let a = Math.abs(x0[i]); if (x1) { const b = Math.abs(x1[i]); if (b > a) a = b; }
      const db = a > 1e-6 ? 20 * Math.log10(a) : -120, over = db - thr;
      let gr = 0;
      if (knee > 0 && over > -knee / 2 && over < knee / 2) { const t = over + knee / 2; gr = slope * t * t / (2 * knee); }
      else if (over > 0) gr = slope * over;
      env = gr > env ? this.a * env + (1 - this.a) * gr : this.r * env + (1 - this.r) * gr;
      if (env > max) max = env;
      const g = Math.pow(10, -env / 20) * this.mk;
      for (let c = 0; c < out.length; c++) out[c][i] = (inp[c] || x0)[i] * g;
    }
    this.env = env < 1e-6 ? 0 : env;
    this.meter(max, n);
    return true;
  }
}
registerProcessor('comp', Comp);

class Gate extends Dyn {
  constructor() { super(); this.env = 0; this.g = 0; this.hold = 0; this.open = false; this.p = { thr: -40, depth: 40, att: 1, hold: 50, rel: 150 }; this.update(); }
  update() { this.a = coef(this.p.att); this.r = coef(this.p.rel); this.thr = lin(this.p.thr); this.close = lin(this.p.thr - 3); this.holdN = this.p.hold * 0.001 * sampleRate; this.detRel = coef(5); }
  process(inputs, outputs) {
    const inp = inputs[0], out = outputs[0];
    if (!inp.length) { this.meter(0, 128); return true; }
    const n = inp[0].length, x0 = inp[0], x1 = inp[1], depth = this.p.depth;
    let env = this.env, g = this.g, max = 0;   // g = current reduction in dB
    for (let i = 0; i < n; i++) {
      let a = Math.abs(x0[i]); if (x1) { const b = Math.abs(x1[i]); if (b > a) a = b; }
      env = a > env ? a : this.detRel * env + (1 - this.detRel) * a;
      if (env >= this.thr) { this.open = true; this.hold = this.holdN; }
      else if (env < this.close && this.open) { if (this.hold > 0) this.hold--; else this.open = false; }
      const target = this.open ? 0 : depth;
      g = target < g ? this.a * g + (1 - this.a) * target : this.r * g + (1 - this.r) * target;
      if (g > max) max = g;
      const k = Math.pow(10, -g / 20);
      for (let c = 0; c < out.length; c++) out[c][i] = (inp[c] || x0)[i] * k;
    }
    this.env = env; this.g = g;
    this.meter(max, n);
    return true;
  }
}
registerProcessor('gate', Gate);

// Split-band de-esser: only the band above the frequency is turned down.
class DeEss extends Dyn {
  constructor() { super(); this.env = 0; this.z = [[0, 0, 0, 0], [0, 0, 0, 0]]; this.p = { freq: 6000, thr: -30, range: 8 }; this.update(); }
  update() {
    const w = 2 * Math.PI * Math.min(this.p.freq, sampleRate * 0.45) / sampleRate, cs = Math.cos(w), al = Math.sin(w) / (2 * 0.707), a0 = 1 + al;
    this.b0 = (1 + cs) / 2 / a0; this.b1 = -(1 + cs) / a0; this.b2 = this.b0; this.a1 = -2 * cs / a0; this.a2 = (1 - al) / a0;
    this.a = coef(0.5); this.r = coef(60);
  }
  process(inputs, outputs) {
    const inp = inputs[0], out = outputs[0];
    if (!inp.length) { this.meter(0, 128); return true; }
    const n = inp[0].length, { thr, range } = this.p, hi = [new Float32Array(n), new Float32Array(n)];
    for (let c = 0; c < Math.min(2, inp.length); c++) {
      const x = inp[c], z = this.z[c], h = hi[c];
      for (let i = 0; i < n; i++) {
        const y = this.b0 * x[i] + this.b1 * z[0] + this.b2 * z[1] - this.a1 * z[2] - this.a2 * z[3];
        z[1] = z[0]; z[0] = x[i]; z[3] = z[2]; z[2] = Math.abs(y) < 1e-20 ? 0 : y; h[i] = y;
      }
    }
    let env = this.env, max = 0;
    for (let i = 0; i < n; i++) {
      let a = Math.abs(hi[0][i]); if (inp.length > 1) { const b = Math.abs(hi[1][i]); if (b > a) a = b; }
      const db = a > 1e-6 ? 20 * Math.log10(a) : -120;
      const gr = Math.min(range, Math.max(0, db - thr));
      env = gr > env ? this.a * env + (1 - this.a) * gr : this.r * env + (1 - this.r) * gr;
      if (env > max) max = env;
      const k = Math.pow(10, -env / 20) - 1;
      for (let c = 0; c < out.length; c++) { const ci = c < inp.length ? c : 0; out[c][i] = inp[ci][i] + hi[Math.min(ci, 1)][i] * k; }
    }
    this.env = env < 1e-6 ? 0 : env;
    this.meter(max, n);
    return true;
  }
}
registerProcessor('deess', DeEss);

// Insert for a plugin that runs on the server. Audio is sent out in blocks and the processed blocks are
// played back exactly `delay` samples later, so the channel stays lined up with the others (which are
// delayed by the same amount). If a block is not back in time, the unprocessed signal is used instead.
class Remote extends AudioWorkletProcessor {
  constructor(o) {
    super();
    const po = o.processorOptions || {};
    this.D = po.delay || 12000; this.h = po.h || 0; this.ch = po.ch || 1;
    this.B = 1024; this.R = 65536; this.NB = this.R / this.B;
    this.dry = [new Float32Array(this.R), new Float32Array(this.R)];
    this.wet = [new Float32Array(this.R), new Float32Array(this.R)];
    this.wseq = new Int32Array(this.NB).fill(-1);
    this.n = 0; this.link = null; this.late = 0; this.total = 0;
    this.port.onmessage = e => {
      if (!e.data.port) return;
      this.link = e.data.port;
      this.link.onmessage = ev => {
        const buf = ev.data, dv = new DataView(buf), seq = dv.getUint32(4, true), nch = dv.getUint16(8, true), frames = dv.getUint16(10, true);
        if (frames !== this.B) return;
        const f = new Float32Array(buf, 16), at = (seq * this.B) % this.R;
        for (let c = 0; c < this.ch; c++) this.wet[c].set(f.subarray(Math.min(c, nch - 1) * frames, Math.min(c, nch - 1) * frames + frames), at);
        this.wseq[seq % this.NB] = seq;
      };
    };
  }
  process(inputs, outputs) {
    const inp = inputs[0], out = outputs[0], n = out[0].length, { B, R, D, ch } = this;
    for (let i = 0; i < n; i++) {
      const pos = this.n % R;
      for (let c = 0; c < ch; c++) this.dry[c][pos] = inp.length ? (inp[c] || inp[0])[i] : 0;
      const j = this.n - D;
      if (j >= 0) {
        const jp = j % R, blk = Math.floor(j / B), ok = this.wseq[blk % this.NB] === blk;
        if (!ok) this.late++;
        this.total++;
        for (let c = 0; c < out.length; c++) out[c][i] = (ok ? this.wet : this.dry)[Math.min(c, ch - 1)][jp];
      }
      this.n++;
      if (this.n % B === 0 && this.link) {       // a full block is ready: ship it
        const seq = this.n / B - 1, buf = new ArrayBuffer(16 + ch * B * 4), dv = new DataView(buf), f = new Float32Array(buf, 16), at = (seq * B) % R;
        dv.setUint32(0, this.h, true); dv.setUint32(4, seq, true); dv.setUint16(8, ch, true); dv.setUint16(10, B, true);
        for (let c = 0; c < ch; c++) f.set(this.dry[c].subarray(at, at + B), c * B);
        this.link.postMessage(buf, [buf]);
      }
    }
    if (this.total >= 24000) { this.port.postMessage(this.late / this.total); this.late = 0; this.total = 0; }
    return true;
  }
}
registerProcessor('remote', Remote);
