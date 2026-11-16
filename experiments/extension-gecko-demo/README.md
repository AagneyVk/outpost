# Gecko-to-extension public login experiment

This is an **isolated research fixture**, not an installable OUTPOST extension,
production transport, or a replacement for the current relay. Do not use real
credentials or install it in an everyday browser profile. The localhost test
page and extension are intentionally restricted to the documented fixture
routes and the public automation demo at
<https://practice.expandtesting.com/login>. The extension permits only the
demo's published username and password for that site's authentication request.

The test loads the demo's real HTML form into a modified Gecko WebAssembly
engine, submits it through the extension, and checks the protected page and the
host Chrome cookie store. It injects a restrictive CSP into the returned HTML
to block scripts, fonts, images, and stylesheets, including third-party
resources. Therefore it is a form-and-session test, **not** an unmodified
full-page compatibility test. The fixture transfers responses and a bounded
request body via encoded virtual filesystem paths, blocks an engine thread,
buffers responses, allows at most two Set-Cookie headers, and serializes
requests. Never adapt this mechanism for real credentials.

On 2026-11-16, the fixture reached the secure page using the published demo
credentials. Chrome's cookie store for the demo remained empty. The two demo
authentication cookies are session cookies: copying the profile files alone
did not restore the login. A test-only Gecko command now captures only these
two synthetic cookies and their attributes, seals them using OUTPOST's
`portable.js` encrypted envelope, and restores them before the first visit in
a second disposable Chrome profile. The secure demo page then loads; wrong
passphrases, tampering and duplicate restoration are rejected, and the captured
attributes match after restore.

This is a constrained feasibility test, **not** a fix for portable logins in
OUTPOST. It does not use the product's complete profile export/import flow,
generalize to other cookies or origins, ensure atomic restoration on errors,
or support logout and conflict handling. The fixture serializes session-cookie
data in memory and must never be used with real credentials. Mozilla documents
[Firefox's session restore](https://firefox-source-docs.mozilla.org/browser/components/sessionstore/docs/index.html),
which is missing components in this stripped-down embedder.

The HTTPS test in the related [bridge experiment](../extension-bridge/README.md)
found the synthetic Gecko channel had no transport security information. Host
Chrome rejecting an invalid certificate does not establish that Gecko has
correct security state, HSTS behavior or security UI. In the inspected Firefox
source, `nsHttpChannel::ProcessSecurityHeaders()` skips HSTS processing when
`mSecurityInfo` is absent. The channel nevertheless reports a secure document
context. This remains a release blocker, not a successful HTTPS fix. Other release
blockers include session portability, request isolation, safe general
upload and response streaming, arbitrary headers, cross-origin redirects,
WebSockets, errors, cancellation, multiple simultaneous requests, third-party
cookies, and security review.

## Running the recorded experiment

Use Node.js 24+, `npm ci`, Chrome, and an already built compatible ordered
fixture engine. The scripts record modifications to the Firefox revision
`2e1e835a5da5907e5ceef19aade58a7493f1e34d` and require the existing isolated
`/build` tree and a read-only `/lab` mount. The compiler environment and large
generated engine are not included; the build script is not a complete
reproducible setup from a fresh checkout.

Set `OUTPOST_FIXTURE_BUILD` to the directory containing the matching fixture's
`gecko.js` and `gecko.wasm.zst`; optionally set `OUTPOST_CHROME` to Chrome's
executable. Then run:

```sh
node experiments/extension-gecko-demo/run-gecko-fixture.mjs --ordered --demo --https
```

The runner uses disposable Chrome profiles and removes them afterward. It
checks the encrypted synthetic session separately from the profile-file copy.
The demo service is external and may change or become unavailable. A previous
run also failed when Chrome returned a response without matching webRequest
metadata; the fixture rejected it, and the intermittent failure is unresolved.
Firefox source modifications remain subject to MPL-2.0.
