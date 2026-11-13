# LiveWebMixer

A web-based multitrack mixing console for audio training. Load the stems of a song, get one mixer channel per track, and practice mixing in the browser.

- Runs in one Docker container, controlled entirely from a web page.
- **Low latency:** the mix engine runs inside your browser (Web Audio + AudioWorklet). The server only stores and hands out the tracks, so a fader move never crosses the network.
- **Bandwidth optimized:** every upload is converted once to Lossless (FLAC), High and Low (Opus). You pick the quality per session; tracks download once and stay cached in the browser.
- **Workflow:** Setup window → load tracks → *Open mixer* → channels are generated from the tracks.
- **Templated, free-flow channel processing:** each channel starts from a template (picked by track name or chosen by you). Add, remove, bypass and reorder HPF, LPF, gate, parametric EQ, compressor and de-esser blocks in any order, and save your own templates.
- 6 aux mixes (pre/post sends), 4 groups, 4 DCAs, reverb and delay FX sends, PFL, main LR.
- Three layouts over the same mix: **SQ** (layers, selected-channel processing, sends on faders), **Console** (all strips, channel panel at the side), **DAW** (insert slots and sends on every strip).
- Scenes per song, automatic save of the current mix, and Reference A/B against a finished mix.
- MIDI controller support with learn (faders, mutes, selects, master, play) that follows the current layer.

## Install

```
docker compose up -d
```

Open **https://<server IP>:8443** and accept the certificate warning once.

Browsers only allow the audio engine and MIDI on https (or localhost), so the container makes its own self-signed certificate. Port 8080 is plain http for a reverse proxy that adds https itself; with a proxy and a real certificate there is no warning, and that is the way to reach it from outside your network. To use your own certificate files, set `TLS_CERT` and `TLS_KEY` to their paths inside the container.

For TrueNAS, paste `truenas-app.yaml` into Apps > Discover Apps > Custom App > Install via YAML.

Everything (songs, scenes, templates, certificate) is kept in the `livewebmixer-data` volume.

There is no sign-in. Keep it on your own network or behind a proxy that asks for a password.

## Using it

1. **Setup:** add a song, then drop its track files (WAV, AIFF, FLAC, MP3, M4A) or one zip of the whole song. Leading track numbers are dropped from names, and upload order follows the file names. Rename, reorder, fold stereo files to mono, or mark a track as the *Reference mix* (a file named like "Full Mix" is marked automatically).
2. Pick the channel template (or *Auto, by track name*) and the audio quality, then **Open mixer**.
3. Faders start down, like a console at the start of a sound check. Press Play (or Space) and build the mix.
4. Click a channel name to select it. Its signal flow is shown left to right: *In/Out* bypasses a block, the arrows move it earlier or later, *＋ Add processing* adds another.
5. In the SQ layout, the **Mix** buttons on the right put the sends to that aux or effect on the faders.
6. **Listen** chooses what the headphones hear (main or an aux mix). **Reference A/B** switches to the reference track; the small slider beside it level-matches it.
7. **Scenes** saves and recalls whole mixes. *Start over from templates* gives a clean console.

Shift-drag a fader for fine moves, double-click it for 0 dB. Double-click most sliders to reset them.

## Good to know

- Tracks are held in browser memory while a song is open (the Setup window shows the estimate). Around 32 mono tracks of a five-minute song is about 1 GB; use a desktop browser for big sessions and fold dual-mono stems to mono.
- All tracks are assumed to start at the same point, as multitrack exports do.
- Output latency depends on the computer's audio device and is shown in the transport bar.
- MIDI works in Chrome and Edge.

## Updating

Versions are major.minor.patch in `package.json`. A push to `main` builds and publishes `ghcr.io/leonidis2013/livewebmixer` (`latest` and the version tag).

`npm test` runs a smoke test of the server (no packages to install).
