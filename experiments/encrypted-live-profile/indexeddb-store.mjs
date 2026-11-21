// Research-only single-record store. Caller must hold a cross-tab exclusive
// Web Lock for the entire profile lifetime, including initial creation.
export async function openEncryptedStore(name) {
  if (typeof name !== 'string' || !/^outpost-live-test-[a-z0-9-]{1,80}$/.test(name)) throw Error('Invalid test store name.');
  const db = await new Promise((resolve, reject) => {
    let rejected = false;
    const request = indexedDB.open(name, 1);
    request.onupgradeneeded = () => request.result.createObjectStore('profile');
    request.onblocked = () => { rejected = true; reject(Error('Encrypted test store is blocked.')); };
    request.onerror = () => reject(request.error || Error('Could not open encrypted test store.'));
    request.onsuccess = () => rejected ? request.result.close() : resolve(request.result);
  });
  return {
    read() {
      return new Promise((resolve, reject) => {
        const tx = db.transaction('profile', 'readonly'), request = tx.objectStore('profile').get('ciphertext');
        let value;
        request.onsuccess = () => { value = request.result ?? null; };
        tx.oncomplete = () => resolve(value);
        tx.onabort = tx.onerror = () => reject(tx.error || Error('Encrypted test store read failed.'));
      });
    },
    commit(blob) {
      if (!(blob instanceof Blob)) return Promise.reject(Error('Encrypted test store accepts only a Blob.'));
      return new Promise((resolve, reject) => {
        const tx = db.transaction('profile', 'readwrite', { durability: 'strict' });
        tx.objectStore('profile').put(blob, 'ciphertext');
        tx.oncomplete = () => resolve();
        tx.onabort = tx.onerror = () => reject(tx.error || Error('Encrypted test store write failed.'));
      });
    },
    close() { db.close(); }
  };
}
