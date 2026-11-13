// Minimal WebSocket server side (RFC 6455), enough for the plugin audio link. No dependencies.
'use strict';
const crypto = require('crypto');
const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const MAX = 8 * 1024 * 1024;

// Completes the handshake on an http 'upgrade' and returns a small socket object:
// ws.send(string | Buffer), ws.close(), ws.onmessage(data, isBinary), ws.onclose()
function accept(req, socket) {
  const key = req.headers['sec-websocket-key'];
  if (!key || (req.headers.upgrade || '').toLowerCase() !== 'websocket') { socket.destroy(); return null; }
  socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ' +
    crypto.createHash('sha1').update(key + GUID).digest('base64') + '\r\n\r\n');
  socket.setNoDelay(true);
  const ws = { onmessage: null, onclose: null, open: true };
  let buf = Buffer.alloc(0), parts = [], partOp = 0;
  const frame = (op, data) => {
    const n = data.length; let h;
    if (n < 126) { h = Buffer.alloc(2); h[1] = n; }
    else if (n < 65536) { h = Buffer.alloc(4); h[1] = 126; h.writeUInt16BE(n, 2); }
    else { h = Buffer.alloc(10); h[1] = 127; h.writeBigUInt64BE(BigInt(n), 2); }
    h[0] = 0x80 | op;
    if (!socket.destroyed) { socket.write(h); socket.write(data); }
  };
  const end = () => { if (!ws.open) return; ws.open = false; socket.destroy(); ws.onclose && ws.onclose(); };
  ws.send = d => { if (ws.open) typeof d === 'string' ? frame(1, Buffer.from(d)) : frame(2, d); };
  ws.close = () => { if (ws.open) { frame(8, Buffer.alloc(0)); end(); } };
  socket.on('data', chunk => {
    buf = buf.length ? Buffer.concat([buf, chunk]) : chunk;
    for (;;) {
      if (buf.length < 2) return;
      const fin = buf[0] & 0x80, op = buf[0] & 0x0f, masked = buf[1] & 0x80;
      let len = buf[1] & 0x7f, off = 2;
      if (len === 126) { if (buf.length < 4) return; len = buf.readUInt16BE(2); off = 4; }
      else if (len === 127) { if (buf.length < 10) return; len = Number(buf.readBigUInt64BE(2)); off = 10; }
      if (len > MAX || !masked) return end();
      if (buf.length < off + 4 + len) return;
      const mask = buf.subarray(off, off + 4), data = Buffer.from(buf.subarray(off + 4, off + 4 + len));
      for (let i = 0; i < len; i++) data[i] ^= mask[i & 3];
      buf = buf.subarray(off + 4 + len);
      if (op === 8) return end();
      if (op === 9) { frame(10, data); continue; }
      if (op === 10) continue;
      if (op === 1 || op === 2) { partOp = op; parts = [data]; } else if (op === 0) parts.push(data); else return end();
      if (fin) { const all = parts.length === 1 ? parts[0] : Buffer.concat(parts); parts = []; try { ws.onmessage && ws.onmessage(partOp === 1 ? all.toString('utf8') : all, partOp === 2); } catch (e) { console.error('ws handler', e.message); } }
    }
  });
  socket.on('close', end); socket.on('error', end);
  return ws;
}
module.exports = { accept };
