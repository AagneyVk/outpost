import fs from 'node:fs/promises';import path from 'node:path';
const root=path.resolve(import.meta.dirname,'..');await fs.mkdir(path.join(root,'public/vendor'),{recursive:true});
for(const [src,dest]of [['@xterm/xterm/lib/xterm.js','xterm.js'],['@xterm/xterm/css/xterm.css','xterm.css'],['xterm-pty/index.mjs','xterm-pty.mjs']])await fs.copyFile(path.join(root,'node_modules',src),path.join(root,'public/vendor',dest));
console.log('Pinned terminal assets copied locally.');
