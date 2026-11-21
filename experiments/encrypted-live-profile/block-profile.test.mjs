import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BlockLiveProfile } from './block-profile.mjs';
import { seal, unseal } from '../../public/portable.js';
const password = 'synthetic long test passphrase';
function store() {
  return { manifest: null, blocks: new Map(), fail: false, lastPuts: [], lastDeletes: [],
    async readManifest() { return this.manifest; }, async readBlock(id, index) { return this.blocks.get(`block:${id}:${index}`) ?? null; },
    async listBlockKeys() { return [...this.blocks.keys()]; },
    async commit(manifest, puts, deletes) {
      if (this.fail) throw Error('synthetic transaction failure');
      const next = new Map(this.blocks);
      for (const [id, index, blob] of puts) next.set(`block:${id}:${index}`, blob);
      for (const [id, index] of deletes) next.delete(`block:${id}:${index}`);
      this.manifest = manifest; this.blocks = next; this.lastPuts = puts; this.lastDeletes = deletes;
    } };
}
test('writes only changed blocks and detects rollback, swaps, and missing blocks', async () => {
  const disk = store(), fs = await BlockLiveProfile.open(disk, password);
  await fs.mkdir('synthetic-private-dir');
  const data = new Uint8Array(2 * 1024 * 1024); data[100000] = 1;
  await fs.writeFile('synthetic-private-dir/file', data);
  assert.equal(disk.lastPuts.length, 32);
  const oldBlock = disk.blocks.get(disk.lastPuts[1][0] && `block:${disk.lastPuts[1][0]}:1`);
  data[100000] = 2; await fs.writeFile('synthetic-private-dir/file', data);
  assert.equal(disk.lastPuts.length, 1);
  const key = `block:${disk.lastPuts[0][0]}:${disk.lastPuts[0][1]}`, latest = disk.blocks.get(key);
  await fs.writeFile('synthetic-private-dir/file', data);
  assert.equal(disk.lastPuts.length, 0, 'unchanged blocks must not be rewritten');
  for (const blob of [disk.manifest, ...disk.blocks.values()]) {
    assert.equal(Buffer.from(await blob.arrayBuffer()).includes(Buffer.from('synthetic-private-dir')), false);
  }
  await assert.rejects(BlockLiveProfile.open(disk, 'wrong synthetic password'), /Wrong passphrase/);
  await fs.close(); disk.blocks.set(key, oldBlock);
  await assert.rejects(BlockLiveProfile.open(disk, password), /damaged encrypted profile/);
  disk.blocks.set(key, latest);
  const keys = [...disk.blocks.keys()], first = disk.blocks.get(keys[0]), second = disk.blocks.get(keys[1]);
  disk.blocks.set(keys[0], second); disk.blocks.set(keys[1], first);
  await assert.rejects(BlockLiveProfile.open(disk, password), /damaged encrypted profile/);
  disk.blocks.set(keys[0], first); disk.blocks.set(keys[1], second);
  disk.blocks.delete(key); await assert.rejects(BlockLiveProfile.open(disk, password), /missing or orphaned/);
  disk.blocks.set(key, latest);
  const reopened = await BlockLiveProfile.open(disk, password);
  assert.equal((await reopened.readFile('synthetic-private-dir/file'))[100000], 2); await reopened.close();
});
test('serializes overlapping writes and persists both files', async () => {
  const disk = store(), fs = await BlockLiveProfile.open(disk, password);
  await Promise.all([fs.writeFile('a', new Uint8Array([1])), fs.writeFile('b', new Uint8Array([2]))]);
  await fs.close();
  const reopened = await BlockLiveProfile.open(disk, password);
  assert.deepEqual([...await reopened.readFile('a')], [1]);
  assert.deepEqual([...await reopened.readFile('b')], [2]);
  await reopened.close();
});
test('stops and warns if encryption preparation fails before committing a write', async () => {
  const disk = store(), fs = await BlockLiveProfile.open(disk, password);
  await fs.writeFile('file', new Uint8Array([1]));
  const before = disk.manifest, blocks = new Map(disk.blocks);
  let fatalEvents = 0; fs.onFatal(() => { fatalEvents++; });
  const original = crypto.getRandomValues;
  try {
    crypto.getRandomValues = () => { throw Error('synthetic random source failure'); };
    await assert.rejects(fs.writeFile('file', new Uint8Array([2])), /write failed/);
  } finally { crypto.getRandomValues = original; }
  assert.equal(fatalEvents, 1);
  assert.equal(disk.manifest, before); assert.deepEqual(disk.blocks, blocks);
  await assert.rejects(fs.readFile('file'), /needs recovery/); await fs.close();
  const reopened = await BlockLiveProfile.open(disk, password);
  assert.deepEqual([...await reopened.readFile('file')], [1]); await reopened.close();
});
test('preserves data across block boundaries, expansion, and truncation', async () => {
  const disk = store(), fs = await BlockLiveProfile.open(disk, password);
  let expected;
  for (const size of [0, 1, 65535, 65536, 65537, 131071, 131072, 131073, 17]) {
    expected = new Uint8Array(size);
    for (let index = 0; index < size; index++) expected[index] = (index * 31 + size) & 255;
    await fs.writeFile('boundary', expected);
    assert.deepEqual(await fs.readFile('boundary'), expected);
  }
  await fs.close();
  const reopened = await BlockLiveProfile.open(disk, password);
  assert.deepEqual(await reopened.readFile('boundary'), expected);
  await reopened.close();
});
test('handles truncation, rename, and transaction failures without corrupting the prior commit', async () => {
  const disk = store(), fs = await BlockLiveProfile.open(disk, password);
  let fatalEvents = 0; fs.onFatal(() => { fatalEvents++; });
  await fs.mkdir('dir'); await fs.writeFile('dir/file', new Uint8Array(140000));
  await fs.writeFile('dir/file', new Uint8Array(65536)); assert.equal(disk.lastDeletes.length, 2);
  await fs.rename('dir', 'renamed');
  assert.equal((await fs.readFile('renamed/file')).length, 65536);
  const before = disk.manifest, blocks = new Map(disk.blocks); disk.fail = true;
  await assert.rejects(fs.writeFile('renamed/file', new Uint8Array([9])), /write failed/);
  assert.equal(fatalEvents, 1);
  assert.equal(disk.manifest, before); assert.deepEqual(disk.blocks, blocks);
  await assert.rejects(fs.readFile('renamed/file'), /needs recovery/); await fs.close(); disk.fail = false;
  const restored = await BlockLiveProfile.open(disk, password);
  assert.equal((await restored.readFile('renamed/file')).length, 65536); await restored.unlink('renamed/file');
  assert.equal(disk.blocks.size, 0); await restored.close();
});
test('migrates existing exports without overwriting an encrypted store', async () => {
  const fingerprint = 'ebd6c75179152624d9644865e11792ed25cadc714d9e0985f412baf9c637a086';
  const header = new TextEncoder().encode(JSON.stringify([[['dir', 'file'], 3]])), prefix = new Uint8Array(4);
  new DataView(prefix.buffer).setUint32(0, header.length);
  const raw = new Uint8Array(await new Blob([prefix, header, new Uint8Array([2, 4, 6])]).arrayBuffer());
  const legacy = await seal(raw, 'T3st!abc', fingerprint, { minLength: 8 }); raw.fill(0);
  const disk = store();
  await assert.rejects(BlockLiveProfile.createFromLegacy(disk, password, legacy, 'wrong password', fingerprint, unseal), /Wrong passphrase/);
  assert.equal(disk.manifest, null);
  const live = await BlockLiveProfile.createFromLegacy(disk, password, legacy, 'T3st!abc', fingerprint, unseal);
  assert.deepEqual([...await live.readFile('dir/file')], [2, 4, 6]);
  await assert.rejects(BlockLiveProfile.createFromLegacy(disk, password, legacy, 'T3st!abc', fingerprint, unseal), /already exists/);
  const output = await live.exportLegacy('T3st!abc', fingerprint, seal);
  const decoded = await unseal(output, 'T3st!abc', fingerprint, { minLength: 8 });
  assert.deepEqual([...decoded.slice(-3)], [2, 4, 6]); decoded.fill(0); await live.close();
});
