import {createHash} from 'node:crypto';
import fs from 'node:fs/promises';
const hash=createHash('sha256');
for(const file of ['public/vendor/libv86.js','public/vendor/v86.wasm','public/vnc32/fs.json'])hash.update(await fs.readFile(file));
const manifest={fingerprint:hash.digest('hex'),format:1,filesystem:'/vnc32'};
const startupFiles = {};
for (const name of ['compatibility.ini', 'startupCache.4.little', 'scriptCache.bin', 'scriptCache-child.bin']) {
 try {
  const bytes = await fs.readFile('public/firefox-startup/' + name);
  startupFiles[name] = {bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex')};
 } catch (error) {
  if (error.code !== 'ENOENT') throw error;
 }
}
if (startupFiles['compatibility.ini'] && startupFiles['startupCache.4.little']) {
 manifest.startupFiles = startupFiles;
}
await fs.writeFile('public/build.json',JSON.stringify(manifest,null,2));
await fs.copyFile('runtime/welcome.html','public/welcome.html');
console.log('Runtime fingerprint prepared.');
