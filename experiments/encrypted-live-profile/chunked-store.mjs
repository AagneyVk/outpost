// Research-only atomic IndexedDB store. Callers must hold an exclusive Web Lock.
export async function openChunkedTestStore(name) {
  if (typeof name !== 'string' || !/^outpost-live-test-[a-z0-9-]{1,80}$/.test(name)) throw Error('Invalid test store name.');
  const db = await new Promise((resolve, reject) => {
    let rejected = false;
    const request = indexedDB.open(name, 1);
    request.onupgradeneeded = () => request.result.createObjectStore('records');
    request.onblocked = () => { rejected = true; reject(Error('Encrypted test store is blocked.')); };
    request.onerror = () => reject(request.error || Error('Could not open encrypted test store.'));
    request.onsuccess = () => rejected ? request.result.close() : resolve(request.result);
  });
  function get(key) {
    return new Promise((resolve, reject) => {
      const tx = db.transaction('records', 'readonly'), request = tx.objectStore('records').get(key);
      let value; request.onsuccess = () => { value = request.result ?? null; };
      tx.oncomplete = () => resolve(value);
      tx.onabort = tx.onerror = () => reject(tx.error || Error('Encrypted test store read failed.'));
    });
  }
  return {
    readManifest: () => get('manifest'),
    readFile(id) { if (!/^[a-f0-9]{32}$/.test(id)) throw Error('Invalid encrypted record identifier.'); return get('file:' + id); },
    listFileIds() {
      return new Promise((resolve, reject) => {
        const tx = db.transaction('records', 'readonly'), request = tx.objectStore('records').getAllKeys();
        let keys; request.onsuccess = () => { keys = request.result; };
        tx.oncomplete = () => {
          if (!keys.every(key => key === 'manifest' || (typeof key === 'string' && /^file:[a-f0-9]{32}$/.test(key)))) return reject(Error('Unexpected encrypted store record.'));
          resolve(keys.filter(key => key !== 'manifest').map(key => key.slice(5)));
        };
        tx.onabort = tx.onerror = () => reject(tx.error || Error('Encrypted test store enumeration failed.'));
      });
    },
    commit(manifest, puts, deletes) {
      if (!(manifest instanceof Blob) || !Array.isArray(puts) || !Array.isArray(deletes) ||
          puts.some(item => !Array.isArray(item) || item.length !== 2 || !/^[a-f0-9]{32}$/.test(item[0]) || !(item[1] instanceof Blob)) ||
          deletes.some(id => !/^[a-f0-9]{32}$/.test(id))) return Promise.reject(Error('Invalid encrypted store transaction.'));
      return new Promise((resolve, reject) => {
        const tx = db.transaction('records', 'readwrite', { durability: 'strict' }), object = tx.objectStore('records');
        object.put(manifest, 'manifest');
        for (const [id, blob] of puts) object.put(blob, 'file:' + id);
        for (const id of deletes) object.delete('file:' + id);
        tx.oncomplete = () => resolve();
        tx.onabort = tx.onerror = () => reject(tx.error || Error('Encrypted test store write failed.'));
      });
    },
    close() { db.close(); }
  };
}
