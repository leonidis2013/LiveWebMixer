// LiveWebMixer audio engine: builds the whole console as a Web Audio graph inside the browser.
// All mixing happens locally, so a fader move is heard within the sound card's own buffer time.
import { dB2g, NG, NA, NF, ND } from './model.js';

const AUX = Array.from({ length: NA }, (_, i) => 'a' + (i + 1)), FX = Array.from({ length: NF }, (_, i) => 'f' + (i + 1));
const BUTTER = { 12: [-3.01], 24: [-5.33, 2.32] };   // Web Audio wants filter Q in dB for high/low-pass

export class Engine {
  constructor() { this.ctx = null; this.n = new Map(); this.pos = 0; this.len = 0; this.playing = false; this.onstate = null; this.buf = new Float32Array(1024); }

  static supported() { return !!(window.AudioContext && window.AudioWorkletNode && window.isSecureContext); }

  async start(chCounts) {
    if (this.ctx) await this.ctx.close().catch(() => {});
    this.n.clear(); this.pos = 0; this.len = 0; this.playing = false; this.loop = null;
    const ctx = this.ctx = new AudioContext({ sampleRate: 48000, latencyHint: 'interactive' });
    await ctx.audioWorklet.addModule('js/worklets.js');
    this.tp = new AudioWorkletNode(ctx, 'transport', { numberOfInputs: 0, numberOfOutputs: chCounts.length, outputChannelCount: chCounts });
    this.tp.port.onmessage = e => { this.pos = e.data.pos; this.playing = e.data.playing; this.onstate && this.onstate(e.data); };
    this.chCounts = chCounts;
  }

  // Download (or take from the browser's cache), decode, and hand one track to the audio thread.
  async loadTrack(i, url, onBytes) {
    let res, cache;
    try { cache = await caches.open('livewebmixer-audio'); res = await cache.match(url); } catch {}
    const cached = !!res;
    if (!res) {
      res = await fetch(url);
      if (!res.ok) throw new Error('Could not download a track (' + res.status + ')');
      if (cache) cache.put(url, res.clone()).catch(() => {});
    }
    const data = await res.arrayBuffer();
    onBytes && onBytes(data.byteLength, cached);
    const ab = await this.ctx.decodeAudioData(data);
    const ch = [];
    for (let c = 0; c < Math.min(ab.numberOfChannels, this.chCounts[i]); c++) {
      const f = ab.getChannelData(c), d = new Int16Array(f.length);
      for (let k = 0; k < f.length; k++) { const v = f[k] * 32767; d[k] = v > 32767 ? 32767 : v < -32768 ? -32768 : v; }
      ch.push(d.buffer);
    }
    this.len = Math.max(this.len, ab.length);
    this.tp.port.postMessage({ t: 'load', i, ch }, ch);
  }

  play() { this.ctx.resume(); this.tp.port.postMessage({ t: 'play' }); }
  pause() { this.tp.port.postMessage({ t: 'pause' }); }
  seek(sec) { this.pos = Math.max(0, Math.min(this.len, sec * 48000)); this.tp.port.postMessage({ t: 'seek', pos: this.pos }); }
  setLoop(a, b) { this.loop = a == null ? null : { a: Math.round(a * 48000), b: Math.round(b * 48000) }; this.tp.port.postMessage({ t: 'loop', loop: this.loop }); }
  get time() { return this.pos / 48000; }
  get duration() { return this.len / 48000; }
  get latencyMs() { return ((this.ctx.baseLatency || 0) + (this.ctx.outputLatency || 0)) * 1000; }

