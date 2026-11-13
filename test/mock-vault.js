// A stand-in LiveVault for testing, and a small reference of docs/LIVEVAULT-API.md.
// It presents the songs in a LiveWebMixer data folder as LiveVault sessions:
//   node test/mock-vault.js <data folder> [port] [token]
'use strict';
const http = require('http'), fs = require('fs'), path = require('path');
const data = path.resolve(process.argv[2] || './data'), port = +(process.argv[3] || 8095), token = process.argv[4] || 'test-token';
const EXT = { flac: ['flac', 'audio/flac'], hi: ['hi.opus', 'audio/ogg'], lo: ['lo.opus', 'audio/ogg'] };
const mixes = new Map(), recordings = [];
const songs = () => fs.readdirSync(path.join(data, 'songs')).map(d => { try { return JSON.parse(fs.readFileSync(path.join(data, 'songs', d, 'song.json'), 'utf8')); } catch { return null; } }).filter(Boolean);
const json = (res, code, body) => { const b = Buffer.from(JSON.stringify(body)); res.writeHead(code, { 'Content-Type': 'application/json', 'Content-Length': b.length }); res.end(b); };
const VERSIONS = ['1.1.0', '1.0.0'];

http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x'), seg = url.pathname.split('/').filter(Boolean).map(decodeURIComponent);
  if (req.headers.authorization !== 'Bearer ' + token) return json(res, 401, { error: 'Missing or wrong access token' });
  if (seg[0] !== 'api' || seg[1] !== 'v1') return json(res, 404, { error: 'Not found' });
  if (seg[2] === 'info') return json(res, 200, { name: 'LiveVault', version: '0.0.0-mock', api: 1 });
  if (seg[2] === 'test-recordings') return json(res, 200, { recordings });
  if (seg[2] === 'sessions' && seg.length === 3) {
    const q = (url.searchParams.get('q') || '').toLowerCase();
    return json(res, 200, { sessions: songs().filter(s => s.name.toLowerCase().includes(q)).map(s => ({ id: s.id, name: s.name, latest: VERSIONS[0], versions: VERSIONS, tags: ['mock'], tracks: s.tracks.length, duration: Math.max(0, ...s.tracks.map(t => t.duration)) })) });
  }
  if (seg[2] === 'sessions' && seg[4] === 'versions' && VERSIONS.includes(seg[5])) {
    const s = songs().find(s => s.id === seg[3]);
    if (!s) return json(res, 404, { error: 'No such session' });
    if (seg.length === 6) {
      // version 1.0.0 pretends to be older: it is missing the last channel
      const tracks = s.tracks.filter(t => t.status === 'ready' && t.role !== 'off');
      const chans = tracks.filter(t => t.role === 'channel');
      const use = seg[5] === '1.0.0' ? tracks.filter(t => t !== chans[chans.length - 1]) : tracks;
      return json(res, 200, { id: s.id, name: s.name, version: seg[5], versions: VERSIONS, tags: ['mock'], notes: 'Served by the mock LiveVault.',
        tracks: use.map(t => ({ id: t.id, name: t.name, file: s.id + '.' + t.id, role: t.role, channels: t.channels, duration: t.duration, sizes: t.sizes })) });
    }
    if (seg[6] === 'recordings' && req.method === 'PUT') { let n = 0; req.on('data', d => n += d.length); req.on('end', () => { recordings.push({ session: seg[3], version: seg[5], name: url.searchParams.get('name'), start: +url.searchParams.get('start'), bytes: n }); json(res, 200, { id: 'r' + recordings.length }); }); return; }
    if (seg[6] === 'mixes' && seg[7] === 'livewebmixer') {
      const key = seg[3] + '@' + seg[5];
      if (req.method === 'GET') return mixes.has(key) ? json(res, 200, mixes.get(key)) : json(res, 404, { error: 'No mix saved yet' });
      if (req.method === 'PUT') { const c = []; req.on('data', d => c.push(d)); req.on('end', () => { mixes.set(key, JSON.parse(Buffer.concat(c).toString('utf8'))); json(res, 200, { ok: true }); }); return; }
    }
  }
  if (seg[2] === 'files' && EXT[seg[4]]) {
    const [sid, tid] = String(seg[3]).split('.');
    if (!/^[a-f0-9]+$/.test(sid || '') || !/^[a-f0-9]+$/.test(tid || '')) return json(res, 404, { error: 'No such file' });
    const f = path.join(data, 'songs', sid, 't', tid + '.' + EXT[seg[4]][0]);
    if (!fs.existsSync(f)) return json(res, 404, { error: 'No such file' });
    const size = fs.statSync(f).size, m = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range || '');
    const h = { 'Content-Type': EXT[seg[4]][1], 'Accept-Ranges': 'bytes' };
    if (m) { const a = +m[1], b = m[2] ? Math.min(+m[2], size - 1) : size - 1; res.writeHead(206, { ...h, 'Content-Range': `bytes ${a}-${b}/${size}`, 'Content-Length': b - a + 1 }); return fs.createReadStream(f, { start: a, end: b }).pipe(res); }
    res.writeHead(200, { ...h, 'Content-Length': size }); return fs.createReadStream(f).pipe(res);
  }
  json(res, 404, { error: 'Not found' });
}).listen(port, () => console.log('mock LiveVault on ' + port));
