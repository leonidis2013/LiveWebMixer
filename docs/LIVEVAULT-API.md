# LiveVault interface used by LiveWebMixer (version 1)

LiveWebMixer opens LiveVault sessions directly: it lists them, plays their tracks without copying, and saves mixes
back to the exact session version. This page is the whole contract. `test/mock-vault.js` is a small working
reference of it.

All calls are made by the LiveWebMixer **server** (never the browser), so LiveVault needs no CORS setup and the
token never reaches a browser.

## Access

Every request carries `Authorization: Bearer <token>`. The token is an API token created in LiveVault for
LiveWebMixer. Answer `401` when it is missing or wrong. Errors are JSON: `{ "error": "plain sentence" }`.

## `GET /api/v1/info`

```json
{ "name": "LiveVault", "version": "1.0.0", "api": 1 }
```

`name` must be exactly `LiveVault`; LiveWebMixer uses it to check the address.

## `GET /api/v1/sessions?q=<search text>`

Sessions the token may see, filtered by `q` (optional) on name and tags.

```json
{ "sessions": [
  { "id": "8f3a1c", "name": "Goodness of God - 2026-11-09 service", "latest": "1.1.0",
    "versions": ["1.1.0", "1.0.0"], "tags": ["service", "vocal-heavy"], "tracks": 24, "duration": 312.4 }
] }
```

`id` is any URL-safe text. `versions` is newest first, numbered major.minor.patch.

## `GET /api/v1/sessions/<id>/versions/<version>`

```json
{ "id": "8f3a1c", "name": "Goodness of God - 2026-11-09 service", "version": "1.1.0",
  "versions": ["1.1.0", "1.0.0"], "tags": ["service"], "notes": "Listen for the lead vocal sibilance.",
  "tracks": [
    { "id": "t01", "name": "Kick", "file": "b1946ac92492d2347c6235b4d2611184", "role": "channel",
      "channels": 1, "duration": 312.4, "sizes": { "flac": 18200341, "hi": 3711002, "lo": 1850443 } }
  ] }
```

- `tracks` is in console order; each `role: "channel"` track becomes a mixer channel, in this order.
- `role`: `channel`, or `reference` for a finished mix to A/B against (at most one is used).
- `id` identifies the track within the session and should stay the same across versions when it is the same
  source, so a saved mix still lines up after a new version. `name` is the channel name.
- `file` identifies the audio content (its hash). The same content in five versions has the same `file`.
- `channels` is 1 or 2. `duration` is seconds. All tracks of a session start at the same moment.
- `sizes` are bytes of each quality below, shown to the user before loading.

## `GET /api/v1/files/<file>/<quality>`

The audio itself. `quality` is one of:

| quality | format | notes |
| --- | --- | --- |
| `flac` | FLAC, lossless | any sample rate; LiveWebMixer plays at 48 kHz and the browser converts |
| `hi` | Ogg Opus, 96 kbit/s mono or 160 kbit/s stereo | for remote use |
| `lo` | Ogg Opus, 48 kbit/s mono or 80 kbit/s stereo | for slow connections |

Requirements: correct `Content-Type` (`audio/flac`, `audio/ogg`), `Content-Length`, and `Range` support
(`206` with `Content-Range`). Content for a given `file` and quality never changes, so LiveWebMixer caches it forever.
All qualities of one session must be the same length and aligned to the sample.

## `GET` and `PUT /api/v1/sessions/<id>/versions/<version>/mixes/livewebmixer`

LiveWebMixer's mix file for that version: one JSON document that LiveVault stores and returns unchanged.

```json
{ "scenes": [ { "name": "Rough mix", "mixer": { } } ], "current": { } }
```

`GET` answers `404` (or `{ "scenes": [], "current": null }`) when nothing has been saved yet. `PUT` replaces the
document and answers `{ "ok": true }`. Documents can reach a few hundred kB. The contents are LiveWebMixer's
business; LiveVault may show the scene names (`scenes[].name`) but should not edit the rest.

## `PUT /api/v1/sessions/<id>/versions/<version>/recordings?name=<name>&start=<seconds>`

A Main LR take recorded in LiveWebMixer: the body is a WAV file (48 kHz, 16-bit stereo), `Content-Type: audio/wav`.
`start` is where in the song the take's first sample is. LiveVault keeps it with that version for review, linked to
the token owner's mix, and answers with the stored recording as JSON (at least `{ "id": "…" }`).

## Per-user mixes

LiveVault has logins, and each person makes their own token. LiveVault keeps the mix document (and the recordings)
per token owner, so each trainee has their own mix of every version. Nothing in LiveWebMixer needs to know.
