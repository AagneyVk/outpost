import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MemoryProfile } from './memory-profile.mjs';

test('keeps independent file contents and handles nested moves and deletion', async () => {
  const fs = new MemoryProfile({ maxBytes: 8, maxEntries: 8 });
  await fs.mkdir('a'); await fs.mkdir('b');
  const input = new Uint8Array([1, 2, 3]);
  await fs.writeFile('a/file', input); input.fill(9);
  const read = await fs.readFile('a/file'); assert.deepEqual([...read], [1, 2, 3]); read.fill(0);
  await fs.rename('a', 'b/renamed');
  assert.deepEqual(await fs.readdir('b'), ['renamed']);
  assert.deepEqual([...await fs.readFile('b/renamed/file')], [1, 2, 3]);
  await assert.rejects(fs.unlink('b/renamed'), /not empty/);
  await fs.unlink('b/renamed/file'); await fs.unlink('b/renamed');
  assert.equal(await fs.stat('a/file'), null);
});

test('rejects traversal and over-limit writes without destroying existing data', async () => {
  const fs = new MemoryProfile({ maxBytes: 3 });
  await fs.writeFile('safe', new Uint8Array([1, 2, 3]));
  await assert.rejects(fs.writeFile('safe', new Uint8Array(4)), /size limit/);
  await assert.rejects(fs.readFile('../safe'), /Invalid path/);
  assert.deepEqual([...await fs.readFile('safe')], [1, 2, 3]);
  fs.destroy();
  assert.equal(await fs.stat('safe'), null);
});
