// LiveWebMixer server: serves the web mixer, stores multitrack songs, and
// transcodes every uploaded track to lossless (FLAC) and compressed (Opus) copies.
// No npm dependencies: Node built-ins plus the ffmpeg/unzip/openssl programs in the image.
'use strict';
const http = require('http');
const https = require('https');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { spawn, execFileSync } = require('child_process');
const wsLib = require('./lib/ws');
const vault = require('./lib/vault');
const { VstHost } = require('./lib/vsthost');

const VERSION = require('./package.json').version;
const DATA = path.resolve(process.env.DATA_DIR || '/data');
const PORT = +(process.env.PORT || 8080);
const HTTPS_PORT = +(process.env.HTTPS_PORT || 8443);
const PUBLIC = path.join(__dirname, 'public');
const SONGS = path.join(DATA, 'songs');
const AUDIO_EXT = new Set(['.wav', '.aif', '.aiff', '.flac', '.mp3', '.m4a', '.aac', '.ogg', '.opus', '.wma', '.caf']);
// bitrates in kbit/s for [mono, stereo]
const QUALITIES = { flac: { ext: 'flac', mime: 'audio/flac' }, hi: { ext: 'hi.opus', mime: 'audio/ogg', kbps: [96, 160] }, lo: { ext: 'lo.opus', mime: 'audio/ogg', kbps: [48, 80] } };
const MAX_UPLOAD = +(process.env.MAX_UPLOAD_MB || 4096) * 1024 * 1024;

fs.mkdirSync(SONGS, { recursive: true });
const SETTINGS = path.join(DATA, 'settings.json');
const vst = new VstHost(DATA);
const ARCH = process.arch === 'x64' ? 'x86_64' : process.arch === 'arm64' ? 'aarch64' : process.arch;

// ---------- small helpers ----------
const id = (n = 4) => crypto.randomBytes(n).toString('hex');
const okId = s => typeof s === 'string' && /^[a-f0-9]{6,16}$/.test(s);
const songDir = sid => path.join(SONGS, sid);
const readJson = async (f, dflt) => { try { return JSON.parse(await fsp.readFile(f, 'utf8')); } catch { return dflt; } };
const writeJson = async (f, v) => { const t = f + '.' + id() + '.tmp'; await fsp.writeFile(t, JSON.stringify(v)); await fsp.rename(t, f); };
const send = (res, code, body, headers = {}) => {
  const buf = Buffer.isBuffer(body) ? body : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
  res.writeHead(code, { 'Content-Type': typeof body === 'string' ? 'text/plain; charset=utf-8' : 'application/json', 'Content-Length': buf.length, 'Cache-Control': 'no-store', ...headers });
  res.end(buf);
};
const readBody = (req, limit = 20 * 1024 * 1024) => new Promise((resolve, reject) => {
  const chunks = []; let n = 0;
  req.on('data', c => { n += c.length; if (n > limit) { reject(new Error('Body too large')); req.destroy(); } else chunks.push(c); });
  req.on('end', () => { try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}); } catch { reject(new Error('Bad JSON')); } });
  req.on('error', reject);
});
const run = (cmd, args) => new Promise((resolve, reject) => {
  const p = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '', err = '';
  p.stdout.on('data', d => out += d); p.stderr.on('data', d => err += d);
  p.on('error', reject);
  p.on('close', code => code === 0 ? resolve(out) : reject(new Error((err || out || cmd + ' failed').trim().split('\n').slice(-3).join(' '))));
});
const cleanName = file => path.basename(file, path.extname(file)).replace(/^\d+[\s_.\-]*/, '').replace(/[_]+/g, ' ').trim() || path.basename(file);

