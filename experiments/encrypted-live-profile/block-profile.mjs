// Research only. Authenticated fixed-size blocks and the encrypted manifest
// are updated in one transaction. Caller must hold an exclusive store lock.
import { MemoryProfile } from '../memory-profile/memory-profile.mjs';
import { importLegacyProfile, exportLegacyProfile } from './legacy-profile.mjs';
const enc = new TextEncoder(), dec = new TextDecoder('utf-8', { fatal: true });
const mMagic = enc.encode('OUTPOSTMAN2'), bMagic = enc.encode('OUTPOSTBLOCK2');
const maxBytes = 64 * 1024 * 1024, maxEntries = 4096, maxManifest = 1024 * 1024, blockSize = 64 * 1024;
function concat(...parts) { const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0)); let i = 0; for (const p of parts) { out.set(p, i); i += p.length; } return out; }
function canonical(path) {
  if (typeof path !== 'string' || path.includes('\0')) throw Error('Invalid profile path.');
  const parts = path.split('/').filter(Boolean);
  if (parts.length > 32 || parts.some(part => part === '.' || part === '..')) throw Error('Invalid profile path.');
  return parts.join('/');
}
function randomId(excluded = new Set()) {
  for (let attempt = 0; attempt < 8; attempt++) {
    const id = [...crypto.getRandomValues(new Uint8Array(16))].map(b => b.toString(16).padStart(2, '0')).join('');
    if (!excluded.has(id)) return id;
  }
  throw Error('Could not allocate an encrypted record identifier.');
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
async function decrypt(key, blob, magic, headerLength, extra = new Uint8Array(), maximum = blockSize + 1024) {
  if (!(blob instanceof Blob) || blob.size < headerLength + 16 || blob.size > maximum) throw Error('Invalid encrypted profile record.');
  const all = new Uint8Array(await blob.arrayBuffer()), header = all.subarray(0, headerLength);
  if (!magic.every((v, i) => header[i] === v)) throw Error('Invalid encrypted profile record.');
  try { return new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: header.subarray(headerLength - 12), additionalData: concat(header, extra), tagLength: 128 }, key, all.subarray(headerLength))); }
  catch { throw Error('Wrong passphrase or damaged encrypted profile.'); }
}
function extra(id, index, version) { return enc.encode(`${id}:${index}:${version}`); }
async function manifestBlob(key, salt, fs, records) {
  const entries = fs.metadata().map(entry => {
    const record = records.get(entry.path);
    return [entry.path, entry.isDir, entry.size, entry.isDir ? null : record?.id, entry.isDir ? [] : record?.versions];
  });
  if (entries.length > maxEntries || entries.some(e => !e[1] && (!/^[a-f0-9]{32}$/.test(e[3] ?? '') || !Array.isArray(e[4]) || e[4].length !== Math.ceil(e[2] / blockSize)))) throw Error('Invalid encrypted profile metadata.');
  const bytes = enc.encode(JSON.stringify({ version: 2, blockSize, entries }));
  try {
    if (bytes.length > maxManifest) throw Error('Encrypted profile manifest too large.');
    const iv = crypto.getRandomValues(new Uint8Array(12));
    return await encrypt(key, concat(mMagic, salt, iv), iv, bytes);
  } finally { bytes.fill(0); }
}
async function blockBlob(key, id, index, version, bytes) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  return encrypt(key, concat(bMagic, iv), iv, bytes, extra(id, index, version));
}
async function prepareFile(key, id, bytes) {
  const versions = [], puts = [];
  for (let index = 0; index < Math.ceil(bytes.length / blockSize); index++) {
    const version = randomId(); versions.push(version);
    puts.push([id, index, await blockBlob(key, id, index, version, bytes.subarray(index * blockSize, Math.min(bytes.length, (index + 1) * blockSize)))]);
  }
  return { versions, puts };
}

