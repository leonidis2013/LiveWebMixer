// Runs the Python plugin host (vsthost.py) and routes audio blocks between browsers and plugins.
'use strict';
const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');

class VstHost {
  constructor(dataDir) {
    this.dir = path.join(dataDir, 'plugins');
    fs.mkdirSync(this.dir, { recursive: true });
    this.proc = null; this.ready = null; this.pending = new Map(); this.rid = 0;
    this.handles = new Map();      // global handle -> { ws, h }
    this.next = 1; this.info = { ok: false, error: 'not started', version: '' };
    this.crashed = new Set();      // plugin paths that took the host down while loading
    this.opening = new Set(); this.clients = new Set(); this.xvfb = null;
  }

  // Start (or restart) the Python process. Resolves once it has answered 'hello'.
  start() {
    if (this.ready) return this.ready;
    this.ready = new Promise(resolve => {
      const env = { ...process.env };
      if (!env.DISPLAY && !this.xvfb && spawnSync('sh', ['-c', 'command -v Xvfb']).status === 0) {
        // many plugins refuse to load without a screen, so give them an invisible one
        this.xvfb = spawn('Xvfb', [':97', '-screen', '0', '1280x800x24', '-nolisten', 'tcp'], { stdio: 'ignore' });
        this.xvfb.on('error', () => {}); this.xvfb.on('exit', () => { this.xvfb = null; });
      }
      if (this.xvfb) env.DISPLAY = ':97';
      let p;
      try { p = spawn(process.env.PYTHON || 'python3', [path.join(__dirname, '..', 'vsthost.py')], { stdio: ['pipe', 'inherit', 'inherit', 'pipe'], env }); }
      catch (e) { this.info = { ok: false, error: e.message }; return resolve(this.info); }
      this.proc = p;
      let buf = Buffer.alloc(0);
      p.stdio[3].on('data', chunk => {
        buf = buf.length ? Buffer.concat([buf, chunk]) : chunk;
        while (buf.length >= 5) {
          const n = buf.readUInt32LE(0);
          if (buf.length < 5 + n) break;
          const kind = buf[4], body = buf.subarray(5, 5 + n);
          buf = buf.subarray(5 + n);
          if (kind === 0) { const m = JSON.parse(body.toString('utf8')); const cb = this.pending.get(m.id); if (cb) { this.pending.delete(m.id); cb(m); } }
          else this.audioBack(Buffer.from(body));
        }
      });
      p.stdin.on('error', () => {});
      const gone = err => {
        if (this.proc !== p) return;
        this.proc = null; this.ready = null;
        for (const pth of this.opening) this.crashed.add(pth);
        this.opening.clear();
        for (const cb of this.pending.values()) cb({ ok: false, error: 'The plugin host stopped' });
        this.pending.clear(); this.handles.clear();
        if (!this.info.ok) this.info.error = this.info.error || (err && err.message) || 'The plugin host could not start';
        for (const ws of this.clients) ws.send(JSON.stringify({ t: 'lost' }));
        resolve(this.info);
      };
      p.on('error', e => { this.info = { ok: false, error: e.code === 'ENOENT' ? 'Python is not installed in this container' : e.message }; gone(e); });
      p.on('exit', () => gone());
      this.cmd({ cmd: 'hello' }).then(m => { this.info = { ok: !!m.ok, error: m.error || '', version: m.version || '' }; resolve(this.info); });
    });
    return this.ready;
  }
  write(kind, payload) {
    if (!this.proc) return;
    const h = Buffer.alloc(5); h.writeUInt32LE(payload.length, 0); h[4] = kind;
    this.proc.stdin.write(h); this.proc.stdin.write(payload);
  }
  cmd(msg, timeout = 30000) {
    return new Promise(resolve => {
      if (!this.proc) return resolve({ ok: false, error: 'The plugin host is not running' });
      const id = ++this.rid;
      const t = setTimeout(() => { this.pending.delete(id); resolve({ ok: false, error: 'The plugin host did not answer' }); }, timeout);
      this.pending.set(id, m => { clearTimeout(t); resolve(m); });
      this.write(0, Buffer.from(JSON.stringify({ ...msg, id })));
    });
  }
  async request(msg, timeout) { const i = await this.start(); return i.ok ? this.cmd(msg, timeout) : { ok: false, error: i.error }; }

