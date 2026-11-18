import { test } from 'node:test';
import assert from 'node:assert/strict';
import { recordMaxAge, maxAgeForRestore } from './max-age-record.mjs';

test('restore preserves only the remaining lifetime, rounding down', () => {
  const entry = recordMaxAge('sid=x; Max-Age=30; HttpOnly; Path=/', 10000);
  assert.equal(maxAgeForRestore(entry, 11100), 'sid=x; Max-Age=28; HttpOnly; Path=/');
  assert.equal(maxAgeForRestore(entry, 39001), null);
  assert.equal(maxAgeForRestore(entry, 40000), null);
});
test('deletion and invalid or ambiguous Max-Age do not become live cookies', () => {
  for (const value of ['0', '-1']) assert.equal(maxAgeForRestore(recordMaxAge('a=b; Max-Age=' + value, 1000), 1000), null);
  for (const value of ['a=b', 'a=b; Max-Age=1; max-age=2', 'a=b; Max-Age=+3', 'a=b; Max-Age=1.5', 'a=b; Max-Age=', 'a=b; Max-Age=1\r\nX: y'])
    assert.throws(() => recordMaxAge(value, 1000));
});
test('Max-Age takes precedence over Expires and is bounded by Chrome lifetime', () => {
  const entry = recordMaxAge('a=b; Expires=Wed, 21 Oct 2037 07:28:00 GMT; MAX-AGE=9999999999999999999', 10000);
  assert.equal(maxAgeForRestore(entry, 10000), 'a=b; Expires=Wed, 21 Oct 2037 07:28:00 GMT; Max-Age=34560000');
  assert.equal(maxAgeForRestore(entry, 10000 + 34560000 * 1000), null);
});
test('untrusted or backwards timestamps and malformed records fail closed', () => {
  const entry = recordMaxAge('a=b; max-age=10', 10000);
  for (const bad of [-1, 2.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1, '10000']) assert.throws(() => maxAgeForRestore(entry, bad));
  assert.throws(() => maxAgeForRestore(entry, 9999), /backwards/);
  assert.throws(() => maxAgeForRestore({ ...entry, requestStartedAt: Number.MAX_SAFE_INTEGER }, Number.MAX_SAFE_INTEGER), /expiry/);
});
