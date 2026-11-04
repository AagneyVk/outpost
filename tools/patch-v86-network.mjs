import fs from 'node:fs/promises';import {createHash} from 'node:crypto';
const file='public/vendor/libv86.js',entry=JSON.parse(await fs.readFile('vendor-manifest.json','utf8')).find(x=>x.path===file);
const marker='/* OUTPOST private guest TCP: reuse the pinned engine implementation. */';
let source=await fs.readFile(file,'utf8');
if(!source.includes(marker)){
 if(createHash('sha256').update(source).digest('hex')!==entry.sha256)throw Error('Unexpected v86 engine. Refusing an unreviewed network patch.');
 const anchor='$b.prototype.receive=function(a){this.bus.send("net"+this.id+"-receive",new Uint8Array(a))};';
 if(source.split(anchor).length!==2||!source.includes('Xb.prototype.connect=function(a){return Nb(a,this)};'))throw Error('Pinned engine network integration changed.');
 source=source.replace(anchor,anchor+marker+'$b.prototype.connect=Xb.prototype.connect;');await fs.writeFile(file,source);
}
await fs.writeFile('public/vendor/outpost-patch.json',JSON.stringify({upstreamSHA256:entry.sha256,derivedSHA256:createHash('sha256').update(source).digest('hex'),change:'Wisp.connect delegates to the same compiled Fetch.connect implementation.'},null,2));
console.log('Enabled private TCP connections using the pinned engine’s own transport.');
