# Certificate metadata feasibility probe

This is a disposable test, not the OUTPOST extension. It attaches Chrome's
debugger to a test tab owned by the test extension, fetches example.com and an
expired-certificate test host, and checks whether the debugging protocol exposes
certificate information. It creates and deletes a temporary Chrome profile.

After installing this repository's dependencies, run:

```sh
node experiments/extension-certificate-probe/run.mjs
```

Set `OUTPOST_CHROME` for a nonstandard Chrome path. The command uses the
unsafe-extension-debugging switch solely to load the unpacked test extension
into the temporary profile; it does not enable the experimental
`WebRequestSecurityInfo` flag.

The `debugger` permission is powerful and may show a browser debugging
notification. It is not requested by OUTPOST's current extension fixture, and
this experiment does not establish that it is appropriate for production.
Reported certificates and issuers reflect the host browser's trust and network
configuration; trusted HTTPS interception can change the observed chain.
