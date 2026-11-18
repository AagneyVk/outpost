# Per-request Chrome transport research

**This is a disposable research fixture, not an installable OUTPOST extension. Do not use real credentials or arbitrary websites.** It runs only against temporary loopback servers with synthetic cookies and deletes its temporary Chrome profile and unpacked extension. It does not change the production relay or the Gecko engine.

## What was tested

On Chrome 157, the fixture used the debugger `Fetch` domain to attach a synthetic workspace cookie to each individual HTTP request, without using a shared header rule. A private test correlation header was removed before the request reached the server. `Network.responseReceivedExtraInfo` carried the synthetic response headers under the same network request ID, allowing the test to distinguish two simultaneous responses from the same URL, including two different `Set-Cookie` values. The two `Set-Cookie` headers in a 302 response remained separate, including an `Expires` date with a comma. The fixture rejects a response if matching extra information is missing or ambiguous.

The test manually observes a 302 and makes a separate request to the destination; it confirms the browser did not automatically follow it. For a redirect to the second loopback origin, the test explicitly omits the first origin's synthetic cookie. This does **not** implement general redirect, cookie-domain, SameSite, partitioning, or authorization-header policy.

The HTTPS redirect probe found that Chrome's manually stopped 302 did not produce the usual request-bound `Network.responseReceived` security event. In the gated variant, Chrome was allowed to prepare the next request but `Fetch` blocked that request before transmission. The `Network.requestWillBeSent` redirect event then supplied secure TLS details for the original response, matched to its request ID and `Location` header. The validator also requires the confirmed block to carry that exact network request ID; missing or different IDs fail closed. A separate cross-origin loopback 307 POST test confirmed that the redirected destination received no request or body. Chrome labeled loopback HTTP as `secure` in that event, so the binding validator explicitly requires an HTTPS source and TLS details. These are limited fixtures; they are not a general redirect implementation.

The fixture also sent a small binary upload and read a 49,152-byte response as multiple chunks without assembling the whole response. It cancelled a separate stream after its first chunk and confirmed the server observed the connection close; a later Chrome interception event was matched to the cancelled request, and later fixture requests still succeeded. This is not a Gecko streaming implementation or a complete backpressure and error-handling test.

The disposable host profile contained a synthetic `host_canary` cookie. HTTP fixture requests did not send it, and synthetic workspace cookies were not stored in Chrome's host cookie jar. The unprotected WebSocket control **did** send that host cookie. With explicit `ws://` host permission, a temporary, URL- and tab-scoped declarative rule replaced it with the synthetic workspace cookie, or removed it when the workspace had no cookie. Local WebSocket text and binary echo succeeded, and the normal path removed the temporary rule.

The race fixture demonstrates why a single shared rule ID is unsafe: two tabs can overwrite it and send the host cookie. Separate test rule IDs per tab kept the two synthetic cookies isolated. A separate control demonstrates that two handshakes in one tab can still overwrite each other; the test-only gate serialized their handshakes and allowed both established sockets to overlap. Another control showed a rule survives closing a tab without cleanup; the test worker removed the closed tab's rule while preserving the other tab's rule.

An opt-in test also connected to the public `wss://echo.websocket.org/` service and received synthetic text and binary echoes while a cookie-removal rule matched. **Remote cookie isolation was not verified.** Chrome's pre-send `webRequest` observation still showed the synthetic host canary, while its debugger handshake event omitted the cookie header. A loopback control showed that the debugger event omitted the cookie even when the server actually received it. Therefore neither the pre-rule observation nor the debugger event alone proves what the public server received; the local server-side tests are the evidence for local cookie isolation.

The separate `run-secure-websocket.mjs` fixture exercises **WSS on localhost** and observes the handshake at the server. On Chrome 158, the unguarded control sent the synthetic host cookie. A packaged static DNR rule scoped to the test extension's pinned ID removed that cookie from its first WSS request, and higher-priority synthetic workspace rules replaced or removed it. A regular host-browser tab still sent its own cookie. This fixture uses a generated, self-signed certificate: the initial control confirms that Chrome rejects it, while the later cookie checks deliberately use Chrome's `--allow-insecure-localhost` test switch. They do **not** validate public-CA HTTPS or remote-site cookie isolation.

The same test demonstrates an unresolved security failure: a higher-priority workspace-cookie session rule survived a tab reload and overrode the static guard until explicitly removed. The test also tried Chrome debugger `Network.setExtraHTTPHeaders` without a DNR rule: the server received the custom synthetic marker but received the host cookie instead of the requested workspace cookie, including when an empty cookie was requested. Debugger detach returned to the original behavior. On this Chrome version, that API is therefore **not** a safe replacement for cookie isolation on WebSocket handshakes. These controls use synthetic data and are not evidence of a general production solution.

