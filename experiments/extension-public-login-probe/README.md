# Public practice login experiment

This test uses the published synthetic credentials for
[Expand Testing's login practice page](https://practice.expandtesting.com/login).
It opens fresh temporary Chrome profiles and sends a limited set of requests
through a test extension. It does not use a personal account.

After installing this repository's dependencies, run:

```sh
node experiments/extension-public-login-probe/run.mjs
```

Set `OUTPOST_CHROME` if Chrome is installed in a nonstandard location. The test
loads the extension into temporary profiles with Chrome's development protocol.
Session cookie values remain in memory and are not printed. The test copies the
synthetic session from the first profile to the second, checks that an empty
session is redirected, and verifies that the copied session reaches the
protected page.

The test temporarily rewrites Origin and Referer and uses a simple in-memory
cookie map. It does not implement cookie domain, path, expiry, SameSite or
partition rules and is unsuitable for real accounts. It tests the extension
layer directly, not Gecko or OUTPOST's encrypted export/import. Server behavior,
network access and bot protection can cause the external test to fail.
