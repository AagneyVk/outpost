import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ChunkedLiveProfile } from './chunked-profile.mjs';
import { seal, unseal } from '../../public/portable.js';
const password = 'synthetic long test passphrase';
function store() {
  return { manifest: null, files: new Map(), fail: false,
    async readManifest() { return this.manifest; }, async readFile(id) { return this.files.get(id) ?? null; },
    async listFileIds() { return [...this.files.keys()]; },
    async commit(manifest, puts, deletes) {
      if (this.fail) throw Error('synthetic transaction failure');
      const next = new Map(this.files); for (const [id, blob] of puts) next.set(id, blob); for (const id of deletes) next.delete(id);
      this.manifest = manifest; this.files = next;
    } };
}
test('encrypts filenames and contents, supports moves, and detects record swapping', async () => {
  const disk = store(), fs = await ChunkedLiveProfile.open(disk, password);
  await fs.mkdir('synthetic-secret-dir');
  await fs.writeFile('synthetic-secret-dir/a', new TextEncoder().encode('synthetic-cookie-value'));
  await fs.writeFile('other', new Uint8Array([8, 9]));
  await fs.rename('synthetic-secret-dir', 'moved');
  assert.deepEqual(await fs.readdir('moved'), ['a']);
  for (const blob of [disk.manifest, ...disk.files.values()]) {
    const bytes = Buffer.from(await blob.arrayBuffer());
    assert.equal(bytes.includes(Buffer.from('synthetic-secret-dir')), false);
    assert.equal(bytes.includes(Buffer.from('synthetic-cookie-value')), false);
  }
  const before = disk.manifest;
  await assert.rejects(ChunkedLiveProfile.open(disk, 'wrong synthetic password'), /Wrong passphrase/);
  assert.equal(disk.manifest, before);
  await fs.close();
  const ids = [...disk.files.keys()], first = disk.files.get(ids[0]), second = disk.files.get(ids[1]);
  disk.files.set(ids[0], second); disk.files.set(ids[1], first);
  await assert.rejects(ChunkedLiveProfile.open(disk, password), /damaged encrypted profile/);
  disk.files.set(ids[0], first); disk.files.set(ids[1], second);
  const reopened = await ChunkedLiveProfile.open(disk, password);
  assert.equal(new TextDecoder().decode(await reopened.readFile('moved/a')), 'synthetic-cookie-value');
  await reopened.close();
});
test('failed transactions stop the provider and preserve the previous committed files', async () => {
  const disk = store(), fs = await ChunkedLiveProfile.open(disk, password);
  await fs.writeFile('file', new Uint8Array([1, 2]));
  const before = disk.manifest, records = [...disk.files.values()]; disk.fail = true;
  await assert.rejects(fs.writeFile('file', new Uint8Array([3])), /write failed/);
  assert.equal(disk.manifest, before); assert.deepEqual([...disk.files.values()], records);
  await assert.rejects(fs.readFile('file'), /needs recovery/);
  await fs.close(); disk.fail = false;
  const reopened = await ChunkedLiveProfile.open(disk, password);
  assert.deepEqual([...await reopened.readFile('file')], [1, 2]); await reopened.close();
});
test('migrates the existing browser export without overwriting a live store', async () => {
  const fingerprint = 'ebd6c75179152624d9644865e11792ed25cadc714d9e0985f412baf9c637a086';
  const header = new TextEncoder().encode(JSON.stringify([[['dir', 'file'], 3]])), prefix = new Uint8Array(4);
  new DataView(prefix.buffer).setUint32(0, header.length);
  const raw = new Uint8Array(await new Blob([prefix, header, new Uint8Array([2, 4, 6])]).arrayBuffer());
  const legacy = await seal(raw, 'T3st!abc', fingerprint, { minLength: 8 }); raw.fill(0);
  const disk = store();
  await assert.rejects(ChunkedLiveProfile.createFromLegacy(disk, password, legacy, 'incorrect password', fingerprint, unseal), /Wrong passphrase/);
  assert.equal(disk.manifest, null);
  const live = await ChunkedLiveProfile.createFromLegacy(disk, password, legacy, 'T3st!abc', fingerprint, unseal);
  assert.deepEqual([...await live.readFile('dir/file')], [2, 4, 6]);
  await assert.rejects(ChunkedLiveProfile.createFromLegacy(disk, password, legacy, 'T3st!abc', fingerprint, unseal), /already exists/);
  const output = await live.exportLegacy('T3st!abc', fingerprint, seal);
  const decoded = await unseal(output, 'T3st!abc', fingerprint, { minLength: 8 });
  assert.deepEqual([...decoded.slice(-3)], [2, 4, 6]); decoded.fill(0);
  await live.close();
});
