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
- **LiveVault link:** browse your LiveVault library from Setup, play a session version straight from LiveVault with nothing copied, and save mixes and scenes back to that version.
- **Record** the Main LR mix while the song plays, then download the take as a WAV or keep it in LiveVault, linked to the session version and your mix, for review.
- **Server plugins:** insert Linux VST3 plugins on input channels and the main bus. They run on the server, and the other channels are delay-compensated so everything stays lined up.
- MIDI controller support with learn (faders, mutes, selects, master, play) that follows the current layer.

## Install

```
docker compose up -d
```

Open **https://<server IP>:8443** and accept the certificate warning once.

Browsers only allow the audio engine and MIDI on https (or localhost), so the container makes its own self-signed certificate. Port 8080 is plain http for a reverse proxy that adds https itself; with a proxy and a real certificate there is no warning, and that is the way to reach it from outside your network. To use your own certificate files, set `TLS_CERT` and `TLS_KEY` to their paths inside the container.

For TrueNAS, paste `truenas-app.yaml` into Apps > Discover Apps > Custom App > Install via YAML.

Everything (songs, scenes, templates, plugins, certificate) is kept in the `livewebmixer-data` volume.

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

## LiveVault

In Setup, the **LiveVault library** card takes the LiveVault address and an access token. Once connected it lists the sessions; pick one, pick a version, and open the mixer. Tracks are fetched from LiveVault through this server (the browser never sees the token), cached in the browser, and never copied into LiveWebMixer. The current mix and scenes are stored with that session version in LiveVault.

In LiveVault, make the access token under **My account > Access tokens**. It acts as you: the library shows the sessions you may see, and mixes and takes are saved under your name (one mix per person for each version). Use LiveVault's http port as the address, for example `http://192.168.1.20:9580`. **Open in LiveWebMixer** on a session in LiveVault opens that version here.

**● Record** in the transport bar starts playback and records the Main LR bus (after the master fader, no matter which mix you are listening to). Pause, move the play position or reach the end to finish the take; name it, listen back, and download it or save it to LiveVault, where it sits with the session version for review notes. Loop switches off while recording so the take lines up with the song, and the delay of server plugins is allowed for.

The interface LiveVault has to offer is written down in `docs/LIVEVAULT-API.md`, and `test/mock-vault.js` is a small working example of it.

## Server plugins (VST3)

A browser cannot load VST plugins, so LiveWebMixer runs them in the container and sends the channel's audio there and back.

1. In Setup, under **Server plugins**, upload a zip of the plugin's `.vst3` folder. It has to be a **Linux** build for the server's processor (the folder contains `Contents/x86_64-linux`). Mac and Windows VST3 files cannot run here.
2. In the mixer, *＋ Add processing* on an input channel or Main LR lists the installed plugins.
3. Adjust the plugin with the sliders in its card. There is no plugin window.

What to expect:

- Audio through a plugin comes back a fixed time later (the **Round trip** setting, 250 ms by default). Every other channel is held back by the same amount, so the mix stays in time and faders, EQ and the rest still respond instantly. Only the plugin's own controls, and Play/Stop, are heard that much later.
- If the connection is too slow for the chosen round trip, the plugin card says how much audio arrived late; that audio is heard unprocessed instead of dropping out. Raise Round trip.
- A plugin that crashes takes the plugin host down for a moment; it restarts by itself and that plugin is refused until you upload it again.
- Plugins run with the container's permissions. Only install plugins you trust.

The plugin host is Spotify's [pedalboard](https://github.com/spotify/pedalboard) library (GPL-3.0), installed in the image.

## Good to know

- Tracks are held in browser memory while a song is open (the Setup window shows the estimate). Around 32 mono tracks of a five-minute song is about 1 GB; use a desktop browser for big sessions and fold dual-mono stems to mono.
- All tracks are assumed to start at the same point, as multitrack exports do.
- Output latency depends on the computer's audio device and is shown in the transport bar.
- MIDI works in Chrome and Edge.

## Updating

Versions are major.minor.patch in `package.json`. A push to `main` builds and publishes `ghcr.io/leonidis2013/livewebmixer` (`latest` and the version tag).

`npm test` runs a smoke test of the server (no packages to install). The GitHub build also runs `test/vst.js` and `test/run.js` inside the finished image before publishing it.
