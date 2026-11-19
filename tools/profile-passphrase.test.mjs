import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validExportPassphrase } from '../public/gecko-lab/passphrase-policy.mjs';

test('allows the existing short policy and longer passphrases', () => {
  for (const value of ['Test12!x', 'a longer unique passphrase', 'abcdefghijklmnop']) {
    assert.equal(validExportPassphrase(value), true);
  }
  for (const value of ['', 'abcdefgh', 'abcdefgh1', 'abcdefg!', 'abcdefghijklmno', ' '.repeat(16), 'x'.repeat(1025)]) {
    assert.equal(validExportPassphrase(value), false);
  }
});
