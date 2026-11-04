// Client-only portable envelope. The passphrase/key is never stored or sent.
const enc=new TextEncoder(),dec=new TextDecoder('utf-8',{fatal:true});
const magic=enc.encode('OUTPOSTLOCAL1');
const rounds=600000,maxEncrypted=256*1024*1024,maxRaw=640*1024*1024;
const b64=b=>btoa(String.fromCharCode(...b));
const unb64=s=>Uint8Array.from(atob(s),c=>c.charCodeAt(0));
async function key(pass,salt,minLength){
 if(typeof pass!=='string'||pass.length<minLength||pass.length>1024)throw Error('Use a passphrase of '+minLength+'–1024 characters.');
 const material=await crypto.subtle.importKey('raw',enc.encode(pass),'PBKDF2',false,['deriveKey']);
 return crypto.subtle.deriveKey({name:'PBKDF2',hash:'SHA-256',salt,iterations:rounds},material,{name:'AES-GCM',length:256},false,['encrypt','decrypt']);
}
async function collect(stream,limit){let size=0;const chunks=[],reader=stream.getReader();try{for(;;){const {value,done}=await reader.read();if(done)break;size+=value.length;if(size>limit)throw Error('Workspace exceeds the prototype size limit.');chunks.push(value);}}catch(e){await reader.cancel().catch(()=>{});throw e;}const result=new Uint8Array(size);let i=0;for(const c of chunks){result.set(c,i);i+=c.length;}return result;}
export async function seal(raw,pass,runtime,{minLength=16}={}){
 if(raw.byteLength>maxRaw)throw Error('Workspace exceeds the prototype memory limit.');
 if(!/^[a-f0-9]{64}$/.test(runtime))throw Error('Runtime fingerprint is invalid.');
 const salt=crypto.getRandomValues(new Uint8Array(16)),iv=crypto.getRandomValues(new Uint8Array(12));
 const header=enc.encode(JSON.stringify({version:1,runtime,createdAt:new Date().toISOString(),kdf:'PBKDF2-SHA256',rounds,salt:b64(salt),iv:b64(iv),compression:'gzip'}));
 const compressed=await collect(new Blob([raw]).stream().pipeThrough(new CompressionStream('gzip')),maxEncrypted-4096);
 const cipher=await crypto.subtle.encrypt({name:'AES-GCM',iv,additionalData:header,tagLength:128},await key(pass,salt,minLength),compressed);
 compressed.fill(0);
 const length=new Uint8Array(4);new DataView(length.buffer).setUint32(0,header.length);
 return new Blob([magic,length,header,cipher],{type:'application/octet-stream'});
}
export async function unseal(blob,pass,runtime,{minLength=16}={}){
 if(blob.size>maxEncrypted||blob.size<magic.length+4+16)throw Error('Invalid or oversized workspace export.');
 const all=new Uint8Array(await blob.arrayBuffer());
 if(!magic.every((v,i)=>v===all[i]))throw Error('Not an OUTPOST local export.');
 const n=new DataView(all.buffer).getUint32(magic.length);if(n<2||n>2048||magic.length+4+n+16>all.length)throw Error('Invalid export header.');
 const header=all.slice(magic.length+4,magic.length+4+n);let h,salt,iv;
 try{h=JSON.parse(dec.decode(header));salt=unb64(h.salt);iv=unb64(h.iv);}catch{throw Error('Invalid export header.');}
 if(h.version!==1||h.kdf!=='PBKDF2-SHA256'||h.rounds!==rounds||h.compression!=='gzip'||salt.length!==16||iv.length!==12)throw Error('Unsupported export format.');
 if(h.runtime!==runtime)throw Error('This export needs the same OUTPOST runtime build. Keep its original runtime assets.');
 let compressed;try{compressed=await crypto.subtle.decrypt({name:'AES-GCM',iv,additionalData:header,tagLength:128},await key(pass,salt,minLength),all.subarray(magic.length+4+n));}catch{throw Error('Wrong passphrase or damaged workspace. Existing work was not changed.');}
 try{return await collect(new Blob([compressed]).stream().pipeThrough(new DecompressionStream('gzip')),maxRaw);}finally{new Uint8Array(compressed).fill(0);}
}
