// Replace the inlined generated glue in a local test bundle. This is not a
// release build; the existing bundle provides the loader and bundled GRE data.
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const dir = path.dirname(fileURLToPath(import.meta.url));
const build = path.join(dir, process.argv.includes('--ordered') ? 'build-ordered' : process.argv.includes('--patched') ? 'build-patched' : 'build');
const baseBundle = process.env.OUTPOST_GECKO_BUNDLE;
if (!baseBundle) throw Error('Set OUTPOST_GECKO_BUNDLE to a compatible original Gecko JavaScript bundle');
let original = await fs.readFile(baseBundle, 'utf8');
const glue = await fs.readFile(path.join(build, 'generated-gecko.js'), 'utf8');
const data = await fs.readFile(path.join(build, 'gecko.data.zst'));
const assets = JSON.parse(await fs.readFile(path.join(build, 'gecko-assets.json'), 'utf8'));
function replaceLine(prefix, value) {
  const start = original.indexOf(prefix);
  const end = original.indexOf('\n', start);
  if (start < 0 || end < 0) throw Error('unexpected test bundle format: ' + prefix);
  original = original.slice(0, start) + prefix + JSON.stringify(value) + ';' + original.slice(end);
}
replaceLine('const geckosource_namespaceObject = ', glue);
replaceLine('const gecko_datainline_namespaceObject = ', 'data:application/octet-stream;base64,' + data.toString('base64'));
replaceLine('var gecko_assets_namespaceObject = ', { ov: assets.wasmSize });
await fs.writeFile(path.join(build, 'gecko.js'), original);
