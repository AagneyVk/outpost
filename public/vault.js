const magic=new TextEncoder().encode('OUTPOSTLOCAL1');
const request=r=>new Promise((resolve,reject)=>{r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);});
const done=tx=>new Promise((resolve,reject)=>{tx.oncomplete=resolve;tx.onabort=()=>reject(tx.error||Error('Save transaction aborted.'));tx.onerror=()=>{};});
export class LocalVault{
 constructor(name='outpost-local-v1'){this.name=name;}
 async open(){
  if(this.db)return this.db;
  const r=indexedDB.open(this.name,1);r.onupgradeneeded=()=>{r.result.createObjectStore('snapshots',{keyPath:'id'});r.result.createObjectStore('meta');};
  this.db=await request(r);return this.db;
 }
 async save(blob){
  if(!(blob instanceof Blob)||blob.size>256*1024*1024)throw Error('Invalid or oversized encrypted snapshot.');
  const prefix=new Uint8Array(await blob.slice(0,magic.length).arrayBuffer());if(!magic.every((v,i)=>prefix[i]===v))throw Error('Only encrypted OUTPOST exports may be stored.');
  const item={id:crypto.randomUUID(),createdAt:new Date().toISOString(),bytes:blob.size,blob};
  const db=await this.open(),tx=db.transaction(['snapshots','meta'],'readwrite'),complete=done(tx),store=tx.objectStore('snapshots');
  store.add(item);tx.objectStore('meta').put(item.id,'latest');
  const all=store.getAll();all.onsuccess=()=>{const previous=all.result.filter(x=>x.id!==item.id).sort((a,b)=>b.createdAt.localeCompare(a.createdAt)||b.id.localeCompare(a.id));for(const old of previous.slice(2))store.delete(old.id);};
  await complete;return item.id;
 }
 async list(){const db=await this.open(),tx=db.transaction(['snapshots','meta'],'readonly'),complete=done(tx);const all=await request(tx.objectStore('snapshots').getAll());await complete;return all.map(({blob,...metadata})=>metadata).sort((a,b)=>b.createdAt.localeCompare(a.createdAt));}
 async latest(){const db=await this.open(),tx=db.transaction('meta','readonly'),complete=done(tx);const id=await request(tx.objectStore('meta').get('latest'));await complete;return id||null;}
 async get(id){const db=await this.open(),tx=db.transaction('snapshots','readonly'),complete=done(tx);const item=await request(tx.objectStore('snapshots').get(id));await complete;if(!item)throw Error('Saved version is missing.');return item.blob;}
 async clear(){const db=await this.open(),tx=db.transaction(['snapshots','meta'],'readwrite'),complete=done(tx);tx.objectStore('snapshots').clear();tx.objectStore('meta').clear();await complete;}
 close(){this.db?.close();this.db=null;}
}
export async function claimLocalWorkspace(name='outpost-local-live'){
 if(!navigator.locks)throw Error('This browser lacks the workspace ownership API.');
 let release,settle;const claimed=new Promise((resolve,reject)=>{settle={resolve,reject};});
 const hold=navigator.locks.request(name,{ifAvailable:true},async lock=>{if(!lock){settle.reject(Error('Another OUTPOST tab owns the live workspace. Save and close it first.'));return;}const stopped=new Promise(resolve=>{release=resolve;});settle.resolve();await stopped;});
 hold.catch(settle.reject);await claimed;return async()=>{release();await hold;};
}
