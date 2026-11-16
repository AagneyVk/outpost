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

On 2026-11-16, the local fixture reached the secure page using the published
demo credentials. Chrome's cookie store for the demo remained empty. A separate
synthetic persistent cookie survived copying Gecko profile files to a second
Chrome profile, but the demo sign-in **did not** survive that copy. This test
found that the two demo authentication cookies had neither `Expires` nor
`Max-Age`; it does not cover encrypted OUTPOST workspace export/import. Mozilla documents
that [Firefox Session Restore includes session cookies](https://firefox-source-docs.mozilla.org/browser/components/sessionstore/docs/index.html);
the fixture's missing session-restore module is a possible factor, not a
confirmed complete diagnosis.

The HTTPS test in the related [bridge experiment](../extension-bridge/README.md)
found the synthetic Gecko channel had no transport security information. Host
Chrome rejecting an invalid certificate does not establish that Gecko has
correct security state, HSTS behavior or security UI. These remain release
blockers, together with session portability, request isolation, safe general
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
node experiments/extension-gecko-demo/run-gecko-fixture.mjs --ordered --demo
```

The runner uses disposable Chrome profiles and removes them afterward. It
reports the fresh-profile result separately; `false` documents a limitation,
not a passing portability result. The demo service is external and may change
or become unavailable. Firefox source modifications remain subject to MPL-2.0.
