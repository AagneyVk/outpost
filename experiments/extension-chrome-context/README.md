# Chrome extension-owned Gecko context experiment

**Research fixture only. Do not install for real browsing or use credentials.** This does not provide a general OUTPOST extension or replace the existing relay. It launches a temporary extension in a disposable Chrome profile and uses fixed test inputs.

The experiment tests a different trust boundary from the [Firefox HTTPS fixture](../extension-firefox-gecko-tls/). Here the Gecko engine and the sample HTTPS code execute inside a top-level extension page. An ordinary localhost page cannot read the extension page or send it an external runtime message in the tested configuration. This is not a security audit or proof against compromised extension code, browser bugs, malicious guest content, or every message and frame attack.

On the tested Chrome 157, the top-level extension page was cross-origin isolated and had `SharedArrayBuffer` and the required WebAssembly APIs. Gecko loaded a local `data:` document. The web-oriented loader originally created a `blob:` script blocked by extension CSP; the test runner extracts the exact bundled Emscripten glue to a packaged extension file and makes the test loader use it. No CSP bypass or remote executable script is used. This is a packaging test, not yet a full extension build.

The optional HTTPS mode uses a separately patched research Gecko build and an extension-owned fixed-origin fetch. Chrome's debugger matches the host response and response body using a network request ID. It obtains a certificate chain with `Network.getCertificate`, but that lookup is **origin-keyed**, so it does not prove the chain belongs to the exact request. The HTTPS test injects a synthetic HSTS header; it does not test actual HSTS or redirects. Its transport serializes one fixed request, buffers the body and fabricates Gecko security information. The temporary HTTPS test extension requests Chrome's powerful `debugger` and `tabs` permissions; these may be unsuitable for a product and this experiment is not a recommendation to request them. The basic context test does not request these permissions.

There is also an experimental **delegated trust** mode. It keeps the fixture engine and network code within the extension page and accepts Chrome's TLS decision and request-specific `webRequest` certificate data. In the controlled Chrome 157 test, it displayed the top-level example.com document even when Chrome trusted the Norton inspection root, and the Gecko leaf fingerprint matched Chrome's request event. Chrome rejected the expired and self-signed badssl sites. The synthetic test intentionally does not load all page resources: its navigation-status flag reports failure when a subresource is blocked, so this is not a successful full-page compatibility test.

A separate **request-state** mode uses the Chrome debugger's request-specific security details and matching response bytes instead of asking for certificate DER. On the tested Chrome 157, it displayed the same top-level document without the certificate feature flag, including when Chrome trusted the Norton inspection root. Gecko exposed a synthetic security object with no server certificate; the test does not claim certificate details or a complete native TLS state. Chrome rejected the expired and self-signed test sites, and changing the captured response body caused the fixture to fail closed. A synthetic HSTS header was recorded; this does not establish handling of a real HSTS header. The test only allows one anonymous fixed URL, blocks its subresource, and does not demonstrate a complete page or browser.

**The request-state engine is unsafe to distribute.** Its Gecko patch accepts a test header that is not itself an authenticated transport. A production design must enforce the extension boundary all the way into the engine, reject any spoofed origin headers, preserve correct Gecko security semantics without pretending missing certificate or certificate-transparency details are available, and pass independent security review. It also relies on Chrome's sensitive `debugger` permission and CDP behavior, which is not a stable browser API; policies or other debuggers may prevent attachment. This is a feasibility result, not a production fix.

An **internal-channel** variant moves this evidence out of HTTP headers into a per-channel Gecko property, which is consumed when the mocked response is processed. The fixture clears any previously inherited property before setting a new one. In Chrome 157, the test loaded `example.com` and its single allowlisted `/s.js` resource with separate verified requests. It deliberately inserted a forged HTTP security header: when the internal property was absent, Gecko rejected the main navigation, reported no security information, and did not record the synthetic HSTS policy. Suppressing only the script's property caused the script request to fail even though the main page loaded. A modified response body was also rejected, and Chrome rejected the expired and self-signed test sites.

