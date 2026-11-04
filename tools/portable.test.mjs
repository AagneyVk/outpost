import test from 'node:test';import assert from 'node:assert/strict';
import { seal,unseal } from '../public/portable.js';
const pass='a separate long test passphrase',runtime='a'.repeat(64);
test('portable envelope encrypts, authenticates and rejects another runtime without exposing plaintext',async()=>{
 const raw=new TextEncoder().encode('synthetic-profile-cookie-proof');const blob=await seal(raw,pass,runtime);
 assert.equal((await blob.text()).includes('synthetic-profile-cookie-proof'),false);
 assert.deepEqual(await unseal(blob,pass,runtime),raw);
 await assert.rejects(unseal(blob,'wrong but long password',runtime),/Wrong passphrase/);
 await assert.rejects(unseal(blob,pass,'b'.repeat(64)),/same OUTPOST runtime/);
 const b=new Uint8Array(await blob.arrayBuffer());b[b.length-1]^=1;await assert.rejects(unseal(new Blob([b]),pass,runtime),/damaged/);
});
test('format and expensive KDF parameters are bounded before processing',async()=>{
 await assert.rejects(seal(new Uint8Array([1]),'short',runtime),/passphrase/);
 await assert.rejects(unseal(new Blob(['bad']),pass,runtime),/Invalid/);
});