  // ---- graph ----
  // inputs: [{ id, out }] maps input strips to transport outputs; refOut is the reference mix's output (or -1)
  build(mixer, inputs, refOut) {
    const c = this.ctx; this.m = mixer;
    for (const sn of this.n.values()) this.dispose(sn);
    this.n.clear();
    if (this.out) { this.out.disconnect(); this.tp.disconnect(); }
    this.out = c.createGain(); this.out.connect(c.destination);
    this.selBus = c.createGain(); this.selBus.connect(this.out);
    this.pflBus = c.createGain(); this.pflBus.gain.value = 0; this.pflBus.connect(this.out);
    this.mon = {};
    for (const k of ['main', ...AUX, 'ref']) { const g = this.mon[k] = c.createGain(); g.gain.value = 0; g.connect(this.selBus); }
    if (refOut >= 0) this.tp.connect(this.mon.ref, refOut);

    const mk = id => { const sn = this.node(mixer.strips[id]); this.n.set(id, sn); return sn; };
    const main = mk('main'); main.post.connect(this.mon.main);
    for (let i = 1; i <= NG; i++) { const g = mk('g' + i); g.lrG = this.g(g.post, main.in); }
    for (const a of AUX) mk(a).post.connect(this.mon[a]);
    for (const f of FX) { const sn = mk(f); sn.lrG = this.g(sn.post, main.in); sn.fxIn = c.createGain(); this.fxSet(f); }
    for (const { id, out } of inputs) {
      const sn = mk(id);
      this.tp.connect(sn.in, out);
      sn.lrG = this.g(sn.post, main.in);
      sn.grpG = Array.from({ length: NG }, (_, i) => this.g(sn.post, this.n.get('g' + (i + 1)).in));
      sn.sends = {};
      for (const a of AUX) sn.sends[a] = { pre: this.g(sn.pre, this.n.get(a).in), post: this.g(sn.post, this.n.get(a).in) };
      for (const f of FX) sn.sends[f] = { pre: this.g(sn.pre, this.n.get(f).fxIn), post: this.g(sn.post, this.n.get(f).fxIn) };
    }
    for (const id of this.n.keys()) { this.rechain(id); this.update(id, true); }
    this.monitor();
  }
  g(from, to) { const g = this.ctx.createGain(); g.gain.value = 0; from.connect(g); g.connect(to); return g; }

  node(s) {
    const c = this.ctx, sn = { s, blocks: new Map() };
    sn.in = c.createGain(); sn.chainOut = c.createGain(); sn.pre = c.createGain(); sn.fad = c.createGain(); sn.post = c.createGain();
    sn.an = c.createAnalyser(); sn.an.fftSize = 1024; sn.pflG = c.createGain(); sn.pflG.gain.value = 0;
    sn.chainOut.connect(sn.pre); sn.chainOut.connect(sn.fad);
    if (s.kind === 'in') { sn.pan = c.createStereoPanner(); sn.fad.connect(sn.pan); sn.pan.connect(sn.post); } else sn.fad.connect(sn.post);
    (s.kind === 'in' ? sn.chainOut : sn.post).connect(sn.an);       // inputs meter pre-fader, buses post-fader
    (s.kind === 'in' ? sn.chainOut : sn.post).connect(sn.pflG); sn.pflG.connect(this.pflBus);
    return sn;
  }
  dispose(sn) {
    for (const k of ['in', 'chainOut', 'pre', 'fad', 'post', 'pan', 'an', 'pflG', 'lrG', 'fxIn']) sn[k] && sn[k].disconnect();
    for (const b of sn.blocks.values()) b.dispose();
    sn.fxNodes && sn.fxNodes.forEach(n => n.disconnect());
  }

  // Rewire a strip's processing chain in the order the model lists it (bypassed blocks are skipped).
  rechain(id) {
    const sn = this.n.get(id); if (!sn) return;
    sn.in.disconnect();
    for (const [bid, b] of sn.blocks) { b.out.disconnect(); if (!sn.s.chain.some(x => x.id === bid)) { b.dispose(); sn.blocks.delete(bid); } }
    let prev = sn.in;
    for (const b of sn.s.chain) {
      let node = sn.blocks.get(b.id);
      if (!node) { node = this.block(b); sn.blocks.set(b.id, node); }
      node.b = b; node.set();
      if (b.on) { prev.connect(node.in); prev = node.out; }
    }
    prev.connect(sn.chainOut);
  }
  blockSet(id, bid) { const sn = this.n.get(id), b = sn && sn.blocks.get(bid); b && b.set(); }
  gr(id, bid) { const sn = this.n.get(id), b = sn && sn.blocks.get(bid); return b && b.b.on ? b.gr || 0 : 0; }

