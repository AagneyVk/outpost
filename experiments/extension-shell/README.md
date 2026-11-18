# OUTPOST browser extension preview

This packages the existing OUTPOST Gecko browser UI as an unpacked Manifest V3 extension. It is a **preview**, not the requested production direct-network extension. It uses the existing Wisp relay; it does not include or enable the test-only direct-network bridge or native-cache prototype. The selected public relay is operated by a third party, and its availability and capacity are not guaranteed. An optional build can bundle the offline Linux terminal and Files. Browser Files, profile data, and history live in the extension's own storage, separate from the GitHub Pages site; use an encrypted export to transfer a compatible profile. Linux and browser exports are separate.

The extension asks for no broad host permissions, `debugger`, or access to existing browser tabs. Its packaged Gecko engine and decompressor run under the extension's content-security policy. The browser's guest pages and guest cookies still require a security review; this is not a claim of protection against a malicious host computer, compromised extension code, or browser vulnerabilities. The relay can observe destination metadata and unencrypted HTTP traffic. HTTPS is handled by the bundled Gecko engine over the relay.

## Build and load

From the repository root, with the checked-in Gecko v7 assets present:

```powershell
node experiments/extension-shell/build.mjs
```

By default this creates `../outpost-extension-preview`; `--out <new-directory>` chooses another existing-parent location. The builder refuses to overwrite an existing destination. In Chrome, open `chrome://extensions`, enable Developer mode, choose **Load unpacked**, and select the generated directory. This is not a signed Chrome Web Store package and has not been reviewed for store policy or distribution licensing; the exact upstream source and notices still need review. The Chrome toolbar button opens an OUTPOST browser tab.

To include the previously prepared Linux demo runtime, use a separate new destination:

```powershell
node experiments/extension-shell/build.mjs --linux-runtime ../pages-linux-runtime --out ../outpost-extension-linux-preview
```

This requires the local runtime directory and adds roughly 540 MB unpacked. The builder checks the expected demo fingerprint, key components, and filesystem blob hashes; those checks do not independently establish the image's provenance or distribution rights. Linux runs offline: the terminal cannot access the internet. The browser still uses Wisp. Linux exports require a passphrase of at least 16 characters and are distinct from browser exports. Changing the unpacked extension directory may give it a different extension ID and separate storage, so export data from the old installation before moving it.

## Verification

With Node dependencies and Chrome installed, the following use only temporary Chrome profiles:

```powershell
node --test experiments/extension-shell/build.test.mjs
node experiments/extension-shell/run.mjs --addon ../outpost-extension-preview
node experiments/extension-shell/run-cache.mjs --addon ../outpost-extension-preview
node experiments/extension-shell/run-portable.mjs --addon ../outpost-extension-preview
node experiments/extension-shell/run-portable.mjs --addon ../outpost-extension-preview --web-to-extension
node experiments/extension-shell/run-live.mjs --addon ../outpost-extension-preview
node experiments/extension-shell/run-import-limit.mjs --addon ../outpost-extension-preview
node experiments/extension-shell/run-live-signin.mjs --addon ../outpost-extension-preview --site the-internet
node experiments/extension-shell/run-public-site-control.mjs
node experiments/extension-shell/run-linux.mjs --addon ../outpost-extension-linux-preview
```

The first test replaces the Wisp connection with a synthetic relay and exercises browser startup, navigation, tabs, history, browser-file upload/download, a host-cookie canary, and ordinary-page access to extension resources. The cache test uses the same synthetic relay to verify Gecko's normal network cache: fresh reuse, ETag/304 validation, `no-store`, and `Vary` on language and cookie. This is distinct from the experimental direct-network cache patch. The portable test uses a synthetic login, then exports an encrypted profile and restores the session and two tabs into a separate Chrome profile; it also tests wrong-password and tampered-file rejection. With `--web-to-extension`, the export comes from a locally served OUTPOST web page and is imported into the extension. The live test makes anonymous requests to `example.com` and the expired, self-signed, and hostname-mismatch `badssl.com` pages using the public relay. Its disposable copy exposes a diagnostic Gecko handle for the test only. These tests use Chrome's unsafe extension-debugging flag solely to load the unpacked extension programmatically; the generated extension itself does not request the debugger permission or that flag.

The import-limit test checks that an authenticated but oversized compressed profile is rejected without changing an existing synthetic profile. The public sign-in harness uses a practice site's published synthetic credentials, the existing relay and disposable Chrome profiles; it checks the protected page, encrypted transfer, restored session and logout. Use `--site expand` to select the other supported public demo. The native Chrome control checks the same logout flow without OUTPOST. Results depend on the relay and sites, so a run must be checked rather than assumed to pass. The Linux test boots the offline terminal, writes and downloads a synthetic file, then exports and restores an encrypted Linux workspace in a separate Chrome profile. These tests do not prove arbitrary sites, real account sign-ins, extension updates, Chrome Web Store acceptance, production security, Linux networking, or image provenance. The experimental direct-network transport and native cache engine remain separate until their general request handling, TLS/security state, streaming, isolation, and failure behavior can be reviewed and verified. See the [internal security review](SECURITY_REVIEW.md).