An anonymous public-resource probe concurrently requested two HTML pages, an RFC text file, an SVG, and a PNG on five fixed HTTPS hosts. On Chrome 157 all five had request-bound secure TLS metadata, exact response-byte matches, and no synthetic host cookie or private marker in the observed outgoing headers. A URL that redirected was intentionally rejected; the tested SVG URL is the final URL. This is an extension-only fixture, **not** browsing in Gecko, a general website test, or production code. Sites, certificates, networks and content can change.

The RFC file exposed a byte-fidelity problem: `Network.getResponseBody` returned decoded text without its UTF-8 byte-order mark, so a strict comparison failed. The probe now tries `Network.streamResourceContent` and joins its request-bound binary chunks; if streaming starts too late, it falls back to `getResponseBody` but still requires an exact byte match. The fixture caps the captured body at 2 MiB and rejects mismatches. The public RFC, SVG and PNG matched via streaming in one run; small pages used the strict fallback. Browser-version behavior, large files, backpressure, compressed encodings, and hostile responses need further testing. This does not establish a secure or general streaming transport.

## Running

With Node dependencies installed and a current Chrome, run from the repository root:

```powershell
node experiments/extension-request-isolation/run.mjs
node --test experiments/extension-request-isolation/capture-bytes.test.mjs
node experiments/extension-request-isolation/run-general-public.mjs
node --test experiments/extension-request-isolation/redirect-binding.test.mjs
$env:OUTPOST_REDIRECT_GATE = '1'
node experiments/extension-request-isolation/run-redirect-https.mjs
$env:OUTPOST_REDIRECT_LOCAL = '1'
node experiments/extension-request-isolation/run-redirect-https.mjs
Remove-Item Env:OUTPOST_REDIRECT_LOCAL
Remove-Item Env:OUTPOST_REDIRECT_GATE
$env:OUTPOST_WS_RULE = '1'
node experiments/extension-request-isolation/run.mjs
Remove-Item Env:OUTPOST_WS_RULE
$env:OUTPOST_WS_EMPTY = '1'
node experiments/extension-request-isolation/run.mjs
Remove-Item Env:OUTPOST_WS_EMPTY
node experiments/extension-request-isolation/run-websocket-race.mjs
node experiments/extension-request-isolation/run-public-wss.mjs
node experiments/extension-request-isolation/run-secure-websocket.mjs
$env:OUTPOST_SAME_TAB_QUEUE = '1'
node experiments/extension-request-isolation/run-websocket-race.mjs
Remove-Item Env:OUTPOST_SAME_TAB_QUEUE
$env:OUTPOST_WS_CLOSE_TEST = '1'
node experiments/extension-request-isolation/run-websocket-race.mjs
Remove-Item Env:OUTPOST_WS_CLOSE_TEST
```

The opt-in controls intentionally reproduce unsafe behavior **only with synthetic local cookies**. `OUTPOST_WS_PROBE=1` demonstrates the unprotected handshake; `OUTPOST_SHARED_RULE_CONTROL=1` and `OUTPOST_SAME_TAB_CONTROL=1` demonstrate rule collisions; `OUTPOST_WS_CLOSE_TEST=1` with `OUTPOST_NO_CLOSE_CLEANUP=1` demonstrates stale rules. These controls assert the unsafe behavior as a regression observation, so their successful exit must never be interpreted as a security pass.

The test uses a powerful `debugger` permission and Chrome's unsafe extension debugging switch only for the disposable unpacked extension. `declarativeNetRequestFeedback` and `webRequest` are used for test diagnostics. The local WSS fixture also requires OpenSSL; set `OUTPOST_OPENSSL` if its executable is not at the standard Git for Windows path or on the Unix PATH. Chrome's [debugger API](https://developer.chrome.com/docs/extensions/reference/api/debugger) and [declarative network rules](https://developer.chrome.com/docs/extensions/reference/api/declarativeNetRequest) have browser- and policy-specific limitations.

## Release blockers

The HTTP cookie, redirect, and stream controls use plain loopback HTTP. The local WSS probe uses the localhost certificate exception described above; public WSS cookie isolation is unverified. This fixture is **not connected to Gecko**, has no arbitrary website support, and has not tested real sign-ins. Chrome's debugger and session-rule APIs have important availability, permission, privacy and compatibility costs. The correlation marker and any temporary cookie-bearing rule require a complete failure and crash threat model; the stale-rule test shows a rule survives a reload and can override the static guard. The tab-ID rule namespace and close handler are test simplifications, not a safe allocator or durable cross-tab coordinator. The gate only coordinates callers inside a single fixture page; worker restarts, concurrent tabs, errors and lifecycle transitions require a production design and adversarial tests.

Correct cookie behavior must remain in an isolated workspace jar and cover domain and path matching, expiration, SameSite, partitioning, multiple headers, logout, import/export, and redirect boundaries. Full HTTP methods and headers, binary streaming into Gecko, TLS security state, HSTS, cross-origin redirects, authentication, cancellation, WebSocket cookies and origins, real-site compatibility, and independent security review remain outstanding. A positive fixture result must not be used to claim that OUTPOST is production-ready.
