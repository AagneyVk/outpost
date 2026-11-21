# Experimental encrypted live browser profile

This is a separately packaged research preview, **not a production release**. It encrypts the Gecko profile, tab state, browser history and saved session-cookie snapshot while they are stored in its IndexedDB database. Use disposable, synthetic data only. The normal extension preview is unchanged and continues to use its existing profile storage. Browser Files and the optional Linux workspace are separate and are not covered by this provider.

The provider holds the unlocked profile in memory, encrypts changed 64 KiB blocks and commits those blocks with an authenticated manifest in one IndexedDB transaction. It derives an AES-GCM key from the passphrase using PBKDF2-SHA256 with 600,000 iterations. It enforces a 64 MiB profile limit and 4,096 entries. A storage or encryption failure stops the provider and exposes a recovery warning. When properly closed, an existing encrypted browser export can be imported into a new live profile and the profile can be exported in the existing format. An import does not delete the original export or old, unencrypted profile.

This design does not protect against a hostile computer, operating system, browser or extension that can observe unlocked data or input. Whole-database rollback is not detected; persistent storage can be lost or evicted; session-cookie recovery after an unexpected crash is not guaranteed; and the preview is not a full filesystem or SQLite durability proof. Short passphrases can be guessed offline. See the [internal security review](SECURITY_REVIEW.md) before using this code.

## Build and try

Install the repository's Node dependencies and prepare the Gecko assets required by the [extension builder](../extension-shell/README.md), then run:

```powershell
node experiments/encrypted-live-profile/build-preview.mjs --out ../outpost-encrypted-live-preview
```

The builder requires a new output directory and leaves the standard extension untouched. In Chrome's `chrome://extensions`, enable Developer mode and choose **Load unpacked** for that directory. The preview asks for a passphrase when opening or creating its separate encrypted profile. It also supports importing a compatible existing export and exporting the new profile. An unpacked extension loaded from a different directory can have a different extension ID and separate storage; keep a verified backup of any existing data before changing installations. The preview's clear operation removes the logical encrypted records, and does not claim forensic erasure.

## Verification

```powershell
npm run test:encrypted-profile
node experiments/encrypted-live-profile/run-preview-failure.mjs --addon ../outpost-encrypted-live-preview
node experiments/extension-shell/run-portable.mjs --addon ../outpost-encrypted-live-preview --encrypted-live-preview
node experiments/extension-shell/run-portable.mjs --addon ../outpost-encrypted-live-preview --encrypted-live-preview --web-to-extension
node experiments/extension-shell/run-live-signin.mjs --addon ../outpost-encrypted-live-preview --encrypted-live-preview --site the-internet
```

The browser tests use disposable Chrome profiles and synthetic credentials; the public demo test reaches the chosen third-party relay and demo site. Local runs passed encrypted export/import, migration from the standard web export, session restoration and logout on two public practice sites, storage-abort warning and reopening, synthetic crash recovery, and rejection of wrong passwords and selected corruption cases. These tests do not establish general site compatibility, availability, resistance to every failure or security against a hostile device. Results should be rerun on the specific build and supported platforms.
