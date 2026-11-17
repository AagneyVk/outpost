import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateRedirectBinding } from './redirect-binding.mjs';
const url = 'https://example.com/start', destination = 'https://example.org/next';
function sample() { return { initialURL: url, requestId: 'a',
  redirects: [{ id: 'a', from: url, to: destination, status: 302, securityState: 'secure', protocol: 'TLS 1.3' }],
  extra: { status: 302, location: destination }, blockResults: [{ url: destination, networkId: 'a', ok: true }] }; }
test('accepts a uniquely matched secure redirect blocked before its next request', () => {
  assert.equal(validateRedirectBinding(sample()).to, destination);
});
test('rejects mismatched, insecure, cached, unblocked, or ambiguous redirects', () => {
  const changes = [
    x => { x.initialURL = 'http://example.com/start'; },
    x => { x.redirects[0].id = 'other'; },
    x => { x.redirects[0].securityState = 'insecure'; },
    x => { x.redirects[0].protocol = null; },
    x => { x.redirects[0].fromDiskCache = true; },
    x => { x.redirects[0].fromServiceWorker = true; },
    x => { x.redirects[0].fromPrefetchCache = true; },
    x => { x.extra.status = 303; },
    x => { x.extra.location = 'https://attacker.invalid/'; },
    x => { x.extra.location = destination + '\nhttps://attacker.invalid/'; },
    x => { x.blockResults[0].ok = false; },
    x => { x.blockResults[0].ok = 'true'; },
    x => { x.blockResults[0].networkId = 'other'; },
    x => { delete x.blockResults[0].networkId; },
    x => { x.blockResults[0].url = 'https://attacker.invalid/'; },
    x => { x.redirects.push({ ...x.redirects[0] }); },
    x => { x.blockResults.push({ ...x.blockResults[0] }); }
  ];
  for (const change of changes) { const x = sample(); change(x); assert.throws(() => validateRedirectBinding(x)); }
});