export class BlockLiveProfile {
  #fs; #records; #store; #key; #salt; #tail = Promise.resolve(); #closed = false; #closing = false; #closePromise; #poisoned = false; #fatalHandler;
  constructor(fs, records, store, key, salt) { this.#fs = fs; this.#records = records; this.#store = store; this.#key = key; this.#salt = salt; }
  static async open(store, passphrase) {
    const blob = await store.readManifest(); let salt;
    if (blob === null) {
      if ((await store.listBlockKeys()).length) throw Error('Encrypted profile has orphaned blocks.');
      salt = crypto.getRandomValues(new Uint8Array(16));
    } else {
      if (!(blob instanceof Blob) || blob.size < mMagic.length + 44 || blob.size > maxManifest + 128) throw Error('Invalid encrypted manifest.');
      const header = new Uint8Array(await blob.slice(0, mMagic.length + 28).arrayBuffer());
      if (!mMagic.every((v, i) => v === header[i])) throw Error('Unsupported encrypted manifest.');
      salt = header.slice(mMagic.length, mMagic.length + 16);
    }
    const key = await keyFor(passphrase, salt), fs = new MemoryProfile(), records = new Map();
    try {
      if (blob === null) await store.commit(await manifestBlob(key, salt, fs, records), [], []);
      else {
        const bytes = await decrypt(key, blob, mMagic, mMagic.length + 28, new Uint8Array(), maxManifest + 128);
        let manifest;
        try { manifest = JSON.parse(dec.decode(bytes)); } finally { bytes.fill(0); }
        if (manifest?.version !== 2 || manifest.blockSize !== blockSize || !Array.isArray(manifest.entries) || manifest.entries.length > maxEntries) throw Error('Invalid encrypted manifest.');
        const paths = new Set(), fileIds = new Set(), expected = new Set(), items = []; let total = 0;
        for (const item of manifest.entries) {
          if (!Array.isArray(item) || item.length !== 5) throw Error('Invalid encrypted manifest entry.');
          const [path, isDir, size, id, versions] = item;
          if (typeof path !== 'string' || !path || canonical(path) !== path || typeof isDir !== 'boolean' || !Number.isSafeInteger(size) || size < 0 ||
              !Array.isArray(versions) || (isDir ? size !== 0 || id !== null || versions.length !== 0 :
                !/^[a-f0-9]{32}$/.test(id ?? '') || fileIds.has(id) || versions.length !== Math.ceil(size / blockSize) || versions.some(v => !/^[a-f0-9]{32}$/.test(v))) || paths.has(path)) throw Error('Invalid encrypted manifest entry.');
          paths.add(path); if (!isDir) { fileIds.add(id); versions.forEach((_, index) => expected.add(`block:${id}:${index}`)); }
          total += size; if (total > maxBytes) throw Error('Encrypted profile exceeds size limit.');
          items.push({ path, isDir, size, id, versions });
        }
        const actual = await store.listBlockKeys();
        if (actual.length !== expected.size || actual.some(name => !expected.has(name))) throw Error('Encrypted profile has missing or orphaned blocks.');
        items.sort((a, b) => a.path.split('/').length - b.path.split('/').length);
        for (const item of items) {
          if (item.isDir) await fs.mkdir(item.path);
          else {
            const data = new Uint8Array(item.size);
            try {
              for (let index = 0; index < item.versions.length; index++) {
                const block = await decrypt(key, await store.readBlock(item.id, index), bMagic, bMagic.length + 12, extra(item.id, index, item.versions[index]));
                try {
                  if (block.length !== Math.min(blockSize, item.size - index * blockSize)) throw Error('Encrypted block length mismatch.');
                  data.set(block, index * blockSize);
                } finally { block.fill(0); }
              }
              await fs.writeFile(item.path, data); records.set(item.path, { id: item.id, versions: item.versions });
            } finally { data.fill(0); }
          }
        }
      }
      return new BlockLiveProfile(fs, records, store, key, salt);
    } catch (error) { fs.destroy(); throw error; }
  }
  static async createFromLegacy(store, livePassphrase, blob, exportPassphrase, fingerprint, unseal) {
    if (await store.readManifest() !== null || (await store.listBlockKeys()).length) throw Error('Encrypted live profile already exists; it was not changed.');
    const fs = await importLegacyProfile(blob, exportPassphrase, fingerprint, unseal), records = new Map(), puts = [];
    try {
      const salt = crypto.getRandomValues(new Uint8Array(16)), key = await keyFor(livePassphrase, salt);
      for (const entry of fs.metadata()) if (!entry.isDir) {
        const id = randomId(new Set([...records.values()].map(value => value.id))), data = await fs.readFile(entry.path);
        try { const prepared = await prepareFile(key, id, data); records.set(entry.path, { id, versions: prepared.versions }); puts.push(...prepared.puts); }
        finally { data.fill(0); }
      }
      await store.commit(await manifestBlob(key, salt, fs, records), puts, []);
      return new BlockLiveProfile(fs, records, store, key, salt);
    } catch (error) { fs.destroy(); throw error; }
  }
  #run(operation) {
    if (this.#closing) return Promise.reject(Error('Encrypted profile is closing.'));
    const result = this.#tail.then(() => { if (this.#closed || this.#poisoned) throw Error('Encrypted profile is closed or needs recovery.'); return operation(); });
    this.#tail = result.catch(() => {}); return result;
  }
  #read(method, args) { return this.#run(() => this.#fs[method](...args)); }
  onFatal(handler) { if (typeof handler !== 'function') throw Error('Invalid profile error handler.'); this.#fatalHandler = handler; }
  #fatal(error) { this.#poisoned = true; try { this.#fatalHandler?.(error); } catch {} }
  async #commit(puts = [], deletes = []) {
    try { await this.#store.commit(await manifestBlob(this.#key, this.#salt, this.#fs, this.#records), puts, deletes); }
    catch (error) { const failure = Error('Encrypted profile write failed; reopen it to recover.', { cause: error }); this.#fatal(failure); throw failure; }
  }
  stat(path) { return this.#read('stat', [path]); }
  readdir(path) { return this.#read('readdir', [path]); }
  readFile(path) { return this.#read('readFile', [path]); }
  mkdir(path) { return this.#run(async () => {
    path = canonical(path); if ((await this.#fs.stat(path))?.isDir) return;
    try { await this.#fs.mkdir(path); } catch (error) { if (/limit exceeded/i.test(error.message)) this.#fatal(error); throw error; }
    await this.#commit();
  }); }
  unlink(path) { return this.#run(async () => {
    path = canonical(path); const record = this.#records.get(path); await this.#fs.unlink(path); this.#records.delete(path);
    await this.#commit([], record ? record.versions.map((_, index) => [record.id, index]) : []);
  }); }
  rename(from, to) { return this.#run(async () => {
    from = canonical(from); to = canonical(to); if (from === to) { if (!await this.#fs.stat(from)) throw Error('Entry not found.'); return; }
    const previous = this.#records.get(to), moved = [...this.#records].filter(([path]) => path === from || path.startsWith(from + '/'));
    await this.#fs.rename(from, to);
    this.#records.delete(to); for (const [path] of moved) this.#records.delete(path);
    for (const [path, record] of moved) this.#records.set(to + path.slice(from.length), record);
    await this.#commit([], previous ? previous.versions.map((_, index) => [previous.id, index]) : []);
  }); }
  async writeFile(path, data) {
    if (this.#closing || this.#closed || this.#poisoned) throw Error('Encrypted profile is closed or needs recovery.');
    if (!(data instanceof Uint8Array)) throw Error('Invalid file data.');
    if (data.length > maxBytes) { const failure = Error('Encrypted profile file is too large.'); this.#fatal(failure); throw failure; }
    const copy = data.slice();
    try { return await this.#run(async () => {
      path = canonical(path);
      const previous = this.#records.get(path), stat = await this.#fs.stat(path);
      if (stat?.isDir) throw Error('Path is a directory.');
      if (stat && !previous) { const failure = Error('Encrypted profile metadata is inconsistent.'); this.#fatal(failure); throw failure; }
      const metadata = this.#fs.metadata(), total = metadata.reduce((sum, entry) => sum + entry.size, 0);
      if ((!stat && metadata.length >= maxEntries - 1) || total - (stat?.size ?? 0) + copy.length > maxBytes) {
        const failure = Error('Encrypted profile size or entry limit exceeded.'); this.#fatal(failure); throw failure;
      }
      let id, versions, puts;
      try {
        id = previous?.id ?? randomId(new Set([...this.#records.values()].map(value => value.id)));
        versions = previous ? previous.versions.slice(0, Math.ceil(copy.length / blockSize)) : [];
        const changed = this.#fs.changedBlocks(path, copy, blockSize); puts = [];
        for (const index of changed) {
          const version = randomId(new Set(previous?.versions[index] ? [previous.versions[index]] : [])); versions[index] = version;
          puts.push([id, index, await blockBlob(this.#key, id, index, version, copy.subarray(index * blockSize, Math.min(copy.length, (index + 1) * blockSize)))]);
        }
      } catch (error) {
        const failure = Error('Encrypted profile write failed; reopen it to recover.', { cause: error });
        this.#fatal(failure); throw failure;
      }
      const deletes = previous ? previous.versions.slice(versions.length).map((_, offset) => [id, versions.length + offset]) : [];
      await this.#fs.writeFile(path, copy); this.#records.set(path, { id, versions });
      await this.#commit(puts, deletes);
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
