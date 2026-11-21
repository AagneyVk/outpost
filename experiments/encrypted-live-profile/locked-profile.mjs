import { openEncryptedStore } from './indexeddb-store.mjs';
import { EncryptedLiveProfile } from './live-profile.mjs';
import { openChunkedTestStore } from './chunked-store.mjs';
import { ChunkedLiveProfile } from './chunked-profile.mjs';
export { openLockedBlockTestProfile, migrateLockedBlockTestProfile, deleteLockedBlockTestProfile } from './block-lock.mjs';

// The test store is intentionally unavailable where Web Locks are missing.
async function acquire(name) {
  if (typeof name !== 'string' || !/^outpost-live-test-[a-z0-9-]{1,80}$/.test(name)) throw Error('Invalid test store name.');
  if (!navigator.locks) throw Error('Exclusive profile locking is unavailable.');
  let unlock, resolveAcquired, rejectAcquired;
  const acquired = new Promise((resolve, reject) => { resolveAcquired = resolve; rejectAcquired = reject; });
  const completion = navigator.locks.request('outpost-live-profile:' + name, { ifAvailable: true }, lock => {
    if (!lock) { resolveAcquired(false); return; }
    resolveAcquired(true);
    return new Promise(resolve => { unlock = resolve; });
  });
  completion.catch(rejectAcquired);
  if (!await acquired) throw Error('Another tab is using this encrypted profile.');
  return async () => { unlock(); await completion; };
}
async function openLocked(name, passphrase, openStore, Profile, initialize) {
  const release = await acquire(name);
  let store, live;
  try {
    store = await openStore(name);
    live = initialize ? await initialize(store) : await Profile.open(store, passphrase);
    let closePromise;
    return { live, close() {
      return closePromise ??= (async () => {
        try { await live.close(); } finally { store.close(); await release(); }
      })();
    } };
  } catch (error) { store?.close(); await release(); throw error; }
}
export function openLockedTestProfile(name, passphrase) { return openLocked(name, passphrase, openEncryptedStore, EncryptedLiveProfile); }
export function openLockedChunkedTestProfile(name, passphrase) { return openLocked(name, passphrase, openChunkedTestStore, ChunkedLiveProfile); }
