import { test } from 'node:test';
import assert from 'node:assert/strict';
import { combineBase64Capture } from './capture-bytes.mjs';

test('reconstructs binary bytes including a UTF-8 byte-order mark across chunks', () => {
  const result = combineBase64Capture(['77u/', 'AP+A', ''], 6);
  assert.deepEqual([...result], [0xef, 0xbb, 0xbf, 0, 255, 128]);
});
test('rejects malformed and oversized capture before allocating its result', () => {
  assert.throws(() => combineBase64Capture(['Zm9v', '%%%'], 10), /Malformed/);
  assert.throws(() => combineBase64Capture(['Zm9v', 'Yg=='], 3), /exceeds limit/);
  assert.throws(() => combineBase64Capture(['Zg=='], -1), /Invalid/);
});
