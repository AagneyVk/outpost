import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { inspectLinuxRuntime, copyLinuxRuntime } from './linux-runtime.mjs';

// Packages the existing relay-based browser. It deliberately does not include
// any of the credential-bearing, hardcoded research transport engines.
const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../..');
const flag = process.argv.indexOf('--out');
if (flag >= 0 && !process.argv[flag + 1]) throw Error('--out requires a directory path');
const destination = path.resolve(flag >= 0 ? process.argv[flag + 1] : path.join(root, '../outpost-extension-preview'));
const linuxFlag = process.argv.indexOf('--linux-runtime');
if (linuxFlag >= 0 && (!process.argv[linuxFlag + 1] || process.argv[linuxFlag + 1].startsWith('--'))) throw Error('--linux-runtime requires a directory path');
const linux = linuxFlag >= 0 ? await inspectLinuxRuntime(path.resolve(process.argv[linuxFlag + 1]), root) : null;
if (linux && (destination === linux.dir || destination.startsWith(linux.dir + path.sep))) throw Error('Output must be outside the Linux runtime directory');
const publicRoot = path.join(root, 'public');
const files = [
  'workstation.css', 'tools.css', 'portable.js', 'theme/pixelify.ttf', 'theme/vt323.ttf', 'theme/OFL.txt', 'theme/VT323-OFL.txt',
  'gecko-lab/index.html', 'gecko-lab/browser.css', 'gecko-lab/start.mjs', 'gecko-lab/profile.mjs',
  'gecko-lab/drag-capture.mjs', 'gecko-lab/wheel-queue.mjs', 'gecko-lab/engine-watchdog.mjs', 'gecko-lab/certificate-errors.mjs',
  'gecko-lab/files.html', 'gecko-lab/files.mjs', 'gecko-lab/return-to-browser.mjs',
  'gecko-lab/engine/gecko-input-v7.wasm.zst', 'gecko-lab/engine/LICENSE'
];
if (linux) files.push('workstation.html', 'workstation.js', 'desktop-guest.js', 'vnc-guest.js', 'guest-channel.js', 'vault.js', 'pixel-surface.js');
function replaceOnce(source, from, to, name) {
  const first = source.indexOf(from);
  if (first < 0 || source.indexOf(from, first + from.length) !== -1) throw Error('Unexpected ' + name + ' format');
  return source.slice(0, first) + to + source.slice(first + from.length);
}
await Promise.all([
  ...files.map(name => fs.access(path.join(publicRoot, name))),
  fs.access(path.join(publicRoot, 'gecko-lab/engine/gecko-input-v7.js')),
  fs.access(path.join(here, 'manifest.json')), fs.access(path.join(here, 'background.js')),
  fs.access(path.join(root, 'LICENSE')), fs.access(path.join(root, 'THIRD_PARTY.md'))
]);
// Refuse to overwrite an existing directory or its contents.
await fs.mkdir(destination, { recursive: false });
if (linux) await copyLinuxRuntime(linux, destination);
for (const name of files) {
  const out = path.join(destination, name);
  await fs.mkdir(path.dirname(out), { recursive: true });
  await fs.copyFile(path.join(publicRoot, name), out);
}
for (const name of ['manifest.json', 'background.js']) await fs.copyFile(path.join(here, name), path.join(destination, name));
await fs.copyFile(path.join(root, 'LICENSE'), path.join(destination, 'OUTPOST-LICENSE'));
await fs.copyFile(path.join(root, 'THIRD_PARTY.md'), path.join(destination, 'THIRD_PARTY.md'));

const htmlPath = path.join(destination, 'gecko-lab/index.html');
let html = await fs.readFile(htmlPath, 'utf8');
html = replaceOnce(html, '<p>Gecko runs inside this tab. Start the browser, then search Google or enter a website address.</p>',
  '<p>Gecko runs inside this tab. Start the browser, then search Google or enter a website address.</p><p class="small">Extension preview: browsing uses the selected Wisp relay. Its profile is separate from OUTPOST on the web. ' + (linux ? 'The Linux terminal is an offline preview.' : 'The Linux workspace is not included in this preview.') + '</p>', 'browser welcome');
html = replaceOnce(html, 'MercuryWorkshop’s public demo relay is selected by default. Clear the field to use OUTPOST’s bundled relay.',
  'MercuryWorkshop’s public demo relay is selected by default. Clearing the field also uses that relay in this extension.', 'relay description');
await fs.writeFile(htmlPath, html);
const filesPage = path.join(destination, 'gecko-lab/files.html');
let filesHtml = await fs.readFile(filesPage, 'utf8');
filesHtml = replaceOnce(filesHtml, '<a href="/" data-return-browser>', '<a href="/gecko-lab/index.html" data-return-browser>', 'files return link');
if (!linux) filesHtml = replaceOnce(filesHtml, 'The Linux terminal has a separate Files panel.', 'The Linux workspace is not included in this extension preview.', 'files description');
await fs.writeFile(filesPage, filesHtml);

const startPath = path.join(destination, 'gecko-lab/start.mjs');
let start = await fs.readFile(startPath, 'utf8');
start = replaceOnce(start,
  "const relay = custom ? new URL(custom) : new URL('/network/', location.href);\n    if (!custom) relay.protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';",
  "const relay = new URL(custom || 'wss://wisp.mercurywork.shop/');", 'relay selection');
start = replaceOnce(start, `Promise.all(['/workstation.html', '/build.json'].map(url => fetch(url, { method: 'HEAD' }))).then(responses => {
  const available = responses.every(response => response.ok);
  document.querySelector('#workspace-link').hidden = !available;
  document.querySelector('#workspace-tools').hidden = !available;
}).catch(() => {});`, linux ? "document.querySelector('#workspace-link').hidden = false; document.querySelector('#workspace-tools').hidden = false;" : '// The Linux workspace is not bundled in this preview.', 'workspace availability');
await fs.writeFile(startPath, start);

const source = await fs.readFile(path.join(publicRoot, 'gecko-lab/engine/gecko-input-v7.js'), 'utf8');
const prefix = 'const geckosource_namespaceObject = ';
const begin = source.indexOf(prefix), end = source.indexOf('\n', begin);
if (begin < 0 || end < 0 || source.indexOf(prefix, begin + prefix.length) !== -1) throw Error('Unexpected Gecko bundle');
const glue = JSON.parse(source.slice(begin + prefix.length, end).trim().replace(/;$/, ''));
const loader = 'const geckoBlobUrl = ()=>_geckoUrl ??= toBlobUrl(geckosource_namespaceObject);';
const packaged = replaceOnce(source.slice(0, begin) + source.slice(end + 1), loader,
  "const geckoBlobUrl = ()=>chrome.runtime.getURL('gecko-lab/engine/engine-glue.js');", 'Gecko loader');
await fs.writeFile(path.join(destination, 'gecko-lab/engine/gecko-input-v7.js'), packaged);
await fs.writeFile(path.join(destination, 'gecko-lab/engine/engine-glue.js'), glue);
await fs.writeFile(path.join(destination, 'index.html'), '<!doctype html><meta charset="utf-8"><meta http-equiv="refresh" content="0;url=/gecko-lab/index.html"><a href="/gecko-lab/index.html">Open OUTPOST</a>\n');
console.log('Built relay-based extension preview' + (linux ? ' with offline Linux' : '') + ' at ' + destination);
