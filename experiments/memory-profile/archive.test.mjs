import { test } from 'node:test';
import assert from 'node:assert/strict';
import { seal, unseal } from '../../public/portable.js';
import { MemoryProfile } from './memory-profile.mjs';
import { sealMemoryProfile, unsealMemoryProfile } from './archive.mjs';
const passphrase = 'synthetic memory profile passphrase', fingerprint = 'a'.repeat(64);

test('transfers a synthetic memory profile through an authenticated encrypted envelope', async () => {
  const profile = new MemoryProfile(); await profile.mkdir('cookies');
  await profile.writeFile('cookies/session', new TextEncoder().encode('synthetic session data'));
  const blob = await sealMemoryProfile(profile, seal, passphrase, fingerprint);
  assert.equal(Buffer.from(await blob.arrayBuffer()).includes(Buffer.from('synthetic session data')), false);
  await assert.rejects(unsealMemoryProfile(blob, unseal, 'wrong password', fingerprint), /Wrong passphrase/);
  const bytes = new Uint8Array(await blob.arrayBuffer()); bytes[bytes.length - 1] ^= 1;
  await assert.rejects(unsealMemoryProfile(new Blob([bytes]), unseal, passphrase, fingerprint), /damaged workspace/);
  const restored = await unsealMemoryProfile(blob, unseal, passphrase, fingerprint);
  assert.equal(new TextDecoder().decode(await restored.readFile('cookies/session')), 'synthetic session data');
  profile.destroy(); restored.destroy();
});

test('rejects authenticated archives with invalid or duplicate paths', async () => {
  for (const manifest of [[['../outside', false, 0]], [['same', true, 0], ['same', true, 0]]]) {
    const header = new TextEncoder().encode(JSON.stringify(manifest)), prefix = new Uint8Array(4);
    new DataView(prefix.buffer).setUint32(0, header.length);
    const blob = await seal(new Uint8Array(await new Blob([prefix, header]).arrayBuffer()), passphrase, fingerprint, { minLength: 8 });
    await assert.rejects(unsealMemoryProfile(blob, unseal, passphrase, fingerprint), /Invalid memory profile entry/);
  }
});