**The internal-channel variant is still not production code.** Its fixed-size virtual-file transport is controlled by test code and has no authenticated general-purpose request channel. The property is accessible to privileged Gecko code and is not a substitute for a fully specified trust boundary. The fixture supports two hardcoded URLs, no general redirects, cookies, binary streaming, WebSockets or real sign-ins. It still fabricates an incomplete Gecko security object without a certificate, and its HSTS input is synthetic. The external badssl services or antivirus interception can make tests fail for reasons other than the expected certificate errors; the tests do not treat those failures as success.

A separate local sign-in fixture exercises a small part of the Gecko-to-extension path: Gecko loads a local synthetic form, submits the fixed test fields with POST, receives a 302 and an HttpOnly session cookie, follows the redirect, and reaches a local account page. The test confirms that a synthetic host-browser cookie was not sent and the workspace cookie was not stored in Chrome's host cookie jar. A negative test supplies a different test password and checks that the fixture rejects it before contacting the authentication endpoint. This is not a real website or an HTTPS, CSRF, general cookie, portability, or third-party login test.

**Never use the local sign-in fixture with real credentials.** It encodes the form body in a virtual filesystem path, relies on a fixed-size, synchronous test transport, and prints synthetic request data. Its narrow allowlist is intentional. The [separate request-isolation fixture](../extension-request-isolation/) tests additional loopback redirect, streaming, cancellation, and WebSocket scenarios; those paths are not yet integrated with Gecko.

The public-demo variant submits the practice site's published synthetic credentials from the Gecko fixture through the extension to `practice.expandtesting.com` over HTTPS. In the tested Chrome 157 run, the login GET, authentication POST, 302, and secure-page GET were tied to Chrome network events with secure TLS state. Chrome's automatic follow-up was blocked; Gecko processed the redirect and sent its synthetic session cookies on the subsequent GET. A synthetic host-browser cookie and the private correlation marker were absent from the network request, and the demo session cookies were absent from Chrome's host cookie jar. The test received the site's secure-page text and logout link.

**This is a narrow test, not an installable login implementation.** The fixture only permits the demo's exact login, authentication, account and optional logout URLs and its published credentials; its Gecko hook encodes the form body in a virtual filename. It injects a restrictive CSP that blocks the site's scripts, fonts, images and styles, and does not forward pre-login cookies on the authentication POST. It does not test full-site rendering, CSRF, multi-factor authentication, arbitrary redirects, or real credentials. The Gecko security object still lacks certificate details and is only as trustworthy as the test-only per-channel handoff. Chrome's debugger permission, policies and unstable protocol remain release risks.

**The delegated engine is unsafe to distribute.** Its test-only Gecko patch accepts a fabricated header as proof of transport security and cannot enforce the extension's trust boundary itself. The test depends on Chrome's developer feature flag, a powerful debugger permission, a single serialized request, a synthetic HSTS header and no redirects. It does not establish that this can safely handle real websites or credentials. No such patch is included in the release engine.

Chrome's [webRequest documentation](https://developer.chrome.com/docs/extensions/reference/api/webRequest) describes certificate metadata, but in the tested Chrome 157 a normal listener observed the response while the security details were missing without the experimental `WebRequestSecurityInfo` feature. With the flag, a request-specific DER certificate and matching fingerprint were returned. Without that evidence, the delegated fixture fails closed.

On this machine Chrome reports that the connection to example.com is issued by Norton Web/Mail Shield Root. Chrome accepted the host connection, but the test Gecko verifier returned NSS `SEC_ERROR_UNKNOWN_ISSUER` (-8179) and rejected the navigation. The guest does not automatically inherit Chrome's trust decisions or trust store. Chrome rejected the expired.badssl.com connection with `ERR_CERT_DATE_INVALID`. No certificate exceptions or user trust-store changes were made.

## Run

Install this repository's Node dependencies and a current Chrome, then run from the repository root:

```powershell
node experiments/extension-chrome-context/run.mjs
node --test experiments/extension-chrome-context/response-binding.test.mjs
node experiments/extension-chrome-context/run-webrequest.mjs
```

The runner uses Chrome's unsafe-extension-debugging flag only for a disposable profile to load this temporary, unpacked fixture. It deletes the profile and temporary extension afterward. Set `OUTPOST_CHROME` for a nonstandard browser path. The runner copies the existing v7 engine into the temporary extension; it does not change the production engine.