// ---------- songs ----------
// One song.json per song; writes are serialized per song so parallel uploads don't clobber each other.
const locks = new Map();
function withSong(sid, fn) {
  const prev = locks.get(sid) || Promise.resolve();
  const next = prev.catch(() => {}).then(async () => {
    const f = path.join(songDir(sid), 'song.json');
    const song = await readJson(f, null);
    if (!song) throw Object.assign(new Error('Song not found'), { code: 404 });
    const r = await fn(song);
    if (r !== false) await writeJson(f, song);
    return song;
  });
  locks.set(sid, next);
  return next;
}
const getSong = sid => readJson(path.join(songDir(sid), 'song.json'), null);
async function listSongs() {
  const out = [];
  for (const d of await fsp.readdir(SONGS).catch(() => [])) {
    const s = okId(d) && await getSong(d);
    if (s) out.push({ id: s.id, name: s.name, created: s.created, tracks: s.tracks.length, duration: Math.max(0, ...s.tracks.map(t => t.duration || 0)) });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
}

// ---------- transcoding queue ----------
const queue = []; let running = 0;
const WORKERS = Math.max(1, Math.min(4, os.cpus().length - 1));
function enqueue(sid, tid) { queue.push({ sid, tid }); pump(); }
function pump() {
  while (running < WORKERS && queue.length) {
    const job = queue.shift(); running++;
    transcode(job.sid, job.tid).catch(e => console.error('transcode', e.message)).finally(() => { running--; pump(); });
  }
}
async function transcode(sid, tid) {
  let track;
  await withSong(sid, s => { track = s.tracks.find(t => t.id === tid); if (!track) return false; track.status = 'processing'; track.error = ''; });
  if (!track) return;
  const dir = songDir(sid), src = path.join(dir, 'src', track.file), outDir = path.join(dir, 't');
  await fsp.mkdir(outDir, { recursive: true });
  try {
    const probe = JSON.parse(await run('ffprobe', ['-v', 'error', '-select_streams', 'a:0', '-show_entries', 'stream=channels,sample_rate,duration:format=duration', '-of', 'json', src]));
    const st = (probe.streams || [])[0];
    if (!st) throw new Error('No audio found in this file');
    const srcCh = +st.channels || 1, ch = track.mono || srcCh === 1 ? 1 : 2;
    const duration = +(st.duration || (probe.format || {}).duration || 0);
    const args = ['-y', '-v', 'error', '-i', src];
    const common = ['-map', '0:a:0', '-vn', '-ac', String(ch), '-ar', '48000'];
    for (const q of Object.values(QUALITIES)) {
      args.push(...common);
      if (q.kbps) args.push('-c:a', 'libopus', '-b:a', q.kbps[ch - 1] + 'k', '-vbr', 'on', '-application', 'audio', '-f', 'ogg');
      else args.push('-c:a', 'flac', '-compression_level', '5', '-f', 'flac');
      args.push(path.join(outDir, tid + '.' + q.ext));
    }
    await run('ffmpeg', args);
    const sizes = {};
    for (const [k, q] of Object.entries(QUALITIES)) sizes[k] = (await fsp.stat(path.join(outDir, tid + '.' + q.ext))).size;
    await withSong(sid, s => { const t = s.tracks.find(t => t.id === tid); if (!t) return false; Object.assign(t, { status: 'ready', channels: ch, srcChannels: srcCh, duration, sizes, rev: (t.rev || 0) + 1 }); });
  } catch (e) {
    await withSong(sid, s => { const t = s.tracks.find(t => t.id === tid); if (!t) return false; t.status = 'error'; t.error = e.message.slice(0, 300); }).catch(() => {});
  }
}
// pick up anything that was mid-transcode when the container stopped
(async () => {
  for (const s of await listSongs()) {
    const song = await getSong(s.id);
    for (const t of song.tracks) if (t.status === 'queued' || t.status === 'processing') enqueue(song.id, t.id);
  }
})();

// ---------- uploads ----------
async function addTrackFile(sid, tmpFile, origName) {
  const tid = id(4), ext = path.extname(origName).toLowerCase();
  const file = tid + ext;
  await fsp.mkdir(path.join(songDir(sid), 'src'), { recursive: true });
  await fsp.rename(tmpFile, path.join(songDir(sid), 'src', file)).catch(async () => { await fsp.copyFile(tmpFile, path.join(songDir(sid), 'src', file)); await fsp.unlink(tmpFile); });
  const isRef = /\b(reference|ref ?mix|full ?mix|mixdown|master)\b/i.test(cleanName(origName));
  await withSong(sid, s => { s.tracks.push({ id: tid, name: cleanName(origName).slice(0, 40), orig: origName, file, role: isRef ? 'reference' : 'channel', mono: false, status: 'queued', channels: 0, duration: 0, sizes: {}, rev: 0 }); });
  enqueue(sid, tid);
}
async function handleUpload(req, res, sid, name) {
  if (!await getSong(sid)) return send(res, 404, { error: 'Song not found' });
  name = path.basename(String(name || 'track'));
  const ext = path.extname(name).toLowerCase();
  if (ext !== '.zip' && !AUDIO_EXT.has(ext)) return send(res, 400, { error: 'Not an audio file or zip: ' + name });
  const tmpDir = await fsp.mkdtemp(path.join(DATA, 'up-'));
  const tmp = path.join(tmpDir, 'upload' + ext);
  try {
    await new Promise((resolve, reject) => {
      let n = 0; const ws = fs.createWriteStream(tmp);
      req.on('data', c => { n += c.length; if (n > MAX_UPLOAD) { req.destroy(); ws.destroy(); reject(new Error('File is larger than the upload limit')); } });
      req.pipe(ws); ws.on('finish', resolve); ws.on('error', reject); req.on('error', reject); req.on('aborted', () => reject(new Error('Upload interrupted')));
    });
    if (ext === '.zip') {
      const ex = path.join(tmpDir, 'x');
      await fsp.mkdir(ex);
      await run('unzip', ['-j', '-o', '-qq', tmp, '-d', ex]).catch(e => { if (!fs.readdirSync(ex).length) throw e; });
      const files = (await fsp.readdir(ex)).filter(f => AUDIO_EXT.has(path.extname(f).toLowerCase()) && !f.startsWith('._')).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
      if (!files.length) throw new Error('No audio files in that zip');
      for (const f of files) await addTrackFile(sid, path.join(ex, f), f);
    } else await addTrackFile(sid, tmp, name);
    send(res, 200, await getSong(sid));
  } catch (e) { send(res, 400, { error: e.message }); }
  finally { fsp.rm(tmpDir, { recursive: true, force: true }).catch(() => {}); }
}


// ---------- settings (LiveVault connection) ----------
const getSettings = () => readJson(SETTINGS, {});
const vaultCfg = async () => (await getSettings()).vault || null;

// ---------- server plugins ----------
async function findVst3(dir, depth = 0) {
  const out = [];
  for (const e of await fsp.readdir(dir, { withFileTypes: true }).catch(() => [])) {
    if (!e.isDirectory() || e.name === '__MACOSX') continue;
    if (e.name.toLowerCase().endsWith('.vst3')) out.push(path.join(dir, e.name));
    else if (depth < 3) out.push(...await findVst3(path.join(dir, e.name), depth + 1));
  }
  return out;
}
async function handlePluginUpload(req, res, name) {
  name = path.basename(String(name || ''));
  if (path.extname(name).toLowerCase() !== '.zip') return send(res, 400, { error: 'Upload the plugin as a zip of its .vst3 folder' });
  const tmpDir = await fsp.mkdtemp(path.join(DATA, 'up-')), tmp = path.join(tmpDir, 'p.zip'), ex = path.join(tmpDir, 'x');
  try {
    await new Promise((resolve, reject) => {
      let n = 0; const ws = fs.createWriteStream(tmp);
      req.on('data', c => { n += c.length; if (n > 1024 * 1024 * 1024) { req.destroy(); ws.destroy(); reject(new Error('That zip is too large')); } });
      req.pipe(ws); ws.on('finish', resolve); ws.on('error', reject); req.on('error', reject); req.on('aborted', () => reject(new Error('Upload interrupted')));
    });
    await fsp.mkdir(ex);
    await run('unzip', ['-o', '-qq', tmp, '-d', ex]).catch(e => { if (!fs.readdirSync(ex).length) throw e; });
    const found = await findVst3(ex);
    if (!found.length) throw new Error('No .vst3 folder in that zip. A Linux VST3 plugin is a folder named Something.vst3; zip that folder and upload it.');
    const good = found.filter(f => fs.existsSync(path.join(f, 'Contents', ARCH + '-linux')));
    if (!good.length) throw new Error(`That is not a Linux build for this server. The plugin needs a Contents/${ARCH}-linux folder (Mac and Windows VST3 files cannot run here).`);
    for (const f of good) {
      const id = path.basename(f).replace(/[^\w .()+\-]/g, '_'), dest = path.join(vst.dir, id);
      await fsp.rm(dest, { recursive: true, force: true });
      await fsp.cp(f, dest, { recursive: true });
      await vst.probe(id);
    }
    send(res, 200, { host: { ...vst.info, arch: ARCH }, plugins: await vst.list() });
  } catch (e) { send(res, 400, { error: e.message }); }
  finally { fsp.rm(tmpDir, { recursive: true, force: true }).catch(() => {}); }
}

// ---------- media (Range support so browsers can resume, cached forever per revision) ----------
async function serveMedia(req, res, sid, tid, q) {
  const Q = QUALITIES[q];
  if (!Q || !okId(sid) || !okId(tid)) return send(res, 404, 'Not found');
  const f = path.join(songDir(sid), 't', tid + '.' + Q.ext);
  const st = await fsp.stat(f).catch(() => null);
  if (!st) return send(res, 404, 'Not found');
  const h = { 'Content-Type': Q.mime, 'Accept-Ranges': 'bytes', 'Cache-Control': 'public, max-age=31536000, immutable' };
  const m = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || '');
  if (m && (m[1] || m[2])) {
    let a = m[1] ? +m[1] : st.size - +m[2], b = m[1] && m[2] ? +m[2] : st.size - 1;
    a = Math.max(0, a); b = Math.min(st.size - 1, b);
    if (a > b) { res.writeHead(416, { 'Content-Range': `bytes */${st.size}` }); return res.end(); }
    res.writeHead(206, { ...h, 'Content-Range': `bytes ${a}-${b}/${st.size}`, 'Content-Length': b - a + 1 });
    return fs.createReadStream(f, { start: a, end: b }).pipe(res);
  }
  res.writeHead(200, { ...h, 'Content-Length': st.size });
  fs.createReadStream(f).pipe(res);
}

