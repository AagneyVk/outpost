// Research-only conversion of the existing OUTPOST Gecko export format.
// Conversion happens in memory; callers must use an exclusive, atomic store.
import { MemoryProfile } from '../memory-profile/memory-profile.mjs';
const limit = 64 * 1024 * 1024, manifestLimit = 1024 * 1024, maxFiles = 4096;
const policy = { minLength: 8, maxOutputBytes: limit + manifestLimit };
const encoder = new TextEncoder();

function validPath(path) {
  return Array.isArray(path) && path.length > 0 && path.length <= 32 &&
    path.every(part => typeof part === 'string' && part && part !== '.' && part !== '..' && !/[\\/\0]/.test(part));
}

export async function importLegacyProfile(blob, passphrase, fingerprint, unseal) {
  const raw = await unseal(blob, passphrase, fingerprint, policy), profile = new MemoryProfile();
  try {
    if (raw.length < 4 || raw.length > limit + manifestLimit) throw Error('Invalid legacy profile size.');
    const length = new DataView(raw.buffer, raw.byteOffset, raw.byteLength).getUint32(0);
    if (length > manifestLimit || length + 4 > raw.length) throw Error('Invalid legacy profile manifest.');
    const manifest = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(raw.subarray(4, 4 + length)));
    if (!Array.isArray(manifest) || manifest.length > maxFiles) throw Error('Invalid legacy profile manifest.');
    const seen = new Set(), files = []; let offset = 4 + length, total = 0;
    for (const entry of manifest) {
      if (!Array.isArray(entry) || entry.length !== 2) throw Error('Invalid legacy profile entry.');
      const [parts, size] = entry;
      if (!validPath(parts) || !Number.isSafeInteger(size) || size < 0 || size > raw.length - offset) throw Error('Invalid legacy profile entry.');
      const name = parts.join('/');
      if (seen.has(name)) throw Error('Duplicate legacy profile entry.');
      seen.add(name); total += size;
      if (total > limit) throw Error('Legacy profile exceeds size limit.');
      files.push({ parts, size, offset }); offset += size;
    }
    if (offset !== raw.length) throw Error('Invalid legacy profile data length.');
    for (const file of files) {
      for (let index = 1; index < file.parts.length; index++) await profile.mkdir(file.parts.slice(0, index).join('/'));
      await profile.writeFile(file.parts.join('/'), raw.subarray(file.offset, file.offset + file.size));
    }
    return profile;
  } catch (error) { profile.destroy(); throw error; }
  finally { raw.fill(0); }
}

export async function exportLegacyProfile(profile, passphrase, fingerprint, seal) {
  const entries = profile.snapshot();
  try {
    const files = entries.filter(entry => !entry.isDir);
    if (files.length > maxFiles) throw Error('Too many legacy profile entries.');
    let size = 0;
    const manifest = files.map(entry => {
      const parts = entry.path.split('/');
      if (!validPath(parts)) throw Error('Profile contains a path the legacy format cannot import.');
      size += entry.data.length;
      if (size > limit) throw Error('Profile exceeds legacy export size limit.');
      return [parts, entry.data.length];
    });
    const header = encoder.encode(JSON.stringify(manifest));
    if (header.length > manifestLimit) throw Error('Legacy profile manifest is too large.');
    const prefix = new Uint8Array(4); new DataView(prefix.buffer).setUint32(0, header.length);
    const raw = new Uint8Array(await new Blob([prefix, header, ...files.map(entry => entry.data)]).arrayBuffer());
    try { return await seal(raw, passphrase, fingerprint, policy); } finally { raw.fill(0); }
  } finally { for (const entry of entries) entry.data?.fill(0); }
}
