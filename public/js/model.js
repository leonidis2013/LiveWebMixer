// LiveWebMixer mixer model: what a mix "is" (plain data, so a scene is just a copy of it).
export const NG = 4, NA = 6, NF = 2, ND = 4, OFF = -90;
export const dB2g = d => d <= OFF ? 0 : Math.pow(10, d / 20);
export const clone = o => JSON.parse(JSON.stringify(o));
export const uid = () => Math.random().toString(36).slice(2, 8);

// fader travel (0..1) <-> dB, console-style taper with 0 dB at about three quarters
const PTS = [[0, OFF], [0.04, -60], [0.2, -40], [0.36, -20], [0.52, -10], [0.76, 0], [1, 10]];
export function posToDb(p) {
  if (p <= 0.005) return OFF;
  for (let i = 1; i < PTS.length; i++) if (p <= PTS[i][0]) { const [a, da] = PTS[i - 1], [b, db] = PTS[i]; return da + (db - da) * (p - a) / (b - a); }
  return 10;
}
export function dbToPos(d) {
  if (d <= OFF) return 0;
  for (let i = 1; i < PTS.length; i++) if (d <= PTS[i][1]) { const [a, da] = PTS[i - 1], [b, db] = PTS[i]; return a + (b - a) * (d - da) / (db - da); }
  return 1;
}
export const fmtDb = d => d <= OFF ? '−∞' : (d > 0 ? '+' : d < 0 ? '−' : '') + Math.abs(d).toFixed(1);

// Processing blocks a channel's signal flow can be built from.
export const SPECS = {
  hpf: { label: 'HPF', long: 'High-pass filter', params: [{ k: 'freq', l: 'Frequency', min: 20, max: 2000, log: 1, u: 'Hz', d: 100 }, { k: 'slope', l: 'Slope', opts: [12, 24], u: 'dB/oct', d: 12 }] },
  lpf: { label: 'LPF', long: 'Low-pass filter', params: [{ k: 'freq', l: 'Frequency', min: 500, max: 20000, log: 1, u: 'Hz', d: 12000 }, { k: 'slope', l: 'Slope', opts: [12, 24], u: 'dB/oct', d: 12 }] },
  gate: { label: 'Gate', long: 'Noise gate', dyn: 1, params: [{ k: 'thr', l: 'Threshold', min: -80, max: 0, u: 'dB', d: -40 }, { k: 'depth', l: 'Depth', min: 0, max: 80, u: 'dB', d: 40 }, { k: 'att', l: 'Attack', min: 0.05, max: 50, log: 1, u: 'ms', d: 1 }, { k: 'hold', l: 'Hold', min: 0, max: 500, u: 'ms', d: 50 }, { k: 'rel', l: 'Release', min: 5, max: 2000, log: 1, u: 'ms', d: 150 }] },
  eq: { label: 'PEQ', long: 'Parametric EQ' },
  comp: { label: 'Comp', long: 'Compressor', dyn: 1, params: [{ k: 'thr', l: 'Threshold', min: -60, max: 0, u: 'dB', d: -20 }, { k: 'ratio', l: 'Ratio', min: 1, max: 20, log: 1, u: ':1', d: 3 }, { k: 'att', l: 'Attack', min: 0.1, max: 200, log: 1, u: 'ms', d: 10 }, { k: 'rel', l: 'Release', min: 10, max: 2000, log: 1, u: 'ms', d: 150 }, { k: 'knee', l: 'Knee', min: 0, max: 24, u: 'dB', d: 6 }, { k: 'makeup', l: 'Make-up', min: 0, max: 24, u: 'dB', d: 0 }] },
  deess: { label: 'De-ess', long: 'De-esser', dyn: 1, params: [{ k: 'freq', l: 'Frequency', min: 2000, max: 12000, log: 1, u: 'Hz', d: 6000 }, { k: 'thr', l: 'Threshold', min: -60, max: 0, u: 'dB', d: -30 }, { k: 'range', l: 'Max reduction', min: 0, max: 24, u: 'dB', d: 8 }] },
  vst: { label: 'Plugin', long: 'Server plugin', remote: 1 },
};
export const EQ_BANDS = () => [{ t: 'lowshelf', f: 100, g: 0, q: 0.7 }, { t: 'peaking', f: 400, g: 0, q: 1 }, { t: 'peaking', f: 2500, g: 0, q: 1 }, { t: 'highshelf', f: 8000, g: 0, q: 0.7 }];
export function newBlock(type, on = true) {
  const p = {};
  if (type === 'eq') p.b = EQ_BANDS(); else if (type === 'vst') Object.assign(p, { plugin: '', name: '', values: {} }); else for (const s of SPECS[type].params) p[s.k] = s.d;
  return { id: uid(), type, on, p };
}

