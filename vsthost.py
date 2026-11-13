#!/usr/bin/env python3
# LiveWebMixer plugin host. Loads Linux VST3 plugins with Spotify's pedalboard library and
# processes blocks of audio for the mixer's server-plugin inserts.
#
# Talks to server.js over two pipes: commands and audio arrive on stdin, replies leave on fd 3.
# (stdout is pointed at stderr, because plugins like to print things.)
# Every message is: 4-byte length, 1-byte kind, payload. kind 0 = JSON, kind 1 = audio.
# Audio payload: handle u32, seq u32, channels u16, frames u16, 4 spare bytes, then float32 samples
# one channel after another.
import sys, os, struct, json

out = os.fdopen(3, 'wb')
os.dup2(2, 1)
inp = sys.stdin.buffer
SR = 48000.0

try:
    import numpy as np
    import pedalboard
    ERR = None
except Exception as e:  # the mixer still runs without the plugin host
    pedalboard = None
    ERR = str(e)

inst = {}


def send(kind, payload):
    out.write(struct.pack('<IB', len(payload), kind))
    out.write(payload)
    out.flush()


def reply(msg):
    send(0, json.dumps(msg).encode('utf8'))


def read_exact(n):
    data = b''
    while len(data) < n:
        chunk = inp.read(n - len(data))
        if not chunk:
            sys.exit(0)
        data += chunk
    return data


class Builtin:
    """A plain gain, used by the tests to check the whole audio path without a plugin file."""

    def __init__(self):
        self.fx = pedalboard.Gain(gain_db=0.0)
        self.raw = 60.0 / 84.0

    def params(self):
        return [{'name': 'gain_db', 'label': 'Gain', 'raw': self.raw, 'text': '%.1f' % self.fx.gain_db, 'units': 'dB', 'steps': 0}]

    def set(self, name, raw):
        self.raw = min(1.0, max(0.0, float(raw)))
        self.fx.gain_db = -60.0 + 84.0 * self.raw
        return self.params()[0]

    def process(self, x):
        return self.fx.process(x, SR, buffer_size=x.shape[1], reset=False)


class Vst:
    def __init__(self, path, name):
        self.plug = pedalboard.load_plugin(path, plugin_name=name) if name else pedalboard.load_plugin(path)
        if not getattr(self.plug, 'is_effect', True):
            raise ValueError('This plugin is an instrument, not an effect')
        self.mode = 0
        self.failed = False

    def _one(self, name, p):
        try:
            text = str(p.string_value)
        except Exception:
            try:
                text = str(getattr(self.plug, name))
            except Exception:
                text = ''
        return {'name': name, 'label': str(getattr(p, 'name', name) or name), 'raw': float(p.raw_value), 'text': text,
                'units': str(getattr(p, 'label', '') or ''), 'steps': int(getattr(p, 'num_steps', 0) or 0)}

    def params(self):
        res = []
        for name, p in self.plug.parameters.items():
            try:
                res.append(self._one(name, p))
            except Exception:
                pass
        return res

    def set(self, name, raw):
        p = self.plug.parameters[name]
        p.raw_value = min(1.0, max(0.0, float(raw)))
        return self._one(name, p)

    def process(self, x):
        n = x.shape[1]
        if self.mode == 0:
            try:
                return self.plug.process(x, SR, buffer_size=n, reset=False)
            except Exception:
                # the plugin does not take this channel count: adapt once and remember
                self.mode = 1 if x.shape[0] == 1 else 2
        if self.mode == 1:      # mono channel into a stereo-only plugin
            return self.plug.process(np.concatenate([x, x]), SR, buffer_size=n, reset=False)
        return self.plug.process(x.mean(axis=0, keepdims=True), SR, buffer_size=n, reset=False)   # stereo into a mono-only plugin


def plugin_names(path):
    try:
        return list(pedalboard.VST3Plugin.get_plugin_names_for_file(path))
    except Exception:
        return []


def command(m):
    cmd, rid = m.get('cmd'), m.get('id')
    try:
        if cmd == 'hello':
            return reply({'id': rid, 'ok': pedalboard is not None, 'error': ERR, 'version': getattr(pedalboard, '__version__', '')})
        if pedalboard is None:
            raise RuntimeError('The plugin library is not installed: ' + str(ERR))
        if cmd == 'probe':
            names = plugin_names(m['path'])
            first = Vst(m['path'], names[0] if names else None)      # loading one proves the file works here
            found = [{'name': names[0] if names else '', 'params': len(first.plug.parameters)}]
            found += [{'name': n, 'params': None} for n in names[1:]]
            del first
            return reply({'id': rid, 'ok': True, 'plugins': found})
        if cmd == 'open':
            v = Builtin() if m['path'] == 'builtin:Gain' else Vst(m['path'], m.get('name') or None)
            for k, raw in (m.get('values') or {}).items():
                try:
                    v.set(k, raw)
                except Exception:
                    pass
            inst[m['handle']] = v
            return reply({'id': rid, 'ok': True, 'params': v.params()})
        if cmd == 'set':
            return reply({'id': rid, 'ok': True, 'param': inst[m['handle']].set(m['name'], m['raw'])})
        if cmd == 'params':
            return reply({'id': rid, 'ok': True, 'params': inst[m['handle']].params()})
        if cmd == 'close':
            inst.pop(m['handle'], None)
            return reply({'id': rid, 'ok': True})
        raise RuntimeError('Unknown command')
    except Exception as e:
        reply({'id': rid, 'ok': False, 'error': str(e) or e.__class__.__name__})


def audio(payload):
    handle, seq, nch, frames = struct.unpack_from('<IIHH', payload, 0)
    x = np.frombuffer(payload, dtype='<f4', offset=16).reshape(nch, frames)
    v = inst.get(handle)
    y = x
    if v is not None:
        try:
            y = np.asarray(v.process(x), dtype=np.float32)
            if y.ndim == 1:
                y = y.reshape(1, -1)
            if y.shape[0] > nch:
                y = y[:nch] if nch > 1 else y.mean(axis=0, keepdims=True)
            elif y.shape[0] < nch:
                y = np.repeat(y[:1], nch, axis=0)
            if y.shape[1] != frames:        # plugins that report latency can hand back short blocks
                fixed = np.zeros((nch, frames), dtype=np.float32)
                n = min(frames, y.shape[1])
                if n:
                    fixed[:, frames - n:] = y[:, y.shape[1] - n:]
                y = fixed
        except Exception as e:
            if not getattr(v, 'failed', False):
                sys.stderr.write('plugin process error (audio passes unprocessed): %s\n' % e)
                v.failed = True
            y = x
    send(1, payload[:16] + np.ascontiguousarray(y, dtype='<f4').tobytes())


while True:
    n, kind = struct.unpack('<IB', read_exact(5))
    body = read_exact(n)
    if kind == 0:
        command(json.loads(body.decode('utf8')))
    else:
        audio(body)
