// Research-only atomic block store. An exclusive Web Lock is required.
export async function openBlockTestStore(name) {
  if (typeof name !== 'string' || !/^outpost-live-test-[a-z0-9-]{1,80}$/.test(name)) throw Error('Invalid test store name.');
  const db = await new Promise((resolve, reject) => {
    let rejected = false;
    const request = indexedDB.open(name, 1);
    request.onupgradeneeded = () => request.result.createObjectStore('records');
    request.onblocked = () => { rejected = true; reject(Error('Encrypted test store is blocked.')); };
    request.onerror = () => reject(request.error || Error('Could not open encrypted test store.'));
    request.onsuccess = () => rejected ? request.result.close() : resolve(request.result);
  });
  function key(id, index) {
    if (!/^[a-f0-9]{32}$/.test(id) || !Number.isSafeInteger(index) || index < 0 || index >= 1024) throw Error('Invalid encrypted block identifier.');
    return `block:${id}:${index}`;
  }
  function get(name) {
    return new Promise((resolve, reject) => {
      const tx = db.transaction('records', 'readonly'), request = tx.objectStore('records').get(name);
      let value; request.onsuccess = () => { value = request.result ?? null; };
      tx.oncomplete = () => resolve(value);
      tx.onabort = tx.onerror = () => reject(tx.error || Error('Encrypted test store read failed.'));
    });
  }
  return {
    readManifest: () => get('manifest'),
    readBlock(id, index) { return get(key(id, index)); },
    listBlockKeys() {
      return new Promise((resolve, reject) => {
        const tx = db.transaction('records', 'readonly'), request = tx.objectStore('records').getAllKeys(); let keys;
        request.onsuccess = () => { keys = request.result; };
        tx.oncomplete = () => {
          if (!keys.every(value => value === 'manifest' || (typeof value === 'string' && /^block:[a-f0-9]{32}:(?:0|[1-9][0-9]{0,3})$/.test(value) && Number(value.slice(value.lastIndexOf(':') + 1)) < 1024))) return reject(Error('Unexpected encrypted store record.'));
          resolve(keys.filter(value => value !== 'manifest'));
        };
        tx.onabort = tx.onerror = () => reject(tx.error || Error('Encrypted test store enumeration failed.'));
      });
    },
    commit(manifest, puts, deletes) {
      if (!(manifest instanceof Blob) || !Array.isArray(puts) || !Array.isArray(deletes)) return Promise.reject(Error('Invalid encrypted store transaction.'));
      let writes, removals;
      try {
        writes = puts.map(([id, index, blob]) => { if (!(blob instanceof Blob)) throw Error(); return [key(id, index), blob]; });
        removals = deletes.map(([id, index]) => key(id, index));
        const all = [...writes.map(([name]) => name), ...removals];
        if (new Set(all).size !== all.length) throw Error();
      } catch { return Promise.reject(Error('Invalid encrypted store transaction.')); }
      return new Promise((resolve, reject) => {
        const tx = db.transaction('records', 'readwrite', { durability: 'strict' }), object = tx.objectStore('records');
        object.put(manifest, 'manifest');
        for (const [name, blob] of writes) object.put(blob, name);
        for (const name of removals) object.delete(name);
        tx.oncomplete = () => resolve();
        tx.onabort = tx.onerror = () => reject(tx.error || Error('Encrypted test store write failed.'));
      });
    },
    clear() {
      return new Promise((resolve, reject) => {
        const tx = db.transaction('records', 'readwrite', { durability: 'strict' });
        tx.objectStore('records').clear();
        tx.oncomplete = () => resolve();
        tx.onabort = tx.onerror = () => reject(tx.error || Error('Encrypted test store clear failed.'));
      });
    },
    close() { db.close(); }
  };
}
