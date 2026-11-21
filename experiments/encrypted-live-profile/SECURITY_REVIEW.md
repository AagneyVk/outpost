# Internal review: encrypted live profile

This is a source and test review of an experimental provider, not an independent audit or an approval for production. The normal extension does not use this provider. The separate preview is for synthetic data only.

## Intended protection and observed checks

The encrypted database stores an AES-GCM authenticated manifest and authenticated file blocks. A fresh random IV is used for each encryption, and block authentication binds a random file identifier, block number and revision. The key is derived from the supplied passphrase using PBKDF2-SHA256 (600,000 iterations) and is nonextractable through Web Crypto. The manifest and changed blocks are committed in the same IndexedDB transaction, with the strict durability option requested where supported. Concurrent access is guarded with a Web Lock.

Tests reject a wrong passphrase, swapped or missing blocks, and replay of an old individual block against a newer manifest. Synthetic failures exercised aborted transactions, an encryption-preparation failure, an interrupted browser process, reopening a previously committed session, and the user-facing failure warning. Synthetic markers were not found in the checked IndexedDB blobs or extension OPFS locations. A public demo login and transfer passed in disposable Chrome profiles. These observations are bounded to the tested scenarios; they do not prove that all plaintext copies, crashes, or attacks are handled.

## Material limitations

- A complete older, internally consistent database can be restored without detection. Record sizes, block counts, access timing and database existence also leak information. The implementation has not received independent cryptographic or security review.
- The decrypted profile exists in memory while unlocked. A hostile host, malicious extension, memory inspection, swap or input capture can expose data. A passphrase typed on an untrusted computer cannot protect against that computer. Clearing logical IndexedDB records is not a forensic erase.
- The eight-character option is supported for compatibility with the requested UI but may be susceptible to offline guessing. Prefer a long, unique passphrase. No key recovery service is provided.
- IndexedDB durability is requested, not a universal power-loss guarantee. Storage eviction, quota exhaustion, browser profile deletion, hardware failure, complete database rollback and simultaneous failures have not been comprehensively tested. Users need independently verified exports and recovery procedures.
- The provider limits the profile to 64 MiB and 4,096 entries. It is an in-memory filesystem adapter, not a complete verification of SQLite locking, crash consistency or every Gecko filesystem operation. Large real profiles, low-memory devices and long sessions need measurement.
- Session cookies are snapshotted for explicit save/export/restart paths. The newest session state may be absent after a crash. Existing plaintext profile data remains in the old installation; import does not erase it. Browser Files and Linux workspaces are outside this provider.
- The preview was exercised on one Windows/Chrome configuration with selected synthetic and public-demo flows. More platforms, Chrome versions, real-world sign-ins, updates, accessibility and independent security testing are required. Neither the bundled engine's provenance nor its licensing has been established by these tests.

References: [Web Crypto AES-GCM parameters](https://developer.mozilla.org/en-US/docs/Web/API/AesGcmParams) and [IndexedDB transaction durability](https://developer.mozilla.org/en-US/docs/Web/API/IDBDatabase/transaction). The release gates in the [extension review](../extension-shell/RELEASE.md) still apply.
