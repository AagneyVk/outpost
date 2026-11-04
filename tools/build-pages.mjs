import { cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const prefix = process.argv[2] ?? '';
if (prefix && !/^\/[a-z\d._-]+$/i.test(prefix)) throw Error('Invalid Pages base path.');
const output = path.resolve(process.argv[3] ?? 'pages-dist');
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
await writeFile(start, (await readFile(start, 'utf8')).replace(
  /Promise\.all\(\['\/workstation\.html', '\/build\.json'\][\s\S]*?\.catch\(\(\) => \{\}\);\r?\n/,
  '',
));
for (const entry of ['isolate.js', 'isolation-worker.js']) {
  await cp('tools/pages/' + entry, path.join(output, entry));
}