// ---------- static ----------
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json' };
async function serveStatic(req, res, p) {
  if (p === '/') p = '/index.html';
  const f = path.normalize(path.join(PUBLIC, p));
  if (!f.startsWith(PUBLIC + path.sep)) return send(res, 403, 'Forbidden');
  const buf = await fsp.readFile(f).catch(() => null);
  if (!buf) return send(res, 404, 'Not found');
  res.writeHead(200, { 'Content-Type': MIME[path.extname(f)] || 'application/octet-stream', 'Content-Length': buf.length, 'Cache-Control': 'no-cache' });
  res.end(buf);
}

// ---------- router ----------
async function handle(req, res) {
  const url = new URL(req.url, 'http://x');
  const p = decodeURIComponent(url.pathname), m = req.method;
  const seg = p.split('/').filter(Boolean);
  if (seg[0] === 'media' && seg[1] === 'vault' && m === 'GET') return vault.media(await vaultCfg(), req, res, seg[2], seg[3]);
  if (seg[0] === 'media' && (m === 'GET' || m === 'HEAD')) return serveMedia(req, res, seg[1], seg[2], seg[3]);
  if (seg[0] !== 'api') return m === 'GET' || m === 'HEAD' ? serveStatic(req, res, p) : send(res, 405, 'Method not allowed');

  if (seg[1] === 'state' && m === 'GET') return send(res, 200, { version: VERSION, songs: await listSongs(), busy: running + queue.length });
  if (seg[1] === 'settings') {
    const st = await getSettings(), pub = v => ({ vault: v ? { url: v.url, hasToken: !!v.token, insecure: !!v.insecure } : null });
    if (m === 'GET') return send(res, 200, pub(st.vault));
    if (m === 'PUT') {
      const b = await readBody(req);
      if (b.vault === null) delete st.vault;
      else if (b.vault) {
        const v = { url: String(b.vault.url || '').trim().replace(/\/+$/, ''), token: b.vault.token != null && b.vault.token !== '' ? String(b.vault.token) : (st.vault || {}).token || '', insecure: !!b.vault.insecure };
        if (!/^https?:\/\//.test(v.url)) return send(res, 400, { error: 'The LiveVault address must start with http:// or https://' });
        const info = await vault.json(v, 'GET', '/api/v1/info');
        if (info.name !== 'LiveVault') return send(res, 400, { error: 'That address answered, but it is not a LiveVault' });
        st.vault = v;
      }
      await writeJson(SETTINGS, st);
      return send(res, 200, pub(st.vault));
    }
  }
  if (seg[1] === 'vault' && seg[2] === 'sessions') {
    const cfg = await vaultCfg();
    if (seg.length === 3 && m === 'GET') return send(res, 200, await vault.json(cfg, 'GET', '/api/v1/sessions' + (url.searchParams.get('q') ? '?q=' + vault.enc(url.searchParams.get('q')) : '')));
    if (seg[4] === 'versions' && seg[5]) {
      if (seg.length === 6 && m === 'GET') return send(res, 200, await vault.song(cfg, seg[3], seg[5]));
      const mixPath = `/api/v1/sessions/${vault.enc(seg[3])}/versions/${vault.enc(seg[5])}/mixes/livewebmixer`;
      if (seg[6] === 'mix' && m === 'GET') return send(res, 200, await vault.json(cfg, 'GET', mixPath).catch(e => { if (e.code === 404) return { scenes: [], current: null }; throw e; }));
      if (seg[6] === 'mix' && m === 'PUT') { await vault.json(cfg, 'PUT', mixPath, await readBody(req)); return send(res, 200, { ok: true }); }
      if (seg[6] === 'recording' && m === 'PUT') return send(res, 200, await vault.upload(cfg, `/api/v1/sessions/${vault.enc(seg[3])}/versions/${vault.enc(seg[5])}/recordings?` + new URLSearchParams({ name: url.searchParams.get('name') || '', start: url.searchParams.get('start') || '0' }), req, 'audio/wav'));
    }
  }
  if (seg[1] === 'plugins') {
    if (seg.length === 2 && m === 'GET') { const info = await vst.start(); return send(res, 200, { host: { ...info, arch: ARCH }, plugins: await vst.list() }); }
    if (seg[2] === 'upload' && m === 'PUT') return handlePluginUpload(req, res, url.searchParams.get('name'));
    if (seg[2] && seg[3] === 'probe' && m === 'POST') { await vst.probe(seg[2]); return send(res, 200, { host: { ...vst.info, arch: ARCH }, plugins: await vst.list() }); }
    if (seg[2] && seg.length === 3 && m === 'DELETE') { await vst.remove(seg[2]); return send(res, 200, { host: { ...vst.info, arch: ARCH }, plugins: await vst.list() }); }
  }
  if (seg[1] === 'templates') {
    const f = path.join(DATA, 'templates.json');
    if (m === 'GET') return send(res, 200, await readJson(f, { templates: null }));
    if (m === 'PUT') { await writeJson(f, await readBody(req)); return send(res, 200, { ok: true }); }
  }
  if (seg[1] === 'songs') {
    if (seg.length === 2 && m === 'POST') {
      const b = await readBody(req), sid = id(4);
      await fsp.mkdir(songDir(sid), { recursive: true });
      const song = { id: sid, name: String(b.name || 'New song').slice(0, 80), created: Date.now(), tracks: [] };
      await writeJson(path.join(songDir(sid), 'song.json'), song);
      return send(res, 200, song);
    }
    const sid = seg[2];
    if (!okId(sid)) return send(res, 404, { error: 'Song not found' });
    if (seg.length === 3) {
      if (m === 'GET') { const s = await getSong(sid); return s ? send(res, 200, s) : send(res, 404, { error: 'Song not found' }); }
      if (m === 'PATCH') {
        const b = await readBody(req);
        return send(res, 200, await withSong(sid, s => {
          if (typeof b.name === 'string' && b.name.trim()) s.name = b.name.trim().slice(0, 80);
          if (Array.isArray(b.order)) s.tracks.sort((x, y) => b.order.indexOf(x.id) - b.order.indexOf(y.id));
        }));
      }
      if (m === 'DELETE') { await fsp.rm(songDir(sid), { recursive: true, force: true }); return send(res, 200, { ok: true }); }
    }
    if (seg[3] === 'upload' && m === 'PUT') return handleUpload(req, res, sid, url.searchParams.get('name'));
    if (seg[3] === 'mix') {
      const f = path.join(songDir(sid), 'mix.json');
      if (m === 'GET') return send(res, 200, await readJson(f, { scenes: [], current: null }));
      if (m === 'PUT') { if (!await getSong(sid)) return send(res, 404, { error: 'Song not found' }); await writeJson(f, await readBody(req)); return send(res, 200, { ok: true }); }
    }
    if (seg[3] === 'tracks' && okId(seg[4])) {
      const tid = seg[4];
      if (m === 'PATCH') {
        const b = await readBody(req); let redo = false;
        const song = await withSong(sid, s => {
          const t = s.tracks.find(t => t.id === tid); if (!t) throw Object.assign(new Error('Track not found'), { code: 404 });
          if (typeof b.name === 'string' && b.name.trim()) t.name = b.name.trim().slice(0, 40);
          if (['channel', 'reference', 'off'].includes(b.role)) t.role = b.role;
          if (typeof b.mono === 'boolean' && b.mono !== t.mono) { t.mono = b.mono; t.status = 'queued'; redo = true; }
        });
        if (redo) enqueue(sid, tid);
        return send(res, 200, song);
      }
      if (m === 'DELETE') {
        let file;
        const song = await withSong(sid, s => { const i = s.tracks.findIndex(t => t.id === tid); if (i < 0) return false; file = s.tracks[i].file; s.tracks.splice(i, 1); });
        if (file) fsp.rm(path.join(songDir(sid), 'src', file), { force: true }).catch(() => {});
        for (const q of Object.values(QUALITIES)) fsp.rm(path.join(songDir(sid), 't', tid + '.' + q.ext), { force: true }).catch(() => {});
        return send(res, 200, song);
      }
    }
  }
  send(res, 404, { error: 'Not found' });
}
const listener = (req, res) => handle(req, res).catch(e => { if (!res.headersSent) send(res, [400, 404, 502].includes(e.code) ? e.code : 500, { error: e.message }); else res.destroy(); });
// the plugin audio link is a WebSocket
const upgrade = (req, socket) => { if (req.url.split('?')[0] !== '/ws/vst') return socket.destroy(); const ws = wsLib.accept(req, socket); if (ws) vst.attach(ws); };

// ---------- start ----------
http.createServer(listener).on('upgrade', upgrade).listen(PORT, () => console.log(`LiveWebMixer ${VERSION}: http on ${PORT}`));

// Browsers only allow the low-latency audio engine (AudioWorklet) and MIDI on https or localhost,
// so the container also answers on https with its own self-signed certificate.
if (HTTPS_PORT) {
  try {
    const dir = path.join(DATA, 'tls'), key = path.join(dir, 'key.pem'), cert = path.join(dir, 'cert.pem');
    const useOwn = process.env.TLS_CERT && process.env.TLS_KEY;
    if (!useOwn && !(fs.existsSync(key) && fs.existsSync(cert))) {
      fs.mkdirSync(dir, { recursive: true });
      execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', cert, '-days', '3650', '-subj', '/CN=livewebmixer',
        '-addext', 'subjectAltName=DNS:livewebmixer,DNS:localhost,IP:127.0.0.1'], { stdio: 'ignore' });
    }
    https.createServer({ key: fs.readFileSync(useOwn ? process.env.TLS_KEY : key), cert: fs.readFileSync(useOwn ? process.env.TLS_CERT : cert) }, listener)
      .on('upgrade', upgrade).listen(HTTPS_PORT, () => console.log(`LiveWebMixer ${VERSION}: https on ${HTTPS_PORT}`));
  } catch (e) { console.error('https is off:', e.message); }
}
process.on('SIGTERM', () => { vst.stop(); process.exit(0); });
process.on('SIGINT', () => { vst.stop(); process.exit(0); });
