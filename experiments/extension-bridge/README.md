# Experimental extension bridge

This is a **local research fixture**, not an installable OUTPOST extension or a
relay replacement. It only accepts requests from a top-level page on
`127.0.0.1` to fixed paths on that same origin, plus anonymous GETs to
`example.com` and two badssl certificate test hosts. It only accepts two
synthetic cookie values. It cannot browse arbitrary sites. Do not install it
into a normal browser profile or use it with real credentials.

The experiment investigates whether a Gecko HTTP channel can hand requests to a
Chrome extension after Gecko has enforced a CORS preflight, and whether Gecko can
retain a synthetic login in its own profile. It leaves OUTPOST's production
browser and Wisp relay unchanged.

## Run the extension fixture

Install Node.js 24+, Google Chrome, and this repository's dependencies:

```sh
npm ci
node experiments/extension-bridge/run.mjs
```

Set `OUTPOST_CHROME` to the Chrome executable path if Chrome is installed in a
nonstandard location. The test creates a loopback server and two disposable
Chrome profiles, and loads the unpacked fixture using Chrome's
`Extensions.loadUnpacked` test interface. The unsafe debugging flag is used
only for those disposable profiles.

The test checks a synthetic login and redirect, cookie isolation, simultaneous
callers, oversized-response rejection, rejected frame access, and transfer of a
test cookie to a second fresh profile. It does not use a real login.

## Gecko experiment

The ordered fixture was tested with the Firefox source revision
`2e1e835a5da5907e5ceef19aade58a7493f1e34d` and an existing local
[firefox-wasm build](../../tools/gecko-wasm/README.md). Its build scripts expect
the source tree at `/build`, an existing release object directory and an
isolated read-only fixture mount at `/lab`. The large generated Gecko builds,
compiler image and browser profiles are not included in the repository.
Rebuilding requires reproducing the compatible pinned build environment; the
shell scripts are a record of the experiment, not a one-command setup.

In the local test, a modified Gecko engine sent only the allowed synthetic
cross-origin POST through the extension after preflight. It received a local
HTTP response through the extension and followed a synthetic login redirect.
The test copied Gecko profile files to a fresh browser profile and restored the
test login. It did **not** test OUTPOST's encrypted export/import.

A separate opt-in test (`run-gecko-fixture.mjs --ordered --https`) fetched
`example.com` through the extension and loaded its response inside Gecko.
Chrome rejected the expired and self-signed badssl test certificates. In the
tested Gecko build, the resulting HTTPS channel had **no transport security
information**, although the document reported a secure context. This is a
release blocker: the experiment does not yet preserve Gecko's certificate state
or security UI. HSTS and other security behavior must also be verified.

For research only, adding `--security-info` starts the temporary test Chrome
with the experimental `WebRequestSecurityInfo` feature flag. The tested Chrome
then exposed certificate metadata to the extension. Without the flag, it did
not; the flag is not an acceptable production requirement for ordinary users,
and this experiment does not transfer that metadata into Gecko.

The first response-override approach skipped preflight and lost redirect cookies.
The lab patches change that behavior for the test; they are not suitable for
release. In particular, the fixture uses a blocking, fixed-size file-provider
bridge, hardcoded test domains and cookies, and synthetic preflight responses.
General request scheduling, cancellation, streaming, redirects across origins,
real website sign-in, cookie attributes, certificate/security state, HTTPS,
WebSockets, concurrency and abuse resistance require implementation and review.
The original Gecko observer sees the request before preflight, so a real bridge
must not dispatch the request from that earlier observer.

The Gecko source patches must retain the upstream project's applicable
[MPL-2.0 license](https://www.mozilla.org/en-US/MPL/2.0/).
