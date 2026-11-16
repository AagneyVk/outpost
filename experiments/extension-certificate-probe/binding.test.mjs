import { test } from 'node:test';
import assert from 'node:assert/strict';
import './binding.js';

const url = 'https://example.com/';
function evidence() {
  return {
    url, status: 200, body: 'content', capturedBody: 'content',
    requests: new Map([['request', url]]),
    responses: new Map([['request', {
      url, status: 200, securityState: 'secure', securityDetails: { protocol: 'TLS 1.3' }
    }]]),
    failures: new Map()
  };
}

test('accepts matching request-bound response and security metadata', () => {
  assert.equal(globalThis.validateResponseBinding(evidence()).requestId, 'request');
});

test('rejects mismatched or ambiguous evidence', () => {
  const cases = [
    value => { value.capturedBody = 'different'; },
    value => { value.failures.set('request', 'net::ERR_CERT_DATE_INVALID'); },
    value => { value.responses.get('request').fromDiskCache = true; },
    value => { value.responses.get('request').fromServiceWorker = true; },
    value => { value.responses.get('request').securityState = 'insecure'; },
    value => { value.responses.get('request').securityDetails = null; },
    value => { value.responses.get('request').status = 302; },
    value => {
      value.requests.set('other', url);
      value.responses.set('other', { ...value.responses.get('request') });
    }
  ];
  for (const mutate of cases) {
    const value = evidence();
    mutate(value);
    assert.throws(() => globalThis.validateResponseBinding(value));
  }
});
