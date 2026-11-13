// Talks to a LiveVault library on the mixer's behalf (see docs/LIVEVAULT-API.md).
// The browser never sees the LiveVault address or token: everything goes through this server.
'use strict';
const http = require('http');
const https = require('https');

function request(cfg, method, p, { headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    if (!cfg || !cfg.url) return reject(Object.assign(new Error('LiveVault is not connected'), { code: 400 }));
    let u;
    try { u = new URL(cfg.url.replace(/\/+$/, '') + p); } catch { return reject(Object.assign(new Error('The LiveVault address is not a valid URL'), { code: 400 })); }
    const data = body == null ? null : Buffer.from(JSON.stringify(body));
    const req = (u.protocol === 'https:' ? https : http).request(u, {
      method, timeout: 20000, rejectUnauthorized: !cfg.insecure,
      headers: { Accept: 'application/json', ...(cfg.token ? { Authorization: 'Bearer ' + cfg.token } : {}), ...(data ? { 'Content-Type': 'application/json', 'Content-Length': data.length } : {}), ...headers },
    }, resolve);
    req.on('timeout', () => req.destroy(new Error('LiveVault did not answer')));
    req.on('error', e => reject(Object.assign(new Error('Cannot reach LiveVault: ' + (e.code === 'DEPTH_ZERO_SELF_SIGNED_CERT' || e.code === 'SELF_SIGNED_CERT_IN_CHAIN' ? 'it uses a self-signed certificate (tick "Allow self-signed certificate")' : e.message)), { code: 502 })));
    req.end(data);
  });
}
async function json(cfg, method, p, body) {
  const res = await request(cfg, method, p, { body });
  const chunks = []; for await (const c of res) chunks.push(c);
  let j = null; try { j = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch {}
  if (res.statusCode === 401 || res.statusCode === 403) throw Object.assign(new Error('LiveVault refused the access token'), { code: 502 });
  if (res.statusCode >= 400 || j == null) throw Object.assign(new Error((j && j.error) || `LiveVault answered ${res.statusCode}`), { code: res.statusCode === 404 ? 404 : 502 });
  return j;
}
const enc = encodeURIComponent;

// A LiveVault session version, reshaped to look like one of the mixer's own songs.
async function song(cfg, sid, ver) {
  const v = await json(cfg, 'GET', `/api/v1/sessions/${enc(sid)}/versions/${enc(ver)}`);
  return {
    id: `vault:${sid}@${v.version}`, name: v.name, vault: { id: String(sid), version: v.version, versions: v.versions || [v.version], notes: v.notes || '', tags: v.tags || [] },
    tracks: (v.tracks || []).map(t => ({
      id: String(t.id), name: String(t.name || 'Track').slice(0, 40), file: String(t.file), role: t.role === 'reference' ? 'reference' : 'channel', status: 'ready',
      channels: t.channels > 1 ? 2 : 1, srcChannels: t.channels > 1 ? 2 : 1, duration: +t.duration || 0, rev: 0, mono: false,
      sizes: { flac: +((t.sizes || {}).flac) || 0, hi: +((t.sizes || {}).hi) || 0, lo: +((t.sizes || {}).lo) || 0 },
    })),
  };
}
// Pass an audio file through, keeping Range requests working.
async function media(cfg, req, res, file, q) {
  const up = await request(cfg, 'GET', `/api/v1/files/${enc(file)}/${enc(q)}`, { headers: { Accept: '*/*', ...(req.headers.range ? { Range: req.headers.range } : {}) } });
  const h = { 'Cache-Control': up.statusCode < 300 ? 'public, max-age=31536000, immutable' : 'no-store' };
  for (const k of ['content-type', 'content-length', 'content-range', 'accept-ranges']) if (up.headers[k]) h[k] = up.headers[k];
  res.writeHead(up.statusCode, h);
  up.pipe(res);
}
module.exports = { json, song, media, enc };
