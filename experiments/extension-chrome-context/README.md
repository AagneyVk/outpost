# Chrome extension-owned Gecko context experiment

**Research fixture only. Do not install for real browsing or use credentials.** This does not provide a general OUTPOST extension or replace the existing relay. It launches a temporary extension in a disposable Chrome profile and uses fixed test inputs.

The experiment tests a different trust boundary from the [Firefox HTTPS fixture](../extension-firefox-gecko-tls/). Here the Gecko engine and the sample HTTPS code execute inside a top-level extension page. An ordinary localhost page cannot read the extension page or send it an external runtime message in the tested configuration. This is not a security audit or proof against compromised extension code, browser bugs, malicious guest content, or every message and frame attack.

On the tested Chrome 157, the top-level extension page was cross-origin isolated and had `SharedArrayBuffer` and the required WebAssembly APIs. Gecko loaded a local `data:` document. The web-oriented loader originally created a `blob:` script blocked by extension CSP; the test runner extracts the exact bundled Emscripten glue to a packaged extension file and makes the test loader use it. No CSP bypass or remote executable script is used. This is a packaging test, not yet a full extension build.

The optional HTTPS mode uses a separately patched research Gecko build and an extension-owned fixed-origin fetch. Chrome's debugger matches the host response and response body using a network request ID. It obtains a certificate chain with `Network.getCertificate`, but that lookup is **origin-keyed**, so it does not prove the chain belongs to the exact request. The HTTPS test injects a synthetic HSTS header; it does not test actual HSTS or redirects. Its transport serializes one fixed request, buffers the body and fabricates Gecko security information. The temporary HTTPS test extension requests Chrome's powerful `debugger` and `tabs` permissions; these may be unsuitable for a product and this experiment is not a recommendation to request them. The basic context test does not request these permissions.

On this machine Chrome reports that the connection to example.com is issued by Norton Web/Mail Shield Root. Chrome accepted the host connection, but the test Gecko verifier returned NSS `SEC_ERROR_UNKNOWN_ISSUER` (-8179) and rejected the navigation. The guest does not automatically inherit Chrome's trust decisions or trust store. Chrome rejected the expired.badssl.com connection with `ERR_CERT_DATE_INVALID`. No certificate exceptions or user trust-store changes were made.

## Run

Install this repository's Node dependencies and a current Chrome, then run from the repository root:

```powershell
node experiments/extension-chrome-context/run.mjs
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

## Work still required

The user-facing extension must securely bind the response, its URL and redirects, and request-specific TLS state without trusting a web page or an origin-keyed certificate lookup. Its treatment of the host's enterprise or antivirus trust roots needs a deliberate, tested policy. General requests, streaming, cookies, CORS, origin headers, HSTS, WebSockets, errors, concurrent requests, sign-ins, installation and updates are unimplemented. The extension-owned context also changes the hosting and workspace-storage model; compatibility with OUTPOST's existing UI and encrypted portable workspaces remains untested. Independent security review and real browser compatibility tests are still needed before release.

Chrome's [cross-origin isolation documentation](https://developer.chrome.com/docs/extensions/develop/concepts/cross-origin-isolation) describes the top-level extension configuration and its iframe limitations. Mozilla's [WebExtension CSP documentation](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/manifest.json/content_security_policy) describes allowing WebAssembly without general JavaScript evaluation.
