import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateResponseBinding } from './response-binding.mjs';
const url = 'https://example.com/';
const bytes = (...values) => new Uint8Array(values);
function sample() {
  return { url, status: 200, finalURL: url, body: bytes(0, 128, 255), capturedBody: bytes(0, 128, 255),
    requests: new Map([['r1', url]]), responses: new Map([['r1', { url, status: 200,
      securityState: 'secure', securityDetails: { protocol: 'TLS 1.3' } }]]),
    failures: new Map(), redirects: new Set() };
}
test('accepts the same network response and binary body', () => {
  assert.equal(validateResponseBinding(sample()).requestId, 'r1');
});
test('rejects altered, ambiguous, redirected, cached or insecure response evidence', () => {
  const alterations = [
    e => { e.capturedBody[1] = 0; },
    e => { e.capturedBody = bytes(0); },
    e => { e.finalURL = 'https://example.org/'; },
    e => { e.url = 'http://example.com/'; e.finalURL = e.url; },
    e => { e.failures.set('r1', 'net::ERR_CERT_DATE_INVALID'); },
    e => { e.redirects.add('r1'); },
    e => { e.responses.get('r1').fromDiskCache = true; },
    e => { e.responses.get('r1').fromServiceWorker = true; },
    e => { e.responses.get('r1').fromPrefetchCache = true; },
    e => { e.responses.get('r1').securityState = 'insecure'; },
    e => { e.responses.get('r1').securityDetails = null; },
    e => { e.responses.get('r1').status = 302; },
    e => { e.requests.set('r2', url); e.responses.set('r2', { ...e.responses.get('r1') }); }
  ];
  for (const alter of alterations) {
    const e = sample(); alter(e);
    assert.throws(() => validateResponseBinding(e));
  }
});
