import fs from 'node:fs/promises';import path from 'node:path';import crypto from 'node:crypto';
const root=path.resolve(import.meta.dirname,'..');
const manifest=JSON.parse(await fs.readFile(path.join(root,'vendor-manifest.json'),'utf8'));
for(const item of manifest){
 const file=path.resolve(root,item.path);if(!file.startsWith(root+path.sep))throw Error('Invalid manifest path');
 const url=new URL(item.url);if(url.protocol!=='https:')throw Error('Expected HTTPS asset');
 const r=await fetch(url,{signal:AbortSignal.timeout(60000)});if(!r.ok)throw Error('Asset download failed: '+item.path);
 const bytes=Buffer.from(await r.arrayBuffer());if(bytes.length!==item.bytes||crypto.createHash('sha256').update(bytes).digest('hex')!==item.sha256)throw Error('Asset changed: '+item.path+'; inspect and pin a new runtime explicitly.');
 await fs.mkdir(path.dirname(file),{recursive:true});await fs.writeFile(file,bytes);console.log('Verified '+item.path);
}
