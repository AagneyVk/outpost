# Relay WebSocket cookie isolation test

This local fixture exercises the actual Gecko Wisp client in a temporary extension and disposable Chrome profiles. It uses a generated self-signed certificate, synthetic cookies and a local WSS server. It does not send real credentials or contact a public relay. The negative control uses an earlier unisolated preview; the other case uses the current built preview.

On Chrome 158, the negative control sent a synthetic host-browser cookie scoped to the relay and a relay response cookie was subsequently sent by a normal host-browser tab. The isolated build used the WebSocket constructor from a credentialless extension frame: the host cookie was not sent to the local relay and the response cookie was not sent by the normal host tab. Chrome's cookie API nevertheless listed the response cookie, so the ordinary host request is important evidence; listing alone does not distinguish the isolated jar. When frame isolation was deliberately made unavailable, startup failed without connecting to the relay.

The cookie tests use Chrome's `--allow-insecure-localhost` switch only for the disposable local fixture. A separate test of the hardened build omits that exception and requires the same self-signed relay to fail the TLS handshake. The test does not prove behavior on all Chrome versions, operating systems, relays, crashes or hostile extensions. It does not enable the experimental direct-to-site transport, whose security blockers are separate. A custom relay that relies on existing host-browser cookies will not receive those cookies from the isolated connection.

With `--test-recovery --test-post`, the fixture interrupts a synthetic POST and then checks a later navigation. Both the previous build and the cookie-isolated build retain the dead connection, without repeating that POST in this fixture. A separate test-only reconnect change allowed the later navigation but caused Gecko to send the interrupted synthetic POST ten times in the observed run. That reconnect change is **not included** in the built extension. The outcome of an interrupted real operation is uncertain; safe automatic recovery is still a release blocker.

Build an unisolated preview from commit `5dcde5c` in a separate checkout as `../outpost-extension-before-fix`, and build the current preview as `../outpost-extension-preview`. Then run from the current repository root:

```powershell
node experiments/relay-credentialless/run.mjs --addon ../outpost-extension-before-fix --hardened-addon ../outpost-extension-preview --test-recovery --test-post
```

The test requires Chrome and OpenSSL. Set `OUTPOST_OPENSSL` if OpenSSL is not at the standard Git for Windows path or on the Unix PATH. It uses Chrome's unsafe extension debugging flag solely to load disposable test copies; the packaged extension does not request debugger permissions.

For the intentionally unsafe negative control, add `--experimental-reconnect` to the command above. This patches only the disposable test copy and expects the synthetic POST to be repeated. A successful negative-control run demonstrates the unsafe behavior; it is not a security pass.
