import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';

// This is a reproducibility/integrity check for the known local demo, not an
// authenticity or distribution-licence verification of its upstream image.
const expectedFingerprint = '186b61ee9cc8cea27a928b5d83de2241653325d4d066ea4b65c50ada54e3f39b';
const pinned = {
  'vendor/libv86.js': '23e52f6efc33d88f250f34b42e078217ef338d0f043eb86aad07d154cb38a77a',
  'vendor/v86.wasm': 'abd512988f39f5c81d4930f564bafa1a6e1e0d5210de9b20e2bdec13fbc318d9',
  'vendor/seabios.bin': '73e3f359102e3a9982c35fce98eb7cd08f18303ac7f1ba6ebfbe6cdc1c244d98',
  'vendor/vgabios.bin': 'a4bc0d80cc3ca028c73dafa8fee396b8d054ce87ebd8abfbd31b06b437607880',
  'vnc32/tools-initrd.gz': '3058ba03f357eca9901cac063f5aa375215be3a7587a623fa7285410102bcf1d'
};
const digest = data => createHash('sha256').update(data).digest('hex');
async function regular(file) {
  const stat = await fs.lstat(file);
  if (!stat.isFile() || stat.isSymbolicLink()) throw Error('Expected a regular file: ' + file);
  return fs.readFile(file);
}
async function checkTree(dir) {
  const stat = await fs.lstat(dir);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw Error('Expected a directory: ' + dir);
  for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) await checkTree(file);
    else if (!entry.isFile() || entry.isSymbolicLink()) throw Error('Unexpected vendor entry: ' + file);
  }
}
export function collectBlobs(manifest) {
  if (!Array.isArray(manifest.fsroot)) throw Error('Invalid Linux filesystem manifest');
  const blobs = new Set();
  const visit = (entries, depth) => {
    if (depth > 100 || entries.length > 100000) throw Error('Invalid Linux filesystem tree');
    for (const entry of entries) {
      if (!Array.isArray(entry) || typeof entry[0] !== 'string' || !Number.isInteger(entry[3])) throw Error('Invalid Linux filesystem entry');
      const type = entry[3] & 0xf000;
      if (type === 0x4000) {
        if (!Array.isArray(entry[6])) throw Error('Invalid Linux directory');
        visit(entry[6], depth + 1);
      } else if (type === 0x8000) {
        if (typeof entry[6] !== 'string' || !/^[a-f0-9]{10}\.bin$/.test(entry[6])) throw Error('Invalid Linux blob name');
        blobs.add(entry[6]);
      }
    }
  };
  visit(manifest.fsroot, 0);
  return [...blobs];
}
export async function inspectLinuxRuntime(dir, root) {
  dir = await fs.realpath(dir);
  await checkTree(path.join(dir, 'vendor'));
  for (const [name, hash] of Object.entries(pinned)) {
    if (digest(await regular(path.join(dir, name))) !== hash) throw Error('Linux runtime checksum mismatch: ' + name);
  }
  if (digest(await regular(path.join(dir, 'workspace-tool.py'))) !== digest(await regular(path.join(root, 'runtime/workspace.py')))) throw Error('Unexpected Linux workspace tool');
  const build = JSON.parse(await regular(path.join(dir, 'build.json')));
  const fsBytes = await regular(path.join(dir, 'vnc32/fs.json'));
  const computed = createHash('sha256').update(await regular(path.join(dir, 'vendor/libv86.js'))).update(await regular(path.join(dir, 'vendor/v86.wasm'))).update(fsBytes).digest('hex');
  if (build.format !== 1 || build.filesystem !== '/vnc32' || build.fingerprint !== expectedFingerprint || computed !== expectedFingerprint || !/^[a-f0-9]{10}\.bin$/.test(build.toolsKernel)) throw Error('Unexpected Linux runtime manifest');
  const blobs = collectBlobs(JSON.parse(fsBytes));
  if (!blobs.includes(build.toolsKernel)) throw Error('Linux kernel missing from manifest');
  return { dir, build, fsBytes, blobs };
}
export async function copyLinuxRuntime(runtime, destination) {
  const { dir, build, fsBytes, blobs } = runtime;
  await fs.cp(path.join(dir, 'vendor'), path.join(destination, 'vendor'), { recursive: true });
  await fs.mkdir(path.join(destination, 'vnc32/rootfs'), { recursive: true });
  await fs.writeFile(path.join(destination, 'vnc32/fs.json'), fsBytes);
  await fs.copyFile(path.join(dir, 'vnc32/tools-initrd.gz'), path.join(destination, 'vnc32/tools-initrd.gz'));
  await fs.copyFile(path.join(dir, 'workspace-tool.py'), path.join(destination, 'workspace-tool.py'));
  let next = 0;
  await Promise.all(Array.from({ length: 8 }, async () => {
    while (next < blobs.length) {
      const name = blobs[next++];
      const data = await regular(path.join(dir, 'vnc32/rootfs', name));
      if (digest(data).slice(0, 10) !== name.slice(0, 10)) throw Error('Linux blob checksum mismatch: ' + name);
      await fs.writeFile(path.join(destination, 'vnc32/rootfs', name), data);
    }
  }));
  await fs.writeFile(path.join(destination, 'build.json'), JSON.stringify({ ...build, offline: true }));
}
