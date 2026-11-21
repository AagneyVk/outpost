// Research only. Each file and the manifest are separately authenticated;
// the caller must hold the store's exclusive lock until close.
import { MemoryProfile } from '../memory-profile/memory-profile.mjs';
import { importLegacyProfile, exportLegacyProfile } from './legacy-profile.mjs';
const enc = new TextEncoder(), dec = new TextDecoder('utf-8', { fatal: true });
const mMagic = enc.encode('OUTPOSTMAN1'), fMagic = enc.encode('OUTPOSTFILE1');
const maxBytes = 64 * 1024 * 1024, maxEntries = 4096, maxManifest = 1024 * 1024;
function concat(...parts) { const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0)); let i = 0; for (const p of parts) { out.set(p, i); i += p.length; } return out; }
function canonical(path) {
  if (typeof path !== 'string' || path.includes('\0')) throw Error('Invalid profile path.');
  const parts = path.split('/').filter(Boolean);
  if (parts.length > 32 || parts.some(part => part === '.' || part === '..')) throw Error('Invalid profile path.');
  return parts.join('/');
}
function newId(existing) {
  for (let attempt = 0; attempt < 8; attempt++) {
    const id = [...crypto.getRandomValues(new Uint8Array(16))].map(b => b.toString(16).padStart(2, '0')).join('');
    if (![...existing.values()].includes(id)) return id;
  }
  throw Error('Could not allocate an encrypted file identifier.');
}
async function keyFor(passphrase, salt) {
  if (typeof passphrase !== 'string' || passphrase.length < 8 || passphrase.length > 1024) throw Error('Invalid live-profile passphrase.');
  const bytes = enc.encode(passphrase);
  try {
    const material = await crypto.subtle.importKey('raw', bytes, 'PBKDF2', false, ['deriveKey']);
    return await crypto.subtle.deriveKey({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: 600000 }, material,
      { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
  } finally { bytes.fill(0); }
}
async function encrypt(key, header, iv, plaintext, extra = new Uint8Array()) {
  return new Blob([header, await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: concat(header, extra), tagLength: 128 }, key, plaintext)]);
}
async function decrypt(key, blob, magic, headerLength, extra = new Uint8Array(), maximum = maxBytes + 1024) {
  if (!(blob instanceof Blob) || blob.size < headerLength + 16 || blob.size > maximum) throw Error('Invalid encrypted profile record.');
  const all = new Uint8Array(await blob.arrayBuffer()), header = all.subarray(0, headerLength);
  if (!magic.every((v, i) => header[i] === v)) throw Error('Invalid encrypted profile record.');
  try { return new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: header.subarray(headerLength - 12), additionalData: concat(header, extra), tagLength: 128 }, key, all.subarray(headerLength))); }
  catch { throw Error('Wrong passphrase or damaged encrypted profile.'); }
}
async function manifestBlob(key, salt, fs, ids) {
  const entries = fs.metadata().map(entry => [entry.path, entry.isDir, entry.size, entry.isDir ? null : ids.get(entry.path)]);
  if (entries.length > maxEntries || entries.some(entry => !entry[1] && !/^[a-f0-9]{32}$/.test(entry[3] ?? ''))) throw Error('Invalid encrypted profile metadata.');
  const bytes = enc.encode(JSON.stringify({ version: 1, entries }));
  try {
    if (bytes.length > maxManifest) throw Error('Encrypted profile manifest too large.');
    const iv = crypto.getRandomValues(new Uint8Array(12));
    return await encrypt(key, concat(mMagic, salt, iv), iv, bytes);
  } finally { bytes.fill(0); }
}
async function fileBlob(key, id, bytes) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  return encrypt(key, concat(fMagic, iv), iv, bytes, enc.encode(id));
}