  // ---- installed plugins ----
  pluginPath(id) { const f = path.join(this.dir, path.basename(String(id))); return f.endsWith('.vst3') && fs.existsSync(f) ? f : null; }
  async list() {
    const out = [];
    for (const d of (await fsp.readdir(this.dir).catch(() => [])).sort()) {
      if (!d.endsWith('.vst3')) continue;
      const meta = JSON.parse(await fsp.readFile(path.join(this.dir, d + '.json'), 'utf8').catch(() => '{}'));
      out.push({ id: d, plugins: meta.plugins || [], error: this.crashed.has(path.join(this.dir, d)) ? 'This plugin crashed the plugin host' : meta.error || '' });
    }
    return out;
  }
  // Check that a plugin folder really loads, and remember what is inside it.
  async probe(id) {
    const p = this.pluginPath(id); if (!p) return;
    this.opening.add(p);
    const r = await this.request({ cmd: 'probe', path: p }, 180000);   // big plugin bundles take a while to scan
    this.opening.delete(p);
    const meta = r.ok ? { plugins: r.plugins } : { plugins: [], error: r.error };
    if (r.ok) this.crashed.delete(p);
    await fsp.writeFile(p + '.json', JSON.stringify(meta));
    return meta;
  }
  async remove(id) { const p = this.pluginPath(id); if (!p) return; await fsp.rm(p, { recursive: true, force: true }); await fsp.rm(p + '.json', { force: true }); this.crashed.delete(p); }

  // ---- one browser connection ----
  attach(ws) {
    this.clients.add(ws);
    const mine = new Map();        // client handle -> global handle
    ws.onclose = () => { this.clients.delete(ws); for (const g of mine.values()) { this.handles.delete(g); this.cmd({ cmd: 'close', handle: g }); } };
    ws.onmessage = async (data, binary) => {
      if (binary) {                // audio block: swap the client's handle for ours and pass it on
        if (data.length < 16) return;
        const g = mine.get(data.readUInt32LE(0));
        if (!g || !this.proc) return;
        data.writeUInt32LE(g, 0); this.write(1, data);
        return;
      }
      let m; try { m = JSON.parse(data); } catch { return; }
      const say = o => ws.send(JSON.stringify(o));
      if (m.t === 'open') {
        const [id, name] = String(m.plugin || '').split('::');
        const p = id === 'builtin:Gain' ? id : this.pluginPath(id);
        if (!p) return say({ t: 'error', h: m.h, error: 'This plugin is not installed on the server' });
        if (this.crashed.has(p)) return say({ t: 'error', h: m.h, error: 'This plugin crashed the plugin host. Remove it, or upload it again to retry.' });
        const g = this.next++;
        this.opening.add(p);
        const r = await this.request({ cmd: 'open', handle: g, path: p, name: name || '', values: m.values || {}, ch: m.ch }, 90000);
        this.opening.delete(p);
        if (!r.ok) return say({ t: 'error', h: m.h, error: r.error });
        if (!ws.open) return this.cmd({ cmd: 'close', handle: g });
        mine.set(m.h, g); this.handles.set(g, { ws, h: m.h });
        say({ t: 'opened', h: m.h, params: r.params });
      } else if (m.t === 'set') {
        const g = mine.get(m.h); if (!g) return;
        const r = await this.cmd({ cmd: 'set', handle: g, name: m.name, raw: m.raw });
        if (r.ok) say({ t: 'val', h: m.h, param: r.param });
      } else if (m.t === 'close') {
        const g = mine.get(m.h); if (!g) return;
        mine.delete(m.h); this.handles.delete(g); this.cmd({ cmd: 'close', handle: g });
      }
    };
  }
  audioBack(buf) {
    const t = this.handles.get(buf.readUInt32LE(0));
    if (!t) return;
    buf.writeUInt32LE(t.h, 0); t.ws.send(buf);
  }
  stop() { this.proc && this.proc.kill(); this.xvfb && this.xvfb.kill(); }
}
module.exports = { VstHost };
