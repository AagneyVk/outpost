# Windows launcher release checks

Build the candidate with `tools/build-windows-launcher.ps1` and the license matching the bundled x64 Node.js binary. The download must contain no device-specific inspection databases, relay credentials, or user profiles.

For the current Windows x64 preview, use Node.js 24.14.1 and run from the checkout root:

```powershell
npm ci
.\tools\build-windows-launcher.ps1 -Destination ../OUTPOST-Windows-x64.exe -NodeLicense node-v24.14.1-LICENSE.txt
```

Double-click the resulting executable. It starts a helper on loopback, opens the default browser, and starts Gecko. Press Enter in the launcher window to stop the helper. If HTTPS inspection prevents verification, the certificate error screen links to compatibility options. This preview is unsigned. Inspection compatibility requires separate administrator-approved device configuration.

Test the executable on a clean Windows x64 installation as a standard user, with no Node.js installation. Double-click it, verify Gecko starts in the default browser, visit a valid HTTPS site, then stop OUTPOST and confirm that the loopback listener and extracted runtime are removed. Repeat on a managed Windows machine that allows the signed executable. Verify approval is required before the launcher uses its configured inspection authority, that valid inspected HTTPS works, and that expired, wrong-host, and unapproved certificates fail. End the temporary session and verify the approved authority is no longer trusted. Record the Windows edition, browser version, inspection setup, artifact hash and result for each run.

Sign a copy of the tested candidate using `tools/sign-windows-launcher.ps1` with an authorized publisher certificate in the user's certificate store, SignTool from the Windows SDK, and an RFC 3161 timestamp URL. The script verifies the signer and timestamp before producing the release artifact. For a signing service, use the publisher's approved service workflow and verify the same Authenticode properties. Test the signed copy on the clean and managed devices and publish the SHA-256 of that copy.

The current candidate is unsigned. Local tests on one Windows laptop verified the bundled runtime, normal shutdown, rejection of foreign loopback Host headers, Norton compatibility, and rejection of selected invalid HTTPS sites. They do not replace the clean-device and managed-device release checks.
