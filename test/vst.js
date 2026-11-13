// Plugin host test: runs the real Python host and pushes audio through it.
// With no arguments it uses the built-in test gain. Pass a folder of .vst3 plugins to also load each one:
//   node test/vst.js /usr/lib/vst3
'use strict';
const assert = require('assert'), fs = require('fs'), os = require('os'), path = require('path');
const { VstHost } = require('../lib/vsthost');

function block(handle, seq, nch, frames, fill) {
  const b = Buffer.alloc(16 + nch * frames * 4);
  b.writeUInt32LE(handle, 0); b.writeUInt32LE(seq, 4); b.writeUInt16LE(nch, 8); b.writeUInt16LE(frames, 10);
  for (let i = 0; i < nch * frames; i++) b.writeFloatLE(fill(i), 16 + i * 4);
  return b;
}
// a pretend browser connection
function client(host) {
  const ws = { open: true, got: [], waiters: [], send(d) { const w = this.waiters.shift(); w ? w(d) : this.got.push(d); } };
  host.attach(ws);
  ws.next = () => new Promise((res, rej) => { if (ws.got.length) return res(ws.got.shift()); const t = setTimeout(() => rej(new Error('no reply from the plugin host')), 20000); ws.waiters.push(d => { clearTimeout(t); res(d); }); });
  ws.say = async o => { await ws.onmessage(JSON.stringify(o), false); };
  return ws;
}

(async () => {
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'lwm-vst-'));
  const host = new VstHost(data);
  try {
    const info = await host.start();
    assert.ok(info.ok, 'plugin host did not start: ' + info.error);
    console.log('plugin library', info.version);
    const ws = client(host);
    await ws.say({ t: 'open', h: 7, plugin: 'builtin:Gain', values: {}, ch: 2 });
    let m = JSON.parse(await ws.next());
    assert.strictEqual(m.t, 'opened', m.error); assert.strictEqual(m.params[0].name, 'gain_db');
    // 0 dB: audio comes back unchanged, with our handle and sequence number
    await ws.onmessage(block(7, 42, 2, 1024, i => (i % 100) / 100 - 0.5), true);
    let a = await ws.next();
    assert.strictEqual(a.readUInt32LE(0), 7); assert.strictEqual(a.readUInt32LE(4), 42); assert.strictEqual(a.length, 16 + 2 * 1024 * 4);
    assert.ok(Math.abs(a.readFloatLE(16 + 4 * 30) - (0.3 - 0.5)) < 1e-4);
    // -6 dB
    await ws.say({ t: 'set', h: 7, name: 'gain_db', raw: 54 / 84 });
    m = JSON.parse(await ws.next()); assert.strictEqual(m.t, 'val'); assert.ok(Math.abs(parseFloat(m.param.text) + 6) < 0.11, m.param.text);
    await ws.onmessage(block(7, 43, 2, 1024, () => 0.5), true);
    for (let k = 0; k < 4; k++) { await ws.onmessage(block(7, 44 + k, 2, 1024, () => 0.5), true); await ws.next(); }   // let any smoothing settle
    a = await ws.next();
    const v = a.readFloatLE(16 + 4 * 2000);
    assert.ok(Math.abs(v - 0.5 * Math.pow(10, -6 / 20)) < 0.01, 'gain not applied: ' + v);
    await ws.say({ t: 'open', h: 8, plugin: 'Nope.vst3', values: {}, ch: 1 });
    assert.strictEqual(JSON.parse(await ws.next()).t, 'error');

    const dir = process.argv[2];
    if (dir) {
      let loaded = 0;
      for (const f of fs.readdirSync(dir).filter(f => f.endsWith('.vst3')).slice(0, 6)) {
        fs.cpSync(path.join(dir, f), path.join(host.dir, f), { recursive: true, dereference: true });
        const meta = await host.probe(f);
        console.log(f, meta.error ? 'FAILED: ' + meta.error : meta.plugins.map(p => `${p.name} (${p.params} parameters)`).join(', '));
        if (meta.error || !meta.plugins.length) continue;
        const p = meta.plugins[0];
        await ws.say({ t: 'open', h: 100 + loaded, plugin: f + '::' + p.name, values: {}, ch: 2 });
        m = JSON.parse(await ws.next());
        if (m.t !== 'opened') { console.log('  open failed:', m.error); continue; }
        await ws.onmessage(block(100 + loaded, 1, 2, 1024, i => Math.sin(i / 20) * 0.3), true);
        a = await ws.next();
        assert.strictEqual(a.length, 16 + 2 * 1024 * 4);
        console.log('  processed a block,', m.params.length, 'parameters');
        loaded++;
      }
      assert.ok(loaded > 0, 'no VST3 plugin in ' + dir + ' could be loaded');
    }
    console.log('ok');
  } finally { host.stop(); fs.rmSync(data, { recursive: true, force: true }); }
})().catch(e => { console.error(e); process.exit(1); });
