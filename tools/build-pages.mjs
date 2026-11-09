import { cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';

const prefix = process.argv[2] ?? '';
if (prefix && !/^\/[a-z\d._-]+$/i.test(prefix)) throw Error('Invalid Pages base path.');
const output = path.resolve(process.argv[3] ?? 'pages-dist');
const linux = process.argv[4];
await mkdir(output, { recursive: true });
for (const entry of ['gecko-lab', 'theme', 'tools.css', 'workstation.css', 'portable.js']) {
  await cp('public/' + entry, path.join(output, entry), { recursive: true });
}
for (const entry of ['gecko-lab/index.html', 'gecko-lab/files.html', 'gecko-lab/profile.mjs', 'tools.css']) {
  const target = path.join(output, entry);
  let source = await readFile(target, 'utf8');
  source = source.replace(/((?:href|src)="|from '|url\(')\/(?!\/)/g, '$1' + prefix + '/');
  if (entry === 'gecko-lab/index.html') {
    source = source.replace('<script type="module"', `<script src="${prefix}/isolate.js"></script>\n<script type="module"`);
    await writeFile(path.join(output, 'index.html'), source);
  }
  await writeFile(target, source);
}
const start = path.join(output, 'gecko-lab/start.mjs');
const probe = "['/workstation.html', '/build.json']";
let browser = await readFile(start, 'utf8');
if (linux) {
  await cp(linux, output, { recursive: true });
  const files = JSON.parse(await readFile('tools/pages/linux-prefetch.json', 'utf8'));
  const chunks = [];
  const index = {};
  let offset = 0;
  for (const name of files) {
    if (!/^[a-f0-9]{10}\.bin$/.test(name)) throw Error('Invalid prefetch filename.');
    const data = await readFile(path.join(linux, 'vnc32/rootfs', name));
    if (createHash('sha256').update(data).digest('hex').slice(0, 10) !== name.slice(0, 10)) throw Error('Prefetch content mismatch: ' + name);
    index[name] = [offset, data.length];
    offset += data.length;
    chunks.push(data);
  }
  const packed = gzipSync(Buffer.concat(chunks), { level: 9 });
  await writeFile(path.join(output, 'linux-prefetch.gz'), packed);
  const packHash = createHash('sha256').update(packed).digest('hex');
  const worker = await readFile('tools/pages/isolation-worker.js', 'utf8');
  await writeFile(path.join(output, 'isolation-worker.js'),
    worker.replace('/* OUTPOST_PREFETCH_CONFIG */', 'const prefetchConfig = ' + JSON.stringify({ index, packHash }) + ';'));
  for (const entry of ['workstation.html', 'workstation.js', 'desktop-guest.js', 'vnc-guest.js', 'guest-channel.js', 'vault.js', 'pixel-surface.js']) {
    const source = await readFile('public/' + entry, 'utf8');
    const patched = source.replace(/((?:href|src)="|href='|src='|url:'|fetch\('|fetchText\(')\/(?!\/)/g, '$1' + prefix + '/');
    const isolated = entry === 'workstation.html'
      ? patched.replace('<script src="vendor/libv86.js">', `<script src="${prefix}/isolate.js"></script><script src="vendor/libv86.js">`)
      : patched;
    await writeFile(path.join(output, entry), isolated);
  }
  const manifestPath = path.join(output, 'build.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  manifest.filesystem = prefix + manifest.filesystem;
  manifest.offline = true;
  await writeFile(manifestPath, JSON.stringify(manifest));
  browser = browser.replace(probe, JSON.stringify([prefix + '/workstation.html', prefix + '/build.json']));
} else {
  browser = browser.replace(/Promise\.all\(\['\/workstation\.html', '\/build\.json'\][\s\S]*?\.catch\(\(\) => \{\}\);\r?\n/, '');
}
await writeFile(start, browser);
for (const entry of linux ? ['isolate.js'] : ['isolate.js', 'isolation-worker.js']) {
  await cp('tools/pages/' + entry, path.join(output, entry));
}
