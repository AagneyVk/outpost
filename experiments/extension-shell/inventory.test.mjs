import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { writeInventory, verifyInventory } from './inventory.mjs';

test('checks inventory digest, changed files, and unexpected files', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'outpost-inventory-'));
  try {
    await fs.mkdir(path.join(root, 'nested'));
    await fs.writeFile(path.join(root, 'nested', 'asset'), 'original');
    const digest = await writeInventory(root);
    assert.deepEqual(await verifyInventory(root, digest), { digest, files: 1, digestVerified: true });
    await assert.rejects(verifyInventory(root, '0'.repeat(64)), /digest does not match/);
    await fs.writeFile(path.join(root, 'nested', 'asset'), 'tampered');
    await assert.rejects(verifyInventory(root, digest), /do not match/);
    await fs.writeFile(path.join(root, 'nested', 'asset'), 'original');
    await fs.writeFile(path.join(root, 'unexpected'), 'extra');
    await assert.rejects(verifyInventory(root, digest), /do not match/);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
