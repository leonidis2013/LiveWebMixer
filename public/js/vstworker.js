// Carries plugin audio between the audio thread and the server over one WebSocket,
// off the page's main thread so screen redraws cannot hold audio up.
let ws = null, up = false;
const ports = new Map(), queue = [];
function connect() {
  ws = new WebSocket((location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/ws/vst');
  ws.binaryType = 'arraybuffer';
  ws.onopen = () => { up = true; postMessage({ t: 'state', up: true }); for (const m of queue.splice(0)) ws.send(m); };
  ws.onclose = () => { if (up) postMessage({ t: 'state', up: false }); up = false; setTimeout(connect, 2000); };
  ws.onerror = () => {};
  ws.onmessage = e => {
    if (typeof e.data === 'string') return postMessage({ t: 'msg', m: JSON.parse(e.data) });
    const p = ports.get(new DataView(e.data).getUint32(0, true));
    if (p) p.postMessage(e.data, [e.data]);
  };
}
onmessage = e => {
  const m = e.data;
  if (m.t === 'port') { ports.set(m.h, m.port); m.port.onmessage = ev => { if (up && ws.bufferedAmount < 4e6) ws.send(ev.data); }; }
  else if (m.t === 'drop') { const p = ports.get(m.h); if (p) { p.onmessage = null; p.close(); ports.delete(m.h); } }
  else if (m.t === 'send') { const s = JSON.stringify(m.m); if (up) ws.send(s); else if (m.m.t !== 'set') queue.push(s); }
};
connect();