  block(b) {
    const c = this.ctx, blk = { b, gr: 0 };
    if (b.type === 'hpf' || b.type === 'lpf') {
      const i = c.createGain(), o = c.createGain(), f = [c.createBiquadFilter(), c.createBiquadFilter()]; let slope = 0;
      blk.in = i; blk.out = o; blk.filters = f;
      blk.set = () => {
        const p = blk.b.p, q = BUTTER[p.slope] || BUTTER[12];
        f.forEach((x, k) => { x.type = blk.b.type === 'hpf' ? 'highpass' : 'lowpass'; x.frequency.value = p.freq; x.Q.value = q[k] ?? 0; });
        if (p.slope !== slope) { slope = p.slope; i.disconnect(); f[0].disconnect(); f[1].disconnect(); i.connect(f[0]); if (slope === 24) { f[0].connect(f[1]); f[1].connect(o); } else f[0].connect(o); }
      };
      blk.active = () => f.slice(0, slope === 24 ? 2 : 1);
      blk.dispose = () => { i.disconnect(); f[0].disconnect(); f[1].disconnect(); o.disconnect(); };
    } else if (b.type === 'eq') {
      const f = b.p.b.map(() => c.createBiquadFilter());
      f.forEach((x, k) => k && f[k - 1].connect(x));
      blk.in = f[0]; blk.out = f[f.length - 1]; blk.filters = f;
      blk.set = () => blk.b.p.b.forEach((band, k) => { f[k].type = band.t; f[k].frequency.value = band.f; f[k].gain.value = band.g; f[k].Q.value = band.q; });
      blk.active = () => f;
      blk.dispose = () => f.forEach(x => x.disconnect());
    } else {
      const n = new AudioWorkletNode(c, b.type);
      n.port.onmessage = e => { blk.gr = e.data; };
      blk.in = blk.out = n;
      blk.set = () => n.port.postMessage({ ...blk.b.p });
      blk.dispose = () => { n.disconnect(); n.port.onmessage = null; };
    }
    return blk;
  }
  // Magnitude response in dB of a filter/EQ block at the given frequencies (for drawing the curve).
  response(id, bid, freqs) {
    const sn = this.n.get(id), b = sn && sn.blocks.get(bid), out = new Float32Array(freqs.length);
    if (!b || !b.active) return out;
    const mag = new Float32Array(freqs.length), ph = new Float32Array(freqs.length);
    for (const f of b.active()) { f.getFrequencyResponse(freqs, mag, ph); for (let i = 0; i < out.length; i++) out[i] += 20 * Math.log10(mag[i] || 1e-6); }
    return out;
  }

  // Apply fader, mute, pan, routing and sends of one strip.
  update(id, now) {
    const sn = this.n.get(id); if (!sn) return;
    const s = sn.s, m = this.m, t = this.ctx.currentTime;
    const set = (p, v) => now ? p.setValueAtTime(v, t) : p.setTargetAtTime(v, t, 0.008);
    let dca = 1, dmute = false;
    s.dca.forEach((on, i) => { if (on) { dca *= dB2g(m.dcas[i].fader); dmute = dmute || m.dcas[i].mute; } });
    const muted = s.mute || dmute;
    set(sn.in.gain, dB2g(s.trim) * (s.pol ? -1 : 1));
    set(sn.pre.gain, muted ? 0 : 1);
    set(sn.fad.gain, muted ? 0 : dB2g(s.fader) * dca);
    if (sn.pan) set(sn.pan.pan, s.pan);
    if (sn.lrG) set(sn.lrG.gain, s.lr ? 1 : 0);
    if (sn.grpG) sn.grpG.forEach((g, i) => set(g.gain, s.grp[i] ? 1 : 0));
    if (sn.sends) for (const [k, n] of Object.entries(sn.sends)) {
      const sd = s.sends[k], g = sd.on ? dB2g(sd.lvl) : 0;
      set(n.pre.gain, sd.pre ? g : 0); set(n.post.gain, sd.pre ? 0 : g);
    }
    set(sn.pflG.gain, s.pfl ? 1 : 0);
  }
  updateAll() { for (const id of this.n.keys()) this.update(id); this.monitor(); }