The optional HTTPS mode needs the matching, locally built research engine. It is not committed and its build is not currently a standalone reproducible recipe. For the locally observed failed navigation, use:

```powershell
$env:OUTPOST_FIXTURE_BUILD = 'C:\path\to\build-ordered'
$env:OUTPOST_EXPECT_REJECTION = '1'
$env:OUTPOST_EXPECT_ERROR = '-8179'
node experiments/extension-chrome-context/run.mjs
Remove-Item Env:OUTPOST_EXPECT_ERROR
Remove-Item Env:OUTPOST_EXPECT_REJECTION
Remove-Item Env:OUTPOST_FIXTURE_BUILD
```

Without `OUTPOST_EXPECT_REJECTION`, HTTPS mode instead requires Gecko to load the valid page. That positive result has not been established on this machine. Neither setting bypasses certificate validation.

For delegated trust, use a **separate test-only** build made with `delegated-engine/` as `/lab` in the matching local builder. Its source is provided to make the experiment reviewable, not as a production build. The local builder image and preparation are not included. Set `OUTPOST_FIXTURE_BUILD` to its output and run this diagnostic comparison:

```powershell
$env:OUTPOST_DELEGATED_TEST = '1'
$env:OUTPOST_EXPECT_MISSING_INFO = '1'
node experiments/extension-chrome-context/run.mjs
Remove-Item Env:OUTPOST_EXPECT_MISSING_INFO
$env:OUTPOST_ENABLE_SECURITY_INFO = '1'
node experiments/extension-chrome-context/run.mjs
Remove-Item Env:OUTPOST_ENABLE_SECURITY_INFO
Remove-Item Env:OUTPOST_DELEGATED_TEST
```

The first run confirms it fails closed without the metadata. The second runs Chrome with a developer flag for research only; it must not be presented as an ordinary user setup. The engine's `navigation` field can be `failed` because the fixture blocks subresources even when the main example.com document is displayed.

For request-state mode, build a second disposable engine with the files in `state-engine/` overlaid on the `delegated-engine/` build sources, then set `OUTPOST_FIXTURE_BUILD` to that engine's output:

```powershell
$env:OUTPOST_STATE_TEST = '1'
node experiments/extension-chrome-context/run.mjs
$env:OUTPOST_STATE_TAMPER = '1'
node experiments/extension-chrome-context/run.mjs
Remove-Item Env:OUTPOST_STATE_TAMPER
Remove-Item Env:OUTPOST_STATE_TEST
```

The second command checks that deliberately changed response bytes are rejected. Both commands use the debugger permission and a temporary, unpacked extension; neither enables `WebRequestSecurityInfo` or bypasses Chrome's certificate validation.

For the internal-channel variant, overlay `internal-engine/` on the `delegated-engine/` source files when preparing a fresh disposable `/lab` build, then point `OUTPOST_FIXTURE_BUILD` at its output. The builder image is not included. Run the following separately:

```powershell
$env:OUTPOST_INTERNAL_TEST = '1'
node experiments/extension-chrome-context/run.mjs
$env:OUTPOST_STATE_NO_EVIDENCE = '1'
node experiments/extension-chrome-context/run.mjs
Remove-Item Env:OUTPOST_STATE_NO_EVIDENCE
$env:OUTPOST_INTERNAL_NO_SCRIPT_EVIDENCE = '1'
node experiments/extension-chrome-context/run.mjs
Remove-Item Env:OUTPOST_INTERNAL_NO_SCRIPT_EVIDENCE
$env:OUTPOST_STATE_TAMPER = '1'
node experiments/extension-chrome-context/run.mjs
Remove-Item Env:OUTPOST_STATE_TAMPER
Remove-Item Env:OUTPOST_INTERNAL_TEST
```

For the synthetic Gecko form, prepare a disposable build by overlaying `internal-engine/` and then `signin-engine/` on `delegated-engine/`, and set `OUTPOST_FIXTURE_BUILD` to its output:

```powershell
$env:OUTPOST_LOCAL_SIGNIN_FORM = '1'
node experiments/extension-chrome-context/run.mjs
Remove-Item Env:OUTPOST_LOCAL_SIGNIN_FORM
$env:OUTPOST_LOCAL_SIGNIN_WRONG = '1'
node experiments/extension-chrome-context/run.mjs
Remove-Item Env:OUTPOST_LOCAL_SIGNIN_WRONG
```

For the public HTTPS demo, overlay `public-demo-engine/` last on that disposable sign-in build, set `OUTPOST_FIXTURE_BUILD` to its output, and run:

```powershell
$env:OUTPOST_PUBLIC_DEMO_FORM = '1'
node experiments/extension-chrome-context/run.mjs
Remove-Item Env:OUTPOST_PUBLIC_DEMO_FORM
```

This contacts an external demo service, which can change or be unavailable, and uses only the test credentials published by that service. The locally built compiler image and binary are not included in the repository.

For additional diagnostics, overlay `public-logout-engine/` last and build a new disposable engine. This overlay forces `Cache-Control: no-store` for test responses so the diagnostic can observe a fresh protected-page request. It does **not** implement faithful cache-header forwarding. On Chrome 157, `OUTPOST_PUBLIC_DEMO_LOGOUT_POINTER=1` passed twice: it clicked the logout link on the Gecko canvas, observed the HTTPS logout redirect, and saw the server redirect a subsequent protected-page request to the login form. `OUTPOST_PUBLIC_DEMO_LOGOUT_DIRECT=1` and the DOM `.click()` diagnostic (`OUTPOST_PUBLIC_DEMO_LOGOUT=1`) each passed once with the rebuilt engine. The earlier click failure's cause was not isolated. These results establish only the demo's observed logout flow, not server-side revocation of a copied session or general-site logout behavior.

Using the same disposable engine, `OUTPOST_PUBLIC_DEMO_PORTABLE=1` signs in with the demo credentials, encrypts a narrowly scoped session-cookie snapshot using the existing portable envelope, and opens it in a second temporary Chrome profile. The restored guest reached the demo's protected page; wrong-password and modified-ciphertext attempts were rejected, the two cookie records and their attributes round-tripped, and a duplicate restore was rejected without changing them. Both host cookie stores retained only their synthetic host canary. This is not a complete workspace export or cross-device test: the fixture snapshots only the demo site's two session cookies, transports only synthetic data, and does not test all cookie attributes, persistent cookies, concurrent restore, or the user's extension UI. Immutable JavaScript strings containing synthetic cookie data cannot be reliably erased.

```powershell
$env:OUTPOST_PUBLIC_DEMO_LOGOUT_POINTER = '1'
node experiments/extension-chrome-context/run.mjs
Remove-Item Env:OUTPOST_PUBLIC_DEMO_LOGOUT_POINTER
$env:OUTPOST_PUBLIC_DEMO_PORTABLE = '1'
node experiments/extension-chrome-context/run.mjs
Remove-Item Env:OUTPOST_PUBLIC_DEMO_PORTABLE
```

Both diagnostics require `OUTPOST_FIXTURE_BUILD` to refer to the matching local engine. The locally built compiler image and binary are not included. Never use real credentials; the fixture sends the published synthetic credentials through a test-only virtual file path.

## Work still required

The user-facing extension must securely bind the response, its URL and redirects, and request-specific TLS state without trusting a web page or an origin-keyed certificate lookup. Its treatment of the host's enterprise or antivirus trust roots needs a deliberate, tested policy. General requests, streaming, cookies, CORS, origin headers, HSTS, WebSockets, errors, concurrent requests, sign-ins, installation and updates are unimplemented. The extension-owned context also changes the hosting and workspace-storage model; compatibility with OUTPOST's existing UI and encrypted portable workspaces remains untested. Independent security review and real browser compatibility tests are still needed before release.

Chrome's [cross-origin isolation documentation](https://developer.chrome.com/docs/extensions/develop/concepts/cross-origin-isolation) describes the top-level extension configuration and its iframe limitations. Mozilla's [WebExtension CSP documentation](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/manifest.json/content_security_policy) describes allowing WebAssembly without general JavaScript evaluation.
