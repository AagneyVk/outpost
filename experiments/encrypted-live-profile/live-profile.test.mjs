import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EncryptedLiveProfile } from './live-profile.mjs';
import { seal, unseal } from '../../public/portable.js';
const password = 'synthetic long test passphrase';
function store() {
  return { blob: null, fail: false, writes: 0,
    async read() { return this.blob; },
    async commit(value) { if (this.fail) throw Error('synthetic disk failure'); this.blob = value; this.writes++; } };
}
test('writes authenticated ciphertext and reopens with the original passphrase', async () => {
  const disk = store(), fs = await EncryptedLiveProfile.open(disk, password);
  await fs.mkdir('synthetic-private-dir');
  await fs.writeFile('synthetic-private-dir/session', new TextEncoder().encode('synthetic-private-cookie'));
  const data = Buffer.from(await disk.blob.arrayBuffer());
  assert.equal(data.includes(Buffer.from('synthetic-private-cookie')), false);
  assert.equal(data.includes(Buffer.from('synthetic-private-dir')), false);
  const saved = disk.blob;
  await assert.rejects(EncryptedLiveProfile.open(disk, 'wrong test passphrase'), /Wrong passphrase/);
  assert.equal(disk.blob, saved);
  await fs.close();
  const reopened = await EncryptedLiveProfile.open(disk, password);
  assert.equal(new TextDecoder().decode(await reopened.readFile('synthetic-private-dir/session')), 'synthetic-private-cookie');
  await reopened.close();
  const damaged = new Uint8Array(await saved.arrayBuffer()); damaged[damaged.length - 1] ^= 1;
  disk.blob = new Blob([damaged]);
  await assert.rejects(EncryptedLiveProfile.open(disk, password), /damaged live profile/);
});
test('failed writes preserve the committed ciphertext and stop subsequent operations', async () => {
  const disk = store(), fs = await EncryptedLiveProfile.open(disk, password);
  await fs.writeFile('file', new Uint8Array([1, 2]));
  const before = disk.blob, count = disk.writes;
  disk.fail = true;
  await assert.rejects(fs.writeFile('file', new Uint8Array([7])), /write failed/);
  assert.equal(disk.blob, before); assert.equal(disk.writes, count);
  await assert.rejects(fs.readFile('file'), /needs recovery/);
  await fs.close(); disk.fail = false;
  const recovered = await EncryptedLiveProfile.open(disk, password);
  assert.deepEqual([...await recovered.readFile('file')], [1, 2]);
  await recovered.close();
});
test('close waits for accepted writes and refuses new operations', async () => {
  const disk = store(), fs = await EncryptedLiveProfile.open(disk, password);
  const write = fs.writeFile('file', new Uint8Array([3, 4]));
  const closing = fs.close();
  await assert.rejects(fs.readFile('file'), /closing/);
  await Promise.all([write, closing]);
  const reopened = await EncryptedLiveProfile.open(disk, password);
  assert.deepEqual([...await reopened.readFile('file')], [3, 4]);
  await reopened.close();
});
test('rejects an oversized write before changing the stored ciphertext', async () => {
  const disk = store(), fs = await EncryptedLiveProfile.open(disk, password), before = disk.blob;
  await assert.rejects(fs.writeFile('oversized', new Uint8Array(64 * 1024 * 1024 + 1)), /oversized/);
  assert.equal(disk.blob, before);
  await fs.close();
});
test('migrates an existing encrypted browser export atomically and exports the legacy format', async () => {
  const fingerprint = 'ebd6c75179152624d9644865e11792ed25cadc714d9e0985f412baf9c637a086';
  const oldPass = 'T3st!abc', newPass = 'new synthetic long passphrase';
  const manifest = new TextEncoder().encode(JSON.stringify([[['cookies', 'synthetic'], 3], [['outpost-history.ndjson'], 4]]));
  const prefix = new Uint8Array(4); new DataView(prefix.buffer).setUint32(0, manifest.length);
  const raw = new Uint8Array(await new Blob([prefix, manifest, new Uint8Array([1, 2, 3, 4, 5, 6, 7])]).arrayBuffer());
  const legacy = await seal(raw, oldPass, fingerprint, { minLength: 8 }); raw.fill(0);
  const disk = store();
  await assert.rejects(EncryptedLiveProfile.createFromLegacy(disk, newPass, legacy, 'wrong password', fingerprint, unseal), /Wrong passphrase/);
  assert.equal(disk.blob, null);
  const migrated = await EncryptedLiveProfile.createFromLegacy(disk, newPass, legacy, oldPass, fingerprint, unseal);
  assert.deepEqual([...await migrated.readFile('cookies/synthetic')], [1, 2, 3]);
  const encryptedBefore = disk.blob;
  await assert.rejects(EncryptedLiveProfile.createFromLegacy(disk, newPass, legacy, oldPass, fingerprint, unseal), /already exists/);
  assert.equal(disk.blob, encryptedBefore);
  const exported = await migrated.exportLegacy(oldPass, fingerprint, seal);
  const decoded = await unseal(exported, oldPass, fingerprint, { minLength: 8 });
  const length = new DataView(decoded.buffer, decoded.byteOffset, decoded.byteLength).getUint32(0);
  assert.deepEqual(JSON.parse(new TextDecoder().decode(decoded.subarray(4, 4 + length))), [[['cookies', 'synthetic'], 3], [['outpost-history.ndjson'], 4]]);
  assert.deepEqual([...decoded.subarray(4 + length)], [1, 2, 3, 4, 5, 6, 7]); decoded.fill(0);
  await migrated.close();
});
