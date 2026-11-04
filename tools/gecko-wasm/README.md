# OUTPOST Gecko Lab

This isolated prototype uses the upstream minimal embedding API with OUTPOST-owned host UI. The smoke fixture uses a data URL and sends no workspace to the engine. Its timer measures through the navigation call. Use a visible fixture pixel and trusted input to measure readiness in subsequent benchmarks.

## Run the lab

The lab targets the [v0.0.1 release](https://github.com/HeyPuter/firefox-wasm/releases/tag/v0.0.1). Extract `gecko.js/dist/gecko.js` and `gecko.js/dist/gecko.wasm.zst` from its library archive into `public/gecko-lab/engine/`. The release inlines the minimal GRE into the JavaScript bundle. Keep the upstream MPL-2.0 notices and source revision with any distribution.

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

To build native page zoom, run `python3 /path/to/outpost/tools/gecko-wasm/patch-native-zoom.py "$PWD"` after checking out the pinned revision and before building. The patch adds a bounded command to set the windowless browsing context's full zoom. OUTPOST enables it only when the engine advertises the capability. Rebuild and replace both the JavaScript bundle and WASM together, then verify that zoom redraws text while the canvas backing dimensions stay fixed.

The source checkout is for engine development. Check its generated API and artifact names before substituting a custom build for the release bundle.

The lab uses the minimal GRE and skips the desktop Firefox frontend. The experimental JavaScript JIT is disabled.

## Portable profiles

To use a separate relay, expand **Network settings** before starting Gecko and enter its `wss://` URL. The relay must support Wisp and accept WebSocket upgrades from the preview's origin. Leave the field blank for OUTPOST's bundled relay.

Close the running OUTPOST browser tab, then reopen OUTPOST and expand **Encrypted browser profile** before starting Gecko. Enter a passphrase of at least 16 characters and export. On another browser, select the export and enter its passphrase, import, then start Gecko. An import is staged in a separate profile directory before it becomes active.

The export is encrypted on the device. The active profile is stored in the host browser's origin storage. On a borrowed computer, clear OUTPOST's site data after verifying that you have your export. Keep the passphrase and matching engine build.

With the development dependencies installed and the preview running, run `node tools/gecko-wasm/verify-profile.mjs` to check that a fresh Chrome context restores a persistent HttpOnly cookie. This test uses a synthetic HTTP site over an intercepted WebSocket. Live HTTPS navigation is covered separately by `verify-https.mjs`.

## Linux tools

The browser toolbar's Files page stores uploads in browser storage without starting Linux. In the full local checkout, Terminal starts Linux on demand and connects the browser terminal directly to a guest serial console. Terminal's own Files panel uses the Linux filesystem. Browser files, Gecko profile exports, and Linux workspace exports are separate. The standalone browser archive omits the Linux runtime.
