import { openBlockTestStore } from './block-store.mjs';
import { BlockLiveProfile } from './block-profile.mjs';

async function acquire(name) {
  if (typeof name !== 'string' || !/^outpost-live-test-[a-z0-9-]{1,80}$/.test(name)) throw Error('Invalid test store name.');
  if (!navigator.locks) throw Error('Exclusive profile locking is unavailable.');
  let unlock, resolveAcquired, rejectAcquired;
  const acquired = new Promise((resolve, reject) => { resolveAcquired = resolve; rejectAcquired = reject; });
  const completion = navigator.locks.request('outpost-live-profile:' + name, { ifAvailable: true }, lock => {
    if (!lock) { resolveAcquired(false); return; }
    resolveAcquired(true); return new Promise(resolve => { unlock = resolve; });
  });
  completion.catch(rejectAcquired);
  if (!await acquired) throw Error('Another tab is using this encrypted profile.');
  return async () => { unlock(); await completion; };
}
async function openLocked(name, initialize) {
  const release = await acquire(name); let store, live;
  try {
    store = await openBlockTestStore(name); live = await initialize(store);
    let closePromise;
    return { live, close() {
      return closePromise ??= (async () => { try { await live.close(); } finally { store.close(); await release(); } })();
    } };
  } catch (error) { store?.close(); await release(); throw error; }
}
export function openLockedBlockTestProfile(name, passphrase, mode = 'open-or-create') {
  if (!['open-or-create', 'open', 'create'].includes(mode)) throw Error('Invalid profile open mode.');
  return openLocked(name, async store => {
    const exists = await store.readManifest() !== null;
    if (mode === 'open' && !exists) throw Error('No encrypted profile exists. Choose Create new.');
    if (mode === 'create' && exists) throw Error('An encrypted profile already exists. It was not changed.');
    return BlockLiveProfile.open(store, passphrase);
  });
}
export function migrateLockedBlockTestProfile(name, livePassphrase, blob, exportPassphrase, fingerprint, unseal) {
  return openLocked(name, store => BlockLiveProfile.createFromLegacy(store, livePassphrase, blob, exportPassphrase, fingerprint, unseal));
}
export async function deleteLockedBlockTestProfile(name, passphrase) {
  const release = await acquire(name); let store, live;
  try {
    store = await openBlockTestStore(name);
    if (await store.readManifest() === null) throw Error('No encrypted profile exists.');
    live = await BlockLiveProfile.open(store, passphrase);
    await live.close(); live = null;
    await store.clear();
  } finally { if (live) await live.close(); store?.close(); await release(); }
}
