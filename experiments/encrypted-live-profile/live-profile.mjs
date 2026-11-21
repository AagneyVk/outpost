// Research only. The caller must hold an exclusive lock for the store lifetime.
// This whole-profile write-through design prioritizes testing crash behavior;
// it has not been approved for real user data or production use.
import { MemoryProfile } from '../memory-profile/memory-profile.mjs';
import { sealMemoryProfile, unsealMemoryProfile } from '../memory-profile/archive.mjs';
import { importLegacyProfile, exportLegacyProfile } from './legacy-profile.mjs';

const magic = new TextEncoder().encode('OUTPOSTLIVE1');
const headerSize = magic.length + 16 + 12, maxCipher = 66 * 1024 * 1024;
const fingerprint = 'a'.repeat(64); // The experimental archive is not an OUTPOST export.
const encoder = new TextEncoder();

async function derive(passphrase, salt) {
  if (typeof passphrase !== 'string' || passphrase.length < 8 || passphrase.length > 1024) throw Error('Invalid live-profile passphrase.');
  const bytes = encoder.encode(passphrase);
  try {
    const material = await crypto.subtle.importKey('raw', bytes, 'PBKDF2', false, ['deriveKey']);
    return await crypto.subtle.deriveKey({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: 600000 }, material,
      { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
  } finally { bytes.fill(0); }
}

async function encryptProfile(profile, key, salt) {
  return sealMemoryProfile(profile, async raw => {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const header = new Uint8Array(headerSize); header.set(magic); header.set(salt, magic.length); header.set(iv, magic.length + 16);
    const cipher = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: header, tagLength: 128 }, key, raw);
    return new Blob([header, cipher], { type: 'application/octet-stream' });
  }, 'unused-value', fingerprint);
}

async function decryptProfile(blob, key) {
  return unsealMemoryProfile(blob, async input => {
    if (!(input instanceof Blob) || input.size < headerSize + 16 || input.size > maxCipher) throw Error('Invalid encrypted live profile.');
    const all = new Uint8Array(await input.arrayBuffer());
    const header = all.subarray(0, headerSize), iv = header.subarray(magic.length + 16);
    try {
      return new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv, additionalData: header, tagLength: 128 }, key, all.subarray(headerSize)));
    } catch { throw Error('Wrong passphrase or damaged live profile.'); }
  }, 'unused-value', fingerprint);
}

async function saltFrom(blob) {
  if (!(blob instanceof Blob) || blob.size < headerSize + 16 || blob.size > maxCipher) throw Error('Invalid encrypted live profile.');
  const head = new Uint8Array(await blob.slice(0, headerSize).arrayBuffer());
  if (!magic.every((byte, index) => byte === head[index])) throw Error('Unsupported encrypted live profile.');
  return head.slice(magic.length, magic.length + 16);
}

async function restoreSnapshot(snapshot) {
  const restored = new MemoryProfile();
  try {
    const ordered = [...snapshot].sort((a, b) => a.path.split('/').length - b.path.split('/').length);
    for (const entry of ordered) {
      if (entry.isDir) await restored.mkdir(entry.path);
      else await restored.writeFile(entry.path, entry.data);
    }
    return restored;
  } catch (error) { restored.destroy(); throw error; }
}

export class EncryptedLiveProfile {
  #profile; #store; #key; #salt; #tail = Promise.resolve(); #closed = false; #closing = false; #closePromise; #poisoned = false;
  constructor(profile, store, key, salt) { this.#profile = profile; this.#store = store; this.#key = key; this.#salt = salt; }

  // store.read() returns a Blob or null; store.commit(blob) resolves only when
  // its atomic transaction completes. Callers must provide exclusive access.
  static async open(store, passphrase) {
    const blob = await store.read();
    const salt = blob === null ? crypto.getRandomValues(new Uint8Array(16)) : await saltFrom(blob);
    const key = await derive(passphrase, salt);
    const profile = blob === null ? new MemoryProfile() : await decryptProfile(blob, key);
    const live = new EncryptedLiveProfile(profile, store, key, salt);
    try {
      if (blob === null) await store.commit(await encryptProfile(profile, key, salt));
      return live;
    } catch (error) { profile.destroy(); throw error; }
  }
  static async createFromLegacy(store, livePassphrase, blob, exportPassphrase, legacyFingerprint, unseal) {
    if (await store.read() !== null) throw Error('Encrypted live profile already exists; it was not changed.');
    const profile = await importLegacyProfile(blob, exportPassphrase, legacyFingerprint, unseal);
    try {
      const salt = crypto.getRandomValues(new Uint8Array(16)), key = await derive(livePassphrase, salt);
      await store.commit(await encryptProfile(profile, key, salt));
      return new EncryptedLiveProfile(profile, store, key, salt);
    } catch (error) { profile.destroy(); throw error; }
  }
  #run(operation) {
    if (this.#closing) return Promise.reject(Error('Encrypted profile is closing.'));
    const result = this.#tail.then(() => {
      if (this.#closed || this.#poisoned) throw Error('Encrypted profile is closed or needs recovery.');
      return operation();
    });
    this.#tail = result.catch(() => {});
    return result;
  }
  #read(method, args) { return this.#run(() => this.#profile[method](...args)); }
  #mutate(method, args) {
    return this.#run(async () => {
      const before = this.#profile.snapshot();
      try {
        await this.#profile[method](...args);
        try { await this.#store.commit(await encryptProfile(this.#profile, this.#key, this.#salt)); }
        catch (error) {
          this.#poisoned = true;
          this.#profile.destroy();
          this.#profile = await restoreSnapshot(before);
          throw Error('Encrypted profile write failed; reopen it to recover.', { cause: error });
        }
      } finally { for (const entry of before) entry.data?.fill(0); }
    });
  }
  stat(path) { return this.#read('stat', [path]); }
  readdir(path) { return this.#read('readdir', [path]); }
  readFile(path) { return this.#read('readFile', [path]); }
  mkdir(path) { return this.#mutate('mkdir', [path]); }
  unlink(path) { return this.#mutate('unlink', [path]); }
  rename(from, to) { return this.#mutate('rename', [from, to]); }
  exportLegacy(passphrase, legacyFingerprint, seal) {
    return this.#run(() => exportLegacyProfile(this.#profile, passphrase, legacyFingerprint, seal));
  }
  async writeFile(path, data) {
    if (!(data instanceof Uint8Array) || data.length > 64 * 1024 * 1024) throw Error('Invalid or oversized file data.');
    const copy = data.slice();
    try { return await this.#mutate('writeFile', [path, copy]); }
    finally { copy.fill(0); }
  }
  close() {
    if (this.#closePromise) return this.#closePromise;
    this.#closing = true;
    this.#closePromise = (async () => {
      await this.#tail;
      this.#closed = true; this.#profile.destroy(); this.#key = null; this.#salt.fill(0);
    })();
    return this.#closePromise;
  }
}
