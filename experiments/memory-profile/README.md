# Memory-only Gecko profile research

This is a disposable experiment, not part of the user-facing extension. It implements a small in-memory version of the custom profile provider supported by the bundled Gecko build. `run.mjs` injects it into a temporary copy of the existing extension, uses a mocked Wisp relay and synthetic credentials, and deletes its test profiles afterward. It does not use a real website or a real user session.

On Chrome 158, the fixture started Gecko, obtained a synthetic HttpOnly session cookie, sent it on a later request, and saved its session-cookie snapshot into the provider. It then sealed a copy with the existing authenticated portable envelope, opened the archive in a fresh Chrome profile, restored the session into a new in-memory provider, verified the cookie on a request and then verified its removal after synthetic logout. The fixture scanned both extension OPFS trees for the synthetic cookie value and its base64 encoding and did not find either. It also checked that an unrelated synthetic host-browser cookie did not enter Gecko requests. These are narrowly scoped observations, not a forensic guarantee.

The archive unit test covers wrong passwords, tampering, traversal and duplicate entries. The provider tests cover selected file operations and limits. These tests do **not** establish POSIX completeness, safe concurrent SQLite snapshots, crash recovery, reliable wiping, speed, arbitrary websites or browser-version compatibility. The memory provider performs whole-file reads and writes and may be slower or more memory-intensive than the native OPFS backend. Data disappears if the test tab closes unless an export has been made. The host operating system, browser, swap, caches, extensions or an attacker controlling the device may retain or capture plaintext. JavaScript buffer clearing is best effort, not reliable memory erasure.

This does not yet protect the product's current active profile: production UI, history and tab persistence, browser-file storage, Linux storage, migration of existing profiles, atomic save/restore and user-facing error handling remain separate. The test archive has an experimental manifest and is **not compatible** with the existing OUTPOST browser-profile export. Never use it for actual credentials or as a replacement for a backup. A production design needs authenticated versioning and migration, a clear save-before-close flow, bounded memory use, performance measurement, race and failure testing, and independent security review.

Run from the repository root with a built unpacked extension and Chrome:

```powershell
node --test experiments/memory-profile/memory-profile.test.mjs experiments/memory-profile/archive.test.mjs
node experiments/memory-profile/run.mjs --addon ../outpost-extension-signin-review
```

The fixture uses Chrome's unsafe extension debugging switch to load its disposable unpacked test copy. The source extension does not request that permission. The provider interface was checked against the bundled engine's generated provider hooks; the underlying engine project is [firefox-wasm](https://github.com/HeyPuter/firefox-wasm).