  // What the headphones hear: main, an aux mix, the reference track, or whatever is soloed (PFL).
  monitor() {
    const m = this.m, t = this.ctx.currentTime;
    const pfl = Object.values(m.strips).some(s => s.pfl);
    for (const [k, g] of Object.entries(this.mon)) g.gain.setTargetAtTime(m.monitor === k ? (k === 'ref' ? dB2g(m.refTrim) : 1) : 0, t, 0.008);
    this.selBus.gain.setTargetAtTime(pfl ? 0 : 1, t, 0.008);
    this.pflBus.gain.setTargetAtTime(pfl ? 1 : 0, t, 0.008);
  }

  // ---- effects ----
  fxSet(id) {
    const sn = this.n.get(id), c = this.ctx, fx = sn.s.fx;
    if (sn.fxType !== fx.type) {
      sn.fxNodes && sn.fxNodes.forEach(n => n.disconnect());
      sn.fxIn.disconnect(); sn.fxType = fx.type; sn.irKey = '';
      if (fx.type === 'reverb') {
        const pre = c.createDelay(0.25), conv = c.createConvolver(); conv.normalize = false;
        sn.fxIn.connect(pre); pre.connect(conv); conv.connect(sn.in); sn.fxNodes = [pre, conv];
      } else {
        const d = c.createDelay(2), lp = c.createBiquadFilter(), fb = c.createGain(); lp.type = 'lowpass';
        sn.fxIn.connect(d); d.connect(sn.in); d.connect(lp); lp.connect(fb); fb.connect(d); sn.fxNodes = [d, lp, fb];
      }
    }
    if (fx.type === 'reverb') {
      const [pre, conv] = sn.fxNodes;
      pre.delayTime.value = fx.pre / 1000;
      const key = fx.time + '/' + fx.damp;
      if (key !== sn.irKey) { sn.irKey = key; conv.buffer = this.impulse(fx.time, fx.damp); }
    } else {
      const [d, lp, fb] = sn.fxNodes;
      d.delayTime.setTargetAtTime(fx.dtime / 1000, c.currentTime, 0.05); lp.frequency.value = fx.damp; fb.gain.value = Math.min(0.95, fx.fb / 100);
    }
  }
  impulse(time, damp) {
    const sr = 48000, n = Math.round(sr * time * 1.1), buf = this.ctx.createBuffer(2, n, sr), a = Math.exp(-2 * Math.PI * damp / sr);
    for (let c = 0; c < 2; c++) {
      const d = buf.getChannelData(c); let lp = 0, e = 0;
      for (let i = 0; i < n; i++) { lp = a * lp + (1 - a) * (Math.random() * 2 - 1); d[i] = lp * Math.exp(-6.9 * i / (sr * time)); e += d[i] * d[i]; }
      const k = 0.7 / Math.sqrt(e || 1);
      for (let i = 0; i < n; i++) d[i] *= k;
    }
    return buf;
  }

  // Peak level of a strip in dB (for the meters).
  level(id) {
    const sn = this.n.get(id); if (!sn) return -120;
    sn.an.getFloatTimeDomainData(this.buf);
    let p = 0; for (let i = 0; i < 1024; i++) { const v = Math.abs(this.buf[i]); if (v > p) p = v; }
    return p > 1e-6 ? 20 * Math.log10(p) : -120;
  }
}
