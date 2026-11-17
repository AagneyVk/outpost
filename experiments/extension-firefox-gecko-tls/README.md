# Firefox-to-Gecko HTTPS research fixture

**Unsafe research code, not an extension for users. Do not install it for browsing, use real credentials, or ship its test Gecko engine.** The page-to-extension messages and the response header used to feed TLS evidence into Gecko are deliberately unauthenticated. The fixture fabricates a transport security object and does not independently validate the certificate chain. A forged self-signed certificate for the requested host is accepted by the test Gecko, even though Firefox itself rejects an actual connection with such a certificate. A successful test run does not imply the bridge is secure.

This experiment explores whether a Firefox extension can pass request-specific, host-verified HTTPS certificate information to an embedded Gecko. It uses one outstanding anonymous request at a time, a fixed allowlist, a fresh temporary Firefox profile, and disposable loopback test pages. It is separate from the OUTPOST release engine, the default relay, and the Chrome extension experiment. It requires a recent Firefox; it does not establish Chrome compatibility.

## Observed results

With Firefox 160 and the disposable patched WASM engine used for this experiment:

* Firefox fetched `https://example.com/`, supplied request-specific verified DER certificate data, and Gecko exposed the same leaf fingerprint on the fixture channel.
* Gecko rejected missing evidence and a valid certificate copied from a different hostname. The fixture uses Gecko's strict `mozilla::pkix::CheckCertHostname` routine for the latter check.
* Firefox rejected the expired and self-signed public badssl.com test endpoints. The test makes no certificate exceptions.
* A synthetic HSTS header added by the fixture was recorded by Gecko in the corresponding storage partition. This does **not** establish correct handling of real response headers or redirects.
* A separate adversarial run replaces the evidence with a synthetic self-signed certificate for `example.com`. Gecko accepts it. This documents the unresolved security vulnerability; the second run deliberately asserts the current unsafe behavior so changes to it are visible.

The extension obtains metadata with [Firefox's `webRequest.getSecurityInfo`](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/API/webRequest/getSecurityInfo). Firefox verifies the actual host connection; the unsafe handoff afterward can be tampered with. Hostname verification alone is not chain or trust verification. Other TLS properties are absent or fabricated in the test object. The public synthetic certificate in this directory has no associated private key here and is only test data.

## Running the tests

These tests use a local debugger to install an unsigned **temporary** extension into a disposable profile. They contact the public test sites and need a current Firefox and Node.js. Set `OUTPOST_FIREFOX` to the Firefox executable. No user profile should be used.

```powershell
$env:OUTPOST_FIREFOX = 'C:\path\to\firefox.exe'
node experiments/extension-firefox-gecko-tls/run.mjs
```

The integrated test additionally needs the exact patched Gecko/WASM artifacts. They are not committed: `OUTPOST_FIXTURE_BUILD` must point to a directory containing `gecko.js` and `gecko.wasm.zst` from this fixture build.

```powershell
$env:OUTPOST_FIXTURE_BUILD = 'C:\path\to\build-ordered'
node experiments/extension-firefox-gecko-tls/run-gecko.mjs
$env:OUTPOST_FORGED_TEST = '1'
node experiments/extension-firefox-gecko-tls/run-gecko.mjs
Remove-Item Env:OUTPOST_FORGED_TEST
```

`build.sh` and the patch scripts record the build steps used with a locally prepared `outpost-gecko-bridge-order:local` image, `/build/firefox`, `/build/gecko.js`, the matching Emscripten output tree and `/lab` pointing to this directory. That image and its complete reproducible preparation are not included, so this is not yet a standalone build recipe. For repacking, set `OUTPOST_BASE_BUNDLE` to the matching Gecko loader bundle, put `generated-gecko.js`, `gecko.data.zst`, `gecko.wasm.zst` and `gecko-assets.json` in this directory's `build-ordered`, and run `node repack-gecko-fixture.mjs --ordered`. Do not replace the production engine with its outputs.

## Release blockers

The evidence must be securely bound to the exact request and response under a clear threat model, or Gecko must independently verify the complete chain and trust policy. This fixture does neither. A real implementation also needs correct handling of redirects, HSTS, cookies, request bodies and headers, streaming, concurrent requests, failures and cancellation, WebSockets, and modern sign-in flows; these are not demonstrated here. It needs a supported distribution model and browser-specific compatibility testing. No real-site sign-in or cross-device portability claim follows from this experiment.
