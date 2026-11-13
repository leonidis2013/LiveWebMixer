// Smoke test: start the server on a temp folder, exercise the API, and check the browser files parse.
'use strict';
const { spawn, spawnSync } = require('child_process');
const fs = require('fs'), os = require('os'), path = require('path'), assert = require('assert');
const root = path.join(__dirname, '..'), data = fs.mkdtempSync(path.join(os.tmpdir(), 'lwm-')), port = 18000 + Math.floor(Math.random() * 1000);
const base = 'http://127.0.0.1:' + port;
const j = async (m, u, b) => { const r = await fetch(base + u, { method: m, headers: b ? { 'Content-Type': 'application/json' } : {}, body: b ? JSON.stringify(b) : undefined }); return { status: r.status, body: await r.json().catch(() => null) }; };
const hasFfmpeg = spawnSync('ffmpeg', ['-version']).status === 0;

(async () => {
  for (const f of ['server.js', 'lib/ws.js', 'lib/vault.js', 'lib/vsthost.js', 'public/js/worklets.js', 'public/js/vstworker.js']) assert.strictEqual(spawnSync(process.execPath, ['--check', path.join(root, f)]).status, 0, f + ' has a syntax error');
  for (const f of ['app.js', 'engine.js', 'model.js']) { const src = fs.readFileSync(path.join(root, 'public/js', f), 'utf8'); const t = path.join(data, f.replace('.js', '.mjs')); fs.writeFileSync(t, src); assert.strictEqual(spawnSync(process.execPath, ['--check', t]).status, 0, f + ' has a syntax error'); }
  const srv = spawn(process.execPath, [path.join(root, 'server.js')], { env: { ...process.env, DATA_DIR: data, PORT: port, HTTPS_PORT: '0' }, stdio: 'inherit' });
  try {
    for (let i = 0; i < 50; i++) { try { await fetch(base + '/api/state'); break; } catch { await new Promise(r => setTimeout(r, 100)); } }
    let r = await j('GET', '/api/state'); assert.strictEqual(r.status, 200); assert.deepStrictEqual(r.body.songs, []);
    assert.strictEqual((await fetch(base + '/')).status, 200);
    assert.strictEqual((await fetch(base + '/../server.js')).status, 404);
    r = await j('POST', '/api/songs', { name: 'Test' }); const sid = r.body.id; assert.ok(sid);
    r = await j('PUT', `/api/songs/${sid}/mix`, { scenes: [{ name: 'a', mixer: {} }], current: null }); assert.strictEqual(r.status, 200);
    r = await j('GET', `/api/songs/${sid}/mix`); assert.strictEqual(r.body.scenes[0].name, 'a');
    r = await fetch(`${base}/api/songs/${sid}/upload?name=notes.txt`, { method: 'PUT', body: 'x' }); assert.strictEqual(r.status, 400);
    if (hasFfmpeg) {
      const wav = path.join(data, 'in.wav');
      assert.strictEqual(spawnSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'sine=f=440:d=2', wav]).status, 0);
      r = await fetch(`${base}/api/songs/${sid}/upload?name=01_Lead_Vox.wav`, { method: 'PUT', body: fs.readFileSync(wav) }); assert.strictEqual(r.status, 200);
      let t;
      for (let i = 0; i < 100; i++) { t = (await j('GET', '/api/songs/' + sid)).body.tracks[0]; if (t.status === 'ready' || t.status === 'error') break; await new Promise(r => setTimeout(r, 100)); }
      assert.strictEqual(t.status, 'ready', t.error); assert.strictEqual(t.name, 'Lead Vox'); assert.strictEqual(t.channels, 1);
      for (const q of ['flac', 'hi', 'lo']) { const m = await fetch(`${base}/media/${sid}/${t.id}/${q}`, { headers: { Range: 'bytes=0-99' } }); assert.strictEqual(m.status, 206); assert.strictEqual((await m.arrayBuffer()).byteLength, 100); }
    } else console.log('ffmpeg not installed here: skipped the transcoding test');
    r = await j('GET', '/api/settings'); assert.strictEqual(r.body.vault, null);
    r = await j('GET', '/api/vault/sessions'); assert.strictEqual(r.status, 400);
    r = await j('PUT', '/api/settings', { vault: { url: 'ftp://x' } }); assert.strictEqual(r.status, 400);
    r = await j('GET', '/api/plugins'); assert.strictEqual(r.status, 200); assert.ok(Array.isArray(r.body.plugins));
    r = await j('DELETE', '/api/songs/' + sid); assert.strictEqual(r.status, 200);
    assert.strictEqual((await j('GET', '/api/songs/' + sid)).status, 404);
    console.log('ok');
  } finally { srv.kill(); fs.rmSync(data, { recursive: true, force: true }); }
})().catch(e => { console.error(e); process.exit(1); });
