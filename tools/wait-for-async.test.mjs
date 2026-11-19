import { test } from 'node:test';
import assert from 'node:assert/strict';
import { waitForAsync } from './wait-for-async.mjs';

test('waits for the resolved value rather than treating a Promise as success', async () => {
  let calls = 0;
  await waitForAsync(async () => ++calls === 3, { timeout: 1000, interval: 1 });
  assert.equal(calls, 3);
  await assert.rejects(waitForAsync(async () => false, { timeout: 20, interval: 5 }), /Timed out/);
});
