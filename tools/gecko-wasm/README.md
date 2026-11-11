# OUTPOST Gecko Lab

This isolated prototype uses the upstream minimal embedding API with OUTPOST-owned host UI. The smoke fixture uses a data URL and sends no workspace to the engine. Its timer measures through the navigation call. Use a visible fixture pixel and trusted input to measure readiness in subsequent benchmarks.

## Run the lab

The lab targets the [v0.0.1 release](https://github.com/HeyPuter/firefox-wasm/releases/tag/v0.0.1), with the source patches described below. The customized JavaScript bundle and compressed WASM are shipped together in `public/gecko-lab/engine/`; the bundle inlines the minimal GRE. Keep the upstream MPL-2.0 notices and source revision with any distribution.

Start OUTPOST's local server and open `/`. Click Start browser and enter a public HTTP or HTTPS URL in the address bar. Gecko validates HTTPS certificates inside the engine.

The standalone preview archive includes the engine and the relay's runtime dependencies. Extract it, run `npm start` with Node 24+, and open `http://127.0.0.1:3001/gecko-lab/index.html`. The default example uses HTTP for local testing. Use [HOSTING.md](../../HOSTING.md) to rehearse authenticated HTTPS delivery. The current Windows relay encounters outbound certificate substitution, so local HTTPS navigation remains a failing release check.

## Source build exploration

On Linux, install the upstream prerequisites, including Node, pnpm, Python, libpulse development headers, and the upstream Rust toolchain with rust-src and wasm32-unknown-emscripten. Build in a separate directory with no workspace archives or credentials.

```sh
git clone https://github.com/HeyPuter/firefox-wasm.git
cd firefox-wasm
git checkout --detach bc69aaa5e2c5388bcf93a43b975b490bb940f4c0
make libxul RELEASE=1
```

The distributed engine applies `patch-native-zoom.py`, `patch-input-latency.py`, `patch-trackpad.py`, and `patch-zoom-render.py` to that pinned revision before building, in that order. The patches wake the command mailbox, preserve fractional wheel input, use Gecko's default scroll handling, and render native page zoom in device pixels with correctly mapped input coordinates. Apply the scripts before `make libxul RELEASE=1`. Apply the host-only `patch-scroll-paint.mjs` to the resulting JavaScript bundle and publish it together with its matching WASM as `gecko-input-v4.js` and `gecko-input-v4.wasm.zst`. It processes software wheel input without an immediate redundant repaint; the regular paint loop displays the latest state. Keep earlier engine pairs available so a cached older app does not combine incompatible assets. Native zoom is applied after a page exists, including when restoring a saved session.

To compare an experimental build without changing the running application, start `node tools/gecko-wasm/test-engine-server.mjs /path/to/gecko.js/dist` and run the checks against `http://127.0.0.1:3002/`. `OUTPOST_BENCH_URL=http://127.0.0.1:3002/ node tools/gecko-wasm/input-benchmark.mjs --wheel` measures a synthetic 80-event scroll burst and a following key; the page verifies the complete scroll delta and the key. `node tools/gecko-wasm/measure-scroll-display.mjs` measures how far a synthetic scroll gesture is ahead of a marker painted by Gecko; add `--baseline` to compare the previous bitmap-scaled release. Set `OUTPOST_MEASURE_ZOOM=150` to measure at 150% zoom. These tests do not predict latency on all sites or devices. Also run `verify-interaction.mjs`, `verify-zoom.mjs`, `verify-redirect.mjs`, `verify-profile.mjs`, and `verify-https.mjs` against the test server before replacing release assets.

`verify-drag.mjs` checks scrollbar dragging and releasing a pointer outside the canvas. The current engine does not pass the scrollbar check; `--skip-scrollbar` runs the outside-release check on its own while the scrollbar issue is investigated.

`verify-trackpad.mjs` checks fractional and reverse wheel deltas, nested and horizontal scrolling, canceled events, line-mode input and a real browser wheel event. It uses synthetic content and cannot replace testing a physical touchpad across devices.

The source checkout is for engine development. Check its generated API and artifact names before substituting a custom build for the release bundle.

The lab uses the minimal GRE and skips the desktop Firefox frontend. The experimental JavaScript JIT is disabled.

## Portable profiles

To use a separate relay, expand **Network settings** before starting Gecko and enter its `wss://` URL. The relay must support Wisp and accept WebSocket upgrades from the preview's origin. Leave the field blank for OUTPOST's bundled relay.

Close the running OUTPOST browser tab, then reopen OUTPOST and expand **Encrypted browser profile** before starting Gecko. Enter an eight-character passphrase containing a number and a symbol, with no spaces, and export. On another browser, select the export and enter its passphrase, import, then start Gecko. An import is staged in a separate profile directory before it becomes active.

The export is encrypted on the device. The active profile is stored in the host browser's origin storage. On a borrowed computer, clear OUTPOST's site data after verifying that you have your export. Keep the passphrase and matching engine build.

With the development dependencies installed and the preview running, run `node tools/gecko-wasm/verify-profile.mjs` to check that a fresh Chrome context restores a persistent HttpOnly cookie. This test uses a synthetic HTTP site over an intercepted WebSocket. Live HTTPS navigation is covered separately by `verify-https.mjs`.

## Linux tools

The browser toolbar's Files page stores uploads in browser storage without starting Linux. In the full local checkout, Terminal starts Linux on demand and connects the browser terminal directly to a guest serial console. Terminal's own Files panel uses the Linux filesystem. Browser files, Gecko profile exports, and Linux workspace exports are separate. The standalone browser archive omits the Linux runtime.
