// LiveWebMixer UI: setup window, three console layouts, selected-channel processing, scenes, MIDI.
import { NG, NA, NF, ND, OFF, clone, posToDb, dbToPos, fmtDb, SPECS, newBlock, DEFAULT_TEMPLATES, chainFrom, newMixer, overlay } from './model.js';
import { Engine } from './engine.js';

const $ = s => document.querySelector(s);
const ls = (k, v) => { try { if (v === undefined) return localStorage.getItem('lwm-' + k); localStorage.setItem('lwm-' + k, v); } catch {} return null; };
function h(tag, attrs, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k.startsWith('on')) el[k] = v; else if (k === 'class') el.className = v; else if (k in el && k !== 'list') el[k] = v; else el.setAttribute(k, v);
  }
  for (const k of kids.flat()) if (k != null && k !== false) el.append(k);
  return el;
}
const fill = (el, ...kids) => el.replaceChildren(...kids.flat().filter(k => k != null && k !== false));
async function api(method, url, body) {
  const r = await fetch(url, { method, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || r.statusText);
  return j;
}
const fmtTime = s => { s = Math.max(0, s); return Math.floor(s / 60) + ':' + String(Math.floor(s % 60)).padStart(2, '0'); };
const fmtMB = b => b >= 1e9 ? (b / 1e9).toFixed(1) + ' GB' : (b / 1e6).toFixed(b < 1e7 ? 1 : 0) + ' MB';
const fmtNum = v => Math.abs(v) >= 10000 ? (v / 1000).toFixed(1) + 'k' : Math.abs(v) >= 1000 ? (v / 1000).toFixed(2) + 'k' : Math.abs(v) >= 100 ? v.toFixed(0) : Math.abs(v) >= 10 ? v.toFixed(1) : v.toFixed(2);
const AUX = Array.from({ length: NA }, (_, i) => 'a' + (i + 1)), FXS = Array.from({ length: NF }, (_, i) => 'f' + (i + 1));
const QN = { flac: 'Lossless', hi: 'High', lo: 'Low' };

const E = new Engine();
const S = { songs: [], song: null, templates: clone(DEFAULT_TEMPLATES), mix: { scenes: [], current: null }, m: null, page: 'setup',
  view: ls('view') || 'sq', layer: 0, sof: 'main', sel: null, quality: ls('quality') || 'hi', tpl: ls('tpl') || 'auto', popup: null, loop: { a: null, b: null, on: false }, msg: '', up: '',
  plugins: { host: { ok: false }, plugins: [] }, settings: { vault: null }, vault: { list: null, q: '', err: '' } };
E.vstDelayMs = +ls('vstDelay') || 250;
const blkLabel = b => b.type === 'vst' ? (b.p.name || 'Plugin') : SPECS[b.type].label;
const blkLong = b => b.type === 'vst' ? (b.p.name || 'Server plugin') : SPECS[b.type].long;
const mediaUrl = t => S.song.vault ? `/media/vault/${encodeURIComponent(t.file)}/${S.quality}` : `/media/${S.song.id}/${t.id}/${S.quality}?r=${t.rev}`;
const mixUrl = () => S.song.vault ? `/api/vault/sessions/${encodeURIComponent(S.song.vault.id)}/versions/${encodeURIComponent(S.song.vault.version)}/mix` : `/api/songs/${S.song.id}/mix`;
let meters = [], faders = new Map(), tUI = {};

// =====================================================================================
// Setup window
// =====================================================================================
async function refreshSongs() { const st = await api('GET', '/api/state'); S.songs = st.songs; $('#hVer').textContent = 'v' + st.version; }
async function selectSong(id) { S.song = id ? await api('GET', '/api/songs/' + id) : null; ls('song', id || ''); renderSetup(); pollSong(); }
let pollT = 0;
function pollSong() {
  clearTimeout(pollT);
  if (S.page !== 'setup' || !S.song || S.song.vault || !S.song.tracks.some(t => t.status === 'queued' || t.status === 'processing')) return;
  pollT = setTimeout(async () => { try { S.song = await api('GET', '/api/songs/' + S.song.id); renderSetup(); } catch {} pollSong(); }, 1500);
}
const act = async fn => { try { S.msg = ''; await fn(); } catch (e) { S.msg = e.message; } renderSetup(); pollSong(); };

function uploadFiles(files) {
  const list = [...files], sid = S.song.id;
  act(async () => {
    for (let i = 0; i < list.length; i++) {
      await new Promise((resolve, reject) => {
        const x = new XMLHttpRequest();
        x.open('PUT', `/api/songs/${sid}/upload?name=${encodeURIComponent(list[i].name)}`);
        x.upload.onprogress = e => { S.up = `Uploading ${i + 1} of ${list.length}: ${list[i].name} (${Math.round(e.loaded / e.total * 100)}%)`; const el = $('#upTxt'); if (el) el.textContent = S.up; };
        x.onload = () => { if (x.status === 200) { S.song = JSON.parse(x.responseText); resolve(); } else reject(new Error((JSON.parse(x.responseText || '{}').error) || 'Upload failed')); };
        x.onerror = () => reject(new Error('Upload failed: connection lost'));
        x.send(list[i]);
      }).finally(() => { S.up = ''; });
      renderSetup();
    }
    await refreshSongs();
  });
}

function renderSetup() {
  const root = $('#setup'); root.replaceChildren();
  // songs
  const nameIn = h('input', { type: 'text', placeholder: 'New song name', class: 'grow' });
  const add = () => nameIn.value.trim() && act(async () => { const s = await api('POST', '/api/songs', { name: nameIn.value.trim() }); await refreshSongs(); S.song = s; ls('song', s.id); });
  nameIn.onkeydown = e => { if (e.key === 'Enter') add(); };   // a handler that returns false would cancel every key
  root.append(h('div', { class: 'card songs' }, h('h2', {}, 'Songs'),
    S.songs.map(s => h('button', { class: 'song' + (S.song && S.song.id === s.id ? ' on' : ''), onclick: () => selectSong(s.id) }, s.name, h('small', {}, s.tracks + ' tracks'))),
    !S.songs.length && h('div', { class: 'note', style: 'margin-bottom:8px' }, 'No songs yet. Name one to start.'),
    h('div', { class: 'row', style: 'margin-top:8px' }, nameIn, h('button', { class: 'on', onclick: add }, 'Add'))));

  const left = h('div', { style: 'display:flex;flex-direction:column;gap:12px;min-width:0' }, root.firstChild, vaultCard());
  const right = h('div', { style: 'display:flex;flex-direction:column;gap:12px;min-width:0' });
  root.append(left, right);
  if (S.msg) right.append(h('div', { class: 'errbox' }, S.msg));
  if (!Engine.supported()) right.append(h('div', { class: 'errbox' }, 'This page is open over plain http, and browsers only allow the low-latency audio engine on https. Open LiveWebMixer at https://',
    location.hostname, ':8443 (accept the certificate warning once), or put it behind your reverse proxy.'));
  const song = S.song;
  if (!song) { right.append(h('div', { class: 'card note' }, 'Pick a song on the left, or add one, then load its tracks here.')); renderTemplates(right); return renderPlugins(right); }
  if (song.vault) { right.append(vaultSongCard(song)); renderTemplates(right); return renderPlugins(right); }

  const ready = song.tracks.filter(t => t.status === 'ready'), chans = ready.filter(t => t.role === 'channel');
  const busy = song.tracks.some(t => t.status === 'queued' || t.status === 'processing');
  const total = q => ready.filter(t => t.role !== 'off').reduce((n, t) => n + (t.sizes[q] || 0), 0);
  const mem = ready.filter(t => t.role !== 'off').reduce((n, t) => n + t.duration * 48000 * 2 * t.channels, 0);
  const songName = h('input', { type: 'text', value: song.name, class: 'grow', onchange: () => act(async () => { S.song = await api('PATCH', '/api/songs/' + song.id, { name: songName.value }); await refreshSongs(); }) });
  const file = h('input', { type: 'file', multiple: true, accept: 'audio/*,.zip,.wav,.aif,.aiff,.flac,.mp3,.m4a,.ogg,.opus', class: 'hide', onchange: () => file.files.length && uploadFiles(file.files) });
  const drop = h('div', { class: 'drop', onclick: () => file.click() }, h('b', {}, 'Drop the multitrack files here'), h('div', { class: 'note', id: 'upTxt' }, S.up || 'or click to choose. WAV, AIFF, FLAC, MP3, M4A, or one zip of the whole song. Each track becomes a mixer channel.'));
  drop.ondragover = e => { e.preventDefault(); drop.classList.add('over'); };
  drop.ondragleave = () => drop.classList.remove('over');
  drop.ondrop = e => { e.preventDefault(); drop.classList.remove('over'); e.dataTransfer.files.length && uploadFiles(e.dataTransfer.files); };
  let delArmed = false;
  const del = h('button', { class: 'danger', onclick: () => { if (!delArmed) { delArmed = true; del.textContent = 'Really delete this song?'; return; } act(async () => { await api('DELETE', '/api/songs/' + song.id); S.song = null; ls('song', ''); await refreshSongs(); }); } }, 'Delete song');

  const patchT = (t, body) => act(async () => { S.song = await api('PATCH', `/api/songs/${song.id}/tracks/${t.id}`, body); });
  const move = (i, d) => { const ids = song.tracks.map(t => t.id); const j = i + d; if (j < 0 || j >= ids.length) return; [ids[i], ids[j]] = [ids[j], ids[i]]; act(async () => { S.song = await api('PATCH', '/api/songs/' + song.id, { order: ids }); }); };
  let chNo = 0;
  const rows = song.tracks.map((t, i) => h('tr', {},
    h('td', { class: 'num' }, t.role === 'channel' ? String(++chNo) : t.role === 'reference' ? 'REF' : '–'),
    h('td', {}, h('button', { class: 'sm', onclick: () => move(i, -1), disabled: i === 0 }, '▲'), ' ', h('button', { class: 'sm', onclick: () => move(i, 1), disabled: i === song.tracks.length - 1 }, '▼')),
    h('td', { style: 'width:40%' }, (() => { const n = h('input', { type: 'text', value: t.name, onchange: () => patchT(t, { name: n.value }) }); return n; })()),
    h('td', { class: 'num' }, t.status === 'ready' ? `${t.channels > 1 ? 'Stereo' : 'Mono'} · ${fmtTime(t.duration)}` : ''),
    h('td', {}, t.srcChannels > 1 && h('label', { class: 'row note', title: 'Fold a stereo file down to one channel (halves its size and memory)' }, h('input', { type: 'checkbox', checked: t.mono, onchange: e => patchT(t, { mono: e.target.checked }) }), 'Mono')),
    h('td', {}, (() => { const s = h('select', { class: 'sm', onchange: () => patchT(t, { role: s.value }) }, [['channel', 'Mixer channel'], ['reference', 'Reference mix'], ['off', 'Not used']].map(([v, l]) => h('option', { value: v, selected: t.role === v }, l))); return s; })()),
    h('td', { class: 'num' }, t.status === 'ready' ? fmtMB(t.sizes[S.quality] || 0) : t.status === 'error' ? h('span', { style: 'color:var(--bad)', title: t.error }, 'Failed: ' + t.error.slice(0, 40)) : t.status === 'processing' ? 'Converting…' : 'Waiting…'),
    h('td', {}, h('button', { class: 'sm danger', title: 'Remove track', onclick: () => act(async () => { S.song = await api('DELETE', `/api/songs/${song.id}/tracks/${t.id}`); await refreshSongs(); }) }, '✕'))));

  const tplSel = h('select', { onchange: () => { S.tpl = tplSel.value; ls('tpl', S.tpl); } }, h('option', { value: 'auto', selected: S.tpl === 'auto' }, 'Auto, by track name'), S.templates.map(t => h('option', { value: t.name, selected: S.tpl === t.name }, t.name)));
  const qSeg = h('div', { class: 'seg' }, Object.keys(QN).map(q => h('button', { class: S.quality === q ? 'on' : '', onclick: () => { S.quality = q; ls('quality', q); renderSetup(); } }, `${QN[q]} · ${fmtMB(total(q))}`)));
  right.append(h('div', { class: 'card' }, h('h2', {}, 'Tracks'), h('div', { class: 'row' }, songName, del), file, drop,
    h('div', { class: 'row', style: 'margin-bottom:8px' },
      h('span', { class: 'note' }, 'Channel template'), tplSel, h('span', { class: 'note' }, 'Audio quality'), qSeg, h('span', { class: 'grow' }),
      h('button', { class: 'on', disabled: !chans.length || busy || !Engine.supported(), onclick: openMixer }, busy ? 'Converting tracks…' : `Open mixer (${chans.length} channels)`)),
    ready.length ? h('div', { class: 'note', style: 'margin:0 0 10px' }, `Tracks download once at the chosen quality and stay cached in this browser. Loaded, this song uses about ${fmtMB(mem)} of memory.`,
      S.quality === 'flac' ? ' Lossless is best on your own network.' : ' High and Low are Opus, sized for remote connections.') : null,
    song.tracks.length ? h('div', { style: 'overflow-x:auto' }, h('table', { class: 'tr' }, h('thead', {}, h('tr', {}, ['Ch', '', 'Name', 'Format', '', 'Use as', 'Download', ''].map(x => h('th', {}, x)))), h('tbody', {}, rows))) : null));
  renderTemplates(right); renderPlugins(right);
}

function renderTemplates(root) {
  const save = () => api('PUT', '/api/templates', { templates: S.templates }).catch(e => { S.msg = e.message; });
  root.append(h('div', { class: 'card' }, h('h2', {}, 'Channel templates'),
    h('div', { class: 'note', style: 'margin-bottom:6px' }, 'A template is the signal flow a new channel starts with. With "Auto", a track whose name contains one of the words gets that template; anything else gets the first one. Save new templates from a channel in the mixer.'),
    S.templates.map((t, i) => {
      const m = h('input', { type: 'text', class: 'sm', value: t.match || '', placeholder: 'words in the track name, comma separated', onchange: () => { t.match = m.value; save(); } });
      return h('div', { class: 'tpl' }, h('b', {}, t.name), m,
        h('div', { class: 'chips' }, t.chain.length ? t.chain.map(b => h('span', { class: 'chip' + (b.on === false ? ' off' : '') }, blkLabel(b))) : h('span', { class: 'note' }, 'no processing')),
        h('button', { class: 'sm danger', disabled: S.templates.length < 2, onclick: () => { S.templates.splice(i, 1); save(); renderSetup(); } }, '✕'));
    })));
}

// ---- LiveVault (the multitrack library) ----
async function loadVaultList() {
  if (!S.settings.vault) return;
  try { S.vault.list = (await api('GET', '/api/vault/sessions' + (S.vault.q ? '?q=' + encodeURIComponent(S.vault.q) : ''))).sessions || []; S.vault.err = ''; }
  catch (e) { S.vault.list = null; S.vault.err = e.message; }
}
const openVault = (id, ver) => act(async () => { S.song = await api('GET', `/api/vault/sessions/${encodeURIComponent(id)}/versions/${encodeURIComponent(ver)}`); ls('song', ''); });
function vaultCard() {
  const v = S.settings.vault, card = h('div', { class: 'card songs' }, h('h2', {}, 'LiveVault library'));
  if (!v || S.vault.edit) {
    const url = h('input', { type: 'text', placeholder: 'https://livevault address', value: v ? v.url : '' }), tok = h('input', { type: 'password', placeholder: v && v.hasToken ? 'Access token (unchanged)' : 'Access token' });
    const ins = h('input', { type: 'checkbox', checked: v ? v.insecure : false });
    card.append(h('div', { class: 'note', style: 'margin-bottom:8px' }, 'Connect to your LiveVault to open its sessions here without copying them. Mixes and scenes are saved back to the session version.'),
      h('div', { style: 'display:flex;flex-direction:column;gap:6px' }, url, tok, h('label', { class: 'row note' }, ins, 'Allow self-signed certificate'),
        h('div', { class: 'row' }, h('button', { class: 'on', onclick: () => act(async () => { S.settings = await api('PUT', '/api/settings', { vault: { url: url.value, token: tok.value, insecure: ins.checked } }); S.vault.edit = false; await loadVaultList(); }) }, 'Connect'),
          v && h('button', { onclick: () => { S.vault.edit = false; renderSetup(); } }, 'Cancel'),
          v && h('button', { class: 'danger', onclick: () => act(async () => { S.settings = await api('PUT', '/api/settings', { vault: null }); S.vault = { list: null, q: '', err: '' }; if (S.song && S.song.vault) S.song = null; }) }, 'Disconnect'))));
    return card;
  }
  const q = h('input', { type: 'text', class: 'grow', placeholder: 'Search sessions', value: S.vault.q, onchange: () => { S.vault.q = q.value; act(loadVaultList); } });
  card.append(h('div', { class: 'row', style: 'margin-bottom:8px' }, q, h('button', { class: 'sm', title: 'LiveVault connection', onclick: () => { S.vault.edit = true; renderSetup(); } }, 'Connection')));
  if (S.vault.err) card.append(h('div', { class: 'errbox' }, S.vault.err));
  else if (!S.vault.list) card.append(h('div', { class: 'note' }, 'Loading…'));
  else if (!S.vault.list.length) card.append(h('div', { class: 'note' }, S.vault.q ? 'No sessions match.' : 'The library has no sessions yet.'));
  else card.append(...S.vault.list.map(x => h('button', { class: 'song' + (S.song && S.song.vault && S.song.vault.id === String(x.id) ? ' on' : ''), onclick: () => openVault(x.id, x.latest) }, x.name, h('small', {}, 'v' + x.latest))));
  return card;
}
function vaultSongCard(song) {
  const v = song.vault, chans = song.tracks.filter(t => t.role === 'channel');
  const total = q => song.tracks.reduce((n, t) => n + (t.sizes[q] || 0), 0), mem = song.tracks.reduce((n, t) => n + t.duration * 48000 * 2 * t.channels, 0);
  const ver = h('select', { onchange: () => openVault(v.id, ver.value) }, v.versions.map(x => h('option', { value: x, selected: x === v.version }, 'Version ' + x)));
  const tplSel = h('select', { onchange: () => { S.tpl = tplSel.value; ls('tpl', S.tpl); } }, h('option', { value: 'auto', selected: S.tpl === 'auto' }, 'Auto, by track name'), S.templates.map(t => h('option', { value: t.name, selected: S.tpl === t.name }, t.name)));
  const qSeg = h('div', { class: 'seg' }, Object.keys(QN).map(q => h('button', { class: S.quality === q ? 'on' : '', onclick: () => { S.quality = q; ls('quality', q); renderSetup(); } }, `${QN[q]} · ${fmtMB(total(q))}`)));
  let n = 0;
  return h('div', { class: 'card' }, h('h2', {}, 'LiveVault session'),
    h('div', { class: 'row', style: 'margin-bottom:8px' }, h('b', { class: 'grow', style: 'font-size:16px' }, song.name), ver),
    (v.tags.length || v.notes) ? h('div', { class: 'note', style: 'margin-bottom:10px' }, h('div', { class: 'chips', style: 'margin-bottom:4px' }, v.tags.map(t => h('span', { class: 'chip' }, t))), v.notes) : null,
    h('div', { class: 'row', style: 'margin-bottom:8px' }, h('span', { class: 'note' }, 'Channel template'), tplSel, h('span', { class: 'note' }, 'Audio quality'), qSeg, h('span', { class: 'grow' }),
      h('button', { class: 'on', disabled: !chans.length || !Engine.supported(), onclick: openMixer }, `Open mixer (${chans.length} channels)`)),
    h('div', { class: 'note', style: 'margin:0 0 10px' }, `Tracks play straight from LiveVault and stay cached in this browser. Mixes and scenes are saved to version ${v.version} in LiveVault. Loaded, this session uses about ${fmtMB(mem)} of memory. To change the tracks, make a new version in LiveVault.`),
    h('div', { style: 'overflow-x:auto' }, h('table', { class: 'tr' }, h('thead', {}, h('tr', {}, ['Ch', 'Name', 'Format', 'Use as', 'Download'].map(x => h('th', {}, x)))),
      h('tbody', {}, song.tracks.map(t => h('tr', {}, h('td', { class: 'num' }, t.role === 'channel' ? String(++n) : 'REF'), h('td', { style: 'width:50%' }, t.name), h('td', { class: 'num' }, `${t.channels > 1 ? 'Stereo' : 'Mono'} · ${fmtTime(t.duration)}`),
        h('td', { class: 'num' }, t.role === 'channel' ? 'Mixer channel' : 'Reference mix'), h('td', { class: 'num' }, fmtMB(t.sizes[S.quality] || 0))))))));
}

// ---- server plugins ----
function renderPlugins(root) {
  const P = S.plugins, host = P.host || {};
  const file = h('input', { type: 'file', accept: '.zip', class: 'hide', onchange: () => { if (!file.files.length) return; const f = file.files[0]; S.up = 'Uploading and checking ' + f.name + '…'; renderSetup();
    act(async () => { try { const r = await fetch('/api/plugins/upload?name=' + encodeURIComponent(f.name), { method: 'PUT', body: f }); const j = await r.json(); if (!r.ok) throw new Error(j.error); S.plugins = j; } finally { S.up = ''; } }); } });
  const dSeg = h('div', { class: 'seg' }, [150, 250, 400, 600].map(ms => h('button', { class: E.vstDelayMs === ms ? 'on' : '', onclick: () => { E.vstDelayMs = ms; ls('vstDelay', ms); renderSetup(); } }, ms + ' ms')));
  root.append(h('div', { class: 'card' }, h('h2', {}, 'Server plugins (VST3)'),
    h('div', { class: 'note', style: 'margin-bottom:8px' }, `Browsers cannot run VST plugins, so these run on the server: a channel that uses one sends its audio there and back. Only Linux VST3 builds for this server's processor (${host.arch || '?'}) will load; Mac and Windows plugin files will not. Plugins are adjusted with sliders in the mixer, without their own window.`),
    !host.ok ? h('div', { class: 'errbox' }, 'The plugin host is not running' + (host.error ? ': ' + host.error : '.')) : null,
    P.plugins.map(p => h('div', { class: 'tpl', style: 'grid-template-columns:1fr auto auto' }, h('div', {}, h('b', {}, p.id.replace(/\.vst3$/i, '')), h('div', { class: 'note', style: p.error ? 'color:var(--bad)' : '' }, p.error ? 'Did not load: ' + p.error : p.plugins.length > 4 ? `${p.plugins.length} plugins: ${p.plugins.slice(0, 4).map(x => x.name).join(', ')}…` : p.plugins.map(x => (x.name || 'plugin') + (x.params != null ? ` · ${x.params} parameters` : '')).join(', '))),
      p.error ? h('button', { class: 'sm', onclick: () => act(async () => { S.plugins = await api('POST', `/api/plugins/${encodeURIComponent(p.id)}/probe`); }) }, 'Retry') : h('span'),
      h('button', { class: 'sm danger', onclick: () => act(async () => { S.plugins = await api('DELETE', '/api/plugins/' + encodeURIComponent(p.id)); }) }, '✕'))),
    file, h('div', { class: 'row', style: 'margin-top:10px' }, h('button', { disabled: !host.ok || !!S.up, onclick: () => file.click() }, 'Upload plugin (.zip of its .vst3 folder)'), h('span', { class: 'note grow' }, S.up && S.up.startsWith('Uploading and') ? S.up : ''),
      h('span', { class: 'note', title: 'How long plugin audio may take to go to the server and back. Raise it if a plugin channel reports late audio (slow or remote connections).' }, 'Round trip'), dSeg)));
}

// =====================================================================================
// Opening the mixer
// =====================================================================================
const chanTracks = () => S.song.tracks.filter(t => t.status === 'ready' && t.role === 'channel');
function freshMixer(saved) { return overlay(newMixer(chanTracks(), S.templates, S.tpl), saved); }
function buildEngine() {
  const chans = chanTracks(), ref = S.song.tracks.find(t => t.status === 'ready' && t.role === 'reference');
  E.build(S.m, chans.map((t, i) => ({ id: 'in' + t.id, out: i })), ref ? chans.length : -1);
}
async function openMixer() {
  const chans = chanTracks(), ref = S.song.tracks.find(t => t.status === 'ready' && t.role === 'reference');
  const list = ref ? [...chans, ref] : chans;
  $('#load').classList.remove('hide');
  const setLoad = (f, txt) => { $('#loadBar').style.width = f * 100 + '%'; $('#loadTxt').textContent = txt; };
  setLoad(0, 'Starting the audio engine…');
  try {
    await E.start(list.map(t => t.channels > 1 ? 2 : 1));
    let done = 0, bytes = 0, fromCache = 0, next = 0;
    const worker = async () => {
      while (next < list.length) {
        const i = next++, t = list[i];
        await E.loadTrack(i, mediaUrl(t), (n, cached) => { if (cached) fromCache++; else bytes += n; });
        done++; setLoad(done / list.length, `${done} of ${list.length} tracks · ${fmtMB(bytes)} downloaded` + (fromCache ? ` · ${fromCache} from cache` : ''));
      }
    };
    await Promise.all([worker(), worker(), worker()]);
    S.mix = await api('GET', mixUrl()); if (!S.mix || !Array.isArray(S.mix.scenes)) S.mix = { scenes: [], current: null };
    S.m = freshMixer(S.mix.current);
    buildEngine();
    E.onstate = () => {};
    S.sel = S.m.inputs[0]; S.layer = 0; S.sof = 'main'; S.loop = { a: null, b: null, on: false }; S.hasRef = !!ref;
    showPage('mixer');
  } catch (e) { S.msg = 'Could not open the mixer: ' + e.message; renderSetup(); }
  $('#load').classList.add('hide');
}
function showPage(p) {
  S.page = p;
  if (p === 'setup' && E.ctx) { E.pause(); closePopup(); }
  $('#setup').classList.toggle('hide', p !== 'setup'); $('#mixer').classList.toggle('hide', p !== 'mixer');
  for (const id of ['#viewSeg', '#scBtn', '#midiBtn', '#setupBtn']) $(id).classList.toggle('hide', p !== 'mixer');
  $('#hSub').textContent = p === 'mixer' ? S.song.name : 'Mix training console';
  $('#status').replaceChildren();
  if (p === 'mixer') { renderTransport(); renderMixer(); } else { renderSetup(); pollSong(); }
}
let saveT = 0;
function dirty() { clearTimeout(saveT); saveT = setTimeout(saveMix, 1500); }
function saveMix() { clearTimeout(saveT); if (!S.m || !S.song) return; S.mix.current = clone(S.m); api('PUT', mixUrl(), S.mix).catch(() => {}); }

// =====================================================================================
// Transport bar
// =====================================================================================
function renderTransport() {
  const bar = $('#tbar'); bar.replaceChildren();
  const play = h('button', { class: 'on', style: 'min-width:64px', onclick: () => E.playing ? E.pause() : E.play() }, 'Play');
  const time = h('span', { class: 'time' });
  const seek = h('input', { type: 'range', class: 'seek', min: 0, max: Math.max(1, E.duration), step: 0.05, value: 0 });
  let drag = false;
  seek.oninput = () => { drag = true; E.seek(+seek.value); }; seek.onchange = () => { drag = false; };
  const lp = S.loop, applyLoop = () => { if (lp.on && lp.a != null && lp.b != null && lp.b > lp.a) E.setLoop(lp.a, lp.b); else E.setLoop(null); upd(); };
  const bA = h('button', { class: 'sm', title: 'Loop start = current position', onclick: () => { lp.a = E.time; applyLoop(); } });
  const bB = h('button', { class: 'sm', title: 'Loop end = current position', onclick: () => { lp.b = E.time; applyLoop(); } });
  const bL = h('button', { class: 'sm', onclick: () => { lp.on = !lp.on; applyLoop(); } }, 'Loop');
  const upd = () => { bA.textContent = 'A ' + (lp.a == null ? '–' : fmtTime(lp.a)); bB.textContent = 'B ' + (lp.b == null ? '–' : fmtTime(lp.b)); bL.classList.toggle('on', lp.on); };
  upd();
  const mon = h('select', { class: 'sm', onchange: () => { S.m.monitor = mon.value; E.monitor(); dirty(); syncRef(); } }, [['main', 'Main LR'], ...AUX.map(a => [a, S.m.strips[a].name])].map(([v, l]) => h('option', { value: v }, l)));
  const ref = h('button', { class: 'sm', disabled: !S.hasRef, title: S.hasRef ? 'Switch between your mix and the reference mix' : 'Mark a track as "Reference mix" in Setup to compare against it',
    onclick: () => { if (S.m.monitor === 'ref') S.m.monitor = S.prevMon || 'main'; else { S.prevMon = S.m.monitor; S.m.monitor = 'ref'; } E.monitor(); syncRef(); } }, 'Reference A/B');
  const refTrim = h('input', { type: 'range', min: -18, max: 6, step: 0.5, value: S.m.refTrim, style: 'width:70px', title: 'Reference level (match it to your mix)', disabled: !S.hasRef, oninput: () => { S.m.refTrim = +refTrim.value; E.monitor(); dirty(); } });
  const syncRef = () => { ref.classList.toggle('on', S.m.monitor === 'ref'); ref.textContent = S.m.monitor === 'ref' ? 'Hearing: reference' : 'Reference A/B'; if (S.m.monitor !== 'ref') mon.value = S.m.monitor; };
  const pflClr = h('button', { class: 'sm pfl hide', onclick: () => { for (const s of Object.values(S.m.strips)) s.pfl = false; E.updateAll(); renderMixer(); } }, 'Clear PFL');
  const lat = h('span', { class: 'st' });
  const rec = h('button', { class: 'sm rec', title: 'Record the Main LR mix while the song plays. Pause or move the play position to end the take.', onclick: () => E.recording ? endTake() : startTake() }, '● Record');
  bar.append(play, h('button', { class: 'sm', title: 'Back to start', onclick: () => E.seek(lp.on && lp.a != null ? lp.a : 0) }, '⏮'), time, seek, bA, bB, bL, h('span', { class: 'sep' }),
    h('label', {}, 'Listen'), mon, ref, refTrim, pflClr, h('span', { class: 'sep' }), rec, lat);
  syncRef();
  tUI = { tick() {
    play.textContent = E.playing ? 'Pause' : 'Play';
    time.textContent = fmtTime(E.time) + ' / ' + fmtTime(E.duration);
    if (!drag) seek.value = E.time;
    pflClr.classList.toggle('hide', !Object.values(S.m.strips).some(s => s.pfl));
    lat.textContent = `${QN[S.quality]} · ${E.latencyMs.toFixed(0)} ms output`;
    rec.classList.toggle('on', E.recording); rec.textContent = E.recording ? `■ Stop take ${fmtTime(E.time - (take.pos || 0))}` : '● Record';
  } };
}

// =====================================================================================
// Recording the Main LR mix (download it, or keep it in LiveVault for review)
// =====================================================================================
const take = { start: 0, pos: 0, sawPlay: false, busy: false };
function startTake() {
  if (E.recording || take.busy) return;
  if (S.loop.on) { S.loop.on = false; E.setLoop(null); renderTransport(); }     // a take is one straight pass, so it lines up with the song
  take.pos = E.time; take.start = Math.max(0, E.time - E.mainLatency); take.sawPlay = false;   // the take's first sample is what Main LR played at that point in the song
  E.recStart(); if (!E.playing) E.play();
}
async function endTake() {
  if (!E.recording || take.busy) return;
  take.busy = true;
  const t = await E.recStop();
  take.busy = false;
  if (E.playing) E.pause();
  if (t && t.frames > 48000 * 0.5) takeDialog(t, take.start);
}
// The take ends when playback stops or jumps (pause, seek, end of song, back to start).
function watchTake() { if (!E.recording || take.busy) return; if (E.playing) take.sawPlay = true; else if (take.sawPlay) endTake(); }
const _seek = E.seek.bind(E); E.seek = sec => { if (E.recording) endTake(); _seek(sec); };
function wavBlob(t) {
  const n = t.frames, buf = new ArrayBuffer(44 + n * 4), v = new DataView(buf);
  const w = (o, str) => { for (let i = 0; i < str.length; i++) v.setUint8(o + i, str.charCodeAt(i)); };
  w(0, 'RIFF'); v.setUint32(4, 36 + n * 4, true); w(8, 'WAVE'); w(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 2, true);
  v.setUint32(24, 48000, true); v.setUint32(28, 48000 * 4, true); v.setUint16(32, 4, true); v.setUint16(34, 16, true); w(36, 'data'); v.setUint32(40, n * 4, true);
  const out = new Int16Array(buf, 44); let k = 0;
  for (let b = 0; b < t.L.length; b++) { const L = t.L[b], R = t.R[b]; for (let i = 0; i < L.length; i++) { const l = Math.max(-1, Math.min(1, L[i])), r = Math.max(-1, Math.min(1, R[i])); out[k++] = l * 32767; out[k++] = r * 32767; } }
  return new Blob([buf], { type: 'audio/wav' });
}
function takeDialog(t, start) {
  const d = $('#dlg'), blob = wavBlob(t), secs = t.frames / 48000, v = S.song.vault;
  const name = h('input', { type: 'text', class: 'grow', value: `Take ${new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}` });
  const url = URL.createObjectURL(blob); let msg = '', busy = false;
  const close = () => { URL.revokeObjectURL(url); d.close(); };
  const upload = async () => {
    busy = true; msg = 'Saving the mix…'; draw();
    try {
      saveMix(); await api('PUT', mixUrl(), S.mix);   // the take is linked to the mix that made it
      await new Promise((resolve, reject) => {
        const x = new XMLHttpRequest();
        x.open('PUT', `/api/vault/sessions/${encodeURIComponent(v.id)}/versions/${encodeURIComponent(v.version)}/recording?name=${encodeURIComponent(name.value.trim())}&start=${start.toFixed(3)}`);
        x.upload.onprogress = e => { msg = `Uploading to LiveVault… ${Math.round(e.loaded / e.total * 100)}%`; const el = $('#takeMsg'); if (el) el.textContent = msg; };
        x.onload = () => x.status === 200 ? resolve() : reject(new Error(JSON.parse(x.responseText || '{}').error || 'Upload failed'));
        x.onerror = () => reject(new Error('Upload failed: connection lost'));
        x.send(blob);
      });
      close(); flash('Recording saved to LiveVault');
    } catch (e) { busy = false; msg = e.message; draw(); }
  };
  const draw = () => fill(d, h('h2', {}, 'Main LR take'),
    h('div', { class: 'note', style: 'margin-bottom:8px' }, `${fmtTime(secs)} recorded from ${fmtTime(start)} · ${fmtMB(blob.size)} WAV, 48 kHz 16-bit`),
    h('audio', { controls: true, src: url, style: 'width:100%;margin-bottom:8px' }),
    h('div', { class: 'row', style: 'margin-bottom:8px' }, h('span', { class: 'note' }, 'Name'), name),
    v && h('div', { class: 'note', style: 'margin-bottom:8px' }, `Saving keeps it with version ${v.version} in LiveVault, linked to your current mix, for review.`),
    msg && h('div', { class: busy ? 'note' : 'errbox', id: 'takeMsg', style: 'margin-bottom:8px' }, msg),
    h('div', { class: 'row' }, v && h('button', { class: 'on', disabled: busy, onclick: upload }, 'Save to LiveVault'),
      h('a', { href: url, download: `${S.song.name} - ${name.value.trim() || 'take'}.wav` }, h('button', {}, 'Download WAV')), h('span', { class: 'grow' }),
      h('button', { class: 'danger', disabled: busy, onclick: close }, 'Discard')),
    !v && h('div', { class: 'note', style: 'margin-top:8px' }, 'Open a session from the LiveVault library to keep takes there for review.'));
  d.onclose = () => URL.revokeObjectURL(url);
  draw(); d.showModal();
}
function flash(text) { const el = h('span', { class: 'st ok' }, text); $('#status').append(el); setTimeout(() => el.remove(), 4000); }

// =====================================================================================
// Console surface
// =====================================================================================
function layers() {
  const L = [], ins = S.m.inputs;
  for (let i = 0; i < ins.length; i += 16) L.push({ name: `In ${i + 1}–${Math.min(ins.length, i + 16)}`, ids: ins.slice(i, i + 16) });
  L.push({ name: 'Buses', ids: [...Array.from({ length: NG }, (_, i) => 'g' + (i + 1)), ...AUX, ...FXS] });
  L.push({ name: 'DCA', ids: Array.from({ length: ND }, (_, i) => 'd' + (i + 1)) });
  return L;
}
const stripNo = id => id.startsWith('in') ? String(S.m.inputs.indexOf(id) + 1) : id === 'main' ? 'LR' : id[0] === 'f' ? 'FX' + id[1] : id.toUpperCase();
const sofOn = () => S.view === 'sq' && S.sof !== 'main';

// What a strip's fader and mute button control right now (its own level, a DCA, or a send in sends-on-faders).
function bind(id) {
  if (id[0] === 'd') { const d = S.m.dcas[+id[1] - 1]; return { get: () => d.fader, set: v => { d.fader = v; E.updateAll(); }, muted: () => d.mute, toggle: () => { d.mute = !d.mute; E.updateAll(); } }; }
  const s = S.m.strips[id];
  if (sofOn() && s.kind === 'in') { const sd = s.sends[S.sof]; return { sof: true, get: () => sd.lvl, set: v => { sd.lvl = v; E.update(id); }, muted: () => !sd.on, toggle: () => { sd.on = !sd.on; E.update(id); } }; }
  return { get: () => s.fader, set: v => { s.fader = v; E.update(id); }, muted: () => s.mute, toggle: () => { s.mute = !s.mute; E.update(id); } };
}

function faderEl(get, set) {
  const el = h('div', { class: 'fader' }, h('div', { class: 'slot' }));
  for (const d of [10, 5, 0, -5, -10, -20, -30, -40, -60]) el.append(h('i', { class: d === 0 ? 'z' : '', style: `bottom:calc(${dbToPos(d)} * (100% - 34px) + 17px)` }));
  const cap = h('div', { class: 'cap' }); el.append(cap);
  const upd = () => { cap.style.bottom = `calc(${dbToPos(get())} * (100% - 34px))`; };
  let st = null;
  el.onpointerdown = e => { el.setPointerCapture(e.pointerId); st = { y: e.clientY, p: dbToPos(get()) }; e.preventDefault(); };
  el.onpointermove = e => { if (!st) return; const p = Math.max(0, Math.min(1, st.p + (st.y - e.clientY) / (el.clientHeight - 34) * (e.shiftKey ? 0.25 : 1))); set(posToDb(p)); upd(); };
  el.onpointerup = el.onpointercancel = () => { st = null; };
  el.ondblclick = () => { set(0); upd(); };
  el.update = upd; upd();
  return el;
}

function stripEl(id, bank) {
  const isD = id[0] === 'd' && !id.startsWith('daw'), s = isD ? null : S.m.strips[id], b = bind(id), daw = S.view === 'daw';
  const name = isD ? S.m.dcas[+id[1] - 1].name : s.name;
  const val = h('div', { class: 'val' }, fmtDb(b.get()));
  const fad = faderEl(b.get, v => { b.set(v); val.textContent = fmtDb(v); dirty(); });
  fad.sync = () => { fad.update(); val.textContent = fmtDb(b.get()); };
  faders.set(id, fad);
  const mute = h('button', { class: 'mute' + (b.muted() ? ' on' : ''), onclick: () => { b.toggle(); mute.classList.toggle('on', b.muted()); dirty(); } }, b.sof ? 'OFF' : 'MUTE');
  fad.mute = () => mute.click();
  const el = h('div', { class: `strip k-${isD ? 'dca' : s.kind}` + (S.sel === id ? ' sel' : '') + (b.sof ? ' sof' : '') + (bank ? ' bank' : '') });
  el.append(h('div', { class: 'no' }, stripNo(id) + (b.sof ? ' → ' + stripNo(S.sof) : '')));
  if (daw && !isD) {
    el.append(h('div', { class: 'ins' }, s.chain.map(blk => h('button', { class: blk.on ? 'on' : 'byp', title: blkLong(blk), onclick: () => openPopup(id, blk.id) }, blkLabel(blk))), addBlockSel(s, '+')));
    if (s.kind === 'in') {
      el.append(h('div', { class: 'snd' }, [...AUX, ...FXS].map(k => { const sd = s.sends[k]; const r = h('input', { type: 'range', min: 0, max: 1, step: 0.005, value: dbToPos(sd.lvl), title: `Send to ${S.m.strips[k].name}`, oninput: () => { sd.lvl = posToDb(+r.value); E.update(id); dirty(); } }); return h('div', {}, stripNo(k), r); })));
      const pn = h('input', { type: 'range', class: 'pn', min: -1, max: 1, step: 0.02, value: s.pan, title: 'Pan (double-click to center)', oninput: () => { s.pan = +pn.value; E.update(id); dirty(); }, ondblclick: () => { pn.value = s.pan = 0; E.update(id); dirty(); } });
      el.append(pn);
    } else el.append(h('div', { class: 'snd' }), h('div', { class: 'pn' }));
  }
  el.append(h('button', { class: 'nm', title: 'Select', onclick: () => { if (isD) return; S.sel = id; if (daw) openPopup(id, null); else renderMixer(); } }, name));
  const pfl = !isD && h('button', { class: 'pfl' + (s.pfl ? ' on' : ''), title: 'Solo to the headphones', onclick: () => { s.pfl = !s.pfl; pfl.classList.toggle('on', s.pfl); E.update(id); E.monitor(); } }, 'PFL');
  el.append(h('div', { class: 'b2' }, mute), h('div', { class: 'b2' }, pfl || h('button', { disabled: true }, '–')));
  const meter = h('div', { class: 'meter' }, h('div', { class: 'mask' }));
  if (!isD) meters.push({ kind: 'lvl', id, el: meter.firstChild, box: meter, v: -120, over: 0 });
  el.append(h('div', { class: 'fm' }, fad, isD ? null : meter), val);
  return el;
}

function renderMixer() {
  if (S.page !== 'mixer') return;
  meters = []; faders = new Map();
  const root = $('#mixer'); root.className = 'view-' + S.view;
  document.querySelectorAll('#viewSeg button').forEach(b => b.classList.toggle('on', b.dataset.v === S.view));
  const keep = [(surf => surf ? surf.scrollLeft : 0)($('#surface .strips')), $('#panel').scrollLeft, $('#panel').scrollTop];
  const surf = $('#surface'); surf.replaceChildren();
  const L = layers(); if (S.layer >= L.length) S.layer = 0;
  const strips = h('div', { class: 'strips' });
  const layerBtns = h('div', { class: 'layers' }, h('b', {}, S.view === 'sq' ? 'Layers' : 'Bank'), L.map((l, i) => h('button', { class: i === S.layer ? 'on' : '', title: S.view === 'sq' ? '' : 'Jump here; a MIDI controller follows this bank', onclick: () => { S.layer = i; renderMixer(); if (S.view !== 'sq') { const t = strips.querySelector('.bank'); t && t.scrollIntoView({ inline: 'start', behavior: 'smooth', block: 'nearest' }); } } }, l.name)));
  if (S.view === 'sq') {
    strips.append(...L[S.layer].ids.map(id => stripEl(id)));
    const mixes = h('div', { class: 'mixes' }, h('b', {}, 'Mix'), ['main', ...AUX, ...FXS].map(k => h('button', { class: S.sof === k ? 'on' : '', title: k === 'main' ? 'Faders control the main mix' : 'Sends on faders: the input faders become the sends to this mix', onclick: () => { S.sof = k; renderMixer(); } }, S.m.strips[k].name)));
    surf.append(layerBtns, strips, h('div', { class: 'secsep' }), stripEl(S.sof), mixes);
  } else {
    const bank = new Set(L[S.layer].ids);
    L.forEach((l, i) => { if (i) strips.append(h('div', { class: 'secsep' })); strips.append(...l.ids.map(id => stripEl(id, bank.has(id)))); });
    surf.append(layerBtns, strips, h('div', { class: 'secsep' }), stripEl('main'));
  }
  renderPanel();
  if (S.popup) renderPopup();
  strips.scrollLeft = keep[0]; if (S.sel === S.lastSel) { $('#panel').scrollLeft = keep[1]; $('#panel').scrollTop = keep[2]; } S.lastSel = S.sel;
}

// =====================================================================================
// Selected channel: settings card, processing blocks
// =====================================================================================
// A labelled slider row. spec: {l, min, max, log, u}
function slider(spec, get, set, cls = '') {
  const N = 1000, to = v => spec.log ? Math.log(v / spec.min) / Math.log(spec.max / spec.min) * N : (v - spec.min) / (spec.max - spec.min) * N;
  const from = x => spec.log ? spec.min * Math.pow(spec.max / spec.min, x / N) : spec.min + (spec.max - spec.min) * x / N;
  const out = h('span', {}), r = h('input', { type: 'range', min: 0, max: N, step: 1 });
  const sync = () => { r.value = to(get()); out.textContent = (spec.fmt ? spec.fmt(get()) : fmtNum(get())) + (spec.u ? ' ' + spec.u : ''); };
  r.oninput = () => { let v = from(+r.value); if (spec.step) v = Math.round(v / spec.step) * spec.step; set(v); sync(); };
  if (spec.d != null) r.ondblclick = () => { set(spec.d); sync(); };
  const row = h('div', { class: 'pr ' + cls }, h('span', {}, spec.l), r, out);
  row.sync = sync; sync();
  return row;
}
const toggles = (label, items) => h('div', { class: 'tg' }, h('span', { class: 'lb' }, label), items);
const tbtn = (txt, on, fn, title) => { const b = h('button', { class: on ? 'on' : '', title, onclick: () => { fn(); } }, txt); return b; };
function addBlockSel(s, label = '＋ Add processing…') {
  const plugs = (s.kind === 'in' || s.kind === 'main') && S.plugins.host.ok ? S.plugins.plugins.filter(p => !p.error).flatMap(p => p.plugins.map(x => ({ v: 'vst:' + p.id + '::' + x.name, l: x.name || p.id.replace(/\.vst3$/i, '') }))) : [];
  const sel = h('select', { class: 'sm', onchange: () => {
    if (!sel.value) return;
    let b;
    if (sel.value.startsWith('vst:')) { b = newBlock('vst'); b.p.plugin = sel.value.slice(4); b.p.name = sel.selectedOptions[0].textContent; } else b = newBlock(sel.value);
    s.chain.push(b); E.rechain(s.id); dirty(); if (S.view === 'daw') S.popup = { id: s.id, bid: b.id }; renderMixer(); } },
    h('option', { value: '' }, label), Object.entries(SPECS).filter(([, v]) => !v.remote).map(([k, v]) => h('option', { value: k }, v.long)),
    plugs.length ? h('optgroup', { label: 'Server plugins' }, plugs.map(p => h('option', { value: p.v }, p.l))) : null);
  return sel;
}

function chanCard(s) {
  const id = s.id, up = () => { E.update(id); dirty(); };
  const nm = h('input', { type: 'text', class: 'sm grow', value: s.name, onchange: () => { s.name = nm.value.slice(0, 40) || s.name; dirty(); renderMixer(); if (s.kind === 'aux') renderTransport(); } });
  const card = h('div', { class: 'card blk chan' }, h('div', { class: 'hd' }, h('span', { class: 't' }, stripNo(id)), nm));
  const body = h('div', { class: 'body', style: 'display:flex;flex-direction:column;gap:6px' }); card.append(body);
  body.append(slider({ l: 'Trim', min: -24, max: 24, u: 'dB', d: 0, step: 0.5 }, () => s.trim, v => { s.trim = v; up(); }));
  if (s.kind === 'in') body.append(slider({ l: 'Pan', min: -1, max: 1, d: 0, step: 0.02, fmt: v => Math.abs(v) < 0.01 ? 'C' : (v < 0 ? 'L' : 'R') + Math.round(Math.abs(v) * 100) }, () => s.pan, v => { s.pan = v; up(); }));
  const route = [tbtn('Ø', s.pol, () => { s.pol = !s.pol; up(); renderPanelOrPopup(); }, 'Flip polarity')];
  if (s.kind !== 'main' && s.kind !== 'aux') route.push(tbtn('LR', s.lr, () => { s.lr = !s.lr; up(); renderPanelOrPopup(); }, 'Send to the main mix'));
  if (s.kind === 'in') s.grp.forEach((on, i) => route.push(tbtn('G' + (i + 1), on, () => { s.grp[i] = !on; up(); renderPanelOrPopup(); }, 'Send to ' + S.m.strips['g' + (i + 1)].name)));
  body.append(toggles('Routing', route));
  if (s.kind !== 'main') body.append(toggles('DCA', s.dca.map((on, i) => tbtn(String(i + 1), on, () => { s.dca[i] = !on; up(); renderPanelOrPopup(); }, S.m.dcas[i].name))));
  if (s.kind === 'in') {
    body.append(h('h2', { style: 'margin:6px 0 0' }, 'Sends'));
    for (const k of [...AUX, ...FXS]) {
      const sd = s.sends[k], val = h('span', {}, fmtDb(sd.lvl));
      const r = h('input', { type: 'range', min: 0, max: 1, step: 0.005, value: dbToPos(sd.lvl), oninput: () => { sd.lvl = posToDb(+r.value); val.textContent = fmtDb(sd.lvl); up(); const f = sofOn() && S.sof === k && faders.get(id); f && f.sync(); } });
      const pre = h('button', { class: 'sm' + (sd.pre ? ' on' : ''), title: 'Pre-fader (monitors) or post-fader (effects)', onclick: () => { sd.pre = !sd.pre; pre.classList.toggle('on', sd.pre); pre.textContent = sd.pre ? 'Pre' : 'Post'; up(); } }, sd.pre ? 'Pre' : 'Post');
      const on = h('button', { class: 'sm' + (sd.on ? ' on' : ''), onclick: () => { sd.on = !sd.on; on.classList.toggle('on', sd.on); up(); } }, 'On');
      body.append(h('div', { class: 'sendrow' }, h('span', { class: 'note' }, S.m.strips[k].name.slice(0, 8)), r, val, pre, on));
    }
  }
  if (s.kind === 'fx') {
    const fx = s.fx, fu = () => { E.fxSet(id); dirty(); };
    body.append(h('h2', { style: 'margin:6px 0 0' }, 'Effect'), toggles('Type', [tbtn('Reverb', fx.type === 'reverb', () => { fx.type = 'reverb'; fu(); renderPanelOrPopup(); }), tbtn('Delay', fx.type === 'delay', () => { fx.type = 'delay'; fu(); renderPanelOrPopup(); })]));
    if (fx.type === 'reverb') body.append(slider({ l: 'Decay', min: 0.3, max: 6, log: 1, u: 's', step: 0.1 }, () => fx.time, v => { fx.time = v; fu(); }), slider({ l: 'Pre-delay', min: 0, max: 150, u: 'ms', step: 1 }, () => fx.pre, v => { fx.pre = v; fu(); }));
    else body.append(slider({ l: 'Time', min: 30, max: 1500, log: 1, u: 'ms', step: 1 }, () => fx.dtime, v => { fx.dtime = v; fu(); }), slider({ l: 'Feedback', min: 0, max: 90, u: '%', step: 1 }, () => fx.fb, v => { fx.fb = v; fu(); }));
    body.append(slider({ l: 'High cut', min: 1000, max: 16000, log: 1, u: 'Hz' }, () => fx.damp, v => { fx.damp = v; fu(); }));
  }
  // templates
  const tSel = h('select', { class: 'sm grow' }, S.templates.map(t => h('option', { value: t.name, selected: t.name === s.tplName }, t.name)));
  const tName = h('input', { type: 'text', class: 'sm grow', placeholder: 'New template name' });
  body.append(h('h2', { style: 'margin:6px 0 0' }, 'Template'),
    h('div', { class: 'row' }, tSel, h('button', { class: 'sm', title: 'Replace this channel\'s processing with the template', onclick: () => { const t = S.templates.find(t => t.name === tSel.value); if (!t) return; s.chain = chainFrom(t); s.tplName = t.name; E.rechain(id); dirty(); renderMixer(); } }, 'Apply')),
    h('div', { class: 'row' }, tName, h('button', { class: 'sm', title: 'Save this channel\'s signal flow and settings as a template', onclick: () => {
      const n = tName.value.trim(); if (!n) return tName.focus();
      const t = { name: n, match: (S.templates.find(t => t.name === n) || {}).match || '', chain: s.chain.map(b => ({ type: b.type, on: b.on, p: clone(b.p) })) };
      const i = S.templates.findIndex(t => t.name === n); if (i >= 0) S.templates[i] = t; else S.templates.push(t);
      s.tplName = n; api('PUT', '/api/templates', { templates: S.templates }).catch(() => {}); renderPanelOrPopup();
    } }, 'Save')));
  return card;
}

const css = v => getComputedStyle(document.documentElement).getPropertyValue(v).trim();
function curveCanvas(H = 150) {
  const cv = h('canvas', { width: 840, height: H * 2 }), g = cv.getContext('2d'), W = 840; H *= 2;
  const X = f => Math.log(f / 20) / Math.log(1000) * W, Y = d => H / 2 - d / 18 * (H / 2 - 8);
  const freqs = new Float32Array(240); for (let i = 0; i < 240; i++) freqs[i] = 20 * Math.pow(1000, i / 239);
  cv.geo = { W, H, X, Y, Fx: x => 20 * Math.pow(1000, x / W), Dy: y => (H / 2 - y) / (H / 2 - 8) * 18, freqs };
  cv.grid = () => {
    g.clearRect(0, 0, W, H); g.lineWidth = 1; g.strokeStyle = css('--line'); g.fillStyle = css('--dim'); g.font = '18px system-ui';
    for (const f of [50, 100, 200, 500, 1000, 2000, 5000, 10000]) { g.beginPath(); g.moveTo(X(f), 0); g.lineTo(X(f), H); g.stroke(); g.fillText(f >= 1000 ? f / 1000 + 'k' : f, X(f) + 4, H - 6); }
    for (const d of [-12, -6, 0, 6, 12]) { g.beginPath(); g.moveTo(0, Y(d)); g.lineTo(W, Y(d)); g.stroke(); if (d) g.fillText((d > 0 ? '+' : '') + d, 4, Y(d) - 4); }
  };
  cv.curve = dbs => { g.strokeStyle = css('--acc'); g.lineWidth = 4; g.beginPath(); for (let i = 0; i < 240; i++) { const x = X(freqs[i]), y = Y(Math.max(-30, dbs[i])); i ? g.lineTo(x, y) : g.moveTo(x, y); } g.stroke();
    g.lineTo(W, Y(0)); g.lineTo(0, Y(0)); g.closePath(); g.globalAlpha = 0.12; g.fillStyle = css('--acc'); g.fill(); g.globalAlpha = 1; };
  return cv;
}

function blockBody(s, b) {
  const sid = s.id, body = h('div', { class: 'body', style: 'display:flex;flex-direction:column;gap:6px' });
  const push = () => { E.blockSet(sid, b.id); dirty(); };
  if (b.type === 'eq') {
    const cv = curveCanvas(150), { X, Y, Fx, Dy, freqs } = cv.geo, g = cv.getContext('2d'), rows = [];
    const draw = () => { cv.grid(); cv.curve(E.response(sid, b.id, freqs)); b.p.b.forEach((bd, i) => { const x = X(bd.f), y = Y(bd.g); g.beginPath(); g.arc(x, y, 15, 0, 7); g.fillStyle = css('--teal'); g.fill(); g.fillStyle = css('--onacc'); g.font = 'bold 18px system-ui'; g.fillText(i + 1, x - 5, y + 6); }); };
    const at = e => { const r = cv.getBoundingClientRect(); return [(e.clientX - r.left) / r.width * cv.geo.W, (e.clientY - r.top) / r.height * cv.geo.H]; };
    let drag = -1;
    cv.onpointerdown = e => { const [x, y] = at(e); let best = 60; b.p.b.forEach((bd, i) => { const d = Math.hypot(X(bd.f) - x, Y(bd.g) - y); if (d < best) { best = d; drag = i; } }); if (drag >= 0) cv.setPointerCapture(e.pointerId); };
    cv.onpointermove = e => { if (drag < 0) return; const [x, y] = at(e), bd = b.p.b[drag]; bd.f = Math.max(20, Math.min(20000, Fx(x))); bd.g = Math.round(Math.max(-18, Math.min(18, Dy(y))) * 2) / 2; push(); draw(); rows[drag].forEach(r => r.sync()); };
    cv.onpointerup = cv.onpointercancel = () => { drag = -1; };
    cv.onwheel = e => { e.preventDefault(); const [x, y] = at(e); let best = 80, k = -1; b.p.b.forEach((bd, i) => { const d = Math.hypot(X(bd.f) - x, Y(bd.g) - y); if (d < best) { best = d; k = i; } }); if (k < 0) return; const bd = b.p.b[k]; bd.q = Math.max(0.3, Math.min(12, bd.q * (e.deltaY < 0 ? 1.15 : 1 / 1.15))); push(); draw(); rows[k].forEach(r => r.sync()); };
    const bands = h('div', { class: 'bands' }, b.p.b.map((bd, i) => {
      const ty = h('select', { class: 'sm', onchange: () => { bd.t = ty.value; push(); draw(); } }, [['peaking', 'Bell'], ['lowshelf', 'Low shelf'], ['highshelf', 'High shelf']].map(([v, l]) => h('option', { value: v, selected: bd.t === v }, `${i + 1} · ${l}`)));
      const r = [slider({ l: 'Hz', min: 20, max: 20000, log: 1 }, () => bd.f, v => { bd.f = v; push(); draw(); }, 's3'),
        slider({ l: 'dB', min: -18, max: 18, step: 0.5, d: 0 }, () => bd.g, v => { bd.g = v; push(); draw(); }, 's3'),
        slider({ l: 'Q', min: 0.3, max: 12, log: 1, d: 1 }, () => bd.q, v => { bd.q = v; push(); draw(); }, 's3')];
      rows.push(r); return h('div', {}, ty, r);
    }));
    body.append(cv, h('div', { class: 'note' }, 'Drag a dot for frequency and gain, scroll over it for width.'), bands);
    requestAnimationFrame(draw);
    return body;
  }
  if (b.type === 'vst') {
    const inst = E.vst(sid, b.id), st = h('div', { class: 'note' });
    meters.push({ kind: 'vst', id: sid, bid: b.id, el: st });
    body.append(st);
    if (!inst || inst.state === 'connecting') return body;
    if (inst.state === 'error') { body.append(h('div', { class: 'errbox' }, inst.error)); return body; }
    const all = inst.params || [], list = h('div', { style: 'display:flex;flex-direction:column;gap:5px' }), rows = new Map();
    const show = f => {
      list.replaceChildren(); rows.clear();
      const hit = all.filter(p => !f || p.label.toLowerCase().includes(f));
      for (const p of hit.slice(0, 40)) {
        const out = h('span', {}, p.text + (p.units ? ' ' + p.units : ''));
        const r = h('input', { type: 'range', min: 0, max: 1, step: p.steps > 1 && p.steps < 200 ? 1 / (p.steps - 1) : 0.001, value: p.raw,
          oninput: () => { p.raw = +r.value; b.p.values[p.name] = p.raw; E.vstSet(sid, b.id, p.name, p.raw); dirty(); } });
        rows.set(p.name, out);
        list.append(h('div', { class: 'pr', title: p.label }, h('span', { style: 'overflow:hidden;text-overflow:ellipsis;white-space:nowrap' }, p.label), r, out));
      }
      if (hit.length > 40) list.append(h('div', { class: 'note' }, `${hit.length - 40} more: type in the box to find them`));
    };
    inst.onval = p => { const out = rows.get(p.name); if (out) out.textContent = p.text + (p.units ? ' ' + p.units : ''); };
    if (all.length > 12) { const f = h('input', { type: 'text', class: 'sm', placeholder: `Find a parameter (${all.length})`, oninput: () => show(f.value.trim().toLowerCase()) }); body.append(f); }
    show(''); body.append(list);
    return body;
  }
  let redraw = () => {};
  if (b.type === 'hpf' || b.type === 'lpf') {
    const cv = curveCanvas(70); body.append(cv);
    redraw = () => { cv.grid(); cv.curve(E.response(sid, b.id, cv.geo.freqs)); };
  }
  if (b.type === 'comp') {
    const cv = h('canvas', { width: 300, height: 300, style: 'width:130px;align-self:center' }), g = cv.getContext('2d'); body.append(cv);
    redraw = () => {
      const { thr, ratio, knee, makeup } = b.p, P = d => (d + 60) / 60 * 300;
      g.clearRect(0, 0, 300, 300); g.strokeStyle = css('--line'); g.lineWidth = 2; g.beginPath(); g.moveTo(0, 300); g.lineTo(300, 0); g.stroke();
      g.strokeStyle = css('--acc'); g.lineWidth = 5; g.beginPath();
      for (let d = -60; d <= 0; d += 0.5) { const o = d - thr, sl = 1 - 1 / ratio; let gr = 0; if (knee > 0 && o > -knee / 2 && o < knee / 2) gr = sl * (o + knee / 2) ** 2 / (2 * knee); else if (o > 0) gr = sl * o; const y = 300 - P(d - gr + makeup); d === -60 ? g.moveTo(P(d), y) : g.lineTo(P(d), y); }
      g.stroke();
    };
  }
  if (SPECS[b.type].dyn) {
    const bar = h('i'), txt = h('span', { class: 'note', style: 'min-width:52px;text-align:right' }, '0.0 dB');
    body.append(h('div', { class: 'row' }, h('span', { class: 'note' }, 'Reduction'), h('div', { class: 'grm grow' }, bar), txt));
    meters.push({ kind: 'gr', id: sid, bid: b.id, el: bar, txt, v: 0 });
  }
  for (const spec of SPECS[b.type].params) {
    if (spec.opts) body.append(toggles(spec.l, spec.opts.map(o => tbtn(o + ' ' + spec.u, b.p[spec.k] === o, () => { b.p[spec.k] = o; push(); renderPanelOrPopup(); }))));
    else body.append(slider(spec, () => b.p[spec.k], v => { b.p[spec.k] = v; push(); redraw(); }));
  }
  requestAnimationFrame(redraw);
  return body;
}
function blockCard(s, b) {
  const i = s.chain.indexOf(b);
  const mv = d => { const j = i + d; if (j < 0 || j >= s.chain.length) return; s.chain.splice(i, 1); s.chain.splice(j, 0, b); E.rechain(s.id); dirty(); renderMixer(); };
  return h('div', { class: 'card blk' + (b.on ? '' : ' off') + (b.type === 'eq' ? ' wide' : '') + (b.type === 'vst' ? ' plug' : '') },
    h('div', { class: 'hd' }, h('button', { class: b.on ? 'on' : '', title: 'In / bypass', onclick: () => { b.on = !b.on; E.rechain(s.id); dirty(); renderMixer(); } }, b.on ? 'In' : 'Out'),
      h('span', { class: 't grow' }, blkLong(b)),
      h('button', { title: 'Earlier in the signal flow', disabled: i === 0, onclick: () => mv(-1) }, '◀'), h('button', { title: 'Later in the signal flow', disabled: i === s.chain.length - 1, onclick: () => mv(1) }, '▶'),
      h('button', { class: 'danger', title: 'Remove', onclick: () => { s.chain.splice(i, 1); if (S.popup && S.popup.bid === b.id) S.popup = null; E.rechain(s.id); dirty(); renderMixer(); } }, '✕')),
    blockBody(s, b));
}
function renderPanel() {
  const p = $('#panel'); p.replaceChildren();
  if (S.view === 'daw') return;
  const s = S.m.strips[S.sel];
  if (!s) return p.append(h('div', { class: 'hint' }, 'Select a channel to see its processing.'));
  p.append(chanCard(s));
  for (const b of s.chain) p.append(h('div', { class: 'flow' }, '➜'), blockCard(s, b));
  p.append(h('div', { class: 'flow' }, '➜'), h('div', { class: 'hint', style: 'padding:6px' }, addBlockSel(s), h('div', { class: 'note', style: 'margin-top:6px' }, 'then fader, pan and sends')));
}
function openPopup(id, bid) { S.popup = { id, bid }; S.sel = id; renderMixer(); }
function closePopup() { S.popup = null; $('#popup').classList.add('hide'); }
function renderPopup() {
  const el = $('#popup'), s = S.popup && S.m.strips[S.popup.id];
  if (!s) return closePopup();
  const b = S.popup.bid && s.chain.find(x => x.id === S.popup.bid);
  el.replaceChildren(h('div', { class: 'card', style: 'display:flex;flex-direction:column;gap:8px' },
    h('div', { class: 'row' }, h('h2', { class: 'grow', style: 'margin:0' }, `${stripNo(s.id)} · ${s.name}`), h('button', { class: 'sm', onclick: () => { closePopup(); } }, 'Close')),
    b ? blockCard(s, b) : chanCard(s)));
  el.classList.remove('hide');
}
// Re-draw just the channel editor (keeps fader drags and meters on the surface untouched).
function renderPanelOrPopup() { meters = meters.filter(m => m.kind === 'lvl'); renderPanel(); if (S.popup) renderPopup(); }

// =====================================================================================
// Scenes
// =====================================================================================
function loadMix(saved) { S.m = freshMixer(saved); buildEngine(); if (!S.m.strips[S.sel]) S.sel = S.m.inputs[0]; saveMix(); renderTransport(); renderMixer(); }
function scenesDialog() {
  const d = $('#dlg'), name = h('input', { type: 'text', class: 'grow', placeholder: 'Scene name' });
  const draw = () => fill(d, h('h2', {}, 'Scenes for ' + S.song.name),
    h('div', { class: 'note', style: 'margin-bottom:8px' }, 'A scene stores the whole mix: faders, routing, sends and every processing block. Your current mix is also kept automatically between visits.'),
    S.mix.scenes.map((sc, i) => h('div', { class: 'li' }, h('b', { class: 'grow' }, sc.name),
      h('button', { class: 'sm on', onclick: () => { loadMix(sc.mixer); d.close(); } }, 'Recall'),
      h('button', { class: 'sm', title: 'Overwrite with the current mix', onclick: () => { sc.mixer = clone(S.m); saveMix(); draw(); } }, 'Update'),
      h('button', { class: 'sm danger', onclick: () => { S.mix.scenes.splice(i, 1); saveMix(); draw(); } }, '✕'))),
    h('div', { class: 'row', style: 'margin-top:10px' }, name, h('button', { class: 'on', onclick: () => { const n = name.value.trim(); if (!n) return name.focus(); S.mix.scenes.push({ name: n, mixer: clone(S.m) }); name.value = ''; saveMix(); draw(); } }, 'Save current mix')),
    h('div', { class: 'row', style: 'margin-top:14px' }, h('button', { class: 'danger', title: 'Faders down, processing back to the channel templates', onclick: () => { loadMix(null); d.close(); } }, 'Start over from templates'), h('span', { class: 'grow' }), h('button', { onclick: () => d.close() }, 'Close')));
  draw(); d.showModal();
}

// =====================================================================================
// MIDI control surface (faders, mutes and selects follow the current layer / bank)
// =====================================================================================
const midi = { access: null, map: JSON.parse(ls('midi') || '{"fader":[],"mute":[],"sel":[],"master":[],"play":[]}'), learn: null, redraw: null };
function midiKey(d) { const st = d[0] & 0xf0, ch = d[0] & 0x0f; return st === 0xe0 ? `pb:${ch}` : st === 0xb0 ? `cc:${ch}:${d[1]}` : st === 0x90 ? `nt:${ch}:${d[1]}` : null; }
function onMidi(e) {
  const d = e.data, st = d[0] & 0xf0, key = midiKey(d);
  if (!key || (st === 0x90 && d[2] === 0)) return;
  if (midi.learn) { const l = midi.map[midi.learn]; if (!l.includes(key)) { if (midi.learn === 'master' || midi.learn === 'play') l.length = 0; l.push(key); ls('midi', JSON.stringify(midi.map)); midi.redraw && midi.redraw(); } return; }
  if (S.page !== 'mixer') return;
  const val = st === 0xe0 ? ((d[2] << 7) | d[1]) / 16383 : d[2] / 127, press = st === 0x90 || d[2] >= 64;
  const ids = layers()[S.layer].ids;
  let i;
  if ((i = midi.map.fader.indexOf(key)) >= 0 || midi.map.master[0] === key) {
    const id = i >= 0 ? ids[i] : (S.view === 'sq' ? S.sof : 'main'); if (!id) return;
    bind(id).set(posToDb(val)); const f = faders.get(id); f && f.sync(); dirty();
  } else if ((i = midi.map.mute.indexOf(key)) >= 0 && press) { const f = faders.get(ids[i]); f && f.mute(); }
  else if ((i = midi.map.sel.indexOf(key)) >= 0 && press) { const id = ids[i]; if (id && id[0] !== 'd') { S.sel = id; renderMixer(); } }
  else if (midi.map.play[0] === key && press) E.playing ? E.pause() : E.play();
}
async function midiEnable() {
  midi.access = await navigator.requestMIDIAccess();
  const hook = () => { for (const inp of midi.access.inputs.values()) inp.onmidimessage = onMidi; midi.redraw && midi.redraw(); };
  midi.access.onstatechange = hook; hook();
}
function midiDialog() {
  const d = $('#dlg'); let err = '';
  const row = (k, label, hint) => h('div', { class: 'li' }, h('div', { class: 'grow' }, h('b', {}, label), h('div', { class: 'note' }, midi.learn === k ? 'Listening… ' + hint : `${midi.map[k].length} assigned`)),
    h('button', { class: 'sm' + (midi.learn === k ? ' on' : ''), disabled: !midi.access, onclick: () => { midi.learn = midi.learn === k ? null : k; draw(); } }, midi.learn === k ? 'Done' : 'Learn'),
    h('button', { class: 'sm danger', onclick: () => { midi.map[k] = []; ls('midi', JSON.stringify(midi.map)); draw(); } }, 'Clear'));
  const draw = midi.redraw = () => fill(d, h('h2', {}, 'MIDI controller'),
    !navigator.requestMIDIAccess ? h('div', { class: 'errbox' }, 'This browser cannot use MIDI devices. Chrome and Edge can; the page must be open over https.') :
    !midi.access ? h('div', { class: 'row' }, h('button', { class: 'on', onclick: () => midiEnable().catch(e => { err = e.message; draw(); }) }, 'Connect MIDI'), h('span', { class: 'note' }, err || 'The browser will ask for permission.')) :
    h('div', { class: 'note' }, 'Connected: ' + ([...midi.access.inputs.values()].map(i => i.name).join(', ') || 'no devices found, plug one in')),
    h('div', { class: 'note', style: 'margin:8px 0' }, 'Press Learn, then move the controls on your controller from left to right. Faders, mutes and selects act on the layer (SQ view) or bank that is showing, so 8 or 16 faders reach every channel.'),
    row('fader', 'Channel faders', 'move fader 1, 2, 3…'), row('mute', 'Mute buttons', 'press mute 1, 2, 3…'), row('sel', 'Select buttons', 'press select 1, 2, 3…'), row('master', 'Master fader', 'move the master fader'), row('play', 'Play / pause', 'press the button'),
    h('div', { class: 'row', style: 'margin-top:12px' }, h('span', { class: 'grow' }), h('button', { onclick: () => d.close() }, 'Close')));
  d.onclose = () => { midi.learn = null; midi.redraw = null; };
  draw(); d.showModal();
}

// =====================================================================================
// Meters and housekeeping
// =====================================================================================
function frame() {
  if (S.page === 'mixer' && E.ctx) {
    for (const m of meters) {
      if (m.kind === 'lvl') {
        const l = E.level(m.id); m.v = Math.max(l, m.v - 1.2);
        m.el.style.height = (100 - Math.max(0, Math.min(1, (m.v + 60) / 66)) * 100) + '%';
        if (l >= -0.1) m.over = 45; if (m.over > 0) { m.over--; m.box.classList.toggle('over', m.over > 0); }
      } else if (m.kind === 'vst') {
        const i = E.vst(m.id, m.bid), t = !i ? '' : i.state === 'connecting' ? 'Connecting to the plugin host…' : i.state === 'error' ? 'Not running' : i.late > 0.02 ? `Running on the server, but ${Math.round(i.late * 100)}% of its audio is arriving late and is heard unprocessed. Raise Round trip in Setup.` : `Running on the server · ${E.vstDelayMs} ms round trip`;
        if (m.el.textContent !== t) m.el.textContent = t;
      } else {
        const gr = E.gr(m.id, m.bid); m.v = Math.max(gr, m.v - 0.4);
        m.el.style.width = Math.min(100, m.v / 24 * 100) + '%'; m.txt.textContent = '−' + m.v.toFixed(1) + ' dB';
      }
    }
    tUI.tick && tUI.tick();
    watchTake();
  }
  requestAnimationFrame(frame);
}

document.querySelectorAll('#viewSeg button').forEach(b => b.onclick = () => { S.view = b.dataset.v; ls('view', S.view); if (S.view !== 'daw') closePopup(); renderMixer(); });
$('#setupBtn').onclick = async () => { saveMix(); await refreshSongs().catch(() => {}); S.plugins = await api('GET', '/api/plugins').catch(() => S.plugins); showPage('setup'); };
$('#scBtn').onclick = scenesDialog;
$('#midiBtn').onclick = midiDialog;
$('#fsBtn').onclick = () => document.fullscreenElement ? document.exitFullscreen() : document.documentElement.requestFullscreen().catch(() => {});
$('#themeBtn').onclick = () => { const t = document.documentElement.getAttribute('data-theme') === 'light' ? 'dark' : 'light'; document.documentElement.setAttribute('data-theme', t); ls('theme', t); if (S.page === 'mixer') renderMixer(); };
document.addEventListener('keydown', e => { if (e.code === 'Space' && S.page === 'mixer' && !/INPUT|SELECT|TEXTAREA|BUTTON/.test(document.activeElement.tagName) && !$('#dlg').open) { e.preventDefault(); E.playing ? E.pause() : E.play(); } });
window.addEventListener('beforeunload', saveMix);

(async () => {
  try {
    const t = await api('GET', '/api/templates'); if (Array.isArray(t.templates) && t.templates.length) S.templates = t.templates;
    await refreshSongs();
    S.settings = await api('GET', '/api/settings'); S.plugins = await api('GET', '/api/plugins').catch(() => S.plugins);
    loadVaultList().then(() => S.page === 'setup' && renderSetup());
    const last = ls('song'); if (last && S.songs.some(s => s.id === last)) S.song = await api('GET', '/api/songs/' + last);
  } catch (e) { S.msg = 'Cannot reach the LiveWebMixer server: ' + e.message; }
  // "Open in LiveWebMixer" in LiveVault links here as #vault=<session id>&version=<version>
  const hp = new URLSearchParams(location.hash.slice(1));
  if (hp.get('vault')) {
    history.replaceState(null, '', location.pathname + location.search);
    if (!S.settings.vault) S.msg = 'To open LiveVault sessions, connect LiveVault first: LiveVault library > address and access token.';
    else try { S.song = await api('GET', `/api/vault/sessions/${encodeURIComponent(hp.get('vault'))}/versions/${encodeURIComponent(hp.get('version') || '')}`); ls('song', ''); }
    catch (e) { S.msg = 'Could not open that LiveVault session: ' + e.message; }
  }
  renderSetup(); pollSong(); requestAnimationFrame(frame);
})();
let linkT = 0;
E.link.onchange = () => { clearTimeout(linkT); linkT = setTimeout(() => { if (S.page === 'mixer') renderPanelOrPopup(); }, 50); };
window.LWM = { S, E, onMidi, midi };
