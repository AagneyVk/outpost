// File inventory for reproducibility and corruption detection. A digest from a
// trusted channel is required for authenticity; the inventory is not signed.
import fs from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
export const inventoryName = 'OUTPOST-BUILD-INVENTORY.json';

async function hashFile(file) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}

export async function inventoryFiles(root) {
  const files = [];
  async function visit(directory, prefix) {
    const entries = await fs.readdir(directory, { withFileTypes: true });
    entries.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
    for (const entry of entries) {
      const name = prefix ? prefix + '/' + entry.name : entry.name;
      if (name === inventoryName) continue;
      const source = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(source, name);
      else if (entry.isFile()) {
        const stat = await fs.stat(source);
        files.push({ path: name, bytes: stat.size, sha256: await hashFile(source) });
      } else throw Error('Inventory does not allow links or non-regular files: ' + name);
    }
  }
  await visit(root, '');
  return { format: 'outpost-build-inventory-v1', files };
}

export async function writeInventory(root) {
  const inventory = await inventoryFiles(root);
  const content = JSON.stringify(inventory, null, 2) + '\n';
  await fs.writeFile(path.join(root, inventoryName), content, { flag: 'wx' });
  return createHash('sha256').update(content).digest('hex');
}

export async function verifyInventory(root, expectedDigest) {
  if (expectedDigest !== undefined && !/^[a-f0-9]{64}$/.test(expectedDigest)) throw Error('Expected inventory digest must be a lowercase SHA-256 hash.');
  const file = path.join(root, inventoryName), stat = await fs.lstat(file);
  if (!stat.isFile() || stat.size > 16 * 1024 * 1024) throw Error('Invalid inventory file.');
  const content = await fs.readFile(file), digest = createHash('sha256').update(content).digest('hex');
  if (expectedDigest !== undefined && digest !== expectedDigest) throw Error('Inventory digest does not match the trusted value.');
  let stored;
  try { stored = JSON.parse(content); } catch { throw Error('Invalid inventory JSON.'); }
  const current = await inventoryFiles(root);
  if (JSON.stringify(stored) !== JSON.stringify(current)) throw Error('Build files do not match the inventory.');
  return { digest, files: current.files.length, digestVerified: expectedDigest !== undefined };
}
