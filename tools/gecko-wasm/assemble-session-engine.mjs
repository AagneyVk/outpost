// Reuse the reviewed v6 host UI around the matching newly built WASM glue.
import fs from 'node:fs/promises';
import path from 'node:path';

if (process.argv.length !== 4) throw Error('Usage: node assemble-session-engine.mjs <wasm-build-dir> <output-js>');
const source = path.resolve(process.argv[2]);
const output = path.resolve(process.argv[3]);
let bundle = await fs.readFile(new URL('../../public/gecko-lab/engine/gecko-input-v6.js', import.meta.url), 'utf8');
const glue = await fs.readFile(path.join(source, 'gecko.js'), 'utf8');
const data = await fs.readFile(path.join(source, 'gecko.data.zst'));
const assets = JSON.parse(await fs.readFile(path.join(source, 'gecko-assets.json'), 'utf8'));
function replace(prefix, value) {
  const start = bundle.indexOf(prefix);
  const end = bundle.indexOf('\n', start);
  if (start < 0 || end < 0 || bundle.indexOf(prefix, start + prefix.length) >= 0)
    throw Error('Unexpected host bundle: ' + prefix);
  bundle = bundle.slice(0, start) + prefix + JSON.stringify(value) + ';' + bundle.slice(end);
}
replace('const geckosource_namespaceObject = ', glue);
replace('const gecko_datainline_namespaceObject = ', 'data:application/octet-stream;base64,' + data.toString('base64'));
replace('var gecko_assets_namespaceObject = ', { ov: assets.wasmSize });
// The v6 bundle carries mixed line endings and trailing spaces in vendored
// comments and statements. Normalize those without changing the inlined data.
bundle = bundle.replace(/\r\n/g, '\n').replace(/[ \t]+(?=\n)/g, '');
await fs.writeFile(output, bundle);
