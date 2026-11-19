import path from 'node:path';
import { verifyInventory } from './inventory.mjs';
const root = process.argv[2];
if (!root) throw Error('Usage: node verify-inventory.mjs <extension-directory> [expected-inventory-sha256]');
const result = await verifyInventory(path.resolve(root), process.argv[3]);
console.log(JSON.stringify({ ...result, note: result.digestVerified ?
  'Matched the supplied digest; trust depends on how you obtained it.' :
  'Self-consistency only: no trusted inventory digest was supplied.' }, null, 2));
