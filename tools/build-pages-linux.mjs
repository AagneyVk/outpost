import { cp, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';

const output = process.argv[2];
if (!output) throw Error('Provide a new directory for the Linux runtime.');
const manifest = JSON.parse(await readFile('public/vnc32/fs.json', 'utf8'));
const removed = [
  '/usr/lib/chromium', '/usr/lib/firefox-esr',
  '/usr/lib/i386-linux-gnu/libLLVM-15.so.1', '/usr/lib/i386-linux-gnu/dri',
];
const blobs = new Set();
function prune(entries, parent = '') {
  return entries.filter(entry => {
    const name = parent + '/' + entry[0];
    if (removed.includes(name)) return false;
    if (Array.isArray(entry[6])) entry[6] = prune(entry[6], name);
    if ((entry[3] & 0xf000) === 0x8000 && typeof entry[6] === 'string') blobs.add(entry[6]);
    return true;
  });
}
manifest.fsroot = prune(manifest.fsroot);
let bytes = 0;
for (const file of blobs) {
  if (!/^[a-f\d]+\.bin$/.test(file)) throw Error('Invalid root filesystem blob name.');
  bytes += (await stat('public/vnc32/rootfs/' + file)).size;
}
if (bytes > 850_000_000) throw Error('Linux root filesystem exceeds the Pages budget.');
await mkdir(path.join(output, 'vnc32/rootfs'), { recursive: true });
const filesystem = JSON.stringify(manifest);
await writeFile(path.join(output, 'vnc32/fs.json'), filesystem);
for (const file of blobs) await cp('public/vnc32/rootfs/' + file, path.join(output, 'vnc32/rootfs', file));
await cp('public/vnc32/tools-initrd.gz', path.join(output, 'vnc32/tools-initrd.gz'));
await cp('public/vendor', path.join(output, 'vendor'), { recursive: true });
await cp('runtime/workspace.py', path.join(output, 'workspace-tool.py'));
const kernel = manifest.fsroot.find(entry => entry[0] === 'boot')[6].find(entry => entry[0] === 'vmlinuz-virt')[6];
const fingerprint = createHash('sha256').update(await readFile('public/vendor/libv86.js'))
  .update(await readFile('public/vendor/v86.wasm')).update(filesystem).digest('hex');
await writeFile(path.join(output, 'build.json'), JSON.stringify({ format: 1, fingerprint, filesystem: '/vnc32', toolsKernel: kernel }));
console.log('Pruned Linux filesystem:', bytes, 'bytes');
