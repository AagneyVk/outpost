import { seal, unseal } from '/portable.js';

export const profileLock = 'outpost-gecko-profile';
const defaultProfile = 'outpost-gecko-lab';
const profileKey = 'outpost-gecko-profile-name';
const limit = 64 * 1024 * 1024;
const passphrasePolicy = { minLength: 8 };
const fingerprint = 'ebd6c75179152624d9644865e11792ed25cadc714d9e0985f412baf9c637a086';

export function profileName() {
  const name = localStorage.getItem(profileKey);
  return /^outpost-import-[a-f0-9-]{36}$/.test(name ?? '') ? name : defaultProfile;
}

async function sessionFile(create, name = 'outpost-session.json') {
  const root = await navigator.storage.getDirectory();
  const directory = await root.getDirectoryHandle(profileName(), { create });
  return directory.getFileHandle(name, { create });
}

export async function readBrowserHistory() {
  try {
    const file = await (await sessionFile(false, 'outpost-history.ndjson')).getFile();
    if (file.size > limit) throw Error('Browser history exceeds the preview storage limit.');
    return (await file.text()).split('\n').filter(Boolean);
  } catch (error) {
    if (error.name === 'NotFoundError') return [];
    throw error;
  }
}

export async function writeBrowserHistory(url) {
  const handle = await sessionFile(true, 'outpost-history.ndjson');
  const size = url ? (await handle.getFile()).size : 0;
  const record = url ? url.href + '\n' : '';
  if (size + new TextEncoder().encode(record).length > limit) throw Error('Browser history storage is full.');
  const writer = await handle.createWritable({ keepExistingData: Boolean(url) });
  try {
    if (url) {
      await writer.seek(size);
      await writer.write(record);
    }
    await writer.close();
  } catch (error) {
    await writer.abort().catch(() => {});
    throw error;
  }
}

export async function readBrowserSession() {
  try {
    const file = await (await sessionFile(false)).getFile();
    if (file.size <= 1024 * 1024) return JSON.parse(await file.text());
  } catch (error) {
    if (error.name !== 'NotFoundError' && !(error instanceof SyntaxError)) throw error;
  }
}

export async function writeBrowserSession(session) {
  const writer = await (await sessionFile(true)).createWritable();
  try {
    await writer.write(JSON.stringify(session));
    await writer.close();
  } catch (error) {
    await writer.abort().catch(() => {});
    throw error;
  }
}

export function clearBrowserProfiles() {
  return exclusively(async () => {
    const root = await navigator.storage.getDirectory();
    const names = [];
    for await (const [name, handle] of root.entries()) {
      if (handle.kind === 'directory' &&
          (name === defaultProfile || /^outpost-import-[a-f0-9-]{36}$/.test(name))) names.push(name);
    }
    for (const name of names) await root.removeEntry(name, { recursive: true });
    localStorage.removeItem(profileKey);
  });
}

async function exclusively(operation) {
  return navigator.locks.request(profileLock, { ifAvailable: true }, lock => {
    if (!lock) throw new Error('Close other OUTPOST browser tabs before exporting or importing.');
    return operation();
  });
}

export function exportProfile(passphrase) {
  if (!/^(?=.*[0-9])(?=.*[\p{P}\p{S}])\S{8}$/u.test(passphrase)) {
    return Promise.reject(new Error('Use exactly 8 characters, including a number and a symbol, with no spaces.'));
  }
  return exclusively(async () => {
    const root = await navigator.storage.getDirectory();
    const profile = await root.getDirectoryHandle(profileName());
    const files = [];
    const chunks = [];
    let bytes = 0;
    async function visit(directory, parents) {
      if (parents.length > 32) throw new Error('Profile directory nesting exceeds the export limit.');
      for await (const [name, handle] of directory.entries()) {
        const path = [...parents, name];
        if (handle.kind === 'directory') await visit(handle, path);
        else {
          const file = await handle.getFile();
          bytes += file.size;
          if (bytes > limit || files.length >= 4096) throw new Error('Profile exceeds the preview export limit.');
          files.push([path, file.size]);
          chunks.push(file);
        }
      }
    }
    await visit(profile, []);
    const manifest = new TextEncoder().encode(JSON.stringify(files));
    const prefix = new Uint8Array(4);
    new DataView(prefix.buffer).setUint32(0, manifest.length);
    const raw = new Uint8Array(await new Blob([prefix, manifest, ...chunks]).arrayBuffer());
    try { return await seal(raw, passphrase, fingerprint, passphrasePolicy); }
    finally { raw.fill(0); }
  });
}

export function importProfile(file, passphrase) {
  return exclusively(async () => {
    const raw = await unseal(file, passphrase, fingerprint, passphrasePolicy);
    try {
      if (raw.length < 4 || raw.length > limit + 1024 * 1024) throw new Error('Invalid profile size.');
      const length = new DataView(raw.buffer, raw.byteOffset).getUint32(0);
      if (length > 1024 * 1024 || length + 4 > raw.length) throw new Error('Invalid profile manifest.');
      const files = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(raw.subarray(4, 4 + length)));
      if (!Array.isArray(files) || files.length > 4096) throw new Error('Invalid profile manifest.');
      let offset = 4 + length;
      const names = new Set();
      for (const [path, size] of files) {
        if (!Array.isArray(path) || !path.length || path.length > 32 ||
            path.some(name => typeof name !== 'string' || !name || name === '.' || name === '..' || /[\\/\0]/.test(name)) ||
            !Number.isSafeInteger(size) || size < 0 || size > raw.length - offset) throw new Error('Invalid profile entry.');
        const key = path.join('/');
        if (names.has(key)) throw new Error('Duplicate profile entry.');
        names.add(key);
        offset += size;
      }
      if (offset !== raw.length) throw new Error('Invalid profile data length.');
      const root = await navigator.storage.getDirectory();
      const name = 'outpost-import-' + crypto.randomUUID();
      const profile = await root.getDirectoryHandle(name, { create: true });
      try {
        offset = 4 + length;
        for (const [path, size] of files) {
          let directory = profile;
          for (const part of path.slice(0, -1)) directory = await directory.getDirectoryHandle(part, { create: true });
          const handle = await directory.getFileHandle(path.at(-1), { create: true });
          const writer = await handle.createWritable();
          try {
            await writer.write(raw.subarray(offset, offset + size));
            await writer.close();
          } catch (error) {
            await writer.abort().catch(() => {});
            throw error;
          }
          offset += size;
        }
        localStorage.setItem(profileKey, name);
      } catch (error) {
        await root.removeEntry(name, { recursive: true }).catch(() => {});
        throw error;
      }
    } finally { raw.fill(0); }
  });
}