// Channel templates: the starting signal flow a new channel gets. "match" words pick a template from the track name.
export const DEFAULT_TEMPLATES = [
  { name: 'Standard', match: '', chain: ['hpf', 'gate:off', 'eq', 'comp'] },
  { name: 'Vocal', match: 'vox, vocal, voc, bgv, lead, sing, choir, speech, pastor', chain: ['hpf', 'eq', 'comp', 'deess'] },
  { name: 'Drums', match: 'kick, snare, tom, hat, hh, oh, overhead, ride, cymbal, drum, perc, cajon', chain: ['gate', 'eq', 'comp'] },
  { name: 'Bass', match: 'bass', chain: ['eq', 'comp'] },
  { name: 'Instrument', match: 'gtr, guitar, keys, piano, synth, pad, organ, strings, acoustic', chain: ['hpf', 'eq', 'comp:off'] },
  { name: 'Empty', match: '', chain: [] },
].map(t => ({ ...t, chain: t.chain.map(c => { const [type, off] = c.split(':'); return { type, on: !off, p: newBlock(type).p }; }) }));

export const chainFrom = tpl => tpl.chain.map(b => ({ id: uid(), type: b.type, on: b.on !== false, p: clone(b.p) }));
export function pickTemplate(name, templates, dflt) {
  if (dflt !== 'auto') return templates.find(t => t.name === dflt) || templates[0];
  const n = ' ' + name.toLowerCase().replace(/[^a-z0-9]+/g, ' ') + ' ';
  for (const t of templates) for (const w of (t.match || '').split(',').map(w => w.trim().toLowerCase()).filter(Boolean)) if (n.includes(w)) return t;
  return templates[0];
}

const sends = () => { const o = {}; for (let i = 1; i <= NA; i++) o['a' + i] = { lvl: OFF, on: true, pre: true }; for (let i = 1; i <= NF; i++) o['f' + i] = { lvl: OFF, on: true, pre: false }; return o; };
const strip = (id, kind, name, extra = {}) => ({ id, kind, name, stereo: true, trim: 0, pol: false, chain: [], fader: 0, mute: false, pan: 0, lr: true, grp: Array(NG).fill(false), dca: Array(ND).fill(false), pfl: false, ...extra });

// Build a fresh mixer for a song: one input channel per track, plus the buses.
export function newMixer(tracks, templates, dflt) {
  const m = { strips: {}, inputs: [], dcas: [], monitor: 'main', refTrim: 0, tpl: dflt };
  for (const t of tracks) {
    const id = 'in' + t.id, tpl = pickTemplate(t.name, templates, dflt);
    m.strips[id] = strip(id, 'in', t.name, { stereo: t.channels > 1, fader: OFF, chain: chainFrom(tpl), tplName: tpl.name, sends: sends() });
    m.inputs.push(id);
  }
  for (let i = 1; i <= NG; i++) m.strips['g' + i] = strip('g' + i, 'grp', 'Group ' + i);
  for (let i = 1; i <= NA; i++) m.strips['a' + i] = strip('a' + i, 'aux', 'Aux ' + i);
  m.strips.f1 = strip('f1', 'fx', 'Reverb', { fx: { type: 'reverb', time: 1.8, pre: 20, damp: 6000, dtime: 350, fb: 30 } });
  m.strips.f2 = strip('f2', 'fx', 'Delay', { fx: { type: 'delay', time: 1.8, pre: 20, damp: 5000, dtime: 350, fb: 30 } });
  m.strips.main = strip('main', 'main', 'Main LR');
  for (let i = 1; i <= ND; i++) m.dcas.push({ name: 'DCA ' + i, fader: 0, mute: false });
  return m;
}
// Lay a saved mix (scene or last session) over a fresh one, so tracks added or removed since still line up.
export function overlay(fresh, saved) {
  if (!saved || !saved.strips) return fresh;
  for (const id of Object.keys(fresh.strips)) {
    const s = saved.strips[id]; if (!s) continue;
    const f = fresh.strips[id];
    fresh.strips[id] = { ...f, ...clone(s), id, kind: f.kind, stereo: f.stereo, pfl: false, sends: f.sends ? { ...f.sends, ...clone(s.sends || {}) } : undefined, fx: f.fx ? { ...f.fx, ...clone(s.fx || {}) } : undefined };
  }
  if (Array.isArray(saved.dcas)) fresh.dcas = fresh.dcas.map((d, i) => ({ ...d, ...(saved.dcas[i] || {}) }));
  fresh.monitor = saved.monitor && saved.monitor !== 'ref' ? saved.monitor : 'main';
  fresh.refTrim = saved.refTrim || 0;
  return fresh;
}
