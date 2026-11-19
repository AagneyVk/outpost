// Research-only memory-profile transfer; callers supply the existing portable
// envelope functions. A caller must stop writes before taking a snapshot.
import { MemoryProfile } from './memory-profile.mjs';
const maxBytes = 64 * 1024 * 1024, maxEntries = 4096, maxManifest = 1024 * 1024;
const policy = { minLength: 8, maxOutputBytes: maxBytes + maxManifest + 4 };

export async function sealMemoryProfile(profile, seal, passphrase, fingerprint) {
  const entries = profile.snapshot();
  try {
    if (entries.length > maxEntries) throw Error('Too many profile entries.');
    let total = 0;
    const manifest = entries.map(({ path, isDir, data }) => {
      total += data?.length ?? 0;
      if (total > maxBytes) throw Error('Memory profile exceeds archive limit.');
      return [path, isDir, data?.length ?? 0];
    });
    const header = new TextEncoder().encode(JSON.stringify(manifest));
    if (header.length > maxManifest) throw Error('Memory profile manifest is too large.');
    const prefix = new Uint8Array(4); new DataView(prefix.buffer).setUint32(0, header.length);
    const raw = new Uint8Array(await new Blob([prefix, header, ...entries.filter(item => !item.isDir).map(item => item.data)]).arrayBuffer());
    try { return await seal(raw, passphrase, fingerprint, policy); } finally { raw.fill(0); }
  } finally { for (const item of entries) item.data?.fill(0); }
}

export async function unsealMemoryProfile(blob, unseal, passphrase, fingerprint) {
  const raw = await unseal(blob, passphrase, fingerprint, policy), profile = new MemoryProfile();
  try {
    if (raw.length < 4) throw Error('Invalid memory profile archive.');
    const length = new DataView(raw.buffer, raw.byteOffset, raw.byteLength).getUint32(0);
    if (length > maxManifest || length + 4 > raw.length) throw Error('Invalid memory profile manifest.');
    const manifest = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(raw.subarray(4, 4 + length)));
    if (!Array.isArray(manifest) || manifest.length > maxEntries) throw Error('Invalid memory profile manifest.');
    const seen = new Set(), items = []; let offset = 4 + length, total = 0;
    for (const entry of manifest) {
      if (!Array.isArray(entry) || entry.length !== 3) throw Error('Invalid memory profile entry.');
      const [path, isDir, size] = entry;
      if (typeof path !== 'string' || !path || path.startsWith('/') || path.endsWith('/') ||
          path.split('/').some(part => !part || part === '.' || part === '..' || /[\\\0]/.test(part)) ||
          typeof isDir !== 'boolean' || !Number.isSafeInteger(size) || size < 0 || (isDir && size) ||
          size > raw.length - offset || seen.has(path)) throw Error('Invalid memory profile entry.');
      seen.add(path); total += size;
      if (total > maxBytes) throw Error('Memory profile exceeds archive limit.');
      items.push({ path, isDir, size, offset }); offset += size;
    }
    if (offset !== raw.length) throw Error('Invalid memory profile length.');
    items.sort((a, b) => a.path.split('/').length - b.path.split('/').length);
    for (const item of items) {
      if (item.isDir) await profile.mkdir(item.path);
      else await profile.writeFile(item.path, raw.subarray(item.offset, item.offset + item.size));
    }
    return profile;
  } catch (error) { profile.destroy(); throw error; }
  finally { raw.fill(0); }
}
