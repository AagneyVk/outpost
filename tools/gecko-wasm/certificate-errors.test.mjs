import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isCertificateError } from '../../public/gecko-lab/certificate-errors.mjs';

test('identifies the bundled engine certificate verification errors', () => {
  for (const status of ['0x805a1ff3', '0x805a1ff5', '0x805a3ff2', '0x805a2ff4', '0X805A1FF5'])
    assert.equal(isCertificateError(status), true);
});

test('does not label unrelated or malformed failures as certificate errors', () => {
  for (const status of ['0x00000000', '0x804b0002', '0x805a1ff4', '', null, undefined, 805])
    assert.equal(isCertificateError(status), false);
});