export class ChunkedLiveProfile {
  #fs; #ids; #store; #key; #salt; #tail = Promise.resolve(); #closed = false; #closing = false; #closePromise; #poisoned = false;
  constructor(fs, ids, store, key, salt) { this.#fs = fs; this.#ids = ids; this.#store = store; this.#key = key; this.#salt = salt; }
  static async open(store, passphrase) {
    const blob = await store.readManifest();
    let salt;
    if (blob === null) {
      if ((await store.listFileIds()).length) throw Error('Encrypted profile has orphaned records.');
      salt = crypto.getRandomValues(new Uint8Array(16));
    } else {
      if (!(blob instanceof Blob) || blob.size < mMagic.length + 44 || blob.size > maxManifest + 128) throw Error('Invalid encrypted manifest.');
      const header = new Uint8Array(await blob.slice(0, mMagic.length + 28).arrayBuffer());
      if (!mMagic.every((v, i) => v === header[i])) throw Error('Unsupported encrypted manifest.');
      salt = header.slice(mMagic.length, mMagic.length + 16);
    }
    const key = await keyFor(passphrase, salt), fs = new MemoryProfile(), ids = new Map();
    try {
      if (blob === null) await store.commit(await manifestBlob(key, salt, fs, ids), [], []);
      else {
        const bytes = await decrypt(key, blob, mMagic, mMagic.length + 28, new Uint8Array(), maxManifest + 128);
        let manifest;
        try { manifest = JSON.parse(dec.decode(bytes)); } finally { bytes.fill(0); }
        if (manifest?.version !== 1 || !Array.isArray(manifest.entries) || manifest.entries.length > maxEntries) throw Error('Invalid encrypted manifest.');
        const paths = new Set(), fileIds = new Set(), items = []; let total = 0;
        for (const item of manifest.entries) {
          if (!Array.isArray(item) || item.length !== 4) throw Error('Invalid encrypted manifest entry.');
          const [path, isDir, size, id] = item;
          if (typeof path !== 'string' || !path || canonical(path) !== path || typeof isDir !== 'boolean' || !Number.isSafeInteger(size) || size < 0 ||
              (isDir ? size !== 0 || id !== null : !/^[a-f0-9]{32}$/.test(id ?? '') || fileIds.has(id)) || paths.has(path)) throw Error('Invalid encrypted manifest entry.');
          paths.add(path); if (!isDir) fileIds.add(id); total += size;
          if (total > maxBytes) throw Error('Encrypted profile exceeds size limit.');
          items.push({ path, isDir, size, id });
        }
        const actualIds = await store.listFileIds();
        if (actualIds.length !== fileIds.size || actualIds.some(id => !fileIds.has(id))) throw Error('Encrypted profile has missing or orphaned records.');
        items.sort((a, b) => a.path.split('/').length - b.path.split('/').length);
        for (const item of items) {
          if (item.isDir) await fs.mkdir(item.path);
          else {
            const data = await decrypt(key, await store.readFile(item.id), fMagic, fMagic.length + 12, enc.encode(item.id));
            try { if (data.length !== item.size) throw Error('Encrypted file length mismatch.'); await fs.writeFile(item.path, data); ids.set(item.path, item.id); }
            finally { data.fill(0); }
          }
        }
      }
      return new ChunkedLiveProfile(fs, ids, store, key, salt);
    } catch (error) { fs.destroy(); throw error; }
  }
  static async createFromLegacy(store, livePassphrase, blob, exportPassphrase, fingerprint, unseal) {
    if (await store.readManifest() !== null || (await store.listFileIds()).length) throw Error('Encrypted live profile already exists; it was not changed.');
    const fs = await importLegacyProfile(blob, exportPassphrase, fingerprint, unseal), ids = new Map(), puts = [];
    try {
      const salt = crypto.getRandomValues(new Uint8Array(16)), key = await keyFor(livePassphrase, salt);
      for (const entry of fs.metadata()) if (!entry.isDir) {
        const id = newId(ids); ids.set(entry.path, id);
        const data = await fs.readFile(entry.path);
        try { puts.push([id, await fileBlob(key, id, data)]); } finally { data.fill(0); }
      }
      await store.commit(await manifestBlob(key, salt, fs, ids), puts, []);
      return new ChunkedLiveProfile(fs, ids, store, key, salt);
    } catch (error) { fs.destroy(); throw error; }
  }
  #run(operation) {
    if (this.#closing) return Promise.reject(Error('Encrypted profile is closing.'));
    const result = this.#tail.then(() => { if (this.#closed || this.#poisoned) throw Error('Encrypted profile is closed or needs recovery.'); return operation(); });
    this.#tail = result.catch(() => {}); return result;
  }
  #read(method, args) { return this.#run(() => this.#fs[method](...args)); }
  async #commit(puts = [], deletes = []) {
    try { await this.#store.commit(await manifestBlob(this.#key, this.#salt, this.#fs, this.#ids), puts, deletes); }
    catch (error) { this.#poisoned = true; throw Error('Encrypted profile write failed; reopen it to recover.', { cause: error }); }
  }
  stat(path) { return this.#read('stat', [path]); }
  readdir(path) { return this.#read('readdir', [path]); }
  readFile(path) { return this.#read('readFile', [path]); }
  mkdir(path) { return this.#run(async () => { path = canonical(path); if ((await this.#fs.stat(path))?.isDir) return; await this.#fs.mkdir(path); await this.#commit(); }); }
  unlink(path) { return this.#run(async () => {
    path = canonical(path); const id = this.#ids.get(path); await this.#fs.unlink(path); this.#ids.delete(path); await this.#commit([], id ? [id] : []);
  }); }
  rename(from, to) { return this.#run(async () => {
    from = canonical(from); to = canonical(to); if (from === to) { if (!await this.#fs.stat(from)) throw Error('Entry not found.'); return; }
    const previous = this.#ids.get(to), moved = [...this.#ids].filter(([path]) => path === from || path.startsWith(from + '/'));
    await this.#fs.rename(from, to);
    this.#ids.delete(to); for (const [path] of moved) this.#ids.delete(path);
    for (const [path, id] of moved) this.#ids.set(to + path.slice(from.length), id);
    await this.#commit([], previous ? [previous] : []);
  }); }
  async writeFile(path, data) {
    if (!(data instanceof Uint8Array) || data.length > maxBytes) throw Error('Invalid or oversized file data.');
    const copy = data.slice();
    try { return await this.#run(async () => {
      path = canonical(path); await this.#fs.writeFile(path, copy);
      let id;
      try { id = this.#ids.get(path) ?? newId(this.#ids); this.#ids.set(path, id); }
      catch (error) { this.#poisoned = true; throw error; }
      let encrypted;
      try { encrypted = await fileBlob(this.#key, id, copy); } catch (error) { this.#poisoned = true; throw error; }
      await this.#commit([[id, encrypted]], []);
    }); } finally { copy.fill(0); }
  }
  exportLegacy(passphrase, fingerprint, seal) { return this.#run(() => exportLegacyProfile(this.#fs, passphrase, fingerprint, seal)); }
  close() {
    if (this.#closePromise) return this.#closePromise;
    this.#closing = true;
    this.#closePromise = (async () => { await this.#tail; this.#closed = true; this.#fs.destroy(); this.#key = null; this.#salt.fill(0); })();
    return this.#closePromise;
  }
}
